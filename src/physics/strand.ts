// One physics engine for every stroke (SPEC §8.3): a Verlet chain that
// chases a target shape. Rope at stiffness 0, nearly the drawn shape at 1,
// and `rigid` strokes (horns, halos) that are the target exactly.
//
// It runs in pixels, and the target is converted to pixels with the current
// torso transform before every step, so when the body moves the chain lags,
// overshoots and settles instead of moving rigidly with it.
import type { Vec2 } from '../types/effect.ts';

export interface PhysicsParams {
  dt: number; // seconds per step
  passes: number; // distance-constraint passes per step
  damping: number; // fraction of velocity lost per step
  gravity: number; // torso heights / s², scaled by the step's px per torso height
  bendLimitDeg: number | null; // max bend per joint away from the target's own bend; null = off
}

// SPEC §8.7 starting values; Qai tunes them there.
export const DEFAULT_PHYSICS: PhysicsParams = { dt: 1 / 120, passes: 8, damping: 0.04, gravity: 2, bendLimitDeg: 35 };
const PULL = 0.5; // shape pull k = PULL · stiffness²
const FTL_DAMPING = 0.9; // share of a child's correction taken out of its parent's velocity (Müller et al.)

export interface Chain {
  kind: 'strand' | 'rigid';
  stiffness: number; // 0 = rope ... 1 = stiff
  points: Vec2[]; // node positions in px; node 0 is the root
  prev: Vec2[]; // positions one step ago: Verlet keeps velocity as x - prev
}

// A chain at rest on its target.
export function createChain(targetPx: Vec2[], kind: Chain['kind'], stiffness: number): Chain {
  return { kind, stiffness, points: targetPx.map(copy), prev: targetPx.map(copy) };
}

// Advances the chain by one fixed step toward `targetPx`, the target shape in
// pixels for this step. `unitPx` is this step's pixels per torso height.
export function stepChain(chain: Chain, targetPx: Vec2[], unitPx: number, params: PhysicsParams = DEFAULT_PHYSICS): void {
  const { points, prev } = chain;
  const n = points.length;
  if (chain.kind === 'rigid') {
    for (let i = 0; i < n; i++) {
      prev[i] = points[i];
      points[i] = copy(targetPx[i]);
    }
    return;
  }

  // Each segment's direction as the step starts. A fast body moves the root
  // about a segment length per step; in one step it can pass right through
  // node 1, and the constraints would then put node 1 on the far side,
  // folding the stroke back over its root. No segment really turns half way
  // round in 1/120 s, so a segment that points backwards from where it
  // pointed at the start of the step is pushed along its old direction.
  const before = new Array<Vec2>(n - 1);
  for (let i = 0; i < n - 1; i++) before[i] = unit(points[i], points[i + 1]);

  // 1. Verlet: carry on at the last step's velocity, minus damping, plus gravity.
  const keep = 1 - params.damping;
  const fall = params.gravity * unitPx * params.dt * params.dt;
  for (let i = 1; i < n; i++) {
    const [x, y] = points[i];
    const [px, py] = prev[i];
    prev[i] = points[i];
    points[i] = [x + (x - px) * keep, y + (y - py) * keep + fall];
  }
  prev[0] = points[0];
  points[0] = copy(targetPx[0]); // the root is pinned to the anchor

  // 2. Distance constraints: each pair back to its rest length, the target's
  // own segment length this step (so the chain scales with the body). The
  // root never moves; other pairs split the correction. Sweeps alternate
  // direction so neither end of the chain is favored. A fast body moves the
  // root about a segment length per step, more than a few such passes can
  // absorb, so a last follow-the-leader sweep (root to tip, each node placed
  // at its rest length from its parent) leaves every length exact.
  const rest = new Array<number>(n - 1);
  for (let i = 0; i < n - 1; i++) rest[i] = distance(targetPx[i], targetPx[i + 1]);
  for (let pass = 0; pass < params.passes; pass++) {
    const forward = pass % 2 === 0;
    for (let j = 0; j < n - 1; j++) {
      const i = forward ? j : n - 2 - j;
      satisfy(points, i, rest[i], before[i]);
    }
  }
  // Plain follow-the-leader lets the tip run wild; dynamic follow-the-leader
  // (Müller et al. 2012) fixes that by taking a share of each node's child's
  // correction back out of the node's velocity.
  const moved: Vec2[] = new Array(n);
  moved[0] = [0, 0];
  for (let i = 0; i < n - 1; i++) moved[i + 1] = follow(points, i, rest[i], before[i]);
  for (let i = 1; i < n - 1; i++) {
    prev[i] = [prev[i][0] + FTL_DAMPING * moved[i + 1][0], prev[i][1] + FTL_DAMPING * moved[i + 1][1]];
  }

  // 3. Shape pull toward the target.
  const k = PULL * chain.stiffness * chain.stiffness;
  if (k > 0) {
    for (let i = 1; i < n; i++) {
      points[i] = [points[i][0] + k * (targetPx[i][0] - points[i][0]), points[i][1] + k * (targetPx[i][1] - points[i][1])];
    }
  }

  // 4. Bend limit: no joint bends more than the limit away from the target's
  // bend at that joint. Measuring against the target, not a straight line,
  // keeps a curve Qai drew; it only stops kinks he didn't draw. A stroke with
  // any stiffness has a drawn angle at the root too, where it leaves the
  // body, and keeps it within the limit; without that, a body moving along
  // the stroke faster than its nodes can follow buckles it at the root into
  // a loop that rolls down to the tip. A rope (stiffness 0) has no drawn shape
  // to keep, so it is free at the root and hangs straight down (P4).
  if (params.bendLimitDeg !== null) limitBends(points, targetPx, (params.bendLimitDeg * Math.PI) / 180, chain.stiffness > 0);
}

// The direction to restore segment a→b along, and its length measured that
// way: its own direction, or, if it has turned backwards from `before` (its
// direction when the step began), `before` and a negative length, so the
// correction pushes b back out ahead of a.
function axis(a: Vec2, b: Vec2, before: Vec2): [number, number, number] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const along = dx * before[0] + dy * before[1];
  if (along < 0 || (dx === 0 && dy === 0)) return [before[0], before[1], along];
  const d = Math.hypot(dx, dy);
  return [dx / d, dy / d, d];
}

// Restores segment i (nodes i, i+1) to its rest length.
function satisfy(points: Vec2[], i: number, rest: number, before: Vec2) {
  const a = points[i];
  const b = points[i + 1];
  const [ux, uy, d] = axis(a, b, before);
  const error = d - rest;
  if (i === 0) {
    points[1] = [b[0] - ux * error, b[1] - uy * error];
  } else {
    points[i] = [a[0] + (ux * error) / 2, a[1] + (uy * error) / 2];
    points[i + 1] = [b[0] - (ux * error) / 2, b[1] - (uy * error) / 2];
  }
}

// Places node i+1 `length` from node i, along the segment, and returns how
// far it moved.
function follow(points: Vec2[], i: number, length: number, before: Vec2): Vec2 {
  const a = points[i];
  const b = points[i + 1];
  const [ux, uy] = axis(a, b, before);
  const moved: Vec2 = [a[0] + ux * length, a[1] + uy * length];
  points[i + 1] = moved;
  return [moved[0] - b[0], moved[1] - b[1]];
}

// Rebuilds the chain root to tip from its segments, keeping each segment's
// length and direction, except that a joint bent past the limit (measured
// from the target's bend there) is turned back to the limit. Everything past
// that joint shifts with it, so no length changes. With `root`, the first
// segment is held within the limit of the target's first segment too.
function limitBends(points: Vec2[], target: Vec2[], limit: number, root: boolean) {
  const n = points.length;
  const lengths = new Array<number>(n - 1);
  const headings = new Array<number>(n - 1);
  for (let i = 0; i < n - 1; i++) {
    lengths[i] = distance(points[i], points[i + 1]);
    headings[i] = heading(points[i], points[i + 1]);
  }
  for (let i = root ? 0 : 1; i < n - 1; i++) {
    const drawn = heading(target[i], target[i + 1]);
    const off = i === 0 ? wrap(headings[0] - drawn) : wrap(headings[i] - headings[i - 1] - wrap(drawn - heading(target[i - 1], target[i])));
    if (Math.abs(off) > limit) headings[i] -= off - Math.sign(off) * limit;
    const [x, y] = points[i];
    points[i + 1] = [x + lengths[i] * Math.cos(headings[i]), y + lengths[i] * Math.sin(headings[i])];
  }
}

const copy = (p: Vec2): Vec2 => [p[0], p[1]];
const unit = (a: Vec2, b: Vec2): Vec2 => {
  const d = distance(a, b);
  return d === 0 ? [0, 0] : [(b[0] - a[0]) / d, (b[1] - a[1]) / d];
};
const distance = (a: Vec2, b: Vec2) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const heading = (a: Vec2, b: Vec2) => Math.atan2(b[1] - a[1], b[0] - a[0]);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
