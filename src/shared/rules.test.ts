import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BoardSnapshot, Room, Round } from "./hunt.ts";
import { MAX_DIFFICULTY, roundDurationMs, targetCount } from "./protocol.ts";
import type { Command, Player } from "./protocol.ts";
import { expireRound, joinRoom, openRoom, plantFinished, reduce } from "./rules.ts";
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
        assert.equal(started.room.difficulty, 2);

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
        const { room } = start(openRoom("room-1"));
        const again = start(room);
        assert.equal(again.code, "busy");
        assert.equal(again.room, room);
    });

    it("gives each target to its first claim only", () => {
        const { room } = start(openRoom("room-1"));
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
        const { room } = start(openRoom("room-1"));
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

    it("plants the next round from the first offer during a live round and ignores later offers", () => {
        const { room } = start(openRoom("room-1"));
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
        const { room } = start(openRoom("room-1"));
        const planting = offer(room, live(room).id).room;
        const nextId = planting.next!.id;
        const targets = live(room).targets;
        assert.equal(plantFinished(planting, "someone-else", targets), planting);
        assert.deepEqual(plantFinished(planting, nextId, targets).next, {
            status: "ready",
            id: nextId,
            frameRect: board.frameRect,
            targets,
        });
        assert.equal(plantFinished(planting, nextId, []).next, null);
    });

    it("promotes a ready next round on start and raises the level again", () => {
        const first = start(openRoom("room-1"));
        const offered = offer(first.room, live(first.room).id).room;
        const nextTargets = live(first.room).targets.map((t) => ({ ...t, id: `n-${t.id}` }));
        const ready = plantFinished(offered, offered.next!.id, nextTargets);
        const cleared = clearAll(ready, [ana]);

        const second = start(cleared, 50_000);
        const round = live(second.room);
        assert.deepEqual([round.id, round.targets, round.startedAt], [offered.next!.id, nextTargets, 50_000]);
        assert.equal(round.endsAt, 50_000 + roundDurationMs(2));
        assert.equal(second.room.next, null);
        assert.equal(second.room.difficulty, 3);
    });

    it("plants afresh and drops a next round that is still planting", () => {
        const first = start(openRoom("room-1"));
        const offered = offer(first.room, live(first.room).id).room;
        const cleared = clearAll(offered, [ana]);
        assert.equal(cleared.next?.status, "planting");

        const second = start(cleared, 50_000);
        assert.notEqual(live(second.room).id, offered.next!.id);
        assert.equal(second.room.next, null);
        assert.equal(plantFinished(second.room, offered.next!.id, live(first.room).targets), second.room);
    });

    it("cancels a live round without awarding it", () => {
        const { room } = start(openRoom("room-1"));
        const round = live(room);
        const found = claim(room, round.id, round.targets[0]!.id, ana).room;
        const cancelled = reduce(found, command({ type: "round.cancel", roundId: round.id }), ben, context(3_000));
        assert.equal(cancelled.code, "ok");
        assert.equal(cancelled.room.current?.status === "ended" && cancelled.room.current.reason, "cancelled");
        assert.deepEqual(cancelled.room.league, [{ playerId: "ana", playerName: "Ana", finds: 1, roundsWon: 0 }]);
        const again = reduce(cancelled.room, command({ type: "round.cancel", roundId: round.id }), ben, context(4_000));
        assert.equal(again.code, "not-live");
    });

    it("sets the level only between rounds and drops an unplayed next round", () => {
        const { room } = start(openRoom("room-1"));
        const set = (r: Room, value: number) => reduce(r, command({ type: "difficulty.set", value }), ana, context(5_000));
        assert.equal(set(room, 4).code, "busy");

        const offered = offer(room, live(room).id).room;
        const ready = plantFinished(offered, offered.next!.id, live(room).targets);
        const between = set(clearAll(ready, [ana]), MAX_DIFFICULTY);
        assert.deepEqual([between.code, between.room.difficulty, between.room.next], ["ok", MAX_DIFFICULTY, null]);
        assert.equal(live(start(between.room, 9_000).room).targets.length, targetCount(MAX_DIFFICULTY));
    });

    it("awards a round to everyone tied for the most finds, and a round nobody scored to nobody", () => {
        const { room } = start(openRoom("room-1"));
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
});
