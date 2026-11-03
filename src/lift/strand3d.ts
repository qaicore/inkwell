// EXPERIMENT (exp/hero-3d-lift): the strand engine of src/physics/strand.ts,
// step for step, with a third axis. Verlet, distance constraints, dynamic
// follow-the-leader, shape pull, then the bend limit, which in 3D measures
// each joint against the target's bend carried onto the current chain (the
// smallest rotation that takes the target's parent segment onto the chain's).
// The 3D rope has its own parameters (decision 15): ROPE3D loses as much of
// its velocity a step as the 2D engine (less left the idle limbs thrashing
// between drawings; the swing past where it was going is the drive's and
// the release's now), and falls a little harder, so it hangs like something
// heavy. The 2D engine and SPEC §8.7's DEFAULT_PHYSICS are left as they
// are. No joint folds sharper than FOLD (40°) after a distance pass (fold):
// the next node but one is pushed off along their line, the root and a
// pinned tip held. After the bend limit a free chain
// curls: each joint turns CURL of its way back toward the target's bend
// (curlBends), so the bend wave the lift drives down it carries, and a hard
// swing can't pull it straight. A pinned chain gets two more distance passes
// there instead, from the tip and back, so the limit's re-laying is shared
// down the rope rather than kinking its last segment.
//
// Collisions (decision 17): in the passes' second half and after the bend
// limit, every node but the root, the nodes within a limb radius of it (they
// grow out of his back) and a pinned tip is pushed out of the dummy's parts
// or its scanned body (collide.ts) by its own radius, with friction on its
// sliding velocity after the bend limit; then two passes mend the lengths
// the pushes broke, each pushed out again. The nodes by the root are pushed
// out by their centreline only: the flare may sink into his back, the line
// may not. The shape it's pulled toward is left as it is (pushing it out too
// bends a drooping limb round every part it hangs near), but a node isn't
// pulled toward a place in it inside him. And the pull never stretches a
// segment past TEAR × its rest length, so a limb caught on him isn't torn
// across him.
//
// The strike hook (impact design §4): a step can take one LimbControl. Its
// target replaces the drawing's for the shape pull and the bend limit (the
// root stays on the lifted root, P1); its stiffness replaces the stroke's;
// restScale scales every rest length; the impulse is added to each node's
// velocity before the Verlet step; and the pin holds the tip node. A pinned
// order with a target lays the chain on it (kinematic: every node on the
// target, the root on the lifted root): the controller's whip and pinned
// curve are the rope's shape there, and it carries their velocity on when
// it lets go. Without one, a step is exactly what it always was.
import type { PhysicsParams } from '../physics/strand.ts';
import type { LimbControl } from '../impact/contracts.ts';
import type { Vec3 } from './body.ts';
import { collideChain, FRICTION, insideDepth, type Dummy } from './collide.ts';

// The 3D rope's own parameters: the 2D damping a step (a third of it left
// the idle limbs thrashing between drawings), 1.5× its gravity, and a
// looser bend limit, so the drawn bend is a tendency, not a mould.
export const ROPE3D: PhysicsParams = { dt: 1 / 120, passes: 8, damping: 0.04, gravity: 3, bendLimitDeg: 50 };

// What a step collides with: the dummy on this step, each node's limb radius
// (px) and the first node that collides (the ones before it grow out of his back).
export interface Contact {
  dummy: Dummy;
  radii: readonly number[];
  from: number;
}

const PULL = 0.5;
const TEAR = 1.1; // the most the shape pull may stretch a segment, × its rest length
const FTL_DAMPING = 0.9;
const ROOT_HELD_FROM = 0.3;
const BEND_STEP = 0.05; // rad a joint past the bend limit is turned back a step at most: pushed round his shoulder, the rope bends past it, and turning it back all at once would swing the rest of it over him
const CURL = 0.1; // the share of each joint's way back to its drawn bend a step (curlBends): a bend wave carries, a swing can't straighten it
const FOLD = (40 * Math.PI) / 180; // the sharpest a joint may bend (fold), radians
// The base's hold (decision 15(a)): a tentacle is muscle at the root and hangs
// at the tip. A pulled node's pull toward its place in the shape is at least
// pull·(1 − t/span)² (t its share of the way along), so the base takes up his
// turn as the drive turns it (lift.ts ROPE: quick at the root) and the rest
// of the rope is dragged round after it, the tip last. A chain under no pull
// (stiffness 0) is held by nothing.
export const HOLD = { pull: 0.1, span: 0.45 };

export interface Chain3 {
  kind: 'strand' | 'rigid';
  stiffness: number;
  points: Vec3[]; // camera px; node 0 is the root
  prev: Vec3[];
  clear: number[]; // per node, the depth (camera px) where it was last clear of his body (collide.ts), kept by the collisions; NaN: not yet
}

export function createChain3(target: Vec3[], kind: Chain3['kind'], stiffness: number): Chain3 {
  return { kind, stiffness, points: target.map(copy), prev: target.map(copy), clear: target.map(() => NaN) };
}

// `target`: the lifted drawing on this step, camera px. `control`: the strike
// hook's orders for this step (null or missing: none). `contact`: the body it
// collides with (null or missing: nothing).
export function stepChain3(chain: Chain3, target: Vec3[], unitPx: number, params: PhysicsParams = ROPE3D, control?: LimbControl | null, contact?: Contact | null): void {
  const { points, prev } = chain;
  const n = points.length;
  const pin = control?.pin ?? null;
  const shape = control?.target ?? target;
  const stiffness = control?.stiffness ?? chain.stiffness;
  const hold = () => {
    if (pin) points[n - 1] = copy(pin);
  };
  // A rigid stroke is its target; so is a pinned chain with one (decision
  // 15(e)): the strike's rippled curve, routed round him, its tip on the pin.
  // Pulled to it instead, a rope as long as the way straight to P was dragged
  // through him on the way round, one span across the whole drop.
  if (chain.kind === 'rigid' || (pin && control?.target)) {
    for (let i = 0; i < n; i++) {
      prev[i] = points[i];
      points[i] = copy(i === 0 ? target[0] : shape[i]);
    }
    hold();
    if (pin) for (let i = 0; i < n; i++) chain.clear[i] = points[i][2];
    return;
  }
  const before = new Array<Vec3>(n - 1);
  for (let i = 0; i < n - 1; i++) before[i] = unit(points[i], points[i + 1]);

  // 0. The impulse: velocity is (points − prev)/dt, so it moves prev.
  const impulse = control?.impulse;
  if (impulse) for (let i = 1; i < n; i++) prev[i] = sub(prev[i], scale(impulse[i], params.dt));

  // 1. Verlet, with gravity straight down the screen (the camera is level).
  const keep = 1 - params.damping;
  const fall = params.gravity * unitPx * params.dt * params.dt;
  for (let i = 1; i < n; i++) {
    const p = points[i];
    const q = prev[i];
    prev[i] = p;
    points[i] = [p[0] + (p[0] - q[0]) * keep, p[1] + (p[1] - q[1]) * keep + fall, p[2] + (p[2] - q[2]) * keep];
  }
  prev[0] = points[0];
  points[0] = copy(target[0]);
  hold();

  // 2. Distance constraints, then dynamic follow-the-leader. A pinned tip is
  // fixed like the root, and follow-the-leader stops short of it.
  const restScale = control?.restScale ?? 1;
  const rest = new Array<number>(n - 1);
  for (let i = 0; i < n - 1; i++) rest[i] = distance(target[i], target[i + 1]) * restScale;
  // Out of his body, each node the way it came: the nodes by the root by
  // their centreline, the rest by their radius. `fine`: the segments sampled
  // as finely as they are checked (the last pushes of a step).
  const collide = (friction: number, fine = false) => {
    if (!contact) return;
    const from = Math.max(1, Math.min(contact.from, pin ? n - 1 : n));
    // The root's zone by its centreline, the segment out of it into the first
    // node pushed by its radius sampled too (that node held there, as a fixed end).
    collideChain(contact.dummy, points, prev, new Array<number>(from).fill(0), 1, from, friction, chain.clear, from < n, fine);
    collideChain(contact.dummy, points, prev, contact.radii, from, pin ? n - 1 : n, friction, chain.clear, pin !== null, fine, false);
    hold();
  };
  const unfold = fold(rest);
  for (let pass = 0; pass < params.passes; pass++) {
    const forward = pass % 2 === 0;
    for (let j = 0; j < n - 1; j++) {
      const i = forward ? j : n - 2 - j;
      satisfy(points, i, rest[i], before[i], pin !== null);
    }
    unfold(points, pin !== null);
    hold();
    // In the passes' second half too, so the lengths and the contact settle together.
    if (2 * pass >= params.passes) collide(0);
  }
  const moved: Vec3[] = new Array(n);
  moved[0] = [0, 0, 0];
  for (let i = 0; i < n - 1; i++) moved[i + 1] = pin && i === n - 2 ? [0, 0, 0] : follow(points, i, rest[i], before[i]);
  for (let i = 1; i < n - 1; i++) prev[i] = add(prev[i], scale(moved[i + 1], FTL_DAMPING));

  // 3. Shape pull, never into his body: a node whose place in the shape is
  // inside him (where no way round him in depth was found, or a drawing he
  // has turned into) hangs on its neighbours and its collisions instead. Nor
  // does the pull tear the chain: from the root out, no node ends up more
  // than TEAR × its rest length from the one before it. A strong pull past a
  // node left hanging, or caught on him (a limb threaded under his arm when
  // it lets go of P), would otherwise stretch the rope across the gap further
  // than the mending can close.
  // The base holds (HOLD): pulled harder toward its place by the root.
  const k = PULL * stiffness * stiffness;
  if (k > 0) {
    const total = rest.reduce((sum, r) => sum + r, 0);
    let along = 0;
    for (let i = 1; i < n; i++) {
      along += rest[i - 1];
      const t = total > 0 ? along / total : 1;
      const ki = pin ? k : Math.max(k, HOLD.pull * Math.max(0, 1 - t / HOLD.span) ** 2);
      const inside = contact && insideDepth(contact.dummy, shape[i], i < contact.from ? 0 : contact.radii[i]) > 0;
      const p = inside ? points[i] : add(points[i], scale(sub(shape[i], points[i]), ki));
      const d = sub(p, points[i - 1]);
      const l = Math.hypot(d[0], d[1], d[2]);
      points[i] = l > TEAR * rest[i - 1] ? add(points[i - 1], scale(d, (TEAR * rest[i - 1]) / l)) : p;
    }
  }
  hold();

  // 4. Bend limit.
  if (params.bendLimitDeg !== null) {
    const limit = (params.bendLimitDeg * Math.PI) / 180;
    const root = Math.PI - (Math.PI - limit) * Math.min(1, stiffness / ROOT_HELD_FROM);
    limitBends(points, shape, limit, root);
    hold();
    // The limit re-lays the chain from the root, so a pinned tip has moved off
    // its pin and back: two more passes share that out down the chain, where
    // the last segment alone would kink.
    if (pin) {
      for (let pass = 0; pass < 2; pass++) {
        for (let j = 0; j < n - 1; j++) {
          const i = pass === 0 ? n - 2 - j : j;
          satisfy(points, i, rest[i], unit(points[i], points[i + 1]), true);
        }
        hold();
      }
    }
  }

  // 4b. The curl: a tentacle's own.
  if (!pin) curlBends(points, prev, shape, CURL);

  // 5. Out of his body, with friction on the sliding velocity, then the
  // lengths the pushes broke mended in two more passes, each pushed out
  // again: a hard push would otherwise leave the chain folded short.
  collide(FRICTION);
  if (contact) {
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 0; j < n - 1; j++) {
        const i = pass % 2 === 0 ? j : n - 2 - j;
        satisfy(points, i, rest[i], unit(points[i], points[i + 1]), pin !== null);
      }
      unfold(points, pin !== null);
      hold();
      collide(0, true);
    }
  }
}

function axis(a: Vec3, b: Vec3, before: Vec3): [Vec3, number] {
  const d = sub(b, a);
  const along = dot(d, before);
  if (along < 0 || (d[0] === 0 && d[1] === 0 && d[2] === 0)) return [before, along];
  const len = Math.hypot(d[0], d[1], d[2]);
  return [scale(d, 1 / len), len];
}

// The root never moves; nor does a pinned tip (`pinned`), so the segment into
// it moves only its inner end.
function satisfy(points: Vec3[], i: number, rest: number, before: Vec3, pinned = false) {
  const [u, d] = axis(points[i], points[i + 1], before);
  const error = d - rest;
  const last = pinned && i === points.length - 2;
  if (i === 0) {
    if (!last) points[1] = sub(points[1], scale(u, error));
  } else if (last) {
    points[i] = add(points[i], scale(u, error));
  } else {
    points[i] = add(points[i], scale(u, error / 2));
    points[i + 1] = sub(points[i + 1], scale(u, error / 2));
  }
}

// The fold floor: at each joint, the nodes either side of it kept at least
// as far apart as two segments of these rest lengths bent FOLD there (the
// cloth simulators' bending constraint, a floor only): the rope stays as
// floppy as it was below FOLD, but a push out of his body or a hard swing
// can't crease it into a hairpin or tie it in a knot. The root never moves,
// nor does a pinned tip.
function fold(rest: readonly number[]): (points: Vec3[], pinned: boolean) => void {
  const least = rest.slice(1).map((b, i) => Math.sqrt(rest[i] ** 2 + b ** 2 + 2 * rest[i] * b * Math.cos(FOLD)));
  return (points, pinned) => {
    const n = points.length;
    for (let i = 0; i < n - 2; i++) {
      const [a, c] = [points[i], points[i + 2]];
      const d = distance(a, c);
      if (!(d < least[i]) || d < 1e-9) continue;
      const u = scale(sub(c, a), 1 / d);
      const gap = least[i] - d;
      const fixedA = i === 0;
      const fixedC = pinned && i + 2 === n - 1;
      if (fixedA && fixedC) continue;
      const [ka, kc] = fixedA ? [0, 1] : fixedC ? [1, 0] : [0.5, 0.5];
      points[i] = sub(a, scale(u, gap * ka));
      points[i + 2] = add(c, scale(u, gap * kc));
    }
  };
}

function follow(points: Vec3[], i: number, length: number, before: Vec3): Vec3 {
  const [u] = axis(points[i], points[i + 1], before);
  const moved = add(points[i], scale(u, length));
  const shift = sub(moved, points[i + 1]);
  points[i + 1] = moved;
  return shift;
}

// Root to tip, past the root segment: each segment turned `c` of the way to
// where the target's bend would put it, given where its parent points now,
// the rest of the chain riding along. Not a pull to a place, and no push
// either (prev moves with the points, so it adds no speed): the limb swings
// and drags as a rope, but keeps curling the way it's drawn (and the way the
// bend wave moves it) instead of going straight when it's swung hard.
function curlBends(points: Vec3[], prev: Vec3[], target: Vec3[], c: number) {
  const n = points.length;
  let parent = unit(points[0], points[1]);
  for (let i = 1; i < n - 1; i++) {
    const length = distance(points[i], points[i + 1]);
    const now = unit(points[i], points[i + 1]);
    const expected = carry(unit(target[i], target[i + 1]), unit(target[i - 1], target[i]), parent);
    const dir = slerp(now, expected, c);
    const shift = sub(add(points[i], scale(dir, length)), points[i + 1]);
    for (let j = i + 1; j < n; j++) {
      points[j] = add(points[j], shift);
      prev[j] = add(prev[j], shift);
    }
    parent = dir;
  }
}

// Root to tip: each segment may turn at most `limit` from where the target's
// bend would put it, given where its parent actually points now, turned
// back BEND_STEP a step at most (the rest of the chain re-laid behind it).
function limitBends(points: Vec3[], target: Vec3[], limit: number, root: number) {
  const n = points.length;
  const lengths = new Array<number>(n - 1);
  const dirs = new Array<Vec3>(n - 1);
  for (let i = 0; i < n - 1; i++) {
    lengths[i] = distance(points[i], points[i + 1]);
    dirs[i] = unit(points[i], points[i + 1]);
  }
  for (let i = 0; i < n - 1; i++) {
    const drawn = unit(target[i], target[i + 1]);
    const expected = i === 0 ? drawn : carry(drawn, unit(target[i - 1], target[i]), dirs[i - 1]);
    const max = i === 0 ? root : limit;
    const angle = Math.acos(Math.min(1, Math.max(-1, dot(dirs[i], expected))));
    if (angle > max) dirs[i] = slerp(expected, dirs[i], Math.max(max, angle - BEND_STEP) / angle);
    points[i + 1] = add(points[i], scale(dirs[i], lengths[i]));
  }
}

// `v` turned by the smallest rotation that takes unit `from` onto unit `to`
// (Rodrigues' formula).
function carry(v: Vec3, from: Vec3, to: Vec3): Vec3 {
  const k = cross(from, to);
  const s = Math.hypot(k[0], k[1], k[2]);
  const c = dot(from, to);
  if (s < 1e-9) return c > 0 ? v : scale(v, -1);
  const kh = scale(k, 1 / s);
  return add(add(scale(v, c), scale(cross(kh, v), s)), scale(kh, dot(kh, v) * (1 - c)));
}

// From unit a toward unit b, `t` of the angle between them.
function slerp(a: Vec3, b: Vec3, t: number): Vec3 {
  const w = Math.acos(Math.min(1, Math.max(-1, dot(a, b))));
  if (w < 1e-9) return b;
  const s = Math.sin(w);
  return add(scale(a, Math.sin((1 - t) * w) / s), scale(b, Math.sin(t * w) / s));
}

const copy = (p: Vec3): Vec3 => [p[0], p[1], p[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const distance = (a: Vec3, b: Vec3) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
const unit = (a: Vec3, b: Vec3): Vec3 => {
  const d = distance(a, b);
  return d === 0 ? [0, 0, 0] : [(b[0] - a[0]) / d, (b[1] - a[1]) / d, (b[2] - a[2]) / d];
};
