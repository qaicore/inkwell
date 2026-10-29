// Colour for the impact (impact design §2, §4, §5, §9): OKLCH both ways, WCAG
// luminance and contrast, the saturated-red test of the flash rules, ΔE, and
// the palette roles every layer draws with. A palette is [p0 main, p1 light,
// p2 ink]. Mixes are straight lerps of the 8-bit sRGB values, which is how
// the strike tones were measured; fire, smoke and dust keep the reference's
// measured ramps whatever the palette is.
import { hex, rgb } from '../render/geometry.ts';

export type Palette = readonly [string, string, string];
type Rgb = [number, number, number];

// ---- sRGB -----------------------------------------------------------------------------

// An 8-bit sRGB channel to linear light, 0..1.
export function linear(c8: number): number {
  const c = c8 / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

// Linear light to an 8-bit channel, clamped and rounded.
function byte(l: number): number {
  const c = l <= 0.0031308 ? 12.92 * l : 1.055 * Math.max(0, l) ** (1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, Math.round(c * 255)));
}

const linearRgb = (color: string): Rgb => rgb(color).map(linear) as Rgb;
const fromLinearRgb = (l: readonly number[]) => hex(l.map(byte));

// '#rrggbb' in lower case.
export const normalizeHex = (color: string): string => hex(rgb(color));

// a → b by t, on the 8-bit values.
export function mixHex(a: string, b: string, t: number): string {
  const x = rgb(a);
  const y = rgb(b);
  return hex(x.map((c, i) => Math.min(255, Math.max(0, Math.round(c + (y[i] - c) * t)))));
}

// WCAG 2 relative luminance, 0..1.
export function luminance(color: string): number {
  const [r, g, b] = linearRgb(color);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// WCAG 2 contrast ratio, 1..21.
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// The flash rules' saturated red (WCAG 2.3.1): R/(R+G+B) ≥ 0.8 in linear light.
export function isSaturatedRed(color: string): boolean {
  const [r, g, b] = linearRgb(color);
  const sum = r + g + b;
  return sum > 0 && r / sum >= 0.8;
}

// ---- OKLab / OKLCH (Björn Ottosson) --------------------------------------------------

export interface Oklch {
  L: number; // 0..1
  C: number; // chroma, 0 or more
  h: number; // hue, degrees 0..360
}

function linearToOklab([r, g, b]: readonly number[]): Rgb {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToLinear([L, a, b]: readonly number[]): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

export const toOklab = (color: string): Rgb => linearToOklab(linearRgb(color));

export function toOklch(color: string): Oklch {
  const [L, a, b] = toOklab(color);
  const h = (Math.atan2(b, a) * 180) / Math.PI;
  return { L, C: Math.hypot(a, b), h: h < 0 ? h + 360 : h };
}

const IN_GAMUT = 1e-6;
const inGamut = (l: readonly number[]) => l.every((c) => c >= -IN_GAMUT && c <= 1 + IN_GAMUT);
const labOf = (L: number, C: number, h: number): Rgb => [L, C * Math.cos((h * Math.PI) / 180), C * Math.sin((h * Math.PI) / 180)];

// OKLCH to '#rrggbb'. Out of gamut, the chroma is lowered (hue and L kept)
// until it fits.
export function fromOklch({ L, C, h }: Oklch): string {
  const l = Math.min(1, Math.max(0, L));
  const c = Math.max(0, C);
  if (inGamut(oklabToLinear(labOf(l, c, h)))) return fromLinearRgb(oklabToLinear(labOf(l, c, h)));
  let lo = 0;
  let hi = c;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(oklabToLinear(labOf(l, mid, h)))) lo = mid;
    else hi = mid;
  }
  return fromLinearRgb(oklabToLinear(labOf(l, lo, h)));
}

// The signed difference b − a between two hues, in −180..180.
export function hueDelta(a: number, b: number): number {
  const d = (((b - a) % 360) + 540) % 360 - 180;
  return d === -180 ? 180 : d;
}

// The circular mean of two hues, in degrees 0..360.
export function hueMean(a: number, b: number): number {
  const h = a + hueDelta(a, b) / 2;
  return ((h % 360) + 360) % 360;
}

// ---- ΔE (CIEDE2000, on CIELAB D65) --------------------------------------------------

export function toLab(color: string): Rgb {
  const [r, g, b] = linearRgb(color);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

// CIEDE2000 between two CIELAB colours (Sharma, Wu and Dalal 2005).
export function deltaE2000([L1, a1, b1]: readonly number[], [L2, a2, b2]: readonly number[]): number {
  const rad = Math.PI / 180;
  const C7 = (((Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2) ** 7);
  const G = 0.5 * (1 - Math.sqrt(C7 / (C7 + 25 ** 7)));
  const ap1 = (1 + G) * a1;
  const ap2 = (1 + G) * a2;
  const Cp1 = Math.hypot(ap1, b1);
  const Cp2 = Math.hypot(ap2, b2);
  const hue = (b: number, a: number) => (b === 0 && a === 0 ? 0 : ((Math.atan2(b, a) / rad) + 360) % 360);
  const hp1 = hue(b1, ap1);
  const hp2 = hue(b2, ap2);
  const dL = L2 - L1;
  const dC = Cp2 - Cp1;
  let dh = 0;
  if (Cp1 * Cp2 !== 0) {
    dh = hp2 - hp1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dh / 2) * rad);
  const Lm = (L1 + L2) / 2;
  const Cm = (Cp1 + Cp2) / 2;
  let hm = hp1 + hp2;
  if (Cp1 * Cp2 !== 0) {
    if (Math.abs(hp1 - hp2) <= 180) hm = (hp1 + hp2) / 2;
    else hm = hp1 + hp2 < 360 ? (hp1 + hp2 + 360) / 2 : (hp1 + hp2 - 360) / 2;
  }
  const T = 1 - 0.17 * Math.cos((hm - 30) * rad) + 0.24 * Math.cos(2 * hm * rad) + 0.32 * Math.cos((3 * hm + 6) * rad) - 0.2 * Math.cos((4 * hm - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hm - 275) / 25) ** 2));
  const Cm7 = Cm ** 7;
  const RC = 2 * Math.sqrt(Cm7 / (Cm7 + 25 ** 7));
  const SL = 1 + (0.015 * (Lm - 50) ** 2) / Math.sqrt(20 + (Lm - 50) ** 2);
  const SC = 1 + 0.045 * Cm;
  const SH = 1 + 0.015 * Cm * T;
  const RT = -Math.sin(2 * dTheta * rad) * RC;
  const l = dL / SL;
  const c = dC / SC;
  const h = dH / SH;
  return Math.sqrt(l * l + c * c + h * h + RT * c * h);
}

// ΔE between two '#rrggbb' colours: CIEDE2000.
export const deltaE = (a: string, b: string): number => deltaE2000(toLab(a), toLab(b));

// ---- The measured constants ---------------------------------------------------------

export const ORANGE = '#fb6a04'; // the reference's flame orange
// The cool discharge set for electricity: arcs, bursts, lightning, floods (§9).
export const DISCHARGE = { edge: '#00027c', band: '#2542fc', core: '#02fdf5', pale: '#abfdf4' } as const;
export const DISCHARGE_HUE = 262; // the measured blues' OKLCH hue
const DISCHARGE_ROTATE_WITHIN = 60; // a p0 this close in hue turns the whole set with it
const ACHROMATIC = 0.02; // OKLCH chroma below which a colour's hue means nothing

// The reference's physical ramps (§6), kept for every palette.
export const FIRE = {
  core: '#fffc7c', // radial gradient centre ...
  outer: '#fefc07', // ... to this at 0.53 U
  licks: ['#fb6a04', '#fa7802'],
  amber: '#fdcd02', // bubbles
  line: ['#866600', '#b17a02'],
  embers: ['#ffdf3e', '#ffb259'],
} as const;
export const SMOKE = {
  tones: ['#642c13', '#552912', '#442413', '#351d13'],
  deep: '#1b0301',
  veins: ['#fc6207', '#fd8d01', '#fd5d0b'], // hot balls
  spots: '#fff884',
  rim: '#e5721b', // the smoke rim within 0.07 S goes toward this in the composite
  paint: ['#b14b15', '#883733'], // smoke painted directly
} as const;
export const HOT = ['#fffdcf', '#b56600', '#733002', '#441003', '#260200'] as const; // dark posters' emission, light to dark
export const DUST = { highlight: '#9e8f7c', fillY: [85, 100], laterY: [110, 125] } as const; // fill luma, rising later

// ---- Roles -----------------------------------------------------------------------------

export interface Roles {
  main: string; // p0: the limbs
  ink: string; // p2
  paper: string; // p1
  tintMax: number; // the most paper is tinted toward p0: 0.20, or 0.15 when p0 is a saturated red
  // Paper tinted toward p0 by s (capped at tintMax). With minLuminance, s is
  // lowered until the tint keeps that relative luminance (gentle mode G3: 0.80).
  tint(s: number, minLuminance?: number): string;
  accent: string; // OKLCH L 0.35, C 0.12, at the circular mean of p0's hue and the orange's
  ring: string; // mix(p1, orange, 0.3)
  strike: { edge: string; accent: string; fill: string; core: string }; // the beam tones (§4)
  discharge: { edge: string; band: string; core: string; pale: string };
  fire: typeof FIRE;
  smoke: typeof SMOKE;
  hot: typeof HOT;
  dust: typeof DUST;
}

export function roles(palette: Palette): Roles {
  const [p0, p1, p2] = palette.map(normalizeHex);
  const main = toOklch(p0);
  const chromatic = main.C >= ACHROMATIC;
  const tintMax = isSaturatedRed(p0) ? 0.15 : 0.2;
  const tintAt = (s: number) => mixHex(p1, p0, s);
  const tint = (s: number, minLuminance = 0) => {
    const t = Math.min(tintMax, Math.max(0, s));
    if (minLuminance <= 0 || luminance(tintAt(t)) >= minLuminance) return tintAt(t);
    if (luminance(p1) < minLuminance) return p1;
    let lo = 0; // passes
    let hi = t; // fails
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (luminance(tintAt(mid)) >= minLuminance) lo = mid;
      else hi = mid;
    }
    return tintAt(lo);
  };
  const orangeHue = toOklch(ORANGE).h;
  const accent = fromOklch({ L: 0.35, C: 0.12, h: chromatic ? hueMean(main.h, orangeHue) : orangeHue });
  const turn = chromatic && Math.abs(hueDelta(DISCHARGE_HUE, main.h)) <= DISCHARGE_ROTATE_WITHIN ? hueDelta(DISCHARGE_HUE, main.h) : 0;
  const rotate = (color: string) => {
    if (turn === 0) return color;
    const c = toOklch(color);
    return fromOklch({ ...c, h: (c.h + turn + 360) % 360 });
  };
  return {
    main: p0,
    ink: p2,
    paper: p1,
    tintMax,
    tint,
    accent,
    ring: mixHex(p1, ORANGE, 0.3),
    strike: { edge: mixHex(p0, p2, 0.5), accent: p0, fill: mixHex(p0, p1, 0.55), core: mixHex(p1, p0, 0.12) },
    discharge: { edge: rotate(DISCHARGE.edge), band: rotate(DISCHARGE.band), core: rotate(DISCHARGE.core), pale: rotate(DISCHARGE.pale) },
    fire: FIRE,
    smoke: SMOKE,
    hot: HOT,
    dust: DUST,
  };
}
