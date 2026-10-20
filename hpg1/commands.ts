import type { InitOptions, Point, Triangle } from "./types";
import { resolvePen } from "./bed";
// Base comamnds
// IN (initialize),
// SP (select pen),
// PU/PD (pen up/down),
// PA/PR (absolute/relative plot) ?,
// SC (scaling points) ?,
// VS/FS (velocity / pen force),
// LT (line type), PW (pen width),
// IW (input window / clip), RO (rotate), PG (page feed),
// DT/LB/SI/DI (labels)

// Chord length in mm used when flattening curves into line segments. Small enough that
// curves read as smooth at plotter resolution (1 unit = 0.025mm) without exploding the
// command count.
const DEFAULT_CHORD_MM = 1;

// How many coordinate pairs to pack into a single PA.
//
// HP-GL allows `PA x1,y1,x2,y2,...` and batching cuts file size by roughly a third, but not
// every plotter accepts it - ours rejects a plot outright when PA carries more than one pair,
// while the same geometry emitted one pair per command runs fine. So the default is the form
// that is known to work on the hardware; raise it per-instance if a machine tolerates more.
const DEFAULT_MAX_POINTS_PER_COMMAND = 1;

export default class HGPL {
    private commands: string[] = [];
    private currentPosition: { x: number; y: number } = { x: 0, y: 0 };
    private unitsPerMM: number;
    private currentPen: number;
    private penIsDown = false;
    private maxPointsPerCommand: number;

    // #1 plotter unit == 0.025 mm 1 / .025 = 40;
    constructor(options: InitOptions = {}) {
        this.unitsPerMM = options.unitsPerMM ?? 40;
        this.currentPen = resolvePen(options.defaultPen);
        this.maxPointsPerCommand = Math.max(
            1,
            Math.round(options.maxPointsPerCommand ?? DEFAULT_MAX_POINTS_PER_COMMAND)
        );
        this.init();
  }
  private init() {
    this.commands.push('IN');
    this.commands.push(`SP${this.currentPen}`)
  }
  private toPlotterUnits(x: number, y: number): [number, number] {
    return [Math.round(x * this.unitsPerMM), Math.round(y * this.unitsPerMM)];
  }

  // Information
  getPos() {
    return this.currentPosition;
  }
  getPen() {
    return this.currentPen;
  }
  isPenDown() {
    return this.penIsDown;
  }

  // Pen control

  penUP() {
    if (!this.penIsDown) return;
    this.penIsDown = false;
    this.commands.push('PU')
  }
  penDOWN() {
    if (this.penIsDown) return;
    this.penIsDown = true;
    this.commands.push('PD')
  }
  selectPen(p: number) {
    // The carousel arm can't swap pens with one still on the paper.
    this.penUP();
    // Slots 0-3 are broken on this machine, so a dead slot silently becomes the default
    // pen. Every SP in a plot funnels through here, which is what makes that guarantee hold.
    this.currentPen = resolvePen(p);
    this.commands.push(`SP${this.currentPen}`)
  }
  // Draw with `p`, then put the previous pen back - lets a caller borrow a colour
  // without having to remember what was loaded before.
  withPen(p: number, draw: () => void) {
    const previous = this.currentPen;
    this.selectPen(p);
    draw();
    this.selectPen(previous);
  }

  // Machine settings

  velocity(cmPerSecond: number) {
    this.commands.push(`VS${cmPerSecond}`)
  }
  force(level: number, pen?: number) {
    this.commands.push(pen === undefined ? `FS${level}` : `FS${level},${resolvePen(pen)}`)
  }
  // LT with no pattern restores a solid line.
  lineType(pattern?: number, patternLengthMM?: number) {
    if (pattern === undefined) {
      this.commands.push('LT');
      return;
    }
    const length = patternLengthMM === undefined ? '' : `,${patternLengthMM}`;
    this.commands.push(`LT${pattern}${length}`)
  }
  penWidth(widthMM: number, pen?: number) {
    this.commands.push(pen === undefined ? `PW${widthMM}` : `PW${widthMM},${resolvePen(pen)}`)
  }
  // Clip window - anything plotted outside of it is discarded by the plotter.
  clipWindow(x1: number, y1: number, x2: number, y2: number) {
    const [px1, py1] = this.toPlotterUnits(x1, y1);
    const [px2, py2] = this.toPlotterUnits(x2, y2);
    this.commands.push(`IW ${px1},${py1},${px2},${py2}`)
  }
  clearClipWindow() {
    this.commands.push('IW')
  }
  rotate(degrees: 0 | 90 | 180 | 270) {
    this.commands.push(`RO${degrees}`)
  }
  home() {
    this.penUP();
    this.set(0, 0);
  }
  pageFeed() {
    this.commands.push('PG')
  }
  // Standard way to close a plot out: pen up, carriage home, paper out.
  //
  // HPGL parks the pen with SP0, but slot 0 is one of this machine's broken positions, so
  // we can't return the pen under program control - we just get it off the paper and move
  // the carriage clear. Cap the pen by hand once the plot finishes or it will dry out.
  end(feed = false) {
    this.home();
    if (feed) this.pageFeed();
  }

  // Positioning

  set(x: number, y: number) {
    const [px, py] = this.toPlotterUnits(x, y);
    this.currentPosition = { x, y };
    this.commands.push(`PA ${px},${py}`);
  }
  move(x: number, y: number) {
    const [px, py] = this.toPlotterUnits(x, y);
    this.commands.push(`PR ${px},${py}`);
    this.currentPosition = { x: this.currentPosition.x + x, y: this.currentPosition.y + y };
  }
  // Pen-up travel to a point - the "go here without drawing" primitive.
  moveTo(x: number, y: number) {
    this.penUP();
    this.set(x, y);
  }
  lineTo(x: number, y: number) {
    this.penDOWN();
    this.set(x, y);
  }
  // PA accepts several coordinate pairs and plots them as a connected run. Batching keeps the
  // output far shorter, but see DEFAULT_MAX_POINTS_PER_COMMAND - it defaults to one pair per
  // command because that is what the machine actually accepts.
  private plot(points: Point[]) {
    for (let i = 0; i < points.length; i += this.maxPointsPerCommand) {
      const chunk = points.slice(i, i + this.maxPointsPerCommand);
      const coords = chunk
        .map((p) => this.toPlotterUnits(p.x, p.y).join(','))
        .join(',');
      this.commands.push(`PA ${coords}`);
    }
    const last = points[points.length - 1];
    if (last) this.currentPosition = { x: last.x, y: last.y };
  }

  // Shapes

  drawLine(x1: number, y1: number, x2: number, y2: number) {
    this.moveTo(x1, y1);
    this.lineTo(x2, y2);
    this.penUP();
  }
  drawPoint(x: number, y: number) {
    this.moveTo(x, y);
    this.penDOWN();
    this.penUP();
  }
  polyLine(points: Point[]) {
    if (points.length === 0) return;
    this.moveTo(points[0].x, points[0].y);
    this.penDOWN();
    this.plot(points.slice(1));
    this.penUP();
  }
  // Same as polyLine but joins the last point back to the first.
  polygon(points: Point[]) {
    if (points.length === 0) return;
    this.moveTo(points[0].x, points[0].y);
    this.penDOWN();
    this.plot([...points.slice(1), points[0]]);
    this.penUP();
  }
  triangle(points: Triangle | Point[]) {
    this.polygon(points as Point[]);
  }
  // x,y is the lower-left corner (HPGL's origin is bottom-left).
  rect(x: number, y: number, width: number, height: number) {
    this.polygon([
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ]);
  }
  square(x: number, y: number, size: number) {
    this.rect(x, y, size, size);
  }
  // Fill a rect with evenly spaced lines - a poor man's fill, since a pen can't flood.
  hatchRect(x: number, y: number, width: number, height: number, spacing = 1) {
    for (let offset = spacing; offset < height; offset += spacing) {
      this.drawLine(x, y + offset, x + width, y + offset);
    }
  }
  regularPolygon(cx: number, cy: number, r: number, sides: number, rotation = 0) {
    if (sides < 3) return;
    const points: Point[] = [];
    for (let i = 0; i < sides; i++) {
      const angle = rotation + (i / sides) * 2 * Math.PI;
      points.push({ x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r });
    }
    this.polygon(points);
  }
  star(cx: number, cy: number, outerR: number, innerR: number, points = 5, rotation = Math.PI / 2) {
    const pts: Point[] = [];
    for (let i = 0; i < points * 2; i++) {
      const r = i % 2 === 0 ? outerR : innerR;
      const angle = rotation + (i / (points * 2)) * 2 * Math.PI;
      pts.push({ x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r });
    }
    this.polygon(pts);
  }
  // HPGL has a native CI (circle), but flattening to line segments keeps the output
  // renderable by the SVG preview and portable across plotters.
  circle(cx: number, cy: number, r: number, stepSize = DEFAULT_CHORD_MM) {
    this.ellipse(cx, cy, r, r, 0, stepSize);
  }
  ellipse(cx: number, cy: number, rx: number, ry: number, rotation = 0, stepSize = DEFAULT_CHORD_MM) {
    const steps = this.stepsFor(Math.PI * (rx + ry), stepSize);
    const points: Point[] = [];
    for (let i = 0; i < steps; i++) {
      const t = (i / steps) * 2 * Math.PI;
      const x = Math.cos(t) * rx;
      const y = Math.sin(t) * ry;
      points.push({
        x: cx + x * Math.cos(rotation) - y * Math.sin(rotation),
        y: cy + x * Math.sin(rotation) + y * Math.cos(rotation),
      });
    }
    this.polygon(points);
  }
  arc(
    x: number,
    y: number,
    r: number,
    rotation: number,
    sweep: number = 0,
    stepSize: number = DEFAULT_CHORD_MM
    ) {
        sweep = Math.min(sweep, 2 * Math.PI)
        const arcLength = Math.abs(sweep * r)
        const steps = this.stepsFor(arcLength, stepSize)
        const pts: Point[] = []
        for (let i = 0; i <= steps; i++) {
            const t = i / steps
            const angle = rotation + t * sweep
            pts.push({ x: x + Math.cos(angle) * r, y: y + Math.sin(angle) * r});
        }
        this.polyLine(pts)
  }
  // Cubic Bezier, flattened - the shape freehand canvas input will most likely be fitted to.
  bezier(p0: Point, p1: Point, p2: Point, p3: Point, stepSize = DEFAULT_CHORD_MM) {
    this.polyLine(this.bezierPoints(p0, p1, p2, p3, stepSize));
  }
  private bezierPoints(p0: Point, p1: Point, p2: Point, p3: Point, stepSize: number): Point[] {
    // Control-polygon length is an upper bound on the curve length, so it's a safe
    // (slightly generous) basis for picking a step count.
    const hull =
      distance(p0, p1) + distance(p1, p2) + distance(p2, p3);
    const steps = this.stepsFor(hull, stepSize);
    const points: Point[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const u = 1 - t;
      points.push({
        x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
        y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
      });
    }
    return points;
  }
  private stepsFor(lengthMM: number, stepSize: number): number {
    return Math.max(8, Math.round(lengthMM / stepSize));
  }

  // Labels

  // ETX terminates an LB command instead of a semicolon, so DT declares it up front.
  labelSize(widthCM: number, heightCM: number) {
    this.commands.push(`SI${widthCM},${heightCM}`)
  }
  // run/rise vector - `1,0` is horizontal, `0,1` prints bottom-to-top.
  labelDirection(run: number, rise: number) {
    this.commands.push(`DI${run},${rise}`)
  }
  label(text: string, x?: number, y?: number) {
    if (x !== undefined && y !== undefined) this.moveTo(x, y);
    this.commands.push('DT\x03');
    this.commands.push(`LB${text}\x03`);
  }

  // Serialize the commands to a string
  serialize(): string {
    return this.commands.join(';') + ';';
  }
  // Drop everything after IN/SP so one instance can be reused for another plot.
  reset() {
    const [initialize, pen] = this.commands;
    this.commands = [initialize, pen];
    this.currentPosition = { x: 0, y: 0 };
    this.penIsDown = false;
  }
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}
