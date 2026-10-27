// Torso space (SPEC §8.1): where strokes are stored, so they ride the body.
// Origin at the anchor, x toward screen right when he's upright, y down, and
// one unit = one torso height. A TorsoTransform says where that space sits on
// one video frame.
import type { Vec2 } from '../types/effect.ts';
import type { Mask, Pose } from './tracking.ts';

export interface TorsoTransform {
  x: number; // origin, px
  y: number;
  angle: number; // radians the space is turned, clockwise on screen; 0 = upright
  unit: number; // px per torso height
}

export function toPixels(t: TorsoTransform, p: Vec2): Vec2 {
  const c = Math.cos(t.angle);
  const s = Math.sin(t.angle);
  return [t.x + t.unit * (c * p[0] - s * p[1]), t.y + t.unit * (s * p[0] + c * p[1])];
}

// The exact inverse of toPixels.
export function toTorso(t: TorsoTransform, p: Vec2): Vec2 {
  const c = Math.cos(t.angle);
  const s = Math.sin(t.angle);
  const dx = (p[0] - t.x) / t.unit;
  const dy = (p[1] - t.y) / t.unit;
  return [c * dx + s * dy, -s * dx + c * dy];
}

// A px offset (no origin) turned into torso units.
export function offsetToTorso(t: TorsoTransform, d: Vec2): Vec2 {
  const c = Math.cos(t.angle);
  const s = Math.sin(t.angle);
  return [(c * d[0] + s * d[1]) / t.unit, (-s * d[0] + c * d[1]) / t.unit];
}

// Between two frames' transforms, `w` of the way from a to b: what the
// physics' fixed steps see between video frames. The angle takes the short
// way round, and the unit is interpolated in log space, so growing and
// shrinking are symmetric.
export function lerpTransform(a: TorsoTransform, b: TorsoTransform, w: number): TorsoTransform {
  const turn = Math.atan2(Math.sin(b.angle - a.angle), Math.cos(b.angle - a.angle));
  return {
    x: a.x + (b.x - a.x) * w,
    y: a.y + (b.y - a.y) * w,
    angle: a.angle + turn * w,
    unit: a.unit * Math.pow(b.unit / a.unit, w),
  };
}

const TORSO_SHARE = 0.35; // torso height as a share of the person's height (SPEC §8.1)

// The torso height on every frame: h = k·√area, with k chosen once for the
// clip so that h is 0.35 × the median bounding-box height of the person mask.
// Null on frames without a person.
export function torsoHeights(masks: (Mask | null)[], width: number, height: number): (number | null)[] {
  const stats = masks.map((mask) => (mask ? maskStats(mask, width, height) : null));
  const found = stats.filter((s): s is { root: number; boxHeight: number } => s !== null);
  if (found.length === 0) return stats.map(() => null);
  const k = (TORSO_SHARE * median(found.map((s) => s.boxHeight))) / median(found.map((s) => s.root));
  return stats.map((s) => (s ? k * s.root : null));
}

// A tracked stroke's transform on one frame. `pose` is the tracker's pose of
// the stroke's root (smoothed, relative to the frame it was drawn on) and
// `unit` the torso height on that drawing frame.
export function anchorTransform(pose: Pose, unit: number): TorsoTransform {
  return { x: pose.x, y: pose.y, angle: pose.angle, unit: unit * pose.scale };
}

// √(mask area) and the height of the mask's bounding box, in clip pixels.
function maskStats(mask: Mask, width: number, height: number) {
  let total = 0;
  let top = -1;
  let bottom = -1;
  for (let row = 0, i = 0; row < mask.height; row++) {
    let any = false;
    for (let col = 0; col < mask.width; col++, i++) {
      if (mask.alpha[i] === 0) continue;
      total += mask.alpha[i];
      any = true;
    }
    if (any) {
      if (top < 0) top = row;
      bottom = row;
    }
  }
  if (top < 0) return null;
  const sx = width / mask.width;
  const sy = height / mask.height;
  return { root: Math.sqrt((total / 255) * sx * sy), boxHeight: (bottom - top + 1) * sy };
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
