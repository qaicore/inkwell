// The limb brush (impact design §2): a held limb's tube (lift/tube.ts) drawn
// as anime cel shading, an outline and flat bands, never a gradient. Every
// band is a closed-form interval of u across each section (bandInterval), so
// it is a strip between two offset curves, and each of the six fills is one
// path with nonzero winding. Strips and discs all wind the same way, so
// where they overlap they add and never cancel.
//   1. line: the silhouette widened by the outline, linePx·S, its width
//      wobbling ±30 % per side on hash(id, side, k mod 3), the boil's cadence,
//      and ×1.35 on the side away from the key light. Its colour follows the
//      plate under it (outlineClasses): the line tone; a p1 rim on dark
//      footage; between the two, the p1 rim with a 1 px line-tone core. A p1
//      stretch is a fill of its own, under the line-tone one.
//   2. shadow: the silhouette.
//   3. body: N·L ≥ τ_base, in the body colour.
//   4. lit: N·L ≥ τ_lit.
//   5. core: N·H ≥ τ_core, broken along the limb (on where noise(t) < 0.55,
//      reseeded on k mod 3), whole while it emerges.
//   6. rim: the edge the back light Lb grazes, up to rimPx wide, in the
//      discharge pale.
// Discs fill the caps, and any fold where the tube turns sharply or bunches
// up on screen. The tones are celTones of p0 (tones.ts). The body and lit
// bands test N·L, not design §2's N·H: the thresholds are limbs3d's, fitted
// with N·L (with N·H, τ_base −0.08 would leave almost no shadow).
//
// Light: the key light from the upper left, L = norm(−0.6, −0.75, 0.3), and
// H = norm(L + V). With `swing` it turns toward P per section, L = norm(mix(L,
// norm(dir to P, z 0.3), w)); keySwing gives w per frame (decision 8: it
// switches to the light from P while the fire burns).
//
// Emergence (EMERGE = { grow 4, pop 2 } drawings, the electric brush's):
//   - ages 0–3 grow the visible length to 0.44, 0.75, 0.94 and 1.0 L; its last
//     10 % rounds off as a head, and its last 30 % is hot: the core across the
//     whole width, the glow ×1.7;
//   - ages 4–5 pop, flash 1 then 0.5: τ_lit falls toward 0.2 and τ_core toward
//     0.6, the core is whole, the glow is ×(1 + flash), and 14 sparks fly, two
//     thirds of them off the tip, farther out and thinner on the second drawing;
//   - after that the limb crackles (decision 8): its glow flickers per drawing
//     (×0.6..1), and on 1 drawing in 4, seeded, it flashes at 0.35 with a few
//     small sparks along it.
// Cord pulses (PulseSpan, from pulse.ts) bulge the radius, widen the core
// around its highlight and double the emission inside them.
//
// The root (decision 8): a glow burst hides where the limb enters him, a
// jagged star in the body, lit and core tones that boils with the outline.
// Design §2's socket ring is root: 'ring'.
//
// Occlusion: chunks (tube.ts) split the tube into front and behind runs at
// the mask's edge. Behind runs draw into ctxBehind (under the person cutout),
// front runs into ctxFront. Glow is emitted only where it can be seen: from
// front sections, and from behind ones off the mask.
//
// WP12 points the 'limb' brush (brushes.ts) at drawLimb: keep its signature.
// Everything is seeded by the stroke id and k, so a drawing re-renders
// identically.
import { decayAlpha } from '../impact/clock.ts';
import type { GlowSink, Palette, PulseSpan, Tube, TubeSection, Vec2, Vec3 } from '../impact/contracts.ts';
import { contrast, roles } from '../impact/palette.ts';
import { bandInterval, chunks as tubeChunks, indexAt, onMask, sectionAt, sectionVectors, type Chunk } from '../lift/tube.ts';
import type { Mask } from '../track/tracking.ts';
import type { LimbSettings } from '../types/effect.ts';
// brushes.ts will import this file once WP12 points 'limb' here: LIMB and
// LIMB_BRUSH are only read inside functions, so the cycle is harmless.
import { LIMB, LIMB_BRUSH } from './brushes.ts';
import { EMERGE } from './electric.ts';
import { hash01, hex, rgb, smoothstep, valueNoise } from './geometry.ts';
import type { BrushTarget, Pixels } from './glow.ts';
import { celTones, type CelTones } from './tones.ts';

const KEY = unit([-0.6, -0.75, 0.3]); // the key light, from the upper left
const BACK = unit([0.55, 0.45, -0.7]); // the back light, for the rim
const SWING_Z = 0.3; // the light from P comes from this far toward the camera
const TAU_RIM = 0.35;
const RIM = { px: 0.0046, fade: 0.25, minR: 1.5 }; // up to px·S wide, full width τ_rim + fade in; none on a section thinner than minR px
const WOBBLE = 0.3; // the outline's width, ±
const SHADOW_LINE = 1.35; // × the outline on the side away from the key light
const CORE_LINE = 1; // px at 1080: the line-tone core of a rim+core outline
const CORE = { on: 0.55, from: 0.08, to: 0.9 }; // where the idle core shows: noise under `on`, between the arc fractions
const HEAD = 0.1; // share of the visible length that rounds off as the head while growing
const HOT = 0.3; // share of the visible length that's hot while growing
const HOT_RAMP = 0.1; // ... reaching full heat over this share
const HEAD_STEPS = 6; // extra sections over the head, so it rounds smoothly
const POP = { flash: [1, 0.5], lit: 0.2, core: 0.6, sparks: 14, atTip: 2 / 3 };
const CRACKLE = { flash: 0.35, share: 0.25, sparks: 4, flicker: 0.4 };
const GLOW = { body: 0.3, core: 0.55, hot: 1.7, burst: 0.8, spark: 0.9, piece: 8 }; // gains, and sections per emitted polyline
const BURST = { spikes: 9, valley: [1.15, 1.3], peak: [1.8, 2.4], lit: 0.84, core: 0.55, glow: 2.2 }; // × (root radius + outline)
const RING_LINE = 1.5; // the socket ring's width, × the outline
const TURN = 0.9; // normals across a section closer than this (n·n) make a sharp turn: a disc fills the fold
const REF_SIZE = 28; // the brush size R0 is given for (design §2: R0 = radius·S·size/28)
const SEED = { line: 7001, core: 9100, flicker: 7, crackle: 23, spark: 101, crackleSpark: 131, burst: 211 };
const CLASS_FREE: Record<OutlineClass, [number, number]> = { line: [95, Infinity], 'rim+core': [55, 105], rim: [-Infinity, 65] }; // G10's Y bands ±5 of hysteresis
const MIN_RUN = 6; // sections: the shortest run of one outline class
const MIN_CONTRAST = 3; // WCAG, the outline against the plate under it
const SWITCH = 0.01; // the cost of changing class, so a tie keeps the class already chosen

// ---- Types ---------------------------------------------------------------------------

// The canvas calls the limb needs beyond the brushes' own.
export interface LimbTarget extends BrushTarget {
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
}

export type OutlineClass = 'line' | 'rim' | 'rim+core';
export type RootLook = 'burst' | 'ring' | 'none';

export interface LimbOptions {
  S: number; // the frame's short side, px: the outline, the rim and the sparks scale with it
  k: number; // the drawing index: seeds the wobble, the core breaks, the burst and the crackle
  palette: Palette;
  color?: string; // the body colour; missing = p0
  settings?: LimbSettings; // brushSettings(effect, 'limb').limb; missing = LIMB
  age?: number; // drawings since the limb's emerge moment, negative before it; missing = out long ago
  flash?: number; // 0..1: replaces the pop's or the crackle's flash (the impact's reaction)
  crackle?: number; // the idle crackle's flash; 0 = steady, no flicker either; missing = 0.35
  pulses?: readonly PulseSpan[];
  swing?: { P: Vec2; w: number } | null; // the key light turned toward P by w, 0..1
  outline?: readonly OutlineClass[] | null; // per section, from outlineClasses; missing = 'line' all along
  chunks?: readonly Chunk[]; // missing = chunks(tube, mask, maskScale)
  mask?: Mask | null; // the person on this frame: flips snap to its edge, and the glow behind him is dropped
  maskScale?: number; // mask px per frame px; missing = 1
  glow?: GlowSink;
  root?: RootLook; // missing = 'burst'
}

type Span = [lo: number, hi: number]; // offsets across the tube, px along its normal

// One drawn section, shaded.
interface Shaded {
  x: number; // the centre on screen
  y: number;
  nx: number; // the unit normal on screen
  ny: number;
  r: number; // the radius, after the head and the pulses
  plus: number; // the outline's width on the + side, px
  minus: number; // ... on the − side
  cls: OutlineClass;
  body: Span | null;
  lit: Span | null;
  core: Span | null;
  rim: Span | null;
  seen: boolean; // its glow can be seen
  gain: number; // its glow gain, before the body or core weight
  fold: boolean; // a disc fills it (a cap, a sharp turn, a bunch)
}

interface Look {
  tones: CelTones;
  light: string; // p1: the rim outline on dark plates
  rim: string; // the back-light rim: the discharge pale
}

// ---- Drawing -------------------------------------------------------------------------

export function drawLimb(ctxBehind: LimbTarget, ctxFront: LimbTarget, tube: Tube, opts: LimbOptions): void {
  const age = opts.age;
  if (age !== undefined && age < 0) return;
  const secs = tube.sections;
  const last = secs.length - 1;
  if (last < 1) return;
  const settings = opts.settings ?? LIMB;
  const look = lookOf(opts.palette, opts.color);
  const growing = age !== undefined && age < EMERGE.grow;
  const pop = age !== undefined && !growing && age < EMERGE.grow + EMERGE.pop ? age - EMERGE.grow : -1; // 0, 1 while popping
  const idle = !growing && pop < 0;
  const grown = growing ? limbGrown(age) : 1;
  const xEnd = growing ? indexAt(tube, grown) : last;
  const sEnd = growing ? grown : 1;
  const k3 = mod(opts.k, 3);
  const crackle = idle ? (opts.crackle ?? CRACKLE.flash) : 0;
  const crackling = crackle > 0 && hash01(tube.id, opts.k, SEED.crackle) < CRACKLE.share;
  const flash = Math.min(1, Math.max(0, opts.flash ?? (pop >= 0 ? POP.flash[pop] : crackling ? crackle : 0)));
  const flicker = crackle > 0 ? 1 - CRACKLE.flicker * hash01(tube.id, opts.k, SEED.flicker) : 1;
  const whole = growing || pop >= 0 || flash >= 0.5; // the core unbroken
  const line = settings.linePx * opts.S;
  const coreLine = CORE_LINE * Math.max(1, opts.S / 1080);
  const tau = { base: settings.bands[0], lit: lerp(settings.bands[1], POP.lit, flash), core: lerp(settings.bands[2], POP.core, flash) };
  const mask = opts.mask ?? null;
  const maskScale = opts.maskScale ?? 1;
  const pulses = opts.pulses ?? [];
  const swing = opts.swing && opts.swing.w > 0 ? opts.swing : null;

  const shade = (x: number, front: boolean): Shaded => {
    const sec = sectionAt(tube, x);
    const s = sec.s;
    let r = sec.r;
    if (growing && grown < 1) {
      const h = (s - (1 - HEAD) * sEnd) / (HEAD * sEnd);
      if (h > 0) r *= Math.sqrt(Math.max(0, 1 - h * h));
    }
    let bulge = 0; // the strongest pulse here, 0..1
    let pulse: PulseSpan | null = null;
    for (const p of pulses) {
      const w = bump(p, s);
      if (w > bulge) [bulge, pulse] = [w, p];
    }
    if (pulse) r *= 1 + (pulse.scale - 1) * bulge;
    const L = lightAt(sec.screen, swing);
    const H = unit([L[0], L[1], L[2] + 1]);
    const [nx, ny] = sec.normal;
    // The core: broken when idle, widened around its highlight in a pulse, the whole width on the hot head.
    const on = whole || (s > CORE.from && s < CORE.to && valueNoise(s * 7 + 3.7 * k3, 3, tube.id + SEED.core) < CORE.on);
    let core = on ? bandInterval(sec, H, tau.core) : null;
    const hot = growing ? smoothstep((1 - HOT) * sEnd, (1 - HOT + HOT_RAMP) * sEnd, s) : 0;
    if (pulse && bulge > 0) {
      const m = core ? (core[0] + core[1]) / 2 : highlight(sec, H);
      core = mixSpan(core ?? [m, m], [Math.max(-1, m - pulse.core), Math.min(1, m + pulse.core)], bulge);
    }
    if (hot > 0) {
      const m = core ? (core[0] + core[1]) / 2 : highlight(sec, H);
      core = mixSpan(core ?? [m, m], [-1, 1], hot);
    }
    // The rim: on the edge facing the back light, where N = ±S and so N·Lb = ±S·Lb.
    const a = nx * BACK[0] + ny * BACK[1];
    const strength = Math.abs(a) - TAU_RIM;
    let rim: Span | null = null;
    if (r >= RIM.minR && strength > 0) {
      const w = Math.min(0.5 * r, RIM.px * opts.S * Math.min(1, strength / RIM.fade));
      rim = a > 0 ? [r - w, r] : [-r, -r + w];
    }
    // The outline: wobbling per side, heavier on the side away from the key light.
    const wob = (side: number) => 1 + WOBBLE * (2 * valueNoise(s * 9, side + 2 * k3, tube.id + SEED.line) - 1);
    const shadowPlus = nx * L[0] + ny * L[1] < 0;
    const cls = opts.outline?.[Math.min(last, Math.max(0, Math.round(x)))] ?? 'line';
    const seen = front || !mask || !onMask(mask, maskScale, sec.screen[0], sec.screen[1]);
    return {
      x: sec.screen[0],
      y: sec.screen[1],
      nx,
      ny,
      r,
      plus: line * wob(0) * (shadowPlus ? SHADOW_LINE : 1),
      minus: line * wob(1) * (shadowPlus ? 1 : SHADOW_LINE),
      cls,
      body: px(bandInterval(sec, L, tau.base), r),
      lit: px(bandInterval(sec, L, tau.lit), r),
      core: px(core, r),
      rim,
      seen,
      gain: flicker * (1 + flash) * (1 + (GLOW.hot - 1) * hot) * (1 + bulge),
      fold: false,
    };
  };

  // The runs, cut to the visible length, each in its layer.
  const behind: Shaded[][] = [];
  const front: Shaded[][] = [];
  const all = opts.chunks ?? tubeChunks(tube, mask, maskScale);
  const head = growing && grown < 1 ? Array.from({ length: HEAD_STEPS }, (_, q) => indexAt(tube, sEnd * (1 - HEAD + (HEAD * (q + 1)) / (HEAD_STEPS + 1)))) : [];
  // The root's layer is its own run's: the first. A behind run that starts
  // one section early, under a front run, can reach back to 0 as well.
  const rootFront: boolean | null = all.length > 0 ? all[0].front : null;
  for (const chunk of all) {
    const from = Math.max(0, chunk.from);
    const to = Math.min(xEnd, chunk.to);
    if (to - from < 1e-6) continue;
    const xs = [from, to];
    for (let i = Math.floor(from) + 1; i < to; i++) xs.push(i);
    for (const h of head) if (h > from && h < to) xs.push(h);
    xs.sort((p, q) => p - q);
    const run = xs.filter((x, i) => i === 0 || x - xs[i - 1] > 1e-4).map((x) => shade(x, chunk.front));
    markFolds(run, from === 0, to >= xEnd - 1e-6);
    (chunk.front ? front : behind).push(run);
  }

  const root = opts.root ?? 'burst';
  const r0 = secs[0].r;
  const rootAt = secs[0].screen;
  for (const [ctx, runs, isFront] of [[ctxBehind, behind, false], [ctxFront, front, true]] as const) {
    const hasRoot = rootFront === isFront;
    if (runs.length === 0 && !hasRoot) continue;
    if (hasRoot && root === 'ring') drawRing(ctx, rootAt, settings.socket * r0, line, look.tones);
    if (runs.some((run) => run.some((sh) => sh.cls !== 'line'))) {
      fillRuns(ctx, runs, look.light, (sh) => (sh.cls === 'line' ? [-sh.r, sh.r] : [-sh.r - sh.minus, sh.r + sh.plus]), (sh) => (sh.cls === 'line' ? 0 : sh.r + Math.max(sh.plus, sh.minus)));
    }
    const lineOut = (sh: Shaded) => (sh.cls === 'line' ? Math.max(sh.plus, sh.minus) : sh.cls === 'rim+core' ? coreLine : 0);
    fillRuns(ctx, runs, look.tones.line, (sh) => (sh.cls === 'line' ? [-sh.r - sh.minus, sh.r + sh.plus] : sh.cls === 'rim+core' ? [-sh.r - coreLine, sh.r + coreLine] : [-sh.r, sh.r]), (sh) => sh.r + lineOut(sh));
    fillRuns(ctx, runs, look.tones.shadow, (sh) => [-sh.r, sh.r], (sh) => sh.r);
    fillRuns(ctx, runs, look.tones.body, (sh) => sh.body);
    fillRuns(ctx, runs, look.tones.lit, (sh) => sh.lit);
    fillRuns(ctx, runs, look.tones.core, (sh) => sh.core);
    fillRuns(ctx, runs, look.rim, (sh) => sh.rim);
    if (hasRoot && root === 'burst') drawBurst(ctx, rootAt, r0 + line, tube.id, k3, look.tones);
  }

  // Sparks: the pop's, off the tip and along the limb; the crackle's, along
  // it. Each goes in the layer of the section it flies from.
  const sparks = pop >= 0 ? popSparks(tube, xEnd, pop, opts.S) : crackling ? crackleSparks(tube, opts.k, xEnd, opts.S) : [];
  const frontAt = (x: number) => all.some((c) => c.front && x >= c.from - 1e-9 && x <= c.to + 1e-9);
  if (sparks.length > 0) {
    for (const [ctx, isFront] of [[ctxBehind, false], [ctxFront, true]] as const) {
      const mine = sparks.filter((sp) => frontAt(sp.at) === isFront);
      for (const [color, pale] of [[look.tones.core, true], [look.tones.lit, false]] as const) {
        const group = mine.filter((sp) => sp.pale === pale);
        if (group.length === 0) continue;
        ctx.fillStyle = color;
        ctx.beginPath();
        for (const sp of group) dart(ctx, sp);
        ctx.fill();
      }
    }
  }

  // Glow, where it can be seen.
  const glow = opts.glow;
  if (!glow) return;
  for (const run of [...behind, ...front]) emitRun(glow, run, look.tones);
  const rootSeen = rootFront === true || (rootFront === false && (!mask || !onMask(mask, maskScale, rootAt[0], rootAt[1])));
  if (root === 'burst' && rootSeen) glow.disc(rootAt, BURST.glow * (r0 + line), look.tones.lit, GLOW.burst * flicker * (1 + flash));
  for (const sp of sparks) {
    const sec = sectionAt(tube, sp.at);
    if (!frontAt(sp.at) && mask && onMask(mask, maskScale, sec.screen[0], sec.screen[1])) continue;
    glow.stroke([sp.tail, sp.tip], 2 * sp.wid, look.tones.core, 'core', GLOW.spark * (1 + flash));
  }
}

// The share of its length a growing limb shows at `age` (0.44, 0.75, 0.94, 1).
export function limbGrown(age: number): number {
  const t = Math.min(1, (Math.max(0, age) + 1) / EMERGE.grow);
  return 1 - (1 - t) ** 2;
}

// The key light's swing toward P on frame j = f − I (design §2, "Lights";
// decision 8), for drawLimb's swing.w: none before the strike and on S0, full
// from S1 (j −7), as grade.ts brings the strike's hue in, held through the
// fire, the aftermath and the hold span, then down with the decay to exactly
// 0 at J_end. A limb drawing takes the value of its first frame. j null (no
// slam) gives 0.
export function keySwing(j: number | null, jEnd: number): number {
  if (j === null || j <= -8 || j >= jEnd) return 0;
  return decayAlpha(j, jEnd);
}

// R0, the root radius before the flare, px: limb.radius·S·(size/28).
export function limbR0(S: number, size: number = LIMB_BRUSH.size, settings: LimbSettings = LIMB): number {
  return settings.radius * S * (size / REF_SIZE);
}

// The limb's tones: celTones of its colour, p1 for the rim outline, and the
// discharge pale for the back-light rim.
const looks = new Map<string, Look>();
function lookOf(palette: Palette, color?: string): Look {
  const key = `${palette.join()}|${color ?? ''}`;
  let look = looks.get(key);
  if (!look) {
    if (looks.size > 64) looks.clear();
    look = { tones: celTones(color ?? palette[0]), light: hex(rgb(palette[1])), rim: roles(palette).discharge.pale };
    looks.set(key, look);
  }
  return look;
}

export function limbTones(palette: Palette, color?: string): CelTones & { light: string; rim: string } {
  const look = lookOf(palette, color);
  return { ...look.tones, light: look.light, rim: look.rim };
}

// ---- Paths ---------------------------------------------------------------------------

// One fill over every run: a strip per run between the span's offsets, plus
// a disc of radius `disc(sh)` on each folded section when `disc` is given.
function fillRuns(ctx: LimbTarget, runs: Shaded[][], color: string, span: (sh: Shaded) => Span | null, disc?: (sh: Shaded) => number) {
  let any = false;
  ctx.beginPath();
  for (const run of runs) {
    if (strip(ctx, run, span)) any = true;
    if (!disc) continue;
    for (const sh of run) {
      if (!sh.fold) continue;
      const R = disc(sh);
      if (R <= 0) continue;
      ctx.moveTo(sh.x + R, sh.y);
      ctx.arc(sh.x, sh.y, R, 0, 2 * Math.PI);
      ctx.closePath();
      any = true;
    }
  }
  if (!any) return;
  ctx.fillStyle = color;
  ctx.fill();
}

// A run's strip: the − edge forward and the + edge back, which winds the same
// way as arc()'s discs. A section without the band collapses to a point at
// the nearest band's centre, so the strip tapers to a point there instead of
// breaking. False when the band is nowhere on the run.
function strip(ctx: LimbTarget, run: Shaded[], span: (sh: Shaded) => Span | null): boolean {
  const n = run.length;
  const spans = run.map(span);
  const prev = new Int32Array(n);
  let p = -1;
  for (let i = 0; i < n; i++) prev[i] = spans[i] ? (p = i) : p;
  let next = -1;
  let found = false;
  const lo = new Float64Array(n);
  const hi = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    const own = spans[i];
    if (own) next = i;
    const j = own ? i : prev[i] < 0 ? next : next < 0 ? prev[i] : i - prev[i] <= next - i ? prev[i] : next;
    if (j < 0) {
      lo[i] = hi[i] = NaN;
      continue;
    }
    found = true;
    const sp = spans[j]!;
    if (own) [lo[i], hi[i]] = sp;
    else lo[i] = hi[i] = (sp[0] + sp[1]) / 2;
  }
  if (!found) return false;
  ctx.moveTo(run[0].x + run[0].nx * lo[0], run[0].y + run[0].ny * lo[0]);
  for (let i = 1; i < n; i++) ctx.lineTo(run[i].x + run[i].nx * lo[i], run[i].y + run[i].ny * lo[i]);
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(run[i].x + run[i].nx * hi[i], run[i].y + run[i].ny * hi[i]);
  ctx.closePath();
  return true;
}

// Which sections get a disc: the caps, sharp turns, and both ends of any
// segment where an edge of the strip (outline included) runs backward
// against the centreline. That is where the strip folds over itself, on the
// inside of a tight bend or where the limb is seen nearly end-on, and the
// fold would leave a hole in a nonzero fill.
function markFolds(run: Shaded[], rootCap: boolean, tipCap: boolean) {
  const n = run.length;
  run[0].fold = rootCap;
  run[n - 1].fold = tipCap;
  for (let i = 0; i < n - 1; i++) {
    const a = run[i];
    const b = run[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    for (const side of [1, -1]) {
      const oa = side * (a.r + (side > 0 ? a.plus : a.minus));
      const ob = side * (b.r + (side > 0 ? b.plus : b.minus));
      const ex = b.x + b.nx * ob - a.x - a.nx * oa;
      const ey = b.y + b.ny * ob - a.y - a.ny * oa;
      if (ex * dx + ey * dy <= 0) a.fold = b.fold = true;
    }
    if (i > 0 && run[i - 1].nx * b.nx + run[i - 1].ny * b.ny < TURN) a.fold = true;
  }
}

function drawRing(ctx: LimbTarget, at: Vec2, R: number, line: number, tones: CelTones) {
  const inner = Math.max(0, R - RING_LINE * line);
  for (const [radius, color] of [[R, tones.line], [inner, tones.shadow]] as const) {
    if (radius <= 0) continue;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(at[0] + radius, at[1]);
    ctx.arc(at[0], at[1], radius, 0, 2 * Math.PI);
    ctx.closePath();
    ctx.fill();
  }
}

// The root's glow burst: three nested jagged stars, seeded by (id, k mod 3).
function drawBurst(ctx: LimbTarget, at: Vec2, R: number, id: number, k3: number, tones: CelTones) {
  const n = BURST.spikes;
  const turn = (hash01(id, k3, SEED.burst) * 2 * Math.PI) / n;
  const star: Vec2[] = [];
  for (let q = 0; q < n; q++) {
    const h = (salt: number) => hash01(id, k3 * 64 + q, SEED.burst + salt);
    const a = turn + ((q + 0.3 * (2 * h(1) - 1)) * 2 * Math.PI) / n;
    const peak = R * lerp(BURST.peak[0], BURST.peak[1], h(2));
    const valley = R * lerp(BURST.valley[0], BURST.valley[1], h(3));
    const b = a + Math.PI / n;
    star.push([Math.cos(a) * peak, Math.sin(a) * peak], [Math.cos(b) * valley, Math.sin(b) * valley]);
  }
  for (const [scale, color] of [[1, tones.body], [BURST.lit, tones.lit], [BURST.core, tones.core]] as const) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(at[0] + star[0][0] * scale, at[1] + star[0][1] * scale);
    for (let i = 1; i < star.length; i++) ctx.lineTo(at[0] + star[i][0] * scale, at[1] + star[i][1] * scale);
    ctx.closePath();
    ctx.fill();
  }
}

// ---- Sparks ---------------------------------------------------------------------------

interface Spark {
  at: number; // the section it flies from, fractional
  tip: Vec2;
  tail: Vec2;
  left: Vec2;
  right: Vec2;
  wid: number; // half its width, px
  pale: boolean; // the core tone, or the lit one
}

// The pop's 14 sparks, the same ones on both drawings: two thirds (9) off the
// tip in a fan, the rest off the sides; farther out and thinner on the second.
function popSparks(tube: Tube, xEnd: number, pop: number, S: number): Spark[] {
  const out: Spark[] = [];
  const unitPx = (S / 1080) * 1.25;
  const tip = sectionAt(tube, xEnd);
  const fromTip = Math.round(POP.sparks * POP.atTip);
  for (let j = 0; j < POP.sparks; j++) {
    const h = (q: number) => hash01(tube.id, j, SEED.spark + q);
    const atTip = j < fromTip;
    const x = atTip ? xEnd : xEnd * (0.3 + 0.6 * h(2));
    const sec = atTip ? tip : sectionAt(tube, x);
    const side = h(3) < 0.5 ? -1 : 1;
    const spread = (2 * h(4) - 1) * 1.6;
    const ahead: Vec2 = [sec.normal[1], -sec.normal[0]];
    const dir: Vec2 = atTip ? rotate(ahead, spread) : [sec.normal[0] * side, sec.normal[1] * side];
    const outPx = (sec.r + (10 + 30 * h(5)) * unitPx) * (pop + 1);
    const thin = pop === 0 ? 1 : 0.6;
    out.push(dartAt(x, sec.screen, dir, outPx, (14 + 22 * h(6)) * thin * unitPx, (2.5 + 2.5 * h(7)) * thin * unitPx, h(8) < 0.5));
  }
  return out;
}

// A crackle's few small sparks off the sides, new on every drawing.
function crackleSparks(tube: Tube, k: number, xEnd: number, S: number): Spark[] {
  const out: Spark[] = [];
  const unitPx = (S / 1080) * 1.25;
  for (let j = 0; j < CRACKLE.sparks; j++) {
    const h = (q: number) => hash01(tube.id, k * 16 + j, SEED.crackleSpark + q);
    const x = xEnd * (0.15 + 0.75 * h(1));
    const sec = sectionAt(tube, x);
    const side = h(2) < 0.5 ? -1 : 1;
    const dir = rotate([sec.normal[0] * side, sec.normal[1] * side], (2 * h(3) - 1) * 0.6);
    out.push(dartAt(x, sec.screen, dir, sec.r + (4 + 10 * h(4)) * unitPx, (8 + 10 * h(5)) * unitPx, (1.5 + 1.5 * h(6)) * unitPx, h(7) < 0.5));
  }
  return out;
}

function dartAt(at: number, from: Vec2, dir: Vec2, outPx: number, len: number, wid: number, pale: boolean): Spark {
  const c: Vec2 = [from[0] + dir[0] * outPx, from[1] + dir[1] * outPx];
  const across: Vec2 = [-dir[1] * wid, dir[0] * wid];
  return {
    at,
    tip: [c[0] + dir[0] * len, c[1] + dir[1] * len],
    tail: [c[0] - dir[0] * len * 0.4, c[1] - dir[1] * len * 0.4],
    left: [c[0] + across[0], c[1] + across[1]],
    right: [c[0] - across[0], c[1] - across[1]],
    wid,
    pale,
  };
}

function dart(ctx: LimbTarget, sp: Spark) {
  ctx.moveTo(sp.tip[0], sp.tip[1]);
  ctx.lineTo(sp.left[0], sp.left[1]);
  ctx.lineTo(sp.tail[0], sp.tail[1]);
  ctx.lineTo(sp.right[0], sp.right[1]);
  ctx.closePath();
}

// ---- Glow ------------------------------------------------------------------------------

// A run's emission, in pieces of GLOW.piece sections over the stretches that
// can be seen: the body along the centreline, the core along its band.
function emitRun(glow: GlowSink, run: Shaded[], tones: CelTones) {
  const pieces = (want: (sh: Shaded) => boolean, emit: (part: Shaded[]) => void) => {
    let part: Shaded[] = [];
    for (const sh of run) {
      if (!want(sh)) {
        if (part.length > 1) emit(part);
        part = [];
        continue;
      }
      part.push(sh);
      if (part.length > GLOW.piece) {
        emit(part);
        part = [sh];
      }
    }
    if (part.length > 1) emit(part);
  };
  const mean = (part: Shaded[], f: (sh: Shaded) => number) => part.reduce((t, sh) => t + f(sh), 0) / part.length;
  pieces(
    (sh) => sh.seen && sh.r > 0,
    (part) => glow.stroke(part.map((sh): Vec2 => [sh.x, sh.y]), 2 * mean(part, (sh) => sh.r), tones.body, 'body', GLOW.body * mean(part, (sh) => sh.gain)),
  );
  pieces(
    (sh) => sh.seen && sh.core !== null && sh.core[1] - sh.core[0] > 0.3,
    (part) => {
      const mid = (sh: Shaded) => (sh.core![0] + sh.core![1]) / 2;
      const points = part.map((sh): Vec2 => [sh.x + sh.nx * mid(sh), sh.y + sh.ny * mid(sh)]);
      glow.stroke(points, mean(part, (sh) => sh.core![1] - sh.core![0]), tones.core, 'core', GLOW.core * mean(part, (sh) => sh.gain));
    },
  );
}

// ---- Outline by contrast (heroclip G10) --------------------------------------------------

// The plate's luma at frame px (Rec. 601, 0..255).
export type PlateLuma = (x: number, y: number) => number;

// A plate image as a PlateLuma, read at the nearest pixel; `scale` is plate
// px per frame px.
export function plateLuma(plate: Pixels, scale = 1): PlateLuma {
  const { data, width, height } = plate;
  return (x, y) => {
    const col = Math.min(width - 1, Math.max(0, Math.floor(x * scale)));
    const row = Math.min(height - 1, Math.max(0, Math.floor(y * scale)));
    const i = (row * width + col) * 4;
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  };
}

// Per section, the plate's median luma in the band just outside its
// silhouette, out to r + 2·linePx, on both sides: 12 samples, at the section
// and halfway to the next.
export function outlineLuma(tube: Tube, plate: PlateLuma, linePx: number): number[] {
  const secs = tube.sections;
  return secs.map((sec, i) => {
    const other = secs[i < secs.length - 1 ? i + 1 : Math.max(0, i - 1)];
    const ys: number[] = [];
    for (const w of [0, 0.5]) {
      const x = sec.screen[0] + (other.screen[0] - sec.screen[0]) * w;
      const y = sec.screen[1] + (other.screen[1] - sec.screen[1]) * w;
      const r = sec.r + (other.r - sec.r) * w;
      for (const d of [r + 0.5 * linePx, r + 1.25 * linePx, r + 2 * linePx]) {
        for (const side of [1, -1]) ys.push(plate(x + sec.normal[0] * d * side, y + sec.normal[1] * d * side));
      }
    }
    ys.sort((a, b) => a - b);
    return (ys[5] + ys[6]) / 2;
  });
}

// The WCAG contrast of an outline class against a plate of luma Y, taken on
// the colour that touches the plate: the line tone for 'line', the p1 rim for
// 'rim' and 'rim+core' (its 1 px line-tone core lies inside the rim, against
// the tube).
export function outlineContrast(cls: OutlineClass, Y: number, palette: Palette, color?: string): number {
  const look = lookOf(palette, color);
  const v = Math.round(Math.min(255, Math.max(0, Y)));
  return contrast(cls === 'line' ? look.tones.line : look.light, hex([v, v, v]));
}

// The outline's class per section (design §2): over Y > 100 the line tone,
// under Y 60 the p1 rim, between them the rim with a line-tone core, chosen
// on each limb drawing's first frame. Each class is free within its Y band
// widened by 5 (the hysteresis: in the overlaps either neighbour is free, and
// a small cost per switch keeps the one already chosen), a section outside
// its class's band costs 1 and more the farther out it is, and a class whose
// contrast against the plate is under 3:1 costs 1000. A dynamic programme
// finds the cheapest labelling whose runs are all at least 6 sections long.
export function outlineClasses(tube: Tube, plate: PlateLuma, opts: { S: number; palette: Palette; color?: string; settings?: LimbSettings }): OutlineClass[] {
  const n = tube.sections.length;
  const linePx = (opts.settings ?? LIMB).linePx * opts.S;
  const Y = outlineLuma(tube, plate, linePx);
  const classes: OutlineClass[] = ['line', 'rim+core', 'rim'];
  const C = classes.length;
  const minRun = Math.min(MIN_RUN, n);
  const dim = new Map<number, boolean>(); // (class, rounded Y) → under 3:1, worked out once
  const tooDim = (c: number, y: number) => {
    const key = c * 256 + Math.round(Math.min(255, Math.max(0, y)));
    let v = dim.get(key);
    if (v === undefined) dim.set(key, (v = outlineContrast(classes[c], y, opts.palette, opts.color) < MIN_CONTRAST));
    return v;
  };
  const local = (i: number, c: number) => {
    const [lo, hi] = CLASS_FREE[classes[c]];
    const out = Math.max(0, lo - Y[i], Y[i] - hi);
    return (out > 0 ? 1 + out / 40 : 0) + (tooDim(c, Y[i]) ? 1000 : 0);
  };
  // State (c, l) per section: class c on a run l + 1 sections long so far,
  // the last l meaning minRun or more.
  const states = C * minRun;
  const cost = new Float64Array(n * states).fill(Infinity);
  const back = new Int32Array(n * states).fill(-1);
  for (let c = 0; c < C; c++) cost[c * minRun] = local(0, c);
  for (let i = 1; i < n; i++) {
    const here = classes.map((_, c) => local(i, c));
    for (let c = 0; c < C; c++) {
      for (let l = 0; l < minRun; l++) {
        const from = (i - 1) * states + c * minRun + l;
        const base = cost[from];
        if (!Number.isFinite(base)) continue;
        const stay = i * states + c * minRun + Math.min(minRun - 1, l + 1);
        if (base + here[c] < cost[stay]) [cost[stay], back[stay]] = [base + here[c], from];
        if (l !== minRun - 1) continue; // a run may only end once it is long enough
        for (let d = 0; d < C; d++) {
          if (d === c) continue;
          const to = i * states + d * minRun;
          const v = base + SWITCH + here[d];
          if (v < cost[to]) [cost[to], back[to]] = [v, from];
        }
      }
    }
  }
  let best = -1;
  for (let c = 0; c < C; c++) {
    const at = (n - 1) * states + c * minRun + minRun - 1;
    if (best < 0 || cost[at] < cost[best]) best = at;
  }
  const out = new Array<OutlineClass>(n);
  for (let i = n - 1, at = best; i >= 0; i--, at = back[at]) out[i] = classes[Math.floor((at - i * states) / minRun)];
  return out;
}

// ---- Pinned stamps (design §4, "Clock") ------------------------------------------------------

export type Matrix = [a: number, b: number, c: number, d: number, e: number, f: number];

// The similarity about P that carries the old root to the new one, as a
// canvas matrix: P stays where it is, so a tip pinned at P stays pinned.
export function pinnedSimilarity(rootOld: Vec2, rootNew: Vec2, P: Vec2): Matrix {
  const ax = rootOld[0] - P[0];
  const ay = rootOld[1] - P[1];
  const bx = rootNew[0] - P[0];
  const by = rootNew[1] - P[1];
  const aa = ax * ax + ay * ay;
  if (aa < 1e-9) return [1, 0, 0, 1, 0, 0];
  const m = (ax * bx + ay * by) / aa; // scale·cos
  const q = (ax * by - ay * bx) / aa; // scale·sin
  return [m, q, -q, m, P[0] - m * P[0] + q * P[1], P[1] - q * P[0] - m * P[1]];
}

export interface StampTarget {
  save(): void;
  restore(): void;
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  drawImage(image: never, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void;
}

// A cached limb layer: its image, and where its top-left sits in frame px.
export interface StampLayer {
  image: unknown;
  width: number;
  height: number;
  x0?: number;
  y0?: number;
}

// Draws a cached limb layer onto ctx through pinnedSimilarity, on top of
// whatever transform ctx already has (the camera's).
export function stampPinned(ctx: StampTarget, layer: StampLayer, rootOld: Vec2, rootNew: Vec2, P: Vec2): void {
  const [a, b, c, d, e, f] = pinnedSimilarity(rootOld, rootNew, P);
  const x0 = layer.x0 ?? 0;
  const y0 = layer.y0 ?? 0;
  ctx.save();
  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(layer.image as never, 0, 0, layer.width, layer.height, x0, y0, layer.width, layer.height);
  ctx.restore();
}

// ---- Small helpers --------------------------------------------------------------------------

// The key light at a section, turned toward P by swing.w.
function lightAt(at: Vec2, swing: { P: Vec2; w: number } | null): Vec3 {
  if (!swing) return KEY;
  const dx = swing.P[0] - at[0];
  const dy = swing.P[1] - at[1];
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return KEY;
  const toP = unit([dx / d, dy / d, SWING_Z]);
  const w = Math.min(1, swing.w);
  const L: Vec3 = [KEY[0] + (toP[0] - KEY[0]) * w, KEY[1] + (toP[1] - KEY[1]) * w, KEY[2] + (toP[2] - KEY[2]) * w];
  return Math.hypot(L[0], L[1], L[2]) < 1e-6 ? [0, 0, 1] : unit(L);
}

// u of the section's brightest visible point under X.
function highlight(sec: TubeSection, X: Vec3): number {
  const { S, Q } = sectionVectors(sec);
  const psi = Math.atan2(S[0] * X[0] + S[1] * X[1] + S[2] * X[2], Q[0] * X[0] + Q[1] * X[1] + Q[2] * X[2]);
  return Math.sin(Math.max(-Math.PI / 2, Math.min(Math.PI / 2, psi)));
}

// A pulse's weight at arc fraction s: a raised cosine over its length.
function bump(p: PulseSpan, s: number): number {
  const x = Math.abs(s - p.s) / (p.len / 2);
  return p.len > 0 && x < 1 ? 0.5 * (1 + Math.cos(Math.PI * x)) : 0;
}

const px = (u: [number, number] | null, r: number): Span | null => (u ? [u[0] * r, u[1] * r] : null);
const mixSpan = (a: [number, number], b: [number, number], w: number): [number, number] => [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
const lerp = (a: number, b: number, w: number) => a + (b - a) * w;
const mod = (k: number, m: number) => ((k % m) + m) % m;
const rotate = ([x, y]: Vec2, a: number): Vec2 => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];

function unit(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
