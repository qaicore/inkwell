// The body the limbs collide with (decision 17): a crash-test dummy fitted to
// him on every frame, so a limb goes round his head, chest and arms instead
// of through them. One camera can't scan him in 3D, so the dummy is built
// from what there is:
//   - the torso is body.ts's egg, the one the roots sit on (its yaw, pitch
//     and roll from the turn and the bend);
//   - a head sphere, a neck, upper arms, forearms (to the fist), thighs and
//     shins are capsules between the stand-in's joints (MediaPipe's 33, or
//     the head and neck alone from its 15 CORE points);
//   - a joint sits where the pose puts it on screen. Its depth: the shoulders,
//     hips and head ride the egg (their place on a standing body, turned,
//     bent and leant with it); an elbow, wrist, knee or ankle is one bone
//     length from its parent, so a bone that looks short on screen points
//     toward or away from the camera by √(L² − ℓ²). L is the bone's longest
//     look over the clip (its 95th percentile, × the torso unit). Of the two
//     depths, the one nearer its place on a standing body wins, unless the
//     joint is over his torso on screen: then a half-hidden joint (visibility
//     0.3–0.5) goes behind it and a plainly seen one (0.8 and over) in front.
//     Under 0.3 the pose's place isn't used;
//   - each capsule's radius is the person mask's half-width across it at its
//     middle (the nearer edge when the other runs into his torso), within
//     0.6–1.5× a standing body's, median-filtered over ±6 frames;
//   - every joint is held in the egg's own frame, filled across frames
//     without a pose (f89–101 on the hero) and smoothed over ±3 frames
//     (triangle weights), so nothing jitters.
// The pre-scan (decision 18): the space he takes on a frame is his person
// mask, so where there is one the mask is his outline and the dummy only its
// depth. Once per clip, before the physics, each frame's mask is scanned into
// a signed distance field (px to the silhouette's edge, with its gradient),
// and each place in it gets the depth spans the egg and the capsules fill on
// its view ray (scanOf, below): one per part, those that overlap taken as
// one, so a gap between two of his parts (his head and his back when he is
// bent over, his arm and his side) stays a gap, and taken over the cells
// round the place, so they have no holes between the cells.
// Collisions (in the 3D rope, strand3d.ts): on a frame with a scan, a node
// whose screen point, widened by the limb's radius, falls inside the mask
// and whose depth falls inside a span there (grown by the radius: a block of
// him) is pushed out: across his outline when that is shortest, else in
// depth: on the side of him the node before it is on (the rope comes from
// his back and can't pass through him between two nodes), else back the way
// it came. Each node remembers the depth where it was last clear of him (off
// his outline, in a gap, or past him), so it leaves a block on that side of
// it, and one that went through a block in a step is put back on its side;
// but only within MEMORY_REACH, since a node deep in a thick block of him
// came round him on screen, not through him. The segments between the nodes are sampled too, and
// a sample inside him moves both its ends out in depth, so no stretch of the
// rope passes through him between two nodes that are clear of him. On a
// frame without a scan, a node closer to a part than the part's radius plus
// the limb's own radius there is pushed out to that surface (the egg along
// its scaled radius, inflated by the limb's radius). Either way its sliding
// velocity loses FRICTION of itself.
// Pure: the same poses and masks give the same dummies.
import type { Vec2 } from '../types/effect.ts';
import type { Mask, PointSet } from '../track/tracking.ts';
import { HEAD, lerpBody, project, toBody, toCamera, TORSO, unproject, type Body3D, type Vec3 } from './body.ts';

export type Part = 'head' | 'neck' | 'upperArm' | 'forearm' | 'thigh' | 'shin';

export interface Capsule {
  part: Part;
  a: Vec3; // camera px; a sphere has a = b
  b: Vec3;
  r: number; // px
}

// One frame's dummy: the egg (body) and the capsules, camera px, and the
// scan of his mask on that frame (null without one: the parts alone).
export interface Dummy {
  body: Body3D;
  capsules: Capsule[];
  scan?: Scan | null;
}

// One frame's scan of his body (decision 18). `sdf`: the mask's signed
// distance on a grid of `cell` clip px over his mask's box grown by `margin`
// px, px to the silhouette's edge, < 0 inside him; off the grid he is at
// least the margin away. Each cell's depth spans (camera px, flat [lo, hi, …],
// low to high and apart), what his parts fill on its view ray, are worked out
// the first time they're asked for and kept (`slabs`), and so are four
// cells' together: the scan is a pure function of the frame's mask and dummy.
export interface Scan {
  body: Body3D; // the frame's: the projection and the parts the slabs come from
  capsules: readonly Capsule[];
  x0: number; // clip px of cell (0, 0)'s centre
  y0: number;
  cell: number;
  cols: number;
  rows: number;
  margin: number;
  sdf: Float32Array;
  slabs: Map<number, Float64Array>;
}

// Which way a push took a point out of him: behind him (−1), in front of him
// (+1), or sideways across his outline (0).
export type Side = -1 | 0 | 1;

export const FRICTION = 0.3; // share of a pushed node's sliding velocity taken away
export const SCAN_CELL = 1 / 480; // × the clip's width: the scan's grid (4 px on a 1920 px clip)
const SCAN_MARGIN = 0.025; // × the clip's width: how far round his mask the scan's field reaches (past any limb's radius)
const INSIDE = 128; // mask alpha from which a pixel is the person
const HIDDEN = 0.3; // joint visibility from which the pose's place is used
const SEEN = 0.5; // a joint over his torso less visible than this is behind it ...
const SURE = 0.8; // ... and one this visible in front of it
const SMOOTH = 3; // ± frames, triangle weights
const RADIUS_NEAR = 6; // ± frames of the radius's median
const RADIUS_RANGE = [0.6, 1.5] as const; // × the standing body's radius
const LENGTH_RANGE = [0.7, 1.4] as const; // × the standing body's bone

// A standing body in the egg's frame (torso units: x his left, y down his
// spine, z out of his chest), and its radii. Each joint names its parent.
const STAND: Record<string, { at: Vec3; mp: number; core?: number; parent?: string }> = {
  head: { at: [0, HEAD.cy, 0.03], mp: -1 }, // the ears' midpoint, else the nose
  lShoulder: { at: [0.24, -0.9, 0], mp: 11, core: 11 },
  rShoulder: { at: [-0.24, -0.9, 0], mp: 12, core: 12 },
  lHip: { at: [0.14, 0.22, 0], mp: 23, core: 13 },
  rHip: { at: [-0.14, 0.22, 0], mp: 24, core: 14 },
  lElbow: { at: [0.3, -0.38, 0], mp: 13, parent: 'lShoulder' },
  rElbow: { at: [-0.3, -0.38, 0], mp: 14, parent: 'rShoulder' },
  lHand: { at: [0.33, 0.12, 0.04], mp: 15, parent: 'lElbow' },
  rHand: { at: [-0.33, 0.12, 0.04], mp: 16, parent: 'rElbow' },
  lKnee: { at: [0.14, 0.95, 0.02], mp: 25, parent: 'lHip' },
  rKnee: { at: [-0.14, 0.95, 0.02], mp: 26, parent: 'rHip' },
  lAnkle: { at: [0.14, 1.65, -0.02], mp: 27, parent: 'lKnee' },
  rAnkle: { at: [-0.14, 1.65, -0.02], mp: 28, parent: 'rKnee' },
};
const JOINTS = Object.keys(STAND);
const ROOTS = ['head', 'lShoulder', 'rShoulder', 'lHip', 'rHip']; // ride the egg
const LIMBS = JOINTS.filter((j) => STAND[j].parent); // parents first: STAND lists them so
// How far the pose may move a root joint from its standing place on the egg,
// torso units per axis: the shoulders and hips stay on the torso, never
// behind his back, and the head nods forward more than back.
const ON_TORSO: [Vec3, Vec3] = [[-0.1, -0.1, -0.08], [0.1, 0.1, 0.08]];
const ROOM: Record<string, [Vec3, Vec3]> = {
  head: [[-0.3, -0.25, -0.1], [0.3, 0.25, 0.45]],
  lShoulder: ON_TORSO,
  rShoulder: ON_TORSO,
  lHip: ON_TORSO,
  rHip: ON_TORSO,
};

// The parts: [part, from joint, to joint, standing radius in torso units].
const PARTS: [Part, string, string, number][] = [
  ['head', 'head', 'head', HEAD.r],
  ['neck', 'neck', 'head', 0.1],
  ['upperArm', 'lShoulder', 'lElbow', 0.085],
  ['upperArm', 'rShoulder', 'rElbow', 0.085],
  ['forearm', 'lElbow', 'lHand', 0.07],
  ['forearm', 'rElbow', 'rHand', 0.07],
  ['thigh', 'lHip', 'lKnee', 0.13],
  ['thigh', 'rHip', 'rKnee', 0.13],
  ['shin', 'lKnee', 'lAnkle', 0.095],
  ['shin', 'rKnee', 'rAnkle', 0.095],
];
const HAND_REACH = 0.08; // torso units the forearm runs on past the wrist, over the fist

export interface DummyOptions {
  bodies: readonly Body3D[]; // the egg on every frame
  joints: readonly (PointSet | null)[] | null; // the stand-in's landmarks, clip px; MediaPipe's 33 or its 15 CORE points
  mask?: ((f: number) => Mask | null) | null; // the person mask, any resolution over width × height
  width: number; // clip px
  height: number;
}

// The dummy on every frame, each with its frame's scan where there is a
// mask. Without joints it is the egg alone.
export function dummyBodies(o: DummyOptions): Dummy[] {
  return partsOf(o).map((d, f) => {
    const m = o.mask?.(f) ?? null;
    return { ...d, scan: m ? scanOf(m, o.width, o.height, d) : null };
  });
}

function partsOf(o: DummyOptions): Dummy[] {
  const n = o.bodies.length;
  const sets = o.joints ?? [];
  const full = sets.some((s) => s && s.x.length >= 33);
  const have = (j: string) => full || STAND[j].core !== undefined || j === 'head';
  const used = JOINTS.filter(have);
  if (!sets.some((s) => s)) return o.bodies.map((body) => ({ body, capsules: [] }));

  // 1. Each joint on screen where the pose sees it (null where it doesn't).
  const index = (j: string) => (full ? STAND[j].mp : STAND[j].core ?? -1);
  const seen = (s: PointSet | null, i: number): { xy: Vec2; vis: number } | null => {
    if (!s || i < 0 || i >= s.x.length) return null;
    const vis = s.confidence[i];
    return Number.isFinite(s.x[i]) && Number.isFinite(s.y[i]) && vis >= HIDDEN ? { xy: [s.x[i], s.y[i]], vis } : null;
  };
  const screen = (j: string, f: number): { xy: Vec2; vis: number } | null => {
    const s = sets[f] ?? null;
    if (j !== 'head') return seen(s, index(j));
    const ears = [seen(s, 7), seen(s, 8)];
    if (ears[0] && ears[1]) return { xy: [(ears[0].xy[0] + ears[1].xy[0]) / 2, (ears[0].xy[1] + ears[1].xy[1]) / 2], vis: Math.min(ears[0].vis, ears[1].vis) };
    return seen(s, 0);
  };

  // 2. The bones' lengths, torso units: their longest look over the clip.
  const bone = new Map<string, number>();
  for (const j of LIMBS.filter(have)) {
    const p = STAND[j].parent!;
    const looks: number[] = [];
    for (let f = 0; f < n; f++) {
      const a = screen(p, f);
      const b = screen(j, f);
      if (a && b) looks.push(Math.hypot(b.xy[0] - a.xy[0], b.xy[1] - a.xy[1]) / o.bodies[f].unit);
    }
    const standing = dist(STAND[j].at, STAND[p].at);
    looks.sort((x, y) => x - y);
    const L = looks.length >= 5 ? looks[Math.min(looks.length - 1, Math.floor(0.95 * looks.length))] : standing;
    bone.set(j, clamp(L, LENGTH_RANGE[0] * standing, LENGTH_RANGE[1] * standing));
  }

  // 3. Each joint in camera px on the frames that see it, then in the egg's frame.
  const local = new Map<string, (Vec3 | null)[]>(used.map((j) => [j, new Array<Vec3 | null>(n).fill(null)]));
  for (let f = 0; f < n; f++) {
    const b = o.bodies[f];
    const at = new Map<string, Vec3>();
    for (const j of used) {
      const s = screen(j, f);
      if (!s) continue;
      const parent = STAND[j].parent;
      if (!parent) {
        // A root joint rides the egg: the pose moves it only so far from where
        // it stands on it (a bent egg turns a screen error into depth).
        const q = toBody(b, unproject(b, s.xy, toCamera(b, STAND[j].at)[2]));
        const [lo, hi] = ROOM[j];
        at.set(j, toCamera(b, [0, 1, 2].map((k) => clamp(q[k], STAND[j].at[k] + lo[k], STAND[j].at[k] + hi[k])) as Vec3));
        continue;
      }
      const pa = at.get(parent);
      if (!pa) continue;
      const pxy = project(b, pa).xy;
      const l = Math.hypot(s.xy[0] - pxy[0], s.xy[1] - pxy[1]) / b.unit;
      const dz = Math.sqrt(Math.max(0, bone.get(j)! ** 2 - l * l)) * b.unit;
      const prior = pa[2] + toCamera(b, STAND[j].at)[2] - toCamera(b, STAND[parent].at)[2];
      let z = Math.abs(pa[2] + dz - prior) <= Math.abs(pa[2] - dz - prior) ? pa[2] + dz : pa[2] - dz;
      if (dz > 0 && overTorso(b, s.xy)) z = s.vis >= SURE ? pa[2] + dz : s.vis < SEEN ? pa[2] - dz : z;
      at.set(j, notBehind(b, s.xy, z));
    }
    for (const [j, p] of at) local.get(j)![f] = toBody(b, p);
  }

  // 4. Filled across frames without them, smoothed, and back on every frame.
  const smoothed = new Map<string, Vec3[]>();
  for (const j of used) smoothed.set(j, smoothTrack(fillTrack(local.get(j)!, STAND[j].at), SMOOTH));
  const joint = (j: string, f: number): Vec3 => {
    const b = o.bodies[f];
    if (j === 'neck') return toCamera(b, mix(smoothed.get('lShoulder')![f], smoothed.get('rShoulder')![f], 0.5));
    return toCamera(b, smoothed.get(j)![f]);
  };

  // 5. The capsules, radii fitted to the mask's width across them.
  const parts = PARTS.filter(([, a, b]) => (a === 'neck' ? have('lShoulder') && have('rShoulder') : have(a)) && have(b));
  const radii = parts.map(([part, a, b, r0]) => {
    const raw: (number | null)[] = [];
    for (let f = 0; f < n; f++) {
      const m = o.mask?.(f) ?? null;
      const body = o.bodies[f];
      if (!m) {
        raw.push(null);
        continue;
      }
      const A = project(body, joint(a, f)).xy;
      const B = project(body, a === b ? joint(a, f) : endOf(part, joint(a, f), joint(b, f), body)).xy;
      const half = halfWidth(m, o.width, o.height, A, B, part === 'head', 2 * RADIUS_RANGE[1] * r0 * body.unit);
      raw.push(half === null ? null : half / body.unit);
    }
    const lo = RADIUS_RANGE[0] * r0;
    const hi = RADIUS_RANGE[1] * r0;
    return medianTrack(raw, RADIUS_NEAR).map((r) => clamp(r ?? r0, lo, hi));
  });
  return o.bodies.map((body, f) => ({
    body,
    capsules: parts.map(([part, a, b], k): Capsule => {
      const A = joint(a, f);
      return { part, a: A, b: a === b ? A : endOf(part, A, joint(b, f), body), r: radii[k][f] * body.unit };
    }),
  }));
}

// A limb joint at screen point xy and depth z, put no further behind his
// spine's plane than his back is (BEHIND, in the egg's frame), its place on
// screen kept. One camera can't tell how far behind him an arm swings (the
// stand-in put his forearm 0.76 torso units behind him face-on), and the
// limbs grow out of his back there: an arm the pose puts behind it closes a
// pocket round their roots that no way out of in depth leads from. Seen side
// on, depth can't move it back, and it stays.
function notBehind(b: Body3D, xy: Vec2, z: number): Vec3 {
  const p = unproject(b, xy, z);
  const q = toBody(b, p);
  if (q[2] >= BEHIND) return p;
  const k = toBody(b, unproject(b, xy, z + b.unit))[2] - q[2]; // the egg's z per torso height of camera depth
  return Math.abs(k) < 0.2 ? p : unproject(b, xy, z + ((BEHIND - q[2]) / k) * b.unit);
}
const BEHIND = -TORSO.c; // torso units

// The forearm runs on past the wrist over the fist; any other part ends at its joint.
function endOf(part: Part, a: Vec3, b: Vec3, body: Body3D): Vec3 {
  if (part !== 'forearm') return b;
  const d = dist(a, b);
  return d > 1e-9 ? add(b, scale(sub(b, a), (HAND_REACH * body.unit) / d)) : b;
}

// The dummy between two frames' (its parts listed alike on both), with the
// nearer frame's scan.
export function lerpDummy(a: Dummy, b: Dummy, w: number): Dummy {
  return {
    body: lerpBody(a.body, b.body, w),
    capsules: a.capsules.map((c, i) => {
      const d = b.capsules[i] ?? c;
      return { part: c.part, a: mix(c.a, d.a, w), b: mix(c.b, d.b, w), r: c.r + (d.r - c.r) * w };
    }),
    scan: (w < 0.5 ? a.scan : b.scan) ?? null,
  };
}

// ---- Inside and out ------------------------------------------------------------------------

// How deep p (camera px) is inside the dummy, grown by `pad` px: > 0 inside.
// With a scan, inside its scanned body: the shortest way out.
export function insideDepth(d: Dummy, p: Vec3, pad = 0): number {
  if (d.scan) return scanPush(d.scan, p, pad)?.depth ?? 0;
  let deepest = eggInside(d.body, p, pad);
  for (const c of d.capsules) deepest = Math.max(deepest, c.r + pad - dist(p, closest(c, p)));
  return deepest;
}

// The egg's depth inside, px, measured along its scaled radius (exact on a sphere).
function eggInside(b: Body3D, p: Vec3, pad: number): number {
  const q = toBody(b, p);
  const r = pad / b.unit;
  const F = Math.hypot(q[0] / (TORSO.a + r), (q[1] - TORSO.cy) / (TORSO.b + r), q[2] / (TORSO.c + r));
  if (F >= 1) return (1 - F) * Math.min(TORSO.a + r, TORSO.c + r) * b.unit;
  const centre: Vec3 = [0, TORSO.cy, 0];
  return dist(q, centre) * (1 / F - 1) * b.unit;
}

// The point on the capsule's axis nearest p.
function closest(c: Capsule, p: Vec3): Vec3 {
  const ab = sub(c.b, c.a);
  const l2 = dot(ab, ab);
  if (l2 < 1e-12) return c.a;
  return add(c.a, scale(ab, clamp(dot(sub(p, c.a), ab) / l2, 0, 1)));
}

// Pushes `points[i]` for i in [from, to) out of his body, `radii[i]` px of
// limb round it, and takes FRICTION of the sliding velocity away (Verlet:
// the velocity is points − prev). With a scan: each node, root first, out of
// the block of him it is in (scanPush) on the side of it the node before it
// is on, when that one is past the block on this ray (the way the rope comes:
// two neighbours going out on opposite sides would hang the segment between
// them through him), else the way it came, by `clear`, each node's depth
// where it was last clear of him (kept up to date here; missing or NaN, or
// that side's face further than MEMORY_REACH, the shortest way), and one
// that went through a block of him since it was last clear put back on its
// side of it (within MEMORY_REACH); then the segments between the nodes,
// sampled at QUARTERS of each (EIGHTHS when `fine`, as insideDepth is
// checked), each sample inside him moving both its ends out in depth, to the
// face on the side of the segment's inner end when that is past the block,
// else on its memory's. Else
// out of every part, in two sweeps, for a node squeezed between two parts.
// `fixed`: a node past `to` that holds (a pinned tip), so the segment into
// it is sampled too and only its inner end moves.
// The root grows out of his back: where his body as known swallows it too
// (in profile his clothes stand out past the egg the root sits on, or a
// shoulder's capsule reaches over it), the nodes within that depth of it,
// and their radius, grow out of him with it instead of being torn off it,
// when they are the root's own zone (`grow`; past it, every node is out).
export function collideChain(d: Dummy, points: Vec3[], prev: Vec3[], radii: readonly number[], from: number, to: number, friction = FRICTION, clear?: number[], fixed = false, fine = false, grow = true): void {
  const sunk = grow && from > 0 && from < to ? insideDepth(d, points[0]) : 0;
  const free = (i: number) => !(sunk > 0) || dist(points[i], points[0]) >= sunk + radii[i];
  if (d.scan) {
    const s = d.scan;
    nodeSeen.gen++;
    const memory = clear ?? new Array<number>(points.length).fill(NaN);
    for (let i = from; i < to; i++) if (free(i)) scanNode(s, points, prev, i, radii[i], friction, memory, points[i - 1]);
    scanSegments(s, points, prev, radii, from, to, free, memory, fixed, fine ? EIGHTHS : QUARTERS);
    return;
  }
  const reach = Math.max(0, ...radii.slice(from, to));
  const boxes = d.capsules.map((c) => box(c, reach));
  const egg = eggBound(d.body, reach);
  for (let i = from; i < to; i++) {
    if (!free(i)) continue;
    const r = radii[i];
    for (let sweep = 0; sweep < 2; sweep++) {
      let p = points[i];
      let moved = false;
      let normal: Vec3 = [0, 0, 0];
      if (dist(p, egg.c) < egg.r) {
        const out = eggPush(d.body, p, r);
        if (out) {
          normal = add(normal, sub(out, p));
          p = out;
          moved = true;
        }
      }
      d.capsules.forEach((c, k) => {
        const bx = boxes[k];
        if (p[0] < bx[0] || p[0] > bx[3] || p[1] < bx[1] || p[1] > bx[4] || p[2] < bx[2] || p[2] > bx[5]) return;
        const q = closest(c, p);
        const R = c.r + r;
        const off = sub(p, q);
        const l = Math.hypot(off[0], off[1], off[2]);
        if (l >= R) return;
        const u: Vec3 = l > 1e-9 ? scale(off, 1 / l) : [0, 0, p[2] >= q[2] ? 1 : -1];
        const out = add(q, scale(u, R));
        normal = add(normal, sub(out, p));
        p = out;
        moved = true;
      });
      if (!moved) break;
      slide(points, prev, i, p, normal, friction);
    }
  }
}

// Node i put at `out`, pushed along `normal`: its velocity into the surface
// gone and its sliding velocity `friction` the less.
function slide(points: Vec3[], prev: Vec3[], i: number, out: Vec3, normal: Vec3, friction: number) {
  const v = sub(points[i], prev[i]);
  const nl = Math.hypot(normal[0], normal[1], normal[2]);
  const n: Vec3 = nl > 1e-12 ? scale(normal, 1 / nl) : [0, 0, 1];
  const vn = dot(v, n);
  const vt = sub(v, scale(n, vn));
  points[i] = out;
  prev[i] = sub(out, add(scale(vt, 1 - friction), scale(n, Math.max(0, vn))));
}

// Node i out of the scanned body by r px, the way it came (scanPush with
// `clear[i]`), and `clear[i]` brought up to date. One clear of him with a
// block of him on its view ray between it and where it was last clear went
// through that block in a step: it goes back to that side of it, when that
// is within MEMORY_REACH (further, it came round him on screen, not through).
function scanNode(s: Scan, points: Vec3[], prev: Vec3[], i: number, r: number, friction: number, clear: number[], before?: Vec3) {
  const p = points[i];
  const sd = seenNode(s, points, i);
  const x = nodeSeen.x[i];
  const y = nodeSeen.y[i];
  if (sd >= r) {
    clear[i] = p[2];
    return;
  }
  const spans = spansAt(s, x, y);
  const last = clear[i];
  const block = blockAt(spans, p[2], r);
  if (!block) {
    const wall = Number.isFinite(last) ? between(spans, last, p[2], r) : null;
    if (!wall || Math.abs((last < p[2] ? wall[0] : wall[1]) - p[2]) > MEMORY_REACH * s.body.unit) {
      clear[i] = p[2];
      return;
    }
    const out = unproject(s.body, [x, y], last < p[2] ? wall[0] : wall[1]);
    slide(points, prev, i, out, sub(out, p), friction);
    clear[i] = out[2];
    return;
  }
  // The way the rope comes: out on the side of this block the node before it
  // is on, when it is past the block on this ray, however far that is (the
  // two going out on opposite sides would hang the segment between them
  // through him); else the way the node came.
  const z = before?.[2];
  const hit = z !== undefined && (z <= block[0] || z >= block[1]) ? scanPush(s, p, r, z, Infinity) : scanPush(s, p, r, last);
  if (!hit) return;
  slide(points, prev, i, hit.out, sub(hit.out, p), friction);
  clear[i] = hit.out[2];
}

// The segments between the nodes, out of the scanned body in depth: sampled
// at `at` of each, the sample deepest inside a block of him moves both ends
// along their view rays until it is at that block's face, the face on the
// side of it the inner end is on when that end is past it, else on the side
// its ends were last clear on (within MEMORY_REACH; else the nearer); an end that can't move
// (in the root's zone, or the fixed tip) stays, and the other takes the move
// at its share. Each end moved is then put out of him at its own place again.
function scanSegments(s: Scan, points: Vec3[], prev: Vec3[], radii: readonly number[], from: number, to: number, free: (i: number) => boolean, clear: number[], fixed: boolean, at: readonly number[]) {
  const last = fixed ? to : to - 1;
  for (let i = Math.max(from, 1); i < last; i++) {
    const a = points[i];
    const b = points[i + 1];
    const moveA = free(i);
    const moveB = i + 1 < to && free(i + 1);
    if (!moveA && !moveB) continue;
    const ra = radii[i];
    const rb = radii[i + 1] ?? radii[i];
    const sa = seenNode(s, points, i);
    const sb = seenNode(s, points, i + 1);
    // Its ends on screen (seenNode's), and the deepest sample's move and place.
    const ax = nodeSeen.x[i];
    const ay = nodeSeen.y[i];
    const bx = nodeSeen.x[i + 1];
    const by = nodeSeen.y[i + 1];
    const reach = Math.max(ra, rb) + Math.hypot(bx - ax, by - ay) / 2;
    if (Math.min(sa, sb) >= reach) continue;
    let best = 0;
    let bestT = 0;
    for (const t of at) {
      const x = ax + (bx - ax) * t;
      const y = ay + (by - ay) * t;
      const r = ra + (rb - ra) * t;
      if (sdfAt(s, x, y) >= r) continue;
      const z = a[2] + (b[2] - a[2]) * t;
      const block = blockAt(spansAt(s, x, y), z, r);
      if (!block) continue;
      const move = (a[2] <= block[0] || a[2] >= block[1] ? faceOf(block, z, a[2], Infinity) : faceOf(block, z, memoryAt(clear, i, t, z), MEMORY_REACH * s.body.unit)) - z;
      if (!(Math.abs(move) > Math.abs(best))) continue;
      best = move;
      bestT = t;
    }
    if (best === 0) continue;
    const both = moveA && moveB;
    if (moveA) depthMove(s, points, prev, i, both ? best : best / Math.max(1 - bestT, ALONE));
    if (moveB) depthMove(s, points, prev, i + 1, both ? best : best / Math.max(bestT, ALONE));
    if (moveA) scanNode(s, points, prev, i, ra, 0, clear, points[i - 1]);
    if (moveB) scanNode(s, points, prev, i + 1, rb, 0, clear, points[i]);
  }
}
// Each node's screen point and the field there (seenNode), worked out once a
// collideChain call (`gen`) and again only for a node moved since: a move
// puts a new point in its place (slide), so the point's identity says.
const nodeSeen = { gen: 0, at: [] as (Vec3 | undefined)[], gens: new Int32Array(64), x: new Float64Array(64), y: new Float64Array(64), sd: new Float64Array(64) };

function seenNode(s: Scan, points: readonly Vec3[], i: number): number {
  const c = nodeSeen;
  const p = points[i];
  if (c.gens[i] === c.gen && c.at[i] === p) return c.sd[i];
  if (i >= c.x.length) {
    const grow = <T extends Float64Array | Int32Array>(a: T, make: (n: number) => T): T => {
      const out = make(2 * (i + 1));
      out.set(a);
      return out;
    };
    [c.x, c.y, c.sd] = [grow(c.x, (k) => new Float64Array(k)), grow(c.y, (k) => new Float64Array(k)), grow(c.sd, (k) => new Float64Array(k))];
    c.gens = grow(c.gens, (k) => new Int32Array(k));
  }
  const [x, y] = project(s.body, p).xy;
  [c.x[i], c.y[i], c.sd[i], c.at[i], c.gens[i]] = [x, y, sdfAt(s, x, y), p, c.gen];
  return c.sd[i];
}

const QUARTERS = [0.25, 0.5, 0.75];
const EIGHTHS = [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875];
const ALONE = 0.25; // the least share of a sample's move an end that moves alone takes it at
const MEMORY_REACH = 0.4; // torso units: the furthest a node is put back on the side of him it was last clear on (further, it came round him on screen, and goes out the nearer way)

// The face of a block of him (lo, hi) a depth z inside it goes out by: the
// one on the side it was last clear on (m; z itself when not known), when
// that is within reach px, else the nearer.
function faceOf(block: readonly [number, number], z: number, m: number, reach: number): number {
  const near = z - block[0] <= block[1] - z ? block[0] : block[1];
  const kept = m <= (block[0] + block[1]) / 2 ? block[0] : block[1];
  return Math.abs(kept - z) <= reach ? kept : near;
}

// Where the limb was last clear of him at point t along segment i (the
// clear depths between its ends, or the one known), else `z`.
function memoryAt(clear: readonly number[], i: number, t: number, z: number): number {
  const [a, b] = [clear[i], clear[i + 1]];
  const [ka, kb] = [Number.isFinite(a), Number.isFinite(b)];
  return ka && kb ? a + (b - a) * t : ka ? a : kb ? b : z;
}

// Node i moved `dz` px along its view ray, its screen point kept.
function depthMove(s: Scan, points: Vec3[], prev: Vec3[], i: number, dz: number) {
  const p = points[i];
  const out = unproject(s.body, project(s.body, p).xy, p[2] + dz);
  slide(points, prev, i, out, sub(out, p), 0);
}

// A copy of `nodes` with those in [from, to) pushed out of every part, as
// collideChain pushes a chain's nodes (for a target: no velocity).
export function pushedOut(d: Dummy, nodes: readonly Vec3[], radii: readonly number[], from: number, to: number): Vec3[] {
  const out = nodes.map((p): Vec3 => [p[0], p[1], p[2]]);
  collideChain(d, out, out.map((p): Vec3 => [p[0], p[1], p[2]]), radii, from, to, 0);
  return out;
}

// p pushed out of the egg grown by r px, along its scaled radius; null when outside.
function eggPush(b: Body3D, p: Vec3, r: number): Vec3 | null {
  const q = toBody(b, p);
  const g = r / b.unit;
  const x = q[0] / (TORSO.a + g);
  const y = (q[1] - TORSO.cy) / (TORSO.b + g);
  const z = q[2] / (TORSO.c + g);
  const F = Math.hypot(x, y, z);
  if (F >= 1) return null;
  if (F < 1e-9) return toCamera(b, [0, TORSO.cy, -(TORSO.c + g)]); // dead centre: out of his back
  return toCamera(b, [q[0] / F, TORSO.cy + (q[1] - TORSO.cy) / F, q[2] / F]);
}

function eggBound(b: Body3D, pad: number): { c: Vec3; r: number } {
  return { c: toCamera(b, [0, TORSO.cy, 0]), r: Math.max(TORSO.a, TORSO.b, TORSO.c) * b.unit + pad };
}

function box(c: Capsule, pad: number): number[] {
  const R = c.r + pad;
  return [Math.min(c.a[0], c.b[0]) - R, Math.min(c.a[1], c.b[1]) - R, Math.min(c.a[2], c.b[2]) - R, Math.max(c.a[0], c.b[0]) + R, Math.max(c.a[1], c.b[1]) + R, Math.max(c.a[2], c.b[2]) + R];
}

// ---- Seen from the camera ----------------------------------------------------------------------

// The depths (camera z, px, low to high) the dummy fills along the view ray
// through camera (x, y), each part grown by `pad` px; orthographic, as
// body.ts's inFront casts its rays. A capsule's span is the chord of the ray
// through its round, centred where the ray passes nearest its axis.
export function depthSpans(d: Dummy, xy: Vec2, pad = 0): [number, number][] {
  const out: [number, number][] = [];
  const b = d.body;
  const g = pad / b.unit;
  const egg = raySpan(toBody(b, [xy[0], xy[1], 0]), viewAxis(b), TORSO.a + g, TORSO.b + g, TORSO.c + g, TORSO.cy);
  if (egg) out.push([egg[0] * b.unit, egg[1] * b.unit]);
  for (const c of d.capsules) {
    const span = capsuleSpan(c, xy, c.r + pad);
    if (span) out.push(span);
  }
  return out.sort((p, q) => p[0] - q[0]);
}

// Is p (camera px) in front of every part the view ray through it meets?
// Missing them all, it is in front when nearer than his spine, as inFront has it.
export function frontOf(d: Dummy, p: Vec3): boolean {
  const spans = depthSpans(d, [p[0], p[1]]);
  if (spans.length === 0) return p[2] > 0;
  return spans.every(([, far]) => far <= p[2]);
}

// Is screen point xy (frame px) over his outline, widened by `pad` px? With a
// scan, his mask's; without, any part's (depthSpans, orthographic).
export function overOutline(d: Dummy, xy: Vec2, pad = 0): boolean {
  if (d.scan) return sdfAt(d.scan, xy[0], xy[1]) < pad;
  return depthSpans(d, xy, pad).length > 0;
}

// The depths his body fills on the view ray through p (camera px), grown by
// `pad` px, from the farthest of him to the nearest: with a scan, the spans
// where his mask (widened by `pad`) covers p's screen point; without, the
// parts' (depthSpans). Null off him.
export function bodySpan(d: Dummy, p: Vec3, pad = 0): [number, number] | null {
  const s = d.scan;
  if (!s) {
    const spans = depthSpans(d, [p[0], p[1]], pad);
    return spans.length === 0 ? null : [Math.min(...spans.map(([lo]) => lo)), Math.max(...spans.map(([, hi]) => hi))];
  }
  const [x, y] = project(s.body, p).xy;
  if (sdfAt(s, x, y) >= pad) return null;
  const sp = spansAt(s, x, y);
  return [sp[0] - pad, sp[sp.length - 1] + pad];
}

// A limb's front flags (its nodes in camera px, root first): in front where
// it is nearer than all of him the view ray through it meets (with a scan,
// the spans where his mask is). A run of nodes over none of him is seen either
// way, and a flip there would leave a cut end in the air, so it takes front
// when an over-body node next to it is in front, else behind: every flip
// falls where his body hides it. A limb over none of him is in front where
// it is nearer than his spine, as inFront has it.
export function frontFlags(d: Dummy, pts: readonly Vec3[]): boolean[] {
  const slabs = pts.map((p) => bodySpan(d, p));
  const raw = pts.map((p, i) => (slabs[i] === null ? p[2] > 0 : slabs[i]![1] <= p[2]));
  if (slabs.every((s) => s === null)) return raw;
  const out = raw.slice();
  for (let i = 0; i < pts.length; ) {
    if (slabs[i] !== null) {
      i++;
      continue;
    }
    let j = i;
    while (j < pts.length && slabs[j] === null) j++;
    const front = (i > 0 && raw[i - 1]) || (j < pts.length && raw[j]);
    for (let k = i; k < j; k++) out[k] = front;
    i = j;
  }
  return out;
}

// Along q + t·v the t where it enters and leaves an ellipsoid (centre (0, cy, 0)), or null.
function raySpan(q: Vec3, v: Vec3, a: number, b: number, c: number, cy: number): [number, number] | null {
  const o: Vec3 = [q[0] / a, (q[1] - cy) / b, q[2] / c];
  const w: Vec3 = [v[0] / a, v[1] / b, v[2] / c];
  const A = dot(w, w);
  const B = 2 * dot(o, w);
  const C = dot(o, o) - 1;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  return [(-B - s) / (2 * A), (-B + s) / (2 * A)];
}

// The z span (camera px) of the view ray through xy inside a capsule of radius R.
function capsuleSpan(c: Capsule, xy: Vec2, R: number): [number, number] | null {
  // Sample the axis finely enough for a smooth span: the ray is a line in z.
  let lo = Infinity;
  let hi = -Infinity;
  const steps = c.a === c.b ? 0 : 8;
  for (let k = 0; k <= steps; k++) {
    const q = steps === 0 ? c.a : mix(c.a, c.b, k / steps);
    const d2 = (xy[0] - q[0]) ** 2 + (xy[1] - q[1]) ** 2;
    if (d2 >= R * R) continue;
    const h = Math.sqrt(R * R - d2);
    lo = Math.min(lo, q[2] - h);
    hi = Math.max(hi, q[2] + h);
  }
  return lo <= hi ? [lo, hi] : null;
}

// A curve kept out of him by its depth alone (decision 17: the slammed limbs
// reach P round his side or over a shoulder, not through him). Each node
// keeps its place on screen. Along the curve (each node, and eighths of each
// segment, as insideDepth is checked along it) the free depths on the view
// ray are the gaps between the blocks of him there (with a scan, his mask's
// spans, else the parts', each grown by the limb's radius there and MARGIN),
// with the depths behind all of him and in front of all of him. The curve
// takes the path through them that moves it least (a path may go from one
// gap to the next only where they overlap in depth, so it never jumps
// through him, and a step in depth the curve doesn't take itself counts as
// a move): moved least from where the limb is now (`now`, its depth at
// node i, when given: so the curve keeps to its side of him from step to
// step instead of flipping through him), else from where the curve is, and
// leaving the root's zone on the side the root is on. So a curve that
// leaves his back stays behind him until it comes clear of him on screen (or
// into a gap between his parts), and comes round in front only there. Its
// nodes' depths are then put in their gaps and the segments' points in
// theirs, and the depth changes ease along the curve (smoothed over
// ROUTE_REACH of it each way) within them. `from`: the first node routed (the
// ones before it grow out of his back); the root is never moved. `free`: px
// from the root along the curve past which the points of the segment into
// `from` are routed too (the point at `free` itself among them, as the tube's
// flare ends there), the node before it moving with them: the root's zone
// ends at that distance, not at a node (missing: that segment is left as it
// is). The root's own segment is left as it is too (moving its far end can't
// clear its near end, and would only run it on through him), unless `own` is
// given: then its points past `free` are kept `own` px clear of him (not the
// radius and MARGIN: they grow out of his back), only its far end moving.
export function routeAround(d: Dummy, nodes: readonly Vec3[], radii: readonly number[], from = 1, now?: (i: number) => number, free = Infinity, own?: number): Vec3[] {
  const n = nodes.length;
  const b = d.scan?.body ?? d.body;
  const first = Math.max(1, from);
  if (first >= n) return nodes.map((p): Vec3 => [p[0], p[1], p[2]]);
  const [sx, sy, pad, z0, want] = [new Float64Array(n), new Float64Array(n), new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  for (let i = 0; i < n; i++) {
    const p = nodes[i];
    [sx[i], sy[i]] = project(b, p).xy;
    pad[i] = (radii[Math.min(i, radii.length - 1)] ?? 0) + MARGIN * b.unit;
    z0[i] = p[2];
    want[i] = now?.(i) ?? p[2];
  }
  // The free gaps (flat [lo, hi, …]) on the ray through point t of segment
  // i, onto the end of `into`.
  const gapsAt = (into: number[], i: number, t: number, grow?: number) => {
    const j = Math.min(i + 1, n - 1);
    const x = d.scan ? sx[i] + (sx[j] - sx[i]) * t : nodes[i][0] + (nodes[j][0] - nodes[i][0]) * t;
    const y = d.scan ? sy[i] + (sy[j] - sy[i]) * t : nodes[i][1] + (nodes[j][1] - nodes[i][1]) * t;
    into.push(-Infinity);
    blocksInto(d, x, y, grow ?? pad[i] + (pad[j] - pad[i]) * t, into);
    into.push(Infinity);
  };
  // The dense points (segment pi[k], point pt[k] along it) and their gaps
  // (all flat in `G`, point k's from go[k], gn[k] of them), from the points
  // of the segment into `first` past `free` of the root along the curve (the
  // one at `free` first) on.
  const pi: number[] = [];
  const pt: number[] = [];
  const go: number[] = [];
  const gn: number[] = [];
  const G: number[] = [];
  const dense = (i: number, t: number, grow?: number) => {
    pi.push(i);
    pt.push(t);
    go.push(G.length);
    gapsAt(G, i, t, grow);
    gn.push((G.length - go[go.length - 1]) >> 1);
  };
  const c = first - 1;
  if (free < Infinity && (c > 0 || own !== undefined)) {
    let along = 0;
    for (let i = 0; i < c; i++) along += dist(nodes[i], nodes[i + 1]);
    const l = dist(nodes[c], nodes[first]);
    const tf = l > 0 ? (free - along) / l : 1;
    const grow = c === 0 ? own : undefined;
    if (tf > 0 && tf < 1) dense(c, tf, grow);
    for (const t of DENSE) if (t > 0 && t > tf) dense(c, t, grow);
  }
  for (let i = first; i < n; i++) for (const t of i < n - 1 ? DENSE : [0]) dense(i, t);
  const m = pi.length;
  // The least-moving path through the gaps (Viterbi): `cost`, the least
  // move to dense point k in each of its gaps; `came` (from co[k]), the gap
  // it came from.
  const wantAt = (k: number) => (pt[k] === 0 ? want[pi[k]] : want[pi[k]] + (want[pi[k] + 1] - want[pi[k]]) * pt[k]);
  // The path starts in a gap that meets the one the root's zone ends in (on
  // its last node's ray, the nearest where his body as known swallows it).
  const rg: number[] = [];
  gapsAt(rg, first - 1, 0);
  let rs = 0;
  for (let q = 1; q < rg.length >> 1; q++) if (off(rg, 0, q, z0[first - 1]) < off(rg, 0, rs, z0[first - 1])) rs = q;
  let wide = 0;
  for (let k = 0; k < m; k++) wide = Math.max(wide, gn[k]);
  let cost: Float64Array = new Float64Array(wide);
  const next = new Float64Array(wide);
  let count = gn[0];
  let open = false;
  for (let q = 0; q < count; q++) {
    cost[q] = G[go[0] + 2 * q] < rg[2 * rs + 1] && rg[2 * rs] < G[go[0] + 2 * q + 1] ? off(G, go[0], q, wantAt(0)) : Infinity;
    open ||= cost[q] < Infinity;
  }
  if (!open) for (let q = 0; q < count; q++) cost[q] = off(G, go[0], q, z0[first - 1]) + off(G, go[0], q, wantAt(0));
  const co = new Int32Array(m);
  for (let k = 1; k < m; k++) co[k] = co[k - 1] + (k > 1 ? gn[k - 1] : 0);
  const came = new Int32Array(m > 1 ? co[m - 1] + gn[m - 1] : 0);
  const wants = new Float64Array(m);
  for (let k = 0; k < m; k++) wants[k] = wantAt(k);
  [cost, count] = leastMoves(G, go, gn, wants, co, came, cost, next, count);
  // Each dense point's gap, from the cheapest end back (the first of the
  // cheapest; none, NaN, read as the first gap on the way back).
  const gap = new Int32Array(m);
  let least = Infinity;
  for (let q = 0; q < count; q++) least = Number.isNaN(cost[q]) || Number.isNaN(least) ? NaN : Math.min(least, cost[q]);
  gap[m - 1] = -1;
  for (let q = 0; q < count; q++) {
    if (cost[q] !== least) continue;
    gap[m - 1] = q;
    break;
  }
  for (let k = m - 1; k > 0; k--) gap[k - 1] = Math.max(0, gap[k] >= 0 && gap[k] < gn[k] ? came[co[k] + gap[k]] : NaN);
  const lo = new Float64Array(m);
  const hi = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    const ok = gap[k] >= 0 && gap[k] < gn[k];
    const g0 = ok ? G[go[k] + 2 * gap[k]] : NaN;
    const g1 = ok ? G[go[k] + 2 * gap[k] + 1] : NaN;
    lo[k] = g0 + CLEAR;
    hi[k] = Math.max(g0 + CLEAR, g1 - CLEAR);
  }
  // Each node's own gap (its dense point's; none, ±∞, for a node without one).
  const nlo = new Float64Array(n).fill(-Infinity);
  const nhi = new Float64Array(n).fill(Infinity);
  for (let k = 0; k < m; k++) {
    if (pt[k] !== 0) continue;
    nlo[pi[k]] = lo[k];
    nhi[pi[k]] = hi[k];
  }
  const held = (i: number, v: number) => Math.min(nhi[i], Math.max(nlo[i], v));
  // The nodes in their gaps and the segments' points in theirs: each point
  // out of its gap moves both ends of its segment, until all are in.
  let z: Float64Array = new Float64Array(n);
  for (let i = 0; i < n; i++) z[i] = held(i, z0[i]);
  const settle = () => {
    for (let round = 0; round < ROUTE_ROUNDS; round++) {
      let moved = false;
      for (let k = 0; k < m; k++) {
        const t = pt[k];
        if (t === 0) continue;
        const i = pi[k];
        const v = z[i] + (z[i + 1] - z[i]) * t;
        const move = v < lo[k] ? lo[k] - v : v > hi[k] ? hi[k] - v : 0;
        if (move === 0) continue;
        if (i === 0) z[1] = held(1, z[1] + move / t); // the root's own segment: its far end takes the whole move
        else {
          z[i] = held(i, z[i] + move);
          z[i + 1] = held(i + 1, z[i + 1] + move);
        }
        moved = true;
      }
      if (!moved) return;
    }
  };
  settle();
  // A pass spreads a shift by half a node² of variance, so this many reach
  // ROUTE_REACH of the curve. A pass that changes nothing is where every
  // later one would leave it too: the rest are skipped.
  z = eased(z, z0, nlo, nhi, first, Math.round(2 * (ROUTE_REACH * (n - 1)) ** 2));
  settle();
  return nodes.map((p, i) => (z[i] === p[2] ? [p[0], p[1], p[2]] : unproject(b, [sx[i], sy[i]], z[i])));
}

// How far depth z is from gap s of the gaps (flat [lo, hi, …]) from `at` in g.
const off = (g: ArrayLike<number>, at: number, s: number, z: number) => (z < g[at + 2 * s] ? g[at + 2 * s] - z : z > g[at + 2 * s + 1] ? z - g[at + 2 * s + 1] : 0);

// The least-moving path's sweep (routeAround's Viterbi): from the first dense
// point's costs (`cost`, over its `count` gaps) on, the least move to each
// dense point k in each of its gaps (gn[k] of them in G from go[k]), and the
// gap of the point before it that it came from (`came`, from co[k]); `wants`
// is the depth each point wants. Gives the last point's costs and their count.
function leastMoves(G: readonly number[], go: readonly number[], gn: readonly number[], wants: Float64Array, co: Int32Array, came: Int32Array, cost: Float64Array, next: Float64Array, count: number): [Float64Array, number] {
  for (let k = 1; k < go.length; k++) {
    const a0 = go[k - 1];
    const a1 = go[k];
    const was = wants[k - 1];
    const here = wants[k];
    const size = gn[k];
    for (let s = 0; s < size; s++) {
      next[s] = Infinity;
      came[co[k] + s] = -1;
      for (let q = 0; q < count; q++) {
        if (!(cost[q] < Infinity)) continue;
        // A step in depth the curve doesn't take itself costs as much as the
        // move; a step from one gap to another that doesn't meet it goes
        // through him, and costs THROUGH per px of him: only where every way
        // on is shut (a held drawing he has turned into), and through the
        // thinnest of him.
        const through = Math.max(0, G[a1 + 2 * s] - G[a0 + 2 * q + 1], G[a0 + 2 * q] - G[a1 + 2 * s + 1]);
        const c = cost[q] + THROUGH * through + Math.max(0, Math.abs(clamp(here, G[a1 + 2 * s], G[a1 + 2 * s + 1]) - clamp(was, G[a0 + 2 * q], G[a0 + 2 * q + 1])) - Math.abs(here - was));
        if (!(c < next[s])) continue;
        next[s] = c;
        came[co[k] + s] = q;
      }
      next[s] += off(G, a1, s, here);
    }
    const done = cost;
    cost = next;
    next = done;
    count = size;
  }
  return [cost, count];
}

// The depth changes z − z0 eased along the curve (routeAround's), over at
// most `passes` passes: each moves every node from `first` on to the mean of
// its own change and its neighbours' (¼, ½, ¼; the last node keeps its own),
// held in its gap [lo, hi]. The nodes before `first` never move, so both
// buffers hold them as they are.
function eased(z: Float64Array, z0: Float64Array, lo: Float64Array, hi: Float64Array, first: number, passes: number): Float64Array {
  const n = z.length;
  let spare: Float64Array = z.slice();
  for (let pass = 0; pass < passes; pass++) {
    let same = true;
    let before = z[first - 1] - z0[first - 1];
    let here = z[first] - z0[first];
    for (let i = first; i < n - 1; i++) {
      const after = z[i + 1] - z0[i + 1];
      const v = Math.min(hi[i], Math.max(lo[i], z0[i] + (0.25 * before + 0.5 * here + 0.25 * after)));
      if (same && !sameValue(v, z[i])) same = false;
      spare[i] = v;
      before = here;
      here = after;
    }
    const v = Math.min(hi[n - 1], Math.max(lo[n - 1], z0[n - 1] + here));
    if (same && !sameValue(v, z[n - 1])) same = false;
    spare[n - 1] = v;
    const done = z;
    z = spare;
    spare = done;
    if (same) break;
  }
  return z;
}

// Object.is for two numbers, inline.
const sameValue = (a: number, b: number) => (a === b ? a !== 0 || 1 / a === 1 / b : a !== a && b !== b);

const MARGIN = 0.02; // torso units of room a routed curve leaves round him
const THROUGH = 1000; // what a px of him a routed curve steps through costs, against a px of depth it moves
const ROUTE_REACH = 0.25; // the share of the curve a depth change eases over each way (one standard deviation: 120 passes on 32 nodes)
const ROUTE_ROUNDS = 24; // rounds a routing's points take at most to settle in their gaps
const CLEAR = 0.01; // px a routed point is kept inside its gap
const DENSE = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]; // a node and the points along the segment after it a routing keeps clear

// The blocks of him (flat [lo, hi, …], camera px, low to high and apart) on
// the view ray through screen point (x, y) (camera x, y without a scan), each
// of his spans grown by `pad` and those that then meet taken as one, onto the
// end of `into`; none off him. A scan's spans are low to high and apart
// already, so they are grown and joined in one sweep.
function blocksInto(d: Dummy, x: number, y: number, pad: number, into: number[]): void {
  const s = d.scan;
  if (s) {
    if (sdfAt(s, x, y) >= pad) return;
    const sp = spansAt(s, x, y);
    let last = -1;
    for (let k = 0; k < sp.length; k += 2) {
      const lo = sp[k] - pad;
      const hi = sp[k + 1] + pad;
      if (last >= 0 && lo <= into[last]) into[last] = Math.max(into[last], hi);
      else {
        into.push(lo, hi);
        last = into.length - 1;
      }
    }
    return;
  }
  const spans = depthSpans(d, [x, y], pad);
  if (spans.length > 0) for (const v of merged(spans.flat(), 0)) into.push(v);
}

// Is a screen point over the egg's outline?
function overTorso(b: Body3D, xy: Vec2): boolean {
  return raySpan(toBody(b, [xy[0], xy[1], 0]), viewAxis(b), TORSO.a, TORSO.b, TORSO.c, TORSO.cy) !== null;
}

// The camera's +z in the egg's frame, one torso unit long per torso unit.
const viewAxis = (b: Body3D): Vec3 => toBody(b, [b.x, b.y, b.unit]);


// ---- The pre-scan (decision 18) ------------------------------------------------------------------

// Frame f's scan: his mask's field (fieldOf), with the dummy its depth spans
// come from. Null when the mask is empty.
export function scanOf(m: Mask, width: number, height: number, d: Dummy): Scan | null {
  const field = fieldOf(m, width, height);
  return field ? { body: d.body, capsules: d.capsules, ...field, slabs: new Map() } : null;
}

// A mask's signed distance field, as a scan holds it.
type Field = Omit<Scan, 'body' | 'capsules' | 'slabs'>;

// The mask sampled at the centres of a SCAN_CELL grid, its box found, and the
// signed distance field worked out over the box grown by SCAN_MARGIN (exact
// Euclidean distances between cell centres, the edge taken halfway between an
// inside and an outside cell); null when the mask is empty. Worked out once
// per mask and clip size and kept with the mask (decision 18: the pre-scan is
// the clip's, so a new physics run on the same masks reuses it); only the
// depth spans, which the body's pose sets, are each scan's own.
function fieldOf(m: Mask, width: number, height: number): Field | null {
  const key = `${width}x${height}`;
  let kept = fields.get(m);
  if (!kept) fields.set(m, (kept = new Map()));
  const hit = kept.get(key);
  if (hit !== undefined) return hit;
  const field = scanField(m, width, height);
  kept.set(key, field);
  return field;
}
const fields = new WeakMap<Mask, Map<string, Field | null>>();

function scanField(m: Mask, width: number, height: number): Field | null {
  const cell = SCAN_CELL * width;
  const margin = SCAN_MARGIN * width;
  const W = Math.ceil(width / cell);
  const H = Math.ceil(height / cell);
  // The mask's column and row under each cell's centre.
  const col = Int32Array.from({ length: W }, (_, c) => Math.min(m.width - 1, Math.floor(((c + 0.5) * cell * m.width) / width)));
  const row = Int32Array.from({ length: H }, (_, r) => Math.min(m.height - 1, Math.floor(((r + 0.5) * cell * m.height) / height)) * m.width);
  // His box, from every other cell (a sliver it misses is within the margin).
  let [c0, r0, c1, r1] = [W, H, -1, -1];
  for (let r = 0; r < H; r += 2) {
    for (let c = 0; c < W; c += 2) {
      if (m.alpha[row[r] + col[c]] < INSIDE) continue;
      if (c < c0) c0 = c;
      if (c > c1) c1 = c;
      if (r < r0) r0 = r;
      if (r > r1) r1 = r;
    }
  }
  if (c1 < 0) return null;
  const grow = Math.ceil(margin / cell) + 2;
  [c0, r0, c1, r1] = [c0 - grow, r0 - grow, c1 + grow, r1 + grow];
  const cols = c1 - c0 + 1;
  const rows = r1 - r0 + 1;
  // Off the frame he goes on as he is at its edge.
  const inside = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const at = row[Math.min(H - 1, Math.max(0, r0 + r))];
    for (let c = 0; c < cols; c++) inside[r * cols + c] = m.alpha[at + col[Math.min(W - 1, Math.max(0, c0 + c))]] >= INSIDE ? 1 : 0;
  }
  const toIn = distances(inside, cols, rows, 1);
  const toOut = distances(inside, cols, rows, 0);
  const sdf = new Float32Array(cols * rows);
  for (let i = 0; i < sdf.length; i++) sdf[i] = (inside[i] ? 0.5 - Math.sqrt(toOut[i]) : Math.sqrt(toIn[i]) - 0.5) * cell;
  return { x0: (c0 + 0.5) * cell, y0: (r0 + 0.5) * cell, cell, cols, rows, margin, sdf };
}

// The field at screen point (x, y), bilinear between cell centres.
function sdfAt(s: Scan, x: number, y: number): number {
  const u = (x - s.x0) / s.cell;
  const v = (y - s.y0) / s.cell;
  if (!(u >= 0 && v >= 0 && u <= s.cols - 1 && v <= s.rows - 1)) return s.margin;
  const i = Math.min(s.cols - 2, Math.floor(u));
  const j = Math.min(s.rows - 2, Math.floor(v));
  const [a, b] = [u - i, v - j];
  const k = j * s.cols + i;
  return (1 - b) * ((1 - a) * s.sdf[k] + a * s.sdf[k + 1]) + b * ((1 - a) * s.sdf[k + s.cols] + a * s.sdf[k + s.cols + 1]);
}

// The way out of him at (x, y): the field's gradient, unit length (null on a flat).
function outward(s: Scan, x: number, y: number): Vec2 | null {
  const h = s.cell;
  const gx = sdfAt(s, x + h, y) - sdfAt(s, x - h, y);
  const gy = sdfAt(s, x, y + h) - sdfAt(s, x, y - h);
  const l = Math.hypot(gx, gy);
  return l > 1e-9 ? [gx / l, gy / l] : null;
}

// The spans (camera px, flat [lo, hi, …], low to high and apart) his parts
// fill on the view rays through the four cell centres round screen point
// (x, y), taken together (cellSpans): so they have no holes between the cells
// and err on his side, and a gap between two of his parts stays a gap. Kept
// per four cells, under keys below the cells' own.
function spansAt(s: Scan, x: number, y: number): Float64Array {
  const c = Math.floor((x - s.x0) / s.cell);
  const r = Math.floor((y - s.y0) / s.cell);
  const key = -1 - ((r + 1) * (s.cols + 2) + c + 1);
  const hit = s.slabs.get(key);
  if (hit) return hit;
  const a = cellSpans(s, c, r);
  const b = cellSpans(s, c + 1, r);
  const e = cellSpans(s, c, r + 1);
  const f = cellSpans(s, c + 1, r + 1);
  const all = flatBuffer(a.length + b.length + e.length + f.length);
  all.set(a, 0);
  all.set(b, a.length);
  all.set(e, a.length + b.length);
  all.set(f, a.length + b.length + e.length);
  const out = merged(all, 0, a.length + b.length + e.length + f.length);
  s.slabs.set(key, out);
  return out;
}

// One cell's spans: the egg's and each capsule's chord (camera px) on the
// view ray through its centre, those that overlap taken as one, or where none
// of them reach it (loose clothes, hair, an arm the pose missed: still his
// mask), the nearest part's depth ± its radius there. Weak perspective: each
// part is met where the ray passes it at its own depth. The parts are seen
// from the scan's body once (seenParts), and a capsule whose samples are all
// further off on screen than its radius can reach is passed over.
function cellSpans(s: Scan, c: number, r: number): Float64Array {
  const key = (r + 1) * (s.cols + 2) + c + 1; // only cells on and round his mask are asked for
  const hit = s.slabs.get(key);
  if (hit) return hit;
  const X = s.x0 + c * s.cell;
  const Y = s.y0 + r * s.cell;
  const b = s.body;
  const seen = seenParts(s);
  const spans = flatBuffer(2 + 2 * seen.parts.length);
  let m = 0;
  // The egg, met at its centre's depth: raySpan(toBody(unproject(…))), as
  // the trig and the gain are the scan's (seenParts).
  {
    const ax = b.x + (X - b.x) / seen.gain;
    const ay = b.y + (Y - b.y) / seen.gain;
    const [cr, sr, cy, sy, cp, sp] = seen.trig;
    let x = (ax - b.x) / b.unit;
    let y = (ay - b.y) / b.unit;
    let z = 0 / b.unit;
    [x, y] = [cr * x + sr * y, -sr * x + cr * y];
    [x, z] = [cy * x - sy * z, sy * x + cy * z];
    [y, z] = [cp * y - sp * z, sp * y + cp * z];
    const [o0, o1, o2] = [x / TORSO.a, (y - TORSO.cy) / TORSO.b, z / TORSO.c];
    const [w0, w1, w2] = seen.w;
    const A = w0 * w0 + w1 * w1 + w2 * w2;
    const B = 2 * (o0 * w0 + o1 * w1 + o2 * w2);
    const C = o0 * o0 + o1 * o1 + o2 * o2 - 1;
    const disc = B * B - 4 * A * C;
    if (disc >= 0) {
      const q = Math.sqrt(disc);
      spans[m++] = ((-B - q) / (2 * A)) * b.unit;
      spans[m++] = ((-B + q) / (2 * A)) * b.unit;
    }
  }
  for (const part of seen.parts) {
    if (!part.solid || X < part.box[0] || X > part.box[2] || Y < part.box[1] || Y > part.box[3]) continue;
    let [lo, hi] = [Infinity, -Infinity];
    for (let i = 0; i < part.x.length; i++) {
      const d2 = ((X - part.x[i]) ** 2 + (Y - part.y[i]) ** 2) / part.g2[i];
      if (d2 >= part.rr) continue;
      const h = Math.sqrt(part.rr - d2);
      [lo, hi] = [Math.min(lo, part.z[i] - h), Math.max(hi, part.z[i] + h)];
    }
    if (lo <= hi) {
      spans[m++] = lo;
      spans[m++] = hi;
    }
  }
  if (m === 0) {
    // None reach it: the nearest part's depth ± its radius there (its spine,
    // a capsule as wide as the egg, among them).
    let near = { gap: Infinity, z: seen.centre[2], deep: seen.parts[0].deep };
    for (const part of seen.parts) {
      for (let i = 0; i < part.x.length; i++) {
        const gap = Math.sqrt(((X - part.x[i]) ** 2 + (Y - part.y[i]) ** 2) / part.g2[i]) - part.r;
        if (gap < near.gap) near = { gap, z: part.z[i], deep: part.deep };
      }
    }
    spans[m++] = near.z - near.deep;
    spans[m++] = near.z + near.deep;
  }
  const out = merged(spans, 0, m);
  s.slabs.set(key, out);
  return out;
}

// The parts as a scan's body sees them (cellSpans'): the egg's spine as a
// capsule as wide as it (for the nearest part only), then each capsule, each
// sampled at nine points along its axis (a sphere at one), with each sample's
// screen point, its perspective gain squared and its depth; and the screen box
// past which no sample's round reaches (grown by its radius × the largest
// gain, and a px). Worked out once per scan.
interface SeenPart {
  r: number;
  rr: number; // r²
  deep: number;
  solid: boolean;
  x: Float64Array;
  y: Float64Array;
  g2: Float64Array;
  z: Float64Array;
  box: [number, number, number, number];
}
interface Seen {
  centre: Vec3;
  gain: number; // unproject's at the centre's depth
  trig: readonly [number, number, number, number, number, number]; // the body's cos and sin of its roll, yaw and pitch (unrotate's)
  w: Vec3; // the view axis over the egg's semi-axes (raySpan's)
  parts: SeenPart[];
}
const seenOf = new WeakMap<Scan, Seen>();
let lastSeen: { s: Scan; seen: Seen } | null = null;

function seenParts(s: Scan): Seen {
  if (lastSeen?.s === s) return lastSeen.seen;
  const hit = seenOf.get(s);
  if (hit) {
    lastSeen = { s, seen: hit };
    return hit;
  }
  const b = s.body;
  const spine = { a: toCamera(b, [0, TORSO.cy - TORSO.b + TORSO.a, 0]), b: toCamera(b, [0, TORSO.cy + TORSO.b - TORSO.a, 0]), r: TORSO.a * b.unit, deep: TORSO.c * b.unit, solid: false };
  const parts = [spine, ...s.capsules.map((q) => ({ a: q.a, b: q.b, r: q.r, deep: q.r, solid: true }))].map((part): SeenPart => {
    const steps = part.a === part.b ? 0 : 8;
    const [x, y, g2, z] = [new Float64Array(steps + 1), new Float64Array(steps + 1), new Float64Array(steps + 1), new Float64Array(steps + 1)];
    let gMax = 0;
    for (let i = 0; i <= steps; i++) {
      const q = steps === 0 ? part.a : mix(part.a, part.b, i / steps);
      const { xy, near: g } = project(b, q);
      [x[i], y[i], g2[i], z[i]] = [xy[0], xy[1], g * g, q[2]];
      gMax = Math.max(gMax, g);
    }
    const reach = part.r * gMax + 1;
    const box: [number, number, number, number] = [Math.min(...x) - reach, Math.min(...y) - reach, Math.max(...x) + reach, Math.max(...y) + reach];
    return { r: part.r, rr: part.r * part.r, deep: part.deep, solid: part.solid, x, y, g2, z, box };
  });
  const centre = toCamera(b, [0, TORSO.cy, 0]);
  const view = viewAxis(b);
  const trig = [Math.cos(b.roll), Math.sin(b.roll), Math.cos(b.yaw), Math.sin(b.yaw), Math.cos(b.pitch), Math.sin(b.pitch)] as const;
  const seen: Seen = { centre, gain: project(b, [0, 0, centre[2]]).near, trig, w: [view[0] / TORSO.a, view[1] / TORSO.b, view[2] / TORSO.c], parts };
  seenOf.set(s, seen);
  lastSeen = { s, seen };
  return seen;
}

// Spans (flat [lo, hi, …], any order; the first `length` of `flat`) each
// grown by `grow`, sorted (stably, by their low ends), and those that overlap
// or touch taken as one.
function merged(flat: ArrayLike<number>, grow: number, length = flat.length): Float64Array {
  const m = length >> 1;
  const order = orderBuffer(m);
  for (let k = 0; k < m; k++) {
    // Insertion: the lists are short.
    let j = k - 1;
    while (j >= 0 && flat[2 * order[j]] - flat[2 * k] > 0) {
      order[j + 1] = order[j];
      j--;
    }
    order[j + 1] = k;
  }
  const out = new Float64Array(2 * m);
  let n = 0;
  for (let q = 0; q < m; q++) {
    const k = order[q];
    const [lo, hi] = [flat[2 * k] - grow, flat[2 * k + 1] + grow];
    if (n > 0 && lo <= out[n - 1]) out[n - 1] = Math.max(out[n - 1], hi);
    else {
      out[n++] = lo;
      out[n++] = hi;
    }
  }
  return n === out.length ? out : out.slice(0, n);
}

// Scratch buffers for the spans, reused: nothing that fills one calls back in.
let orders = new Int32Array(64);
let flats = new Float64Array(64);
const orderBuffer = (m: number) => (m <= orders.length ? orders : (orders = new Int32Array(2 * m)));
function flatBuffer(m: number): Float64Array {
  if (m > flats.length) flats = new Float64Array(2 * m);
  return flats;
}

// The block of him depth z is inside (his spans `sp` grown by r, those that
// then meet taken as one), or null where z is clear of them: between two, or
// past them all. A depth on a block's face is clear.
function blockAt(sp: ArrayLike<number>, z: number, r: number): [number, number] | null {
  for (let k = 0; k < sp.length; k += 2) {
    const lo = sp[k] - r;
    if (z <= lo) return null;
    let hi = sp[k + 1] + r;
    while (k + 2 < sp.length && sp[k + 2] - r < hi) {
      k += 2;
      hi = Math.max(hi, sp[k + 1] + r);
    }
    if (z < hi) return [lo, hi];
  }
  return null;
}

// The block of him (as blockAt has them) that lies wholly between depths a
// and b, the one nearest a; null when there is none, so a point gone from a
// to b on this ray went round him, not through him.
function between(sp: ArrayLike<number>, a: number, b: number, r: number): [number, number] | null {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  let found: [number, number] | null = null;
  for (let k = 0; k < sp.length; k += 2) {
    const L = sp[k] - r;
    let H = sp[k + 1] + r;
    while (k + 2 < sp.length && sp[k + 2] - r < H) {
      k += 2;
      H = Math.max(H, sp[k + 1] + r);
    }
    if (L >= lo && H <= hi) {
      if (a < b) return [L, H];
      found = [L, H];
    }
  }
  return found;
}

// p (camera px) out of the scanned body by `r` px of limb round it, the
// shortest way its memory allows (`last`, the depth where it was last clear
// of him: out of the block it is in on that side, behind it or in front of
// it, when that face is within `reach` px, MEMORY_REACH by default; NaN, or
// further, either): sideways is across his outline along the field's
// gradient, when that comes clear of him (not into a gap narrower than the
// limb, say between his arm and his side), and is always allowed, since it
// keeps the depth. With how far that is (px) and which way it went (−1
// behind, +1 in front, 0 sideways). Null when it's out: its screen point,
// widened by r, is off his mask, or its depth is in none of the blocks of
// him there (each of his spans grown by r).
export function scanPush(s: Scan, p: Vec3, r: number, last = NaN, reach = MEMORY_REACH * s.body.unit): { out: Vec3; depth: number; way: Side } | null {
  const b = s.body;
  const [x, y] = project(b, p).xy;
  const sd = sdfAt(s, x, y);
  if (sd >= r) return null;
  const block = blockAt(spansAt(s, x, y), p[2], r);
  if (!block) return null;
  const mid = (block[0] + block[1]) / 2;
  const known = Number.isFinite(last);
  const back = known && last > mid && block[1] - p[2] <= reach ? Infinity : p[2] - block[0];
  const front = known && last <= mid && p[2] - block[0] <= reach ? Infinity : block[1] - p[2];
  let across = Infinity;
  let to: Vec2 = [x, y];
  if (r - sd < Math.min(back, front)) {
    // Along the gradient, and on from there while that isn't clear yet (the
    // field is only piecewise linear): SIDE_STEPS at most, and clear within
    // a tenth of a cell.
    let [qx, qy, moved, left] = [x, y, 0, sd];
    for (let k = 0; k < SIDE_STEPS && left < r; k++) {
      const way = outward(s, qx, qy);
      if (!way) break;
      [qx, qy, moved] = [qx + way[0] * (r - left), qy + way[1] * (r - left), moved + r - left];
      left = sdfAt(s, qx, qy);
    }
    const rr = Math.max(0, r - 0.1 * s.cell);
    if (moved > 0 && (left >= rr || !blockAt(spansAt(s, qx, qy), p[2], rr))) [across, to] = [moved, [qx, qy]];
  }
  if (across < back && across < front) return { out: unproject(b, to, p[2]), depth: across, way: 0 };
  return back <= front ? { out: unproject(b, [x, y], block[0]), depth: back, way: -1 } : { out: unproject(b, [x, y], block[1]), depth: front, way: 1 };
}
const SIDE_STEPS = 3; // steps along the field a sideways push takes at most

// The squared distance (cells²) from each cell of a cols × rows grid to the
// nearest cell whose `grid` value is `to` (Felzenszwalb and Huttenlocher's
// exact transform: columns, then rows). The columns are swept down and up
// the grid row by row, each to its nearest such cell, which gives the same
// squares exactly; a column with none takes the transform's own answer.
function distances(grid: Uint8Array, cols: number, rows: number, to: number): Float64Array {
  const FAR = 1e20;
  const d = new Float64Array(cols * rows);
  const n = Math.max(cols, rows);
  const f = new Float64Array(n);
  const g = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const h = new Float64Array(n);
  const last = new Int32Array(cols).fill(-1);
  for (let r = 0; r < rows; r++) {
    for (let c = 0, i = r * cols; c < cols; c++, i++) {
      if (grid[i] === to) last[c] = r;
      d[i] = last[c] < 0 ? Infinity : r - last[c];
    }
  }
  const next = last.fill(-1);
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = 0, i = r * cols; c < cols; c++, i++) {
      if (grid[i] === to) next[c] = r;
      const e = next[c] < 0 || d[i] <= next[c] - r ? d[i] : next[c] - r;
      d[i] = e * e;
    }
  }
  for (let c = 0; c < cols; c++) {
    if (next[c] >= 0) continue;
    f.fill(FAR, 0, rows);
    lowerEnvelope(f, rows, g, v, z, h);
    for (let r = 0; r < rows; r++) d[r * cols + c] = g[r];
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) f[c] = d[r * cols + c];
    lowerEnvelope(f, cols, g, v, z, h);
    for (let c = 0; c < cols; c++) d[r * cols + c] = g[c];
  }
  return d;
}

// One line of the transform: d[q] = min over p of (q − p)² + f[p]. `h`
// keeps each kept parabola's f[p] + p², worked out once.
function lowerEnvelope(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array, h: Float64Array) {
  let k = 0;
  v[0] = 0;
  h[0] = f[0] + 0 * 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    const fq = f[q] + q * q;
    let s = (fq - h[k]) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (fq - h[k]) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    h[k] = fq;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const e = q - v[k];
    d[q] = e * e + f[v[k]];
  }
}

// ---- The mask ------------------------------------------------------------------------------------

// The mask's half-width across segment A→B at its middle, clip px: how far
// the person runs each way along its normal. When one way runs much farther
// (into his torso), the nearer is the edge. A sphere (the head) measures
// across the screen. `max`: how far to look.
function halfWidth(m: Mask, width: number, height: number, A: Vec2, B: Vec2, sphere: boolean, max: number): number | null {
  const sx = m.width / width;
  const sy = m.height / height;
  const on = (x: number, y: number) => {
    const col = Math.floor(x * sx);
    const row = Math.floor(y * sy);
    return col >= 0 && row >= 0 && col < m.width && row < m.height && m.alpha[row * m.width + col] >= INSIDE;
  };
  const mid: Vec2 = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
  if (!on(mid[0], mid[1])) return null;
  const l = Math.hypot(B[0] - A[0], B[1] - A[1]);
  const nrm: Vec2 = sphere || l < 1e-6 ? [1, 0] : [-(B[1] - A[1]) / l, (B[0] - A[0]) / l];
  const step = Math.max(0.5, 1 / Math.min(sx, sy));
  const run = (s: number) => {
    let t = 0;
    while (t < max && on(mid[0] + nrm[0] * s * (t + step), mid[1] + nrm[1] * s * (t + step))) t += step;
    return t;
  };
  const a = run(1);
  const b = run(-1);
  const near = Math.min(a, b);
  return Math.max(a, b) > 1.6 * near + 2 * step ? near : (a + b) / 2;
}

// ---- Over time ------------------------------------------------------------------------------------

// Missing frames filled linearly between the frames on either side, held at
// the ends; `fallback` where there is none at all.
function fillTrack(track: (Vec3 | null)[], fallback: Vec3): Vec3[] {
  const known = track.map((p, f) => (p ? f : -1)).filter((f) => f >= 0);
  if (known.length === 0) return track.map(() => [fallback[0], fallback[1], fallback[2]]);
  return track.map((p, f) => {
    if (p) return p;
    let k = 0;
    while (k < known.length && known[k] < f) k++;
    if (k === 0) return track[known[0]]!;
    if (k === known.length) return track[known[known.length - 1]]!;
    const [f0, f1] = [known[k - 1], known[k]];
    return mix(track[f0]!, track[f1]!, (f - f0) / (f1 - f0));
  });
}

function smoothTrack(track: Vec3[], reach: number): Vec3[] {
  return track.map((_, f) => {
    let w = 0;
    const s: Vec3 = [0, 0, 0];
    for (let g = Math.max(0, f - reach); g <= Math.min(track.length - 1, f + reach); g++) {
      const k = reach + 1 - Math.abs(g - f);
      w += k;
      for (let i = 0; i < 3; i++) s[i] += track[g][i] * k;
    }
    return [s[0] / w, s[1] / w, s[2] / w];
  });
}

function medianTrack(values: (number | null)[], reach: number): (number | null)[] {
  return values.map((_, f) => {
    const near: number[] = [];
    for (let g = Math.max(0, f - reach); g <= Math.min(values.length - 1, f + reach); g++) if (values[g] !== null) near.push(values[g]!);
    if (near.length === 0) return null;
    near.sort((x, y) => x - y);
    return near[near.length >> 1];
  });
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dist = (a: Vec3, b: Vec3) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
const mix = (a: Vec3, b: Vec3, w: number): Vec3 => [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w];
