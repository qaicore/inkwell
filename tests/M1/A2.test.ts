/// <reference types="node" />
// A2 (SPEC §10, anime motion): boil, measured on the boil offsets themselves. Consecutive offsets differ; they repeat
// every boil.cycle drawings (from reference/timing.json); max offset <= boil.maxPx.
//
// Measured on src/motion/boil.ts boilOffsets(k, strokeId, count, boil, wobble, width), with boil.maxPx and boil.cycle
// read from Qai's reference/timing.json at runtime (missing = FAIL, no fallback). Over stroke ids 1..12, point
// counts 8, 32 and 64, wobble 1 and 0.5, and drawings k = 0 .. 6 cycles plus k = 1000 .. 1000 + 2 cycles:
//   - consecutive: offsets(k) and offsets(k + 1) differ at some point, for every k;
//   - repeat: offsets(k + cycle) is identical to offsets(k), value for value;
//   - max offset: the largest |offset| (Euclidean length of the per-point offset, in px) at 1080 wide, wobble <= 1.
// Stricter readings, flagged for Qai:
//   - "repeat every boil.cycle drawings" also means not sooner: offsets(k + j) differs from offsets(k) for
//     0 < j < cycle (§11: cycle is "how many drawings before the boil repeats");
//   - maxPx is "at 1080 wide" (§11), so at 720 and 2160 wide the max is checked against maxPx · width / 1080;
//   - §8.4's A = boil.maxPx · wobble: wobble 0 gives zero offsets, and wobble 0.5 gives half of wobble 1.
import { afterAll, describe, expect, it } from 'vitest';
import { Evidence } from '../helpers/evidence.ts';
import { need, recorded, timingBoil, type V2 } from '../helpers/engine.ts';

type BoilModule = typeof import('../../src/motion/boil.ts');

const ID = 'A2';
const ev = new Evidence(ID, [
  'modules load',
  'reference/timing.json boil',
  'consecutive offsets differ',
  'offsets repeat every boil.cycle drawings',
  'offsets do not repeat sooner than boil.cycle',
  'max offset <= boil.maxPx at 1080 wide',
  'max offset scales with width (maxPx is at 1080 wide)',
  'amplitude follows wobble (A = maxPx · wobble)',
]);
afterAll(() => ev.write());

const IDS = Array.from({ length: 12 }, (_, i) => i + 1);
const COUNTS = [8, 32, 64];

const same = (a: V2[], b: V2[]) => a.length === b.length && a.every((p, i) => p[0] === b[i]![0] && p[1] === b[i]![1]);
const maxDiff = (a: V2[], b: V2[]) => (a.length !== b.length ? Infinity : Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i]![0], p[1] - b[i]![1]))));
const maxLen = (a: V2[]) => Math.max(0, ...a.map((p) => (Number.isFinite(p[0]) && Number.isFinite(p[1]) ? Math.hypot(p[0], p[1]) : Infinity)));

describe('A2 boil, measured on the boil offsets', () => {
  it('A2 consecutive offsets differ, repeat every boil.cycle drawings, and stay within boil.maxPx', async () => {
    const mod: BoilModule = await recorded(ev, 'modules load', 'src/motion/boil.ts exports boilOffsets', () =>
      need('src/motion/boil.ts', { boilOffsets: 'function' }, () => import('../../src/motion/boil.ts')),
    );
    const boil = await recorded(ev, 'reference/timing.json boil', 'boil.maxPx >= 0 and boil.cycle a whole number >= 2', () => {
      const b = timingBoil();
      if (b.cycle < 2) throw new Error(`reference/timing.json "boil.cycle" is ${b.cycle}: consecutive offsets can only differ with a cycle of 2 or more`);
      return b;
    }, (b) => b);
    const offsets = (k: number, id: number, count: number, wobble: number, width = 1080) =>
      mod.boilOffsets(k, id, count, boil, wobble, width) as V2[];

    const ks = [...Array.from({ length: 6 * boil.cycle }, (_, i) => i), ...Array.from({ length: 2 * boil.cycle }, (_, i) => 1000 + i)];

    const notDiffering: string[] = [];
    const notRepeating: string[] = [];
    const repeatsSooner: string[] = [];
    const wrongCount: string[] = [];
    let minConsecutiveDiff = Infinity;
    let maxRepeatDiff = 0;
    let max1080 = 0;
    for (const id of IDS) {
      for (const count of COUNTS) {
        for (const wobble of [1, 0.5]) {
          for (const k of ks) {
            const o = offsets(k, id, count, wobble);
            if (o.length !== count) wrongCount.push(`k ${k}, id ${id}, count ${count}: got ${o.length}`);
            max1080 = Math.max(max1080, maxLen(o));
            const next = offsets(k + 1, id, count, wobble);
            const d = maxDiff(o, next);
            minConsecutiveDiff = Math.min(minConsecutiveDiff, d);
            if (!(d > 0)) notDiffering.push(`k ${k}->${k + 1}, id ${id}, count ${count}, wobble ${wobble}`);
            const again = offsets(k + boil.cycle, id, count, wobble);
            if (!same(o, again)) {
              notRepeating.push(`k ${k} vs ${k + boil.cycle}, id ${id}, count ${count}, wobble ${wobble}`);
              maxRepeatDiff = Math.max(maxRepeatDiff, maxDiff(o, again));
            }
            for (let j = 1; j < boil.cycle; j++) {
              if (same(o, offsets(k + j, id, count, wobble))) repeatsSooner.push(`k ${k} = k ${k + j}, id ${id}, count ${count}, wobble ${wobble}`);
            }
          }
        }
      }
    }

    const head = (xs: string[]) => (xs.length > 5 ? [...xs.slice(0, 5), `... ${xs.length - 5} more`] : xs);
    ev.record('consecutive offsets differ', { minMaxPointDifferencePx: minConsecutiveDiff, pairsThatDontDiffer: head(notDiffering) }, 'every consecutive pair differs (> 0 px)',
      notDiffering.length === 0 && wrongCount.length === 0, wrongCount.length ? `wrong point counts: ${head(wrongCount).join('; ')}` : '');
    ev.record('offsets repeat every boil.cycle drawings', { cycle: boil.cycle, mismatches: head(notRepeating), maxMismatchPx: maxRepeatDiff },
      `offsets(k + ${boil.cycle}) identical to offsets(k)`, notRepeating.length === 0);
    ev.record('offsets do not repeat sooner than boil.cycle', head(repeatsSooner), `offsets(k + j) differ from offsets(k) for 0 < j < ${boil.cycle}`, repeatsSooner.length === 0);
    ev.record('max offset <= boil.maxPx at 1080 wide', { maxPx: max1080 }, `<= ${boil.maxPx} px (boil.maxPx)`, max1080 <= boil.maxPx);

    const widths: Record<string, { max: number; limit: number }> = {};
    for (const width of [720, 2160]) {
      let m = 0;
      for (const id of IDS) for (const k of ks) m = Math.max(m, maxLen(offsets(k, id, 32, 1, width)));
      widths[String(width)] = { max: m, limit: (boil.maxPx * width) / 1080 };
    }
    const widthOk = Object.values(widths).every((w) => w.max <= w.limit);
    ev.record('max offset scales with width (maxPx is at 1080 wide)', widths, 'max <= boil.maxPx · width / 1080', widthOk);

    let zeroMax = 0;
    let halfErr = 0;
    for (const id of IDS) {
      for (const k of ks) {
        zeroMax = Math.max(zeroMax, maxLen(offsets(k, id, 32, 0)));
        const full = offsets(k, id, 32, 1);
        const half = offsets(k, id, 32, 0.5);
        halfErr = Math.max(halfErr, maxDiff(half, full.map((p): V2 => [p[0] / 2, p[1] / 2])));
      }
    }
    const wobbleOk = zeroMax === 0 && halfErr <= 1e-9;
    ev.record('amplitude follows wobble (A = maxPx · wobble)', { wobble0MaxPx: zeroMax, wobbleHalfVsHalfOfFullPx: halfErr }, 'wobble 0 -> 0 px; wobble 0.5 = half of wobble 1 (within 1e-9 px)', wobbleOk);

    expect(wrongCount, 'A2 boilOffsets must return one offset per point').toEqual([]);
    expect(notDiffering, `A2 consecutive boil offsets are identical (min difference ${minConsecutiveDiff} px)`).toEqual([]);
    expect(notRepeating, `A2 boil offsets don't repeat every ${boil.cycle} drawings`).toEqual([]);
    expect(repeatsSooner, `A2 boil offsets repeat before ${boil.cycle} drawings`).toEqual([]);
    expect(max1080, `A2 max boil offset ${max1080} px exceeds boil.maxPx ${boil.maxPx}`).toBeLessThanOrEqual(boil.maxPx);
    expect(widthOk, `A2 boil offsets don't scale with width: ${JSON.stringify(widths)}`).toBe(true);
    expect(wobbleOk, `A2 boil amplitude doesn't follow wobble: wobble 0 max ${zeroMax} px, half-wobble error ${halfErr} px`).toBe(true);
  });
});
