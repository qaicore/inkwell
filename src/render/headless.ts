// Renders placed strokes to a PNG in Node, with @napi-rs/canvas, through the
// same outline and fill code the browser uses (SPEC §6: one code path). The
// tests, the goldens and the contact sheets draw with this.
import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import type { Effect } from '../types/effect.ts';
import type { PlacedStroke } from '../motion/animate.ts';
import { fillOutline, strokeOutline } from './brush.ts';

// `scale` multiplies the brush size: the frame's width / 1080.
export function renderPng(width: number, height: number, strokes: PlacedStroke[], effect: Effect, scale = 1): Buffer {
  const canvas = createCanvas(width, height);
  drawStrokes(canvas.getContext('2d'), strokes, effect, scale);
  return canvas.toBuffer('image/png');
}

// Behind strokes first, then front ones, each in drawing order.
export function drawStrokes(ctx: SKRSContext2D, strokes: PlacedStroke[], effect: Effect, scale = 1) {
  const colorOf = new Map(effect.strokes.map((s) => [s.id, effect.palette[s.color]]));
  for (const layer of ['behind', 'front'] as const) {
    for (const stroke of strokes) {
      if (stroke.layer !== layer) continue;
      fillOutline(ctx, strokeOutline(stroke.points, stroke.pressure, effect.brush, scale), colorOf.get(stroke.id) ?? '#000000');
    }
  }
}
