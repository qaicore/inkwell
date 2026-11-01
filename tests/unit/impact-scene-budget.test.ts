// Design §10's budget (WP12): the table in tiers.ts adds up, and the scene
// holds it in the Node proxy at 1080×608 with the drawings run ahead. Timed,
// so it runs in vitest.config.ts's serial group.
//
// @napi-rs/canvas records draw calls and rasterizes them only when a canvas
// is read or drawn from, so each job reads one pixel of every part it drew,
// and each frame reads one pixel of the frame: the times include the raster.
// Each figure is the median of three passes on fresh scenes, I − 10..I + 45.
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import type { DrawnLayer } from '../../src/impact/contracts.ts';
import { JOB_MS, MAIN_BUDGET, MAIN_LINES, WORKER_LOAD, WORKER_WINDOWS, mainBudget, windowLoad } from '../../src/impact/tiers.ts';
import { plate, sceneOf } from './helpers/impact-scene-clip.ts';
import { HERO } from './helpers/impact-drawings.ts';

const I = HERO.I;
const FROM = I - 10;
const TO = I + 45;
const PASSES = 3;

const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const ms = (t0: bigint) => Number(process.hrtime.bigint() - t0) / 1e6;
const settle = (layer: DrawnLayer) => {
  for (const part of layer.parts) (part.image as { getContext(id: '2d'): { getImageData(x: number, y: number, w: number, h: number): unknown } } | null)?.getContext('2d').getImageData(0, 0, 1, 1);
};

interface Pass {
  frames: Map<number, number>;
  jobs: Map<string, { kind: string; ms: number }>;
}

function pass(): Pass {
  const scene = sceneOf();
  scene.frames3d(); // the physics runs once, ahead of the clip
  const ctx = createCanvas(scene.width, scene.height).getContext('2d');
  const video = plate(scene.width, scene.height);
  const frames = new Map<number, number>();
  const jobs = new Map<string, { kind: string; ms: number }>();
  const run = (o: number) => {
    for (const job of scene.jobs(o)) {
      const t0 = process.hrtime.bigint();
      settle(scene.runJob(job));
      jobs.set(job.key.split(':').slice(2).join(':'), { kind: job.kind, ms: ms(t0) });
    }
  };
  run(FROM - 1);
  for (let o = FROM; o <= TO; o++) {
    run(o);
    const t0 = process.hrtime.bigint();
    scene.render(ctx as never, video, o);
    ctx.getImageData(0, 0, 1, 1); // the raster is done
    frames.set(o, ms(t0));
  }
  return { frames, jobs };
}

let passes: Pass[] | null = null;
const timed = () => (passes ??= Array.from({ length: PASSES }, pass));

describe('the budget table', () => {
  it('adds the main-thread lines up to 26 ms or less, and keeps the worker at 80 % or less in every window', () => {
    expect(mainBudget()).toBe(MAIN_LINES.reduce((s, l) => s + l.node, 0));
    expect(mainBudget()).toBeLessThanOrEqual(MAIN_BUDGET);
    for (const w of WORKER_WINDOWS) expect(windowLoad(w), w.name).toBeLessThanOrEqual(WORKER_LOAD);
    expect(windowLoad(WORKER_WINDOWS.find((w) => w.name === 'aftermath')!)).toBeCloseTo(0.648, 3);
  });
});

describe('the Node proxy at 1080×608', () => {
  it('draws each limb drawing in 42 ms or less, each mass part in 12 and each poster in 8 (median of 3)', () => {
    const all = timed();
    const over: string[] = [];
    const report: Record<string, number> = { limb: 0, mass: 0, poster: 0 };
    for (const [key, { kind }] of all[0].jobs) {
      const t = median(all.map((p) => p.jobs.get(key)?.ms ?? Infinity));
      report[kind] = Math.max(report[kind], t);
      if (t > JOB_MS[kind as keyof typeof JOB_MS]) over.push(`${key} ${t.toFixed(1)}`);
    }
    expect(over, `worst: limb ${report.limb.toFixed(1)}, mass ${report.mass.toFixed(1)}, poster ${report.poster.toFixed(1)}`).toEqual([]);
  });

  it('draws every main-thread frame in 26 ms or less with the drawings run ahead (median of 3)', () => {
    const all = timed();
    const over: string[] = [];
    let worst = 0;
    const each: number[] = [];
    for (let o = FROM; o <= TO; o++) {
      const t = median(all.map((p) => p.frames.get(o)!));
      each.push(t);
      worst = Math.max(worst, t);
      if (t > MAIN_BUDGET) over.push(`j${o - I} ${t.toFixed(1)}`);
    }
    expect(over, `worst ${worst.toFixed(1)} ms, median frame ${median(each).toFixed(1)} ms`).toEqual([]);
  });
});
