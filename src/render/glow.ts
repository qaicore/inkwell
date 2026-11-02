// The canvas plumbing every brush shares, and the glow: worked out once per
// stroke at quarter resolution from each pixel's distance to the centerline,
// laid down twice: a normal blend, so it still reads on light footage, then
// added ('lighter'), so it blazes on dark. Neon, electric, blade and trail all
// glow through here (SPEC §8.8).
import type { Vec2 } from '../types/effect.ts';
import type { PathTarget } from './brush.ts';
import { Centerline, bounds, hash01, rgb } from './geometry.ts';

const GLOW_REACH = 1.7; // the glow fades to nothing at 1.7 × its radius (B2 allows 2 ×)
const GLOW_HALO = 0.6; // of the glow's strength in the wide halo; the rest hugs the line
const GLOW_GAIN = 1.6; // how lit the glow is at full intensity, clipped at opaque
const GLOW_OVER = 0.5; // opacity of the normal-blend pass, for light footage
const FLICKER = 0.25; // the glow's intensity drops by up to a quarter on a drawing

// ---- Canvas plumbing -------------------------------------------------------------

// The parts of a 2D context the brushes use; the browser's canvas and
// @napi-rs/canvas both have them.
export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}
export interface BrushTarget extends PathTarget {
  globalCompositeOperation: string;
  globalAlpha: number;
  imageSmoothingEnabled: boolean;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  getImageData(x: number, y: number, w: number, h: number): Pixels;
  putImageData(image: Pixels, x: number, y: number): void;
  drawImage(image: never, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void;
}
export interface Scratch {
  canvas: { width: number; height: number };
  ctx: BrushTarget;
}
export type MakeScratch = (width: number, height: number) => Scratch;

// Scratch buffers per canvas maker, one per slot (0 grain, 1 glow, 2 the
// flame aura, 3 and 4 the plate averaged under a mass in impact/scene.ts),
// grown when a stroke needs more room and otherwise reused: no new buffer per
// stroke or per frame, which matters on a phone.
const pools = new WeakMap<MakeScratch, Scratch[]>();
export function scratch(make: MakeScratch, slot: number, width: number, height: number): Scratch {
  let pool = pools.get(make);
  if (!pool) pools.set(make, (pool = []));
  let s = pool[slot];
  if (!s || s.canvas.width < width || s.canvas.height < height) {
    s = make(Math.max(width, s?.canvas.width ?? 0), Math.max(height, s?.canvas.height ?? 0));
    pool[slot] = s;
  }
  s.ctx.setTransform(1, 0, 0, 1, 0, 0);
  s.ctx.globalCompositeOperation = 'source-over';
  // All of it, not just the stroke's box: smoothed upscaling samples a pixel
  // past the box's edge, and that pixel must not hold the last stroke.
  s.ctx.clearRect(0, 0, s.canvas.width, s.canvas.height);
  return s;
}

// What the glow needs from a stroke.
export interface GlowStroke {
  id: number;
  k: number;
  points: Vec2[]; // target px
  color: string;
  scale: number;
  glow: { radiusPx: number; intensity: number };
}

// Bayer 4×4 thresholds: a little ordered dither, so the glow's soft falloff
// doesn't band in 8 bits.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16 - 0.5);

export function drawGlow(ctx: BrushTarget, make: MakeScratch, s: GlowStroke, flicker = FLICKER) {
  const glow = s.glow;
  const radius = glow.radiusPx * s.scale;
  if (!(radius > 0)) return;
  const reach = GLOW_REACH * radius;
  // Quarter resolution at full size; a smaller step for a small glow, so
  // upscaling never carries it past 2 × its radius.
  const q = Math.max(1, Math.min(4, Math.floor(radius / 3)));
  const box = bounds(s.points, reach + 2 * q);
  if (!box) return;
  const x0 = Math.floor(box.x0 / q) * q;
  const y0 = Math.floor(box.y0 / q) * q;
  const w = Math.ceil((box.x0 + box.w - x0) / q);
  const h = Math.ceil((box.y0 + box.h - y0) / q);
  const buf = scratch(make, 1, w, h);
  const img = buf.ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const [r, g, b] = rgb(s.color);
  const intensity = glow.intensity * (1 - flicker * hash01(s.id, s.k, 0x9e37));
  const line = new Centerline(s.points);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dist = line.distance(x0 + (x + 0.5) * q, y0 + (y + 0.5) * q);
      if (dist >= reach) continue;
      // A wide halo plus a tight bloom: lit up along the line, soft far out.
      const u = dist / reach;
      const near = Math.max(0, 1 - u / 0.4);
      const falloff = GLOW_HALO * (1 - u) ** 1.5 + (1 - GLOW_HALO) * near * near;
      const a = Math.round(255 * GLOW_GAIN * intensity * falloff + BAYER[(y & 3) * 4 + (x & 3)]);
      if (a <= 0) continue;
      const i = (y * w + x) * 4;
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = Math.min(255, a);
    }
  }
  buf.ctx.putImageData(img, 0, 0);
  const op = ctx.globalCompositeOperation;
  const smooth = ctx.imageSmoothingEnabled;
  const alpha = ctx.globalAlpha;
  ctx.imageSmoothingEnabled = true;
  ctx.globalAlpha = alpha * GLOW_OVER;
  ctx.drawImage(buf.canvas as never, 0, 0, w, h, x0, y0, w * q, h * q);
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = 'lighter';
  ctx.drawImage(buf.canvas as never, 0, 0, w, h, x0, y0, w * q, h * q);
  ctx.globalCompositeOperation = op;
  ctx.imageSmoothingEnabled = smooth;
}
