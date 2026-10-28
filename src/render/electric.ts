// The electric brush (SPEC §8.8): a cel-shaded bolt, not a thin zigzag.
//   - Path: the simulated centerline bent sideways at nodes every
//     `bolt.bendPx`, by up to `bolt.ampPx`; most joins are smooth (cosine),
//     a share (`bolt.elbows`) are straight, which makes sharp corners.
//   - Width swells and pinches along it (seeded), to pointed ends.
//   - Flat bands, no gradients: a dark rim, the stroke color, a pale band and
//     a white core, the inner two pushed to one side and pinching on their
//     own, so the core breaks up.
//   - A wide bloom behind: the neon glow at a bigger radius, flickering
//     between 0.6× and 1× per drawing.
//   - Up to `bolt.shards` small angular chips beside it.
// Every offset is seeded by stroke id and drawing index k, so the bolt takes a
// new shape each drawing, on 2s, and re-renders identically. The root doesn't
// move, so it stays attached, and the physics underneath is unchanged.
import type { BrushSettings, Vec2 } from '../types/effect.ts';
import { fillOutline, strokeOutline } from './brush.ts';
import { hash01, mixBlack, mixWhite } from './geometry.ts';
import { drawGlow, type BrushTarget, type MakeScratch } from './glow.ts';

export const ELECTRIC_SIZE = 19; // px at its widest, at 1080 wide
export const ELECTRIC_BOLT = { bendPx: 38, ampPx: 18, elbows: 0.55, shards: 5 };
export const ELECTRIC_GLOW = { radiusPx: 26, intensity: 0.55 };
const FLICKER = 0.4; // the bloom drops to 0.6× at most on a drawing
const SHARD_OFF = [16, 42]; // px from the bolt, at 1080 wide
const SHARD_LEN = [6, 18];

const signed = (a: number, b: number, c: number) => hash01(a, b, c) * 2 - 1;

export interface ElectricStroke {
  id: number;
  k: number;
  points: Vec2[]; // target px
  color: string;
  settings: BrushSettings;
  scale: number;
}

export function drawElectric(ctx: BrushTarget, make: MakeScratch, s: ElectricStroke) {
  const bolt = s.settings.bolt ?? ELECTRIC_BOLT;
  const width = s.settings.size * s.scale;
  const b = bend(s.points, s.id, s.k, bolt, s.settings.size, s.scale);
  if (!b) return;
  if (s.settings.glow) drawGlow(ctx, make, { id: s.id, k: s.k, points: b.path, color: s.color, scale: s.scale, glow: s.settings.glow }, FLICKER);
  const band = (path: Vec2[], pressure: number[], size: number, color: string) =>
    fillOutline(ctx, strokeOutline(path, pressure, { size, thinning: 0.95, smoothing: 0.5, streamline: 0 }, 1, 'taper'), color);
  band(b.path, b.width, width * 1.18, mixBlack(s.color, 0.55));
  band(b.path, b.width, width, s.color);
  band(shifted(b, 0.12, width), b.width.map((w, i) => Math.min(w, b.core[i] * 1.3)), width * 0.62, mixWhite(s.color, 0.55));
  band(shifted(b, 0.2, width), b.core, width * 0.36, mixWhite(s.color, 0.94));
  drawShards(ctx, b.path, s, bolt.shards);
}

interface Bent {
  path: Vec2[];
  width: number[]; // 0..1 of the brush size
  core: number[];
  side: number; // which side the inner bands lean to
}

// The centerline bent by seeded offsets. A thin bolt kinks tighter: bends
// scale with its size (never below a third, never above the settings).
function bend(pts: Vec2[], id: number, k: number, bolt: NonNullable<BrushSettings['bolt']>, size: number, scale: number): Bent | null {
  const line = new Arc(pts);
  if (!(line.total > 0)) return null;
  const fit = Math.min(1, Math.max(1 / 3, size / ELECTRIC_SIZE));
  const step = bolt.bendPx * fit * scale;
  const nodes = Math.max(2, Math.round(line.total / step) + 1);
  const bends = curve(id, k, 11, nodes, bolt.elbows);
  const swell = curve(id, k, 17, nodes * 2, 0.4);
  const pinch = curve(id, k, 23, nodes * 3, 0.5);
  const n = Math.max(24, Math.round(line.total / 3));
  const path: Vec2[] = [];
  const width: number[] = [];
  const core: number[] = [];
  for (let i = 0; i < n; i++) {
    const at = (line.total * i) / (n - 1);
    const x = (at / line.total) * (nodes - 1);
    const { p, nx, ny } = line.at(at);
    const ramp = Math.min(1, at / step); // the root stays put
    const d = bolt.ampPx * fit * scale * ramp * bends(x);
    path.push([p[0] + nx * d, p[1] + ny * d]);
    const ends = Math.min(1, (at / line.total) * 6, ((line.total - at) / line.total) * 4); // pointed ends
    width.push(Math.max(0.05, ends * (0.5 + 0.5 * swell(x * 2)) ** 1.5));
    core.push(Math.max(0.02, ends * (0.5 + 0.5 * pinch(x * 3))));
  }
  return { path, width, core, side: hash01(id, k, 29) < 0.5 ? -1 : 1 };
}

// A seeded curve along the stroke, -1..1: values at nodes, joined smoothly
// or, at an elbow, straight.
function curve(id: number, k: number, salt: number, nodes: number, elbows: number) {
  const v = Array.from({ length: nodes }, (_, j) => signed(id, k * 977 + j, salt));
  const sharp = Array.from({ length: nodes }, (_, j) => hash01(id, k * 977 + j, salt + 1) < elbows);
  return (x: number) => {
    const j = Math.min(nodes - 2, Math.max(0, Math.floor(x)));
    const f = x - j;
    const e = sharp[j] ? f : (1 - Math.cos(Math.PI * f)) / 2;
    return v[j] + (v[j + 1] - v[j]) * e;
  };
}

// The path pushed sideways by `by` × its width at each point.
function shifted(b: Bent, by: number, width: number): Vec2[] {
  const line = new Arc(b.path);
  return b.path.map((_, i) => {
    const { p, nx, ny } = line.at(line.cum[i]);
    const o = by * b.side * width * b.width[i];
    return [p[0] + nx * o, p[1] + ny * o];
  });
}

function drawShards(ctx: BrushTarget, path: Vec2[], s: ElectricStroke, most: number) {
  const line = new Arc(path);
  const count = Math.floor(hash01(s.id, s.k, 71) * (most + 1));
  for (let j = 0; j < count; j++) {
    const r = (q: number) => hash01(s.id, s.k * 53 + j, q);
    const { p, nx, ny } = line.at(line.total * (0.15 + 0.8 * r(73)));
    const tx = ny;
    const ty = -nx;
    const side = r(79) < 0.5 ? -1 : 1;
    const off = (SHARD_OFF[0] + (SHARD_OFF[1] - SHARD_OFF[0]) * r(83)) * s.scale * side;
    const c: Vec2 = [p[0] + nx * off, p[1] + ny * off];
    const len = (SHARD_LEN[0] + (SHARD_LEN[1] - SHARD_LEN[0]) * r(89)) * s.scale;
    const wid = (2 + 4 * r(97)) * s.scale;
    const lean = signed(s.id, s.k * 53 + j, 101) * 0.6;
    const ax: Vec2 = [tx + nx * lean, ty + ny * lean];
    ctx.fillStyle = r(103) < 0.5 ? s.color : mixWhite(s.color, 0.55);
    ctx.beginPath();
    ctx.moveTo(c[0] + ax[0] * len, c[1] + ax[1] * len);
    for (const [x, y] of [
      [c[0] + nx * wid, c[1] + ny * wid],
      [c[0] - ax[0] * len * 0.6, c[1] - ax[1] * len * 0.6],
      [c[0] - nx * wid * 0.5, c[1] - ny * wid * 0.5],
    ]) ctx.quadraticCurveTo(x, y, x, y); // straight edges: PathTarget has no lineTo
    ctx.closePath();
    ctx.fill();
  }
}

// A polyline by arc length: the point and unit normal at any distance along it.
class Arc {
  readonly cum: number[];
  readonly total: number;
  private readonly pts: Vec2[];
  constructor(pts: Vec2[]) {
    this.pts = pts;
    this.cum = [0];
    for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    this.total = this.cum[this.cum.length - 1];
  }
  at(s: number): { p: Vec2; nx: number; ny: number } {
    const { pts, cum } = this;
    let i = 1;
    while (i < pts.length - 1 && cum[i] < s) i++;
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const len = cum[i] - cum[i - 1] || 1;
    const u = Math.min(1, Math.max(0, (s - cum[i - 1]) / len));
    return { p: [ax + (bx - ax) * u, ay + (by - ay) * u], nx: -(by - ay) / len, ny: (bx - ax) / len };
  }
}
