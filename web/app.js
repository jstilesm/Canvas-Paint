// Drawing surface + HPGL generation client.
//
// Strokes are stored in a fixed "logical" coordinate space sized to the plotter bed rather
// than in screen pixels, so resizing the window (or drawing on a phone and generating on a
// laptop) never rescales or distorts what was already drawn. The server does the same
// letterbox fit from that space onto the physical bed.
//
// The drawing is a flat list of items, each of which is one or more pen-down runs:
//   { kind: "stroke", pen, points }   - a freehand line
//   { kind: "fill",   pen, runs }     - a hatched region, one run per ruled line
// `itemRuns` flattens either shape, so rendering, erasing and HPGL export all treat the two
// uniformly and there is no second code path to keep in sync.

import { computeFill } from "./fill.js";
import { svgToRuns } from "./svg-import.js";

const LOGICAL_UNITS_PER_MM = 4; // 1 logical unit = 0.25mm
const PEN_WIDTH_MM = 0.45; // typical fibre-tip plotter pen, for on-screen fidelity
const ERASE_RADIUS_MM = 4;
const MIN_POINT_DISTANCE = 1.2; // logical units; drops pointer spam at rest
const MIN_HATCH_RUN_MM = 0.5; // shorter spans are slivers at a region's edge, not shading

// Max distance a flattened curve may bow away from the true arc. Well under the 0.45mm pen,
// so the facets are invisible on paper; the segment count follows from this rather than being
// a fixed number, which keeps a small circle cheap and a bed-sized one still smooth.
const CURVE_FLATNESS_MM = 0.05;

// Keep imported artwork off the very edge of the drawing area, so it stays visibly inside the
// bed once the export margin is applied on top.
const SVG_IMPORT_INSET_MM = 4;
const MAX_SVG_BYTES = 5 * 1024 * 1024;

// A fill this large almost always means the region wasn't closed and the hatch escaped into
// the background. We still honour the click, but say so - it's a lot of plotter time to waste.
const RUNAWAY_FILL_FRACTION = 0.5;

const canvas = document.getElementById("canvas");
const frame = document.querySelector(".canvas-frame");
const previewFrame = document.getElementById("preview");
const codeEl = document.getElementById("code");
const statsEl = document.getElementById("stats");
const statusEl = document.getElementById("status");
const penPicker = document.getElementById("pen-picker");
const ctx = canvas.getContext("2d");

// Pen width in logical units for the current canvas size, set by render().
let strokeWidth = 1;

const state = {
  items: [],
  undoStack: [],
  redoStack: [],
  active: null,
  eraseSnapshot: null,
  lastErasePoint: null,
  shapeStart: null,
  shapeEnd: null,
  shiftHeld: false,
  tool: "pen",
  // Carousel slots 0-3 are broken on the machine; the real list arrives from /api/config,
  // these are just placeholders for the moment before that resolves.
  pen: 4,
  availablePens: [4],
  hpgl: "",
  stickyStatus: null,
  plotter: { configured: false, url: "" },
  penColors: { 4: "#1b1b1b" },
  penNames: {},
  lightPens: [],
  haloColor: "#bdbdb8",
  logical: { width: 1030, height: 765 },
  mmPerLogical: 1 / LOGICAL_UNITS_PER_MM,
};

/* ------------------------------------------------------------------ setup */

async function init() {
  let config;
  try {
    const res = await fetch("/api/config");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    config = await res.json();
  } catch (err) {
    setStatus(`Could not load plotter config: ${err.message}`, true);
    return;
  }

  const [bedWidthMM, bedHeightMM] = config.bedMM;
  state.penColors = config.penColors;
  state.penNames = config.penNames ?? {};
  state.lightPens = config.lightPens ?? [];
  state.haloColor = config.haloColor ?? state.haloColor;
  state.availablePens = config.availablePens;
  state.pen = config.defaultPen;
  state.plotter = config.plotter ?? state.plotter;
  state.logical = {
    width: Math.round(bedWidthMM * LOGICAL_UNITS_PER_MM),
    height: Math.round(bedHeightMM * LOGICAL_UNITS_PER_MM),
  };

  document.getElementById("bed-label").textContent =
    `Bed ${bedWidthMM} x ${bedHeightMM} mm - ${config.unitsPerMM} plotter units/mm`;

  // Lock both the drawing surface and the preview to the bed's proportions.
  const ratio = `${bedWidthMM} / ${bedHeightMM}`;
  frame.style.aspectRatio = ratio;
  previewFrame.style.aspectRatio = ratio;

  buildPenPicker();
  wireControls();
  wirePlotter();
  wireSvgImport();
  new ResizeObserver(resizeCanvas).observe(frame);
  resizeCanvas();
  renderStats(null);
}

function buildPenPicker() {
  // Only the slots the server reports as working - broken carousel positions are never
  // offered, so there is no way to author a drawing the plotter can't pick up a pen for.
  for (const slot of state.availablePens) {
    const button = document.createElement("button");
    button.className = "pen";
    button.dataset.pen = String(slot);
    button.style.background = state.penColors[slot];
    const label = state.penNames[slot] ? `Pen ${slot} - ${state.penNames[slot]}` : `Pen ${slot}`;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", String(slot === state.pen));
    button.addEventListener("click", () => selectPen(slot));
    penPicker.append(button);
  }
}

function selectPen(slot) {
  state.pen = slot;
  for (const button of penPicker.children) {
    button.setAttribute("aria-pressed", String(Number(button.dataset.pen) === slot));
  }
}

function selectTool(tool) {
  state.tool = tool;
  for (const button of document.querySelectorAll(".tool")) {
    button.setAttribute("aria-pressed", String(button.dataset.tool === tool));
  }
  canvas.classList.toggle("erasing", tool === "erase");
  canvas.classList.toggle("filling", tool === "fill");
}

/* ------------------------------------------------------------- rendering */

function resizeCanvas() {
  const rect = frame.getBoundingClientRect();
  if (rect.width === 0) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  render();
}

function render() {
  const { width: logicalWidth, height: logicalHeight } = state.logical;
  const scale = canvas.width / logicalWidth;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#f7f7f5";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Draw in logical units from here on; the transform handles DPR and element size at once.
  ctx.setTransform(scale, 0, 0, canvas.height / logicalHeight, 0, 0);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Keep hairline pens visible on screen even though the real pen is a fraction of a mm.
  const trueWidth = PEN_WIDTH_MM * LOGICAL_UNITS_PER_MM;
  strokeWidth = Math.max(trueWidth, 1.4 / scale);
  ctx.lineWidth = strokeWidth;

  for (const item of state.items) drawItem(item);
  if (state.active) drawItem(state.active);
}

/** One or more pen-down runs, whatever kind of item produced them. */
function itemRuns(item) {
  return item.kind === "fill" ? item.runs : [item.points];
}

/** True for anything built from geometry rather than sampled from a pointer. */
function isExact(item) {
  return item.exact === true || item.kind === "fill";
}

function drawItem(item) {
  const color = state.penColors[item.pen] ?? "#111111";
  // White ink would be invisible on the paper-coloured canvas, so light pens get a wider grey
  // line underneath - same treatment the SVG preview applies, so the two panes match.
  const halo = state.lightPens.includes(item.pen) ? state.haloColor : null;
  const exact = isExact(item);
  for (const run of itemRuns(item)) drawRun(run, exact, color, halo);
}

function drawRun(points, exact, color, halo) {
  if (points.length === 0) return;
  ctx.beginPath();

  if (points.length === 1) {
    // A tap is a dot: the plotter renders this as pen-down/pen-up in place.
    if (halo) {
      ctx.beginPath();
      ctx.arc(points[0].x, points[0].y, strokeWidth * 1.1, 0, Math.PI * 2);
      ctx.fillStyle = halo;
      ctx.fill();
      ctx.beginPath();
    }
    ctx.arc(points[0].x, points[0].y, strokeWidth / 2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    return;
  }

  ctx.moveTo(points[0].x, points[0].y);

  if (exact) {
    // Exact geometry gets plain segments. The curve fitting below is right for a dense
    // pointer stream but would round the corners off a rectangle - and then the canvas would
    // disagree with both the plot preview and the pen.
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    strokePath(color, halo);
    return;
  }

  // Quadratic segments through the midpoints of consecutive samples - cheap way to render a
  // dense point stream as a continuous curve instead of a visibly faceted polyline.
  for (let i = 1; i < points.length - 1; i++) {
    const midX = (points[i].x + points[i + 1].x) / 2;
    const midY = (points[i].y + points[i + 1].y) / 2;
    ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
  }
  const last = points[points.length - 1];
  ctx.lineTo(last.x, last.y);
  strokePath(color, halo);
}

/** Strokes the current path, laying a halo underneath first for inks that need one. */
function strokePath(color, halo) {
  if (halo) {
    ctx.strokeStyle = halo;
    ctx.lineWidth = strokeWidth * 2.2;
    ctx.stroke();
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = strokeWidth;
  ctx.stroke();
}

/* -------------------------------------------------------------- pointers */

function toLogical(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * state.logical.width,
    y: ((event.clientY - rect.top) / rect.height) * state.logical.height,
  };
}

canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 && event.pointerType === "mouse") return;
  canvas.setPointerCapture(event.pointerId);
  const point = toLogical(event);

  if (state.tool === "fill") {
    // A bucket click completes on press - there is no drag state to carry.
    fillAt(point);
    return;
  }

  if (SHAPE_TOOLS.has(state.tool)) {
    state.shapeStart = point;
    state.shapeEnd = point;
    state.shiftHeld = event.shiftKey;
    updateShape();
    render();
    return;
  }

  if (state.tool === "erase") {
    // Snapshot once per drag, so a sweep that clears five strokes is a single undo.
    state.eraseSnapshot = state.items;
    state.lastErasePoint = point;
    eraseSweep(point, point);
  } else {
    state.active = { kind: "stroke", pen: state.pen, points: [point] };
  }
  render();
});

canvas.addEventListener("pointermove", (event) => {
  if (!state.active && !state.eraseSnapshot) return;

  // A shape is defined by its two endpoints, so only the latest position matters - there is
  // no path to reconstruct from the coalesced samples.
  if (state.shapeStart) {
    state.shapeEnd = toLogical(event);
    state.shiftHeld = event.shiftKey;
    updateShape();
    render();
    return;
  }

  // Coalesced events recover the samples the browser batched between frames, which is what
  // makes a fast stroke come out as a curve rather than a few long chords.
  const events = event.getCoalescedEvents ? event.getCoalescedEvents() : [event];

  for (const raw of events) {
    const point = toLogical(raw);
    if (state.tool === "erase") {
      eraseSweep(state.lastErasePoint ?? point, point);
      state.lastErasePoint = point;
    } else {
      const previous = state.active.points[state.active.points.length - 1];
      if (Math.hypot(point.x - previous.x, point.y - previous.y) >= MIN_POINT_DISTANCE) {
        state.active.points.push(point);
      }
    }
  }
  render();
});

function endStroke(event) {
  if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);

  if (state.tool === "erase") {
    if (state.eraseSnapshot && state.eraseSnapshot !== state.items) {
      state.undoStack.push(state.eraseSnapshot);
      state.redoStack = [];
      onDrawingChanged();
    }
    state.eraseSnapshot = null;
    state.lastErasePoint = null;
    return;
  }

  if (state.shapeStart) {
    const shape = state.active;
    state.shapeStart = null;
    state.shapeEnd = null;
    state.active = null;
    if (shape && shapeIsWorthKeeping(shape.points)) commit([...state.items, shape]);
    else render();
    return;
  }

  if (!state.active) return;
  commit([...state.items, state.active]);
  state.active = null;
}

canvas.addEventListener("pointerup", endStroke);
canvas.addEventListener("pointercancel", endStroke);

// Tests the whole segment the cursor travelled since the last sample, not just where it
// landed. Pointer samples can be tens of pixels apart on a fast drag, and hit-testing only
// the sample points lets a stroke slip between two of them untouched.
function eraseSweep(from, to) {
  const radius = ERASE_RADIUS_MM * LOGICAL_UNITS_PER_MM;
  const remaining = state.items.filter((item) => !itemHits(item, from, to, radius));
  if (remaining.length !== state.items.length) state.items = remaining;
}

// A fill is erased as one unit - the whole hatched region goes, not the individual lines the
// cursor happened to cross.
function itemHits(item, from, to, radius) {
  return itemRuns(item).some((points) => runHits(points, from, to, radius));
}

function runHits(points, from, to, radius) {
  if (points.length === 1) return distanceToSegment(points[0], from, to) <= radius;
  for (let i = 1; i < points.length; i++) {
    if (segmentDistance(from, to, points[i - 1], points[i]) <= radius) return true;
  }
  return false;
}

/** Shortest distance between two line segments. 0 when they cross. */
function segmentDistance(a, b, c, d) {
  if (segmentsIntersect(a, b, c, d)) return 0;
  // Non-crossing segments always achieve their minimum at one of the four endpoints.
  return Math.min(
    distanceToSegment(a, c, d),
    distanceToSegment(b, c, d),
    distanceToSegment(c, a, b),
    distanceToSegment(d, a, b)
  );
}

function segmentsIntersect(a, b, c, d) {
  const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  // Strict straddle on both sides. Collinear/touching cases fall through to the endpoint
  // distances above, which return ~0 for them anyway.
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

function distanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  // Clamped projection: we want distance to the drawn segment, not to its infinite line.
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/* ------------------------------------------------------------ svg import */

async function importSvgFile(file) {
  if (!file) return;
  if (file.size > MAX_SVG_BYTES) {
    setStatus(`${file.name} is too large (limit ${MAX_SVG_BYTES / 1024 / 1024}MB).`, true);
    return;
  }

  setStatus(`Importing ${file.name}...`);

  let result;
  try {
    result = svgToRuns(await file.text(), {
      width: state.logical.width,
      height: state.logical.height,
      inset: SVG_IMPORT_INSET_MM * LOGICAL_UNITS_PER_MM,
    });
  } catch (err) {
    setStatus(`Could not import ${file.name}: ${err.message}`, true, true);
    return;
  }

  // One item per path rather than one for the whole file: whiteout can then take out a single
  // shape, while undo still lifts the entire import in one step because this is one commit.
  const items = result.runs.map((points) => ({
    kind: "stroke",
    pen: state.pen,
    exact: true,      // artwork, not pointer samples - never smooth it
    simplify: true,   // but it *is* densely sampled, so RDP still earns its keep
    points,
  }));

  commit([...state.items, ...items]);

  const points = result.runs.reduce((sum, run) => sum + run.length, 0);
  const note = result.warnings.length > 0 ? ` (${result.warnings.join("; ")})` : "";
  setStatus(
    `Imported ${items.length} paths, ${points.toLocaleString()} points from ${file.name}${note}.`,
    false,
    result.warnings.length > 0
  );
}

function wireSvgImport() {
  const input = document.getElementById("svg-file");
  document.getElementById("import-svg").addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    importSvgFile(input.files[0]);
    input.value = ""; // let the same file be picked again after an undo
  });

  // Drag and drop straight onto the drawing area.
  for (const type of ["dragenter", "dragover"]) {
    frame.addEventListener(type, (event) => {
      event.preventDefault();
      frame.classList.add("dropping");
    });
  }
  for (const type of ["dragleave", "drop"]) {
    frame.addEventListener(type, (event) => {
      event.preventDefault();
      frame.classList.remove("dropping");
    });
  }
  frame.addEventListener("drop", (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) importSvgFile(file);
  });
}

/* ---------------------------------------------------------------- shapes */

const SHAPE_TOOLS = new Set(["line", "rect", "triangle", "ellipse"]);

/**
 * Builds a shape from the drag that defined it: `a` is where the pointer went down, `b` where
 * it is now. `constrain` is the Shift key, following the convention every drawing app uses -
 * 45-degree lines, exact squares, equilateral triangles.
 *
 * Returns a closed point list for the area shapes (last point repeats the first), so the pen
 * finishes where it started and the outline has no gap.
 */
function shapePoints(tool, a, b, constrain) {
  if (tool === "line") {
    if (!constrain) return [a, b];
    // Snap to the nearest 45 degrees, keeping the length the user dragged out.
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const step = Math.PI / 4;
    const angle = Math.round(Math.atan2(b.y - a.y, b.x - a.x) / step) * step;
    return [a, { x: a.x + Math.cos(angle) * length, y: a.y + Math.sin(angle) * length }];
  }

  let dx = b.x - a.x;
  let dy = b.y - a.y;
  if (constrain && (tool === "rect" || tool === "ellipse")) {
    // Square / circle: take the longer drag axis, but keep the direction the user dragged.
    const size = Math.max(Math.abs(dx), Math.abs(dy));
    dx = (dx < 0 ? -1 : 1) * size;
    dy = (dy < 0 ? -1 : 1) * size;
  }

  const x1 = Math.min(a.x, a.x + dx);
  const x2 = Math.max(a.x, a.x + dx);
  const y1 = Math.min(a.y, a.y + dy);
  const y2 = Math.max(a.y, a.y + dy);

  if (tool === "rect") {
    return [
      { x: x1, y: y1 },
      { x: x2, y: y1 },
      { x: x2, y: y2 },
      { x: x1, y: y2 },
      { x: x1, y: y1 },
    ];
  }

  if (tool === "ellipse") {
    return ellipsePoints((x1 + x2) / 2, (y1 + y2) / 2, (x2 - x1) / 2, (y2 - y1) / 2);
  }

  // Triangle: apex centred on the top edge, base along the bottom. Canvas Y grows downward,
  // so y1 is the visual top. Shift makes it equilateral by deriving the height from the base.
  const apexY = constrain ? y2 - ((x2 - x1) * Math.sqrt(3)) / 2 : y1;
  return [
    { x: x1, y: y2 },
    { x: (x1 + x2) / 2, y: apexY },
    { x: x2, y: y2 },
    { x: x1, y: y2 },
  ];
}

/**
 * Flattens an ellipse into the polyline the pen will actually draw. HP-GL does have a native
 * circle command, but flattening here keeps one representation for every shape - so erase
 * hit-testing, the SVG preview and the plot all read the same point list.
 */
function ellipsePoints(cx, cy, rx, ry) {
  const points = [];
  for (let i = 0, steps = ellipseSteps(rx, ry); i < steps; i++) {
    const t = (i / steps) * 2 * Math.PI;
    points.push({ x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry });
  }
  points.push(points[0]); // close it, so the pen finishes where it started
  return points;
}

/**
 * Segment count from the flatness tolerance: a chord subtending angle t on radius r bows away
 * from the arc by r(1 - cos(t/2)), so solving that for t gives the coarsest step that still
 * looks round. Uses the major radius, which is the worst case for an ellipse.
 */
function ellipseSteps(rx, ry) {
  const r = Math.max(Math.abs(rx), Math.abs(ry));
  const tolerance = CURVE_FLATNESS_MM * LOGICAL_UNITS_PER_MM;
  if (r <= tolerance) return 12;
  const step = 2 * Math.acos(1 - tolerance / r);
  return Math.max(24, Math.min(720, Math.ceil((2 * Math.PI) / step)));
}

function updateShape() {
  if (!state.shapeStart || !state.shapeEnd) return;
  state.active = {
    kind: "stroke",
    pen: state.pen,
    // Straight from the geometry, not sampled from a pointer - don't let the smoothing pass
    // round the corners off.
    exact: true,
    points: shapePoints(state.tool, state.shapeStart, state.shapeEnd, state.shiftHeld),
  };
}

/** Ignores the pixel-sized shape a stray click produces. */
function shapeIsWorthKeeping(points) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) >= 2;
}

// Shift is read live rather than only at pointer-move time, so toggling it mid-drag snaps the
// shape immediately instead of waiting for the next mouse movement.
for (const [type, held] of [["keydown", true], ["keyup", false]]) {
  window.addEventListener(type, (event) => {
    if (event.key !== "Shift" || !state.shapeStart) return;
    state.shiftHeld = held;
    updateShape();
    render();
  });
}

/* ------------------------------------------------------------------ fill */

function fillAt(seed) {
  const spacingMM = Number(document.getElementById("hatch-spacing").value);
  const angleDeg = Number(document.getElementById("hatch-angle").value);
  const cross = document.getElementById("hatch-cross").checked;

  const angleRad = (angleDeg * Math.PI) / 180;
  const angles = cross ? [angleRad, angleRad + Math.PI / 2] : [angleRad];

  setStatus("Filling...");

  let result;
  try {
    result = computeFill({
      // Only real strokes bound the fill. Existing hatch lines have gaps between them by
      // construction, so counting them as walls would fill those gaps instead of the region.
      barrierRuns: state.items.filter((i) => i.kind !== "fill").map((i) => i.points),
      seed,
      width: state.logical.width,
      height: state.logical.height,
      barrierWidth: PEN_WIDTH_MM * LOGICAL_UNITS_PER_MM,
      spacing: spacingMM * LOGICAL_UNITS_PER_MM,
      angles,
      minRun: MIN_HATCH_RUN_MM * LOGICAL_UNITS_PER_MM,
    });
  } catch (err) {
    setStatus(`Fill failed: ${err.message}`, true);
    return;
  }

  if (!result) {
    setStatus("Nothing to fill there - that spot is on a line.", true);
    return;
  }
  if (result.runs.length === 0) {
    setStatus("That region is too small to hatch at this spacing.", true);
    return;
  }

  commit([...state.items, { kind: "fill", pen: state.pen, runs: result.runs }]);

  // A fill that reached the page edge escaped through a gap in the outline. It's a valid
  // thing to want (shading the background), but far more often it means the region wasn't
  // closed - so say which happened rather than silently plotting for an hour.
  const percent = Math.round(result.areaFraction * 100);
  if (result.touchedEdge && result.areaFraction > RUNAWAY_FILL_FRACTION) {
    setStatus(
      `Fill leaked to the page edge and shaded ${percent}% of the sheet - close the outline and undo.`,
      true,
      true
    );
  } else {
    setStatus(`Filled ${percent}% of the sheet with ${result.runs.length} hatch lines.`);
  }
}

/* --------------------------------------------------------------- history */

function commit(items) {
  state.undoStack.push(state.items);
  state.items = items;
  state.redoStack = [];
  onDrawingChanged();
}

function undo() {
  if (state.undoStack.length === 0) return;
  state.redoStack.push(state.items);
  state.items = state.undoStack.pop();
  onDrawingChanged();
}

function redo() {
  if (state.redoStack.length === 0) return;
  state.undoStack.push(state.items);
  state.items = state.redoStack.pop();
  onDrawingChanged();
}

function onDrawingChanged() {
  state.stickyStatus = null;
  render();
  document.getElementById("undo").disabled = state.undoStack.length === 0;
  document.getElementById("redo").disabled = state.redoStack.length === 0;
  if (document.getElementById("live").checked) scheduleGenerate();
}

/* ------------------------------------------------------------ generation */

let generateTimer = null;
let inFlight = false;
let pendingRun = false;

function scheduleGenerate() {
  clearTimeout(generateTimer);
  generateTimer = setTimeout(generate, 350);
}

async function generate() {
  clearTimeout(generateTimer);

  if (state.items.length === 0) {
    state.hpgl = "";
    previewFrame.innerHTML = '<p class="empty">Draw something, then generate a plot.</p>';
    codeEl.textContent = "IN;";
    renderStats(null);
    updateSendButton();
    setStatus("");
    return;
  }

  // One request at a time; if edits land mid-flight, run once more when it returns rather
  // than queueing up a request per keystroke of the sliders.
  if (inFlight) {
    pendingRun = true;
    return;
  }
  inFlight = true;
  // A sticky warning (a leaked fill) outranks this transient note - don't clobber it.
  if (!state.stickyStatus) setStatus("Generating HP-GL...");

  try {
    const res = await fetch("/api/hpgl", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // Each run becomes one wire stroke; the server groups them by pen from there.
        strokes: state.items.flatMap((item) =>
          itemRuns(item).map((points) => ({
            pen: item.pen,
            points,
            // Exact geometry (drawn shapes, hatch runs) is never smoothed. Simplification is
            // separate: imported SVG is exact but densely sampled, so it still wants RDP.
            smooth: !isExact(item),
            simplify: item.simplify ?? !isExact(item),
          }))
        ),
        canvasWidth: state.logical.width,
        canvasHeight: state.logical.height,
        marginMM: Number(document.getElementById("margin").value),
        toleranceMM: Number(document.getElementById("tolerance").value),
        smoothPasses: Number(document.getElementById("smooth").value),
        // Off by default: this plotter refuses a plot whose PA carries more than one pair.
        maxPointsPerCommand: document.getElementById("batch-pa").checked ? 8 : 1,
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

    state.hpgl = data.hpgl;
    previewFrame.innerHTML = data.svg;
    codeEl.textContent = data.hpgl;
    renderStats(data.stats);
    updateSendButton();
    if (!state.stickyStatus) setStatus(`${data.hpgl.length.toLocaleString()} characters of HP-GL`);
  } catch (err) {
    setStatus(`Generation failed: ${err.message}`, true);
  } finally {
    inFlight = false;
    if (pendingRun) {
      pendingRun = false;
      scheduleGenerate();
    }
  }
}

function renderStats(stats) {
  if (!stats) {
    statsEl.innerHTML = "";
    return;
  }
  const metres = stats.drawLengthMM / 1000;
  const reduction = stats.inputPoints > 0
    ? Math.round((1 - stats.outputPoints / stats.inputPoints) * 100)
    : 0;

  const entries = [
    ["Paths", stats.strokeCount.toLocaleString()],
    ["Points", `${stats.outputPoints.toLocaleString()}`],
    ["Simplified", `${reduction}%`],
    ["Pen changes", stats.penChanges.toLocaleString()],
    ["Pen travel", metres >= 1 ? `${metres.toFixed(2)} m` : `${Math.round(stats.drawLengthMM)} mm`],
  ];

  statsEl.innerHTML = entries
    .map(([term, value]) => `<div><dt>${term}</dt><dd>${value}</dd></div>`)
    .join("");
}

// `sticky` marks a message that must outlive the next background event - specifically the
// live-preview byte count, which lands a few hundred ms after a fill and would otherwise
// silently wipe out a "your fill leaked" warning. Cleared by the next drawing action.
function setStatus(message, isError = false, sticky = false) {
  statusEl.textContent = message || " ";
  statusEl.classList.toggle("error", isError);
  state.stickyStatus = sticky ? message : null;
}

/* ---------------------------------------------------------------- wiring */

function wireControls() {
  for (const button of document.querySelectorAll(".tool")) {
    button.addEventListener("click", () => selectTool(button.dataset.tool));
  }

  document.getElementById("undo").addEventListener("click", undo);
  document.getElementById("redo").addEventListener("click", redo);
  document.getElementById("clear").addEventListener("click", () => {
    if (state.items.length > 0) commit([]);
  });

  document.getElementById("batch-pa").addEventListener("change", () => {
    if (document.getElementById("live").checked) scheduleGenerate();
  });

  document.getElementById("generate").addEventListener("click", generate);
  document.getElementById("copy").addEventListener("click", copyHpgl);
  document.getElementById("download").addEventListener("click", downloadHpgl);

  // These change how the drawing is converted, so every move re-runs the export.
  const conversionSliders = [
    ["margin", (v) => `${v} mm`],
    ["tolerance", (v) => `${Number(v).toFixed(2)} mm`],
    ["smooth", (v) => (Number(v) === 1 ? "1 pass" : `${v} passes`)],
  ];
  for (const [id, format] of conversionSliders) {
    const input = document.getElementById(id);
    const output = document.getElementById(`${id}-out`);
    const sync = () => {
      output.textContent = format(input.value);
      if (document.getElementById("live").checked) scheduleGenerate();
    };
    input.addEventListener("input", sync);
    sync();
  }

  // Hatch settings are baked into each fill at click time, the way a paint bucket commits its
  // pixels. Moving them changes the next fill, not the ones already down, so there is nothing
  // to regenerate here.
  const hatchSliders = [
    ["hatch-spacing", (v) => `${Number(v).toFixed(1)} mm`],
    ["hatch-angle", (v) => `${v}\u00b0`],
  ];
  for (const [id, format] of hatchSliders) {
    const input = document.getElementById(id);
    const output = document.getElementById(`${id}-out`);
    const sync = () => { output.textContent = format(input.value); };
    input.addEventListener("input", sync);
    sync();
  }

  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => {
      for (const other of document.querySelectorAll(".tab")) {
        const selected = other === tab;
        other.setAttribute("aria-selected", String(selected));
        document.getElementById(`tab-${other.dataset.tab}`).hidden = !selected;
      }
    });
  }

  document.getElementById("undo").disabled = true;
  document.getElementById("redo").disabled = true;

  window.addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
    event.preventDefault();
    event.shiftKey ? redo() : undo();
  });
}

async function copyHpgl() {
  if (!state.hpgl) return setStatus("Nothing to copy yet.", true);
  try {
    await navigator.clipboard.writeText(state.hpgl);
    setStatus("HP-GL copied to clipboard.");
  } catch {
    setStatus("Clipboard blocked - use the HP-GL tab and copy manually.", true);
  }
}

function downloadHpgl() {
  if (!state.hpgl) return setStatus("Nothing to download yet.", true);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const url = URL.createObjectURL(new Blob([state.hpgl], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `paint-plotter-${stamp}.hpgl`;
  link.click();
  URL.revokeObjectURL(url);
  setStatus(`Saved ${link.download}`);
}

/* -------------------------------------------------------- live plotting */

// Sending drives a physical machine, so this half of the app is deliberately explicit: the
// button says what will happen before it happens, progress is reported as what has been *sent*
// (the plotter buffers ahead and its pen keeps moving after the last byte), and Stop is
// reachable at any moment. The server does the pacing and the actual websocket; the browser
// just POSTs the plot and reads back a stream of NDJSON events.

const sendButton = document.getElementById("send");
const stopButton = document.getElementById("stop");
const plotFeed = document.getElementById("plot-feed");
const plotBar = document.getElementById("plot-bar-fill");
const plotLine = document.getElementById("plot-line");

let plotting = false;

function updateSendButton() {
  if (plotting) return;
  const ready = state.plotter.configured && state.hpgl.length > 0;
  sendButton.disabled = !ready;
  sendButton.title = !state.plotter.configured
    ? "No plotter configured - restart the server with PLOTTER_WS=ws://<pi-ip>:8080"
    : state.hpgl
      ? `Stream this plot to ${state.plotter.url}`
      : "Generate a plot first";
}

function setPlotFeed(message, tone = "") {
  plotFeed.hidden = false;
  plotFeed.className = `plot-feed ${tone}`.trim();
  plotLine.textContent = message;
}

function setPlotProgress(fraction) {
  plotBar.style.width = `${Math.min(100, Math.max(0, fraction * 100)).toFixed(1)}%`;
}

function formatDuration(seconds) {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
}

function handlePlotEvent(event) {
  switch (event.type) {
    case "connecting":
      setPlotFeed(`Connecting to ${event.url}...`);
      break;
    case "ready":
      setPlotFeed(
        `${event.lines.toLocaleString()} lines / ${event.bytes.toLocaleString()} bytes` +
        `${event.buffer === null ? "" : `, plotter buffer ${event.buffer}`}` +
        ` - about ${formatDuration(event.estimateSeconds)} of transfer.`
      );
      break;
    case "progress": {
      const percent = Math.round((event.sentBytes / event.totalBytes) * 100);
      setPlotProgress(event.sentBytes / event.totalBytes);
      setPlotFeed(`Sent ${percent}% - line ${event.sentLines.toLocaleString()} of ${event.totalLines.toLocaleString()}`);
      break;
    }
    case "draining":
      setPlotProgress(1);
      setPlotFeed(`All commands sent - letting the last ${formatDuration(event.seconds)} drain to the machine.`);
      break;
    case "device":
      setPlotFeed(`Plotter: ${event.message}`);
      break;
    case "warning":
      setStatus(event.message, true, true);
      break;
    case "notice":
      setStatus(event.message);
      break;
    case "done":
      setPlotProgress(1);
      setPlotFeed(
        `Sent ${event.sentLines.toLocaleString()} lines in ${formatDuration(event.seconds)}. ` +
        `The pen keeps moving until the plotter empties its buffer.`,
        "done"
      );
      setStatus("Plot sent.");
      break;
    case "cancelled":
      setPlotFeed(
        `Stopped after ${event.sentLines.toLocaleString()} of ${event.totalLines.toLocaleString()} lines. ` +
        `The plotter will still finish what it already buffered.`,
        "failed"
      );
      setStatus("Plot stopped.", true);
      break;
    case "error":
      setPlotFeed(event.message, "failed");
      setStatus(event.message, true, true);
      break;
  }
}

async function sendToPlotter() {
  if (plotting || !state.hpgl) return;

  const penCount = new Set(
    (state.hpgl.match(/SP(\d+)/g) ?? []).map((command) => command.slice(2))
  ).size;
  const confirmed = window.confirm(
    `Plot on the machine at ${state.plotter.url}?\n\n` +
    `${state.hpgl.length.toLocaleString()} characters of HP-GL` +
    `${penCount > 1 ? `, ${penCount} pens` : ""}.\n` +
    `Check the paper is loaded and the pens are in the carousel.`
  );
  if (!confirmed) return;

  plotting = true;
  sendButton.disabled = true;
  stopButton.hidden = false;
  setPlotProgress(0);
  setPlotFeed("Starting...");

  try {
    const res = await fetch("/api/plot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hpgl: state.hpgl }),
    });

    // Refusals (no plotter configured, one already running) come back as plain JSON before
    // the event stream starts, so they need handling separately from in-band `error` events.
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) handlePlotEvent(JSON.parse(line));
      }
    }
  } catch (err) {
    setPlotFeed(`Send failed: ${err.message}`, "failed");
    setStatus(`Send failed: ${err.message}`, true, true);
  } finally {
    plotting = false;
    stopButton.hidden = true;
    stopButton.disabled = false;
    updateSendButton();
  }
}

async function stopPlot() {
  stopButton.disabled = true;
  setPlotFeed("Stopping...");
  // Ask the server to abort rather than dropping the fetch: it then closes the websocket
  // itself and still sends back a `cancelled` event saying how far the plot got.
  try {
    await fetch("/api/plot/cancel", { method: "POST" });
  } catch (err) {
    setStatus(`Could not stop: ${err.message}`, true);
    stopButton.disabled = false;
  }
}

function wirePlotter() {
  sendButton.addEventListener("click", sendToPlotter);
  stopButton.addEventListener("click", stopPlot);

  // Closing the tab drops the request, which aborts the stream mid-plot - worth a prompt.
  window.addEventListener("beforeunload", (event) => {
    if (!plotting) return;
    event.preventDefault();
    event.returnValue = "";
  });

  updateSendButton();
}

init();
