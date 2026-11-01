// The turn (impact design §1, "Turn"; SPEC §8.5): θ keys [frame, degrees]
// for body.ts's turnAt. They come from the first of these there is:
//   1. his nudged keys (More → Turn keys);
//   2. his one tap on the frame f_b where his back faces the camera: keys a
//      quarter turn apart either side of it, out to where the turn starts and
//      ends, (f_b + nΔ, (180 + 90n)·dir) for n = −2..2;
//   3. the turn read from the stand-in pose, where it reads as one;
//   4. none: θ = 0 on every frame.
//
// Reading the pose (3). Facing the camera, his left shoulder and hip are to
// the right of his right ones, across his spine; with his back to the camera
// both pairs are swapped. Bent forward, his spine on screen is too short to
// say what's across it, so a frame reads only when its spine is at least
// UPRIGHT of the longest within NEAR frames. A run of at least BACK_RUN
// frames with both swapped is his back. He is side-on where the pairs cross
// over (the shoulder width collapses), interpolated between the last frame
// one way and the first the other: θ 90° going in, 270° coming out. His nose
// says which way he spins: right of his spine going in means his right side
// faces the camera, θ +90° (body.ts). Coming out it must point the other
// way, or he turned back, which isn't read. His back is square to the camera
// where his nose crosses his spine inside the run (the stand-in puts it
// mid-head there), else halfway. The tap's model is fitted to those three
// times: f_b their mean, Δ half the time between the crossings. A spin it
// doesn't fit (Δ out of range, or a time more than Δ/2 off) isn't read
// either. The face landmarks' visibility only gates the nose (under PRESENT
// it isn't read): on its own it can't tell his back from his front, since on
// the hero it stays at 0.99 or more right through his back (f57–69).
import type { Turn, Vec2 } from '../types/effect.ts';
import { frameAt } from '../motion/timing.ts';
import { goodStandIns } from '../track/bend.ts';
import type { PointSet } from '../track/tracking.ts';
import { turnAt } from './body.ts';

export const TURN_STEP = 6; // Δ, frames at 30 fps between the tap's keys
const BACK_RUN = 3; // good frames with his back to the camera before it counts
const BRACKET = 3; // a crossing must lie between good frames at most this far apart
const NOSE = 0.15; // how far off his spine his nose must be to say which way he turns, × the spine
const NOSE_NEAR = 3; // frames either side of a crossing that read his nose
const STEP_RANGE = [3, 12]; // Δ the pose may give, frames at 30 fps
const PRESENT = 0.5; // a landmark at this confidence or more is there
const UPRIGHT = 0.6; // a frame's spine against the longest near it, for the frame to read
const NEAR = 15; // frames either side that set that longest spine

const NOSE_AT = 0; // places in the stand-in's CORE points
const SHOULDERS = [11, 12]; // his left, then his right
const HIPS = [13, 14];

export type TurnSource = 'keys' | 'tap' | 'pose' | 'none';

// The keys from his turn: none without one, his nudged keys when he has
// any, else the tap's five.
export function turnKeysFromTap(turn: Turn | null | undefined, fps = 30): Vec2[] {
  if (!turn) return [];
  if (turn.keys && turn.keys.length > 0) return turn.keys.map(([s, deg]): Vec2 => [frameAt(s, fps), deg]);
  const fb = frameAt(turn.at, fps);
  const step = Math.round((TURN_STEP * fps) / 30);
  return [-2, -1, 0, 1, 2].map((n): Vec2 => [fb + n * step, (180 + 90 * n) * turn.dir || 0]);
}

// The keys a clip uses, and where they came from: his turn when he gave one,
// else the pose's (`bodies`: the stand-in, null without one; `good`: the
// stand-in frames to trust, goodStandIns with the person masks to drop the
// phantoms), else none.
export function turnKeys(turn: Turn | null | undefined, bodies: (PointSet | null)[] | null, fps = 30, good?: boolean[]): { keys: Vec2[]; from: TurnSource } {
  if (turn) return { keys: turnKeysFromTap(turn, fps), from: turn.keys && turn.keys.length > 0 ? 'keys' : 'tap' };
  const keys = bodies ? turnFromPose(bodies, good, fps) : [];
  return { keys, from: keys.length > 0 ? 'pose' : 'none' };
}

// The largest difference in θ between two sets of keys on frames from..to, degrees.
export function turnError(a: readonly Vec2[], b: readonly Vec2[], from: number, to: number): number {
  let worst = 0;
  for (let f = from; f <= to; f++) worst = Math.max(worst, Math.abs(turnAt(a, f) - turnAt(b, f)));
  return worst;
}

// A turn read by itself, checked against keys known to be right (the hero
// render's hand keys): it's used while it stays within `maxDeg` of them on
// frames from..to, else they are. `error` is its largest difference there.
export function checkedTurn(read: readonly Vec2[], known: readonly Vec2[], from: number, to: number, maxDeg = 45): { keys: Vec2[]; used: 'read' | 'known'; error: number } {
  const error = turnError(read, known, from, to);
  return error <= maxDeg ? { keys: [...read], used: 'read', error } : { keys: [...known], used: 'known', error };
}

interface Reading {
  shoulders: number; // his left shoulder's lead on his right across his spine, × the spine: > 0 facing the camera
  hips: number;
  nose: number | null; // the nose's offset across his spine, × the spine
}

// The turn read from the stand-in (`good`: the frames to trust); [] where it doesn't read as one.
export function turnFromPose(bodies: (PointSet | null)[], good = goodStandIns(bodies), fps = 30): Vec2[] {
  const spine = bodies.map((b, f) => (b && good[f] ? Math.hypot(...sub(mid(b, SHOULDERS), mid(b, HIPS))) : 0));
  const longest = (f: number) => Math.max(...spine.slice(Math.max(0, f - NEAR), f + NEAR + 1));
  const read = bodies.map((b, f) => (b && good[f] && spine[f] > 0 && spine[f] >= UPRIGHT * longest(f) ? reading(b) : null));
  // +1 facing the camera, −1 his back, 0 the pairs disagree; null unread.
  const way = read.map((r) => (r === null ? null : Math.sign(r.shoulders) === Math.sign(r.hips) ? Math.sign(r.shoulders) : 0));
  const [minStep, maxStep] = STEP_RANGE.map((s) => (s * fps) / 30);
  const keys: Vec2[] = [];
  let base = 0;
  for (let f = 0; f < way.length; ) {
    if (way[f] !== -1) {
      f++;
      continue;
    }
    // His back: from f to the last −1 before he faces the camera again.
    let end = f;
    let count = 0;
    for (let g = f; g < way.length && way[g] !== 1; g++) {
      if (way[g] === -1) {
        end = g;
        count++;
      }
    }
    if (count < BACK_RUN) {
      f = end + 1;
      continue;
    }
    const before = facingNear(way, f, -1);
    const after = facingNear(way, end, 1);
    if (before === null || after === null) return [];
    const t90 = crossing(read[before]!, read[f]!, before, f);
    const t270 = crossing(read[end]!, read[after]!, end, after);
    const dir = noseSide(read, t90);
    if (dir === 0 || noseSide(read, t270) !== -dir) return [];
    const t180 = noseCrossing(read, f, end, dir) ?? (t90 + t270) / 2;
    const fb = (t90 + t180 + t270) / 3;
    const step = (t270 - t90) / 2;
    const off = Math.max(Math.abs(t90 - (fb - step)), Math.abs(t180 - fb), Math.abs(t270 - (fb + step)));
    if (step < minStep || step > maxStep || off > step / 2) return [];
    if (keys.length > 0 && fb - 2 * step < keys[keys.length - 1][0]) return [];
    for (let n = -2; n <= 2; n++) keys.push([fb + n * step, base + (180 + 90 * n) * dir]);
    base += 360 * dir;
    f = after;
  }
  return keys;
}

function reading(b: PointSet): Reading | null {
  const [sx, sy] = mid(b, SHOULDERS);
  const [hx, hy] = mid(b, HIPS);
  const len = Math.hypot(sx - hx, sy - hy);
  if (!(len > 0)) return null;
  const across = [-(sy - hy) / len, (sx - hx) / len]; // his spine turned a quarter clockwise: his left, facing the camera
  const lead = (x: number, y: number) => (x * across[0] + y * across[1]) / len;
  const pair = (p: number[]) => lead(b.x[p[0]] - b.x[p[1]], b.y[p[0]] - b.y[p[1]]);
  const nose = b.confidence[NOSE_AT] >= PRESENT ? lead(b.x[NOSE_AT] - sx, b.y[NOSE_AT] - sy) : null;
  return { shoulders: pair(SHOULDERS), hips: pair(HIPS), nose };
}

const mid = (b: PointSet, pair: number[]): [number, number] => [(b.x[pair[0]] + b.x[pair[1]]) / 2, (b.y[pair[0]] + b.y[pair[1]]) / 2];
const sub = (a: [number, number], b: [number, number]): [number, number] => [a[0] - b[0], a[1] - b[1]];

// The nearest frame facing the camera before (side −1) or after (+1) frame
// f, if it's within BRACKET.
function facingNear(way: (number | null)[], f: number, side: -1 | 1): number | null {
  for (let g = f + side; Math.abs(g - f) <= BRACKET && g >= 0 && g < way.length; g += side) if (way[g] === 1) return g;
  return null;
}

// Where both pairs cross over between frames a and b, averaged.
function crossing(ra: Reading, rb: Reading, a: number, b: number): number {
  const at = (u: number, v: number) => a + ((b - a) * u) / (u - v);
  return (at(ra.shoulders, rb.shoulders) + at(ra.hips, rb.hips)) / 2;
}

// Which side of his spine his nose is on around frame t: ±1, or 0 when it
// isn't clearly off it.
function noseSide(read: (Reading | null)[], t: number): number {
  let sum = 0;
  let n = 0;
  for (let f = Math.max(0, Math.ceil(t - NOSE_NEAR)); f <= Math.min(read.length - 1, Math.floor(t + NOSE_NEAR)); f++) {
    const nose = read[f]?.nose;
    if (nose === null || nose === undefined) continue;
    sum += nose;
    n++;
  }
  if (n === 0 || Math.abs(sum / n) < NOSE) return 0;
  return Math.sign(sum);
}

// Where his nose first crosses his spine within frames from..to, from side `dir`.
function noseCrossing(read: (Reading | null)[], from: number, to: number, dir: number): number | null {
  let last: number | null = null;
  for (let f = from; f <= to; f++) {
    const nose = read[f]?.nose;
    if (nose === null || nose === undefined) continue;
    if (last !== null && f - last <= BRACKET) {
      const u = read[last]!.nose! * dir;
      const v = nose * dir;
      if (u > 0 && v <= 0) return last + ((f - last) * u) / (u - v);
    }
    last = f;
  }
  return null;
}
