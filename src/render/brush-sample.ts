// One brush's sample (SPEC §10 B3): the same three strokes, drawn with that
// brush on a dark backdrop and on a light one, side by side. Qai approves
// each as the brush's golden, and L1 re-renders it from here, so everything
// in it is fixed: the strokes, the pressures, the drawing index.
//   1. A long S with the pressure swelling in the middle: taper and width.
//   2. A quick flick, heavy to nothing: the tip.
//   3. A curl that crosses itself: grain on overlaps, glow where lines meet.
import { createCanvas } from '@napi-rs/canvas';
import type { BrushId, Effect, Stroke, Vec2 } from '../types/effect.ts';
import { DEFAULT_BRUSH, resampleStroke, type Point } from './brush.ts';
import { drawStrokes } from './headless.ts';

export const SAMPLE_PANEL = { width: 640, height: 360 };
export const SAMPLE_BACKDROPS = ['#16141a', '#e9e6df'] as const; // dark footage, light footage
const PALETTE: Effect['palette'] = ['#e8203a', '#f4f1ea', '#16141a'];

function curve(n: number, at: (t: number) => [number, number, number]): Point[] {
  return Array.from({ length: n }, (_, i) => at(i / (n - 1)));
}

const SAMPLE_STROKES: Point[][] = [
  curve(48, (t) => [70 + 300 * t, 180 - 110 * Math.sin(2 * Math.PI * t), 0.25 + 0.75 * Math.sin(Math.PI * t)]),
  curve(16, (t) => [420 + 150 * t, 300 - 90 * t - 40 * t * t, 1 - 0.9 * t]),
  curve(48, (t) => {
    const a = 2.6 * Math.PI * t;
    return [470 + 34 * t * 2 + 46 * Math.cos(a), 110 - 46 * Math.sin(a) + 20 * t, 0.6];
  }),
];

export function brushSamplePng(brush: BrushId): Buffer {
  const strokes: Stroke[] = [];
  const placed = SAMPLE_STROKES.map((raw, i) => {
    const { points, pressure } = resampleStroke(raw, 48);
    const id = i + 1;
    strokes.push({
      id,
      color: 0,
      kind: 'rigid',
      anchor: { type: 'ground', xy: points[0] as Vec2 },
      bodyAngle: 0,
      stiffness: 1,
      wobble: 0,
      brush,
      views: { front: { points, pressure, root: points[0], layer: 'front' } },
    });
    return { id, points, pressure, layer: 'front' as const };
  });
  const effect: Effect = { version: 1, brush: DEFAULT_BRUSH, palette: PALETTE, timing: { drawingsPerSecond: 12 }, strokes, overrides: {} };

  const { width, height } = SAMPLE_PANEL;
  const out = createCanvas(width * SAMPLE_BACKDROPS.length, height);
  const ctx = out.getContext('2d');
  SAMPLE_BACKDROPS.forEach((backdrop, i) => {
    const panel = createCanvas(width, height);
    const p = panel.getContext('2d');
    p.fillStyle = backdrop;
    p.fillRect(0, 0, width, height);
    drawStrokes(p, placed, effect, 1, ['behind', 'front'], 0);
    ctx.drawImage(panel, i * width, 0);
  });
  return out.toBuffer('image/png');
}
