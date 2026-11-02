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
// The decay (judge round 2: cel smoke breaks up, it doesn't fade): the masses
// erode instead of cross-fading. Each group in the decay is drawn at its
// erosion level, decayAlpha at its first frame: the cluster's lumps and the
// dust's plumes stay opaque, shrink to √ of it and drop out in a seeded
// order, the specks drop out. Only the last FADE_FRAMES frames fade, so
// everything is exactly 0 at J_end.
//
// The burst (judge round 2: k14–16's flames, not a flower) is a body around P
// (a core across the fan, −85°..+67° from n̂, a lobe under each tongue and a
// web between neighbours) with a flame for each tongue rising out of it: a
// pointed tip, concave flanks and 2–4 secondary points, each a smaller flame
// leaning off the tongue's axis. Every flank and the body's rim are torn
// into barbs with notches 0.02–0.05 U deep. The pieces are painted as one
// path, so their union is one silhouette with one ink line round it. Its area
// (the line's included) is scaled to the measured target, and the body's
// level is bisected so the centroid lands on the measured curve (A0 0.067 U²
// at n 0.14; A1–2 0.22 U² at n 0.30). The orange licks are the last 15–25 %
// of each tongue and point, within its own outline; the body is the measured
// radial gradient, #fffc7c at P to #fefc07 at 0.53 U, with 3–6 amber bubbles
// in it. In full mode a pale core (the composite's, at least #fefeb1) stands
// in for the near glow the masses have no buffer for.
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
  alpha: number; // fadeAlpha(j, J_end): 1 until the last FADE_FRAMES frames, exactly 0 at J_end
  erode: number; // the erosion level, decayAlpha at the group's first frame: 1 until the decay, then down toward 0
  zoom: number; // every mass size × this: 1.08/zoom at the group's first frame
}

// The masses' fade: only the last FADE_FRAMES frames before J_end, the
// erosion having done the rest (see the header).
export const FADE_FRAMES = 3;
export const fadeAlpha = (j: number, end: number): number => Math.min(1, Math.max(0, (end - j) / FADE_FRAMES));

// The mass clock on frame f, or null where no mass shows: before j 9, and
// after J_end. At J_end itself the alpha is exactly 0.
export function massClock(ictx: MassContext, f: number): MassClock | null {
  const j = f - ictx.I;
  if (j < 9 || j > ictx.jEnd) return null;
  const dps = ictx.dps ?? MASS_DPS;
  const g = massGroup(f, ictx.I, dps) as number;
  let start = f;
  while (start - 1 - ictx.I >= 9 && massGroup(start - 1, ictx.I, dps) === g) start--;
  return {
    j,
    g,
    start,
    A: GROUP_AGE[Math.min(g, LAST_MEASURED)],
    alpha: fadeAlpha(j, ictx.jEnd),
    erode: decayAlpha(start - ictx.I, ictx.jEnd),
    zoom: ZOOM_PEAK / zoomAt(start - ictx.I),
  };
}

// A seeded rank in [0, 1) per item of a layer's stream (the −1 keeps it off
// the groups' own draws): an eroding layer keeps item i while its rank is
// under √erode, so the same items drop out first, whatever the group.
export type ErodeStream = 'cluster' | 'dust' | 'debris' | 'wisp';
export const erodeRank = (seed: number, stream: ErodeStream, i: number): number => rng(seed, stream, -1, i)();
export const erodeKeeps = (seed: number, stream: ErodeStream, i: number, erode: number): boolean => erode >= 1 || erodeRank(seed, stream, i) < Math.sqrt(erode);

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
  color: string; // its fill, or the fallback where there's no gradient
  alpha?: number; // its own opacity, × the drawing's; missing = 1
  round?: boolean; // drawn with curves through the edge midpoints (fillOutline): discs, puffs, petals
  radial?: Radial; // filled with this radial gradient where the canvas has them (the browser's and @napi-rs/canvas both do)
}

// A radial gradient about c, out to r px: stops at 0..1 of r, '#rrggbb' or 'rgba(…)'.
export interface Radial {
  c: Vec2;
  r: number;
  stops: readonly (readonly [number, string])[];
}

// The canvas call a gradient needs, past what BrushTarget has.
interface GradientTarget extends BrushTarget {
  createRadialGradient?(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): { addColorStop(offset: number, color: string): void };
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
// subpath is traced the same way round, so nonzero fill keeps the union. A
// run with a gradient shares the one Radial object (the burst's line, its
// body), so the gradient spans the union.
export function paint(ctx: BrushTarget, drawing: MassDrawing | null, opaque = false) {
  if (!drawing) return;
  const base = opaque ? 1 : drawing.alpha;
  if (!(base > 0)) return;
  const alpha = ctx.globalAlpha;
  const shapes = drawing.shapes;
  const gradients = typeof (ctx as GradientTarget).createRadialGradient === 'function';
  let set = alpha;
  for (let i = 0; i < shapes.length; ) {
    const s = shapes[i];
    const own = s.alpha ?? 1;
    let j = i + 1;
    while (j < shapes.length && shapes[j].radial === s.radial && shapes[j].color === s.color && (shapes[j].alpha ?? 1) === own) j++;
    const a = base * own;
    if (a > 0) {
      if (alpha * a !== set) ctx.globalAlpha = set = alpha * a;
      ctx.fillStyle = s.radial && gradients ? gradientOf(ctx as GradientTarget, s.radial) : s.color;
      ctx.beginPath();
      for (let q = i; q < j; q++) if (shapes[q].points.length >= 3) trace(ctx, shapes[q].points, shapes[q].round === true);
      ctx.fill();
    }
    i = j;
  }
  if (set !== alpha) ctx.globalAlpha = alpha;
}

function gradientOf(ctx: GradientTarget, g: Radial) {
  const out = ctx.createRadialGradient!(g.c[0], g.c[1], 0, g.c[0], g.c[1], Math.max(1e-3, g.r));
  for (const [at, color] of g.stops) out.addColorStop(at, color);
  return out;
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
const FIRE_AREA = [0.067, 0.22]; // U²: A0, A1–2, the ink line's included
// The centroid's n on g0 and g1 (design §6, "Where the mass sits"). g1 aims
// 0.01 U low: the dust's first rims cover its base and lift what shows.
const FIRE_CENTROID = [0.14, 0.29];
export const FIRE_LINE = 0.0065; // U: the olive-brown ink line, 3–5 px on the reference
const LINE_REACH = 0.6; // U: the line runs #b17a02 at P to #866600 here
export const STEPS = 360; // the outer rim's samples across the fan (the lightning's outline)
export const GRADIENT_REACH = 0.53; // U: the body runs #fffc7c at P to #fefc07 here (k14–16)
// Full mode's core: the composite's is #fefeb1 or paler, the near glow over
// the flat's #fffc7c; the masses have no glow buffer, so it is painted in.
export const PALE = '#fffed6';
const PALE_REACH = 0.14; // U: where the pale core has become #fffc7c
// The torn edge: a tooth every `step` along a flank or the rim, its notch
// `depth` in, on `torn` of the steps.
export const JAG = { depth: [0.02, 0.05], step: [0.035, 0.07], torn: 0.75 } as const; // U
export const LICK = [0.15, 0.25] as const; // the orange tip, × the tongue's reach (a point: × its length)
export const BUBBLES = { count: [3, 6], r: [0.011, 0.022], stretch: [1.2, 1.7], line: 0.004 } as const; // U
// A flame's half-width at u of its length, × its root's: (1 − u)^TAPER ×
// (1 + BULGE·u), full low down and drawn to a point with concave flanks.
const TAPER = 1.35;
const BULGE = 0.8;
const halfWidth = (u: number) => (u >= 1 ? 0 : (1 - Math.max(0, u)) ** TAPER * (1 + BULGE * Math.max(0, u)));
const SOFT = 10 * DEG; // angles past the fan's ends less 1° + SOFT are eased into it
// The fit's one free number s (0..1) lifts the mass: the body's rim from
// BODY[0] to BODY[1] of a tongue's reach, the core from CORE[0] to CORE[1] of
// the longest, and the side tongues thinner, a tongue's lobe and flame ×
// FULL + (1 − FULL)·cos(φ)^(LEAN·s). The flames root at half the lobe.
const BODY = [0.4, 0.62] as const;
const CORE = [0.3, 0.05] as const;
const FULL = 0.85;
const LEAN = 4;
const fullness = (phi: number, s: number) => FULL + (1 - FULL) * Math.max(0, Math.cos(phi)) ** (LEAN * s);
const LOBE = 22 * DEG; // the body's lobe under a tongue, half-width
const WEB_GAP = 40 * DEG; // neighbouring tongues closer than this are webbed at the body's level
const HOLE_CELL = 0.004; // U: the raster the holes between the pieces are found and filled on

// A flame: a tongue, rooted inside the body, or a secondary point, rooted on
// its tongue's axis.
export interface Flame {
  id: number; // its seed stream
  phi: number; // its axis, radians from n̂
  reach: number; // a tongue: P to its tip, U; a point: its length, × its tongue's reach
  width: number; // its half-width at the root, × its reach (a point: × its length)
  lick: number; // the orange tip's share of the reach (a point: of its length)
  tone: 0 | 1; // which of the licks' two oranges
  at: number; // a point: where it rises on its tongue's axis, × the tongue's reach
}
export interface Tongue extends Flame {
  points: Flame[]; // its secondary points: 2–4 (the A0 crown's small flames: 1–2)
}
interface BubbleSpec {
  r: number;
  stretch: number;
  angle: number;
}
export interface BurstLayout {
  crown: boolean; // A0: the low, wide crown
  tongues: Tongue[];
  bubbles: BubbleSpec[];
}

// The burst's flames before the fit (reaches unscaled): pure in (seed, g).
// A secondary point is a short, broad flame rising from the upper half of its
// tongue's axis and leaning off it, so it forks out of a flank.
export function burstLayout(seed: number, g: 0 | 1): BurstLayout {
  const r = rng(seed, 'fire', g);
  let id = 0;
  const tongue = (phiDeg: number, reach: number, points: number, width: number): Tongue => {
    const t: Tongue = { id: id++, phi: phiDeg * DEG, reach, width, lick: uniform(r, LICK[0], LICK[1]), tone: int(r, 0, 1) as 0 | 1, at: 0, points: [] };
    const first = r() < 0.5 ? 1 : -1;
    for (let i = 0; i < points; i++) {
      const side = i % 2 === 0 ? first : -first;
      t.points.push({
        id: id++,
        phi: t.phi + side * uniform(r, 20, 34) * DEG,
        reach: uniform(r, 0.22, 0.3),
        width: uniform(r, 0.36, 0.44),
        lick: uniform(r, LICK[0], LICK[1]),
        tone: (1 - t.tone) as 0 | 1,
        at: 0.5 + (0.25 * (i + uniform(r, 0.15, 0.85))) / points,
      });
    }
    return t;
  };
  let tongues: Tongue[];
  if (g === 0) {
    // A0, the crown: tongues at −74° (0.42 U) and +8° (0.54 U), and 6–10 smaller flames of 0.25–0.54 U.
    tongues = [tongue(uniform(r, -76, -72), uniform(r, 0.4, 0.44), int(r, 2, 3), uniform(r, 0.17, 0.21)), tongue(uniform(r, 6, 10), uniform(r, 0.52, 0.56), int(r, 2, 3), uniform(r, 0.17, 0.21))];
    for (let i = int(r, 6, 10); i > 0; i--) tongues.push(tongue(uniform(r, -72, 56), 0.25 + 0.29 * r() ** 2, int(r, 1, 2), uniform(r, 0.19, 0.24)));
  } else {
    // A1–2, the burst: 5 tongues 24–33° apart, the two longest within ±14° of n̂.
    const a = uniform(r, -14, -12);
    const b = uniform(r, 12, 14);
    const c = a - uniform(r, 24, 33);
    const d = Math.max(-76, c - uniform(r, 24, 33));
    const e = Math.min(56, b + uniform(r, 24, 33));
    const spec: [number, number][] = [[d, uniform(r, 0.44, 0.47)], [c, uniform(r, 0.46, 0.49)], [a, uniform(r, 0.59, 0.62)], [b, uniform(r, 0.6, 0.62)], [e, uniform(r, 0.47, 0.5)]];
    tongues = spec.map(([phi, reach]) => tongue(phi, reach, int(r, 2, 4), uniform(r, 0.17, 0.21)));
  }
  const bubbles: BubbleSpec[] = [];
  for (let i = int(r, BUBBLES.count[0], BUBBLES.count[1]); i > 0; i--) {
    bubbles.push({ r: uniform(r, BUBBLES.r[0], BUBBLES.r[1]), stretch: uniform(r, BUBBLES.stretch[0], BUBBLES.stretch[1]), angle: uniform(r, 0, Math.PI) });
  }
  return { crown: g === 0, tongues, bubbles };
}

// One flank of a flame, root to tip, in the flame's own frame ([along, out]):
// torn into barbs that point up it, each tooth's notch 30 % up its step and
// `depth` in from the smooth flank, its barb at the step's top; smooth over
// the last 12 % to the point. A notch is cut only where 0.6 of the half-width
// leaves JAG.depth[0], so every notch is 0.02–0.05 U deep.
function flank(r: Rng, length: number, half: number): Vec2[] {
  const hw = (y: number) => half * halfWidth(y / length);
  const out: Vec2[] = [[0, half]];
  const top = 0.88 * length;
  let y = 0;
  for (;;) {
    const step = uniform(r, JAG.step[0], JAG.step[1]);
    const depth = uniform(r, JAG.depth[0], JAG.depth[1]);
    const torn = r() < JAG.torn;
    if (y + step > top) break;
    const yn = y + 0.3 * step;
    const d = Math.min(depth, 0.6 * hw(yn));
    out.push([yn, hw(yn) - (torn && d >= JAG.depth[0] ? d : 0)]);
    y += step;
    out.push([y, hw(y)]);
  }
  for (let i = 1; i <= 6; i++) {
    const yy = y + ((length - y) * i) / 6;
    out.push([yy, hw(yy)]);
  }
  return out;
}

// A flank from `from` along it to the tip (the flank's along runs up).
function above(fl: readonly Vec2[], from: number): Vec2[] {
  for (let i = 1; i < fl.length; i++) {
    if (fl[i][0] <= from) continue;
    const a = fl[i - 1];
    const b = fl[i];
    const w = (from - a[0]) / (b[0] - a[0] || 1);
    return [[from, a[1] + (b[1] - a[1]) * w], ...fl.slice(i)];
  }
  return [fl[fl.length - 1]];
}

// A flame's outline and its lick, in the floor frame: rooted at `origin`
// along `phi`, `length` long, `half` wide at the root, the last `lick` U
// orange with a ragged lower edge.
function flamePolys(r: Rng, origin: FloorPt, phi: number, length: number, half: number, lick: number): { poly: FloorPt[]; lick: FloorPt[]; tip: FloorPt } {
  const right = flank(r, length, half);
  const left = flank(r, length, half);
  const a: FloorPt = [Math.cos(phi), Math.sin(phi)];
  const b: FloorPt = [-Math.sin(phi), Math.cos(phi)];
  const at = (y: number, x: number): FloorPt => [origin[0] + y * a[0] + x * b[0], origin[1] + y * a[1] + x * b[1]];
  const poly = [...right.map(([y, x]) => at(y, x)), ...left.slice(0, -1).reverse().map(([y, x]) => at(y, -x))];
  // The lick: both flanks above its line, and a ragged edge across, its
  // three points dipping into the yellow (kept within 0.3 of the half-width,
  // clear of any notch).
  const from = length - lick;
  const hw = half * halfWidth(from / length);
  const dip = Math.min(uniform(r, 0.015, 0.03), 0.4 * lick);
  const rr = above(right, from);
  const ll = above(left, from);
  const edge: FloorPt[] = [at(from - dip, -0.3 * hw), at(from + 0.5 * dip, 0), at(from - dip, 0.3 * hw)];
  const lickPoly = [...rr.map(([y, x]) => at(y, x)), ...ll.slice(0, -1).reverse().map(([y, x]) => at(y, -x)), ...edge];
  return { poly, lick: lickPoly, tip: at(length, 0) };
}

// Inside a closed polygon (even-odd).
function insidePoly(poly: readonly FloorPt[], [n, t]: FloorPt): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a[0] > n !== b[0] > n && t < a[1] + ((n - a[0]) / (b[0] - a[0])) * (b[1] - a[1])) inside = !inside;
  }
  return inside;
}

// The body's radius at φ: the core, a lobe under each tongue at the body's
// level, and the web between neighbouring tongues.
function bodyRadius(tongues: readonly Tongue[], core: number, level: number, crown: boolean, s: number): (phi: number) => number {
  const byPhi = [...tongues].sort((p, q) => p.phi - q.phi);
  return (phi) => {
    let r = core * (crown ? 0.5 + 0.5 * Math.abs(Math.sin(phi)) : 1);
    for (const t of tongues) {
      const d = Math.abs(phi - t.phi);
      if (d < LOBE) r = Math.max(r, level * fullness(t.phi, s) * t.reach * Math.cos((d / LOBE) * (Math.PI / 2)) ** 0.7);
    }
    for (let i = 1; i < byPhi.length; i++) {
      const p = byPhi[i - 1];
      const q = byPhi[i];
      if (phi > p.phi && phi < q.phi && q.phi - p.phi < WEB_GAP) r = Math.max(r, level * Math.min(fullness(p.phi, s) * p.reach, fullness(q.phi, s) * q.reach));
    }
    return r;
  };
}

const RIM_STEP = 0.25 * DEG;

// The body as a polygon from P: its rim across the fan, torn like the flames'
// flanks (a tooth's notch radially in, as the rim runs across the rays).
function bodyPoly(r: Rng, radius: (phi: number) => number): FloorPt[] {
  const count = Math.round((FAN[1] - FAN[0]) / RIM_STEP);
  const phis = Array.from({ length: count + 1 }, (_, i) => FAN[0] + ((FAN[1] - FAN[0]) * i) / count);
  const rs = phis.map(radius);
  const cut = new Float64Array(count + 1);
  let i = 0;
  while (i < count) {
    const step = uniform(r, JAG.step[0], JAG.step[1]);
    const depth = uniform(r, JAG.depth[0], JAG.depth[1]);
    const torn = r() < JAG.torn;
    const n = Math.max(4, Math.round(step / (Math.max(rs[i], 0.02) * RIM_STEP)));
    if (i + n > count) break;
    const notch = i + Math.round(0.3 * n);
    const d = Math.min(depth, 0.35 * rs[notch]);
    if (torn && d >= JAG.depth[0]) {
      for (let q = i; q <= i + n; q++) cut[q] = q <= notch ? (d * (q - i)) / (notch - i) : (d * (i + n - q)) / (i + n - notch);
    }
    i += n;
  }
  return [[0, 0], ...phis.map((phi, q): FloorPt => [(rs[q] - cut[q]) * Math.cos(phi), (rs[q] - cut[q]) * Math.sin(phi)])];
}

// A floor point eased into the fan: past 1° + SOFT short of either end the
// angle goes as tanh, so nothing leaves the fan or dips below the floor line
// and a flank pressed against an end keeps its shape.
function intoFan(p: FloorPt): FloorPt {
  const rho = Math.hypot(p[0], p[1]);
  if (rho < 1e-9) return p;
  const phi = Math.atan2(p[1], p[0]);
  const lo = FAN[0] + DEG + SOFT;
  const hi = FAN[1] - DEG - SOFT;
  let q = phi;
  if (phi > hi) q = hi + SOFT * Math.tanh((phi - hi) / SOFT);
  else if (phi < lo) q = lo - SOFT * Math.tanh((lo - phi) / SOFT);
  return q === phi ? p : [rho * Math.cos(q), rho * Math.sin(q)];
}

// Its angle held within the fan (the ink line's few points past it, near P).
function clampFan(p: FloorPt): FloorPt {
  const phi = Math.atan2(p[1], p[0]);
  const q = clamp(phi, FAN[0], FAN[1]);
  if (q === phi) return p;
  const rho = Math.hypot(p[0], p[1]);
  return [rho * Math.cos(q), rho * Math.sin(q)];
}

// A closed outline pushed out by d along its vertex normals.
function grownBy(loop: readonly FloorPt[], d: number): FloorPt[] {
  let sign = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    sign += a[0] * b[1] - b[0] * a[1];
  }
  const out = sign >= 0 ? 1 : -1;
  return loop.map((p, i): FloorPt => {
    const a = loop[(i + loop.length - 1) % loop.length];
    const b = loop[(i + 1) % loop.length];
    const tx = b[0] - a[0];
    const ty = b[1] - a[1];
    const len = Math.hypot(tx, ty) || 1;
    return [p[0] + (out * d * ty) / len, p[1] - (out * d * tx) / len];
  });
}

// The union of closed polygons on a grid of `cell` U over n −0.1..1.2, t
// −1.2..1.2 (each polygon by scanline, even-odd; covered where any covers),
// and its holes: the uncovered cells the grid's edge can't reach.
interface UnionGrid {
  cell: number;
  cols: number;
  rows: number;
  covered: Uint8Array;
  outside: Uint8Array;
}
const UN0 = -0.1;
const UT0 = -1.2;
function unionGrid(polys: readonly FloorPt[][], cell: number): UnionGrid {
  const rows = Math.ceil(1.3 / cell);
  const cols = Math.ceil(2.4 / cell);
  const covered = new Uint8Array(rows * cols);
  const xs: number[] = [];
  for (const poly of polys) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of poly) {
      lo = Math.min(lo, p[0]);
      hi = Math.max(hi, p[0]);
    }
    for (let i = Math.max(0, Math.ceil((lo - UN0) / cell - 0.5)), i1 = Math.min(rows - 1, Math.floor((hi - UN0) / cell - 0.5)); i <= i1; i++) {
      const cn = UN0 + (i + 0.5) * cell;
      xs.length = 0;
      for (let e = 0; e < poly.length; e++) {
        const a = poly[e];
        const b = poly[(e + 1) % poly.length];
        if (a[0] <= cn === b[0] <= cn) continue;
        xs.push(a[1] + ((cn - a[0]) / (b[0] - a[0])) * (b[1] - a[1]));
      }
      xs.sort((p, q) => p - q);
      for (let m = 0; m + 1 < xs.length; m += 2) {
        const k0 = Math.max(0, Math.ceil((xs[m] - UT0) / cell - 0.5));
        const k1 = Math.min(cols - 1, Math.floor((xs[m + 1] - UT0) / cell - 0.5));
        if (k1 >= k0) covered.fill(1, i * cols + k0, i * cols + k1 + 1);
      }
    }
  }
  // Flood the outside in from the grid's edge.
  const outside = new Uint8Array(rows * cols);
  const queue = new Int32Array(rows * cols);
  let tail = 0;
  const push = (at: number) => {
    if (covered[at] || outside[at]) return;
    outside[at] = 1;
    queue[tail++] = at;
  };
  for (let k = 0; k < cols; k++) {
    push(k);
    push((rows - 1) * cols + k);
  }
  for (let i = 0; i < rows; i++) {
    push(i * cols);
    push(i * cols + cols - 1);
  }
  for (let head = 0; head < tail; head++) {
    const at = queue[head];
    const k = at % cols;
    if (k > 0) push(at - 1);
    if (k < cols - 1) push(at + 1);
    if (at >= cols) push(at - cols);
    if (at < (rows - 1) * cols) push(at + cols);
  }
  return { cell, cols, rows, covered, outside };
}

// The union's area and n-centroid with its holes filled.
function unionStats(polys: readonly FloorPt[][], cell: number): { area: number; n: number } {
  const u = unionGrid(polys, cell);
  let count = 0;
  let sn = 0;
  for (let i = 0; i < u.rows; i++) {
    let c = 0;
    for (let at = i * u.cols, end = at + u.cols; at < end; at++) c += 1 - u.outside[at];
    count += c;
    sn += c * (UN0 + (i + 0.5) * cell);
  }
  return { area: count * cell * cell, n: count ? sn / count : 0 };
}

// The holes between the pieces (where flanks and points cross above the rim,
// and the pockets the ink line closes) as row strips of HOLE_CELL, so the
// burst stays one silhouette with one line round it. A strip cell is a hole
// (inside the line's silhouette, off every piece) or next to one, and more
// than the line's width in from the outside: the outer line stays whole and
// the lines inside the holes are covered.
function holePatches(parts: readonly FloorPt[][], line: readonly FloorPt[][]): FloorPt[][] {
  const body = unionGrid(parts, HOLE_CELL);
  const { cols, rows, covered } = body;
  const { outside } = unionGrid(line, HOLE_CELL);
  // Each cell's distance from the outside, in cells, out to BAND + 1.
  const BAND = Math.ceil(FIRE_LINE / HOLE_CELL) + 1;
  const dist = new Uint8Array(rows * cols).fill(BAND + 1);
  const queue = new Int32Array(rows * cols);
  let tail = 0;
  for (let at = 0; at < rows * cols; at++) {
    if (!outside[at]) continue;
    dist[at] = 0;
    queue[tail++] = at;
  }
  for (let head = 0; head < tail; head++) {
    const at = queue[head];
    const d = dist[at] + 1;
    if (d > BAND) continue;
    const k = at % cols;
    for (const nb of [k > 0 ? at - 1 : -1, k < cols - 1 ? at + 1 : -1, at - cols, at + cols]) {
      if (nb < 0 || nb >= rows * cols || dist[nb] <= d) continue;
      dist[nb] = d;
      queue[tail++] = nb;
    }
  }
  const hole = (at: number) => !covered[at] && !outside[at];
  const out: FloorPt[][] = [];
  for (let i = 1; i < rows - 1; i++) {
    let start = -1;
    for (let k = 1; k <= cols - 1; k++) {
      const at = i * cols + k;
      const on = k < cols - 1 && dist[at] > BAND && (hole(at) || hole(at - 1) || hole(at + 1) || hole(at - cols) || hole(at + cols));
      if (on && start < 0) start = k;
      if (!on && start >= 0) {
        // A quarter cell over its neighbours, so no seam shows between strips.
        const n0 = UN0 + (i - 0.25) * HOLE_CELL;
        const n1 = n0 + 1.5 * HOLE_CELL;
        const t0 = UT0 + start * HOLE_CELL;
        const t1 = UT0 + k * HOLE_CELL;
        out.push(([[n0, t0], [n0, t1], [n1, t1], [n1, t0]] as FloorPt[]).map(clampFan));
        start = -1;
      }
    }
  }
  return out;
}

// The farthest the parts reach along the ray from P at each φ.
function rimRadii(parts: readonly FloorPt[][], phis: readonly number[]): number[] {
  return phis.map((phi) => {
    const dn = Math.cos(phi);
    const dt = Math.sin(phi);
    let best = 0;
    for (const poly of parts) {
      for (let e = 0; e < poly.length; e++) {
        const a = poly[e];
        const b = poly[(e + 1) % poly.length];
        const en = b[0] - a[0];
        const et = b[1] - a[1];
        const den = en * dt - et * dn;
        if (Math.abs(den) < 1e-12) continue;
        const u = -(a[0] * dt - a[1] * dn) / den;
        if (u < 0 || u > 1) continue;
        const s = (a[0] + u * en) * dn + (a[1] + u * et) * dt;
        if (s > best) best = s;
      }
    }
    return best;
  });
}

export interface FireLick {
  poly: FloorPt[];
  tone: 0 | 1;
  share: number; // of its flame's reach (a point: of its length)
  flame: number; // the flame's id
}
export interface FireBubble {
  c: FloorPt;
  r: number;
  stretch: number;
  angle: number;
}
export interface FireStar {
  phis: number[]; // sample angles across the fan
  radii: number[]; // the outer rim (body and flames, the line not) at each, U
  tongues: Tongue[]; // as drawn: reaches × scale
  scale: number; // what the layout's reaches were scaled by to hit the area
  level: number; // the body's rim, × a tongue's reach
  core: number; // U
  parts: FloorPt[][]; // the body, then each tongue and its points: their union is the burst
  patches: FloorPt[][]; // the holes between them, filled
  line: FloorPt[][]; // each part grown by the ink line
  licks: FireLick[];
  bubbles: FireBubble[];
}
type Built = Omit<FireStar, 'phis' | 'radii' | 'patches' | 'bubbles'>;

// The burst at fit parameter s (0..1, see BODY) and scale k.
function buildBurst(L: BurstLayout, seed: number, g: 0 | 1, s: number, k: number): Built {
  const level = BODY[0] + (BODY[1] - BODY[0]) * s;
  const tongues: Tongue[] = L.tongues.map((t) => ({ ...t, reach: t.reach * k, points: t.points.map((p) => ({ ...p })) }));
  const longest = Math.max(...tongues.map((t) => t.reach));
  const core = (CORE[0] + (CORE[1] - CORE[0]) * s) * longest;
  const radius = bodyRadius(tongues, core, level, L.crown, s);
  const parts: FloorPt[][] = [bodyPoly(rng(seed, 'fire', g, 1), radius)];
  const licks: FireLick[] = [];
  const tips: { tip: FloorPt; part: number }[] = [];
  for (const t of tongues) {
    const ax: FloorPt = [Math.cos(t.phi), Math.sin(t.phi)];
    const full = fullness(t.phi, s);
    const root = 0.5 * level * full * t.reach;
    const f = flamePolys(rng(seed, 'fire', g, 2, t.id), [root * ax[0], root * ax[1]], t.phi, t.reach - root, full * t.width * t.reach, t.lick * t.reach);
    tips.push({ tip: f.tip, part: parts.length });
    parts.push(f.poly);
    licks.push({ poly: f.lick, tone: t.tone, share: t.lick, flame: t.id });
    for (const p of t.points) {
      const len = p.reach * t.reach;
      const at = p.at * t.reach;
      const fp = flamePolys(rng(seed, 'fire', g, 2, p.id), [at * ax[0], at * ax[1]], p.phi, len, p.width * len, p.lick * len);
      tips.push({ tip: fp.tip, part: parts.length });
      parts.push(fp.poly);
      licks.push({ poly: fp.lick, tone: p.tone, share: p.lick, flame: p.id });
    }
  }
  const fanned = parts.map((p) => p.map(intoFan));
  // A lick shows only where its flame's tip is on the silhouette, not buried
  // in another piece (the crown's small flames often are).
  const shown = tips.map(({ tip, part }) => {
    const at = intoFan(tip);
    return !fanned.some((poly, q) => q !== part && insidePoly(poly, at));
  });
  return {
    tongues,
    scale: k,
    level,
    core,
    parts: fanned,
    line: fanned.map((p) => grownBy(p, FIRE_LINE).map(clampFan)),
    licks: licks.filter((_, q) => shown[q]).map((l) => ({ ...l, poly: l.poly.map(intoFan) })),
  };
}

// The bubbles (the crown's × its scale, down to 0.006 U): each wholly inside
// the pieces, its ink ring and 0.006 U more, clear of the others. Each tries
// up to 24 seeded spots between −60° and +50°, smaller after 12.
function placeBubbles(L: BurstLayout, seed: number, g: 0 | 1, parts: readonly FloorPt[][], phis: readonly number[], radii: readonly number[], k: number): FireBubble[] {
  const rimAt = (phi: number) => radii[Math.round(((phi - phis[0]) / (phis[phis.length - 1] - phis[0])) * (phis.length - 1))];
  const inside = (p: FloorPt) => parts.some((poly) => insidePoly(poly, p));
  const out: FireBubble[] = [];
  L.bubbles.forEach((b, i) => {
    const pick = rng(seed, 'fire', g, 3, i);
    for (let tries = 0; tries < 24; tries++) {
      const phi = uniform(pick, -60, 50) * DEG;
      const rho = uniform(pick, 0.04, 0.92) * rimAt(phi);
      const r = Math.max(0.006, b.r * Math.min(1, k) * (tries < 12 ? 1 : 0.55));
      const c: FloorPt = [rho * Math.cos(phi), rho * Math.sin(phi)];
      const size = r * b.stretch + BUBBLES.line;
      if (out.some((o) => Math.hypot(o.c[0] - c[0], o.c[1] - c[1]) < o.r * o.stretch + size + 0.008)) continue;
      if (!ellipsePts(c, r + BUBBLES.line + 0.006, 12, b.stretch, b.angle).every(inside)) continue;
      out.push({ c, r, stretch: b.stretch, angle: b.angle });
      return;
    }
  });
  return out;
}

// The burst's star for hold group g (0 or 1): pure in (seed, g). The scale
// brings the union with its ink line to the measured area, and the fit's s,
// bisected, puts its centroid at the measured height (or as near as s's
// range allows: the A1–2 layout's own spread holds it near 0.25 U).
const STARS = new Map<string, FireStar>();
export function fireStar(seed: number, g: 0 | 1): FireStar {
  return memo(STARS, `${seed}:${g}`, () => {
    const L = burstLayout(seed, g);
    const target = FIRE_AREA[g];
    let k = 1;
    const trial = (s: number, cell: number, rounds: number) => {
      let b = buildBurst(L, seed, g, s, k);
      let m = unionStats(b.line, cell);
      for (let i = 0; i < rounds; i++) {
        k *= Math.sqrt(target / m.area);
        b = buildBurst(L, seed, g, s, k);
        m = unionStats(b.line, cell);
      }
      return { b, m };
    };
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 8; i++) {
      const mid = (lo + hi) / 2;
      if (trial(mid, 0.008, 1).m.n < FIRE_CENTROID[g]) lo = mid;
      else hi = mid;
    }
    const { b } = trial((lo + hi) / 2, 0.004, 2);
    const phis = Array.from({ length: STEPS + 1 }, (_, i) => FAN[0] + ((FAN[1] - FAN[0]) * i) / STEPS);
    const radii = rimRadii(b.parts, phis);
    return { ...b, phis, radii, patches: holePatches(b.parts, b.line), bubbles: placeBubbles(L, seed, g, b.parts, phis, radii, b.scale) };
  });
}

export interface FireDrawing extends MassDrawing {
  g: number;
  A: number;
  unit: number; // px per mass unit on this frame
  star: FireStar;
}

// The burst's shapes at `unit` px per U: the ink line under everything, the
// body in its gradient (the holes' patches with it), the licks, then the
// bubbles with their own line.
function burstShapes(star: FireStar, fr: MassFrame, unit: number, pale: boolean): MassShape[] {
  const px = (pts: readonly FloorPt[]) => pts.map((p) => toFrame(fr, unit, p));
  const line: Radial = { c: fr.P, r: LINE_REACH * unit, stops: [[0, FIRE.line[1]], [1, FIRE.line[0]]] };
  const body: Radial = {
    c: fr.P,
    r: GRADIENT_REACH * unit,
    stops: pale ? [[0, PALE], [PALE_REACH / GRADIENT_REACH, FIRE.core], [1, FIRE.outer]] : [[0, FIRE.core], [1, FIRE.outer]],
  };
  const out: MassShape[] = [];
  const lineColor = mixHex(FIRE.line[0], FIRE.line[1], 0.5);
  for (const p of star.line) out.push({ role: 'line', points: px(p), color: lineColor, radial: line });
  for (const p of [...star.parts, ...star.patches]) out.push({ role: 'body', points: px(p), color: FIRE.outer, radial: body });
  for (const l of star.licks) out.push({ role: 'lick', points: px(l.poly), color: FIRE.licks[l.tone] });
  const ring = (b: FireBubble, r: number) => px(ellipsePts(b.c, r, discCount(r * b.stretch * unit), b.stretch, b.angle));
  for (const b of star.bubbles) out.push({ role: 'bubble-line', points: ring(b, b.r + BUBBLES.line), color: FIRE.line[1], round: true });
  for (const b of star.bubbles) out.push({ role: 'bubble', points: ring(b, b.r), color: FIRE.amber, round: true });
  return out;
}

const BURSTS = new Map<string, MassShape[]>();

// The burst on frame f: hold groups 0 and 1 (A0, A1–2), or null. Full mode
// paints the pale core; Reduce flashing keeps the flat's gradient.
export function shapes(ictx: MassContext, f: number): FireDrawing | null {
  const clock = massClock(ictx, f);
  if (!clock || clock.g > 1) return null;
  const g = clock.g as 0 | 1;
  const fr = massFrame(ictx, true);
  const unit = fr.U * clock.zoom;
  const star = fireStar(ictx.seed, g);
  const pale = ictx.flash !== 'safe';
  const key = `fire:${massKey(ictx)}:${g}:${unit.toFixed(3)}:${pale ? 'pale' : 'flat'}`;
  const out = memo(BURSTS, key, () => burstShapes(star, fr, unit, pale), 8);
  return { layer: 'behind', key, alpha: clock.alpha, shapes: out, g, A: clock.A, unit, star };
}

// Inside the burst's outer rim seen from P (so inside the fan).
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
