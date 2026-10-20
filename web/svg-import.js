// SVG -> plotter paths.
//
// Rather than parsing path data by hand, this hands the file to the browser's own SVG engine
// and walks the result with `getTotalLength`/`getPointAtLength`. That gets arcs, every flavour
// of Bezier, and nested/rotated transforms correct for free - all the places a hand-rolled
// path parser goes wrong. The cost is that the document has to be laid out to be measured, so
// everything happens inside a detached, off-screen host element.
//
// A pen has no fill, so every element contributes its *outline*: a filled shape with no stroke
// still plots as its border.

// Sample density, expressed across the whole drawing's diagonal so a design authored in a
// 24-unit viewBox and one authored in 2400 units come out equally smooth. RDP thins the
// redundant points afterwards, in millimetres, once the real output scale is known.
const SAMPLES_ACROSS_DIAGONAL = 400;

// A single <path> can hold many subpaths, and getPointAtLength walks straight across the gap
// between them. Consecutive samples are at most one step apart along the curve (a chord is
// never longer than its arc), so anything noticeably longer than a step is a pen-up jump
// rather than real geometry.
const SUBPATH_JUMP_FACTOR = 2;

const MAX_POINTS = 200_000;
const GEOMETRY_SELECTOR = "path, line, polyline, polygon, circle, ellipse, rect";

/**
 * @returns { runs, warnings, sourceSize } - runs are polylines in the target coordinate space,
 *          fitted to `width` x `height` with `inset` kept clear on every side.
 * @throws  if the file isn't parseable SVG or holds nothing drawable.
 */
export function svgToRuns(svgText, { width, height, inset = 0 }) {
    const warnings = [];
    const parsed = new DOMParser().parseFromString(svgText, "image/svg+xml");

    if (parsed.querySelector("parsererror")) throw new Error("That file isn't valid SVG.");
    const root = parsed.documentElement;
    if (!root || root.localName !== "svg") throw new Error("That file has no <svg> root element.");

    if (parsed.querySelector("text, tspan")) {
        warnings.push("text elements skipped - a plotter needs outlines, not fonts");
    }
    if (parsed.querySelector("use")) {
        warnings.push("<use> references skipped");
    }
    if (parsed.querySelector("image")) {
        warnings.push("bitmap <image> skipped");
    }

    // getScreenCTM/getBBox only report real numbers for a laid-out element, so the SVG has to
    // be in the document. Park it off-screen at a fixed size; every measurement below is taken
    // relative to the root, so the host's size cancels out.
    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "position:absolute;left:-99999px;top:0;width:1000px;height:1000px;overflow:hidden;";
    const imported = document.importNode(root, true);
    imported.setAttribute("width", "1000");
    imported.setAttribute("height", "1000");
    host.append(imported);
    document.body.append(host);

    let runs;
    try {
        runs = sampleGeometry(imported, warnings);
    } finally {
        host.remove();
    }

    if (runs.length === 0) throw new Error("No drawable paths found in that SVG.");

    return { ...fitRuns(runs, width, height, inset), warnings };
}

function sampleGeometry(root, warnings) {
    // Root bbox only sets the sampling step, so an approximate figure is fine here - the fit
    // later uses the real extent of the points we actually sampled.
    let diagonal;
    try {
        const box = root.getBBox();
        diagonal = Math.hypot(box.width, box.height);
    } catch {
        diagonal = 0;
    }
    if (!(diagonal > 0)) throw new Error("That SVG has no measurable content.");

    const step = diagonal / SAMPLES_ACROSS_DIAGONAL;
    const rootInverse = root.getScreenCTM()?.inverse();
    if (!rootInverse) throw new Error("Could not measure that SVG.");

    const runs = [];
    let total = 0;
    let truncated = false;

    for (const el of root.querySelectorAll(GEOMETRY_SELECTOR)) {
        if (truncated) break;
        if (!isVisible(el)) continue;

        let length;
        try {
            length = el.getTotalLength();
        } catch {
            continue; // malformed `d`, degenerate shape - nothing to draw
        }
        if (!(length > 0)) continue;

        // Element user space -> root user space, transforms and all.
        const screenCTM = el.getScreenCTM();
        if (!screenCTM) continue;
        const matrix = rootInverse.multiply(screenCTM);

        const steps = Math.max(1, Math.ceil(length / step));
        let current = [];

        for (let i = 0; i <= steps; i++) {
            const raw = el.getPointAtLength((i / steps) * length);
            const point = { x: matrix.a * raw.x + matrix.c * raw.y + matrix.e,
                            y: matrix.b * raw.x + matrix.d * raw.y + matrix.f };

            const previous = current[current.length - 1];
            if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) > step * SUBPATH_JUMP_FACTOR) {
                // Crossed into the next subpath - break the run so the pen lifts here.
                if (current.length > 1) runs.push(current);
                current = [];
            }
            current.push(point);

            if (++total > MAX_POINTS) {
                truncated = true;
                break;
            }
        }
        if (current.length > 1) runs.push(current);
    }

    if (truncated) warnings.push(`too detailed - stopped at ${MAX_POINTS.toLocaleString()} points`);
    return runs;
}

function isVisible(el) {
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
}

/** Scales the sampled geometry into the target box without distorting it, and centres it. */
function fitRuns(runs, width, height, inset) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const run of runs) {
        for (const p of run) {
            if (p.x < minX) minX = p.x;
            if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.y > maxY) maxY = p.y;
        }
    }

    const sourceWidth = maxX - minX;
    const sourceHeight = maxY - minY;
    const usableWidth = Math.max(1, width - inset * 2);
    const usableHeight = Math.max(1, height - inset * 2);

    // A single straight line has zero extent on one axis; fall back to the other so it still
    // scales instead of collapsing to a point.
    const scale = Math.min(
        sourceWidth > 0 ? usableWidth / sourceWidth : Infinity,
        sourceHeight > 0 ? usableHeight / sourceHeight : Infinity
    );
    const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;

    const offsetX = (width - sourceWidth * safeScale) / 2;
    const offsetY = (height - sourceHeight * safeScale) / 2;

    return {
        runs: runs.map((run) =>
            run.map((p) => ({
                x: offsetX + (p.x - minX) * safeScale,
                y: offsetY + (p.y - minY) * safeScale,
            }))
        ),
        sourceSize: { width: sourceWidth, height: sourceHeight },
    };
}
