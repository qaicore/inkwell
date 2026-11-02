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
// a step ends, in frames. A whip crack, not a turning rod (decision 15):
//   - coil, frames land − 7..land − 3: each target is turned about its root
//     in the screen plane, z kept, away from P by 30°·ease_in(p_i), root
//     first: node i starts coilDelay·t_i frames after the root (t_i its arc
//     fraction) and would be fully wound at τ = land − 1, so
//     p_i = (τ − (land − 7) − coilDelay·t_i)/(6 − coilDelay·t_i), the root's
//     the design's (j + 14)/6. The stiffness ramps with the root's p from the
//     stroke's own (0.1) toward 0.5, but only as far as lets the pull add 8
//     torso heights a second to a tip that lags its target (a stiffened
//     spring far from its target is a fast one), and never below the stroke's own;
//   - strike, land − 2..land (whipFrames): the whip. A front runs down the
//     limb: node i comes over from the coil (still winding) to the strike
//     curve C over whipSpan of the whip from whip·t_i² of it (the front runs
//     on faster as the rope thins), so the inner half comes over first, the
//     outer last, and the tip comes down onto P last and fastest, on land
//     itself. The whip is laid on the chain (its own tip pinned, so the lift
//     places it exactly; stiffness 1): from where the chain is, each segment
//     turned at least catchUp of the way a step onto the whip's, so the
//     rope's drag can't carry the outer half over with the inner;
//   - pinned, land + 1..release − 1: C with a ripple running down it (zero at
//     both ends, seeded per limb; the whip's C has it too), at pinStiffness,
//     the tip pinned where C's end projects onto P, so the chain is laid on
//     C (the lift's kinematic pin) and the rest lengths scaled so the chain
//     is exactly as long as the rippled curve. The hook takes one scale for
//     every rest length, so a segment is |C|/(n − 1) when the drawing's
//     nodes are evenly spaced, and keeps the drawing's proportions otherwise;
//   - release, from release, eased over easeDrawings (8): unpinned, and the
//     drawn length back within the frame (decision 15: never longer than
//     about 1.15× it, never straight). The target is thrown back from C
//     (as it would lie now) to the lift's own target: for recoilFrom of the
//     ease the limb only pulls out of P, back along C at its drawn length and
//     pulled up −d̂ (pullOut × the drawn length at the tip, swelling and gone
//     over pullSpan); then a recoil wave runs from the tip up to the root
//     (recoilWave), each segment's direction turned from C's to its own on a
//     damped spring that swings about a fifth past it (recoilSpring: the
//     limb flops into its idle curve and past it), bowed on screen to at
//     least minBow when it would look straighter (bowedOnScreen), while the
//     stiffness falls from 1 to the stroke's own over the ease
//     (1 − (1 − s)·smooth(q)²). On the release's first step every node also
//     gets the recoil, −d̂·1.5 unit/s·t_i plus a seeded lateral of ±0.4×
//     that. After the ease the limb is the lift's again.
// With a dummy (collide.ts) the strike curve, the whip's and the pinned, is
// routed round his body by its depth (routeAround), finely sampled before
// the chain's nodes are read off it and on the side of him the limb is on
// now: the slammed limbs reach P round his side or over a shoulder, never
// through him, and don't flip from one side of him to the other between
// steps. The released throw is left to the chain's own collisions.
//
// The strike curve, in frame px: it sets off from the stem's end S, stem
// torso heights out of his back from the root along its outward normal
// (strikeStem), then C(t) = R + (P − R)·t + bulge·side·n̂·sin(πt)·|P − R|,
// with R = S on screen, n̂ = (−u_y, u_x) the chord's normal, side and
// bulge round his outline (roundOutline; the way the drawn limb bows
// without a body), and z(t) = z_S + 0.25·unit·smoothstep(0.1, 0.4, t), so
// the slammed limbs come forward of his back. C is similarity-covariant
// about P: the stamp that carries the root to the next frame's root keeps
// the tip on P (design §4, "Clock"). The chain's nodes are read off it at
// the drawing's own arc fractions of its length on screen (so a dive in
// depth round his side doesn't bunch them), and the target and the scaled
// rest lengths agree. The routing moves depths only, so C's place on
// screen, and the tip on P, stay.
//
// Pure: an order is a function of the step and the options alone, so two
// runs give the same arrays; nothing reads Math.random or a clock.
import type { LimbControl, StrikeController, StrikeLimb, StrikeStep, Vec2, Vec3 } from '../impact/contracts.ts';
import { rng, uniform } from '../impact/rng.ts';
import { project, toBody, toCamera, TORSO, unproject, type Body3D } from './body.ts';
import { lerpDummy, overOutline, routeAround, type Dummy } from './collide.ts';
import { radiusAt } from './tube.ts';

// Design §4 and §9's slam rows.
export const STRIKE = {
  land: -7, // limbs first: the tips land on P at I − 7 ...
  release: 9, // ... and let go at I + 9
  coilFrames: 6, // the root winds over τ = land − 7..land − 1 (its frames land − 7..land − 3, then the whip takes it)
  coilDeg: 30,
  coilDelay: 3, // frames the tip's coil starts after the root's: it winds back root first
  coilStiffness: 0.5,
  whipFrames: 3, // the whip's frames, land − 2..land: the inner half comes over first, the outer last, the tip onto P on land
  whip: 0.75, // node i starts over to C at whip·t_i² of the whip (the front runs on faster as the rope thins) ...
  whipSpan: 0.25, // ... and is on it this share of it later: the tip at its end
  catchUp: 0.05, // the whipped chain is laid on its order, from where it is, at least this share of the way a step
  bulge: 0.12, // × |P − R|: the least, and without his body
  bulges: [0.12, 0.2, 0.3, 0.4, 0.5, 0.65, 0.8], // round his outline: the bulges tried ...
  bulgeCost: 0.15, // ... each counting this × its bulge × |P − R| of arc over him against itself ...
  bulgeSoft: 0.04, // ... and blended by exp(−cost/(this × |P − R|)), so the bulge eases as he moves
  stem: 0.15, // torso heights the curve first runs out of his back, along its normal
  lift: 0.25, // torso heights toward the camera at the tip ...
  liftSpan: [0.1, 0.4] as const, // ... by smoothstep over this stretch of the curve
  pinStiffness: 1, // the pinned rope's pull: taut ...
  ripple: 0.05, // ... but alive: × |P − R|, the ripple across C, zero at both ends ...
  rippleHz: 2.2, // ... running down it,
  rippleWaves: 1.5, // this many waves along it
  easeDrawings: 8, // the release hands back to the lift over this many drawings
  regrow: 0.5, // the release closes this share of the gap to the drawn length on each step
  pullOut: 0.12, // × the drawn length: the released tip's pull back up −d̂, out of P ...
  pullSpan: 0.4, // ... swelling and gone again over this share of the ease
  recoilFrom: 0.15, // the share of the ease the limb only pulls out of P (along C, at its drawn length) before the throw back ...
  recoilWave: 0.35, // ... and the share the recoil wave then takes to run from the tip up to the root ...
  recoilPeak: 0.6, // ... each node's swing past its idle curve peaking this share of its spring after it sets off ...
  recoilDamping: 0.45, // ... on a spring this damped (about a fifth past it); ...
  rootTurn: [0.1, 0.4] as const, // ... by the root, up to this stretch of it (smoothstep), a steady turn over the ease
  minBow: 0.1, // the least sagitta over chord on screen a released limb's target shows (never straight)
  recoil: 1.5, // torso heights a second along −d̂, at the tip
  lateral: 0.4, // ± × the recoil, across d̂, seeded per limb
  coilSpeed: 8, // torso heights a second the coil's stiffening may add to a lagging tip
};
const LIMB_RADIUS = 0.02 * (9 / 16); // × the frame's width: R0 when no radius is given (lift.ts's: 0.02 of a 16:9 clip's short side)
const OUTLINE_PAD = 0.5; // × R0 past the limb's root radius: the room roundOutline leaves round his outline
const CURVE_SAMPLES = 96; // C is read off this many pieces at the chain's arc fractions

// The landing and the release for contact frame I, limbs first.
export const limbsFirst = (I: number): { land: number; release: number } => ({ land: I + STRIKE.land, release: I + STRIKE.release });

// The whip's first frame: from it to the release the lift draws every frame.
export const whipFrom = (strike: { land: number }): number => strike.land - STRIKE.whipFrames + 1;

// The frames SPEC P3's speed guard skips (design §4, "Speed guard"): the
// whip's three frames, the landing the last (the tips cross several hundred
// px a frame there on the hero, by design) and the recoil, the release and the RECOIL_FRAMES after
// it, where the released limb flicks out of P and flops back into its idle
// curve (decision 15: up to about 50 torso heights a second at the tip on
// the hero). SPEC A7 exempts a preset strike already, and P3 is about anchor motion.
export const RECOIL_FRAMES = 5;
export const speedExempt = (f: number, strike: { land: number; release: number }): boolean =>
  (f >= whipFrom(strike) && f <= strike.land) || (f >= strike.release && f <= strike.release + RECOIL_FRAMES);

// A limb on a step as the lift hands it over: the contract's, plus its
// length as drawn at this step's torso height (camera px), which the release
// gives it back (decision 15); missing, its lifted length.
export interface LimbStep extends StrikeLimb {
  drawn?: number;
}

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
  seed: number; // the recoil's lateral and the ripple's phase
  dps?: number; // drawings a second, for the release's ease (12)
  fps?: number; // (30)
  dummies?: readonly Dummy[] | null; // his body on every frame (collide.ts): every curve is routed round it; missing = not routed
  radius?: number; // the limb's root radius, px, the routing's room round him; missing = lift.ts's for a 1920 px wide frame
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
  if (f < whipFrom(strike)) return { kind: 'coil', p: clamp01((tau - coilFrom) / STRIKE.coilFrames) };
  if (f <= land) return { kind: 'strike' };
  if (f < release) return { kind: 'pinned' };
  const q = (tau - (release - 1)) / easeFrames;
  if (q > 1) return { kind: 'none' };
  return { kind: 'release', q, first: f === release && sub === 1 };
}

// Which side of its own chord (root to tip) a drawn limb bows to: +1 toward
// the chord's normal (−u_y, u_x), −1 away from it, by the signed area the
// limb and its chord enclose. A straight or evenly S-shaped limb gets +1.
export function bulgeSide(points: readonly Vec2[]): 1 | -1 {
  return signedArea(points) > 0 ? -1 : 1;
}

// Twice the signed area a limb and its chord enclose.
function signedArea(points: readonly Vec2[]): number {
  const [x0, y0] = points[0];
  let area = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    area += (ax - x0) * (by - y0) - (ay - y0) * (bx - x0);
  }
  return area;
}

// The strike curve on screen at t in 0..1, from root R to P, bulging `bulge` × |P − R|.
export function strikeCurve(R: Vec2, P: Vec2, side: 1 | -1, t: number, bulge: number = STRIKE.bulge): Vec2 {
  const ux = P[0] - R[0];
  const uy = P[1] - R[1];
  const bow = bulge * side * Math.sin(Math.PI * t); // × n̂·|P − R| = (−u_y, u_x)
  return [R[0] + ux * t - uy * bow, R[1] + uy * t + ux * bow];
}

// Round his outline on screen (decision 17): the side of him the strike curve
// goes round (away from the middle of his torso, from the root) and how far
// it bulges. Each of STRIKE.bulges is scored by the arc its curve runs over
// his outline (widened by `pad` px) past the root's zone (`from` of the way
// along) and short of the last tenth into P (his fist and feet are there),
// plus bulgeCost × its bulge × |P − R|; the bulge is their blend weighted by
// exp(−score/(bulgeSoft × |P − R|)), so it moves smoothly as he does instead
// of jumping between two that score alike. On each of the step's frames' own
// dummies, blended by the step's place between them.
function roundOutline(ds: readonly Dummy[], w: number, b: Body3D, R: Vec2, P: Vec2, from: number, pad: number): { side: 1 | -1; bulge: number } {
  const len = Math.hypot(P[0] - R[0], P[1] - R[1]) || 1;
  const centre = project(b, toCamera(b, [0, TORSO.cy, 0])).xy;
  const away = -(P[1] - R[1]) * (R[0] - centre[0]) + (P[0] - R[0]) * (R[1] - centre[1]); // n̂·(R − centre)·|P − R|
  const side: 1 | -1 = away >= 0 ? 1 : -1;
  const n = OUTLINE_SAMPLES;
  const t0 = Math.min(0.9, from);
  const bulgeOn = (d: Dummy) => {
    let [sum, weight] = [0, 0];
    const scores = STRIKE.bulges.map((k) => {
      let over = 0;
      let prev = strikeCurve(R, P, side, t0, k);
      for (let i = 1; i <= n; i++) {
        const at = strikeCurve(R, P, side, t0 + ((0.9 - t0) * i) / n, k);
        if (overOutline(d, at, pad)) over += Math.hypot(at[0] - prev[0], at[1] - prev[1]);
        prev = at;
      }
      return over + STRIKE.bulgeCost * k * len;
    });
    const least = Math.min(...scores);
    scores.forEach((c, i) => {
      const e = Math.exp(-(c - least) / (STRIKE.bulgeSoft * len));
      sum += e * STRIKE.bulges[i];
      weight += e;
    });
    return sum / weight;
  };
  const a = bulgeOn(ds[0]);
  return { side, bulge: ds.length > 1 && w > 0 ? a + (bulgeOn(ds[1]) - a) * w : a };
}
const OUTLINE_SAMPLES = 40; // pieces of the curve roundOutline scores

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
  const ripplePhase = new Map(o.limbs.map((s) => [s.id, uniform(rng(o.seed, 'ripple', s.id), 0, 2 * Math.PI)]));
  const liftPx = STRIKE.lift * o.unit;
  const recoilPx = STRIKE.recoil * o.unit;
  const R0 = o.radius ?? LIMB_RADIUS * 1920;
  const dummies = o.dummies && o.dummies.length > 0 ? o.dummies : null;
  const coilFrom = land - 1 - STRIKE.coilFrames;

  const order = (l: StrikeLimb, at: StrikeStep, phase: StrikePhase): LimbControl | null => {
    const spec = specs.get(l.id);
    const n = l.target.length;
    if (!spec || phase.kind === 'none' || n < 2) return null;
    const b = at.body;
    const target = l.target;
    const fr = arcFractions(target);
    const tau = at.f - 1 + at.sub / at.steps;
    // Round his body, when there is one: the dummy on this step, between its frames'.
    const ends = dummies ? [dummies[Math.max(0, Math.min(dummies.length - 1, at.f - 1))], dummies[Math.min(dummies.length - 1, at.f)]] : null;
    const dummy = ends ? lerpDummy(ends[0], ends[1], at.sub / at.steps) : null;
    // C round his body, routed finely before the nodes are read off it, on
    // the side of him the limb is on now.
    const depthNow = depthAt(l.points);
    const routeOf = (pts: Vec3[]) => {
      const ft = arcFractions(pts);
      return routeAround(dummy!, pts, ft.map((t) => radiusAt(t, 1, R0)), routeFrom(ft, polyLength(pts), R0), (k) => depthNow(ft[k]), FLARE * R0);
    };
    const routed: Route | undefined = dummy ? { fine: routeOf, nodes: routeOf } : undefined;
    if (phase.kind === 'coil') {
      const s0 = l.stiffness;
      const wound = coil(b, target, P, (t) => coilAt(tau, coilFrom, t));
      const ramp = s0 + (Math.max(s0, STRIKE.coilStiffness) - s0) * phase.p;
      // The pull is a spring: stiffness s on a tip e torso heights from its
      // target swings it at about s·e/(√2·dt) torso heights a second.
      const e = dist3(wound[n - 1], l.points[n - 1]) / b.unit;
      const dt = 1 / (fps * at.steps);
      const cap = e > 0 ? (STRIKE.coilSpeed * dt * Math.SQRT2) / e : ramp;
      return { target: wound, stiffness: Math.max(s0, Math.min(ramp, cap)) };
    }
    const drawn = polyLength(target);
    // C's side and bulge: round his outline when there is a body, else the drawing's way.
    const R = project(b, target[0]).xy;
    const round = ends ? roundOutline(ends, at.sub / at.steps, b, R, P, (1.22 * R0) / (Math.hypot(P[0] - R[0], P[1] - R[1]) || 1), R0 * (1 + OUTLINE_PAD)) : null;
    const side = round?.side ?? spec.side ?? bulgeSide(target.map((q) => project(b, q).xy));
    const bulge = round?.bulge ?? STRIKE.bulge;
    const wave = { amp: STRIKE.ripple * Math.hypot(P[0] - R[0], P[1] - R[1]), phase: (ripplePhase.get(l.id) ?? 0) + 2 * Math.PI * STRIKE.rippleHz * (tau / fps) };
    if (phase.kind === 'strike') {
      // The whip, laid on the chain (a pin on its own tip: the lift then
      // places the chain on the order exactly), so the rope's own drag can't
      // carry the outer half over with the inner: from where the chain is,
      // each segment's way turned at least catchUp of the way a step onto
      // the whip's, and all of it once the front has passed it.
      const curve = curveNodes(b, target[0], P, side, liftPx, fr, wave, routed, bulge).nodes;
      const wound = coil(b, target, P, (t) => coilAt(tau, coilFrom, t));
      const u = (tau - (land - STRIKE.whipFrames)) / STRIKE.whipFrames; // 0..1 through the whip's frames
      const w = (i: number) => smooth((u - STRIKE.whip * fr[i] ** 2) / STRIKE.whipSpan);
      const goal = whipBlend(wound, curve, w);
      const [dx, dy, dz] = sub3(target[0], l.points[0]); // the chain carried with its root to this step's
      const from = l.points.map((q): Vec3 => [q[0] + dx, q[1] + dy, q[2] + dz]);
      const laid = dragBlend(from, goal, (i) => Math.max(STRIKE.catchUp, w(i)));
      return { target: laid, stiffness: 1, pin: laid[n - 1] };
    }
    if (phase.kind === 'pinned') {
      const { nodes: curve, length } = curveNodes(b, target[0], P, side, liftPx, fr, wave, routed, bulge);
      return { target: curve, stiffness: STRIKE.pinStiffness, pin: curve[n - 1], restScale: drawn > 0 ? length / drawn : 1 };
    }
    // The release (decision 15(f)): the drawn length back within the frame,
    // and the limb thrown from the pinned curve (as it would lie now) back to
    // its own idle curve by a recoil wave running from the tip up to the
    // root: after recoilFrom of the ease, node i sets off recoilWave·(1 − t_i)
    // of it after the tip and swings past its idle curve and back on a
    // damped spring (recoilSpring), each segment's direction turned from the
    // curve's to the idle one's at its drawn length. So the tip pulls out of
    // P first (back along C as the length comes back, and pulled up −d̂),
    // the bend runs back up, and the limb flops into its curve with an
    // overshoot, never longer than drawn, never straight (bowed on screen
    // after, as the idle curve is).
    const goal = (l as LimbStep).drawn;
    const want = goal !== undefined && drawn > 0 ? Math.min(1, goal / drawn) : 1;
    const q = Math.max(0, phase.q);
    const pinned = curveNodes(b, target[0], P, side, liftPx, fr, undefined, undefined, bulge).nodes;
    const idle = bowedOnScreen(b, target, side, fr);
    // By the root (rootTurn of it) the limb turns back steadily over the whole
    // ease instead: the stem out of his back swung round at once would sweep
    // the rope through him.
    const throwAt = (i: number) => recoilSpring((q - STRIKE.recoilFrom - STRIKE.recoilWave * (1 - fr[i])) / (1 - STRIKE.recoilFrom - STRIKE.recoilWave));
    const w = (i: number) => {
      const k = smoothstepAt(STRIKE.rootTurn[0], STRIKE.rootTurn[1], fr[i]);
      return smooth(q) + (throwAt(i) - smooth(q)) * k;
    };
    // Out of P first: the throw carried back up −d̂, pullOut of the drawn
    // length at the tip (t_i of it down the limb), swelling and gone again
    // over the first pullSpan of the ease.
    const pull = q < STRIKE.pullSpan ? STRIKE.pullOut * drawn * want * Math.sin((Math.PI * q) / STRIKE.pullSpan) : 0;
    // That length back within the release frame, half the way left on each
    // step: all at once, the stretch would fling the chain on for frames.
    // After it, the drawn length (a chain the collisions stretch on him is
    // pulled back to it, not given the stretch).
    const now = drawn > 0 ? polyLength(l.points) / drawn : 1;
    const out: LimbControl = {
      pin: null,
      restScale: at.f > release || Math.abs(want - now) < 0.02 * want ? want : now + (want - now) * STRIKE.regrow,
      target: bowedOnScreen(
        b,
        throwBack(pinned, idle, w, want).map((p, i): Vec3 => [p[0] - d[0] * pull * fr[i], p[1] - d[1] * pull * fr[i], p[2]]),
        side,
        fr,
      ),
      stiffness: 1 + (l.stiffness - 1) * smooth(q) ** 2, // near 1 early in the ease (the throw is the target's), the rope's own by its end
    };
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

// How far wound node t (its arc fraction) is at τ: root first, every node
// full at the end of the strike frame (coilFrom + coilFrames + 1).
function coilAt(tau: number, coilFrom: number, t: number): number {
  const start = STRIKE.coilDelay * t;
  return clamp01((tau - coilFrom - start) / (STRIKE.coilFrames - start));
}

// The target turned about its root on screen, away from P, node i by
// 30°·ease_in(p(t_i)), each point at its own depth. It turns whichever way
// takes the tip away from P; a limb pointing within 15° of P (or straight
// away from it) has no clear way, so its coil fades out there instead of
// flipping between the two.
function coil(b: Body3D, target: readonly Vec3[], P: Vec2, p: (t: number) => number): Vec3[] {
  const R = project(b, target[0]).xy;
  const tip = project(b, target[target.length - 1]).xy;
  const [ax, ay] = [tip[0] - R[0], tip[1] - R[1]];
  const [cx, cy] = [P[0] - R[0], P[1] - R[1]];
  const sin = (ax * cy - ay * cx) / (Math.hypot(ax, ay) * Math.hypot(cx, cy) || 1); // > 0: P is clockwise of the tip
  const away = -clamp(sin / Math.sin((15 * Math.PI) / 180), -1, 1);
  const fr = arcFractions(target);
  return target.map((q, i) => (i === 0 ? copy3(q) : turnAbout(b, R, q, away * ((STRIKE.coilDeg * Math.PI) / 180) * p(fr[i]) ** 3)));
}

// The first node the routing moves: past the flared root, as the lift collides.
function routeFrom(fr: readonly number[], length: number, R0: number): number {
  const i = fr.findIndex((t) => t * length >= FLARE * R0);
  return i < 0 ? fr.length : Math.max(1, i);
}
const FLARE = 1.22; // × R0: the flared root's radius (tube.ts, 1 + ROOT_FLARE)

// From `from` to `to` (both camera px, root first, the same root), each
// segment's direction turned `w(i)` of the way, at `to`'s segment lengths:
// a blend of two shapes that keeps the limb's length, where blending their
// points would stretch it across the gap between them.
// The whip's target: each segment's direction turned from the wound coil's
// toward C's by its node's share w(i) (slerp), its length between theirs,
// laid from the root. Blending places instead, a node half way between two
// shapes far apart, kinks the chain where the share changes along it (the
// outer half crumpled on the strike frame); blending directions, each joint
// bends no more than the two shapes and the share's own turn. All of C at
// w = 1.
function whipBlend(wound: readonly Vec3[], curve: readonly Vec3[], w: (i: number) => number): Vec3[] {
  const out: Vec3[] = [copy3(wound[0])];
  for (let i = 0; i < wound.length - 1; i++) {
    const a = sub3(wound[i + 1], wound[i]);
    const c = sub3(curve[i + 1], curve[i]);
    const [la, lc] = [Math.hypot(a[0], a[1], a[2]), Math.hypot(c[0], c[1], c[2])];
    const t = w(i + 1);
    const dir = la > 1e-9 && lc > 1e-9 ? turnToward([a[0] / la, a[1] / la, a[2] / la], [c[0] / lc, c[1] / lc, c[2] / lc], t) : lc > 1e-9 ? [c[0] / lc, c[1] / lc, c[2] / lc] : [0, 0, 0];
    const len = la + (lc - la) * t;
    const p = out[i];
    out.push([p[0] + dir[0] * len, p[1] + dir[1] * len, p[2] + dir[2] * len]);
  }
  return out;
}

// From unit a toward unit b, `t` of the angle between them (slerp).
function turnToward(a: Vec3, b: Vec3, t: number): Vec3 {
  const w = Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
  if (w < 1e-9) return [b[0], b[1], b[2]];
  const s = Math.sin(w);
  if (s < 1e-6) return t < 0.5 ? [a[0], a[1], a[2]] : [b[0], b[1], b[2]];
  const [p, q] = [Math.sin((1 - t) * w) / s, Math.sin(t * w) / s];
  return [a[0] * p + b[0] * q, a[1] * p + b[1] * q, a[2] * p + b[2] * q];
}

// As whipBlend, but each segment's way from the node before it as laid now
// to where its own node is: a node the front hasn't reached is dragged along
// its segment after the one before it, as a rope's is, not carried round
// with it (follow-the-leader), so the outer half lags the inner and comes
// over after it.
function dragBlend(from: readonly Vec3[], goal: readonly Vec3[], w: (i: number) => number): Vec3[] {
  const out: Vec3[] = [copy3(from[0])];
  for (let i = 0; i < from.length - 1; i++) {
    const a = sub3(from[i + 1], out[i]);
    const c = sub3(goal[i + 1], goal[i]);
    const [la, lc, l0] = [Math.hypot(a[0], a[1], a[2]), Math.hypot(c[0], c[1], c[2]), dist3(from[i + 1], from[i])];
    const t = w(i + 1);
    const dir = la > 1e-9 && lc > 1e-9 ? turnToward(scale3(a, 1 / la), scale3(c, 1 / lc), t) : lc > 1e-9 ? scale3(c, 1 / lc) : [0, 0, 0];
    out.push(add3(out[i], scale3(dir as Vec3, l0 + (lc - l0) * t)));
  }
  return out;
}

// From `from` to `to` (camera px, root first, the same root), each
// segment's direction turned w(i) of the way from from's to to's (past it
// for w > 1), at to's segment lengths × k, laid from the root.
function throwBack(from: readonly Vec3[], to: readonly Vec3[], w: (i: number) => number, k: number): Vec3[] {
  const out: Vec3[] = [copy3(to[0])];
  for (let i = 0; i < to.length - 1; i++) {
    const a = sub3(from[i + 1], from[i]);
    const c = sub3(to[i + 1], to[i]);
    const [la, lc] = [Math.hypot(a[0], a[1], a[2]), Math.hypot(c[0], c[1], c[2])];
    if (lc < 1e-9) {
      out.push(copy3(out[i]));
      continue;
    }
    const dir = la > 1e-9 ? turnToward(scale3(a, 1 / la), scale3(c, 1 / lc), w(i + 1)) : scale3(c, 1 / lc);
    out.push(add3(out[i], scale3(dir, lc * k)));
  }
  return out;
}

// A damped spring's step response at u (0 before it sets off): past 1 by
// about a fifth at u = recoilPeak, back under it, and within 1 % of it by u = 1.
function recoilSpring(u: number): number {
  if (!(u > 0)) return 0;
  const zeta = STRIKE.recoilDamping;
  const wd = Math.PI / STRIKE.recoilPeak;
  const w0 = wd / Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * w0 * u) * (Math.cos(wd * u) + ((zeta * w0) / wd) * Math.sin(wd * u));
}

// `nodes` (camera px, root first) bowed on screen to `side` when they look
// straighter than `least` (sagitta over chord): each segment turned about
// the view axis, from +φ/2 at the root to −φ/2 at the tip, φ grown (from as
// much as a circular arc needs to make up the difference: its sagitta over
// chord is about φ/8) until they bow that much, up to BOW_TURN. Seen edge-on,
// as when he bends double, a drawn curve is a line.
export function bowedOnScreen(b: Body3D, nodes: readonly Vec3[], side: 1 | -1, fr: readonly number[], least: number = STRIKE.minBow): Vec3[] {
  const seen = (pts: readonly Vec3[]) => pts.map((p) => project(b, p).xy);
  let ratio = sagittaRatio(seen(nodes));
  if (!(ratio < least)) return nodes.map(copy3);
  const make = (phi: number): Vec3[] => {
    const out: Vec3[] = [copy3(nodes[0])];
    for (let i = 1; i < nodes.length; i++) {
      const a = phi * (0.5 - (fr[i - 1] + fr[i]) / 2);
      const [dx, dy, dz] = sub3(nodes[i], nodes[i - 1]);
      const c = Math.cos(a);
      const sn = Math.sin(a);
      out.push(add3(out[i - 1], [c * dx - sn * dy, sn * dx + c * dy, dz]));
    }
    return out;
  };
  // Which way of turning bows to `side`: the one that adds area that way.
  const more = signedArea(seen(make(0.01))) - signedArea(seen(nodes));
  const way = (more > 0 ? -1 : 1) === side ? 1 : -1;
  let phi = 0;
  let out = nodes.map(copy3);
  for (let k = 0; k < 4 && ratio < least && phi < BOW_TURN; k++) {
    phi = Math.min(BOW_TURN, phi + 8 * (least - ratio));
    out = make(way * phi);
    ratio = sagittaRatio(seen(out));
  }
  return out;
}
const BOW_TURN = (2 * Math.PI) / 3; // the most bowedOnScreen turns a limb from root to tip

// The farthest any point is from the root–tip chord, over the chord's length.
export function sagittaRatio(pts: readonly Vec2[]): number {
  const [ax, ay] = pts[0];
  const [bx, by] = pts[pts.length - 1];
  const c = Math.hypot(bx - ax, by - ay);
  if (c < 1e-9) return Infinity;
  let m = 0;
  for (const [x, y] of pts) m = Math.max(m, Math.abs((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / c);
  return m / c;
}

// The released limb in camera px at arc fractions `fr`: a circular arc
// `length` long from the root to `end` (straight when it can't be), bowing
// out of his back and to `side` on screen, so the length a slammed
// limb gets back goes into a bow clear of him. The arc is kept to 0.75 of a
// full turn: past that, `end` is moved out along the chord.
function releaseBow(b: Body3D, root: Vec3, end: Vec3, length: number, side: 1 | -1, fr: readonly number[]): Vec3[] {
  let e = sub3(end, root);
  let c = Math.hypot(e[0], e[1], e[2]);
  e = c > 1e-9 ? scale3(e, 1 / c) : [0, 1, 0];
  const most = Math.sin(BOW_MAX) / BOW_MAX; // the shortest chord over length the arc may have
  if (length > 0 && c < most * length) c = most * length;
  if (length > 0 && c > length) c = length; // too far to reach: straight at its length, toward `end`
  // The bow's way: his back's outward normal and the chord's screen normal
  // toward `side`, equally, square to the chord.
  const back = sub3(toCamera(b, [0, TORSO.cy, -1]), toCamera(b, [0, TORSO.cy, 0]));
  const screen: Vec3 = [-e[1] * side, e[0] * side, 0];
  let m = add3(scale3(back, 1 / (Math.hypot(back[0], back[1], back[2]) || 1)), scale3(screen, 1 / (Math.hypot(screen[0], screen[1]) || 1)));
  m = sub3(m, scale3(e, dot3(m, e)));
  const ml = Math.hypot(m[0], m[1], m[2]);
  m = ml > 1e-9 ? scale3(m, 1 / ml) : [-e[1], e[0], 0];
  // The half-angle θ with sin θ/θ = c/length (bisection: it falls from 1 on (0, π)).
  const ratio = length > 0 ? Math.min(1, c / length) : 1;
  let lo = 0;
  let hi = BOW_MAX;
  for (let k = 0; k < 48 && hi - lo > 1e-9; k++) {
    const mid = (lo + hi) / 2;
    if (Math.sin(mid) / mid > ratio) lo = mid;
    else hi = mid;
  }
  const th = (lo + hi) / 2;
  const mid = add3(root, scale3(e, c / 2));
  return fr.map((t, i): Vec3 => {
    if (i === 0) return copy3(root);
    if (th < 1e-6) return add3(root, scale3(e, c * t));
    const rho = c / (2 * Math.sin(th));
    const a = -th + 2 * th * t;
    return add3(mid, add3(scale3(e, rho * Math.sin(a)), scale3(m, rho * (Math.cos(a) - Math.cos(th)))));
  });
}
const BOW_MAX = 0.75 * Math.PI; // the released bow's largest half-angle

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
// lifted to z(t), routed round his body when there is a `route` (its depths
// only, so every sample keeps its place on screen), then read off by arc
// length, so a dive round him spreads over the nodes as evenly as the rest.
// The root is the target's own and the tip projects exactly onto P.
// `length` is the node polyline's before the routing: the pinned chain's
// rest lengths take it, so a dive round him pulls the rope taut over his
// shoulder instead of adding slack that crumples it. A `ripple` moves each
// point across C on screen by amp·sin(πt)·sin(phase − 2π·waves·t): a wave
// running down it, still at both ends.
function curveNodes(b: Body3D, root: Vec3, P: Vec2, side: 1 | -1, liftPx: number, fr: readonly number[], ripple?: { amp: number; phase: number }, route?: Route, bulge: number = STRIKE.bulge): { nodes: Vec3[]; length: number } {
  // The stem: out of his back along its outward normal first (STEM torso
  // heights), as the lifted limb grows out of him (lift.ts SHEET.exit). Bent
  // double, his back faces up, P is under him, and a curve that set off
  // straight for it would start over him, his head in front of it and his
  // torso behind: no way out of there in depth that doesn't go through him.
  const S = strikeStem(b, root);
  const R = project(b, S).xy;
  const [lo, hi] = STRIKE.liftSpan;
  const fine: Vec3[] = [];
  for (let k = 0; k < STEM_SAMPLES; k++) fine.push(mix3(root, S, k / STEM_SAMPLES));
  const len = Math.hypot(P[0] - R[0], P[1] - R[1]) || 1;
  const [nx, ny] = [-(P[1] - R[1]) / len, (P[0] - R[0]) / len];
  for (let k = 0; k <= CURVE_SAMPLES; k++) {
    const t = k / CURVE_SAMPLES;
    const z = S[2] + liftPx * smoothstepAt(lo, hi, t);
    let at = k === CURVE_SAMPLES ? P : strikeCurve(R, P, side, t, bulge);
    if (ripple && k > 0 && k < CURVE_SAMPLES) {
      const w = ripple.amp * Math.sin(Math.PI * t) * Math.sin(ripple.phase - 2 * Math.PI * STRIKE.rippleWaves * t);
      at = [at[0] + nx * w, at[1] + ny * w];
    }
    fine.push(k === 0 ? copy3(S) : unproject(b, at, z));
  }
  const plain = readOff(b, fine, fr);
  return { nodes: route ? route.nodes(readOff(b, route.fine(fine), fr)) : plain, length: polyLength(plain) };
}
const STEM_SAMPLES = 6; // the fine curve's pieces along the stem

// A curve's routing round his body: the fine curve's, then its nodes' (the
// nodes are read off the routed fine curve, and a chord between two of them
// can cut a corner of it through him).
interface Route {
  fine: (pts: Vec3[]) => Vec3[];
  nodes: (pts: Vec3[]) => Vec3[];
}

// The egg's outward normal at a camera-px point on (or by) it, camera frame, unit length.
// Where the strike curve sets off: STRIKE.stem out of his back from the root, along its outward normal.
export const strikeStem = (b: Body3D, root: Vec3): Vec3 => add3(root, scale3(backNormal(b, root), STRIKE.stem * b.unit));

function backNormal(b: Body3D, p: Vec3): Vec3 {
  const q = toBody(b, p);
  const g: Vec3 = [q[0] / TORSO.a ** 2, (q[1] - TORSO.cy) / TORSO.b ** 2, q[2] / TORSO.c ** 2];
  const l = Math.hypot(g[0], g[1], g[2]);
  const u: Vec3 = l > 1e-9 ? [q[0] + g[0] / l, q[1] + g[1] / l, q[2] + g[2] / l] : [q[0], q[1], q[2] - 1];
  const d = sub3(toCamera(b, u), toCamera(b, q));
  const dl = Math.hypot(d[0], d[1], d[2]);
  return dl > 1e-9 ? scale3(d, 1 / dl) : [0, 0, -1];
}

// The points at arc fractions `fr` along a fine polyline, by its length on
// screen (so a dive round him in depth doesn't take a share of the nodes
// and leave the rest of the way to P to a few long spans): its ends exactly.
function readOff(b: Body3D, fine: readonly Vec3[], fr: readonly number[]): Vec3[] {
  const last = fine.length - 1;
  const seen = fine.map((p) => project(b, p).xy);
  const along = [0];
  for (let k = 1; k <= last; k++) along.push(along[k - 1] + Math.hypot(seen[k][0] - seen[k - 1][0], seen[k][1] - seen[k - 1][1]));
  const total = along[last];
  let k = 0;
  return fr.map((t, i): Vec3 => {
    if (i === 0) return fine[0];
    if (i === fr.length - 1) return fine[last];
    const at = t * total;
    while (k < last - 1 && along[k + 1] < at) k++;
    const w = along[k + 1] > along[k] ? (at - along[k]) / (along[k + 1] - along[k]) : 0;
    return mix3(fine[k], fine[k + 1], w);
  });
}

// The depth (camera z) along a chain at arc fraction t, linear between its nodes.
function depthAt(pts: readonly Vec3[]): (t: number) => number {
  const fr = arcFractions(pts);
  return (t) => {
    let k = 0;
    while (k < fr.length - 2 && fr[k + 1] < t) k++;
    const w = fr[k + 1] > fr[k] ? clamp01((t - fr[k]) / (fr[k + 1] - fr[k])) : 0;
    return pts[k][2] + (pts[k + 1][2] - pts[k][2]) * w;
  };
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
const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale3 = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
