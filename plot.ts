#!/usr/bin/env -S npx tsx
// Sends a .hpgl file straight to the plotter, without the browser.
//
//   PLOTTER_WS=ws://10.100.5.213:8080 npm run plot -- drawing.hpgl
//
// Useful for re-running a downloaded plot, and for checking the link is up before drawing
// anything: a run that reaches "Sent 0%" has already proved the Pi and the serial side work.

import fs from "node:fs";
import { sanitizePens, streamHpgl } from "./hpg1/plotter-link";

const file = process.argv[2];
const url = process.env.PLOTTER_WS;

if (!file || !url) {
    console.error("usage: PLOTTER_WS=ws://<pi-ip>:8080 npm run plot -- <file.hpgl>");
    process.exit(2);
}

const target: string = url;

const { hpgl, rewritten } = sanitizePens(fs.readFileSync(file, "utf8"));
if (rewritten > 0) console.error(`note: moved ${rewritten} pen selection(s) off broken carousel slots`);

// Ctrl-C stops the feed; the plotter still finishes whatever it has already buffered.
const controller = new AbortController();
process.on("SIGINT", () => {
    console.error("\nstopping...");
    controller.abort();
});

async function main() {
    await streamHpgl(hpgl, {
        url: target,
        baud: Number(process.env.PLOTTER_BAUD ?? 9600),
        signal: controller.signal,
        onEvent: (event) => {
            if (event.type === "progress") {
                const percent = ((event.sentBytes / event.totalBytes) * 100).toFixed(0);
                process.stderr.write(`\r${percent}% - line ${event.sentLines}/${event.totalLines}   `);
                return;
            }
            process.stderr.write(`\r${JSON.stringify(event)}\n`);
        },
    });
}

main().catch((err) => {
    console.error(`\n${err instanceof Error ? err.message : err}`);
    process.exit(1);
});
