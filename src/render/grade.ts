// The plate grade (impact design §7): the video under the impact takes the
// light. One timeline gives every frame's parameters {L, lift, hueAmt, pool,
// WB}, and applyGrade lays them on a canvas with three compositing ops. That
// Canvas2D path is the reference: Node, the export and the preview fallback
// all use it.
//   1. A 'color' fill of the light L at alpha 0.5·hueAmt: the plate takes L's
//      hue and saturation and keeps its own luminosity.
//   2. The pool: a radial gradient round P, drawn 'screen' over its own box.
//   3. A 'multiply' fill of the white balance (1, 1, B×).
// An op that would change nothing is skipped, so a neutral grade leaves the
// canvas byte-identical. createGradeGL is the same three ops as one WebGL
// pass, for the preview only: never in Node or the export.
//
// Timeline (design §7):
//   - before the strike, and from J_end on: identity;
//   - strike, j −8..−1 (S0..S6): L = hsv(h(p0), 0.6, 1), hueAmt 0 on S0 and
//     0.6 from S1, lift 1.25, a pool of c·20 Y in p0 with c the strike's
//     charge gain; j 0..8 keep the strike's look while the charge fades over
//     j 0..3 (the posters cover it, unless there are none);
//   - aftermath, j 9..31: the hold group g 0..8 of kr(j), each with its own L
//     hue, lift and pool, and B× = 1 − 0.34·g/8;
//   - hold, j 32..J_end − 14: g8's values;
//   - decay, the last 14 frames: linear to identity, exactly at J_end, with
//     the same decayAlpha every decaying layer uses.
import type { ImpactContext, Vec2 } from '../impact/contracts.ts';
import { decayAlpha, kr, massGroup } from '../impact/clock.ts';
import { hex, rgb } from './geometry.ts';
import type { BrushTarget } from './glow.ts';

type Rgb = [number, number, number]; // 0..1

export interface Pool {
  c: Vec2; // centre, frame px
  sigma: number; // px
  color: string; // its colour: p0 in the strike, L in the aftermath
  dY: number; // the peak lift, luma levels
}

export interface Grade {
  L: string; // the light, '#rrggbb' at V 1
  lift: number; // the ground lift; the WebGL model and the reference's, not drawn by a 'color' fill (see applyGrade)
  hueAmt: number; // 0..1: how far the plate takes L's hue
  pool: Pool | null;
  WB: Rgb; // per-channel white balance, 1 = none
}

export const NEUTRAL_GRADE: Grade = Object.freeze({ L: '#ffffff', lift: 1, hueAmt: 0, pool: null, WB: Object.freeze([1, 1, 1]) as unknown as Rgb });

export const LIGHT_SAT = 0.6; // L's saturation, strike and aftermath
export const HUE_AMT = 0.6; // the plate's hue amount from S1 on (the reference's ≈ 1.0 is too strong for live video)
export const STRIKE_LIFT = 1.25;
export const STRIKE_POOL = 20; // Y at charge 1
export const STRIKE_CHARGE = [0, 0.11, 0.16, 0.06, 0.38, 0.82, 1.0]; // the charge gain c on S0..S6 (design §9)
export const AFTERMATH_GRADE = {
  hue: [47, 45, 42, 35, 31, 27, 20, 17, 7], // L's hue per hold group g0..g8, degrees
  lift: [1.9, 1.76, 1.67, 1.55, 1.52, 1.33, 1.24, 1.05, 0.95],
  pool: [40, 37, 35, 30, 25, 25, 24, 20, 17], // Y
} as const;
export const WB_SPAN = 0.34; // B× = 1 − 0.34·g/8
export const POOL_SIGMA = 0.24; // × U, round P
export const POOL_CANVAS = 0.6; // Canvas2D's screen lifts mid-tones too, so the pool is drawn at 0.6× its peak
export const POOL_REACH = 2.5; // the gradient is transparent from 2.5 σ
export const PERSON_AMT = 0.5; // the person cutout's share of the grade
const POOL_STOPS = 12;
const ACHROMATIC = 0.08; // a p0 below this HSV saturation has no hue: the strike's light is white

// What the timeline reads.
export type GradeContext = Pick<ImpactContext, 'jEnd' | 'frame' | 'palette'>;

// ---- HSV --------------------------------------------------------------------------------

export function hsvOf(color: string): { h: number; s: number; v: number } {
  const [r, g, b] = rgb(color).map((c) => c / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d > 0) {
    if (max === r) h = 60 * ((((g - b) / d) % 6) + 6) % 360;
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return { h, s: max > 0 ? d / max : 0, v: max };
}

// HSV (degrees, 0..1, 0..1) to RGB 0..1.
export function hsvRgb(h: number, s: number, v: number): Rgb {
  const hh = (((h % 360) + 360) % 360) / 60;
  const i = Math.floor(hh) % 6;
  const f = hh - Math.floor(hh);
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  return ([[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]] as Rgb[])[i];
}

const toHex = (c: readonly number[]) => hex(c.map((x) => Math.min(255, Math.max(0, Math.round(x * 255)))));
const lightOf = (h: number, s = LIGHT_SAT) => toHex(hsvRgb(h, s, 1));

// ---- The timeline -----------------------------------------------------------------------

// The grade on frame j (frames since contact; null without a slam).
export function gradeAt(j: number | null, ictx: GradeContext): Grade {
  if (j === null || j < -8 || j >= ictx.jEnd) return NEUTRAL_GRADE;
  if (j <= 8) return strikeGrade(j, ictx);
  const base = aftermathGrade(j <= 31 ? groupOf(j) : 8, ictx);
  return fade(base, decayAlpha(j, ictx.jEnd));
}

// The hold group of kr(j), j 9..31. At 30 drawings a second every frame starts
// a drawing, so massGroup's group is kr(j)'s own.
function groupOf(j: number): number {
  return Math.min(8, Math.max(0, massGroup(j, 0, 30) ?? 0));
}

function strikeGrade(j: number, ictx: GradeContext): Grade {
  const p0 = ictx.palette[0];
  const { h, s } = hsvOf(p0);
  const step = j < 0 ? kr(j) : null; // S0..S6
  const charge = step !== null ? STRIKE_CHARGE[step] : j <= 3 ? 1 - j / 3 : 0;
  return {
    L: lightOf(h, s < ACHROMATIC ? 0 : LIGHT_SAT),
    lift: STRIKE_LIFT,
    hueAmt: step === 0 ? 0 : HUE_AMT,
    pool: charge > 0 ? { c: ictx.frame.P, sigma: POOL_SIGMA * ictx.frame.U, color: p0, dY: STRIKE_POOL * charge } : null,
    WB: [1, 1, 1],
  };
}

function aftermathGrade(g: number, ictx: GradeContext): Grade {
  const L = lightOf(AFTERMATH_GRADE.hue[g]);
  return {
    L,
    lift: AFTERMATH_GRADE.lift[g],
    hueAmt: HUE_AMT,
    pool: { c: ictx.frame.P, sigma: POOL_SIGMA * ictx.frame.U, color: L, dY: AFTERMATH_GRADE.pool[g] },
    WB: [1, 1, 1 - (WB_SPAN * g) / 8],
  };
}

// a of the way from identity to `g`.
function fade(g: Grade, a: number): Grade {
  if (a >= 1) return g;
  if (a <= 0) return NEUTRAL_GRADE;
  return {
    L: g.L,
    lift: 1 + (g.lift - 1) * a,
    hueAmt: g.hueAmt * a,
    pool: g.pool && { ...g.pool, dY: g.pool.dY * a },
    WB: g.WB.map((w) => 1 + (w - 1) * a) as Rgb,
  };
}

// True when applyGrade would draw nothing.
export function isNeutral(g: Grade, amount = 1): boolean {
  return colorAlpha(g, amount) <= 0 && poolPeak(g, amount) === null && wbOf(g, amount).every((w) => w === 1);
}

// ---- Canvas2D, the reference ------------------------------------------------------------

// The canvas calls the grade needs, past what BrushTarget has; the browser's
// canvas and @napi-rs/canvas both have them.
interface GradeTarget extends BrushTarget {
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): { addColorStop(offset: number, color: string): void };
}

// The 'color' fill's alpha.
const colorAlpha = (g: Grade, amount: number) => 0.5 * g.hueAmt * amount;

// The white balance at `amount` of its strength.
const wbOf = (g: Grade, amount: number) => g.WB.map((w) => 1 + (w - 1) * amount) as Rgb;

// The pool's peak colour as drawn (0..1), or null when it lifts nothing:
// L scaled to luma dY/255, times POOL_CANVAS.
function poolPeak(g: Grade, amount: number): Rgb | null {
  const pool = g.pool;
  if (!pool || !(pool.dY > 0) || !(pool.sigma > 0) || !(amount > 0)) return null;
  const c = rgb(pool.color).map((x) => x / 255) as Rgb;
  const luma = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const k = luma > 0 ? (POOL_CANVAS * amount * pool.dY) / 255 / luma : 0;
  const peak = c.map((x) => Math.min(1, x * k)) as Rgb;
  return peak.some((x) => x >= 0.5 / 255) ? peak : null;
}

// Grades what's on ctx over the frame rect (0, 0, width, height), in ctx's own
// transform: frame px. `amount` scales the whole grade (the person cutout
// takes PERSON_AMT). The 'color' fill is L itself: that op keeps the plate's
// luminosity, so lift has no say in it, and L·lift would only lose
// saturation where it clips. The rest of the light comes from the pool.
export function applyGrade(ctx: BrushTarget, g: Grade, width: number, height: number, amount = 1) {
  const alpha = colorAlpha(g, amount);
  const peak = poolPeak(g, amount);
  const wb = wbOf(g, amount);
  const balance = wb.some((w) => w !== 1);
  if (!(alpha > 0) && !peak && !balance) return;
  const op = ctx.globalCompositeOperation;
  const ga = ctx.globalAlpha;
  const style = ctx.fillStyle;
  if (alpha > 0) {
    ctx.globalCompositeOperation = 'color';
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.fillStyle = g.L;
    ctx.fillRect(0, 0, width, height);
    ctx.globalAlpha = 1;
  }
  if (peak) drawPool(ctx as GradeTarget, g.pool!, peak, width, height);
  if (balance) {
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = 1;
    ctx.fillStyle = toHex(wb);
    ctx.fillRect(0, 0, width, height);
  }
  ctx.globalCompositeOperation = op;
  ctx.globalAlpha = ga;
  ctx.fillStyle = style;
}

// The pool: Gaussian stops out to 2.5 σ, 'screen', over its own box only.
function drawPool(ctx: GradeTarget, pool: Pool, peak: Rgb, width: number, height: number) {
  const r = POOL_REACH * pool.sigma;
  const [cx, cy] = pool.c;
  const x0 = Math.max(0, Math.floor(cx - r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const x1 = Math.min(width, Math.ceil(cx + r));
  const y1 = Math.min(height, Math.ceil(cy + r));
  if (x1 <= x0 || y1 <= y0) return;
  const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  for (let i = 0; i <= POOL_STOPS; i++) {
    const t = i / POOL_STOPS;
    const w = i === POOL_STOPS ? 0 : Math.exp(-((POOL_REACH * t) ** 2) / 2);
    gradient.addColorStop(t, toHex(peak.map((c) => c * w)));
  }
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = 1;
  ctx.fillStyle = gradient;
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
}

// ---- WebGL, the preview's fast path -----------------------------------------------------

type GLCanvas = HTMLCanvasElement | OffscreenCanvas;

export interface GradeGL {
  readonly canvas: GLCanvas;
  // Grades a frame-sized source into the GL canvas and returns it, ready for drawImage.
  draw(source: TexImageSource, g: Grade, width: number, height: number, amount?: number): GLCanvas;
  dispose(): void;
}

const VERTEX = `
attribute vec2 pos;
varying vec2 uv;
void main() {
  uv = vec2(0.5 + 0.5 * pos.x, 0.5 - 0.5 * pos.y);
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

// The three Canvas2D ops in one pass, as the compositing spec defines them:
// 'color' is SetLum(L, Lum(backdrop)) at alpha colorA, then the pool's screen,
// then the multiply.
const FRAGMENT = `
precision mediump float;
uniform sampler2D video;
uniform vec2 size;
uniform vec3 light;
uniform float colorA;
uniform vec2 poolC;
uniform float poolR;
uniform float poolK;
uniform vec3 poolRGB;
uniform vec3 wb;
varying vec2 uv;
float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c) {
  float l = lum(c);
  float n = min(c.r, min(c.g, c.b));
  float x = max(c.r, max(c.g, c.b));
  if (n < 0.0) c = l + (c - l) * l / (l - n);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / (x - l);
  return c;
}
void main() {
  vec3 c = texture2D(video, uv).rgb;
  vec3 hue = clipColor(light + (lum(c) - lum(light)));
  c = mix(c, hue, colorA);
  vec2 d = uv * size - poolC;
  float r2 = dot(d, d);
  if (r2 < poolR * poolR) {
    vec3 s = poolRGB * exp(-r2 * poolK);
    c = 1.0 - (1.0 - c) * (1.0 - s);
  }
  gl_FragColor = vec4(c * wb, 1.0);
}`;

// A WebGL grade on `canvas` (the app's one WebGL canvas), or a new one; null
// where WebGL is missing, as in Node. The preview falls back to applyGrade.
export function createGradeGL(canvas?: GLCanvas): GradeGL | null {
  const c = canvas ?? newCanvas();
  if (!c) return null;
  const gl = ((c as HTMLCanvasElement).getContext('webgl', { premultipliedAlpha: false, antialias: false }) ?? null) as WebGLRenderingContext | null;
  if (!gl) return null;
  const program = link(gl);
  if (!program) return null;
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const at = (name: string) => gl.getUniformLocation(program, name);
  const u = { size: at('size'), light: at('light'), colorA: at('colorA'), poolC: at('poolC'), poolR: at('poolR'), poolK: at('poolK'), poolRGB: at('poolRGB'), wb: at('wb') };
  const pos = gl.getAttribLocation(program, 'pos');
  return {
    canvas: c,
    draw(source, g, width, height, amount = 1) {
      if (c.width !== width || c.height !== height) {
        c.width = width;
        c.height = height;
      }
      gl.viewport(0, 0, width, height);
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(pos);
      gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, source);
      const peak = poolPeak(g, amount);
      const pool = g.pool;
      const light = rgb(g.L).map((x) => x / 255);
      gl.uniform2f(u.size, width, height);
      gl.uniform3f(u.light, light[0], light[1], light[2]);
      gl.uniform1f(u.colorA, Math.min(1, colorAlpha(g, amount)));
      gl.uniform2f(u.poolC, pool ? pool.c[0] : 0, pool ? pool.c[1] : 0);
      gl.uniform1f(u.poolR, peak && pool ? POOL_REACH * pool.sigma : 0);
      gl.uniform1f(u.poolK, peak && pool ? 1 / (2 * pool.sigma * pool.sigma) : 0);
      gl.uniform3f(u.poolRGB, peak ? peak[0] : 0, peak ? peak[1] : 0, peak ? peak[2] : 0);
      const wb = wbOf(g, amount);
      gl.uniform3f(u.wb, wb[0], wb[1], wb[2]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return c;
    },
    dispose() {
      gl.deleteTexture(texture);
      gl.deleteBuffer(quad);
      gl.deleteProgram(program);
    },
  };
}

function newCanvas(): GLCanvas | null {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(1, 1);
  if (typeof document !== 'undefined') return document.createElement('canvas');
  return null;
}

function link(gl: WebGLRenderingContext): WebGLProgram | null {
  const shader = (type: number, source: string) => {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, source);
    gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
  };
  const vs = shader(gl.VERTEX_SHADER, VERTEX);
  const fs = shader(gl.FRAGMENT_SHADER, FRAGMENT);
  const program = gl.createProgram();
  if (!vs || !fs || !program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : null;
}
