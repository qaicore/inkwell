// The washes (impact design §5 G5 and the ladder, §6 "Energy" and "Decay and
// the time map"; destruction §4.6, §4.8, §6.8, §6.9; compositing §2.7):
//   - the cyan floods, on the kr clock. Full mode keeps the measured four: A10
//     (16 % of the frame), A11 (30 %), A15 (29 %) and A17 (58 %), each on its
//     own kr step, seeded rng(seed, 'flood', wash, A). Gentle mode (Reduce
//     flashing) keeps wash 1 (A10–11) and wash 3 (A17) only, one shape each,
//     seeded rng(seed, 'flood', wash), at 22 % of the frame. Each ramps up over
//     2 frames and down over 2 either side of its plateau (wash 1 j 20–25,
//     wash 3 j 28–33, the flash plan of design §5), and wash 2 becomes a bolt
//     brightening on its step;
//   - the ladder hooks: washes.w1 / w3 'bolt' turn a wash into a brightening
//     on its plateau, with no flood pixels; noFlash drops the washes, the
//     brightenings, the veil and the flash;
//   - the dust-wash veil of A5–6 (hold group 3): α 0.64 with a 4-step feather
//     of 0.04–0.055 S, cut to at most 0.35 over the person;
//   - the A5–6 white flash, on the strict-2s clock: the frame less a hole round
//     the cluster and dust, 4–5 floor splinters, a window and the person, by
//     the even-odd rule, at about 0.4 opacity.
// A flood is layered outside in: an ink line, the blue band (lobed on its
// outer side), an ink line, a pale fringe, then the cyan field, whose edge is
// notched in 0.01–0.02 U steps. The A15–17 fields pale with depth, from core
// at the edge to pale 0.15–0.3 U in; the A10–11 fields run the other way, a
// paler rim 0.03 U deep over a saturated inside. Floods go behind the person
// (slot 6); the veil goes in the front FX (slot 10) and the flash above it
// (slot 11). In gentle mode the veil and the flash stay under +0.10 L: their
// opacity is capped so no grey background up to L 0.6 moves by 0.08 or more.
//
// The kr-clocked things take j (frames since contact); the 2s ones take the
// output frame f, like the masses. This file also holds what the three energy
// modules share: the energy frame (n up the floor, t across it toward the
// strike's side), the kr-step bounds, the 2s group clock, flat fills and the
// faded paint. They match fire.ts's (WP8) on purpose, kept apart so WP9 needs
// no WP8 code.
import type { Vec2 } from '../../types/effect.ts';
import type { GlowSink, ImpactContext, LayerDraw } from '../contracts.ts';
import type { Mask } from '../../track/tracking.ts';
import { drawingIndex } from '../../motion/timing.ts';
import { rgb } from '../../render/geometry.ts';
import { scratch, type BrushTarget, type MakeScratch, type Scratch } from '../../render/glow.ts';
import { decayAlpha, drawingStart, kr, massGroup, zoomAt } from '../clock.ts';
import { floorFrame } from '../floor.ts';
import { linear, mixHex, roles } from '../palette.ts';
import { int, rng, uniform } from '../rng.ts';

const TAU = 2 * Math.PI;
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
// A vector's length: Math.hypot guards against overflow these lengths never
// reach, at about nine times the cost.
export const hyp = (x: number, y: number) => Math.sqrt(x * x + y * y);

// ---- The energy frame and clocks ----------------------------------------------------------

// An ImpactContext, plus the global drawing rate when it isn't 12.
export type EnergyContext = ImpactContext & { dps?: number };
export const ENERGY_DPS = 12;

export interface EnergyFrame {
  P: Vec2;
  n: Vec2; // up the floor, on screen
  t: Vec2; // across it, toward the strike's side
  side: 1 | -1; // t = side × floorFrame's t̂
  U: number; // px per U: σ·S × aftermath.scale
  S: number; // the frame's short side, px
}

export function energyFrame(ictx: ImpactContext): EnergyFrame {
  const { P, n, t } = floorFrame(ictx.frame.P, ictx.floor);
  const u = ictx.frame.u;
  const side: 1 | -1 = u[0] * t[0] + u[1] * t[1] >= 0 ? 1 : -1;
  return { P, n, t: [side * t[0], side * t[1]], side, U: ictx.frame.U * ictx.aftermath.scale, S: ictx.frame.S };
}

// A floor-frame point, n up and t across, in units of `unit` px, to frame px.
export const onFloor = (fr: EnergyFrame, unit: number, n: number, t: number): Vec2 => [fr.P[0] + unit * (n * fr.n[0] + t * fr.t[0]), fr.P[1] + unit * (n * fr.n[1] + t * fr.t[1])];

// The frames of j's kr step: kr holds 2, 1, 1, 1 frames, so first = last on
// most steps.
export function krSpan(j: number): { first: number; last: number } {
  const k = kr(j);
  return { first: kr(j - 1) === k ? j - 1 : j, last: kr(j + 1) === k ? j + 1 : j };
}

// Each measured hold group's first reference age, g0..g8 (clock.ts's groups);
// groups past g8 hold g8's.
export const GROUP_AGE = [0, 1, 3, 5, 7, 9, 12, 15, 17] as const;
export const LAST_GROUP = 8;
export const ZOOM_PEAK = 1.08;

export interface GroupClock {
  j: number; // f − I
  g: number; // the hold group: 0..8 measured, 9 and up in the hold span and the decay
  start: number; // the group's first frame
  A: number; // the reference age the group stands for
  alpha: number; // decayAlpha(j, J_end): 1 until J_end − 14, exactly 0 at J_end
  zoom: number; // sizes and positions × this: 1.08/zoom at the group's first frame
}

// The 2s group clock on frame f, or null before j 9 and after J_end.
export function groupClock(ictx: EnergyContext, f: number): GroupClock | null {
  const j = f - ictx.I;
  if (j < 9 || j > ictx.jEnd) return null;
  const dps = ictx.dps ?? ENERGY_DPS;
  const g = massGroup(f, ictx.I, dps) as number;
  let start = f;
  while (start - 1 - ictx.I >= 9 && massGroup(start - 1, ictx.I, dps) === g) start--;
  return { j, g, start, A: GROUP_AGE[Math.min(g, LAST_GROUP)], alpha: decayAlpha(j, ictx.jEnd), zoom: ZOOM_PEAK / zoomAt(start - ictx.I) };
}

// The strict-2s clock (every global drawing): the drawing holding frame f,
// its first visible frame and the reference age there.
export function drawingClock(ictx: EnergyContext, f: number): { k: number; start: number; A: number } {
  const dps = ictx.dps ?? ENERGY_DPS;
  const k = drawingIndex(f, dps);
  const start = Math.max(drawingStart(k, dps), ictx.I + 9);
  return { k, start, A: kr(start - ictx.I) - 14 };
}

// Everything about the scene that changes an energy layer's pixels, for the
// stack's cache keys.
export function sceneKey(ictx: ImpactContext): string {
  const { frame: fr, floor } = ictx;
  return [
    ictx.seed,
    `${ictx.width}x${ictx.height}`,
    fr.P[0].toFixed(2),
    fr.P[1].toFixed(2),
    fr.u[0].toFixed(5),
    fr.u[1].toFixed(5),
    fr.U.toFixed(3),
    ictx.aftermath.scale,
    floor.ratio,
    floor.majorDeg,
    floor.up[0],
    floor.up[1],
    floor.persp,
    ictx.palette.join(''),
    ictx.flash,
    ictx.tier,
  ].join(':');
}

export function memo<T>(cache: Map<string, T>, key: string, make: () => T, cap = 24): T {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const value = make();
  if (cache.size >= cap) cache.delete(cache.keys().next().value as string);
  cache.set(key, value);
  return value;
}

// ---- Polygons ----------------------------------------------------------------------------

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// The whole-pixel box round some polygons, padded and cut to the w × h frame;
// null when nothing is on it.
export function boxOf(polys: readonly (readonly Vec2[])[], pad: number, w: number, h: number): Box | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const poly of polys) {
    for (const [x, y] of poly) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (!(x1 >= x0)) return null;
  const box = { x0: Math.max(0, Math.floor(x0 - pad)), y0: Math.max(0, Math.floor(y0 - pad)), x1: Math.min(w, Math.ceil(x1 + pad)), y1: Math.min(h, Math.ceil(y1 + pad)) };
  return box.x1 > box.x0 && box.y1 > box.y0 ? box : null;
}

// The shoelace area: positive for one winding, negative for the other.
export function signedArea(pts: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0, k = pts.length - 1; i < pts.length; k = i++) a += pts[k][0] * pts[i][1] - pts[i][0] * pts[k][1];
  return a / 2;
}

function clipPlane(pts: readonly Vec2[], axis: 0 | 1, value: number, keepAbove: boolean): Vec2[] {
  const out: Vec2[] = [];
  const n = pts.length;
  const inside = (p: Vec2) => (keepAbove ? p[axis] >= value : p[axis] <= value);
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const ia = inside(a);
    if (ia) out.push(a);
    if (ia !== inside(b)) {
      const s = (value - a[axis]) / (b[axis] - a[axis]);
      out.push([a[0] + s * (b[0] - a[0]), a[1] + s * (b[1] - a[1])]);
    }
  }
  return out;
}

// Sutherland–Hodgman: the part of a closed polygon on the [0, w] × [0, h] frame.
export function clipToFrame(pts: readonly Vec2[], w: number, h: number): Vec2[] {
  let p = clipPlane(pts, 0, 0, true);
  p = clipPlane(p, 0, w, false);
  p = clipPlane(p, 1, 0, true);
  return clipPlane(p, 1, h, false);
}

// The points of a polyline less those on a straight line between their
// neighbours (within 0.02 px): the ends of each straight run are kept.
export function straight(pts: readonly Vec2[], eps = 0.02): Vec2[] {
  if (pts.length < 3) return [...pts];
  const out: Vec2[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1];
    const b = pts[i];
    const c = pts[i + 1];
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(cross) > eps * hyp(c[0] - a[0], c[1] - a[1]) || (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) < 0) out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// Even-odd point in polygon.
export function inside(pts: readonly Vec2[], [x, y]: Vec2): boolean {
  let hit = false;
  for (let i = 0, k = pts.length - 1; i < pts.length; k = i++) {
    const [xi, yi] = pts[i];
    const [xk, yk] = pts[k];
    if (yi > y !== yk > y && x < ((xk - xi) * (y - yi)) / (yk - yi) + xi) hit = !hit;
  }
  return hit;
}

// A straight edge to (x, y): lineTo where the target has it (a canvas does,
// and fills lines faster), otherwise a quadratic with its control point on
// the end point, which is a line (PathTarget has no lineTo).
function edgeTo(ctx: BrushTarget): (x: number, y: number) => void {
  const target = ctx as BrushTarget & { lineTo?(x: number, y: number): void };
  return typeof target.lineTo === 'function' ? (x, y) => target.lineTo!(x, y) : (x, y) => ctx.quadraticCurveTo(x, y, x, y);
}

// Closed polygons as one path, each wound the same way round, so the nonzero
// fill joins any that overlap. A polygon with a non-finite point is left out:
// the canvas would drop the whole path.
export const finite = (poly: readonly Vec2[]) => poly.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
export function fillUnion(ctx: BrushTarget, polys: readonly (readonly Vec2[])[], color: string) {
  let any = false;
  const edge = edgeTo(ctx);
  ctx.fillStyle = color;
  ctx.beginPath();
  for (const poly of polys) {
    const n = poly.length;
    if (n < 3 || !finite(poly)) continue;
    const back = signedArea(poly) < 0;
    const first = poly[back ? n - 1 : 0];
    ctx.moveTo(first[0], first[1]);
    for (let i = 1; i < n; i++) {
      const [x, y] = poly[back ? n - 1 - i : i];
      edge(x, y);
    }
    ctx.closePath();
    any = true;
  }
  if (any) ctx.fill();
}

// The first polygon less the rest, by the even-odd rule. The holes mustn't
// overlap one another: where two did, the fill would come back.
export function fillEvenOdd(ctx: BrushTarget, polys: readonly (readonly Vec2[])[], color: string) {
  const edge = edgeTo(ctx);
  ctx.fillStyle = color;
  ctx.beginPath();
  for (const poly of polys) {
    if (poly.length < 3) continue;
    ctx.moveTo(poly[0][0], poly[0][1]);
    for (let i = 1; i < poly.length; i++) edge(poly[i][0], poly[i][1]);
    ctx.closePath();
  }
  (ctx as unknown as { fill(rule: 'evenodd'): void }).fill('evenodd');
}

// ---- Painting through a scratch ------------------------------------------------------------

const SCRATCH_SLOT = 3; // the energy layers' slot in glow.ts's scratch pool (0 grain, 1 glow, 2 aura)

// Paints into a scratch in frame px, lets `after` work on the pixels in
// `box`, then lays that box on ctx at `alpha`. The scratch reaches the box's
// far corner, and a box is cut to the frame, so a shape running off the frame
// is cut where the frame cuts it, however big the scratch has grown (a canvas
// rasterizes the pixels next to its edge a little differently when a path
// runs past it, so a scratch cut to the box would make a frame's pixels
// depend on what was drawn before).
function throughScratch(ctx: BrushTarget, make: MakeScratch, alpha: number, box: Box, paint: (c: BrushTarget) => void, after?: (c: BrushTarget) => void) {
  const s = scratch(make, SCRATCH_SLOT, box.x1, box.y1);
  s.ctx.globalAlpha = 1;
  paint(s.ctx);
  s.ctx.globalAlpha = 1;
  after?.(s.ctx);
  lay(ctx, s, alpha, box);
}

// Lays a buffer's `box` (frame px, as the buffer is) on ctx at `alpha`.
function lay(ctx: BrushTarget, s: Scratch, alpha: number, box: Box) {
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  const a = ctx.globalAlpha;
  ctx.globalAlpha = a * alpha;
  ctx.drawImage(s.canvas as never, box.x0, box.y0, w, h, box.x0, box.y0, w, h);
  ctx.globalAlpha = a;
}

// A whole drawing at `alpha` as one: opaque into a scratch, then laid on ctx
// at alpha, so the drawing's own overlaps don't show through. At alpha 1 it
// paints straight onto ctx. The stack composites a keyed layer at full
// opacity, so a fade has to be baked in here.
export function faded(ctx: BrushTarget, make: MakeScratch, alpha: number, box: Box | null, paint: (c: BrushTarget) => void) {
  if (!(alpha > 0) || !box) return;
  if (alpha >= 1) paint(ctx);
  else throughScratch(ctx, make, alpha, box, paint);
}

// Lowers a scratch's alpha by `cut` × the person mask over `box` (frame px,
// as the scratch is); the mask is frame-sized, or scaled to the frame.
function cutPerson(c: BrushTarget, box: Box, mask: Mask, cut: number, width: number, height: number) {
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  const img = c.getImageData(box.x0, box.y0, w, h);
  const d = img.data;
  const sx = mask.width / width;
  const sy = mask.height / height;
  const cols = new Int32Array(w);
  for (let x = 0; x < w; x++) cols[x] = Math.min(mask.width - 1, Math.floor((box.x0 + x + 0.5) * sx));
  for (let y = 0; y < h; y++) {
    const row = Math.min(mask.height - 1, Math.floor((box.y0 + y + 0.5) * sy)) * mask.width;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4 + 3;
      if (d[i] === 0) continue;
      const m = mask.alpha[row + cols[x]];
      if (m > 0) d[i] = Math.round(d[i] * (1 - (cut * m) / 255));
    }
  }
  c.putImageData(img, box.x0, box.y0);
}

// ---- Gentle mode's lift cap -----------------------------------------------------------------

export const GENTLE_LIFT = 0.08; // the most a gentle veil or flash moves L: under the checker's 0.10
export const GENTLE_BG = 0.6; // over grey backgrounds up to this L

const lum8 = (r: number, g: number, b: number) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
const caps = new Map<string, number>();

// The most opacity a veil of `color` can have so that over no grey background
// up to L maxBg the result moves by `limit` or more, unless both sides stay at
// L 0.80 or above (the checker ignores a change there). 8-bit blending, as
// the canvas does it.
export function liftCap(color: string, limit = GENTLE_LIFT, maxBg = GENTLE_BG): number {
  const key = `${color}|${limit}|${maxBg}`;
  const hit = caps.get(key);
  if (hit !== undefined) return hit;
  const c = rgb(color);
  const greys: number[] = [];
  for (let v = 0; v <= 255; v++) if (lum8(v, v, v) <= maxBg) greys.push(v);
  const ok = (a: number) =>
    greys.every((v) => {
      const l0 = lum8(v, v, v);
      const l1 = lum8(Math.round(v + a * (c[0] - v)), Math.round(v + a * (c[1] - v)), Math.round(v + a * (c[2] - v)));
      return Math.abs(l1 - l0) < limit || Math.min(l0, l1) >= 0.8;
    });
  let lo = 0;
  let hi = 1;
  if (ok(1)) lo = 1;
  else {
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (ok(mid)) lo = mid;
      else hi = mid;
    }
  }
  caps.set(key, lo);
  return lo;
}

// ---- Floods ----------------------------------------------------------------------------------

export type WashMode = 'flood' | 'bolt';
export interface WashOptions {
  washes?: { w1?: WashMode; w3?: WashMode }; // ladder steps 1 and 2: 'bolt' makes the wash a bolt brightening
  noFlash?: boolean; // ladder steps 6 and 7: no washes, no brightenings, no veil, no A5–6 flash
}

export interface FloodSpec {
  wash: 1 | 2 | 3;
  A: number; // the reference age: its kr step is 14 + A
  area: number; // share of the frame, outer ink line included
  dir: number; // degrees from n̂ toward +t: where the flood lies, beyond a line across that way
  field: 'rim' | 'deep'; // a paler rim over a saturated inside, or core at the edge paling with depth
}

// The measured floods (destruction §4.8, §6.9).
export const FLOODS: readonly FloodSpec[] = [
  { wash: 1, A: 10, area: 0.16, dir: 60, field: 'rim' }, // the +t background beyond the cluster
  { wash: 1, A: 11, area: 0.3, dir: 75, field: 'rim' }, // the floor in front of P and the far +t corner
  { wash: 2, A: 15, area: 0.29, dir: -70, field: 'deep' }, // the −t floor and background
  { wash: 3, A: 17, area: 0.58, dir: -95, field: 'deep' }, // everything on the −t side
];

export const GENTLE_FLOOD_AREA = 0.22; // under the 25 % cap, with room for the lobes
export const GENTLE_RAMP = [1 / 3, 2 / 3, 1, 1, 2 / 3, 1 / 3] as const; // up 2 frames, the plateau, down 2
export const GENTLE_WASHES = [
  { wash: 1, from: 20, A: 10, dir: 68, field: 'rim' }, // j 20–25: up on 20–21, the plateau on A10–11 (j 22–23), down on 24–25
  { wash: 3, from: 28, A: 17, dir: -95, field: 'deep' }, // j 28–33: up on 28–29, the plateau on A17 (j 30–31), down on 32–33
] as const;
export const BOLT_BOOST = 1.6; // × the bolts' glow on a wash turned bolt brightening

export interface FloodPlan {
  wash: 1 | 2 | 3;
  A: number; // the reference age it stands for (its plateau's first, in gentle mode)
  level: number; // its opacity on this frame: the gentle ramp, or 1
  area: number;
  dir: number;
  field: 'rim' | 'deep';
  ints: number[]; // rng(seed, 'flood', ...ints): (wash) in gentle mode, (wash, A) in full
}

// The flood on frame I + j, or null. Gentle W3's ramp down (j 32–33) runs into
// the hold span, which otherwise has no washes.
export function floodAt(ictx: ImpactContext, j: number, opts: WashOptions = {}): FloodPlan | null {
  if (opts.noFlash || j < 9 || j > ictx.jEnd) return null;
  const w1 = opts.washes?.w1 ?? 'flood';
  const w3 = opts.washes?.w3 ?? 'flood';
  if (ictx.flash === 'safe') {
    for (const g of GENTLE_WASHES) {
      const i = j - g.from;
      if (i < 0 || i >= GENTLE_RAMP.length || (g.wash === 1 ? w1 : w3) === 'bolt') continue;
      return { wash: g.wash, A: g.A, level: GENTLE_RAMP[i], area: GENTLE_FLOOD_AREA, dir: g.dir, field: g.field, ints: [g.wash] };
    }
    return null;
  }
  if (j > 31) return null; // the hold span: no washes
  const A = kr(j) - 14;
  const spec = FLOODS.find((s) => s.A === A);
  if (!spec || (spec.wash === 1 && w1 === 'bolt') || (spec.wash === 3 && w3 === 'bolt')) return null;
  return { wash: spec.wash, A, level: 1, area: spec.area, dir: spec.dir, field: spec.field, ints: [spec.wash, A] };
}

// The bolts' glow multiplier on frame I + j: BOLT_BOOST on a wash that became
// a bolt brightening (gentle mode's wash 2 on A15; w1 'bolt' on A10–11; w3
// 'bolt' on A17), else 1. A kr step never changes it mid-step.
export function boltBoost(ictx: ImpactContext, j: number, opts: WashOptions = {}): number {
  if (opts.noFlash || j < 9 || j > 31) return 1;
  const A = kr(j) - 14;
  if (ictx.flash === 'safe' && A === 15) return BOLT_BOOST;
  if (opts.washes?.w1 === 'bolt' && (A === 10 || A === 11)) return BOLT_BOOST;
  if (opts.washes?.w3 === 'bolt' && A === 17) return BOLT_BOOST;
  return 1;
}

export interface FloodLayer {
  role: 'ink' | 'band' | 'fringe' | 'field';
  color: string;
  points: Vec2[]; // frame px, on the frame
}

export interface FloodDrawing extends FloodPlan {
  key: string;
  layers: FloodLayer[]; // outside in, each painted over the last
  outline: Vec2[]; // the whole flood
  share: number; // the outline's share of the frame
  glow: string; // the wash halo's colour
}

const STEP = 0.01; // U: the flood edge's sample spacing
const floods = new Map<string, Pick<FloodDrawing, 'layers' | 'outline' | 'share' | 'glow'>>();

export function floodShapes(ictx: ImpactContext, j: number, opts: WashOptions = {}): FloodDrawing | null {
  const plan = floodAt(ictx, j, opts);
  if (!plan) return null;
  const base = `${sceneKey(ictx)}:${plan.ints.join('.')}:${plan.area}:${plan.dir}:${plan.field}`;
  const geo = memo(floods, base, () => floodGeometry(ictx, plan), 12);
  return { ...plan, ...geo, key: `flood:${base}:${plan.level.toFixed(4)}` };
}

// The flood's layers: the frame beyond a lobed, notched line across `dir`,
// the line set by bisection so the outline covers `area` of the frame.
function floodGeometry(ictx: ImpactContext, plan: FloodPlan): Pick<FloodDrawing, 'layers' | 'outline' | 'share' | 'glow'> {
  const fr = energyFrame(ictx);
  const { width: W, height: H } = ictx;
  const { U, S } = fr;
  const tones = roles(ictx.palette).discharge;
  const r = rng(ictx.seed, 'flood', ...plan.ints);
  const ang = ((plan.dir + uniform(r, -10, 10)) * Math.PI) / 180;
  const nu: Vec2 = [Math.cos(ang) * fr.n[0] + Math.sin(ang) * fr.t[0], Math.cos(ang) * fr.n[1] + Math.sin(ang) * fr.t[1]];
  const tau: Vec2 = [-nu[1], nu[0]];
  const corners: Vec2[] = [[0, 0], [W, 0], [W, H], [0, H]];
  const along = corners.map(([x, y]) => (x - fr.P[0]) * tau[0] + (y - fr.P[1]) * tau[1]);
  const across = corners.map(([x, y]) => (x - fr.P[0]) * nu[0] + (y - fr.P[1]) * nu[1]);
  const s0 = Math.min(...along) - 4;
  const s1 = Math.max(...along) + 4;
  const q0 = Math.min(...across) - 8;
  const q1 = Math.max(...across) + 8;

  // The band: a thin base, with rounded lobes on its outer side.
  const b0 = uniform(r, 0.008, 0.02) * U;
  const lobes: { c: number; hw: number; h: number }[] = [];
  for (let s = s0 + uniform(r, 0, 0.3) * U; s < s1; s += uniform(r, 0.3, 0.5) * U) lobes.push({ c: s, hw: uniform(r, 0.06, 0.12) * U, h: uniform(r, 0.04, 0.1) * U });
  // The field side's notches: a step every 0.03–0.08 U, up or down 0.01–0.02 U.
  const notchAt: { s: number; v: number }[] = [];
  let v = 0;
  for (let s = s0; s < s1; s += uniform(r, 0.03, 0.08) * U) {
    notchAt.push({ s, v });
    const up = v <= 0 ? true : v >= 0.03 * U ? false : r() < 0.5;
    v = clamp(v + (up ? 1 : -1) * uniform(r, 0.01, 0.02) * U, 0, 0.03 * U);
  }
  const samples: number[] = [];
  for (let s = s0; s < s1; s += STEP * U) samples.push(s);
  samples.push(s1);
  for (const n of notchAt.slice(1)) samples.push(n.s - 0.05, n.s + 0.05);
  samples.sort((a, b) => a - b);
  const band = new Float64Array(samples.length);
  const notch = new Float64Array(samples.length);
  let at = 0;
  samples.forEach((s, i) => {
    let b = b0;
    for (const l of lobes) {
      const x = (s - l.c) / l.hw;
      if (x > -1 && x < 1) {
        const c = Math.cos((Math.PI / 2) * x);
        b = Math.max(b, b0 + l.h * c * c);
      }
    }
    band[i] = b;
    while (at + 1 < notchAt.length && notchAt[at + 1].s <= s) at++;
    notch[i] = notchAt[at].v;
  });

  // The region q ≥ edge(s), closed beyond the frame and cut to it. Runs of
  // samples on one straight line (the notches' flats, the band between its
  // lobes) keep their ends only.
  const region = (edge: (i: number) => number): Vec2[] => {
    const pts: Vec2[] = straight(
      samples.map((s, i) => {
        const q = clamp(edge(i), q0, q1);
        return [fr.P[0] + s * tau[0] + q * nu[0], fr.P[1] + s * tau[1] + q * nu[1]];
      }),
    );
    const far = q1 + 16;
    pts.push([fr.P[0] + s1 * tau[0] + far * nu[0], fr.P[1] + s1 * tau[1] + far * nu[1]], [fr.P[0] + s0 * tau[0] + far * nu[0], fr.P[1] + s0 * tau[1] + far * nu[1]]);
    return clipToFrame(pts, W, H);
  };
  const ink0 = Math.max(1, 0.0016 * S);
  const ink1 = Math.max(1.2, 0.0019 * S);
  const fringe = Math.max(1.2, 0.0024 * S);
  // The outline's area as the line moves to `mid`, integrated along the
  // samples: at each, the run of q from the edge to the frame's far side
  // (the frame's span of q there, [qa, qb], is fixed), by the trapezoid rule.
  // Exact where the run is linear between samples, so the bisection needs no
  // polygons.
  const n = samples.length;
  const qa = new Float64Array(n);
  const qb = new Float64Array(n);
  const span = (base: number, d: number, size: number, k: number) => {
    // q where base + q·d stays in [0, size]
    if (Math.abs(d) < 1e-12) {
      if (base < 0 || base > size) qb[k] = -Infinity;
      return;
    }
    const a = (0 - base) / d;
    const b = (size - base) / d;
    qa[k] = Math.max(qa[k], Math.min(a, b));
    qb[k] = Math.min(qb[k], Math.max(a, b));
  };
  for (let k = 0; k < n; k++) {
    qa[k] = -Infinity;
    qb[k] = Infinity;
    span(fr.P[0] + samples[k] * tau[0], nu[0], W, k);
    span(fr.P[1] + samples[k] * tau[1], nu[1], H, k);
  }
  const areaAt = (mid: number) => {
    let sum = 0;
    let prev = 0;
    for (let k = 0; k < n; k++) {
      const q = clamp(mid - band[k] - ink0, q0, q1);
      const run = Math.max(0, qb[k] - Math.max(qa[k], q));
      if (k > 0) sum += ((samples[k] - samples[k - 1]) * (run + prev)) / 2;
      prev = run;
    }
    return sum;
  };
  const target = plan.area * W * H;
  let lo = q0 - Math.max(...band) - ink0 - 8; // all of the frame
  let hi = q1; // none of it
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (areaAt(mid) > target) lo = mid;
    else hi = mid;
  }
  const B = (lo + hi) / 2;
  const fieldEdge = (k: number) => B + notch[k] + ink1 + fringe;
  const steps: [number, string][] =
    plan.field === 'deep'
      ? (() => {
          const d = uniform(r, 0.15, 0.3) * U;
          return [[0, tones.core], [0.3 * d, mixHex(tones.core, tones.pale, 0.33)], [0.62 * d, mixHex(tones.core, tones.pale, 0.66)], [d, tones.pale]];
        })()
      : [[0, mixHex(tones.core, tones.pale, 0.5)], [uniform(r, 0.025, 0.035) * U, tones.core]];
  const all: FloodLayer[] = [
    { role: 'ink', color: tones.edge, points: region((k) => B - band[k] - ink0) },
    { role: 'band', color: tones.band, points: region((k) => B - band[k]) },
    { role: 'ink', color: tones.edge, points: region((k) => B + notch[k]) },
    { role: 'fringe', color: mixHex(tones.core, tones.pale, 0.6), points: region((k) => B + notch[k] + ink1) },
    ...steps.map(([depth, color]): FloodLayer => ({ role: 'field', color, points: region((k) => fieldEdge(k) + depth) })),
  ];
  const layers = all.filter((l) => l.points.length >= 3);
  const outline = layers.length > 0 ? layers[0].points : [];
  return { layers, outline, share: Math.abs(signedArea(outline)) / (W * H), glow: tones.band };
}

// A gentle wash lays one flood at the ramp's levels, a frame each, so below
// level 1 the opaque flood is painted once into a buffer of its own, kept per
// canvas maker with the flood it holds, and each frame lays that at its level.
// The buffer is grown and cleared as throughScratch's is and reaches the box's
// far corner, so at one frame size the pixels are the ones throughScratch
// would lay (checked byte for byte over both ramps, three sizes and seeds).
const held = new WeakMap<MakeScratch, { layers: readonly FloodLayer[]; box: Box; buf: Scratch }>();

export function paintFlood(ctx: BrushTarget, make: MakeScratch, d: FloodDrawing | null, width: number, height: number) {
  if (!d || !(d.level > 0)) return;
  const box = boxOf([d.outline], 2, width, height);
  if (!box) return;
  const paint = (c: BrushTarget) => {
    for (const l of d.layers) fillUnion(c, [l.points], l.color);
  };
  if (d.level >= 1) return paint(ctx);
  let h = held.get(make);
  if (!h || h.layers !== d.layers || h.box.x0 !== box.x0 || h.box.y0 !== box.y0 || h.box.x1 !== box.x1 || h.box.y1 !== box.y1) {
    let buf = h?.buf;
    if (!buf || buf.canvas.width < box.x1 || buf.canvas.height < box.y1) buf = make(Math.max(box.x1, buf?.canvas.width ?? 0), Math.max(box.y1, buf?.canvas.height ?? 0));
    buf.ctx.setTransform(1, 0, 0, 1, 0, 0);
    buf.ctx.globalCompositeOperation = 'source-over';
    buf.ctx.globalAlpha = 1;
    buf.ctx.clearRect(0, 0, buf.canvas.width, buf.canvas.height);
    paint(buf.ctx);
    held.set(make, (h = { layers: d.layers, box, buf }));
  }
  lay(ctx, h.buf, d.level, box);
}

// A flood's wide wash halo (design §7's W buffer), at the flood's level.
export function emitFlood(sink: GlowSink, d: FloodDrawing | null) {
  if (d && d.outline.length >= 3) sink.wash(d.outline, d.glow, d.level);
}

export function floodLayer(ictx: ImpactContext, j: number, make: MakeScratch, opts: WashOptions = {}): LayerDraw | null {
  const d = floodShapes(ictx, j, opts);
  if (!d) held.delete(make); // between washes, no flood buffer is kept
  return d ? { key: d.key, draw: (ctx) => paintFlood(ctx, make, d, ictx.width, ictx.height) } : null;
}

// ---- The dust-wash veil, A5–6 -------------------------------------------------------------------

// compositing §2.7: α 0.64 (transmission 0.36), #84766f…#8d7775, feathered
// 0.04–0.055 S, at most 0.35 over the person mask.
export const VEIL = { alpha: 0.64, person: 0.35, color: '#8a7772', feather: [0.04, 0.055], group: 3 } as const;
const VEIL_SUB = 0x7e11; // rng(seed, 'dust', g, VEIL_SUB): apart from the dust layer's own draws
const VEIL_POINTS = 64;

export interface VeilDrawing {
  key: string;
  g: number;
  alpha: number; // in the middle, past the feather
  personAlpha: number; // over the person
  color: string;
  rings: Vec2[][]; // outermost first: 4 nested fills at ringAlpha make the feather
  ringAlpha: number;
}

// The veil on frame f: on hold group 3 only (A5–6). The dust wave is a lumpy
// dome over P, t ±0.62 U, n −0.14..+0.58 U, its top torn into lumps.
export function veilShapes(ictx: EnergyContext, f: number, opts: WashOptions = {}): VeilDrawing | null {
  if (opts.noFlash) return null;
  const clock = groupClock(ictx, f);
  if (!clock || clock.g !== VEIL.group || !(clock.alpha > 0)) return null;
  const fr = energyFrame(ictx);
  const unit = fr.U * clock.zoom;
  const r = rng(ictx.seed, 'dust', clock.g, VEIL_SUB);
  const alpha = (ictx.flash === 'safe' ? Math.min(VEIL.alpha, liftCap(VEIL.color)) : VEIL.alpha) * clock.alpha;
  const nc = uniform(r, 0.2, 0.24);
  const nh = uniform(r, 0.34, 0.39);
  const tw = uniform(r, 0.58, 0.66);
  const ph = [uniform(r, 0, TAU), uniform(r, 0, TAU), uniform(r, 0, TAU)];
  const pts: Vec2[] = [];
  for (let i = 0; i < VEIL_POINTS; i++) {
    const th = (TAU * i) / VEIL_POINTS;
    const top = Math.max(0, Math.cos(th));
    const lump = 1 + top * (0.07 * Math.sin(3 * th + ph[0]) + 0.05 * Math.sin(7 * th + ph[1]) + 0.03 * Math.sin(13 * th + ph[2]));
    pts.push(onFloor(fr, unit, nc + nh * Math.cos(th) * lump, tw * Math.sin(th) * lump));
  }
  const centre = onFloor(fr, unit, nc, 0);
  const feather = uniform(r, VEIL.feather[0], VEIL.feather[1]) * fr.S;
  const rings = [0, 1, 2, 3].map((k) => shrink(pts, centre, (k * feather) / 3));
  return {
    key: `veil:${sceneKey(ictx)}:${clock.g}:${alpha.toFixed(4)}:${f}`, // the person cut is the frame's own
    g: clock.g,
    alpha,
    personAlpha: (alpha * VEIL.person) / VEIL.alpha,
    color: VEIL.color,
    rings,
    ringAlpha: 1 - (1 - alpha) ** 0.25,
  };
}

// Each point moved toward c by d px (a star-shaped polygon's inward offset, near enough).
function shrink(pts: readonly Vec2[], c: Vec2, d: number): Vec2[] {
  return pts.map(([x, y]): Vec2 => {
    const len = hyp(x - c[0], y - c[1]);
    const k = len > 0 ? Math.max(0, 1 - d / len) : 0;
    return [c[0] + (x - c[0]) * k, c[1] + (y - c[1]) * k];
  });
}

export function paintVeil(ctx: BrushTarget, make: MakeScratch, v: VeilDrawing | null, mask: Mask | null, width: number, height: number) {
  if (!v) return;
  const box = boxOf([v.rings[0]], 2, width, height);
  if (!box) return;
  throughScratch(
    ctx,
    make,
    1,
    box,
    (c) => {
      c.globalAlpha = v.ringAlpha;
      for (const ring of v.rings) fillUnion(c, [ring], v.color);
      c.globalAlpha = 1;
    },
    mask ? (c) => cutPerson(c, box, mask, 1 - v.personAlpha / v.alpha, width, height) : undefined,
  );
}

export function veilLayer(ictx: EnergyContext, f: number, make: MakeScratch, opts: WashOptions = {}): LayerDraw | null {
  const v = veilShapes(ictx, f, opts);
  if (!v) return null;
  const mask = ictx.personMask(f);
  return { key: v.key, draw: (ctx) => paintVeil(ctx, make, v, mask, ictx.width, ictx.height) };
}

// ---- The A5–6 white flash ---------------------------------------------------------------------------

// destruction §4.6, §6.8: the frame less a hole round the cluster and dust
// (t −0.51..+0.50, n −0.13..+0.70 U), 4–5 floor splinters at n −0.42..−0.14,
// a window at t +0.59..+0.75, n 0.34..0.66, and the person; one light tone,
// at most 15 % toward p0, at about 0.4 opacity; a hard cut at A7.
export const FLASH = { alpha: 0.4, ages: [5, 6], tint: 0.15 } as const;
export const GENTLE_FLASH_AREA = 0.22; // gentle mode: at most this share of the frame, under the 25 % cap
const FLASH_SUB = 0xf1a5; // rng(seed, 'wisp', k, FLASH_SUB): apart from the wisps' own draws

export interface FlashDrawing {
  key: string;
  k: number; // the global drawing
  A: number;
  alpha: number;
  color: string;
  holes: Vec2[][]; // on the frame: the main hole first
  share: number; // of the frame, before the person is cut out
}

export function flashShapes(ictx: EnergyContext, f: number, opts: WashOptions = {}): FlashDrawing | null {
  if (opts.noFlash) return null;
  const j = f - ictx.I;
  if (j < 9 || j > ictx.jEnd) return null;
  const { k, start, A } = drawingClock(ictx, f);
  if (A !== FLASH.ages[0] && A !== FLASH.ages[1]) return null;
  const fr = energyFrame(ictx);
  const { width: W, height: H } = ictx;
  const unit = fr.U * (ZOOM_PEAK / zoomAt(start - ictx.I)); // the hole is round the masses, so it scales with them
  const r = rng(ictx.seed, 'wisp', k, FLASH_SUB);
  const ph = [uniform(r, 0, TAU), uniform(r, 0, TAU)];
  const hole = (scale: number): Vec2[] => {
    const out: Vec2[] = [];
    for (let i = 0; i < 48; i++) {
      const th = (TAU * i) / 48;
      const lump = 1 + 0.05 * Math.sin(5 * th + ph[0]) + 0.03 * Math.sin(9 * th + ph[1]);
      out.push(onFloor(fr, unit, 0.285 + 0.415 * scale * Math.cos(th) * lump, -0.005 + 0.505 * scale * Math.sin(th) * lump));
    }
    return out;
  };
  const extra: Vec2[][] = [];
  for (let i = 0, count = int(r, 4, 5); i < count; i++) {
    const n = uniform(r, -0.42, -0.14);
    const t = uniform(r, -0.45, 0.45);
    const len = uniform(r, 0.05, 0.1);
    const wid = uniform(r, 0.012, 0.025);
    const a = uniform(r, 0, Math.PI);
    const pt = (l: number, w: number) => onFloor(fr, unit, n + l * Math.cos(a) - w * Math.sin(a), t + l * Math.sin(a) + w * Math.cos(a));
    extra.push([pt(len / 2, 0), pt(0, wid / 2), pt(-len / 2, 0), pt(0, -wid / 2)]);
  }
  const win: Vec2[] = [];
  for (let i = 0; i < 16; i++) win.push(onFloor(fr, unit, 0.5 + 0.13 * Math.cos((TAU * i) / 16), 0.67 + 0.065 * Math.sin((TAU * i) / 16)));
  extra.push(win);
  const area = (poly: Vec2[]) => Math.abs(signedArea(clipToFrame(poly, W, H)));
  let scale = 1;
  if (ictx.flash === 'safe') {
    // Gentle: the hole grows until the flash covers at most 22 %, and the
    // small holes go (grown, it swallows them, and even-odd would fill their
    // overlap back in).
    const share = (s: number) => 1 - area(hole(s)) / (W * H);
    if (share(1) > GENTLE_FLASH_AREA) {
      let lo = 1;
      let hi = 2;
      while (share(hi) > GENTLE_FLASH_AREA && hi < 256) hi *= 2;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (share(mid) > GENTLE_FLASH_AREA) lo = mid;
        else hi = mid;
      }
      scale = hi;
    }
    extra.length = 0;
  }
  const whole = hole(scale);
  const main = clipToFrame(whole, W, H);
  const holes: Vec2[][] = main.length >= 3 ? [main] : [];
  for (const p of extra) {
    // A small hole that touches another is dropped: even-odd would fill the overlap.
    const cut = clipToFrame(p, W, H);
    if (cut.length < 3 || p.some((q) => inside(whole, q)) || holes.some((h) => h.some((q) => inside(cut, q)) || cut.some((q) => inside(h, q)))) continue;
    holes.push(cut);
  }
  const color = roles(ictx.palette).tint(FLASH.tint);
  const alpha = ictx.flash === 'safe' ? Math.min(FLASH.alpha, liftCap(color)) : FLASH.alpha;
  const share = 1 - holes.reduce((s, h) => s + Math.abs(signedArea(h)), 0) / (W * H);
  return { key: `flash:${sceneKey(ictx)}:${k}:${scale.toFixed(4)}:${f}`, k, A, alpha, color, holes, share };
}

export function paintFlash(ctx: BrushTarget, make: MakeScratch, fl: FlashDrawing | null, mask: Mask | null, width: number, height: number) {
  if (!fl || !(fl.alpha > 0)) return;
  const box: Box = { x0: 0, y0: 0, x1: width, y1: height };
  const frame: Vec2[] = [[0, 0], [width, 0], [width, height], [0, height]];
  throughScratch(ctx, make, fl.alpha, box, (c) => fillEvenOdd(c, [frame, ...fl.holes], fl.color), mask ? (c) => cutPerson(c, box, mask, 1, width, height) : undefined);
}

export function flashLayer(ictx: EnergyContext, f: number, make: MakeScratch, opts: WashOptions = {}): LayerDraw | null {
  const fl = flashShapes(ictx, f, opts);
  if (!fl) return null;
  const mask = ictx.personMask(f);
  return { key: fl.key, draw: (ctx) => paintFlash(ctx, make, fl, mask, ictx.width, ictx.height) };
}
