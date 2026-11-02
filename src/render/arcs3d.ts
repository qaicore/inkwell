// Electricity round the limbs (impact design §3): static crawling on a cable.
// Thin blue arcs coil round each limb's tube, sometimes in front of it and
// sometimes behind.
//   - Shape. Each arc is a stretch of helix in the tube's own frame: it spans
//     U[0.20, 0.38] of the length, winds U[0.5, 1.2] turns round it and stands
//     off the axis by d(t) = R·(1.05 + (λ − 1.05)·sin(πt)^0.7), λ in
//     U[1.2, 2.1] (limb.arcLift), so its ends touch down on the skin and its
//     middle rides off it. Kinks of 40–85° jog it every 2–8 arc widths, and
//     55–75 % of it shows, in 1–3 pieces.
//   - Front and back. The sign of ν_z, the depth of the radial direction
//     cos φ·N + sin φ·B, splits each piece into far runs, drawn before the
//     tube chunk (which covers them where they pass behind it), and near runs,
//     drawn after it. A run also takes its tube section's layer, over the
//     person or under the cutout, and splits where that flips. A graze, less
//     than 0.5 px on one side, folds into its neighbour, so the far and the
//     near run always share the point where they meet.
//   - Counts. limb.arcs (3) on an idle limb, 2 while it grows, twice the idle
//     count on the pop, in the strike window (j −8..8) and in the aftermath
//     (j 9..31), plus one arc from each tip down to P on j 9..20.
//   - Timing. The shapes are the limb drawing's, cached with the tube.
//     Placement (where an arc sits, its span and which way it winds) is seeded
//     by floor(k/2), and on the second drawing of each pair it crawls 15 % of
//     its span toward the tip; the turns, φ0, the lift, the kinks and the gaps
//     reseed on every drawing. The glow flickers on ones at composite time
//     (arcFlicker), so a cached drawing never changes. k is the limb's
//     electricity clock (limbClock in pulse.ts): the global drawing on the 2s
//     grid, and every kr step inside the strike window.
//   - Drawing. Each band (edge, body, core) is a stroked polyline whose width
//     steps in quarters toward the tapered ends, each step one straight
//     stretch, and every stretch at one width goes into one stroke() call: at
//     most 12 calls however many arcs. limbs3d's perfect-freehand outlines
//     cost 0.73 ms an arc at 960×540; the budget is 0.45 ms an arc at
//     1080×608 (design §10), shapes included. Only the parts that show are
//     sampled.
// Every random draw is rng(id, 'arc', ...): no Math.random and no clock.
import type { GlowSink, Tube, Vec2, Vec3 } from '../impact/contracts.ts';
import { DISCHARGE, fromOklch, hueDelta, roles, toOklch, type Palette } from '../impact/palette.ts';
import { int, rng, uniform, type Rng } from '../impact/rng.ts';
import { EMERGE } from './electric.ts';
import { hash01 } from './geometry.ts';

export const ARC_WIDTH = 0.0074; // × S: the body band, at its widest
const ARC_LINE = 0.0022; // × S: how much wider the edge band is (limbs3d)
export const ARC_CORE = 0.3; // the core band, × the width
export interface ArcTones {
  edge: string;
  body: string;
  core: string;
}
export const ARC_TONES: Readonly<ArcTones> = { edge: '#07075e', body: '#3a6cff', core: '#a8f6ff' };
export const ARC_LIFT: readonly [number, number] = [1.2, 2.1]; // λ, × r (limb.arcLift)
export const ARC_IDLE = 3; // arcs on an idle limb (limb.arcs)
const SPAN = [0.2, 0.38] as const; // of the limb's length
const TURNS = [0.5, 1.2] as const;
const SKIN = 1.05; // where an arc's ends sit, × r
const LIFT_MEAN = 0.7; // the mean of sin(πt)^0.7 over the arc
const KINK_EVERY = [2, 8] as const; // arc widths of path between kinks
const KINK_DEG = [40, 65] as const; // most kinks turn this far ...
const KINK_WIDE = [65, 85] as const; // ... and 15 % of them this far (lightning §5.3)
const KINK_JOG = [0.5, 1] as const; // arc widths: how long a kink's jog lasts
const KINKS = 24; // kinks drawn per arc, more than the longest arc can use
const VISIBLE = [0.55, 0.75] as const; // of each arc
export const CRAWL = 0.15; // of its span, toward the tip, on a pair's second drawing
export const HOLD = 2; // drawings a placement holds
const ALONG = [0.06, 0.94] as const; // where along the tube an arc may sit
const TIP_ROOM = 0.04; // a growing limb's arcs stop this short of its growing end
export const GROWN = [0.44, 0.75, 0.94, 1]; // design §2: the length a growing limb shows at ages 0..3
const TAPER = 2.5; // arc widths of taper at each end of a piece
const STEPS = 4; // the taper's width steps
const SPACING = 3; // px of arc between samples ...
const SIMPLIFY = 0.2; // ... thinned to this many px off the dense polyline for drawing
const MIN_RUN = 0.5; // px: a shorter stretch on one side of the axis is a graze and folds into its neighbour
const EDGE = 1 + ARC_LINE / ARC_WIDTH; // the edge band's width, × the body's
const FAR_GLOW = 0.5; // far runs glow at half gain: light leaking round the tube
export const TIP_ARCS = [9, 20] as const; // j: the arcs from the tips down to P
const TIP_BOW = 0.18; // a tip arc bows sideways by up to this × its length

// ---- Phases and counts ------------------------------------------------------------

export type ArcPhase =
  | { kind: 'idle' }
  | { kind: 'grow'; age: number } // emergence ages 0..3: the limb shows GROWN[age] of its length
  | { kind: 'pop'; age: number } // emergence ages 4..5: the flash, 1.0 then 0.5
  | { kind: 'coil'; j: number } // j −14..−9: the arcs stay idle; the pulses quicken
  | { kind: 'strike'; j: number } // j −8..8: the strike, then the posters (whose limbs are plain silhouettes, §4)
  | { kind: 'aftermath'; j: number }; // j 9..31

// A limb's phase from its emergence age (limb drawings since the drawing it
// was drawn on; null when it has no emergence) and j (frames since contact;
// null without a slam). Null: the limb isn't out yet. The emergence comes
// first, so a limb still growing in the strike window keeps to its shown part.
export function arcPhase(age: number | null, j: number | null): ArcPhase | null {
  if (age !== null && age < 0) return null;
  if (age !== null && age < EMERGE.grow) return { kind: 'grow', age };
  if (age !== null && age < EMERGE.grow + EMERGE.pop) return { kind: 'pop', age };
  if (j !== null && j >= -14 && j <= -9) return { kind: 'coil', j };
  if (j !== null && j >= -8 && j <= 8) return { kind: 'strike', j };
  if (j !== null && j >= 9 && j <= 31) return { kind: 'aftermath', j };
  return { kind: 'idle' };
}

// Sheath arcs per limb in a phase. `fewer` is the phone tier's cut 6 (design
// §10): the strike window and the aftermath keep the idle count.
export function arcCount(phase: ArcPhase, idle = ARC_IDLE, fewer = false): number {
  const n = Math.max(0, Math.round(idle));
  switch (phase.kind) {
    case 'grow':
      return Math.min(2, n);
    case 'pop':
      return 2 * n;
    case 'strike':
    case 'aftermath':
      return fewer ? n : 2 * n;
    default:
      return n;
  }
}

// Whether the aftermath draws an arc from each tip down to P.
export const tipArcOn = (phase: ArcPhase): boolean => phase.kind === 'aftermath' && phase.j >= TIP_ARCS[0] && phase.j <= TIP_ARCS[1];

// How much of the limb's length shows: all of it, except while it grows.
export const shownOf = (phase: ArcPhase): number => (phase.kind === 'grow' ? GROWN[Math.min(GROWN.length - 1, Math.max(0, Math.floor(phase.age)))] : 1);

// The flash of the pop (design §2): 1.0 on its first drawing, 0.5 on its second.
const flashOf = (phase: ArcPhase): number => (phase.kind !== 'pop' ? 0 : phase.age === EMERGE.grow ? 1 : 0.5);

// ---- Plans: the numbers behind one drawing's arcs -----------------------------------

export interface Kink {
  gap: number; // arc widths of path since the last kink (or the arc's start)
  deg: number; // how far it turns off the arc's heading, signed
  jog: number; // arc widths: how long it heads off before the heading resumes
}

export interface ArcPlan {
  arc: number; // which of the limb's arcs
  s0: number; // where it starts along the tube, 0..1 of the length, crawl included
  span: number; // how much of the length it covers
  base: number; // s0 before the crawl: the pair's placement
  turns: number; // turns round the tube, signed
  phi0: number; // its angle round the tube at the start, radians
  lambda: number; // how far its middle stands off the axis, × r
  kinks: Kink[]; // in order along it; it uses as many as its length holds
  pieces: [number, number][]; // the parts that show, as ranges of t in [0, 1]
  core: number; // the core band's share of the width
}

export interface ArcOptions {
  S: number; // the frame's short side, px: arcs are 0.0074 S wide
  P?: Vec2 | null; // the impact point: the aftermath's tip → P arcs need it
  idle?: number; // limb.arcs: arcs on an idle limb (3)
  lift?: readonly [number, number]; // limb.arcLift: λ's range, × r ([1.2, 2.1])
  fewer?: boolean; // the phone tier's cut: no doubling in the strike window and the aftermath
}

// The plans of drawing k's sheath arcs for limb `id`.
export function arcPlans(id: number, k: number, phase: ArcPhase, opts: Omit<ArcOptions, 'S' | 'P'> = {}): ArcPlan[] {
  const count = arcCount(phase, opts.idle ?? ARC_IDLE, opts.fewer);
  const [liftLo, liftHi] = opts.lift ?? ARC_LIFT;
  const lo = ALONG[0];
  const hi = Math.max(lo, Math.min(ALONG[1], shownOf(phase) - TIP_ROOM));
  const core = ARC_CORE + 0.3 * flashOf(phase); // limbs3d: a flash grows the core toward 0.6 of the width
  const slot = Math.floor(k / HOLD);
  const second = k - slot * HOLD; // 0 on a pair's first drawing, 1 on its second
  return Array.from({ length: count }, (_, arc): ArcPlan => {
    const place = rng(id, 'arc', slot, arc, 0);
    const span = Math.min(uniform(place, SPAN[0], SPAN[1]), (hi - lo) / (1 + CRAWL));
    const winds = place() < 0.5 ? -1 : 1;
    const base = lo + Math.max(0, hi - lo - span * (1 + CRAWL)) * place();
    const shape = rng(id, 'arc', k, arc, 1);
    const turns = winds * uniform(shape, TURNS[0], TURNS[1]);
    const phi0 = uniform(shape, 0, 2 * Math.PI);
    const lambda = uniform(shape, liftLo, liftHi);
    const pieces = piecesOf(shape);
    const kinks = Array.from({ length: KINKS }, () => kinkOf(shape));
    return { arc, s0: base + CRAWL * span * second, span, base, turns, phi0, lambda, kinks, pieces, core };
  });
}

function kinkOf(r: Rng): Kink {
  const [lo, hi] = r() < 0.15 ? KINK_WIDE : KINK_DEG;
  const deg = uniform(r, lo, hi) * (r() < 0.5 ? -1 : 1);
  return { gap: uniform(r, KINK_EVERY[0], KINK_EVERY[1]), deg, jog: uniform(r, KINK_JOG[0], KINK_JOG[1]) };
}

// 55–75 % of the arc in 1–3 pieces, with the gaps between them at least half
// the size of the end gaps on average, so the pieces read as separate.
function piecesOf(r: Rng): [number, number][] {
  const visible = uniform(r, VISIBLE[0], VISIBLE[1]);
  const n = int(r, 1, 3);
  const parts = Array.from({ length: n }, () => uniform(r, 0.6, 1.4));
  const holes = Array.from({ length: n + 1 }, (_, q) => (q === 0 || q === n ? uniform(r, 0.05, 1) : uniform(r, 0.5, 1.5)));
  const partSum = parts.reduce((a, b) => a + b, 0);
  const holeSum = holes.reduce((a, b) => a + b, 0);
  const out: [number, number][] = [];
  let t = 0;
  for (let q = 0; q < n; q++) {
    t += ((1 - visible) * holes[q]) / holeSum;
    const len = (visible * parts[q]) / partSum;
    out.push([t, t + len]);
    t += len;
  }
  return out;
}

// ---- The tube, read anywhere along it ---------------------------------------------------

export interface TubePoint {
  c: Vec3; // centre, camera px
  N: Vec3; // the frame, renormalised after the blend
  B: Vec3;
  r: number; // radius, px
  screen: Vec2; // the centre on screen, frame px
  normal: Vec2; // the screen normal of the projected centreline
  front: boolean; // the nearer section's layer
}

// The tube at arc-length fraction s, blended between its two nearest
// sections; clamped to the ends.
export function sectionAt(tube: Tube, s: number): TubePoint {
  const secs = tube.sections;
  const last = secs.length - 1;
  let i = 0;
  let f = 0;
  if (s >= secs[last].s) {
    i = Math.max(0, last - 1);
    f = last === 0 ? 0 : 1;
  } else if (s > secs[0].s) {
    let lo = 0;
    let hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (secs[mid].s <= s) lo = mid;
      else hi = mid;
    }
    i = lo;
    const span = secs[lo + 1].s - secs[lo].s;
    f = span > 0 ? (s - secs[lo].s) / span : 0;
  }
  const a = secs[i];
  const b = secs[Math.min(last, i + 1)];
  const lerp = (x: number, y: number) => x + (y - x) * f;
  const unit3 = (x: Vec3, y: Vec3): Vec3 => {
    const v: Vec3 = [lerp(x[0], y[0]), lerp(x[1], y[1]), lerp(x[2], y[2])];
    const len = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / len, v[1] / len, v[2] / len];
  };
  const nx = lerp(a.normal[0], b.normal[0]);
  const ny = lerp(a.normal[1], b.normal[1]);
  const nl = Math.hypot(nx, ny) || 1;
  return {
    c: [lerp(a.c[0], b.c[0]), lerp(a.c[1], b.c[1]), lerp(a.c[2], b.c[2])],
    N: unit3(a.N, b.N),
    B: unit3(a.B, b.B),
    r: lerp(a.r, b.r),
    screen: [lerp(a.screen[0], b.screen[0]), lerp(a.screen[1], b.screen[1])],
    normal: [nx / nl, ny / nl],
    front: f < 0.5 ? a.front : b.front,
  };
}

// ---- Geometry -----------------------------------------------------------------------------

// One sample of an arc: its place on the tube (a along it, φ round it, d off
// the axis), where that lands on screen, and ν_z, the depth of its radial
// direction.
export interface ArcSample {
  t: number; // 0..1 along the arc
  a: number; // along the tube, 0..1 of its length
  phi: number; // round it, radians
  d: number; // off the axis, px
  xy: Vec2; // frame px
  nz: number; // ν_z
  front: boolean; // its tube section's layer
}

// A kink's jog, as the change it makes to a and φ from t0 to t1 of the arc.
interface Jog {
  t0: number;
  t1: number;
  da: number;
  dphi: number;
}

// What every sample of one arc reads: its plan, its path's length on the
// tube's surface, px, and its jogs, in order along it.
interface ArcPath {
  plan: ArcPlan;
  length: number;
  jogs: Jog[];
  corners: number[]; // the jogs' ends, in order: each gets a sample
}

// The path of `plan` round `tube` for an arc w px wide. A kink heads `deg` off
// the heading for `jog` widths, then the heading resumes: a sideways step of
// jog·sin(deg) over jog·cos(deg) of path.
function arcPath(tube: Tube, plan: ArcPlan, w: number): ArcPath | null {
  const L = tube.length;
  const mid = sectionAt(tube, plan.s0 + plan.span / 2);
  const dMean = Math.max(1e-6, mid.r * (SKIN + (plan.lambda - SKIN) * LIFT_MEAN));
  const along = plan.span * L; // px on the tube's surface, along it ...
  const around = 2 * Math.PI * Math.abs(plan.turns) * dMean; // ... and round it
  const length = Math.hypot(along, around);
  if (!(length > 0)) return null;
  const hx = along / length; // the heading in (along, around) px
  const hy = (plan.turns < 0 ? -around : around) / length;
  const jogs: Jog[] = [];
  const corners: number[] = [];
  let at = 0;
  for (const k of plan.kinks) {
    at += k.gap * w;
    if (at >= length - w) break;
    const th = (k.deg * Math.PI) / 180;
    const run = k.jog * w * Math.cos(th);
    const side = k.jog * w * Math.sin(th);
    const t0 = at / length;
    const t1 = (at + run) / length;
    jogs.push({ t0, t1, da: (-hy * side) / L, dphi: (hx * side) / dMean });
    corners.push(t0, Math.min(1, t1));
    at += run;
  }
  return { plan, length, jogs, corners };
}

const blankSample = (): ArcSample => ({ t: 0, a: 0, phi: 0, d: 0, xy: [0, 0], nz: 0, front: true });

// The sample at t of an arc, written into `out` so a drawing allocates
// nothing per sample. On screen a point sits at its section's centre plus
// d·(ν_x, ν_y): the local orthographic view the tube is drawn with (design
// §2). The frame is blended between the two nearest sections, as sectionAt
// does; `shown` keeps a growing limb's arcs on the part that shows.
function place(tube: Tube, path: ArcPath, t: number, shown: number, out: ArcSample): void {
  const { plan, jogs } = path;
  let a = plan.s0 + plan.span * t;
  let phi = plan.phi0 + 2 * Math.PI * plan.turns * t;
  for (const g of jogs) {
    if (t <= g.t0) break;
    const f = t >= g.t1 || g.t1 <= g.t0 ? 1 : (t - g.t0) / (g.t1 - g.t0);
    a += g.da * f;
    phi += g.dphi * f;
  }
  a = Math.min(shown, Math.max(0, a));
  const secs = tube.sections;
  const last = secs.length - 1;
  let i = 0;
  let f = 0;
  if (a >= secs[last].s) {
    i = last - 1;
    f = 1;
  } else if (a > secs[0].s) {
    let hi = last;
    while (hi - i > 1) {
      const mid = (i + hi) >> 1;
      if (secs[mid].s <= a) i = mid;
      else hi = mid;
    }
    const span = secs[i + 1].s - secs[i].s;
    f = span > 0 ? (a - secs[i].s) / span : 0;
  }
  const p = secs[i];
  const q = secs[i + 1];
  let nx = p.N[0] + (q.N[0] - p.N[0]) * f;
  let ny = p.N[1] + (q.N[1] - p.N[1]) * f;
  let nz = p.N[2] + (q.N[2] - p.N[2]) * f;
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl;
  ny /= nl;
  nz /= nl;
  let bx = p.B[0] + (q.B[0] - p.B[0]) * f;
  let by = p.B[1] + (q.B[1] - p.B[1]) * f;
  let bz = p.B[2] + (q.B[2] - p.B[2]) * f;
  const bl = Math.hypot(bx, by, bz) || 1;
  bx /= bl;
  by /= bl;
  bz /= bl;
  const r = p.r + (q.r - p.r) * f;
  const d = r * (SKIN + (plan.lambda - SKIN) * Math.sin(Math.PI * t) ** 0.7);
  const cp = Math.cos(phi);
  const sp = Math.sin(phi);
  out.t = t;
  out.a = a;
  out.phi = phi;
  out.d = d;
  out.xy[0] = p.screen[0] + (q.screen[0] - p.screen[0]) * f + d * (cp * nx + sp * bx);
  out.xy[1] = p.screen[1] + (q.screen[1] - p.screen[1]) * f + d * (cp * ny + sp * by);
  out.nz = cp * nz + sp * bz;
  out.front = f < 0.5 ? p.front : q.front;
}

// The t of every sample in the piece t0..t1 of an arc whose path is `length`
// px long, in order: about every 3 px of path, and every kink corner inside it.
function pieceTs(length: number, corners: readonly number[], t0: number, t1: number, each: (t: number) => void) {
  const n = Math.min(200, Math.max(2, Math.ceil(((t1 - t0) * length) / SPACING) + 1));
  let c = 0;
  let last = -Infinity;
  const take = (t: number) => {
    if (t - last < 1e-9) return;
    last = t;
    each(t);
  };
  for (let q = 0; q < n; q++) {
    const t = q === n - 1 ? t1 : t0 + ((t1 - t0) * q) / (n - 1);
    for (; c < corners.length && corners[c] < t; c++) if (corners[c] > t0) take(corners[c]);
    take(t);
  }
}

// The samples of `plan`'s pieces round `tube`, the parts of the arc that
// show, in order. w is the arc width, px; `shown` the share of the limb that
// shows.
export function arcSamples(tube: Tube, plan: ArcPlan, w: number, shown = 1): ArcSample[] {
  if (tube.sections.length < 2 || !(tube.length > 0) || !(w > 0)) return [];
  const path = arcPath(tube, plan, w);
  if (!path) return [];
  const out: ArcSample[] = [];
  const at = blankSample();
  for (const [t0, t1] of plan.pieces) {
    pieceTs(path.length, path.corners, t0, t1, (t) => {
      place(tube, path, t, shown, at);
      out.push({ ...at, xy: [at.xy[0], at.xy[1]] });
    });
  }
  return out;
}

// ---- Runs -------------------------------------------------------------------------------------

// A stretch of one arc that is drawn in one go: on one side of the tube's axis
// and in one layer. The far ones go before the tube chunk, the near ones after.
export interface ArcRun {
  kind: 'sheath' | 'tip'; // round the tube, or from the tip down to P
  arc: number; // which of the limb's arcs it belongs to
  points: Vec2[]; // frame px
  width: number[]; // the body band's width at each point, px, tapered toward its piece's ends
  base: number; // the arc's full body width, px: the taper steps in quarters of it
  core: number; // the core band's share of the width
  // ν_z at each point, on the run's side of 0: a graze under 0.5 px, folded
  // into its neighbour, reads 0, and so does the point a far run and a near
  // run share.
  nz: number[];
  near: boolean; // ν_z ≥ 0: drawn after the tube chunk
  front: boolean; // in the front layer, over the person, or under the cutout
  s: number; // where along the tube its middle sits, 0..1
}

export interface SheathArcs {
  far: ArcRun[];
  near: ArcRun[];
}

// Drawing k's arcs round one limb (k: limbClock), split far and near. Each
// run carries its width profile, so drawArcs and emitArcs need nothing else.
export function sheathArcs(tube: Tube, k: number, phase: ArcPhase, id: number, opts: ArcOptions): SheathArcs {
  const out: SheathArcs = { far: [], near: [] };
  if (tube.sections.length < 2 || !(tube.length > 0)) return out;
  const w = ARC_WIDTH * opts.S;
  const shown = shownOf(phase);
  const plans = arcPlans(id, k, phase, opts);
  const at = blankSample();
  for (const plan of plans) {
    const path = arcPath(tube, plan, w);
    if (!path) continue;
    for (const [t0, t1] of plan.pieces) {
      const piece = emptyTrace();
      pieceTs(path.length, path.corners, t0, t1, (t) => {
        place(tube, path, t, shown, at);
        piece.x.push(at.xy[0]);
        piece.y.push(at.xy[1]);
        piece.nz.push(at.nz);
        piece.a.push(at.a);
        piece.front.push(at.front);
      });
      for (const run of runsOf(piece, 'sheath', plan.arc, plan.core, w)) (run.near ? out.near : out.far).push(run);
    }
  }
  if (opts.P && tipArcOn(phase)) out.near.push(...tipArc(tube, opts.P, id, k, plans.length, w));
  return out;
}

// One piece of an arc as parallel lists, one entry a sample.
interface Trace {
  x: number[]; // frame px
  y: number[];
  nz: number[]; // ν_z
  a: number[]; // along the tube, 0..1
  front: boolean[]; // its tube section's layer
}

const emptyTrace = (): Trace => ({ x: [], y: [], nz: [], a: [], front: [] });

// A piece's samples as the runs to draw:
//   1. It is split wherever ν_z changes sign (at the crossing, which both
//      runs share, ν_z 0) or the tube's layer flips (halfway between the
//      samples), and a point goes in at each of the taper's steps, so every
//      step falls exactly on its quarter of the taper: one straight stretch.
//   2. A stretch under 0.5 px on one side of the axis is a graze, not a
//      crossing: it folds into its neighbour, so every split point stays
//      shared by the two runs either side of it.
//   3. Each run is thinned for drawing.
function runsOf(tr: Trace, kind: ArcRun['kind'], arc: number, core: number, w: number): ArcRun[] {
  const m = tr.x.length;
  if (m < 2) return [];
  const cum = [0];
  for (let i = 1; i < m; i++) cum.push(cum[i - 1] + Math.hypot(tr.x[i] - tr.x[i - 1], tr.y[i] - tr.y[i - 1]));
  const total = cum[m - 1];
  if (!(total >= MIN_RUN)) return [];
  const reach = Math.min(TAPER * w, 0.3 * total);
  const steps: number[] = []; // screen px from the piece's start where the width steps, in order
  for (let q = 1; q <= STEPS; q++) steps.push((reach * q) / STEPS);
  for (let q = STEPS; q >= 1; q--) steps.push(total - (reach * q) / STEPS);
  const sideOf = (i: number) => (tr.nz[i] >= 0 ? 1 : 0) | (tr.front[i] ? 2 : 0);
  // The points, in order: the samples, and between them the splits and the steps.
  const pt = { x: [] as number[], y: [] as number[], nz: [] as number[], a: [] as number[], c: [] as number[], side: [] as number[], pin: [] as boolean[], cut: [] as boolean[] };
  const add = (x: number, y: number, nz: number, a: number, c: number, side: number, pin: boolean, cut: boolean) => {
    pt.x.push(x);
    pt.y.push(y);
    pt.nz.push(nz);
    pt.a.push(a);
    pt.c.push(c);
    pt.side.push(side);
    pt.pin.push(pin);
    pt.cut.push(cut);
  };
  add(tr.x[0], tr.y[0], tr.nz[0], tr.a[0], 0, sideOf(0), true, false);
  const inside: { f: number; cut: boolean }[] = [];
  let next = 0; // the next step to place
  for (let i = 1; i < m; i++) {
    inside.length = 0;
    let crossing = false;
    if (sideOf(i) !== sideOf(i - 1)) {
      crossing = (tr.nz[i] >= 0) !== (tr.nz[i - 1] >= 0);
      inside.push({ f: crossing ? tr.nz[i - 1] / (tr.nz[i - 1] - tr.nz[i]) : 0.5, cut: true });
    }
    const len = cum[i] - cum[i - 1];
    let pinned = i === m - 1;
    for (; next < steps.length && steps[next] <= cum[i]; next++) {
      if (steps[next] === cum[i]) pinned = true; // a step right on the sample
      else if (steps[next] > cum[i - 1] && len > 0) inside.push({ f: (steps[next] - cum[i - 1]) / len, cut: false });
    }
    if (inside.length > 1) inside.sort((u, v) => u.f - v.f);
    for (const { f: raw, cut } of inside) {
      const f = Math.min(1 - 1e-9, Math.max(1e-9, raw)); // never on a sample
      const lerp = (u: number, v: number) => u + (v - u) * f;
      add(lerp(tr.x[i - 1], tr.x[i]), lerp(tr.y[i - 1], tr.y[i]), cut && crossing ? 0 : lerp(tr.nz[i - 1], tr.nz[i]), lerp(tr.a[i - 1], tr.a[i]), lerp(cum[i - 1], cum[i]), -1, true, cut);
    }
    add(tr.x[i], tr.y[i], tr.nz[i], tr.a[i], cum[i], sideOf(i), pinned, false);
  }
  // Cut at the splits; a run's side is its samples'.
  const n = pt.x.length;
  type Span = { i0: number; i1: number; side: number };
  const spans: Span[] = [];
  let i0 = 0;
  let side = -1;
  for (let i = 0; i < n; i++) {
    if (side < 0) side = pt.side[i];
    if (i > 0 && (pt.cut[i] || i === n - 1)) {
      spans.push({ i0, i1: i, side });
      i0 = i;
      side = -1;
    }
  }
  const length = (s: Span) => pt.c[s.i1] - pt.c[s.i0];
  const kept: Span[] = [];
  for (const s of spans) {
    const prev = kept[kept.length - 1];
    if (prev && (prev.side === s.side || length(s) < MIN_RUN)) prev.i1 = s.i1;
    else kept.push({ ...s });
  }
  if (kept.length > 1 && length(kept[0]) < MIN_RUN) {
    kept[1].i0 = kept[0].i0; // a graze at the start has nothing before it to fold into
    kept.shift();
  }
  const widthAt = (c: number) => w * Math.min(1, Math.max(0, Math.min(c, total - c) / reach));
  return kept.map(({ i0: from, i1: to, side: sd }, r): ArcRun => {
    const near = (sd & 1) === 1;
    const keep = thinned(pt.x, pt.y, pt.pin, from, to);
    const nz = keep.map((i) => (near ? Math.max(0, pt.nz[i]) : Math.min(0, pt.nz[i])));
    if (r > 0 && (kept[r - 1].side & 1) !== (sd & 1)) nz[0] = 0;
    if (r < kept.length - 1 && (kept[r + 1].side & 1) !== (sd & 1)) nz[nz.length - 1] = 0;
    return {
      kind,
      arc,
      points: keep.map((i): Vec2 => [pt.x[i], pt.y[i]]),
      width: keep.map((i) => widthAt(pt.c[i])),
      base: w,
      core,
      nz,
      near,
      front: (sd & 2) === 2,
      s: pt.a[keep[keep.length >> 1]],
    };
  });
}

// Which of the points from..to to draw: the pinned ones (the run's ends, its
// splits and the taper's steps) and, between them, Douglas–Peucker to 0.2 px.
// The samples sit 3 px apart for the turns of the helix; on its straighter
// stretches most of them add nothing but cost: the stroker's time goes with
// the segments.
function thinned(x: number[], y: number[], pin: boolean[], from: number, to: number): number[] {
  const keep = new Uint8Array(to - from + 1);
  keep[0] = 1;
  keep[to - from] = 1;
  for (let i = from + 1; i < to; i++) if (pin[i]) keep[i - from] = 1;
  const stack: number[] = [];
  for (let a = from, b = from + 1; b <= to; b++) {
    if (!keep[b - from]) continue;
    if (b - a > 1) stack.push(a, b);
    while (stack.length > 0) {
      const hi = stack.pop() as number;
      const lo = stack.pop() as number;
      const dx = x[hi] - x[lo];
      const dy = y[hi] - y[lo];
      const len2 = dx * dx + dy * dy;
      let worst = -1;
      let at = -1;
      for (let i = lo + 1; i < hi; i++) {
        const u = len2 > 0 ? Math.min(1, Math.max(0, ((x[i] - x[lo]) * dx + (y[i] - y[lo]) * dy) / len2)) : 0;
        const dist = Math.hypot(x[i] - x[lo] - u * dx, y[i] - y[lo] - u * dy);
        if (dist > worst) {
          worst = dist;
          at = i;
        }
      }
      if (worst > SIMPLIFY) {
        keep[at - from] = 1;
        if (at - lo > 1) stack.push(lo, at);
        if (hi - at > 1) stack.push(at, hi);
      }
    }
    a = b;
  }
  const out: number[] = [];
  for (let i = from; i <= to; i++) if (keep[i - from]) out.push(i);
  return out;
}

// The aftermath's arc from a released tip down to P (design §6): a bowed
// chord with the sheath arcs' kinks, all of it showing, over the person. It
// comes back as one run, or none when the tip is already on P.
function tipArc(tube: Tube, P: Vec2, id: number, k: number, arc: number, w: number): ArcRun[] {
  const tip = tube.sections[tube.sections.length - 1].screen;
  const dx = P[0] - tip[0];
  const dy = P[1] - tip[1];
  const len = Math.hypot(dx, dy);
  if (!(len > 2 * w)) return [];
  const px = -dy / len; // across the chord
  const py = dx / len;
  const r = rng(id, 'arc', k, arc, 2);
  const bow = uniform(r, -TIP_BOW, TIP_BOW) * len;
  const jogs: { t0: number; t1: number; side: number }[] = [];
  const corners: number[] = [];
  let at = 0;
  for (let q = 0; q < KINKS; q++) {
    const kink = kinkOf(r);
    at += kink.gap * w;
    if (at >= len - w) break;
    const th = (kink.deg * Math.PI) / 180;
    const run = kink.jog * w * Math.cos(th);
    jogs.push({ t0: at / len, t1: (at + run) / len, side: kink.jog * w * Math.sin(th) });
    corners.push(at / len, Math.min(1, (at + run) / len));
    at += run;
  }
  const off = (t: number) => jogs.reduce((sum, g) => sum + g.side * (t <= g.t0 ? 0 : t >= g.t1 || g.t1 <= g.t0 ? 1 : (t - g.t0) / (g.t1 - g.t0)), 0);
  const end = off(1); // taken back out linearly, so the arc lands on P
  const trace = emptyTrace();
  pieceTs(len, corners, 0, 1, (t) => {
    const e = off(t) - end * t + bow * Math.sin(Math.PI * t);
    trace.x.push(tip[0] + dx * t + px * e);
    trace.y.push(tip[1] + dy * t + py * e);
    trace.nz.push(1);
    trace.a.push(1);
    trace.front.push(true);
  });
  return runsOf(trace, 'tip', arc, ARC_CORE, w);
}

// ---- Drawing --------------------------------------------------------------------------------

// The polyline half of a canvas path, which drawArcs can trace once and
// stroke in every band: the browser's Path2D and @napi-rs/canvas's both fit,
// and so does the context itself.
export interface LinePath {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
}

// The canvas calls drawArcs uses; the browser's 2D context and @napi-rs/canvas
// both have them.
export interface ArcTarget extends LinePath {
  strokeStyle: unknown;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  beginPath(): void;
  stroke(path?: LinePath): void;
}

// The page's Path2D, where there is one: the browser has it on the main thread
// and in workers; Node doesn't, so pass @napi-rs/canvas's to drawArcs there.
export const nativePath = (): (() => LinePath) | null => (typeof Path2D === 'function' ? () => new Path2D() : null);

const BANDS = ['edge', 'body', 'core'] as const;

// The three bands of every run: edge, then body, then core, each a stroked
// polyline. A run is cut into stretches of one width step (its segments' mean
// width rounded up to a quarter of the full width), and all the stretches at
// one step share a path, which each band strokes at its own width: for runs
// of one width and core share, 4 paths and 12 stroke() calls however many
// runs. With `newPath` (a Path2D maker for this ctx) each path is traced once
// for all three bands, which in Node saves two thirds of the canvas calls;
// without one it is traced on the context for each band. Both draw the same
// pixels. Caps are butt: stretches meet on a straight segment (runsOf puts a
// point at every step and split), so they join flush, where a round cap would
// cost as much again and draw the near run's dark edge over the far run at
// every crossing. Joins are round, so a kink's corner stays filled.
export function drawArcs(ctx: ArcTarget, runs: readonly ArcRun[], tones: Readonly<ArcTones> = ARC_TONES, newPath: (() => LinePath) | null = nativePath()) {
  // The stretches by width step, base and core share, in the order they come.
  type Stretch = { run: ArcRun; from: number; to: number };
  const groups = new Map<string, { body: number; core: number; stretches: Stretch[] }>();
  for (const run of runs) {
    const { points, width, base } = run;
    if (points.length < 2 || !(base > 0)) continue;
    let from = 0;
    let step = 0;
    const close = (to: number) => {
      const key = `${step} ${base} ${run.core}`;
      let group = groups.get(key);
      if (!group) groups.set(key, (group = { body: (base * step) / STEPS, core: run.core, stretches: [] }));
      group.stretches.push({ run, from, to });
    };
    for (let i = 0; i < points.length - 1; i++) {
      const q = Math.min(STEPS, Math.max(1, Math.ceil((STEPS * (width[i] + width[i + 1])) / (2 * base) - 1e-6)));
      if (i === 0) step = q;
      else if (q !== step) {
        close(i);
        from = i;
        step = q;
      }
    }
    close(points.length - 1);
  }
  if (groups.size === 0) return;
  const trace = (path: LinePath, stretches: readonly Stretch[]) => {
    for (const { run, from, to } of stretches) {
      const pts = run.points;
      path.moveTo(pts[from][0], pts[from][1]);
      for (let i = from + 1; i <= to; i++) path.lineTo(pts[i][0], pts[i][1]);
    }
  };
  const paths = newPath ? [...groups.values()].map(({ stretches }) => {
    const path = newPath();
    trace(path, stretches);
    return path;
  }) : null;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';
  for (const band of BANDS) {
    ctx.strokeStyle = tones[band];
    let g = 0;
    for (const { body, core, stretches } of groups.values()) {
      const w = band === 'edge' ? body * EDGE : band === 'core' ? body * core : body;
      ctx.lineWidth = Math.round(w * 100) / 100;
      if (paths) ctx.stroke(paths[g]);
      else {
        ctx.beginPath();
        trace(ctx, stretches);
        ctx.stroke();
      }
      g++;
    }
  }
}

// The arcs' glow into the global buffers (design §7): the body and the core
// of every run, the far ones at half gain. The flicker isn't in here: the
// composite multiplies the cached emission by arcFlicker on each kr step.
export function emitArcs(sink: GlowSink, runs: readonly ArcRun[], gain: number, tones: Readonly<ArcTones> = ARC_TONES) {
  for (const run of runs) {
    if (run.points.length < 2) continue;
    const g = run.near ? gain : gain * FAR_GLOW;
    sink.stroke(run.points, run.base, tones.body, 'body', g);
    sink.stroke(run.points, run.base * run.core, tones.core, 'core', g);
  }
}

// The arc glow's gain on the 1s clock c1 (WP0's clock.ts: kr with a slam,
// k24 without): it flickers at 24 a second, like the reference, and holds on
// both frames of a 2-frame step.
export const arcFlicker = (id: number, c1: number): number => 0.6 + 0.4 * hash01(id, c1, 7);

// The arcs' tones for a palette (design §9): limbs3d's blues, turned in OKLCH
// hue with the discharge set, which roles() turns by h(p0) − 262° when p0's
// hue is within 60° of the measured blues' and leaves alone otherwise.
export function arcTones(palette: Palette): ArcTones {
  const turn = hueDelta(toOklch(DISCHARGE.band).h, toOklch(roles(palette).discharge.band).h);
  if (Math.abs(turn) < 1e-6) return { ...ARC_TONES };
  const rotate = (color: string) => {
    const c = toOklch(color);
    return fromOklch({ ...c, h: (c.h + turn + 360) % 360 });
  };
  return { edge: rotate(ARC_TONES.edge), body: rotate(ARC_TONES.body), core: rotate(ARC_TONES.core) };
}
