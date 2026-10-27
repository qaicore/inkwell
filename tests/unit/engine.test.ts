import { describe, expect, it } from 'vitest';
import type { Effect, Vec2 } from '../../src/types/effect.ts';
import { DEFAULT_PHYSICS, createChain, stepChain } from '../../src/physics/strand.ts';
import { drawingIndex, frameAt } from '../../src/motion/timing.ts';
import { boilOffsets } from '../../src/motion/boil.ts';
import { animate } from '../../src/motion/animate.ts';
import { lerpTransform, toPixels, toTorso, torsoHeights, type TorsoTransform } from '../../src/track/torso.ts';
import { resampleStroke, strokeOutline, DEFAULT_BRUSH } from '../../src/render/brush.ts';
import type { Mask } from '../../src/track/tracking.ts';

const length = (a: Vec2, b: Vec2) => Math.hypot(b[0] - a[0], b[1] - a[1]);
// A gently bending line of n points, `step` px apart, starting at `root` and heading right.
function arc(n: number, step: number, root: Vec2 = [500, 500], bendPerJoint = 0.05): Vec2[] {
  const pts: Vec2[] = [root];
  let heading = 0;
  for (let i = 1; i < n; i++) {
    pts.push([pts[i - 1][0] + step * Math.cos(heading), pts[i - 1][1] + step * Math.sin(heading)]);
    heading += bendPerJoint;
  }
  return pts;
}

describe('physics: the strand chain', () => {
  it('pins the root and keeps every segment at its rest length while the root jumps', () => {
    // Stiffness 0: the shape pull, which runs after the constraints, is off.
    const target = arc(32, 10);
    const chain = createChain(target, 'strand', 0);
    for (let s = 0; s < 240; s++) {
      const shift = s % 60 === 30 ? 40 : 0; // a jump of 4 segment lengths now and then
      const moved = target.map((p): Vec2 => [p[0] + s * 3 + shift, p[1]]);
      stepChain(chain, moved, 420);
      expect(length(chain.points[0], moved[0])).toBe(0);
      for (let i = 0; i < 31; i++) expect(Math.abs(length(chain.points[i], chain.points[i + 1]) - 10)).toBeLessThan(1e-9);
    }
  });

  it('lets a stiffness-0 rope fall under gravity until it hangs below its root, and stop there', () => {
    // Drawn pointing right; a rope is free at the root, so it ends up hanging
    // straight down, 310 px long.
    const target = arc(32, 10);
    const chain = createChain(target, 'strand', 0);
    for (let s = 0; s < 120 * 12; s++) stepChain(chain, target, 420, { ...DEFAULT_PHYSICS, gravity: 10 });
    const tip = chain.points[31];
    expect(tip[1]).toBeGreaterThan(target[0][1] + 300);
    expect(Math.abs(tip[0] - target[0][0])).toBeLessThan(10);
    const before: Vec2 = [tip[0], tip[1]];
    stepChain(chain, target, 420, { ...DEFAULT_PHYSICS, gravity: 10 });
    expect(length(before, chain.points[31])).toBeLessThan(1e-3);
  });

  it('keeps a stiff stroke within the bend limit of its drawn angle at the root while the body runs into it', () => {
    // Drawn pointing right; the root runs right at a segment length per step,
    // which buckled the stroke into a loop before the root joint was limited.
    const target = arc(32, 10);
    const chain = createChain(target, 'strand', 0.3);
    const limit = (DEFAULT_PHYSICS.bendLimitDeg! * Math.PI) / 180;
    for (let s = 0; s < 120; s++) {
      const moved = target.map((p): Vec2 => [p[0] + 10 * s, p[1]]);
      stepChain(chain, moved, 420);
      const first = Math.atan2(chain.points[1][1] - chain.points[0][1], chain.points[1][0] - chain.points[0][0]);
      expect(Math.abs(first)).toBeLessThanOrEqual(limit + 1e-9);
    }
  });

  it('holds the drawn shape at rest without gravity, bends and all', () => {
    const target = arc(32, 10, [500, 500], 0.4); // 23° per joint, tighter than a straight line
    const chain = createChain(target, 'strand', 1);
    for (let s = 0; s < 240; s++) stepChain(chain, target, 420, { ...DEFAULT_PHYSICS, gravity: 0 });
    for (let i = 0; i < 32; i++) expect(length(chain.points[i], target[i])).toBeLessThan(1e-6);
  });

  it('bends no joint more than the limit away from the target\'s own bend', () => {
    const target = arc(32, 10);
    const chain = createChain(target, 'strand', 0);
    const limit = (DEFAULT_PHYSICS.bendLimitDeg! * Math.PI) / 180;
    const heading = (a: Vec2, b: Vec2) => Math.atan2(b[1] - a[1], b[0] - a[0]);
    const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
    for (let s = 0; s < 360; s++) {
      const moved = target.map((p): Vec2 => [p[0] + 200 * Math.sin(s / 6), p[1] + 120 * Math.cos(s / 4)]);
      stepChain(chain, moved, 420);
      for (let i = 1; i < 31; i++) {
        const bend = wrap(heading(chain.points[i], chain.points[i + 1]) - heading(chain.points[i - 1], chain.points[i]));
        const wanted = wrap(heading(moved[i], moved[i + 1]) - heading(moved[i - 1], moved[i]));
        expect(Math.abs(wrap(bend - wanted))).toBeLessThan(limit + 1e-9);
      }
    }
  });

  it('puts a rigid stroke exactly on its target', () => {
    const chain = createChain(arc(8, 10), 'rigid', 1);
    const moved = arc(8, 12, [100, 50], 0.2);
    stepChain(chain, moved, 420);
    expect(chain.points).toEqual(moved);
  });
});

describe('motion: the drawing clock and boil', () => {
  it('steps on 2s and 3s at 12 dps and on 3s and 4s at 8 dps', () => {
    const changes = (dps: number) => Array.from({ length: 31 }, (_, f) => f).filter((f) => f === 0 || drawingIndex(f, dps) !== drawingIndex(f - 1, dps));
    expect(changes(12)).toEqual([0, 3, 5, 8, 10, 13, 15, 18, 20, 23, 25, 28, 30]);
    expect(changes(8)).toEqual([0, 4, 8, 12, 15, 19, 23, 27, 30]);
    expect(frameAt(1.0333333)).toBe(31);
    expect(() => drawingIndex(1.5, 12)).toThrow();
  });

  it('boils smoothly, at most maxPx, repeating every cycle and scaled to the frame width', () => {
    const boil = { maxPx: 1.5, cycle: 3 };
    const a = boilOffsets(4, 7, 32, boil, 1);
    expect(a).toEqual(boilOffsets(7, 7, 32, boil, 1));
    expect(a).not.toEqual(boilOffsets(5, 7, 32, boil, 1));
    expect(a).not.toEqual(boilOffsets(4, 8, 32, boil, 1));
    for (const [x, y] of a) expect(Math.hypot(x, y)).toBeLessThanOrEqual(1.5 + 1e-12);
    // Smooth along the stroke (2 to 3 waves): neighbors never jump by more than 2/3 of the amplitude.
    for (let i = 1; i < 32; i++) expect(length(a[i], a[i - 1])).toBeLessThan(1.5 * 0.67);
    const wide = boilOffsets(4, 7, 32, boil, 1, 2160);
    expect(wide[5][0]).toBeCloseTo(a[5][0] * 2, 12);
    expect(boilOffsets(4, 7, 32, boil, 0).every(([x, y]) => x === 0 && y === 0)).toBe(true);
  });
});

describe('torso space', () => {
  const t: TorsoTransform = { x: 300, y: 400, angle: 0.4, unit: 250 };

  it('maps torso units to pixels and back', () => {
    expect(toPixels({ x: 10, y: 20, angle: 0, unit: 100 }, [1, 0.5])).toEqual([110, 70]);
    const p: Vec2 = [0.3, -1.2];
    const back = toTorso(t, toPixels(t, p));
    expect(back[0]).toBeCloseTo(p[0], 12);
    expect(back[1]).toBeCloseTo(p[1], 12);
  });

  it('interpolates transforms the short way round', () => {
    const a = { x: 0, y: 0, angle: 3.1, unit: 100 };
    const b = { x: 10, y: 0, angle: -3.1, unit: 400 };
    const mid = lerpTransform(a, b, 0.5);
    expect(mid.x).toBe(5);
    expect(Math.abs(Math.cos(mid.angle) + 1)).toBeLessThan(1e-3); // through π, not through 0
    expect(mid.unit).toBeCloseTo(200, 9);
  });

  it('sets the torso height to 0.35 of the median body height, growing with √area', () => {
    const rect = (h: number, w: number): Mask => {
      const alpha = new Uint8ClampedArray(100 * 100);
      for (let row = 0; row < h; row++) alpha.fill(255, row * 100, row * 100 + w);
      return { width: 100, height: 100, alpha };
    };
    const heights = torsoHeights([rect(40, 10), rect(40, 10), rect(80, 20), null], 200, 200);
    expect(heights[0]).toBeCloseTo(0.35 * 80, 9); // median box height 40 mask px = 80 clip px
    expect(heights[2]).toBeCloseTo(0.35 * 80 * 2, 9); // 4x the area, 2x the height
    expect(heights[3]).toBeNull();
  });
});

describe('brush: stored strokes and outlines', () => {
  it('resamples by arc length, pressure included', () => {
    const { points, pressure } = resampleStroke([[0, 0, 0], [10, 0, 1], [10, 30, 1]], 5);
    expect(points).toEqual([[0, 0], [10, 0], [10, 10], [10, 20], [10, 30]]);
    expect(pressure).toEqual([0, 1, 1, 1, 1]);
  });

  it('gives nearly the same outline for a curve however many points describe it', () => {
    const raw = Array.from({ length: 400 }, (_, i): [number, number, number] => {
      const t = i / 399;
      return [200 + 300 * t, 500 - 200 * Math.sin(Math.PI * t), 0.4 + 0.4 * t];
    });
    const stored = resampleStroke(raw, 32);
    const a = strokeOutline(stored.points, stored.pressure, DEFAULT_BRUSH);
    const b = strokeOutline(raw.map((p): Vec2 => [p[0], p[1]]), raw.map((p) => p[2]), DEFAULT_BRUSH);
    // Mean distance from each outline's vertices to the other outline's edges, both ways.
    const toEdges = (p: Vec2, poly: Vec2[]) => {
      let best = Infinity;
      for (let i = 0; i < poly.length; i++) {
        const q = poly[i];
        const r = poly[(i + 1) % poly.length];
        const dx = r[0] - q[0];
        const dy = r[1] - q[1];
        const u = Math.max(0, Math.min(1, ((p[0] - q[0]) * dx + (p[1] - q[1]) * dy) / (dx * dx + dy * dy || 1)));
        best = Math.min(best, Math.hypot(p[0] - q[0] - u * dx, p[1] - q[1] - u * dy));
      }
      return best;
    };
    const mean = (from: Vec2[], to: Vec2[]) => from.reduce((sum, p) => sum + toEdges(p, to), 0) / from.length;
    expect(Math.max(mean(a, b), mean(b, a))).toBeLessThan(0.25);
  });
});

describe('animate: held drawings and placement', () => {
  const effect: Effect = {
    version: 1,
    brush: DEFAULT_BRUSH,
    palette: ['#e8203a', '#f4f1ea', '#16141a'],
    timing: { drawingsPerSecond: 12 },
    strokes: [
      {
        id: 1,
        color: 0,
        kind: 'strand',
        anchor: { type: 'point', time: 0, xy: [540, 900] },
        bodyAngle: 0,
        stiffness: 0.3,
        wobble: 1,
        views: { front: { points: arc(32, 0.03, [0, 0]), pressure: new Array(32).fill(0.5), root: [0, 0], layer: 'front' } },
      },
    ],
    overrides: {},
  };
  const anchor = (_id: number, f: number): TorsoTransform => ({ x: 400 + f * 6, y: 900, angle: 0.01 * f, unit: 420 });
  const frames = animate({ effect, frames: 30, anchor, width: 1080, boil: { maxPx: 1.5, cycle: 3 } });

  it('holds each drawing between drawing changes and places it with each frame\'s transform', () => {
    for (const fr of frames.slice(1)) {
      const prev = frames[fr.f - 1];
      if (fr.k === prev.k) expect(fr.held).toBe(prev.held);
      else expect(fr.held).not.toEqual(prev.held);
      const placed = fr.held[0].points.map((p) => toPixels(anchor(1, fr.f), p));
      expect(fr.placed[0].points).toEqual(placed);
    }
    expect(new Set(frames.map((fr) => fr.k)).size).toBe(12);
  });

  it('pins the simulated root to the anchor, and runs the same way twice', () => {
    for (const fr of frames) expect(length(fr.sim[0].points[0], toPixels(anchor(1, fr.f), [0, 0]))).toBeLessThan(1e-9);
    const again = animate({ effect, frames: 30, anchor, width: 1080, boil: { maxPx: 1.5, cycle: 3 } });
    expect(again).toEqual(frames);
  });
});
