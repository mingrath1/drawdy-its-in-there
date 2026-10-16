import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BoardItem, PlantRequest, Rect, Target } from "./hunt.ts";
import { DEFAULT_STROKE_COLOR, plant } from "./placement.ts";

const FRAME: Rect = { x: 100, y: -50, width: 1200, height: 800 };

/** A zigzag scribble filling `area`, made of short freedraw strokes like a real doodle. */
function scribbles(area: Rect, strokeColor: string, strokeWidth = 3): BoardItem[] {
    const items: BoardItem[] = [];
    const size = 60;
    for (let y = area.y; y + size <= area.y + area.height; y += size) {
        for (let x = area.x; x + size <= area.x + area.width; x += size) {
            const points: [number, number][] = [];
            for (let i = 0; i <= 12; i++) {
                points.push([x + (i * size) / 12, y + (i % 2 === 0 ? 5 : size - 5)]);
            }
            items.push({ rect: { x, y, width: size, height: size }, kind: "freedraw", strokeColor, strokeWidth, points });
        }
    }
    return items;
}

function request(items: BoardItem[], overrides: Partial<PlantRequest> = {}): PlantRequest {
    return {
        roundId: "r1",
        seed: 42,
        difficulty: 1,
        count: 3,
        board: { frameRect: FRAME, items },
        stampIds: ["cat", "229"],
        ...overrides,
    };
}

/** The axis-aligned box the stamp covers once drawn tilted about its centre. */
function tiltedBounds(t: Target): Rect {
    const theta = (t.rotationDeg * Math.PI) / 180;
    const half = (t.rect.width / 2) * (Math.abs(Math.cos(theta)) + Math.abs(Math.sin(theta)));
    const cx = t.rect.x + t.rect.width / 2;
    const cy = t.rect.y + t.rect.height / 2;
    return { x: cx - half, y: cy - half, width: 2 * half, height: 2 * half };
}

const centre = (t: Target) => [t.rect.x + t.rect.width / 2, t.rect.y + t.rect.height / 2] as const;
const inside = (r: Rect, [x, y]: readonly [number, number]) =>
    x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
const overlaps = (a: Rect, b: Rect) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const DENSE: Rect = { x: 100, y: -50, width: 540, height: 800 };
const boards = {
    empty: [] as BoardItem[],
    dense: scribbles(DENSE, "#ff4d4d"),
    everywhere: scribbles(FRAME, "#698CF9"),
};

describe("plant", () => {
    it("returns the same targets for the same seed and different targets for another seed", () => {
        const a = plant(request(boards.dense));
        const b = plant(request(boards.dense));
        const c = plant(request(boards.dense, { seed: 43 }));
        assert.deepEqual(a, b);
        assert.notDeepEqual(a, c);
    });

    it("places the requested count with ids unique to the round and stamps from the list", () => {
        for (const [name, items] of Object.entries(boards)) {
            for (const count of [3, 4, 5]) {
                const targets = plant(request(items, { count }));
                assert.equal(targets.length, count, `${name} count ${count}`);
                assert.equal(new Set(targets.map((t) => t.id)).size, count);
                for (const t of targets) assert.ok(["cat", "229"].includes(t.stampId));
            }
        }
    });

    it("keeps every tilted stamp fully inside the frame", () => {
        for (const items of Object.values(boards)) {
            for (let seed = 0; seed < 40; seed++) {
                for (const difficulty of [1, 2, 3, 6]) {
                    for (const t of plant(request(items, { seed, difficulty, count: 5 }))) {
                        const b = tiltedBounds(t);
                        assert.ok(b.x >= FRAME.x - 1e-9 && b.y >= FRAME.y - 1e-9, `seed ${seed}`);
                        assert.ok(b.x + b.width <= FRAME.x + FRAME.width + 1e-9, `seed ${seed}`);
                        assert.ok(b.y + b.height <= FRAME.y + FRAME.height + 1e-9, `seed ${seed}`);
                    }
                }
            }
        }
    });

    it("never overlaps two targets", () => {
        for (const items of Object.values(boards)) {
            for (let seed = 0; seed < 40; seed++) {
                const targets = plant(request(items, { seed, difficulty: 3, count: 5 }));
                for (let i = 0; i < targets.length; i++) {
                    for (let j = i + 1; j < targets.length; j++) {
                        assert.ok(!overlaps(tiltedBounds(targets[i]), tiltedBounds(targets[j])), `seed ${seed}`);
                    }
                }
            }
        }
    });

    it("prefers cluttered parts of the board, more so at higher difficulty", () => {
        const share = (difficulty: number) => {
            let hits = 0;
            let total = 0;
            for (let seed = 0; seed < 30; seed++) {
                for (const t of plant(request(boards.dense, { seed, difficulty, count: 4 }))) {
                    total++;
                    if (inside(DENSE, centre(t))) hits++;
                }
            }
            return hits / total;
        };
        // The scribbled area is 45% of the frame.
        assert.ok(share(1) > 0.6, `difficulty 1 share ${share(1)}`);
        assert.ok(share(3) > 0.9, `difficulty 3 share ${share(3)}`);
    });

    it("draws smaller stamps at higher difficulty", () => {
        const meanSide = (difficulty: number) => {
            const sides = [];
            for (let seed = 0; seed < 20; seed++) {
                for (const t of plant(request(boards.everywhere, { seed, difficulty }))) sides.push(t.rect.width);
            }
            return sides.reduce((a, b) => a + b, 0) / sides.length;
        };
        assert.ok(meanSide(3) < meanSide(1) * 0.8);
    });

    it("copies the stroke colour and width of the nearest ink", () => {
        const left = scribbles({ x: 100, y: -50, width: 480, height: 800 }, "#ff4d4d", 4);
        const right = scribbles({ x: 820, y: -50, width: 480, height: 800 }, "#698CF9", 3);
        for (let seed = 0; seed < 20; seed++) {
            for (const t of plant(request([...left, ...right], { seed, count: 4 }))) {
                const [x] = centre(t);
                if (x < 580) assert.equal(t.strokeColor, "#ff4d4d");
                if (x > 820) assert.equal(t.strokeColor, "#698CF9");
                assert.ok(t.strokeWidth >= 1 && t.strokeWidth <= 4);
            }
        }
    });

    it("still hides targets on an empty board, in the default ink", () => {
        const targets = plant(request([], { count: 5 }));
        assert.equal(targets.length, 5);
        for (const t of targets) assert.equal(t.strokeColor, DEFAULT_STROKE_COLOR);
    });

    it("plants within 200 ms when strokes, shapes, and lines reach far outside the frame", () => {
        const frameRect: Rect = { x: 0, y: 0, width: 800, height: 600 };
        const zigzag = Array.from({ length: 128 }, (_, i): [number, number] => (i % 2 === 0 ? [0, 0] : [1e7, 0]));
        const huge: Rect = { x: -1e7, y: -1e7, width: 2e7, height: 2e7 };
        const boards: Record<string, BoardItem[]> = {
            freedraw: Array.from({ length: 64 }, () => ({ rect: { x: 0, y: 0, width: 1e7, height: 0 }, kind: "freedraw", points: zigzag })),
            shape: Array.from({ length: 500 }, () => ({ rect: huge, kind: "shape" })),
            line: Array.from({ length: 500 }, () => ({ rect: huge, kind: "line" })),
        };
        for (const [name, items] of Object.entries(boards)) {
            const started = performance.now();
            const targets = plant(request(items, { board: { frameRect, items } }));
            const elapsed = performance.now() - started;
            assert.ok(elapsed < 200, `${name} took ${elapsed.toFixed(0)} ms`);
            assert.equal(targets.length, 3, name);
        }
    });

    it("inks a stroke that leaves the frame like the part of it inside the frame", () => {
        const frameRect: Rect = { x: 0, y: 0, width: 800, height: 600 };
        const stroke = (from: [number, number], to: [number, number]): BoardItem => ({
            rect: { x: 0, y: 0, width: 800, height: 600 },
            kind: "freedraw",
            points: [from, to],
        });
        const inside = [stroke([0, 100], [800, 100]), stroke([200, 0], [200, 600])];
        const reaching = [stroke([-1e6, 100], [1e6, 100]), stroke([200, -5e6], [200, 5e6])];
        for (let seed = 0; seed < 10; seed++) {
            assert.deepEqual(
                plant(request(reaching, { seed, board: { frameRect, items: reaching } })),
                plant(request(inside, { seed, board: { frameRect, items: inside } })),
                `seed ${seed}`,
            );
        }
    });

    it("hides nothing without stamps or with a zero count", () => {
        assert.deepEqual(plant(request(boards.dense, { stampIds: [] })), []);
        assert.deepEqual(plant(request(boards.dense, { count: 0 })), []);
    });
});
