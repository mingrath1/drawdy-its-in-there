import { test } from "node:test";
import assert from "node:assert/strict";
import type { Find } from "./hunt.ts";
import { displayName, leadChange, roundOutcome, roundStandings } from "./standings.ts";

const ana = (targetId: string, at: number): Find => ({ targetId, playerId: "p-ana", playerName: "Ana", playerColor: "#e11d48", at });
const ben = (targetId: string, at: number): Find => ({ targetId, playerId: "p-ben", playerName: "Ben", playerColor: "#2563eb", at });

test("standings sort by finds, and a tie breaks to whoever reached the count first", () => {
    const s = roundStandings([ben("t1", 1), ana("t2", 2), ana("t3", 3), ben("t4", 4)]);
    assert.deepEqual(s.rows.map((r) => [r.name, r.finds]), [["Ana", 2], ["Ben", 2]]);
    assert.equal(s.leader, null, "a tie has no leader");
});

test("the leader is set only when one player is strictly ahead", () => {
    assert.equal(roundStandings([ana("t1", 1), ana("t2", 2), ben("t3", 3)]).leader, "p-ana");
    assert.equal(roundStandings([]).leader, null);
    assert.equal(roundStandings([ben("t1", 1)]).leader, "p-ben", "a lone scorer leads");
});

test("finds are counted in time order whatever order they arrive in", () => {
    const s = roundStandings([ana("t2", 5), ben("t1", 1), ana("t3", 9)]);
    assert.deepEqual(s.rows.map((r) => r.name), ["Ana", "Ben"]);
});

test("the outcome names the winner, a tie, or nobody", () => {
    const win = roundOutcome([ana("t1", 1), ana("t2", 2), ben("t3", 3)]);
    assert.equal(win.kind, "win");
    assert.deepEqual(win.winners.map((w) => w.name), ["Ana"]);
    const tie = roundOutcome([ana("t1", 1), ben("t2", 2)]);
    assert.equal(tie.kind, "tie");
    assert.deepEqual(tie.winners.map((w) => w.name).sort(), ["Ana", "Ben"]);
    assert.equal(roundOutcome([]).kind, "none");
});

test("long names are cut by characters, not UTF-16 units, and blank names show as ?", () => {
    assert.equal(displayName("Ana"), "Ana");
    assert.equal(displayName("Bartholomew the Third"), "Bartholomew the…");
    assert.equal([...displayName("🐱".repeat(20))].length, 16);
    assert.equal(displayName("   "), "?");
});

test("a find that puts its finder ahead takes the lead", () => {
    const before = [ana("t1", 1), ben("t2", 2)];
    assert.equal(leadChange(before, [...before, ben("t3", 3)]), "takes-lead");
});

test("a find that levels the score ties it", () => {
    const before = [ana("t1", 1), ana("t2", 2), ben("t3", 3)];
    assert.equal(leadChange(before, [...before, ben("t4", 4)]), "ties");
});

test("extending your own lead or scoring alone changes nothing", () => {
    const before = [ana("t1", 1), ben("t2", 2), ana("t3", 3)];
    assert.equal(leadChange(before, [...before, ana("t4", 4)]), null, "extends the lead");
    assert.equal(leadChange([], [ana("t1", 1)]), null, "first find of the round");
    assert.equal(leadChange([ana("t1", 1)], [ana("t1", 1), ana("t2", 2)]), null, "solo");
});
