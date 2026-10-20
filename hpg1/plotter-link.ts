// Streams HP-GL to the plotter Pi over its websocketd endpoint (`websocketd --port 8080
// ./itsaliveplot`).
//
// The Pi side is a line-oriented bash script: websocketd turns every websocket message into
// one line on the script's stdin, the script runs that through `fold -w60`, asks the plotter
// how much input buffer is free (ESC.B) and writes the line to /dev/ttyUSB0 once it fits.
//
// Two consequences drive everything here:
//
//   1. The fold width is the Pi's unit of flow control: it checks the plotter's free buffer
//      once per folded chunk and writes that chunk with `echo -n`, so the chunk boundaries
//      never reach the serial line - the byte stream is reassembled exactly. Nothing is
//      corrupted by sending a whole plot at once, but nothing is *observable* either. Sending
//      one message per <=60-character line instead makes each message correspond to exactly
//      one buffer check and one write, which is what makes progress mean anything.
//   2. The serial link is 9600 8N1, i.e. ~960 bytes/second. Blasting the whole plot at the
//      socket would land it in the Pi's pipe buffers within milliseconds, which makes progress
//      meaningless and leaves a queue that a cancel can no longer stop. Sending at roughly the
//      speed the wire can drain keeps "cancel" worth pressing.

import { DEFAULT_PEN, isPenAvailable } from "./bed";

/** `fold -w60` on the Pi. A line at or under this width is one chunk, so one buffer check. */
export const MAX_LINE_CHARS = 60;

/** 9600 8N1 is 10 bits per byte on the wire. */
const DEFAULT_BAUD = 9600;

/** How far ahead of the serial link we are willing to run, in bytes. */
const LEAD_BYTES = 512;

/** Stop feeding while this much is still sitting in the local socket buffer. */
const MAX_BUFFERED_BYTES = 4096;

const CONNECT_TIMEOUT_MS = 10_000;
const HELLO_TIMEOUT_MS = 4_000;
const PROGRESS_INTERVAL_MS = 250;

/** How long the feed may make no headway before we say so. */
const STALL_NOTICE_MS = 15_000;

export type PlotEvent =
    | { type: "connecting"; url: string }
    | { type: "ready"; lines: number; bytes: number; buffer: number | null; estimateSeconds: number }
    | { type: "progress"; sentLines: number; totalLines: number; sentBytes: number; totalBytes: number; ackedLines: number }
    | { type: "device"; message: string }
    | { type: "warning"; message: string }
    | { type: "notice"; message: string }
    | { type: "draining"; seconds: number }
    | { type: "done"; sentLines: number; sentBytes: number; seconds: number }
    | { type: "cancelled"; sentLines: number; totalLines: number }
    | { type: "error"; message: string };

export interface StreamOptions {
    /** e.g. ws://10.100.5.213:8080 */
    url: string;
    baud?: number;
    signal?: AbortSignal;
    onEvent?: (event: PlotEvent) => void;
}

/* ------------------------------------------------------------------ splitting */

/**
 * Splits a serialized plot into individual commands, `;` terminator included.
 *
 * `;` is not a reliable delimiter on its own: LB prints literal text that may contain one, and
 * is terminated by ETX instead. Handling that here means label output survives the trip even
 * though the canvas path never emits any.
 */
export function tokenizeHpgl(source: string): string[] {
    const tokens: string[] = [];
    let i = 0;

    while (i < source.length) {
        while (i < source.length && /\s/.test(source[i]!)) i++;
        if (i >= source.length) break;

        if (source.slice(i, i + 2).toUpperCase() === "LB") {
            const etx = source.indexOf("\x03", i);
            const end = etx === -1 ? source.length : etx + 1;
            tokens.push(source.slice(i, end));
            i = end;
            // serialize() joins on ';', so an LB is usually followed by one. ETX already
            // ended the command, so that separator is redundant - drop it.
            if (source[i] === ";") i++;
            continue;
        }

        const semi = source.indexOf(";", i);
        const end = semi === -1 ? source.length : semi;
        const command = source.slice(i, end).trim();
        if (command) tokens.push(`${command};`);
        i = semi === -1 ? source.length : semi + 1;
    }

    return tokens;
}

export interface PackedPlot {
    lines: string[];
    /** Commands wider than the fold width, so they span more than one chunk on the Pi. */
    oversized: string[];
}

/**
 * Packs a plot into wire lines of at most `maxChars`, breaking only between whole commands.
 *
 * `maxChars` matches the Pi's fold width so one message is one chunk is one buffer check.
 * Packing several commands per line rather than sending one each keeps the message count (and
 * so the websocketd round trips) down by roughly a factor of five on freehand work.
 */
export function packHpglLines(hpgl: string, maxChars: number = MAX_LINE_CHARS): PackedPlot {
    const lines: string[] = [];
    const oversized: string[] = [];
    let current = "";

    const flush = () => {
        if (current.length > 0) lines.push(current);
        current = "";
    };

    for (const token of tokenizeHpgl(hpgl)) {
        if (token.length > maxChars) {
            // Sent whole. `fold` will split it across chunks, which is harmless - the Pi
            // reassembles - it just costs an extra buffer check and blurs progress slightly.
            flush();
            oversized.push(token);
            lines.push(token);
            continue;
        }
        if (current.length + token.length > maxChars) flush();
        current += token;
    }
    flush();

    return { lines, oversized };
}

/**
 * Rewrites any `SP` naming a broken carousel slot onto a working one.
 *
 * This is the last point before bytes reach the machine, and unlike /api/hpgl it can be handed
 * a plot the browser didn't generate (a pasted file, an older download). The same guarantee the
 * generator makes - never ask for a pen that isn't there - therefore has to be re-made here.
 */
export function sanitizePens(hpgl: string): { hpgl: string; rewritten: number } {
    let rewritten = 0;
    const tokens = tokenizeHpgl(hpgl).map((token) => {
        const match = /^SP\s*(-?\d+)?\s*;$/i.exec(token);
        if (!match) return token;
        // Bare `SP;` returns the pen to the carousel, which needs no slot number.
        if (match[1] === undefined) return token;
        const pen = Number(match[1]);
        if (isPenAvailable(pen)) return token;
        rewritten++;
        return `SP${DEFAULT_PEN};`;
    });
    return { hpgl: tokens.join(""), rewritten };
}

/* ------------------------------------------------------------------ streaming */

const wire = (line: string) => line.length + 1; // the Pi appends a newline per message

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(done, ms);
        function done() {
            clearTimeout(timer);
            signal?.removeEventListener("abort", done);
            resolve();
        }
        signal?.addEventListener("abort", done, { once: true });
    });
}

class SocketClosed extends Error {}

/**
 * Sends a plot to the plotter, reporting progress as it goes. Resolves when the last line is
 * on the wire; rejects if the Pi is unreachable or drops the connection mid-plot.
 *
 * Progress is what has been *sent*, not what has been drawn: the plotter buffers ahead and its
 * pen keeps moving after the last byte arrives. Callers should word it that way.
 */
export async function streamHpgl(hpgl: string, options: StreamOptions): Promise<void> {
    const { url, baud = DEFAULT_BAUD, signal } = options;
    const emit = options.onEvent ?? (() => {});
    const bytesPerSecond = baud / 10;

    const { lines, oversized } = packHpglLines(hpgl);
    if (lines.length === 0) throw new Error("Nothing to plot");
    if (oversized.length > 0) {
        emit({
            type: "notice",
            message: `${oversized.length} command(s) are wider than the Pi's ${MAX_LINE_CHARS}-character fold width, so progress will be slightly coarse.`,
        });
    }

    const totalBytes = lines.reduce((sum, line) => sum + wire(line), 0);
    emit({ type: "connecting", url });

    const socket = new WebSocket(url);

    // The Pi's greeting: the script echoes the plotter's free buffer size before reading any
    // input, so a number here means the serial side answered ESC.B and the machine is awake.
    let announcedBuffer: number | null = null;
    let hello = false;
    let ackedLines = 0;
    let closed = false;

    socket.addEventListener("message", (event) => {
        const text = String((event as MessageEvent).data).trim();
        if (!hello) {
            hello = true;
            const digits = /-?\d+/.exec(text);
            announcedBuffer = digits ? Number(digits[0]) : null;
            return;
        }
        // Anything after the greeting is the script talking back. If it is instrumented to
        // acknowledge each line, this is a true "the plotter took it" signal; if it is silent
        // this simply never fires and progress falls back to what we have sent.
        ackedLines++;
        if (text) emit({ type: "device", message: text });
    });

    socket.addEventListener("close", () => { closed = true; });

    const closeSocket = () => {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
            socket.close(1000, "done");
        }
    };

    try {
        await waitForOpen(socket, url);

        if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");

        // Give the greeting a moment. Its absence is not fatal - the script only prints it
        // after a successful ESC.B, and the plotter can be slow to answer - but if the socket
        // drops while we wait, the script exited, which is how "plotter offline" surfaces.
        await waitFor(() => hello || closed, HELLO_TIMEOUT_MS);
        if (closed) {
            throw new Error(
                "The plotter bridge closed immediately - the Pi reports the plotter is offline " +
                "or /dev/ttyUSB0 is not responding."
            );
        }
        if (announcedBuffer === 0) {
            emit({ type: "warning", message: "The plotter reports no free buffer; it may be paused or out of paper." });
        }

        const estimateSeconds = totalBytes / bytesPerSecond;
        emit({ type: "ready", lines: lines.length, bytes: totalBytes, buffer: announcedBuffer, estimateSeconds });

        const startedAt = Date.now();
        let sentBytes = 0;
        let lastReport = 0;
        let lastSend = startedAt;
        let stalled = false;

        for (let i = 0; i < lines.length; i++) {
            if (signal?.aborted) {
                emit({ type: "cancelled", sentLines: i, totalLines: lines.length });
                return;
            }
            if (closed) throw new SocketClosed("The plotter bridge dropped the connection mid-plot.");

            // Two brakes. The clock keeps us from outrunning 9600 baud by more than LEAD_BYTES;
            // bufferedAmount catches the case where the plotter itself stalls (pen change, out
            // of paper) and backpressure reaches us through the Pi.
            const dueAt = startedAt + ((sentBytes - LEAD_BYTES) / bytesPerSecond) * 1000;
            const wait = Math.max(dueAt - Date.now(), socket.bufferedAmount > MAX_BUFFERED_BYTES ? 100 : 0);
            if (wait > 0) {
                // A long pause here is the plotter refusing to take more - a pen change it
                // can't complete, no paper, a jam. Nothing is broken, but nothing is moving
                // either, so say so rather than sitting on a frozen progress bar.
                if (!stalled && Date.now() - lastSend > STALL_NOTICE_MS) {
                    stalled = true;
                    emit({
                        type: "warning",
                        message: "The plotter has not accepted anything for 15s - check for a jam, a stuck pen carousel or no paper. Still waiting.",
                    });
                }
                await sleep(Math.min(wait, 250), signal);
                i--; // re-check cancellation and backpressure before committing to this line
                continue;
            }

            socket.send(lines[i]!);
            sentBytes += wire(lines[i]!);

            const now = Date.now();
            lastSend = now;
            if (stalled) {
                stalled = false;
                emit({ type: "notice", message: "The plotter is accepting data again." });
            }
            if (now - lastReport >= PROGRESS_INTERVAL_MS || i === lines.length - 1) {
                lastReport = now;
                emit({
                    type: "progress",
                    sentLines: i + 1,
                    totalLines: lines.length,
                    sentBytes,
                    totalBytes,
                    ackedLines,
                });
            }
        }

        // Closing the socket kills websocketd's child, and with it the fd on /dev/ttyUSB0.
        // Hold on long enough for whatever is still queued on the Pi to reach the plotter.
        const drainSeconds = Math.max(2, (LEAD_BYTES + (announcedBuffer ?? 0)) / bytesPerSecond);
        emit({ type: "draining", seconds: drainSeconds });
        await sleep(drainSeconds * 1000, signal);

        emit({
            type: "done",
            sentLines: lines.length,
            sentBytes,
            seconds: (Date.now() - startedAt) / 1000,
        });
    } finally {
        closeSocket();
    }
}

function waitForOpen(socket: WebSocket, url: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.close();
            reject(new Error(
                `Timed out connecting to the plotter at ${url}. Is the Pi awake and running ` +
                `websocketd? On the RC network a cold ARP cache can also cause this - try \`plotnet pingme\`.`
            ));
        }, CONNECT_TIMEOUT_MS);

        socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
        socket.addEventListener("error", () => {
            clearTimeout(timer);
            reject(new Error(`Could not connect to the plotter at ${url}.`));
        }, { once: true });
    });
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition() && Date.now() < deadline) await sleep(25);
}
