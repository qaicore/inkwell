// EXPERIMENT (exp/hero-3d-lift): a 3D stand-in for the body, the way
// Blender's Grease Pencil puts 2D strokes on 3D objects. One egg-shaped torso
// per frame, fitted from the SAM person mask:
//   - where it is and how big: the tracked anchor pose (same as torso space)
//   - which way it faces (yaw): Qai's turn keys
//   - how far it bends toward the camera (pitch): how squat the mask is
//   - how far it leans on screen (roll): the anchor's own angle
// Camera space: x right, y down (px), z toward the camera (px at the anchor's
// depth). Body space: torso units, origin at the anchor (his lower back on
// the drawing frame), x his left, y down his spine, z out of his chest.
import type { Vec2 } from '../types/effect.ts';
import type { SamMask } from '../sam/cache.ts';
import type { Bend } from '../track/bend.ts';
import type { Pose } from '../track/tracking.ts';
import type { TorsoTransform } from '../track/torso.ts';

export type Vec3 = [number, number, number];

export interface Body3D {
  x: number; // anchor on screen, px
  y: number;
  unit: number; // px per torso height
  yaw: number; // radians; 0 faces the camera, π/2 shows his right side (SPEC §7)
  pitch: number; // radians bent toward the camera at the hips
  roll: number; // radians turned clockwise on screen
}

// The torso as an ellipsoid in body units: hips (y 0.35) to shoulders (y −1),
// half as wide as it is tall, depth 0.6 × width as in SPEC §8.5's ellipse.
export const TORSO = { cy: -0.325, a: 0.33, b: 0.675, c: 0.2 };
// The head, a ball above the shoulders. It only blocks the view: bent over
// toward the camera, his head is what covers his lower back.
export const HEAD = { cy: -1.25, r: 0.2 };
const CAMERA = 10; // camera distance in torso heights: a gentle perspective

// θ in degrees from turn keys [frame, degrees], linear between them. No keys
// is no turn: 0.
export function turnAt(keys: readonly Vec2[], f: number): number {
  if (keys.length === 0) return 0;
  for (let i = 1; i < keys.length; i++) {
    const [f0, a0] = keys[i - 1];
    const [f1, a1] = keys[i];
    if (f <= f1) return a0 + ((a1 - a0) * Math.max(0, f - f0)) / (f1 - f0);
  }
  return keys[keys.length - 1][1];
}

// How tall his upper body stands above the anchor, in torso heights at the
// drawing frame's size × this frame's scale: from the anchor up to the first
// mask row at least a quarter torso wide (so a raised arm or a few hairs don't
// count). Null when the mask is missing or his head is cut off by the top of
// the frame (in the jump, and walking up to the camera), where it can't be read.
export function upperHeight(m: SamMask, pose: Pose, unit0: number): number | null {
  const sx = (m.bounds.right - m.bounds.left) / m.width;
  const sy = (m.bounds.bottom - m.bounds.top) / m.height;
  for (let row = 0; row < m.height; row++) {
    let n = 0;
    for (let col = 0; col < m.width; col++) n += m.raster[row * m.width + col];
    if (n * sx < 0.25 * unit0) continue;
    const y = m.bounds.top + row * sy;
    return y < 2 ? null : (pose.y - y) / (unit0 * pose.scale);
  }
  return null;
}

// The bend toward the camera on every frame, from foreshortening: bent
// forward by β, a body h tall standing looks h·cos β tall, so β = acos(h/h₀),
// with h₀ his median height over the frames he stands still. It's a rough
// read: arms and a widening stance get in, so it's smoothed (±4 frames).
// Unreadable frames count as upright.
export function bendFromHeight(heights: (number | null)[], standing: number): number[] {
  const raw = heights.map((h) => (h === null ? 0 : Math.acos(Math.min(1, Math.max(0, h / standing)))));
  return raw.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - 4); j <= Math.min(raw.length - 1, i + 4); j++, n++) sum += raw[j];
    return sum / n;
  });
}

export function bodyFrom(pose: Pose, unit0: number, yawDeg: number, pitch: number): Body3D {
  return { x: pose.x, y: pose.y, unit: unit0 * pose.scale, yaw: (yawDeg * Math.PI) / 180, pitch, roll: pose.angle };
}

// The body on every frame (impact design §2, "Frames without a pose"): where
// he is and how big from the anchor pose, which the mask gives on every frame;
// the turn from the keys (turn.ts); the bend and roll from the stand-in's
// shoulders and hips (track/bend.ts, which holds them through the frames
// without a good pose and blends them back). The roll is taken from the
// drawing frame's, where the anchor is upright. Without a bend, the anchor's
// own angle and `pitch` (bendFromHeight's, say; upright where it's missing).
export function liftBodies(poses: readonly Pose[], unit0: number, drawn: number, keys: readonly Vec2[], bend: readonly Bend[] | null, pitch: readonly number[] = []): Body3D[] {
  return poses.map((pose, f) => {
    if (!bend) return bodyFrom(pose, unit0, turnAt(keys, f), pitch[f] ?? 0);
    return { ...bodyFrom(pose, unit0, turnAt(keys, f), bend[f].pitch), roll: bend[f].roll - bend[drawn].roll };
  });
}

export function lerpBody(a: Body3D, b: Body3D, w: number): Body3D {
  return {
    x: a.x + (b.x - a.x) * w,
    y: a.y + (b.y - a.y) * w,
    unit: a.unit * Math.pow(b.unit / a.unit, w),
    yaw: a.yaw + (b.yaw - a.yaw) * w, // the keys are unwrapped already
    pitch: a.pitch + (b.pitch - a.pitch) * w,
    roll: a.roll + Math.atan2(Math.sin(b.roll - a.roll), Math.cos(b.roll - a.roll)) * w,
  };
}

// The 2D torso transform the held drawing rides between drawings.
export const flat = (b: Body3D): TorsoTransform => ({ x: b.x, y: b.y, angle: b.roll, unit: b.unit });

// Body units → camera px: bend at the hips, turn about the vertical, lean on screen.
export function toCamera(b: Body3D, q: Vec3): Vec3 {
  const [x, y, z] = rotate(b, q);
  return [b.x + x * b.unit, b.y + y * b.unit, z * b.unit];
}

// The exact inverse of toCamera.
export function toBody(b: Body3D, p: Vec3): Vec3 {
  return unrotate(b, [(p[0] - b.x) / b.unit, (p[1] - b.y) / b.unit, p[2] / b.unit]);
}

// Camera px → screen px, and how much nearer (> 1) or farther the point is
// than the anchor, for line width.
export function project(b: Body3D, p: Vec3): { xy: Vec2; near: number } {
  const g = CAMERA / (CAMERA - p[2] / b.unit);
  return { xy: [b.x + (p[0] - b.x) * g, b.y + (p[1] - b.y) * g], near: g };
}

// Where a screen point at depth z (camera px) sits in camera space: the
// inverse of project for that depth.
export function unproject(b: Body3D, xy: Vec2, z: number): Vec3 {
  const g = CAMERA / (CAMERA - z / b.unit);
  return [b.x + (xy[0] - b.x) / g, b.y + (xy[1] - b.y) / g, z];
}

// Depth of the torso's back surface at body (x, y), units (negative: behind
// the spine). Off the torso's outline it's the edge, depth 0.
export function backDepth(x: number, y: number): number {
  const r = 1 - (x / TORSO.a) ** 2 - ((y - TORSO.cy) / TORSO.b) ** 2;
  return -TORSO.c * Math.sqrt(Math.max(0, r));
}

// Does a point (camera px) sit in front of his body as the camera sees it?
// The view ray through it is cast at the torso and the head (orthographic,
// which is close enough at this camera distance). It's in front if every
// part the ray hits is behind it. If the ray misses both, the point could
// still cover an arm, so it's in front if it's nearer than his spine.
export function inFront(b: Body3D, p: Vec3): boolean {
  const q = toBody(b, p);
  const d = unrotate(b, [0, 0, 1]);
  const hits = [
    nearSurface(q, d, TORSO.a, TORSO.b, TORSO.c, TORSO.cy),
    nearSurface(q, d, HEAD.r, HEAD.r, HEAD.r, HEAD.cy),
  ].filter((t): t is number => t !== null);
  if (hits.length === 0) return p[2] > 0;
  return hits.every((t) => t <= 0);
}

// Along ray q + t·d, the t where it leaves an ellipsoid (centre (0, cy, 0),
// semi-axes a, b, c) toward the camera, or null if it misses.
function nearSurface(q: Vec3, d: Vec3, a: number, b: number, c: number, cy: number): number | null {
  const o: Vec3 = [q[0] / a, (q[1] - cy) / b, q[2] / c];
  const v: Vec3 = [d[0] / a, d[1] / b, d[2] / c];
  const A = dot(v, v);
  const B = 2 * dot(o, v);
  const C = dot(o, o) - 1;
  const disc = B * B - 4 * A * C;
  return disc < 0 ? null : (-B + Math.sqrt(disc)) / (2 * A);
}

function rotate(b: Body3D, [x, y, z]: Vec3): Vec3 {
  // Bend: the top of the spine (−y) tips toward his chest (+z).
  const cp = Math.cos(b.pitch);
  const sp = Math.sin(b.pitch);
  [y, z] = [cp * y + sp * z, -sp * y + cp * z];
  // Turn: at yaw π/2 his right side (−x) faces the camera.
  const cy = Math.cos(b.yaw);
  const sy = Math.sin(b.yaw);
  [x, z] = [cy * x + sy * z, -sy * x + cy * z];
  // Lean on screen, clockwise.
  const cr = Math.cos(b.roll);
  const sr = Math.sin(b.roll);
  return [cr * x - sr * y, sr * x + cr * y, z];
}

function unrotate(b: Body3D, [x, y, z]: Vec3): Vec3 {
  const cr = Math.cos(b.roll);
  const sr = Math.sin(b.roll);
  [x, y] = [cr * x + sr * y, -sr * x + cr * y];
  const cy = Math.cos(b.yaw);
  const sy = Math.sin(b.yaw);
  [x, z] = [cy * x - sy * z, sy * x + cy * z];
  const cp = Math.cos(b.pitch);
  const sp = Math.sin(b.pitch);
  [y, z] = [cp * y - sp * z, sp * y + cp * z];
  return [x, y, z];
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
