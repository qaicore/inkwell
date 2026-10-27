import { describe, expect, it } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { Effect, Stroke, Vec2 } from '../../src/types/effect.ts';
import type { AnimatedFrame, PlacedStroke } from '../../src/motion/animate.ts';
import { DEFAULT_BRUSH } from '../../src/render/brush.ts';
import { contactSheet } from '../../src/render/sheet.ts';

const RED = '#e8203a';
const BLACK = '#16141a';

function stroke(id: number, color: 0 | 2, layer: 'front' | 'behind'): Stroke {
  return {
    id,
    color,
    kind: 'strand',
    anchor: { type: 'point', time: 0, xy: [0, 0] },
    bodyAngle: 0,
    stiffness: 0.5,
    wobble: 0,
    views: { front: { points: [], pressure: [], root: [0, 0], layer } },
  };
}

// A horizontal stroke across the frame at height y, px.
function across(id: number, y: number, layer: 'front' | 'behind'): PlacedStroke {
  const points = Array.from({ length: 32 }, (_, i): Vec2 => [140 + (800 * i) / 31, y]);
  return { id, points, pressure: points.map(() => 0.8), layer };
}

async function pixel(png: Buffer, x: number, y: number) {
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  return [...ctx.getImageData(x, y, 1, 1).data.slice(0, 3)];
}

describe('contact sheet', () => {
  it('draws Behind strokes under the figure and Front strokes over it', async () => {
    const effect: Effect = {
      version: 1,
      brush: DEFAULT_BRUSH,
      palette: [RED, '#f4f1ea', BLACK],
      timing: { drawingsPerSecond: 12 },
      strokes: [stroke(1, 0, 'behind'), stroke(2, 2, 'front')],
      overrides: {},
    };
    // The figure's torso is centred on (540, 858) and spans y 606 to 1110.
    const frame: AnimatedFrame = { f: 0, k: 0, held: [], sim: [], placed: [across(1, 858, 'behind'), across(2, 950, 'front')] };
    const png = contactSheet({
      frames: [frame],
      effect,
      body: () => ({ x: 540, y: 900, angle: 0, unit: 420 }),
      crop: { x: 140, y: 600, size: 800 }, // 1:1
      cell: 800,
      columns: 1,
      scale: 3,
      banner: ['test'], // 30 px tall
      info: () => ({ theta: 0, facing: 'front', weights: 'front 1.00', preset: 'none', fallback: false }),
    });
    expect(await pixel(png, 400, 30 + 258)).toEqual([0xc9, 0xc9, 0xcf]); // the figure, over the behind stroke
    expect(await pixel(png, 400, 30 + 350)).toEqual([0x16, 0x14, 0x1a]); // the front stroke, over the figure
    expect(await pixel(png, 110, 30 + 258)).toEqual([0xe8, 0x20, 0x3a]); // the behind stroke, clear of the figure
  });
});
