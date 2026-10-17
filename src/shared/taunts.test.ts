import { test } from "node:test";
import assert from "node:assert/strict";
import type { EndReason } from "./round.ts";
import type { Find, Room, Round, Target } from "./hunt.ts";
import { roundOutcome } from "./standings.ts";
import { bundledTaunts, momentOf, type TauntMoment } from "./taunts.ts";

const frameRect = { x: 0, y: 0, width: 800, height: 600 };
const target = (id: string): Target => ({ id, stampId: "fish", rect: frameRect, rotationDeg: 0, strokeColor: "#fff", strokeWidth: 2 });
const three = ["t1", "t2", "t3"].map(target);
const four = ["t1", "t2", "t3", "t4"].map(target);

const ana = (targetId: string, at: number): Find => ({ targetId, playerId: "p-ana", playerName: "Ana", playerColor: "#e11d48", at });
const ben = (targetId: string, at: number): Find => ({ targetId, playerId: "p-ben", playerName: "Ben", playerColor: "#2563eb", at });
const cara = (targetId: string, at: number): Find => ({ targetId, playerId: "p-cara", playerName: "Cara", playerColor: "#16a34a", at });

const room = (current: Round | null): Room => ({
  roomId: "room-1",
  difficulty: 1,
  chosenDifficulty: null,
  league: [],
  current,
  next: null,
  roundsPlayed: 0,
});
const live = (id: string, targets: Target[], finds: Find[]): Round => ({ status: "live", id, frameRect, targets, startedAt: 1, endsAt: 100, finds });
const ended = (id: string, targets: Target[], finds: Find[], reason: EndReason): Round => ({
  status: "ended",
  id,
  frameRect,
  targets,
  startedAt: 1,
  endedAt: 50,
  finds,
  reason,
});

/** The find moment for one find, and the lead change it made. */
const finding = (roundId: string, find: Find, lead: "takes-lead" | "ties" | null): TauntMoment => ({ kind: "find", roundId, find, lead });
/** The round-end moment for a round that ended with these finds. */
const ending = (roundId: string, finds: Find[], reason: EndReason, total = 3): TauntMoment => ({
  kind: "round-end",
  roundId,
  reason,
  found: finds.length,
  total,
  outcome: roundOutcome(finds),
});

/** The lines the host picks across forty rounds, so every variant of a moment gets its turn. Sorted, without repeats. */
const picked = (moment: (roundId: string) => TauntMoment): string[] =>
  [...new Set(Array.from({ length: 40 }, (_, index) => bundledTaunts(moment(`r${index}`))))].sort();

const ROUND_START = ["ซ่อนไว้แล้ว หาให้เจอนะ!", "It's in there. Somewhere.", "ดูดีๆ มันอยู่ในรูปนั่นแหละ", "Ready, set, squint."];
const GENERIC_FIND = ["ตาไวมาก!", "Spotted!", "เจอแล้ว!", "Nothing gets past you."];
const ALL_FOUND = ["เจอครบทุกตัว! รอบหน้ายากขึ้นนะ", "Clean sweep. The next one is meaner."];
const MISSED = ["หมดเวลา! ยังซ่อนอยู่อีกหลายตัวเลย", "Time's up. They were right there."];
const CANCELLED = ["ยกเลิกรอบนี้แล้ว", "Round called off."];
const DEAD_HEAT = ["เสมอกัน! ตัดสินกันรอบหน้า · Dead heat. Settle it next round.", "เท่ากันเป๊ะ! มาเคลียร์รอบหน้า · Dead level. Rematch decides."];
const TAKES_LEAD_BEN = ["Ben แซงแล้ว! · Ben takes the lead!", "Ben ขึ้นนำแล้ว! · Ben is out front!"];
const TIES_BEN = ["Ben ตามทันแล้ว! · Ben ties it up!", "Ben เท่ากันแล้ว! · Ben is level now!"];
const REMATCH_ANA = ["Ana ขอแก้มือไหม? · Rematch, Ana?", "Ana ไปต่อไหม? · Go again, Ana?"];
const REMATCH_BEN = ["Ben ขอแก้มือไหม? · Rematch, Ben?", "Ben ไปต่อไหม? · Go again, Ben?"];
const REMATCH_CARA = ["Cara ขอแก้มือไหม? · Rematch, Cara?", "Cara ไปต่อไหม? · Go again, Cara?"];

test("a find carries the lead change it made, read against the round before it", () => {
  const before = [ana("t1", 1), ben("t2", 2)];
  assert.deepEqual(momentOf(room(live("r1", four, before)), room(live("r1", four, [...before, ben("t3", 3)]))), finding("r1", ben("t3", 3), "takes-lead"));

  const tied = [ana("t1", 1), ana("t2", 2), ben("t3", 3)];
  assert.deepEqual(momentOf(room(live("r1", four, tied)), room(live("r1", four, [...tied, ben("t4", 4)]))), finding("r1", ben("t4", 4), "ties"));

  const lead = [ana("t1", 1), ana("t2", 2)];
  assert.deepEqual(momentOf(room(live("r1", four, lead)), room(live("r1", four, [...lead, ana("t3", 3)]))), finding("r1", ana("t3", 3), null));
});

test("a round's end carries the outcome of the finds it ended with", () => {
  const finds = [ana("t1", 1), ben("t2", 2), ana("t3", 3)];
  assert.deepEqual(momentOf(room(live("r1", three, finds.slice(0, 2))), room(ended("r1", three, finds, "all-found"))), ending("r1", finds, "all-found"));
});

test("a round-ending find that takes the lead is a round end, and its line is the rematch nudge", () => {
  const before = [ana("t1", 1), ben("t2", 2)];
  const after = [...before, ben("t3", 3)];
  const expected = ending("r1", after, "all-found");
  assert.deepEqual(momentOf(room(live("r1", three, before)), room(ended("r1", three, after, "all-found"))), expected);
  assert.ok(REMATCH_ANA.includes(bundledTaunts(expected)));
});

test("a find that takes the lead names its finder, in Thai and English", () => {
  assert.deepEqual(picked((id) => finding(id, ben("t3", 3), "takes-lead")), [...TAKES_LEAD_BEN].sort());
});

test("a find that ties the lead names its finder, in Thai and English", () => {
  assert.deepEqual(picked((id) => finding(id, ben("t3", 3), "ties")), [...TIES_BEN].sort());
});

test("a find that changes no lead keeps the generic find lines", () => {
  assert.deepEqual(picked((id) => finding(id, ben("t3", 3), null)), [...GENERIC_FIND].sort());
});

test("a win over rivals asks the last-place player for a rematch", () => {
  assert.deepEqual(picked((id) => ending(id, [ana("t1", 1), ana("t2", 2), ben("t3", 3)], "all-found")), [...REMATCH_BEN].sort());
});

test("with three players the rematch nudge names the lowest-placed one", () => {
  const finds = [ana("t1", 1), ana("t2", 2), ben("t3", 3), cara("t4", 4)];
  assert.deepEqual(picked((id) => ending(id, finds, "all-found", 4)), [...REMATCH_CARA].sort());
});

test("a time-up round with a winner gets the rematch nudge too", () => {
  assert.deepEqual(picked((id) => ending(id, [ana("t1", 1), ana("t2", 2), ben("t3", 3)], "time-up")), [...REMATCH_BEN].sort());
});

test("a dead heat with rivals gets the dead-heat line, however the round ended", () => {
  const finds = [ana("t1", 1), ben("t2", 2)];
  assert.deepEqual(picked((id) => ending(id, finds, "all-found", 2)), [...DEAD_HEAT].sort());
  assert.deepEqual(picked((id) => ending(id, finds, "time-up", 2)), [...DEAD_HEAT].sort());
});

test("solo play keeps the plain round-end lines", () => {
  assert.deepEqual(picked((id) => ending(id, [ana("t1", 1), ana("t2", 2)], "all-found")), [...ALL_FOUND].sort());
  assert.deepEqual(picked((id) => ending(id, [ana("t1", 1)], "time-up")), [...MISSED].sort());
});

test("a round nobody scored in keeps the plain round-end line", () => {
  assert.deepEqual(picked((id) => ending(id, [], "time-up")), [...MISSED].sort());
});

test("a cancelled round stays generic even with two scorers", () => {
  assert.deepEqual(picked((id) => ending(id, [ana("t1", 1), ben("t2", 2)], "cancelled")), [...CANCELLED].sort());
  assert.deepEqual(picked((id) => ending(id, [ana("t1", 1), ana("t2", 2), ben("t3", 3)], "cancelled")), [...CANCELLED].sort());
});

test("round start keeps its plain lines", () => {
  assert.deepEqual(picked((id) => ({ kind: "round-start", roundId: id })), [...ROUND_START].sort());
});

test("solo play never names a player, from its first find to the round end", () => {
  const rounds = [
    room(null),
    room(live("r1", three, [])),
    room(live("r1", three, [ana("t1", 1)])),
    room(live("r1", three, [ana("t1", 1), ana("t2", 2)])),
    room(ended("r1", three, [ana("t1", 1), ana("t2", 2), ana("t3", 3)], "all-found")),
  ];
  const plain = [...ROUND_START, ...GENERIC_FIND, ...ALL_FOUND];
  for (let index = 1; index < rounds.length; index++) {
    const moment = momentOf(rounds[index - 1]!, rounds[index]!);
    assert.ok(moment, `commit ${index} makes a moment`);
    assert.ok(plain.includes(bundledTaunts(moment)), `commit ${index} says a plain line`);
    if (moment.kind === "find") assert.equal(moment.lead, null);
  }
});

test("a long name arrives clipped to sixteen characters, and its lines stay on the banner", () => {
  const long = "Bartholomew ".repeat(12).trim();
  const rival = { ...ben("t3", 3), playerName: long };
  const lines = [
    ...picked((id) => finding(id, rival, "takes-lead")),
    ...picked((id) => ending(id, [ana("t1", 1), ana("t2", 2), rival], "all-found")),
  ];
  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.ok(line.includes("Bartholomew Bar…"), line);
    assert.ok(!line.includes("Bartholomew Bartholomew"), line);
    assert.ok([...line].length <= 70, line);
  }
});

test("every line fits the banner: at most 70 characters with a sixteen-character name", () => {
  for (const name of ["Maximilian Smith", "สมชายใจดีมากๆเลย"]) {
    assert.equal([...name].length, 16, "the fixture name is sixteen characters");
    const rival = { ...ben("t3", 3), playerName: name };
    const lines = [
      ...picked((id) => ({ kind: "round-start", roundId: id })),
      ...picked((id) => finding(id, rival, "takes-lead")),
      ...picked((id) => finding(id, rival, "ties")),
      ...picked((id) => finding(id, rival, null)),
      ...picked((id) => ending(id, [ana("t1", 1), ana("t2", 2), rival], "all-found")),
      ...picked((id) => ending(id, [ana("t1", 1), ana("t2", 2), rival], "time-up")),
      ...picked((id) => ending(id, [ana("t1", 1), rival], "all-found", 2)),
      ...picked((id) => ending(id, [ana("t1", 1)], "cancelled")),
    ];
    assert.ok(lines.some((line) => line.includes(name)), "the named lines carry the name");
    for (const line of lines) assert.ok([...line].length <= 70, `${[...line].length} characters: ${line}`);
  }
});

test("the same moment always gets the same line", () => {
  const line = () => bundledTaunts(finding("r9", ben("t3", 3), "takes-lead"));
  assert.equal(line(), line());
});
