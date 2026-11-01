// The smoke-ball cluster (impact design §6, "Cluster and smoke, A3+" and
// "Where the mass sits"; destruction §4.4, §6.4), from hold group g2 (A3).
// The fill rule, in order:
//   1. Lobes, discs of 0.11–0.17 U, are seeded into the group's envelope (a
//      dome on the floor at P, leaning by the strike's tilt β) until the union
//      less what the dust covers is the group's visible area. A foot lobe
//      stands on P, dipping 0.012 U under the floor line. The others are
//      added one at a time, each the best of a few candidates (grown off a
//      placed lobe toward where the centroid still needs area, a dropped
//      lobe, or a fresh draw) for the visible centroid's measured n and t,
//      looking ahead to where the rest of the area has to go. Every lobe
//      overlaps another by 0.035 U, and while the fire part is at least 40 %
//      of the union (A3–7) every lobe is seen from P, so the fire part can
//      reach its share. An annealed refinement then resizes and moves them
//      (the foot only resizes) until area and centroid land together.
//   2. The fire part, the share h(A) = 0.65·0.91^(A−3) of the visible union
//      nearest P, is a star around P: a radius per angle, the smaller of the
//      lobes' extent and a noisy, licked profile whose scale is bisected to h.
//   3. Smoke balls of 0.022–0.033 U (phone 0.033–0.05 U, at most 30)
//      scallop the outline and fill the smoke part on a lattice. The lattice
//      is spaced so about a fifth of the smoke shows the deep tone between
//      them. Consecutive groups before g6 stand on opposite halves of it, so
//      each is a new drawing (smoke IoU 0.28 at k23); from g6 a seeded 50–70 %
//      of the lobe and ball centres carry over, jittered, and new ones fill
//      the rest (IoU 0.52–0.61): first the holes the dropped balls leave, a
//      new ball 0.45–0.75 of the old one's radius off its centre, then the
//      outline and the lattice. The balls kept sit on the lobes kept, where
//      there are enough. The fire part is bisected again over the balls.
// The smoke's measured IoU is of its balls, so this module's is too: the
// union of the balls as drawn, less the dust. Up to 4 seeded drawings are
// tried per group, and the one nearest its measures is kept: area, centroid,
// and from g6 that IoU inside 0.48–0.72.
// Past g8 (the hold) the groups keep g8's parameters, its extents among them
// (design §6): the refinement and the choice also hold the visible union's
// t02, t98 and top to g8's, or the carry-over walks them off (0.1 U by g14).
// Paint order (judge round 1: one contour, cel-shaded lumps): every lobe and
// ball in the line colour, so the ink shows only on the union's edge; each
// lobe's crescent cel steps over that (the deep tone in a crescent away from
// P, a lit crescent toward it, then the body); the fire part (its dark red
// line, three nested tones and the hot spots near the base); last the fills
// of the scalloping edge balls and of the warm balls round the fire part.
// Tones are the composite's (design §6, "In the composite"); balls near the
// fire warm toward #e5721b.
import type { Vec2 } from '../../types/effect.ts';
import type { GlowSink, Tier } from '../contracts.ts';
import type { BrushTarget } from '../../render/glow.ts';
import { SMOKE, mixHex } from '../palette.ts';
import { int, rng, uniform, type Rng } from '../rng.ts';
import { dustState } from './dust.ts';
import {
  CARRY_FROM, GROUP_AGE, LAST_MEASURED, clamp, discCount, discGain, ellipsePts, gridIoU, gridOr, gridStats, inGrid, jitter, massClock, massFrame, massKey, memo,
  newGrid, paint, polygonCount, rayExit, rayReach, shuffled, stampDisc, stampPolygon, toFrame, fireStar, forDiscRows, cellN, cellT, ROWS, COLS, CELL, VISIBLE_REACH,
  type FloorPt, type Grid, type MassContext, type MassDrawing, type MassFrame, type MassShape,
} from './fire.ts';

// Per hold group g0..g8; groups past g8 keep g8's (the hold span).
export const CLUSTER_AREA = [0, 0, 0.28, 0.11, 0.2, 0.32, 0.37, 0.39, 0.39]; // U², the visible union (less the dust)
export const CENTROID_N = [0.14, 0.3, 0.39, 0.475, 0.47, 0.38, 0.36, 0.38, 0.38]; // U: the visible centroid's height (fire on g0–1)
export const LOBE_R = [0.11, 0.17] as const;
export const BALL_R: Record<Tier, readonly [number, number]> = { full: [0.022, 0.033], phone: [0.033, 0.05] };
export const PHONE_BALLS = 30;
const T_SHIFT = 0.06; // U: the most the lean moves the centroid across (±0.08 measured)
const PAD: Record<Tier, number> = { full: 0.008, phone: 0.012 }; // U: how far the scalloping balls push the outline out, on average
const LATTICE = 2.4; // the ball lattice's spacing in mean radii: about a fifth of the smoke shows deep between balls
const OUTLINE = 0.16; // a ball's deep outline, in radii
const CREST_LINE = 0.006; // U: the union's ink line on a lobe
const LIT_MIX = 0.45; // the lit crescent: the body tone this far toward the rim light
const LOBE_JITTER = 0.02; // U: a carried lobe's move (≤ 0.05)
export const BALL_JITTER = 0.006; // U: a carried ball's move (≤ 0.05)
const HOLE_SHIFT = [0.45, 0.75]; // a new ball in a dropped ball's hole sits this far off its centre, in the old ball's radii
export const CARRY = [0.5, 0.7] as const; // the share of lobes and balls a group keeps, from g6 on
const CORE_RAYS = 89;
const CORE_SPAN = (88 * Math.PI) / 180; // the fire part's rays: ±88° from n̂
const VEIN_LINE = 0.006; // U: the dark red line where the fire meets the smoke
const DEG = Math.PI / 180;
const REFINE_STEPS = 120;
const REFINE_DONE = 0.006; // the refinement stops at this cost
const REFINE_HEAT = 0.012; // the annealing's starting temperature, in cost
const TRIES = 4; // drawings tried for a group that misses its measures
const IOU_BAND = [0.48, 0.72]; // the carried smoke's IoU with the last group, kept inside 0.45–0.75
const STAR_SHARE = 0.4; // while the fire part is at least this share (A3–7), every lobe is seen from P
const JOIN = 0.035; // U: two lobes are joined when they overlap this deep
const CLIMB = 0.05; // U: how far above the top so far the next lobe's visible part can be taken to sit
const FOOT_SINK = 0.012; // U: the lobe on P reaches this far below the floor line
const FOOT: readonly FloorPt[] = [[0.002, -0.006], [0.002, 0.006], [0.03, 0]]; // U: what a lobe on P covers
const HELD_W = 0.5; // the refinement's weight on the hold's extents, per U off g8's

export const hotShare = (A: number) => 0.65 * 0.91 ** (A - 3);

// The composite smoke tones over the loop (destruction §4.4 "Comp"), by A.
const PAINT: readonly (readonly [number, string])[] = [[3, '#b14b15'], [7, '#a1442f'], [12, '#a64029'], [15, '#953c34'], [17, '#883733']];
const DEEP: readonly (readonly [number, string])[] = [[3, '#701f03'], [17, '#3a1221']];
const VEIN_DARK = '#660800';
const VEIN_ORANGE = SMOKE.veins[0]; // #fc6207
const VEIN_LIGHT = SMOKE.veins[1]; // #fd8d01
const VEIN_RED = SMOKE.veins[2]; // #fd5d0b

function ramp(stops: readonly (readonly [number, string])[], A: number): string {
  if (A <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (A <= stops[i][0]) return mixHex(stops[i - 1][1], stops[i][1], (A - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]));
  }
  return stops[stops.length - 1][1];
}

interface Envelope {
  top: number; // U
  tMin: number;
  tMax: number;
}
// A3–4: n to 0.71, |t| ≤ 0.41; A5–6 between; from A7: top 0.76, t −0.50..+0.47.
const envelope = (gi: number): Envelope => (gi <= 2 ? { top: 0.71, tMin: -0.41, tMax: 0.41 } : gi === 3 ? { top: 0.73, tMin: -0.45, tMax: 0.45 } : { top: 0.76, tMin: -0.5, tMax: 0.47 });

export interface Lobe {
  c: FloorPt;
  r: number;
}
export interface Ball {
  c: FloorPt;
  r: number;
  level: number; // × the smoke tone
  spot: FloorPt; // the shade spot's centre
  spotR: number;
  edge: boolean; // scalloping the outline
  warm: boolean; // next to the fire part
}
export interface ClusterState {
  g: number;
  A: number;
  hot: number; // the target hot share, h(A)
  lean: number; // β
  lobes: Lobe[];
  balls: Ball[];
  weights: number[]; // the fire part's profile per ray
  exits: number[]; // the lobes' extent per ray
  rho: number; // the fire part's scale
  phase: 0 | 1; // which half of the ball lattice
  union: Grid; // lobes ∪ balls
  smoke: Grid; // the balls as drawn, outline included: the smoke measure (its IoU)
  carried: number; // how many of the last group's balls it kept (0 before g7)
  stats: { area: number; n: number; t: number; hot: number }; // visible (less the dust)
}

const rayAngle = (i: number) => -CORE_SPAN + (2 * CORE_SPAN * i) / (CORE_RAYS - 1);

// The fire part as a polygon from P: per ray the smaller of its profile and
// the lobes' extent, × `scale`, plus `grow` U (never past the extent).
export function corePolygon(rho: number, weights: readonly number[], exits: readonly number[], grow = 0, scale = 1): FloorPt[] {
  const out: FloorPt[] = [[0, 0]];
  for (let i = 0; i < CORE_RAYS; i++) {
    const phi = rayAngle(i);
    const r = Math.min(Math.min(rho * weights[i], exits[i]) * scale + grow, exits[i]);
    out.push([r * Math.cos(phi), r * Math.sin(phi)]);
  }
  return out;
}

// The fire part's profile: a slow wobble and 4–7 pointed licks.
function coreWeights(r: Rng): number[] {
  const p = [r(), r(), r()].map((v) => v * 2 * Math.PI);
  const licks = Array.from({ length: int(r, 4, 7) }, () => ({ at: uniform(r, -0.85, 0.85) * CORE_SPAN, half: uniform(r, 4, 9) * DEG, gain: uniform(r, 1.25, 1.6) }));
  return Array.from({ length: CORE_RAYS }, (_, i) => {
    const phi = rayAngle(i);
    let v = 0.82 + 0.1 * Math.sin(3 * phi + p[0]) + 0.06 * Math.sin(7 * phi + p[1]) + 0.04 * Math.sin(13 * phi + p[2]);
    for (const l of licks) {
      const d = Math.abs(phi - l.at);
      if (d < l.half) v *= 1 + (l.gain - 1) * (1 - d / l.half);
    }
    return v;
  });
}

// The scale of the fire part whose visible share of the visible union is h.
function fitCore(h: number, weights: number[], exits: number[], union: Grid, hidden: Grid, cover: Grid | null): number {
  const total = gridStats(union, hidden).area;
  if (!(total > 0)) return 0;
  let lo = 0;
  let hi = 1.5;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (polygonCount(corePolygon(mid, weights, exits), hidden, cover) / total < h) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// A candidate lobe centre, uniform in the dome, leaned.
function propose(r: Rng, env: Envelope, rl: number, Cn: number, t0: number, tanB: number): FloorPt {
  const nc = env.top / 2;
  const an = Math.max(0.05, env.top / 2 - 0.6 * rl);
  const tc = (env.tMin + env.tMax) / 2;
  const at = Math.max(0.05, (env.tMax - env.tMin) / 2 - 0.75 * rl);
  const a = 2 * Math.PI * r();
  const d = Math.sqrt(r());
  const n = clamp(nc + an * d * Math.cos(a), rl - 0.01, env.top - rl + 0.01);
  return [n, tc + at * d * Math.sin(a) + t0 + (n - Cn) * tanB];
}

interface Fit {
  T: number;
  Cn: number;
  t0: number;
  tanB: number;
  env: Envelope;
  hidden: Grid;
  pad: number;
  star: boolean; // every lobe seen from P (while the fire part is most of the mass)
  held: Extents | null; // past g8: g8's visible extents, kept through the hold
}

// Step 1: lobes until the visible union (padded for the scallops) is the target.
function placeLobes(r: Rng, fit: Fit, kept: Lobe[], dropped: Lobe[]): Lobe[] {
  const { T, Cn, t0, tanB, env, hidden, pad } = fit;
  const lobes: Lobe[] = [];
  let grid = newGrid();
  let A = 0;
  let Sn = 0;
  let St = 0;
  const add = (l: Lobe) => {
    const gain = discGain(grid, hidden, l.c[0], l.c[1], l.r + pad);
    A += gain.area;
    Sn += gain.n;
    St += gain.t;
    stampDisc(grid, l.c[0], l.c[1], l.r + pad);
    lobes.push(l);
  };
  for (const l of kept) add(l);
  // The fire part's rays leave from P: a lobe must hold P and the floor line
  // either side of it (a carried one may have moved off).
  const holdsP = (l: Lobe) => FOOT.every(([n, t]) => Math.hypot(l.c[0] - n, l.c[1] - t) < l.r);
  let foot = -1;
  if (!lobes.some(holdsP)) {
    const rb = uniform(r, 0.13, 0.16);
    foot = lobes.length;
    add({ c: [rb - FOOT_SINK, uniform(r, -0.025, 0.025)], r: rb });
  }
  const fresh = lobes.length;
  let top = Math.max(...lobes.map((l) => l.c[0] + l.r));
  for (let step = 0; A < 0.96 * T && step < 30; step++) {
    // Where the rest of the area has to sit for the union to land on (Cn, t0).
    const left = Math.max(1e-6, T - A);
    const needN = clamp((T * Cn - Sn) / left, 0.1, env.top - 0.1);
    const needT = clamp((T * t0 - St) / left, env.tMin + 0.1, env.tMax - 0.1);
    let best: Lobe | null = null;
    let bestCost = Infinity;
    for (let k = 0, tries = 0; k < 12 && tries < 90; tries++) {
      let cand: Lobe;
      if (dropped.length && k < 3) {
        const d = dropped[int(r, 0, dropped.length - 1)];
        cand = { c: jitter(r, d.c, 0.05), r: clamp(d.r * uniform(r, 0.85, 1.15), LOBE_R[0], LOBE_R[1]) };
      } else if (k % 2) {
        // Grown off a lobe toward where the rest is needed.
        const rl = uniform(r, LOBE_R[0], LOBE_R[1]);
        const from = lobes[int(r, 0, lobes.length - 1)];
        const a = Math.atan2(needT - from.c[1], needN - from.c[0]) + uniform(r, -0.6, 0.6);
        const d = uniform(r, 0.45, 0.95) * (from.r + rl - JOIN);
        cand = { c: [from.c[0] + d * Math.cos(a), from.c[1] + d * Math.sin(a)], r: rl };
      } else {
        const rl = uniform(r, LOBE_R[0], LOBE_R[1]);
        cand = { c: propose(r, env, rl, Cn, t0, tanB), r: rl };
      }
      cand.c[0] = clamp(cand.c[0], cand.r - 0.01, env.top - cand.r + 0.01);
      if (!lobes.some((l) => Math.hypot(l.c[0] - cand.c[0], l.c[1] - cand.c[1]) < cand.r + l.r - JOIN)) continue;
      if (fit.star && !seenFromP(lobes, cand)) continue;
      k++;
      const gain = discGain(grid, hidden, cand.c[0], cand.c[1], cand.r + pad);
      if (gain.area < 0.004) continue;
      const A2 = A + gain.area;
      // Judged by where it leaves the union: with area still to place, the
      // rest is taken to sit where it is needed if it can climb there (a
      // column from the top so far up to the envelope's), so a lobe that
      // spends the area low loses to one that climbs; the last lobe must not
      // overshoot.
      let cost: number;
      if (A2 < T) {
        const rest = T - A2;
        const climb = Math.max(top, cand.c[0] + cand.r) + CLIMB;
        const restN = Math.min(clamp((T * Cn - Sn - gain.n) / rest, 0.1, env.top - 0.1), climb);
        const restT = clamp((T * t0 - St - gain.t) / rest, env.tMin + 0.1, env.tMax - 0.1);
        cost =
          Math.abs((Sn + gain.n + rest * restN) / T - Cn) +
          0.5 * Math.abs((St + gain.t + rest * restT) / T - t0) +
          0.25 * (gain.area / left) * (Math.abs(gain.n / gain.area - needN) + 0.5 * Math.abs(gain.t / gain.area - needT));
      } else {
        cost = Math.abs((Sn + gain.n) / A2 - Cn) + 0.5 * Math.abs((St + gain.t) / A2 - t0) + 2 * Math.max(0, A2 / T - 1.04);
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = cand;
      }
    }
    if (!best) break;
    add(best);
    top = Math.max(top, best.c[0] + best.r);
  }
  // Overshot: shrink the last lobe onto the target.
  if (A > 1.03 * T && lobes.length > fresh) {
    const last = lobes.pop() as Lobe;
    grid = newGrid();
    let A0 = 0;
    for (const l of lobes) {
      A0 += discGain(grid, hidden, l.c[0], l.c[1], l.r + pad).area;
      stampDisc(grid, l.c[0], l.c[1], l.r + pad);
    }
    let lo = 0.03;
    let hi = last.r;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (A0 + discGain(grid, hidden, last.c[0], last.c[1], mid + pad).area > T) hi = mid;
      else lo = mid;
    }
    lobes.push({ c: last.c, r: (lo + hi) / 2 });
  }
  refineLobes(r, fit, lobes, fresh, foot);
  return lobes;
}

// The segment from P to the lobe's centre runs inside the lobes, so the fire
// part's rays reach it.
function seenFromP(lobes: readonly Lobe[], l: Lobe): boolean {
  const steps = Math.ceil(Math.hypot(l.c[0], l.c[1]) / 0.02);
  const inside = (o: Lobe, n: number, t: number) => Math.hypot(o.c[0] - n, o.c[1] - t) < o.r - 0.01;
  for (let s = 1; s < steps; s++) {
    const n = (l.c[0] * s) / steps;
    const t = (l.c[1] * s) / steps;
    if (!inside(l, n, t) && !lobes.some((o) => inside(o, n, t))) return false;
  }
  return true;
}

const joined = (a: Lobe, b: Lobe) => Math.hypot(a.c[0] - b.c[0], a.c[1] - b.c[1]) < a.r + b.r - JOIN;
function connected(lobes: readonly Lobe[]): boolean {
  const seen = new Uint8Array(lobes.length);
  const stack = [0];
  seen[0] = 1;
  let reached = 1;
  while (stack.length) {
    const a = lobes[stack.pop() as number];
    for (let i = 0; i < lobes.length; i++) {
      if (seen[i] || !joined(a, lobes[i])) continue;
      seen[i] = 1;
      reached++;
      stack.push(i);
    }
  }
  return reached === lobes.length;
}

// Step 1b: a short annealed search over the lobes placed fresh (not the
// carried ones nor the one on P): moves and resizes that bring the visible
// union nearer the target's area and centroid, keeping the lobes joined. The
// greedy step can't see ahead (at A5 it spends the area low, under a wall of
// dust); this mends it. Through the hold it also holds g8's extents. The best
// arrangement seen is kept.
function refineLobes(r: Rng, fit: Fit, lobes: Lobe[], from: number, foot: number) {
  const { T, Cn, t0, tanB, env, hidden, pad, held } = fit;
  if (lobes.length <= from) return;
  const lo = foot >= 0 ? from - 1 : from; // the lobe on P only grows or shrinks, standing on P
  // How many lobes cover each cell, and the visible union's cell count, sums
  // of n and of the column, and counts per column and per row, kept as lobes
  // come and go.
  const count = new Uint8Array(COLS * ROWS);
  const perCol = new Int32Array(COLS);
  const perRow = new Int32Array(ROWS);
  let cells = 0;
  let sn = 0;
  let sk = 0;
  const apply = (l: Lobe, d: 1 | -1) =>
    forDiscRows(l.c[0], l.c[1], l.r + pad, (i, k0, k1) => {
      const row = i * COLS;
      let c = 0;
      let s = 0;
      for (let at = row + k0, end = row + k1; at <= end; at++) {
        if (d > 0 ? count[at]++ !== 0 : --count[at] !== 0) continue;
        if (hidden[at]) continue;
        c++;
        s += at - row;
        perCol[at - row] += d;
      }
      cells += d * c;
      sn += d * c * cellN(i);
      sk += d * s;
      perRow[i] += d * c;
    });
  const t00 = cellT(0);
  const cost = () => {
    if (!cells) return Infinity;
    const c = 1.5 * Math.abs((cells * CELL * CELL) / T - 1) + Math.abs(sn / cells - Cn) + 0.5 * Math.abs(t00 + (sk / cells) * CELL - t0);
    return held ? c + HELD_W * extentsOff(extentsOf(perCol, perRow, cells), held) : c;
  };
  for (const l of lobes) apply(l, 1);
  let now = cost();
  let best = now;
  let bestLobes = lobes.slice();
  for (let it = 0; it < REFINE_STEPS && best > REFINE_DONE; it++) {
    const i = int(r, lo, lobes.length - 1);
    const old = lobes[i];
    const move = r();
    let cand: Lobe;
    if (i === foot) {
      const rl = clamp(old.r * uniform(r, 0.88, 1.14), LOBE_R[0], LOBE_R[1]);
      cand = { c: [rl - FOOT_SINK, old.c[1]], r: rl };
    } else {
      const resize = move < 0.3 || move > 0.8;
      const shift = move >= 0.3;
      const rl = resize ? clamp(old.r * uniform(r, 0.85, 1.18), Math.min(old.r, LOBE_R[0]), LOBE_R[1]) : old.r;
      const n = clamp(old.c[0] + (shift ? uniform(r, -0.08, 0.08) : 0), rl - 0.01, env.top - rl + 0.01);
      const lean = t0 + (n - Cn) * tanB;
      const t = clamp(old.c[1] + (shift ? uniform(r, -0.08, 0.08) : 0), env.tMin + 0.6 * rl + lean, env.tMax - 0.6 * rl + lean);
      cand = { c: [n, t], r: rl };
    }
    lobes[i] = cand;
    if (!connected(lobes) || (fit.star && !lobes.every((l) => seenFromP(lobes, l)))) {
      lobes[i] = old;
      continue;
    }
    apply(old, -1);
    apply(cand, 1);
    const next = cost();
    const heat = REFINE_HEAT * (1 - it / REFINE_STEPS);
    if (next < now || r() < Math.exp((now - next) / heat)) {
      now = next;
      if (now < best) {
        best = now;
        bestLobes = lobes.slice();
      }
      continue;
    }
    apply(cand, -1);
    apply(old, 1);
    lobes[i] = old;
  }
  for (let i = 0; i < lobes.length; i++) lobes[i] = bestLobes[i];
}

// A close-by test for balls, on a coarse hash.
function nearIndex(size: number) {
  const cells = new Map<number, Ball[]>();
  const key = (i: number, k: number) => i * 4096 + k;
  return {
    add(b: Ball) {
      const kk = key(Math.floor(b.c[0] / size), Math.floor(b.c[1] / size));
      const list = cells.get(kk);
      if (list) list.push(b);
      else cells.set(kk, [b]);
    },
    // No ball within factor × (r + its r) of c.
    clear(c: FloorPt, r: number, factor: number): boolean {
      const i0 = Math.floor(c[0] / size);
      const k0 = Math.floor(c[1] / size);
      for (let di = -1; di <= 1; di++) {
        for (let dk = -1; dk <= 1; dk++) {
          const list = cells.get(key(i0 + di, k0 + dk));
          if (!list) continue;
          for (const b of list) if (Math.hypot(b.c[0] - c[0], b.c[1] - c[1]) < factor * (r + b.r)) return false;
        }
      }
      return true;
    },
  };
}

function makeBall(r: Rng, c: FloorPt, rb: number, edge: boolean): Ball {
  const away = Math.atan2(c[1], c[0]) + uniform(r, -0.6, 0.6); // the shade sits away from the fire, which is toward P
  const spotR = uniform(r, 0.5, 0.62) * rb;
  const off = Math.min(0.3 * rb, 0.8 * rb - spotR) * uniform(r, 0.6, 1);
  return { c, r: rb, level: uniform(r, 0.86, 1.12), spot: [c[0] + off * Math.cos(away), c[1] + off * Math.sin(away)], spotR, edge, warm: false };
}

// Step 3: balls along the outline and on the lattice, in the smoke part.
// `shift` moves the lattice by a fraction of a cell (carried groups place
// their new balls off the old lattice). A carried group first refills the
// holes its dropped balls leave.
function placeBalls(r: Rng, tier: Tier, lobes: Lobe[], lobeGrid: Grid, coreGrid: Grid, phase: 0 | 1, shift: FloorPt, carried: Ball[], holes: Ball[]): { balls: Ball[]; kept: number } {
  const [rMin, rMax] = BALL_R[tier];
  const rMean = (rMin + rMax) / 2;
  const near = nearIndex(2.2 * rMax);
  const smoke = (c: FloorPt) => inGrid(lobeGrid, c[0], c[1]) && !inGrid(coreGrid, c[0], c[1]);
  const inside = (c: FloorPt, rb: number) => {
    for (let a = 0; a < 6; a++) if (!inGrid(lobeGrid, c[0] + 0.8 * rb * Math.cos((a * Math.PI) / 3), c[1] + 0.8 * rb * Math.sin((a * Math.PI) / 3))) return false;
    return true;
  };
  const kept: Ball[] = [];
  const refills: Ball[] = [];
  const edges: Ball[] = [];
  const inner: Ball[] = [];
  for (const b of carried) {
    if (!smoke(b.c) || !near.clear(b.c, b.r, 0.7)) continue;
    kept.push(b);
    near.add(b);
  }
  for (const h of holes) {
    const a = 2 * Math.PI * r();
    const d = h.r * uniform(r, HOLE_SHIFT[0], HOLE_SHIFT[1]);
    const c: FloorPt = [h.c[0] + d * Math.cos(a), h.c[1] + d * Math.sin(a)];
    const rb = uniform(r, rMin, rMax);
    if (!smoke(c) || !inside(c, rb) || !near.clear(c, rb, 0.78)) continue;
    const b = makeBall(r, c, rb, false);
    refills.push(b);
    near.add(b);
  }
  for (const l of lobes) {
    const m = Math.max(6, Math.ceil((2 * Math.PI * l.r) / ((tier === 'phone' ? 2.3 : 1.9) * rMean)));
    const th0 = r() * 2 * Math.PI;
    for (let i = 0; i < m; i++) {
      const th = th0 + (2 * Math.PI * i) / m;
      const dn = Math.cos(th);
      const dt = Math.sin(th);
      const rb = uniform(r, rMin, rMax);
      const q: FloorPt = [l.c[0] + l.r * dn, l.c[1] + l.r * dt];
      if (q[0] < 0.03) continue; // nothing hangs below the floor line
      if (lobes.some((o) => o !== l && Math.hypot(o.c[0] - q[0], o.c[1] - q[1]) < o.r - 0.25 * rMean)) continue;
      const c: FloorPt = [l.c[0] + (l.r - 0.45 * rb) * dn, l.c[1] + (l.r - 0.45 * rb) * dt];
      if (inGrid(coreGrid, c[0], c[1]) || !near.clear(c, rb, 0.78)) continue;
      const b = makeBall(r, c, rb, true);
      edges.push(b);
      near.add(b);
    }
  }
  const s = LATTICE * rMean;
  const rowH = (s * Math.sqrt(3)) / 2;
  const origin: FloorPt = [shift[0] * 2 * rowH, shift[1] * s];
  const off: FloorPt = phase ? [s / (2 * Math.sqrt(3)), s / 2] : [0, 0];
  let n0 = Infinity;
  let n1 = -Infinity;
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const l of lobes) {
    n0 = Math.min(n0, l.c[0] - l.r);
    n1 = Math.max(n1, l.c[0] + l.r);
    t0 = Math.min(t0, l.c[1] - l.r);
    t1 = Math.max(t1, l.c[1] + l.r);
  }
  for (let i = Math.floor((n0 - origin[0] - off[0]) / rowH) - 1, i1 = Math.ceil((n1 - origin[0] - off[0]) / rowH) + 1; i <= i1; i++) {
    for (let k = Math.floor((t0 - origin[1] - off[1]) / s) - 1, k1 = Math.ceil((t1 - origin[1] - off[1]) / s) + 1; k <= k1; k++) {
      const site: FloorPt = [origin[0] + off[0] + i * rowH, origin[1] + off[1] + k * s + (i & 1 ? s / 2 : 0)];
      const c = jitter(r, site, 0.12 * s);
      const rb = uniform(r, rMin, rMax);
      if (!smoke(c) || !inside(c, rb) || !near.clear(c, rb, 0.82)) continue;
      const b = makeBall(r, c, rb, false);
      inner.push(b);
      near.add(b);
    }
  }
  if (tier !== 'phone') return { balls: [...kept, ...refills, ...edges, ...inner], kept: kept.length };
  // The phone tier keeps 30: what carried over, the refilled holes, then the
  // outline, then the inside.
  const pick = (list: Ball[], room: number) => shuffled(list.length, r).slice(0, Math.max(0, room)).sort((a, b) => a - b).map((i) => list[i]);
  const out = kept.slice(0, PHONE_BALLS);
  const nKept = out.length;
  out.push(...refills.slice(0, PHONE_BALLS - out.length));
  out.push(...pick(edges, PHONE_BALLS - out.length));
  out.push(...pick(inner, PHONE_BALLS - out.length));
  return { balls: out, kept: nKept };
}

const DISC_DIRS = Array.from({ length: 8 }, (_, i) => [Math.cos((i * Math.PI) / 4), Math.sin((i * Math.PI) / 4)] as const);

function buildCluster(seed: number, g: number, tier: Tier, beta: number): ClusterState {
  const gi = Math.min(g, LAST_MEASURED);
  const A = GROUP_AGE[gi];
  const h = hotShare(A);
  const T = CLUSTER_AREA[gi];
  const Cn = CENTROID_N[gi];
  const tanB = Math.tan(beta);
  const t0 = clamp(Cn * tanB, -T_SHIFT, T_SHIFT);
  const env = envelope(gi);
  const hidden = dustState(seed, g).grid;
  const prev = g > CARRY_FROM ? clusterState(seed, g - 1, tier, beta) : null;
  const phase: 0 | 1 = prev ? prev.phase : g >= CARRY_FROM ? 0 : ((g % 2) as 0 | 1);
  // What carries over (from g6 on): a seeded 50–70 % of the lobes and of the
  // balls, the balls on the kept lobes first; the rest of the balls leave holes.
  const carry = (v: number) => {
    const rc = v ? rng(seed, 'cluster', g, 1, v) : rng(seed, 'cluster', g, 1);
    let keptLobes: Lobe[] = [];
    let droppedLobes: Lobe[] = [];
    let keptBalls: Ball[] = [];
    let holes: Ball[] = [];
    let origin: FloorPt = [0, 0];
    if (prev) {
      const lo = shuffled(prev.lobes.length, rc);
      const nl = Math.round(uniform(rc, CARRY[0], CARRY[1]) * prev.lobes.length);
      keptLobes = lo.slice(0, nl).map((i) => ({ c: jitter(rc, prev.lobes[i].c, LOBE_JITTER), r: prev.lobes[i].r }));
      droppedLobes = lo.slice(nl).map((i) => prev.lobes[i]);
      const onKept = newGrid();
      for (const l of keptLobes) stampDisc(onKept, l.c[0], l.c[1], l.r);
      const bo = shuffled(prev.balls.length, rc);
      const order = [...bo.filter((i) => inGrid(onKept, prev.balls[i].c[0], prev.balls[i].c[1])), ...bo.filter((i) => !inGrid(onKept, prev.balls[i].c[0], prev.balls[i].c[1]))];
      const nb = Math.round(uniform(rc, CARRY[0], CARRY[1]) * prev.balls.length);
      keptBalls = order.slice(0, nb).map((i) => {
        const b = prev.balls[i];
        const c = jitter(rc, b.c, BALL_JITTER);
        return { ...b, c, spot: [b.spot[0] + c[0] - b.c[0], b.spot[1] + c[1] - b.c[1]] as FloorPt, warm: false };
      });
      holes = order.slice(nb).map((i) => prev.balls[i]);
      origin = [uniform(rc, 0, 1), uniform(rc, 0, 1)]; // new balls land anywhere between the carried ones
    }
    return { keptLobes, droppedLobes, keptBalls, holes, origin };
  };
  const held = g > LAST_MEASURED ? visibleExtents(clusterState(seed, LAST_MEASURED, tier, beta).union, dustState(seed, LAST_MEASURED).grid) : null;
  const fit: Fit = { T, Cn, t0, tanB, env, hidden, pad: PAD[tier], star: h >= STAR_SHARE, held };
  const attempt = (target: number, v: number, sel: ReturnType<typeof carry>): ClusterState => {
    const { keptLobes, droppedLobes, keptBalls, holes, origin } = sel;
    const r = v ? rng(seed, 'cluster', g, 3, v) : rng(seed, 'cluster', g);
    const lobes = placeLobes(r, { ...fit, T: target }, keptLobes, droppedLobes);
    const lobeGrid = newGrid();
    for (const l of lobes) stampDisc(lobeGrid, l.c[0], l.c[1], l.r);
    const weights = coreWeights(r);
    const exits = Array.from({ length: CORE_RAYS }, (_, i) => rayExit(lobeGrid, rayAngle(i)));
    // Step 2 on the lobes alone, to know where the smoke part is.
    const rho0 = fitCore(h, weights, exits, lobeGrid, hidden, null);
    const coreGrid = newGrid();
    stampPolygon(coreGrid, corePolygon(rho0, weights, exits));
    const { balls, kept } = placeBalls(r, tier, lobes, lobeGrid, coreGrid, phase, origin, keptBalls, holes);
    const cover = newGrid();
    for (const b of balls) stampDisc(cover, b.c[0], b.c[1], b.r);
    const union = gridOr(lobeGrid, cover);
    // Step 2 again, over the balls.
    const rho = fitCore(h, weights, exits, union, hidden, cover);
    const finalCore = newGrid();
    stampPolygon(finalCore, corePolygon(rho, weights, exits));
    // New balls, not flags on the old ones: the carried balls are shared by both attempts.
    const lit = balls.map((b) => ({ ...b, warm: DISC_DIRS.some(([dn, dt]) => inGrid(finalCore, b.c[0] + (b.r + 0.04) * dn, b.c[1] + (b.r + 0.04) * dt)) }));
    const vis = gridStats(union, hidden);
    const hot = vis.area > 0 ? polygonCount(corePolygon(rho, weights, exits), hidden, cover) / vis.area : 0;
    return { g, A, hot: h, lean: beta, lobes, balls: lit, weights, exits, rho, phase, union, smoke: cover, carried: kept, stats: { ...vis, hot } };
  };
  const once = (v: number) => {
    const sel = carry(v);
    let state = attempt(T, v, sel);
    if (Math.abs(state.stats.area / T - 1) > 0.04) {
      const again = attempt(T * (T / Math.max(1e-6, state.stats.area)), v, sel);
      if (Math.abs(again.stats.area / T - 1) < Math.abs(state.stats.area / T - 1)) state = again;
    }
    return state;
  };
  // How far a drawing is off the measures, in units of a comfortable margin
  // inside each tolerance (≤ 1 keeps it): area, centroid, the fire part's
  // share (short of it when the lobes leave the core no room by P), from g7
  // the smoke's IoU with the last group, and past g8 g8's extents (half the
  // hold's 0.1 U across and 0.08 U up).
  const prevHidden = prev ? dustState(seed, g - 1).grid : null;
  const miss = (s: ClusterState) => {
    let m = Math.max(Math.abs(s.stats.area / T - 1) / 0.06, Math.abs(s.stats.n - Cn) / 0.035, Math.abs(s.stats.t - t0) / 0.06, Math.abs(s.stats.hot - h) / 0.03);
    if (prev) {
      const iou = gridIoU(prev.smoke, s.smoke, prevHidden, hidden);
      m = Math.max(m, Math.max(0, IOU_BAND[0] - iou, iou - IOU_BAND[1]) / 0.02);
    }
    if (held) {
      const e = visibleExtents(s.union, hidden);
      m = Math.max(m, Math.abs(e.t02 - held.t02) / 0.05, Math.abs(e.t98 - held.t98) / 0.05, Math.abs(e.top - held.top) / 0.04);
    }
    return m;
  };
  // A drawing that misses is drawn again on its own stream, up to TRIES times;
  // the nearest is kept.
  let best = once(0);
  let bestMiss = miss(best);
  for (let v = 1; v < TRIES && bestMiss > 1; v++) {
    const s = once(v);
    const m = miss(s);
    if (m < bestMiss) {
      best = s;
      bestMiss = m;
    }
  }
  return best;
}

const STATES = new Map<string, ClusterState>();

// The cluster of hold group g (2 and up), in U in the floor frame: pure in
// (seed, g, tier, lean).
export function clusterState(seed: number, g: number, tier: Tier, beta: number): ClusterState {
  return memo(STATES, `${seed}|${tier}|${beta.toFixed(5)}|${g}`, () => buildCluster(seed, g, tier, beta));
}

export interface ClusterDrawing extends MassDrawing {
  g: number;
  A: number;
  unit: number; // px per mass unit on this frame
  state: ClusterState;
}

const SHAPES = new Map<string, MassShape[]>();

// The shapes of one group's cluster at `unit` px per U (held while the group
// shows: every frame of it gets the same list).
export function clusterShapes(ictx: MassContext, g: number, unit: number, alpha = 1): ClusterDrawing {
  const fr = massFrame(ictx, true);
  const state = clusterState(ictx.seed, g, ictx.tier, fr.beta);
  const key = `cluster:${massKey(ictx)}:${g}:${unit.toFixed(3)}`;
  const shapes = memo(SHAPES, key, () => buildShapes(ictx, fr, state, g, unit), 8);
  return { layer: 'behind', key, alpha, shapes, g, A: state.A, unit, state };
}

function buildShapes(ictx: MassContext, fr: MassFrame, state: ClusterState, g: number, unit: number): MassShape[] {
  const px = (pts: readonly FloorPt[]) => pts.map((p) => toFrame(fr, unit, p));
  const disc = (c: FloorPt, r: number) => px(ellipsePts(c, r, discCount(r * unit)));
  const deep = ramp(DEEP, state.A);
  const tone = ramp(PAINT, state.A);
  const line = mixHex(deep, '#000000', 0.35);
  const lit = mixHex(tone, SMOKE.rim, LIT_MIX);
  const out: MassShape[] = [];
  // One ink contour, on the union's edge only (judge round 1: no polka dots):
  // every lobe and ball in the line's colour, then the fills over them a line
  // in, so the line shows only where nothing else covers it. The balls are
  // the scallops along it; inside, the lobes' cel steps cover them, and only
  // the scallops and the warm balls round the fire part are filled, last.
  for (const l of state.lobes) out.push({ role: 'lobe', points: disc(l.c, l.r), color: line, round: true });
  for (const b of state.balls) out.push({ role: 'ball-line', points: disc(b.c, b.r), color: line, round: true });
  // Each lobe a lump in crescent cel steps: the deep tone in a crescent away
  // from P, a lit crescent toward it, offset 0.15–0.2 of its radius.
  for (const l of state.lobes) {
    const r = l.r - CREST_LINE;
    const len = Math.hypot(l.c[0], l.c[1]) || 1;
    const u: FloorPt = [-l.c[0] / len, -l.c[1] / len]; // toward P
    const at = (k: number): FloorPt => [l.c[0] + k * r * u[0], l.c[1] + k * r * u[1]];
    out.push({ role: 'lobe-shade', points: disc(l.c, r), color: deep, round: true });
    out.push({ role: 'lobe-lit', points: disc(at(0.15), 0.85 * r), color: lit, round: true });
    out.push({ role: 'lobe-body', points: disc(at(-0.05), 0.72 * r), color: tone, round: true });
  }
  const { rho, weights, exits } = state;
  out.push({ role: 'vein-line', points: px(corePolygon(rho, weights, exits, VEIN_LINE)), color: VEIN_DARK });
  out.push({ role: 'core', points: px(corePolygon(rho, weights, exits)), color: VEIN_RED });
  out.push({ role: 'core-mid', points: px(corePolygon(rho, weights, exits, 0, 0.8)), color: VEIN_ORANGE });
  out.push({ role: 'core-inner', points: px(corePolygon(rho, weights, exits, 0, 0.5)), color: VEIN_LIGHT });
  // Hot spots: pale yellow, orange-rimmed, in the fire part near the base.
  const rs = rng(ictx.seed, 'cluster', g, 2);
  for (let i = int(rs, 3, 6); i > 0; i--) {
    const k = int(rs, 8, CORE_RAYS - 9);
    const phi = rayAngle(k);
    const reach = Math.min(rho * weights[k], exits[k]) * uniform(rs, 0.25, 0.65);
    const c: FloorPt = [reach * Math.cos(phi), reach * Math.sin(phi)];
    if (c[0] > 0.3) continue;
    const size = uniform(rs, 0.012, 0.026);
    out.push({ role: 'spot-rim', points: disc(c, size * 1.35), color: VEIN_LIGHT, round: true });
    out.push({ role: 'spot', points: disc(c, size), color: SMOKE.spots, round: true });
  }
  for (const b of state.balls) {
    if (b.edge || b.warm) out.push({ role: 'ball', points: disc(b.c, b.r * (1 - OUTLINE)), color: b.warm ? mixHex(tone, SMOKE.rim, 0.35) : tone, round: true });
  }
  return out;
}

// The cluster on frame f: hold group 2 on (A3+), until J_end; null elsewhere.
export function shapes(ictx: MassContext, f: number): ClusterDrawing | null {
  const clock = massClock(ictx, f);
  if (!clock || clock.g < 2) return null;
  return clusterShapes(ictx, clock.g, massFrame(ictx, true).U * clock.zoom, clock.alpha);
}

export function draw(ctxBehind: BrushTarget, _ctxFront: BrushTarget, _sink: GlowSink, ictx: MassContext, f: number, opaque = false) {
  paint(ctxBehind, shapes(ictx, f), opaque);
}

const OUTLINE_RAYS = 64;

// The mass's outer outline seen from P, for the lightning (WP9 via WP12): a
// polyline in frame px from the floor on one side over the top to the other.
// The burst's rim on g0–1, the cluster's outline from g2; null with no mass.
export function outline(ictx: MassContext, f: number): Vec2[] | null {
  const clock = massClock(ictx, f);
  if (!clock) return null;
  const fr = massFrame(ictx, true);
  const unit = fr.U * clock.zoom;
  if (clock.g < 2) {
    const star = fireStar(ictx.seed, clock.g as 0 | 1);
    return star.phis.map((phi, i) => toFrame(fr, unit, [star.radii[i] * Math.cos(phi), star.radii[i] * Math.sin(phi)]));
  }
  const state = clusterState(ictx.seed, clock.g, ictx.tier, fr.beta);
  const out: Vec2[] = [];
  for (let i = 0; i < OUTLINE_RAYS; i++) {
    const phi = -CORE_SPAN + (2 * CORE_SPAN * i) / (OUTLINE_RAYS - 1);
    const rho = rayReach(state.union, phi);
    if (rho > 0) out.push(toFrame(fr, unit, [rho * Math.cos(phi), rho * Math.sin(phi)]));
  }
  return out.length >= 2 ? out : null;
}

interface Extents {
  t02: number; // U: the 2nd and 98th percentiles of t, across
  t98: number;
  top: number; // U: the 98th percentile of n
}

// The bin the k-th count (from 0) falls in.
function binOf(counts: Int32Array, k: number): number {
  let sum = 0;
  for (let b = 0; b < counts.length; b++) {
    sum += counts[b];
    if (sum > k) return b;
  }
  return counts.length - 1;
}

// The extents of `cells` cells counted per column and per row.
const extentsOf = (perCol: Int32Array, perRow: Int32Array, cells: number): Extents => ({
  t02: cellT(binOf(perCol, Math.floor(0.02 * cells))),
  t98: cellT(binOf(perCol, Math.floor(0.98 * cells))),
  top: cellN(binOf(perRow, Math.floor(0.98 * cells))),
});

const extentsOff = (e: Extents, to: Extents) => Math.abs(e.t02 - to.t02) + Math.abs(e.t98 - to.t98) + Math.abs(e.top - to.top);

// The visible union's extents, less the dust, within VISIBLE_REACH of P.
function visibleExtents(union: Grid, hidden: Grid | null): Extents {
  const perCol = new Int32Array(COLS);
  const perRow = new Int32Array(ROWS);
  let cells = 0;
  for (let i = 0; i < ROWS; i++) {
    const cn = cellN(i);
    for (let k = 0; k < COLS; k++) {
      const at = i * COLS + k;
      if (!union[at] || (hidden && hidden[at])) continue;
      const ct = cellT(k);
      if (cn * cn + ct * ct > VISIBLE_REACH * VISIBLE_REACH) continue;
      perCol[k]++;
      perRow[i]++;
      cells++;
    }
  }
  return extentsOf(perCol, perRow, cells);
}

// The visible union's base (design §6): the 2nd percentile of n of the cells
// within |t| ≤ 0.15 U of P, less the dust, in U.
export function visibleBase(union: Grid, hidden: Grid | null): number {
  const ns: number[] = [];
  for (let i = 0; i < ROWS; i++) {
    const cn = cellN(i);
    for (let k = 0; k < COLS; k++) {
      const at = i * COLS + k;
      if (!union[at] || (hidden && hidden[at])) continue;
      const ct = cellT(k);
      if (Math.abs(ct) <= 0.15 && cn * cn + ct * ct <= VISIBLE_REACH * VISIBLE_REACH) ns.push(cn);
    }
  }
  if (!ns.length) return NaN;
  ns.sort((a, b) => a - b);
  return ns[Math.floor(0.02 * ns.length)];
}

