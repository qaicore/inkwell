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
// Frames without a body are filled linearly, then both are smoothed with the
// One Euro filter both ways, like the anchor track.
import { fillLinear, smoothBothWays, wrapHalf, type PointSet } from './tracking.ts';

export interface Bend {
  roll: number; // radians, clockwise on screen; 0 = upright
  pitch: number; // radians bent forward toward the camera; 0 = upright, π/2 = back facing up
}

const SHOULDERS = [11, 12]; // places in the stand-in's CORE points
const HIPS = [13, 14];
const SIDE_ON = 0.35; // shoulder width under this share of his upright length: no roll
const NEAR = 15; // frames either side of the drawing frame that set his upright proportions
const SMOOTHING = { minCutoff: 1.2, beta: 0.4 };

// `frame` is the drawing frame: he's taken to stand upright there, facing the
// camera, the way the anchors are re-based on it.
export function torsoBend(bodies: (PointSet | null)[], frame: number, fps: number): Bend[] | null {
  const mid = (b: PointSet, pair: number[]) => [(b.x[pair[0]] + b.x[pair[1]]) / 2, (b.y[pair[0]] + b.y[pair[1]]) / 2];
  const lineAngle = (b: PointSet, pair: number[]) => Math.atan2(b.y[pair[0]] - b.y[pair[1]], b.x[pair[0]] - b.x[pair[1]]);
  const spine = bodies.map((b) => {
    if (!b) return null;
    const [sx, sy] = mid(b, SHOULDERS);
    const [hx, hy] = mid(b, HIPS);
    return [sx - hx, sy - hy];
  });
  const width = bodies.map((b) => (b ? Math.hypot(b.x[SHOULDERS[0]] - b.x[SHOULDERS[1]], b.y[SHOULDERS[0]] - b.y[SHOULDERS[1]]) : 0));
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
  const roll = bodies.map((b, i) => {
    if (!b) return null;
    if (width[i] < SIDE_ON * upright(i) / ratio) return null;
    const a = lineAngle(b, SHOULDERS);
    const h = lineAngle(b, HIPS);
    const mean = Math.atan2(Math.sin(2 * a) + Math.sin(2 * h), Math.cos(2 * a) + Math.cos(2 * h)) / 2;
    last = last === null ? wrapHalf(mean) : last + wrapHalf(mean - last);
    return last;
  });
  if (roll.every((r) => r === null)) return null;
  const rolls = smoothBothWays(fillLinear(roll), fps, SMOOTHING);

  // Pitch, from cos(pitch) = the spine's length along the rolled up
  // direction / his upright length.
  const cos = spine.map((v, i) => {
    if (!v) return null;
    const up = [Math.sin(rolls[i]), -Math.cos(rolls[i])];
    return Math.max(-1, Math.min(1, (v[0] * up[0] + v[1] * up[1]) / upright(i)));
  });
  const pitch = smoothBothWays(fillLinear(cos.map((c) => (c === null ? null : Math.acos(c)))), fps, SMOOTHING);
  return rolls.map((r, i) => ({ roll: r, pitch: Math.max(0, pitch[i]) }));
}
