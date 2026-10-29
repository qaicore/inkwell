// The nine brushes (SPEC §8.8), and the limb brush of the impact design (§2).
// Every brush is a perfect-freehand outline of the same simulated centerline;
// they differ only in their settings and in how the outline is filled:
//   - ink, fine-ink: the outline filled solid, straight onto the target.
//   - textured, fine-textured: the outline drawn white into a scratch buffer
//     the size of the stroke, grain cut out of its alpha, tinted to the
//     stroke's color, then laid on the target. The grain is value noise read
//     in the stroke's own coordinates (distance along the centerline, distance
//     across it), seeded by the stroke id, so it rides the line as the physics
//     bends it instead of sliding over it.
//   - neon-straight, neon-round: a lit tube. A glow worked out once per stroke
//     at quarter resolution from each pixel's distance to the centerline, laid
//     down twice: a normal blend, so it still reads on light footage, then
//     added ('lighter'), so it blazes on dark. On top, nested outlines: a thin
//     deep-colored edge (keeps the line readable on light footage), the full
//     brush color, and a hot near-white core along the center. The glow's
//     intensity flickers per drawing, seeded by stroke id and drawing index k,
//     so it changes on 2s and re-renders identically.
//   - electric: a cel-shaded bolt (electric.ts).
//   - blade, trail: shaded per pixel and cached per drawing (solid.ts).
//   - limb: drawn as ink for now. Its settings are registered here; the
//     shaded tube (render/limb.ts) takes over once the impact scene points
//     the dispatch at it.
// The same code draws in Node (@napi-rs/canvas) and in the browser; the
// caller passes a way to make scratch canvases, and they're reused.
import type { BrushId, BrushSettings, Effect, LimbSettings, Vec2 } from '../types/effect.ts';
import { fillOutline, strokeOutline, type Ends } from './brush.ts';
import { Centerline, bounds, grainNoise, mixBlack, mixWhite } from './geometry.ts';
import { drawGlow, scratch, type BrushTarget, type MakeScratch } from './glow.ts';
import { ELECTRIC_BOLT, ELECTRIC_GLOW, ELECTRIC_SIZE, drawElectric } from './electric.ts';
import { BLADE_GLOW, BLADE_SIZE, TRAIL_GLOW, TRAIL_SIZE, drawBlade, drawTrail } from './solid.ts';

export type { BrushTarget, MakeScratch, Pixels, Scratch } from './glow.ts';

export { BRUSH_IDS } from '../types/effect.ts';

// SPEC §8.7 starting values; Qai tunes them.
export const FINE_TIP_SIZE = 0.35; // × the ink brush's size
export const FINE_TIP_THINNING = 0.85; // ink's is 0.65: the line gets fine at fast strokes
export const GRAIN = 0.35;
export const NEON_GLOW = { radiusPx: 12, intensity: 0.8 }; // at 1080 wide
export const NEON_CORE_SIZE = 0.5; // × the ink brush's size
// The tube, from the outside in: [size × the brush's, mix toward white];
// a negative mix darkens toward black.
// Small steps from color to white, so the core fades in rather than banding.
const NEON_TUBE: [number, number][] = [
  [1.0, -0.35], // the edge
  [0.82, 0], // the brush color
  [0.66, 0.25],
  [0.52, 0.5],
  [0.4, 0.72],
  [0.29, 0.88],
  [0.19, 0.97], // the hot core
];
const GRAIN_CELLS_PER_SIZE = 6; // grain cells across the brush: finer than 1/5 reads as texture, not dirt
const GRAIN_CONTRAST = 1.2;
// The limb brush's starting values (impact design §2, §9); Qai tunes them.
export const LIMB_BRUSH = { size: 28, thinning: 0, smoothing: 0.5, streamline: 0.45 };
export const LIMB_GLOW = { radiusPx: 26, intensity: 0.55 }; // at 1080 wide
export const LIMB: LimbSettings = { radius: 0.02, taper: 0.55, socket: 1.3, bands: [-0.08, 0.5, 0.9], linePx: 0.0031, arcs: 3, arcLift: [1.2, 2.1], pulseEvery: [6, 10] };
const limbDefaults = (): LimbSettings => ({ ...LIMB, bands: [...LIMB.bands], arcLift: [...LIMB.arcLift], pulseEvery: [...LIMB.pulseEvery] });

// The settings a brush resolves to: the effect's own (effect.brushes) when it
// has them, otherwise the §8.8 defaults built from the ink brush.
export function brushSettings(effect: Pick<Effect, 'brush' | 'brushes'>, id: BrushId): BrushSettings {
  const ink = effect.brush;
  if (id === 'ink') return ink;
  const fine: BrushSettings = { ...ink, size: FINE_TIP_SIZE * ink.size, thinning: FINE_TIP_THINNING };
  const neon: BrushSettings = { ...ink, size: NEON_CORE_SIZE * ink.size, glow: { ...NEON_GLOW } };
  const defaults: Record<Exclude<BrushId, 'ink'>, BrushSettings> = {
    textured: { ...ink, grain: GRAIN },
    'fine-ink': fine,
    'fine-textured': { ...fine, grain: GRAIN },
    'neon-straight': { ...neon, thinning: 0 }, // even width
    'neon-round': neon,
    electric: { ...ink, size: ELECTRIC_SIZE, glow: { ...ELECTRIC_GLOW }, bolt: { ...ELECTRIC_BOLT } },
    blade: { ...ink, size: BLADE_SIZE * ink.size, glow: { ...BLADE_GLOW } },
    trail: { ...ink, size: TRAIL_SIZE * ink.size, glow: { ...TRAIL_GLOW } },
    limb: { ...LIMB_BRUSH, glow: { ...LIMB_GLOW }, limb: limbDefaults() },
  };
  return { ...defaults[id], ...effect.brushes?.[id] };
}

// Flat ends for the straight neon tip; every other brush tapers to round ends
// ("straight vs round" read as the end shape, §8.8).
export const endsOf = (id: BrushId): Ends => (id === 'neon-straight' ? 'flat' : 'taper');

// ---- Drawing ----------------------------------------------------------------------

export interface BrushStroke {
  id: number; // seeds the grain and the flicker
  points: Vec2[]; // the placed centerline, target px
  pressure: number[];
  color: string; // '#rrggbb'
  accent?: string; // blade: the reflected light's color; missing = `color`
  emerge?: number; // electric: drawings since its emerge moment; missing = always out
  brush: BrushId;
  settings: BrushSettings; // from brushSettings, at 1080 wide
  scale: number; // target width / 1080
  k: number; // drawing index
}

export function drawBrushStroke(ctx: BrushTarget, make: MakeScratch, s: BrushStroke) {
  if (s.brush === 'electric') return drawElectric(ctx, make, s);
  if (s.brush === 'blade') return drawBlade(ctx, make, { ...s, accent: s.accent ?? s.color });
  if (s.brush === 'trail') return drawTrail(ctx, make, { ...s, accent: s.accent ?? s.color });
  const outline = strokeOutline(s.points, s.pressure, s.settings, s.scale, endsOf(s.brush));
  if (s.brush === 'limb') return fillOutline(ctx, outline, s.color); // the ink path, glow and all ignored, until the tube takes over
  if (s.settings.glow) {
    drawGlow(ctx, make, { ...s, glow: s.settings.glow });
    for (const [size, white] of NEON_TUBE) {
      const ring = strokeOutline(s.points, s.pressure, { ...s.settings, size: s.settings.size * size }, s.scale, endsOf(s.brush));
      fillOutline(ctx, ring, white < 0 ? mixBlack(s.color, -white) : mixWhite(s.color, white));
    }
  } else if (s.settings.grain) {
    drawGrained(ctx, make, outline, s);
  } else {
    fillOutline(ctx, outline, s.color);
  }
}

function drawGrained(ctx: BrushTarget, make: MakeScratch, outline: Vec2[], s: BrushStroke) {
  const box = bounds(outline, 1);
  if (!box) return;
  const { x0, y0, w, h } = box;
  const buf = scratch(make, 0, w, h);
  buf.ctx.setTransform(1, 0, 0, 1, -x0, -y0);
  fillOutline(buf.ctx, outline, '#ffffff');
  buf.ctx.setTransform(1, 0, 0, 1, 0, 0);
  const img = buf.ctx.getImageData(0, 0, w, h);
  const line = new Centerline(s.points);
  const cell = Math.max(1, (s.settings.size * s.scale) / GRAIN_CELLS_PER_SIZE);
  const amount = s.settings.grain ?? 0;
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4 + 3;
      if (d[i] === 0) continue;
      const [along, across] = line.coords(x0 + x + 0.5, y0 + y + 0.5);
      const n = grainNoise(along / cell, across / cell, s.id);
      const removed = Math.min(1, Math.max(0, amount + (n - 0.5) * GRAIN_CONTRAST));
      d[i] = Math.round(d[i] * (1 - removed));
    }
  }
  buf.ctx.putImageData(img, 0, 0);
  buf.ctx.globalCompositeOperation = 'source-in';
  buf.ctx.fillStyle = s.color;
  buf.ctx.fillRect(0, 0, w, h);
  buf.ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(buf.canvas as never, 0, 0, w, h, x0, y0, w, h);
}
