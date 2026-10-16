// Scene shapes the driver draws: stamps as preview lines, and the committed found marker.
// Drawdy rejects freedraw previews ("Frame and freedraw elements peview not yet supported"),
// so each stamp stroke becomes preview `line` elements. A line with two or more bend points
// renders as a Catmull-Rom spline through them, so strokes are split at sharp corners to keep
// those crisp.

import type { DrawdyElementSchema, DrawdyPreviewElementSchema, LocalAnimation } from "@drawdy/driver-protocol";
import type { Rect, Stamp, Target } from "../shared/hunt.ts";

export type Point = [number, number];

/** A turn sharper than this, in degrees, ends one line and starts the next. */
export const CORNER_DEG = 55;
/** The found marker circles the stamp with this much room to spare. */
const MARKER_PADDING = 1.35;

/** The stamp's strokes in canvas space, tilted about the target's centre and split at sharp corners. */
export function stampRuns(stamp: Stamp, target: Target): Point[][] {
    const { x, y, width, height } = target.rect;
    const cx = x + width / 2;
    const cy = y + height / 2;
    const theta = (target.rotationDeg * Math.PI) / 180;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const toCanvas = ([u, v]: readonly [number, number]): Point => {
        const dx = (u - 0.5) * width;
        const dy = (v - 0.5) * height;
        return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
    };

    const runs: Point[][] = [];
    for (const stroke of stamp.strokes) {
        const points = dedupe(stroke.map(toCanvas));
        let run: Point[] = points.slice(0, 1);
        for (let i = 1; i < points.length; i++) {
            run.push(points[i]);
            if (i < points.length - 1 && turnDeg(points[i - 1], points[i], points[i + 1]) > CORNER_DEG) {
                runs.push(run);
                run = [points[i]];
            }
        }
        if (run.length >= 2) runs.push(run);
    }
    return runs;
}

export function previewLines(ids: readonly string[], runs: readonly Point[][], color: string, strokeWidth: number): DrawdyPreviewElementSchema[] {
    return runs.map((run, i) => ({
        type: "line",
        drawdyElementId: ids[i],
        from: run[0],
        to: run[run.length - 1],
        ...(run.length > 2 ? { bend: run.slice(1, -1) } : {}),
        color,
        strokeColor: color,
        strokeWidth,
        roughness: 0,
    }));
}

/** A circle around a found target, kept inside the hunt frame so the frame owns it. */
export function foundMarker(args: {
    id: string;
    frameId: string;
    frameRect: Rect;
    target: Target;
    color: string;
    tag: string;
}): DrawdyElementSchema {
    const { frameRect: frame, target } = args;
    const theta = (target.rotationDeg * Math.PI) / 180;
    const tilted = target.rect.width * (Math.abs(Math.cos(theta)) + Math.abs(Math.sin(theta)));
    const size = Math.min(tilted * MARKER_PADDING, frame.width, frame.height);
    const cx = target.rect.x + target.rect.width / 2;
    const cy = target.rect.y + target.rect.height / 2;
    return {
        type: "shape",
        componentType: "circle",
        drawdyElementId: args.id,
        x: clamp(cx - size / 2, frame.x, frame.x + frame.width - size),
        y: clamp(cy - size / 2, frame.y, frame.y + frame.height - size),
        width: size,
        height: size,
        strokeColor: args.color,
        fillColor: "transparent",
        strokeWidth: Math.max(2, size / 25),
        roughness: 1,
        frameId: args.frameId,
        meta: { iitFound: args.tag },
    };
}

/** The marker pops in: scales up past full size, settles, and fades in on the way. */
export const FOUND_POP: LocalAnimation = {
    time: { durationMs: 550, curve: "ease-in-out", repeat: "none" },
    animation: {
        transform: { width: [0.2, 1.3, 0.92, 1], height: [0.2, 1.3, 0.92, 1], opacity: [0, 1, 1, 1] },
        curve: "catmull",
    },
};

/** Where the stamp lands once the hunt frame has moved since planting (protocol.ts header rule). */
export function shifted(target: Target, offset: { dx: number; dy: number }): Target {
    return { ...target, rect: { ...target.rect, x: target.rect.x + offset.dx, y: target.rect.y + offset.dy } };
}

function dedupe(points: Point[]): Point[] {
    return points.filter((p, i) => i === 0 || Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) > 1e-6);
}

function turnDeg(a: Point, b: Point, c: Point): number {
    const ab = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const bc = Math.atan2(c[1] - b[1], c[0] - b[0]);
    const turn = Math.abs(bc - ab) % (2 * Math.PI);
    return ((turn > Math.PI ? 2 * Math.PI - turn : turn) * 180) / Math.PI;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}
