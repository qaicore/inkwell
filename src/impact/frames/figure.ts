// The figure on the impact frames (impact design §5, "The figure"; study
// impact.md §7.7): him, his limbs and every one of his impact strokes, as flat
// two-tone shapes.
//   - The person: the mask on the poster's first frame, traced to polygons
//     (marching squares, Douglas–Peucker to 0.6 px), once per mask.
//   - The limbs: each tube's silhouette at its pose on that frame, pinned on P
//     (limbs first); the caller supplies the polygons.
//   - The mark: every impact stroke, 1.5× as drawn. A stroke with an end within
//     0.08 S of P draws on from that end, ease.cracks((si+1)/4) of its length
//     ('out': 58, 88, 98 and 100 % on IF1–IF4; IF5–IF7 whole); any other stroke
//     (scattered marks, a ring, a scribble) is drawn whole from IF1, because a
//     half-drawn scribble reads as a glitch.
// The styling per poster: IF1 ink with a 0.012 S paper rim facing P; IF2 XOR
// with the split; IF3 paper with a 0.006 S ink contour; IF4 ink; IF5 paper with
// the hot glow; IF6 a contour, the limbs with 3 accent recoil copies 0.03 S apart along −u; IF7
// the limbs as paper (the comet's), the person ink with a 0.006 S paper rim
// facing P. The rim facing P is the band of mask pixels x where
// x + δ·(P − x)/|P − x| falls outside the mask: the figure moved away from P by
// δ, clipped to the figure, is the body (rimBody); what's left is the rim.
// The ink guard (draw.ts) can ask for the body as a contour, limbs kept solid.
import type { Ease, Vec2 } from '../../types/effect.ts';
import type { BrushTarget, MakeScratch, Scratch } from '../../render/glow.ts';
import { DEFAULT_BRUSH, strokeOutline } from '../../render/brush.ts';
import type { Mask } from '../../track/tracking.ts';
import type { Crack, GlowSink, ImpactContext } from '../contracts.ts';
import { posterFirstJ, type PosterSpec } from './gentle.ts';

export const MARK_WIDTH = 1.5; // × the stroke as drawn
export const AT_P = 0.08; // S: a stroke end this near P draws on from there
export const RIM_IF1 = 0.012; // S
export const RIM_IF7 = 0.006; // S
export const CONTOUR = 0.006; // S
export const EDGE = 0.006; // S: in the light comp, ink this near paper is thin ink (the edge tone); deeper is core (p2)
const THIN = 0.01; // S: a mark thinner than this (twice its area over its outline) is thin ink throughout
export const RECOIL = { copies: 3, step: 0.03 } as const; // IF6: copies stepped this far (S) along −u
const TRACE_TOLERANCE = 0.6; // mask px
const MARK_TOLERANCE = 0.5; // frame px
const SPECK = 2; // px²: smaller traced loops are dropped
const PEAK_WIDTH = 2 * Math.sin((Math.PI / 2) * (0.5 + DEFAULT_BRUSH.thinning / 2)); // perfect-freehand's width at full pressure, × size

// A 2D context the posters paint with: the brushes' target plus lines, arcs,
// clips and gradients. The browser's canvas and @napi-rs/canvas both have it.
export interface PosterTarget extends BrushTarget {
  strokeStyle: unknown;
  lineWidth: number;
  lineJoin: string;
  lineCap: string;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, start: number, end: number, ccw?: boolean): void;
  rect(x: number, y: number, w: number, h: number): void;
  stroke(): void;
  fill(rule?: 'nonzero' | 'evenodd'): void;
  clip(rule?: 'nonzero' | 'evenodd'): void;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): { addColorStop(offset: number, color: string): void };
}

export interface PosterFigure {
  person: Vec2[][]; // traced loops, frame px: outlines of positive signed area, holes negative
  personArea: number; // px²
  personLength: number; // the loops' total length, px (a contour's ink)
  limbs: Vec2[][]; // frame px, positive signed area
  limbArea: number;
  marks: Vec2[][]; // the impact strokes at this poster's draw-on, frame px, positive signed area
  markArea: number;
}

export interface FigureInput {
  person?: Mask | null; // missing: ictx.personMask on the poster's first frame
  limbs?: readonly (readonly Vec2[])[]; // each limb's silhouette on that frame, frame px
}

export type FigureContext = Pick<ImpactContext, 'I' | 'frame' | 'width' | 'height' | 'cracks' | 'crackEase' | 'personMask'>;
export type MarkContext = Pick<ImpactContext, 'frame' | 'width' | 'cracks' | 'crackEase'>;

export const NO_FIGURE: PosterFigure = { person: [], personArea: 0, personLength: 0, limbs: [], limbArea: 0, marks: [], markArea: 0 };

// The figure for poster si.
export function posterFigure(ictx: FigureContext, si: number, input: FigureInput = {}): PosterFigure {
  const mask = input.person !== undefined ? input.person : ictx.personMask(ictx.I + posterFirstJ(si));
  const traced = mask ? personLoops(mask, ictx.width / mask.width, ictx.height / mask.height) : null;
  const limbs = (input.limbs ?? []).filter((l) => l.length >= 3).map((l) => oriented(l.map((p): Vec2 => [p[0], p[1]])));
  const marks = markOutlines(ictx, si);
  return {
    person: traced?.loops ?? [],
    personArea: traced?.area ?? 0,
    personLength: traced?.length ?? 0,
    limbs,
    limbArea: limbs.reduce((s, l) => s + signedArea(l), 0),
    marks,
    markArea: marks.reduce((s, m) => s + signedArea(m), 0),
  };
}

// ---- The mark -----------------------------------------------------------------------

// The four eases at t in 0..1.
export function easeAt(ease: Ease, t: number): number {
  const x = Math.min(1, Math.max(0, t));
  switch (ease) {
    case 'linear':
      return x;
    case 'in':
      return x * x * x;
    case 'out':
      return 1 - (1 - x) ** 3;
    case 'hold-snap':
      return x >= 1 ? 1 : 0;
  }
}

// How much of a stroke that starts at P poster si shows: ease.cracks((si+1)/4).
export const crackFraction = (ease: Ease, si: number): number => easeAt(ease, Math.min(1, (si + 1) / 4));

// The end of a stroke within 0.08 S of P, the nearer if both are; null if neither.
export function drawOnEnd(points: readonly Vec2[], P: Vec2, S: number): 'start' | 'end' | null {
  if (points.length === 0) return null;
  const a = Math.hypot(points[0][0] - P[0], points[0][1] - P[1]);
  const b = Math.hypot(points[points.length - 1][0] - P[0], points[points.length - 1][1] - P[1]);
  if (Math.min(a, b) > AT_P * S) return null;
  return a <= b ? 'start' : 'end';
}

// The first `fraction` of a polyline by length, the pressure carried along.
export function drawOn(points: readonly Vec2[], pressure: readonly number[], fraction: number): { points: Vec2[]; pressure: number[] } {
  const f = Math.min(1, Math.max(0, fraction));
  const along = [0];
  for (let i = 1; i < points.length; i++) along.push(along[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  const total = along[along.length - 1];
  const pr = (i: number) => pressure[Math.min(i, pressure.length - 1)] ?? 1;
  if (f >= 1 || total === 0) return { points: points.map((p): Vec2 => [p[0], p[1]]), pressure: points.map((_, i) => pr(i)) };
  const target = f * total;
  const out: Vec2[] = [[points[0][0], points[0][1]]];
  const outP = [pr(0)];
  for (let i = 1; i < points.length; i++) {
    if (along[i] < target) {
      out.push([points[i][0], points[i][1]]);
      outP.push(pr(i));
      continue;
    }
    const w = (target - along[i - 1]) / (along[i] - along[i - 1]);
    out.push([points[i - 1][0] + (points[i][0] - points[i - 1][0]) * w, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * w]);
    outP.push(pr(i - 1) + (pr(i) - pr(i - 1)) * w);
    break;
  }
  return { points: out, pressure: outP };
}

// Every impact stroke as poster si draws it: drawn on from its P end, 1.5×
// as wide, as outlines in frame px. The brush size is px at 1080 wide. The
// outlines are shared with later calls: callers don't change them.
export function markOutlines(ictx: MarkContext, si: number): Vec2[][] {
  const scale = ictx.width / 1080;
  const out: Vec2[][] = [];
  for (const crack of ictx.cracks) {
    if (crack.points.length === 0) continue;
    const fraction = crack.fromP ? crackFraction(ictx.crackEase, si) : 1;
    if (fraction <= 0) continue;
    const outline = markOutline(crack, fraction, scale);
    if (outline) out.push(outline);
  }
  return out;
}

// A stroke's outline is most of a poster's figure's cost (perfect-freehand),
// and the same on every replay while the strokes don't change: cached per
// crack, by draw-on fraction, scale and brush, and dropped when the crack's
// points or pressure arrays are replaced.
interface MarkEntry {
  points: readonly Vec2[];
  pressure: readonly number[];
  fromP: Crack['fromP'];
  outlines: Map<string, Vec2[] | null>;
}
const markCache = new WeakMap<Crack, MarkEntry>();

function markOutline(crack: Crack, fraction: number, scale: number): Vec2[] | null {
  let entry = markCache.get(crack);
  if (!entry || entry.points !== crack.points || entry.pressure !== crack.pressure || entry.fromP !== crack.fromP) {
    entry = { points: crack.points, pressure: crack.pressure, fromP: crack.fromP, outlines: new Map() };
    markCache.set(crack, entry);
  }
  const { size, thinning, smoothing, streamline } = crack.brush;
  const key = `${fraction} ${scale} ${size} ${thinning} ${smoothing} ${streamline}`;
  const hit = entry.outlines.get(key);
  if (hit !== undefined) return hit;
  const reversed = crack.fromP === 'end';
  const points = reversed ? [...crack.points].reverse() : crack.points;
  const pressure = reversed ? [...crack.pressure].reverse() : crack.pressure;
  const cut = drawOn(points, pressure, fraction);
  const outline = strokeOutline(cut.points, cut.pressure, { size: size * MARK_WIDTH, thinning, smoothing, streamline }, scale);
  const result = outline.length >= 3 ? oriented(simplifyClosed(outline, MARK_TOLERANCE)) : null;
  entry.outlines.set(key, result);
  return result;
}

// ---- Tracing the person ----------------------------------------------------------------

const traced = new WeakMap<Mask, Map<string, Traced>>();
interface Traced {
  loops: Vec2[][];
  area: number;
  length: number;
}

// The traced person, scaled to frame px; cached per mask and scale.
function personLoops(mask: Mask, sx: number, sy: number): Traced {
  let byScale = traced.get(mask);
  if (!byScale) traced.set(mask, (byScale = new Map()));
  const key = `${sx},${sy}`;
  let t = byScale.get(key);
  if (!t) {
    const { loops, area } = traceMask(mask);
    const scaled = loops.map((l) => l.map((p): Vec2 => [p[0] * sx, p[1] * sy]));
    t = { loops: scaled, area: area * sx * sy, length: scaled.reduce((s, l) => s + perimeter(l), 0) };
    byScale.set(key, t);
  }
  return t;
}

// A soft mask's outline at `threshold`, in mask px (pixel centres at +0.5), by
// marching squares with the crossings interpolated: outlines come out with
// positive signed area (y down) and holes negative, so one nonzero fill draws
// the person. `area` counts the pixels at or over the threshold.
export function traceMask(mask: Mask, threshold = 128, tolerance = TRACE_TOLERANCE): { loops: Vec2[][]; area: number } {
  const { width: w, height: h, alpha } = mask;
  let x0 = w;
  let x1 = -1;
  let y0 = h;
  let y1 = -1;
  let area = 0;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (alpha[row + x] < threshold) continue;
      area++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  if (area === 0) return { loops: [], area: 0 };
  // Corners on pixel centres, one pixel past the box on every side.
  const gx = x0 - 1;
  const gy = y0 - 1;
  const GW = x1 - x0 + 3;
  const GH = y1 - y0 + 3;
  const V = new Uint8Array(GW * GH);
  for (let cy = 0; cy < GH; cy++) {
    const y = gy + cy;
    if (y < 0 || y >= h) continue;
    for (let cx = 0; cx < GW; cx++) {
      const x = gx + cx;
      if (x >= 0 && x < w) V[cy * GW + cx] = alpha[y * w + x];
    }
  }
  // Edge ids: 2·corner for the edge to the right, 2·corner + 1 for the one below.
  const next = new Int32Array(2 * GW * GH).fill(-1);
  const ex = new Float32Array(2 * GW * GH);
  const ey = new Float32Array(2 * GW * GH);
  const starts: number[] = [];
  const cross = (e: number) => {
    const c = e >> 1;
    const cx = c % GW;
    const cy = (c - cx) / GW;
    const a = V[c];
    const b = e & 1 ? V[c + GW] : V[c + 1];
    const t = b === a ? 0.5 : Math.min(1, Math.max(0, (threshold - a) / (b - a)));
    ex[e] = gx + cx + 0.5 + (e & 1 ? 0 : t);
    ey[e] = gy + cy + 0.5 + (e & 1 ? t : 0);
  };
  const seg = (from: number, to: number) => {
    next[from] = to;
    starts.push(from);
    cross(from);
  };
  for (let cy = 0; cy < GH - 1; cy++) {
    for (let cx = 0; cx < GW - 1; cx++) {
      const c = cy * GW + cx;
      const tl = V[c] >= threshold ? 1 : 0;
      const tr = V[c + 1] >= threshold ? 2 : 0;
      const br = V[c + GW + 1] >= threshold ? 4 : 0;
      const bl = V[c + GW] >= threshold ? 8 : 0;
      const code = tl | tr | br | bl;
      if (code === 0 || code === 15) continue;
      const T = 2 * c;
      const B = 2 * (c + GW);
      const L = 2 * c + 1;
      const R = 2 * (c + 1) + 1;
      // Walking each segment, the inside is on the right (y down).
      switch (code) {
        case 1: seg(T, L); break;
        case 2: seg(R, T); break;
        case 3: seg(R, L); break;
        case 4: seg(B, R); break;
        case 6: seg(B, T); break;
        case 7: seg(B, L); break;
        case 8: seg(L, B); break;
        case 9: seg(T, B); break;
        case 11: seg(R, B); break;
        case 12: seg(L, R); break;
        case 13: seg(T, R); break;
        case 14: seg(L, T); break;
        case 5:
        case 10: {
          const joined = (V[c] + V[c + 1] + V[c + GW] + V[c + GW + 1]) / 4 >= threshold;
          if (code === 5) {
            if (joined) { seg(T, R); seg(B, L); } else { seg(T, L); seg(B, R); }
          } else if (joined) { seg(L, T); seg(R, B); } else { seg(R, T); seg(L, B); }
          break;
        }
      }
    }
  }
  const loops: Vec2[][] = [];
  for (const s of starts) {
    if (next[s] < 0) continue;
    const loop: Vec2[] = [];
    let e = s;
    while (next[e] >= 0) {
      loop.push([ex[e], ey[e]]);
      const n = next[e];
      next[e] = -2;
      e = n;
    }
    if (loop.length < 3) continue;
    const simple = simplifyClosed(loop, tolerance);
    if (simple.length >= 3 && Math.abs(signedArea(simple)) >= SPECK) loops.push(simple);
  }
  return { loops, area };
}

// ---- Polygons ------------------------------------------------------------------------

// Shoelace, y down: positive for a loop that runs clockwise on screen.
export function signedArea(pts: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

export const oriented = (pts: Vec2[]): Vec2[] => (signedArea(pts) < 0 ? pts.reverse() : pts);

export function perimeter(pts: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0, n = pts.length; i < n; i++) s += Math.hypot(pts[(i + 1) % n][0] - pts[i][0], pts[(i + 1) % n][1] - pts[i][1]);
  return s;
}

// Douglas–Peucker on a closed loop, split at the point farthest from the first.
export function simplifyClosed(loop: readonly Vec2[], tolerance: number): Vec2[] {
  const n = loop.length;
  if (n <= 4) return loop.map((p): Vec2 => [p[0], p[1]]);
  let far = 0;
  let best = -1;
  for (let i = 1; i < n; i++) {
    const d = (loop[i][0] - loop[0][0]) ** 2 + (loop[i][1] - loop[0][1]) ** 2;
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const a = simplifyOpen(loop.slice(0, far + 1), tolerance);
  const b = simplifyOpen([...loop.slice(far), loop[0]], tolerance);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

export function simplifyOpen(pts: readonly Vec2[], tolerance: number): Vec2[] {
  const n = pts.length;
  if (n <= 2) return pts.map((p): Vec2 => [p[0], p[1]]);
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: number[] = [0, n - 1];
  const tol2 = tolerance * tolerance;
  while (stack.length) {
    const j = stack.pop()!;
    const i = stack.pop()!;
    const [ax, ay] = pts[i];
    const dx = pts[j][0] - ax;
    const dy = pts[j][1] - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let at = -1;
    for (let k = i + 1; k < j; k++) {
      const px = pts[k][0] - ax;
      const py = pts[k][1] - ay;
      const t = len2 > 0 ? Math.min(1, Math.max(0, (px * dx + py * dy) / len2)) : 0;
      const d = (px - t * dx) ** 2 + (py - t * dy) ** 2;
      if (d > worst) {
        worst = d;
        at = k;
      }
    }
    if (worst > tol2) {
      keep[at] = 1;
      stack.push(i, at, at, j);
    }
  }
  const out: Vec2[] = [];
  for (let k = 0; k < n; k++) if (keep[k]) out.push([pts[k][0], pts[k][1]]);
  return out;
}

// What's left of a loop under a rim δ px wide facing P: the loop moved δ
// away from P and clipped to itself, built without the clip (a clip costs
// as much as another fill). Each vertex whose outward normal faces P moves
// δ away from P, into the shape; the rest stay, which is where the clip
// would have cut the moved loop; a vertex turning side-on to P blends
// between the two over the last 0.2 of the normal's cosine. Where the shape
// is thinner than δ the moved side can cross the far one, a sliver the clip
// would have left as rim.
export function rimBody(loop: readonly Vec2[], P: Vec2, d: number): Vec2[] {
  const n = loop.length;
  if (n < 3 || d === 0) return loop.map((p): Vec2 => [p[0], p[1]]);
  const out: Vec2[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = loop[(i + n - 1) % n];
    const p = loop[i];
    const b = loop[(i + 1) % n];
    const l1 = Math.hypot(p[0] - a[0], p[1] - a[1]) || 1;
    const l2 = Math.hypot(b[0] - p[0], b[1] - p[1]) || 1;
    // The outward normal, y down: the bisector of the edges' (e_y, −e_x).
    let nx = (p[1] - a[1]) / l1 + (b[1] - p[1]) / l2;
    let ny = -(p[0] - a[0]) / l1 - (b[0] - p[0]) / l2;
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl;
    ny /= nl;
    const mx = p[0] - P[0];
    const my = p[1] - P[1];
    const ml = Math.hypot(mx, my);
    if (ml < 1e-9) {
      out[i] = [p[0], p[1]];
      continue;
    }
    const w = Math.min(1, Math.max(0, -(nx * mx + ny * my) / ml / 0.2));
    out[i] = [p[0] + (d * w * mx) / ml, p[1] + (d * w * my) / ml];
  }
  return out;
}

// ---- Painting ------------------------------------------------------------------------
// Every line here is a fill: a canvas stroke rasterises several times slower
// than a fill of the same edges, and the posters have 8 ms each. A contour is
// the shape grown by half the line in the line's tone, then shrunk by half in
// the inside's tone; a fringe is the shape grown in the fringe's tone, under it.

export function addLoops(ctx: PosterTarget, loops: readonly (readonly Vec2[])[], dx = 0, dy = 0) {
  for (const loop of loops) {
    if (loop.length < 2) continue;
    ctx.moveTo(loop[0][0] + dx, loop[0][1] + dy);
    for (let i = 1; i < loop.length; i++) ctx.lineTo(loop[i][0] + dx, loop[i][1] + dy);
    ctx.closePath();
  }
}

// `loops` filled in `color`, as one path, or with `each` one path per loop,
// so outlines that cross themselves (a limb's, a brush stroke's) can't cancel
// another's winding where they overlap. One path is the cheaper; the passes
// that only shape a figure's edge (contours, rims, fringes) take it.
export function fillLoops(ctx: PosterTarget, loops: readonly (readonly Vec2[])[], color: string, each = false, dx = 0, dy = 0) {
  if (loops.length === 0) return;
  ctx.fillStyle = color;
  if (!each) {
    ctx.beginPath();
    addLoops(ctx, loops, dx, dy);
    ctx.fill();
    return;
  }
  for (const loop of loops) {
    ctx.beginPath();
    addLoops(ctx, [loop], dx, dy);
    ctx.fill();
  }
}

// A loop with each vertex moved d px along its outward normal (the bisector
// of its edges' normals, the miter capped at 2d): d > 0 grows the shape and
// d < 0 shrinks it. A hole's loop runs the other way, so it shrinks as the
// shape grows. Where a part is thinner than −2d the shrunk loop turns inside
// out; filled nonzero, it still lies inside the part.
export function offsetLoop(loop: readonly Vec2[], d: number): Vec2[] {
  const n = loop.length;
  if (n < 3 || d === 0) return loop.map((p): Vec2 => [p[0], p[1]]);
  const out: Vec2[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = loop[(i + n - 1) % n];
    const p = loop[i];
    const b = loop[(i + 1) % n];
    const l1 = Math.hypot(p[0] - a[0], p[1] - a[1]) || 1;
    const l2 = Math.hypot(b[0] - p[0], b[1] - p[1]) || 1;
    // Outward normals, y down: (e_y, −e_x) for a loop of positive area.
    const n1x = (p[1] - a[1]) / l1;
    const n1y = -(p[0] - a[0]) / l1;
    const n2x = (b[1] - p[1]) / l2;
    const n2y = -(b[0] - p[0]) / l2;
    let mx = n1x + n2x;
    let my = n1y + n2y;
    const ml = Math.hypot(mx, my);
    if (ml < 1e-9) {
      mx = n1x;
      my = n1y;
    } else {
      mx /= ml;
      my /= ml;
    }
    const k = d / Math.max(0.5, mx * n1x + my * n1y);
    out[i] = [p[0] + k * mx, p[1] + k * my];
  }
  return out;
}

export const offsetLoops = (loops: readonly (readonly Vec2[])[], d: number): Vec2[][] => loops.map((l) => offsetLoop(l, d));

// The band between `grown` and `shrunk` (a contour's line once its inside is
// filled) in `color`, over whatever lies on the inside by now: one nonzero
// path, the grown loops and the shrunk ones reversed, clipped (even-odd) off
// the inside of the shrunk ones, so that a limb's line can't show inside his
// body: the same union contour() leaves. The clip is only his box.
function band(ctx: PosterTarget, grown: readonly Vec2[][], shrunk: readonly Vec2[][], color: string, width: number, height: number) {
  const box = pixelBox(grown, 0, 0, width, height);
  if (!box) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(box[0], box[1], box[2], box[3]);
  addLoops(ctx, shrunk);
  ctx.clip('evenodd');
  ctx.fillStyle = color;
  ctx.beginPath();
  addLoops(ctx, grown);
  addLoops(ctx, shrunk.map((l) => l.slice().reverse()));
  ctx.fill('nonzero');
  ctx.restore();
}

// f, once: later calls do nothing.
function once(f: (() => void) | null | undefined): (() => void) | null {
  if (!f) return null;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    f();
  };
}

// A contour `line` px wide on the loops, centred on their edge: `edge` on the
// line, `inside` within it, the whole moved by (dx, dy).
function contour(ctx: PosterTarget, loops: readonly Vec2[][], line: number, edge: string, inside: string, dx = 0, dy = 0) {
  if (loops.length === 0) return;
  fillLoops(ctx, offsetLoops(loops, line / 2), edge, false, dx, dy);
  fillLoops(ctx, offsetLoops(loops, -line / 2), inside, false, dx, dy);
}

// `body` with a `rim`-toned band δ wide on the side facing P; with `rim` null
// the rim is whatever is already under the loops (IF1's cream fringe fill).
function rimmed(ctx: PosterTarget, loops: Vec2[][], P: Vec2, d: number, body: string, rim: string | null) {
  if (loops.length === 0) return;
  if (rim) fillLoops(ctx, loops, rim);
  fillLoops(ctx, loops.map((l) => rimBody(l, P, d)), body);
}

// `inside` where the shapes cross the disc, `outside` elsewhere: IF2's XOR.
// The shapes in `outside`, then clipped to the disc in `inside`: one clip.
export function xorFill(ctx: PosterTarget, loops: readonly Vec2[][], disc: readonly Vec2[], inside: string, outside: string) {
  if (loops.length === 0) return;
  fillLoops(ctx, loops, outside);
  ctx.save();
  ctx.beginPath();
  addLoops(ctx, [disc]);
  ctx.clip();
  fillLoops(ctx, loops, inside);
  ctx.restore();
}

export interface FigurePaint {
  si: number;
  spec: PosterSpec;
  ink: string; // the poster's tones
  paper: string;
  accent: string;
  ring: string;
  P: Vec2;
  u: Vec2;
  S: number;
  width: number; // frame px
  height: number;
  disc: Vec2[] | null; // IF2's ink disc, for the XOR
  contour: boolean; // the ink guard's call: the body as a contour, the limbs kept solid
  emit: string | null; // the colour paper parts glow in (the dark posters' comp), or null
  fringe?: { color: string; width: number } | null; // a fringe this wide (px) round ink fills, under them (the light comp, where it shows)
  scratch?: MakeScratch | null; // a scratch canvas maker: IF6 draws its recoil copy once and blits it
  edge?: string | null; // the light comp's thin ink: his contour, thin marks and the EDGE band round his solid ink (null: ink throughout)
  over?: (() => void) | null; // paints what lies over him (draw.ts's Z.over): IF3 and IF6 call it between his paper fill and his contour, the rest after him
}

// His mark and the figure, in that order (the mark is under him), then what
// lies over him if the figure didn't paint it. On IF2's ink split both XOR
// with the disc in one pass, since they take the same tone on either side of
// its edge.
export function paintMarksAndFigure(ctx: PosterTarget, sink: GlowSink, fig: PosterFigure, p: FigurePaint) {
  const q: FigurePaint = { ...p, over: once(p.over) };
  if (q.si === 1 && q.spec.disc === 'ink' && q.disc) xorFill(ctx, [...fig.person, ...fig.limbs, ...fig.marks], q.disc, q.paper, q.ink);
  else {
    paintMarks(ctx, sink, fig.marks, q);
    paintFigure(ctx, sink, fig, q);
  }
  q.over?.();
}

// The figure as poster si draws it (the table at the top of this file).
export function paintFigure(ctx: PosterTarget, sink: GlowSink, fig: PosterFigure, p: FigurePaint) {
  const { person, limbs } = fig;
  const over = once(p.over);
  if (person.length === 0 && limbs.length === 0) {
    over?.();
    return;
  }
  const light = p.spec.field === 'light';
  const fg = light ? p.ink : p.paper;
  const bg = light ? p.paper : p.ink;
  const all = [...person, ...limbs];
  const line = CONTOUR * p.S;
  // The light comp grades ink by thickness: his contour is thin ink (the edge
  // tone), and a solid ink body gets an EDGE band in it round a p2 core.
  const graded = light && !!p.edge && p.edge !== p.ink;
  const thinInk = graded && p.edge ? p.edge : fg;
  const glow = (loops: readonly Vec2[][]) => {
    if (p.emit) for (const l of loops) if (signedArea(l) > 0) sink.fill(l, p.emit, 'body', 1);
  };
  const fringe = (loops: readonly Vec2[][]) => {
    if (light && p.fringe) fillLoops(ctx, offsetLoops(loops, p.fringe.width), p.fringe.color);
  };
  const silhouette = (tone: string) => {
    fringe(all);
    const cored = graded && tone === p.ink;
    const rim = cored ? thinInk : tone;
    if (p.contour) contour(ctx, person, line, thinInk, bg);
    else fillLoops(ctx, person, rim);
    fillLoops(ctx, limbs, rim, true);
    if (!cored) return;
    const inset = EDGE * p.S;
    if (!p.contour) fillLoops(ctx, offsetLoops(person, -inset), tone);
    fillLoops(ctx, offsetLoops(limbs, -inset), tone, true);
  };
  switch (p.si) {
    case 0: {
      // IF1: ink with a paper rim facing P. In the comp, paper is cream, so
      // the cream fringe's fill (the figure grown by the fringe) is the rim too.
      const cream = light && p.fringe;
      fringe(all);
      if (p.contour) {
        contour(ctx, person, line, fg, bg);
        rimmed(ctx, limbs, p.P, RIM_IF1 * p.S, fg, cream ? null : bg);
      } else rimmed(ctx, all, p.P, RIM_IF1 * p.S, fg, cream ? null : bg);
      break;
    }
    case 1: // IF2: XOR with the split (paintMarksAndFigure); on G2's light split, ink
      if (p.spec.disc === 'ink' && p.disc) xorFill(ctx, all, p.disc, p.paper, p.ink);
      else silhouette(fg);
      break;
    case 2: {
      // IF3: paper, with an ink contour; the speed lines (over) lie on his
      // paper fill, under the contour.
      const grown = offsetLoops(all, line / 2);
      fillLoops(ctx, grown, bg);
      over?.();
      band(ctx, grown, offsetLoops(all, -line / 2), thinInk, p.width, p.height);
      break;
    }
    case 5: {
      // IF6: his paper fill; on it the limbs' recoil trail (impact.md §7.7):
      // 3 accent copies of their contour stepped along −u, each hiding the
      // ones further back; then the fan (over), and his own contour on top.
      // The copies step whole pixels, so one copy drawn on a scratch canvas
      // blits to each without resampling: two fills and three blits instead
      // of six fills, the same pixels.
      const step = RECOIL.step * p.S;
      const tone = light ? p.accent : p.ring;
      const grown = offsetLoops(limbs, line / 2);
      const shrunk = offsetLoops(limbs, -line / 2);
      const body = [...offsetLoops(person, line / 2), ...grown];
      const inner = [...offsetLoops(person, -line / 2), ...shrunk];
      fillLoops(ctx, body, bg);
      const shift = (k: number): Vec2 => [Math.round(-k * step * p.u[0]), Math.round(-k * step * p.u[1])];
      const reach = Math.ceil(RECOIL.copies * step) + 2;
      const box = pixelBox(grown, -reach, -reach, p.width + reach, p.height + reach);
      if (p.scratch && box) {
        const [x0, y0, w, h] = box;
        const s = sprite(p.scratch, w, h);
        const sctx = s.ctx as unknown as PosterTarget; // a 2D context, as the frame's
        fillLoops(sctx, grown, tone, false, -x0, -y0);
        fillLoops(sctx, shrunk, bg, false, -x0, -y0);
        for (let k = RECOIL.copies; k >= 1; k--) {
          const [dx, dy] = shift(k);
          ctx.drawImage(s.canvas as never, 0, 0, w, h, x0 + dx, y0 + dy, w, h);
        }
      } else if (box) {
        for (let k = RECOIL.copies; k >= 1; k--) {
          const [dx, dy] = shift(k);
          fillLoops(ctx, grown, tone, false, dx, dy);
          fillLoops(ctx, shrunk, bg, false, dx, dy);
        }
      }
      over?.();
      // The figure's own contour, the limbs' offsets reused.
      band(ctx, body, inner, thinInk, p.width, p.height);
      if (p.emit) for (const l of all) sink.stroke([...l, l[0]], line, p.emit, 'body', 1);
      break;
    }
    case 6: // IF7: the limbs paper, the person ink with a paper rim facing P
      if (light) silhouette(fg);
      else {
        fillLoops(ctx, limbs, p.paper, true);
        glow(limbs);
        rimmed(ctx, person, p.P, RIM_IF7 * p.S, p.ink, p.paper);
      }
      break;
    default: // IF4 ink; IF5 paper with the glow (ink when light)
      silhouette(fg);
      if (!light) glow(all);
  }
  over?.();
}

// The whole-pixel box round the loops, grown 2 px for the edges' anti-aliasing
// and clamped to [x0, x1] × [y0, y1]: [x, y, width, height], or null if empty.
function pixelBox(loops: readonly Vec2[][], x0: number, y0: number, x1: number, y1: number): [number, number, number, number] | null {
  let a = Infinity;
  let b = Infinity;
  let c = -Infinity;
  let d = -Infinity;
  for (const loop of loops) {
    for (const [x, y] of loop) {
      if (x < a) a = x;
      if (y < b) b = y;
      if (x > c) c = x;
      if (y > d) d = y;
    }
  }
  const left = Math.max(x0, Math.floor(a) - 2);
  const top = Math.max(y0, Math.floor(b) - 2);
  const right = Math.min(x1, Math.ceil(c) + 2);
  const bottom = Math.min(y1, Math.ceil(d) + 2);
  return right > left && bottom > top ? [left, top, right - left, bottom - top] : null;
}

// IF6's scratch canvas, one per maker, grown when a figure needs more room,
// cleared for each use.
const sprites = new WeakMap<MakeScratch, Scratch>();
function sprite(make: MakeScratch, width: number, height: number): Scratch {
  let s = sprites.get(make);
  if (!s || s.canvas.width < width || s.canvas.height < height) {
    s = make(Math.max(width, s?.canvas.width ?? 0), Math.max(height, s?.canvas.height ?? 0));
    sprites.set(make, s);
  }
  s.ctx.setTransform(1, 0, 0, 1, 0, 0);
  s.ctx.globalAlpha = 1;
  s.ctx.globalCompositeOperation = 'source-over';
  s.ctx.clearRect(0, 0, width, height);
  return s;
}

// The mark: ink on light fields, paper on dark ones; IF2's ink split XORs it.
export function paintMarks(ctx: PosterTarget, sink: GlowSink, marks: readonly Vec2[][], p: FigurePaint) {
  if (marks.length === 0) return;
  const light = p.spec.field === 'light';
  if (p.si === 1 && p.spec.disc === 'ink' && p.disc) {
    xorFill(ctx, marks, p.disc, p.paper, p.ink);
    return;
  }
  if (light && p.fringe) fillLoops(ctx, offsetLoops(marks, p.fringe.width), p.fringe.color);
  if (light && p.edge && p.edge !== p.ink) {
    // The light comp: a mark thinner than 0.01 S is thin ink, the edge tone.
    const thin = (m: Vec2[]) => (2 * Math.abs(signedArea(m))) / Math.max(1e-9, perimeter(m)) < THIN * p.S;
    fillLoops(ctx, marks.filter(thin), p.edge, true);
    fillLoops(ctx, marks.filter((m) => !thin(m)), p.ink, true);
  } else fillLoops(ctx, marks, light ? p.ink : p.paper, true);
  if (p.emit && !light) for (const m of marks) sink.fill(m, p.emit, 'body', 1);
}

// ---- Test doubles (the sheet and the tests) ------------------------------------------

// The ink brush size (px at 1080 wide) whose widest point matches the widest of
// `width` (full widths in px on a frame `frameWidth` wide): perfect-freehand's
// width at full pressure is PEAK_WIDTH × size.
export function brushSizeForWidth(width: readonly number[], frameWidth: number): number {
  return (Math.max(1, ...width) / PEAK_WIDTH) * (1080 / frameWidth);
}

// An impact stroke given as widths per point (tests/unit/helpers/impact-drawings.ts),
// as a Crack: the brush sized so its widest point matches, its draw-on end by
// the 0.08 S rule.
export function crackFromStroke(stroke: { id: number; points: readonly Vec2[]; pressure: readonly number[]; width: readonly number[] }, P: Vec2, S: number, frameWidth: number, color: 0 | 1 | 2 = 2): Crack {
  const size = brushSizeForWidth(stroke.width, frameWidth);
  return {
    id: stroke.id,
    points: stroke.points.map((p): Vec2 => [p[0], p[1]]),
    pressure: [...stroke.pressure],
    brush: { ...DEFAULT_BRUSH, size },
    color,
    fromP: drawOnEnd(stroke.points, P, S),
  };
}

// A crouched person whose right fist is on the floor at P, as a frame-sized
// soft mask, and four limbs from his back arcing over him and pinned on P
// (limbs first), as tube silhouettes of radius 0.020·H at the root (decision 8),
// thinning to 40 % at the tip. Sizes are in S; "up" is −u.
export function syntheticCrouch(width: number, height: number, P: Vec2, u: Vec2, S: number): { mask: Mask; limbs: Vec2[][] } {
  const up: Vec2 = [-u[0], -u[1]];
  const side: Vec2 = [u[1], -u[0]];
  const at = (s: number, t: number): Vec2 => [P[0] + S * (s * side[0] + t * up[0]), P[1] + S * (s * side[1] + t * up[1])];
  const capsules: readonly (readonly number[])[] = [
    [0.07, 0.31, 0.075, 0.345, 0.022], // neck
    [0.085, 0.27, 0.165, 0.14, 0.072], // torso
    [0.035, 0.275, -0.01, 0.15, 0.03], // his right arm, to the fist
    [-0.01, 0.15, 0.0, 0.045, 0.026],
    [0.135, 0.27, 0.205, 0.18, 0.028], // his left arm
    [0.205, 0.18, 0.175, 0.095, 0.024],
    [0.165, 0.13, 0.27, 0.19, 0.048], // a knee up
    [0.27, 0.19, 0.255, 0.035, 0.04],
    [0.255, 0.022, 0.315, 0.018, 0.022],
    [0.15, 0.12, 0.115, 0.04, 0.045], // a knee down
    [0.115, 0.035, 0.235, 0.025, 0.032],
  ];
  const ellipses: readonly (readonly number[])[] = [
    [0.07, 0.375, 0.046, 0.056], // head
    [0.0, 0.03, 0.034, 0.03], // fist, its bottom on P
  ];
  const ext = [...capsules.flatMap((c) => [at(c[0], c[1]), at(c[2], c[3])]), ...ellipses.map((e) => at(e[0], e[1]))];
  const pad = 0.09 * S;
  const bx0 = Math.max(0, Math.floor(Math.min(...ext.map((p) => p[0])) - pad));
  const bx1 = Math.min(width, Math.ceil(Math.max(...ext.map((p) => p[0])) + pad));
  const by0 = Math.max(0, Math.floor(Math.min(...ext.map((p) => p[1])) - pad));
  const by1 = Math.min(height, Math.ceil(Math.max(...ext.map((p) => p[1])) + pad));
  const alpha = new Uint8ClampedArray(width * height);
  for (let y = by0; y < by1; y++) {
    for (let x = bx0; x < bx1; x++) {
      const rx = (x + 0.5 - P[0]) / S;
      const ry = (y + 0.5 - P[1]) / S;
      const s = rx * side[0] + ry * side[1];
      const t = rx * up[0] + ry * up[1];
      let d = Infinity;
      for (const [s0, t0, s1, t1, r] of capsules) d = Math.min(d, segmentDistance(s, t, s0, t0, s1, t1) - r);
      for (const [cs, ct, rs, rt] of ellipses) d = Math.min(d, (Math.hypot((s - cs) / rs, (t - ct) / rt) - 1) * Math.min(rs, rt));
      alpha[y * width + x] = Math.round(255 * Math.min(1, Math.max(0, 0.5 - d * S)));
    }
  }
  // The limbs: cubic curves root → over him → P, each a tube outline.
  const R0 = 0.02 * height;
  const curves: readonly (readonly number[])[] = [
    [0.105, 0.29, 0.08, 0.75, -0.28, 0.55],
    [0.135, 0.275, 0.22, 0.8, -0.2, 0.68],
    [0.115, 0.25, 0.34, 0.62, -0.36, 0.3],
    [0.145, 0.235, 0.44, 0.45, -0.14, 0.4],
  ];
  const limbs = curves.map(([rs, rt, as, at1, bs, bt]) => {
    const n = 24;
    const c: Vec2[] = Array.from({ length: n + 1 }, (_, i) => {
      const q = i / n;
      const w = [(1 - q) ** 3, 3 * q * (1 - q) ** 2, 3 * q * q * (1 - q), q ** 3];
      return at(w[0] * rs + w[1] * as + w[2] * bs, w[0] * rt + w[1] * at1 + w[2] * bt);
    });
    const left: Vec2[] = [];
    const right: Vec2[] = [];
    c.forEach((p, i) => {
      const a = c[Math.max(0, i - 1)];
      const b = c[Math.min(n, i + 1)];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const nx = -(b[1] - a[1]) / len;
      const ny = (b[0] - a[0]) / len;
      const r = R0 * (1 - 0.6 * (i / n));
      left.push([p[0] + r * nx, p[1] + r * ny]);
      right.push([p[0] - r * nx, p[1] - r * ny]);
    });
    return oriented([...left, ...right.reverse()]);
  });
  return { mask: { width, height, alpha }, limbs };
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
