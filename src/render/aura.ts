// The flame aura (SPEC §8.6): grown from the person mask, so nobody draws it
// and it follows him for free. Drawn after the video frame and under the
// person cutout, so it only shows around him.
//   - Distance field: how far each pixel is from the person, at half
//     resolution (two chamfer passes, the classic two-sweep distance
//     transform with 1 and √2 steps).
//   - The edge: seeded value noise, stretched upward, says how far the flame
//     reaches at each pixel, up to 0.1 torso heights at his feet and 0.5 at
//     his head, so the edge licks up.
//   - Inside, colored in layers, never a flat fill: a deep band hugging the
//     body, shorter inner tongues with their own lighter edges, rising
//     streaks, a paler outer flame and a thin bright rim. Embers drift off
//     the top.
// The noise is read relative to the person's box, not the screen, so the
// flames ride along with him instead of him sliding through them; it's
// seeded by drawing index k, so it changes on 2s and re-renders identically.
import type { Vec2 } from '../types/effect.ts';
import { fillOutline } from './brush.ts';
import { hash01, hex, mix, rgb, smoothstep, valueNoise } from './geometry.ts';
import { scratch, type BrushTarget, type MakeScratch } from './glow.ts';

// SPEC §8.7 starting values; Qai tunes them.
export const AURA_REACH = { feet: 0.1, head: 0.5 }; // torso heights
export const AURA_EMBERS = 26; // per drawing
// The noise's cell size in torso heights: narrow licks, tall flames.
const LICK = { across: 0.11, up: 0.31 };
const BAND = 0.022; // torso heights: the unit the color bands are measured in

export interface FlameAura {
  mask: ArrayLike<number>; // width × height, > 0 is the person
  width: number;
  height: number;
  color: string;
  k: number; // drawing index
  torsoPx: number; // one torso height, in mask px
  scale?: number; // target px per mask px (default 1)
}

export function drawFlameAura(ctx: BrushTarget, make: MakeScratch, a: FlameAura) {
  const box = maskBox(a);
  if (!box || !(a.torsoPx > 0)) return;
  const torso = a.torsoPx / 2; // half resolution from here on
  const unit = BAND * torso;
  const reachMost = AURA_REACH.head * torso;
  // The region: the person's box plus the farthest reach, on the half grid.
  const hw = Math.ceil(a.width / 2);
  const hh = Math.ceil(a.height / 2);
  const pad = Math.ceil(reachMost) + 2;
  const rx0 = Math.max(0, (box.x0 >> 1) - pad);
  const ry0 = Math.max(0, (box.y0 >> 1) - pad);
  const rx1 = Math.min(hw - 1, (box.x1 >> 1) + pad);
  const ry1 = Math.min(hh - 1, (box.y1 >> 1) + pad);
  const w = rx1 - rx0 + 1;
  const h = ry1 - ry0 + 1;
  const d = distanceField(a, rx0, ry0, w, h);
  // Noise origin and height scale: the person's own box.
  const ox = box.x0 >> 1;
  const top = box.y0 >> 1;
  const bottom = box.y1 >> 1;
  const span = Math.max(1, bottom - top);
  const base = rgb(a.color);
  const deep = mix(base.map((c) => c * 0.55), [60, 0, 90], 0.25);
  const pale = mix(base, [255, 250, 255], 0.5);
  const rim = mix(base, [255, 255, 255], 0.8);
  const k = a.k;
  const reachAt = (y: number) => torso * (AURA_REACH.feet + (AURA_REACH.head - AURA_REACH.feet) * Math.min(1, Math.max(0, (bottom - y) / span)));
  const buf = scratch(make, 2, w, h);
  const img = buf.ctx.getImageData(0, 0, w, h);
  const px = img.data;
  for (let y = 0; y < h; y++) {
    const gy = ry0 + y;
    const reachMax = reachAt(gy);
    const Y = (gy - top) / torso;
    for (let x = 0; x < w; x++) {
      const D = d[y * w + x];
      if (D === 0 || D > reachMax) continue; // the person covers the inside anyway
      const X = (rx0 + x - ox) / torso;
      const n = valueNoise(X / LICK.across, Y / LICK.up + k * 0.9, 51) * 0.65 + valueNoise(X / (LICK.across / 2), Y / (LICK.up / 2.3) + k * 1.7, 53) * 0.35;
      const reach = reachMax * (0.25 + 0.75 * n);
      const edge = smoothstep(0, Math.max(0.8, 0.6 * unit), reach - D);
      if (edge <= 0) continue;
      // Inner tongues: a second, shorter flame inside, with a lighter edge.
      const inner = reach * (0.3 + 0.4 * valueNoise(X / 0.067, Y / 0.2 + k * 1.3, 57));
      const streak = fbm(X / 0.031, Y / 0.18 + k * 1.1, 59); // rising streaks
      let c = mix(deep, base, smoothstep(0.3 * unit, 2 * unit, D));
      c = mix(c, c.map((v) => v * 0.6), smoothstep(0.5, 0.8, streak) * 0.6 * (1 - smoothstep(0, unit, D - inner)));
      c = mix(c, mix(base, pale, 0.25), smoothstep(-0.3 * unit, 0.3 * unit, D - inner));
      c = mix(c, pale, 0.8 * (1 - smoothstep(0, 0.45 * unit, Math.abs(D - inner))));
      c = mix(c, pale, smoothstep(0.6, 0.9, D / reach) * 0.6);
      c = mix(c, rim, (1 - smoothstep(0.15 * unit, 0.8 * unit, reach - D)) * 0.9); // the bright rim
      const o = (y * w + x) * 4;
      px[o] = c[0];
      px[o + 1] = c[1];
      px[o + 2] = c[2];
      px[o + 3] = Math.round(255 * edge * (0.7 + 0.25 * smoothstep(0.5, 1, D / reach)));
    }
  }
  buf.ctx.putImageData(img, 0, 0);
  const s = 2 * (a.scale ?? 1);
  const smooth = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(buf.canvas as never, 0, 0, w, h, rx0 * s, ry0 * s, w * s, h * s);
  ctx.imageSmoothingEnabled = smooth;
  drawEmbers(ctx, a, { d, rx0, ry0, w, h, ox, top, span, torso, reachAt }, hex(rim), a.color);
}

// Embers rising off the top of the flame: small upright sparks, placed only
// where the flame reaches, so they stay with it.
function drawEmbers(
  ctx: BrushTarget,
  a: FlameAura,
  f: { d: Float32Array; rx0: number; ry0: number; w: number; h: number; ox: number; top: number; span: number; torso: number; reachAt: (y: number) => number },
  bright: string,
  color: string,
) {
  const s = 2 * (a.scale ?? 1);
  const size = f.torso / 90; // half px per ember size unit
  const alpha = ctx.globalAlpha;
  for (let e = 0; e < AURA_EMBERS; e++) {
    const r = (q: number) => hash01(e, a.k * 61 + 7, q);
    const gx = Math.round(f.ox + (r(1) - 0.1) * 1.2 * (f.w - 2 * (f.ox - f.rx0)));
    const gy = Math.round(f.top - f.reachAt(f.top) * 0.8 + r(2) ** 1.4 * (f.span * 0.45 + f.reachAt(f.top)));
    const x = gx - f.rx0;
    const y = gy - f.ry0;
    if (x < 0 || y < 0 || x >= f.w || y >= f.h) continue;
    const D = f.d[y * f.w + x];
    if (D === 0 || D > f.reachAt(gy) * 0.9) continue;
    const rx = (0.8 + 1.4 * r(5)) * size;
    const ry = 2 * rx;
    const dot: Vec2[] = [];
    for (let q = 0; q < 6; q++) dot.push([(gx + Math.cos((q * Math.PI) / 3) * rx) * s, (gy + Math.sin((q * Math.PI) / 3) * ry) * s]);
    ctx.globalAlpha = alpha * (0.5 + 0.5 * r(3));
    fillOutline(ctx, dot, r(4) < 0.4 ? bright : color);
  }
  ctx.globalAlpha = alpha;
}

// The person's bounding box in mask px, or null if the mask is empty.
function maskBox(a: FlameAura): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < a.height; y++) {
    const row = y * a.width;
    for (let x = 0; x < a.width; x++) {
      if (!(a.mask[row + x] > 0)) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

// Distance from the person in half-res px, over the region: a cell is the
// person if any of its 2×2 mask pixels is.
function distanceField(a: FlameAura, rx0: number, ry0: number, w: number, h: number): Float32Array {
  const d = new Float32Array(w * h).fill(1e9);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const mx = (rx0 + x) * 2;
      const my = (ry0 + y) * 2;
      for (let j = 0; j < 2 && d[y * w + x] !== 0; j++) {
        if (my + j >= a.height) break;
        for (let i = 0; i < 2; i++) {
          if (mx + i < a.width && a.mask[(my + j) * a.width + mx + i] > 0) {
            d[y * w + x] = 0;
            break;
          }
        }
      }
    }
  }
  const S = Math.SQRT2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 1);
        if (x > 0) v = Math.min(v, d[i - w - 1] + S);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + S);
      }
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + 1);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 1);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + S);
        if (x > 0) v = Math.min(v, d[i + w - 1] + S);
      }
      d[i] = v;
    }
  }
  return d;
}

function fbm(x: number, y: number, seed: number): number {
  return valueNoise(x, y, seed) * 0.55 + valueNoise(x * 2.1, y * 2.1, seed + 1) * 0.3 + valueNoise(x * 4.3, y * 4.3, seed + 2) * 0.15;
}
