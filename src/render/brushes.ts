// The six brushes (SPEC §8.8). Every brush is a perfect-freehand outline of
// the same simulated centerline; they differ only in their settings and in
// how the outline is filled:
//   - ink, fine-ink: the outline filled solid, straight onto the target.
//   - textured, fine-textured: the outline drawn white into a scratch buffer
//     the size of the stroke, grain cut out of its alpha, tinted to the
//     stroke's color, then laid on the target. The grain is value noise read
//     in the stroke's own coordinates (distance along the centerline, distance
//     across it), seeded by the stroke id, so it rides the line as the physics
//     bends it instead of sliding over it.
//   - neon-straight, neon-round: a lit tube. A glow worked out once per stroke
//     at quarter resolution from each pixel's distance to the centerline, laid
//     down twice: a normal blend, so it still reads on light footage, then
//     added ('lighter'), so it blazes on dark. On top, nested outlines: a thin
//     deep-colored edge (keeps the line readable on light footage), the full
//     brush color, and a hot near-white core along the center. The glow's
//     intensity flickers per drawing, seeded by stroke id and drawing index k,
//     so it changes on 2s and re-renders identically.
// The same code draws in Node (@napi-rs/canvas) and in the browser; the
// caller passes a way to make scratch canvases, and they're reused.
import type { BrushId, BrushSettings, Effect, Vec2 } from '../types/effect.ts';
import { fillOutline, strokeOutline, type Ends, type PathTarget } from './brush.ts';

export { BRUSH_IDS } from '../types/effect.ts';

// SPEC §8.7 starting values; Qai tunes them.
export const FINE_TIP_SIZE = 0.35; // × the ink brush's size
export const FINE_TIP_THINNING = 0.85; // ink's is 0.65: the line gets fine at fast strokes
export const GRAIN = 0.35;
export const NEON_GLOW = { radiusPx: 12, intensity: 0.8 }; // at 1080 wide
export const NEON_CORE_SIZE = 0.5; // × the ink brush's size
// The tube, from the outside in: [size × the brush's, mix toward white];
// a negative mix darkens toward black.
// Small steps from color to white, so the core fades in rather than banding.
const NEON_TUBE: [number, number][] = [
  [1.0, -0.35], // the edge
  [0.82, 0], // the brush color
  [0.66, 0.25],
  [0.52, 0.5],
  [0.4, 0.72],
  [0.29, 0.88],
  [0.19, 0.97], // the hot core
];
const GLOW_REACH = 1.7; // the glow fades to nothing at 1.7 × its radius (B2 allows 2 ×)
const GLOW_HALO = 0.6; // of the glow's strength in the wide halo; the rest hugs the line
const GLOW_GAIN = 1.6; // how lit the glow is at full intensity, clipped at opaque
const GLOW_OVER = 0.5; // opacity of the normal-blend pass, for light footage
const FLICKER = 0.25; // the glow's intensity drops by up to a quarter on a drawing
const GRAIN_CELLS_PER_SIZE = 6; // grain cells across the brush: finer than 1/5 reads as texture, not dirt
const GRAIN_CONTRAST = 1.2;

// The settings a brush resolves to: the effect's own (effect.brushes) when it
// has them, otherwise the §8.8 defaults built from the ink brush.
export function brushSettings(effect: Pick<Effect, 'brush' | 'brushes'>, id: BrushId): BrushSettings {
  const ink = effect.brush;
  if (id === 'ink') return ink;
  const fine: BrushSettings = { ...ink, size: FINE_TIP_SIZE * ink.size, thinning: FINE_TIP_THINNING };
  const neon: BrushSettings = { ...ink, size: NEON_CORE_SIZE * ink.size, glow: { ...NEON_GLOW } };
  const defaults: Record<Exclude<BrushId, 'ink'>, BrushSettings> = {
    textured: { ...ink, grain: GRAIN },
    'fine-ink': fine,
    'fine-textured': { ...fine, grain: GRAIN },
    'neon-straight': { ...neon, thinning: 0 }, // even width
    'neon-round': neon,
  };
  return { ...defaults[id], ...effect.brushes?.[id] };
}

// Flat ends for the straight neon tip; every other brush tapers to round ends
// ("straight vs round" read as the end shape, §8.8).
export const endsOf = (id: BrushId): Ends => (id === 'neon-straight' ? 'flat' : 'taper');

// ---- Canvas plumbing -------------------------------------------------------------

// The parts of a 2D context the brushes use; the browser's canvas and
// @napi-rs/canvas both have them.
export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}
export interface BrushTarget extends PathTarget {
  globalCompositeOperation: string;
  globalAlpha: number;
  imageSmoothingEnabled: boolean;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  getImageData(x: number, y: number, w: number, h: number): Pixels;
  putImageData(image: Pixels, x: number, y: number): void;
  drawImage(image: never, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void;
}
export interface Scratch {
  canvas: { width: number; height: number };
  ctx: BrushTarget;
}
export type MakeScratch = (width: number, height: number) => Scratch;

// Two scratch buffers per canvas maker (one for grain, one for glow), grown
// when a stroke needs more room and otherwise reused: no new buffer per
// stroke or per frame, which matters on a phone.
const pools = new WeakMap<MakeScratch, Scratch[]>();
function scratch(make: MakeScratch, slot: 0 | 1, width: number, height: number): Scratch {
  let pool = pools.get(make);
  if (!pool) pools.set(make, (pool = []));
  let s = pool[slot];
  if (!s || s.canvas.width < width || s.canvas.height < height) {
    s = make(Math.max(width, s?.canvas.width ?? 0), Math.max(height, s?.canvas.height ?? 0));
    pool[slot] = s;
  }
  s.ctx.setTransform(1, 0, 0, 1, 0, 0);
  s.ctx.globalCompositeOperation = 'source-over';
  // All of it, not just the stroke's box: smoothed upscaling samples a pixel
  // past the box's edge, and that pixel must not hold the last stroke.
  s.ctx.clearRect(0, 0, s.canvas.width, s.canvas.height);
  return s;
}

// ---- Drawing ----------------------------------------------------------------------

export interface BrushStroke {
  id: number; // seeds the grain and the flicker
  points: Vec2[]; // the placed centerline, target px
  pressure: number[];
  color: string; // '#rrggbb'
  brush: BrushId;
  settings: BrushSettings; // from brushSettings, at 1080 wide
  scale: number; // target width / 1080
  k: number; // drawing index
}

export function drawBrushStroke(ctx: BrushTarget, make: MakeScratch, s: BrushStroke) {
  const outline = strokeOutline(s.points, s.pressure, s.settings, s.scale, endsOf(s.brush));
  if (s.settings.glow) {
    drawGlow(ctx, make, s);
    for (const [size, white] of NEON_TUBE) {
      const ring = strokeOutline(s.points, s.pressure, { ...s.settings, size: s.settings.size * size }, s.scale, endsOf(s.brush));
      fillOutline(ctx, ring, white < 0 ? mixBlack(s.color, -white) : mixWhite(s.color, white));
    }
  } else if (s.settings.grain) {
    drawGrained(ctx, make, outline, s);
  } else {
    fillOutline(ctx, outline, s.color);
  }
}

function drawGrained(ctx: BrushTarget, make: MakeScratch, outline: Vec2[], s: BrushStroke) {
  const box = bounds(outline, 1);
  if (!box) return;
  const { x0, y0, w, h } = box;
  const buf = scratch(make, 0, w, h);
  buf.ctx.setTransform(1, 0, 0, 1, -x0, -y0);
  fillOutline(buf.ctx, outline, '#ffffff');
  buf.ctx.setTransform(1, 0, 0, 1, 0, 0);
  const img = buf.ctx.getImageData(0, 0, w, h);
  const line = new Centerline(s.points);
  const cell = Math.max(1, (s.settings.size * s.scale) / GRAIN_CELLS_PER_SIZE);
  const amount = s.settings.grain ?? 0;
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4 + 3;
      if (d[i] === 0) continue;
      const [along, across] = line.coords(x0 + x + 0.5, y0 + y + 0.5);
      const n = grainNoise(along / cell, across / cell, s.id);
      const removed = Math.min(1, Math.max(0, amount + (n - 0.5) * GRAIN_CONTRAST));
      d[i] = Math.round(d[i] * (1 - removed));
    }
  }
  buf.ctx.putImageData(img, 0, 0);
  buf.ctx.globalCompositeOperation = 'source-in';
  buf.ctx.fillStyle = s.color;
  buf.ctx.fillRect(0, 0, w, h);
  buf.ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(buf.canvas as never, 0, 0, w, h, x0, y0, w, h);
}

// Bayer 4×4 thresholds: a little ordered dither, so the glow's soft falloff
// doesn't band in 8 bits.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16 - 0.5);

function drawGlow(ctx: BrushTarget, make: MakeScratch, s: BrushStroke) {
  const glow = s.settings.glow!;
  const radius = glow.radiusPx * s.scale;
  if (!(radius > 0)) return;
  const reach = GLOW_REACH * radius;
  // Quarter resolution at full size; a smaller step for a small glow, so
  // upscaling never carries it past 2 × its radius.
  const q = Math.max(1, Math.min(4, Math.floor(radius / 3)));
  const box = bounds(s.points, reach + 2 * q);
  if (!box) return;
  const x0 = Math.floor(box.x0 / q) * q;
  const y0 = Math.floor(box.y0 / q) * q;
  const w = Math.ceil((box.x0 + box.w - x0) / q);
  const h = Math.ceil((box.y0 + box.h - y0) / q);
  const buf = scratch(make, 1, w, h);
  const img = buf.ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const [r, g, b] = rgb(s.color);
  const intensity = glow.intensity * (1 - FLICKER * hash01(s.id, s.k, 0x9e37));
  const line = new Centerline(s.points);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dist = line.distance(x0 + (x + 0.5) * q, y0 + (y + 0.5) * q);
      if (dist >= reach) continue;
      // A wide halo plus a tight bloom: lit up along the line, soft far out.
      const u = dist / reach;
      const near = Math.max(0, 1 - u / 0.4);
      const falloff = GLOW_HALO * (1 - u) ** 1.5 + (1 - GLOW_HALO) * near * near;
      const a = Math.round(255 * GLOW_GAIN * intensity * falloff + BAYER[(y & 3) * 4 + (x & 3)]);
      if (a <= 0) continue;
      const i = (y * w + x) * 4;
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = Math.min(255, a);
    }
  }
  buf.ctx.putImageData(img, 0, 0);
  const op = ctx.globalCompositeOperation;
  const smooth = ctx.imageSmoothingEnabled;
  const alpha = ctx.globalAlpha;
  ctx.imageSmoothingEnabled = true;
  ctx.globalAlpha = alpha * GLOW_OVER;
  ctx.drawImage(buf.canvas as never, 0, 0, w, h, x0, y0, w * q, h * q);
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = 'lighter';
  ctx.drawImage(buf.canvas as never, 0, 0, w, h, x0, y0, w * q, h * q);
  ctx.globalCompositeOperation = op;
  ctx.imageSmoothingEnabled = smooth;
}

// ---- Geometry and noise ------------------------------------------------------------

// A polyline that answers, for any point, how far along it and how far to
// the side of it that point is (signed: + is to the right of travel).
class Centerline {
  private readonly pts: Vec2[];
  private readonly along: number[];
  constructor(pts: Vec2[]) {
    this.pts = pts;
    this.along = [0];
    for (let i = 1; i < pts.length; i++) this.along.push(this.along[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  private nearest(x: number, y: number): { d2: number; seg: number; t: number } {
    const p = this.pts;
    let best = { d2: Infinity, seg: 0, t: 0 };
    if (p.length === 1) return { d2: (x - p[0][0]) ** 2 + (y - p[0][1]) ** 2, seg: 0, t: 0 };
    for (let i = 1; i < p.length; i++) {
      const ax = p[i - 1][0];
      const ay = p[i - 1][1];
      const dx = p[i][0] - ax;
      const dy = p[i][1] - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
      const ex = x - (ax + dx * t);
      const ey = y - (ay + dy * t);
      const d2 = ex * ex + ey * ey;
      if (d2 < best.d2) best = { d2, seg: i, t };
    }
    return best;
  }
  distance(x: number, y: number): number {
    return Math.sqrt(this.nearest(x, y).d2);
  }
  coords(x: number, y: number): Vec2 {
    const p = this.pts;
    if (p.length === 1) return [0, Math.hypot(x - p[0][0], y - p[0][1])];
    const { d2, seg, t } = this.nearest(x, y);
    const a = p[seg - 1];
    const b = p[seg];
    const len = this.along[seg] - this.along[seg - 1];
    const side = len > 0 ? Math.sign((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) : 1;
    return [this.along[seg - 1] + len * t, side * Math.sqrt(d2)];
  }
}

// Two octaves of value noise, 0..1, from a hash of the lattice and the seed:
// no image file and no Math.random, so it repeats exactly.
function grainNoise(u: number, v: number, seed: number): number {
  return 0.65 * valueNoise(u, v, seed) + 0.35 * valueNoise(u * 2.3 + 17.1, v * 2.3 - 5.3, seed + 7919);
}

function valueNoise(u: number, v: number, seed: number): number {
  const iu = Math.floor(u);
  const iv = Math.floor(v);
  const fu = u - iu;
  const fv = v - iv;
  const su = fu * fu * (3 - 2 * fu);
  const sv = fv * fv * (3 - 2 * fv);
  const a = hash01(iu, iv, seed);
  const b = hash01(iu + 1, iv, seed);
  const c = hash01(iu, iv + 1, seed);
  const d = hash01(iu + 1, iv + 1, seed);
  return a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
}

// An integer hash (murmur3's finalizer) of three numbers, as 0..1.
function hash01(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function bounds(pts: Vec2[], pad: number): { x0: number; y0: number; w: number; h: number } | null {
  if (pts.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  const bx = Math.floor(x0 - pad);
  const by = Math.floor(y0 - pad);
  const w = Math.ceil(x1 + pad) - bx + 1;
  const h = Math.ceil(y1 + pad) - by + 1;
  if (!(w > 0 && h > 0) || w * h > 4096 * 4096) return null;
  return { x0: bx, y0: by, w, h };
}

function rgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const hex = ([r, g, b]: number[]) => `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;

function mixWhite(color: string, w: number): string {
  return hex(rgb(color).map((c) => Math.round(c + (255 - c) * w)));
}

function mixBlack(color: string, k: number): string {
  return hex(rgb(color).map((c) => Math.round(c * (1 - k))));
}
