import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ROUND_TRANSITIONS } from "./hunt.ts";
import type { Find, Round, RoundStatus, Target } from "./hunt.ts";
import { allFound, claimFind, endRound, markReady, plantingRound, startRound } from "./round.ts";
import type { RoundResult } from "./round.ts";

const FRAME = { x: 0, y: 0, width: 800, height: 600 };
const target = (id: string): Target => ({
    id,
    stampId: "cat",
    rect: { x: 10, y: 10, width: 40, height: 40 },
    rotationDeg: 0,
    strokeColor: "#fff",
    strokeWidth: 2,
});
const TARGETS = [target("r1:0"), target("r1:1")];
const find = (targetId: string, playerId = "ana", at = 1_500): Find => ({
    targetId,
    playerId,
    playerName: playerId,
    playerColor: "#ff4d4d",
    at,
});

function unwrap(result: RoundResult): Round {
    assert.ok(result.ok, `rejected: ${JSON.stringify(!result.ok && result.rejection)}`);
    return result.round;
}

const sample: Record<RoundStatus, Round> = (() => {
    const planting = plantingRound("r1", FRAME, 1);
    const ready = unwrap(markReady(planting, TARGETS));
    const live = unwrap(startRound(ready, 1_000, 60_000));
    const ended = unwrap(endRound(live, 2_000, "cancelled"));
    return { planting, ready, live, ended };
})();

describe("round", () => {
    it("runs planting, ready, live, and ends when every target is found", () => {
        const live = sample.live;
        assert.equal(live.status, "live");
        assert.equal(live.status === "live" && live.endsAt, 61_000);

        const one = unwrap(claimFind(live, find("r1:0")));
        assert.equal(allFound(one), false);
        const both = unwrap(claimFind(one, find("r1:1", "ben", 1_600)));
        assert.equal(allFound(both), true);

        const ended = unwrap(endRound(both, 1_700, "all-found"));
        assert.deepEqual(ended, {
            status: "ended",
            id: "r1",
            frameRect: FRAME,
            targets: TARGETS,
            startedAt: 1_000,
            endedAt: 1_700,
            finds: [find("r1:0"), find("r1:1", "ben", 1_600)],
            reason: "all-found",
        });
    });

    it("allows exactly the transitions in ROUND_TRANSITIONS", () => {
        const helpers: [RoundStatus, (r: Round) => RoundResult][] = [
            ["ready", (r) => markReady(r, TARGETS)],
            ["live", (r) => startRound(r, 5_000, 60_000)],
            ["ended", (r) => endRound(r, 5_000, "time-up")],
        ];
        for (const [from, round] of Object.entries(sample) as [RoundStatus, Round][]) {
            for (const [to, apply] of helpers) {
                const result = apply(round);
                const allowed = ROUND_TRANSITIONS[from].includes(to);
                assert.equal(result.ok, allowed, `${from} -> ${to}`);
                if (result.ok) assert.equal(result.round.status, to);
                else assert.deepEqual(result.rejection, { kind: "illegal-transition", from, to });
            }
        }
    });

    it("accepts finds only while live", () => {
        for (const status of ["planting", "ready", "ended"] as const) {
            const result = claimFind(sample[status], find("r1:0"));
            assert.deepEqual(result, { ok: false, rejection: { kind: "illegal-transition", from: status, to: "live" } });
        }
    });

    it("rejects a second claim on the same target and keeps the first finder", () => {
        const first = unwrap(claimFind(sample.live, find("r1:0", "ana")));
        const second = claimFind(first, find("r1:0", "ben", 1_501));
        assert.deepEqual(second, { ok: false, rejection: { kind: "already-found", targetId: "r1:0", by: "ana" } });
    });

    it("rejects an unknown target and a find after the clock ran out", () => {
        assert.deepEqual(claimFind(sample.live, find("nope")), {
            ok: false,
            rejection: { kind: "unknown-target", targetId: "nope" },
        });
        assert.deepEqual(claimFind(sample.live, find("r1:0", "ana", 61_000)), {
            ok: false,
            rejection: { kind: "too-late", endsAt: 61_000, at: 61_000 },
        });
        assert.equal(claimFind(sample.live, find("r1:0", "ana", 60_999)).ok, true);
    });

    it("leaves the round it was given untouched", () => {
        const before = structuredClone(sample.live);
        unwrap(claimFind(sample.live, find("r1:0")));
        assert.deepEqual(sample.live, before);
    });
});
