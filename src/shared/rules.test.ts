import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BoardSnapshot, Room, Round } from "./hunt.ts";
import { MAX_DIFFICULTY, MAX_LEAGUE, roundDurationMs, targetCount, toWire } from "./protocol.ts";
import type { Command, Player } from "./protocol.ts";
import { canJoin, expireRound, joinRoom, openRoom, plantFinished, reduce } from "./rules.ts";
import type { RuleContext, Step } from "./rules.ts";

const board: BoardSnapshot = { frameRect: { x: 0, y: 0, width: 800, height: 600 }, items: [] };
const ana: Player = { playerId: "ana", name: "Ana", color: "#e03131" };
const ben: Player = { playerId: "ben", name: "Ben", color: "#1971c2" };
const stampIds = ["sitting-cat", "fish", "star"];

let counter = 0;
const context = (now: number): RuleContext => ({
    now,
    fresh: { roundId: `round-${++counter}`, seed: counter },
    stampIds,
});
const command = (body: Record<string, unknown>): Command => ({ v: 1, requestId: `req-${++counter}`, ...body }) as Command;
const start = (room: Room, now = 1_000, by = ana): Step => reduce(room, command({ type: "round.start", board }), by, context(now));
const claim = (room: Room, roundId: string, targetId: string, by: Player, now = 2_000): Step =>
    reduce(room, command({ type: "find.claim", roundId, targetId }), by, context(now));
const offer = (room: Room, afterRoundId: string, now = 2_000): Step =>
    reduce(room, command({ type: "board.offer", afterRoundId, board }), ana, context(now));

/** Ana and Ben joined, as every finder does before a round. */
const lobby = (): Room => joinRoom(joinRoom(openRoom("room-1"), ana), ben);

function live(room: Room): Extract<Round, { status: "live" }> {
    assert.equal(room.current?.status, "live");
    return room.current as Extract<Round, { status: "live" }>;
}

function clearAll(room: Room, by: Player[]): Room {
    const round = live(room);
    return round.targets.reduce((r, target, i) => claim(r, round.id, target.id, by[i % by.length]!).room, room);
}

describe("rules", () => {
    it("plays a round from start to all-found, crediting finds as they happen", () => {
        const started = start(joinRoom(joinRoom(openRoom("room-1"), ana), ben));
        assert.equal(started.code, "ok");
        const round = live(started.room);
        assert.equal(round.targets.length, targetCount(1));
        assert.equal(round.endsAt, 1_000 + roundDurationMs(1));
        assert.equal(started.room.difficulty, 1);

        const first = claim(started.room, round.id, round.targets[0]!.id, ana);
        assert.deepEqual(first.room.league.map((e) => [e.playerId, e.finds]), [["ana", 1], ["ben", 0]]);

        const room = clearAll(first.room, [ana, ben, ana]);
        assert.equal(room.current?.status === "ended" && room.current.reason, "all-found");
        assert.equal(room.roundsPlayed, 1);
        assert.deepEqual(room.league, [
            { playerId: "ana", playerName: "Ana", finds: 2, roundsWon: 1 },
            { playerId: "ben", playerName: "Ben", finds: 1, roundsWon: 0 },
        ]);
    });

    it("refuses a start while a round is live and changes nothing", () => {
        const { room } = start(lobby());
        const again = start(room);
        assert.equal(again.code, "busy");
        assert.equal(again.room, room);
    });

    it("gives each target to its first claim only", () => {
        const { room } = start(lobby());
        const round = live(room);
        const won = claim(room, round.id, round.targets[0]!.id, ana);
        const lost = claim(won.room, round.id, round.targets[0]!.id, ben);
        assert.equal(won.code, "ok");
        assert.equal(lost.code, "taken");
        assert.equal(lost.room, won.room);
        assert.equal(claim(room, round.id, "nope", ana).code, "unknown-target");
        assert.equal(claim(room, "other-round", round.targets[0]!.id, ana).code, "stale");
    });

    it("ends the round at its deadline and answers late claims with expired", () => {
        const { room } = start(lobby());
        const round = live(room);
        const late = claim(room, round.id, round.targets[0]!.id, ana, round.endsAt + 5_000);
        assert.equal(late.code, "expired");
        assert.deepEqual(late.room.current?.status === "ended" && [late.room.current.reason, late.room.current.endedAt], [
            "time-up",
            round.endsAt,
        ]);
        assert.equal(expireRound(late.room, round.endsAt + 9_000), late.room);
        assert.equal(expireRound(room, round.endsAt - 1), room);
    });

    it("answers a claim on an ended round with expired only when its time ran out", () => {
        const { room } = start(lobby());
        const round = live(room);
        const target = round.targets[0]!.id;
        const timedOut = expireRound(room, round.endsAt);
        const cleared = clearAll(room, [ana]);
        const cancelled = reduce(room, command({ type: "round.cancel", roundId: round.id }), ana, context(3_000)).room;
        assert.equal(claim(timedOut, round.id, target, ben, round.endsAt + 1).code, "expired");
        assert.equal(claim(cleared, round.id, target, ben).code, "not-live");
        assert.equal(claim(cancelled, round.id, target, ben).code, "not-live");
    });

    it("plants the next round from the first offer during a live round and ignores later offers", () => {
        const { room } = start(lobby());
        const round = live(room);
        const first = offer(room, round.id);
        assert.equal(first.code, "ok");
        assert.equal(first.room.next?.status, "planting");
        assert.equal(first.plant?.roundId, first.room.next?.id);
        assert.equal(first.plant?.difficulty, 2);
        assert.equal(first.plant?.count, targetCount(2));

        const second = offer(first.room, round.id);
        assert.deepEqual([second.code, second.room, second.plant], ["ok", first.room, null]);
        assert.equal(offer(room, "other-round").code, "stale");
        const ended = clearAll(room, [ana]);
        assert.equal(offer(ended, round.id).code, "not-live");
    });

    it("publishes planted targets only into the slot that asked for them", () => {
        const { room } = start(lobby());
        const planting = offer(room, live(room).id).room;
        const nextId = planting.next!.id;
        const targets = live(room).targets;
        assert.equal(plantFinished(planting, "someone-else", targets), planting);
        assert.deepEqual(plantFinished(planting, nextId, targets).next, {
            status: "ready",
            id: nextId,
            frameRect: board.frameRect,
            level: 2,
            targets,
        });
        assert.equal(plantFinished(planting, nextId, []).next, null);
    });

    it("promotes a ready next round planted for the next level on start", () => {
        const first = start(lobby());
        const offered = offer(first.room, live(first.room).id).room;
        const nextTargets = live(first.room).targets.map((t) => ({ ...t, id: `n-${t.id}` }));
        const ready = plantFinished(offered, offered.next!.id, nextTargets);
        const cleared = clearAll(ready, [ana]);

        const second = start(cleared, 50_000);
        const round = live(second.room);
        assert.deepEqual([round.id, round.targets, round.startedAt], [offered.next!.id, nextTargets, 50_000]);
        assert.equal(round.endsAt, 50_000 + roundDurationMs(2));
        assert.equal(second.room.next, null);
        assert.equal(second.room.difficulty, 2);
    });

    it("promotes a pre-planted round only at the level and board size it was planted for", () => {
        const first = start(lobby());
        const round = live(first.room);
        const offered = offer(first.room, round.id).room;
        const nextId = offered.next!.id;
        const ready = plantFinished(offered, nextId, round.targets.map((t) => ({ ...t, id: `n-${t.id}` })));
        const startWith = (room: Room, frameRect = board.frameRect) =>
            live(reduce(room, command({ type: "round.start", board: { ...board, frameRect } }), ana, context(50_000)).room);
        const set = (room: Room, value: number) => reduce(room, command({ type: "difficulty.set", value }), ana, context(5_000)).room;

        const allFound = clearAll(ready, [ana]);
        assert.equal(startWith(allFound).id, nextId);
        assert.equal(startWith(allFound, { ...board.frameRect, x: 500 }).id, nextId, "a moved frame of the same size");
        assert.notEqual(startWith(expireRound(ready, round.endsAt)).id, nextId, "time-up keeps the level");
        assert.notEqual(startWith(set(allFound, 3)).id, nextId, "difficulty.set chose another level");
        const resized = startWith(allFound, { ...board.frameRect, width: 801 });
        assert.notEqual(resized.id, nextId);
        assert.equal(resized.frameRect.width, 801);
    });

    it("plays the next round one level up after all found, and at the same level after time-up or a cancel", () => {
        const first = start(lobby());
        assert.equal(first.room.difficulty, 1);
        const allFound = clearAll(first.room, [ana]);
        assert.equal(toWire(allFound).nextDifficulty, 2);

        const second = start(allFound, 50_000).room;
        const round = live(second);
        assert.deepEqual([second.difficulty, round.targets.length, round.endsAt - 50_000], [2, targetCount(2), roundDurationMs(2)]);

        const timedOut = expireRound(second, round.endsAt);
        assert.equal(toWire(timedOut).nextDifficulty, 2);
        assert.equal(start(timedOut, 200_000).room.difficulty, 2);

        const cancelled = reduce(second, command({ type: "round.cancel", roundId: round.id }), ana, context(60_000)).room;
        assert.deepEqual([cancelled.difficulty, cancelled.roundsPlayed, toWire(cancelled).nextDifficulty], [2, 1, 2]);
        assert.equal(start(cancelled, 200_000).room.difficulty, 2);
    });

    it("stops raising the level at MAX_DIFFICULTY", () => {
        let room = lobby();
        for (let i = 0; i < MAX_DIFFICULTY + 2; i++) room = clearAll(start(room, 1_000 + i * 100_000).room, [ana]);
        assert.deepEqual([room.difficulty, toWire(room).nextDifficulty], [MAX_DIFFICULTY, MAX_DIFFICULTY]);
    });

    it("plants afresh and drops a next round that is still planting", () => {
        const first = start(lobby());
        const offered = offer(first.room, live(first.room).id).room;
        const cleared = clearAll(offered, [ana]);
        assert.equal(cleared.next?.status, "planting");

        const second = start(cleared, 50_000);
        assert.notEqual(live(second.room).id, offered.next!.id);
        assert.equal(second.room.next, null);
        assert.equal(plantFinished(second.room, offered.next!.id, live(first.room).targets), second.room);
    });

    it("cancels a live round without awarding it", () => {
        const { room } = start(lobby());
        const round = live(room);
        const found = claim(room, round.id, round.targets[0]!.id, ana).room;
        const cancelled = reduce(found, command({ type: "round.cancel", roundId: round.id }), ben, context(3_000));
        assert.equal(cancelled.code, "ok");
        assert.equal(cancelled.room.roundsPlayed, 0);
        assert.equal(cancelled.room.current?.status === "ended" && cancelled.room.current.reason, "cancelled");
        assert.deepEqual(cancelled.room.league, [
            { playerId: "ana", playerName: "Ana", finds: 1, roundsWon: 0 },
            { playerId: "ben", playerName: "Ben", finds: 0, roundsWon: 0 },
        ]);
        const again = reduce(cancelled.room, command({ type: "round.cancel", roundId: round.id }), ben, context(4_000));
        assert.equal(again.code, "not-live");
    });

    it("lets difficulty.set choose the next round's level only between rounds, even after all found", () => {
        const set = (r: Room, value: number) => reduce(r, command({ type: "difficulty.set", value }), ana, context(5_000));
        assert.equal(start(set(lobby(), 3).room).room.difficulty, 3);

        const { room } = start(lobby());
        assert.equal(set(room, 3).code, "busy");
        const allFound = clearAll(room, [ana]);
        const chosen = set(allFound, 1);
        assert.deepEqual([chosen.code, chosen.room.difficulty, toWire(chosen.room).nextDifficulty], ["ok", 1, 1]);
        assert.equal(start(chosen.room, 9_000).room.difficulty, 1);
        const hardest = start(set(allFound, MAX_DIFFICULTY).room, 9_000).room;
        assert.equal(live(hardest).targets.length, targetCount(MAX_DIFFICULTY));
    });

    it("awards a round to everyone tied for the most finds, and a round nobody scored to nobody", () => {
        const { room } = start(lobby());
        const round = live(room);
        let tied = claim(room, round.id, round.targets[0]!.id, ana).room;
        tied = claim(tied, round.id, round.targets[1]!.id, ben).room;
        tied = expireRound(tied, round.endsAt);
        assert.deepEqual(tied.league.map((e) => [e.playerId, e.roundsWon]), [["ana", 1], ["ben", 1]]);

        const empty = expireRound(start(joinRoom(openRoom("room-2"), ana)).room, 10_000_000);
        assert.deepEqual(empty.league, [{ playerId: "ana", playerName: "Ana", finds: 0, roundsWon: 0 }]);
    });

    it("lists a player from their first hello and keeps their name fresh", () => {
        const room = joinRoom(openRoom("room-1"), ana);
        assert.deepEqual(room.league, [{ playerId: "ana", playerName: "Ana", finds: 0, roundsWon: 0 }]);
        assert.equal(joinRoom(room, ana), room);
        assert.equal(joinRoom(room, { ...ana, name: "Ana B" }).league[0]!.playerName, "Ana B");
    });

    it("lists at most MAX_LEAGUE players and still lets a listed one back in", () => {
        let room = openRoom("room-1");
        for (let i = 0; i < MAX_LEAGUE; i++) room = joinRoom(room, { playerId: `p${i}`, name: `P${i}`, color: "#fff" });
        assert.equal(room.league.length, MAX_LEAGUE);
        const late = { playerId: "late", name: "Late", color: "#fff" };
        assert.equal(canJoin(room, late.playerId), false);
        assert.equal(joinRoom(room, late), room);
        assert.equal(canJoin(room, "p0"), true);
        assert.equal(joinRoom(room, { playerId: "p0", name: "Back", color: "#fff" }).league[0]!.playerName, "Back");
    });
});
