import { describe, expect, it } from "vitest";
import type { BoardSnapshot, Room } from "../../src/shared/hunt.ts";
import {
  claimFind,
  endDueRound,
  newRoom,
  readyNext,
  ROUND_MS,
  roomView,
  type Player,
  type RoundSeeds,
  startRound,
  targetCount,
} from "../src/rules.ts";

const board: BoardSnapshot = { frameRect: { x: 0, y: 0, width: 800, height: 600 }, items: [] };
const setup = { board, stampIds: ["cat", "229"] };
const alice: Player = { id: "alice", name: "Alice", color: "#e03131" };
const bob: Player = { id: "bob", name: "Bob", color: "#1971c2" };

const seeds = (now: number, round: number): RoundSeeds => ({
  now,
  current: { id: `round-${round}`, seed: round },
  next: { id: `round-${round + 1}`, seed: round + 1 },
});

function start(room: Room, now = 1_000, round = 1) {
  const step = startRound(room, setup, seeds(now, round));
  if (step.kind !== "started") throw new Error(`start failed: ${step.kind}`);
  return step;
}

describe("room rules", () => {
  it("plays a round from start to all-found and settles the league", () => {
    const started = start(newRoom("room-1"));
    expect(started.round.targets).toHaveLength(targetCount(1));
    expect(started.round.endsAt).toBe(1_000 + ROUND_MS);

    let room = started.room;
    const claimers = [alice, bob, alice];
    let last;
    for (const [index, target] of started.round.targets.entries()) {
      last = claimFind(
        room,
        { roundId: "round-1", targetId: target.id, player: claimers[index]! },
        2_000 + index,
      );
      expect(last.result.kind).toBe("found");
      room = last.room;
    }

    expect(last?.ended?.reason).toBe("all-found");
    expect(room.current).toMatchObject({ status: "ended", reason: "all-found", endedAt: 2_002 });
    expect(room.roundsPlayed).toBe(1);
    expect(room.difficulty).toBe(2);
    expect(room.league).toEqual([
      { playerId: "alice", playerName: "Alice", finds: 2, roundsWon: 1 },
      { playerId: "bob", playerName: "Bob", finds: 1, roundsWon: 0 },
    ]);
    expect(room.next).toMatchObject({ status: "planting", id: "round-2" });
  });

  it("rejects a start while a round is live", () => {
    const { room } = start(newRoom("room-1"));
    expect(startRound(room, setup, seeds(2_000, 2))).toEqual({ kind: "round-live" });
  });

  it("refuses a round with nothing to hide", () => {
    expect(startRound(newRoom("room-1"), { board, stampIds: [] }, seeds(1_000, 1))).toEqual({
      kind: "no-targets",
    });
  });

  it("gives a target to the first claim only", () => {
    const { room, round } = start(newRoom("room-1"));
    const targetId = round.targets[0]!.id;
    const first = claimFind(room, { roundId: round.id, targetId, player: alice }, 2_000);
    const second = claimFind(first.room, { roundId: round.id, targetId, player: bob }, 2_000);

    expect(first.result).toMatchObject({ kind: "found", find: { playerId: "alice" } });
    expect(second.result).toMatchObject({ kind: "taken", find: { playerId: "alice" } });
    expect(second.room.current).toMatchObject({ finds: [{ targetId, playerId: "alice" }] });
  });

  it("rejects claims for unknown targets and other rounds", () => {
    const { room, round } = start(newRoom("room-1"));
    expect(
      claimFind(room, { roundId: round.id, targetId: "nope", player: alice }, 2_000).result,
    ).toEqual({ kind: "unknown-target" });
    expect(
      claimFind(room, { roundId: "old", targetId: round.targets[0]!.id, player: alice }, 2_000)
        .result,
    ).toEqual({ kind: "not-live" });
  });

  it("ends the round at its deadline instead of scoring a late claim", () => {
    const { room, round } = start(newRoom("room-1"));
    const late = claimFind(
      room,
      { roundId: round.id, targetId: round.targets[0]!.id, player: alice },
      round.endsAt,
    );

    expect(late.result).toEqual({ kind: "not-live" });
    expect(late.room.current).toMatchObject({
      status: "ended",
      reason: "time-up",
      endedAt: round.endsAt,
      finds: [],
    });
  });

  it("ends a due round on the clock and leaves an undue one alone", () => {
    const { room, round } = start(newRoom("room-1"));
    expect(endDueRound(room, round.endsAt - 1)).toBeNull();
    expect(endDueRound(room, round.endsAt + 5_000)?.room.current).toMatchObject({
      status: "ended",
      reason: "time-up",
      endedAt: round.endsAt,
    });
  });

  it("drops the pre-planted round when a failed round keeps the difficulty", () => {
    const { room, round } = start(newRoom("room-1"));
    const planted = readyNext(room, "round-2", []);
    const ended = endDueRound(planted, round.endsAt)!;

    expect(ended.room.difficulty).toBe(1);
    expect(ended.room.next).toBeNull();
  });

  function clearedWithNextReady() {
    const first = start(newRoom("room-1"));
    const nextTargets = first.round.targets.map((target) => ({ ...target, id: `n-${target.id}` }));
    let room = readyNext(first.room, "round-2", nextTargets);
    for (const target of first.round.targets) {
      room = claimFind(
        room,
        { roundId: "round-1", targetId: target.id, player: alice },
        2_000,
      ).room;
    }
    return { first, room, nextTargets };
  }

  it("promotes a ready next round and plants the one after it", () => {
    const { first, room, nextTargets } = clearedWithNextReady();
    expect(first.plantNext).toMatchObject({ roundId: "round-2", difficulty: 2 });

    const second = startRound(room, setup, seeds(5_000, 3));

    expect(second).toMatchObject({
      kind: "started",
      round: { id: "round-2", targets: nextTargets, startedAt: 5_000 },
      room: { next: { status: "planting", id: "round-4" } },
      plantNext: { roundId: "round-4", difficulty: 3 },
    });
  });

  it("plants afresh when the frame moved since the next round was planted", () => {
    const { room } = clearedWithNextReady();
    const moved = { ...setup, board: { ...board, frameRect: { x: 50, y: 0, width: 800, height: 600 } } };
    const second = startRound(room, moved, seeds(9_000, 7));

    expect(second).toMatchObject({ kind: "started", round: { id: "round-7" } });
  });

  it("ignores a planting the room has dropped", () => {
    const { room } = start(newRoom("room-1"));
    expect(readyNext(room, "someone-else", [])).toBe(room);
  });

  it("hides the next round's targets from players", () => {
    const { room, round } = start(newRoom("room-1"));
    const view = roomView(readyNext(room, "round-2", round.targets));
    expect(view.next).toEqual({ id: "round-2", status: "ready" });
    expect(view.current).toEqual(round);
  });
});
