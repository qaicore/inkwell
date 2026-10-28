// Renders placed strokes to a PNG in Node, with @napi-rs/canvas, through the
// same brush code the browser uses (SPEC §6: one code path). The tests, the
// goldens and the contact sheets draw with this.
import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import type { Effect } from '../types/effect.ts';
import type { PlacedStroke } from '../motion/animate.ts';
import { brushSettings, drawBrushStroke, type BrushTarget, type MakeScratch } from './brushes.ts';

type Layer = PlacedStroke['layer'];

// Scratch canvases for the textured and neon brushes, in Node.
export const nodeScratch: MakeScratch = (width, height) => {
  const canvas = createCanvas(width, height);
  return { canvas, ctx: canvas.getContext('2d') as unknown as BrushTarget };
};

// `scale` multiplies the brush size: the frame's width / 1080. `k` is the
// drawing index, which seeds the neon flicker.
export function renderPng(width: number, height: number, strokes: PlacedStroke[], effect: Effect, scale = 1, k = 0): Buffer {
  const canvas = createCanvas(width, height);
  drawStrokes(canvas.getContext('2d'), strokes, effect, scale, ['behind', 'front'], k);
  return canvas.toBuffer('image/png');
}

// Behind strokes first, then front ones, each in drawing order. Pass one
// layer to draw something between them, like the person.
export function drawStrokes(ctx: SKRSContext2D, strokes: PlacedStroke[], effect: Effect, scale = 1, layers: readonly Layer[] = ['behind', 'front'], k = 0) {
  const byId = new Map(effect.strokes.map((s) => [s.id, s]));
  for (const layer of layers) {
    for (const stroke of strokes) {
      if (stroke.layer !== layer) continue;
      const source = byId.get(stroke.id);
      const brush = source?.brush ?? 'ink';
      drawBrushStroke(ctx as unknown as BrushTarget, nodeScratch, {
        id: stroke.id,
        points: stroke.points,
        pressure: stroke.pressure,
        color: source ? effect.palette[source.color] : '#000000',
        brush,
        settings: brushSettings(effect, brush),
        scale,
        k,
      });
    }
  }
}
