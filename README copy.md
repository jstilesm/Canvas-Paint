# Paint_Plotter

Canvas to Plotter Web Application

## Overview

A web app that lets a user draw an image on an HTML canvas and converts the drawing into HP-GL commands for output to a physical pen plotter.

## Steps

- [x] Build out JS to plotter interpreter — given JS/canvas drawing data, return HP-GL code for the plotter
- [x] Build out web page with canvas screen where user can draw an image
- [x] Connect both interfaces together
- [x] Add Whiteout feature

## Running it

```
npm install
npm run web        # http://localhost:5173  (PORT=... to change)
npm run dev        # same, restarts on file changes
npm run preview    # the standalone Sierpinski render, opens an SVG in the browser
```

To plot for real, point the server at the Pi as well:

```
PLOTTER_WS=ws://10.100.5.213:8080 npm run web

# or, since DHCP moves it around, resolve it first (see the plotnet repo):
PLOTTER_WS="ws://$(plotnet ip | awk '{print $1}'):8080" npm run web
```

Draw on the left, and the right pane shows the SVG preview of the HP-GL the plotter will
actually receive, plus the code itself. `Download .hpgl` gives you the file; **Send to
plotter** streams it straight to the machine (see below).

| Tool     | What it does                                                        | Shift            |
| -------- | ------------------------------------------------------------------- | ---------------- |
| Draw     | Freehand stroke with the selected pen.                              | —                |
| Line     | Straight line between the drag endpoints.                           | snap to 45°      |
| Rect     | Rectangle from the drag box.                                        | square           |
| Triangle | Apex centred on the top edge, base along the bottom.                | equilateral      |
| Ellipse  | Ellipse inscribed in the drag box.                                  | circle           |
| Fill     | Paint-bucket shading — click inside a bounded area to hatch it.     | —                |
| Whiteout | Erases whole strokes, shapes and fills under the cursor.            | —                |

Shift is read live, so toggling it mid-drag re-snaps the shape immediately.

Shapes are marked *exact*: they skip the smoothing and simplification passes (which exist for
freehand input and would round a rectangle's corners off), and the canvas draws them with
plain segments rather than the curve fitting used for pointer samples. Curves are flattened to
polylines — the pen can't draw an arc — with the segment count derived from a 0.05mm flatness
budget, so a small circle stays cheap and a bed-sized one still looks round.

### Fill

A pen can't flood a region, so Fill *hatches*: it finds the enclosed area exactly the way a
raster paint bucket would, then rules closely spaced parallel lines across it. Click inside a
shape you've closed and the interior gets shaded.

Because it's a real flood fill, **it leaks through gaps** just like MS Paint. If the fill
escapes and shades most of the sheet you get a warning saying so — undo, close the outline,
and try again. That warning sticks around rather than being overwritten by the live preview,
since the alternative is silently plotting for an hour.

Hatch settings are baked into each fill at click time, so changing them affects the *next*
fill, not the ones already down. Existing fills are never treated as walls by a later fill —
hatch lines have gaps between them by construction, and filling those gaps is never what you
want.

### Importing SVG

**Import SVG**, or drop a `.svg` file onto the drawing area. The artwork is scaled to fit,
centred, and added as ordinary paths — so you can erase parts of it, fill regions inside it,
or draw on top.

Parsing is delegated to the browser's own SVG engine (`getTotalLength`/`getPointAtLength` plus
`getScreenCTM`), which means arcs, every flavour of Bézier, and nested/rotated transforms come
out right without a hand-written path parser. Each element is sampled along its length and
then thinned by RDP once the real output scale is known, so a curve costs only the points it
needs — imports typically simplify by 90–99%.

Since a pen has no fill, every element contributes its **outline**: a filled shape with no
stroke still plots as its border.

Not supported, each reported in the status line when encountered: `<text>` (a plotter needs
outlines, not fonts — convert text to paths first), `<use>` references, and bitmap `<image>`.
All imported paths use the currently selected pen; per-colour pen mapping isn't wired up yet.

### Controls

| Control     | What it does                                                                 |
| ----------- | ---------------------------------------------------------------------------- |
| Margin      | Unplotted border. The drawing is fit to the remaining area, aspect preserved. |
| Simplify    | Ramer–Douglas–Peucker tolerance in mm. 0.3mm typically cuts point count ~65%. |
| Smoothing   | Moving-average passes over the raw input, to take out hand shake.             |
| Hatch       | Fill line spacing in mm — this is the shading density. Halving it doubles plot time. |
| Angle       | Hatch direction.                                                             |
| Cross-hatch | Second pass at 90° to the first, offset half a step. Roughly doubles travel.  |
| Batch PA    | Packs up to 8 coordinate pairs per `PA`. **Leave off** — see Machine notes.   |

Margin/Simplify/Smoothing re-run the export on every change; Hatch/Angle/Cross-hatch don't,
because they only affect future fills.

`Generate` / `Copy` / `Download .hpgl` work on the plot itself; `Send to plotter` and `Stop`
drive the machine and are only enabled when `PLOTTER_WS` is set.

## Sending to the plotter

On the Pi, `websocketd --port 8080 ./itsaliveplot` bridges a websocket to `/dev/ttyUSB0`:
every websocket message becomes one line on the script's stdin, the script runs it through
`fold -w60`, asks the plotter how much input buffer is free (`ESC.B`) and writes the line to
the serial port once it fits.

Start the server with `PLOTTER_WS` set and the **Send to plotter** button lights up. It
confirms first (it moves a physical machine), then streams, showing a progress bar and a
**Stop** button. There's a CLI for the same thing without the browser:

```
PLOTTER_WS=ws://10.100.5.213:8080 npm run plot -- drawing.hpgl
```

The browser never talks to the Pi directly. It POSTs the plot to `/api/plot` and reads back a
stream of NDJSON events; the server owns the websocket. That keeps the Pi's address in one
place, lets the page work over https (where `ws://` would be blocked), and — the real reason —
lets the server refuse a second plot while one is running. Two tabs interleaving commands into
one plotter wouldn't fail loudly, it would just draw garbage.

### Why the plot is split into ≤60-character lines

Not for correctness — `itsaliveplot` writes each folded chunk with `echo -n`, so the newlines
`fold` inserts never reach the serial port and the byte stream is reassembled exactly. A whole
plot sent as one message arrives intact (verified by running the script's write loop against a
file: whole-message and per-line paths produce byte-identical output).

The fold width matters because it's the Pi's **unit of flow control** — one chunk, one `ESC.B`
buffer check, one write. Sending one message per ≤60-character line makes each websocket
message correspond to exactly one of those, which is what makes the progress bar and Stop mean
anything. `packHpglLines` in `hpg1/plotter-link.ts` does that, breaking only between whole
commands and packing several per line to keep the message count down.

### Pacing and stopping

The serial link is 9600 8N1 — about 960 bytes/second — while a websocket send lands in the Pi's
pipe buffers instantly. The stream is therefore paced to roughly wire speed (with a 512-byte
lead, plus a `bufferedAmount` cap that catches the plotter stalling on a pen change or running
out of paper). That's what makes the progress bar mean anything and what makes **Stop** worth
pressing: at most a second or so of commands is in flight.

Progress is what has been **sent**, not what has been drawn — the plotter buffers ahead and its
pen keeps moving after the last byte lands. The UI says so rather than claiming the plot is
finished. Stopping likewise cuts the feed; whatever already reached the plotter's own buffer
still gets drawn.

If `itsaliveplot` is ever changed to echo a line after each write, the client picks those up
automatically as acknowledgements (`ackedLines`) and progress becomes exact.

### Failure modes it reports

| What you see | What happened |
| --- | --- |
| `Could not connect to the plotter at ...` | Nothing listening — `websocketd` isn't running. |
| `Timed out connecting ...` | Host unreachable. On the RC network this is usually the ARP problem; `plotnet pingme` fixes it. |
| `The plotter bridge closed immediately` | The script's `ESC.B` got no answer and it hit `exit 5` — plotter powered off, or the wrong `/dev/ttyUSB0`. |
| `A plot has been running for Ns` | Another plot is in flight. Stop it first. |

## Machine notes

**Pen carousel slots 0–3 are broken** — `SP0`–`SP3` must never be emitted. The pen picker only
offers working slots and `resolvePen` snaps anything else onto the default.

What's loaded, in slot order:

| Slot | Ink   |
| ---- | ----- |
| 4    | black (default) |
| 5    | green |
| 6    | pink  |
| 7    | red   |
| 8    | white |

`PEN_INKS` in `hpg1/bed.ts` is the single source for this: the usable-slot list *and* the
preview colours are both derived from it, so swapping a pen means editing one map and nothing
can drift out of sync. If a broken slot gets repaired, add it there.

White ink is invisible on white paper, so light inks are drawn with a grey halo underneath in
both the canvas and the SVG preview — otherwise the white pen would plot blind. Which inks
need one is decided server-side (`isLightInk`, a luma threshold) so the two panes can't
disagree.

**One coordinate pair per `PA`.** HP-GL allows `PA x1,y1,x2,y2,...` and batching cuts file
size by up to ~20%, but this plotter refuses a plot outright when a `PA` carries more than one
pair. The same geometry emitted one pair per command runs fine — confirmed by diffing a
working file against a rejected one, where the *only* structural difference was pairs-per-`PA`
(1 vs up to 8) and command length (12 vs 82 chars).

`maxPointsPerCommand` in `InitOptions` controls this and defaults to `1`. The **Batch PA**
checkbox in the web UI flips it to 8 so you can retest on other hardware; leave it off for
this machine. Note the saving is small for hatched fills anyway — hatch runs are two points
each, so most `PA` commands are single-pair regardless.

The Pi's `fold -w60` was briefly suspected here, since the rejected file's other structural
difference was command length (82 chars vs 12). It isn't the cause: `echo -n` reassembles the
folded chunks, so an 82-character `PA` reaches the plotter whole. The original finding stands —
the machine really does reject multi-pair `PA`.

---

## Day 1

Built the basic class structure for the HP-GL interpreter, with foundational pen and motion commands.

### Done

- Created `Point` and `InitOptions` types
- Created basic commands: `penUP`, `penDOWN`, `drawLine`, `drawPoint`, `arc`, `polyLine`
- Added absolute (`moveTo`/`lineTo`/`set`) and relative (`move`) positioning
- Added unit conversion between mm and plotter units (`toPlotterUnits`, 1 unit = 0.025mm)
- Added command serialization (`serialize`) to produce a semicolon-delimited HP-GL string

### Known issues / notes for tomorrow

- Next: canvas drawing capture — evaluate path-simplification (Ramer–Douglas–Peucker) + curve fitting (Bezier fit or Catmull-Rom) + adaptive flattening to convert freehand mouse input into clean HP-GL point lists

- Build a way to preview the HPGL Code upon generation

---

## Day 2

Built the web feature: draw on a canvas, get HP-GL out.

### Done

- `hpg1/simplify.ts` — RDP simplification, plus dedupe/smoothing passes for freehand input
- `hpg1/canvas.ts` — canvas pixels → bed millimetres (aspect-preserving fit, Y flip), strokes
  grouped by pen so a multi-colour plot costs one carousel change per pen
- `hpg1/bed.ts` — one definition of the bed and the usable pen slots, shared by every layer
- `server.ts` — dependency-free Node server; `POST /api/hpgl` returns HP-GL + SVG + stats
- `web/` — canvas UI: pens, whiteout, undo/redo, live preview, download
- Merged the expanded `commands.ts` from `base-plotter-commands`: shapes (`polygon`, `rect`,
  `circle`, `ellipse`, `star`, `regularPolygon`, `hatchRect`), `bezier` flattening, machine
  settings (`VS`/`FS`/`LT`/`PW`/`IW`/`RO`/`PG`), labels, and `withPen`/`home`/`end`

### From the merge

- `polyLine` no longer emits its first point twice, and `PA` now batches up to 8 coordinate
  pairs per command — together that cut a two-stroke test plot from 2,168 to 1,719 characters
  and removed two zero-length segments from the preview
- `penUP`/`penDOWN` track state, so redundant `PU;PU` runs are gone
- `drawLine` was doing `set` (absolute) then `move` (relative), which put the endpoint in the
  wrong place; it now uses `moveTo`/`lineTo`
- `parkPen()` was dropped and `end()` reworked — it used to emit `SP0`, which is a dead slot
  on this machine (see Machine notes). `end()` now lifts the pen and homes the carriage, so
  **the pen has to be capped by hand** after a plot

### Known issues / notes for tomorrow

- Nothing sorts strokes to reduce pen-up travel between them; plots are drawn in the order
  they were made. A nearest-neighbour pass over stroke start points would cut plot time.
- No curve fitting yet — freehand input is simplified to polylines. `bezier()` exists now, so
  fitting cubics to the stroke points before flattening is the obvious next step.
- `serialize()` joins on `;`, so a `label()` containing a semicolon would corrupt the output.
- SVG import puts every path on the current pen. Mapping distinct `stroke` colours onto
  separate carousel pens is the obvious next step, and would make multi-pen plots easy.
- SVG import always fits to the full drawing area, so importing a second file rescales it to
  the same box rather than placing it alongside the first.
- Multi-point `PA` is off by default (see Machine notes). If the real cause turns out to be
  command *length* rather than parameter count, a batch size of 2–3 would still be safe and
  recover most of the saving — worth testing on the machine.

---

## Day 3

Added the paint-bucket fill, and merged the expanded command set.

### Done

- `web/fill.js` — raster flood fill (4-connected scanline) + hatch generation. Raster-based
  rather than geometric on purpose: freehand strokes overshoot, self-intersect and leave
  hairline gaps, so point-in-polygon testing is fragile on exactly this input.
- Hatch runs are emitted boustrophedon (alternate lines reversed) so the pen snakes back and
  forth instead of flying back to the same edge before every line.
- The drawing model is now a list of items — `{kind:"stroke", points}` or `{kind:"fill", runs}`
  — flattened by `itemRuns`, so render/erase/export have one code path. A fill undoes and
  erases as a single unit.
- `PEN_COLORS` is now derived from `AVAILABLE_PENS` instead of being a hand-kept second list.
  The two had already drifted once when slots 7 and 8 were added, which showed up as blank
  swatches in the pen picker.

### Known issues / notes for tomorrow

- Fill is bounded by strokes only, and bakes its hatch at click time. Drawing a new stroke
  through an existing fill won't re-clip it — same as Paint, but worth knowing.
- Nothing sorts strokes to reduce pen-up travel between them; plots are drawn in the order
  they were made. This matters much more now that a fill emits 50–150 separate runs.
- No curve fitting yet — freehand input is simplified to polylines. `bezier()` exists now, so
  fitting cubics to the stroke points before flattening is the obvious next step.
- `serialize()` joins on `;`, so a `label()` containing a semicolon would corrupt the output.
- SVG import puts every path on the current pen. Mapping distinct `stroke` colours onto
  separate carousel pens is the obvious next step, and would make multi-pen plots easy.
- SVG import always fits to the full drawing area, so importing a second file rescales it to
  the same box rather than placing it alongside the first.
- Multi-point `PA` is off by default (see Machine notes). If the real cause turns out to be
  command *length* rather than parameter count, a batch size of 2–3 would still be safe and
  recover most of the saving — worth testing on the machine.
