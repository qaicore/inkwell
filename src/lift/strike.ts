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
// a step ends, in frames. A whip crack, not a turning rod (decisions 15, 19):
//   - coil, frames land − 7..land − 3: each target is turned about its root
//     in the screen plane, z kept, away from P by 30°·ease_in(p_i), root
//     first: node i starts coilDelay·t_i frames after the root (t_i its arc
//     fraction) and would be fully wound at τ = land − 1, so
//     p_i = (τ − (land − 7) − coilDelay·t_i)/(6 − coilDelay·t_i), the root's
//     the design's (j + 14)/6. The stiffness ramps with the root's p from the
//     stroke's own (0.1) toward 0.5, but only as far as lets the pull add 8
//     torso heights a second to a tip that lags its target (a stiffened
//     spring far from its target is a fast one), and never below the stroke's own;
//   - strike, land − 2..land (whipFrames): the whip, laid on the chain (its
//     own tip pinned, so the lift places it exactly; stiffness 1). It swings
//     the chain from the shape the whip found it in (on its first step: laid
//     from the coil's target instead, it snapped the lagging chain onto it)
//     to the strike curve C, each segment's way on screen turned round the
//     camera's z axis, all of them the same way round (swing: against the
//     coil's wind), node i setting off whip·t_i of the way into the whip and
//     over whipSpan of it, coming in faster and faster (its share squared),
//     on a clock running as u^whipEase over the whip's frames: the inner half
//     comes over first, the bend runs out to the tip, and the tip comes down
//     onto P last and fastest, on land itself. A loop, not a pigtail
//     (curlLimited), and the inner half bowed, never a rod (bowInner);
//   - pinned, land + 1..release − 1: C with a ripple running down it (zero at
//     both ends, seeded per limb; the whip's C has it too), at pinStiffness,
//     the tip pinned where C's end projects onto P, so the chain is laid on
//     C (the lift's kinematic pin) and the rest lengths scaled so the chain
//     is exactly as long as the rippled curve. The hook takes one scale for
//     every rest length, so a segment is |C|/(n − 1) when the drawing's
//     nodes are evenly spaced, and keeps the drawing's proportions otherwise.
//     C's side and bulge round him change slowly (steady), so the drawn rope
//     never pops from one side of him to the other;
//   - release, from release: a snap, a flop, then rest (decision 15(f), 19(e)).
//     The tip lets go of P and the drawn length comes back (never longer than
//     about 1.15× it, never straight). The chain is laid on a thrown curve,
//     pinned to its own tip (made(q), snapBack): from C as it would lie now to
//     its idle curve (its own target, bowed on screen to at least minBow).
//     The tension let go flings it there on the first drawings, the tip ahead
//     of the root (snapFrames, snapDelay), so the tips are far off P and the
//     limbs keep their glow while the fire burns; by the root it turns
//     steadily instead (stemSpan, stemTurn). A recoil wave then runs from the
//     tip up to the root, a damped swing past the idle curve and back
//     (overshootDeg), and is gone by the throw's end, about f116. After the
//     first drawings (throwFree), no drawing moves the outer half of the
//     line more than throwPx against the frame before it (throwClock). Never
//     under the floor line through P (aboveFloor). The stiffness falls from 1
//     to the stroke's own as it goes (1 − (1 − s)·smooth(q)²), and the limb is
//     the lift's again once the throw is done and caught up, easeDrawings
//     after the release at the latest.
// With a dummy (collide.ts) every laid curve (the whip's, the pinned and
// the thrown) is routed round his body by its depth (routeAround), C finely
// sampled before the chain's nodes are read off it and on the side of him
// the limb is on now: the slammed limbs reach P round his side or over a
// shoulder, never through him, and don't flip from one side of him to the
// other between steps.
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
import { drawingStart } from '../impact/clock.ts';
import { rng, uniform } from '../impact/rng.ts';
import { drawingIndex } from '../motion/timing.ts';
import { project, toBody, toCamera, TORSO, unproject, type Body3D } from './body.ts';
import { insideDepth, lerpDummy, overOutline, routeAround, scanPush, type Dummy } from './collide.ts';
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
  whip: 0.7, // node i starts over to C at whip·t_i of the whip ...
  whipSpan: 0.3, // ... and is on it this share of it later: the tip at its end (a wide front: a narrow one folds the rope back on itself, a pigtail) ...
  whipEase: 1.6, // ... on a clock running as u^whipEase over its frames: by the f76 drawing the front is half way down the limb, the outer half on its way (at 2 the outer half never showed it)
  whipCurl: 80, // the whipped outer quarter turning this many degrees at most in all (a whip's loop, not a pigtail) ...
  whipJoint: 24, // ... and no joint of it more than this many
  whipInnerBow: 0.04, // the least sagitta over chord of the whip's inner half on screen: a rope coming over, never a rod
  bulge: 0.12, // × |P − R|: the least, and without his body
  bulges: [0.12, 0.2, 0.3, 0.4], // round his outline: the bulges tried (a taut rope: past 0.4 the pinned limbs read as loose loops; the routing in depth takes him from there) ...
  bulgeCost: 0.15, // ... each counting this × its bulge × |P − R| of arc over him against itself ...
  bulgeSoft: 0.04, // ... and blended by exp(−cost/(this × |P − R|)), so the bulge eases as he moves ...
  bulgeRate: 0.02, // ... and changes by this much a frame at most from the whip to the release (a jump is a pop; a stamp or a poster held 2 frames shows two frames' change at once) ...
  flipPx: 18, // ... and swinging over him to the other side, its middle this many px a frame at most (decision 19(d): 60 a drawing, with his own turn, on stamps 2 frames apart)
  stem: 0.13, // torso heights the curve first runs out of his back, along its normal (0.15 folds the whipped rope at it on f76; 0.12 takes the pinned limb 2 into him as it swings over)
  lift: 0.25, // torso heights toward the camera at the tip ...
  liftSpan: [0.1, 0.4] as const, // ... by smoothstep over this stretch of the curve
  pinStiffness: 1, // the pinned rope's pull: taut ...
  ripple: 0.06, // ... but alive: × |P − R|, the ripple across C, zero at both ends, ...
  rippleMin: 12, // ... at least this many px ...
  rippleMax: 32, // ... and at most this many,
  rippleAlong: 0.45, // and along C a quarter wave behind, this share of it: each point rides an ellipse, so the rope never stops
  rippleHz: 2.2, // ... running down it,
  rippleWaves: 1.5, // this many waves along it
  easeDrawings: 24, // the release hands back to the lift within this many drawings at most (f93–152 on the hero), as soon as its throw is done ...
  throwDrawings: 9.6, // ... the throw running over this many when nothing slows it: at rest by about f116 ...
  throwFree: 2, // ... free for this many frames after the release's first, the snap (decision 19(e) holds from f96) ...
  throwPx: 72, // ... and from there slower wherever a drawing would change a node more than this many px on screen against the frame before it (decision 19(e): 80)
  snapFrames: 0.6, // the snap's clock, e-folding: most of the way to the idle curve on the first drawing ...
  snapDelay: 0.6, // ... the root this many frames behind the tip
  stemSpan: [0.04, 0.22] as const, // by the root, up to this stretch of it (smoothstep), the limb turns steadily instead: swung round at once, the stem out of his back would sweep through him ...
  stemTurn: 0.2, // ... and is round by this share of the throw (slower, it lies across him longer and the routing takes it round in depth: 1.3x its length)
  overshootDeg: 25, // the recoil's swing past the idle curve, at its most ...
  recoilFrames: 16, // ... a whole swing this many frames ...
  recoilDecay: 7, // ... dying away over this many (e-folding) ...
  recoilDelay: 5, // ... and reaching the root this many frames after the tip
  floorPad: 4, // px the released limb's target keeps above the floor line through P
  minBow: 0.13, // the least sagitta over chord on screen a released limb's target shows (never straight)
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
  seed: number; // the ripple's phase
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

// A released limb's way through its throw (strikeController's throwClock).
interface Thrown {
  tau: number;
  q: number;
  held: boolean; // the budget held it back on the last step
  frameBody: Body3D; // his body at the end of the last whole frame
  shown: Vec2[]; // the last drawing started, on screen ...
  shownBody: Body3D; // ... on this body ...
  shownAt: number; // ... at this τ
}
const THROW_STEM = 0.25; // the stretch by the root (arc fraction) that goes with the root, which is his to move ...
const THROW_OUTER = 0.5; // ... and the stretch the budget looks at, from here to the tip (the nearer nodes ride on him)

export function strikeController(o: StrikeOptions): Strike {
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
  const ripplePhase = new Map(o.limbs.map((s) => [s.id, uniform(rng(o.seed, 'ripple', s.id), 0, 2 * Math.PI)]));
  const liftPx = STRIKE.lift * o.unit;
  const R0 = o.radius ?? LIMB_RADIUS * 1920;
  const dummies = o.dummies && o.dummies.length > 0 ? o.dummies : null;
  const coilFrom = land - 1 - STRIKE.coilFrames;
  // Each limb's strike curve from the whip on (decision 19(d)), held as a
  // signed bulge (side × bulge): eased toward roundOutline's at bulgeRate a
  // frame at most, so his moving outline can't pop the pinned rope from a
  // loose loop to a tight one between frames; and when he turns so the side
  // round him changes, swung over through straight with its middle flipPx a
  // frame at most, as a rope nailed at both ends rolls over him (routed in
  // depth, in front of him or behind), never jumping from one side of him to
  // the other. The lift steps in time order; a step earlier than the last
  // one seen starts afresh (a new run of the same controller), so two runs
  // give the same orders.
  const held = new Map<number, { tau: number; sb: number }>();
  const steady = (id: number, tau: number, side: 1 | -1, bulge: number, len: number): { side: 1 | -1; bulge: number } => {
    const last = held.get(id);
    const swinging = last !== undefined && (Math.sign(last.sb) !== side || Math.abs(last.sb) < STRIKE.bulge);
    const rate = (swinging ? STRIKE.flipPx / Math.max(len, 1) : STRIKE.bulgeRate) * (last ? tau - last.tau : 0);
    const sb = !last || tau <= last.tau ? side * bulge : last.sb + clamp(side * bulge - last.sb, -rate, rate);
    held.set(id, { tau, sb });
    return { side: sb >= 0 ? 1 : -1, bulge: Math.abs(sb) };
  };
  // The way round a limb swings (swing), per limb and phase: fixed on the
  // first step it's asked for, so it never flips mid-swing. Kept as `held` is.
  const ways = new Map<string, { tau: number; sense: number }>();
  const heldWay = (key: string, tau: number, first: () => number): number => {
    const last = ways.get(key);
    const sense = !last || tau <= last.tau ? first() : last.sense;
    ways.set(key, { tau, sense });
    return sense;
  };
  // Each limb's chain as the whip found it, on the whip's first step: the
  // shape the whip swings from (laid from the coil's target instead, it
  // snapped the chain onto it, the coil's lag and all: 440 px on the hero's
  // limb 3 on f75). Kept as `held` is.
  const whipped = new Map<number, { tau: number; pts: Vec3[] }>();
  const whipStart = (id: number, tau: number, pts: readonly Vec3[]): Vec3[] => {
    const last = whipped.get(id);
    const kept = !last || tau <= last.tau ? pts.map(copy3) : last.pts;
    whipped.set(id, { tau, pts: kept });
    return kept;
  };
  // Each released limb's way through its throw, q 0..1 (the release's
  // made(q)), on the throw's own clock: throwDrawings at the most, so it is at
  // rest by about f116. After the snap's drawings (throwFree), no drawing
  // changes a node past the root's stretch by more than throwPx on screen
  // against the frame before it, the last drawing carried by his torso's
  // similarity (what carries a held drawing between drawings, impact/scene.ts):
  // a node further off is taken its share of the way there, so his own move
  // counts in full, and a throw that goes his way is free. The budget grows
  // over the frames up to the next drawing. Kept as `held` is: in time order,
  // afresh on an earlier step.
  const throwFrames = (STRIKE.throwDrawings * fps) / (o.dps ?? 12);
  const thrown = new Map<number, Thrown>();
  const throwClock = (id: number, b: Body3D, tau: number, at: StrikeStep, fr: readonly number[], made: (q: number) => Vec3[]): { q: number; nodes: Vec3[] } => {
    const last = thrown.get(id);
    const was = last && tau > last.tau ? last : undefined;
    const q = clamp01((tau - (release - 1)) / throwFrames);
    const curve = made(q);
    const seen = curve.map((p) => project(b, p).xy);
    let nodes = curve;
    let shows = seen;
    let held = false;
    if (was && at.f > release + STRIKE.throwFree) {
      // What the frame before the next drawing shows.
      const from = was.shown.map(carried(was.shownBody, was.frameBody));
      const k = drawingIndex(Math.ceil(was.shownAt), o.dps ?? 12, fps);
      const budget = STRIKE.throwPx * clamp01((tau - was.shownAt) / Math.max(1, drawingStart(k + 1, o.dps ?? 12) - was.shownAt));
      const most = Math.max(...seen.map((p, i) => (fr[i] < THROW_OUTER ? 0 : Math.hypot(p[0] - from[i][0], p[1] - from[i][1]))));
      held = most > budget;
      if (held) {
        const share = budget / most;
        shows = seen.map((p, i) => {
          const w = share + (1 - share) * (1 - smooth(fr[i] / THROW_STEM));
          return [from[i][0] + (p[0] - from[i][0]) * w, from[i][1] + (p[1] - from[i][1]) * w];
        });
        nodes = curve.map((p, i) => (i === 0 ? p : unproject(b, shows[i], p[2])));
      }
    }
    const ends = at.sub === at.steps;
    const starts = !was || (ends && drawingStart(drawingIndex(at.f, o.dps ?? 12, fps), o.dps ?? 12) === at.f);
    thrown.set(id, { tau, q, held, frameBody: ends || !was ? b : was.frameBody, shown: starts ? shows : was.shown, shownBody: starts ? b : was.shownBody, shownAt: starts ? tau : was.shownAt });
    return { q, nodes };
  };

  const order = (l: StrikeLimb, at: StrikeStep, phase: StrikePhase): LimbControl | null => {
    const spec = specs.get(l.id);
    const n = l.target.length;
    const tau = at.f - 1 + at.sub / at.steps;
    // A released limb is handed back to the lift as soon as its throw is
    // done, and by the ease's end at the latest: handed back half thrown, the
    // rope snapped to its idle curve in a frame (550 px on the hero).
    const last = thrown.get(l.id);
    const done = phase.kind === 'release' && last !== undefined && tau > last.tau && last.q >= 1 && !last.held;
    if (!spec || phase.kind === 'none' || n < 2 || done) return null;
    const b = at.body;
    const target = l.target;
    const fr = arcFractions(target);
    // Round his body, when there is one: the dummy on this step, between its frames'.
    const ends = dummies ? [dummies[Math.max(0, Math.min(dummies.length - 1, at.f - 1))], dummies[Math.min(dummies.length - 1, at.f)]] : null;
    const dummy = ends ? lerpDummy(ends[0], ends[1], at.sub / at.steps) : null;
    // C round his body, routed finely before the nodes are read off it, on
    // the side of him the limb is on now.
    // The side of him each stretch is on now: the chain's depths, each the
    // median of its own and its neighbours' (DEPTH_CALM each way), so one
    // node the last routing left in a sliver of room behind him (290 px
    // behind its neighbours on the hero's limb 4, f109) isn't asked to stay
    // there, step after step, while the rest lies in front.
    const depthNow = depthAt(calmDepths(l.points));
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
    // C's side and bulge: round his outline when there is a body, else the
    // drawing's way; held steady from the whip on (steady).
    const R = project(b, target[0]).xy;
    const round = ends ? roundOutline(ends, at.sub / at.steps, b, R, P, (1.22 * R0) / (Math.hypot(P[0] - R[0], P[1] - R[1]) || 1), R0 * (1 + OUTLINE_PAD)) : null;
    const { side, bulge } = steady(l.id, tau, round?.side ?? spec.side ?? bulgeSide(target.map((q) => project(b, q).xy)), round?.bulge ?? STRIKE.bulge, Math.hypot(P[0] - R[0], P[1] - R[1]));
    const wave = { amp: clamp(STRIKE.ripple * Math.hypot(P[0] - R[0], P[1] - R[1]), STRIKE.rippleMin, STRIKE.rippleMax), phase: (ripplePhase.get(l.id) ?? 0) + 2 * Math.PI * STRIKE.rippleHz * (tau / fps) };
    if (phase.kind === 'strike') {
      // The whip (decision 15(d), 19(c)): a bend thrown down the limb. From
      // the chain as the whip found it to C, each segment's way turned round
      // the camera's z axis the throw's way (against the coil's wind: back
      // past the drawn limb and on to P), node i setting off whip·t_i of the
      // way into the whip and over whipSpan of it, faster and faster, on a
      // clock that quickens (whipEase), so the inner half comes over first,
      // the bend runs out to the tip, and the tip comes down onto P last and
      // fastest, on land itself. Laid on the chain (a pin on its own tip: the
      // lift then places the chain on the order exactly). Its outer part
      // loops behind the inner as a whip's does, but a loop, not a pigtail
      // (curlLimited), and the inner half comes over bowed, never a rod
      // (bowInner); neither once the front has passed every node, so the tip
      // lands on P exactly. Routed round him by its depth, as C is.
      const curve = curveNodes(b, target[0], P, side, liftPx, fr, wave, routed, bulge).nodes;
      const found = whipStart(l.id, tau, l.points);
      const u = clamp01((tau - (land - STRIKE.whipFrames)) / STRIKE.whipFrames) ** STRIKE.whipEase; // 0..1 through the whip's frames
      const w = (i: number) => clamp01((u - STRIKE.whip * fr[i]) / STRIKE.whipSpan) ** 2; // each node comes in faster and faster, the tip onto P fastest of all
      const sense = heldWay(`whip ${l.id}`, tau, () => {
        const away = coilWay(b, target, P);
        return Math.abs(away) > 0.5 ? -Math.sign(away) : 0; // no clear way round: the short way
      });
      const lengths = found.slice(1).map((p, i) => {
        const [a, c] = [dist3(found[i], p), dist3(curve[i], curve[i + 1])];
        return a + (c - a) * w(i + 1);
      });
      const goal = swing(found, curve, w, sense, lengths);
      const laid = w(n - 1) >= 1 ? goal : bowInner(b, curlLimited(goal, fr, w), side, fr);
      const out = routed && w(n - 1) < 1 ? routed.nodes(laid) : laid;
      return { target: out, stiffness: 1, pin: out[n - 1] };
    }
    if (phase.kind === 'pinned') {
      const { nodes: curve, length } = curveNodes(b, target[0], P, side, liftPx, fr, wave, routed, bulge);
      return { target: curve, stiffness: STRIKE.pinStiffness, pin: curve[n - 1], restScale: drawn > 0 ? length / drawn : 1 };
    }
    // The release (decision 15(f), 19(e)): the drawn length back within the
    // frame, and the limb flung from the pinned curve (as it would lie now) to
    // its own idle curve (snapBack), never longer than drawn, never straight
    // (bowed on screen, as the idle curve is), and never under the floor line
    // through P (aboveFloor: laid at the drawn length, C's last stretch would
    // run on past P into the floor).
    const goal = (l as LimbStep).drawn;
    const want = goal !== undefined && drawn > 0 ? Math.min(1, goal / drawn) : 1;
    // The side of him it is thrown from and the way round it is thrown, held
    // from the release's first step (the short way then): C opened out to
    // releaseBulge on the other side, as his outline turns under it, is
    // half a limb away (290 px on the hero's f132).
    const from = heldWay(`release side ${l.id}`, tau, () => side) as 1 | -1;
    const idle = bowedOnScreen(b, target, from, fr);
    const lengths = idle.slice(1).map((p, i) => dist3(idle[i], p) * want);
    const sense = heldWay(`release ${l.id}`, tau, () => Math.sign(wrap(chordAngle(idle) - chordAngle(curveNodes(b, target[0], P, from, liftPx, fr, undefined, undefined, bulge).nodes))) || 1);
    const made = (q: number): Vec3[] => {
      const pinned = curveNodes(b, target[0], P, from, liftPx, fr, undefined, undefined, bulge).nodes;
      return aboveFloor(b, bowedOnScreen(b, snapBack(pinned, idle, fr, q * throwFrames, q, sense, lengths), from, fr), P, d, STRIKE.floorPad);
    };
    // The throw's own clock and the budget on each drawing (decision 19(e)).
    const { q, nodes: throwOf } = throwClock(l.id, b, tau, at, fr, made);
    // Laid on the chain, as the whip and the pinned curve are (the lift's
    // kinematic pin, here on its own tip): left to its collisions, the pushes
    // tore it across him in depth (2.2× its length on the hero's f112). It
    // carries the throw's velocity on when it is handed back. Routed from its
    // own depths, not the chain's: it is on its way to its idle curve behind
    // him, and the chain's still lie in front of him where the strike lifted it.
    const laid = dummy
      ? stemClear(
          dummy,
          b,
          keptLong(
            (pts, now) => {
              const ft = arcFractions(pts);
              // The room round him grows along the limb: by the root, the rope grows out of him.
              return routeAround(dummy, pts, ft.map((t) => radiusAt(t, 1, R0) * smoothstepAt(0.1, 0.4, t)), routeFrom(ft, polyLength(pts), R0), now, FLARE * R0);
            },
            throwOf,
            lengths,
          ),
        )
      : throwOf;
    return {
      pin: laid[n - 1],
      restScale: drawn > 0 ? polyLength(laid) / drawn : 1,
      target: laid,
      stiffness: 1 + (l.stiffness - 1) * smooth(q) ** 2, // the rope's own by the throw's end
    };
  };

  return {
    land,
    release,
    floor: { P: [P[0], P[1]], d },
    step(at) {
      const phase = strikePhase(at.f, at.sub, at.steps, strike, easeFrames);
      return at.limbs.map((l) => order(l, at, phase));
    },
  };
}

// The controller strikeController makes: the contract's, plus the floor line
// the slam lands on (through P, normal d̂ down into it), which the lift keeps
// a released limb above (lift.ts).
export interface Strike extends StrikeController {
  floor: { P: Vec2; d: Vec2 };
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
  const away = coilWay(b, target, P);
  const fr = arcFractions(target);
  return target.map((q, i) => (i === 0 ? copy3(q) : turnAbout(b, R, q, away * ((STRIKE.coilDeg * Math.PI) / 180) * p(fr[i]) ** 3)));
}

// The coil's way round (−1..1, its share of coilDeg): away from P, fading
// out within 15° of P or of straight away from it.
function coilWay(b: Body3D, target: readonly Vec3[], P: Vec2): number {
  const R = project(b, target[0]).xy;
  const tip = project(b, target[target.length - 1]).xy;
  const [ax, ay] = [tip[0] - R[0], tip[1] - R[1]];
  const [cx, cy] = [P[0] - R[0], P[1] - R[1]];
  const sin = (ax * cy - ay * cx) / (Math.hypot(ax, ay) * Math.hypot(cx, cy) || 1); // > 0: P is clockwise of the tip
  return -clamp(sin / Math.sin((15 * Math.PI) / 180), -1, 1);
}

// The first node the routing moves: past the flared root, as the lift collides.
function routeFrom(fr: readonly number[], length: number, R0: number): number {
  const i = fr.findIndex((t) => t * length >= FLARE * R0);
  return i < 0 ? fr.length : Math.max(1, i);
}
const FLARE = 1.22; // × R0: the flared root's radius (tube.ts, 1 + ROOT_FLARE)

// From `from` to `to` (camera px, root first, the same root), each
// segment's way turned w(i) of the way round the camera's z axis (past it
// for w > 1), every one the same way round: the chord's turn taken `sense`
// (+1 counter-clockwise on screen, −1 clockwise; 0 the short way), each
// segment's own turn about the chord the short way. Its rise toward the
// camera goes from its from's to its to's; its length is `lengths`[i],
// laid from to's root. A slerp in 3D between two ways nearly opposite each
// other (a limb thrown back up from P, or whipped down from its coil) goes
// round whichever side its last bit of noise says, and flipped the whole
// limb across its root between two steps (442 px on the hero's f132).
function swing(from: readonly Vec3[], to: readonly Vec3[], w: (i: number) => number, sense: number, lengths: readonly number[]): Vec3[] {
  const n = to.length;
  const [ga, gb] = [chordAngle(from), chordAngle(to)];
  const turn = turnWay(gb - ga, sense);
  const out: Vec3[] = [copy3(to[0])];
  for (let i = 0; i < n - 1; i++) {
    const a = sub3(from[i + 1], from[i]);
    const c = sub3(to[i + 1], to[i]);
    const [aa, ca] = [Math.atan2(a[1], a[0]), Math.atan2(c[1], c[0])];
    const [ea, ec] = [Math.atan2(a[2], Math.hypot(a[0], a[1])), Math.atan2(c[2], Math.hypot(c[0], c[1]))];
    const k = w(i + 1);
    const ang = aa + k * (turn + wrap(ca - gb - (aa - ga)));
    const rise = ea + k * (ec - ea);
    const l = lengths[i];
    const p = out[i];
    out.push([p[0] + l * Math.cos(rise) * Math.cos(ang), p[1] + l * Math.cos(rise) * Math.sin(ang), p[2] + l * Math.sin(rise)]);
  }
  return out;
}

// The thrown curve `x` frames into the release (q: that share of the throw),
// laid from the pinned curve's root (decision 15(f)). Each segment's way on
// screen is its pinned way plus
//   - the snap: the chord's turn to the idle curve's, taken `sense` round,
//     and the segment's own way about the chord, on a clock that is most of
//     the way there on the first drawing, the tip's first (snapDelay·(1 − t)
//     frames ahead of the root's), so the tension let go flings the tips off P;
//   - the recoil: a damped swing past the idle curve and back (overshootDeg,
//     recoilFrames a swing), running from the tip up to the root
//     (recoilDelay·(1 − t) frames), gone with the throw's end, so the limb
//     flops into its curve instead of stopping on it.
// Its rise toward the camera goes the same way as the snap, and its length is `lengths`[i].
function snapBack(pinned: readonly Vec3[], idle: readonly Vec3[], fr: readonly number[], x: number, q: number, sense: number, lengths: readonly number[]): Vec3[] {
  const n = idle.length;
  const [ga, gb] = [chordAngle(pinned), chordAngle(idle)];
  const turn = turnWay(gb - ga, sense);
  const way = Math.sign(turn) || 1;
  const left = 1 - clamp01(q) ** 4;
  const out: Vec3[] = [copy3(idle[0])];
  for (let i = 0; i < n - 1; i++) {
    const a = sub3(pinned[i + 1], pinned[i]);
    const c = sub3(idle[i + 1], idle[i]);
    const [aa, ca] = [Math.atan2(a[1], a[0]), Math.atan2(c[1], c[0])];
    const [ea, ec] = [Math.atan2(a[2], Math.hypot(a[0], a[1])), Math.atan2(c[2], Math.hypot(c[0], c[1]))];
    const back = 1 - fr[i + 1];
    const flung = 1 - (1 - snapClock(x - STRIKE.snapDelay * back)) * (1 - clamp01(q) ** 4);
    const snap = smooth(q / STRIKE.stemTurn) + (flung - smooth(q / STRIKE.stemTurn)) * smoothstepAt(STRIKE.stemSpan[0], STRIKE.stemSpan[1], fr[i + 1]);
    const u = x - STRIKE.recoilDelay * back;
    const swung = u > 0 ? Math.exp(-u / STRIKE.recoilDecay) * Math.sin((2 * Math.PI * u) / STRIKE.recoilFrames) : 0;
    const ang = aa + snap * (turn + wrap(ca - gb - (aa - ga))) + way * ((STRIKE.overshootDeg * Math.PI) / 180) * swung * left;
    const rise = ea + flung * (ec - ea);
    const p = out[i];
    out.push([p[0] + lengths[i] * Math.cos(rise) * Math.cos(ang), p[1] + lengths[i] * Math.cos(rise) * Math.sin(ang), p[2] + lengths[i] * Math.sin(rise)]);
  }
  return out;
}
// A thrown curve routed round him at its own length (decision 15(f)): the
// routing moves depths only, and a dive round him adds to the rope. When the
// way it is routed from its own depths comes out over THROW_LONG × its length
// (the way that moves it least can leave his back in a step as deep as he
// is), the way that stays nearest the root's depth is tried, and the shorter kept.
function keptLong(route: (pts: Vec3[], now?: (i: number) => number) => Vec3[], nodes: Vec3[], lengths: readonly number[]): Vec3[] {
  const own = route(nodes);
  if (polyLength(own) <= THROW_LONG * lengths.reduce((sum, l) => sum + l, 0)) return own;
  const low = route(nodes, () => nodes[0][2]);
  return polyLength(low) < polyLength(own) ? low : own;
}
const THROW_LONG = 1.08;

// The curve with no node left over STEM_SLACK px inside him: the routing starts
// past the flared root, and a stem swung round can sweep a node by the root a
// little into him. Out the shortest way: the scan's, else straight off his torso.
function stemClear(d: Dummy, b: Body3D, nodes: Vec3[]): Vec3[] {
  const centre = toCamera(b, [0, TORSO.cy, 0]);
  return nodes.map((p, i) => {
    const deep = i === 0 ? 0 : insideDepth(d, p);
    if (deep <= STEM_SLACK) return p;
    const hit = d.scan ? scanPush(d.scan, p, 0) : null;
    if (hit) return hit.out;
    const off = sub3(p, centre);
    return add3(p, scale3(off, (deep + STEM_SLACK) / (Math.hypot(off[0], off[1], off[2]) || 1)));
  });
}
const STEM_SLACK = 1;

const snapClock = (x: number) => (x > 0 ? 1 - Math.exp(-x / STRIKE.snapFrames) : 0);

// His torso's similarity from body a to body b on screen (scale, lean and
// place: what carries a held drawing between drawings, impact/scene.ts
// torsoSimilarity), as a map of screen points.
function carried(a: Body3D, b: Body3D): (p: Vec2) => Vec2 {
  const k = b.unit / a.unit;
  const [c, s] = [k * Math.cos(b.roll - a.roll), k * Math.sin(b.roll - a.roll)];
  return (p) => {
    const [x, y] = [p[0] - a.x, p[1] - a.y];
    return [b.x + c * x - s * y, b.y + s * x + c * y];
  };
}

// The way a limb's chord points on screen (camera x, y), root to tip.
const chordAngle = (p: readonly Vec3[]) => Math.atan2(p[p.length - 1][1] - p[0][1], p[p.length - 1][0] - p[0][0]);

// An angle taken `sense` round (+1 counter-clockwise, −1 clockwise, 0 the short way).
function turnWay(a: number, sense: number): number {
  const short = wrap(a);
  if (sense === 0 || short === 0 || Math.sign(short) === Math.sign(sense)) return short;
  return short + 2 * Math.PI * Math.sign(sense);
}
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

// The height (px, up −d̂) a point `up` px above the floor line is kept at:
// `pad` at least, eased in over FLOOR_BAND px (a softplus), so a curve the
// floor stops has its bottom rounded, never folded flat along the line.
export function floorHeight(up: number, pad: number): number {
  const x = (up - pad) / FLOOR_BAND;
  return pad + FLOOR_BAND * (x > 30 ? x : Math.log1p(Math.exp(x)));
}
const FLOOR_BAND = 12; // px

// `nodes` (camera px) with every point past the root kept `pad` px above
// the floor line through P on screen (normal d̂, pointing down into the
// floor), by floorHeight: lifted straight back up −d̂, at its own depth.
export function aboveFloor(b: Body3D, nodes: readonly Vec3[], P: Vec2, d: Vec2, pad: number): Vec3[] {
  return nodes.map((p, i) => {
    if (i === 0) return copy3(p);
    const xy = project(b, p).xy;
    const up = -((xy[0] - P[0]) * d[0] + (xy[1] - P[1]) * d[1]);
    const lift = floorHeight(up, pad) - up;
    return lift > 1e-3 ? unproject(b, [xy[0] - d[0] * lift, xy[1] - d[1] * lift], p[2]) : copy3(p);
  });
}

// The whip's dragged outer part as a whip's loop, not a pigtail: root to
// tip, a joint the front hasn't passed (w < 1) turns no more than
// STRIKE.whipJoint on screen, and the outer quarter's joints no more than
// STRIKE.whipCurl in all; a segment over it is turned back toward the one
// before it about the view axis, the rest of the chain carried with it.
function curlLimited(nodes: readonly Vec3[], fr: readonly number[], w: (i: number) => number): Vec3[] {
  const out = nodes.map(copy3);
  const joint = (STRIKE.whipJoint * Math.PI) / 180;
  let left = (STRIKE.whipCurl * Math.PI) / 180;
  for (let i = 1; i < out.length - 1; i++) {
    const [ax, ay] = [out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1]];
    const [bx, by] = [out[i + 1][0] - out[i][0], out[i + 1][1] - out[i][1]];
    if (Math.hypot(ax, ay) < 1e-6 || Math.hypot(bx, by) < 1e-6) continue;
    const turn = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
    const outer = fr[i] >= 0.75;
    const most = w(i + 1) >= 1 ? Infinity : outer ? Math.min(joint, Math.max(0, left)) : joint;
    const kept = Math.sign(turn) * Math.min(Math.abs(turn), most);
    if (outer) left -= Math.abs(kept);
    if (kept === turn) continue;
    // Turn every node past i about node i on screen (the camera's z axis) by kept − turn.
    const [c, s] = [Math.cos(kept - turn), Math.sin(kept - turn)];
    for (let j = i + 1; j < out.length; j++) {
      const [dx, dy] = [out[j][0] - out[i][0], out[j][1] - out[i][1]];
      out[j] = [out[i][0] + c * dx - s * dy, out[i][1] + s * dx + c * dy, out[j][2]];
    }
  }
  return out;
}

// The whip's inner half bowed on screen to STRIKE.whipInnerBow of its chord
// when it looks straighter (bowedOnScreen on it alone, its side), the outer
// half carried along with the inner half's end.
function bowInner(b: Body3D, nodes: readonly Vec3[], side: 1 | -1, fr: readonly number[]): Vec3[] {
  const half = nodes.length >> 1;
  const inner = nodes.slice(0, half + 1);
  if (!(sagittaRatio(inner.map((p) => project(b, p).xy)) < STRIKE.whipInnerBow)) return nodes.map(copy3);
  const end = fr[half] > 0 ? fr[half] : 1;
  const bowed = bowedOnScreen(b, inner, side, fr.slice(0, half + 1).map((t) => t / end), STRIKE.whipInnerBow);
  const by = sub3(bowed[half], nodes[half]);
  return [...bowed, ...nodes.slice(half + 1).map((p) => add3(p, by))];
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
  // The ripple's other half: each node a quarter wave behind it along the
  // chord, so every point rides a small ellipse and the pinned rope is never
  // still (read off by arc length, a ripple across C alone stops at its crests).
  const along = (nodes: Vec3[]): Vec3[] =>
    ripple
      ? nodes.map((p, i) => {
          if (i === 0 || i === nodes.length - 1) return p;
          const t = fr[i];
          const w = STRIKE.rippleAlong * ripple.amp * Math.sin(Math.PI * t) * Math.cos(ripple.phase - 2 * Math.PI * STRIKE.rippleWaves * t);
          const xy = project(b, p).xy;
          return unproject(b, [xy[0] + ny * w, xy[1] - nx * w], p[2]);
        })
      : nodes;
  const plain = along(readOff(b, fine, fr));
  return { nodes: route ? route.nodes(along(readOff(b, route.fine(fine), fr))) : plain, length: polyLength(plain) };
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

// A chain with each node's depth the median of its own and DEPTH_CALM
// neighbours' each way (the root's and the tip's kept).
function calmDepths(pts: readonly Vec3[]): Vec3[] {
  const n = pts.length;
  return pts.map((p, i): Vec3 => {
    if (i === 0 || i === n - 1) return copy3(p);
    const zs: number[] = [];
    for (let j = Math.max(0, i - DEPTH_CALM); j <= Math.min(n - 1, i + DEPTH_CALM); j++) zs.push(pts[j][2]);
    zs.sort((a, b) => a - b);
    return [p[0], p[1], zs[zs.length >> 1]];
  });
}
const DEPTH_CALM = 2;

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
