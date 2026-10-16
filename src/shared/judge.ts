// Decides whether a laser stroke found a target. Pure: the room backend can re-judge a claim.

import type { Circle, JudgeFn, Target } from "./hunt.ts";

type Point = readonly [number, number];

/**
 * A loop counts only when its convex hull covers at most this many target areas.
 * A loose circle around a square target covers about 2 to 4, so 6 forgives sloppy
 * hands while circling the whole board fails. The hull, unlike the polygon's own
 * area, cannot be shrunk by crossing the stroke over itself in a figure eight.
 */
export const MAX_LOOP_AREA_RATIO = 6;
/** A scribble counts when its path passes this close to the centre, in target sides. */
export const SCRIBBLE_HIT_RADIUS = 0.3;
/** A scribble stays within a box this many target sides across. */
export const SCRIBBLE_MAX_SPAN = 1.5;
/** A scribble's path is at least this many target sides long, so a tap or a flick does not count. */
export const SCRIBBLE_MIN_LENGTH = 1.5;

export const judge: JudgeFn = (circle, target) => {
    const points = circle.points;
    if (points.length < 2) return false;
    const side = Math.sqrt(target.rect.width * target.rect.height);
    const centre: Point = [target.rect.x + target.rect.width / 2, target.rect.y + target.rect.height / 2];
    return encloses(points, centre, target) || scribblesOver(points, centre, side);
};

function encloses(points: Circle["points"], centre: Point, target: Target): boolean {
    if (points.length < 3 || windingNumber(points, centre) === 0) return false;
    return hullArea(points) <= MAX_LOOP_AREA_RATIO * target.rect.width * target.rect.height;
}

function scribblesOver(points: Circle["points"], centre: Point, side: number): boolean {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of points) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
    }
    if (Math.max(maxX - minX, maxY - minY) > SCRIBBLE_MAX_SPAN * side) return false;

    let length = 0;
    let nearest = Infinity;
    for (let i = 1; i < points.length; i++) {
        length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
        nearest = Math.min(nearest, distanceToSegment(centre, points[i - 1], points[i]));
    }
    return length >= SCRIBBLE_MIN_LENGTH * side && nearest <= SCRIBBLE_HIT_RADIUS * side;
}

/** Non-zero winding of the stroke closed back to its start, so a double loop still counts as around. */
function windingNumber(points: Circle["points"], [px, py]: Point): number {
    let winding = 0;
    for (let i = 0; i < points.length; i++) {
        const [ax, ay] = points[i];
        const [bx, by] = points[(i + 1) % points.length];
        const side = (bx - ax) * (py - ay) - (px - ax) * (by - ay);
        if (ay <= py) {
            if (by > py && side > 0) winding++;
        } else if (by <= py && side < 0) {
            winding--;
        }
    }
    return winding;
}

function hullArea(points: Circle["points"]): number {
    const sorted = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower: Point[] = [];
    for (const p of sorted) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
        lower.push(p);
    }
    const upper: Point[] = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
        const p = sorted[i];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
        upper.push(p);
    }
    const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
    let twice = 0;
    for (let i = 0; i < hull.length; i++) {
        const [ax, ay] = hull[i];
        const [bx, by] = hull[(i + 1) % hull.length];
        twice += ax * by - bx * ay;
    }
    return Math.abs(twice) / 2;
}

function distanceToSegment([px, py]: Point, [ax, ay]: Point, [bx, by]: Point): number {
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
