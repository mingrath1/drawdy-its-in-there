// The in-process host: a whole room inside the driver, speaking the wire protocol, for play
// without a backend. It answers like the Room Durable Object: a result per command, a full
// snapshot per change, and stored receipts so a replayed requestId gets the same answer.

import type { LeagueEntry, Room } from "../shared/hunt.ts";
import { plant } from "../shared/placement.ts";
import {
    PROTOCOL_VERSION,
    MAX_DIFFICULTY,
    MIN_DIFFICULTY,
    commandFingerprint,
    isCommand,
    roundDurationMs,
    targetCount,
    toWire,
} from "../shared/protocol.ts";
import type { Command, Hello, HuntHost, Player, ResultCode, ServerMessage } from "../shared/protocol.ts";
import { allFound, claimFind, endRound, markReady, plantingRound, startRound } from "../shared/round.ts";
import type { EndReason, RoundRejection } from "../shared/round.ts";
import { pickTaunt } from "../shared/taunts.ts";
import { log, warn } from "./command.ts";

export type LocalHostOptions = {
    stampIds: string[];
    difficulty?: number;
    now?: () => number;
    random?: () => number;
};

export function createLocalHost(options: LocalHostOptions): HuntHost {
    const now = options.now ?? Date.now;
    const random = options.random ?? Math.random;
    const receipts = new Map<string, { fingerprint: string; code: ResultCode }>();
    let room: Room | null = null;
    let player: Player | null = null;
    let receive: ((message: ServerMessage) => void) | null = null;
    let revision = 0;
    let taunt: string | null = null;
    let alarm: ReturnType<typeof setTimeout> | null = null;

    const publish = () => {
        if (!room || !player) return;
        revision++;
        receive?.({
            v: PROTOCOL_VERSION,
            type: "snapshot",
            revision,
            serverNow: now(),
            self: player.playerId,
            room: toWire(room),
            taunt,
        });
    };

    const arm = (endsAt: number) => {
        if (alarm) clearTimeout(alarm);
        alarm = setTimeout(() => {
            alarm = null;
            if (settleOverdue(now())) publish();
        }, Math.max(0, endsAt - now()));
    };

    // TEMPORARY: the room rules below move to src/shared/rules.ts, shared with the Room Durable
    // Object. The coordinator swaps this block for that reducer at merge.
    const settleOverdue = (at: number): boolean => {
        const current = room?.current;
        if (current?.status !== "live" || at < current.endsAt) return false;
        finish("time-up", current.endsAt);
        return true;
    };

    const finish = (reason: EndReason, at: number) => {
        if (!room?.current) return;
        const ended = endRound(room.current, at, reason);
        if (!ended.ok) return;
        if (alarm) clearTimeout(alarm);
        alarm = null;
        room.current = ended.round;
        room.roundsPlayed++;
        if (reason === "all-found") {
            room.difficulty = Math.min(MAX_DIFFICULTY, room.difficulty + 1);
            const winner = topFinder(ended.round.status === "ended" ? ended.round.finds : []);
            if (winner) leagueEntry(room.league, winner.playerId, winner.playerName).roundsWon++;
        }
        taunt = reason === "cancelled" ? null : pickTaunt(reason, random);
    };

    const reduce = (command: Command, at: number): ResultCode => {
        if (!room || !player) return "not-live";
        settleOverdue(at);
        const current = room.current;
        switch (command.type) {
            case "round.start": {
                if (current && current.status !== "ended") return "busy";
                const id = `local-${room.roundsPlayed + 1}-${Math.floor(random() * 1e9).toString(36)}`;
                const targets = plant({
                    roundId: id,
                    seed: Math.floor(random() * 2 ** 32),
                    difficulty: room.difficulty,
                    count: targetCount(room.difficulty),
                    board: command.board,
                    stampIds: options.stampIds,
                });
                if (targets.length === 0) return "busy";
                const ready = markReady(plantingRound(id, command.board.frameRect), targets);
                const live = ready.ok ? startRound(ready.round, at, roundDurationMs(room.difficulty)) : ready;
                if (!live.ok || live.round.status !== "live") return "busy";
                room.current = live.round;
                taunt = pickTaunt("start", random);
                arm(live.round.endsAt);
                return "ok";
            }
            case "board.offer":
                // Planting here is instant, so there is nothing to prepare ahead.
                return "ok";
            case "find.claim": {
                if (!current || current.id !== command.roundId) return "stale";
                const claimed = claimFind(current, {
                    targetId: command.targetId,
                    playerId: player.playerId,
                    playerName: player.name,
                    playerColor: player.color,
                    at,
                });
                if (!claimed.ok) return codeFor(claimed.rejection);
                room.current = claimed.round;
                leagueEntry(room.league, player.playerId, player.name).finds++;
                taunt = pickTaunt("find", random);
                if (allFound(claimed.round)) finish("all-found", at);
                return "ok";
            }
            case "round.cancel": {
                if (!current || current.id !== command.roundId) return "stale";
                if (current.status === "ended") return "not-live";
                finish("cancelled", at);
                return "ok";
            }
            case "difficulty.set": {
                if (current && current.status !== "ended") return "busy";
                room.difficulty = command.value;
                return "ok";
            }
        }
    };
    // End of TEMPORARY room rules.

    return {
        open(hello: Hello, onMessage) {
            receive = onMessage;
            player = hello.player;
            room ??= {
                roomId: hello.roomId,
                difficulty: Math.min(MAX_DIFFICULTY, Math.max(MIN_DIFFICULTY, Math.floor(options.difficulty ?? 1))),
                league: [],
                current: null,
                next: null,
                roundsPlayed: 0,
            };
            log(`local host open: room ${hello.roomId}, difficulty ${room.difficulty}`);
            publish();
            return Promise.resolve();
        },
        send(command) {
            if (!isCommand(command)) {
                warn("local host dropped an invalid command", command);
                return;
            }
            const fingerprint = commandFingerprint(command);
            const receipt = receipts.get(command.requestId);
            let code: ResultCode;
            if (receipt) {
                code = receipt.fingerprint === fingerprint ? receipt.code : "request-conflict";
            } else {
                const before = JSON.stringify(room);
                code = reduce(command, now());
                receipts.set(command.requestId, { fingerprint, code });
                if (JSON.stringify(room) !== before) publish();
            }
            receive?.({ v: PROTOCOL_VERSION, type: "result", requestId: command.requestId, command: command.type, code, revision });
        },
        close() {
            receive = null;
        },
    };
}

function codeFor(rejection: RoundRejection): ResultCode {
    switch (rejection.kind) {
        case "illegal-transition":
            return "not-live";
        case "unknown-target":
            return "unknown-target";
        case "already-found":
            return "taken";
        case "too-late":
            return "expired";
    }
}

function leagueEntry(league: LeagueEntry[], playerId: string, playerName: string): LeagueEntry {
    let entry = league.find((e) => e.playerId === playerId);
    if (!entry) {
        entry = { playerId, playerName, finds: 0, roundsWon: 0 };
        league.push(entry);
    }
    return entry;
}

function topFinder(finds: { playerId: string; playerName: string }[]) {
    const counts = new Map<string, { playerId: string; playerName: string; n: number }>();
    for (const f of finds) {
        const c = counts.get(f.playerId) ?? { playerId: f.playerId, playerName: f.playerName, n: 0 };
        c.n++;
        counts.set(f.playerId, c);
    }
    let best: { playerId: string; playerName: string; n: number } | null = null;
    for (const c of counts.values()) if (!best || c.n > best.n) best = c;
    return best;
}
