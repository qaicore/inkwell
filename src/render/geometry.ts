// Geometry, noise and color helpers shared by the brushes and the flame aura
// (SPEC §8.6, §8.8). No Math.random anywhere: everything is seeded, so a
// render repeats exactly.
import type { Vec2 } from '../types/effect.ts';

// A polyline that answers, for any point, how far along it and how far to
// the side of it that point is (signed: + is to the right of travel).
export class Centerline {
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
export function grainNoise(u: number, v: number, seed: number): number {
  return 0.65 * valueNoise(u, v, seed) + 0.35 * valueNoise(u * 2.3 + 17.1, v * 2.3 - 5.3, seed + 7919);
}

export function valueNoise(u: number, v: number, seed: number): number {
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
export function hash01(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function bounds(pts: Vec2[], pad: number): { x0: number; y0: number; w: number; h: number } | null {
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

export function rgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const hex = ([r, g, b]: number[]) => `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;

export function mixWhite(color: string, w: number): string {
  return hex(rgb(color).map((c) => Math.round(c + (255 - c) * w)));
}

export function mixBlack(color: string, k: number): string {
  return hex(rgb(color).map((c) => Math.round(c * (1 - k))));
}

// Smoothstep from a to b (either order).
export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export const mix = (a: number[], b: number[], w: number): number[] => a.map((c, i) => c + (b[i] - c) * w);
