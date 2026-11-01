// The limb's tube (impact design §2, "Geometry"): a held limb drawing made
// into a 3D tube that limb.ts cel-shades, arcs3d.ts wraps and the posters
// take the silhouette of. Pure maths, no canvas.
//   1. Densify: centripetal Catmull–Rom through the held points and their
//      depths, three sections per segment, so 32 points give 94 sections.
//   2. Frame: T by central differences, then N and B by double reflection
//      (Wang et al. 2008), from N0 = the screen normal at the root. The
//      frame turns as little as it can, so an angle round the tube means the
//      same thing all along it and nothing wound round it twists.
//   3. Radius: R(t, p) = max(0.8 px, R0·(1 + 0.22·max(0, 1 − t/0.14)²)·(1 − t)^taper·(0.75 + 0.25p)),
//      t the arc fraction and p the pressure: a flared root and a fine tip.
//   4. Section vectors (sectionVectors): S, across the projected tube in the
//      screen plane, and Q, the cross-section's most camera-facing
//      direction. A surface point at angle ψ has the normal cos ψ·Q + sin ψ·S
//      and sits u = sin ψ radii across the projected centreline, so a cel test
//      N·X ≥ τ is a closed interval of u (bandInterval): no per-pixel work.
// The held drawing is already projected: its points are where the camera
// sees them, and the lift has widened nearer points through their pressure.
// So a section's centre is (screen x, screen y, camera z), and the tube is
// shaded and offset orthographically, with the view along +z. The clip's weak
// perspective keeps the gain within ±5 % of 1 (limbs3d §2.3).
//
// Occlusion: chunks splits the tube into front and behind runs on the held
// points' front flags, and moves each flip to where the projected centreline
// crosses the person mask's edge when that is within 6 sections. The stand-in
// body is smaller than the mask (his hair, his arms), so without the snap a
// limb visibly ends inside his hair (the f92 and f104 bleed).
import type { HeldLimb, Tube, TubeSection, Vec2, Vec3 } from '../impact/contracts.ts';
import type { Mask } from '../track/tracking.ts';

export const PIECES = 3; // sections per held segment: 32 points → 94 sections
export const ROOT_FLARE = 0.22; // the root is this much wider ...
export const FLARE_REACH = 0.14; // ... easing off by this arc fraction
export const TAPER = 0.55; // (1 − t)^taper: limb.taper's default
export const MIN_RADIUS = 0.8; // px: the tip tapers to this
export const SNAP_REACH = 6; // sections: how far a front/behind flip moves to the mask's edge
const INSIDE = 128; // mask alpha from which a pixel is the person
const EDGE_STEPS = 12; // bisection steps along a segment for the edge: far below a pixel

// ---- Radius --------------------------------------------------------------------------

export function radiusAt(t: number, p: number, R0: number, taper = TAPER): number {
  const flare = 1 + ROOT_FLARE * Math.max(0, 1 - t / FLARE_REACH) ** 2;
  const pressure = Math.min(1, Math.max(0, p));
  return Math.max(MIN_RADIUS, R0 * flare * Math.max(0, 1 - t) ** taper * (0.75 + 0.25 * pressure));
}

// ---- Building the tube ------------------------------------------------------------------

export interface TubeOptions {
  taper?: number; // the radius's falloff exponent; missing = 0.55
  pieces?: number; // sections per held segment; missing = 3
}

// `R0` is the root radius before the flare, px: limb.radius·S·(size/28)
// (limbR0 in render/limb.ts).
export function buildTube(held: HeldLimb, R0: number, opts: TubeOptions = {}): Tube {
  const count = held.points.length;
  if (count < 2) throw new Error(`buildTube needs 2 or more points (limb ${held.id} has ${count})`);
  for (const [name, list] of [['z', held.z], ['pressure', held.pressure], ['front', held.front]] as const) {
    if (list.length !== count) throw new Error(`limb ${held.id}: ${name} has ${list.length} values for ${count} points`);
  }
  const pieces = opts.pieces ?? PIECES;
  const taper = opts.taper ?? TAPER;
  const pts = held.points.map((p, i): Vec3 => [p[0], p[1], held.z[i]]);

  // 1. Densify.
  const c: Vec3[] = [];
  const pressure: number[] = [];
  const front: boolean[] = [];
  for (let i = 0; i < count - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p3 = pts[Math.min(count - 1, i + 2)];
    for (let j = 0; j < pieces; j++) {
      const u = j / pieces;
      c.push(catmullRom(p0, pts[i], pts[i + 1], p3, u));
      pressure.push(held.pressure[i] + (held.pressure[i + 1] - held.pressure[i]) * u);
      front.push(u < 0.5 ? held.front[i] : held.front[i + 1]); // the flag flips halfway between points
    }
  }
  c.push(pts[count - 1]);
  pressure.push(held.pressure[count - 1]);
  front.push(held.front[count - 1]);
  const m = c.length;

  const along = [0];
  for (let i = 1; i < m; i++) along.push(along[i - 1] + len(sub(c[i], c[i - 1])));
  const length = along[m - 1];
  const s = along.map((a, i) => (length > 0 ? a / length : i / (m - 1)));

  // 2. Frame. Tangents by central differences; a coincident run keeps the last one.
  const T: Vec3[] = [];
  for (let i = 0; i < m; i++) {
    const d = sub(c[Math.min(m - 1, i + 1)], c[Math.max(0, i - 1)]);
    T.push(len(d) > 1e-9 ? unit(d) : (T[i - 1] ?? [1, 0, 0]));
  }
  for (let i = m - 2; i >= 0; i--) if (len(sub(c[Math.min(m - 1, i + 1)], c[Math.max(0, i - 1)])) <= 1e-9) T[i] = T[i + 1]; // a coincident start takes the first real tangent
  const normals = screenNormals(T);
  const N: Vec3[] = [[normals[0][0], normals[0][1], 0]]; // the screen normal is ⟂ T whatever T's depth
  for (let i = 0; i < m - 1; i++) N.push(reflectAlong(c[i], c[i + 1], T[i], T[i + 1], N[i]));

  const sections = c.map(
    (centre, i): TubeSection => ({
      c: centre,
      T: T[i],
      N: N[i],
      B: cross(T[i], N[i]),
      r: radiusAt(s[i], pressure[i], R0, taper),
      s: s[i],
      front: front[i],
      screen: [centre[0], centre[1]],
      normal: normals[i],
    }),
  );
  return { id: held.id, sections, length };
}

// A held limb with no depth, for a drawing that was never lifted (the 2D
// brush path): the tube lies in the screen plane, facing the camera.
export function flatHeld(id: number, points: Vec2[], pressure: number[], front = true): HeldLimb {
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return { id, points: points.map((p): Vec2 => [p[0], p[1]]), z: points.map(() => 0), pressure: [...pressure], front: points.map(() => front), length };
}

// The point u (0..1) of the way from p1 to p2 on the centripetal Catmull–Rom
// curve (Barry and Goldman's form, as render/brush.ts draws it in 2D): it
// never loops or overshoots between unevenly spaced points.
function catmullRom(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, u: number): Vec3 {
  const knot = (a: Vec3, b: Vec3) => Math.max(Math.sqrt(len(sub(b, a))), 1e-6);
  const t1 = knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const t = t1 + (t2 - t1) * u;
  const mix = (a: Vec3, b: Vec3, ta: number, tb: number): Vec3 => {
    const w = (t - ta) / (tb - ta);
    return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w];
  };
  const a1 = mix(p0, p1, 0, t1);
  const a2 = mix(p1, p2, t1, t2);
  const a3 = mix(p2, p3, t2, t3);
  return mix(mix(a1, a2, 0, t2), mix(a2, a3, t1, t3), t1, t2);
}

// The projected centreline's unit normals: each tangent's screen part turned
// to (−ty, tx). A section seen end-on has no screen direction and takes its
// neighbour's.
function screenNormals(T: Vec3[]): Vec2[] {
  const out: (Vec2 | null)[] = T.map(([tx, ty]) => {
    const l = Math.hypot(tx, ty);
    return l > 1e-6 ? [-ty / l, tx / l] : null;
  });
  let last: Vec2 | null = out.find((n) => n !== null) ?? [0, 1];
  return out.map((n) => (last = n ?? last) as Vec2);
}

// One step of the double-reflection rotation-minimizing frame: reflect across
// the plane bisecting x0 → x1, then across the one that takes the reflected
// tangent onto t1.
function reflectAlong(x0: Vec3, x1: Vec3, t0: Vec3, t1: Vec3, r0: Vec3): Vec3 {
  const v1 = sub(x1, x0);
  const c1 = dot(v1, v1);
  if (c1 < 1e-12) return orthonormal(r0, t1);
  const rL = sub(r0, scale(v1, (2 / c1) * dot(v1, r0)));
  const tL = sub(t0, scale(v1, (2 / c1) * dot(v1, t0)));
  const v2 = sub(t1, tL);
  const c2 = dot(v2, v2);
  return orthonormal(c2 < 1e-12 ? rL : sub(rL, scale(v2, (2 / c2) * dot(v2, rL))), t1);
}

// r made exactly perpendicular to t and unit, against rounding drift.
function orthonormal(r: Vec3, t: Vec3): Vec3 {
  const q = sub(r, scale(t, dot(r, t)));
  return len(q) > 1e-12 ? unit(q) : unit(cross(t, Math.abs(t[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));
}

// ---- Shading -------------------------------------------------------------------------

// S, across the projected tube (u = +1 is the `normal` side), and Q, the
// cross-section's most camera-facing direction: (V − (V·T)T)/|T_xy|, written
// with the screen tangent so it stays exact when T points at the camera.
export function sectionVectors(sec: TubeSection): { S: Vec3; Q: Vec3 } {
  const [nx, ny] = sec.normal;
  const [tx, ty, tz] = sec.T;
  return { S: [nx, ny, 0], Q: [-tz * ny, tz * nx, Math.hypot(tx, ty)] };
}

// The u-interval (u = sin ψ, −1..1 across the projected tube) where N·X ≥ τ
// on the visible half of the section, or null where there is none. X is a
// unit direction toward the light. With ρ = |(X·S, X·Q)| and ψX = atan2(X·S, X·Q),
// N·X = ρ·cos(ψ − ψX), so the band is ψX ± acos(τ/ρ), clipped to ψ in
// [−90°, 90°]. Lit from behind it can come out in two pieces, one at each
// edge: the wider one is kept (limb.ts's rim covers the other edge).
export function bandInterval(sec: TubeSection, X: Vec3, tau: number): [number, number] | null {
  const { S, Q } = sectionVectors(sec);
  const a = dot(S, X);
  const b = dot(Q, X);
  const rho = Math.hypot(a, b);
  if (rho < 1e-9) return tau <= 0 ? [-1, 1] : null; // lit along the tube: the whole of it is at N·X = 0
  const c = tau / rho;
  if (c >= 1) return null;
  if (c <= -1) return [-1, 1];
  const psi = Math.atan2(a, b);
  const half = Math.acos(c);
  const edge = Math.PI / 2;
  let best: [number, number] | null = null;
  for (const wrap of [-2 * Math.PI, 0, 2 * Math.PI]) {
    const lo = Math.max(-edge, psi - half + wrap);
    const hi = Math.min(edge, psi + half + wrap);
    if (hi <= lo) continue;
    const u: [number, number] = [Math.sin(lo), Math.sin(hi)];
    if (!best || u[1] - u[0] > best[1] - best[0]) best = u;
  }
  return best;
}

// ---- Along the tube --------------------------------------------------------------------

// The section at fractional index x (2.5 is halfway from section 2 to 3), its
// fields interpolated and its directions renormalized.
export function sectionAt(tube: Tube, x: number): TubeSection {
  const secs = tube.sections;
  const last = secs.length - 1;
  if (x <= 0 || last === 0) return secs[0];
  if (x >= last) return secs[last];
  const i = Math.floor(x);
  const w = x - i;
  if (w === 0) return secs[i];
  const a = secs[i];
  const b = secs[i + 1];
  const mix3 = (p: Vec3, q: Vec3): Vec3 => [p[0] + (q[0] - p[0]) * w, p[1] + (q[1] - p[1]) * w, p[2] + (q[2] - p[2]) * w];
  const n: Vec2 = [a.normal[0] + (b.normal[0] - a.normal[0]) * w, a.normal[1] + (b.normal[1] - a.normal[1]) * w];
  const nl = Math.hypot(n[0], n[1]) || 1;
  const T = unit(mix3(a.T, b.T));
  const N = orthonormal(mix3(a.N, b.N), T);
  return {
    c: mix3(a.c, b.c),
    T,
    N,
    B: cross(T, N),
    r: a.r + (b.r - a.r) * w,
    s: a.s + (b.s - a.s) * w,
    front: w < 0.5 ? a.front : b.front,
    screen: [a.screen[0] + (b.screen[0] - a.screen[0]) * w, a.screen[1] + (b.screen[1] - a.screen[1]) * w],
    normal: [n[0] / nl, n[1] / nl],
  };
}

// The fractional index where the arc fraction reaches s.
export function indexAt(tube: Tube, s: number): number {
  const secs = tube.sections;
  const last = secs.length - 1;
  if (s <= secs[0].s) return 0;
  if (s >= secs[last].s) return last;
  let i = 1;
  while (secs[i].s < s) i++;
  const span = secs[i].s - secs[i - 1].s;
  return i - 1 + (span > 0 ? (s - secs[i - 1].s) / span : 0);
}

// ---- Front and behind -----------------------------------------------------------------

// A run of sections on one side of him, from and to fractional section
// indices, both included.
export interface Chunk {
  front: boolean;
  from: number;
  to: number;
}

// The tube's front and behind runs, root first. Each flip sits halfway
// between the two sections whose flags differ, or, with a mask, on the
// nearest place within SNAP_REACH sections where the projected centreline
// crosses the mask's edge. A behind run reaches one section past each of its
// flips: that stretch lies under the front run (the behind layer is drawn
// under it), so no seam shows where they meet, and the front run never pokes
// into the person. `scale` is mask px per frame px.
export function chunks(tube: Tube, mask?: Mask | null, scale = 1): Chunk[] {
  const secs = tube.sections;
  const last = secs.length - 1;
  let flips: { at: number; front: boolean }[] = [];
  for (let i = 0; i < last; i++) if (secs[i].front !== secs[i + 1].front) flips.push({ at: i + 0.5, front: secs[i + 1].front });
  if (mask && flips.length > 0) {
    const crossings = edgeCrossings(tube, mask, scale);
    flips = flips.map((f) => {
      let best: number | null = null;
      for (const x of crossings) if (Math.abs(x - f.at) <= SNAP_REACH && (best === null || Math.abs(x - f.at) < Math.abs(best - f.at))) best = x;
      return { ...f, at: best ?? f.at };
    });
    // Two flips snapped onto (or past) each other leave nothing between them: drop both.
    for (let k = 1; k < flips.length; ) {
      if (flips[k].at <= flips[k - 1].at + 1e-6) flips.splice(k - 1, 2);
      else k++;
    }
  }
  const runs: Chunk[] = [];
  let from = 0;
  let front = secs[0].front;
  for (const f of flips) {
    runs.push({ front, from, to: f.at });
    from = f.at;
    front = f.front;
  }
  runs.push({ front, from, to: last });
  return runs.map((r) => (r.front ? r : { front: false, from: r.from > 0 ? Math.max(0, r.from - 1) : 0, to: r.to < last ? Math.min(last, r.to + 1) : last }));
}

// Is this frame px on the person? Off the mask counts as not.
export function onMask(mask: Mask, scale: number, x: number, y: number): boolean {
  const col = Math.floor(x * scale);
  const row = Math.floor(y * scale);
  if (col < 0 || row < 0 || col >= mask.width || row >= mask.height) return false;
  return mask.alpha[row * mask.width + col] >= INSIDE;
}

// Every place the projected centreline crosses the mask's edge, as
// fractional section indices.
function edgeCrossings(tube: Tube, mask: Mask, scale: number): number[] {
  const secs = tube.sections;
  const inside = secs.map((s) => onMask(mask, scale, s.screen[0], s.screen[1]));
  const out: number[] = [];
  for (let i = 0; i < secs.length - 1; i++) {
    if (inside[i] === inside[i + 1]) continue;
    const [ax, ay] = secs[i].screen;
    const [bx, by] = secs[i + 1].screen;
    let lo = 0; // on the same side as section i
    let hi = 1;
    for (let k = 0; k < EDGE_STEPS; k++) {
      const mid = (lo + hi) / 2;
      if (onMask(mask, scale, ax + (bx - ax) * mid, ay + (by - ay) * mid) === inside[i]) lo = mid;
      else hi = mid;
    }
    out.push(i + (lo + hi) / 2);
  }
  return out;
}

// ---- Silhouette ----------------------------------------------------------------------------

const CAP_STEPS = 8; // points on each round end

// The tube's outline on screen, one closed polygon for the posters and the
// pinned stamps: the `normal` edge from root to tip, round over the tip, the
// other edge back, round over the root. `pad` widens it all round, px.
export function silhouette(tube: Tube, pad = 0): Vec2[] {
  const secs = tube.sections;
  const edge = (sec: TubeSection, side: number): Vec2 => [sec.screen[0] + sec.normal[0] * side * (sec.r + pad), sec.screen[1] + sec.normal[1] * side * (sec.r + pad)];
  // Half a turn round a section from its `normal` side, through `ahead` (+1
  // the way to the tip, −1 back toward the root), to its other side.
  const cap = (sec: TubeSection, ahead: number): Vec2[] => {
    const [nx, ny] = sec.normal;
    const tx = ny * ahead; // the screen tangent, (ny, −nx), the way of `ahead`
    const ty = -nx * ahead;
    const R = sec.r + pad;
    const out: Vec2[] = [];
    for (let q = 1; q < CAP_STEPS; q++) {
      const a = (Math.PI * q) / CAP_STEPS;
      const side = ahead > 0 ? 1 : -1; // the root's cap runs from the other side back to the normal side
      out.push([sec.screen[0] + R * (side * Math.cos(a) * nx + Math.sin(a) * tx), sec.screen[1] + R * (side * Math.cos(a) * ny + Math.sin(a) * ty)]);
    }
    return out;
  };
  const out: Vec2[] = secs.map((s) => edge(s, 1));
  out.push(...cap(secs[secs.length - 1], 1));
  for (let i = secs.length - 1; i >= 0; i--) out.push(edge(secs[i], -1));
  out.push(...cap(secs[0], -1));
  return out;
}

// ---- Small vector helpers ------------------------------------------------------------------

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => scale(a, 1 / (len(a) || 1));
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
