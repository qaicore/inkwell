// The limbs' physics off the page (decision 20). The rope round his body
// (impact/scene.ts's physics: the strike controller, the collisions) takes
// seconds for a clip, too long for the page's thread, so in the app it's
// worked out in a worker:
//   - The page hands the worker the clip's data once (engine.ts's ClipData,
//     whose id names it on both threads, so both key the physics alike) and
//     asks for each new scene's physics (the render-ahead's SceneData). The
//     worker builds the same scene, works its physics out and posts it back
//     packed (packPhysics: a few flat arrays, moved, not copied); the page
//     keeps it by its key (keepPhysics) and builds the scene again with it.
//   - Until it comes, the page's scene shows the limbs as drawn (the scene's
//     'wait'), and anything else he changes meanwhile (Reduce flashing, the
//     aftermath) takes what's kept.
//   - One physics at a time, the newest asked for: an older ask that hasn't
//     started is dropped. The worker keeps the last few itself, and his
//     body's scan stays with the clip's masks (lift/collide.ts), so asking
//     again, or for the same clip, is quicker.
// Without a module worker the page works the physics out itself. The same
// file is the worker: run in a worker scope it serves the page (the guard at
// the bottom), and anywhere else it only defines things.
import type { SceneData } from '../app/render-worker.ts';
import { impactClip, impactScene, type ClipData } from '../app/engine.ts';
import { forgetPhysics, packPhysics, type PackedPhysics } from '../impact/scene.ts';

type ToWorker = { type: 'clip'; clip: ClipData } | { type: 'run'; key: string; scene: SceneData };
type FromWorker = { type: 'physics'; physics: PackedPhysics } | { type: 'failed'; key: string; message: string };

export interface SimScope {
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (e: MessageEvent<ToWorker>) => void): void;
}

// What works the physics out, for the page.
export interface Sim {
  clip(data: ClipData): void; // a new clip, or new tracking
  run(key: string, scene: SceneData): void; // the physics of the scene whose physicsKey this is; it comes to `done`
  dispose(): void;
}

// Starts the worker on this same file. `done` gets each physics worked out;
// `failed` a run that threw (with its key) or a worker that didn't start
// (null), after which the page works the physics out itself. Null where
// there's no module worker.
export function startSim(done: (physics: PackedPhysics) => void, failed: (key: string | null, message: string) => void): Sim | null {
  let worker: Worker;
  try {
    worker = new Worker(new URL('./sim-worker.ts', import.meta.url), { type: 'module' });
  } catch (err) {
    console.info('No module worker for the physics; the page works it out itself.', err);
    return null;
  }
  worker.addEventListener('message', (e: MessageEvent<FromWorker>) => {
    const msg = e.data;
    if (msg?.type === 'physics') done(msg.physics);
    else if (msg?.type === 'failed') failed(msg.key, msg.message);
  });
  worker.addEventListener('error', (e) => failed(null, `the physics worker didn't start (${e.message || 'no detail'})`));
  return {
    clip: (data) => worker.postMessage({ type: 'clip', clip: data } satisfies ToWorker),
    run: (key, scene) => worker.postMessage({ type: 'run', key, scene } satisfies ToWorker),
    dispose: () => worker.terminate(),
  };
}

// The arrays a packed physics is made of, to move between threads.
export const transferOf = (p: PackedPhysics): ArrayBuffer[] => [p.start, p.bodies, p.frames, p.limbs, p.pts, p.front].map((a) => a.buffer as ArrayBuffer);

// The worker's side: the clip's data, then the physics asked for, the newest
// first: a run waits for `schedule` (the next task), so the asks that came
// in meanwhile are read first and only the last of them is worked out.
export function serveSim(scope: SimScope, schedule: (work: () => void) => void = (work) => void setTimeout(work, 0)): void {
  let clip: ClipData | null = null;
  let next: { key: string; scene: SceneData } | null = null;
  let scheduled = false;
  const work = () => {
    scheduled = false;
    const run = next;
    next = null;
    if (!run || !clip) return;
    try {
      const { effect, poses, tier, size, cuts, boil } = run.scene;
      const scene = impactScene(effect, impactClip(clip, poses), { tier, size, cuts, boil });
      if (!scene) throw new Error('the effect has no impact');
      if (scene.physicsKey !== run.key) throw new Error("the worker's scene reads other inputs than the page's");
      const physics = packPhysics(scene.physics());
      scope.postMessage({ type: 'physics', physics }, transferOf(physics));
    } catch (err) {
      scope.postMessage({ type: 'failed', key: run.key, message: err instanceof Error ? err.message : String(err) });
    }
  };
  scope.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg?.type === 'clip') {
      clip = msg.clip;
      next = null;
      forgetPhysics(); // the last clip's are no use now
      return;
    }
    if (msg?.type !== 'run') return;
    next = { key: msg.key, scene: msg.scene };
    if (!scheduled) {
      scheduled = true;
      schedule(work);
    }
  });
}

// In a worker scope this file is the physics' worker.
const workerScope = globalThis as unknown as { WorkerGlobalScope?: abstract new () => unknown };
if (typeof workerScope.WorkerGlobalScope === 'function' && globalThis instanceof workerScope.WorkerGlobalScope) serveSim(globalThis as unknown as SimScope);
