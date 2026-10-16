// The game rules as a pure reducer over Room. The Room Durable Object and the driver's
// offline LocalHost both run this file, so there is one copy of the rules.
//
// room.difficulty is the level the next round is planted at. Starting a round raises it
// one step, board.offer plants the next round at it, and difficulty.set drops any unplayed
// next round, so a pre-planted round always matches the room's level.

import type { BoardSnapshot, Find, LeagueEntry, PlantRequest, PlayerId, Room, Round, Target } from "./hunt.ts";
import { plant } from "./placement.ts";
import {
    type Command,
    MAX_DIFFICULTY,
    MAX_LEAGUE,
    MIN_DIFFICULTY,
    type Player,
    type ResultCode,
    roundDurationMs,
    targetCount,
} from "./protocol.ts";
import {
    allFound,
    claimFind,
    type EndReason,
    endRound,
    markReady,
    plantingRound,
    type RoundRejection,
    type RoundResult,
    startRound,
} from "./round.ts";

/** What a step needs that a pure function cannot invent. */
export type RuleContext = {
    now: number;
    /** Used only when the step plants a round. */
    fresh: { roundId: string; seed: number };
    stampIds: readonly string[];
};

/** `plant` asks the host to plant the next round, then call plantFinished with its targets. */
export type Step = { room: Room; code: ResultCode; plant: PlantRequest | null };

export function openRoom(roomId: string): Room {
    return { roomId, difficulty: MIN_DIFFICULTY, league: [], current: null, next: null, roundsPlayed: 0 };
}

/** A listed player can always rejoin. A new one needs a free place in the league. */
export function canJoin(room: Room, playerId: PlayerId): boolean {
    return room.league.length < MAX_LEAGUE || room.league.some((e) => e.playerId === playerId);
}

/** Lists a player in the league from their first hello and keeps their display name fresh. */
export function joinRoom(room: Room, player: Player): Room {
    if (!canJoin(room, player.playerId)) return room;
    const entry = room.league.find((e) => e.playerId === player.playerId);
    if (entry?.playerName === player.name) return room;
    const league = entry
        ? room.league.map((e) => (e.playerId === player.playerId ? { ...e, playerName: player.name } : e))
        : [...room.league, { playerId: player.playerId, playerName: player.name, finds: 0, roundsWon: 0 }];
    return { ...room, league };
}

/** Ends the live round once its deadline has passed. It ends at the deadline, however late this runs. */
export function expireRound(room: Room, now: number): Room {
    const round = room.current;
    if (round?.status !== "live" || now < round.endsAt) return room;
    return finish(room, round, round.endsAt, "time-up");
}

export function roundDeadline(room: Room): number | undefined {
    return room.current?.status === "live" ? room.current.endsAt : undefined;
}

/** Publishes planted targets only if the next slot still holds that round. */
export function plantFinished(room: Room, roundId: string, targets: Target[]): Room {
    const next = room.next;
    if (next?.status !== "planting" || next.id !== roundId) return room;
    if (targets.length === 0) return { ...room, next: null };
    return { ...room, next: must(markReady(next, targets)) };
}

/** Applies one command from an authenticated player. The room is returned unchanged when the command changes nothing. */
export function reduce(room: Room, command: Command, player: Player, context: RuleContext): Step {
    const reconciled = expireRound(room, context.now);
    switch (command.type) {
        case "round.start":
            return start(reconciled, command.board, context);
        case "board.offer":
            return offer(reconciled, command.afterRoundId, command.board, context);
        case "find.claim":
            return claim(reconciled, command.roundId, command.targetId, player, context.now);
        case "round.cancel":
            return cancel(reconciled, command.roundId, context.now);
        case "difficulty.set":
            return setDifficulty(reconciled, command.value);
    }
}

const step = (room: Room, code: ResultCode, plantNext: PlantRequest | null = null): Step => ({
    room,
    code,
    plant: plantNext,
});

function start(room: Room, board: BoardSnapshot, context: RuleContext): Step {
    if (room.current?.status === "live") return step(room, "busy");
    const difficulty = room.difficulty;
    let ready: Round | null = room.next?.status === "ready" ? room.next : null;
    if (ready === null) {
        const targets = plant(plantRequest(context, board, difficulty));
        if (targets.length === 0) return step(room, "busy");
        ready = must(markReady(plantingRound(context.fresh.roundId, board.frameRect), targets));
    }
    const live = must(startRound(ready, context.now, roundDurationMs(difficulty)));
    // A next round still planting was planted for this level; dropping it lets board.offer plant the harder one.
    return step(
        { ...room, current: live, next: null, difficulty: Math.min(MAX_DIFFICULTY, difficulty + 1) },
        "ok",
    );
}

/** The first offer during a live round plants the next one. Later offers change nothing. */
function offer(room: Room, afterRoundId: string, board: BoardSnapshot, context: RuleContext): Step {
    const current = room.current;
    if (current === null || current.id !== afterRoundId) return step(room, "stale");
    if (current.status !== "live") return step(room, "not-live");
    if (room.next !== null) return step(room, "ok");
    return step(
        { ...room, next: plantingRound(context.fresh.roundId, board.frameRect) },
        "ok",
        plantRequest(context, board, room.difficulty),
    );
}

function claim(room: Room, roundId: string, targetId: string, player: Player, now: number): Step {
    const current = room.current;
    if (current === null || current.id !== roundId) return step(room, "stale");
    const find: Find = {
        targetId,
        playerId: player.playerId,
        playerName: player.name,
        playerColor: player.color,
        at: now,
    };
    const result = claimFind(current, find);
    if (!result.ok) return step(room, rejectionCode(result.rejection, current));
    const credited: Room = { ...room, current: result.round, league: credit(room.league, find) };
    return step(allFound(result.round) ? finish(credited, result.round, now, "all-found") : credited, "ok");
}

function cancel(room: Room, roundId: string, now: number): Step {
    const current = room.current;
    if (current === null || current.id !== roundId) return step(room, "stale");
    if (current.status !== "live") return step(room, "not-live");
    return step(finish(room, current, now, "cancelled"), "ok");
}

function setDifficulty(room: Room, value: number): Step {
    if (room.current?.status === "live") return step(room, "busy");
    if (value === room.difficulty) return step(room, "ok");
    return step({ ...room, difficulty: value, next: null }, "ok");
}

function plantRequest(context: RuleContext, board: BoardSnapshot, difficulty: number): PlantRequest {
    return {
        roundId: context.fresh.roundId,
        seed: context.fresh.seed,
        difficulty,
        count: targetCount(difficulty),
        board,
        stampIds: [...context.stampIds],
    };
}

/** "expired" means time ran out. A round that ended any other way is just not live. */
function rejectionCode(rejection: RoundRejection, round: Round): ResultCode {
    switch (rejection.kind) {
        case "illegal-transition":
            return round.status === "ended" && round.reason === "time-up" ? "expired" : "not-live";
        case "unknown-target":
            return "unknown-target";
        case "already-found":
            return "taken";
        case "too-late":
            return "expired";
    }
}

/** Finds count as they happen, so the scoreboard ticks during the round. Every finder joined the league first. */
function credit(league: LeagueEntry[], find: Find): LeagueEntry[] {
    return league.map((e) => (e.playerId === find.playerId ? { ...e, finds: e.finds + 1 } : e));
}

/** Ends a round. Everyone tied for the most finds wins it, unless it was cancelled or nobody found anything. */
function finish(room: Room, round: Round, endedAt: number, reason: EndReason): Room {
    const ended = must(endRound(round, endedAt, reason));
    const winners = topFinders(ended.status === "ended" && reason !== "cancelled" ? ended.finds : []);
    return {
        ...room,
        current: ended,
        roundsPlayed: room.roundsPlayed + 1,
        league: room.league.map((e) => (winners.has(e.playerId) ? { ...e, roundsWon: e.roundsWon + 1 } : e)),
    };
}

function topFinders(finds: Find[]): Set<PlayerId> {
    const counts = new Map<PlayerId, number>();
    for (const find of finds) counts.set(find.playerId, (counts.get(find.playerId) ?? 0) + 1);
    const best = Math.max(0, ...counts.values());
    return new Set([...counts].filter(([, count]) => best > 0 && count === best).map(([playerId]) => playerId));
}

function must(result: RoundResult): Round {
    if (!result.ok) throw new Error(`Impossible round transition: ${JSON.stringify(result.rejection)}`);
    return result.round;
}
