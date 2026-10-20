export interface InitOptions {
    unitsPerMM?: number; // plotter units per MM
    defaultPen?: number; // selected Pen
    maxPointsPerCommand?: number; // coordinate pairs packed into one PA. 1 = safest.
}
export type Point = {
    x: number;
    y: number;
}
export type Segment = {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    pen: number;
}
export type Triangle = [
    Point, Point, Point
]


