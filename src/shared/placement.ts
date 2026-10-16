// Hides targets where the board is busiest, so they blend into what people drew.
// Pure and dependency-free: the room backend runs this same file.

import type { BoardItem, PlantFn, Rect, Target } from "./hunt.ts";

type Point = readonly [number, number];

/** Drawdy's adaptive foreground ink, which flips with the board theme. Used when no nearby ink has a colour. */
export const DEFAULT_STROKE_COLOR = "oklch(0.93 0.005 260)";
export const DEFAULT_STROKE_WIDTH = 2;

/** Cells along the frame's longer side in the clutter grid. */
const GRID_CELLS = 32;
/** A filled element (text, image) counts like this many strokes crossing each cell it covers. */
const FILL_INK_PER_CELL = 1;

// Tables indexed by difficulty 1, 2, 3, 4+.
/** Stamp side as a share of the local clutter scale. */
const SIZE_FACTOR = [0.9, 0.72, 0.58, 0.48];
/** How strongly a random draw competes with clutter when ranking spots. */
const NOISE_WEIGHT = [0.6, 0.35, 0.2, 0.12];
/** Largest tilt in degrees either way. */
const MAX_TILT_DEG = [10, 16, 22, 28];
/** Smallest stamp side, as a share of the frame's shorter side, so a target stays findable on screen. */
const MIN_SIDE_FRAC = [0.07, 0.055, 0.045, 0.035];

/** Largest stamp side, as a share of the frame's shorter side. */
const MAX_SIDE_FRAC = 0.3;
/** Clutter scale of an empty patch, as a share of the frame's shorter side. */
const EMPTY_SCALE_FRAC = 0.25;
/** Side of the neighbourhood that sets the local clutter scale, as a share of the frame's shorter side. */
const NEIGHBOURHOOD_FRAC = 0.2;
/** Clear space between two targets, as a share of the larger one's side. */
const GAP_FRAC = 0.2;
/** When a pass cannot fit every target, retry with stamps scaled by the next factor. */
const SHRINK_PASSES = [1, 0.75, 0.55];

/** Cells tile the frame exactly, so a short frame gets short cells rather than one row hanging past its edge. */
type Cells = {
    frame: Rect;
    cellWidth: number;
    cellHeight: number;
    cols: number;
    rows: number;
};

type Grid = Cells & {
    /** Blurred ink per cell, normalized so the busiest cell is 1. */
    clutter: Float64Array;
};

type Placement = {
    cx: number;
    cy: number;
    side: number;
    rotationDeg: number;
    /** Axis-aligned bounds of the tilted stamp box. */
    bounds: Rect;
};

export const plant: PlantFn = (req) => {
    const frame = req.board.frameRect;
    if (req.count <= 0 || req.stampIds.length === 0) return [];
    if (!(frame.width > 0 && frame.height > 0)) return [];

    const level = Math.min(Math.max(Math.floor(req.difficulty), 1), SIZE_FACTOR.length) - 1;
    const rand = mulberry32(req.seed);
    const grid = clutterGrid(frame, req.board.items);
    const frameMin = Math.min(frame.width, frame.height);
    const scaleOf = localScaleLookup(grid, req.board.items, frameMin);
    const cells = rankCells(grid, NOISE_WEIGHT[level], rand);
    const stampIds = shuffled(req.stampIds, rand);

    let placed: Placement[] = [];
    for (const shrink of SHRINK_PASSES) {
        placed = [];
        for (const cell of cells) {
            if (placed.length === req.count) break;
            const candidate = fitAt(cell, grid, {
                side: clamp(
                    scaleOf(cell) * SIZE_FACTOR[level],
                    frameMin * MIN_SIDE_FRAC[level],
                    frameMin * MAX_SIDE_FRAC
                ) * shrink,
                rotationDeg: (rand() * 2 - 1) * MAX_TILT_DEG[level],
                jitterX: rand() - 0.5,
                jitterY: rand() - 0.5,
            });
            if (candidate && !placed.some((p) => tooClose(p, candidate))) {
                placed.push(candidate);
            }
        }
        if (placed.length === req.count) break;
    }

    return placed.map((p, i): Target => {
        const style = nearestStyle(req.board.items, p.cx, p.cy);
        return {
            id: `${req.roundId}:${i}`,
            stampId: stampIds[i % stampIds.length],
            rect: { x: p.cx - p.side / 2, y: p.cy - p.side / 2, width: p.side, height: p.side },
            rotationDeg: p.rotationDeg,
            strokeColor: style.strokeColor,
            strokeWidth: clamp(style.strokeWidth, 1, Math.max(1, p.side / 8)),
        };
    });
};

/** Places a stamp centred near the cell, shifted inward so its tilted box stays inside the frame. */
function fitAt(
    cellIndex: number,
    grid: Grid,
    shape: { side: number; rotationDeg: number; jitterX: number; jitterY: number }
): Placement | null {
    const { frame, cellWidth, cellHeight, cols } = grid;
    const theta = (shape.rotationDeg * Math.PI) / 180;
    const half = (shape.side / 2) * (Math.abs(Math.cos(theta)) + Math.abs(Math.sin(theta)));
    if (2 * half > frame.width || 2 * half > frame.height) return null;

    const col = cellIndex % cols;
    const row = Math.floor(cellIndex / cols);
    const cx = clamp(frame.x + (col + 0.5 + shape.jitterX) * cellWidth, frame.x + half, frame.x + frame.width - half);
    const cy = clamp(frame.y + (row + 0.5 + shape.jitterY) * cellHeight, frame.y + half, frame.y + frame.height - half);
    return {
        cx,
        cy,
        side: shape.side,
        rotationDeg: shape.rotationDeg,
        bounds: { x: cx - half, y: cy - half, width: 2 * half, height: 2 * half },
    };
}

function tooClose(a: Placement, b: Placement): boolean {
    const gap = GAP_FRAC * Math.max(a.side, b.side);
    return (
        a.bounds.x < b.bounds.x + b.bounds.width + gap &&
        b.bounds.x < a.bounds.x + a.bounds.width + gap &&
        a.bounds.y < b.bounds.y + b.bounds.height + gap &&
        b.bounds.y < a.bounds.y + a.bounds.height + gap
    );
}

/** Cell indices, busiest first, with a random draw mixed in so each seed hides things differently. */
function rankCells(grid: Grid, noiseWeight: number, rand: () => number): number[] {
    const scored = Array.from(grid.clutter, (c, i) => ({ i, score: c + rand() * noiseWeight }));
    scored.sort((a, b) => b.score - a.score || a.i - b.i);
    return scored.map((s) => s.i);
}

function clutterGrid(frame: Rect, items: readonly BoardItem[]): Grid {
    /** The longer side of every cell, and the ink of a stroke crossing a cell that way. */
    const longSide = Math.max(frame.width, frame.height) / GRID_CELLS;
    const cols = Math.max(1, Math.ceil(frame.width / longSide));
    const rows = Math.max(1, Math.ceil(frame.height / longSide));
    const cells: Cells = { frame, cellWidth: frame.width / cols, cellHeight: frame.height / rows, cols, rows };
    const ink = new Float64Array(cols * rows);

    const addInk = (x: number, y: number, amount: number) => {
        const col = Math.floor((x - frame.x) / cells.cellWidth);
        const row = Math.floor((y - frame.y) / cells.cellHeight);
        if (col < 0 || row < 0 || col >= cols || row >= rows) return;
        ink[row * cols + col] += amount;
    };

    for (const item of items) {
        const paths = inkPaths(item);
        if (paths) {
            for (const path of paths) tracePath(path, cells, longSide / 4, addInk);
        } else {
            fillRect(item.rect, cells, (i, area) => {
                ink[i] += (FILL_INK_PER_CELL * area) / longSide;
            });
        }
    }

    const clutter = new Float64Array(cols * rows);
    let max = 0;
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            let sum = 0;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const r = row + dy;
                    const c = col + dx;
                    if (r >= 0 && c >= 0 && r < rows && c < cols) sum += ink[r * cols + c];
                }
            }
            clutter[row * cols + col] = sum;
            max = Math.max(max, sum);
        }
    }
    if (max > 0) for (let i = 0; i < clutter.length; i++) clutter[i] /= max;
    return { ...cells, clutter };
}

/** The strokes an item draws, or null when it is a filled block (text, image). */
function inkPaths(item: BoardItem): Point[][] | null {
    const { x, y, width: w, height: h } = item.rect;
    if (item.points && item.points.length > 0) return [item.points.slice()];
    switch (item.kind) {
        case "shape":
            return [[[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]];
        case "line":
        case "freedraw":
            return [[[x, y], [x + w, y + h]]];
        default:
            return null;
    }
}

/**
 * Inks each segment's part inside the frame, two samples per cell along the axis where it crosses more
 * cells. A clipped segment crosses at most GRID_CELLS cells, so a stroke reaching far off the frame costs no more.
 */
function tracePath(
    path: Point[],
    cells: Cells,
    dotInk: number,
    addInk: (x: number, y: number, amount: number) => void
) {
    if (path.length === 1) {
        addInk(path[0][0], path[0][1], dotInk);
        return;
    }
    for (let i = 1; i < path.length; i++) {
        const inside = clipToRect(path[i - 1], path[i], cells.frame);
        if (!inside) continue;
        const [[ax, ay], [bx, by]] = inside;
        const length = Math.hypot(bx - ax, by - ay);
        const crossed = Math.max(Math.abs(bx - ax) / cells.cellWidth, Math.abs(by - ay) / cells.cellHeight);
        const steps = Math.max(1, Math.ceil(2 * crossed));
        for (let s = 0; s < steps; s++) {
            const t = (s + 0.5) / steps;
            addInk(ax + (bx - ax) * t, ay + (by - ay) * t, length / steps);
        }
    }
}

/** The part of segment a-b inside the rect (Liang-Barsky), or null when it misses. */
function clipToRect(a: Point, b: Point, rect: Rect): [Point, Point] | null {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    let t0 = 0;
    let t1 = 1;
    const edges = [
        [-dx, a[0] - rect.x],
        [dx, rect.x + rect.width - a[0]],
        [-dy, a[1] - rect.y],
        [dy, rect.y + rect.height - a[1]],
    ];
    for (const [p, q] of edges) {
        if (p === 0) {
            if (q < 0) return null;
        } else if (p < 0) {
            t0 = Math.max(t0, q / p);
        } else {
            t1 = Math.min(t1, q / p);
        }
    }
    if (t0 > t1) return null;
    return [
        [a[0] + t0 * dx, a[1] + t0 * dy],
        [a[0] + t1 * dx, a[1] + t1 * dy],
    ];
}

function fillRect(rect: Rect, cells: Cells, add: (index: number, area: number) => void) {
    const { frame, cellWidth, cellHeight, cols, rows } = cells;
    const c0 = Math.max(0, Math.floor((rect.x - frame.x) / cellWidth));
    const c1 = Math.min(cols - 1, Math.floor((rect.x + rect.width - frame.x) / cellWidth));
    const r0 = Math.max(0, Math.floor((rect.y - frame.y) / cellHeight));
    const r1 = Math.min(rows - 1, Math.floor((rect.y + rect.height - frame.y) / cellHeight));
    for (let row = r0; row <= r1; row++) {
        for (let col = c0; col <= c1; col++) {
            const cx = frame.x + col * cellWidth;
            const cy = frame.y + row * cellHeight;
            const w = Math.min(cx + cellWidth, rect.x + rect.width) - Math.max(cx, rect.x);
            const h = Math.min(cy + cellHeight, rect.y + rect.height) - Math.max(cy, rect.y);
            if (w > 0 && h > 0) add(row * cols + col, w * h);
        }
    }
}

/** The median size of the things drawn around a cell, so a stamp matches its neighbours. */
function localScaleLookup(grid: Grid, items: readonly BoardItem[], frameMin: number) {
    const cache = new Map<number, number>();
    const reach = (frameMin * NEIGHBOURHOOD_FRAC) / 2;
    return (cellIndex: number): number => {
        const cached = cache.get(cellIndex);
        if (cached !== undefined) return cached;
        const cx = grid.frame.x + ((cellIndex % grid.cols) + 0.5) * grid.cellWidth;
        const cy = grid.frame.y + (Math.floor(cellIndex / grid.cols) + 0.5) * grid.cellHeight;
        const sizes: number[] = [];
        for (const { rect } of items) {
            const near =
                rect.x < cx + reach &&
                rect.x + rect.width > cx - reach &&
                rect.y < cy + reach &&
                rect.y + rect.height > cy - reach;
            if (near) sizes.push(Math.min(Math.max(rect.width, rect.height), frameMin / 2));
        }
        const scale = sizes.length > 0 ? median(sizes) : frameMin * EMPTY_SCALE_FRAC;
        cache.set(cellIndex, scale);
        return scale;
    };
}

function nearestStyle(items: readonly BoardItem[], x: number, y: number) {
    let best: BoardItem | null = null;
    let bestDistance = Infinity;
    for (const item of items) {
        if (!item.strokeColor) continue;
        const dx = Math.max(item.rect.x - x, 0, x - (item.rect.x + item.rect.width));
        const dy = Math.max(item.rect.y - y, 0, y - (item.rect.y + item.rect.height));
        const distance = Math.hypot(dx, dy);
        if (distance < bestDistance) {
            best = item;
            bestDistance = distance;
        }
    }
    return {
        strokeColor: best?.strokeColor ?? DEFAULT_STROKE_COLOR,
        strokeWidth: best?.strokeWidth ?? DEFAULT_STROKE_WIDTH,
    };
}

function median(values: number[]): number {
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

function shuffled<T>(values: readonly T[], rand: () => number): T[] {
    const out = values.slice();
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

/** mulberry32: a tiny seeded PRNG, so every client and the room plant identical targets. */
function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
