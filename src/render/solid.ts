// The blade and trail brushes (SPEC §8.8), shaded per pixel.
//
// Both start from a distance field around the stroke: for every pixel near
// it, the nearest point on the centerline gives t (0 at the root, 1 at the
// tip), the signed distance across it, and the centerline's normal there.
// Segments are rasterized one at a time over their own small box, keeping the
// nearest, so the cost grows with the stroke's area, not area × length.
//   - blade: the distance across becomes a fake surface normal (two faces
//     meeting at a ridge, each slightly curved). Lit from a fixed direction
//     on screen, that picks three soft cel tones; then crystal streaks and
//     veins stretched along the blade, reflected light in the accent color on
//     the shadow edge, a broad faint sheen and a small broken glint (both
//     tinted, never white), and a darker edge line. A soft cast shadow and a
//     faint glow go under it.
//   - trail: see-through, crisp on its outer edge (the outside of its curve)
//     and soft on the inner one, fading out at both ends, colored all the way
//     through so it reads on light footage. Two sharp forks at the tip and
//     sparkle dust shed off its outer side; the neon glow behind.
// Per-pixel shading is too slow for every output frame on a phone, so each
// stroke's shaded bitmap is cached per drawing: a drawing holds for 2 frames
// and re-renders identically, so the frames in between just stamp it.
import type { BrushSettings, Vec2 } from '../types/effect.ts';
import { densify, fillOutline } from './brush.ts';
import { bounds, hash01, mix, rgb, smoothstep, valueNoise, hex } from './geometry.ts';
import { drawGlow, type BrushTarget, type MakeScratch, type Scratch } from './glow.ts';

// SPEC §8.7 starting values; Qai tunes them.
export const BLADE_SIZE = 2; // × the ink brush's size, at its widest
export const BLADE_GLOW = { radiusPx: 14, intensity: 0.3 };
export const TRAIL_SIZE = 1.4; // × the ink brush's size, at its widest
export const TRAIL_GLOW = { radiusPx: 16, intensity: 0.4 };
const LIGHT = unit([-0.6, -0.75, 0.3]); // from the upper left, a little in front
const HALF = unit([LIGHT[0], LIGHT[1], LIGHT[2] + 1]); // halfway to the viewer, for highlights
const SHADOW: [number, number][] = [[4, 0.14], [8.5, 0.12], [13, 0.1]]; // px down-right at 1080 wide, opacity
const SHADOW_DIR = unit([0.6, 0.8]);
const SHADOW_COLOR = '#1a0624';
const FORKS = 2;
const FORK_LEN = [1.4, 2.6]; // × the trail's width
const SPARKLES = 40; // per drawing, at most
const INNER = 1.6; // the trail's soft inner side reaches 1.6 × its half-width

export interface SolidStroke {
  id: number;
  k: number;
  points: Vec2[]; // target px
  pressure: number[];
  color: string;
  accent: string; // blade: the reflected light's color
  settings: BrushSettings;
  scale: number;
}

// ---- Blade --------------------------------------------------------------------------

export function drawBlade(ctx: BrushTarget, make: MakeScratch, s: SolidStroke) {
  const line = dense(s);
  if (!line) return;
  const width = s.settings.size * s.scale;
  // Flat at the root, swelling a little, straight sides down to a razor tip.
  const half = (t: number, p: number) => (width / 2) * (t < 0.12 ? 0.75 + 2 * t : 1) * (1 - t) ** 0.9 * (0.7 + 0.3 * p);
  castShadow(ctx, line, half, s.scale);
  if (s.settings.glow) drawGlow(ctx, make, { id: s.id, k: s.k, points: s.points, color: s.color, scale: s.scale, glow: s.settings.glow });
  stamp(ctx, make, 'blade', s, () => {
    const f = field(line, width / 2 + 2);
    if (!f) return null;
    const base = rgb(s.color);
    const shadow = mix(base.map((c) => c * 0.3), [30, 6, 60], 0.35); // darker and cooler
    const lit = mix(base, [255, 232, 222], 0.42); // lighter and warmer
    const spec = mix(base, [255, 255, 255], 0.5);
    const rim = rgb(s.accent);
    const drift = 0.35 * s.k;
    const seed = s.id * 7;
    return paint(f, (i) => {
      if (f.end[i] < 0) return null; // the flat root
      const hh = half(f.t[i], f.p[i]);
      const dist = f.end[i] ? f.d[i] : Math.abs(f.across[i]);
      const cover = Math.min(1, hh - dist + 0.5);
      if (cover <= 0 || hh < 0.3) return null;
      const u = Math.max(-1, Math.min(1, f.across[i] / hh));
      const len = (f.t[i] * f.total) / s.scale;
      // Two faces meeting at a ridge, each slightly curved.
      const a = Math.sign(u) * 0.62 + 0.38 * u;
      const z = 0.72 * (1 - 0.25 * Math.abs(u));
      const m = Math.hypot(a, z);
      const N = [(f.nx[i] * a) / m, (f.ny[i] * a) / m, z / m];
      // Crystal texture: long streaks along the blade, a little warped.
      const warp = valueNoise(len / 40, u * 1.5 + drift, seed + 1) * 1.6;
      const streak = fbm(len / 70, u * 3 + warp, seed + 2);
      const vein = smoothstep(0.9, 0.97, 1 - Math.abs(2 * valueNoise(len / 55, u * 2.2 + warp, seed + 3) - 1));
      const breakup = smoothstep(0.45, 0.75, valueNoise(len / 22, u * 5 + drift, seed + 4));
      let c = shade(N, streak, { base, shadow, lit, spec, rim }, 34, breakup);
      c = mix(c, shadow.map((v) => v * 0.6), vein * 0.55);
      c = mix(c, shadow, (1 - smoothstep(0, 0.16, f.t[i])) * 0.6); // the root sinks into whatever it grows from
      c = mix(c, c.map((v) => v * 0.35), smoothstep(hh - 1.6 * s.scale, hh - 0.3 * s.scale, dist) * 0.8); // the edge line
      return [c[0], c[1], c[2], cover];
    });
  });
}

// Three soft cel tones from the light, texture nudging the boundaries, then
// reflected light on the far edge and the highlights.
function shade(N: number[], tex: number, look: { base: number[]; shadow: number[]; lit: number[]; spec: number[]; rim: number[] }, gloss: number, breakup: number): number[] {
  const ndl = N[0] * LIGHT[0] + N[1] * LIGHT[1] + N[2] * LIGHT[2];
  const w = 0.5 + 0.5 * ndl + 0.16 * (tex - 0.5);
  const mid = mix(look.shadow, look.base, 0.55);
  let c = mix(look.shadow, mid, smoothstep(0.3, 0.38, w));
  c = mix(c, look.base, smoothstep(0.5, 0.58, w));
  c = mix(c, look.lit, smoothstep(0.72, 0.8, w) * 0.9);
  const rim = Math.max(0, -ndl) * (1 - N[2]) ** 1.5;
  c = mix(c, look.rim, Math.min(0.55, rim * 1.4));
  const ndh = Math.max(0, N[0] * HALF[0] + N[1] * HALF[1] + N[2] * HALF[2]);
  const sheen = ndh ** (gloss * 0.25) * 0.16; // broad and soft
  const glint = smoothstep(0.5, 0.7, ndh ** gloss) * 0.45 * breakup; // tight, broken up
  return mix(c, look.spec, Math.min(0.6, sheen + glint));
}

// A soft shadow cast down and to the right onto whatever is under the blade:
// its shape pushed 4, 8.5 and 13 px, at falling opacity.
function castShadow(ctx: BrushTarget, line: Dense, half: (t: number, p: number) => number, scale: number) {
  const n = line.pts.length;
  const side = (sign: number) =>
    line.pts.map((p, i): Vec2 => {
      const a = line.pts[Math.max(0, i - 1)];
      const b = line.pts[Math.min(n - 1, i + 1)];
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const h = half(line.t[i], line.p[i]) * sign;
      return [p[0] - ((b[1] - a[1]) / d) * h, p[1] + ((b[0] - a[0]) / d) * h];
    });
  const hull = [...side(1), ...side(-1).reverse()];
  const alpha = ctx.globalAlpha;
  for (const [off, a] of SHADOW) {
    const dx = SHADOW_DIR[0] * off * scale;
    const dy = SHADOW_DIR[1] * off * scale;
    ctx.globalAlpha = alpha * a;
    fillOutline(ctx, hull.map(([x, y]): Vec2 => [x + dx, y + dy]), SHADOW_COLOR);
  }
  ctx.globalAlpha = alpha;
}

// ---- Trail --------------------------------------------------------------------------

export function drawTrail(ctx: BrushTarget, make: MakeScratch, s: SolidStroke) {
  const line = dense(s);
  if (!line) return;
  const width = s.settings.size * s.scale;
  const outer = outside(line.pts);
  const half = (t: number, p: number) => (width / 2) * Math.sin(Math.PI * Math.min(1, t * 1.15)) ** 0.6 * (0.7 + 0.3 * p);
  if (s.settings.glow) drawGlow(ctx, make, { id: s.id, k: s.k, points: s.points, color: s.color, scale: s.scale, glow: s.settings.glow });
  stamp(ctx, make, 'trail', s, () => {
    const f = field(line, (width / 2) * INNER + 2);
    if (!f) return null;
    const base = rgb(s.color);
    const deep = base.map((c) => c * 0.55);
    const hot = mix(base, [255, 255, 255], 0.12);
    const pale = mix(base, [255, 255, 255], 0.45);
    return paint(f, (i) => {
      if (f.end[i]) return null;
      const hh = half(f.t[i], f.p[i]);
      if (hh < 0.3) return null;
      const u = (f.across[i] * outer) / hh; // -1 inner .. +1 outer
      if (u > 1 || u < -INNER) return null;
      const edge = u > 0 ? (u > 0.92 ? (1 - u) / 0.08 : 1) : Math.max(0, 1 + u / INNER) ** 1.5; // crisp outside, soft inside
      const along = Math.sin(Math.PI * f.t[i]) ** 0.8;
      const a = edge * along * 0.95;
      if (a <= 0.01) return null;
      const glow = Math.max(0, 1 - Math.abs(u - 0.45) / 0.3) ** 2 * along;
      let c = mix(deep, hot, smoothstep(1, 0.7, u) * smoothstep(-INNER, -0.2, u));
      c = mix(c, pale, glow * 0.75);
      return [c[0], c[1], c[2], a];
    });
  });
  drawForks(ctx, line.pts, s, width);
  drawSparkles(ctx, line.pts, s, width, outer);
}

// Which side of the stroke is the outside of its curve: +1 or -1 in the
// field's `across` sign. A straight stroke picks a side from its seed.
function outside(pts: Vec2[]): number {
  let turn = 0;
  for (let i = 2; i < pts.length; i++) {
    const ax = pts[i - 1][0] - pts[i - 2][0];
    const ay = pts[i - 1][1] - pts[i - 2][1];
    const bx = pts[i][0] - pts[i - 1][0];
    const by = pts[i][1] - pts[i - 1][1];
    turn += ax * by - ay * bx;
  }
  return turn > 0 ? -1 : 1;
}

// Two sharp spikes splitting off the end, each angled away from the line and
// curving slightly back toward it.
function drawForks(ctx: BrushTarget, pts: Vec2[], s: SolidStroke, width: number) {
  const color = hex(mix(rgb(s.color), [255, 255, 255], 0.15));
  for (let f = 0; f < FORKS; f++) {
    const i0 = Math.min(pts.length - 2, Math.floor(pts.length * (0.78 + 0.1 * f)));
    const p0 = pts[i0];
    const p1 = pts[Math.min(pts.length - 1, i0 + 2)];
    const side = f % 2 ? 1 : -1;
    const a = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) + side * (0.3 + 0.2 * hash01(s.id, s.k * 3 + f, 19));
    const len = width * (FORK_LEN[0] + (FORK_LEN[1] - FORK_LEN[0]) * hash01(s.id, s.k * 3 + f, 20));
    const spine: Vec2[] = [];
    for (let j = 0; j <= 9; j++) {
      const u = j / 9;
      const b = a - side * 0.25 * u;
      spine.push([p0[0] + Math.cos(b) * len * u, p0[1] + Math.sin(b) * len * u]);
    }
    // A thin wedge: wide at its start, to a point.
    const w0 = width * 0.11;
    const wedge = (sign: number) =>
      spine.map((p, j): Vec2 => {
        const q = spine[Math.min(9, j + 1)];
        const r = spine[Math.max(0, j - 1)];
        const d = Math.hypot(q[0] - r[0], q[1] - r[1]) || 1;
        const h = w0 * (1 - j / 9) * sign;
        return [p[0] - ((q[1] - r[1]) / d) * h, p[1] + ((q[0] - r[0]) / d) * h];
      });
    fillOutline(ctx, [...wedge(1), ...wedge(-1).reverse()], color);
  }
}

// Dust shed off the outer side: small round dots, pale tints of the color
// (never white).
function drawSparkles(ctx: BrushTarget, pts: Vec2[], s: SolidStroke, width: number, outer: number) {
  const n = pts.length;
  const count = Math.round(SPARKLES * (0.5 + 0.5 * hash01(s.id, s.k, 43)));
  const alpha = ctx.globalAlpha;
  for (let j = 0; j < count; j++) {
    const r = (q: number) => hash01(s.id, s.k * 97 + j, q);
    const i = Math.min(n - 1, Math.floor(r(23) * n));
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = -(b[1] - a[1]) / d;
    const ny = (b[0] - a[0]) / d;
    const off = (r(29) * 1.6 - 0.3) * width * 0.8 * outer;
    const rad = (0.6 + 1.6 * r(31) ** 3) * s.scale;
    const cx = pts[i][0] + nx * off;
    const cy = pts[i][1] + ny * off;
    ctx.globalAlpha = alpha * (0.5 + 0.5 * r(41));
    const dot: Vec2[] = [];
    for (let q = 0; q < 6; q++) dot.push([cx + Math.cos((q * Math.PI) / 3) * rad, cy + Math.sin((q * Math.PI) / 3) * rad]);
    fillOutline(ctx, dot, hex(mix(rgb(s.color), [255, 255, 255], r(37) < 0.5 ? 0.6 : 0.35)));
  }
  ctx.globalAlpha = alpha;
}

// ---- The distance field ---------------------------------------------------------------

interface Dense {
  pts: Vec2[];
  p: number[]; // pressure
  t: number[]; // 0 at the root .. 1 at the tip
  cum: number[];
  total: number;
}

// The centerline as a smooth curve every few px, so the shading has no facets.
function dense(s: SolidStroke): Dense | null {
  if (s.points.length < 2) return null;
  const d = densify(s.points, s.pressure, Math.max(2, 3 * s.scale));
  const pts = d.map((q): Vec2 => [q[0], q[1]]);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = cum[cum.length - 1];
  if (!(total > 0)) return null;
  return { pts, p: d.map((q) => q[2]), t: cum.map((c) => c / total), cum, total };
}

interface Field {
  x0: number;
  y0: number;
  w: number;
  h: number;
  total: number;
  d: Float32Array; // distance to the centerline
  across: Float32Array; // signed distance across it (+ is to the right of travel)
  t: Float32Array;
  p: Float32Array; // pressure there
  nx: Float32Array; // the centerline's unit normal there
  ny: Float32Array;
  end: Int8Array; // -1 before the root, 1 past the tip, 0 alongside
}

function field(line: Dense, pad: number): Field | null {
  const box = bounds(line.pts, pad + 1);
  if (!box) return null;
  const { x0, y0, w, h } = box;
  const n = w * h;
  const f: Field = {
    x0, y0, w, h, total: line.total,
    d: new Float32Array(n).fill(Infinity),
    across: new Float32Array(n), t: new Float32Array(n), p: new Float32Array(n),
    nx: new Float32Array(n), ny: new Float32Array(n), end: new Int8Array(n),
  };
  const pts = line.pts;
  const last = pts.length - 2;
  for (let i = 0; i <= last; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (!(len2 > 0)) continue;
    const len = Math.sqrt(len2);
    const nx = -dy / len;
    const ny = dx / len;
    const xa = Math.max(0, Math.floor(Math.min(ax, bx) - pad - x0));
    const xb = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + pad - x0));
    const ya = Math.max(0, Math.floor(Math.min(ay, by) - pad - y0));
    const yb = Math.min(h - 1, Math.ceil(Math.max(ay, by) + pad - y0));
    for (let y = ya; y <= yb; y++) {
      const py = y0 + y + 0.5;
      for (let x = xa; x <= xb; x++) {
        const px = x0 + x + 0.5;
        const raw = ((px - ax) * dx + (py - ay) * dy) / len2;
        const u = raw < 0 ? 0 : raw > 1 ? 1 : raw;
        const ex = px - (ax + dx * u);
        const ey = py - (ay + dy * u);
        const d = Math.sqrt(ex * ex + ey * ey);
        const k = y * w + x;
        if (d >= f.d[k]) continue;
        f.d[k] = d;
        f.across[k] = (px - ax) * nx + (py - ay) * ny;
        f.t[k] = (line.cum[i] + u * len) / line.total;
        f.p[k] = line.p[i] + (line.p[i + 1] - line.p[i]) * u;
        f.nx[k] = nx;
        f.ny[k] = ny;
        f.end[k] = i === 0 && raw < 0 ? -1 : i === last && raw > 1 ? 1 : 0;
      }
    }
  }
  return f;
}

type Painted = { x0: number; y0: number; w: number; h: number; data: Uint8ClampedArray };

// Runs a shader over the field: [r, g, b, alpha 0..1] or null for nothing.
function paint(f: Field, shader: (i: number) => number[] | null): Painted {
  const data = new Uint8ClampedArray(f.w * f.h * 4);
  for (let i = 0; i < f.w * f.h; i++) {
    if (f.d[i] === Infinity) continue;
    const c = shader(i);
    if (!c) continue;
    const o = i * 4;
    data[o] = c[0];
    data[o + 1] = c[1];
    data[o + 2] = c[2];
    data[o + 3] = Math.round(255 * Math.min(1, c[3]));
  }
  return { x0: f.x0, y0: f.y0, w: f.w, h: f.h, data };
}

// ---- The per-drawing cache ----------------------------------------------------------

// One bitmap per stroke, kept while the stroke's inputs and drawing index
// stay the same. The key covers everything the bitmap depends on, so a hit
// gives exactly what a fresh render would.
interface Cached { key: string; buf: Scratch; x0: number; y0: number; w: number; h: number }
const caches = new WeakMap<MakeScratch, Map<string, Cached>>();

function stamp(ctx: BrushTarget, make: MakeScratch, brush: string, s: SolidStroke, render: () => Painted | null) {
  let cache = caches.get(make);
  if (!cache) caches.set(make, (cache = new Map()));
  const slot = `${brush}:${s.id}`;
  const key = cacheKey(s);
  let hit = cache.get(slot);
  if (!hit || hit.key !== key) {
    const out = render();
    if (!out) return;
    let buf = hit?.buf;
    if (!buf || buf.canvas.width < out.w || buf.canvas.height < out.h) buf = make(Math.max(out.w, buf?.canvas.width ?? 0), Math.max(out.h, buf?.canvas.height ?? 0));
    buf.ctx.setTransform(1, 0, 0, 1, 0, 0);
    buf.ctx.clearRect(0, 0, buf.canvas.width, buf.canvas.height);
    const img = buf.ctx.getImageData(0, 0, out.w, out.h);
    img.data.set(out.data);
    buf.ctx.putImageData(img, 0, 0);
    hit = { key, buf, x0: out.x0, y0: out.y0, w: out.w, h: out.h };
    cache.set(slot, hit);
  }
  ctx.drawImage(hit.buf.canvas as never, 0, 0, hit.w, hit.h, hit.x0, hit.y0, hit.w, hit.h);
}

function cacheKey(s: SolidStroke): string {
  // FNV-1a over the points and pressure, to 1/64 px.
  let h = 0x811c9dc5;
  const add = (v: number) => {
    h ^= Math.round(v * 64) | 0;
    h = Math.imul(h, 0x01000193);
  };
  for (const [x, y] of s.points) {
    add(x);
    add(y);
  }
  for (const p of s.pressure) add(p);
  return `${s.k}|${s.color}|${s.accent}|${s.scale}|${JSON.stringify(s.settings)}|${s.points.length}|${h >>> 0}`;
}

// ---- Small helpers ------------------------------------------------------------------

function unit(v: number[]): number[] {
  const m = Math.hypot(...v);
  return v.map((c) => c / m);
}

function fbm(x: number, y: number, seed: number): number {
  return valueNoise(x, y, seed) * 0.55 + valueNoise(x * 2.1, y * 2.1, seed + 1) * 0.3 + valueNoise(x * 4.3, y * 4.3, seed + 2) * 0.15;
}
