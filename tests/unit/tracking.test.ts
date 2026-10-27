import { describe, expect, it } from 'vitest';
import { applyPose, followMask, maskHasPerson, maskNear, type Mask } from '../../src/tracking.ts';

// A tall rectangle of "person" at its own resolution, the shape a body mask has.
function rectMask(width: number, height: number, left: number, top: number, w: number, h: number): Mask {
  const alpha = new Uint8ClampedArray(width * height);
  for (let row = top; row < top + h; row++) alpha.fill(255, row * width + left, row * width + left + w);
  return { width, height, alpha };
}

describe('tracking: follow a mask', () => {
  it('moves the root with the mask centre when the body slides', () => {
    // The mask is at half the clip's resolution, so 1 mask pixel = 2 clip pixels.
    const masks = [0, 3, 6].map((shift) => rectMask(40, 60, 10 + shift, 10, 8, 30));
    const poses = followMask(masks, [30, 40], 0, 80, 120);
    expect(poses[0]?.x).toBeCloseTo(30, 6);
    expect(poses[0]?.y).toBeCloseTo(40, 6);
    expect(poses[0]?.angle).toBeCloseTo(0, 6);
    expect(poses[1]?.x).toBeCloseTo(36, 6);
    expect(poses[2]?.x).toBeCloseTo(42, 6);
    expect(poses[2]?.y).toBeCloseTo(40, 6);
    expect(poses[2]?.scale).toBeCloseTo(1, 6);
  });

  it('scales the root offset with the mask size', () => {
    const masks = [rectMask(100, 100, 40, 20, 10, 40), rectMask(100, 100, 35, 0, 20, 80)];
    const [, grown] = followMask(masks, [50, 30], 0, 100, 100);
    // The centre stays at (45, 40) and the area grows 4x, so the root's
    // offset from the centre, (5, -10), doubles to (10, -20).
    expect(grown?.scale).toBeCloseTo(2, 6);
    expect(grown?.x).toBeCloseTo(55, 6);
    expect(grown?.y).toBeCloseTo(20, 6);
  });

  it('loses the root on frames with no mask', () => {
    const poses = followMask([rectMask(20, 20, 5, 2, 4, 12), null], [7, 8], 0, 20, 20);
    expect(poses[1]).toBeNull();
  });
});

describe('tracking: helpers', () => {
  it('applyPose turns and scales a drawn point about its root', () => {
    const [x, y] = applyPose({ x: 10, y: 10, angle: Math.PI / 2, scale: 2 }, [0, 0], 1, 0);
    expect(x).toBeCloseTo(10, 9);
    expect(y).toBeCloseTo(12, 9);
  });

  it('maskHasPerson needs a minimum share of the frame', () => {
    expect(maskHasPerson(rectMask(100, 100, 0, 0, 1, 1))).toBe(false);
    expect(maskHasPerson(rectMask(100, 100, 0, 0, 10, 10))).toBe(true);
  });

  it('maskNear borrows the nearest mask within reach', () => {
    const a = rectMask(4, 4, 0, 0, 2, 2);
    const masks = [a, null, null, null];
    expect(maskNear(masks, 2, 2)).toBe(a);
    expect(maskNear(masks, 3, 2)).toBeNull();
  });
});
