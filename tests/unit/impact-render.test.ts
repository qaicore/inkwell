// WP14: the hero render script's own pieces (scripts/impact-render.ts): the
// drawings as an effect, the turn it asks for, the portrait crop, the output
// window and audio under the flash ladder's freeze, the labels and the
// reports. Everything is synthetic or the hero's numbers; no clip, no ffmpeg,
// no network. The render itself runs by hand (see the script's header).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HAND_KEYS,
  HERO_FLOOR,
  TURN_CHECK,
  atFrames,
  audioFilter,
  audioSegments,
  closeWindow,
  crackStroke,
  cropLeft,
  cropSamMask,
  flashBrief,
  frameLabel,
  handTurn,
  heroEffect,
  internalSize,
  limbStroke,
  main,
  outName,
  outputWindow,
  phaseLabel,
  portraitWidth,
  readDrawings,
  refName,
  samBox,
  segmentTimes,
  shiftDrawings,
  shotSpans,
  standInPoints,
  stats,
  timingSummary,
  turnPlan,
  turnReport,
  turnUsed,
  type AudioSegment,
  type FrameTime,
  type HeroDrawings,
  type JobTime,
} from '../../scripts/impact-render.ts';
import { checkFlashes, flashSummary, type CheckFrame } from '../../src/export/flash.ts';
import { FREEZE_EXTRA, freezeMap, phaseAt } from '../../src/impact/clock.ts';
import type { DrawnMoments } from '../../src/impact/detect.ts';
import type { PosterSpec } from '../../src/impact/frames/gentle.ts';
import { turnAt } from '../../src/lift/body.ts';
import { turnKeysFromTap } from '../../src/lift/turn.ts';
import { drawingIndex } from '../../src/motion/timing.ts';
import { toFrameMask, type SamMask } from '../../src/sam/cache.ts';
import { toPixels, type TorsoTransform } from '../../src/track/torso.ts';
import { parseEffect, serializeEffect, type Vec2 } from '../../src/types/effect.ts';
import { HERO, HERO_CRACKS } from './helpers/impact-drawings.ts';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const I = HERO.I;
const CRACK_IDS = HERO_CRACKS.map((c) => c.id);
const close = (a: readonly number[], b: readonly number[], eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) <= eps);

// Two limbs out of his back on f22, and the hero's six cracks on f84.
const DRAWINGS: HeroDrawings = {
  size: [1920, 1080],
  seed: 84,
  palette: ['#e8203a', '#f4f1ea', '#16141a'],
  start: {
    frame: 22,
    hips: [808.1, 452.1],
    strokes: [
      { id: 1, points: [[778, 300], [760, 262], [731, 231], [690, 214], [641, 214], [600, 228]], pressure: [1, 0.9, 0.8, 0.6, 0.45, 0.3], color: 0, stiffness: 0.1, layer: 'behind' },
      { id: 2, points: [[838, 300], [858, 260], [890, 232], [935, 216], [985, 220]], pressure: [1, 0.85, 0.7, 0.5, 0.3], color: 0, stiffness: 0.1, layer: 'behind' },
    ],
  },
  end: {
    frame: 84,
    floor: { ratio: 0.763, majorDeg: 2.6 },
    ease: null,
    strokes: HERO_CRACKS.map((c) => ({ id: c.id, points: c.points.map((p): Vec2 => [p[0], p[1]]), pressure: [...c.pressure], color: 2 as const, anchor: [942, 1061] as Vec2 })),
  },
};

// What momentsFromDrawings gives on the hero (WP1), written out.
const MOMENTS: DrawnMoments = {
  emerge: { kind: 'emerge', at: 22 / 30, strokes: [1, 2] },
  slam: { kind: 'slam', at: I / 30, xy: [943, 1062.5], by: 'body', dir: [-0.06, 0.998], seed: 84, strokes: CRACK_IDS, limbs: [1, 2], frames: { count: 7, flash: 'full' }, aftermath: { seconds: 1.5, scale: 1, scarSeconds: 3 } },
  snap: { frame: I, found: true, drawnOn: I, moved: false, toast: null },
  point: { P: [943, 1062.5], drawn: [942, 1061], from: 'start', snapped: true, ends: CRACK_IDS.map(() => 'start' as const), problems: [] },
  strike: { dir: [-0.06, 0.998], by: 'fist' },
  problems: [],
};

const AT: TorsoTransform = { x: 808.1, y: 452.1, angle: 0.05, unit: 203.4 };

describe('the drawings as an effect', () => {
  it('reads the test drawings` shape: limbs on the start frame, cracks (ink by default) on the end frame, the floor and the crack ease', () => {
    const d = readDrawings({
      size: [1920, 1080],
      seed: 84,
      palette: ['#e8203a', '#f4f1ea', '#16141a'],
      start: { frame: 22, body: { hipsMid: [808.1, 452.1] }, strokes: [{ id: 1, color: 0, stiffness: 0.1, layer: 'behind', points: [[778, 300], [760, 250], [700, 200]], pressure: [1, 0.8, 0.5] }] },
      end: { frame: 84, floor: { smallCircleRatioAtP: 0.75, smallCircleMajorAxisDeg: 3 }, strokes: [{ id: 11, anchor: { type: 'ground', xy: [942, 1061] }, points: [[942, 1061], [900, 1060]], pressure: [1, 0.5] }] },
      moments: [{ kind: 'emerge', at: 0.733 }, { kind: 'slam', ease: { cracks: 'linear', ring: 'out' } }],
    });
    expect(d.start).toEqual({ frame: 22, hips: [808.1, 452.1], strokes: [{ id: 1, points: [[778, 300], [760, 250], [700, 200]], pressure: [1, 0.8, 0.5], color: 0, stiffness: 0.1, layer: 'behind' }] });
    expect(d.end.strokes).toEqual([{ id: 11, points: [[942, 1061], [900, 1060]], pressure: [1, 0.5], color: 2, anchor: [942, 1061] }]);
    expect(d.end.floor).toEqual({ ratio: 0.75, majorDeg: 3 });
    expect(d.end.ease).toBe('linear');
    expect(d.seed).toBe(84);
  });

  it('refuses drawings it can`t use', () => {
    const limb = { id: 1, points: [[0, 0], [1, 1]], pressure: [1, 1] };
    const crack = { id: 11, points: [[0, 0], [1, 1]], pressure: [1, 1] };
    expect(() => readDrawings({ end: { frame: 84, strokes: [crack] } })).toThrow(/start drawing/);
    expect(() => readDrawings({ start: { frame: 22, strokes: [] }, end: { frame: 84, strokes: [crack] } })).toThrow(/no limb strokes/);
    expect(() => readDrawings({ start: { frame: 22, strokes: [{ ...limb, pressure: [1] }] }, end: { frame: 84, strokes: [crack] } })).toThrow(/pressures/);
    expect(() => readDrawings({ start: { frame: 22, strokes: [{ ...limb, color: 5 }] }, end: { frame: 84, strokes: [crack] } })).toThrow(/color/);
    expect(() => readDrawings({ start: { frame: 'x', strokes: [limb] }, end: { frame: 84, strokes: [crack] } })).toThrow(/start frame/);
  });

  it('stores each limb as the app does: 32 points in torso space on the start frame, back to the drawn line through the same transform', () => {
    for (const l of DRAWINGS.start.strokes) {
      const st = limbStroke(l, AT);
      expect(st).toMatchObject({ id: l.id, brush: 'limb', kind: 'strand', anchor: { type: 'concept', prompt: 'person' }, stiffness: 0.1, color: 0 });
      const { points, pressure, root, layer } = st.views.front;
      expect(points).toHaveLength(32);
      expect(pressure).toHaveLength(32);
      expect(layer).toBe('behind');
      expect(root).toEqual(points[0]);
      expect(close(toPixels(AT, points[0]), l.points[0])).toBe(true);
      expect(close(toPixels(AT, points[31]), l.points[l.points.length - 1])).toBe(true);
    }
  });

  it('keeps the cracks as ground strokes, as drawn', () => {
    const c = DRAWINGS.end.strokes[0];
    const st = crackStroke(c);
    expect(st).toMatchObject({ id: 11, color: 2, kind: 'rigid', anchor: { type: 'ground', xy: [942, 1061] }, stiffness: 1, wobble: 0 });
    expect(st.brush).toBeUndefined(); // the ink brush
    expect(st.views.front.points).toEqual(c.points);
    expect(st.views.front.pressure).toEqual(c.pressure);
  });

  it('makes an effect that parses: the derived slam in either flash mode, on the hero`s floor, with no turn unless one is given', () => {
    for (const flash of ['full', 'safe'] as const) {
      const effect = heroEffect({ drawings: DRAWINGS, moments: MOMENTS, at: AT, flash });
      const parsed = parseEffect(serializeEffect(effect));
      expect('problems' in parsed ? parsed.problems : []).toEqual([]);
      expect(effect.strokes.map((s) => s.id)).toEqual([1, 2, ...CRACK_IDS]);
      expect(effect.timing.drawingsPerSecond).toBe(12);
      expect(effect.palette).toEqual(DRAWINGS.palette);
      expect(effect.turn).toBeUndefined();
      const [emerge, slam] = effect.moments ?? [];
      expect(emerge).toEqual(MOMENTS.emerge);
      expect(slam).toMatchObject({ kind: 'slam', at: I / 30, xy: [943, 1062.5], dir: [-0.06, 0.998], seed: 84, strokes: CRACK_IDS, limbs: [1, 2], frames: { count: 7, flash } });
      expect(slam && 'floor' in slam ? slam.floor : null).toEqual({ ratio: 0.763, majorDeg: 2.6, up: [0.04, -1], persp: 0.68 });
      expect(slam && 'ease' in slam ? slam.ease : undefined).toBeUndefined();
    }
    const eased = heroEffect({ drawings: { ...DRAWINGS, end: { ...DRAWINGS.end, ease: 'linear', floor: null } }, moments: MOMENTS, at: AT, flash: 'full', turn: { at: 2, dir: 1 } });
    const slam = eased.moments?.[1];
    expect(slam && 'ease' in slam ? slam.ease : null).toEqual({ cracks: 'linear' });
    expect(slam && 'floor' in slam ? slam.floor : null).toEqual({ ...HERO_FLOOR, up: [0.04, -1] });
    expect(eased.turn).toEqual({ at: 2, dir: 1 });
  });

  it('moves the drawings with the portrait crop', () => {
    const d = shiftDrawings(DRAWINGS, -646);
    expect(d.start.hips).toEqual([808.1 - 646, 452.1]);
    expect(d.start.strokes[0].points[0]).toEqual([778 - 646, 300]);
    expect(d.end.strokes[0].points[0]).toEqual([942 - 646, 1061]);
    expect(d.end.strokes[0].anchor).toEqual([942 - 646, 1061]);
    expect(DRAWINGS.start.strokes[0].points[0]).toEqual([778, 300]); // untouched
  });
});

describe('the turn (decision 4)', () => {
  it('asks the scene to hold the pose`s turn to the hand keys over f50–74 within 45°, and a tap overrides it', () => {
    expect(turnPlan(undefined)).toEqual({ turn: null, check: { known: HAND_KEYS, from: 50, to: 74, maxDeg: 45 } });
    expect(TURN_CHECK).toEqual({ from: 50, to: 74, maxDeg: 45 });
    expect(turnPlan(60)).toEqual({ turn: { at: 2, dir: 1 }, check: undefined });
  });

  it('gives the hand keys as his nudged keys when the pose reads no turn', () => {
    expect(turnKeysFromTap(handTurn(), 30)).toEqual(HAND_KEYS);
  });

  it('names the keys used', () => {
    expect(turnUsed({ from: 'pose', checked: { used: 'read', error: 30.9 } })).toBe('pose');
    expect(turnUsed({ from: 'pose', checked: { used: 'known', error: 50 } })).toBe('hand');
    expect(turnUsed({ from: 'keys', checked: null })).toBe('hand');
    expect(turnUsed({ from: 'tap', checked: null })).toBe('tap');
    expect(turnUsed({ from: 'none', checked: null })).toBe('none');
  });

  it('reports the error against the hand keys: 30° for the tap at f60, none for the hand keys themselves', () => {
    const tap = turnKeysFromTap({ at: 2, dir: 1 }, 30);
    const report = turnReport({ read: { keys: tap, from: 'tap', checked: null }, pose: HAND_KEYS.map((k): Vec2 => [k[0], k[1]]), frames: [0, 50, 66, 72, 159] });
    expect(report.used).toBe('tap');
    expect(report.maxError).toBe(30);
    expect(report.tapModel).toEqual({ at: 60, keys: tap, error: 30 });
    expect(report.automatic).toMatchObject({ error: 0, within: true });
    expect(report.perFrame.map((p) => [p.f, p.used, p.hand, p.error])).toEqual([
      [0, 0, 0, 0],
      [50, 30, 0, 30],
      [66, 270, 247.5, 22.5],
      [72, 360, 330, 30],
      [159, 360, 360, 0],
    ]);
    expect(turnReport({ read: { keys: [], from: 'none', checked: null }, pose: [], frames: [] }).automatic).toBeNull();
  });
});

describe('the portrait crop', () => {
  // A 200 × 4 px patch at x 100..300, its raster half as wide (2 px a cell);
  // cells 20..79 are set.
  const mask: SamMask = { width: 100, height: 4, raster: Uint8Array.from({ length: 400 }, (_, i) => (i % 100 >= 20 && i % 100 < 80 ? 1 : 0)), bounds: { left: 100, top: 500, right: 300, bottom: 504 }, confidence: 0.9 };

  it('is 608 px wide on a 1080 px clip, centred on his box and kept inside the clip', () => {
    expect(portraitWidth(1080)).toBe(608);
    expect(cropLeft({ left: 709, right: 1190 }, 1920, 608)).toBe(646); // his box on f84
    expect(cropLeft({ left: 0, right: 100 }, 1920, 608)).toBe(0);
    expect(cropLeft({ left: 1850, right: 1920 }, 1920, 608)).toBe(1312);
  });

  it('reads a mask`s box from its set cells', () => {
    expect(samBox(mask)).toEqual({ left: 140, right: 260, top: 500, bottom: 504 });
    expect(samBox(null)).toBeNull();
    expect(samBox({ ...mask, raster: new Uint8Array(400) })).toBeNull();
  });

  it('crops a mask to the window: the same frame mask, moved', () => {
    const crop = cropSamMask(mask, 150, 100);
    expect(crop).not.toBeNull();
    expect(crop!.bounds).toEqual({ left: 0, top: 500, right: 100, bottom: 504 });
    expect(crop!.width).toBe(50);
    expect(crop!.confidence).toBe(0.9);
    const whole = toFrameMask(mask, 400, 520, 1);
    const part = toFrameMask(crop!, 100, 520, 1);
    for (let y = 0; y < 520; y++) for (let x = 0; x < 100; x++) expect(part.alpha[y * 100 + x], `${x}, ${y}`).toBe(whole.alpha[y * 400 + x + 150]);
    expect(cropSamMask(mask, 400, 100)).toBeNull(); // off it
    expect(cropSamMask(mask, 0, 120)).toBeNull(); // only unset cells in the window
  });

  it('takes the stand-in`s 15 points from MediaPipe`s 33', () => {
    const lm = Array.from({ length: 33 }, (_, i) => [i, 10 * i, 0.5 + i / 100]);
    const p = standInPoints(lm)!;
    expect([...p.x]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 23, 24]);
    expect(p.y[13]).toBe(230);
    expect(p.confidence[14]).toBeCloseTo(0.74, 6);
    expect(standInPoints(null)).toBeNull();
    expect(standInPoints(lm.slice(0, 20))).toBeNull();
  });
});

describe('the output frames, sizes and audio', () => {
  it('renders at 1080 on the long side, or the clip`s size × --scale', () => {
    expect(internalSize(1920, 1080, 1080, 1)).toEqual({ W: 1080, H: 608 });
    expect(internalSize(608, 1080, 1080, 1)).toEqual({ W: 608, H: 1080 });
    expect(internalSize(1920, 1080, 1920, 1)).toEqual({ W: 1920, H: 1080 });
    expect(internalSize(1920, 1080, 1080, 0.75)).toEqual({ W: 810, H: 456 });
  });

  it('keeps the window under full flashing, and under the freeze covers the same clip frames, 26 frames longer', () => {
    expect(outputWindow(0, 159, I, false)).toEqual([0, 159]);
    expect(outputWindow(0, 159, I, true)).toEqual([0, 159 + FREEZE_EXTRA]);
    expect(outputWindow(0, 80, I, true)).toEqual([0, 80]);
    expect(outputWindow(84, 84, I, true)).toEqual([84, 118]);
    expect(outputWindow(93, 100, I, true)).toEqual([119, 126]);
    // The ends show the window's clip frames, and the frames past them don't.
    for (const [first, last] of [[0, 159], [70, 130], [93, 100], [20, 90]] as const) {
      const [a, b] = outputWindow(first, last, I, true);
      expect(freezeMap(I, a).clip).toBeGreaterThanOrEqual(first);
      expect(freezeMap(I, b).clip).toBeLessThanOrEqual(last);
      expect(freezeMap(I, b + 1).clip).toBeGreaterThan(last);
      if (a > 0) expect(freezeMap(I, a - 1).clip).toBeLessThan(first);
    }
  });

  it('plays the clip`s audio in step, and under the freeze 26 frames of silence after I + 9', () => {
    expect(audioSegments(0, 159, I, false)).toEqual([{ kind: 'clip', from: 0, to: 160 / 30 }]);
    expect(audioSegments(0, 185, I, true)).toEqual([
      { kind: 'clip', from: 0, to: 93 / 30 },
      { kind: 'silence', seconds: 26 / 30 },
      { kind: 'clip', from: 93 / 30, to: 160 / 30 },
    ]);
    expect(audioSegments(100, 130, I, true)).toEqual([
      { kind: 'silence', seconds: 19 / 30 },
      { kind: 'clip', from: 93 / 30, to: 105 / 30 },
    ]);
    const length = (sg: readonly AudioSegment[]) => sg.reduce((s, x) => s + (x.kind === 'clip' ? x.to - x.from : x.seconds), 0);
    for (const [a, b] of [[0, 185], [50, 100], [90, 95], [100, 130], [119, 150], [0, 80]] as const) expect(length(audioSegments(a, b, I, true))).toBeCloseTo((b - a + 1) / 30, 9);
  });

  it('turns the segments into one ffmpeg filter ending in [aout]', () => {
    expect(audioFilter(audioSegments(0, 159, I, false), 48000, 'stereo')).toBe('[1:a]atrim=start=0.000000:end=5.333333,asetpts=PTS-STARTPTS[aout]');
    expect(audioFilter(audioSegments(0, 185, I, true), 48000, 'stereo')).toBe(
      [
        '[1:a]asplit=2[c0][c1]',
        '[c0]atrim=start=0.000000:end=3.100000,asetpts=PTS-STARTPTS[s0]',
        'anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=0.866667[s1]',
        '[c1]atrim=start=3.100000:end=5.333333,asetpts=PTS-STARTPTS[s2]',
        '[s0][s1][s2]concat=n=3:v=0:a=1[aout]',
      ].join(';'),
    );
  });

  it('frames the close-up 1.5× about the punch-in centre mix(frame centre, P, 0.5), inside the frame', () => {
    // The hero's P (943, 1062.5) is (530.4, 597.7) at 1080×608: the window sits on the bottom edge.
    expect(closeWindow(1080, 608, [530.4, 597.7])).toEqual({ x: 175, y: 202, w: 720, h: 406 });
    expect(closeWindow(1080, 608, [540, 304])).toEqual({ x: 180, y: 101, w: 720, h: 406 });
    expect(closeWindow(1080, 608, [0, 0])).toEqual({ x: 0, y: 0, w: 720, h: 406 });
    expect(closeWindow(608, 1080, [304, 1070])).toEqual({ x: 101, y: 360, w: 406, h: 720 });
  });

  it('names the outputs, and the reference drawing for each j', () => {
    expect(outName('impact-hero', 'mp4', false)).toBe('impact-hero.mp4');
    expect(outName('impact-hero-sheet', 'png', true)).toBe('impact-hero-sheet-portrait.png');
    expect([-8, -1, 0, 1, 2, 31].map(refName)).toEqual(['comp-01.png', 'comp-07.png', 'comp-08.png', 'comp-08.png', 'comp-09.png', 'comp-32.png']);
  });
});

describe('the labels', () => {
  // The hero's frames as design §8's table has them (I 84, limbs drawn on f22, J_end 45).
  const heroPhase = (f: number) => {
    const j = f - I;
    const poster: PosterSpec | undefined = j >= 0 && j <= 8 ? { si: phaseAt(j, 45).kind === 'poster' ? (phaseAt(j, 45) as { si: number }).si : 0, field: 'light', disc: null, minL: 0, redSafe: false, glint: false } : undefined;
    return phaseLabel(phaseAt(j, 45), { age: drawingIndex(f, 12) - drawingIndex(22, 12), group: j >= 9 ? 0 : null, poster });
  };

  it('reads the hero`s frames as the design`s table does', () => {
    expect([19, 20, 29, 30, 34, 35, 69, 70, 76, 77, 83].map(heroPhase)).toEqual(['footage', 'grow 0', 'grow 3', 'pop 0', 'pop 1', 'idle', 'idle', 'coil', 'S0 whip', 'S1 pinned', 'S6 swell']);
    expect([84, 85, 86, 89, 92].map(heroPhase)).toEqual(['IF1 whiteout, light', 'IF1 whiteout, light', 'IF2 split, light', 'IF5 negative cross, light', 'IF7 negative strike, light']);
    expect([93, 116, 129, 130].map(heroPhase)).toEqual(['A0 g0', 'decay 0.93', 'decay 0.00', 'scars']);
  });

  it('says when a poster frame shows no poster, and when it is the glint', () => {
    expect(phaseLabel({ kind: 'poster', si: 0 }, { age: 30, group: null, poster: null })).toBe('IF1 whiteout (no poster)');
    expect(phaseLabel({ kind: 'poster', si: 3 }, { age: 30, group: null, poster: { si: 3, field: 'light', disc: null, minL: 0, redSafe: true, glint: true } })).toBe('IF4 star, glint');
    expect(phaseLabel({ kind: 'hold' }, { age: 40, group: null })).toBe('hold');
    expect(phaseLabel(null, { age: null, group: null })).toBe('footage');
  });

  it('labels a cell with the frame, j, k and kr, the phase, and the tips through the strike', () => {
    expect(frameLabel({ o: 84, c: 84, j: 0, k: 33, phase: 'IF1 whiteout, light', limbs: 'silhouette', tips: 0.4 })).toEqual(['f84 j0 k33 kr7', 'IF1 whiteout, light', 'limbs silhouette, tips 0 px from P']);
    expect(frameLabel({ o: 100, c: 84, j: 0, k: 33, phase: 'IF4 star, light', limbs: null, tips: null })).toEqual(['f84 o100 j0 k33 kr7', 'IF4 star, light']);
    expect(frameLabel({ o: 10, c: 10, j: null, k: 4, phase: 'footage', limbs: null, tips: null })).toEqual(['f10 k4', 'footage']);
    expect(frameLabel({ o: 140, c: 140, j: 56, k: 56, phase: 'scars', limbs: 'grid', tips: null })).toEqual(['f140 j56 k56', 'scars']);
  });
});

describe('the reports', () => {
  it('sums up times: the median, the 90th percentile and the worst', () => {
    expect(stats([5, 1, 9, 3, 7, 2, 8, 4, 6, 10])).toEqual({ n: 10, median: 6, p90: 10, worst: 10 });
    expect(stats([])).toEqual({ n: 0, median: 0, p90: 0, worst: 0 });
  });

  it('holds the main thread to 26 ms and each job to its line', () => {
    const frames: FrameTime[] = [
      { o: 70, clip: 70, j: -14, ms: 10, lines: {} },
      { o: 84, clip: 84, j: 0, ms: 30, lines: {} },
      { o: 140, clip: 140, j: 56, ms: 20, lines: {} },
    ];
    const jobs: JobTime[] = [
      { key: '76', kind: 'limb', due: 76, at: 73, ms: 50 },
      { key: '78', kind: 'limb', due: 78, at: 75, ms: 30 },
      { key: 'p', kind: 'poster', due: 84, at: 81, ms: 7 },
    ];
    const t = timingSummary(frames, jobs, I);
    expect(t.main).toMatchObject({ budget: 26, n: 3, worst: 30, over: 1, worstFrame: { o: 84, j: 0, ms: 30 } });
    expect(t.main.impactWindow).toMatchObject({ from: 74, to: 129, n: 1, worst: 30, over: 1 });
    expect(t.jobs.limb).toMatchObject({ budget: 42, n: 2, worst: 50, over: 1 });
    expect(t.jobs.poster).toMatchObject({ budget: 8, n: 1, over: 0 });
    expect(t.jobs.mass).toMatchObject({ budget: 12, n: 0, over: 0 });
  });

  it('splits the shot as design §8 does: footage, the limbs and their electricity, the strike, the impact frames, the aftermath and the rest', () => {
    const parts = (first: number, last: number, I0: number | null) => shotSpans(first, last, 22, I0).map((sp) => [sp.name, sp.from, sp.to]);
    expect(parts(0, 159, I)).toEqual([
      ['footage', 0, 19],
      ['limbs', 20, 75],
      ['strike', 76, 83],
      ['impact', 84, 92],
      ['aftermath', 93, 115],
      ['after', 116, 159],
    ]);
    expect(parts(70, 100, I)).toEqual([['limbs', 70, 75], ['strike', 76, 83], ['impact', 84, 92], ['aftermath', 93, 100]]);
    expect(parts(0, 40, null)).toEqual([['footage', 0, 19], ['limbs', 20, 40]]);
  });

  it('times each part a frame: the main thread, the drawings due on its frames, and the two together', () => {
    const frames: FrameTime[] = [
      { o: 84, clip: 84, j: 0, ms: 2, lines: { total: 1 } },
      { o: 85, clip: 85, j: 1, ms: 4, lines: { total: 3, glow: 1 } },
      { o: 93, clip: 93, j: 9, ms: 40, lines: {} },
    ];
    const jobs: JobTime[] = [
      { key: 'p0', kind: 'poster', due: 84, at: 81, ms: 20 },
      { key: 'p1', kind: 'poster', due: 86, at: 83, ms: 30 }, // due on a frame not timed here
      { key: '93', kind: 'limb', due: 93, at: 90, ms: 45 },
    ];
    const [impact, after] = segmentTimes(frames, jobs, [
      { name: 'impact', what: 'IF1–IF7', from: 84, to: 92 },
      { name: 'aftermath', what: 'A0–A17', from: 93, to: 115 },
    ]);
    expect(impact).toMatchObject({ name: 'impact', clip: [84, 92], frames: 2, main: { n: 2, worst: 4 }, jobs: { poster: { n: 1, worst: 20 } }, withDrawings: { worst: 22, mean: 13 } });
    expect(impact.jobs).not.toHaveProperty('limb');
    expect(impact.lines).toEqual({ total: 3, glow: 1 });
    expect(after).toMatchObject({ frames: 1, main: { worst: 40 }, jobs: { limb: { n: 1, worst: 45 } }, withDrawings: { mean: 85 } });
  });

  it('keeps the flash report`s verdict, its flashing windows and fields, and every transition', () => {
    const frame = (v: number): CheckFrame => ({ data: new Uint8ClampedArray(160 * 90 * 4).fill(v).map((x, i) => (i % 4 === 3 ? 255 : x)), width: 160, height: 90 });
    const report = checkFlashes(Array.from({ length: 40 }, (_, f) => frame(f % 2 ? 255 : 0)), 30);
    const brief = flashBrief(report);
    expect(brief.pass).toBe(false);
    expect(brief.worstGeneral).toBeGreaterThan(3);
    expect(brief.summary).toMatch(/^This video flashes more than 3 times a second/);
    expect(brief.windows.length).toBeGreaterThan(0);
    expect(brief.windows.every((w) => w.general > 0 || w.red > 0)).toBe(true);
    // Each field keeps its index, so a transition's field can be found.
    expect(brief.fields.length).toBeGreaterThan(0);
    expect(brief.fields.every((f) => report.fields[f.field].x === f.x && report.fields[f.field].y === f.y && report.fields[f.field].general === f.general)).toBe(true);
    expect(brief.transitions).toHaveLength(report.transitions.length);
    expect(brief.transitions[0]).toEqual([report.transitions[0].frame, report.transitions[0].field, report.transitions[0].direction, report.transitions[0].kind]);
    const still = flashBrief(checkFlashes(Array.from({ length: 40 }, () => frame(128)), 30));
    expect(still).toMatchObject({ pass: true, worstGeneral: 0, windows: [], fields: [], transitions: [] });
  });

  it('numbers a window`s report by the output frames it checked, not from 0', () => {
    const frame = (v: number): CheckFrame => ({ data: new Uint8ClampedArray(160 * 90 * 4).fill(v).map((x, i) => (i % 4 === 3 ? 255 : x)), width: 160, height: 90 });
    const report = checkFlashes(Array.from({ length: 40 }, (_, f) => frame(f % 2 ? 255 : 0)), 30);
    expect(atFrames(report, 0)).toBe(report);
    const before = report.windows[0].start;
    const at40 = atFrames(report, 40);
    expect(at40.windows.map((w) => [w.start, w.end])).toEqual(report.windows.map((w) => [w.start + 40, w.end + 40]));
    expect(at40.transitions.map((t) => t.frame)).toEqual(report.transitions.map((t) => t.frame + 40));
    const worst = report.windows.find((w) => w.general === report.worstGeneral)!;
    expect(worst.end).toBeLessThan(40);
    expect(flashSummary(report)).toContain(`frames ${worst.start}–${worst.end}`);
    expect(flashSummary(at40)).toBe(flashSummary(report).replace(`frames ${worst.start}–${worst.end}`, `frames ${worst.start + 40}–${worst.end + 40}`));
    expect(report.windows[0].start).toBe(before); // left as it was
  });
});

describe('the command', () => {
  it('refuses an --out inside the repo before it reads or writes anything', async () => {
    const out = join(REPO, 'renders-wp14-test');
    await expect(main(['--clip', 'missing.mp4', '--drawings', 'missing.json', '--out', out])).rejects.toThrow(/inside the repo/);
    expect(existsSync(out)).toBe(false);
  });

  it('asks for the clip, the drawings and --out', async () => {
    await expect(main([])).rejects.toThrow(/^usage: node scripts\/impact-render\.ts/);
    await expect(main(['--out', 'x', '--clip', 'c.mp4'])).rejects.toThrow(/usage/);
    await expect(main(['--out', 'x', '--clip', 'c.mp4', '--drawings', 'd.json', '--frames', '9-1'])).rejects.toThrow(/--frames/);
  });

  it('runs as a script: a bad command line prints why and exits 1', () => {
    const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'impact-render.ts')], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/usage: node scripts\/impact-render\.ts --clip/);
  });

  it('says the hand keys over f50–74 as the design gives them', () => {
    expect(HAND_KEYS).toEqual([[0, 0], [50, 0], [54, 90], [60, 180], [68, 270], [74, 360], [999, 360]]);
    expect([50, 54, 60, 68, 74].map((f) => turnAt(HAND_KEYS, f))).toEqual([0, 90, 180, 270, 360]);
  });
});
