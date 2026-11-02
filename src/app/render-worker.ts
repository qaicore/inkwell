// Render-ahead for the impact preview (impact design §10; WP13). The scene
// (impact/scene.ts) lists the drawings due over the next frames, its jobs, and
// each is pure in the effect, the clip's cached data and its key, so they can
// be drawn before the frames that show them:
//   - In a worker, on OffscreenCanvas. The page hands it the clip's data once
//     (engine.ts's ClipData) and each new scene's effect and anchor track; it
//     builds the same scene (the same sceneId, so the same job keys), draws
//     each job it's sent, and posts the parts back as ImageBitmaps, their glow
//     as recorded calls. The page's scene keeps them (put), and its frames
//     stamp them.
//   - Where a worker has no OffscreenCanvas 2D, or there's no module worker,
//     the same jobs run on the main thread, one at a time between frames, and
//     the preview draws at 0.75 resolution (SLICED_SIZE).
// A frame never waits for a job: frameLayers draws whatever is still missing
// itself. The same file is the worker: run in a worker scope it serves the
// page (the guard at the bottom), and anywhere else it only defines things.
import type { Effect } from '../types/effect.ts';
import type { DrawingJob, DrawnLayer, DrawnPart, Tier } from '../impact/contracts.ts';
import { createImpactScene, type ImpactScene } from '../impact/scene.ts';
import { CUT_RESOLUTION } from '../impact/tiers.ts';
import type { BoilParams } from '../motion/boil.ts';
import type { Pose } from '../track/tracking.ts';
import { browserScratch, impactClip, type ClipData } from './engine.ts';

export const PREVIEW_SIZE = 1080; // the internal frame's long side (design §10)
export const SLICED_SIZE = Math.round(PREVIEW_SIZE * CUT_RESOLUTION); // on the main thread: 810
const IN_FLIGHT = 6; // jobs the worker is asked for at once
const START_MS = 10_000; // how long the worker may take to say it's there

// What a worker needs to build the page's scene, besides the clip's data.
export interface SceneData {
  effect: Effect;
  poses: Pose[]; // the anchor track (engine.ts's anchorTrack)
  tier: Tier;
  size: number; // the internal frame's long side
  cuts?: number;
  boil?: BoilParams;
}

type ToWorker =
  | { type: 'hello' }
  | { type: 'clip'; clip: ClipData }
  | { type: 'scene'; id: number; scene: SceneData }
  | { type: 'job'; id: number; key: string };
type FromWorker =
  | { type: 'ready'; has2d: boolean }
  | { type: 'scene'; id: number; sceneId: string }
  | { type: 'layer'; id: number; layer: DrawnLayer }
  | { type: 'failed'; id: number; key: string; message: string };

interface WorkerScope {
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (e: MessageEvent<ToWorker>) => void): void;
}

// The scene a SceneData describes, on any thread: the page's and the worker's
// are built by this one function, so their ids match.
export function sceneFrom(clip: ClipData, data: SceneData): ImpactScene {
  return createImpactScene(data.effect, impactClip(clip, data.poses), { tier: data.tier, make: browserScratch, size: data.size, cuts: data.cuts, boil: data.boil });
}

// What runs the jobs, for the page.
export interface RenderAhead {
  readonly mode: 'worker' | 'main';
  readonly size: number; // the preview's internal long side: PREVIEW_SIZE in a worker, SLICED_SIZE on the main thread
  clip(data: ClipData | null): void; // a new clip, or new tracking
  scene(scene: ImpactScene | null, data: SceneData | null): void; // the scene the page draws now
  ahead(o: number): void; // after output frame o is on screen: the drawings due next
  dispose(): void;
}

// Starts the worker on this same file and asks whether it can draw; without
// one that can, the jobs run on the main thread.
export function startRenderAhead(): Promise<RenderAhead> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./render-worker.ts', import.meta.url), { type: 'module' });
    } catch (err) {
      console.info('No module worker for the render-ahead; it runs between frames.', err);
      resolve(slicedAhead());
      return;
    }
    const fallBack = (why: string) => {
      clearTimeout(timer);
      worker.terminate();
      console.info(`The render-ahead runs between frames: ${why}.`);
      resolve(slicedAhead());
    };
    const timer = setTimeout(() => fallBack('the worker gave no answer'), START_MS);
    const hello = (e: MessageEvent<FromWorker>) => {
      if (e.data?.type !== 'ready') return;
      worker.removeEventListener('message', hello);
      if (!e.data.has2d) return fallBack('no OffscreenCanvas 2D in a worker');
      clearTimeout(timer);
      resolve(workerAhead(worker));
    };
    worker.addEventListener('message', hello);
    worker.addEventListener('error', (e) => fallBack(`the worker didn't start (${e.message || 'no detail'})`));
    worker.postMessage({ type: 'hello' } satisfies ToWorker);
  });
}

// The page's side of the worker. Each scene gets an id; answers for an older
// one are dropped, and its jobs go out only once the worker has built the
// same scene.
function workerAhead(worker: Worker): RenderAhead {
  let id = 0;
  let current: ImpactScene | null = null;
  let same = false;
  const asked = new Set<string>();
  worker.addEventListener('message', (e: MessageEvent<FromWorker>) => {
    const msg = e.data;
    if (msg.type === 'scene' && msg.id === id && current) {
      same = msg.sceneId === current.sceneId;
      if (!same) console.warn(`The render-ahead worker built scene ${msg.sceneId}, not ${current.sceneId}; the page draws every drawing itself.`);
    } else if (msg.type === 'layer') {
      asked.delete(msg.layer.key);
      if (msg.id === id && current) current.put(msg.layer);
    } else if (msg.type === 'failed') {
      asked.delete(msg.key);
      if (msg.id === id) console.warn(`The render-ahead worker couldn't draw ${msg.key}: ${msg.message}`);
    }
  });
  return {
    mode: 'worker',
    size: PREVIEW_SIZE,
    clip: (data) => {
      if (data) worker.postMessage({ type: 'clip', clip: data } satisfies ToWorker);
    },
    scene: (scene, data) => {
      id++;
      current = scene;
      same = false;
      asked.clear();
      if (scene && data) worker.postMessage({ type: 'scene', id, scene: data } satisfies ToWorker);
    },
    ahead: (o) => {
      if (!current || !same) return;
      for (const job of current.jobs(o)) {
        if (asked.size >= IN_FLIGHT) break;
        if (asked.has(job.key)) continue;
        asked.add(job.key);
        worker.postMessage({ type: 'job', id, key: job.key } satisfies ToWorker);
      }
    },
    dispose: () => worker.terminate(),
  };
}

// The jobs on the main thread, one a task so frames paint between them, the
// soonest due first; a job whose frame has gone by is dropped.
export function slicedAhead(defer: (run: () => void) => void = (run) => void setTimeout(run, 0)): RenderAhead & { pending(): readonly DrawingJob[] } {
  let current: ImpactScene | null = null;
  let shown = -1;
  let scheduled = false;
  const queue: DrawingJob[] = [];
  const pump = () => {
    scheduled = false;
    let job = queue.shift();
    while (job && job.due <= shown) job = queue.shift();
    if (!job || !current) return;
    try {
      current.runJob(job);
    } catch (err) {
      console.warn(`Couldn't draw ${job.key} ahead`, err);
    }
    schedule();
  };
  const schedule = () => {
    if (scheduled || queue.length === 0) return;
    scheduled = true;
    defer(pump);
  };
  return {
    mode: 'main',
    size: SLICED_SIZE,
    clip: () => {},
    scene: (scene) => {
      current = scene;
      queue.length = 0;
    },
    ahead: (o) => {
      shown = o;
      if (!current) return;
      const queued = new Set(queue.map((job) => job.key));
      for (const job of current.jobs(o)) if (!queued.has(job.key)) queue.push(job);
      queue.sort((a, b) => a.due - b.due);
      schedule();
    },
    dispose: () => {
      current = null;
      queue.length = 0;
    },
    pending: () => queue,
  };
}

// ---- The worker -------------------------------------------------------------------------------

// A layer ready to post: each part's canvas copied into an ImageBitmap (the
// worker's scene keeps its canvas), its glow calls as they are.
export async function toTransfer(layer: DrawnLayer, bitmap: (image: unknown) => Promise<ImageBitmap>): Promise<{ layer: DrawnLayer; transfer: ImageBitmap[] }> {
  const transfer: ImageBitmap[] = [];
  const parts = await Promise.all(
    layer.parts.map(async (part): Promise<DrawnPart> => {
      if (!part.image || part.width <= 0 || part.height <= 0) return { ...part, image: null };
      const image = await bitmap(part.image);
      transfer.push(image);
      return { ...part, image };
    }),
  );
  return { layer: { ...layer, parts }, transfer };
}

const has2d = () => {
  try {
    return typeof OffscreenCanvas !== 'undefined' && new OffscreenCanvas(1, 1).getContext('2d') !== null;
  } catch {
    return false;
  }
};

// The worker's side: the clip's data, then a scene per id, then its jobs.
export function serveJobs(scope: WorkerScope): void {
  let clip: ClipData | null = null;
  let own: { id: number; scene: ImpactScene } | null = null;
  scope.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg?.type === 'hello') return scope.postMessage({ type: 'ready', has2d: has2d() });
    if (msg?.type === 'clip') {
      clip = msg.clip;
      own = null;
      return;
    }
    if (msg?.type === 'scene') {
      if (!clip) return;
      own = { id: msg.id, scene: sceneFrom(clip, msg.scene) };
      return scope.postMessage({ type: 'scene', id: msg.id, sceneId: own.scene.sceneId });
    }
    if (msg?.type !== 'job' || !own || own.id !== msg.id) return;
    const { id, scene } = own;
    try {
      const layer = scene.runJob(msg.key);
      void toTransfer(layer, (image) => createImageBitmap(image as OffscreenCanvas)).then(
        ({ layer: ready, transfer }) => scope.postMessage({ type: 'layer', id, layer: ready }, transfer),
        (err: unknown) => scope.postMessage({ type: 'failed', id, key: msg.key, message: err instanceof Error ? err.message : String(err) }),
      );
    } catch (err) {
      scope.postMessage({ type: 'failed', id, key: msg.key, message: err instanceof Error ? err.message : String(err) });
    }
  });
}

// In a worker scope this file is the render-ahead's worker.
const workerScope = globalThis as unknown as { WorkerGlobalScope?: abstract new () => unknown };
if (typeof workerScope.WorkerGlobalScope === 'function' && globalThis instanceof workerScope.WorkerGlobalScope) serveJobs(globalThis as unknown as WorkerScope);
