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
//
// Emergence (an 'emerge' moment): the stroke grows out of its root like a
// live cord. Over EMERGE.grow drawings it extends to full length, eased out,
// with a hot pulse riding its head: the last stretch of it drawn pale and
// wide, a bigger glow, a bright bead at the tip. On the next EMERGE.pop
// drawings it pops: the whole bolt flashes (a wider, paler core and a
// stronger bloom) and a burst of sparks flies off the tip and along it,
// spreading and thinning on the second drawing. Then it's the normal bolt.
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
export const EMERGE = { grow: 4, pop: 2 }; // drawings
const PULSE = 0.3; // share of the grown length the pulse covers
const SPARKS = 14;

const signed = (a: number, b: number, c: number) => hash01(a, b, c) * 2 - 1;

export interface ElectricStroke {
  id: number;
  k: number;
  points: Vec2[]; // target px
  color: string;
  settings: BrushSettings;
  scale: number;
  emerge?: number; // drawings since its emerge moment (negative: not out yet); missing = always out
}

export function drawElectric(ctx: BrushTarget, make: MakeScratch, s: ElectricStroke) {
  const age = s.emerge;
  if (age !== undefined && age < 0) return;
  const growing = age !== undefined && age < EMERGE.grow;
  const pop = age !== undefined && !growing && age < EMERGE.grow + EMERGE.pop ? age - EMERGE.grow : -1; // 0, 1 while popping
  const grown = growing ? 1 - (1 - (age + 1) / EMERGE.grow) ** 2 : 1;
  const bolt = s.settings.bolt ?? ELECTRIC_BOLT;
  const width = s.settings.size * s.scale;
  const b = bend(growing ? cut(s.points, grown) : s.points, s.id, s.k, bolt, s.settings.size, s.scale);
  if (!b) return;
  const flash = pop === 0 ? 1 : pop === 1 ? 0.45 : 0;
  if (s.settings.glow) {
    const glow = { radiusPx: s.settings.glow.radiusPx * (1 + 0.7 * flash), intensity: Math.min(1, s.settings.glow.intensity * (1 + 1.2 * flash)) };
    drawGlow(ctx, make, { id: s.id, k: s.k, points: b.path, color: s.color, scale: s.scale, glow }, flash > 0 ? 0 : FLICKER);
  }
  const band = (path: Vec2[], pressure: number[], size: number, color: string) =>
    fillOutline(ctx, strokeOutline(path, pressure, { size, thinning: 0.95, smoothing: 0.5, streamline: 0 }, 1, 'taper'), color);
  band(b.path, b.width, width * 1.18, mixBlack(s.color, 0.55));
  band(b.path, b.width, width, s.color);
  band(shifted(b, 0.12, width), b.width.map((w, i) => Math.min(w, b.core[i] * (1.3 + flash))), width * (0.62 + 0.2 * flash), mixWhite(s.color, 0.55 + 0.3 * flash));
  band(shifted(b, 0.2, width), b.core.map((c) => Math.min(1, c * (1 + flash))), width * (0.36 + 0.24 * flash), mixWhite(s.color, 0.94));
  if (growing) drawPulse(ctx, make, b, s, width);
  else drawShards(ctx, b.path, s, bolt.shards);
  if (pop >= 0) drawSparks(ctx, b.path, s, pop);
}

// The first `share` of a polyline by length.
function cut(pts: Vec2[], share: number): Vec2[] {
  const line = new Arc(pts);
  const end = line.total * share;
  const out: Vec2[] = [pts[0]];
  for (let i = 1; i < pts.length && line.cum[i] < end; i++) out.push(pts[i]);
  out.push(line.at(end).p);
  return out;
}

// The current riding the head of a growing cord: its last PULSE of length
// drawn hot and wide, with a stronger glow, and a bright bead at the tip.
function drawPulse(ctx: BrushTarget, make: MakeScratch, b: Bent, s: ElectricStroke, width: number) {
  const n = b.path.length;
  const path = b.path.slice(Math.max(0, Math.floor(n * (1 - PULSE))));
  if (path.length < 2) return;
  const ramp = path.map((_, i) => 0.3 + 0.7 * (i / (path.length - 1))); // fat at the head
  if (s.settings.glow) {
    const glow = { radiusPx: s.settings.glow.radiusPx * 1.4, intensity: Math.min(1, s.settings.glow.intensity * 1.8) };
    drawGlow(ctx, make, { id: s.id, k: s.k, points: path, color: s.color, scale: s.scale, glow }, 0);
  }
  const hot = (size: number, color: string) =>
    fillOutline(ctx, strokeOutline(path, ramp, { size, thinning: 0.8, smoothing: 0.5, streamline: 0 }, 1, 'taper'), color);
  hot(width * 0.9, mixWhite(s.color, 0.7));
  hot(width * 0.5, mixWhite(s.color, 0.95));
  const [tx, ty] = b.path[n - 1];
  const r = width * 0.55;
  const bead: Vec2[] = [];
  for (let q = 0; q < 8; q++) bead.push([tx + Math.cos((q * Math.PI) / 4) * r, ty + Math.sin((q * Math.PI) / 4) * r]);
  fillOutline(ctx, bead, mixWhite(s.color, 0.95));
}

// The pop: SPARKS slivers flying off, most from the tip, some from along the
// bolt, flung out along the bolt's direction and to the sides. The same
// sparks on both drawings; on the second they're farther out, shorter and
// thinner.
function drawSparks(ctx: BrushTarget, path: Vec2[], s: ElectricStroke, pop: number) {
  const line = new Arc(path);
  const end = line.at(line.total);
  const ahead: Vec2 = [end.ny, -end.nx]; // the bolt's direction at the tip
  for (let j = 0; j < SPARKS; j++) {
    const r = (q: number) => hash01(s.id, j, q);
    const atTip = r(107) < 0.65;
    const from = atTip ? end : line.at(line.total * (0.3 + 0.6 * r(109)));
    const side = r(113) < 0.5 ? -1 : 1;
    const spread = (r(127) * 2 - 1) * 1.6;
    const dir: Vec2 = atTip
      ? [ahead[0] * Math.cos(spread) - ahead[1] * Math.sin(spread), ahead[0] * Math.sin(spread) + ahead[1] * Math.cos(spread)]
      : [from.nx * side, from.ny * side];
    const out = (10 + 30 * r(131)) * (pop + 1) * s.scale;
    const thin = pop === 0 ? 1 : 0.6;
    const len = (14 + 22 * r(137)) * thin * s.scale;
    const wid = (2.5 + 2.5 * r(139)) * thin * s.scale;
    const c: Vec2 = [from.p[0] + dir[0] * out, from.p[1] + dir[1] * out];
    const across: Vec2 = [-dir[1] * wid, dir[0] * wid];
    ctx.fillStyle = r(149) < 0.5 ? mixWhite(s.color, 0.9) : mixWhite(s.color, 0.5);
    ctx.beginPath();
    ctx.moveTo(c[0] + dir[0] * len, c[1] + dir[1] * len);
    for (const [x, y] of [
      [c[0] + across[0], c[1] + across[1]],
      [c[0] - dir[0] * len * 0.4, c[1] - dir[1] * len * 0.4],
      [c[0] - across[0], c[1] - across[1]],
    ]) ctx.quadraticCurveTo(x, y, x, y);
    ctx.closePath();
    ctx.fill();
  }
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
