// The floor block without asking (round 3, F8; impact design §0, §6): how a
// circle on the floor at P looks, read from the person, so the app's two
// drawings render with a floor near the hand-measured one instead of
// DEFAULT_FLOOR. One phone camera, so the floor comes from a pinhole camera
// fitted to him, then read at P (cameraFloor):
//   - standing frames: the stand-in's shoulders, hips and nose seen, his
//     torso within 10° of upright and as long as a standing torso, his hips
//     at least 0.42 of his height over his feet, and the whole person mask
//     inside the frame. His height there is the mask's box, his feet its
//     bottom row. Fewer than 8 such frames and there is nothing to read.
//   - the horizon, where the floor's parallel lines meet: while he walks
//     toward or away from the camera upright, the line through his shoulders
//     on two frames and the line through his hips on the same two are images
//     of parallel floor-level lines, so they cross on the horizon (frame
//     pairs whose torsos differ by 30 % or more; the median crossing). When he
//     never moves that far, it's the camera-height prior: the phone at
//     CAMERA_HEIGHT of his height, so the horizon crosses his standing body
//     there (heightHorizon).
//   - the roll: the median slope of his hip line on the standing frames,
//     within ±6° (it lies near the horizon's height, where any level line
//     looks parallel to it; standing on both feet his pelvis stays level,
//     while his shoulders shrug and swing with his arms). Standing frames
//     whose hip or shoulder line is more than 6° off it are dropped: he's
//     twisting, rising from a crouch or in the air.
//   - the focal length can't be read from one camera's 2D pose without a
//     floor ruler (the stand-in's 15 points have no feet), so it's the room
//     prior: he stands DISTANCE of his height from the phone, so f is his
//     standing height in px × DISTANCE.
//   - the tilt follows from the horizon's offset from the frame centre, the
//     principal point: tan τ = offset / f.
// Unreliable, and DEFAULT_FLOOR with the reason, when: there's no pose, too
// few standing frames, the camera comes out tilted beyond −25..50°, P isn't
// clearly below the horizon (it can't be on the floor), or the ratio leaves
// the effect's 0.2..1.
// On the hero (camera fit: f 922 px, tilt 12.1°, roll 2.3°; floor 0.763,
// 2.6°, (0.04, −1), 0.68) see tests/unit/r3-f8-floor-estimate.test.ts.
// Pure: no DOM, nothing random.
import type { FloorBlock, Vec2 } from '../types/effect.ts';
import type { SamMask } from '../sam/cache.ts';
import type { PointSet } from '../track/tracking.ts';
import { DEFAULT_FLOOR, sigmaOf } from './floor.ts';

// The priors (a phone propped in a room, filming the whole of him). The
// hero's own values are 0.67 (1.18 m of about 1.75 m) and 1.37 (2.4 m away).
export const CAMERA_HEIGHT = 0.65; // the camera's height, × his height
export const DISTANCE = 1.43; // how far he stands from the camera, × his height (2.5 m for 1.75 m)
const MIN_STANDING = 8; // standing frames needed
const SEEN = 0.5; // landmark confidence
const LEAN = 10; // degrees: his torso from upright, on screen
const HIPS_UP = 0.42; // × his height: his hips over his feet, standing (0.5 on the hero; a crouch is 0.2–0.3)
const TORSO_MIN = 0.22; // × his height: shoulders to hips, standing (0.28 on the hero; bent toward the camera is shorter)
const EDGE = 0.01; // × the frame height: the mask's box keeps this far inside, top and bottom
const WALK_SCALE = 1.3; // torso length between the two frames of a horizon pair
const WALK_LEVEL = 6; // degrees: a standing or walking frame's hip and shoulder lines from the roll
const WALK_BUILD = 0.25; // a walking frame's shoulder width / torso length within this share of standing's
const MIN_CROSS = 20; // degrees between the two lines of a pair
const MIN_PAIRS = 5;
const MAX_ROLL = 6; // degrees
const TILT = [-25, 50] as const; // degrees: a plausible phone tilt (down positive)
const BELOW = 0.05; // × the frame height: P under the horizon by at least this
const SIGMA_REACH = 15; // frames either side of I for his mask's box (scene.ts's)
const RING = 0.75; // × U: the floor circle persp is fitted on (the middle floor arc)

export interface Camera {
  f: number; // px
  tilt: number; // radians, down positive
  roll: number; // radians, clockwise on screen (y down) positive
  cx: number; // the principal point, px
  cy: number;
}

export interface FloorEstimate {
  floor: FloorBlock;
  from: 'person' | 'default';
  why: string; // what it read, or why it fell back
  camera: Camera | null;
  horizon: { x: number; y: number; from: 'walk' | 'height' } | null; // a point on it, clip px
  standing: number; // standing frames found
}

export interface FloorInput {
  P: Vec2; // the impact point, clip px
  I: number; // the contact frame
  width: number; // clip px
  height: number;
  masks: readonly (SamMask | null)[]; // the person on each frame (detect.ts's Masks)
  bodies: readonly (PointSet | null)[] | null; // the stand-in's landmarks, clip px: MediaPipe's 33 or its 15 CORE points
}

// ---- The camera ----------------------------------------------------------------------------

// World: the camera 1 up (units cancel), looking along +z, tilted down by
// τ; the floor is y = 0. Camera axes: right (1, 0, 0), image down
// (0, −cos τ, −sin τ), forward (0, −sin τ, cos τ); the roll turns the image.
type Floor2 = [number, number]; // a floor point (x, z)

function project(cam: Camera, q: Floor2): Vec2 | null {
  const st = Math.sin(cam.tilt);
  const ct = Math.cos(cam.tilt);
  const z = st + q[1] * ct;
  if (!(z > 1e-9)) return null;
  const u = q[0] / z;
  const w = (ct - q[1] * st) / z;
  const sr = Math.sin(cam.roll);
  const cr = Math.cos(cam.roll);
  return [cam.cx + cam.f * (cr * u - sr * w), cam.cy + cam.f * (sr * u + cr * w)];
}

// The floor point under an image point; null at or above the horizon.
function backProject(cam: Camera, p: Vec2): Floor2 | null {
  const dx = p[0] - cam.cx;
  const dy = p[1] - cam.cy;
  const sr = Math.sin(cam.roll);
  const cr = Math.cos(cam.roll);
  const u = (cr * dx + sr * dy) / cam.f;
  const w = (-sr * dx + cr * dy) / cam.f;
  const st = Math.sin(cam.tilt);
  const ct = Math.cos(cam.tilt);
  const down = st + w * ct;
  if (!(down > 1e-9)) return null;
  const t = 1 / down;
  return [t * u, t * (ct - w * st)];
}

// The floor block at P for a camera (impact design §6's model): a small floor
// circle's image ellipse (its axes' ratio and the major axis's angle), n̂ the
// image of the floor's direction away from the camera at P, and persp fitted
// to the far half of the floor circle RING·U across. Null when P isn't on
// the floor.
export function cameraFloor(cam: Camera, P: Vec2, U: number): FloorBlock | null {
  const q = backProject(cam, P);
  if (!q) return null;
  const range = Math.hypot(q[0], q[1]);
  const e = 1e-4 * range;
  const at = (x: number, z: number) => project(cam, [q[0] + x, q[1] + z]);
  const px = [at(e, 0), at(-e, 0)];
  const pz = [at(0, e), at(0, -e)];
  if (!px[0] || !px[1] || !pz[0] || !pz[1]) return null;
  // The Jacobian's columns: the image per floor unit along x and along z.
  const a: Vec2 = [(px[0][0] - px[1][0]) / (2 * e), (px[0][1] - px[1][1]) / (2 * e)];
  const b: Vec2 = [(pz[0][0] - pz[1][0]) / (2 * e), (pz[0][1] - pz[1][1]) / (2 * e)];
  // Its singular values from J·Jᵀ (symmetric 2×2): the ellipse's semi-axes per floor unit.
  const sxx = a[0] * a[0] + b[0] * b[0];
  const syy = a[1] * a[1] + b[1] * b[1];
  const sxy = a[0] * a[1] + b[0] * b[1];
  const mean = (sxx + syy) / 2;
  const half = Math.hypot((sxx - syy) / 2, sxy);
  const big = Math.sqrt(mean + half);
  const small = Math.sqrt(Math.max(0, mean - half));
  const majorDeg = (0.5 * Math.atan2(2 * sxy, sxx - syy) * 180) / Math.PI;
  // n̂: away from the camera along the floor, radially from under it.
  const away: Floor2 = [q[0] / range, q[1] / range];
  const n0: Vec2 = [a[0] * away[0] + b[0] * away[1], a[1] * away[0] + b[1] * away[1]];
  const nLen = Math.hypot(n0[0], n0[1]);
  if (!(nLen > 0) || !(big > 0)) return null;
  const n: Vec2 = [n0[0] / nLen, n0[1] / nLen];
  const ratio = small / big;
  // persp: the far rise of a floor circle RING·U across, against ratio·R.
  const R = RING * U;
  const far = project(cam, [q[0] + (away[0] * R) / big, q[1] + (away[1] * R) / big]);
  const rise = far ? (far[0] - P[0]) * n[0] + (far[1] - P[1]) * n[1] : 0;
  const persp = rise > 0 ? Math.max(0, ((ratio * R) / rise - 1) * (U / R)) : 0;
  return { ratio, majorDeg, up: n, persp };
}

// ---- What the person gives -------------------------------------------------------------------

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// A cached mask's set cells as a box, clip px. Null when it has none.
export function samMaskBox(m: SamMask | null): Box | null {
  if (!m) return null;
  let c0 = Infinity;
  let c1 = -Infinity;
  let r0 = Infinity;
  let r1 = -Infinity;
  for (let r = 0; r < m.height; r++) {
    for (let c = 0; c < m.width; c++) {
      if (!m.raster[r * m.width + c]) continue;
      if (c < c0) c0 = c;
      if (c > c1) c1 = c;
      if (r < r0) r0 = r;
      r1 = r;
    }
  }
  if (r1 < 0) return null;
  const sx = (m.bounds.right - m.bounds.left) / m.width;
  const sy = (m.bounds.bottom - m.bounds.top) / m.height;
  return { x0: m.bounds.left + c0 * sx, y0: m.bounds.top + r0 * sy, x1: m.bounds.left + (c1 + 1) * sx, y1: m.bounds.top + (r1 + 1) * sy };
}

interface Torso {
  sh: Vec2; // the shoulders' midpoint
  hip: Vec2;
  width: number; // shoulder to shoulder, px
  length: number; // shoulders to hips, px
  lean: number; // degrees from upright on screen
  hipLevel: number | null; // the hip line's slope, degrees; null side-on
  shoulderLevel: number | null;
  nose: Vec2 | null;
}

// The stand-in's torso on one frame: the shoulders (11, 12) and hips (23, 24
// of MediaPipe's 33, 13, 14 of the 15 CORE points). Null unless all four are seen.
function torsoOf(s: PointSet | null): Torso | null {
  if (!s) return null;
  const hips = s.x.length >= 33 ? [23, 24] : [13, 14];
  const pt = (i: number): Vec2 | null => (i < s.x.length && s.confidence[i] >= SEEN && Number.isFinite(s.x[i]) && Number.isFinite(s.y[i]) ? [s.x[i], s.y[i]] : null);
  const [ls, rs, lh, rh] = [pt(11), pt(12), pt(hips[0]), pt(hips[1])];
  if (!ls || !rs || !lh || !rh) return null;
  const sh: Vec2 = [(ls[0] + rs[0]) / 2, (ls[1] + rs[1]) / 2];
  const hip: Vec2 = [(lh[0] + rh[0]) / 2, (lh[1] + rh[1]) / 2];
  const length = Math.hypot(sh[0] - hip[0], sh[1] - hip[1]);
  const width = Math.hypot(ls[0] - rs[0], ls[1] - rs[1]);
  // A line's slope, folded into −90..90 (his left shoulder is on the image
  // right when he faces the camera, on the left when his back is to it).
  const slope = (l: Vec2, r: Vec2): number | null => {
    const dx = l[0] - r[0];
    const dy = l[1] - r[1];
    if (Math.abs(dx) < 0.5 * Math.hypot(dx, dy)) return null; // side-on
    return (Math.atan(dy / dx) * 180) / Math.PI;
  };
  const shoulderLevel = slope(ls, rs);
  const hipLevel = slope(lh, rh);
  return {
    sh,
    hip,
    width,
    length,
    lean: (Math.atan2(sh[0] - hip[0], hip[1] - sh[1]) * 180) / Math.PI,
    hipLevel,
    shoulderLevel,
    nose: pt(0),
  };
}

interface Standing {
  f: number;
  torso: Torso;
  stature: number; // his height, px: the mask's box
  feet: Vec2; // the box's bottom middle
}

const median = (values: readonly number[]): number => {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Where two lines cross (a1→a2 and b1→b2), with the angle between them; null when nearly parallel.
function crossing(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): { at: Vec2; deg: number } | null {
  const d1: Vec2 = [a2[0] - a1[0], a2[1] - a1[1]];
  const d2: Vec2 = [b2[0] - b1[0], b2[1] - b1[1]];
  const den = d1[0] * d2[1] - d1[1] * d2[0];
  const l1 = Math.hypot(d1[0], d1[1]);
  const l2 = Math.hypot(d2[0], d2[1]);
  if (!(l1 > 0) || !(l2 > 0)) return null;
  const deg = (Math.asin(Math.min(1, Math.abs(den) / (l1 * l2))) * 180) / Math.PI;
  if (deg < MIN_CROSS) return null;
  const t = ((b1[0] - a1[0]) * d2[1] - (b1[1] - a1[1]) * d2[0]) / den;
  return { at: [a1[0] + t * d1[0], a1[1] + t * d1[1]], deg };
}

const fallback = (why: string, standing = 0): FloorEstimate => ({ floor: { ...DEFAULT_FLOOR, up: [DEFAULT_FLOOR.up[0], DEFAULT_FLOOR.up[1]] }, from: 'default', why, camera: null, horizon: null, standing });

// The floor block for the slam at P, read from the person (see the top of
// this file); DEFAULT_FLOOR and the reason when it can't be read.
export function estimateFloor(o: FloorInput): FloorEstimate {
  const { P, width: W, height: H } = o;
  if (!o.bodies || !o.bodies.some(Boolean)) return fallback('no stand-in pose (Track (stand-in) gives one), so his height and the horizon are unread');
  const frames = Math.min(o.bodies.length, o.masks.length);
  const torsos = Array.from({ length: frames }, (_, f) => torsoOf(o.bodies![f] ?? null));

  // 1. Standing frames.
  const upright: Standing[] = [];
  for (let f = 0; f < frames; f++) {
    const t = torsos[f];
    const box = t ? samMaskBox(o.masks[f] ?? null) : null;
    if (!t || !box || box.y0 <= EDGE * H || box.y1 >= (1 - EDGE) * H) continue;
    const stature = box.y1 - box.y0;
    if (Math.abs(t.lean) > LEAN || !t.nose || t.nose[1] >= t.sh[1]) continue;
    if (box.y1 - t.hip[1] < HIPS_UP * stature || t.hip[1] - t.sh[1] < TORSO_MIN * stature) continue;
    upright.push({ f, torso: t, stature, feet: [(box.x0 + box.x1) / 2, box.y1] });
  }

  // 2. The roll, and the standing frames level with it.
  const levels = upright.map((s) => s.torso.hipLevel).filter((v): v is number => v !== null);
  const rollDeg = levels.length > 0 ? Math.max(-MAX_ROLL, Math.min(MAX_ROLL, median(levels))) : 0;
  const roll = (rollDeg * Math.PI) / 180;
  const level = (t: Torso) => t.hipLevel !== null && t.shoulderLevel !== null && Math.abs(t.hipLevel - rollDeg) <= WALK_LEVEL && Math.abs(t.shoulderLevel - rollDeg) <= WALK_LEVEL;
  const standing = upright.filter((s) => level(s.torso));
  if (standing.length < MIN_STANDING) return fallback(`he stands upright, level and whole in frame on ${standing.length} frames (${MIN_STANDING} needed)`, standing.length);

  // 3. The horizon: crossings while he walks, else the camera-height prior.
  const build = median(standing.map((s) => s.torso.width / s.torso.length));
  const walking = torsos.flatMap((t, f): { f: number; t: Torso }[] => {
    if (!t || Math.abs(t.lean) > LEAN || !level(t)) return [];
    if (Math.abs(t.width / t.length / build - 1) > WALK_BUILD) return [];
    return [{ f, t }];
  });
  const crossings: Vec2[] = [];
  for (const a of standing) {
    for (const b of walking) {
      const k = b.t.length / a.torso.length;
      if (k < WALK_SCALE && 1 / k < WALK_SCALE) continue;
      const c = crossing(a.torso.sh, b.t.sh, a.torso.hip, b.t.hip);
      if (c) crossings.push(c.at);
    }
  }
  const cx = W / 2;
  const cy = H / 2;
  const f = DISTANCE * median(standing.map((s) => s.stature)); // the room prior (step 4)
  const tanRoll = Math.tan(roll);
  let horizon: FloorEstimate['horizon'];
  if (crossings.length >= MIN_PAIRS) {
    horizon = { x: median(crossings.map((c) => c[0])), y: median(crossings.map((c) => c[1])), from: 'walk' };
  } else {
    const row = heightHorizon(standing, f, roll, cx, cy);
    horizon = { x: cx - Math.sin(roll) * row, y: cy + Math.cos(roll) * row, from: 'height' };
  }
  const horizonAt = (x: number) => horizon!.y + (x - horizon!.x) * tanRoll;

  // 4. The camera: f from the room prior, the tilt from the horizon's offset.
  const offset = (cy - horizonAt(cx)) * Math.cos(roll); // the principal point below the horizon, px
  const tilt = Math.atan2(offset, f);
  const tiltDeg = (tilt * 180) / Math.PI;
  if (tiltDeg < TILT[0] || tiltDeg > TILT[1]) return fallback(`the horizon it read (y ${horizonAt(cx).toFixed(0)}) tilts the camera ${tiltDeg.toFixed(0)}°, outside ${TILT[0]}..${TILT[1]}°`, standing.length);
  const camera: Camera = { f, tilt, roll, cx, cy };
  if ((P[1] - horizonAt(P[0])) * Math.cos(roll) < BELOW * H) return fallback(`P (y ${P[1].toFixed(0)}) isn't clearly below the horizon (y ${horizonAt(P[0]).toFixed(0)}), so it can't be on the floor`, standing.length);

  // 5. The floor at P, U from his mask's box at I (scene.ts's σ).
  const S = Math.min(W, H);
  const U = sigmaOf(personHeight(o.masks, o.I) ?? 0.7 * H, S) * S;
  const read = cameraFloor(camera, P, U);
  if (!read || !(read.ratio >= 0.2 && read.ratio <= 1)) return fallback(`the camera it read gives a floor ratio of ${read ? read.ratio.toFixed(2) : 'nothing'} at P, outside 0.2..1`, standing.length);
  const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
  return {
    floor: { ratio: round(read.ratio, 3), majorDeg: round(read.majorDeg, 1), up: [round(read.up[0], 3), round(read.up[1], 3)], persp: round(read.persp, 2) },
    from: 'person',
    why: `${standing.length} standing frames; horizon y ${horizonAt(P[0]).toFixed(0)} at P from ${horizon.from === 'walk' ? `${crossings.length} walking crossings` : `the camera-height prior (${CAMERA_HEIGHT} of his height)`}; f ${f.toFixed(0)} px from the room prior (${DISTANCE} of his height away); tilt ${tiltDeg.toFixed(1)}°, roll ${rollDeg.toFixed(1)}°`,
    camera,
    horizon,
    standing: standing.length,
  };
}

// The camera-height prior's horizon: the point CAMERA_HEIGHT up his standing
// body lies on it. Rows here are turned upright by the roll and measured from
// the principal point, so the horizon is the row −f·tan τ and the vertical
// vanishing point the row f·cot τ. Up his body the image isn't linear in
// height, but 1/(y_V − y) is, so the horizon's row follows from y_V, and y_V
// from the tilt that row gives: from the linear guess, a few rounds settle it
// (the linear guess alone sits about 19 px high at a 10° tilt).
function heightHorizon(standing: readonly Standing[], f: number, roll: number, cx: number, cy: number): number {
  const sr = Math.sin(roll);
  const cr = Math.cos(roll);
  const rowOf = (x: number, y: number) => -sr * (x - cx) + cr * (y - cy);
  const rows = standing.map((s) => ({ feet: rowOf(s.feet[0], s.feet[1]), top: rowOf(s.feet[0], s.feet[1] - s.stature) }));
  let row = median(rows.map((r) => r.feet - CAMERA_HEIGHT * (r.feet - r.top)));
  for (let k = 0; k < 5; k++) {
    const tan = -row / f; // tan τ
    if (Math.abs(tan) < 1e-6) break; // level: the vertical vanishing point is at infinity and the guess is exact
    const vp = f / tan;
    const next = median(
      rows.map((r) => {
        const a = 1 / (vp - r.feet);
        const b = 1 / (vp - r.top);
        return vp - 1 / (a + CAMERA_HEIGHT * (b - a));
      }),
    );
    if (!Number.isFinite(next)) break;
    row = next;
  }
  return row;
}

// His mask's box height at I, or the nearest frame's within ±15 (scene.ts's personHeight, clip px).
function personHeight(masks: readonly (SamMask | null)[], I: number): number | null {
  for (let d = 0; d <= SIGMA_REACH; d++) {
    for (const f of d === 0 ? [I] : [I - d, I + d]) {
      if (f < 0 || f >= masks.length) continue;
      const box = samMaskBox(masks[f] ?? null);
      if (box) return box.y1 - box.y0;
    }
  }
  return null;
}
