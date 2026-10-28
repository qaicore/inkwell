import { describe, expect, it } from 'vitest';
import { samShape, trackAnchor } from '../../src/track/anchor.ts';
import { samCacheFile, toFrameMask, type SamMask } from '../../src/sam/cache.ts';

// A filled w × h box with its top-left corner at (x, y), at 2 px per raster cell.
function block(x: number, y: number, w: number, h: number): SamMask {
  const width = w / 2;
  const height = h / 2;
  return { width, height, raster: new Uint8Array(width * height).fill(1), bounds: { left: x, top: y, right: x + w, bottom: y + h } };
}

describe('samShape', () => {
  it('measures in frame px through the bounds', () => {
    const s = samShape(block(100, 200, 40, 200))!;
    expect(s.x).toBeCloseTo(120);
    expect(s.y).toBeCloseTo(300);
    expect(s.size).toBeCloseTo(Math.sqrt(40 * 200));
    expect(Math.abs(s.axis)).toBeCloseTo(Math.PI / 2); // tall: the long axis is vertical
  });
});

describe('trackAnchor', () => {
  it('sits on the seed on its own frame and follows the mask', () => {
    const masks = Array.from({ length: 60 }, (_, f) => (f === 30 ? null : block(100 + 3 * f, 200, 40, 200)));
    const seed = { frame: 10, xy: [125, 250] as [number, number] };
    const { raw, smoothed } = trackAnchor(masks, seed, 30);
    expect(raw[30]).toBeNull();
    expect(Math.hypot(smoothed[10]![0] - 125, smoothed[10]![1] - 250)).toBeLessThan(1e-9);
    expect(smoothed[40]![0]).toBeCloseTo(125 + 3 * 30, 0); // steady drift: no lag after the two-way filter
  });
  it('is all null when the seed frame has no mask', () => {
    expect(trackAnchor([null, block(0, 0, 10, 10)], { frame: 0, xy: [0, 0] }, 30).smoothed).toEqual([null, null]);
  });
});

describe('the SAM cache', () => {
  it('names a cache file per concept, per point stroke, none for the ground', () => {
    expect(samCacheFile({ type: 'concept', prompt: ' Left Hand ' }, 3)).toBe('sam-left-hand.json');
    expect(samCacheFile({ type: 'point', time: 1, xy: [1, 2] }, 3)).toBe('sam-stroke-3.json');
    expect(samCacheFile({ type: 'ground', xy: [1, 2] }, 3)).toBeNull();
  });
  it('turns a boxed mask into a whole-frame one', () => {
    const m = toFrameMask(block(8, 4, 8, 8), 32, 16, 4);
    expect([m.width, m.height]).toEqual([8, 4]);
    expect([...m.alpha].map((a) => (a ? 1 : 0)).join('')).toBe('00000000' + '00110000' + '00110000' + '00000000');
  });
});
