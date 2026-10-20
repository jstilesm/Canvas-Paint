import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canvasToHpgl, type CanvasStroke } from "./hpg1/canvas";
import { hpglToSvg } from "./hpg1/preview";
import { sanitizePens, streamHpgl, type PlotEvent } from "./hpg1/plotter-link";
import {
    AVAILABLE_PENS,
    BED_MM,
    DEFAULT_PEN,
    INK_HALO_COLOR,
    PEN_COLORS,
    PEN_INKS,
    UNITS_PER_MM,
    isLightInk,
    resolvePen,
} from "./hpg1/bed";

// Deliberately dependency-free: Node's own http server is enough to hand the browser a
// static page and run the canvas -> HPGL conversion, and it keeps `npm i` down to tsx.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(HERE, "web");
const PORT = Number(process.env.PORT ?? 5173);

// The Pi bridging websocketd to /dev/ttyUSB0. Its address changes with DHCP, so it is an env
// var rather than a constant:  PLOTTER_WS="ws://$(plotnet ip | awk '{print $1}'):8080" npm run web
const PLOTTER_WS = process.env.PLOTTER_WS ?? "";
const PLOTTER_BAUD = Number(process.env.PLOTTER_BAUD ?? 9600);

// Freehand strokes are verbose. 8MB is generous for a full page of drawing while still
// refusing to buffer an unbounded request body.
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8",
    ".ico": "image/x-icon",
};

/**
 * The plotter is one physical machine, so exactly one plot may be in flight at a time.
 * Interleaving two drawings' commands would not fail loudly - it would just draw garbage - so
 * the second request is refused rather than queued.
 */
let activePlot: { controller: AbortController; startedAt: number } | null = null;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error("Request body too large"));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

function serveStatic(urlPath: string, res: http.ServerResponse): void {
    const relative = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath).replace(/^\/+/, "");
    const filePath = path.join(WEB_ROOT, relative);

    // Reject anything that escapes web/ - `..` segments, absolute paths, symlink-ish tricks.
    if (path.relative(WEB_ROOT, filePath).startsWith("..") || path.isAbsolute(path.relative(WEB_ROOT, filePath))) {
        res.writeHead(403).end("Forbidden");
        return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
            return;
        }
        res.writeHead(200, {
            "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
            "Cache-Control": "no-cache",
        });
        res.end(data);
    });
}

interface HpglRequest {
    strokes?: CanvasStroke[];
    canvasWidth?: number;
    canvasHeight?: number;
    marginMM?: number;
    toleranceMM?: number;
    smoothPasses?: number;
    defaultPen?: number;
    maxPointsPerCommand?: number;
}

function handleHpglRequest(raw: string, res: http.ServerResponse): void {
    let body: HpglRequest;
    try {
        body = JSON.parse(raw);
    } catch {
        sendJson(res, 400, { error: "Body must be valid JSON" });
        return;
    }

    const { strokes, canvasWidth, canvasHeight } = body;

    if (!Array.isArray(strokes)) {
        sendJson(res, 400, { error: "`strokes` must be an array" });
        return;
    }
    if (!Number.isFinite(canvasWidth) || !Number.isFinite(canvasHeight) || canvasWidth! <= 0 || canvasHeight! <= 0) {
        sendJson(res, 400, { error: "`canvasWidth` and `canvasHeight` must be positive numbers" });
        return;
    }

    // Never trust client geometry: a NaN or a string coordinate would silently poison the
    // whole plot with `PA NaN,NaN`, which the plotter would choke on rather than reject.
    const clean: CanvasStroke[] = [];
    for (const stroke of strokes) {
        if (!stroke || !Array.isArray(stroke.points)) continue;
        const points = stroke.points.filter(
            (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y)
        );
        if (points.length === 0) continue;
        // Slots 0-3 are broken hardware, so a client asking for one gets the default pen
        // instead - the plotter must never be told to pick up a pen that isn't there.
        clean.push({
            pen: resolvePen(Math.round(stroke.pen)),
            points,
            smooth: stroke.smooth !== false,
            simplify: stroke.simplify !== false,
        });
    }

    const { hpgl, stats } = canvasToHpgl(clean, {
        canvasWidth: canvasWidth!,
        canvasHeight: canvasHeight!,
        marginMM: Number.isFinite(body.marginMM) ? body.marginMM : undefined,
        toleranceMM: Number.isFinite(body.toleranceMM) ? body.toleranceMM : undefined,
        smoothPasses: Number.isFinite(body.smoothPasses) ? body.smoothPasses : undefined,
        defaultPen: Number.isFinite(body.defaultPen) ? body.defaultPen : undefined,
        maxPointsPerCommand: Number.isFinite(body.maxPointsPerCommand)
            ? Math.max(1, Math.min(64, Math.round(body.maxPointsPerCommand!)))
            : undefined,
    });

    // Round-trip the HPGL back through the interpreter rather than drawing the SVG from the
    // strokes directly. The preview then reflects what the plotter will actually receive -
    // simplification, pen ordering, Y flip and all - instead of what the user drew.
    sendJson(res, 200, { hpgl, svg: hpglToSvg(hpgl, { showBounds: true }), stats });
}

/**
 * Streams a plot to the machine, reporting back as newline-delimited JSON.
 *
 * NDJSON rather than SSE because the browser needs to POST the plot up front, which EventSource
 * cannot do; `fetch` + a stream reader handles both halves in one request.
 */
async function handlePlotRequest(raw: string, res: http.ServerResponse): Promise<void> {
    let body: { hpgl?: unknown };
    try {
        body = JSON.parse(raw);
    } catch {
        sendJson(res, 400, { error: "Body must be valid JSON" });
        return;
    }

    if (typeof body.hpgl !== "string" || body.hpgl.trim().length === 0) {
        sendJson(res, 400, { error: "`hpgl` must be a non-empty string" });
        return;
    }
    if (!PLOTTER_WS) {
        sendJson(res, 503, {
            error: "No plotter configured. Start the server with PLOTTER_WS=ws://<pi-ip>:8080.",
        });
        return;
    }
    if (activePlot) {
        sendJson(res, 409, {
            error: `A plot has been running for ${Math.round((Date.now() - activePlot.startedAt) / 1000)}s. Stop it first.`,
        });
        return;
    }

    const { hpgl, rewritten } = sanitizePens(body.hpgl);
    const controller = new AbortController();
    activePlot = { controller, startedAt: Date.now() };

    res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });

    const send = (event: PlotEvent) => {
        if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
    };

    // The browser navigating away or hitting Stop drops the request; that has to abort the
    // stream too, or the plotter would keep drawing with nobody watching.
    res.on("close", () => controller.abort());

    if (rewritten > 0) {
        send({
            type: "warning",
            message: `${rewritten} pen selection(s) named a broken carousel slot and were moved to pen ${DEFAULT_PEN}.`,
        });
    }

    try {
        await streamHpgl(hpgl, {
            url: PLOTTER_WS,
            baud: PLOTTER_BAUD,
            signal: controller.signal,
            onEvent: send,
        });
    } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
        activePlot = null;
        res.end();
    }
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/api/config") {
        sendJson(res, 200, {
            bedMM: BED_MM,
            unitsPerMM: UNITS_PER_MM,
            penColors: PEN_COLORS,
            penNames: Object.fromEntries(AVAILABLE_PENS.map((pen) => [pen, PEN_INKS[pen].name])),
            // Decided here rather than in the browser so the canvas and the SVG preview agree
            // on which inks need a halo.
            lightPens: AVAILABLE_PENS.filter((pen) => isLightInk(PEN_COLORS[pen])),
            haloColor: INK_HALO_COLOR,
            availablePens: AVAILABLE_PENS,
            defaultPen: DEFAULT_PEN,
            plotter: { url: PLOTTER_WS, configured: PLOTTER_WS.length > 0 },
        });
        return;
    }

    if (url.pathname === "/api/plot") {
        if (req.method !== "POST") {
            res.writeHead(405, { Allow: "POST" }).end("Method not allowed");
            return;
        }
        try {
            await handlePlotRequest(await readBody(req), res);
        } catch (err) {
            sendJson(res, 413, { error: err instanceof Error ? err.message : "Could not read request body" });
        }
        return;
    }

    if (url.pathname === "/api/plot/cancel") {
        if (req.method !== "POST") {
            res.writeHead(405, { Allow: "POST" }).end("Method not allowed");
            return;
        }
        // Stops the feed. Whatever already reached the plotter's own buffer still gets drawn -
        // a few hundred bytes at most, since the stream is paced to the serial link.
        const running = activePlot !== null;
        activePlot?.controller.abort();
        sendJson(res, 200, { stopped: running });
        return;
    }

    if (url.pathname === "/api/hpgl") {
        if (req.method !== "POST") {
            res.writeHead(405, { Allow: "POST" }).end("Method not allowed");
            return;
        }
        try {
            handleHpglRequest(await readBody(req), res);
        } catch (err) {
            sendJson(res, 413, { error: err instanceof Error ? err.message : "Could not read request body" });
        }
        return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
        serveStatic(url.pathname, res);
        return;
    }

    res.writeHead(405).end("Method not allowed");
});

server.listen(PORT, () => {
    console.log(`Paint Plotter running at http://localhost:${PORT}`);
    console.log(`Bed: ${BED_MM[0]}mm x ${BED_MM[1]}mm (${UNITS_PER_MM} plotter units/mm)`);
    console.log(
        PLOTTER_WS
            ? `Plotter: ${PLOTTER_WS} at ${PLOTTER_BAUD} baud`
            : "Plotter: not configured - set PLOTTER_WS=ws://<pi-ip>:8080 to enable Send to plotter"
    );
});
