// Round 5, S2: the first paint of a rebuilt scene. A scene just built has none
// of its drawings, and drawing a frame's limbs, masses and posters on the page
// is one task of 100 to 330 ms (round 4's asks:2 and technical:3). The page
// asks the render-ahead's worker for them instead (`ready`) and holds the last
// good frame until they come. Offline: the synthetic slam and a stand-in worker
// that answers as render-worker.ts's would, with the scene's own drawings.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOLD_MS, slicedAhead, startRenderAhead, type RenderAhead } from '../../src/app/render-worker.ts';
import type { ImpactScene } from '../../src/impact/scene.ts';
import { HERO } from './helpers/impact-drawings.ts';
import { sceneOf } from './helpers/impact-scene-clip.ts';

const I = HERO.I;

type Reply = 'draw' | 'fail' | 'silent';

// A worker that answers the page's messages when `deliver` is called.
class FakeWorker {
  static twin: ImpactScene | null = null;
  static sceneId: string | null = null; // what it says it built; missing = the twin's
  static reply: Reply = 'draw';
  static instance: FakeWorker | null = null;
  asked: string[] = [];
  private inbox: unknown[] = [];
  private listeners: ((e: MessageEvent) => void)[] = [];
  constructor() {
    FakeWorker.instance = this;
  }
  postMessage(data: { type: string; id: number; key: string }) {
    if (data.type === 'hello') this.inbox.push({ type: 'ready', has2d: true });
    else if (data.type === 'scene') this.inbox.push({ type: 'scene', id: data.id, sceneId: FakeWorker.sceneId ?? FakeWorker.twin!.sceneId });
    else if (data.type === 'job') {
      this.asked.push(data.key);
      if (FakeWorker.reply === 'draw') this.inbox.push({ type: 'layer', id: data.id, layer: FakeWorker.twin!.runJob(data.key) });
      else if (FakeWorker.reply === 'fail') this.inbox.push({ type: 'failed', id: data.id, key: data.key, message: 'no canvas' });
    }
  }
  deliver() {
    for (const data of this.inbox.splice(0)) this.listeners.forEach((l) => l({ data } as MessageEvent));
  }
  addEventListener(type: string, listener: (e: MessageEvent) => void) {
    if (type === 'message') this.listeners.push(listener);
  }
  removeEventListener(type: string, listener: (e: MessageEvent) => void) {
    if (type === 'message') this.listeners = this.listeners.filter((l) => l !== listener);
  }
  terminate() {}
}

// The page's scene, its twin in the worker, and the first output frame at or
// after I − 6 that the page's scene lacks drawings for.
function setup(reply: Reply = 'draw', sceneId: string | null = null) {
  const page = sceneOf();
  FakeWorker.twin = sceneOf();
  FakeWorker.reply = reply;
  FakeWorker.sceneId = sceneId;
  let o = I - 6;
  while (page.missing(o).length === 0) o++;
  return { page, o };
}

async function start(): Promise<{ ahead: RenderAhead; worker: FakeWorker }> {
  vi.stubGlobal('Worker', FakeWorker);
  const starting = startRenderAhead();
  const worker = FakeWorker.instance!;
  worker.deliver(); // ready
  return { ahead: await starting, worker };
}

describe('the page asks before it draws a rebuilt scene’s first frame', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    FakeWorker.instance = null;
  });

  it('lists the drawings a frame lacks: the limbs, masses and posters due on it, none once they are drawn', () => {
    const scene = sceneOf();
    let o = I - 6;
    while (scene.missing(o).length === 0) o++;
    const jobs = scene.missing(o);
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.every((job) => job.due === o && ['limb', 'mass', 'poster'].includes(job.kind))).toBe(true);
    expect(scene.missing(o).map((job) => job.key)).toEqual(jobs.map((job) => job.key)); // asking draws nothing
    for (const job of jobs) scene.runJob(job);
    expect(scene.missing(o)).toEqual([]);
    expect(scene.missing(2)).toEqual([]); // before anything is due
  });

  it('is not ready until the worker has said it built the same scene, then asks for what the frame lacks, once, and is ready when it all arrives', async () => {
    const { page, o } = setup();
    const { ahead, worker } = await start();
    let arrivals = 0;
    ahead.arrived = () => arrivals++;
    ahead.scene(page, {} as never);
    expect(ahead.ready(o)).toBe(false);
    expect(worker.asked).toEqual([]); // nothing goes out before the worker has the scene
    worker.deliver(); // its word on the scene
    expect(arrivals).toBe(1);
    const lacking = page.missing(o).map((job) => job.key);
    expect(ahead.ready(o)).toBe(false);
    expect(worker.asked).toEqual(lacking.slice(0, 6));
    expect(ahead.ready(o)).toBe(false); // asked once
    expect(worker.asked).toHaveLength(Math.min(6, lacking.length));
    for (let turn = 0; turn < 10 && !ahead.ready(o); turn++) worker.deliver(); // the drawings
    expect(arrivals).toBeGreaterThan(1);
    expect(ahead.ready(o)).toBe(true);
    expect(page.missing(o)).toEqual([]);
  });

  it('is ready at once for a frame that lacks nothing, even before the worker has answered', async () => {
    const { page } = setup();
    const { ahead } = await start();
    ahead.scene(page, {} as never);
    expect(ahead.ready(2)).toBe(true);
  });

  it('is ready, so the page draws the frame, once the worker has failed every drawing it lacks', async () => {
    const { page, o } = setup('fail');
    const { ahead, worker } = await start();
    ahead.scene(page, {} as never);
    worker.deliver();
    expect(ahead.ready(o)).toBe(false);
    for (let turn = 0; turn < 10 && !ahead.ready(o); turn++) worker.deliver();
    expect(ahead.ready(o)).toBe(true);
    expect(page.missing(o).length).toBeGreaterThan(0); // none drawn: the page does it
  });

  it('is ready when the worker built another scene than the page’s, and draws nothing for it', async () => {
    const { page, o } = setup('draw', 'another scene');
    const { ahead, worker } = await start();
    ahead.scene(page, {} as never);
    expect(ahead.ready(o)).toBe(false);
    worker.deliver();
    expect(ahead.ready(o)).toBe(true);
    expect(worker.asked).toEqual([]);
  });

  it('is ready when the worker has said nothing for HOLD_MS', async () => {
    const { page, o } = setup('silent');
    const { ahead, worker } = await start();
    ahead.scene(page, {} as never);
    worker.deliver();
    expect(ahead.ready(o)).toBe(false);
    const t = performance.now();
    vi.spyOn(performance, 'now').mockReturnValue(t + HOLD_MS + 1);
    expect(ahead.ready(o)).toBe(true);
  });

  it('starts over for a new scene, and the main-thread render-ahead is always ready (it draws between frames)', async () => {
    const { page, o } = setup();
    const { ahead, worker } = await start();
    ahead.scene(page, {} as never);
    worker.deliver();
    ahead.ready(o);
    const next = sceneOf({ flash: 'safe' });
    FakeWorker.twin = sceneOf({ flash: 'safe' });
    ahead.scene(next, {} as never);
    expect(ahead.ready(o)).toBe(next.missing(o).length === 0); // not heard yet for this one
    const sliced = slicedAhead(() => {});
    sliced.scene(next, null);
    expect(sliced.ready(o)).toBe(true);
  });
});
