// Single source of truth for the machine bed. Shared by the HPGL preview renderer, the
// canvas -> HPGL converter and the web server so the drawing surface, the SVG preview and
// the emitted plot all agree on one coordinate space.

// Plotter units. 1 unit == 0.025mm, so 40 units == 1mm.
export const UNITS_PER_MM = 40;
export const BOUNDS: [number, number] = [10300, 7650];

export const BED_MM: [number, number] = [
    BOUNDS[0] / UNITS_PER_MM,
    BOUNDS[1] / UNITS_PER_MM,
];

// HARDWARE CONSTRAINT: carousel slots 0-3 are broken on this machine, so `SP0`-`SP3` must
// never be emitted. (SP0 is also HPGL's "put the pen away" command - we don't use it either,
// which is why a finished plot ends on PU rather than SP0.) Everything that picks a pen goes
// through AVAILABLE_PENS / resolvePen so there is one place to edit if a slot gets repaired.
//
// This map is what is physically loaded in the carousel, in slot order. It is the single
// source for both the usable-slot list and the preview colours, so the two cannot drift apart
// when a pen is swapped - change the ink here and everything downstream follows.
export interface PenInk {
    name: string;
    color: string; // approximate ink colour, for the on-screen preview
}

export const PEN_INKS: Record<number, PenInk> = {
    4: { name: "black", color: "#1b1b1b" },
    5: { name: "green", color: "#2f9e44" },
    6: { name: "pink", color: "#e64980" },
    7: { name: "red", color: "#e03131" },
    8: { name: "white", color: "#ffffff" },
};

export const AVAILABLE_PENS: readonly number[] = Object.keys(PEN_INKS)
    .map(Number)
    .sort((a, b) => a - b);

export const DEFAULT_PEN = AVAILABLE_PENS[0];

export const PEN_COLORS: Record<number, string> = Object.fromEntries(
    AVAILABLE_PENS.map((pen) => [pen, PEN_INKS[pen].color])
);

export function penColor(pen: number): string {
    return PEN_COLORS[pen] ?? "#111111";
}

// Drawn under a light ink so the stroke is locatable on white paper.
export const INK_HALO_COLOR = "#bdbdb8";

/**
 * True for an ink that would vanish against the page - white, in practice. Those get a halo in
 * the preview rather than being drawn invisibly: the whole point of the white pen is to see
 * where it went. Rec. 709 luma is more than precise enough to answer this.
 */
export function isLightInk(color: string): boolean {
    const match = /^#([0-9a-f]{6})$/i.exec(color.trim());
    if (!match) return false;
    const value = parseInt(match[1], 16);
    const r = ((value >> 16) & 0xff) / 255;
    const g = ((value >> 8) & 0xff) / 255;
    const b = (value & 0xff) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.75;
}

export function isPenAvailable(pen: unknown): pen is number {
    return typeof pen === "number" && AVAILABLE_PENS.includes(pen);
}

/** Coerces any requested pen onto a working slot. Untrusted input lands here. */
export function resolvePen(pen: unknown): number {
    return isPenAvailable(pen) ? pen : DEFAULT_PEN;
}
