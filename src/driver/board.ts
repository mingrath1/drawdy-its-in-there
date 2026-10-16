// Turns what query-rect returns into the BoardSnapshot the host plants into, within the wire limits.

import type { SubscribeableKey, SubscribedDrawdyElement } from "@drawdy/driver-protocol";
import type { BoardItem, BoardSnapshot, Rect } from "../shared/hunt.ts";
import { MAX_BOARD_ITEMS, MAX_POINTS_PER_ITEM, MAX_TOTAL_POINTS } from "../shared/protocol.ts";

export const BOARD_PROPERTIES = [
    "type",
    "componentType",
    "x",
    "y",
    "width",
    "height",
    "points",
    "strokeColor",
    "strokeWidth",
    "meta",
] satisfies SubscribeableKey[];

const LIMIT = 1e7;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= LIMIT;
const usableColor = (v: unknown): v is string =>
    typeof v === "string" && v.length > 0 && v.length <= 64 && !/[\u0000-\u001f\u007f]/.test(v);

/** Our own scene writes (hunt frames, found markers) are not part of the board. */
export function isOurs(element: SubscribedDrawdyElement): boolean {
    const meta = element.meta;
    return typeof meta === "object" && meta !== null && ("iit" in meta || "iitFound" in meta);
}

export function boardSnapshot(frameRect: Rect, elements: readonly SubscribedDrawdyElement[]): BoardSnapshot {
    const kept = elements.filter((e) => e.type !== "frame" && !isOurs(e)).slice(0, MAX_BOARD_ITEMS);
    const strokes = kept.filter((e) => e.type === "freedraw" && Array.isArray(e.points)).length;
    const pointBudget = Math.min(MAX_POINTS_PER_ITEM, Math.max(2, Math.floor(MAX_TOTAL_POINTS / Math.max(1, strokes))));
    const items: BoardItem[] = [];
    for (const element of kept) {
        const item = toItem(element, pointBudget);
        if (item) items.push(item);
    }
    return { frameRect, items };
}

function toItem(e: SubscribedDrawdyElement, pointBudget: number): BoardItem | null {
    if (!finite(e.x) || !finite(e.y) || !finite(e.width) || !finite(e.height)) return null;
    if (e.width < 0 || e.height < 0) return null;
    const rect = { x: e.x, y: e.y, width: e.width, height: e.height };
    const kind = kindOf(e);
    const item: BoardItem = { rect, kind };

    // Sticky-note and image stroke colours are tape and border, not ink worth imitating.
    const inked = kind !== "image" && kind !== "other" && e.componentType !== "sticky-note";
    if (inked && usableColor(e.strokeColor)) item.strokeColor = e.strokeColor;
    if (inked && finite(e.strokeWidth) && e.strokeWidth >= 0 && e.strokeWidth <= 1000) item.strokeWidth = e.strokeWidth;

    if (kind === "freedraw" && Array.isArray(e.points)) {
        const points = e.points.filter((p) => finite(p[0]) && finite(p[1])).map((p): [number, number] => [p[0], p[1]]);
        if (points.length > 0) item.points = thin(points, pointBudget);
    }
    return item;
}

function kindOf(e: SubscribedDrawdyElement): BoardItem["kind"] {
    switch (e.type) {
        case "freedraw":
            return "freedraw";
        case "text":
            return "text";
        case "image":
            return "image";
        case "path":
            // A path without a componentType is a line, an arrow, or a shape the protocol does not name.
            return e.componentType ? "shape" : "line";
        default:
            return "other";
    }
}

/** Keeps the first and last point and evenly spaced ones between. */
function thin(points: [number, number][], max: number): [number, number][] {
    if (points.length <= max) return points;
    const out: [number, number][] = [];
    for (let i = 0; i < max; i++) out.push(points[Math.round((i * (points.length - 1)) / (max - 1))]);
    return out;
}
