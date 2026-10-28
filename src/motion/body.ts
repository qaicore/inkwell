// How a stroke's target shape turns with the body in depth, before the
// physics sees it, so the chain lags and swings through the change instead
// of snapping (SPEC §8.5 single-view fallback, plus the bend). Torso space,
// origin at the stroke's root.
//   - Bend: he bends forward by `pitch` about a horizontal axis through the
//     root. A front-view drawing has no depth, so each point is given one:
//     DEPTH × its distance along the stroke from the root, going away from
//     the body (a tendril drawn on his back grows backward as it goes out).
//     Rotating that about the axis lifts the far parts: bent 90°, what
//     stuck out behind him now sticks up.
//   - Turn (§8.5 fallback): the root sweeps round an ellipse of half-width
//     HALF_WIDTH (half-depth 0.6 × that) from its body angle, and the shape is
//     foreshortened and mirrored about the root, x × s·max(|cos θ|, 0.25).
//   - Layer: behind the person while the stroke's middle is farther from the
//     camera than his body, in front once the bend or the turn brings it
//     nearer. It's read when a drawing is captured, so it swaps on a drawing.
import type { Vec2 } from '../types/effect.ts';

export const DEPTH = 0.7; // depth per unit of length along a stroke
export const HALF_WIDTH = 0.3; // torso half-width, torso heights

export interface BodyAngle {
  theta: number; // facing, radians: 0 = toward the camera, π = his back
  pitch: number; // radians bent forward toward the camera
}

// `bodyAngle` is the root's place round the torso, radians (π = center of
// the back), as in §8.5.
export function warpView(points: Vec2[], bodyAngle: number, at: BodyAngle): { points: Vec2[]; layer: 'behind' | 'front' } {
  const cp = Math.cos(at.pitch);
  const sp = Math.sin(at.pitch);
  const ct = Math.cos(at.theta);
  const squash = (ct >= 0 ? 1 : -1) * Math.max(Math.abs(ct), 0.25);
  // The root's sweep, relative to where it was drawn (θ = 0).
  const sweep = -HALF_WIDTH * Math.sin(bodyAngle - at.theta) + HALF_WIDTH * Math.sin(bodyAngle);
  const rootDepth = 0.6 * HALF_WIDTH * Math.cos(bodyAngle - at.theta); // > 0 toward the camera
  let along = 0;
  let depth = 0; // the stroke's mean distance behind his body, after the bend
  const out = points.map((p, i): Vec2 => {
    if (i > 0) along += Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]);
    const z = DEPTH * along; // behind the body, in his own frame
    const y = p[1] * cp - z * sp;
    depth += p[1] * sp + z * cp;
    return [p[0] * squash + sweep, y];
  });
  depth /= points.length;
  // Toward the camera: the root's own depth, minus the stroke's depth behind
  // the back turned by the facing (behind his back is toward the camera once
  // he faces away).
  const toward = rootDepth - depth * ct;
  return { points: out, layer: toward > 0 ? 'front' : 'behind' };
}
