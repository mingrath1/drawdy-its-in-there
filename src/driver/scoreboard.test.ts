import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Find, LeagueEntry } from "../shared/hunt.ts";
import type { Player } from "../shared/protocol.ts";
import { roundVerdict, scoreRows } from "./scoreboard.ts";

const entry = (playerId: string, playerName: string, roundsWon = 0): LeagueEntry => ({ playerId, playerName, finds: 9, roundsWon });
const here = (playerId: string, name: string, color: string): Player => ({ playerId, name, color });
const find = (targetId: string, playerId: string, playerName: string, playerColor: string, at: number): Find => ({ targetId, playerId, playerName, playerColor, at });

const league = [
    entry("p-ana", "Ana", 1),
    entry("p-ben", "Ben"),
    entry("p-cat", "Cat", 3),
    entry("p-dan", "Dan", 2),
    entry("p-eve", "Eve", 2),
    entry("p-fay", "Fay", 5),
];
const presence = [
    here("p-eve", "Eve", "#eeeeee"),
    here("p-ana", "Ana", "#aaaaaa"),
    here("p-dan", "Dan", "#dddddd"),
    here("p-ben", "Ben", "#bbbbbb"),
    here("p-gus", "Gus", "#999999"),
];
const finds = [find("t0", "p-ben", "Ben", "#b0b0b0", 1), find("t1", "p-cat", "Cat", "#c0c0c0", 2), find("t2", "p-ben", "Ben", "#b1b1b1", 3)];

describe("scoreRows", () => {
    it("shows us, the league players on the board, and this round's scorers: scorers first, then by rounds won and name", () => {
        const rows = scoreRows("p-ana", league, presence, finds);
        assert.deepEqual(
            rows.map((r) => [r.name, r.finds, r.roundsWon]),
            [
                ["Ben", 2, 0],
                ["Cat", 1, 3],
                ["Dan", 0, 2],
                ["Eve", 0, 2],
                ["Ana", 0, 1],
            ],
            "Fay is off the board and scored nothing, and Gus never joined the room"
        );
    });

    it("crowns only a player strictly ahead this round, and marks our own row", () => {
        const rows = scoreRows("p-ana", league, presence, finds);
        assert.deepEqual(rows.filter((r) => r.leader).map((r) => r.name), ["Ben"]);
        assert.deepEqual(rows.filter((r) => r.self).map((r) => r.name), ["Ana"]);
        const tied = scoreRows("p-ana", league, presence, finds.slice(0, 2));
        assert.ok(tied.every((r) => !r.leader), "a tie has no leader");
        const lone = scoreRows("p-ana", league, presence, finds.slice(0, 1));
        assert.deepEqual(lone.filter((r) => r.leader).map((r) => r.name), ["Ben"], "a lone scorer leads");
    });

    it("colours a row from presence, else the player's latest find, else leaves it blank", () => {
        const rows = scoreRows("p-ana", league, presence, finds);
        assert.deepEqual(
            rows.map((r) => [r.name, r.color]),
            [
                ["Ben", "#bbbbbb"],
                ["Cat", "#c0c0c0"],
                ["Dan", "#dddddd"],
                ["Eve", "#eeeeee"],
                ["Ana", "#aaaaaa"],
            ]
        );
        assert.deepEqual(scoreRows("p-ana", league, null, []).map((r) => r.color), [""], "no presence and no find leaves it blank");
        const later = [find("t0", "p-cat", "Cat", "#c0c0c0", 1), find("t1", "p-cat", "Cat", "#c9c9c9", 2)];
        assert.equal(scoreRows("p-ana", league, null, later)[0].color, "#c9c9c9", "the latest find's colour");
    });

    it("names a row from the league, else presence, else the player's latest find", () => {
        const renamed = [entry("p-ben", "Benjamin")];
        const rows = scoreRows("p-ana", renamed, [here("p-ana", "Ana in presence", "#aaaaaa"), here("p-ben", "Ben in presence", "#bbbbbb")], [
            find("t0", "p-hal", "Hal", "#123456", 1),
            find("t1", "p-hal", "Hal later", "#123456", 2),
        ]);
        assert.deepEqual(rows.map((r) => r.name), ["Hal later", "Ana in presence", "Benjamin"]);
        assert.deepEqual(rows.map((r) => r.roundsWon), [0, 0, 0], "someone missing from the league has won nothing");
    });

    it("shows only us and this round's scorers when presence is unavailable", () => {
        const rows = scoreRows("p-ana", league, null, finds);
        assert.deepEqual(rows.map((r) => r.name), ["Ben", "Cat", "Ana"]);
    });

    it("keeps one row for a player whose two tabs are both on the board", () => {
        const rows = scoreRows("p-ana", league, [...presence, here("p-ana", "Ana", "#aaaaaa")], []);
        assert.equal(rows.filter((r) => r.name === "Ana").length, 1);
    });
});

describe("roundVerdict", () => {
    const rows = (self: string, f: Find[]) => scoreRows(self, league, presence, f);

    it("names the sole leader with its row's colour, and the score best first", () => {
        assert.deepEqual(roundVerdict("time-up", finds, rows("p-ana", finds)), { kind: "win", name: "Ben", color: "#bbbbbb", self: false, score: [2, 1, 0, 0, 0] });
        assert.deepEqual(roundVerdict("all-found", finds, rows("p-ben", finds)), { kind: "win", name: "Ben", color: "#bbbbbb", self: true, score: [2, 1, 0, 0, 0] });
    });

    it("calls a shared best a tie", () => {
        const tie = finds.slice(0, 2);
        assert.deepEqual(roundVerdict("time-up", tie, rows("p-ana", tie)), { kind: "tie", score: [1, 1, 0, 0, 0] });
    });

    it("keeps the plain headline for a cancelled round, a round nobody scored in, or a lone player", () => {
        assert.deepEqual(roundVerdict("cancelled", finds, rows("p-ana", finds)), { kind: "plain" });
        assert.deepEqual(roundVerdict("time-up", [], rows("p-ana", [])), { kind: "plain" });
        const alone = [find("t0", "p-ana", "Ana", "#aaaaaa", 1)];
        assert.deepEqual(roundVerdict("all-found", alone, scoreRows("p-ana", league, null, alone)), { kind: "plain" });
    });
});
