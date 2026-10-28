/// <reference types="node" />
// B1 (SPEC §10, brushes): determinism. Each of the six brushes, same effect and drawing index k: byte-identical
// pixels across two renders; identical between drawing changes (A1).
//
// Brush ids are read from docs/SPEC.md §7 (`type BrushId = ...`) at runtime, not from the implementation.
// Measured on the real pipeline: src/motion/animate.ts animate() (physics, stepped drawings, boil) for 1 s of a seeded
// moving anchor, then src/render/headless.ts renderPng(width, height, strokes, effect, scale, k) on every frame, for
// each brush (both strokes of the effect set to it via Stroke.brush, §7). Each frame's held drawing (torso space) is
// placed with one fixed transform, so any difference between frames of the same drawing comes from the renderer.
//   - Two runs: fresh module instances (vi.resetModules) with Math.random, Date.now and performance.now different
//     between them; every frame's PNG must be byte-identical across the runs.
//   - Within a run: frames holding the same drawing (same k = floor(f·dps/30)) give byte-identical PNGs.
// Preconditions (so identical output can't come from drawing nothing or ignoring the brush): every PNG is a real
// render of the right size; consecutive drawings render differently for every brush (boil on, wobble 1); the six
// brushes give six different images.
// Stricter reading, flagged for Qai: §7 says strokes without `brush` render as 'ink' exactly as before, so an effect
// with no brush fields must render byte-identically to the same effect with brush 'ink' on every stroke.
// The boil numbers are arbitrary test input, not Qai's reference.
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { BrushId, Effect, Stroke } from '../../src/types/effect.ts';
import { Evidence, ROOT, readText } from '../helpers/evidence.ts';
import { need, pngSize, randomMotion, recorded, rng, tendril, torsoToPx, type V2 } from '../helpers/engine.ts';
import { join } from 'node:path';

type AnimateModule = typeof import('../../src/motion/animate.ts');
type HeadlessModule = typeof import('../../src/render/headless.ts');
type Placed = Parameters<HeadlessModule['renderPng']>[2][number];

const ID = 'B1';
const W = 1080;
const H = 1080;
const FPS = 30;
const FRAMES = 30; // 1 s: 12 drawings at 12 dps
const BOIL = { maxPx: 2, cycle: 4 }; // arbitrary test input
const FIXED = { x: 540, y: 520, angle: 0, unit: 420 };

function specBrushIds(): string[] {
  const spec = readText(join(ROOT, 'docs', 'SPEC.md'));
  const m = spec.match(/type\s+BrushId\s*=\s*([^;]+);/);
  if (!m) throw new Error('docs/SPEC.md §7 has no "type BrushId = ..." line');
  const ids = [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
  if (ids.length === 0) throw new Error('docs/SPEC.md §7 BrushId lists no ids');
  return ids;
}
const BRUSHES = specBrushIds();

const ev = new Evidence(ID, [
  'modules load',
  'precondition: real renders',
  'precondition: consecutive drawings differ, per brush',
  'precondition: the six brushes look different',
  ...BRUSHES.map((b) => `${b}: byte-identical across two renders`),
  ...BRUSHES.map((b) => `${b}: identical between drawing changes`),
  'no brush field renders exactly as ink',
]);
afterAll(() => ev.write());

function makeStroke(id: number, kind: 'strand' | 'rigid', stiffness: number, brush: string | undefined): Stroke {
  const points = tendril(6100 + id);
  const s: Stroke = {
    id,
    color: (id % 3) as 0 | 1 | 2,
    kind,
    anchor: { type: 'concept', prompt: 'person' },
    bodyAngle: 0,
    stiffness,
    wobble: 1,
    views: { front: { points, pressure: points.map((_, i) => 0.3 + 0.7 * Math.sin((Math.PI * i) / (points.length - 1))), root: points[0]!, layer: 'front' } },
  };
  if (brush !== undefined) s.brush = brush as BrushId;
  return s;
}

function effectFor(brush: string | undefined): Effect {
  return {
    version: 1,
    brush: { size: 28, thinning: 0.65, smoothing: 0.6, streamline: 0.45 },
    palette: ['#1b1b1f', '#c8323c', '#3fd0ff'],
    timing: { drawingsPerSecond: 12 },
    strokes: [makeStroke(1, 'strand', 0.3, brush), makeStroke(2, 'rigid', 1, brush)],
    overrides: {},
  };
}

const kOf = (f: number, dps: number) => Math.floor((f * dps) / FPS);

async function runOnce(seed: number): Promise<Map<string, Buffer[]>> {
  vi.resetModules();
  const random = rng(seed);
  const spies = [
    vi.spyOn(Math, 'random').mockImplementation(() => random()),
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000 + seed * 7_919_000),
    vi.spyOn(performance, 'now').mockReturnValue(seed * 104_729),
  ];
  try {
    const anim: AnimateModule = await need('src/motion/animate.ts', { animate: 'function' }, () => import('../../src/motion/animate.ts'));
    const head: HeadlessModule = await need('src/render/headless.ts', { renderPng: 'function' }, () => import('../../src/render/headless.ts'));
    const out = new Map<string, Buffer[]>();
    for (const b of [...BRUSHES, '(none)']) {
      const effect = effectFor(b === '(none)' ? undefined : b);
      const motions = new Map(effect.strokes.map((s) => [s.id, randomMotion(9100 + s.id)]));
      const frames = anim.animate({ effect, frames: FRAMES, anchor: (id: number, f: number) => motions.get(id)!(f / FPS), width: W, boil: BOIL });
      out.set(b, frames.map((fr) => {
        const placed: Placed[] = fr.held.map((s) => ({ ...s, points: s.points.map((p) => torsoToPx(FIXED, p as V2)) }));
        return Buffer.from(head.renderPng(W, H, placed, effect, 1, fr.k));
      }));
    }
    return out;
  } finally {
    for (const s of spies) s.mockRestore();
  }
}

describe('B1 brush determinism', () => {
  it('B1 each brush renders byte-identically across two runs and within a drawing', async () => {
    await recorded(ev, 'modules load', 'src/motion/animate.ts (animate), src/render/headless.ts (renderPng)', async () => {
      await need('src/motion/animate.ts', { animate: 'function' }, () => import('../../src/motion/animate.ts'));
      await need('src/render/headless.ts', { renderPng: 'function' }, () => import('../../src/render/headless.ts'));
    });
    const a = await runOnce(1);
    const b = await runOnce(2);
    const dps = 12;

    const badSize: string[] = [];
    for (const [brush, pngs] of a) pngs.forEach((p, f) => {
      const s = pngSize(p);
      if (!s || s.width !== W || s.height !== H) badSize.push(`${brush} f${f}`);
    });
    ev.record('precondition: real renders', badSize.length ? badSize.slice(0, 8) : `${a.size * FRAMES} PNGs`, `PNG, ${W} x ${H}`, badSize.length === 0);

    const flat: string[] = [];
    for (const brush of BRUSHES) {
      const pngs = a.get(brush)!;
      let changes = 0;
      let boundaries = 0;
      for (let f = 1; f < FRAMES; f++) if (kOf(f, dps) !== kOf(f - 1, dps)) {
        boundaries++;
        if (!pngs[f]!.equals(pngs[f - 1]!)) changes++;
      }
      if (changes < boundaries) flat.push(`${brush}: ${changes}/${boundaries} drawing changes show`);
    }
    ev.record('precondition: consecutive drawings differ, per brush', flat.length ? flat : 'every drawing change shows', 'each new drawing renders differently (boil on)', flat.length === 0);

    const first = BRUSHES.map((br) => a.get(br)![0]!.toString('base64'));
    const distinct = new Set(first).size;
    ev.record('precondition: the six brushes look different', `${distinct} distinct images of ${BRUSHES.length}`, `${BRUSHES.length} distinct`, distinct === BRUSHES.length);

    const failures: string[] = [];
    for (const brush of BRUSHES) {
      const pa = a.get(brush)!;
      const pb = b.get(brush)!;
      const differ = pa.map((p, f) => (pb[f] && p.equals(pb[f]!) ? -1 : f)).filter((f) => f >= 0);
      ev.record(`${brush}: byte-identical across two renders`, { frames: pa.length, differingFrames: differ.slice(0, 10) }, 'every frame byte-identical', differ.length === 0 && pa.length === pb.length);
      if (differ.length) failures.push(`${brush} differs between runs on frames ${differ.slice(0, 6).join(', ')}`);
      const inside: number[] = [];
      for (let f = 1; f < FRAMES; f++) if (kOf(f, dps) === kOf(f - 1, dps) && !pa[f]!.equals(pa[f - 1]!)) inside.push(f);
      ev.record(`${brush}: identical between drawing changes`, { framesChangedWithinADrawing: inside.slice(0, 10) }, 'identical within each drawing', inside.length === 0);
      if (inside.length) failures.push(`${brush} changes within a drawing on frames ${inside.slice(0, 6).join(', ')}`);
    }

    const none = a.get('(none)')!;
    const ink = a.get('ink');
    const legacyDiff = ink ? none.map((p, f) => (p.equals(ink[f]!) ? -1 : f)).filter((f) => f >= 0) : ['no ink brush in SPEC'];
    ev.record('no brush field renders exactly as ink', { differingFrames: legacyDiff.slice(0, 10) }, "byte-identical to brush 'ink' (§7: missing = 'ink')", legacyDiff.length === 0);

    expect(badSize, 'B1 precondition: not real renders').toEqual([]);
    expect(flat, 'B1 precondition: drawings that render the same as the one before').toEqual([]);
    expect(distinct, 'B1 precondition: brushes rendering identically').toBe(BRUSHES.length);
    expect(failures, 'B1 determinism').toEqual([]);
    expect(legacyDiff, 'B1 effect without brush fields vs ink').toEqual([]);
  }, 300_000);
});
