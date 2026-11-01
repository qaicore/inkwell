// The strike controller (impact design §4, "Physics"): the orders the lift's
// strike hook (lift.ts, strand3d.ts) gives each limb's chain on every physics
// step, so the limbs coil back, whip down onto the impact point P, stay
// nailed there through the strike and the posters, and rebound.
//
// Limbs first (decision 2): the tips land on P at I − 7 (f77 on the hero),
// stay pinned through the strike, the splash and the charge (j −8..−1) and
// the white-out on the fist contact (I, f84), and let go at I + 9 (f93).
// Fist first is out of scope. Every phase is relative to the landing frame
// `land` and the release frame `release`, and τ = f − 1 + sub/steps is when
// a step ends, in frames:
//   - coil, frames land − 7..land − 2: each target is turned about its root
//     in the screen plane, z kept, away from P by 30°·ease_in(p), with
//     p = (τ − (land − 7))/6, the design's (j + 14)/6: 0 at the end of
//     land − 7, 5/6 at the end of land − 2, the full turn on the strike frame.
//     The stiffness ramps with p from the stroke's own (0.1) toward 0.5, but
//     only as far as lets the pull add 8 torso heights a second to a tip that
//     lags its target (a stiffened spring far from its target is a fast one),
//     and never below the stroke's own;
//   - strike, land − 1: the full coil mixed 0.35 of the way to the strike
//     curve C, at stiffness 1: the whip;
//   - pinned, land..release − 1: C itself at stiffness 1, the tip pinned
//     where it projects onto P at the curve's z, and the rest lengths scaled
//     so the chain is exactly as long as C. The hook takes one scale for
//     every rest length, so a segment is |C|/(n − 1) when the drawing's
//     nodes are evenly spaced, and keeps the drawing's proportions otherwise;
//   - release, from release: unpinned, and the drawing's own target and
//     stiffness are back at once (no override). The rest lengths ease back
//     from C's over 4 drawings (smoothstep), and on the release's first step
//     every node gets the recoil, −d̂·1.5 unit/s·t_i plus a seeded lateral of
//     ±0.4× that (t_i the node's arc fraction). After the ease the limb is
//     the lift's again. The target goes back at once on purpose: easing it
//     back as well leaves a chain squeezed onto a short C to regrow along C's
//     end, which drives the tips on through the floor.
//
// The strike curve, in frame px: C(t) = R + (P − R)·t + 0.12·side·n̂·
// sin(πt)·|P − R|, with R the root on screen, n̂ = (−u_y, u_x) the chord's
// normal and side the way the drawn limb bows (bulgeSide), and z(t) =
// z_root + 0.25·unit·smoothstep(0.1, 0.4, t), so the slammed limbs come
// forward of his back. C is similarity-covariant about P: the stamp that
// carries the root to the next frame's root keeps the tip on P (design §4,
// "Clock"). The chain's nodes sit on C at the drawing's own arc fractions,
// so the target and the scaled rest lengths agree.
//
// Pure: an order is a function of the step and the options alone, so two
// runs give the same arrays; nothing reads Math.random or a clock.
import type { LimbControl, StrikeController, StrikeLimb, StrikeStep, Vec2, Vec3 } from '../impact/contracts.ts';
import { rng, uniform } from '../impact/rng.ts';
import { project, unproject, type Body3D } from './body.ts';

// Design §4 and §9's slam rows.
export const STRIKE = {
  land: -7, // limbs first: the tips land on P at I − 7 ...
  release: 9, // ... and let go at I + 9
  coilFrames: 6, // land − 7..land − 2
  coilDeg: 30,
  coilStiffness: 0.5,
  whip: 0.35, // the strike frame's weight on C
  bulge: 0.12, // × |P − R|
  lift: 0.25, // torso heights toward the camera at the tip ...
  liftSpan: [0.1, 0.4] as const, // ... by smoothstep over this stretch of the curve
  easeDrawings: 4, // the rest lengths ease back over this many drawings
  recoil: 1.5, // torso heights a second along −d̂, at the tip
  lateral: 0.4, // ± × the recoil, across d̂, seeded per limb
  coilSpeed: 8, // torso heights a second the coil's stiffening may add to a lagging tip
};
const CURVE_SAMPLES = 96; // C is read off this many pieces at the chain's arc fractions

// The landing and the release for contact frame I, limbs first.
export const limbsFirst = (I: number): { land: number; release: number } => ({ land: I + STRIKE.land, release: I + STRIKE.release });

// The frames SPEC P3's speed guard skips (design §4, "Speed guard"): the
// whip, the landing (the tips cross 466–1045 px in those two frames on the
// hero, by design) and the release. SPEC A7 exempts a preset strike already.
export const speedExempt = (f: number, strike: { land: number; release: number }): boolean =>
  f === strike.land - 1 || f === strike.land || f === strike.release;

export interface StrikeLimbSpec {
  id: number; // the stroke id
  side?: 1 | -1; // the way its strike curve bows: bulgeSide of the drawn stroke. Missing = of its target on each step
}

export interface StrikeOptions {
  land: number; // the output frame the tips land on P
  release: number; // the output frame they let go
  P: Vec2; // the impact point, frame px
  d: Vec2; // the strike direction on screen (normalised here)
  limbs: readonly StrikeLimbSpec[]; // the limbs that slam down; any other chain is left alone
  unit: number; // px per torso height: the lift toward the camera and the recoil
  seed: number; // the recoil's lateral
  dps?: number; // drawings a second, for the release's ease (12)
  fps?: number; // (30)
}

export type StrikePhase =
  | { kind: 'none' } // before the coil, or once the release has eased out: no orders
  | { kind: 'coil'; p: number } // 0..1
  | { kind: 'strike' }
  | { kind: 'pinned' }
  | { kind: 'release'; q: number; first: boolean }; // q 0..1 through the ease; first: the recoil's step

// Which phase a step is in. `easeFrames` is the release's ease, frames.
export function strikePhase(f: number, sub: number, steps: number, strike: { land: number; release: number }, easeFrames: number): StrikePhase {
  const { land, release } = strike;
  const tau = f - 1 + sub / steps;
  const coilFrom = land - 1 - STRIKE.coilFrames;
  if (f < coilFrom) return { kind: 'none' };
  if (f < land - 1) return { kind: 'coil', p: clamp01((tau - coilFrom) / STRIKE.coilFrames) };
  if (f === land - 1) return { kind: 'strike' };
  if (f < release) return { kind: 'pinned' };
  const q = (tau - (release - 1)) / easeFrames;
  if (q > 1) return { kind: 'none' };
  return { kind: 'release', q, first: f === release && sub === 1 };
}

// Which side of its own chord (root to tip) a drawn limb bows to: +1 toward
// the chord's normal (−u_y, u_x), −1 away from it, by the signed area the
// limb and its chord enclose. A straight or evenly S-shaped limb gets +1.
export function bulgeSide(points: readonly Vec2[]): 1 | -1 {
  const [x0, y0] = points[0];
  let area = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    area += (ax - x0) * (by - y0) - (ay - y0) * (bx - x0);
  }
  return area > 0 ? -1 : 1;
}

// The strike curve on screen at t in 0..1, from root R to P.
export function strikeCurve(R: Vec2, P: Vec2, side: 1 | -1, t: number): Vec2 {
  const ux = P[0] - R[0];
  const uy = P[1] - R[1];
  const bow = STRIKE.bulge * side * Math.sin(Math.PI * t); // × n̂·|P − R| = (−u_y, u_x)
  return [R[0] + ux * t - uy * bow, R[1] + uy * t + ux * bow];
}

export function strikeController(o: StrikeOptions): StrikeController {
  const { land, release, P } = o;
  if (!Number.isInteger(land) || !Number.isInteger(release) || release <= land) {
    throw new Error(`strikeController needs whole frames with land < release (got ${land}, ${release})`);
  }
  if (!(o.unit > 0)) throw new Error(`strikeController needs a positive unit (got ${o.unit})`);
  const strike = { land, release };
  const fps = o.fps ?? 30;
  const easeFrames = (STRIKE.easeDrawings * fps) / (o.dps ?? 12);
  const dLen = Math.hypot(o.d[0], o.d[1]);
  const d: Vec2 = dLen > 0 ? [o.d[0] / dLen, o.d[1] / dLen] : [0, 1];
  const specs = new Map(o.limbs.map((s) => [s.id, s]));
  const lateral = new Map(o.limbs.map((s) => [s.id, uniform(rng(o.seed, 'recoil', s.id), -STRIKE.lateral, STRIKE.lateral)]));
  const liftPx = STRIKE.lift * o.unit;
  const recoilPx = STRIKE.recoil * o.unit;

  const order = (l: StrikeLimb, at: StrikeStep, phase: StrikePhase): LimbControl | null => {
    const spec = specs.get(l.id);
    const n = l.target.length;
    if (!spec || phase.kind === 'none' || n < 2) return null;
    const b = at.body;
    const target = l.target;
    const fr = arcFractions(target);
    if (phase.kind === 'coil') {
      const s0 = l.stiffness;
      const wound = coil(b, target, P, phase.p);
      const ramp = s0 + (Math.max(s0, STRIKE.coilStiffness) - s0) * phase.p;
      // The pull is a spring: stiffness s on a tip e torso heights from its
      // target swings it at about s·e/(√2·dt) torso heights a second.
      const e = dist3(wound[n - 1], l.points[n - 1]) / b.unit;
      const dt = 1 / (fps * at.steps);
      const cap = e > 0 ? (STRIKE.coilSpeed * dt * Math.SQRT2) / e : ramp;
      return { target: wound, stiffness: Math.max(s0, Math.min(ramp, cap)) };
    }
    const side = spec.side ?? bulgeSide(target.map((q) => project(b, q).xy));
    const curve = curveNodes(b, target[0], P, side, liftPx, fr);
    const drawn = polyLength(target);
    const scale = drawn > 0 ? curve.length / drawn : 1;
    if (phase.kind === 'strike') {
      const wound = coil(b, target, P, 1);
      return { target: wound.map((q, i) => mix3(q, curve.nodes[i], STRIKE.whip)), stiffness: 1 };
    }
    if (phase.kind === 'pinned') return { target: curve.nodes, stiffness: 1, pin: curve.nodes[n - 1], restScale: scale };
    // The release: the drawing's own target and stiffness (no override), the
    // rest lengths easing back from C's.
    const grow = smooth(phase.q);
    const out: LimbControl = { pin: null, restScale: grow >= 1 ? 1 : scale + (1 - scale) * grow };
    if (phase.first) {
      const across = lateral.get(l.id) ?? 0;
      const vx = recoilPx * (-d[0] - across * d[1]); // −d̂ plus `across` of (−d_y, d_x)
      const vy = recoilPx * (-d[1] + across * d[0]);
      out.impulse = fr.map((t): Vec3 => [vx * t, vy * t, 0]);
    }
    return out;
  };

  return {
    land,
    release,
    step(at) {
      const phase = strikePhase(at.f, at.sub, at.steps, strike, easeFrames);
      return at.limbs.map((l) => order(l, at, phase));
    },
  };
}

// ---- Geometry ------------------------------------------------------------------------------

// The target turned about its root on screen, away from P, by 30°·ease_in(p),
// each point at its own depth. It turns whichever way takes the tip away from
// P; a limb pointing within 15° of P (or straight away from it) has no clear
// way, so its coil fades out there instead of flipping between the two.
function coil(b: Body3D, target: readonly Vec3[], P: Vec2, p: number): Vec3[] {
  const R = project(b, target[0]).xy;
  const tip = project(b, target[target.length - 1]).xy;
  const [ax, ay] = [tip[0] - R[0], tip[1] - R[1]];
  const [cx, cy] = [P[0] - R[0], P[1] - R[1]];
  const sin = (ax * cy - ay * cx) / (Math.hypot(ax, ay) * Math.hypot(cx, cy) || 1); // > 0: P is clockwise of the tip
  const away = -clamp(sin / Math.sin((15 * Math.PI) / 180), -1, 1);
  const angle = away * ((STRIKE.coilDeg * Math.PI) / 180) * p * p * p;
  return target.map((q, i) => (i === 0 ? copy3(q) : turnAbout(b, R, q, angle)));
}

// A camera-px point turned on screen about R by `angle`, at its own depth.
function turnAbout(b: Body3D, R: Vec2, q: Vec3, angle: number): Vec3 {
  if (angle === 0) return copy3(q);
  const [x, y] = project(b, q).xy;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const [dx, dy] = [x - R[0], y - R[1]];
  return unproject(b, [R[0] + c * dx - s * dy, R[1] + s * dx + c * dy], q[2]);
}

// C in camera px at the chain's arc fractions `fr`: sampled finely in t,
// lifted to z(t), then read off by arc length. The root is the target's own
// and the tip projects exactly onto P. `length` is the node polyline's.
function curveNodes(b: Body3D, root: Vec3, P: Vec2, side: 1 | -1, liftPx: number, fr: readonly number[]): { nodes: Vec3[]; length: number } {
  const R = project(b, root).xy;
  const [lo, hi] = STRIKE.liftSpan;
  const fine: Vec3[] = [];
  const along = [0];
  for (let k = 0; k <= CURVE_SAMPLES; k++) {
    const t = k / CURVE_SAMPLES;
    const z = root[2] + liftPx * smoothstepAt(lo, hi, t);
    fine.push(k === 0 ? [root[0], root[1], root[2]] : unproject(b, k === CURVE_SAMPLES ? P : strikeCurve(R, P, side, t), z));
    if (k > 0) along.push(along[k - 1] + dist3(fine[k - 1], fine[k]));
  }
  const total = along[CURVE_SAMPLES];
  let k = 0;
  const nodes = fr.map((t, i): Vec3 => {
    if (i === 0) return fine[0];
    if (i === fr.length - 1) return fine[CURVE_SAMPLES];
    const at = t * total;
    while (k < CURVE_SAMPLES - 1 && along[k + 1] < at) k++;
    const w = along[k + 1] > along[k] ? (at - along[k]) / (along[k + 1] - along[k]) : 0;
    return mix3(fine[k], fine[k + 1], w);
  });
  return { nodes, length: polyLength(nodes) };
}

// Each node's share of the way along the chain, 0 at the root and 1 at the tip.
function arcFractions(pts: readonly Vec3[]): number[] {
  const out = [0];
  for (let i = 1; i < pts.length; i++) out.push(out[i - 1] + dist3(pts[i - 1], pts[i]));
  const total = out[pts.length - 1];
  return out.map((s, i) => (total > 0 ? s / total : i / (pts.length - 1)));
}

function polyLength(pts: readonly Vec3[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist3(pts[i - 1], pts[i]);
  return s;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const clamp01 = (x: number) => clamp(x, 0, 1);
const smooth = (x: number) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};
const smoothstepAt = (a: number, b: number, x: number) => smooth((x - a) / (b - a));
const copy3 = (q: Vec3): Vec3 => [q[0], q[1], q[2]];
const mix3 = (a: Vec3, b: Vec3, w: number): Vec3 => [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w];
const dist3 = (a: Vec3, b: Vec3) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
