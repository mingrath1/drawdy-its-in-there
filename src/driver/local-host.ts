// The in-process host: a whole room inside the driver, for play without a backend. It runs the
// same rules as the Room Durable Object (src/shared/rules.ts) and answers the same way: a full
// snapshot per change, a result per command, and stored receipts so a replayed requestId gets
// its original answer. Planting is synchronous here, and a timer ends the round at its deadline.

import { bundledTaunts, momentOf } from "../shared/taunts.ts";
import type { Room } from "../shared/hunt.ts";
import { plant } from "../shared/placement.ts";
import { MAX_DIFFICULTY, MIN_DIFFICULTY, PROTOCOL_VERSION, commandFingerprint, isCommand, nextDifficulty, toWire } from "../shared/protocol.ts";
import type { HuntHost, Player, ResultCode, ServerMessage } from "../shared/protocol.ts";
import { expireRound, joinRoom, openRoom, plantFinished, reduce, roundDeadline } from "../shared/rules.ts";
import { log, warn } from "./command.ts";

type LocalHostOptions = {
    stampIds: string[];
    /** The level the room's first round is planted at. */
    difficulty?: number;
    now?: () => number;
    random?: () => number;
};

export function createLocalHost(options: LocalHostOptions): HuntHost {
    const now = options.now ?? (() => Date.now());
    const random = options.random ?? Math.random;
    const receipts = new Map<string, { fingerprint: string; code: ResultCode; revision: number }>();
    let room: Room | null = null;
    let player: Player | null = null;
    let receive: ((message: ServerMessage) => void) | null = null;
    let revision = 0;
    let taunt: string | null = null;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    let rounds = 0;

    const sendSnapshot = () => {
        if (!room || !player) return;
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

    /** Commits a new room state, like the Room's publish: a new revision and the taunt for that moment. */
    const commit = (next: Room): boolean => {
        if (!room || next === room) return false;
        const moment = momentOf(room, next);
        room = next;
        revision++;
        taunt = moment ? bundledTaunts(moment) : null;
        armDeadline();
        return true;
    };

    const armDeadline = () => {
        if (deadline) clearTimeout(deadline);
        deadline = null;
        const endsAt = room ? roundDeadline(room) : undefined;
        if (endsAt === undefined) return;
        deadline = setTimeout(() => {
            deadline = null;
            if (room && commit(expireRound(room, now()))) sendSnapshot();
        }, Math.max(0, endsAt - now()));
    };

    return {
        open(hello, onMessage) {
            receive = onMessage;
            player = hello.player;
            if (!room) {
                const level = Math.min(MAX_DIFFICULTY, Math.max(MIN_DIFFICULTY, Math.floor(options.difficulty ?? MIN_DIFFICULTY)));
                room = { ...openRoom(hello.roomId), difficulty: level };
            }
            commit(joinRoom(expireRound(room, now()), hello.player));
            log(`local host open: room ${hello.roomId}, next round at level ${nextDifficulty(room)}`);
            sendSnapshot();
            return Promise.resolve();
        },
        send(command) {
            if (!isCommand(command)) {
                warn("local host dropped an invalid command", command);
                return;
            }
            if (!room || !player) return;
            const at = now();
            const key = `${player.playerId}:${command.requestId}`;
            const fingerprint = commandFingerprint(command);
            const receipt = receipts.get(key);
            let code: ResultCode;
            let resultRevision: number;
            if (receipt) {
                commit(expireRound(room, at));
                code = receipt.fingerprint === fingerprint ? receipt.code : "request-conflict";
                resultRevision = receipt.fingerprint === fingerprint ? receipt.revision : revision;
                sendSnapshot();
            } else {
                const step = reduce(room, command, player, {
                    now: at,
                    fresh: { roundId: `local-${++rounds}-${Math.floor(random() * 2 ** 32).toString(36)}`, seed: Math.floor(random() * 2 ** 32) },
                    stampIds: options.stampIds,
                });
                const planted = step.plant ? plantFinished(step.room, step.plant.roundId, plant(step.plant)) : step.room;
                const changed = commit(planted);
                code = step.code;
                resultRevision = revision;
                receipts.set(key, { fingerprint, code, revision });
                if (changed) sendSnapshot();
            }
            receive?.({ v: PROTOCOL_VERSION, type: "result", requestId: command.requestId, command: command.type, code, revision: resultRevision });
        },
        close() {
            receive = null;
        },
    };
}
