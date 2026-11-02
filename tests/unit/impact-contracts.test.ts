import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fnv1a32, int, mulberry32, normal, pick, rng, uniform } from '../../src/impact/rng.ts';
import { GROUP_HOLD, c1, decayAlpha, drawingStart, freezeMap, jEnd, k24, kr, limbDrawingAt, massGroup, phaseAt, posterHolds, zoomAt } from '../../src/impact/clock.ts';
import { DISCHARGE, contrast, deltaE, deltaE2000, fromOklch, hueDelta, isSaturatedRed, luminance, mixHex, roles, toOklch } from '../../src/impact/palette.ts';
import { DEFAULT_FLOOR, floorCircle, floorFrame, mirrorIntoFrame, sigmaOf, strikeAt, strikeFrame } from '../../src/impact/floor.ts';
import { nullSink, recordingSink, syntheticTube } from '../../src/impact/contracts.ts';
import { drawingIndex } from '../../src/motion/timing.ts';
import { assertOutsideRepo, parseArgs } from '../../scripts/lib/out-dir.ts';
import { LIMB, LIMB_BRUSH, LIMB_GLOW, brushSettings, endsOf } from '../../src/render/brushes.ts';
import { renderPng } from '../../src/render/headless.ts';
import { limbTones } from '../../src/render/limb.ts';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { PlacedStroke } from '../../src/motion/animate.ts';
import { BRUSH_IDS, parseEffect, serializeEffect, type Effect, type Vec2 } from '../../src/types/effect.ts';
import { HERO, HERO_CRACKS, MESSY_KINDS, asGroundStrokes, messyDrawing, messyDrawings } from './helpers/impact-drawings.ts';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const I = 84; // the hero's contact frame
const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const runs = (values: number[]) => values.reduce<number[]>((out, v, i) => (i > 0 && v === values[i - 1] ? (out[out.length - 1]++, out) : [...out, 1]), []);

describe('rng', () => {
  it('gives the same sequence for the same arguments', () => {
    const a = rng(84, 'fire', 3);
    const b = rng(84, 'fire', 3);
    const xs = Array.from({ length: 100 }, a);
    expect(Array.from({ length: 100 }, b)).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it('gives different sequences for different seeds, streams and ints', () => {
    const first = (r: () => number) => Array.from({ length: 8 }, r).join();
    const base = first(rng(84, 'fire', 3));
    for (const other of [rng(85, 'fire', 3), rng(84, 'dust', 3), rng(84, 'fire', 4), rng(84, 'fire', 3, 0), rng(84, 'fire', -3)]) expect(first(other)).not.toBe(base);
    expect(fnv1a32('ab', 'c')).not.toBe(fnv1a32('a', 'bc'));
    expect(fnv1a32(1)).not.toBe(fnv1a32('1'));
    expect(fnv1a32(0.5)).not.toBe(fnv1a32(0.7));
  });

  it('is pinned: the hash and the generator never drift', () => {
    expect(fnv1a32()).toBe(0x811c9dc5); // FNV-1a's offset basis
    expect(rng(84, 'fire', 0)()).toBe(0.06758157163858414);
    expect(mulberry32(0)()).toBe(mulberry32(0)());
  });

  it('averages 0.5 over 10k uniforms', () => {
    const r = rng(7, 'spark', 0);
    let sum = 0;
    for (let i = 0; i < 10_000; i++) sum += r();
    expect(Math.abs(sum / 10_000 - 0.5)).toBeLessThan(0.01);
  });

  it('has uniform, int, normal and pick helpers', () => {
    const r = rng(1, 'debris', 0);
    const ints = Array.from({ length: 2000 }, () => int(r, 6, 10));
    expect(new Set(ints)).toEqual(new Set([6, 7, 8, 9, 10]));
    expect(() => int(r, 3, 2)).toThrow();
    const us = Array.from({ length: 1000 }, () => uniform(r, 0.2, 0.38));
    expect(Math.min(...us)).toBeGreaterThanOrEqual(0.2);
    expect(Math.max(...us)).toBeLessThan(0.38);
    const ns = Array.from({ length: 10_000 }, () => normal(r, 0.02, 0.15));
    const mean = ns.reduce((a, b) => a + b, 0) / ns.length;
    const sd = Math.sqrt(ns.reduce((a, b) => a + (b - mean) ** 2, 0) / ns.length);
    expect(Math.abs(mean - 0.02)).toBeLessThan(0.01);
    expect(Math.abs(sd - 0.15)).toBeLessThan(0.01);
    expect(['a', 'b', 'c']).toContain(pick(r, ['a', 'b', 'c']));
    expect(() => pick(r, [])).toThrow();
  });

  it('reads no Math.random, clock or ctx.filter in the WP0 impact modules', () => {
    for (const f of ['rng', 'clock', 'palette', 'floor', 'contracts']) {
      const code = readFileSync(resolve(REPO, 'src/impact', `${f}.ts`), 'utf8').replace(/\/\/.*$/gm, '');
      expect(code, f).not.toMatch(/Math\.random|\bDate\b|performance\.now|\.filter\s*=/);
    }
  });
});

describe('clocks', () => {
  it('kr runs 24 a second around contact', () => {
    const cases: [number, number][] = [[-8, 0], [-5, 3], [-4, 3], [0, 7], [1, 7], [5, 11], [6, 11], [8, 13], [9, 14], [31, 31]];
    for (const [j, k] of cases) expect(kr(j), `j ${j}`).toBe(k);
  });

  it('kr and k24 hold 2, 1, 1, 1 frames', () => {
    expect(runs(Array.from({ length: 40 }, (_, f) => k24(f)))).toEqual(Array.from({ length: 8 }, () => [2, 1, 1, 1]).flat()); // 40 frames: eight steps of 5
    expect(runs(Array.from({ length: 40 }, (_, i) => kr(i - 5)))).toEqual(Array.from({ length: 8 }, () => [2, 1, 1, 1]).flat()); // 40 frames: eight steps of 5
  });

  it('c1 is kr with a slam and k24 without', () => {
    expect(c1(90, I)).toBe(kr(6));
    expect(c1(90, null)).toBe(k24(90));
    expect(c1(90)).toBe(k24(90));
  });

  it('drawingStart is the first frame of a global drawing', () => {
    for (const dps of [12, 8]) {
      for (let k = -5; k < 80; k++) {
        const f = drawingStart(k, dps);
        expect(drawingIndex(f, dps)).toBe(k);
        expect(drawingIndex(f - 1, dps)).toBe(k - 1);
      }
    }
  });
});

describe('mass hold groups', () => {
  it('match the hero schedule at I = 84', () => {
    const want: [number, number][] = [[93, 0], [94, 0], [95, 1], [97, 1], [98, 2], [100, 3], [103, 4], [105, 5], [107, 5], [108, 6], [110, 6], [111, 6], [112, 7], [113, 7], [114, 7], [115, 8], [116, 8], [117, 8], [118, 9], [120, 10]];
    for (const [f, g] of want) expect(massGroup(f, I, 12), `f${f}`).toBe(g);
    expect(massGroup(92, I, 12)).toBeNull();
  });

  it('never change inside a global drawing, except where j 9 or the 4-frame hold forces one', () => {
    for (const dps of [12, 8]) {
      for (let at = 80; at <= 90; at++) {
        for (let f = at + 10; f <= at + 120; f++) {
          const g = massGroup(f, at, dps)!;
          const before = massGroup(f - 1, at, dps)!;
          expect(g).toBeGreaterThanOrEqual(before);
          if (drawingIndex(f, dps) !== drawingIndex(f - 1, dps) || g === before) continue;
          // Mid-drawing: only on the frame after a measured group's GROUP_HOLD frames, onto the next group.
          const at_ = `I ${at} f ${f} dps ${dps}`;
          expect(f - at, at_).toBeLessThanOrEqual(31);
          expect(massGroup(f - GROUP_HOLD, at, dps), at_).toBe(before);
          expect(g, at_).toBe(before + 1);
        }
        expect(massGroup(at + 9, at, dps)).toBe(0);
        expect(massGroup(at + 8, at, dps)).toBeNull();
      }
    }
  });

  it('hold no measured group longer than GROUP_HOLD (4) frames over j 9..31 (judge round 2: g6 held 5)', () => {
    expect(GROUP_HOLD).toBe(4);
    for (const dps of [12, 8]) {
      for (let at = 80; at <= 90; at++) {
        const run = new Map<number, number>();
        for (let f = at + 9; f <= at + 31; f++) {
          const g = massGroup(f, at, dps)!;
          run.set(g, (run.get(g) ?? 0) + 1);
        }
        for (const [g, n] of run) expect(n, `I ${at} dps ${dps} g${g}`).toBeLessThanOrEqual(GROUP_HOLD);
      }
    }
    // The hero's g6: f108–111.
    expect([107, 108, 111, 112].map((f) => massGroup(f, I, 12))).toEqual([5, 6, 6, 7]);
  });
});

describe('phases and the decay', () => {
  it('decayAlpha is 1 at J_end − 14 and exactly 0 at J_end, for 1.5 s and 3 s', () => {
    for (const [seconds, end] of [[1.5, 45], [3, 90]]) {
      expect(jEnd(seconds)).toBe(end);
      expect(decayAlpha(end - 14, end)).toBe(1);
      expect(decayAlpha(end - 7, end)).toBe(0.5);
      expect(decayAlpha(end, end)).toBe(0);
      expect(decayAlpha(end + 5, end)).toBe(0);
      expect(decayAlpha(0, end)).toBe(1);
    }
  });

  it('phaseAt walks coil, strike, posters, aftermath, hold, decay', () => {
    expect(phaseAt(-15, 45)).toEqual({ kind: 'none' });
    expect(phaseAt(-14, 45)).toEqual({ kind: 'coil' });
    expect(phaseAt(-8, 45)).toEqual({ kind: 'strike', s: 0 });
    expect(phaseAt(-4, 45)).toEqual({ kind: 'strike', s: 3 });
    expect(phaseAt(-1, 45)).toEqual({ kind: 'strike', s: 6 });
    expect(phaseAt(0, 45)).toEqual({ kind: 'poster', si: 0 });
    expect(phaseAt(5, 45)).toEqual({ kind: 'poster', si: 4 });
    expect(phaseAt(8, 45)).toEqual({ kind: 'poster', si: 6 });
    expect(phaseAt(9, 45)).toEqual({ kind: 'aftermath', A: 0 });
    expect(phaseAt(31, 45)).toEqual({ kind: 'aftermath', A: 17 });
    expect(phaseAt(32, 45)).toEqual({ kind: 'decay', alpha: 13 / 14 });
    expect(phaseAt(45, 45)).toEqual({ kind: 'decay', alpha: 0 });
    expect(phaseAt(46, 45)).toEqual({ kind: 'after' });
    expect(phaseAt(32, 90)).toEqual({ kind: 'hold' });
    expect(phaseAt(76, 90)).toEqual({ kind: 'hold' });
    expect(phaseAt(77, 90)).toEqual({ kind: 'decay', alpha: 13 / 14 });
  });

  it('zoomAt punches in through j 9 and eases back by j 39', () => {
    expect(zoomAt(-1)).toBe(1);
    expect(zoomAt(0)).toBe(1.08);
    expect(zoomAt(9)).toBe(1.08);
    expect(zoomAt(24)).toBeCloseTo(1.02, 12);
    expect(zoomAt(39)).toBe(1);
    expect(zoomAt(60)).toBe(1);
    for (let j = 10; j <= 39; j++) expect(zoomAt(j)).toBeLessThan(zoomAt(j - 1));
  });
});

describe('limbDrawingAt (limbs first)', () => {
  const strike = { land: I - 7, release: I + 9 }; // f77, f93
  const kinds = (fs: number[], posters = true) => fs.map((f) => limbDrawingAt(f, I, strike, posters));

  it('draws tubes on j −8, −7, −5, −3, −1, stamps between, silhouettes on the posters', () => {
    expect(kinds([76, 77, 79, 81, 83])).toEqual(Array(5).fill('tube'));
    expect(kinds([78, 80, 82])).toEqual(Array(3).fill('stamp'));
    expect(kinds([84, 85, 86, 87, 88, 89, 90, 91, 92])).toEqual(Array(9).fill('silhouette'));
    expect(limbDrawingAt(93, I, strike)).toBe('tube'); // the release forces a new drawing
    expect(kinds([60, 75, 94, 120])).toEqual(Array(4).fill('grid'));
  });

  it('keeps the pinned cadence through j 0..8 when there are no posters', () => {
    expect(kinds([84, 85, 86, 92, 93], false)).toEqual(['stamp', 'tube', 'stamp', 'stamp', 'tube']);
    expect(limbDrawingAt(86, I)).toBe('silhouette');
    expect(limbDrawingAt(80, I)).toBe('grid');
  });
});

describe('the slow-replay freeze', () => {
  it('holds clip frame I under the posters, then resumes at I + 9', () => {
    for (let o = 0; o < I; o++) expect(freezeMap(I, o)).toEqual({ clip: o, si: null });
    for (let o = I; o <= I + 34; o++) expect(freezeMap(I, o)).toEqual({ clip: I, si: Math.floor((o - I) / 5) });
    expect(freezeMap(I, I + 35)).toEqual({ clip: I + 9, si: null });
    for (let o = I + 35; o < I + 120; o++) expect(freezeMap(I, o).clip).toBe(o - 26);
  });

  it('posterHolds are 2, 1, 1, 1, 2, 1, 1, or 5 each frozen', () => {
    expect(posterHolds()).toEqual([2, 1, 1, 1, 2, 1, 1]);
    expect(posterHolds(true)).toEqual([5, 5, 5, 5, 5, 5, 5]);
  });
});

// ---- The effect JSON ---------------------------------------------------------------------

const VIEW = { points: [[0, 0], [0.2, 0.1]] as Vec2[], pressure: [1, 0.5], root: [0, 0] as Vec2, layer: 'behind' as const };
const OLD: Effect = {
  version: 1,
  brush: { size: 28, thinning: 0.65, smoothing: 0.6, streamline: 0.45 },
  palette: ['#e8203a', '#f4f1ea', '#16141a'],
  timing: { drawingsPerSecond: 12 },
  strokes: [{ id: 1, color: 0, brush: 'electric', kind: 'strand', anchor: { type: 'concept', prompt: 'back' }, bodyAngle: 180, stiffness: 0.1, wobble: 1, views: { front: VIEW } }],
  overrides: {},
};
// c628565 (Oct 27): the slam with its ring, bursts and ease, as test-drawings.json has it.
const C628565: Effect = {
  ...OLD,
  moments: [
    { kind: 'emerge', at: 0.733 },
    { kind: 'slam', at: 2.8, xy: [942, 1061], by: 'body', ring: { color: 1, seed: 84 }, bursts: { color: 1, brush: 'electric', count: 8, seed: 84 }, ease: { cracks: 'out', ring: 'out', bursts: 'out' } },
  ],
};
const IMPACT: Effect = {
  ...OLD,
  brushes: { limb: { ...LIMB_BRUSH, glow: { ...LIMB_GLOW }, limb: { ...LIMB, radius: 0.024 } } },
  strokes: [
    { ...OLD.strokes[0], brush: 'limb' },
    { id: 11, color: 2, kind: 'rigid', anchor: { type: 'ground', xy: [942, 1061] }, bodyAngle: 0, stiffness: 1, wobble: 0, views: { front: VIEW } },
  ],
  moments: [
    { kind: 'emerge', at: 0.733, strokes: [1] },
    {
      kind: 'slam',
      at: 2.8,
      xy: [942, 1061],
      by: 'body',
      dir: [-0.06, 0.998],
      seed: 84,
      strokes: [11],
      limbs: [1],
      frames: { count: 7, flash: 'full' },
      aftermath: { seconds: 2.25, scale: 1, scarSeconds: 3 },
      floor: { ratio: 0.763, majorDeg: 2.6, up: [0.04, -1], persp: 0.68 },
      ring: { color: 1, seed: 84 },
      bursts: { color: 1, brush: 'electric', count: 8, seed: 84 },
      ease: { cracks: 'in' },
    },
  ],
  turn: { at: 2, dir: -1, keys: [[1.6, 0], [1.8, -90], [2, -180], [2.2, -270], [2.4, -360]] },
};

const problemsOf = (e: unknown): string[] => {
  const r = parseEffect(JSON.stringify(e));
  return 'problems' in r ? r.problems : [];
};
const withSlam = (patch: Record<string, unknown>) => ({ ...OLD, moments: [{ kind: 'slam', at: 2.8, xy: [942, 1061], by: 'body', ...patch }] });

describe('the effect JSON', () => {
  it("knows the 'limb' brush", () => {
    expect(BRUSH_IDS).toContain('limb');
    expect(problemsOf({ ...OLD, strokes: [{ ...OLD.strokes[0], brush: 'limb' }] })).toEqual([]);
  });

  it('round-trips every new field, the turn included', () => {
    expect(parseEffect(serializeEffect(IMPACT))).toEqual({ effect: IMPACT });
  });

  it('reads an effect saved before the impact fields', () => {
    expect(parseEffect(serializeEffect(OLD))).toEqual({ effect: OLD });
  });

  it("keeps c628565's ring, bursts and ease exactly", () => {
    const text = serializeEffect(C628565);
    const r = parseEffect(text);
    expect(r).toEqual({ effect: C628565 });
    expect('effect' in r && serializeEffect(r.effect)).toBe(text);
  });

  it('rejects an aftermath outside 1.5–3 s with a readable problem', () => {
    const aftermath = (seconds: number) => withSlam({ aftermath: { seconds, scale: 1, scarSeconds: 3 } });
    expect(problemsOf(aftermath(1.4))).toEqual(['moments[0].aftermath.seconds is not in 1.5..3 (it is 1.4)']);
    expect(problemsOf(aftermath(3.1))).toEqual(['moments[0].aftermath.seconds is not in 1.5..3 (it is 3.1)']);
    expect(problemsOf(aftermath(1.5))).toEqual([]);
    expect(problemsOf(aftermath(3))).toEqual([]);
  });

  it('checks frames, floor, dir and the stroke lists', () => {
    expect(problemsOf(withSlam({ frames: { count: 5, flash: 'safe' } }))).toEqual(['moments[0].frames.count is not 0 or 7 (it is 5)']);
    expect(problemsOf(withSlam({ frames: { count: 0, flash: 'gentle' } }))).toEqual(['moments[0].frames.flash is not safe or full (it is "gentle")']);
    expect(problemsOf(withSlam({ frames: { count: 0, flash: 'safe' } }))).toEqual([]);
    expect(problemsOf(withSlam({ floor: { ...DEFAULT_FLOOR, ratio: 0.1 } }))).toEqual(['moments[0].floor.ratio is not in 0.2..1 (it is 0.1)']);
    expect(problemsOf(withSlam({ floor: { ...DEFAULT_FLOOR, ratio: 1.2 } }))).toEqual(['moments[0].floor.ratio is not in 0.2..1 (it is 1.2)']);
    expect(problemsOf(withSlam({ floor: { ...DEFAULT_FLOOR } }))).toEqual([]);
    expect(problemsOf(withSlam({ floor: { ...DEFAULT_FLOOR, up: [0, 0] } }))).toEqual(['moments[0].floor.up is not a direction [x, y]']);
    expect(problemsOf(withSlam({ dir: [0, 0] }))).toEqual(['moments[0].dir is not a direction [x, y]']);
    expect(problemsOf(withSlam({ limbs: [1.5], strokes: 'all' }))).toEqual(['moments[0].strokes is not a list of stroke ids', 'moments[0].limbs is not a list of stroke ids']);
    expect(problemsOf(withSlam({ seed: '84' }))).toEqual(['moments[0].seed is not a number']);
  });

  it('checks the turn', () => {
    const turn = (t: unknown) => problemsOf({ ...OLD, turn: t });
    expect(turn({ at: 2, dir: 1 })).toEqual([]);
    expect(turn({ at: 2, dir: 2 })).toEqual(['turn.dir is not 1 or -1']);
    expect(turn({ dir: 1 })).toEqual(['turn.at is not a number of seconds']);
    expect(turn({ at: 2, dir: 1, keys: [[2, 180], [1.8, 90]] })).toEqual(['turn.keys are not in time order']);
    expect(turn({ at: 2, dir: 1, keys: [[1.8, 90], [1.8, 180]] })).toEqual(['turn.keys are not in time order']);
    expect(turn({ at: 2, dir: 1, keys: [[1.8, null]] })).toEqual(['turn.keys is not a list of [seconds, degrees]']);
    expect(turn('f60')).toEqual(['turn is not { at, dir, keys }']);
  });

  it("checks the limb brush's settings", () => {
    const bad = { ...OLD, brushes: { limb: { ...LIMB_BRUSH, limb: { ...LIMB, bands: [0.5, 0.9] } } } };
    expect(problemsOf(bad)).toEqual(['brushes.limb.limb is not { radius, taper, socket, bands, linePx, arcs, arcLift, pulseEvery }']);
  });
});

// ---- The limb brush ------------------------------------------------------------------------

describe("the 'limb' brush", () => {
  it('has the impact defaults', () => {
    const s = brushSettings(OLD, 'limb');
    expect(s).toEqual({ size: 28, thinning: 0, smoothing: 0.5, streamline: 0.45, glow: { radiusPx: 26, intensity: 0.55 }, limb: { radius: 0.02, taper: 0.55, socket: 1.3, bands: [-0.08, 0.5, 0.9], linePx: 0.0031, arcs: 3, arcLift: [1.2, 2.1], pulseEvery: [6, 10] } });
    expect(s.limb).not.toBe(brushSettings(OLD, 'limb').limb); // fresh copies, so nobody edits the defaults
    expect(endsOf('limb')).toBe('taper');
    expect(brushSettings({ ...OLD, brushes: { limb: { ...s, size: 40 } } }, 'limb').size).toBe(40);
  });

  // WP12 points the dispatch at the shaded tube (render/limb.ts): the same
  // pixels every time, neither the ink path nor the neon one, and the body
  // in the limb's own cel tones.
  it('draws the shaded tube, the same every time, in its own body tone', async () => {
    const points = Array.from({ length: 32 }, (_, i): Vec2 => [30 + i * 7, 90 + 40 * Math.sin(i / 5)]);
    const placed: PlacedStroke[] = [{ id: 1, points, pressure: points.map((_, i) => 1 - i / 40), layer: 'front' }];
    const limb = renderPng(300, 200, placed, { ...OLD, strokes: [{ ...OLD.strokes[0], brush: 'limb' }] });
    const again = renderPng(300, 200, placed, { ...OLD, strokes: [{ ...OLD.strokes[0], brush: 'limb' }] });
    const ink = renderPng(300, 200, placed, { ...OLD, brush: { ...LIMB_BRUSH }, strokes: [{ ...OLD.strokes[0], brush: 'ink' }] });
    const neon = renderPng(300, 200, placed, { ...OLD, brushes: { 'neon-round': brushSettings(OLD, 'limb') }, strokes: [{ ...OLD.strokes[0], brush: 'neon-round' }] });
    expect(limb.equals(again)).toBe(true);
    expect(limb.equals(ink)).toBe(false);
    expect(limb.equals(neon)).toBe(false);
    const ctx = createCanvas(300, 200).getContext('2d');
    ctx.drawImage(await loadImage(limb), 0, 0);
    const { data } = ctx.getImageData(0, 0, 300, 200);
    const body = limbTones(OLD.palette).body;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(body.slice(i, i + 2), 16));
    let near = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i + 3] === 255 && Math.abs(data[i] - r) + Math.abs(data[i + 1] - g) + Math.abs(data[i + 2] - b) <= 12) near++;
    expect(near).toBeGreaterThan(200); // a band of body tone along the tube
  });
});

// ---- Palette ------------------------------------------------------------------------------

describe('palette', () => {
  const TEST: [string, string, string] = ['#e8203a', '#f4f1ea', '#16141a'];

  it('gives the strike tones within ΔE 3', () => {
    const { strike } = roles(TEST);
    const want = { edge: '#7f1a2a', accent: '#e8203a', fill: '#ef939b', core: '#f3d8d5' };
    for (const k of Object.keys(want) as (keyof typeof want)[]) expect(deltaE(strike[k], want[k]), k).toBeLessThan(3);
  });

  it('computes CIEDE2000 as Sharma, Wu and Dalal tabulate it', () => {
    const pairs: [number[], number[], number][] = [
      [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
      [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
      [[50, 0, 0], [50, -1, 2], 2.3669],
      [[50, 2.49, -0.001], [50, -2.49, 0.0009], 7.1792],
      [[50, 2.49, -0.001], [50, -2.49, 0.0011], 7.2195],
      [[50, -0.001, 2.49], [50, 0.0009, -2.49], 4.8045],
      [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    ];
    for (const [a, b, e] of pairs) expect(deltaE2000(a, b)).toBeCloseTo(e, 4);
    expect(deltaE('#e8203a', '#e8203a')).toBe(0);
  });

  it('converts OKLCH both ways', () => {
    const red = toOklch('#ff0000');
    expect(red.L).toBeCloseTo(0.628, 3);
    expect(red.C).toBeCloseTo(0.2577, 3);
    expect(red.h).toBeCloseTo(29.23, 1);
    for (const c of ['#e8203a', '#f4f1ea', '#16141a', '#00027c', '#02fdf5', '#7f1a2a', '#808080', '#000000', '#ffffff']) expect(fromOklch(toOklch(c))).toBe(c);
    // Out of gamut: the chroma comes down, the hue stays.
    const loud = fromOklch({ L: 0.6, C: 0.5, h: 150 });
    expect(Math.abs(hueDelta(toOklch(loud).h, 150))).toBeLessThan(2);
  });

  it('measures luminance, contrast and saturated red', () => {
    expect(luminance('#ffffff')).toBeCloseTo(1, 9);
    expect(luminance('#000000')).toBe(0);
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 9);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
    expect(isSaturatedRed('#e8203a')).toBe(true);
    expect(isSaturatedRed('#6a2c03')).toBe(true); // gentle mode G4's example ...
    expect(isSaturatedRed('#6a3b0a')).toBe(false); // ... and its fix
    expect(isSaturatedRed('#000000')).toBe(false);
  });

  it('builds the roles of design §5 and §9', () => {
    const r = roles(TEST);
    expect([r.main, r.paper, r.ink]).toEqual(TEST);
    expect(r.ring).toBe(mixHex('#f4f1ea', '#fb6a04', 0.3));
    const accent = toOklch(r.accent);
    expect(accent.L).toBeCloseTo(0.35, 2);
    expect(accent.C).toBeCloseTo(0.12, 2);
    expect(hueDelta(toOklch('#e8203a').h, accent.h)).toBeGreaterThan(0);
    expect(hueDelta(accent.h, toOklch('#fb6a04').h)).toBeGreaterThan(0);
    expect(r.discharge).toEqual(DISCHARGE); // red limbs keep the measured blues
    expect(r.fire.licks).toContain('#fb6a04');
    expect(r.hot[0]).toBe('#fffdcf');
    expect(r.smoke.deep).toBe('#1b0301');
  });

  it('caps the tint, and keeps light fields light on request', () => {
    const r = roles(TEST);
    expect(r.tintMax).toBe(0.15); // p0 is a saturated red
    expect(roles(['#3a6cff', '#f4f1ea', '#16141a']).tintMax).toBe(0.2);
    expect(r.tint(0)).toBe('#f4f1ea');
    expect(r.tint(0.5)).toBe(r.tint(0.15));
    expect(luminance(r.tint(0.15))).toBeLessThan(0.8);
    const kept = r.tint(0.15, 0.8);
    expect(luminance(kept)).toBeGreaterThanOrEqual(0.8);
    expect(kept).not.toBe('#f4f1ea');
  });

  it('turns the discharge set with a p0 within 60° of its hue', () => {
    const p0 = '#9b3cff'; // a violet, 38° past the measured blues
    const turn = hueDelta(262, toOklch(p0).h);
    expect(turn).toBeGreaterThan(30);
    expect(turn).toBeLessThan(60);
    const { discharge } = roles([p0, '#f4f1ea', '#16141a']);
    for (const k of ['edge', 'band', 'core', 'pale'] as const) expect(Math.abs(hueDelta(toOklch(DISCHARGE[k]).h + turn, toOklch(discharge[k]).h)), k).toBeLessThan(1);
  });
});

// ---- Floor and strike frame ---------------------------------------------------------------------

const extent = (pts: Vec2[], P: Vec2, axis: Vec2) => Math.max(...pts.map((p) => Math.abs((p[0] - P[0]) * axis[0] + (p[1] - P[1]) * axis[1])));

describe('floor', () => {
  it('reads n̂ and t̂ off the floor block', () => {
    expect(floorFrame([942, 1061], DEFAULT_FLOOR)).toEqual({ P: [942, 1061], n: [0, -1], t: [1, 0] });
  });

  it('draws a floor circle with semi-axes R and ratio·R', () => {
    const P: Vec2 = [960, 540];
    for (const R of [37, 200, 431.5]) {
      const { points, closed } = floorCircle(P, R, DEFAULT_FLOOR, { U: 680, height: 1080 });
      expect(closed).toBe(true);
      expect(Math.abs(extent(points, P, [1, 0]) - R)).toBeLessThan(0.5);
      expect(Math.abs(extent(points, P, [0, 1]) - 0.5 * R)).toBeLessThan(0.5);
    }
  });

  it("squashes the far half by 1 + persp·R/U", () => {
    const P: Vec2 = [960, 540];
    const floor = { ratio: 0.763, majorDeg: 0, up: [0, -1] as Vec2, persp: 0.68 };
    const { points } = floorCircle(P, 200, floor, { U: 680, height: 1080 });
    const up = Math.max(...points.map((p) => P[1] - p[1]));
    const down = Math.max(...points.map((p) => p[1] - P[1]));
    expect(Math.abs(up - (0.763 * 200) / (1 + (0.68 * 200) / 680))).toBeLessThan(0.5);
    expect(Math.abs(down - 0.763 * 200)).toBeLessThan(0.5);
  });

  it('draws only the far half when P is in the bottom 5 % of the frame', () => {
    const near = floorCircle([942, 1061], 120, DEFAULT_FLOOR, { U: 680, height: 1080, segments: 64 });
    expect(near.closed).toBe(false);
    expect(near.points).toHaveLength(33);
    expect(near.points.every((p) => p[1] <= 1061 + 1e-9)).toBe(true);
    expect(floorCircle([942, 1026], 120, DEFAULT_FLOOR, { U: 680, height: 1080 }).closed).toBe(true); // 0.95 H is 1026
  });

  it('mirrors an element that is wholly off the frame back across P', () => {
    const P: Vec2 = [942, 1061];
    const below: Vec2[] = [[900, 1100], [960, 1150]];
    const { points, mirrored } = mirrorIntoFrame(below, P, [0, -1], 1920, 1080);
    expect(mirrored).toBe(true);
    expect(points).toEqual([[900, 1022], [960, 972]]);
    const crossing = mirrorIntoFrame([[900, 1200], [900, 1000]], P, [0, -1], 1920, 1080);
    expect(crossing.mirrored).toBe(false);
    const passing = mirrorIntoFrame([[-50, 500], [500, -50]], P, [1, 0], 1920, 1080); // corner cut: no point inside, the segment is
    expect(passing.mirrored).toBe(false);
  });

  it('works out σ from the person box', () => {
    expect(sigmaOf(609, 1080)).toBeCloseTo(0.6307, 3); // the hero: U ≈ 680
    expect(sigmaOf(100, 1080)).toBe(0.45);
    expect(sigmaOf(2000, 1080)).toBe(1);
  });

  it('gives strike axes with h = −1 in portrait, for every seed', () => {
    for (let seed = 0; seed < 500; seed++) {
      const f = strikeFrame([540, 1500], [0.2, 0.98], 1080, 0.6, 1080, 1920, seed);
      expect(f.h).toBe(-1);
      expect(f.v[0]).toBeCloseTo(f.u[1], 12); // v = −(−u_y, u_x)
      expect(f.v[1]).toBeCloseTo(-f.u[0], 12);
    }
  });

  it('lets the seed pick the side in landscape, and builds X(a, b)', () => {
    const { P, d, S, width, height, seed: heroSeed } = HERO;
    const sides = new Set(Array.from({ length: 64 }, (_, seed) => strikeFrame(P, d, S, 0.63, width, height, seed).h));
    expect(sides).toEqual(new Set([1, -1]));
    const f = strikeFrame(P, d, S, 0.63, width, height, heroSeed);
    expect(strikeFrame(P, d, S, 0.63, width, height, heroSeed)).toEqual(f);
    expect(Math.hypot(...f.u)).toBeCloseTo(1, 12);
    expect(f.u[0] * f.v[0] + f.u[1] * f.v[1]).toBeCloseTo(0, 12);
    expect(f.U).toBeCloseTo(680.4, 9);
    expect(strikeAt(f, 0, 0)).toEqual([942, 1061]);
    expect(dist(strikeAt(f, 0.1, 0), [942 + 108 * f.u[0], 1061 + 108 * f.u[1]])).toBeLessThan(1e-9);
    expect(strikeFrame([0, 0], [0, 0], 1080, 1, 1920, 1080, 1).u).toEqual([0, 1]);
  });
});

// ---- Contracts -------------------------------------------------------------------------------

describe('contracts', () => {
  it('syntheticTube is a straight tube facing the camera', () => {
    const tube = syntheticTube(10, 300, 12, [100, 200]);
    expect(tube.sections).toHaveLength(10);
    expect(tube.length).toBe(300);
    tube.sections.forEach((s, i) => {
      expect(s.s).toBeCloseTo(i / 9, 12);
      expect(s.screen).toEqual([s.c[0], s.c[1]]);
      expect(s.screen[0]).toBeCloseTo(100 + (300 * i) / 9, 9);
      expect(s.screen[1]).toBe(200);
      expect(s.T[0] * s.N[0] + s.T[1] * s.N[1] + s.T[2] * s.N[2]).toBe(0);
      expect(s.B).toEqual([s.T[1] * s.N[2] - s.T[2] * s.N[1], s.T[2] * s.N[0] - s.T[0] * s.N[2], s.T[0] * s.N[1] - s.T[1] * s.N[0]]); // T × N
      expect(s.normal).toEqual([0, 1]); // the screen tangent (1, 0) turned to (−ty, tx)
      expect(s.r).toBe(12);
    });
    expect(() => syntheticTube(1, 300, 12)).toThrow();
  });

  it('recordingSink keeps a copy of every call; nullSink takes them all', () => {
    const sink = recordingSink();
    const pts: Vec2[] = [[0, 0], [10, 5]];
    sink.stroke(pts, 4, '#3a6cff', 'core', 1);
    sink.fill(pts, '#a8f6ff', 'body', 0.6);
    sink.disc([5, 5], 9, '#ffffff', 0.4);
    sink.wash(pts, '#02fdf5', 0.2);
    pts[0][0] = 99;
    expect(sink.calls.map((c) => c.op)).toEqual(['stroke', 'fill', 'disc', 'wash']);
    expect(sink.calls[0]).toEqual({ op: 'stroke', points: [[0, 0], [10, 5]], width: 4, color: '#3a6cff', kind: 'core', gain: 1 });
    expect(() => {
      nullSink.stroke(pts, 1, '#000000', 'body', 1);
      nullSink.disc([0, 0], 1, '#000000', 1);
    }).not.toThrow();
  });
});

// ---- Render-script arguments ---------------------------------------------------------------------

describe('out-dir', () => {
  it('parses the render options', () => {
    const args = parseArgs(['--out', 'D:/renders', '--clip=C:/clip.mp4', '--drawings', 'd.json', '--ref', 'refs', '--frames', '70-130', '--flash', 'safe', '--tier', 'phone', '--scale', '0.5', '--tap', '60', '--portrait', 'extra']);
    expect(args).toEqual({ out: 'D:/renders', clip: 'C:/clip.mp4', drawings: 'd.json', ref: 'refs', frames: [70, 130], flash: 'safe', tier: 'phone', scale: 0.5, tap: 60, portrait: true, positional: ['extra'] });
    expect(parseArgs([])).toEqual({ portrait: false, positional: [] });
  });

  it('says what is wrong with a bad option', () => {
    expect(() => parseArgs(['--frames', '130-70'])).toThrow(/--frames takes first-last/);
    expect(() => parseArgs(['--frames', '70'])).toThrow(/--frames/);
    expect(() => parseArgs(['--flash', 'gentle'])).toThrow(/--flash is safe or full/);
    expect(() => parseArgs(['--tier', 'ipad'])).toThrow(/--tier/);
    expect(() => parseArgs(['--scale', '0'])).toThrow(/--scale/);
    expect(() => parseArgs(['--tap', 'f60'])).toThrow(/--tap/);
    expect(() => parseArgs(['--out'])).toThrow(/--out needs a value/);
    expect(() => parseArgs(['--out', '--portrait'])).toThrow(/--out needs a value/);
    expect(() => parseArgs(['--portrait=yes'])).toThrow(/takes no value/);
    expect(() => parseArgs(['--fps', '30'])).toThrow(/unknown option --fps/);
  });

  it('assertOutsideRepo refuses the repo and anything in it', () => {
    expect(() => assertOutsideRepo(resolve(REPO, 'renders'), REPO)).toThrow(/inside the repo/);
    expect(() => assertOutsideRepo(resolve(REPO, 'renders', 'sheets', 'a.png'), REPO)).toThrow(/inside the repo/);
    expect(() => assertOutsideRepo(REPO, REPO)).toThrow(/inside the repo/);
    if (process.platform === 'win32') expect(() => assertOutsideRepo(resolve(REPO, 'renders').toUpperCase(), REPO)).toThrow(/inside the repo/);
    const outside = resolve(REPO, '..', `${REPO.split(/[\\/]/).pop()}-renders`, 'sheets');
    expect(assertOutsideRepo(outside, REPO)).toBe(outside);
  });
});

// ---- The messy impact drawings (the test helper) -----------------------------------------------

describe('the messy impact drawings', () => {
  const S = HERO.S;
  const P = HERO.P;
  const onFrame = (p: Vec2) => p[0] >= 0 && p[0] <= HERO.width - 1 && p[1] >= 0 && p[1] <= HERO.height - 1;
  const nearest = (pts: Vec2[], q: Vec2) => {
    let best = Infinity;
    for (let i = 1; i < pts.length; i++) {
      const [a, b] = [pts[i - 1], pts[i]];
      const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
      const t = Math.min(1, Math.max(0, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / (dx * dx + dy * dy)));
      best = Math.min(best, dist(q, [a[0] + dx * t, a[1] + dy * t]));
    }
    return best;
  };

  it('are seeded: the same seed gives the same drawings, another seed others', () => {
    expect(messyDrawings(84)).toEqual(messyDrawings(84));
    for (const k of ['jittered', 'scattered', 'starburst'] as const) expect(messyDrawing(k, 85)).not.toEqual(messyDrawing(k, 84));
    expect(Object.keys(messyDrawings())).toEqual([...MESSY_KINDS]);
  });

  it('jittered moves every point by at most 0.01 S on each axis', () => {
    const j = messyDrawing('jittered');
    expect(j.map((s) => s.id)).toEqual(HERO_CRACKS.map((c) => c.id));
    j.forEach((s, i) => s.points.forEach((p, k) => {
      const q = HERO_CRACKS[i].points[k];
      expect(Math.abs(p[0] - q[0])).toBeLessThanOrEqual(0.01 * S + 1e-9);
      expect(Math.abs(p[1] - q[1])).toBeLessThanOrEqual(0.01 * S + 1e-9);
      expect(onFrame(p)).toBe(true);
    }));
    expect(j.flatMap((s) => s.points).filter((p, i) => dist(p, HERO_CRACKS.flatMap((c) => c.points)[i]) > 1).length).toBeGreaterThan(50);
  });

  it('inward draws every crack toward P', () => {
    for (const s of messyDrawing('inward')) {
      expect(s.points[s.points.length - 1]).toEqual(P);
      expect(s.pressure[s.pressure.length - 1]).toBe(1);
    }
  });

  it('single is crack 13 alone', () => {
    expect(messyDrawing('single')).toEqual([HERO_CRACKS.find((c) => c.id === 13)]);
  });

  it('scattered is six short marks 0.15–0.35 S out, sharing no end', () => {
    const marks = messyDrawing('scattered');
    expect(marks).toHaveLength(6);
    const ends = marks.map((m) => [m.points[0], m.points[m.points.length - 1]]);
    marks.forEach((m, i) => {
      const mid: Vec2 = [(ends[i][0][0] + ends[i][1][0]) / 2, (ends[i][0][1] + ends[i][1][1]) / 2];
      expect(dist(mid, P) / S).toBeGreaterThanOrEqual(0.15 - 1e-9);
      expect(dist(mid, P) / S).toBeLessThanOrEqual(0.35 + 1e-9);
      expect(Math.min(...m.points.map((p) => dist(p, P))) / S).toBeGreaterThan(0.08); // no end at P: drawn whole on the posters
      expect(m.points.every(onFrame)).toBe(true);
      for (let o = 0; o < i; o++) for (const a of ends[i]) for (const b of ends[o]) expect(dist(a, b) / S).toBeGreaterThanOrEqual(0.05);
    });
  });

  it('starburst is eight strokes through P, each starting at most 0.05 S past it', () => {
    const rays = messyDrawing('starburst');
    expect(rays).toHaveLength(8);
    for (const r of rays) {
      expect(nearest(r.points, P)).toBeLessThan(0.5);
      expect(dist(r.points[0], P) / S).toBeLessThanOrEqual(0.05 + 1e-9);
      expect(r.points.every(onFrame)).toBe(true);
    }
    // Rays heading off the bottom keep their whole 0.05 S start; the frame cuts the others.
    expect(rays.filter((r) => Math.abs(dist(r.points[0], P) / S - 0.05) < 1e-9).length).toBeGreaterThanOrEqual(2);
  });

  it('turn into effect strokes that parse', () => {
    for (const k of MESSY_KINDS) {
      const effect: Effect = { ...OLD, strokes: asGroundStrokes(messyDrawing(k)) };
      expect(parseEffect(serializeEffect(effect)), k).toEqual({ effect });
    }
  });
});
