// Plotter "paint bucket".
//
// A pen can't flood a region the way MS Paint fills pixels, so the closest honest analog is
// hatching: find the enclosed area the way a raster bucket would, then rule closely spaced
// parallel lines across it. The interaction is identical - click inside a bounded area - but
// the output is strokes the machine can actually draw.
//
// The region search is deliberately raster-based rather than geometric. Freehand strokes
// almost never form clean closed polygons (they overshoot, self-intersect, and leave hairline
// gaps), so point-in-polygon testing is fragile on exactly the input this tool receives.
// Rasterising and flood filling behaves the way the user expects from Paint, including
// leaking through a gap - which we detect and warn about instead of hiding.

// One raster pixel per logical unit (0.25mm). Fine enough to resolve any gap the pen could
// physically draw through, cheap enough to flood fill in a few milliseconds.
const RASTER_SCALE = 1;

// Any pixel with meaningful ink counts as a barrier. Being generous here widens barriers by
// roughly the antialiased fringe, which both prevents leaks through diagonal lines and keeps
// the hatch from butting up against the outline it sits inside.
const INK_THRESHOLD = 240;

/**
 * @param barrierRuns  Point[][] - the drawn polylines that bound the fill. Existing fills are
 *                     deliberately excluded by the caller: hatch lines have gaps between them,
 *                     and treating those as walls would fill the gaps rather than the region.
 * @param seed         Point in logical units - where the user clicked.
 * @param angles       One angle in radians, or two for cross-hatch.
 * @returns null if the click landed on a barrier, otherwise the hatch runs plus the diagnostics
 *          the UI needs to warn about a runaway fill.
 */
export function computeFill({
  barrierRuns,
  seed,
  width,
  height,
  barrierWidth,
  spacing,
  angles,
  minRun,
}) {
  const w = Math.round(width * RASTER_SCALE);
  const h = Math.round(height * RASTER_SCALE);

  const sx = Math.round(seed.x * RASTER_SCALE);
  const sy = Math.round(seed.y * RASTER_SCALE);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return null;

  const barrier = rasterizeBarriers(barrierRuns, w, h, barrierWidth * RASTER_SCALE);
  const filled = floodFill(barrier, w, h, sx, sy);
  if (!filled) return null;

  const runs = [];
  angles.forEach((angle, pass) => {
    runs.push(...hatch(filled, w, h, angle, spacing * RASTER_SCALE, minRun * RASTER_SCALE, pass));
  });

  return {
    runs: runs.map((run) => run.map((p) => ({ x: p.x / RASTER_SCALE, y: p.y / RASTER_SCALE }))),
    areaFraction: filled.count / (w * h),
    touchedEdge: filled.touchedEdge,
  };
}

/** Paints the barrier polylines into a bitmap and reduces it to a one-byte-per-pixel mask. */
function rasterizeBarriers(barrierRuns, w, h, lineWidth) {
  const surface =
    typeof OffscreenCanvas === "function"
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement("canvas"), { width: w, height: h });

  const ctx = surface.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = "#000000";
  ctx.fillStyle = "#000000";
  // A barrier must be at least 2px of solid core: 4-connected flood fill cannot cross a
  // continuous 2px line, including a diagonal one.
  ctx.lineWidth = Math.max(2, lineWidth);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const run of barrierRuns) {
    if (run.length === 0) continue;
    if (run.length === 1) {
      ctx.beginPath();
      ctx.arc(run[0].x * RASTER_SCALE, run[0].y * RASTER_SCALE, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(run[0].x * RASTER_SCALE, run[0].y * RASTER_SCALE);
    for (let i = 1; i < run.length; i++) {
      ctx.lineTo(run[i].x * RASTER_SCALE, run[i].y * RASTER_SCALE);
    }
    ctx.stroke();
  }

  const { data } = ctx.getImageData(0, 0, w, h);
  const mask = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    if (data[p] < INK_THRESHOLD) mask[i] = 1;
  }
  return mask;
}

/**
 * Scanline flood fill, 4-connected. 4-connectivity is the safe choice: an 8-connected fill
 * would squeeze through the diagonal touch between two corner-adjacent pixels, which is
 * exactly the kind of hairline gap freehand strokes leave behind.
 */
function floodFill(barrier, w, h, sx, sy) {
  if (barrier[sy * w + sx]) return null;

  const region = new Uint8Array(w * h);
  const stack = [sx, sy];
  let count = 0;
  let touchedEdge = false;
  let minX = sx;
  let maxX = sx;
  let minY = sy;
  let maxY = sy;

  const open = (x, y) => !barrier[y * w + x] && !region[y * w + x];

  while (stack.length > 0) {
    const y = stack.pop();
    let x = stack.pop();

    while (x >= 0 && open(x, y)) x--;
    x++;

    let spanUp = false;
    let spanDown = false;

    while (x < w && open(x, y)) {
      region[y * w + x] = 1;
      count++;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchedEdge = true;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      // Push each vertical span once, at its first open column, instead of once per pixel.
      if (y > 0) {
        const up = open(x, y - 1);
        if (up && !spanUp) {
          stack.push(x, y - 1);
          spanUp = true;
        } else if (!up) {
          spanUp = false;
        }
      }
      if (y < h - 1) {
        const down = open(x, y + 1);
        if (down && !spanDown) {
          stack.push(x, y + 1);
          spanDown = true;
        } else if (!down) {
          spanDown = false;
        }
      }
      x++;
    }
  }

  return { region, count, touchedEdge, bbox: [minX, minY, maxX, maxY] };
}

/**
 * Rules parallel lines across the region at `angle` and keeps the spans that fall inside it.
 * Alternate lines are emitted in reverse (boustrophedon), so the pen snakes back and forth
 * instead of flying back to the same edge before every line.
 */
function hatch(filled, w, h, angle, spacing, minRun, pass) {
  const { region, bbox } = filled;
  const [minX, minY, maxX, maxY] = bbox;

  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const nx = -dy;
  const ny = dx;

  // Project the region's bounding box onto the hatch direction and its normal to get the
  // range of lines to rule, and how far along each line to walk.
  let nMin = Infinity;
  let nMax = -Infinity;
  let dMin = Infinity;
  let dMax = -Infinity;
  for (const [x, y] of [[minX, minY], [maxX, minY], [minX, maxY], [maxX, maxY]]) {
    const n = x * nx + y * ny;
    const d = x * dx + y * dy;
    nMin = Math.min(nMin, n);
    nMax = Math.max(nMax, n);
    dMin = Math.min(dMin, d);
    dMax = Math.max(dMax, d);
  }

  // Offset the second cross-hatch pass by half a step so its lines land between the first
  // pass's crossings rather than piling onto them.
  const start = nMin + spacing * (pass % 2 === 1 ? 1 : 0.5);
  const runs = [];
  let lineIndex = 0;

  for (let offset = start; offset <= nMax; offset += spacing, lineIndex++) {
    const lineRuns = [];
    let runStart = null;

    for (let t = dMin; t <= dMax; t += 1) {
      const x = Math.round(nx * offset + dx * t);
      const y = Math.round(ny * offset + dy * t);
      const inside = x >= 0 && y >= 0 && x < w && y < h && region[y * w + x] === 1;

      if (inside && runStart === null) runStart = t;
      else if (!inside && runStart !== null) {
        addRun(lineRuns, offset, runStart, t - 1);
        runStart = null;
      }
    }
    if (runStart !== null) addRun(lineRuns, offset, runStart, dMax);

    if (lineIndex % 2 === 1) {
      lineRuns.reverse();
      for (const run of lineRuns) run.reverse();
    }
    runs.push(...lineRuns);
  }

  function addRun(into, offset, tStart, tEnd) {
    if (tEnd - tStart < minRun) return; // skip slivers at the region's edges
    into.push([
      { x: nx * offset + dx * tStart, y: ny * offset + dy * tStart },
      { x: nx * offset + dx * tEnd, y: ny * offset + dy * tEnd },
    ]);
  }

  return runs;
}
