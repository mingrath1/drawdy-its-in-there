import { describe, expect, it } from "vitest";
import type { Room } from "../../src/shared/hunt.ts";
import { bundledTaunts, momentOf, selectTauntHost } from "../src/taunts.ts";

const frameRect = { x: 0, y: 0, width: 800, height: 600 };
const target = { id: "r1:0", stampId: "fish", rect: frameRect, rotationDeg: 0, strokeColor: "#fff", strokeWidth: 2 };
const find = { targetId: "r1:0", playerId: "ana", playerName: "Ana", playerColor: "#e03131", at: 2 };
const room = (current: Room["current"]): Room => ({
  roomId: "room-1",
  difficulty: 1,
  chosenDifficulty: null,
  league: [],
  current,
  next: null,
  roundsPlayed: 0,
});
const live = room({ status: "live", id: "r1", frameRect, targets: [target], startedAt: 1, endsAt: 9, finds: [] });
const found = room({ status: "live", id: "r1", frameRect, targets: [target], startedAt: 1, endsAt: 9, finds: [find] });
const ended = room({
  status: "ended",
  id: "r1",
  frameRect,
  targets: [target],
  startedAt: 1,
  endedAt: 3,
  finds: [find],
  reason: "all-found",
});

describe("taunts", () => {
  it("keeps the bundled lines while TAUNT_HOST is unset", () => {
    expect(selectTauntHost({})).toBe(bundledTaunts);
    expect(selectTauntHost({ TAUNT_HOST: "" })).toBe(bundledTaunts);
    expect(() => selectTauntHost({ TAUNT_HOST: "llm" })).toThrow(/TAUNT_HOST/);
  });

  it("names the moment a commit produced, a round's end outranking its last find", () => {
    expect(momentOf(room(null), live)).toEqual({ kind: "round-start", roundId: "r1" });
    expect(momentOf(live, found)).toEqual({ kind: "find", roundId: "r1", find });
    expect(momentOf(live, ended)).toMatchObject({ kind: "round-end", reason: "all-found", found: 1, total: 1 });
    expect(momentOf(found, found)).toBeNull();
    expect(momentOf(ended, ended)).toBeNull();
  });
});
