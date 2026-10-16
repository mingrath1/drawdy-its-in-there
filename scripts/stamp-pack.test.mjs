import assert from "node:assert/strict";
import { test } from "node:test";
import { STAMP_PACK } from "../src/stamp-pack.ts";

const isClosed = (stroke) => {
    const first = stroke[0];
    const last = stroke[stroke.length - 1];
    return stroke.length > 2 && first[0] === last[0] && first[1] === last[1];
};

test("every point sits inside the 0..1 box", () => {
    for (const stamp of STAMP_PACK) {
        for (const [x, y] of stamp.strokes.flat()) {
            assert.ok(x >= 0 && x <= 1 && y >= 0 && y <= 1, `${stamp.id} has point [${x}, ${y}] outside 0..1`);
        }
    }
});

test("every stroke has at least two points", () => {
    for (const stamp of STAMP_PACK) {
        for (const stroke of stamp.strokes) {
            assert.ok(stroke.length >= 2, `${stamp.id} has a stroke with ${stroke.length} point(s)`);
        }
    }
});

test("every closed stroke has 8 to 40 points", () => {
    for (const stamp of STAMP_PACK) {
        for (const stroke of stamp.strokes.filter(isClosed)) {
            assert.ok(
                stroke.length >= 8 && stroke.length <= 40,
                `${stamp.id} has a closed stroke with ${stroke.length} points`,
            );
        }
    }
});

test("the pack has 14 stamps with unique ids", () => {
    const ids = STAMP_PACK.map((stamp) => stamp.id);
    assert.equal(ids.length, 14);
    assert.equal(new Set(ids).size, ids.length);
});
