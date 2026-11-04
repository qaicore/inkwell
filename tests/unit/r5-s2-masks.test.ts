// Round 5, S2: opening a clip no longer freezes the page. The cached SAM run
// (the hero's is 15 s of decoding on the page) is read a record at a time,
// in shares by a few workers (sam/mask-worker.ts), and the page hears how
// far it is. Offline: fixtures/probe/sam-person.json, the first frames only
// (the records beyond are not decoded), and a stand-in Worker that serves the
// same module in this thread.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { masksFromCache, masksFromCacheSliced, type SamMask } from '../../src/sam/cache.ts';
import { samTracking, samTrackingSliced } from '../../src/app/pipeline.ts';
import { buffersOf, maskReader, serveMasks, type MaskScope } from '../../src/sam/mask-worker.ts';

const json: unknown = JSON.parse(readFileSync(new URL('../../fixtures/probe/sam-person.json', import.meta.url), 'utf8'));
const FRAMES = 9;
const same = (a: (SamMask | null)[], b: (SamMask | null)[]) => {
  expect(a).toHaveLength(b.length);
  a.forEach((m, f) => {
    if (!m || !b[f]) return expect(m, `frame ${f}`).toEqual(b[f]);
    expect(m.bounds, `frame ${f}`).toEqual(b[f]!.bounds);
    expect([m.width, m.height, m.confidence]).toEqual([b[f]!.width, b[f]!.height, b[f]!.confidence]);
    expect(Buffer.from(m.raster).equals(Buffer.from(b[f]!.raster)), `frame ${f}'s raster`).toBe(true);
  });
};

const whole = await masksFromCache(json, FRAMES);

describe('reading the cache in slices', () => {
  it('gives the very masks of reading it whole, hands the thread back between records and reports a rising fraction ending at 1', async () => {
    let pauses = 0;
    const fractions: number[] = [];
    const sliced = await masksFromCacheSliced(json, FRAMES, { pause: async () => void pauses++, progress: (f) => fractions.push(f) });
    same(sliced, whole);
    expect(whole.filter(Boolean).length).toBeGreaterThan(0);
    expect(pauses).toBeGreaterThanOrEqual(FRAMES); // at least a pause a frame, so no task is longer than a raster
    expect(fractions.at(-1)).toBe(1);
    expect(fractions.every((f, i) => i === 0 || f >= fractions[i - 1])).toBe(true);
  });

  it('reads a share of the frames by itself: the frames f with f % count === index, the rest null, and the shares together are the whole', async () => {
    const parts = await Promise.all([0, 1, 2].map((index) => masksFromCacheSliced(json, FRAMES, { part: { index, count: 3 } })));
    parts.forEach((part, index) => part.forEach((m, f) => f % 3 !== index && expect(m).toBeNull()));
    same(Array.from({ length: FRAMES }, (_, f) => parts[f % 3][f]), whole);
  });
});

// A worker in this thread: what the page posts goes to serveMasks, what it posts
// comes back to the page's listener, as the browser would deliver it, in its own task.
class SameThreadWorker {
  static made = 0;
  static fail = false;
  private to: ((e: MessageEvent) => void)[] = [];
  private from: ((e: MessageEvent) => void)[] = [];
  constructor(_url: unknown, _options?: unknown) {
    if (SameThreadWorker.fail) throw new Error('no module worker here');
    SameThreadWorker.made++;
    const scope: MaskScope = {
      postMessage: (data, transfer) => {
        expect(transfer === undefined || transfer.every((t) => t instanceof ArrayBuffer)).toBe(true);
        setTimeout(() => this.from.forEach((l) => l({ data } as MessageEvent)), 0);
      },
      addEventListener: (_, listener) => void this.to.push(listener as (e: MessageEvent) => void),
    };
    serveMasks(scope);
  }
  postMessage(data: unknown) {
    setTimeout(() => this.to.forEach((l) => l({ data } as MessageEvent)), 0);
  }
  addEventListener(type: string, listener: (e: MessageEvent) => void) {
    if (type === 'message') this.from.push(listener);
  }
  terminate() {}
}

describe('the reader the page uses', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    SameThreadWorker.made = 0;
    SameThreadWorker.fail = false;
  });

  it('has a few workers each read a share and puts the shares back in frame order, with the fraction done on the way', async () => {
    vi.stubGlobal('Worker', SameThreadWorker);
    const fractions: number[] = [];
    const read = maskReader(3);
    same(await read(json, FRAMES, (f) => fractions.push(f)), whole);
    expect(SameThreadWorker.made).toBe(3);
    expect(Math.max(...fractions, 0)).toBeLessThanOrEqual(1);
    same(await read(json, FRAMES), whole); // the same workers again
    expect(SameThreadWorker.made).toBe(3);
  });

  it('reads on the page, in slices, where there is no module worker', async () => {
    vi.stubGlobal('Worker', SameThreadWorker);
    SameThreadWorker.fail = true;
    const fractions: number[] = [];
    same(await maskReader(2)(json, FRAMES, (f) => fractions.push(f)), whole);
    expect(fractions.at(-1)).toBe(1);
  });

  it('says what is wrong with a cache that is not one, from the worker', async () => {
    vi.stubGlobal('Worker', SameThreadWorker);
    await expect(maskReader(2)({ rawOutput: 5 }, FRAMES)).rejects.toThrow(/rawOutput/);
  });
});

describe('moving the rasters', () => {
  it('lists each raster buffer once, null frames none', () => {
    expect(buffersOf(whole)).toHaveLength(whole.filter(Boolean).length);
    expect(buffersOf([null, null])).toEqual([]);
  });
});

describe('the cutouts and shapes, in slices', () => {
  it('are the very tracking of working them out whole, with the thread handed back every few frames', async () => {
    let pauses = 0;
    const sliced = await samTrackingSliced(whole, 1920, 1080, async () => void pauses++);
    const direct = samTracking(whole, 1920, 1080);
    expect(sliced.label).toBe(direct.label);
    expect(sliced.masks).toEqual(direct.masks);
    expect(pauses).toBe(Math.floor(FRAMES / 4));
    const root: [number, number] = [830, 400];
    expect(sliced.follow(root, 2)).toEqual(direct.follow(root, 2));
  });
});
