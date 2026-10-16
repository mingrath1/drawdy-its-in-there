import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SubscribedDrawdyElement } from "@drawdy/driver-protocol";
import { encode, isCommand } from "../shared/protocol.ts";
import type { Command } from "../shared/protocol.ts";
import { boardSnapshot } from "./board.ts";

const FRAME = { x: 0, y: 0, width: 1000, height: 800 };

function freedraw(id: string, points: number): SubscribedDrawdyElement {
    return {
        id,
        type: "freedraw",
        x: 10,
        y: 10,
        width: 100,
        height: 50,
        strokeColor: "oklch(0.93 0.005 260)",
        strokeWidth: 2,
        points: Array.from({ length: points }, (_, i): [number, number] => [10 + i, 10 + (i % 50)]),
    };
}

describe("boardSnapshot", () => {
    it("leaves out frames, our own hunt frame and found markers", () => {
        const board = boardSnapshot(FRAME, [
            freedraw("ink", 10),
            { id: "f", type: "frame", x: 0, y: 0, width: 1000, height: 800 },
            { id: "m", type: "path", componentType: "circle", x: 5, y: 5, width: 40, height: 40, meta: { iitFound: "r:t" } },
            { id: "h", type: "frame", x: 0, y: 0, width: 10, height: 10, meta: { iit: { v: 1 } } },
        ]);
        assert.equal(board.items.length, 1);
        assert.equal(board.items[0].kind, "freedraw");
    });

    it("maps element types to item kinds and keeps only ink colours", () => {
        const board = boardSnapshot(FRAME, [
            { id: "a", type: "path", componentType: "rect", x: 0, y: 0, width: 10, height: 10, strokeColor: "#ff0000", strokeWidth: 3 },
            { id: "b", type: "path", x: 0, y: 0, width: 10, height: 10, strokeColor: "#00ff00" },
            { id: "c", type: "path", componentType: "sticky-note", x: 0, y: 0, width: 10, height: 10, strokeColor: "#aec4ff" },
            { id: "d", type: "image", x: 0, y: 0, width: 10, height: 10, strokeColor: "#ffffff" },
            { id: "e", type: "text", x: 0, y: 0, width: 10, height: 10, strokeColor: "#0000ff" },
        ]);
        assert.deepEqual(
            board.items.map((i) => [i.kind, i.strokeColor]),
            [
                ["shape", "#ff0000"],
                ["line", "#00ff00"],
                ["shape", undefined],
                ["image", undefined],
                ["text", "#0000ff"],
            ]
        );
    });

    it("drops elements without usable geometry", () => {
        const board = boardSnapshot(FRAME, [
            { id: "a", type: "text", x: 0, y: 0, width: Number.NaN, height: 10 },
            { id: "b", type: "text", x: 0, y: 0 },
        ]);
        assert.deepEqual(board.items, []);
    });

    it("stays inside the wire limits on a crowded board", () => {
        const elements = Array.from({ length: 700 }, (_, i) => freedraw(`s${i}`, 400));
        const board = boardSnapshot(FRAME, elements);
        const command = { v: 1, type: "round.start", requestId: "r-1", board };
        assert.equal(isCommand(command), true);
        const first = board.items[0].points!;
        assert.deepEqual(first[0], [10, 10]);
        assert.deepEqual(first[first.length - 1], [409, 10 + (399 % 50)]);
    });

    it("rounds to one decimal, so 64 strokes of 128 fractional points upload in under 240,000 characters", () => {
        const elements = Array.from({ length: 64 }, (_, i): SubscribedDrawdyElement => ({
            ...freedraw(`s${i}`, 0),
            x: 1000.123456789,
            points: Array.from({ length: 128 }, (_, k): [number, number] => [1000 + i + k / 7, 2000 + k / 3]),
        }));
        const board = boardSnapshot(FRAME, elements);
        const command: Command = { v: 1, type: "round.start", requestId: "r-1", board };
        assert.ok(encode(command).length <= 240_000, `${encode(command).length} characters`);
        assert.equal(isCommand(command), true);
        assert.equal(board.items.length, 64);
        assert.equal(board.items[0].rect.x, 1000.1);
        assert.deepEqual(board.items[0].points![1], [1000.1, 2000.3]);
        assert.equal(board.items[0].points!.length, 128);
    });

    it("thins a board that would still be too big after rounding until the upload fits", () => {
        const color = `#${"a".repeat(63)}`;
        const elements = Array.from({ length: 500 }, (_, i): SubscribedDrawdyElement => ({
            id: `s${i}`,
            type: "freedraw",
            x: -9_999_990.25,
            y: -9_999_990.25,
            width: 9_999_999.25,
            height: 9_999_999.25,
            strokeColor: color,
            strokeWidth: 999.25,
            points: Array.from({ length: 400 }, (_, k): [number, number] => [-9_999_990.25 + k, -9_999_990.25 + i]),
        }));
        const board = boardSnapshot(FRAME, elements);
        const command: Command = { v: 1, type: "board.offer", requestId: "r".repeat(128), afterRoundId: "a".repeat(128), board };
        assert.ok(encode(command).length <= 240_000, `${encode(command).length} characters`);
        assert.equal(isCommand(command), true);
        assert.equal(board.items.length, 500, "thinning points was enough; no stroke was dropped");
    });
});
