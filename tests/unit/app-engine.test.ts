import { describe, expect, it } from 'vitest';
import { animateStroke, animateStrokes, type ClipMotion, type Stroke } from '../../src/app/engine.ts';
import { EXAMPLE_TIMING } from '../../src/motion/timing.ts';
import type { Pose } from '../../src/track/tracking.ts';

// A straight stroke drawn on frame 10, 300 px long, pointing right from (500, 800).
function stroke(kind: Stroke['kind']): Stroke {
  return {
    id: 1,
    color: '#e8203a',
    brush: 'ink',
    size: 30,
    frame: 10,
    pen: false,
    layer: 'front',
    kind,
    stiffness: 1,
    points: Array.from({ length: 50 }, (_, i): [number, number, number] => [500 + (300 * i) / 49, 800, 0.5]),
  };
}

function motion(poses: Pose[] | null): ClipMotion {
  return { frameCount: 30, width: 1080, height: 1920, poses: () => poses, units: null, timing: EXAMPLE_TIMING, wobble: false };
}

describe('the app on the engine', () => {
  it('animates each stroke on its own exactly as it does among the others, so the page can cache it per stroke', () => {
    const rope: Stroke = { ...stroke('strand'), id: 2, stiffness: 0, frame: 0 };
    const rigid = stroke('rigid');
    const m = { ...motion(null), wobble: true };
    const together = animateStrokes([rigid, rope], m);
    expect(animateStroke(rigid, m)).toEqual(together.map((frame) => frame[0]));
    expect(animateStroke(rope, m)).toEqual(together.map((frame) => frame[1]));
  });

  it('puts a rigid stroke where it was drawn, on the frame it was drawn on, without tracking', () => {
    const frames = animateStrokes([stroke('rigid')], motion(null));
    const drawn = frames[10][0];
    expect(drawn.points).toHaveLength(32);
    expect(drawn.points[0][0]).toBeCloseTo(500, 9);
    expect(drawn.points[31][0]).toBeCloseTo(800, 9);
    expect(drawn.points[31][1]).toBeCloseTo(800, 9);
    expect(drawn.size).toBeCloseTo(30, 9);
  });

  it('moves, turns and scales a rigid stroke with its tracked root, size included', () => {
    // From frame 20 on, the root has moved 100 px right, turned 90° and doubled.
    const poses = Array.from({ length: 30 }, (_, f): Pose => (f < 20 ? { x: 500, y: 800, angle: 0, scale: 1 } : { x: 600, y: 800, angle: Math.PI / 2, scale: 2 }));
    const frames = animateStrokes([stroke('rigid')], motion(poses));
    const tip = frames[25][0].points[31];
    expect(tip[0]).toBeCloseTo(600, 6);
    expect(tip[1]).toBeCloseTo(1400, 6); // 300 px × 2, now pointing down
    expect(frames[25][0].size).toBeCloseTo(60, 9);
  });

  it('gives every frame an empty list when nothing is drawn', () => {
    expect(animateStrokes([], motion(null))).toEqual(Array.from({ length: 30 }, () => []));
  });
});
