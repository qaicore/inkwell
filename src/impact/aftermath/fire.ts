// The flame burst (impact design §6, "Fire, A0–A2"), and the plumbing every
// aftermath mass layer shares (fire, cluster, dust, wisps, debris):
//   - the mass clock: the hold group a frame is in, the reference age that
//     group stands for, the decay, and the size factor under the zoom;
//   - the mass frame: positions are (n, t) from P, n up the floor (floor.up)
//     and t across it, signed toward the side the strike travels, so a strike
//     from the other side mirrors the whole aftermath;
//   - a grid of 0.01 U cells for the area targets, and the shape list a layer
//     hands the stack and the tests.
// Sizes are in U = σ·S × aftermath.scale. Every mass size is also × 1.08/zoom
// at its group's first frame (design §6, "Sizes under the zoom"): the camera
// relaxes from 1.08 to 1, and this keeps the masses at the reference's screen
// size meanwhile. Being read at the group's first frame keeps a group's shapes
// identical on every frame it holds.
//
// The burst itself is one star-shaped polygon around P: a radius for every
// angle across the fan (−85°..+67° from n̂), the larger of a core and a few
// teardrop tongues rooted at P. That makes the union of the tongues a single
// path with one ink line. Its area is scaled to the measured target exactly,
// and the core is sized by bisection so the centroid lands on the measured
// curve (A0 0.067 U² at n 0.14; A1–2 0.22 U² at n 0.30). The radial
// gradient is five nested bands, flat cel steps from #fffc7c to #fefc07.
import type { Vec2 } from '../../types/effect.ts';
import type { GlowSink, ImpactContext } from '../contracts.ts';
import type { BrushTarget } from '../../render/glow.ts';
import { drawingIndex } from '../../motion/timing.ts';
import { decayAlpha, drawingStart, kr, massGroup, zoomAt } from '../clock.ts';
import { floorFrame } from '../floor.ts';
import { FIRE, mixHex, roles } from '../palette.ts';
import { int, rng, uniform, type Rng } from '../rng.ts';

// ---- The mass clock (design §0 "Hold groups", §6 "Decay and the time map") ----------

// An ImpactContext, plus the global drawing rate when it isn't 12.
export type MassContext = ImpactContext & { dps?: number };
export const MASS_DPS = 12;

// Each measured hold group's first reference age (A = kr − 14): g0 {14},
// g1 {15,16}, g2 {17,18}, g3 {19,20}, g4 {21,22}, g5 {23,24,25}, g6 {26,27,28},
// g7 {29,30}, g8 {31}. Groups past g8 hold g8's parameters.
export const GROUP_AGE = [0, 1, 3, 5, 7, 9, 12, 15, 17] as const;
export const LAST_MEASURED = 8;
export const CARRY_FROM = 6; // from g6 on, each group carries over into the next
export const ZOOM_PEAK = 1.08;

export interface MassClock {
  j: number; // f − I
  g: number; // the hold group: 0..8 measured, 9 and up in the hold span and the decay
  start: number; // the group's first frame
  A: number; // the reference age the group stands for (g8's past g8)
  alpha: number; // decayAlpha(j, J_end): 1 until J_end − 14, exactly 0 at J_end
  zoom: number; // every mass size × this: 1.08/zoom at the group's first frame
}

// The mass clock on frame f, or null where no mass shows: before j 9, and
// after J_end. At J_end itself the alpha is exactly 0.
export function massClock(ictx: MassContext, f: number): MassClock | null {
  const j = f - ictx.I;
  if (j < 9 || j > ictx.jEnd) return null;
  const dps = ictx.dps ?? MASS_DPS;
  const g = massGroup(f, ictx.I, dps) as number;
  let start = f;
  while (start - 1 - ictx.I >= 9 && massGroup(start - 1, ictx.I, dps) === g) start--;
  return { j, g, start, A: GROUP_AGE[Math.min(g, LAST_MEASURED)], alpha: decayAlpha(j, ictx.jEnd), zoom: ZOOM_PEAK / zoomAt(start - ictx.I) };
}

// The first visible frame of the global drawing that holds frame f, and its
// reference age: the clock of the strict-2s layers (the wisps).
export function drawingAge(ictx: MassContext, f: number): { k: number; start: number; A: number } {
  const dps = ictx.dps ?? MASS_DPS;
  const k = drawingIndex(f, dps);
  const start = Math.max(drawingStart(k, dps), ictx.I + 9);
  return { k, start, A: kr(start - ictx.I) - 14 };
}

// ---- The mass frame --------------------------------------------------------------------

// A point on the floor frame: n up the floor from P, t across it, in mass units.
export type FloorPt = [n: number, t: number];

export interface MassFrame {
  P: Vec2;
  n: Vec2; // up the floor, on screen
  t: Vec2; // across it, toward the strike's side
  side: 1 | -1; // t = side × floorFrame's t̂
  U: number; // px per U: σ·S × aftermath.scale
  beta: number; // the strike's tilt off −n̂ toward +t, radians, within ±20°: the cluster leans by it
}

const MAX_LEAN = (20 * Math.PI) / 180;

// The burst, the cluster and the dust are sized at least as the reference's
// are against its frame (judge round 1): U × max(scale, BURST_SIGMA/σ), σ =
// U/S, so a figure who fills the frame doesn't shrink the destruction round
// him. The washes, the lightning and the rest keep U × scale, and so does
// Reduce flashing (decision 12): there the burst stays his size, behind him,
// so its flare leaving moves no 10° field on its own.
export const BURST_SIGMA = 0.85;

export function massFrame(ictx: ImpactContext, grown = false): MassFrame {
  const { P, n, t } = floorFrame(ictx.frame.P, ictx.floor);
  const sigma = ictx.frame.U / ictx.frame.S;
  const scale = grown && sigma > 0 && ictx.flash !== 'safe' ? Math.max(ictx.aftermath.scale, BURST_SIGMA / sigma) : ictx.aftermath.scale;
  const u = ictx.frame.u;
  const along = u[0] * t[0] + u[1] * t[1];
  const side: 1 | -1 = along >= 0 ? 1 : -1;
  const down = Math.abs(u[0] * n[0] + u[1] * n[1]);
  const beta = Math.max(-MAX_LEAN, Math.min(MAX_LEAN, Math.atan2(Math.abs(along), Math.max(down, 1e-9))));
  return { P, n, t: [side * t[0], side * t[1]], side, U: ictx.frame.U * scale, beta };
}

// A floor-frame point to frame px, at `unit` px per mass unit.
export function toFrame(fr: MassFrame, unit: number, [n, t]: FloorPt): Vec2 {
  return [fr.P[0] + unit * (n * fr.n[0] + t * fr.t[0]), fr.P[1] + unit * (n * fr.n[1] + t * fr.t[1])];
}

// Frame px back to the floor frame (the inverse of toFrame).
export function toFloor(fr: MassFrame, unit: number, [x, y]: Vec2): FloorPt {
  const dx = (x - fr.P[0]) / unit;
  const dy = (y - fr.P[1]) / unit;
  return [dx * fr.n[0] + dy * fr.n[1], dx * fr.t[0] + dy * fr.t[1]];
}

// What a mass layer's shapes depend on besides its own clock: the cache keys
// start with it, so two scenes never share a key.
export function massKey(ictx: ImpactContext): string {
  const fr = massFrame(ictx);
  const v = (p: Vec2, d: number) => `${p[0].toFixed(d)},${p[1].toFixed(d)}`;
  return [ictx.seed, `${ictx.width}x${ictx.height}`, v(fr.P, 2), v(fr.n, 5), v(fr.t, 5), fr.U.toFixed(3), fr.beta.toFixed(5), ictx.tier, ictx.palette.join(',')].join(':');
}

// ---- What a mass layer draws -------------------------------------------------------------

export interface MassShape {
  role: string; // what it is: 'body', 'lick', 'lobe', 'ball', 'puff', 'chunk', … (tests and sheets read it)
  points: Vec2[]; // a closed polygon, frame px
  color: string;
  alpha?: number; // its own opacity, × the drawing's; missing = 1
  round?: boolean; // drawn with curves through the edge midpoints (fillOutline): discs, puffs, petals
}

export interface MassDrawing {
  layer: 'behind' | 'front';
  key: string; // equal keys draw equal shapes; the alpha is apart, so a cached copy can be faded
  alpha: number; // the whole drawing's opacity on this frame
  shapes: MassShape[]; // in paint order
}

// Paints a drawing's shapes in order. `opaque` paints at full opacity, for a
// cached layer the stack fades by drawing.alpha itself. A run of consecutive
// shapes in one colour and opacity is filled as one path: the same pixels
// where they're opaque, no seam where they overlap, and a translucent run
// reads as one sheet rather than darkening where its pieces cross. Every
// subpath is traced the same way round, so nonzero fill keeps the union.
export function paint(ctx: BrushTarget, drawing: MassDrawing | null, opaque = false) {
  if (!drawing) return;
  const base = opaque ? 1 : drawing.alpha;
  if (!(base > 0)) return;
  const alpha = ctx.globalAlpha;
  const shapes = drawing.shapes;
  let set = alpha;
  for (let i = 0; i < shapes.length; ) {
    const s = shapes[i];
    const own = s.alpha ?? 1;
    let j = i + 1;
    while (j < shapes.length && shapes[j].color === s.color && (shapes[j].alpha ?? 1) === own) j++;
    const a = base * own;
    if (a > 0) {
      if (alpha * a !== set) ctx.globalAlpha = set = alpha * a;
      ctx.fillStyle = s.color;
      ctx.beginPath();
      for (let q = i; q < j; q++) if (shapes[q].points.length >= 3) trace(ctx, shapes[q].points, shapes[q].round === true);
      ctx.fill();
    }
    i = j;
  }
  if (set !== alpha) ctx.globalAlpha = alpha;
}

// One closed subpath, traced with a positive shoelace sum: straight edges, or
// (round) the curve through the edge midpoints that brush.ts's fillOutline
// draws.
function trace(ctx: BrushTarget, pts: readonly Vec2[], round: boolean) {
  const n = pts.length;
  let area = 0;
  for (let i = 0, k = n - 1; i < n; k = i++) area += pts[k][0] * pts[i][1] - pts[i][0] * pts[k][1];
  const at = area >= 0 ? (i: number) => pts[i % n] : (i: number) => pts[(n - 1 - (i % n)) % n];
  if (round) {
    const a = at(0);
    const b = at(1);
    ctx.moveTo((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    for (let i = 1; i <= n; i++) {
      const p = at(i);
      const q = at(i + 1);
      ctx.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
    }
  } else {
    const a = at(0);
    ctx.moveTo(a[0], a[1]);
    for (let i = 1; i < n; i++) {
      const p = at(i);
      ctx.quadraticCurveTo(p[0], p[1], p[0], p[1]);
    }
  }
  ctx.closePath();
}

// A polygon with straight edges (PathTarget has no lineTo: a quadratic with its
// control point on the end point is a straight line).
export function fillPolygon(ctx: BrushTarget, points: Vec2[], color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) ctx.quadraticCurveTo(points[i][0], points[i][1], points[i][0], points[i][1]);
  ctx.closePath();
  ctx.fill();
}

// A disc (or an ellipse stretched `stretch` times along `angle`, radians from
// n̂ toward t) as a polygon in the floor frame. fillOutline's curves run
// through the edge midpoints, inside the vertices, so the vertices sit out by
// 1/cos(π/count): the midpoints then land on the radius and the curve stays
// within 0.1 % of it.
export function ellipsePts(c: FloorPt, r: number, count = 16, stretch = 1, angle = 0): FloorPt[] {
  const fix = 1 / Math.cos(Math.PI / count);
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const out: FloorPt[] = [];
  for (let i = 0; i < count; i++) {
    const th = (2 * Math.PI * i) / count;
    const a = r * fix * stretch * Math.cos(th);
    const b = r * fix * Math.sin(th);
    out.push([c[0] + a * ca - b * sa, c[1] + a * sa + b * ca]);
  }
  return out;
}

// A vertex count that keeps a disc of r px smooth without wasting work: the
// midpoint curve of 8 vertices is already within 0.3 % of the circle, so 8
// up to r 12 px, 12 up to r 25 px, and so on.
export const discCount = (rPx: number) => Math.max(8, Math.min(28, 4 * Math.round(Math.sqrt(Math.max(1, rPx)) * 0.7)));

// ---- The grid: 0.01 U cells over t −1.25..1.25, n −0.5..1.25 -------------------------------

export const CELL = 0.01;
const T_MIN = -1.25;
const N_MIN = -0.5;
export const COLS = 250;
export const ROWS = 175;
export type Grid = Uint8Array; // 1 where covered
export const newGrid = (): Grid => new Uint8Array(COLS * ROWS);
export const cellN = (i: number) => N_MIN + (i + 0.5) * CELL;
export const cellT = (k: number) => T_MIN + (k + 0.5) * CELL;
const firstRow = (n: number) => Math.max(0, Math.ceil((n - N_MIN) / CELL - 0.5));
const lastRow = (n: number) => Math.min(ROWS - 1, Math.floor((n - N_MIN) / CELL - 0.5));
const firstCol = (t: number) => Math.max(0, Math.ceil((t - T_MIN) / CELL - 0.5));
const lastCol = (t: number) => Math.min(COLS - 1, Math.floor((t - T_MIN) / CELL - 0.5));

export const VISIBLE_REACH = 1.2; // U: the visible union is measured within this of P
// Per row, the columns within VISIBLE_REACH of P (k0 > k1 when none).
const REACH_K0 = new Int32Array(ROWS);
const REACH_K1 = new Int32Array(ROWS);
for (let i = 0; i < ROWS; i++) {
  const cn = cellN(i);
  let k0 = COLS;
  let k1 = -1;
  for (let k = 0; k < COLS; k++) {
    const ct = cellT(k);
    if (cn * cn + ct * ct > VISIBLE_REACH * VISIBLE_REACH) continue;
    k0 = Math.min(k0, k);
    k1 = Math.max(k1, k);
  }
  REACH_K0[i] = k0;
  REACH_K1[i] = k1;
}

// What a disc would add: the cells it covers that `grid` doesn't yet and
// `hidden` doesn't hide, within VISIBLE_REACH of P: count, Σn, Σt.
export function discGain(grid: Grid, hidden: Grid | null, n: number, t: number, r: number): { area: number; n: number; t: number } {
  let count = 0;
  let sn = 0;
  let sk = 0;
  const r2 = r * r;
  for (let i = firstRow(n - r), i1 = lastRow(n + r); i <= i1; i++) {
    const cn = cellN(i);
    const dn = cn - n;
    const half = Math.sqrt(Math.max(0, r2 - dn * dn));
    const row = i * COLS;
    let c = 0;
    for (let k = Math.max(firstCol(t - half), REACH_K0[i]), k1 = Math.min(lastCol(t + half), REACH_K1[i]); k <= k1; k++) {
      const at = row + k;
      if (grid[at] || (hidden && hidden[at])) continue;
      c++;
      sk += k;
    }
    count += c;
    sn += c * cn;
  }
  const st = count * (T_MIN + 0.5 * CELL) + sk * CELL;
  return { area: count * CELL * CELL, n: sn * CELL * CELL, t: st * CELL * CELL };
}

// Each row of cells a disc covers (stampDisc's cells), as a column span
// k0..k1 cut to VISIBLE_REACH.
export function forDiscRows(n: number, t: number, r: number, visit: (i: number, k0: number, k1: number) => void) {
  const r2 = r * r;
  for (let i = firstRow(n - r), i1 = lastRow(n + r); i <= i1; i++) {
    const dn = cellN(i) - n;
    const half = Math.sqrt(Math.max(0, r2 - dn * dn));
    const k0 = Math.max(firstCol(t - half), REACH_K0[i]);
    const k1 = Math.min(lastCol(t + half), REACH_K1[i]);
    if (k1 >= k0) visit(i, k0, k1);
  }
}

export function stampDisc(grid: Grid, n: number, t: number, r: number) {
  const r2 = r * r;
  for (let i = firstRow(n - r), i1 = lastRow(n + r); i <= i1; i++) {
    const dn = cellN(i) - n;
    const half = Math.sqrt(Math.max(0, r2 - dn * dn));
    grid.fill(1, i * COLS + firstCol(t - half), i * COLS + lastCol(t + half) + 1);
  }
}

// An ellipse with semi-axes a (along `angle` from n̂ toward t) and b.
export function stampEllipse(grid: Grid, c: FloorPt, a: number, b: number, angle: number) {
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const reach = Math.max(a, b);
  for (let i = firstRow(c[0] - reach), i1 = lastRow(c[0] + reach); i <= i1; i++) {
    const dn = cellN(i) - c[0];
    for (let k = firstCol(c[1] - reach), k1 = lastCol(c[1] + reach); k <= k1; k++) {
      const dt = cellT(k) - c[1];
      const u = (dn * ca + dt * sa) / a;
      const v = (-dn * sa + dt * ca) / b;
      if (u * u + v * v <= 1) grid[i * COLS + k] = 1;
    }
  }
}

// A closed polygon, by scanline (even-odd).
export function stampPolygon(grid: Grid, poly: readonly FloorPt[]) {
  if (poly.length < 3) return;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of poly) {
    lo = Math.min(lo, p[0]);
    hi = Math.max(hi, p[0]);
  }
  const xs: number[] = [];
  for (let i = firstRow(lo), i1 = lastRow(hi); i <= i1; i++) {
    const cn = cellN(i);
    xs.length = 0;
    for (let e = 0; e < poly.length; e++) {
      const a = poly[e];
      const b = poly[(e + 1) % poly.length];
      if (a[0] <= cn === b[0] <= cn) continue;
      xs.push(a[1] + ((cn - a[0]) / (b[0] - a[0])) * (b[1] - a[1]));
    }
    xs.sort((p, q) => p - q);
    for (let m = 0; m + 1 < xs.length; m += 2) {
      const k0 = firstCol(xs[m]);
      const k1 = lastCol(xs[m + 1]);
      if (k1 >= k0) grid.fill(1, i * COLS + k0, i * COLS + k1 + 1);
    }
  }
}

// The covered cells less the hidden ones, within VISIBLE_REACH: area (U²) and centroid.
export function gridStats(grid: Grid, hidden: Grid | null = null): { area: number; n: number; t: number } {
  let count = 0;
  let sn = 0;
  let sk = 0;
  for (let i = 0; i < ROWS; i++) {
    const row = i * COLS;
    let c = 0;
    if (hidden) {
      for (let at = row + REACH_K0[i], end = row + REACH_K1[i]; at <= end; at++) {
        if (grid[at] && !hidden[at]) {
          c++;
          sk += at - row;
        }
      }
    } else {
      for (let at = row + REACH_K0[i], end = row + REACH_K1[i]; at <= end; at++) {
        if (grid[at]) {
          c++;
          sk += at - row;
        }
      }
    }
    count += c;
    sn += c * cellN(i);
  }
  return count ? { area: count * CELL * CELL, n: sn / count, t: T_MIN + 0.5 * CELL + (sk / count) * CELL } : { area: 0, n: 0, t: 0 };
}

// Intersection over union of two grids' covered cells, each less its own hidden cells.
export function gridIoU(a: Grid, b: Grid, hideA: Grid | null = null, hideB: Grid | null = null): number {
  let both = 0;
  let either = 0;
  for (let at = 0; at < a.length; at++) {
    const x = a[at] && !(hideA && hideA[at]);
    const y = b[at] && !(hideB && hideB[at]);
    if (x && y) both++;
    if (x || y) either++;
  }
  return either ? both / either : 0;
}

// The cell under (n, t), or −1 off the grid.
export function cellAt(n: number, t: number): number {
  const i = Math.floor((n - N_MIN) / CELL);
  const k = Math.floor((t - T_MIN) / CELL);
  return i < 0 || i >= ROWS || k < 0 || k >= COLS ? -1 : i * COLS + k;
}
export const inGrid = (grid: Grid, n: number, t: number): boolean => {
  const at = cellAt(n, t);
  return at >= 0 && grid[at] === 1;
};

// The cells inside a closed polygon that `hidden` and `cover` leave visible,
// within VISIBLE_REACH, in U² (stampPolygon's scanline, counting).
export function polygonCount(poly: readonly FloorPt[], hidden: Grid | null, cover: Grid | null): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of poly) {
    lo = Math.min(lo, p[0]);
    hi = Math.max(hi, p[0]);
  }
  const xs: number[] = [];
  let count = 0;
  for (let i = firstRow(lo), i1 = lastRow(hi); i <= i1; i++) {
    const cn = cellN(i);
    xs.length = 0;
    for (let e = 0; e < poly.length; e++) {
      const a = poly[e];
      const b = poly[(e + 1) % poly.length];
      if (a[0] <= cn === b[0] <= cn) continue;
      xs.push(a[1] + ((cn - a[0]) / (b[0] - a[0])) * (b[1] - a[1]));
    }
    xs.sort((p, q) => p - q);
    for (let m = 0; m + 1 < xs.length; m += 2) {
      for (let at = i * COLS + Math.max(firstCol(xs[m]), REACH_K0[i]), end = i * COLS + Math.min(lastCol(xs[m + 1]), REACH_K1[i]); at <= end; at++) {
        if (!(hidden && hidden[at]) && !(cover && cover[at])) count++;
      }
    }
  }
  return count * CELL * CELL;
}

// a | b, into a new grid.
export function gridOr(a: Grid, b: Grid): Grid {
  const out = new Uint8Array(a.length);
  for (let at = 0; at < a.length; at++) out[at] = a[at] | b[at];
  return out;
}

// The last covered point along the ray from P at φ (radians from n̂ toward
// t), out to VISIBLE_REACH: the outer silhouette, for outlines.
export function rayReach(grid: Grid, phi: number, step = CELL / 2): number {
  const cn = Math.cos(phi);
  const st = Math.sin(phi);
  let last = 0;
  for (let rho = step; rho <= VISIBLE_REACH; rho += step) if (inGrid(grid, rho * cn, rho * st)) last = rho;
  return last;
}

// The first uncovered point along the ray from P: the star-shaped part of a
// mass seen from P ends there.
export function rayExit(grid: Grid, phi: number, step = CELL / 2): number {
  const cn = Math.cos(phi);
  const st = Math.sin(phi);
  let rho = step;
  while (rho <= VISIBLE_REACH && inGrid(grid, rho * cn, rho * st)) rho += step;
  return rho - step;
}

// ---- Small helpers -------------------------------------------------------------------------

// A bounded memo: a group's shapes are worked out once and held while the
// group shows (and while the next group carries from it).
export function memo<T>(cache: Map<string, T>, key: string, make: () => T, cap = 40): T {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const value = make();
  if (cache.size >= cap) cache.delete(cache.keys().next().value as string);
  cache.set(key, value);
  return value;
}

// 0..n−1 in a seeded order (Fisher–Yates).
export function shuffled(n: number, r: Rng): number[] {
  const out = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const k = Math.floor(r() * (i + 1));
    [out[i], out[k]] = [out[k], out[i]];
  }
  return out;
}

// A point jittered uniformly within a disc of radius `reach`.
export function jitter(r: Rng, [n, t]: FloorPt, reach: number): FloorPt {
  const a = 2 * Math.PI * r();
  const d = reach * Math.sqrt(r());
  return [n + d * Math.cos(a), t + d * Math.sin(a)];
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// The area of a polygon (shoelace), in its own units².
export function polygonArea(pts: readonly (readonly [number, number])[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}

// ---- The burst (A0–A2) --------------------------------------------------------------------

const DEG = Math.PI / 180;
export const FAN: readonly [number, number] = [-85 * DEG, 67 * DEG]; // from n̂, + toward the strike's side
const FIRE_AREA = [0.067, 0.22]; // U²: A0, A1–2
// The visible centroid's n on g0 and g1 (design §6, "Where the mass sits"). g1
// aims 0.01 U low: the dust's first rims cover its base and lift what shows.
const FIRE_CENTROID = [0.14, 0.29];
const FIRE_LINE = 0.0065; // U: the olive-brown ink line, 3–5 px on the reference
const STEPS = 120; // radius samples across the fan
const BANDS = [0.45, 0.38, 0.31, 0.23]; // U: the gradient's cel steps, out to in, saturated to pale

interface Tongue {
  phi: number; // radians from n̂
  reach: number; // U
  width: number; // angular half-width, radians
  lick: boolean; // a flat orange lick at its tip
}

export interface FireStar {
  phis: number[]; // sample angles across the fan
  radii: number[]; // the star's radius at each, U
  tongues: Tongue[];
  scale: number; // what the raw radii were scaled by to hit the area
}

// A tongue's profile. Neighbouring tongues overlap (A1–2: 16–19° either
// side, 24–33° apart), so the rim between them never drops to the core: one
// billowing silhouette, not petals (judge round 1). The side tongues are a
// little shorter to keep the measured centroid with the wider ones.
const bump = (d: number, w: number) => (Math.abs(d) >= w ? 0 : Math.cos((Math.abs(d) / w) * (Math.PI / 2)) ** 0.7);

function tonguesFor(burst: boolean, r: Rng): Tongue[] {
  if (!burst) {
    // A0, the crown: tongues at −74° (0.42 U) and +8° (0.54 U), and 6–10 smaller billows of 0.25–0.54 U.
    const out: Tongue[] = [
      { phi: uniform(r, -76, -72) * DEG, reach: uniform(r, 0.4, 0.44), width: uniform(r, 18, 22) * DEG, lick: true },
      { phi: uniform(r, 6, 10) * DEG, reach: uniform(r, 0.52, 0.56), width: uniform(r, 16, 20) * DEG, lick: true },
    ];
    for (let i = int(r, 6, 10); i > 0; i--) {
      out.push({ phi: uniform(r, -78, 60) * DEG, reach: 0.25 + 0.29 * r() ** 2, width: uniform(r, 12, 16) * DEG, lick: false });
    }
    return out;
  }
  // A1–2, the burst: 5 tongues 24–33° apart, the two longest within ±14° of n̂.
  const a = uniform(r, -14, -12);
  const b = uniform(r, 12, 14);
  const c = Math.max(-80, a - uniform(r, 24, 33));
  const d = Math.max(-80, c - uniform(r, 24, 33));
  const e = Math.min(60, b + uniform(r, 24, 33));
  const tongue = (phi: number, reach: number): Tongue => ({ phi: phi * DEG, reach, width: uniform(r, 16, 19) * DEG, lick: true });
  return [tongue(d, uniform(r, 0.44, 0.47)), tongue(c, uniform(r, 0.46, 0.49)), tongue(a, uniform(r, 0.59, 0.62)), tongue(b, uniform(r, 0.6, 0.62)), tongue(e, uniform(r, 0.47, 0.5))];
}

// The star's raw radii for a core of `core` U (a low, wide crown on A0).
function rawRadii(phis: number[], tongues: Tongue[], core: number, burst: boolean): number[] {
  // Between two neighbouring tongues the rim keeps WEB of the shorter one's
  // reach, so the tongues read as lobes of one billow (judge round 1).
  const byPhi = [...tongues].sort((a, b) => a.phi - b.phi);
  return phis.map((phi) => {
    let r = core * (burst ? 1 : 0.5 + 0.5 * Math.abs(Math.sin(phi)));
    for (const tg of tongues) r = Math.max(r, tg.reach * bump(phi - tg.phi, tg.width));
    for (let i = 1; i < byPhi.length; i++) {
      const a = byPhi[i - 1];
      const b = byPhi[i];
      if (phi > a.phi && phi < b.phi && b.phi - a.phi < WEB_GAP) r = Math.max(r, WEB * Math.min(a.reach, b.reach));
    }
    return r;
  });
}
const WEB = 0.7; // the rim between neighbouring tongues, × the shorter one's reach
const WEB_GAP = 40 * DEG; // tongues further apart than this aren't joined

// Area and n-centroid of the star r(φ) around P, in closed form per sample.
function starMoments(phis: number[], radii: number[]): { area: number; n: number } {
  const dphi = (phis[phis.length - 1] - phis[0]) / (phis.length - 1);
  let area = 0;
  let mn = 0;
  for (let i = 0; i < phis.length; i++) {
    const w = i === 0 || i === phis.length - 1 ? 0.5 : 1;
    area += w * 0.5 * radii[i] ** 2 * dphi;
    mn += (w * radii[i] ** 3 * Math.cos(phis[i]) * dphi) / 3;
  }
  return { area, n: mn / area };
}

// The burst's star for hold group g (0 or 1): pure in (seed, g).
export function fireStar(seed: number, g: 0 | 1): FireStar {
  const r = rng(seed, 'fire', g);
  const burst = g === 1;
  const tongues = tonguesFor(burst, r);
  const phis = Array.from({ length: STEPS + 1 }, (_, i) => FAN[0] + ((FAN[1] - FAN[0]) * i) / STEPS);
  const target = FIRE_AREA[g];
  // A bigger core spreads the area to every angle and lowers the centroid:
  // bisect it so the area-scaled star sits at the measured height.
  const shaped = (core: number) => {
    const raw = rawRadii(phis, tongues, core, burst);
    const m = starMoments(phis, raw);
    const scale = Math.sqrt(target / m.area);
    return { raw, scale, n: m.n * scale };
  };
  let lo = 0.02;
  let hi = 0.6;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (shaped(mid).n > FIRE_CENTROID[g]) lo = mid;
    else hi = mid;
  }
  const { raw, scale } = shaped((lo + hi) / 2);
  return { phis, radii: raw.map((v) => v * scale), tongues: tongues.map((tg) => ({ ...tg, reach: tg.reach * scale })), scale };
}

// The star as a polygon from P: P, then the rim across the fan, at `grow`
// × the radius plus `pad` U.
function starPolygon(star: FireStar, grow = 1, pad = 0, cap = Infinity): FloorPt[] {
  const out: FloorPt[] = [[0, 0]];
  star.phis.forEach((phi, i) => {
    const r = Math.min(cap, star.radii[i] * grow) + pad;
    out.push([r * Math.cos(phi), r * Math.sin(phi)]);
  });
  return out;
}

export interface FireDrawing extends MassDrawing {
  g: number;
  A: number;
  unit: number; // px per mass unit on this frame
  star: FireStar;
}

// The burst on frame f: hold groups 0 and 1 (A0, A1–2), or null.
export function shapes(ictx: MassContext, f: number): FireDrawing | null {
  const clock = massClock(ictx, f);
  if (!clock || clock.g > 1) return null;
  const g = clock.g as 0 | 1;
  const fr = massFrame(ictx, true);
  const unit = fr.U * clock.zoom;
  const star = fireStar(ictx.seed, g);
  const px = (pts: readonly FloorPt[]) => pts.map((p) => toFrame(fr, unit, p));
  const out: MassShape[] = [];
  // The ink line: the star grown by the line's width, behind the body.
  const lineColor = mixHex(FIRE.line[0], FIRE.line[1], 0.5);
  out.push({ role: 'line', points: px(starPolygon(star, 1, FIRE_LINE)), color: lineColor });
  out.push({ role: 'body', points: px(starPolygon(star)), color: FIRE.outer });
  BANDS.forEach((cap, i) => {
    out.push({ role: 'band', points: px(starPolygon(star, 1, 0, cap)), color: mixHex(FIRE.outer, FIRE.core, (i + 1) / BANDS.length) });
  });
  // One silhouette (judge round 1): the star and its cel bands only, with no
  // licks or amber bubbles on it to read as loose petals and coins.
  return { layer: 'behind', key: `fire:${massKey(ictx)}:${g}:${unit.toFixed(3)}`, alpha: clock.alpha, shapes: out, g, A: clock.A, unit, star };
}

// Inside the star r(φ) (so inside the fan): its angle within the fan and its
// distance from P within the rim there.
export function insideStar(star: FireStar, [n, t]: FloorPt): boolean {
  const a = Math.atan2(t, n);
  if (a < FAN[0] || a > FAN[1]) return false;
  const u = ((a - FAN[0]) / (FAN[1] - FAN[0])) * STEPS;
  const k = Math.min(STEPS - 1, Math.floor(u));
  const rim = star.radii[k] + (star.radii[k + 1] - star.radii[k]) * (u - k);
  return Math.hypot(n, t) <= rim;
}

export function draw(ctxBehind: BrushTarget, _ctxFront: BrushTarget, _sink: GlowSink, ictx: MassContext, f: number, opaque = false) {
  paint(ctxBehind, shapes(ictx, f), opaque);
}

// The palette roles, for the layers that tint toward the palette.
export const rolesOf = (ictx: ImpactContext) => roles(ictx.palette);
