import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Circle, Target } from "./hunt.ts";
import { judge } from "./judge.ts";

const SIDE = 40;
const TARGET: Target = {
    id: "r1:0",
    stampId: "cat",
    rect: { x: 480, y: 280, width: SIDE, height: SIDE },
    rotationDeg: 12,
    strokeColor: "#fff",
    strokeWidth: 2,
};
const CX = 500;
const CY = 300;

function arc(cx: number, cy: number, rx: number, ry: number, fromDeg: number, toDeg: number, steps = 48): [number, number][] {
    const points: [number, number][] = [];
    for (let i = 0; i <= steps; i++) {
        const a = ((fromDeg + ((toDeg - fromDeg) * i) / steps) * Math.PI) / 180;
        points.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
    }
    return points;
}

const stroke = (points: [number, number][]): Circle => ({ points });

describe("judge", () => {
    it("accepts a loose circle around the target", () => {
        assert.equal(judge(stroke(arc(CX + 4, CY - 3, SIDE * 0.9, SIDE * 0.8, 0, 360)), TARGET), true);
    });

    it("accepts a loop that is not quite closed", () => {
        assert.equal(judge(stroke(arc(CX, CY, SIDE, SIDE, -20, 290)), TARGET), true);
    });

    it("accepts a double loop", () => {
        assert.equal(judge(stroke(arc(CX, CY, SIDE * 0.9, SIDE * 0.9, 0, 720, 96)), TARGET), true);
    });

    it("accepts a loop that starts with a short run-up from outside", () => {
        const runUp: [number, number][] = [
            [CX + 70, CY + 50],
            [CX + 55, CY + 25],
        ];
        assert.equal(judge(stroke([...runUp, ...arc(CX, CY, SIDE, SIDE, 30, 400)]), TARGET), true);
    });

    it("accepts a circle up to about six target areas and rejects a bigger one", () => {
        assert.equal(judge(stroke(arc(CX, CY, SIDE * 1.3, SIDE * 1.3, 0, 360, 64)), TARGET), true);
        assert.equal(judge(stroke(arc(CX, CY, SIDE * 1.5, SIDE * 1.5, 0, 360, 64)), TARGET), false);
    });

    it("rejects circling the whole board", () => {
        assert.equal(judge(stroke(arc(600, 400, 900, 600, 0, 360)), TARGET), false);
    });

    it("rejects a circle that misses the centre", () => {
        assert.equal(judge(stroke(arc(CX + SIDE * 1.2, CY, SIDE * 0.8, SIDE * 0.8, 0, 360)), TARGET), false);
    });

    it("rejects a huge figure eight with the target inside one lobe", () => {
        const lobe = 400;
        const eight: [number, number][] = [];
        for (let i = 0; i <= 96; i++) {
            const t = (i / 96) * 2 * Math.PI;
            eight.push([CX + lobe / 2 + lobe * Math.sin(t), CY + (lobe / 2) * Math.sin(2 * t)]);
        }
        assert.equal(judge(stroke(eight), TARGET), false);
    });

    it("accepts a tight scribble over the centre", () => {
        const zigzag: [number, number][] = [];
        for (let i = 0; i <= 8; i++) zigzag.push([CX - 20 + i * 5, CY + (i % 2 === 0 ? -15 : 15)]);
        assert.equal(judge(stroke(zigzag), TARGET), true);
    });

    it("rejects a scribble beside the target", () => {
        const zigzag: [number, number][] = [];
        for (let i = 0; i <= 8; i++) zigzag.push([CX + 30 + i * 4, CY + (i % 2 === 0 ? -15 : 15)]);
        assert.equal(judge(stroke(zigzag), TARGET), false);
    });

    it("rejects a tap, a short flick, and a long swipe through the centre", () => {
        assert.equal(judge(stroke([[CX, CY]]), TARGET), false);
        assert.equal(judge(stroke([[CX - 5, CY], [CX + 5, CY]]), TARGET), false);
        assert.equal(judge(stroke([[CX - 400, CY], [CX, CY], [CX + 400, CY]]), TARGET), false);
    });
});
