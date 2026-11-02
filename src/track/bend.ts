// The torso's bend, from the stand-in's shoulders and hips: roll (the body
// leaning sideways on screen) and pitch (bending forward, toward the camera).
// The whole-person mask can't give either: in a wide crouch its long axis
// follows the spread legs, not the back. So:
//   - roll: the direction of the shoulder line and the hip line, averaged.
//     A line has no head or tail, so it's taken within half a circle and
//     unwrapped frame to frame; that also keeps it steady through a turn,
//     when the shoulders swap sides on screen. Side-on, the shoulders sit on
//     top of each other and the line means nothing, so those frames are
//     dropped and filled.
//   - pitch: how much of the hips-to-shoulders length is left along the
//     body's up direction, against his upright length: cos(pitch). Bent
//     forward 90°, that length is gone; past 90° the shoulders are below the
//     hips and it turns negative. His upright length on each frame is the
//     larger of the spine itself and the shoulder width × his spine to
//     shoulder ratio on the drawing frame: bending forward shortens the spine but not the
//     shoulders, and turning side-on narrows the shoulders but not the spine,
//     so one of the two always holds. No mask size: opening his arms grows the
//     mask's area and would read as bending.
// Frames without a good pose (impact design §2, "Frames without a pose"): a
// stand-in frame is good when both shoulders and both hips are there and,
// given the person mask, the shoulder midpoint is on the mask dilated by
// 0.03 S (the stand-in also finds phantom bodies off him). A missing frame
// holds the last good frame's bend and roll; when good frames return, both
// blend back over BLEND frames (smoothstep). Side-on frames are good, so their
// roll is filled linearly within their run of good frames. Both are smoothed
// with the One Euro filter both ways, like the anchor track.
import { fillLinear, smoothBothWays, wrapHalf, type Mask, type PointSet } from './tracking.ts';

export interface Bend {
  roll: number; // radians, clockwise on screen; 0 = upright
  pitch: number; // radians bent forward toward the camera; 0 = upright, π/2 = back facing up
}

const SHOULDERS = [11, 12]; // places in the stand-in's CORE points
const HIPS = [13, 14];
const SIDE_ON = 0.35; // shoulder width under this share of his upright length: no roll
const NEAR = 15; // frames either side of the drawing frame that set his upright proportions
const SMOOTHING = { minCutoff: 1.2, beta: 0.4 };
const PRESENT = 0.5; // a landmark at this confidence or more is there
const ON_MASK = 0.03; // how far off the mask the shoulder midpoint may be, × the frame's short side
export const BLEND = 4; // frames to blend back over after a gap

const mid = (b: PointSet, pair: number[]): [number, number] => [(b.x[pair[0]] + b.x[pair[1]]) / 2, (b.y[pair[0]] + b.y[pair[1]]) / 2];
const lineAngle = (b: PointSet, pair: number[]) => Math.atan2(b.y[pair[0]] - b.y[pair[1]], b.x[pair[0]] - b.x[pair[1]]);

// What a stand-in frame is checked against: the person mask on that frame
// (null where there's none, so the frame isn't good), over a width × height frame.
export interface PoseGate {
  mask: (frame: number) => Mask | null;
  width: number; // frame px
  height: number;
}

// Which stand-in frames to trust.
export function goodStandIns(bodies: (PointSet | null)[], gate?: PoseGate): boolean[] {
  return bodies.map((b, f) => {
    if (!b) return false;
    const there = [...SHOULDERS, ...HIPS].every((i) => b.confidence[i] >= PRESENT && Number.isFinite(b.x[i]) && Number.isFinite(b.y[i]));
    if (!there || !gate) return there;
    const mask = gate.mask(f);
    if (!mask) return false;
    const [x, y] = mid(b, SHOULDERS);
    return nearMask(mask, gate.width, gate.height, x, y, ON_MASK * Math.min(gate.width, gate.height));
  });
}

// Is a mask pixel (alpha 128 or more) within r frame px of (x, y)?
function nearMask(m: Mask, width: number, height: number, x: number, y: number, r: number): boolean {
  const sx = m.width / width;
  const sy = m.height / height;
  const [cx, cy, rx, ry] = [x * sx, y * sy, r * sx, r * sy]; // mask px
  const row0 = Math.max(0, Math.floor(cy - ry));
  const row1 = Math.min(m.height - 1, Math.floor(cy + ry));
  const col0 = Math.max(0, Math.floor(cx - rx));
  const col1 = Math.min(m.width - 1, Math.floor(cx + rx));
  for (let row = row0; row <= row1; row++) {
    const dy = (row + 0.5 - cy) / ry;
    for (let col = col0; col <= col1; col++) {
      const dx = (col + 0.5 - cx) / rx;
      if (dx * dx + dy * dy <= 1 && m.alpha[row * m.width + col] >= 128) return true;
    }
  }
  return false;
}

// `frame` is the drawing frame: he's taken to stand upright there, facing the
// camera, the way the anchors are re-based on it. `good`: which stand-in
// frames to trust (goodStandIns; give it the person masks to drop phantoms).
export function torsoBend(bodies: (PointSet | null)[], frame: number, fps: number, good = goodStandIns(bodies)): Bend[] | null {
  const measured = measuredBend(bodies, frame, fps, good);
  if (!measured) return null;
  const roll = holdGaps(measured.map((b) => b.roll), good);
  const pitch = holdGaps(measured.map((b) => b.pitch), good);
  return measured.map((_, i) => ({ roll: roll[i], pitch: pitch[i] }));
}

// The bend the good frames measure, before the gap rule. The missing frames
// hold the last good frame's values going into the smoothing, so it doesn't
// pull the far side of a gap in.
export function measuredBend(bodies: (PointSet | null)[], frame: number, fps: number, good = goodStandIns(bodies)): Bend[] | null {
  const kept = bodies.map((b, i) => (good[i] ? b : null));
  const spine = kept.map((b) => {
    if (!b) return null;
    const [sx, sy] = mid(b, SHOULDERS);
    const [hx, hy] = mid(b, HIPS);
    return [sx - hx, sy - hy];
  });
  const width = kept.map((b) => (b ? Math.hypot(b.x[SHOULDERS[0]] - b.x[SHOULDERS[1]], b.y[SHOULDERS[0]] - b.y[SHOULDERS[1]]) : 0));
  // His upright spine : shoulders ratio, the median over the frames around
  // the drawing frame.
  const near = (i: number) => Math.abs(i - frame) <= NEAR;
  const ratios = spine.flatMap((v, i) => (v && width[i] > 0 && near(i) ? [Math.hypot(v[0], v[1]) / width[i]] : []));
  if (ratios.length === 0) return null;
  const ratio = [...ratios].sort((a, b) => a - b)[Math.floor((ratios.length - 1) / 2)];
  const upright = (i: number) => Math.max(Math.hypot(spine[i]![0], spine[i]![1]), ratio * width[i]);

  // Roll: the mean of the two lines' directions, in doubled angles so that
  // directions half a circle apart agree, then unwrapped.
  let last: number | null = null;
  const roll = kept.map((b, i) => {
    if (!b) return null;
    if (width[i] < SIDE_ON * upright(i) / ratio) return null;
    const a = lineAngle(b, SHOULDERS);
    const h = lineAngle(b, HIPS);
    const mean = Math.atan2(Math.sin(2 * a) + Math.sin(2 * h), Math.cos(2 * a) + Math.cos(2 * h)) / 2;
    last = last === null ? wrapHalf(mean) : last + wrapHalf(mean - last);
    return last;
  });
  if (roll.every((r) => r === null)) return null;
  const rolls = smoothBothWays(fillHeld(roll, good), fps, SMOOTHING);

  // Pitch, from cos(pitch) = the spine's length along the rolled up
  // direction / his upright length.
  const cos = spine.map((v, i) => {
    if (!v) return null;
    const up = [Math.sin(rolls[i]), -Math.cos(rolls[i])];
    return Math.max(-1, Math.min(1, (v[0] * up[0] + v[1] * up[1]) / upright(i)));
  });
  const pitch = smoothBothWays(fillHeld(cos.map((c) => (c === null ? null : Math.acos(c))), good), fps, SMOOTHING);
  return rolls.map((r, i) => ({ roll: r, pitch: Math.max(0, pitch[i]) }));
}

// Per frame, how much of its own value shows: 0 on a missing frame, then
// smoothstep back up over the `blend` good frames after a gap (exactly 1 on
// the last of them), 1 elsewhere. Before the first good frame there's
// nothing to blend from.
export function gapWeights(good: boolean[], blend = BLEND): number[] {
  let seen = false; // a good frame so far
  let since = Infinity; // good frames since the last gap
  return good.map((g) => {
    if (!g) {
      if (seen) since = 0;
      return 0;
    }
    seen = true;
    since++;
    const t = Math.min(1, since / blend);
    return t * t * (3 - 2 * t);
  });
}

// The gap rule on one series: a missing frame holds the last good frame's
// value, and after a gap the series blends from that back to its own.
export function holdGaps(values: number[], good: boolean[], blend = BLEND): number[] {
  const first = good.indexOf(true);
  if (first < 0) return [...values];
  const w = gapWeights(good, blend);
  let last = values[first]; // the last good frame's value, as shown
  let from = last; // what the current gap holds
  return values.map((v, i) => {
    if (!good[i]) {
      if (i > 0 && good[i - 1]) from = last;
      return from;
    }
    last = w[i] === 1 ? v : from + (v - from) * w[i];
    return last;
  });
}

// fillLinear within each run of good frames; the missing frames, and a run
// with no value at all, hold the last value before them (the first one, at
// the start). Assumes one is known.
function fillHeld(values: (number | null)[], good: boolean[]): number[] {
  const runs = values.map((): number | null => null);
  for (let i = 0; i < values.length; ) {
    if (!good[i]) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < values.length && good[j]) j++;
    const run = values.slice(i, j);
    if (run.some((v) => v !== null)) fillLinear(run).forEach((v, k) => (runs[i + k] = v));
    i = j;
  }
  let held = runs.find((v) => v !== null)!;
  return runs.map((v) => (v === null ? held : (held = v)));
}
