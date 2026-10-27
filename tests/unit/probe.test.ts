import { describe, expect, it } from 'vitest';
import { crc32, inflateSync } from 'node:zlib';
import { checkFacing, facingPrompt, spreadFrames } from '../../scripts/probe/facing.ts';
import { fitSize } from '../../scripts/probe/ffmpeg.ts';
import { drawNumber, tile, tintMask } from '../../scripts/probe/image.ts';
import { maskHas, maskStats, type FrameMask } from '../../scripts/probe/masks.ts';
import { createImage, encodePng } from '../../scripts/probe/png.ts';
import { bodyHeights, chooseBackPoint, jumpStats, percentile, runs, timelineBar } from '../../scripts/probe/report.ts';

// A filled rectangle of raster pixels; `bounds` maps the raster onto the frame.
function rectMask(width: number, height: number, bounds: FrameMask['bounds'], fill: { left: number; top: number; w: number; h: number }): FrameMask {
  const raster = new Uint8Array(width * height);
  for (let r = fill.top; r < fill.top + fill.h; r++) raster.fill(1, r * width + fill.left, r * width + fill.left + fill.w);
  return { objectId: '0', width, height, raster, bounds };
}

// A person-shaped stand-in: full raster over a box `h` tall at (left, top).
function body(left: number, top: number, w: number, h: number): FrameMask {
  return rectMask(w, h, { left, top, right: left + w, bottom: top + h }, { left: 0, top: 0, w, h });
}

describe('probe png', () => {
  it('writes a valid RGB PNG whose pixels round-trip', () => {
    const img = createImage(3, 2, [10, 20, 30]);
    img.data.set([255, 0, 0], 3 * 4); // pixel (1, 1)
    const png = encodePng(img);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.toString('ascii', 12, 16)).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(3);
    expect(png.readUInt32BE(20)).toBe(2);
    expect(png.readUInt32BE(29)).toBe(crc32(png.subarray(12, 29)));
    const idatLength = png.readUInt32BE(33);
    expect(png.toString('ascii', 37, 41)).toBe('IDAT');
    const raw = inflateSync(png.subarray(41, 41 + idatLength));
    expect(raw.length).toBe(2 * (1 + 9));
    expect([...raw.subarray(10, 20)]).toEqual([0, 10, 20, 30, 255, 0, 0, 10, 20, 30]);
  });

  it('rejects a buffer of the wrong size', () => {
    expect(() => encodePng({ width: 2, height: 2, data: new Uint8Array(5) })).toThrow();
  });
});

describe('probe masks', () => {
  it('measures a raster that is coarser than the frame', () => {
    // A 10x10 raster over a 40x20 box at (100, 50): each raster pixel is 4x2 source pixels.
    const mask = rectMask(10, 10, { left: 100, top: 50, right: 140, bottom: 70 }, { left: 2, top: 4, w: 3, h: 5 });
    const stats = maskStats(mask)!;
    expect(stats.area).toBe(15 * 8);
    expect(stats.cx).toBeCloseTo(100 + 3.5 * 4, 9);
    expect(stats.cy).toBeCloseTo(50 + 6.5 * 2, 9);
    expect(stats.box).toEqual({ left: 108, top: 58, right: 120, bottom: 68 });
    expect(maskHas(mask, 109, 59)).toBe(true);
    expect(maskHas(mask, 107.9, 59)).toBe(false);
    expect(maskHas(mask, 99, 59)).toBe(false);
  });

  it('gives no stats for an empty mask', () => {
    expect(maskStats(rectMask(4, 4, { left: 0, top: 0, right: 4, bottom: 4 }, { left: 0, top: 0, w: 0, h: 0 }))).toBeNull();
  });
});

describe('probe report math', () => {
  it('percentile interpolates between closest ranks', () => {
    expect(percentile([3, 1, 2], 0.5)).toBe(2);
    expect(percentile([0, 10], 0.95)).toBeCloseTo(9.5, 9);
    expect(percentile([], 0.5)).toBeNull();
  });

  it('jumpStats reports centroid steps as % of body height and skips gaps', () => {
    const person = [body(0, 0, 10, 100), body(2, 0, 10, 100), null, body(2, 0, 10, 100), body(6, 0, 10, 100)];
    const heights = bodyHeights(person);
    expect(heights).toEqual([100, 100, null, 100, 100]);
    const stats = jumpStats(person, heights);
    expect(stats.framesWithMask).toBe(4);
    expect(stats.pairs).toBe(2); // (0,1) and (3,4); frame 2 breaks the chain
    expect(stats.median).toBeCloseTo(3, 9); // steps of 2 and 4 px on a 100 px body
    expect(stats.longestGap).toBe(1);
  });

  it('runs and timelineBar summarise face presence', () => {
    const present = [true, true, false, false, false, true];
    expect(runs(present)).toEqual([
      { start: 0, end: 1, present: true },
      { start: 2, end: 4, present: false },
      { start: 5, end: 5, present: true },
    ]);
    expect(timelineBar(present, 2)).toBe('#.#');
  });

  it('chooseBackPoint lands mid-back in the longest no-face stretch', () => {
    const person = Array.from({ length: 9 }, () => body(100, 200, 50, 400));
    const face = [true, true, false, false, false, false, false, true, true];
    const point = chooseBackPoint(person, face)!;
    expect(point.frame).toBe(4);
    expect(point.y).toBe(200 + 140);
    expect(point.x).toBe(125);
    expect(maskHas(person[4]!, point.x, point.y)).toBe(true);
  });

  it('chooseBackPoint centres on the widest run, not an arm', () => {
    // Torso 40 px wide at x 100..140, an arm 10 px wide at x 170..180, same row.
    const mask = rectMask(100, 100, { left: 100, top: 0, right: 200, bottom: 100 }, { left: 0, top: 0, w: 40, h: 100 });
    for (let r = 0; r < 100; r++) mask.raster.fill(1, r * 100 + 70, r * 100 + 80);
    const point = chooseBackPoint([mask], [false])!;
    expect(point.x).toBe(120);
  });

  it('chooseBackPoint falls back to the middle frame when the face never leaves', () => {
    const person = [body(0, 0, 10, 10), body(0, 0, 10, 10), body(0, 0, 10, 10)];
    const point = chooseBackPoint(person, [true, true, true])!;
    expect(point.frame).toBe(1);
    expect(point.how).toMatch(/never left/);
  });
});

describe('probe images', () => {
  it('tints only the pixels the mask covers, at thumbnail scale', () => {
    const thumb = createImage(4, 4, [0, 0, 0]);
    // Source frame 8x8; the mask covers source x 0..4, y 0..8.
    tintMask(thumb, rectMask(4, 8, { left: 0, top: 0, right: 4, bottom: 8 }, { left: 0, top: 0, w: 4, h: 8 }), 8, 8, [200, 100, 0], 0.5);
    expect([...thumb.data.subarray(0, 3)]).toEqual([100, 50, 0]); // (0, 0)
    expect([...thumb.data.subarray(3 * 2, 3 * 2 + 3)]).toEqual([0, 0, 0]); // (2, 0)
  });

  it('drawNumber writes ink inside its box, and tile lays cells out', () => {
    const img = createImage(40, 20, [9, 9, 9]);
    const width = drawNumber(img, 10, 0, 0, 2);
    expect(width).toBe(2 * 4 * 2 - 2 + 4);
    expect([...img.data.subarray(0, 3)]).toEqual([0, 0, 0]); // the box's padding
    expect([...img.data.subarray((2 * 40 + 4) * 3, (2 * 40 + 4) * 3 + 3)]).toEqual([255, 255, 255]); // the 1's top
    const strip = tile([createImage(2, 2, [1, 1, 1]), createImage(2, 2, [2, 2, 2]), createImage(2, 2, [3, 3, 3])], 2, 1);
    expect([strip.width, strip.height]).toEqual([7, 7]);
    expect(strip.data[(4 * 7 + 1) * 3]).toBe(3);
  });

  it('fitSize keeps the aspect ratio with even sides', () => {
    expect(fitSize(1080, 1920, 768)).toEqual([432, 768]);
    expect(fitSize(1920, 1080, 320)).toEqual([320, 180]);
  });
});

describe('probe facing', () => {
  it('states the SPEC classes and lists the frames', () => {
    const prompt = facingPrompt([0, 42]);
    expect(prompt).toContain('| right | within 45° of 90° (his right side toward the camera) |');
    expect(prompt).toContain('0, 42');
  });

  it('accepts one valid entry per frame, in frame order', () => {
    const text = JSON.stringify({ frames: [{ frame: 42, facing: 'back', confidence: 0.7 }, { frame: 0, facing: 'front', confidence: 1 }] });
    const check = checkFacing(text, [0, 42]);
    expect(check).toEqual({ ok: true, labels: [{ frame: 0, facing: 'front', confidence: 1 }, { frame: 42, facing: 'back', confidence: 0.7 }] });
  });

  it('rejects missing, extra, repeated or out-of-range entries', () => {
    const bad = (frames: unknown[]) => checkFacing(JSON.stringify({ frames }), [0, 42]);
    expect(bad([{ frame: 0, facing: 'front', confidence: 1 }]).ok).toBe(false);
    expect(bad([{ frame: 0, facing: 'front', confidence: 1 }, { frame: 7, facing: 'back', confidence: 1 }]).ok).toBe(false);
    expect(bad([{ frame: 0, facing: 'up', confidence: 1 }, { frame: 42, facing: 'back', confidence: 1 }]).ok).toBe(false);
    expect(bad([{ frame: 0, facing: 'front', confidence: 1.5 }, { frame: 42, facing: 'back', confidence: 1 }]).ok).toBe(false);
    expect(checkFacing('not json', [0]).ok).toBe(false);
  });

  it('spreads frames from first to last', () => {
    expect(spreadFrames(300, 8)).toEqual([0, 43, 85, 128, 171, 214, 256, 299]);
    expect(spreadFrames(5, 8)).toEqual([0, 1, 2, 3, 4]);
  });
});
