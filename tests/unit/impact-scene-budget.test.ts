// Design §10's budget (WP12): the table in tiers.ts adds up, and the scene
// holds it in the Node proxy at 1080×608 with the drawings run ahead. Timed,
// so it runs in vitest.config.ts's serial group.
//
// @napi-rs/canvas records draw calls and rasterizes them only when a canvas
// is read or drawn from, so each job reads one pixel of every part it drew,
// and each frame reads one pixel of the frame: the times include the raster.
// Each figure is the median of three passes on fresh scenes, I − 10..I + 45.
//
// Decision 20: the limbs' physics, by the scene's own clock, and the page
// while a rebuilt scene's physics is worked out in its worker
// (lift/sim-worker.ts, here in a Node worker thread).
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { impactClip, impactScene, type ClipData } from '../../src/app/engine.ts';
import type { SceneData } from '../../src/app/render-worker.ts';
import type { DrawnLayer } from '../../src/impact/contracts.ts';
import { keepPhysics, unpackPhysics, type ImpactScene, type PackedPhysics } from '../../src/impact/scene.ts';
import { nodeScratch } from '../../src/render/headless.ts';
import { JOB_MS, MAIN_BUDGET, MAIN_LINES, WORKER_LOAD, WORKER_WINDOWS, mainBudget, windowLoad } from '../../src/impact/tiers.ts';
import type { Effect } from '../../src/types/effect.ts';
import { DRAWN, FRAMES, plate, sceneClip, sceneOf } from './helpers/impact-scene-clip.ts';
import { HERO } from './helpers/impact-drawings.ts';

const I = HERO.I;
const FROM = I - 10;
const TO = I + 45;
const PASSES = 3;

// Decision 11: the Node proxy asserts about 1.5 × the worst it measures
// today, so it catches a regression without failing on the design's targets,
// which stay in tiers.ts (the device bench and Qai's iPhone run hold those).
// Each limit below gives the design number and today's (Nov 2, Node 24,
// 1080×608, median of 3, under the whole unit suite: its serial group, four
// runs for the jobs and five for the frames). The handover lists every Node
// number still over the design.
const NODE_JOB_MS = {
  limb: 70, // design JOB_MS.limb 42; today 36.6–47.1 (the worst f103)
  mass: 37, // design JOB_MS.mass 12; today 11.5–24.8 (the worst the f112 cluster)
  poster: 132, // design JOB_MS.poster 8; today 76.9–88.1 (IF1's first light poster, which traces him)
} as const;
const NODE_MAIN_MEDIAN = 44; // design MAIN_BUDGET 26 a frame; today's median frame 27.5–29.4
const NODE_MAIN_WORST = 92; // design MAIN_BUDGET 26; today's worst frame 52.4–61.5 (j−1, j19, j22: the strike's last drawing, the floods and the lightning)
// The physics a clip frame, each on a fresh clip (new inputs, so worked out
// again; the scan stays with its mask): 180 frames, four limbs, the egg alone.
const NODE_PHYSICS_MS = 13; // design 1 ms a clip frame (decision 20); today 9.0–9.2 with R1's rope (8.3–8.9 before it; round 3's code: 20.3–24.7)
// Decision 20's line for the page while a scene is rebuilt, asserted as it
// is: building it and showing the limbs as drawn, taking the physics when it
// comes, and the longest the page's thread is held from the ask to then.
const PAGE_TASK_MS = 100; // design 100 ms; today the build 3.7–14.7, the arrival 3.0–11.2, held at most 22.8–56.6

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
  it('draws each limb drawing in 70 ms or less, each mass part in 37 and each poster in 132 (median of 3; decision 11)', () => {
    const all = timed();
    const over: string[] = [];
    const overDesign: string[] = [];
    const report: Record<string, number> = { limb: 0, mass: 0, poster: 0 };
    for (const [key, { kind }] of all[0].jobs) {
      const t = median(all.map((p) => p.jobs.get(key)?.ms ?? Infinity));
      report[kind] = Math.max(report[kind], t);
      if (t > JOB_MS[kind as keyof typeof JOB_MS]) overDesign.push(`${kind} ${key} ${t.toFixed(1)}`);
      if (t > NODE_JOB_MS[kind as keyof typeof NODE_JOB_MS]) over.push(`${key} ${t.toFixed(1)}`);
    }
    // For the handover: the jobs still over the design's table.
    console.log(`jobs over design (limb ${JOB_MS.limb}, mass ${JOB_MS.mass}, poster ${JOB_MS.poster} ms): ${overDesign.join('; ') || 'none'}`);
    const worst = `worst: limb ${report.limb.toFixed(1)}, mass ${report.mass.toFixed(1)}, poster ${report.poster.toFixed(1)}`;
    console.log(`jobs ${worst} ms (median of ${PASSES})`);
    expect(over, worst).toEqual([]);
  });

  it('draws the median main-thread frame in 44 ms or less and the worst in 92, with the drawings run ahead (median of 3; decision 11)', () => {
    const all = timed();
    const overDesign: string[] = [];
    let worst = 0;
    const each: number[] = [];
    for (let o = FROM; o <= TO; o++) {
      const t = median(all.map((p) => p.frames.get(o)!));
      each.push(t);
      worst = Math.max(worst, t);
      if (t > MAIN_BUDGET) overDesign.push(`j${o - I} ${t.toFixed(1)}`);
    }
    const mid = median(each);
    // For the handover: the frames still over the design's 26 ms.
    console.log(`main thread: median ${mid.toFixed(1)} ms, worst ${worst.toFixed(1)} ms; over design ${MAIN_BUDGET} ms: ${overDesign.join(', ') || 'none'}`);
    expect(mid, `median frame ${mid.toFixed(1)} ms`).toBeLessThanOrEqual(NODE_MAIN_MEDIAN);
    expect(worst, `worst frame ${worst.toFixed(1)} ms`).toBeLessThanOrEqual(NODE_MAIN_WORST);
  });
});

describe('the limbs’ physics in the Node proxy', () => {
  it('works the physics out in 13 ms a clip frame or less (median of 3; decision 11)', () => {
    const each = Array.from({ length: PASSES }, () => sceneOf({}, { clock: () => performance.now() }).timings().physics);
    const mid = median(each);
    console.log(`physics: ${each.map((t) => t.toFixed(2)).join(', ')} ms a clip frame (median ${mid.toFixed(2)}; design 1)`);
    expect(mid, `physics ${mid.toFixed(2)} ms a clip frame`).toBeLessThanOrEqual(NODE_PHYSICS_MS);
  });

  it('holds the page no more than 100 ms at a time while a rebuilt scene’s physics is worked out in its worker (decision 20)', async () => {
    // The worker: lift/sim-worker.ts served in a Node worker thread.
    const sim = new URL('../../src/lift/sim-worker.ts', import.meta.url).href;
    const worker = new Worker(
      `const { parentPort } = require('node:worker_threads');
      import(${JSON.stringify(sim)}).then(({ serveSim }) => {
        serveSim({ postMessage: (m, t) => parentPort.postMessage(m, t), addEventListener: (_, l) => parentPort.on('message', (data) => l({ data })) });
        parentPort.postMessage({ type: 'ready' });
      });`,
      { eval: true },
    );
    try {
      await once(worker, 'message');
      const sc = sceneClip();
      const person = sc.clip.personMask(0);
      const data: ClipData = { width: sc.clip.width, height: sc.clip.height, frames: FRAMES, masks: Array.from({ length: FRAMES }, () => person), faces: null, bodies: null, units: [...(sc.clip.units ?? [])], id: 'clip p' };
      let last = performance.now();
      let held = 0;
      const tick = setInterval(() => {
        const now = performance.now();
        held = Math.max(held, now - last);
        last = now;
      }, 5);
      // What the page does with a scene: builds it, and reads the limbs and
      // his turn as a frame shows them (the frame's drawing is the budget's above).
      const show = (effect: Effect): ImpactScene => {
        const scene = impactScene(effect, impactClip(data, sc.clip.poses), { tier: 'full', make: nodeScratch, size: 1080, physics: 'wait' })!;
        scene.frames3d();
        scene.turn();
        scene.bodies();
        scene.tubesAt(DRAWN);
        return scene;
      };
      const rebuild = async (effect: Effect, clip: boolean) => {
        const t0 = performance.now();
        if (clip) worker.postMessage({ type: 'clip', clip: data });
        const waiting = show(effect);
        const ask: SceneData = { effect, poses: [...sc.clip.poses], tier: 'full', size: 1080 };
        worker.postMessage({ type: 'run', key: waiting.physicsKey, scene: ask });
        const build = performance.now() - t0;
        const [reply] = (await once(worker, 'message')) as [{ type: string; physics: PackedPhysics; message?: string }];
        const t1 = performance.now();
        if (reply.type !== 'physics') throw new Error(`the worker's run failed: ${reply.message}`);
        keepPhysics(unpackPhysics(reply.physics));
        const done = show(effect);
        const arrival = performance.now() - t1;
        return { waiting: waiting.waiting, done: done.waiting, worker: t1 - t0 - build, build, arrival };
      };
      // The first scene, then the same with a limb moved: the page's thread
      // the first time, and once its code has run.
      const first = await rebuild(sc.effect, true);
      const [limb, ...rest] = sc.effect.strokes;
      const moved = { ...limb, views: { front: { ...limb.views.front, points: limb.views.front.points.map(([x, y]): [number, number] => [x + 0.05, y]) } } };
      const second = await rebuild({ ...sc.effect, strokes: [moved, ...rest] }, false);
      await new Promise((resolve) => setTimeout(resolve, 20));
      clearInterval(tick);
      const said = (r: typeof first) => `build ${r.build.toFixed(1)}, worker ${r.worker.toFixed(0)}, arrival ${r.arrival.toFixed(1)} ms`;
      console.log(`rebuild: first ${said(first)}; again ${said(second)}; the page held at most ${held.toFixed(1)} ms (design ${PAGE_TASK_MS})`);
      for (const r of [first, second]) {
        expect([r.waiting, r.done]).toEqual([true, false]);
        expect(r.build, said(r)).toBeLessThanOrEqual(PAGE_TASK_MS);
        expect(r.arrival, said(r)).toBeLessThanOrEqual(PAGE_TASK_MS);
      }
      expect(held, `held ${held.toFixed(1)} ms`).toBeLessThanOrEqual(PAGE_TASK_MS);
    } finally {
      await worker.terminate();
    }
  });

  // R5, S2: the page's first paint of a rebuilt scene asks which drawings the
  // frame lacks (scene.missing) and holds the last frame while the render-ahead's
  // worker makes them, instead of drawing them in one task. What it does itself
  // is the ask; the drawings it leaves out are the jobs below, which the budget
  // above times (design 42 ms a limb drawing, 12 a mass part, 8 a poster; the
  // first page-side draw measured 137 to 319 ms in the dev app).
  it('asks for a rebuilt scene’s first frame, at a strike frame and an aftermath frame, in a few ms, leaving its limb, mass and poster drawings to the worker (R5, S2)', () => {
    // As the page has it, waiting for the physics (its limbs as drawn), then with the physics worked out and kept.
    const waiting = sceneOf({}, { physics: 'wait' });
    const worked = sceneOf();
    worked.frames3d();
    for (const scene of [waiting, worked]) {
      for (const o of [I - 3, I + 20]) {
        const t0 = performance.now();
        const lacking = scene.missing(o);
        const asked = performance.now() - t0;
        expect(lacking.length, `frame ${o} lacks drawings`).toBeGreaterThan(0);
        expect(asked, `ask ${asked.toFixed(2)} ms`).toBeLessThanOrEqual(PAGE_TASK_MS); // today a few ms
      }
      expect(scene.missing(I + 20).some((job) => job.kind === 'mass')).toBe(true);
    }
  });
});
