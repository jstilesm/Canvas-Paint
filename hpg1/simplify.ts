import type { Point } from "./types";

// Freehand mouse/touch input arrives as a dense, jittery point stream - often several
// hundred points for a stroke the plotter could draw with a dozen. These helpers cut that
// down before it becomes HPGL, which keeps the command file small and stops the pen from
// stuttering over sub-millimetre noise.

function perpendicularDistance(p: Point, a: Point, b: Point): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;

    // Degenerate segment (a == b): fall back to plain point-to-point distance.
    if (lengthSquared === 0) return Math.hypot(p.x - a.x, p.y - a.y);

    // Project p onto the infinite line through a,b - no clamping, because RDP measures
    // deviation from the chord's line, not from the finite segment.
    return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / Math.sqrt(lengthSquared);
}

/**
 * Ramer-Douglas-Peucker. Keeps the points that carry the shape and drops the ones that sit
 * within `tolerance` of the line they'd be interpolated onto anyway. `tolerance` is in the
 * same units as the points (millimetres, everywhere we call this).
 */
export function simplifyPath(points: Point[], tolerance: number): Point[] {
    if (points.length <= 2 || tolerance <= 0) return points.slice();

    const first = points[0];
    const last = points[points.length - 1];

    let maxDistance = 0;
    let index = 0;
    for (let i = 1; i < points.length - 1; i++) {
        const distance = perpendicularDistance(points[i], first, last);
        if (distance > maxDistance) {
            maxDistance = distance;
            index = i;
        }
    }

    if (maxDistance <= tolerance) return [first, last];

    // The furthest point must survive, so split there and simplify each half independently.
    const left = simplifyPath(points.slice(0, index + 1), tolerance);
    const right = simplifyPath(points.slice(index), tolerance);
    return [...left.slice(0, -1), ...right];
}

/**
 * Drops points closer than `minDistance` to the previously kept point. Runs before RDP to
 * strip the clusters a pointer emits when it pauses in place - RDP alone leaves those in,
 * since a cluster deviates from its own chord by ~0.
 */
export function dedupePath(points: Point[], minDistance: number): Point[] {
    if (points.length === 0) return [];

    const kept: Point[] = [points[0]];
    for (let i = 1; i < points.length; i++) {
        const previous = kept[kept.length - 1];
        if (Math.hypot(points[i].x - previous.x, points[i].y - previous.y) >= minDistance) {
            kept.push(points[i]);
        }
    }

    // Always preserve the true endpoint so a stroke doesn't get visibly clipped short.
    const last = points[points.length - 1];
    const lastKept = kept[kept.length - 1];
    if (kept.length > 1 && (lastKept.x !== last.x || lastKept.y !== last.y)) kept.push(last);

    return kept;
}

/**
 * Three-point moving average over the interior points, applied `passes` times. Takes the
 * hand-shake out of freehand input; endpoints are pinned so strokes still start and finish
 * where the user lifted the pen.
 */
export function smoothPath(points: Point[], passes: number = 1): Point[] {
    let current = points;
    for (let pass = 0; pass < passes; pass++) {
        if (current.length <= 2) return current.slice();
        const next: Point[] = [current[0]];
        for (let i = 1; i < current.length - 1; i++) {
            next.push({
                x: (current[i - 1].x + current[i].x + current[i + 1].x) / 3,
                y: (current[i - 1].y + current[i].y + current[i + 1].y) / 3,
            });
        }
        next.push(current[current.length - 1]);
        current = next;
    }
    return current;
}

/** Total pen-down travel of a path, in the path's own units. */
export function pathLength(points: Point[]): number {
    let total = 0;
    for (let i = 1; i < points.length; i++) {
        total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    }
    return total;
}
