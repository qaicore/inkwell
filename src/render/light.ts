// The impact's glow (impact design §7, compositing §4): every emitter on a
// drawing lights quarter-resolution buffers, each blurred once with three box
// passes and laid over the finished frame:
//   - N, the near halo, σ 0.019 S: added ('lighter'), the hot edge;
//   - F, the far halo, σ 0.047 S: screened, plus a 0.2 normal-over tint
//     toward the halo's own hue (the reference's −G dip beside a red light);
//   - W, the washes' wide halo, σ 0.10 S: screened.
// A glow made with a ramp (the dark posters' hot ramp, design §5) instead
// keeps one intensity buffer at σ 0.04 S, colours it through the ramp's
// stops and screens it round the shapes, never over them.
//
// Emission. Each call draws its shape twice, once per buffer, in that
// buffer's colour: the near halo takes the light's hue at full saturation,
// turned 20° toward red (blues 10° toward cyan); the far halo turns 35°
// further toward violet (reds, pinks, blues) or red (oranges, yellows), and a
// core's far halo is that mixed 45 % toward white. Weights are per unit of
// coverage: near body 0.63, core 0.59; far body 0.67, core 1.0. Elements
// thinner than 0.015 S emit ×(0.015 S / w)^1.6, up to ×3; a core rides inside
// its element, so it's measured against 0.0045 S, the core of a 0.015 S
// element at the usual 0.30 share. Buffers are 8-bit canvases that hold the
// light at 1/8, so piled-up emitters clip only past 8× full light.
//
// Blur. One readback per buffer per drawing, then three box passes each way
// in floats, over the emitters' box plus the blur's reach only. The three
// passes are done at once, as a triple running sum differenced at four taps
// (boxBlur3): the exact box∘box∘box, at half the cost of three passes. The
// strong/weak gain (1.0 or 0.6 a drawing, plus any flicker) stays out of the
// buffers: it's applied when compositing, so held frames reuse them.
//
// Composite. Screen W, tint, screen F, add N is, per pixel and channel, one
// affine map c → c·M + K. So the glow lands with two quarter-res images drawn
// ×4 over the lit box only, with bilinear smoothing: 'multiply' by M, then
// 'lighter' by K. Unlit pixels get M = 1 and K = 0, which leaves them
// byte-identical.
import type { GlowKind, GlowSink, LayerDraw, Vec2 } from '../impact/contracts.ts';
import { HOT } from '../impact/palette.ts';
import { rng } from '../impact/rng.ts';
import { rgb } from './geometry.ts';
import type { BrushTarget, MakeScratch, Scratch } from './glow.ts';
import { hsvOf, hsvRgb } from './grade.ts';

export const QUARTER = 4; // buffer px per frame px
export const GLOW_SIGMA = { near: 0.019, far: 0.047, wash: 0.1, hot: 0.04 } as const; // × S
export const GLOW_WEIGHT = { near: { body: 0.63, core: 0.59 }, far: { body: 0.67, core: 1.0 } } as const; // per unit of coverage
export const GLOW_TINT = 0.2; // the far halo's normal-over share, × its brightness
export const WASH_WEIGHT = 1.4; // a wash's halo: +180 at its edge over dark ground (compositing §2.8, k25)
export const THIN = 0.015; // × S: thinner elements emit more
export const GLOW_GAIN = { strong: 1, weak: 0.6 } as const; // per drawing (compositing C8)
const CORE_SHARE = 0.3; // a core is measured against THIN × this
const THIN_POWER = 1.6;
const THIN_MAX = 3;
const FAR_CORE_WHITE = 0.45; // a core's far halo, toward white
const ACHROMATIC = 0.08; // HSV saturation below which a light has no hue: it glows its own colour
const HEADROOM = 8; // the buffers hold light at 1/HEADROOM
const AA = 2; // frame px of antialiasing round each shape's box
const STRONG_P = 0.35; // a strike drawing is strong with this chance

type Rgb = [number, number, number]; // 0..1

// ---- Sizes and colours ------------------------------------------------------------------

// Three box passes of radius r give a variance of r(r + 1), so the radius
// that best fits σ (buffer px) is the root of r² + r − σ².
export const boxRadius = (sigma: number): number => Math.max(0, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));

// How much more a thin element emits (compositing §4.2): ×(0.015 S / w)^1.6,
// 1 to 3. A core is measured against the core of a 0.015 S element.
export function thinBoost(width: number, S: number, kind: GlowKind): number {
  if (!(width > 0)) return THIN_MAX;
  const ref = THIN * S * (kind === 'core' ? CORE_SHARE : 1);
  return Math.min(THIN_MAX, Math.max(1, (ref / width) ** THIN_POWER));
}

// HSV hue h turned by up to `by` degrees toward `to`, never past it. Reds
// sit at 360 when they come from above (magenta side) and at 0 from below.
function turnToward(h: number, to: number, by: number): number {
  const d = to - h;
  return Math.abs(d) <= by ? to : h + Math.sign(d) * by;
}

// The near halo's hue (compositing §4.4): reds, pinks and violets 20° toward
// red, oranges and yellows 20° toward red, blues 10° toward cyan, greens 10°
// toward cyan.
function nearHue(h: number): number {
  if (h >= 270) return turnToward(h, 360, 20);
  if (h < 90) return turnToward(h, 0, 20);
  return turnToward(h, 180, 10);
}

// The far halo's hue, from the near one: 35° toward violet from the reds and
// pinks (270–360), 25° from the blues (180–270, the measured 15–35°), 35°
// toward red from the oranges and yellows, toward cyan from the greens.
function farHue(h: number): number {
  if (h >= 270) return turnToward(h, 270, 35);
  if (h >= 180) return turnToward(h, 270, 25);
  if (h < 90) return turnToward(h, 0, 35);
  return turnToward(h, 180, 35);
}

export interface HaloColors {
  near: Rgb;
  far: Rgb;
  farCore: Rgb;
}

const haloCache = new Map<string, HaloColors>();

// The three halo colours a light of this colour gives (compositing §4.4). A
// light with no hue of its own (a white-hot core, a grey) glows with `main`'s
// halos: a p1 core inside a p0 body lights c_N and c_FC of p0, as measured.
// With no main, or a main with no hue either, it glows its own colour at full
// brightness.
export function haloColors(color: string, main?: string): HaloColors {
  const key = main ? `${color}|${main}` : color;
  const hit = haloCache.get(key);
  if (hit) return hit;
  const { h, s, v } = hsvOf(color);
  let colors: HaloColors;
  if ((s < ACHROMATIC || v <= 0) && main && main !== color && hsvOf(main).s >= ACHROMATIC) {
    colors = haloColors(main);
  } else if (s < ACHROMATIC || v <= 0) {
    const c = rgb(color).map((x) => (v > 0 ? x / 255 / v : 0)) as Rgb;
    colors = { near: c, far: c, farCore: c };
  } else {
    const nh = nearHue(h);
    const far = hsvRgb(farHue(nh), Math.min(1, Math.max(0.55, s)), 1);
    colors = { near: hsvRgb(nh % 360, 1, 1), far, farCore: far.map((c) => c + (1 - c) * FAR_CORE_WHITE) as Rgb };
  }
  if (haloCache.size > 256) haloCache.clear();
  haloCache.set(key, colors);
  return colors;
}

// The strong/weak gain of n drawings in a row (compositing C8): strong (1.0)
// with p 0.35, never two strong in a row, and at least one strong in any
// three. Seeded by (seed, 'glow', i), so drawing i always gets the same gain.
export function glowGains(seed: number, n: number): number[] {
  const strong: boolean[] = [];
  for (let i = 0; i < n; i++) {
    if (i >= 1 && strong[i - 1]) strong.push(false);
    else if (i >= 2 && !strong[i - 1] && !strong[i - 2]) strong.push(true);
    else strong.push(rng(seed, 'glow', i)() < STRONG_P);
  }
  return strong.map((s) => (s ? GLOW_GAIN.strong : GLOW_GAIN.weak));
}

// ---- Buffers ----------------------------------------------------------------------------

// The canvas calls the emitters need, past what BrushTarget has; the browser's
// canvas and @napi-rs/canvas both have them.
interface EmitTarget extends BrushTarget {
  strokeStyle: unknown;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  lineTo(x: number, y: number): void;
  stroke(): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  createImageData(width: number, height: number): ImageData;
}

// A box in buffer px: [x0, x1) × [y0, y1).
interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

type Kind = 'near' | 'far' | 'wash' | 'hot';

// One emission buffer and, after the blur, its light.
interface Buffer {
  kind: Kind;
  channels: 1 | 3;
  radius: number; // per box pass, buffer px
  canvas: Scratch | null; // made on first use
  lit: { x0: number; y0: number; x1: number; y1: number } | null; // what's been drawn, frame px
  box: Box | null; // after the blur: where the light is
  light: Float32Array; // after the blur: box-sized, `channels` floats a pixel, 1 = full
  inside: Float32Array | null; // the hot buffer only: the shapes themselves, unblurred
}

export interface GlowOptions {
  main?: string; // the drawing's main colour (p0): what lights with no hue of their own glow with
  ramp?: readonly string[]; // colour everything through these stops, light to dark (the dark posters: HOT)
}

export interface Glow extends GlowSink {
  readonly width: number; // frame px
  readonly height: number;
  readonly S: number; // the frame's short side
  readonly empty: boolean; // nothing emitted since the last clear
  clear(): void; // a new drawing: forgets everything emitted
  blur(): void; // blurs what was emitted; composite calls it if it hasn't run
  composite(ctx: BrushTarget, gain?: number): void; // lays the glow over ctx (frame px)
}

// A glow as the composite sees it: an id and a version that bumps on every
// emission and clear, so the composite knows when its images are stale.
type Internal = Glow & { readonly id: number; readonly version: number; readonly buffers: Buffer[]; readonly ramp: Ramp | null };
const outputs = new WeakMap<Glow, Output>();

// The ramp stops' positions, light to dark (impact.md: t 1, 0.5, 0.25, 0.12,
// 0.06, then nothing), for a ramp of HOT's length.
const RAMP_AT = [1, 0.5, 0.25, 0.12, 0.06];

let nextId = 1;

// A glow for one frame size. Emit with the GlowSink calls, in frame px.
export function createGlow(make: MakeScratch, width: number, height: number, opts: GlowOptions = {}): Glow {
  const S = Math.min(width, height);
  const qw = Math.ceil(width / QUARTER);
  const qh = Math.ceil(height / QUARTER);
  const radius = (sigma: number) => boxRadius((sigma * S) / QUARTER);
  const buffer = (kind: Kind, channels: 1 | 3, sigma: number): Buffer => ({ kind, channels, radius: radius(sigma), canvas: null, lit: null, box: null, light: new Float32Array(0), inside: null });
  const ramp = opts.ramp ? rampOf(opts.ramp) : null;
  const near = buffer('near', 3, GLOW_SIGMA.near);
  const far = buffer('far', 3, GLOW_SIGMA.far);
  const wash = buffer('wash', 3, GLOW_SIGMA.wash);
  const hot = buffer('hot', 1, GLOW_SIGMA.hot);
  const buffers = ramp ? [hot] : [near, far, wash];
  let blurred = true;
  let version = 0;
  const out: Output = { make, M: null, K: null, key: '', box: null, combined: null };

  const target = (b: Buffer): EmitTarget => {
    if (!b.canvas) {
      b.canvas = make(qw, qh);
      resetBuffer(b);
    }
    const ctx = b.canvas.ctx as EmitTarget;
    ctx.setTransform(1 / QUARTER, 0, 0, 1 / QUARTER, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 1;
    return ctx;
  };
  const touch = (b: Buffer, x0: number, y0: number, x1: number, y1: number) => {
    const l = b.lit;
    b.lit = l ? { x0: Math.min(l.x0, x0), y0: Math.min(l.y0, y0), x1: Math.max(l.x1, x1), y1: Math.max(l.y1, y1) } : { x0, y0, x1, y1 };
    blurred = false;
    version++;
  };
  // A path on every buffer it lights, each in its own colour.
  const emit = (targets: [Buffer, Rgb][], path: (ctx: EmitTarget) => void, paint: 'fill' | 'stroke', lineWidth: number, box: [number, number, number, number]) => {
    for (const [b, color] of targets) {
      if (!(Math.max(color[0], color[1], color[2]) > 0)) continue;
      const ctx = target(b);
      const style = styleOf(b, color);
      ctx.beginPath();
      path(ctx);
      if (paint === 'stroke') {
        ctx.strokeStyle = style;
        ctx.lineWidth = lineWidth;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();
      } else {
        ctx.fillStyle = style;
        ctx.fill();
      }
      touch(b, box[0] - AA, box[1] - AA, box[2] + AA, box[3] + AA);
    }
  };
  // The near and far colours of one light, weighted.
  const lights = (color: string, kind: GlowKind, k: number): [Buffer, Rgb][] => {
    if (ramp) return [[hot, [k, k, k]]];
    const c = haloColors(color, opts.main);
    return [
      [near, scale(c.near, GLOW_WEIGHT.near[kind] * k)],
      [far, scale(kind === 'core' ? c.farCore : c.far, GLOW_WEIGHT.far[kind] * k)],
    ];
  };

  const glow: Internal = {
    width,
    height,
    S,
    id: nextId++,
    get version() {
      return version;
    },
    buffers,
    ramp,
    get empty() {
      return buffers.every((b) => !b.lit);
    },
    stroke(points: Vec2[], lineWidth: number, color: string, kind: GlowKind, gain: number) {
      if (points.length === 0 || !(lineWidth > 0) || !(gain > 0)) return;
      const k = gain * thinBoost(lineWidth, S, kind);
      const box = extent(points, lineWidth / 2);
      if (points.length === 1) {
        const [x, y] = points[0];
        emit(lights(color, kind, k), (ctx) => ctx.arc(x, y, lineWidth / 2, 0, 2 * Math.PI), 'fill', 0, box);
        return;
      }
      emit(lights(color, kind, k), (ctx) => polyline(ctx, points), 'stroke', lineWidth, box);
    },
    fill(outline: Vec2[], color: string, kind: GlowKind, gain: number) {
      if (outline.length < 3 || !(gain > 0)) return;
      const k = gain * thinBoost(meanWidth(outline), S, kind);
      emit(lights(color, kind, k), (ctx) => polygon(ctx, outline), 'fill', 0, extent(outline, 0));
    },
    disc(c: Vec2, r: number, color: string, gain: number) {
      if (!(r > 0) || !(gain > 0)) return;
      const k = gain * thinBoost(2 * r, S, 'core');
      emit(lights(color, 'core', k), (ctx) => ctx.arc(c[0], c[1], r, 0, 2 * Math.PI), 'fill', 0, [c[0] - r, c[1] - r, c[0] + r, c[1] + r]);
    },
    wash(outline: Vec2[], color: string, gain: number) {
      if (outline.length < 3 || !(gain > 0)) return;
      const targets: [Buffer, Rgb][] = ramp ? [[hot, [gain, gain, gain]]] : [[wash, scale(haloColors(color, opts.main).far, WASH_WEIGHT * gain)]];
      emit(targets, (ctx) => polygon(ctx, outline), 'fill', 0, extent(outline, 0));
    },
    clear() {
      for (const b of buffers) {
        if (b.lit && b.canvas) resetBuffer(b);
        b.lit = null;
        b.box = null;
      }
      blurred = true;
      version++;
    },
    blur() {
      if (blurred) return;
      for (const b of buffers) blurBuffer(b, qw, qh);
      blurred = true;
    },
    composite(ctx: BrushTarget, gain = 1) {
      compositeGlows(ctx, [[glow, gain]]);
    },
  };
  outputs.set(glow, out);
  return glow;
}

// The glow slot's layer (design §7, slot 12): these glows over the frame,
// each at its gain. It blends with the frame, so it's never cached.
export function glowLayer(entries: readonly (readonly [Glow, number])[]): LayerDraw {
  return { key: null, draw: (ctx) => compositeGlows(ctx, entries) };
}

// ---- Blur -------------------------------------------------------------------------------

function resetBuffer(b: Buffer) {
  const ctx = b.canvas!.ctx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, b.canvas!.canvas.width, b.canvas!.canvas.height);
}

// Reads back what was drawn, over the lit box plus the blur's reach, and blurs it.
function blurBuffer(b: Buffer, qw: number, qh: number) {
  if (!b.lit || !b.canvas) {
    b.box = null;
    return;
  }
  const reach = 3 * b.radius + 1;
  const ly0 = Math.max(0, Math.floor(b.lit.y0 / QUARTER));
  const ly1 = Math.min(qh, Math.ceil(b.lit.y1 / QUARTER));
  const box: Box = {
    x0: Math.max(0, Math.floor(b.lit.x0 / QUARTER) - reach),
    y0: Math.max(0, ly0 - reach),
    x1: Math.min(qw, Math.ceil(b.lit.x1 / QUARTER) + reach),
    y1: Math.min(qh, ly1 + reach),
  };
  if (box.x1 <= box.x0 || box.y1 <= box.y0) {
    b.box = null;
    return;
  }
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  const c = b.channels;
  const px = b.canvas.ctx.getImageData(box.x0, box.y0, w, h).data;
  const n = w * h * c;
  if (b.light.length < n) b.light = new Float32Array(n);
  const light = b.light;
  const unit = HEADROOM / 255;
  if (c === 3) {
    for (let i = 0, j = 0; j < n; i += 4, j += 3) {
      light[j] = px[i] * unit;
      light[j + 1] = px[i + 1] * unit;
      light[j + 2] = px[i + 2] * unit;
    }
  } else {
    // The hot buffer: light in red, the shapes' own coverage in green.
    if (!b.inside || b.inside.length < n) b.inside = new Float32Array(n);
    const inside = b.inside;
    for (let i = 0, j = 0; j < n; i += 4, j++) {
      light[j] = px[i] * unit;
      inside[j] = px[i + 1] / 255;
    }
  }
  // Rows above and below the emitters are dark until the column passes reach them.
  boxBlur3(light, w, h, c, b.radius, Math.max(0, ly0 - box.y0), Math.min(h, ly1 - box.y0));
  b.box = box;
}

let triple = new Float64Array(0);
let ring = new Float64Array(0);
let sums = new Float64Array(0);

// Three box passes of radius r each way, in place, zero outside the buffer.
// It's the exact box∘box∘box convolution, done in one sweep a row: the triple
// running sum T of the row (zero before it and past its end), differenced at
// four taps n = 2r + 1 apart,
//   out(x) = (T(x + 3r) − 3·T(x + 3r − n) + 3·T(x + 3r − 2n) − T(x + 3r − 3n)) / n³,
// then the same down every column at once. So light a pass carries past the
// buffer's edge comes back on the next one, and the frame's edge doesn't dim
// a glow next to it. T is kept in doubles: its cubic growth would cancel
// badly in floats. `c` floats a pixel, interleaved (1 or 3). Rows outside
// [rows0, rows1) must be zero: the row sweep skips them.
export function boxBlur3(buf: Float32Array, w: number, h: number, c: number, r: number, rows0 = 0, rows1 = h) {
  if (r <= 0 || w <= 0 || h <= 0) return;
  if (c !== 1 && c !== 3) throw new Error(`boxBlur3 takes 1 or 3 channels (got ${c})`);
  (c === 3 ? sweepRows3 : sweepRows1)(buf, w, r, Math.max(0, rows0), Math.min(h, rows1));
  sweepColumns(buf, w * c, h, r);
}

function tripleFor(n: number): Float64Array {
  if (triple.length < n) triple = new Float64Array(n);
  return triple;
}

// One sweep of rows y0..y1 − 1 of a w-wide RGB buffer, in place.
function sweepRows3(buf: Float32Array, w: number, r: number, y0: number, y1: number) {
  const n = 2 * r + 1;
  const inv = 1 / (n * n * n);
  const len = w + 3 * r; // T(0) .. T(w − 1 + 3r): the last output's leading tap
  const T = tripleFor(3 * len);
  const lag = 3 * n;
  const lead = 9 * r;
  const head = Math.min(3 * w, Math.max(0, 3 * lag - lead)); // outputs whose last tap falls before T(0)
  for (let y = y0; y < y1; y++) {
    const row = 3 * w * y;
    // The running sums, once, twice and three times over, per channel.
    let p0 = 0;
    let q0 = 0;
    let t0 = 0;
    let p1 = 0;
    let q1 = 0;
    let t1 = 0;
    let p2 = 0;
    let q2 = 0;
    let t2 = 0;
    let i = 0;
    for (let k = row, end = row + 3 * w; k < end; k += 3, i += 3) {
      p0 += buf[k];
      q0 += p0;
      t0 += q0;
      T[i] = t0;
      p1 += buf[k + 1];
      q1 += p1;
      t1 += q1;
      T[i + 1] = t1;
      p2 += buf[k + 2];
      q2 += p2;
      t2 += q2;
      T[i + 2] = t2;
    }
    for (const end = 3 * len; i < end; i += 3) {
      q0 += p0;
      t0 += q0;
      T[i] = t0;
      q1 += p1;
      t1 += q1;
      T[i + 1] = t1;
      q2 += p2;
      t2 += q2;
      T[i + 2] = t2;
    }
    let o = 0;
    for (; o < head; o++) {
      const m = o + lead;
      let v = T[m];
      if (m >= lag) v -= 3 * T[m - lag];
      if (m >= 2 * lag) v += 3 * T[m - 2 * lag];
      buf[row + o] = v * inv;
    }
    for (const end = 3 * w; o < end; o++) {
      const m = o + lead;
      buf[row + o] = (T[m] - 3 * (T[m - lag] - T[m - 2 * lag]) - T[m - 3 * lag]) * inv;
    }
  }
}

// The same for one channel.
function sweepRows1(buf: Float32Array, w: number, r: number, y0: number, y1: number) {
  const n = 2 * r + 1;
  const inv = 1 / (n * n * n);
  const len = w + 3 * r;
  const T = tripleFor(len);
  const lead = 3 * r;
  const head = Math.min(w, Math.max(0, 3 * n - lead));
  for (let y = y0; y < y1; y++) {
    const row = w * y;
    let p = 0;
    let q = 0;
    let t = 0;
    let i = 0;
    for (; i < w; i++) {
      p += buf[row + i];
      q += p;
      t += q;
      T[i] = t;
    }
    for (; i < len; i++) {
      q += p;
      t += q;
      T[i] = t;
    }
    let o = 0;
    for (; o < head; o++) {
      const m = o + lead;
      let v = T[m];
      if (m >= n) v -= 3 * T[m - n];
      if (m >= 2 * n) v += 3 * T[m - 2 * n];
      buf[row + o] = v * inv;
    }
    for (; o < w; o++) {
      const m = o + lead;
      buf[row + o] = (T[m] - 3 * (T[m - n] - T[m - 2 * n]) - T[m - 3 * n]) * inv;
    }
  }
}

// The same sweep down all `stride` float columns of an h-row buffer at once,
// a row at a time: the running sums are kept per column and the last 3n + 1
// rows of T in a ring. Output row m − 3r is written once input row m is
// read, so it's in place.
function sweepColumns(buf: Float32Array, stride: number, h: number, r: number) {
  const n = 2 * r + 1;
  const inv = 1 / (n * n * n);
  const L = 3 * n + 1;
  if (ring.length < L * stride) ring = new Float64Array(L * stride);
  if (sums.length < 3 * stride) sums = new Float64Array(3 * stride);
  const R = ring;
  const S = sums; // p, q and t of column k at 3k, 3k + 1, 3k + 2
  S.fill(0, 0, 3 * stride);
  const lead = 3 * r;
  for (let m = 0, end = h + lead; m < end; m++) {
    const slot = (m % L) * stride;
    if (m < h) {
      for (let k = 0, s = 0, src = m * stride; k < stride; k++, s += 3) {
        const p = S[s] + buf[src + k];
        const q = S[s + 1] + p;
        const t = S[s + 2] + q;
        S[s] = p;
        S[s + 1] = q;
        S[s + 2] = t;
        R[slot + k] = t;
      }
    } else {
      for (let k = 0, s = 0; k < stride; k++, s += 3) {
        const q = S[s + 1] + S[s];
        const t = S[s + 2] + q;
        S[s + 1] = q;
        S[s + 2] = t;
        R[slot + k] = t;
      }
    }
    const o = m - lead;
    if (o < 0) continue;
    const dst = o * stride;
    const s1 = ((m - n + L) % L) * stride;
    const s2 = ((m - 2 * n + 2 * L) % L) * stride;
    const s3 = ((m - 3 * n + 3 * L) % L) * stride;
    if (m >= 3 * n) {
      for (let k = 0; k < stride; k++) buf[dst + k] = (R[slot + k] - 3 * (R[s1 + k] - R[s2 + k]) - R[s3 + k]) * inv;
    } else {
      // Taps before the first row read T = 0.
      const a = m >= n ? 3 : 0;
      const b = m >= 2 * n ? 3 : 0;
      for (let k = 0; k < stride; k++) buf[dst + k] = (R[slot + k] - a * R[s1 + k] + b * R[s2 + k]) * inv;
    }
  }
}

// ---- Composite --------------------------------------------------------------------------

// Where a glow's composite goes: the M and K images, and what they were last
// built from, so a held frame redraws without rebuilding.
interface Output {
  make: MakeScratch;
  M: Scratch | null;
  K: Scratch | null;
  key: string;
  box: Box | null; // what M and K hold now; outside it they're M = 1, K = 0
  combined: { size: number; N: Float32Array; F: Float32Array; W: Float32Array; T: Float32Array; E: Float32Array } | null;
}

// Lays several glows over ctx in one pass, each at its own gain (strong or
// weak, times any flicker). They must share a frame size; the first one's
// images carry the composite. ctx draws in frame px.
export function compositeGlows(ctx: BrushTarget, entries: readonly (readonly [Glow, number])[]) {
  const live = entries.filter(([g, gain]) => gain > 0 && !g.empty) as unknown as [Internal, number][];
  if (live.length === 0) return;
  const first = live[0][0];
  for (const [g] of live) {
    if (g.width !== first.width || g.height !== first.height) throw new Error(`compositeGlows needs one frame size (got ${first.width}×${first.height} and ${g.width}×${g.height})`);
    g.blur();
  }
  const out = outputs.get(first)!;
  let box: Box | null = null;
  for (const [g] of live) for (const b of g.buffers) if (b.box) box = box ? union(box, b.box) : { ...b.box };
  if (!box) return;
  const qw = Math.ceil(first.width / QUARTER);
  const qh = Math.ceil(first.height / QUARTER);
  // One pixel round the light, so the ×4 upscale reads M = 1, K = 0 at its edge.
  box = { x0: Math.max(0, box.x0 - 1), y0: Math.max(0, box.y0 - 1), x1: Math.min(qw, box.x1 + 1), y1: Math.min(qh, box.y1 + 1) };
  const key = live.map(([g, gain]) => `${g.id}.${g.version}@${gain}`).join('|');
  if (out.key !== key) {
    buildImages(out, live, box, qw, qh);
    out.key = key;
  }
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  const t = ctx as BrushTarget & { imageSmoothingQuality?: string };
  const op = t.globalCompositeOperation;
  const alpha = t.globalAlpha;
  const smooth = t.imageSmoothingEnabled;
  const quality = t.imageSmoothingQuality;
  t.globalAlpha = 1;
  t.imageSmoothingEnabled = true;
  // Bilinear: the light is smooth, and 'high' costs three times as much (the preview sets it).
  if (quality !== undefined) t.imageSmoothingQuality = 'low';
  t.globalCompositeOperation = 'multiply';
  t.drawImage(out.M!.canvas as never, box.x0, box.y0, w, h, box.x0 * QUARTER, box.y0 * QUARTER, w * QUARTER, h * QUARTER);
  t.globalCompositeOperation = 'lighter';
  t.drawImage(out.K!.canvas as never, box.x0, box.y0, w, h, box.x0 * QUARTER, box.y0 * QUARTER, w * QUARTER, h * QUARTER);
  t.globalCompositeOperation = op;
  t.globalAlpha = alpha;
  t.imageSmoothingEnabled = smooth;
  if (quality !== undefined) t.imageSmoothingQuality = quality;
}

// Sums the glows' light over the box at their gains, then writes M and K.
function buildImages(out: Output, live: [Internal, number][], box: Box, qw: number, qh: number) {
  if (!out.M || !out.K) {
    out.M = out.make(qw, qh);
    out.K = out.make(qw, qh);
    for (const [s, color] of [[out.M, '#ffffff'], [out.K, '#000000']] as const) {
      s.ctx.setTransform(1, 0, 0, 1, 0, 0);
      s.ctx.globalCompositeOperation = 'source-over';
      s.ctx.globalAlpha = 1;
      s.ctx.fillStyle = color;
      s.ctx.fillRect(0, 0, s.canvas.width, s.canvas.height);
    }
  }
  // Whatever the last composite left outside this box goes back to M = 1, K = 0.
  if (out.box) {
    const o = out.box;
    out.M.ctx.fillStyle = '#ffffff';
    out.M.ctx.fillRect(o.x0, o.y0, o.x1 - o.x0, o.y1 - o.y0);
    out.K.ctx.fillStyle = '#000000';
    out.K.ctx.fillRect(o.x0, o.y0, o.x1 - o.x0, o.y1 - o.y0);
  }
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  const size = w * h;
  if (!out.combined || out.combined.size < size) {
    out.combined = { size, N: new Float32Array(size * 3), F: new Float32Array(size * 3), W: new Float32Array(size * 3), T: new Float32Array(size), E: new Float32Array(size) };
  }
  const { N, F, W, T, E } = out.combined;
  let ramp: Ramp | null = null;
  let washes = false;
  for (const [g] of live) {
    if (g.ramp) ramp = g.ramp;
    for (const b of g.buffers) if (b.kind === 'wash' && b.box) washes = true;
  }
  N.fill(0, 0, size * 3);
  F.fill(0, 0, size * 3);
  if (washes) W.fill(0, 0, size * 3);
  if (ramp) {
    T.fill(0, 0, size);
    E.fill(0, 0, size);
  }
  for (const [g, gain] of live) {
    for (const b of g.buffers) {
      if (!b.box) continue;
      if (b.kind === 'hot') {
        addInto(T, box, b.light, b.box, 1, gain);
        addInto(E, box, b.inside!, b.box, 1, 1);
      } else addInto(b.kind === 'near' ? N : b.kind === 'far' ? F : W, box, b.light, b.box, 3, gain);
    }
  }
  const M = (out.M.ctx as EmitTarget).createImageData(w, h);
  const K = (out.K.ctx as EmitTarget).createImageData(w, h);
  // The stores round and clamp to 0..255 by themselves (Uint8ClampedArray).
  if (washes || ramp) mapAll(M.data, K.data, N, F, W, T, E, size, washes, ramp);
  else mapPlain(M.data, K.data, N, F, size);
  out.M.ctx.putImageData(M, box.x0, box.y0);
  out.K.ctx.putImageData(K, box.x0, box.y0);
  out.box = box;
}

// M and K with no wash and no ramp, the usual case: tint, screen F, add N.
//   M = (1 − 0.2·a)(1 − F),  K = 0.2·F(1 − F) + F + N,  a = max(F).
function mapPlain(m: Uint8ClampedArray, k: Uint8ClampedArray, N: Float32Array, F: Float32Array, size: number) {
  for (let p = 0, i = 0, o = 0; p < size; p++, i += 3, o += 4) {
    let fr = F[i];
    let fg = F[i + 1];
    let fb = F[i + 2];
    if (fr > 1) fr = 1;
    if (fg > 1) fg = 1;
    if (fb > 1) fb = 1;
    const a = fr > fg ? (fr > fb ? fr : fb) : fg > fb ? fg : fb;
    const t = 255 - 255 * GLOW_TINT * a;
    m[o] = t * (1 - fr);
    m[o + 1] = t * (1 - fg);
    m[o + 2] = t * (1 - fb);
    m[o + 3] = 255;
    k[o] = 255 * (fr + GLOW_TINT * fr * (1 - fr) + N[i]);
    k[o + 1] = 255 * (fg + GLOW_TINT * fg * (1 - fg) + N[i + 1]);
    k[o + 2] = 255 * (fb + GLOW_TINT * fb * (1 - fb) + N[i + 2]);
    k[o + 3] = 255;
  }
}

// M and K with everything: screen W and the hot ramp, tint, screen F, add N.
function mapAll(m: Uint8ClampedArray, k: Uint8ClampedArray, N: Float32Array, F: Float32Array, W: Float32Array, T: Float32Array, E: Float32Array, size: number, washes: boolean, ramp: Ramp | null) {
  const hot: Rgb = [0, 0, 0];
  for (let p = 0; p < size; p++) {
    const i = p * 3;
    const fr = Math.min(1, F[i]);
    const fg = Math.min(1, F[i + 1]);
    const fb = Math.min(1, F[i + 2]);
    const tint = 1 - GLOW_TINT * Math.max(fr, fg, fb);
    if (ramp && T[p] > 0) ramp.at(T[p], 1 - Math.min(1, E[p]), hot);
    else hot[0] = hot[1] = hot[2] = 0;
    const o = p * 4;
    for (let ch = 0; ch < 3; ch++) {
      const f = ch === 0 ? fr : ch === 1 ? fg : fb;
      const m1 = (washes ? 1 - Math.min(1, W[i + ch]) : 1) * (1 - hot[ch]);
      const m2 = m1 * tint;
      const k2 = (1 - m1) * tint + GLOW_TINT * f;
      m[o + ch] = 255 * m2 * (1 - f);
      k[o + ch] = 255 * (k2 * (1 - f) + f + N[i + ch]);
    }
    m[o + 3] = 255;
    k[o + 3] = 255;
  }
}

// dst (over `into`) += gain × src (over `from`), where they overlap.
function addInto(dst: Float32Array, into: Box, src: Float32Array, from: Box, c: number, gain: number) {
  const x0 = Math.max(into.x0, from.x0);
  const x1 = Math.min(into.x1, from.x1);
  const y0 = Math.max(into.y0, from.y0);
  const y1 = Math.min(into.y1, from.y1);
  if (x1 <= x0 || y1 <= y0) return;
  const dw = into.x1 - into.x0;
  const sw = from.x1 - from.x0;
  const run = (x1 - x0) * c;
  for (let y = y0; y < y1; y++) {
    const d = ((y - into.y0) * dw + (x0 - into.x0)) * c;
    const s = ((y - from.y0) * sw + (x0 - from.x0)) * c;
    for (let x = 0; x < run; x++) dst[d + x] += gain * src[s + x];
  }
}

// ---- The hot ramp -----------------------------------------------------------------------

interface Ramp {
  // The ramp's colour for blurred intensity t, kept off the shapes
  // themselves (`outside` 0 inside them, 1 clear of them), into `out`.
  at(t: number, outside: number, out: Rgb): void;
}

// The blurred edge of a shape reads 0.5, so 2t puts the ramp's lightest stop
// on the edge; it falls through the stops outward.
function rampOf(stops: readonly string[]): Ramp {
  const colors = stops.map((s) => rgb(s).map((c) => c / 255) as Rgb);
  const at = RAMP_AT.slice(0, colors.length);
  if (colors.length !== at.length) throw new Error(`a glow ramp has 2 to ${RAMP_AT.length} stops (got ${stops.length})`);
  return {
    at(t, outside, out) {
      const u = Math.min(1, 2 * t);
      const last = at.length - 1;
      if (u <= at[last]) {
        const w = (u / at[last]) * outside;
        for (let ch = 0; ch < 3; ch++) out[ch] = colors[last][ch] * w;
        return;
      }
      let i = 0;
      while (i < last && u < at[i + 1]) i++;
      const hi = i === last ? last : i + 1;
      const span = at[i] - at[hi];
      const w = span > 0 ? (u - at[hi]) / span : 1;
      for (let ch = 0; ch < 3; ch++) out[ch] = (colors[hi][ch] + (colors[i][ch] - colors[hi][ch]) * w) * outside;
    },
  };
}

// The dark posters' glow (design §5): cream to near-black.
export const HOT_RAMP: readonly string[] = HOT;

// ---- Small helpers ----------------------------------------------------------------------

const scale = (c: Rgb, k: number): Rgb => [c[0] * k, c[1] * k, c[2] * k];

// A buffer colour: light (1 = full) at 1/HEADROOM, as 8-bit. The hot buffer
// keeps its light in red and marks the shapes themselves in green.
function styleOf(b: Buffer, c: Rgb): string {
  const byte = (v: number) => Math.min(255, Math.max(0, Math.round((v * 255) / HEADROOM)));
  return b.kind === 'hot' ? `rgb(${byte(c[0])}, 255, 0)` : `rgb(${byte(c[0])}, ${byte(c[1])}, ${byte(c[2])})`;
}

function polyline(ctx: EmitTarget, points: Vec2[]) {
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
}

function polygon(ctx: EmitTarget, outline: Vec2[]) {
  polyline(ctx, outline);
  ctx.closePath();
}

function extent(points: Vec2[], pad: number): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

// A closed outline's mean width, 2 × area ÷ perimeter (compositing §2.3).
export function meanWidth(outline: Vec2[]): number {
  let area = 0;
  let perimeter = 0;
  for (let i = 0; i < outline.length; i++) {
    const [x0, y0] = outline[i];
    const [x1, y1] = outline[(i + 1) % outline.length];
    area += x0 * y1 - x1 * y0;
    perimeter += Math.hypot(x1 - x0, y1 - y0);
  }
  return perimeter > 0 ? Math.abs(area) / perimeter : 0;
}

function union(a: Box, b: Box): Box {
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}
