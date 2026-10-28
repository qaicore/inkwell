/// <reference types="node" />
// B2 (SPEC §10, brushes): each brush does its job: grain fixed to the stroke; neon and electric glow stay near their
// line; electric changes shape on drawings and keeps its root; fine tip thinner than ink. Thresholds: grain pixels move
// with the stroke (within 0.5 px under a pure translation); no glow pixel farther than 2 × glow.radiusPx from the
// centerline (for electric, 2 × glow.radiusPx + bolt.ampPx + the farthest shard); electric's pixels differ between
// consecutive drawings and its root sits within 1 px of the drawn root; blade's cast shadow no farther than 16 px from
// its outline; trail's sparkles within 1.6 × its width of the centerline, and its core never white (no pixel with all
// channels >= 250); fine-ink's widest point <= 0.5 × ink's on the same stroke (start).
//
// Measured on pixels from the real renderer, src/render/headless.ts renderPng(width, height, strokes, effect, scale,
// k), decoded with @napi-rs/canvas; the settings each brush resolves to come from src/render/brushes.ts
// brushSettings(effect, id). Strokes are seeded tendrils placed directly in px on a 1080 x 1080 canvas (scale 1).
//   - Grain: grain(x) = alpha(base brush) - alpha(textured brush), same stroke (textured's outline is ink's,
//     fine-textured's is fine-ink's, §8.8). The stroke is rendered again translated by T; the grain's own shift is
//     found by zero-mean cross-correlation of the two grain maps over the stroke's interior, searched over every
//     integer shift from 0 to T and 5 px around (so a grain that stays put on the screen peaks at 0), refined with a
//     parabola. |found - T| <= 0.5 px for T = (40, 25) and (-17, 33).
//   - Glow: every pixel with alpha > 0 in a neon render is within 2 × glow.radiusPx of the stroke's centerline (the
//     placed points' polyline); at the default settings and with effect.brushes setting a radius twice as large.
//   - Fine tip: the widest point of each render (2 × the largest distance from an inked pixel, alpha >= 128, to the
//     nearest un-inked one, minus 1) for fine-ink vs ink on the same three strokes; the worst ratio counts.
//   - Electric (every drawing k = 0..11 of one placed stroke, so any change comes from the brush, not the boil):
//     "glow-off" renders use effect.brushes electric with glow intensity 0, so only the bolt and its shards are left.
//     Ink = alpha > 0. The bolt is the largest 8-connected ink component of the glow-off render; every other
//     component is a shard. Farthest shard = the largest distance of any shard pixel from the drawn centerline (0 when
//     there are none). Glow: every pixel with alpha > 0 in the full render of the same k lies within
//     2 × glow.radiusPx + bolt.ampPx + farthest shard of the centerline; at the defaults and with a radius twice as
//     large. Changes: consecutive drawings' PNGs differ, and so do their glow-off ink shapes (alpha >= 128).
//     Root: the alpha-weighted centroid of the bolt's pixels whose arc-length projection on the drawn centerline is
//     within 0.5 px of the bolt's smallest one, i.e. the bolt's root end; it must lie within 1 px of points[0].
//   - Blade (k = 0..3), glow off as above, so every ink pixel is the blade or its shadow: the blade's outline is its
//     pixels with alpha >= 0.5 (the shadow is 3 layers at 10-14% opacity, §8.7, so it stays below that); every other
//     ink pixel must lie within 16 px of an outline pixel (exact Euclidean distance transform).
//   - Trail (k = 0..3), glow off: the trail is the largest ink component, every other component is a sparkle. Its
//     width = the widest point of that component (2 × the largest distance from an ink pixel to the nearest non-ink
//     one, minus 1). Every sparkle pixel lies within 1.6 × that width of the drawn centerline. White: with the default
//     glow, in each palette color, no pixel of the render composited over black has all three channels >= 250, and
//     no pixel with alpha >= 64 has an un-premultiplied color with all three channels >= 250 (a see-through white core
//     still reads white on light footage).
// SPEC §8.7 pins, read from docs/SPEC.md at runtime: the defaults an effect without `brushes` resolves to must be
// fine-tip size = 0.35 × the ink brush's size (fine-ink and fine-textured), grain 0.35 (textured, fine-textured),
// neon glow radius 12 px, intensity 0.8 (both neon brushes), electric bloom radius 26 px, intensity 0.55 and bolt
// bendPx 38, ampPx 18, elbows 0.55, shards 5, blade glow 14 px / 0.3, trail glow 16 px / 0.4, so the glow and bolt
// thresholds are SPEC's, not the code's.
// Preconditions: grain removes some but not all of the fill; the neon brushes actually glow past their core; electric
// glows past its bolt and never shows more shards than bolt.shards in a drawing (so the shard allowance can't be
// inflated by stray specks); blade casts a shadow; trail sheds at least one sparkle over the drawings tested.
// Stricter readings / open points, flagged for Qai:
//   - a sub-pixel translation (12.5, -7.25) is measured and reported but not gated (pixel grids make sub-pixel grain
//     shifts hard to measure exactly);
//   - "glow pixel" is any pixel the neon or electric render touches at all (alpha > 0), core included;
//   - "the farthest shard" is read as that shard's farthest pixel from the centerline; a bolt that pinches to nothing
//     mid-way splits into pieces that count as shards, and more than bolt.shards of them fails the precondition;
//   - electric "changes shape" is also checked with the glow off, so the glow's flicker alone can't pass it;
//   - blade and trail are measured with glow intensity 0 (a valid effect.brushes setting) so the glow can't be
//     mistaken for shadow or sparkles; shards and sparkles are assumed not to depend on the glow's intensity;
//   - trail's "width" is its measured widest point, not settings.size; "core never white" is checked on every pixel.
import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { Effect, Stroke } from '../../src/types/effect.ts';
import { Evidence, ROOT, readText } from '../helpers/evidence.ts';
import { errMsg, need, projectOnPolyline, recorded, segDist, tendril, torsoToPx, type V2 } from '../helpers/engine.ts';

type HeadlessModule = typeof import('../../src/render/headless.ts');
type BrushesModule = typeof import('../../src/render/brushes.ts');
type Placed = Parameters<HeadlessModule['renderPng']>[2][number];

const ID = 'B2';
const W = 1080;
const H = 1080;
const GRAIN_TOL = 0.5; // px (SPEC §10 B2)
const GLOW_FACTOR = 2; // × glow.radiusPx
const FINE_RATIO = 0.5; // fine-ink widest <= 0.5 × ink widest (start)
const SHIFTS: V2[] = [[40, 25], [-17, 33]];
const SUBPIXEL: V2 = [12.5, -7.25];
const INK = { size: 28, thinning: 0.65, smoothing: 0.6, streamline: 0.45 };
const ROOT_TOL = 1; // px: electric's root within 1 px of the drawn root (SPEC §10 B2)
const ROOT_WINDOW = 0.5; // px of arc length that make up the bolt's root end (measurement, not a threshold)
const SHADOW_MAX = 16; // px: blade's cast shadow from its outline (SPEC §10 B2)
const SPARKLE_FACTOR = 1.6; // × trail's width (SPEC §10 B2)
const WHITE = 250; // all channels >= 250 is white (SPEC §10 B2)
const ELECTRIC_KS = Array.from({ length: 12 }, (_, k) => k);
const SHADED_KS = [0, 1, 2, 3];

const ev = new Evidence(ID, [
  'modules load',
  'SPEC §8.7 defaults',
  'precondition: grain removes part of the fill',
  'textured: grain moves with the stroke',
  'fine-textured: grain moves with the stroke',
  'grain under a sub-pixel translation (report)',
  'precondition: neon glows past its core',
  'neon-straight: glow within 2 × radius (default)',
  'neon-round: glow within 2 × radius (default)',
  'neon glow within 2 × radius (custom radius)',
  'precondition: electric glows past its bolt',
  'precondition: electric shows at most bolt.shards shards per drawing',
  'electric: glow within 2 × radius + ampPx + farthest shard (default)',
  'electric: glow within 2 × radius + ampPx + farthest shard (custom radius)',
  'electric: pixels differ between consecutive drawings',
  'electric: shape differs between consecutive drawings (glow off)',
  'electric: root within 1 px of the drawn root',
  'precondition: blade casts a shadow',
  'blade: cast shadow within 16 px of its outline',
  'precondition: trail sheds sparkles',
  'trail: sparkles within 1.6 × its width of the centerline',
  'trail: never white (no pixel with all channels >= 250)',
  "fine-ink's widest point <= 0.5 × ink's",
]);
afterAll(() => ev.write());

// ---------- SPEC §8.7 ----------

interface Spec87 {
  fineFactor: number;
  grain: number;
  glowRadius: number;
  glowIntensity: number;
  electric: { glow: { radiusPx: number; intensity: number }; bolt: { bendPx: number; ampPx: number; elbows: number; shards: number } };
  blade: { glow: { radiusPx: number; intensity: number } };
  trail: { glow: { radiusPx: number; intensity: number } };
}

function spec87(): Spec87 {
  const spec = readText(join(ROOT, 'docs', 'SPEC.md'));
  const start = spec.indexOf('### 8.7');
  if (start < 0) throw new Error('docs/SPEC.md has no "### 8.7" parameter table');
  const end = spec.indexOf('\n### ', start + 5);
  const sec = spec.slice(start, end < 0 ? undefined : end);
  const cell = (row: string) => {
    const m = sec.match(new RegExp(`^\\|\\s*${row}[^|]*\\|([^|\\n]+)\\|`, 'mi'));
    if (!m) throw new Error(`docs/SPEC.md §8.7 has no "${row}" row`);
    return m[1]!.trim();
  };
  const fine = cell('fine-tip size').match(/^(\d+(?:\.\d+)?)\s*×/);
  const grain = cell('grain').match(/^(\d+(?:\.\d+)?)/);
  const glow = cell('neon glow').match(/radius\s+(\d+(?:\.\d+)?)\s*px,\s*intensity\s+(\d+(?:\.\d+)?)/);
  if (!fine || !grain || !glow) throw new Error('docs/SPEC.md §8.7 fine-tip size, grain or neon glow row is not in the expected form');
  // The new rows by their exact names ("electric" must not match "electric bursts").
  const exact = (row: string) => {
    const m = sec.match(new RegExp(`^\\|\\s*${row}\\s*\\|([^|\\n]+)\\|`, 'mi'));
    if (!m) throw new Error(`docs/SPEC.md §8.7 has no "${row}" row`);
    return m[1]!.trim();
  };
  const N = '(\\d+(?:\\.\\d+)?)';
  const read = (row: string, text: string, re: string, what: string) => {
    const m = text.match(new RegExp(re, 'i'));
    if (!m) throw new Error(`docs/SPEC.md §8.7 "${row}" row has no ${what} in the expected form: "${text}"`);
    return Number(m[1]);
  };
  const glowOf = (row: string, text: string, label: string) => {
    const m = text.match(new RegExp(`${label}\\s+radius\\s+${N}\\s*px,\\s*intensity\\s+${N}`, 'i'));
    if (!m) throw new Error(`docs/SPEC.md §8.7 "${row}" row has no "${label} radius <n> px, intensity <n>": "${text}"`);
    return { radiusPx: Number(m[1]), intensity: Number(m[2]) };
  };
  const el = exact('electric');
  const bl = exact('blade');
  const tr = exact('trail');
  return {
    fineFactor: Number(fine[1]),
    grain: Number(grain[1]),
    glowRadius: Number(glow[1]),
    glowIntensity: Number(glow[2]),
    electric: {
      glow: glowOf('electric', el, 'bloom'),
      bolt: {
        bendPx: read('electric', el, `bends every\\s+${N}\\s*px`, 'bend spacing ("bends every <n> px")'),
        ampPx: read('electric', el, `up to\\s+${N}\\s*px sideways`, 'sideways reach ("up to <n> px sideways")'),
        elbows: read('electric', el, `${N}\\s*% of them sharp elbows`, 'elbow share ("<n>% of them sharp elbows")') / 100,
        shards: read('electric', el, `up to\\s+${N}\\s+shards`, 'shard count ("up to <n> shards")'),
      },
    },
    blade: { glow: glowOf('blade', bl, 'glow') },
    trail: { glow: glowOf('trail', tr, 'glow') },
  };
}

// ---------- input ----------

function effectWith(brush: string, extra: Partial<Effect> = {}, color: 0 | 1 | 2 = 1): Effect {
  const points = tendril(1);
  const s: Stroke = {
    id: 7,
    color,
    kind: 'strand',
    anchor: { type: 'concept', prompt: 'person' },
    bodyAngle: 0,
    stiffness: 1,
    wobble: 0,
    views: { front: { points, pressure: points.map(() => 0.6), root: points[0]!, layer: 'front' } },
  };
  (s as Stroke & { brush?: string }).brush = brush;
  return { version: 1, brush: { ...INK }, palette: ['#1b1b1f', '#c8323c', '#3fd0ff'], timing: { drawingsPerSecond: 12 }, strokes: [s], overrides: {}, ...extra };
}

function placedStroke(seed: number, offset: V2 = [0, 0]): Placed {
  const pts = tendril(seed, 32, 0.8);
  const pose = { x: 540 + offset[0], y: 520 + offset[1], angle: 0, unit: 420 };
  return {
    id: 7,
    points: pts.map((p) => torsoToPx(pose, p)),
    pressure: pts.map((_, i) => 0.35 + 0.6 * Math.sin((Math.PI * i) / (pts.length - 1))),
    layer: 'front',
  } as Placed;
}

// ---------- pixels ----------

let head: HeadlessModule;
/** The PNG renderPng gives for one stroke at drawing k, and its decoded straight (un-premultiplied) RGBA. */
async function renderOf(effect: Effect, stroke: Placed, k: number): Promise<{ png: Buffer; rgba: Uint8ClampedArray }> {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const png = Buffer.from(head.renderPng(W, H, [stroke], effect, 1, k));
  const img = await loadImage(png);
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return { png, rgba: ctx.getImageData(0, 0, W, H).data };
}

async function alphaOf(effect: Effect, stroke: Placed): Promise<Float32Array> {
  const d = (await renderOf(effect, stroke, 0)).rgba;
  const a = new Float32Array(W * H);
  for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3]! / 255;
  return a;
}

/** Grain map: how much of the base brush's fill the textured brush removed, per pixel. */
const grainMap = (base: Float32Array, tex: Float32Array) => base.map((v, i) => Math.max(0, v - tex[i]!));

/** Pixels fully inside the base outline, one pixel in from its edge. */
function interior(base: Float32Array): number[] {
  const out: number[] = [];
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    if (base[i]! >= 0.98 && base[i - 1]! >= 0.98 && base[i + 1]! >= 0.98 && base[i - W]! >= 0.98 && base[i + W]! >= 0.98) out.push(i);
  }
  return out;
}

/** Shift d of map B relative to map A (B(x + d) ≈ A(x)) by zero-mean cross-correlation over A's interior. */
function grainShift(gA: Float32Array, inA: number[], gB: Float32Array, inB: Set<number>, expect: V2): { d: V2; peak: number } {
  const meanA = inA.reduce((s, i) => s + gA[i]!, 0) / inA.length;
  let sumB = 0;
  for (const i of inB) sumB += gB[i]!;
  const meanB = sumB / inB.size;
  const rB = (i: number) => (inB.has(i) ? gB[i]! - meanB : 0);
  const lo: V2 = [Math.min(0, expect[0]) - 5, Math.min(0, expect[1]) - 5];
  const hi: V2 = [Math.max(0, expect[0]) + 5, Math.max(0, expect[1]) + 5];
  const C = new Map<string, number>();
  let best = { dx: 0, dy: 0, c: -Infinity };
  for (let dy = Math.floor(lo[1]); dy <= Math.ceil(hi[1]); dy++) for (let dx = Math.floor(lo[0]); dx <= Math.ceil(hi[0]); dx++) {
    let c = 0;
    for (const i of inA) {
      const x = (i % W) + dx;
      const y = Math.floor(i / W) + dy;
      if (x < 0 || x >= W || y < 0 || y >= H) continue;
      c += (gA[i]! - meanA) * rB(y * W + x);
    }
    C.set(`${dx},${dy}`, c);
    if (c > best.c) best = { dx, dy, c };
  }
  const at = (dx: number, dy: number) => C.get(`${dx},${dy}`);
  const refine = (m: number | undefined, z: number, p: number | undefined) => {
    if (m === undefined || p === undefined) return 0;
    const den = m - 2 * z + p;
    return den < 0 ? (0.5 * (m - p)) / den : 0;
  };
  const fx = refine(at(best.dx - 1, best.dy), best.c, at(best.dx + 1, best.dy));
  const fy = refine(at(best.dx, best.dy - 1), best.c, at(best.dx, best.dy + 1));
  return { d: [best.dx + fx, best.dy + fy], peak: best.c };
}

function distToLine(p: V2, pts: V2[]): number {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) best = Math.min(best, segDist(p, pts[i - 1]!, pts[i]!).d);
  return best;
}

/** Widest point: 2 × max distance (inked pixel to nearest un-inked pixel centre) - 1, via an exact distance transform. */
function widest(alpha: Float32Array): number {
  return widestOf((i) => alpha[i]! >= 0.5);
}

/** widest() for any set of inked pixels. */
function widestOf(isInked: (i: number) => boolean): number {
  let x0 = W;
  let x1 = -1;
  let y0 = H;
  let y1 = -1;
  for (let i = 0; i < W * H; i++) if (isInked(i)) {
    const x = i % W;
    const y = Math.floor(i / W);
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (x1 < 0) return 0;
  x0 -= 2; y0 -= 2; x1 += 2; y1 += 2;
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const INF = 1e20;
  const f = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const gx = x + x0;
    const gy = y + y0;
    const inked = gx >= 0 && gx < W && gy >= 0 && gy < H && isInked(gy * W + gx);
    f[y * w + x] = inked ? INF : 0;
  }
  const dt1 = (get: (i: number) => number, set: (i: number, v: number) => void, n: number) => {
    const v = new Int32Array(n);
    const z = new Float64Array(n + 1);
    const d = new Float64Array(n);
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = (get(q) + q * q - (get(v[k]!) + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      while (s <= z[k]!) {
        k--;
        s = (get(q) + q * q - (get(v[k]!) + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1]! < q) k++;
      d[q] = (q - v[k]!) * (q - v[k]!) + get(v[k]!);
    }
    for (let q = 0; q < n; q++) set(q, d[q]!);
  };
  for (let x = 0; x < w; x++) dt1((i) => f[i * w + x]!, (i, val) => (f[i * w + x] = val), h);
  for (let y = 0; y < h; y++) dt1((i) => f[y * w + i]!, (i, val) => (f[y * w + i] = val), w);
  let max = 0;
  for (let i = 0; i < f.length; i++) if (f[i]! < INF / 2 && f[i]! > max) max = f[i]!;
  return 2 * Math.sqrt(max) - 1;
}

/** Exact squared Euclidean distance from every pixel centre to the nearest source pixel centre (Felzenszwalb). */
function sqDistTo(source: Uint8Array, w: number, h: number): Float64Array {
  const INF = 1e20;
  const f = new Float64Array(w * h);
  for (let i = 0; i < f.length; i++) f[i] = source[i] ? 0 : INF;
  const n = Math.max(w, h);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const g = new Float64Array(n);
  const d = new Float64Array(n);
  const pass = (len: number, at: (q: number) => number) => {
    for (let q = 0; q < len; q++) g[q] = f[at(q)]!;
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = (g[q]! + q * q - (g[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      while (s <= z[k]!) {
        k--;
        s = (g[q]! + q * q - (g[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1]! < q) k++;
      d[q] = (q - v[k]!) * (q - v[k]!) + g[v[k]!]!;
    }
    for (let q = 0; q < len; q++) f[at(q)] = d[q]!;
  };
  for (let x = 0; x < w; x++) pass(h, (q) => q * w + x);
  for (let y = 0; y < h; y++) pass(w, (q) => y * w + q);
  return f;
}

/** 8-connected components of the inked pixels: a label per pixel (-1 = not inked) and each component's size. */
function components(ink: Uint8Array): { label: Int32Array; sizes: number[] } {
  const label = new Int32Array(W * H).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let i = 0; i < ink.length; i++) {
    if (!ink[i] || label[i] !== -1) continue;
    const id = sizes.length;
    let n = 0;
    label[i] = id;
    stack.push(i);
    while (stack.length) {
      const j = stack.pop()!;
      n++;
      const x = j % W;
      const y = (j - x) / W;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const m = ny * W + nx;
        if (ink[m] && label[m] === -1) {
          label[m] = id;
          stack.push(m);
        }
      }
    }
    sizes.push(n);
  }
  return { label, sizes };
}

/** The largest component (the stroke itself) and the rest (shards, sparkles) of an RGBA render's ink (alpha > 0). */
function splitInk(rgba: Uint8ClampedArray): { main: number[]; others: number[][]; count: number } {
  const ink = new Uint8Array(W * H);
  for (let i = 0; i < ink.length; i++) ink[i] = rgba[i * 4 + 3]! > 0 ? 1 : 0;
  const { label, sizes } = components(ink);
  let big = -1;
  for (let c = 0; c < sizes.length; c++) if (big < 0 || sizes[c]! > sizes[big]!) big = c;
  const groups: number[][] = sizes.map(() => []);
  for (let i = 0; i < label.length; i++) if (label[i]! >= 0) groups[label[i]!]!.push(i);
  return { main: big >= 0 ? groups[big]! : [], others: groups.filter((_, c) => c !== big), count: sizes.length };
}

const centre = (i: number): V2 => [(i % W) + 0.5, Math.floor(i / W) + 0.5];

/** The same settings with the glow switched off (intensity 0), so only the stroke's own pixels are left. */
function glowOff(brushes: BrushesModule, id: string, over: Partial<{ radiusPx: number }> = {}): Effect {
  const base = brushes.brushSettings(effectWith(id), id as never) as { glow?: { radiusPx: number; intensity: number } };
  const settings = { ...base, glow: { radiusPx: over.radiusPx ?? base.glow?.radiusPx ?? 0, intensity: 0 } };
  return effectWith(id, { brushes: { [id]: settings } as Effect['brushes'] });
}

// ---------- tests ----------

describe('B2 each brush does its job', () => {
  it('B2 grain fixed to the stroke, neon and electric glow near their line, electric reshapes and keeps its root, blade shadow and trail sparkles stay close, trail never white, fine tip thinner than ink', async () => {
    const mods = await recorded(ev, 'modules load', 'src/render/headless.ts (renderPng), src/render/brushes.ts (brushSettings)', async () => ({
      head: await need('src/render/headless.ts', { renderPng: 'function' }, () => import('../../src/render/headless.ts')),
      brushes: await need('src/render/brushes.ts', { brushSettings: 'function' }, () => import('../../src/render/brushes.ts')),
    })) as { head: HeadlessModule; brushes: BrushesModule };
    head = mods.head;
    const failures: string[] = [];

    // SPEC §8.7 defaults
    const s87 = spec87();
    {
      const e = effectWith('ink');
      const got = (id: string) =>
        mods.brushes.brushSettings(e, id as never) as {
          size: number;
          grain?: number;
          glow?: { radiusPx: number; intensity: number };
          bolt?: { bendPx: number; ampPx: number; elbows: number; shards: number };
        };
      const near = (a: number | undefined, b: number) => a !== undefined && Math.abs(a - b) < 1e-9;
      const bad: string[] = [];
      for (const id of ['fine-ink', 'fine-textured']) if (!near(got(id).size, s87.fineFactor * INK.size)) bad.push(`${id} size ${got(id).size} (want ${s87.fineFactor} × ${INK.size})`);
      for (const id of ['textured', 'fine-textured']) if (!near(got(id).grain, s87.grain)) bad.push(`${id} grain ${got(id).grain} (want ${s87.grain})`);
      for (const id of ['neon-straight', 'neon-round']) {
        const g = got(id).glow;
        if (!g || !near(g.radiusPx, s87.glowRadius) || !near(g.intensity, s87.glowIntensity)) bad.push(`${id} glow ${JSON.stringify(g)} (want radius ${s87.glowRadius}, intensity ${s87.glowIntensity})`);
      }
      for (const id of ['electric', 'blade', 'trail'] as const) {
        const want = s87[id].glow;
        const g = got(id).glow;
        if (!g || !near(g.radiusPx, want.radiusPx) || !near(g.intensity, want.intensity)) bad.push(`${id} glow ${JSON.stringify(g)} (want radius ${want.radiusPx}, intensity ${want.intensity})`);
      }
      {
        const want = s87.electric.bolt;
        const b = got('electric').bolt;
        if (!b || !near(b.bendPx, want.bendPx) || !near(b.ampPx, want.ampPx) || !near(b.elbows, want.elbows) || !near(b.shards, want.shards)) {
          bad.push(`electric bolt ${JSON.stringify(b)} (want ${JSON.stringify(want)})`);
        }
      }
      ev.record(
        'SPEC §8.7 defaults',
        bad.length ? bad : 'all match',
        `fine size ${s87.fineFactor} × ink, grain ${s87.grain}, neon glow radius ${s87.glowRadius} px, intensity ${s87.glowIntensity}; electric glow ${JSON.stringify(s87.electric.glow)}, bolt ${JSON.stringify(s87.electric.bolt)}; blade glow ${JSON.stringify(s87.blade.glow)}; trail glow ${JSON.stringify(s87.trail.glow)}`,
        bad.length === 0,
      );
      if (bad.length) failures.push(`defaults: ${bad.join('; ')}`);
    }

    // Grain
    {
      const pre: Record<string, number> = {};
      for (const [tex, base] of [['textured', 'ink'], ['fine-textured', 'fine-ink']] as const) {
        const stroke = placedStroke(31);
        const aBase = await alphaOf(effectWith(base), stroke);
        const aTex = await alphaOf(effectWith(tex), stroke);
        const gA = grainMap(aBase, aTex);
        const inA = interior(aBase);
        const removed = inA.length ? inA.reduce((s, i) => s + gA[i]!, 0) / inA.length : 0;
        pre[tex] = removed;
        const results: { T: V2; found: V2; err: number }[] = [];
        for (const T of [...SHIFTS, SUBPIXEL]) {
          const moved = placedStroke(31, T);
          const bBase = await alphaOf(effectWith(base), moved);
          const bTex = await alphaOf(effectWith(tex), moved);
          const gB = grainMap(bBase, bTex);
          const { d } = grainShift(gA, inA, gB, new Set(interior(bBase)), T);
          results.push({ T, found: [Number(d[0].toFixed(3)), Number(d[1].toFixed(3))], err: Math.hypot(d[0] - T[0], d[1] - T[1]) });
        }
        const gated = results.slice(0, SHIFTS.length);
        const worst = Math.max(...gated.map((r) => r.err));
        const ok = removed > 0.05 && removed < 0.95 && worst <= GRAIN_TOL;
        ev.record(`${tex}: grain moves with the stroke`, { worstErrPx: worst, shifts: gated }, `|grain shift - translation| <= ${GRAIN_TOL} px`, ok);
        if (!ok) failures.push(`${tex}: grain shift error ${worst} px (removed ${removed})`);
        if (tex === 'textured') ev.record('grain under a sub-pixel translation (report)', results[SHIFTS.length], `reported; ${GRAIN_TOL} px would be the threshold`, true);
      }
      const preOk = Object.values(pre).every((r) => r > 0.05 && r < 0.95);
      ev.record('precondition: grain removes part of the fill', pre, 'between 5% and 95% of the interior fill removed', preOk);
    }

    // Glow
    {
      const stroke = placedStroke(47);
      const line = stroke.points as V2[];
      const glowCheck = async (effect: Effect, id: string) => {
        const st = mods.brushes.brushSettings(effect, id as never) as { size: number; glow?: { radiusPx: number } };
        const radius = st.glow?.radiusPx ?? NaN;
        const a = await alphaOf(effect, stroke);
        let far = 0;
        let maxD = 0;
        let pastCore = 0;
        for (let i = 0; i < a.length; i++) {
          if (a[i]! <= 0) continue;
          const d = distToLine([(i % W) + 0.5, Math.floor(i / W) + 0.5], line);
          if (d > maxD) maxD = d;
          if (d > GLOW_FACTOR * radius) far++;
          if (d > st.size / 2 + 1) pastCore++;
        }
        return { radius, limit: GLOW_FACTOR * radius, maxDistPx: maxD, pixelsBeyond: far, pixelsPastCore: pastCore };
      };
      const glowPast: Record<string, number> = {};
      for (const id of ['neon-straight', 'neon-round']) {
        const r = await glowCheck(effectWith(id), id);
        glowPast[id] = r.pixelsPastCore;
        const ok = Number.isFinite(r.radius) && r.pixelsBeyond === 0;
        ev.record(`${id}: glow within 2 × radius (default)`, r, `no pixel farther than ${GLOW_FACTOR} × glow.radiusPx from the centerline`, ok);
        if (!ok) failures.push(`${id} default: ${r.pixelsBeyond} pixels beyond ${r.limit} px (max ${r.maxDistPx.toFixed(2)})`);
      }
      ev.record('precondition: neon glows past its core', glowPast, 'some pixels beyond half the brush size', Object.values(glowPast).every((n) => n > 0));
      const custom: Record<string, unknown> = {};
      let customOk = true;
      for (const id of ['neon-straight', 'neon-round']) {
        const base = mods.brushes.brushSettings(effectWith(id), id as never) as { glow?: { radiusPx: number; intensity: number } };
        const settings = { ...base, glow: { radiusPx: 2 * s87.glowRadius, intensity: base.glow?.intensity ?? s87.glowIntensity } };
        const e = effectWith(id, { brushes: { [id]: settings } as Effect['brushes'] });
        const r = await glowCheck(e, id);
        custom[id] = r;
        if (!(r.radius === 2 * s87.glowRadius && r.pixelsBeyond === 0)) customOk = false;
      }
      ev.record('neon glow within 2 × radius (custom radius)', custom, `effect.brushes radius ${2 * s87.glowRadius} px is used, and no pixel beyond 2 × it`, customOk);
      if (!customOk) failures.push('custom glow radius');
    }

    // Fine tip
    {
      const rows: { seed: number; ink: number; fine: number; ratio: number }[] = [];
      for (const seed of [52, 53, 54]) {
        const stroke = placedStroke(seed);
        const ink = widest(await alphaOf(effectWith('ink'), stroke));
        const fine = widest(await alphaOf(effectWith('fine-ink'), stroke));
        rows.push({ seed, ink, fine, ratio: ink > 0 ? fine / ink : Infinity });
      }
      const worst = Math.max(...rows.map((r) => r.ratio));
      const ok = rows.every((r) => r.ink > 0 && r.fine > 0) && worst <= FINE_RATIO;
      ev.record("fine-ink's widest point <= 0.5 × ink's", { worstRatio: worst, strokes: rows }, `<= ${FINE_RATIO}`, ok);
      if (!ok) failures.push(`fine-ink / ink widest ratio ${worst}`);
    }

    // Electric, blade and trail share one placed stroke; the distance of each pixel to its drawn centerline is
    // worked out once, on demand.
    const shared = placedStroke(47);
    const line = shared.points as V2[];
    const lineCache = new Float32Array(W * H).fill(-1);
    const dLine = (i: number) => {
      let v = lineCache[i]!;
      if (v < 0) lineCache[i] = v = distToLine(centre(i), line);
      return v;
    };
    // A section that throws records each of its checks that hasn't run yet as a FAIL with the reason, so the
    // checks after it still run and the evidence says why.
    const guarded = async (names: string[], fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        for (const n of names) if (!ev.checks.some((c) => c.name === n)) ev.record(n, 'not measured', 'SPEC §10 B2', false, errMsg(e));
        failures.push(`${names[0]}: ${errMsg(e)}`);
      }
    };

    // Electric
    await guarded(
      [
        'precondition: electric glows past its bolt',
        'precondition: electric shows at most bolt.shards shards per drawing',
        'electric: glow within 2 × radius + ampPx + farthest shard (default)',
        'electric: glow within 2 × radius + ampPx + farthest shard (custom radius)',
        'electric: pixels differ between consecutive drawings',
        'electric: shape differs between consecutive drawings (glow off)',
        'electric: root within 1 px of the drawn root',
      ],
      async () => {
        const root = line[0]!;
        const R = s87.electric.glow.radiusPx;
        const AMP = s87.electric.bolt.ampPx;
        const MAX_SHARDS = s87.electric.bolt.shards;
        const base = mods.brushes.brushSettings(effectWith('electric'), 'electric' as never) as { glow?: { radiusPx: number; intensity: number } };
        const measure = async (full: Effect, bare: Effect, k: number, radius: number) => {
          const f = await renderOf(full, shared, k);
          const b = await renderOf(bare, shared, k);
          const { main, others } = splitInk(b.rgba);
          let farShard = 0;
          for (const g of others) for (const i of g) farShard = Math.max(farShard, dLine(i));
          const limit = 2 * radius + AMP + farShard;
          let beyond = 0;
          let maxD = 0;
          let pastBolt = 0;
          for (let i = 0; i < W * H; i++) {
            if (f.rgba[i * 4 + 3]! === 0) continue;
            const d = dLine(i);
            if (d > maxD) maxD = d;
            if (d > limit) beyond++;
            if (b.rgba[i * 4 + 3]! === 0) pastBolt++;
          }
          // The bolt's root end: the pixels whose projection on the drawn centerline is nearest its start.
          const proj = main.map((i) => ({ i, s: projectOnPolyline(centre(i), line).s, a: b.rgba[i * 4 + 3]! / 255 }));
          const sMin = proj.length ? Math.min(...proj.map((p) => p.s)) : NaN;
          let sx = 0;
          let sy = 0;
          let sa = 0;
          for (const p of proj) if (p.s <= sMin + ROOT_WINDOW) {
            const [x, y] = centre(p.i);
            sx += x * p.a;
            sy += y * p.a;
            sa += p.a;
          }
          const rootErr = sa > 0 ? Math.hypot(sx / sa - root[0], sy / sa - root[1]) : Infinity;
          const shape = new Uint8Array(W * H);
          for (let i = 0; i < shape.length; i++) shape[i] = b.rgba[i * 4 + 3]! >= 128 ? 1 : 0;
          return { png: f.png, shape, shards: others.length, farShard, limit, maxD, beyond, pastBolt, rootErr };
        };

        const rows: Awaited<ReturnType<typeof measure>>[] = [];
        for (const k of ELECTRIC_KS) rows.push(await measure(effectWith('electric'), glowOff(mods.brushes, 'electric'), k, R));
        const brief = (r: (typeof rows)[number], k: number) => ({ k, limitPx: Number(r.limit.toFixed(2)), maxDistPx: Number(r.maxD.toFixed(2)), pixelsBeyond: r.beyond, shards: r.shards, farShardPx: Number(r.farShard.toFixed(2)) });

        const past = rows.map((r) => r.pastBolt);
        ev.record('precondition: electric glows past its bolt', { glowOnlyPixelsPerDrawing: past }, 'every drawing has glow pixels outside the glow-off bolt', past.every((n) => n > 0));

        const shards = rows.map((r) => r.shards);
        ev.record('precondition: electric shows at most bolt.shards shards per drawing', { shardsPerDrawing: shards }, `<= ${MAX_SHARDS} (SPEC §8.7) separate pieces besides the bolt`, shards.every((n) => n <= MAX_SHARDS));

        const worst = rows.reduce((w, r, k) => (r.beyond > rows[w]!.beyond || (r.beyond === rows[w]!.beyond && r.maxD - r.limit > rows[w]!.maxD - rows[w]!.limit) ? k : w), 0);
        const defOk = Number.isFinite(base.glow?.radiusPx ?? NaN) && rows.every((r) => r.beyond === 0);
        ev.record(
          'electric: glow within 2 × radius + ampPx + farthest shard (default)',
          { worst: brief(rows[worst]!, worst), drawings: rows.map(brief) },
          `no pixel farther than 2 × ${R} + ${AMP} + farthest shard from the centerline, every drawing`,
          defOk,
        );

        const custom: ReturnType<typeof brief>[] = [];
        let customOk = true;
        {
          const radius = 2 * R;
          const st = { ...base, glow: { radiusPx: radius, intensity: base.glow?.intensity ?? s87.electric.glow.intensity } };
          const full = effectWith('electric', { brushes: { electric: st } as Effect['brushes'] });
          const used = (mods.brushes.brushSettings(full, 'electric' as never) as { glow?: { radiusPx: number } }).glow?.radiusPx;
          if (used !== radius) customOk = false;
          for (const k of [0, 1, 2]) {
            const r = await measure(full, glowOff(mods.brushes, 'electric', { radiusPx: radius }), k, radius);
            custom.push(brief(r, k));
            if (r.beyond > 0) customOk = false;
          }
        }
        ev.record('electric: glow within 2 × radius + ampPx + farthest shard (custom radius)', custom, `effect.brushes radius ${2 * R} px is used, and no pixel beyond 2 × it + ${AMP} + farthest shard`, customOk);

        const samePng: string[] = [];
        const sameShape: string[] = [];
        for (let k = 1; k < rows.length; k++) {
          if (rows[k]!.png.equals(rows[k - 1]!.png)) samePng.push(`${k - 1}->${k}`);
          const a = rows[k - 1]!.shape;
          const b = rows[k]!.shape;
          let diff = 0;
          for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
          if (diff === 0) sameShape.push(`${k - 1}->${k}`);
        }
        ev.record('electric: pixels differ between consecutive drawings', { identicalPairs: samePng, pairs: rows.length - 1 }, 'every consecutive pair of drawings renders differently', samePng.length === 0);
        ev.record('electric: shape differs between consecutive drawings (glow off)', { identicalPairs: sameShape, pairs: rows.length - 1 }, 'the bolt and shards (alpha >= 128, glow off) differ on every consecutive pair', sameShape.length === 0);

        const errs = rows.map((r) => Number(r.rootErr.toFixed(3)));
        const worstRoot = Math.max(...rows.map((r) => r.rootErr));
        ev.record('electric: root within 1 px of the drawn root', { worstPx: worstRoot, perDrawing: errs }, `<= ${ROOT_TOL} px from points[0], every drawing`, worstRoot <= ROOT_TOL);
      },
    );

    // Blade
    await guarded(['precondition: blade casts a shadow', 'blade: cast shadow within 16 px of its outline'], async () => {
      const rows: { k: number; shadowPixels: number; maxDistPx: number; pixelsBeyond: number; shadowOffset: V2 }[] = [];
      for (const k of SHADED_KS) {
        const { rgba } = await renderOf(glowOff(mods.brushes, 'blade'), shared, k);
        const body = new Uint8Array(W * H);
        for (let i = 0; i < body.length; i++) body[i] = rgba[i * 4 + 3]! >= 128 ? 1 : 0;
        const d2 = sqDistTo(body, W, H);
        let n = 0;
        let maxD = 0;
        let beyond = 0;
        const c = { bx: 0, by: 0, bn: 0, sx: 0, sy: 0, sa: 0 };
        for (let i = 0; i < body.length; i++) {
          const a = rgba[i * 4 + 3]!;
          if (a === 0) continue;
          const [x, y] = centre(i);
          if (body[i]) {
            c.bx += x;
            c.by += y;
            c.bn++;
            continue;
          }
          n++;
          c.sx += x * a;
          c.sy += y * a;
          c.sa += a;
          const d = Math.sqrt(d2[i]!);
          if (d > maxD) maxD = d;
          if (d > SHADOW_MAX) beyond++;
        }
        const off: V2 = c.sa > 0 && c.bn > 0 ? [Number((c.sx / c.sa - c.bx / c.bn).toFixed(2)), Number((c.sy / c.sa - c.by / c.bn).toFixed(2))] : [NaN, NaN];
        rows.push({ k, shadowPixels: n, maxDistPx: Number(maxD.toFixed(2)), pixelsBeyond: beyond, shadowOffset: off });
      }
      ev.record(
        'precondition: blade casts a shadow',
        rows.map((r) => ({ k: r.k, shadowPixels: r.shadowPixels, shadowOffsetFromBlade: r.shadowOffset })),
        'every drawing has see-through pixels (alpha < 0.5) outside the blade with the glow off; offset reported (§8.7: down and to the right)',
        rows.every((r) => r.shadowPixels > 0),
      );
      ev.record(
        'blade: cast shadow within 16 px of its outline',
        { worstDistPx: Math.max(...rows.map((r) => r.maxDistPx)), drawings: rows.map(({ k, maxDistPx, pixelsBeyond }) => ({ k, maxDistPx, pixelsBeyond })) },
        `no shadow pixel farther than ${SHADOW_MAX} px from the blade's outline (alpha >= 0.5), every drawing`,
        rows.every((r) => r.pixelsBeyond === 0),
      );
    });

    // Trail
    await guarded(['precondition: trail sheds sparkles', 'trail: sparkles within 1.6 × its width of the centerline'], async () => {
      const rows: { k: number; widthPx: number; limitPx: number; sparkles: number; farthestPx: number; pixelsBeyond: number }[] = [];
      for (const k of SHADED_KS) {
        const { rgba } = await renderOf(glowOff(mods.brushes, 'trail'), shared, k);
        const { main, others } = splitInk(rgba);
        const inMain = new Uint8Array(W * H);
        for (const i of main) inMain[i] = 1;
        const width = widestOf((i) => inMain[i] === 1);
        const limit = SPARKLE_FACTOR * width;
        let far = 0;
        let beyond = 0;
        for (const g of others) for (const i of g) {
          const d = dLine(i);
          if (d > far) far = d;
          if (d > limit) beyond++;
        }
        rows.push({ k, widthPx: Number(width.toFixed(2)), limitPx: Number(limit.toFixed(2)), sparkles: others.length, farthestPx: Number(far.toFixed(2)), pixelsBeyond: beyond });
      }
      const total = rows.reduce((s, r) => s + r.sparkles, 0);
      ev.record('precondition: trail sheds sparkles', { sparklesPerDrawing: rows.map((r) => r.sparkles) }, 'at least one sparkle (a separate piece, glow off) over the drawings tested', total > 0);
      ev.record(
        'trail: sparkles within 1.6 × its width of the centerline',
        rows,
        `no sparkle pixel farther than ${SPARKLE_FACTOR} × the trail's widest point from the centerline, every drawing`,
        rows.every((r) => r.widthPx > 0 && r.pixelsBeyond === 0),
      );
    });
    await guarded(['trail: never white (no pixel with all channels >= 250)'], async () => {
      const rows: { color: number; k: number; whiteOverBlack: number; whiteColor: number; example?: number[] }[] = [];
      for (const color of [0, 1, 2] as const) for (const k of SHADED_KS) {
        const { rgba } = await renderOf(effectWith('trail', {}, color), shared, k);
        let overBlack = 0;
        let straight = 0;
        let example: number[] | undefined;
        let inked = 0;
        for (let i = 0; i < W * H; i++) {
          const a = rgba[i * 4 + 3]!;
          if (a === 0) continue;
          inked++;
          const r = rgba[i * 4]!;
          const g = rgba[i * 4 + 1]!;
          const b = rgba[i * 4 + 2]!;
          const on = [Math.round((r * a) / 255), Math.round((g * a) / 255), Math.round((b * a) / 255)];
          const white = on.every((v) => v >= WHITE);
          if (white) overBlack++;
          const whiteStraight = a >= 64 && r >= WHITE && g >= WHITE && b >= WHITE;
          if (whiteStraight) straight++;
          if ((white || whiteStraight) && !example) example = [i % W, Math.floor(i / W), r, g, b, a];
        }
        if (inked === 0) throw new Error(`trail renders nothing in color ${color} at k ${k}`);
        rows.push({ color, k, whiteOverBlack: overBlack, whiteColor: straight, ...(example ? { example } : {}) });
      }
      ev.record(
        'trail: never white (no pixel with all channels >= 250)',
        { renders: rows.length, withWhite: rows.filter((r) => r.whiteOverBlack || r.whiteColor).slice(0, 12) },
        `no pixel with R, G, B all >= ${WHITE}: over black, nor in the color of any pixel with alpha >= 64; palette colors 0-2, k ${SHADED_KS.join(', ')}`,
        rows.every((r) => r.whiteOverBlack === 0 && r.whiteColor === 0),
      );
    });

    const failed = ev.checks.filter((c) => !c.pass).map((c) => `${c.name}: ${JSON.stringify(c.measured).slice(0, 200)}`);
    expect(ev.missing(), 'B2 checks that never ran').toEqual([]);
    expect(failed, `B2 failing checks (${failures.join('; ')})`).toEqual([]);
  }, 600_000);
});
