// Cel tones from one colour (impact design §2, "Tones"): the limb brush's
// line, shadow, lit and core tones around its body colour. Each tone keeps the
// body's hue family and gets its own luma:
//   - Luma is Rec. 709 on the 8-bit values, as limbs3d measured the reference.
//     The darks are a share of the body's luma; the lights are a share of the
//     way from the body's luma to white, so a light body still gets a light
//     band and a hot core below white instead of clipping both to white.
//   - The darks lean cool and the lights warm, as the reference's lit volumes
//     do (limbs3d §1.1: its shadow 10° toward violet, its light 29° toward
//     yellow). The turns are limbs3d's: the line 12° toward 250°, the shadow
//     12° toward 280°, the lit tone 14° and the core 20° toward 50° (a warm
//     body) or 185° (a cool one). The lights give up saturation: the lit tone
//     keeps 0.62 of it and the core has 0.14.
//   - A tone is then mixed toward black (the darks) or white (the lights)
//     until its luma lands. A light tone that can't reach its luma at full
//     value gives up more saturation, which is mixing toward white: the
//     gamut clamp. HSV at value ≤ 1 is always inside sRGB.
// The ratios are fitted to the hero red's ladder, the one design §2's table
// lists (#e8203a: line #27010e, shadow #680627, lit #ff8577, core #ffe3db). The
// table's ×0.19 / 0.40 / 1.69 / 1.85 are the reference fireball's own ratios,
// for an orange body of luma 131; on a red of luma 76 they give a mid-pink
// core (luma 141) where the table's core is near white (luma 232).
import { hex, rgb } from './geometry.ts';

export interface CelTones {
  line: string; // the outline
  shadow: string; // the unlit side
  body: string; // the colour itself
  lit: string; // the light band
  core: string; // the hot highlight
}

type Hsv = [h: number, s: number, v: number]; // h degrees 0..360, s and v 0..1

const LINE = { toward: 250, turn: 12, sat: 0.1, luma: 0.131 }; // saturation + sat, luma × the body's
const SHADOW = { toward: 280, turn: 12, sat: 0.08, luma: 0.382 };
const LIT = { warm: 50, cool: 185, turn: 14, sat: 0.62, headroom: 0.457 }; // saturation × sat; luma this share of the way to white
const CORE = { warm: 50, cool: 185, turn: 20, sat: 0.14, headroom: 0.873 }; // saturation = sat
const GREY = 0.05; // a body less saturated than this has no hue to keep: its tones stay grey
const STEPS = 32; // bisection steps; far below one 8-bit level

// Rec. 709 luma of a colour, 0..255.
export function luma709(color: string): number {
  const [r, g, b] = rgb(color);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function celTones(color: string): CelTones {
  const body = hex(rgb(color));
  const [h, s] = hsvOf(body);
  const y = luma709(body);
  const grey = s < GREY;
  const warm = h < 90 || h > 270;
  const sat = (v: number) => (grey ? 0 : Math.min(1, Math.max(0, v)));
  return {
    line: toLuma(turned(h, LINE.toward, LINE.turn), sat(s + LINE.sat), LINE.luma * y),
    shadow: toLuma(turned(h, SHADOW.toward, SHADOW.turn), sat(s + SHADOW.sat), SHADOW.luma * y),
    body,
    lit: toLuma(turned(h, warm ? LIT.warm : LIT.cool, LIT.turn), sat(s * LIT.sat), y + LIT.headroom * (255 - y)),
    core: toLuma(turned(h, warm ? CORE.warm : CORE.cool, CORE.turn), sat(CORE.sat), y + CORE.headroom * (255 - y)),
  };
}

// Hue h turned toward `target` by `by` degrees, never past it.
function turned(h: number, target: number, by: number): number {
  const d = ((((target - h) % 360) + 540) % 360) - 180;
  return (h + Math.sign(d) * Math.min(by, Math.abs(d)) + 360) % 360;
}

// The colour of hue h and saturation s whose luma is `y`: its value lowered
// (mixed toward black) when full value is bright enough, otherwise full
// value with the saturation lowered (mixed toward white).
function toLuma(h: number, s: number, y: number): string {
  const lumaAt = (sat: number, v: number) => {
    const [r, g, b] = fromHsv([h, sat, v]);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  if (lumaAt(s, 1) >= y) {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < STEPS; i++) {
      const mid = (lo + hi) / 2;
      if (lumaAt(s, mid) < y) lo = mid;
      else hi = mid;
    }
    return hex(fromHsv([h, s, (lo + hi) / 2]).map(Math.round));
  }
  let lo = 0; // reaches y
  let hi = s; // doesn't
  for (let i = 0; i < STEPS; i++) {
    const mid = (lo + hi) / 2;
    if (lumaAt(mid, 1) >= y) lo = mid;
    else hi = mid;
  }
  return hex(fromHsv([h, lo, 1]).map(Math.round));
}

function hsvOf(color: string): Hsv {
  const [r, g, b] = rgb(color).map((c) => c / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d > 0) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, max > 0 ? d / max : 0, max];
}

// HSV to 8-bit RGB, unrounded.
function fromHsv([h, s, v]: Hsv): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}
