/// <reference types="node" />
// P5 (SPEC §10, physics): determinism. Two runs give byte-identical point arrays and identical PNGs.
//
// Measured on the real pipeline: src/motion/animate.ts animate() (physics, stepped drawings, boil, placement) and
// src/render/headless.ts renderPng() on every one of the 90 frames (3 s at 30 fps, 1080 x 1920). The input is seeded
// and synthetic: a moving torso anchor per stroke, a strand (stiffness 0.3, wobble 1, front), a rope (stiffness 0,
// wobble 0.5, behind) and a rigid stroke (wobble 1, front), with DEFAULT_PHYSICS. The boil numbers here are arbitrary
// test input, not Qai's reference: P5 tests that the output repeats, not how it looks.
//   - Point arrays: every frame's held, placed and sim points and pressures are written out as Float64 bytes (so -0
//     and NaN payloads count) along with ids, layers, f and k, and the two runs' bytes must be equal.
//   - PNGs: Buffer.equals for every frame.
// Stricter readings, flagged for Qai: "two runs" means two fresh module instances (vi.resetModules), with Math.random,
// Date.now and performance.now deliberately different between them, so hidden global state, import-time seeding or
// clock reads show up here and not later as golden drift.
// Precondition: the PNGs are real renders: PNG signature, 1080 x 1920 in the header, and they change from drawing
// to drawing (a renderer that draws nothing would be trivially identical).
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Effect, Stroke } from '../../src/types/effect.ts';
import { Evidence } from '../helpers/evidence.ts';
import { f64Bytes, need, pngSize, randomMotion, recorded, rng, tendril, type V2 } from '../helpers/engine.ts';

type AnimateModule = typeof import('../../src/motion/animate.ts');
type Frame = ReturnType<AnimateModule['animate']>[number];

const ID = 'P5';
const W = 1080;
const H = 1920;
const FRAMES = 90;
const ev = new Evidence(ID, [
  'modules load',
  'precondition: PNGs are real renders that change with the drawing',
  'point arrays byte-identical across two runs',
  'PNGs identical across two runs',
]);
afterAll(() => ev.write());

function makeStroke(id: number, kind: 'strand' | 'rigid', stiffness: number, wobble: number, layer: 'front' | 'behind'): Stroke {
  const points = tendril(5000 + id);
  return {
    id,
    color: (id % 3) as 0 | 1 | 2,
    kind,
    anchor: { type: 'concept', prompt: 'person' },
    bodyAngle: 0,
    stiffness,
    wobble,
    views: { front: { points, pressure: points.map((_, i) => 0.3 + 0.7 * Math.sin((Math.PI * i) / (points.length - 1))), root: points[0]!, layer } },
  };
}

const EFFECT: Effect = {
  version: 1,
  brush: { size: 14, thinning: 0.6, smoothing: 0.5, streamline: 0.4 },
  palette: ['#1b1b1f', '#c8323c', '#f2efe6'],
  timing: { drawingsPerSecond: 12 },
  strokes: [makeStroke(1, 'strand', 0.3, 1, 'front'), makeStroke(2, 'strand', 0, 0.5, 'behind'), makeStroke(3, 'rigid', 1, 1, 'front')],
  overrides: {},
};
const BOIL = { maxPx: 2, cycle: 4 }; // arbitrary test input (not reference values)

interface RunOut {
  bytes: Buffer;
  layout: string;
  pngs: Buffer[];
}

function serialize(frames: Frame[]): { bytes: Buffer; layout: string } {
  const nums: number[] = [];
  const layout: unknown[] = [];
  for (const fr of frames) {
    nums.push(fr.f, fr.k);
    const one = (s: { id: number; points: V2[]; pressure?: number[]; layer?: string }) => {
      nums.push(s.id, s.points.length, ...s.points.flat(), ...(s.pressure ?? []));
      return [s.id, s.layer ?? null, s.points.length, s.pressure?.length ?? null];
    };
    layout.push([
      fr.f,
      fr.held.map((s) => one(s as { id: number; points: V2[]; pressure: number[]; layer: string })),
      fr.placed.map((s) => one(s as { id: number; points: V2[]; pressure: number[]; layer: string })),
      fr.sim.map((s) => one(s as { id: number; points: V2[] })),
    ]);
  }
  return { bytes: f64Bytes(nums), layout: JSON.stringify(layout) };
}

async function runOnce(seed: number): Promise<RunOut> {
  vi.resetModules();
  const random = rng(seed);
  const spies = [
    vi.spyOn(Math, 'random').mockImplementation(() => random()),
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000 + seed * 7_919_000),
    vi.spyOn(performance, 'now').mockReturnValue(seed * 104_729),
  ];
  try {
    const anim = await need('src/motion/animate.ts', { animate: 'function' }, () => import('../../src/motion/animate.ts'));
    const head = await need('src/render/headless.ts', { renderPng: 'function' }, () => import('../../src/render/headless.ts'));
    const motions = new Map(EFFECT.strokes.map((s) => [s.id, randomMotion(9000 + s.id)]));
    const frames: Frame[] = anim.animate({ effect: EFFECT, frames: FRAMES, anchor: (id: number, f: number) => motions.get(id)!(f / 30), width: W, boil: BOIL });
    const { bytes, layout } = serialize(frames);
    const pngs = frames.map((fr) => Buffer.from(head.renderPng(W, H, fr.placed, EFFECT)));
    return { bytes, layout, pngs };
  } finally {
    for (const s of spies) s.mockRestore();
  }
}

describe('P5 determinism', () => {
  it('P5 two runs give byte-identical point arrays and identical PNGs', async () => {
    await recorded(ev, 'modules load', 'src/motion/animate.ts (animate) and src/render/headless.ts (renderPng)', async () => {
      await need('src/motion/animate.ts', { animate: 'function' }, () => import('../../src/motion/animate.ts'));
      await need('src/render/headless.ts', { renderPng: 'function' }, () => import('../../src/render/headless.ts'));
    });
    const a = await runOnce(1);
    const b = await runOnce(2);

    const sizes = a.pngs.map((p) => pngSize(p));
    const badHeaders = sizes.map((s, f) => (s && s.width === W && s.height === H ? -1 : f)).filter((f) => f >= 0);
    const distinct = new Set(a.pngs.map((p) => p.toString('base64'))).size;
    const realRenders = a.pngs.length === FRAMES && badHeaders.length === 0 && distinct > 1;
    ev.record('precondition: PNGs are real renders that change with the drawing', { frames: a.pngs.length, badHeaderFrames: badHeaders.slice(0, 8), distinctPngs: distinct },
      `${FRAMES} PNGs, ${W} x ${H}, more than one distinct image`, realRenders);

    const sameLayout = a.layout === b.layout;
    const sameBytes = a.bytes.equals(b.bytes);
    let firstDiff = -1;
    if (!sameBytes) for (let i = 0; i < Math.min(a.bytes.length, b.bytes.length); i += 8) if (!a.bytes.subarray(i, i + 8).equals(b.bytes.subarray(i, i + 8))) { firstDiff = i / 8; break; }
    ev.record('point arrays byte-identical across two runs', { bytesRun1: a.bytes.length, bytesRun2: b.bytes.length, sameLayout, firstDifferingValueIndex: firstDiff },
      'identical bytes (held, placed and sim points and pressure, every frame)', sameBytes && sameLayout && a.bytes.length > 0);

    const differing = a.pngs.map((p, f) => (b.pngs[f] && p.equals(b.pngs[f]!) ? -1 : f)).filter((f) => f >= 0);
    ev.record('PNGs identical across two runs', { framesCompared: a.pngs.length, differingFrames: differing.slice(0, 12), differingCount: differing.length },
      'every frame byte-identical', differing.length === 0 && a.pngs.length === b.pngs.length);

    expect(realRenders, `P5 precondition: PNGs aren't real renders (bad headers ${JSON.stringify(badHeaders.slice(0, 8))}, ${distinct} distinct)`).toBe(true);
    expect(sameLayout, 'P5 the two runs differ in stroke ids, layers or point counts').toBe(true);
    expect(sameBytes, `P5 point arrays differ between runs (first differing value #${firstDiff})`).toBe(true);
    expect(differing, 'P5 PNGs differ between runs on these frames').toEqual([]);
  }, 180_000);
});
