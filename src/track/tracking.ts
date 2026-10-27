// Tracking answers one question for every stroke: on each frame, where did
// its root go, and how much did the stroke turn and grow? What that's
// measured from can change (a stand-in today, SAM 3.1's masks next) without
// the drawing, the preview or the export noticing.

export type Vec = [x: number, y: number];

// Where a stroke sits on one frame, relative to how it was drawn: its root
// moved to (x, y), and the stroke turned by `angle` radians and was scaled
// by `scale`. On the frame it was drawn on, that's (root, 0, 1).
export type Pose = { x: number; y: number; angle: number; scale: number };

// A soft mask of the person on one frame, at the mask's own resolution:
// 255 is person, 0 is background.
export type Mask = { width: number; height: number; alpha: Uint8ClampedArray };

// The same few points found on every frame (body landmarks, say), in clip
// pixels, each with how sure the tracker is of it, from 0 to 1.
export type PointSet = { x: Float32Array; y: Float32Array; confidence: Float32Array };

export type Tracking = {
  label: string;
  masks: (Mask | null)[]; // the person on each frame, for strokes that go behind
  // Raw poses for a root drawn on `frame`, one per frame; null where it's lost.
  follow(root: Vec, frame: number): (Pose | null)[];
};

// The pose of a stroke drawn at `root` on `frame`, for every frame: gaps
// filled, jitter smoothed, and exactly where it was drawn on its own frame.
// Null if the tracking never finds it.
export function trackStroke(tracking: Tracking, root: Vec, frame: number, fps: number): Pose[] | null {
  const filled = fillGaps(tracking.follow(root, frame));
  if (!filled) return null;
  return relativeTo(smooth(filled, fps), root, frame);
}

// Where the drawn point (x, y) ends up under `pose`.
export function applyPose(pose: Pose, root: Vec, x: number, y: number): Vec {
  const [dx, dy] = rotate(x - root[0], y - root[1], pose.angle, pose.scale);
  return [pose.x + dx, pose.y + dy];
}

// ---- Following a mask ------------------------------------------------------

const MIN_AREA = 0.002; // share of the frame a mask needs to count as found
const MIN_STRETCH = 0.15; // how elongated a mask must be to have a direction

// Follows a root with masks alone, which is what SAM 3.1 gives: each mask's
// centre, the direction it's stretched along, and its size. The root keeps
// its place relative to those.
export function followMask(
  masks: (Mask | null)[],
  root: Vec,
  frame: number,
  width: number,
  height: number,
): (Pose | null)[] {
  const shapes = masks.map((mask) => (mask ? shapeOf(mask, width, height) : null));
  const start = shapes[frame];
  const poses: (Pose | null)[] = shapes.map(() => null);
  if (!start) return poses;
  // A long axis has no head or tail, so a turn is only known to within half
  // a circle. Walk out from the drawing frame both ways and take, each frame,
  // the turn nearest the last one, so tipping past 90 degrees doesn't flip
  // the stroke to the other end of the body. A roundish blob has no axis at
  // all; keep the last turn.
  for (const step of [1, -1]) {
    let turn = 0;
    for (let i = frame; i >= 0 && i < shapes.length; i += step) {
      const shape = shapes[i];
      if (!shape) continue;
      if (shape.stretch > MIN_STRETCH && start.stretch > MIN_STRETCH) turn += wrapHalf(shape.axis - start.axis - turn);
      const scale = shape.size / start.size;
      const [dx, dy] = rotate(root[0] - start.x, root[1] - start.y, turn, scale);
      poses[i] = { x: shape.x + dx, y: shape.y + dy, angle: turn, scale };
    }
  }
  return poses;
}

// Whether a mask shows anyone: at least MIN_AREA of the frame, by the same
// measure shapeOf uses.
export function maskHasPerson(mask: Mask) {
  let covered = 0;
  for (let i = 0; i < mask.alpha.length; i++) covered += mask.alpha[i];
  return covered >= 255 * mask.alpha.length * MIN_AREA;
}

// The person mask for a frame or, if the tracker missed that frame, the one
// from the nearest frame it didn't miss, up to `reach` frames away. Without
// it, a stroke set behind the person flashes in front of them on a miss.
export function maskNear(masks: (Mask | null)[], frame: number, reach = 15): Mask | null {
  for (let d = 0; d <= reach; d++) {
    const mask = masks[frame - d] ?? masks[frame + d];
    if (mask) return mask;
  }
  return null;
}

type Shape = { x: number; y: number; axis: number; stretch: number; size: number };

// A mask's centre, long axis, elongation (0 round, 1 a line) and size (the
// side of a square of the same area), in clip pixels.
function shapeOf(mask: Mask, width: number, height: number): Shape | null {
  const sx = width / mask.width;
  const sy = height / mask.height;
  let total = 0;
  let cx = 0;
  let cy = 0;
  for (let row = 0, i = 0; row < mask.height; row++) {
    for (let col = 0; col < mask.width; col++, i++) {
      const w = mask.alpha[i];
      if (w === 0) continue;
      total += w;
      cx += w * (col + 0.5) * sx;
      cy += w * (row + 0.5) * sy;
    }
  }
  if (total < 255 * mask.width * mask.height * MIN_AREA) return null;
  cx /= total;
  cy /= total;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (let row = 0, i = 0; row < mask.height; row++) {
    for (let col = 0; col < mask.width; col++, i++) {
      const w = mask.alpha[i];
      if (w === 0) continue;
      const dx = (col + 0.5) * sx - cx;
      const dy = (row + 0.5) * sy - cy;
      xx += w * dx * dx;
      yy += w * dy * dy;
      xy += w * dx * dy;
    }
  }
  return {
    x: cx,
    y: cy,
    axis: 0.5 * Math.atan2(2 * xy, xx - yy),
    stretch: Math.hypot(xx - yy, 2 * xy) / (xx + yy),
    size: Math.sqrt((total / 255) * sx * sy),
  };
}

// ---- Following points --------------------------------------------------------

// Follows a root with tracked points (body landmarks). Points near the root
// count most: `reach` is the distance, in clip pixels, at which a point's say
// has dropped to about 60%. The turn and shift that best carry those points
// from the drawing frame to each frame carry the root too. `sizeOf` measures
// the body on a frame, for scale; when it can't, the points' spread is used.
export function followPoints(
  sets: (PointSet | null)[],
  root: Vec,
  frame: number,
  reach: number,
  sizeOf: (set: PointSet) => number | null,
): (Pose | null)[] {
  const start = sets[frame];
  if (!start) return sets.map(() => null);
  const near = start.x.map((x, i) => {
    const d2 = (x - root[0]) ** 2 + (start.y[i] - root[1]) ** 2;
    return start.confidence[i] * Math.exp(-d2 / (2 * reach * reach));
  });
  const nearTotal = near.reduce((a, b) => a + b, 0);
  if (nearTotal < 1e-3) return sets.map(() => null); // drawn away from the body
  // Scale comes from one measure for the whole track, so it can't flicker
  // between two. Body size where it's known, filled in between where it
  // isn't; the points' spread only if the body can't be measured at all.
  const startSize = sizeOf(start);
  const scales = startSize
    ? fillLinear(sets.map((set) => (set ? sizeOf(set) : null)).map((size) => (size ? size / startSize : null)))
    : null;

  return sets.map((set, i) => {
    if (!set) return null;
    const weights = near.map((w, i) => w * set.confidence[i]);
    const total = weights.reduce((a, b) => a + b, 0);
    if (total < 0.25 * nearTotal) return null; // most of the nearby points are hidden

    // Weighted centres of the points on both frames.
    let ax = 0;
    let ay = 0;
    let bx = 0;
    let by = 0;
    weights.forEach((w, i) => {
      ax += w * start.x[i];
      ay += w * start.y[i];
      bx += w * set.x[i];
      by += w * set.y[i];
    });
    ax /= total;
    ay /= total;
    bx /= total;
    by /= total;

    // The rotation that best lines the two up (2D Procrustes).
    let dot = 0;
    let cross = 0;
    let spread = 0;
    weights.forEach((w, i) => {
      const px = start.x[i] - ax;
      const py = start.y[i] - ay;
      const qx = set.x[i] - bx;
      const qy = set.y[i] - by;
      dot += w * (px * qx + py * qy);
      cross += w * (px * qy - py * qx);
      spread += w * (px * px + py * py);
    });
    const turn = Math.atan2(cross, dot);
    const scale = scales ? scales[i] : spread > 0 ? Math.hypot(dot, cross) / spread : 1;
    const [dx, dy] = rotate(root[0] - ax, root[1] - ay, turn, scale);
    return { x: bx + dx, y: by + dy, angle: turn, scale };
  });
}

// ---- Cleaning up a track -------------------------------------------------------

// Holds the first and last known poses out to the ends and joins gaps in
// between with straight lines. Angles are unwound first, so a turn past half
// a circle doesn't spin back the short way.
function fillGaps(raw: (Pose | null)[]): Pose[] | null {
  const known: number[] = [];
  const poses: Pose[] = [];
  raw.forEach((pose, i) => {
    if (!pose) return;
    const previous = poses[poses.length - 1];
    const angle = previous ? previous.angle + wrap(pose.angle - previous.angle) : pose.angle;
    known.push(i);
    poses.push({ ...pose, angle });
  });
  if (known.length === 0) return null;

  const out: Pose[] = [];
  let k = 0; // poses[k] is the last known pose at or before i
  for (let i = 0; i < raw.length; i++) {
    while (k + 1 < known.length && known[k + 1] <= i) k++;
    if (i <= known[0]) out.push(poses[0]);
    else if (k === known.length - 1) out.push(poses[k]);
    else {
      const t = (i - known[k]) / (known[k + 1] - known[k]);
      const a = poses[k];
      const b = poses[k + 1];
      out.push({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        angle: a.angle + (b.angle - a.angle) * t,
        scale: a.scale * (b.scale / a.scale) ** t,
      });
    }
  }
  return out;
}

// Fills the gaps in a series: straight lines between known values, the
// first and last known values held out to the ends. Assumes one is known.
function fillLinear(values: (number | null)[]): number[] {
  const known = values.flatMap((v, i) => (v === null ? [] : [i]));
  const out: number[] = [];
  let k = 0; // known[k] is the last known index at or before i
  for (let i = 0; i < values.length; i++) {
    while (k + 1 < known.length && known[k + 1] <= i) k++;
    const a = known[k];
    const b = known[k + 1];
    if (i <= a || b === undefined) out.push(values[a]!);
    else out.push(values[a]! + ((values[b]! - values[a]!) * (i - a)) / (b - a));
  }
  return out;
}

// One Euro filter settings for each part of a pose: below `minCutoff` Hz the
// jitter is smoothed away; `beta` lets fast moves through without lag.
const SMOOTHING = {
  position: { minCutoff: 1.0, beta: 0.007 }, // pixels
  angle: { minCutoff: 1.0, beta: 0.3 }, // radians
  scale: { minCutoff: 0.6, beta: 0.3 }, // log of the scale
};
const PAD = 30; // frames mirrored onto each end, so the filter doesn't drag there

// The whole clip is known up front, so filter forwards and backwards and
// average the two: the lag of one cancels the lead of the other.
function smooth(poses: Pose[], fps: number): Pose[] {
  const dt = 1 / fps;
  const n = poses.length;
  const pad = Math.min(PAD, n - 1);
  const both = (values: number[], s: { minCutoff: number; beta: number }) => {
    const padded = mirrorEnds(values, pad);
    const forward = oneEuro(padded, dt, s.minCutoff, s.beta);
    const backward = oneEuro([...padded].reverse(), dt, s.minCutoff, s.beta).reverse();
    return values.map((_, i) => (forward[pad + i] + backward[pad + i]) / 2);
  };
  const x = both(poses.map((p) => p.x), SMOOTHING.position);
  const y = both(poses.map((p) => p.y), SMOOTHING.position);
  const angle = both(poses.map((p) => p.angle), SMOOTHING.angle);
  const scale = both(poses.map((p) => Math.log(p.scale)), SMOOTHING.scale);
  return poses.map((_, i) => ({ x: x[i], y: y[i], angle: angle[i], scale: Math.exp(scale[i]) }));
}

// Extends a series past both ends by reflecting it through its end values,
// so a steady drift carries on straight instead of stopping dead.
function mirrorEnds(values: number[], pad: number) {
  const n = values.length;
  const before = Array.from({ length: pad }, (_, k) => 2 * values[0] - values[pad - k]);
  const after = Array.from({ length: pad }, (_, k) => 2 * values[n - 1] - values[n - 2 - k]);
  return [...before, ...values, ...after];
}

// The One Euro filter (Casiez et al. 2012): a low-pass filter whose cutoff
// rises with speed, so it's smooth when still and quick when moving.
function oneEuro(values: number[], dt: number, minCutoff: number, beta: number, derivativeCutoff = 1) {
  const out = [values[0]];
  let x = values[0];
  let speed = 0;
  for (let i = 1; i < values.length; i++) {
    speed += smoothingFactor(derivativeCutoff, dt) * ((values[i] - x) / dt - speed);
    x += smoothingFactor(minCutoff + beta * Math.abs(speed), dt) * (values[i] - x);
    out.push(x);
  }
  return out;
}

function smoothingFactor(cutoff: number, dt: number) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

// Re-bases a track on the drawing frame, so the stroke sits exactly where it
// was drawn there and every other frame moves it by the change since then.
function relativeTo(poses: Pose[], root: Vec, frame: number): Pose[] {
  const start = poses[frame];
  return poses.map((pose) => {
    const angle = pose.angle - start.angle;
    const scale = pose.scale / start.scale;
    const [dx, dy] = rotate(root[0] - start.x, root[1] - start.y, angle, scale);
    return { x: pose.x + dx, y: pose.y + dy, angle, scale };
  });
}

// ---- Small helpers -----------------------------------------------------------------

function rotate(x: number, y: number, angle: number, scale: number): Vec {
  const c = Math.cos(angle) * scale;
  const s = Math.sin(angle) * scale;
  return [c * x - s * y, s * x + c * y];
}

// An angle brought into -PI..PI.
function wrap(angle: number) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

// An angle brought into -PI/2..PI/2, for directions that have no head or tail.
function wrapHalf(angle: number) {
  return angle - Math.PI * Math.round(angle / Math.PI);
}
