// Reading a cached SAM run off the page (R5, S2). The hero's cache is 15 s of
// decoding (@meta-sam/parser: an arithmetic decode and a check that encodes
// every raster again), which on the page was one task that froze it before
// the first drawing. Here the page hands a few workers the cache and the
// frame count, each reads its share of the frames, and the masks come back
// with their rasters moved, not copied, and the fraction done on the way for
// the status line.
// Without a module worker the page reads them itself, a record at a time with
// the thread handed back between them (cache.ts, masksFromCacheSliced), so no
// task is longer than one raster. The same file is the worker: run in a
// worker scope it serves the page (the guard at the bottom), and anywhere
// else it only defines things.
import { masksFromCacheSliced, type SamMask } from './cache.ts';
import type { Part } from './masks.ts';

type ToWorker = { type: 'read'; id: number; json: unknown; frames: number; part?: Part };
type FromWorker =
  | { type: 'progress'; id: number; fraction: number }
  | { type: 'masks'; id: number; masks: (SamMask | null)[] }
  | { type: 'failed'; id: number; message: string };

export interface MaskScope {
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (e: MessageEvent<ToWorker>) => void): void;
}

// What reads the masks, for the page: `fraction` hears 0 to 1 as it goes.
export type MaskReader = (json: unknown, frames: number, fraction?: (f: number) => void) => Promise<(SamMask | null)[]>;

// The next task, so the page's own events (a frame, a touch) run between records.
const nextTask = () => new Promise<void>((resume) => void setTimeout(resume, 0));

const POOL = 4; // workers at most; the page keeps one core

// The reader the page uses: a few workers at once, or the page's own slices
// where there is no module worker, or when one fails to start or stops.
export function maskReader(workers = Math.max(1, Math.min(POOL, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1))): MaskReader {
  type Ask = { done: (m: (SamMask | null)[]) => void; fail: (e: Error) => void; fraction: (f: number) => void };
  let pool: Worker[] | null = null;
  let broken = false;
  const waiting = new Map<number, Ask>();
  let ids = 0;
  const stop = (why: string) => {
    broken = true;
    for (const w of pool ?? []) w.terminate();
    pool = null;
    for (const ask of waiting.values()) ask.fail(new Error(why));
    waiting.clear();
  };
  const start = (): Worker[] | null => {
    if (pool || broken) return pool;
    try {
      pool = Array.from({ length: workers }, () => new Worker(new URL('./mask-worker.ts', import.meta.url), { type: 'module' }));
    } catch (err) {
      console.info('No module worker for the SAM cache; the page reads it in slices.', err);
      broken = true;
      return null;
    }
    for (const w of pool) {
      w.addEventListener('message', (e: MessageEvent<FromWorker>) => {
        const msg = e.data;
        const ask = msg && waiting.get(msg.id);
        if (!ask) return;
        if (msg.type === 'progress') ask.fraction(msg.fraction);
        else {
          waiting.delete(msg.id);
          if (msg.type === 'masks') ask.done(msg.masks);
          else ask.fail(new Error(msg.message));
        }
      });
      w.addEventListener('error', (e) => {
        console.warn(`The SAM cache worker stopped (${e.message || 'no detail'}); the page reads it in slices.`);
        stop('the SAM cache worker stopped');
      });
    }
    return pool;
  };
  const sliced: MaskReader = (json, frames, fraction) => masksFromCacheSliced(json, frames, { pause: nextTask, progress: fraction });
  return async (json, frames, fraction) => {
    const team = start();
    if (!team) return sliced(json, frames, fraction);
    const seen = team.map(() => 0);
    try {
      const parts = await Promise.all(
        team.map(
          (worker, index) =>
            new Promise<(SamMask | null)[]>((done, fail) => {
              const id = ++ids;
              const own = (f: number) => {
                seen[index] = f;
                fraction?.(seen.reduce((sum, x) => sum + x, 0) / team.length);
              };
              waiting.set(id, { done, fail, fraction: own });
              worker.postMessage({ type: 'read', id, json, frames, part: { index, count: team.length } } satisfies ToWorker);
            }),
        ),
      );
      return Array.from({ length: frames }, (_, f) => parts[f % team.length][f]);
    } catch (err) {
      if (!broken) throw err; // the workers ran and the cache is bad: the page would find the same
      return sliced(json, frames, fraction);
    }
  };
}

// The rasters a read is made of, to move between threads.
export const buffersOf = (masks: readonly (SamMask | null)[]): ArrayBuffer[] => [...new Set(masks.flatMap((m) => (m ? [m.raster.buffer as ArrayBuffer] : [])))];

// The worker's side: each read as it comes.
export function serveMasks(scope: MaskScope): void {
  scope.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg?.type !== 'read') return;
    const { id } = msg;
    let sent = 0;
    masksFromCacheSliced(msg.json, msg.frames, {
      part: msg.part,
      progress: (fraction) => {
        const now = Date.now();
        if (now - sent < 100) return;
        sent = now;
        scope.postMessage({ type: 'progress', id, fraction });
      },
    }).then(
      (masks) => scope.postMessage({ type: 'masks', id, masks }, buffersOf(masks)),
      (err) => scope.postMessage({ type: 'failed', id, message: err instanceof Error ? err.message : String(err) }),
    );
  });
}

// In a worker scope this file is the cache's worker.
const workerScope = globalThis as unknown as { WorkerGlobalScope?: abstract new () => unknown };
if (typeof workerScope.WorkerGlobalScope === 'function' && globalThis instanceof workerScope.WorkerGlobalScope) serveMasks(globalThis as unknown as MaskScope);
