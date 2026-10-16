import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Stamp, Target } from "../shared/hunt.ts";
import { STAMP_PACK } from "../stamp-pack.ts";
import { foundMarker, previewLines, shifted, stampRuns } from "./render.ts";

const target = (rotationDeg: number): Target => ({
    id: "r:0",
    stampId: "x",
    rect: { x: 100, y: 200, width: 60, height: 60 },
    rotationDeg,
    strokeColor: "#fff",
    strokeWidth: 2,
});

const stamp = (strokes: Stamp["strokes"]): Stamp => ({ id: "x", label: "x", strokes });

describe("stampRuns", () => {
    it("keeps every point inside the tilted target box", () => {
        for (const s of STAMP_PACK) {
            for (const deg of [-28, 0, 17]) {
                const t = target(deg);
                const theta = (deg * Math.PI) / 180;
                const half = 30 * (Math.abs(Math.cos(theta)) + Math.abs(Math.sin(theta)));
                for (const [x, y] of stampRuns(s, t).flat()) {
                    assert.ok(Math.abs(x - 130) <= half + 1e-9 && Math.abs(y - 230) <= half + 1e-9, `${s.id} at ${deg}°`);
                }
            }
        }
    });

    it("maps the box corners onto the target rect when untilted", () => {
        const runs = stampRuns(stamp([[[0, 0], [1, 1]]]), target(0));
        assert.deepEqual(runs, [[[100, 200], [160, 260]]]);
    });

    it("splits a stroke at a sharp corner and keeps a gentle curve whole", () => {
        const vee = stampRuns(stamp([[[0, 0], [0.5, 1], [1, 0]]]), target(0));
        assert.equal(vee.length, 2);
        const arc: [number, number][] = [];
        for (let i = 0; i <= 12; i++) arc.push([0.5 + 0.4 * Math.cos((i * Math.PI) / 12), 0.5 + 0.4 * Math.sin((i * Math.PI) / 12)]);
        assert.equal(stampRuns(stamp([arc]), target(0)).length, 1);
    });
});

describe("previewLines", () => {
    it("draws each run as a line through its inner points", () => {
        const [straight, curved] = previewLines(
            ["a", "b"],
            [
                [[0, 0], [10, 0]],
                [[0, 0], [5, 5], [10, 0], [15, 5]],
            ],
            "#ff4d4d",
            3
        );
        assert.deepEqual(straight, {
            type: "line",
            drawdyElementId: "a",
            from: [0, 0],
            to: [10, 0],
            color: "#ff4d4d",
            strokeColor: "#ff4d4d",
            strokeWidth: 3,
            roughness: 0,
        });
        assert.equal(curved.type === "line" && JSON.stringify(curved.bend), JSON.stringify([[5, 5], [10, 0]]));
    });
});

describe("foundMarker", () => {
    it("circles the target inside the frame and carries the dedupe tag", () => {
        const frameRect = { x: 90, y: 190, width: 400, height: 400 };
        const marker = foundMarker({ id: "m", frameId: "f", frameRect, target: target(0), color: "#ff4d4d", tag: "r:r:0" });
        assert.equal(marker.type, "shape");
        if (marker.type !== "shape") return;
        assert.ok(marker.x >= frameRect.x && marker.y >= frameRect.y);
        assert.ok(marker.x <= 100 && marker.x + (marker.width ?? 0) >= 160);
        assert.equal(marker.frameId, "f");
        assert.deepEqual(marker.meta, { iitFound: "r:r:0" });
    });

    it("follows a frame that moved since planting", () => {
        assert.deepEqual(shifted(target(0), { dx: 50, dy: -20 }).rect, { x: 150, y: 180, width: 60, height: 60 });
    });
});
