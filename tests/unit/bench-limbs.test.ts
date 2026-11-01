// WP17: the limb bench (impact design §10, "Device gate"). The bench module
// loads in Node with no DOM, nothing from ../app at run time and no worker of
// its own, and one iteration of each job it times runs on nodeScratch: the
// limb drawing with 12 and with 24 arcs, the stamp, the cutout, the grade and
// the three together. The times are the phone's (bench.html), so nothing here
// asserts one: the medians and the gate are checked with a fake clock.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Path2D } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import {
  BENCH,
  FRAME_JOBS,
  benchGrade,
  createFrameBench,
  createLimbBench,
  drawingOf,
  formatReport,
  gateOf,
  heroHeld,
  layersOf,
  median,
  serveBench,
  standInMask,
  timeFrame,
  timeLimbs,
  timeRuns,
  type BenchReport,
  type Series,
} from '../../src/bench/limbs.ts';
import { arcCount, type LinePath } from '../../src/render/arcs3d.ts';
import type { Scratch } from '../../src/render/glow.ts';
import { nodeScratch } from '../../src/render/headless.ts';

const REPO = resolve(import.meta.dirname, '../..');
const newPath = (): LinePath => new Path2D(); // Node has no global Path2D: drawArcs takes @napi-rs/canvas's
const pixels = (s: Scratch) => s.ctx.getImageData(0, 0, s.canvas.width, s.canvas.height).data;
const sha = (...images: Uint8ClampedArray[]) => images.reduce((h, data) => h.update(data), createHash('sha256')).digest('hex');
const opaque = (data: Uint8ClampedArray) => {
  let n = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) n++;
  return n;
};
const series = (key: string, ms: number[]): Series => ({ key, label: key, ms });
const once = { runs: 1, warm: 0, repeat: 1 };

describe('the bench module', () => {
  it('loads in Node with no DOM, imports nothing from ../app at run time and serves no worker', () => {
    expect(typeof document).toBe('undefined');
    const runtime = (file: string): string[] =>
      [...readFileSync(file, 'utf8').matchAll(/^import\s+(?!type\b)[^;]*?from\s+'(\.[^']+)'/gm)].map((m) => {
        const p = resolve(dirname(file), m[1]);
        return existsSync(p) ? p : `${p}.ts`;
      });
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const dep of runtime(file)) walk(dep);
    };
    walk(resolve(REPO, 'src/bench/limbs.ts'));
    expect(seen.size).toBeGreaterThan(10);
    expect([...seen].filter((f) => f.replaceAll('\\', '/').includes('/src/app/'))).toEqual([]);
    // Plain Node (no vite, no DOM) imports it, and exits: no listener keeps it alive.
    const url = pathToFileURL(resolve(REPO, 'src/bench/limbs.ts')).href;
    const check = "['createLimbBench', 'createFrameBench', 'mountBench', 'serveBench'].every((f) => typeof m[f] === 'function')";
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(url)}); if (!${check}) process.exit(2);`], { cwd: REPO, encoding: 'utf8', timeout: 60_000 });
    expect(run.stderr).not.toMatch(/Error/);
    expect(run.status).toBe(0);
  });

  it('answers a run with no2d where there is no OffscreenCanvas, as in Node', () => {
    const posted: unknown[] = [];
    const scope: { listener?: (e: MessageEvent) => void } = {};
    serveBench({ postMessage: (m) => void posted.push(m), addEventListener: (_type, listener) => void (scope.listener = listener) });
    scope.listener!({ data: { type: 'other' } } as MessageEvent);
    expect(posted).toEqual([]);
    scope.listener!({ data: { type: 'run', ...once } } as MessageEvent);
    expect(posted).toEqual([{ type: 'no2d' }]);
  });

  it('uses no Math.random or Date, and reads the clock only in the page glue', () => {
    const raw = readFileSync(resolve(REPO, 'src/bench/limbs.ts'), 'utf8');
    const code = (s: string) => s.replace(/\/\/.*$/gm, '');
    const glue = raw.indexOf('// ---- In the browser');
    expect(glue).toBeGreaterThan(0);
    expect(code(raw)).not.toMatch(/Math\.random|\bDate\b|\.filter\s*=/);
    expect(code(raw.slice(0, glue))).not.toMatch(/performance\.now/);
  });
});

describe('the hero scene', () => {
  it('has the four test limbs at the test lengths, rooted inside the stand-in mask', () => {
    const limbs = heroHeld();
    expect(limbs.map((l) => l.id)).toEqual([1, 2, 3, 4]);
    expect(limbs.map((l) => l.points.length)).toEqual([32, 32, 32, 32]);
    expect(limbs.map((l) => l.length)).toEqual([446, 447, 432, 435].map((L) => expect.closeTo((L * 608) / 1080, 6)));
    const mask = standInMask();
    expect([mask.width, mask.height]).toEqual([1080, 608]);
    for (const l of limbs) {
      const [x, y] = l.points[0];
      expect(mask.alpha[Math.floor(y) * mask.width + Math.floor(x)], `limb ${l.id}`).toBe(255);
      expect(l.front.slice(0, 5).some(Boolean)).toBe(false); // the root inside him
      expect(l.front.slice(5).every(Boolean)).toBe(true);
    }
  });

  it('draws the strike window, j −8..−1, at 6 arcs a limb and 3 on the phone tier', () => {
    expect(Array.from({ length: 8 }, (_, i) => drawingOf(i).j)).toEqual([-8, -7, -6, -5, -4, -3, -2, -1]);
    expect(drawingOf(8)).toEqual(drawingOf(0));
    for (let i = 0; i < 8; i++) {
      const { phase } = drawingOf(i);
      expect(phase.kind).toBe('strike');
      expect(arcCount(phase)).toBe(6);
      expect(arcCount(phase, 3, true)).toBe(3);
    }
    expect([drawingOf(0).k, drawingOf(7).k]).toEqual([31, 37]); // limbClock on the hero: f76 31, f83 37
    expect([drawingOf(0).swing, drawingOf(1).swing]).toEqual([0, 1]); // none on S0, full from S1
  });

  it('grades with all three ops: the colour fill, the pool round P and the white balance', () => {
    const g = benchGrade();
    expect(g.hueAmt).toBeGreaterThan(0);
    expect(g.pool?.dY).toBeGreaterThan(0);
    expect(g.pool?.c[0]).toBeCloseTo((942 * 608) / 1080, 6);
    expect(g.WB[2]).toBeLessThan(1);
  });
});

describe('one iteration on nodeScratch', () => {
  const limbs = createLimbBench(nodeScratch, { newPath });

  it('draws a limb drawing with 12 and with 24 arcs into both layers, with its glow', () => {
    const { x0, y0, x1, y1 } = limbs.box;
    expect(x0).toBeGreaterThanOrEqual(0);
    expect(y0).toBeGreaterThanOrEqual(0);
    expect(x1).toBeLessThanOrEqual(BENCH.width);
    expect(y1).toBeLessThanOrEqual(BENCH.height);
    expect((x1 - x0) * (y1 - y0)).toBeLessThan(BENCH.width * BENCH.height); // the box, not the frame
    for (const arcs of BENCH.arcs) {
      for (const i of [0, 3]) {
        const stats = limbs.draw(arcs, i);
        expect(stats.arcs, `${arcs} arcs, drawing ${i}`).toBe(arcs);
        expect(stats.glow).toBe(true);
        expect(stats.pulses).toBeGreaterThan(0);
        expect(opaque(pixels(limbs.behind))).toBeGreaterThan(500); // the roots, under the cutout
        expect(opaque(pixels(limbs.front))).toBeGreaterThan(5000);
      }
    }
  });

  it('draws the same pixels for the same drawing and new ones for the next', () => {
    limbs.draw(24, 3);
    const first = sha(pixels(limbs.behind), pixels(limbs.front));
    limbs.draw(24, 5);
    const next = sha(pixels(limbs.behind), pixels(limbs.front));
    limbs.draw(24, 3);
    expect(sha(pixels(limbs.behind), pixels(limbs.front))).toBe(first);
    expect(next).not.toBe(first);
    const other = createLimbBench(nodeScratch, { newPath, scene: limbs.scene });
    other.draw(24, 3);
    expect(sha(pixels(other.behind), pixels(other.front))).toBe(first);
  });

  it('changes the frame with each of the stamp, the cutout, the grade and the three together', () => {
    const frame = createFrameBench(nodeScratch, { scene: limbs.scene, newPath });
    frame.plate();
    const plate = sha(pixels(frame.target));
    const after = new Map<string, string>();
    for (const job of ['stamp', 'cutout', 'grade', 'frame'] as const) {
      frame.plate();
      frame[job]();
      frame.settle();
      after.set(job, sha(pixels(frame.target)));
      expect(after.get(job), job).not.toBe(plate);
    }
    expect(new Set(after.values()).size).toBe(4);
    frame.plate();
    frame.frame();
    expect(sha(pixels(frame.target))).toBe(after.get('frame'));
  });

  it('times every job once the way the page does', () => {
    const clock = () => 0;
    const all = BENCH.arcs.map((arcs) => timeLimbs(limbs, arcs, clock, once));
    expect(all.map((s) => s.arcs)).toEqual([12, 24]);
    const frame = createFrameBench(nodeScratch, { scene: limbs.scene, layers: layersOf(limbs) });
    for (const job of FRAME_JOBS) all.push(timeFrame(frame, job, clock, once));
    expect(all.map((s) => s.key)).toEqual(['limbs12', 'limbs24', 'stamp', 'cutout', 'grade', 'frame', 'readback']);
    expect(all.map((s) => s.ms)).toEqual(all.map(() => [0]));
  });
});

describe('timing and the gate', () => {
  it('times the runs only, after untimed warm-ups and setups', () => {
    let t = 0;
    const ms = timeRuns((i) => void (t += i < 5 ? i + 1 : 1000), () => t, { runs: 5, warm: 2, setup: () => void (t += 7) });
    expect(ms).toEqual([1, 2, 3, 4, 5]);
  });

  it('times a frame job per frame: several in a row, then one readback', () => {
    let t = 0;
    const plates: number[] = [];
    const frame = {
      target: nodeScratch(1, 1),
      plate: () => void plates.push(t),
      grade: () => void (t += 3),
      stamp: () => void (t += 1),
      cutout: () => {},
      frame: () => {},
      settle: () => void (t += 8),
    };
    expect(timeFrame(frame, 'grade', () => t, { runs: 2, warm: 1, repeat: 4 }).ms).toEqual([5, 5]); // (4 × 3 + 8) / 4
    expect(plates).toHaveLength(3); // before every run, untimed
    expect(timeFrame(frame, 'readback', () => t, { runs: 1, warm: 0, repeat: 4 }).ms).toEqual([8]); // once, alone
  });

  it('takes the median, the mean of the middle two for an even count', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([7])).toBe(7);
    expect(median([])).toBeNaN();
  });

  it('passes at 50 ms in the worker and 14 on the main thread, and misses without a worker', () => {
    const worker = (ms: number) => [series('limbs12', [1, 2, 3]), series('limbs24', [ms, ms - 5, ms + 5])];
    const main = (ms: number) => [series('limbs24', [99]), series('stamp', [99]), series('frame', [ms, ms])];
    expect(gateOf(worker(50), main(14))).toEqual({ worker: 50, main: 14, workerPass: true, mainPass: true, pass: true });
    expect(gateOf(worker(50.5), main(14)).pass).toBe(false);
    expect(gateOf(worker(50), main(14.5))).toMatchObject({ workerPass: true, mainPass: false, pass: false });
    expect(gateOf(null, main(1))).toMatchObject({ worker: null, workerPass: false, mainPass: true, pass: false });
    expect(gateOf(worker(1), []).pass).toBe(false);
  });

  it('writes the results to post, with both gate lines and what a miss means', () => {
    const report: BenchReport = {
      runs: 20,
      warm: 5,
      repeat: 10,
      worker: [series('limbs12', [20, 22, 21]), series('limbs24', [30, 31, 29])],
      workerNote: 'OffscreenCanvas 2D',
      main: [series('frame', [15, 16, 15])],
      stamped: 'the worker’s bitmaps',
      hidden: false,
      device: 'test',
    };
    const text = formatReport(report);
    expect(text).toContain('medians of 20 runs at 1080×608, after 5 warm-ups; frame jobs per frame, 10 in a row and read back once');
    expect(text).toContain('worker, limbs24: 30.0 ms (29.0 ms to 31.0 ms); gate ≤ 50 ms: pass');
    expect(text).toContain('main, frame: 15.0 ms (15.0 ms to 16.0 ms); gate ≤ 14 ms: miss');
    expect(text).toContain('gate: miss, WP12 starts from the phone tier');
    expect(text).not.toContain('background');
    const none = formatReport({ ...report, worker: null, workerNote: 'no OffscreenCanvas 2D in a worker', main: [series('frame', [5])], hidden: true });
    expect(none).toContain('worker, limb drawing, 24 arcs: not run; gate ≤ 50 ms: miss');
    expect(none).toContain('worker: no OffscreenCanvas 2D in a worker');
    expect(none).toContain('background');
  });
});
