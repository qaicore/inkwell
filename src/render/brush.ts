import { getStroke, type StrokeOptions } from 'perfect-freehand';
import type { Vec2 } from '../types/effect.ts';

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
