// EXPERIMENT (exp/hero-3d-lift): the strand engine of src/physics/strand.ts,
// step for step, with a third axis. Verlet, distance constraints, dynamic
// follow-the-leader, shape pull, then the bend limit, which in 3D measures
// each joint against the target's bend carried onto the current chain (the
// smallest rotation that takes the target's parent segment onto the chain's).
// Same parameters, so stiffness 0.1 means the same floppiness as in 2D.
import { DEFAULT_PHYSICS, type PhysicsParams } from '../physics/strand.ts';
import type { Vec3 } from './body.ts';

const PULL = 0.5;
const FTL_DAMPING = 0.9;
const ROOT_HELD_FROM = 0.3;

export interface Chain3 {
  kind: 'strand' | 'rigid';
  stiffness: number;
  points: Vec3[]; // camera px; node 0 is the root
  prev: Vec3[];
}

export function createChain3(target: Vec3[], kind: Chain3['kind'], stiffness: number): Chain3 {
  return { kind, stiffness, points: target.map(copy), prev: target.map(copy) };
}

export function stepChain3(chain: Chain3, target: Vec3[], unitPx: number, params: PhysicsParams = DEFAULT_PHYSICS): void {
  const { points, prev } = chain;
  const n = points.length;
  if (chain.kind === 'rigid') {
    for (let i = 0; i < n; i++) {
      prev[i] = points[i];
      points[i] = copy(target[i]);
    }
    return;
  }
  const before = new Array<Vec3>(n - 1);
  for (let i = 0; i < n - 1; i++) before[i] = unit(points[i], points[i + 1]);

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

  // 2. Distance constraints, then dynamic follow-the-leader.
  const rest = new Array<number>(n - 1);
  for (let i = 0; i < n - 1; i++) rest[i] = distance(target[i], target[i + 1]);
  for (let pass = 0; pass < params.passes; pass++) {
    const forward = pass % 2 === 0;
    for (let j = 0; j < n - 1; j++) {
      const i = forward ? j : n - 2 - j;
      satisfy(points, i, rest[i], before[i]);
    }
  }
  const moved: Vec3[] = new Array(n);
  moved[0] = [0, 0, 0];
  for (let i = 0; i < n - 1; i++) moved[i + 1] = follow(points, i, rest[i], before[i]);
  for (let i = 1; i < n - 1; i++) prev[i] = add(prev[i], scale(moved[i + 1], FTL_DAMPING));

  // 3. Shape pull.
  const k = PULL * chain.stiffness * chain.stiffness;
  if (k > 0) for (let i = 1; i < n; i++) points[i] = add(points[i], scale(sub(target[i], points[i]), k));

  // 4. Bend limit.
  if (params.bendLimitDeg !== null) {
    const limit = (params.bendLimitDeg * Math.PI) / 180;
    const root = Math.PI - (Math.PI - limit) * Math.min(1, chain.stiffness / ROOT_HELD_FROM);
    limitBends(points, target, limit, root);
  }
}

function axis(a: Vec3, b: Vec3, before: Vec3): [Vec3, number] {
  const d = sub(b, a);
  const along = dot(d, before);
  if (along < 0 || (d[0] === 0 && d[1] === 0 && d[2] === 0)) return [before, along];
  const len = Math.hypot(d[0], d[1], d[2]);
  return [scale(d, 1 / len), len];
}

function satisfy(points: Vec3[], i: number, rest: number, before: Vec3) {
  const [u, d] = axis(points[i], points[i + 1], before);
  const error = d - rest;
  if (i === 0) {
    points[1] = sub(points[1], scale(u, error));
  } else {
    points[i] = add(points[i], scale(u, error / 2));
    points[i + 1] = sub(points[i + 1], scale(u, error / 2));
  }
}

function follow(points: Vec3[], i: number, length: number, before: Vec3): Vec3 {
  const [u] = axis(points[i], points[i + 1], before);
  const moved = add(points[i], scale(u, length));
  const shift = sub(moved, points[i + 1]);
  points[i + 1] = moved;
  return shift;
}

// Root to tip: each segment may turn at most `limit` from where the target's
// bend would put it, given where its parent actually points now.
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
    if (angle > max) dirs[i] = slerp(expected, dirs[i], max / angle);
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
