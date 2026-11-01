// The dust band and wall (impact design §6, "Dust"; destruction §4.5, §6.5):
// khaki dust along the floor line, from A1 on, drawn over the base of the
// fire and the cluster and behind the person.
//   - One band with a torn, lumpy top (destruction §4.5, "Construction"): a
//     thin torn rim along the floor line, and plumes standing on it, each the
//     top of 1–4 puffs stacked from the creep line, narrowing upward, leaning
//     away from P and torn along the top. The band's half-width (half of
//     t02..t98, the way destruction §4.5 reads it) is 0.45 U at A1 → 0.6 U
//     from A7. Under the plumes it reaches below the line by the measured
//     near-side creep (0.04 → 0.11 U), and they stand up as a wall: 0.16–0.26
//     U at P on A3–8 (it hides the cluster's base there), 0.3–0.48 U on the
//     flanks, tapering at the far −t end. Streaks climb into the cluster from
//     A7. On g1 there is no rim yet, only low plumes (k15's thin rims along
//     the burst's base).
//   - A foot plume stands on P and two low caps end the band in every
//     drawing; the other plumes stand on every other step of a 0.13 U
//     lattice, and the next drawing's in the gaps, so the groups before g6 are
//     redrawn rather than held (IoU ≤ 0.3, destruction measured 0.29). The rim
//     is kept thin (0.016–0.022 U) to leave that intact. From g6 a seeded
//     50–70 % of the plumes carry over with their torn tops (the band's edge
//     points), jittered, the rim keeps its teeth, and new plumes fill up to
//     the area (IoU 0.45–0.75).
//   - Each group's plume heights are scaled by bisection to its area (a
//     carried group short of it by 5 % stands the new plumes its pick passed
//     over too). Up to 8 seeded drawings are tried per group, and the first
//     within 10 % of its area and inside its IoU band (≤ 0.27 redrawn,
//     0.48–0.72 carried) is kept, else the nearest. A group's drawing depends
//     on the last group's, so building g builds g−1 first (memoized).
//   - The fill is the measured luma ladder in cel steps: the dominant tone,
//     which darkens 1.5 luma a drawing, over a floor tone 12 darker along the
//     line, the step's edge torn; the tops inside the cluster (above 0.31 U)
//     and the streaks take the flat highlight #9e8f7c.
// The dust wash veil of A5–6 is WP9's (washes.ts), with the A5–6 flash.
// Everything here is in U (× the group's zoom factor, see fire.ts) in the
// floor frame; the cluster reads this layer's cells to know what it covers.
import type { GlowSink } from '../contracts.ts';
import type { BrushTarget } from '../../render/glow.ts';
import { smoothstep } from '../../render/geometry.ts';
import { DUST, mixHex } from '../palette.ts';
import { int, rng, uniform, type Rng } from '../rng.ts';
import {
  CARRY_FROM, GROUP_AGE, LAST_MEASURED, cellN, clamp, gridIoU, gridStats, jitter, massClock, massFrame, massKey, memo, newGrid, paint, shuffled,
  stampPolygon, toFrame, ROWS, COLS, VISIBLE_REACH, CELL, cellT,
  type FloorPt, type Grid, type MassContext, type MassDrawing, type MassShape,
} from './fire.ts';

// Per hold group g0..g8 (g0 has no dust; groups past g8 keep g8's).
export const DUST_HALF_WIDTH = [0, 0.45, 0.46, 0.5, 0.57, 0.58, 0.6, 0.6, 0.6]; // U, along the floor line: half of t02..t98
export const DUST_DEPTH = [0, 0.04, 0.04, 0.05, 0.08, 0.09, 0.1, 0.11, 0.11]; // U below the line: the near side's creep
const TOP_MID = [0, 0.05, 0.16, 0.26, 0.24, 0.05, 0.05, 0.05, 0.05]; // U: the wall at P (|t| ≤ 0.12); the cluster's base shows over it from g5
const TOP_SIDE = [0, 0.06, 0.3, 0.48, 0.45, 0.3, 0.22, 0.2, 0.2]; // U: the wall on the flanks
export const DUST_AREA = [0, 0.038, 0.104, 0.255, 0.283, 0.184, 0.203, 0.17, 0.17]; // U² (destruction §4.5; g7–8 between the flooded readings)
const RIM = [0, 0, 0.016, 0.02, 0.02, 0.016, 0.016, 0.022, 0.022]; // U: the torn rim's thickness about the line (none on g1)
const REACH_PAD = 0.035; // U: the band runs this far past its half-width, since t02..t98 trims its thin ends
const STREAKS_FROM = 4; // A7
const PLUME_STEP = 0.13; // U: one drawing's plumes stand 2 steps apart; the next drawing's in between
const PLUME_HALF = [0.5, 0.64]; // a plume's half-width at its foot, in steps
const PLUME_REACH = 1.3; // its puffs' wobble and lean reach this many half-widths out
const FOOT_HALF = [0.11, 0.14]; // U: the foot plume on P, in every drawing
const FOOT_CLEAR = 0.09; // U: no lattice plume this near P; the foot stands there
const MID_REACH = 0.12; // U: a plume standing this near P …
const MID_CAP = 1.25; // … stays within this × the wall's height there
const CAP_HALF = 0.06; // U: the low plume that ends the band at both ends in every drawing
const CAP_H = 0.035; // U: its top
const TAPER = 0.35; // the top puff is this much narrower than the bottom one
const LEAN = 0.5; // a plume's top puff stands off its foot by up to this × LEAN_SHIFT half-widths, away from P
const LEAN_SHIFT = 0.5;
const PLUME_JITTER = 0.015; // U: a carried plume's move, along the line and in height (≤ 0.05)
const CARRY = [0.5, 0.7]; // the share of plumes a group keeps from g6 on
const TRIES = 8; // drawings tried for a group whose IoU or area misses
const SHORT = 0.95; // a carried group this short of its area stands the passed-over plumes too
const IOU_FRESH = 0.27; // a redrawn group's IoU with the last, at most (≤ 0.3)
const IOU_BAND = [0.48, 0.72]; // a carried group's, inside 0.45–0.75
const SAMPLE = 0.008; // U: the band is sampled this finely along the line, and at every tooth of its outline
const SIMPLIFY = 0.0006; // U: outline points closer than this to the line through their neighbours are dropped
const TOOTH: readonly [number, number] = [0.014, 0.034]; // U: a tooth's width along a torn edge
const TEAR = 0.1; // a plume's teeth stand out this share of its height,
const TEAR_MAX = 0.03; // U: at most this
const STEP_AT = 0.04; // U over the line: where the dominant tone takes over from the floor tone
const STEP_TEAR = 0.02; // U: how far a cel step's torn edge strays
const FLOOR_DARKER = 12; // luma: the floor tone under the dominant one
const HIGHLIGHT_ABOVE = 0.31; // U: a top above this is inside the cluster: the flat highlight
// The measured palette peaks, luma → tone (destruction §4.5).
const LADDER: readonly (readonly [number, string])[] = [
  [89, '#665745'], [95, '#6c5e4b'], [103, '#756553'], [110, '#7b6c5a'], [116, '#82735e'], [124, '#897a67'], [132, '#92836e'], [145, DUST.highlight],
];

// A torn edge: tips and notches along it, alternately out (0.55–1) and in
// (0.2–0.45), half a tooth's width apart, and 0 at both ends; the edge's
// offset is linear between them. A plume has its own, in half-widths.
interface Torn {
  x: number[];
  o: number[];
}

export interface Plume {
  t: number; // its foot's centre along the line, U
  half: number; // its foot's half-width, U
  rise: number; // × the wall's height
  lean: number; // −1..1: which way and how far its top puff stands off its foot
  draws: number[]; // the puffs' wobble and widths
  top: Torn; // its torn top: it carries over with the plume
  H: number; // its height over the line, U, once placed
}
export interface Streak {
  pts: FloorPt[]; // a closed polygon
}
// The band along the line: its top and bottom at each sample.
interface Band {
  ts: number[];
  top: number[];
  bot: number[];
}
export interface DustState {
  g: number;
  phase: 0 | 1; // which half of the lattice the plumes stand on
  plumes: Plume[]; // placed, but for the caps: what carries over
  caps: Plume[]; // the two low plumes that end the band, made anew for every group
  rim: number; // U: the rim's thickness (0: no rim)
  edges: Torn[]; // the rim's top and bottom, the cel step's and the highlight's
  streaks: Streak[];
  band: Band;
  grid: Grid; // the cells it covers (what it hides of the cluster)
  area: number; // U², within 1.2 U of P
}

interface Profile {
  W: number; // how far the band runs along the floor line
  top(t: number): number; // the wall's height at t
  low(t: number): number; // the band's lowest n at t (≤ 0)
}

function profile(gi: number): Profile {
  const W = DUST_HALF_WIDTH[gi] + REACH_PAD;
  const depth = DUST_DEPTH[gi];
  const mid = TOP_MID[gi];
  const side = TOP_SIDE[gi];
  return {
    W,
    top: (t) => {
      const u = Math.abs(t) / W;
      const h = (mid + (side - mid) * smoothstep(0.12, 0.32, Math.abs(t))) * (1 - (t < 0 ? 0.55 : 0.3) * smoothstep(0.7, 1, u));
      return Math.max(0.03, h);
    },
    low: (t) => -depth * (0.55 + 0.45 * Math.cos((Math.PI / 2) * Math.min(1, Math.abs(t) / W))),
  };
}

// The dominant luma at reference age A: 110 at A3, 1.5 darker a drawing, 89 at A17.
const dominant = (A: number) => clamp(110 - 1.5 * (A - 3), 89, 112);

export function ladder(y: number): string {
  if (y <= LADDER[0][0]) return LADDER[0][1];
  for (let i = 1; i < LADDER.length; i++) {
    if (y <= LADDER[i][0]) return mixHex(LADDER[i - 1][1], LADDER[i][1], (y - LADDER[i - 1][0]) / (LADDER[i][0] - LADDER[i - 1][0]));
  }
  return LADDER[LADDER.length - 1][1];
}

function torn(r: Rng, from: number, to: number, step: readonly [number, number]): Torn {
  const x = [from];
  const o = [0];
  let out = r() < 0.5;
  for (let at = from + uniform(r, step[0], step[1]) / 2; at < to - step[0] / 2; at += uniform(r, step[0], step[1]) / 2) {
    x.push(at);
    o.push(out ? uniform(r, 0.55, 1) : -uniform(r, 0.2, 0.45));
    out = !out;
  }
  x.push(to);
  o.push(0);
  return { x, o };
}

function tornAt(e: Torn, u: number): number {
  const { x, o } = e;
  if (!(u > x[0] && u < x[x.length - 1])) return 0;
  let lo = 0;
  let hi = x.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (x[mid] <= u) lo = mid;
    else hi = mid;
  }
  return o[lo] + ((o[hi] - o[lo]) * (u - x[lo])) / (x[hi] - x[lo]);
}

// A plume's torn top, in half-widths of a plume `half` U wide.
const topOf = (r: Rng, half: number) => torn(r, -PLUME_REACH, PLUME_REACH, [TOOTH[0] / half, TOOTH[1] / half]);

// The plumes lean away from P, more the farther out they stand.
const leanAt = (t: number) => Math.sign(t) * LEAN * smoothstep(0.05, 0.35, Math.abs(t));

// A plume's height at the group's scale. Near P the wall stays within
// MID_CAP × its own height whatever the scale, so the cluster's base shows
// over it from g5 (design §6, "The base").
const capAt = (p: Plume, pr: Profile) => (Math.abs(p.t) < MID_REACH ? pr.top(p.t) * MID_CAP : Infinity);
const plumeHeight = (p: Plume, pr: Profile, scale: number) => Math.min(capAt(p, pr), Math.max(0.03 * Math.min(1, scale), pr.top(p.t) * p.rise * scale));

// A plume as the old puffs stacked it, 1–4 from its creep line `low` up to
// its height: the top of their union at x half-widths from its foot's centre
// (−∞ off them). Each puff wobbles by its draw, narrows upward and stands
// off toward the lean.
function stackTop(p: Plume, low: number, x: number): number {
  const height = p.H - low;
  const count = Math.max(1, Math.min(4, Math.round(height / (2.1 * p.half))));
  const seg = height / count;
  const b = seg * 0.75;
  let up = -Infinity;
  for (let i = 0; i < count; i++) {
    const d = p.draws[i % p.draws.length];
    const up01 = count > 1 ? i / (count - 1) : 0;
    const a = (1 - TAPER * up01) * (0.92 + 0.16 * d);
    const c = i === count - 1 ? p.H - b : low + seg * (i + 0.5);
    const u = (x - (d - 0.5) * 0.4 - p.lean * LEAN_SHIFT * up01) / a;
    if (u > -1 && u < 1) up = Math.max(up, c + b * Math.sqrt(1 - u * u));
  }
  return up;
}

// The band's top and bottom at each sample: the rim's, and over each plume
// its torn top and its sag to the creep line under its bottom puff, whichever
// reaches farther.
function bandOf(plumes: readonly Plume[], pr: Profile, rim: number, edges: readonly Torn[]): Band {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of plumes) {
    lo = Math.min(lo, p.t - PLUME_REACH * p.half);
    hi = Math.max(hi, p.t + PLUME_REACH * p.half);
  }
  const raw: number[] = [];
  for (let t = lo; t < hi; t += SAMPLE) raw.push(t);
  raw.push(hi);
  for (const p of plumes) for (const x of p.top.x) raw.push(p.t + x * p.half);
  for (const e of edges.slice(0, 2)) for (const t of e.x) if (t > lo && t < hi) raw.push(t);
  raw.sort((a, b) => a - b);
  const ts: number[] = [];
  for (const t of raw) if (!ts.length || t - ts[ts.length - 1] > 1e-6) ts.push(t);
  const reach = pr.W - CAP_HALF;
  const top: number[] = [];
  const bot: number[] = [];
  for (const t of ts) {
    let up = 0;
    let down = 0;
    if (rim > 0 && Math.abs(t) <= reach) {
      up = rim * (0.45 + 0.4 * tornAt(edges[0], t));
      down = -rim * (0.55 + 0.3 * tornAt(edges[1], t));
    }
    const low = pr.low(t);
    for (const p of plumes) {
      const x = (t - p.t) / p.half;
      if (!(x > -PLUME_REACH && x < PLUME_REACH)) continue;
      const e = stackTop(p, pr.low(p.t), x);
      if (e === -Infinity) continue;
      up = Math.max(up, e + Math.min(TEAR_MAX, TEAR * p.H) * clamp(e / (0.3 * p.H), 0, 1) * tornAt(p.top, x));
      const u = (x - (p.draws[0] - 0.5) * 0.4) / (0.92 + 0.16 * p.draws[0]);
      down = Math.min(down, low * Math.sqrt(Math.max(0, 1 - Math.abs(u) ** 3)));
    }
    top.push(up);
    bot.push(down);
  }
  return { ts, top, bot };
}

// An open chain with the points that bend it by less than SIMPLIFY dropped
// (Douglas–Peucker): the samples along smooth stretches go, the teeth stay.
function simplified(pts: FloorPt[]): FloorPt[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [an, at] = pts[a];
    const dn = pts[b][0] - an;
    const dt = pts[b][1] - at;
    const len = Math.hypot(dn, dt) || 1;
    let far = 0;
    let at2 = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - an) * dt - (pts[i][1] - at) * dn) / len;
      if (d > far) {
        far = d;
        at2 = i;
      }
    }
    if (far > SIMPLIFY) {
      keep[at2] = 1;
      stack.push([a, at2], [at2, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

// The band's pieces between max(its bottom, floor) and its top, as closed
// polygons; where a piece ends between two samples it ends on the crossing.
function pieces(b: Band, floor: (t: number) => number): FloorPt[][] {
  const out: FloorPt[][] = [];
  const lower = (i: number) => Math.max(b.bot[i], floor(b.ts[i]));
  const gap = (i: number) => b.top[i] - lower(i);
  const cross = (i: number, k: number): FloorPt => {
    const u = gap(i) / (gap(i) - gap(k));
    return [lower(i) + (lower(k) - lower(i)) * u, b.ts[i] + (b.ts[k] - b.ts[i]) * u];
  };
  let up: FloorPt[] = [];
  let down: FloorPt[] = [];
  for (let i = 0; i < b.ts.length; i++) {
    if (gap(i) > 1e-4) {
      if (!up.length && i > 0) up.push(cross(i - 1, i));
      up.push([b.top[i], b.ts[i]]);
      down.push([lower(i), b.ts[i]]);
      continue;
    }
    if (up.length) {
      up.push(cross(i - 1, i));
      if (up.length + down.length >= 3) out.push([...simplified(up), ...simplified(down.reverse())]);
      up = [];
      down = [];
    }
  }
  if (up.length + down.length >= 3) out.push([...simplified(up), ...simplified(down.reverse())]);
  return out;
}

function streaksFor(r: Rng, pr: Profile, count: number): Streak[] {
  const out: Streak[] = [];
  for (let s = 0; s < count; s++) {
    const t0 = uniform(r, -0.3, 0.32);
    const n0 = Math.max(0.02, pr.top(t0) * 0.45);
    const n1 = uniform(r, 0.45, 0.55);
    const width = uniform(r, 0.03, 0.06);
    const amp = uniform(r, 0.015, 0.045);
    const freq = uniform(r, 1.2, 2.2);
    const ph = uniform(r, 0, 2 * Math.PI);
    const drift = uniform(r, -0.08, 0.08);
    const left: FloorPt[] = [];
    const right: FloorPt[] = [];
    const M = 10;
    for (let i = 0; i <= M; i++) {
      const u = i / M;
      const n = n0 + (n1 - n0) * u;
      const t = t0 + amp * Math.sin(ph + u * freq * Math.PI) + drift * u;
      const w = width * (0.45 + 0.55 * Math.sin(Math.PI * Math.min(1, 0.15 + u * 0.85))) * (1 - 0.6 * u);
      left.push([n, t - w / 2]);
      right.push([n, t + w / 2]);
    }
    out.push({ pts: [...left, ...right.reverse()] });
  }
  return out;
}

// The rim's top and bottom edges, then the cel step's and the highlight's, torn along the band.
function edgesOf(r: Rng, pr: Profile): Torn[] {
  const reach = pr.W - CAP_HALF;
  const wide = pr.W + 0.1;
  return [torn(r, -reach, reach, TOOTH), torn(r, -reach, reach, TOOTH), torn(r, -wide, wide, [0.02, 0.05]), torn(r, -wide, wide, [0.02, 0.05])];
}

const capsOf = (r: Rng, pr: Profile): Plume[] =>
  [-1, 1].map((s) => ({ t: s * (pr.W - CAP_HALF), half: CAP_HALF, rise: 1, lean: leanAt(s), draws: [r(), r(), r(), r()], top: topOf(r, CAP_HALF), H: CAP_H }));
// The caps thin with the band below scale 1 (the thin A1 band).
const capped = (caps: readonly Plume[], scale: number) => caps.map((c) => ({ ...c, H: CAP_H * Math.min(1, 0.4 + 0.6 * scale) }));

function dustOf(g: number, phase: 0 | 1, pr: Profile, rim: number, plumes: Plume[], caps: Plume[], edges: Torn[], streaks: Streak[]): DustState {
  const band = bandOf([...caps, ...plumes], pr, rim, edges);
  const grid = newGrid();
  for (const p of pieces(band, () => -Infinity)) stampPolygon(grid, p);
  for (const s of streaks) stampPolygon(grid, s.pts);
  return { g, phase, plumes, caps, rim, edges, streaks, band, grid, area: gridStats(grid).area };
}

// Scales `scale` by bisection until `build(scale)` covers `target` U².
function fitArea(target: number, build: (scale: number) => DustState, lo = 0.15, hi = 1.9): DustState {
  let best = build(1);
  let bestErr = Math.abs(best.area - target);
  for (let i = 0; i < 11; i++) {
    const mid = (lo + hi) / 2;
    const got = build(mid);
    if (Math.abs(got.area - target) < bestErr) {
      best = got;
      bestErr = Math.abs(got.area - target);
    }
    if (got.area < target) lo = mid;
    else hi = mid;
  }
  return best;
}

// A plume on the lattice: drawn whether or not it stands, so each group's
// stream stays in step.
function latticePlume(r: Rng, t: number, halfScale: number, rise: readonly [number, number]): Plume {
  const half = PLUME_STEP * uniform(r, PLUME_HALF[0], PLUME_HALF[1]) * halfScale;
  return { t, half, rise: uniform(r, rise[0], rise[1]), lean: leanAt(t), draws: [r(), r(), r(), r()], top: topOf(r, half), H: 0 };
}

// The foot: one wide plume on P, so the wall stands at P on either half of
// the lattice and the cluster's base is under it on A3–8.
function footPlume(r: Rng): Plume {
  const half = uniform(r, FOOT_HALF[0], FOOT_HALF[1]);
  return { t: uniform(r, -0.035, 0.035), half, rise: uniform(r, 1, 1.1), lean: 0, draws: [r(), r(), r(), r()], top: topOf(r, half), H: 0 };
}

function freshDust(seed: number, g: number, v: number): DustState {
  const gi = Math.min(g, LAST_MEASURED);
  const pr = profile(gi);
  const phase = (g >= CARRY_FROM ? 0 : g % 2) as 0 | 1;
  const r = v ? rng(seed, 'dust', g, 3, v) : rng(seed, 'dust', g);
  const plumes: Plume[] = [footPlume(r)];
  for (let k = -8; k <= 8; k++) {
    const p = latticePlume(r, (2 * k + phase) * PLUME_STEP + uniform(r, -0.15, 0.15) * PLUME_STEP, 1, [0.75, 1]);
    if (Math.abs(p.t) >= FOOT_CLEAR && Math.abs(p.t) <= pr.W - 0.05) plumes.push(p);
  }
  const streaks = gi >= STREAKS_FROM ? streaksFor(r, pr, int(r, 2, 4)) : [];
  const caps = capsOf(r, pr);
  const edges = edgesOf(r, pr);
  const build = (scale: number) =>
    dustOf(g, phase, pr, RIM[gi], plumes.map((p) => ({ ...p, H: plumeHeight(p, pr, scale) })), capped(caps, scale), edges, streaks);
  return fitArea(DUST_AREA[gi], build);
}

// From g6 on: keep a seeded 50–70 % of the last group's plumes with their
// torn tops, and the rim's teeth, jittered, and fill up to the area with new
// plumes between them. The caps are made anew at this group's reach.
function carriedDust(seed: number, g: number, prev: DustState, v: number): DustState {
  const gi = Math.min(g, LAST_MEASURED);
  const pr = profile(gi);
  const r = v ? rng(seed, 'dust', g, 3, v) : rng(seed, 'dust', g);
  const keep = Math.round(uniform(r, CARRY[0], CARRY[1]) * prev.plumes.length);
  const order = shuffled(prev.plumes.length, r);
  const kept: Plume[] = order.slice(0, keep).map((i) => {
    const p = prev.plumes[i];
    const moved = { ...p, t: p.t + uniform(r, -1, 1) * PLUME_JITTER };
    return { ...moved, H: Math.min(capAt(moved, pr), Math.max(0.02, p.H + uniform(r, -1, 1) * PLUME_JITTER)) };
  });
  const streaks = prev.streaks.map((s) => ({ pts: s.pts.map((p) => jitter(r, p, PLUME_JITTER / 2)) }));
  const rimEdges = prev.edges.slice(0, 2).map((e) => ({ x: e.x, o: e.o.map((o) => o * uniform(r, 0.85, 1.15)) }));
  const edges = [...rimEdges, ...edgesOf(r, pr).slice(2)];
  const caps = capped(capsOf(r, pr), 1);
  // New plumes anywhere along the band, on the same half of the lattice.
  const fresh: Plume[] = [];
  const spare: Plume[] = [];
  for (let k = -8; k <= 8; k++) {
    const p = latticePlume(r, (2 * k + prev.phase) * PLUME_STEP + uniform(r, -0.5, 0.5) * PLUME_STEP, 0.85, [0.55, 1]);
    const pick = r() <= 0.55;
    if (Math.abs(p.t) <= pr.W - 0.05) (pick ? fresh : spare).push(p);
  }
  const fit = (more: readonly Plume[]) => {
    const standing = [...fresh, ...more];
    const build = (scale: number) =>
      dustOf(g, prev.phase, pr, RIM[gi], [...kept, ...standing.map((p) => ({ ...p, H: plumeHeight(p, pr, scale) }))], caps, edges, streaks);
    return fitArea(DUST_AREA[gi], build, 0.1, 1.9);
  };
  const got = fit([]);
  // Too few new plumes to make up the area: the ones the pick passed over stand too.
  return got.area < SHORT * DUST_AREA[gi] && spare.length ? fit(spare) : got;
}

const STATES = new Map<string, DustState>();

// A group's dust, drawn again on its own stream (up to TRIES times) while its
// IoU with the last group's misses the measures (at most 0.3 before g6 → g7,
// inside 0.45–0.75 after) or its area misses by more than 10 %; the nearest
// is kept.
function buildDust(seed: number, g: number): DustState {
  if (g <= 1) return freshDust(seed, g, 0);
  const prev = dustState(seed, g - 1);
  const carried = g > CARRY_FROM;
  const make = (v: number) => (carried ? carriedDust(seed, g, prev, v) : freshDust(seed, g, v));
  const target = DUST_AREA[Math.min(g, LAST_MEASURED)];
  const miss = (s: DustState) => {
    const iou = gridIoU(prev.grid, s.grid);
    const off = carried ? Math.max(0, IOU_BAND[0] - iou, iou - IOU_BAND[1]) : Math.max(0, iou - IOU_FRESH);
    return Math.max(off / 0.02, Math.abs(s.area / target - 1) / 0.1 - 1, 0);
  };
  let best = make(0);
  let bestMiss = miss(best);
  for (let v = 1; v < TRIES && bestMiss > 0; v++) {
    const s = make(v);
    const m = miss(s);
    if (m < bestMiss) {
      best = s;
      bestMiss = m;
    }
  }
  return best;
}

// The dust of hold group g (1 and up), in U in the floor frame: pure in (seed, g).
export function dustState(seed: number, g: number): DustState {
  return memo(STATES, `${seed}|${g}`, () => buildDust(seed, g));
}

// A group's fill as polygons in paint order: the band in the floor tone, the
// dominant tone over it from the torn step up, and the highlight on the tops
// inside the cluster.
interface Fill {
  role: string;
  color: string;
  polys: FloorPt[][];
}
const FILLS = new WeakMap<DustState, Fill[]>();
function fillsOf(state: DustState): Fill[] {
  const hit = FILLS.get(state);
  if (hit) return hit;
  const y = dominant(GROUP_AGE[Math.min(state.g, LAST_MEASURED)]);
  const above = (at: number, edge: Torn) => (t: number) => at + STEP_TEAR * tornAt(edge, t);
  const fills = [
    { role: 'dust-floor', color: ladder(y - FLOOR_DARKER), polys: pieces(state.band, () => -Infinity) },
    { role: 'dust', color: ladder(y), polys: pieces(state.band, above(STEP_AT, state.edges[2])) },
    { role: 'dust-top', color: DUST.highlight, polys: pieces(state.band, above(HIGHLIGHT_ABOVE, state.edges[3])) },
  ];
  FILLS.set(state, fills);
  return fills;
}

export interface DustDrawing extends MassDrawing {
  g: number;
  A: number;
  unit: number; // px per mass unit on this frame
  state: DustState;
}

// The dust on frame f: hold group 1 on (A1+), until J_end; null elsewhere.
export function shapes(ictx: MassContext, f: number): DustDrawing | null {
  const clock = massClock(ictx, f);
  if (!clock || clock.g < 1) return null;
  const state = dustState(ictx.seed, clock.g);
  const fr = massFrame(ictx);
  const unit = fr.U * clock.zoom;
  const px = (pts: readonly FloorPt[]) => pts.map((p) => toFrame(fr, unit, p));
  const out: MassShape[] = [];
  for (const fill of fillsOf(state)) for (const p of fill.polys) out.push({ role: fill.role, points: px(p), color: fill.color });
  for (const s of state.streaks) out.push({ role: 'streak', points: px(s.pts), color: DUST.highlight, round: true });
  return {
    layer: 'behind',
    key: `dust:${massKey(ictx)}:${clock.g}:${unit.toFixed(3)}`,
    alpha: clock.alpha,
    shapes: out,
    g: clock.g,
    A: clock.A,
    unit,
    state,
  };
}

export function draw(ctxBehind: BrushTarget, _ctxFront: BrushTarget, _sink: GlowSink, ictx: MassContext, f: number, opaque = false) {
  paint(ctxBehind, shapes(ictx, f), opaque);
}

// The dust's extent along the floor line: half of t02..t98 of its cells (the
// way destruction §4.5 reads the band), in U.
export function halfWidth(state: DustState): number {
  const ts: number[] = [];
  for (let i = 0; i < ROWS; i++) {
    const cn = cellN(i);
    for (let k = 0; k < COLS; k++) {
      if (!state.grid[i * COLS + k]) continue;
      const ct = cellT(k);
      if (cn * cn + ct * ct <= VISIBLE_REACH * VISIBLE_REACH) ts.push(ct);
    }
  }
  if (!ts.length) return 0;
  ts.sort((a, b) => a - b);
  const at = (q: number) => ts[Math.min(ts.length - 1, Math.floor(q * ts.length))];
  return (at(0.98) - at(0.02)) / 2 + CELL / 2;
}
