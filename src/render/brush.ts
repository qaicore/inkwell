import { getStroke, type StrokeOptions } from 'perfect-freehand';
import type { Vec2 } from '../types/effect.ts';
import { drawingIndex } from '../motion/timing.ts';
import { applyPose, type Pose } from '../track/tracking.ts';

export type Point = [x: number, y: number, pressure: number];

// The brush settings saved in an effect (SPEC §7). `size` is px at 1080 wide.
export interface Brush {
  size: number;
  thinning: number;
  smoothing: number;
  streamline: number;
}

// The starting brush; Qai locks the look.
export const DEFAULT_BRUSH: Brush = { size: 28, thinning: 0.65, smoothing: 0.6, streamline: 0.45 };
const EASING = (pressure: number) => Math.sin((pressure * Math.PI) / 2);
const START_TAPER = 1.5; // taper lengths, in brush sizes
const END_TAPER = 6;
const SPACING = 1; // px between the centerline points perfect-freehand sees, at scale 1

// ---- Stored strokes ----------------------------------------------------------

// Resamples a drawn stroke to `count` points evenly spaced along its length
// (SPEC §7: the same count in every view, so views match point to point).
// Pressure is interpolated the same way.
export function resampleStroke(raw: Point[], count = 32): { points: Vec2[]; pressure: number[] } {
  if (raw.length === 0) throw new Error('resampleStroke needs at least one point');
  const along = [0];
  for (let i = 1; i < raw.length; i++) along.push(along[i - 1] + Math.hypot(raw[i][0] - raw[i - 1][0], raw[i][1] - raw[i - 1][1]));
  const total = along[along.length - 1];
  const points: Vec2[] = [];
  const pressure: number[] = [];
  let seg = 0;
  for (let j = 0; j < count; j++) {
    const s = count > 1 ? (total * j) / (count - 1) : 0;
    while (seg < raw.length - 2 && along[seg + 1] < s) seg++;
    const a = raw[seg];
    const b = raw[Math.min(seg + 1, raw.length - 1)];
    const span = along[Math.min(seg + 1, raw.length - 1)] - along[seg];
    const w = span > 0 ? Math.min(1, Math.max(0, (s - along[seg]) / span)) : 0;
    points.push([a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w]);
    pressure.push(a[2] + (b[2] - a[2]) * w);
  }
  return { points, pressure };
}

// ---- Outlines ------------------------------------------------------------------

// The filled outline of a centerline, as a polygon. perfect-freehand's
// smoothing and streamline act per input point, so the same curve sent with
// 32 points or with 300 would come out differently. The centerline is
// therefore first redrawn as a smooth curve through its points (centripetal
// Catmull-Rom) at a fixed spacing, and that is what perfect-freehand sees:
// the outline depends on the curve, not on how many points describe it.
// `scale` multiplies the brush size (frame width / 1080).
export function strokeOutline(points: Vec2[], pressure: number[], brush: Brush, scale = 1): Vec2[] {
  const dense = densify(points, pressure, SPACING * scale);
  const size = brush.size * scale;
  let length = 0;
  for (let i = 1; i < dense.length; i++) length += Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]);
  const options: StrokeOptions = {
    size,
    thinning: brush.thinning,
    smoothing: brush.smoothing,
    streamline: brush.streamline,
    easing: EASING,
    simulatePressure: false,
    // Short strokes get shorter tapers, so they don't vanish.
    start: { cap: true, taper: Math.min(size * START_TAPER, length * 0.25) },
    end: { cap: true, taper: Math.min(size * END_TAPER, length * 0.6) },
    last: true,
  };
  return getStroke(dense, options).map((p): Vec2 => [p[0], p[1]]);
}

// The parts of a 2D canvas context that filling an outline uses; the
// browser's canvas and @napi-rs/canvas both have them.
export interface PathTarget {
  fillStyle: unknown;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void;
  closePath(): void;
  fill(): void;
}

// Fills an outline polygon, rounded off with curves through the middle of
// each edge.
export function fillOutline(ctx: PathTarget, outline: Vec2[], color: string) {
  const n = outline.length;
  if (n < 3) return;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo((outline[0][0] + outline[1][0]) / 2, (outline[0][1] + outline[1][1]) / 2);
  for (let i = 1; i <= n; i++) {
    const [x, y] = outline[i % n];
    const [nextX, nextY] = outline[(i + 1) % n];
    ctx.quadraticCurveTo(x, y, (x + nextX) / 2, (y + nextY) / 2);
  }
  ctx.closePath();
  ctx.fill();
}

// Points every `spacing` px along a centripetal Catmull-Rom curve through
// `points`, each with its pressure interpolated. Centripetal (alpha 0.5)
// never loops or overshoots between unevenly spaced points.
function densify(points: Vec2[], pressure: number[], spacing: number): Point[] {
  const n = points.length;
  if (n === 1) return [[points[0][0], points[0][1], pressure[0]]];
  const out: Point[] = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(n - 1, i + 2)];
    const length = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const pieces = Math.max(1, Math.ceil(length / spacing));
    for (let j = 0; j < pieces; j++) {
      const u = j / pieces;
      const [x, y] = catmullRom(p0, p1, p2, p3, u);
      out.push([x, y, pressure[i] + (pressure[i + 1] - pressure[i]) * u]);
    }
  }
  out.push([points[n - 1][0], points[n - 1][1], pressure[n - 1]]);
  return out;
}

// The point `u` (0..1) of the way from p1 to p2 (Barry and Goldman's form).
function catmullRom(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, u: number): Vec2 {
  const knot = (a: Vec2, b: Vec2) => Math.max(Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])), 1e-6);
  const t0 = 0;
  const t1 = t0 + knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const t = t1 + (t2 - t1) * u;
  const mix = (a: Vec2, b: Vec2, ta: number, tb: number): Vec2 => {
    const w = (t - ta) / (tb - ta);
    return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
  };
  const a1 = mix(p0, p1, t0, t1);
  const a2 = mix(p1, p2, t1, t2);
  const a3 = mix(p2, p3, t2, t3);
  const b1 = mix(a1, a2, t0, t2);
  const b2 = mix(a2, a3, t1, t3);
  return mix(b1, b2, t1, t2);
}

// ---- The Oct 27 prototype's live drawing -----------------------------------------
// The app still draws strokes in clip pixels this way until it moves onto
// the engine (strokes in torso space, physics, stepped drawings).

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

const INK: StrokeOptions = { thinning: 0.65, smoothing: 0.6, streamline: 0.45, easing: EASING };

// Hand-drawn wobble: each stroke is redrawn slightly differently 12 times a
// second, like a doodle animation where every drawing is traced again.
const WOBBLE_DPS = 12;

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
  const points = pose ? placePoints(wobbled, stroke.points[0], pose) : wobbled;
  const scale = pose?.scale ?? 1;
  const size = stroke.size * scale;
  const length = strokeLength(stroke.points) * scale;
  const outline = getStroke(points, {
    ...INK,
    size,
    simulatePressure: !stroke.pen,
    start: { cap: true, taper: Math.min(size * START_TAPER, length * 0.25) },
    end: { cap: true, taper: Math.min(size * END_TAPER, length * 0.6) },
    last: done,
  });
  fillOutline(ctx, outline as Vec2[], stroke.color);
}

function placePoints(points: Point[], root: Point, pose: Pose): Point[] {
  return points.map(([x, y, pressure]): Point => {
    const [placedX, placedY] = applyPose(pose, [root[0], root[1]], x, y);
    return [placedX, placedY, pressure];
  });
}

// 30 fps video, 12 wobbles a second: a new wobble every 2 or 3 frames.
export function wobbleTick(frame: number) {
  return drawingIndex(frame, WOBBLE_DPS);
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
