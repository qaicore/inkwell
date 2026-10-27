import { getStroke, type StrokeOptions } from 'perfect-freehand';
import { FPS } from '../video/clip';
import { applyPose, type Pose } from '../track/tracking';

export type Point = [x: number, y: number, pressure: number];

// One drawn line, in clip pixels. Its first point is its root, the end that
// gets attached to the body.
export type Stroke = {
  id: number;
  color: string;
  size: number; // brush diameter at full pressure
  frame: number; // the frame it was drawn on
  pen: boolean; // real pen pressure; otherwise pressure comes from speed
  layer: 'front' | 'behind'; // in front of the person, or tucked behind them
  points: Point[];
};

// The brush. perfect-freehand turns the points into one filled outline that
// thins with pressure and tapers at both ends. These are the knobs to tune.
const INK: StrokeOptions = {
  thinning: 0.65, // how much pressure changes the width
  smoothing: 0.6, // how soft the outline's edges are
  streamline: 0.45, // how much a shaky hand is evened out
  easing: (pressure) => Math.sin((pressure * Math.PI) / 2),
};
const START_TAPER = 1.5; // taper lengths, in brush sizes
const END_TAPER = 6;

// Hand-drawn wobble: each stroke is redrawn slightly differently 12 times a
// second, like a doodle animation where every drawing is traced again.
const WOBBLE_FPS = 12;

// `tick` picks the wobble (null draws the stroke exactly as drawn), `pose`
// moves it to where tracking puts its root on this frame (null leaves it where
// it was drawn), and `done` is false while the pen is still down.
export function drawStroke(
  ctx: CanvasRenderingContext2D,
  stroke: Stroke,
  tick: number | null,
  pose: Pose | null = null,
  done = true,
) {
  const wobbled = tick === null ? stroke.points : wobblePoints(stroke, tick);
  // Tracking moves the whole stroke stiffly for now. The rope physics will
  // bend it here: the root pinned to the pose, the rest swinging behind it.
  const points = pose ? placePoints(wobbled, stroke.points[0], pose) : wobbled;
  const scale = pose?.scale ?? 1;
  const size = stroke.size * scale;
  const length = strokeLength(stroke.points) * scale;
  const outline = getStroke(points, {
    ...INK,
    size,
    simulatePressure: !stroke.pen,
    // Short strokes get shorter tapers, so they don't vanish.
    start: { cap: true, taper: Math.min(size * START_TAPER, length * 0.25) },
    end: { cap: true, taper: Math.min(size * END_TAPER, length * 0.6) },
    last: done,
  });
  ctx.fillStyle = stroke.color;
  ctx.fill(outlinePath(outline));
}

function placePoints(points: Point[], root: Point, pose: Pose): Point[] {
  return points.map(([x, y, pressure]): Point => {
    const [placedX, placedY] = applyPose(pose, [root[0], root[1]], x, y);
    return [placedX, placedY, pressure];
  });
}

// 30 fps video, 12 wobbles a second: a new wobble every 2 or 3 frames.
export function wobbleTick(frame: number) {
  return Math.floor((frame * WOBBLE_FPS) / FPS);
}

// Shifts each point by noise that varies smoothly along the stroke, so the
// line bends a little instead of jittering point by point. The same stroke
// and tick always give the same wobble, so preview and export match.
function wobblePoints(stroke: Stroke, tick: number): Point[] {
  const amount = Math.max(1.5, stroke.size * 0.12); // px the line drifts
  const wavelength = Math.max(30, stroke.size * 4); // px of stroke per bump
  const out: Point[] = [];
  let along = 0;
  for (let i = 0; i < stroke.points.length; i++) {
    const [x, y, pressure] = stroke.points[i];
    if (i > 0) along += Math.hypot(x - stroke.points[i - 1][0], y - stroke.points[i - 1][1]);
    const u = along / wavelength;
    out.push([
      x + noise(stroke.id, tick, 0, u) * amount,
      y + noise(stroke.id, tick, 1, u) * amount,
      Math.min(1, Math.max(0, pressure * (1 + noise(stroke.id, tick, 2, u) * 0.1))),
    ]);
  }
  return out;
}

function strokeLength(points: Point[]) {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return length;
}

// perfect-freehand returns the outline as a polygon. Round it off with curves
// through the middle of each edge.
function outlinePath(outline: number[][]) {
  const path = new Path2D();
  const n = outline.length;
  if (n < 3) return path;
  path.moveTo((outline[0][0] + outline[1][0]) / 2, (outline[0][1] + outline[1][1]) / 2);
  for (let i = 1; i <= n; i++) {
    const [x, y] = outline[i % n];
    const [nextX, nextY] = outline[(i + 1) % n];
    path.quadraticCurveTo(x, y, (x + nextX) / 2, (y + nextY) / 2);
  }
  path.closePath();
  return path;
}

// Smooth 1D noise in -1..1: random values at whole-number steps of `u`,
// eased between. `seed`, `tick` and `channel` pick an independent curve.
function noise(seed: number, tick: number, channel: number, u: number) {
  const i = Math.floor(u);
  const f = u - i;
  const a = hash(seed, tick, channel, i);
  const b = hash(seed, tick, channel, i + 1);
  return a + (b - a) * f * f * (3 - 2 * f);
}

// Four integers in, one repeatable random number in -1..1 out.
function hash(a: number, b: number, c: number, d: number) {
  let h = Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca77) ^ Math.imul(c, 0xc2b2ae3d) ^ Math.imul(d, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}
