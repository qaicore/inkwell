// Round 3, F7: the iPhone bench times the slam. The bench (src/bench/slam.ts,
// run from limbs.ts and bench.html) builds a whole synthetic slam on the
// phone, with nothing fetched, and times a whole strike frame and a whole
// aftermath frame on the main thread and the worker's drawings over the
// aftermath, against design §10's lines. Here it runs once in Node with a
// fake clock: what it draws, what it times and how the results read. The
// times are the phone's, so nothing here asserts one. The cut order loses
// design step 2 (the near glow has no switch), and the full tier is uncut.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Path2D } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { BENCH, formatReport, slamGateOf, slamVerdict, tierName, type BenchReport, type Series, type SlamRun } from '../../src/bench/limbs.ts';
import { createSlamBench, SLAM, SLAM_FRAMES, slamInputs, timeSlamFrames, timeSlamLoad, type SlamLoad } from '../../src/bench/slam.ts';
import type { LinePath } from '../../src/render/arcs3d.ts';
import type { Moment } from '../../src/types/effect.ts';
import type { Scratch } from '../../src/render/glow.ts';
import { nodeScratch } from '../../src/render/headless.ts';
import { CUT_ORDER, cutsAt, DEVICE_GATE, MAIN_BUDGET, PHONE_CUTS, tierCuts, UNCUT, WORKER_LOAD } from '../../src/impact/tiers.ts';

const REPO = resolve(import.meta.dirname, '../..');
const newPath = (): LinePath => new Path2D();
const counter = () => {
  let t = 0;
  return () => t++; // every reading 1 ms on: a job read twice costs 1
};
const pixels = (s: Scratch) => s.ctx.getImageData(0, 0, s.canvas.width, s.canvas.height).data;
const notGrey = (data: Uint8ClampedArray) => {
  let n = 0;
  for (let i = 0; i < data.length; i += 4) if (Math.abs(data[i] - 128) > 12 || Math.abs(data[i + 2] - 128) > 12) n++;
  return n;
};

describe('the synthetic slam', () => {
  it('is the hero’s slam: two drawings, contact on f84 at P along d, four limbs and six cracks, built the same every time', () => {
    const a = slamInputs();
    expect(JSON.stringify(a.effect)).toBe(JSON.stringify(slamInputs().effect));
    const moments = a.effect.moments ?? [];
    expect(moments.map((m) => m.kind)).toEqual(['emerge', 'slam']);
    const slam = moments[1] as Moment;
    expect(slam.at * 30).toBeCloseTo(SLAM.I, 9);
    expect(slam.xy).toEqual([942, 1061]);
    expect(slam.frames).toEqual({ count: 7, flash: 'full' });
    expect(a.effect.strokes.filter((s) => s.brush === 'limb').map((s) => s.id)).toEqual([1, 2, 3, 4]);
    expect(a.effect.strokes.filter((s) => s.kind === 'rigid').map((s) => s.id)).toEqual(slam.strokes);
    expect(slam.strokes).toHaveLength(6);
    expect([a.clip.width, a.clip.height, a.clip.frames]).toEqual([1920, 1080, 180]);
    expect(a.clip.personMask(SLAM.I)?.alpha.some((v) => v > 0)).toBe(true);
  });

  it('times the windows design §10 names: the strike j −8..−1, the aftermath j 18–28 and the worker over f93–115', () => {
    expect(SLAM.strike.map((f) => f - SLAM.I)).toEqual([-8, -1]);
    expect(SLAM.aftermath.map((f) => f - SLAM.I)).toEqual([18, 28]);
    expect(SLAM.load).toEqual([93, 115]);
    expect(SLAM.line).toEqual({ main: 26, load: 0.8 });
    expect(SLAM_FRAMES).toEqual(['strike', 'aftermath']);
  });
});

describe('one pass in Node', () => {
  const bench = createSlamBench(nodeScratch, { newPath });

  it('draws the full tier at 1080×608, every timed frame the slam’s and not the plate, its drawings run ahead', () => {
    expect([bench.scene.width, bench.scene.height, bench.scene.cuts.n]).toEqual([1080, 608, 0]);
    // No frame draws a drawing of its own: each is in the store before it renders.
    const own: string[] = [];
    const render = bench.render;
    bench.render = (o) => {
      own.push(...bench.scene.jobs(o - 1).filter((j) => j.due === o).map((j) => j.key));
      render(o);
    };
    const clock = counter();
    const strike = timeSlamFrames(bench, 'strike', clock);
    expect(strike.frames).toEqual([76, 77, 78, 79, 80, 81, 82, 83]);
    expect(strike.ms).toEqual(strike.frames.map(() => 1)); // one reading before the frame, one after its readback
    expect(strike.label).toBe('strike frame, f76–83 (j −8..−1)');
    expect(notGrey(pixels(bench.target))).toBeGreaterThan(5000);
    const after = timeSlamFrames(bench, 'aftermath', clock);
    expect(after.frames).toEqual(Array.from({ length: 11 }, (_, i) => 102 + i));
    expect(after.label).toBe('aftermath frame, f102–112 (j 18–28)');
    expect(notGrey(pixels(bench.target))).toBeGreaterThan(20000); // the fire, the smoke and the lightning
    expect(own).toEqual([]);
  });

  it('times the worker’s drawings due on f93–115, each once, limbs and masses, against the window’s 767 ms', () => {
    const fresh = createSlamBench(nodeScratch, { newPath });
    const load = timeSlamLoad(fresh, counter());
    expect(load.frames).toEqual([93, 115]);
    expect(load.windowMs).toBeCloseTo((23 * 1000) / 30, 9);
    expect(load.jobs.every((j) => j.due >= 93 && j.due <= 115)).toBe(true);
    const kinds = new Set(load.jobs.map((j) => j.kind));
    expect([...kinds].sort()).toEqual(['limb', 'mass']);
    expect(load.jobs.filter((j) => j.kind === 'limb').length).toBeGreaterThanOrEqual(10); // 12 a second, j 9's among them
    expect(load.jobs.length).toBeGreaterThan(40);
    expect(load.jobs.every((j) => j.ms === 1)).toBe(true);
    expect(load.busyMs).toBe(load.jobs.length);
    expect(load.load).toBeCloseTo(load.jobs.length / load.windowMs, 9);
  });

  it('draws the phone tier at PHONE_CUTS, smaller where the cuts take the resolution', () => {
    const phone = createSlamBench(nodeScratch, { newPath, cuts: PHONE_CUTS });
    const c = cutsAt(PHONE_CUTS);
    expect(phone.scene.cuts).toEqual(c);
    expect(phone.scene.width).toBe(Math.round(1080 * c.resolution));
    expect(phone.scene.sceneId).not.toBe(bench.scene.sceneId);
    const s = timeSlamFrames(phone, 'strike', counter());
    expect(s.ms).toHaveLength(8);
  });
});

describe('the lines and the results', () => {
  const frames = (strike: number[], aftermath: number[]): SlamRun['frames'] => [
    { key: 'strike', label: 'strike frame, f76–83 (j −8..−1)', frames: strike.map((_, i) => 76 + i), ms: strike },
    { key: 'aftermath', label: 'aftermath frame, f102–112 (j 18–28)', frames: aftermath.map((_, i) => 102 + i), ms: aftermath },
  ];
  const loadOf = (busyMs: number): SlamLoad => ({
    frames: [93, 115],
    windowMs: 23000 / 30,
    jobs: [
      { kind: 'limb', due: 93, ms: busyMs / 2 },
      { kind: 'mass', due: 94, ms: busyMs / 4 },
      { kind: 'mass', due: 96, ms: busyMs / 4 },
    ],
    busyMs,
    load: busyMs / (23000 / 30),
  });
  const run = (cuts: number, strike: number, aftermath: number, busyMs: number | null): SlamRun => ({
    cuts,
    frames: frames([strike - 1, strike, strike + 1], [aftermath, aftermath + 2, aftermath - 2]),
    load: busyMs === null ? null : loadOf(busyMs),
  });

  it('passes a slam at 26 ms a frame and 80 % of the worker, and misses past either or without the worker', () => {
    const at80 = 0.8 * (23000 / 30);
    expect(slamGateOf(run(0, 26, 26, at80))).toMatchObject({ strike: 26, aftermath: 26, strikePass: true, aftermathPass: true, loadPass: true, pass: true });
    expect(slamGateOf(run(0, 26.5, 20, 100))).toMatchObject({ strikePass: false, pass: false });
    expect(slamGateOf(run(0, 20, 26.5, 100))).toMatchObject({ aftermathPass: false, pass: false });
    expect(slamGateOf(run(0, 20, 20, at80 + 1))).toMatchObject({ loadPass: false, pass: false });
    expect(slamGateOf(run(0, 20, 20, null))).toMatchObject({ load: null, loadPass: false, pass: false });
    expect(slamGateOf({ cuts: 0, frames: [], load: loadOf(1) }).pass).toBe(false);
  });

  it('says what the slam’s lines mean for PHONE_CUTS', () => {
    expect(slamVerdict([])).toBe('slam: not run');
    expect(slamVerdict([run(0, 20, 20, 100), run(6, 10, 10, 50)])).toBe('slam: the full tier fits design §10 on this phone, so PHONE_CUTS can go to 0');
    expect(slamVerdict([run(0, 40, 50, 1000), run(6, 20, 25, 500)])).toBe('slam: 6 cuts fit design §10 on this phone, so PHONE_CUTS stays at 6 or lower');
    expect(slamVerdict([run(0, 40, 50, 1000), run(6, 30, 35, 500)])).toBe('slam: no tier timed fits design §10 on this phone; post these numbers for the cut order');
    expect(tierName(0)).toBe('the full tier');
    expect(tierName(PHONE_CUTS)).toBe((PHONE_CUTS as number) === 0 ? 'the full tier' : 'the phone tier, PHONE_CUTS');
  });

  it('keeps the results’ format: the limb lines as they were, then a line a slam window and one for its worker load, then the verdicts', () => {
    const series = (key: string, ms: number[]): Series => ({ key, label: key, ms });
    const report: BenchReport = {
      runs: 20,
      warm: 5,
      repeat: 10,
      worker: [series('limbs12', [20, 22, 21]), series('limbs24', [30, 31, 29])],
      workerNote: 'OffscreenCanvas 2D',
      main: [series('frame', [15, 16, 15])],
      slam: [run(0, 44, 56, 1012), run(6, 22, 25, 500)],
      slamNote: 'OffscreenCanvas 2D in the worker',
      stamped: 'the worker’s bitmaps',
      hidden: false,
      device: 'test',
    };
    expect(formatReport(report).split('\n')).toEqual([
      'Inkwell limb bench (WP17): medians of 20 runs at 1080×608, after 5 warm-ups; frame jobs per frame, 10 in a row and read back once',
      'worker, limbs12: 21.0 ms (20.0 ms to 22.0 ms)',
      'worker, limbs24: 30.0 ms (29.0 ms to 31.0 ms); gate ≤ 50 ms: pass',
      'main, frame: 15.0 ms (15.0 ms to 16.0 ms); gate ≤ 14 ms: miss',
      'main, strike frame, f76–83 (j −8..−1), cuts 0: 44.0 ms (43.0 ms to 45.0 ms); design ≤ 26 ms: miss',
      'main, aftermath frame, f102–112 (j 18–28), cuts 0: 56.0 ms (54.0 ms to 58.0 ms); design ≤ 26 ms: miss',
      'worker, the drawings due on f93–115, cuts 0: 1012.0 ms in 766.7 ms, 3 drawings (limb 1, mass 2): 132 %; design ≤ 80 %: miss',
      'main, strike frame, f76–83 (j −8..−1), cuts 6: 22.0 ms (21.0 ms to 23.0 ms); design ≤ 26 ms: pass',
      'main, aftermath frame, f102–112 (j 18–28), cuts 6: 25.0 ms (23.0 ms to 27.0 ms); design ≤ 26 ms: pass',
      'worker, the drawings due on f93–115, cuts 6: 500.0 ms in 766.7 ms, 3 drawings (limb 1, mass 2): 65 %; design ≤ 80 %: pass',
      'gate: miss, WP12 starts from the phone tier and records these numbers',
      'slam, cuts 0 (the full tier): miss',
      `slam, cuts 6 (${tierName(6)}): pass`,
      'slam: 6 cuts fit design §10 on this phone, so PHONE_CUTS stays at 6 or lower',
      'worker: OffscreenCanvas 2D; stamped: the worker’s bitmaps; slam: OffscreenCanvas 2D in the worker',
      'device: test',
    ]);
    const noWorker = formatReport({ ...report, slam: [run(0, 44, 56, null)], slamNote: 'no module worker' });
    expect(noWorker).toContain('worker, the drawings due on f93–115, cuts 0: not run; design ≤ 80 %: miss');
    expect(noWorker).toContain('slam: no tier timed fits design §10 on this phone; post these numbers for the cut order');
    expect(noWorker).toContain('; slam: no module worker');
  });
});

describe('the page', () => {
  it('times the full tier and the phone’s, and keeps every element mountBench reads', () => {
    expect(BENCH.slamCuts).toEqual(PHONE_CUTS > 0 ? [0, PHONE_CUTS] : [0]);
    const html = readFileSync(resolve(REPO, 'bench.html'), 'utf8');
    for (const id of ['run', 'copy', 'status', 'verdict', 'results', 'report', 'report-box', 'frame']) expect(html, id).toContain(`id="${id}"`);
    expect(html).toContain("import { mountBench } from '/src/bench/limbs.ts';");
    expect(html).toMatch(/about 25 seconds/);
  });

  it('is fully offline: no URL, fetch or network call in the page or the bench', () => {
    const files = ['bench.html', ...readdirSync(resolve(REPO, 'src/bench')).map((f) => `src/bench/${f}`)];
    expect(files).toContain('src/bench/slam.ts');
    for (const file of files) {
      const text = readFileSync(resolve(REPO, file), 'utf8');
      expect(text, file).not.toMatch(/https?:\/\/|\bfetch\s*\(|import\s*\(\s*['"]http/);
      // Spelled in pieces, or tests/M0/R4.test.ts reads this line as a browser network call.
      expect(text, file).not.toMatch(new RegExp(['XMLHttp' + 'Request', 'Web' + 'Socket', 'Event' + 'Source', 'send' + 'Beacon'].join('|')));
    }
    expect(existsSync(resolve(REPO, 'src/bench/slam.ts'))).toBe(true);
  });

  it('uses no Math.random or Date in the slam bench, and reads no clock there', () => {
    const code = readFileSync(resolve(REPO, 'src/bench/slam.ts'), 'utf8').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/Math\.random|\bDate\b|performance\.now/);
    expect(code).not.toMatch(/from '\.\.\/app\//);
  });
});

describe('the cut order', () => {
  it('takes design step 2 (the near glow) out, and keeps the others in design order as steps 1–6', () => {
    expect(CUT_ORDER.map((c) => c.step)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(CUT_ORDER.map((c) => c.design)).toEqual([1, 3, 4, 5, 6, 7]);
    expect(CUT_ORDER.map((c) => c.name)).not.toContain('near-glow');
    expect(UNCUT.map((c) => [c.design, c.name])).toEqual([[2, 'near-glow']]);
    expect(() => cutsAt(7)).toThrow();
    expect(() => cutsAt(-1)).toThrow();
  });

  it('switches each step on in turn, and leaves the full tier and the export uncut', () => {
    expect(cutsAt(0)).toEqual({ n: 0, lightning2s: false, maxRibbons: undefined, halfParticles: false, tier: 'full', fewerArcs: false, resolution: 1 });
    expect(cutsAt(1).lightning2s).toBe(true);
    expect(cutsAt(2).maxRibbons).toBe(2);
    expect(cutsAt(3).halfParticles).toBe(true);
    expect([cutsAt(3).tier, cutsAt(4).tier]).toEqual(['full', 'phone']);
    expect([cutsAt(4).fewerArcs, cutsAt(5).fewerArcs]).toEqual([false, true]);
    expect([cutsAt(5).resolution, cutsAt(6).resolution]).toEqual([1, 0.75]);
    expect(tierCuts('full')).toBe(0);
    expect(tierCuts('phone')).toBe(PHONE_CUTS);
    expect(PHONE_CUTS).toBeGreaterThanOrEqual(0);
    expect(PHONE_CUTS).toBeLessThanOrEqual(CUT_ORDER.length);
  });

  it('puts design §10’s slam lines in the device gate beside WP17’s, still unmeasured', () => {
    expect(DEVICE_GATE).toEqual({ worker: 50, main: 14, strike: MAIN_BUDGET, aftermath: MAIN_BUDGET, load: WORKER_LOAD, measured: null });
    expect([MAIN_BUDGET, WORKER_LOAD]).toEqual([26, 0.8]);
  });
});
