import HGPL from "./commands";
import { BED_MM, DEFAULT_PEN, UNITS_PER_MM, resolvePen } from "./bed";
import { dedupePath, pathLength, simplifyPath, smoothPath } from "./simplify";
import type { Point } from "./types";

// Bridges the browser canvas to the HPGL interpreter. The two live in different coordinate
// spaces: canvas pixels run top-left origin with Y down, the plotter runs bottom-left origin
// with Y up and measures in millimetres. Everything here exists to cross that gap.

export type CanvasStroke = {
    pen: number;
    points: Point[]; // canvas pixels, top-left origin
    /**
     * Tremor removal, for sampled pointer input only. Off for anything that is already
     * geometry - a moving average over a rectangle's corners visibly rounds them off.
     * Defaults to true.
     */
    smooth?: boolean;
    /**
     * Redundant-point removal (RDP). Off for paths that are already minimal, like a drawn
     * rectangle or a hatch run, where it can only take away. On for anything sampled -
     * freehand input and imported SVG alike. Defaults to true.
     */
    simplify?: boolean;
};

export interface CanvasToHpglOptions {
    canvasWidth: number; // pixels
    canvasHeight: number; // pixels
    bedMM?: [number, number];
    marginMM?: number;
    /** RDP tolerance in mm. Larger = fewer, longer segments. */
    toleranceMM?: number;
    /** Moving-average passes applied before simplification. 0 disables smoothing. */
    smoothPasses?: number;
    unitsPerMM?: number;
    defaultPen?: number;
    /** Coordinate pairs per PA command. 1 (default) is what this plotter accepts. */
    maxPointsPerCommand?: number;
}

export interface ConversionStats {
    strokeCount: number;
    inputPoints: number;
    outputPoints: number;
    penChanges: number;
    /** Pen-down travel in mm. */
    drawLengthMM: number;
    scale: number; // mm per canvas pixel
}

export interface ConversionResult {
    hpgl: string;
    stats: ConversionStats;
}

/**
 * Fits the canvas rectangle into the bed (minus margin) without distorting it, and returns a
 * mapper from canvas pixels to plotter millimetres. Letterboxes on whichever axis has slack
 * so the drawing lands centred on the page.
 */
export function createCanvasToBedMapper(
    canvasWidth: number,
    canvasHeight: number,
    bedMM: [number, number] = BED_MM,
    marginMM: number = 10
) {
    const usableWidth = Math.max(1, bedMM[0] - marginMM * 2);
    const usableHeight = Math.max(1, bedMM[1] - marginMM * 2);
    const scale = Math.min(usableWidth / canvasWidth, usableHeight / canvasHeight);

    const drawnWidth = canvasWidth * scale;
    const drawnHeight = canvasHeight * scale;
    const offsetX = (bedMM[0] - drawnWidth) / 2;
    const offsetY = (bedMM[1] - drawnHeight) / 2;

    return {
        scale,
        // Y is subtracted from canvasHeight to flip the axis: canvas row 0 is the top of the
        // picture, which is the *high* Y edge of the plotter bed.
        map: (p: Point): Point => ({
            x: offsetX + p.x * scale,
            y: offsetY + (canvasHeight - p.y) * scale,
        }),
    };
}

export function canvasToHpgl(strokes: CanvasStroke[], options: CanvasToHpglOptions): ConversionResult {
    const {
        canvasWidth,
        canvasHeight,
        bedMM = BED_MM,
        marginMM = 10,
        toleranceMM = 0.3,
        smoothPasses = 1,
        unitsPerMM = UNITS_PER_MM,
        defaultPen: requestedPen = DEFAULT_PEN,
        maxPointsPerCommand,
    } = options;

    const defaultPen = resolvePen(requestedPen);

    const { scale, map } = createCanvasToBedMapper(canvasWidth, canvasHeight, bedMM, marginMM);

    // Snap every stroke onto a working carousel slot before anything else looks at the pen
    // numbers, so grouping, pen-change counting and the emitted SP all agree.
    const usable = strokes.map((stroke) => ({ ...stroke, pen: resolvePen(stroke.pen) }));

    // Plot every stroke for one pen before swapping, so a multi-colour drawing costs one
    // carousel change per pen instead of one per stroke. Ties keep drawing order, which
    // preserves the user's intended layering within a colour.
    const ordered = usable
        .map((stroke, index) => ({ stroke, index }))
        .sort((a, b) => a.stroke.pen - b.stroke.pen || a.index - b.index)
        .map((entry) => entry.stroke);

    const plotter = new HGPL({ unitsPerMM, defaultPen, maxPointsPerCommand });

    const stats: ConversionStats = {
        strokeCount: 0,
        inputPoints: 0,
        outputPoints: 0,
        penChanges: 0,
        drawLengthMM: 0,
        scale,
    };

    let activePen = defaultPen;

    for (const stroke of ordered) {
        if (!stroke.points || stroke.points.length === 0) continue;
        stats.inputPoints += stroke.points.length;

        // Simplify in millimetres, not pixels, so the tolerance means the same physical
        // thing regardless of how large the browser canvas happened to be.
        let path = stroke.points.map(map);
        if (stroke.smooth !== false) {
            path = dedupePath(path, Math.min(toleranceMM, 0.2));
            if (smoothPasses > 0) path = smoothPath(path, smoothPasses);
        }
        if (stroke.simplify !== false) {
            path = simplifyPath(path, toleranceMM);
        }
        const simplified = path;

        if (simplified.length === 0) continue;

        if (stroke.pen !== activePen) {
            // selectPen lifts the pen itself - the carousel can't swap with one on the paper.
            plotter.selectPen(stroke.pen);
            activePen = stroke.pen;
            stats.penChanges++;
        }

        plotter.polyLine(simplified);

        stats.strokeCount++;
        stats.outputPoints += simplified.length;
        stats.drawLengthMM += pathLength(simplified);
    }

    // Lift the pen and send the carriage home so the sheet can be pulled off cleanly.
    plotter.end();

    return { hpgl: plotter.serialize(), stats };
}
