import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { recordingSink, syntheticTube, type PulseSpan } from '../../src/impact/contracts.ts';
import { kr } from '../../src/impact/clock.ts';
import { drawingIndex } from '../../src/motion/timing.ts';
import { ARC_TONES } from '../../src/render/arcs3d.ts';
import {
  POP_GLOW,
  PULSE_GLOW,
  drawPops,
  emitPops,
  emitPulses,
  limbClock,
  popShape,
  pulseCentres,
  pulseStarts,
  pulseTimeline,
  pulsesAt,
  type Pop,
  type PulseTimeline,
} from '../../src/render/pulse.ts';

const I = 84; // the hero's contact frame
const HERO_TL = pulseTimeline(8, I); // drawn on f22, which is in k8
const CALM_TL = pulseTimeline(null, null); // no emergence, no slam
const R0 = 21.6;
const tube = syntheticTube(94, 446, R0, [200, 300], 7);

const gaps = (xs: number[]) => xs.slice(1).map((x, i) => x - xs[i]);
const inCharge = (tl: PulseTimeline, d: number) => tl.charge !== null && d >= tl.charge[0] && d <= tl.charge[1];

// The sweeps below check every value but assert once per property, on its
// [min, max] or on the list of misses: an expect() per value costs far more
// than the code under test.
function extent(xs: readonly number[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of xs) {
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  return [lo, hi];
}
function expectWithin(xs: readonly number[], min: number, max: number, what: string) {
  const [lo, hi] = extent(xs);
  expect(lo, `${what}: the least of ${xs.length}`).toBeGreaterThanOrEqual(min);
  expect(hi, `${what}: the most of ${xs.length}`).toBeLessThanOrEqual(max);
}
const expectNone = (misses: readonly string[]) => expect(misses.slice(0, 8), `${misses.length} misses`).toEqual([]);

describe('limbClock', () => {
  it('runs on the 2s grid, steps on kr through the strike window and carries on after it', () => {
    const hero: Record<number, number> = { 75: 30, 76: 31, 77: 32, 78: 33, 79: 34, 80: 34, 81: 35, 82: 36, 83: 37, 84: 38, 85: 38, 86: 39, 92: 44, 93: 45, 94: 45, 95: 46 };
    for (const [f, k] of Object.entries(hero)) expect(limbClock(Number(f), I), `f${f}`).toBe(k);
    for (let f = 0; f < I - 8; f++) expect(limbClock(f, I)).toBe(drawingIndex(f, 12));
    for (let f = 0; f < 200; f++) expect(limbClock(f, null)).toBe(drawingIndex(f, 12));
    for (let j = -8; j <= 8; j++) expect(limbClock(I + j, I) - limbClock(I - 8, I)).toBe(kr(j) - kr(-8));
    for (let f = 1; f < 250; f++) {
      const step = limbClock(f, I) - limbClock(f - 1, I);
      expect(step === 0 || step === 1, `f${f}`).toBe(true);
    }
  });

  it('builds the hero timeline: idle from k 14, the charge window k 28..44', () => {
    expect(HERO_TL).toEqual({ from: 14, charge: [28, 44] });
    expect(CALM_TL).toEqual({ from: 0, charge: null });
    expect(pulseTimeline(8, I, 12, [5, 9]).every).toEqual([5, 9]);
  });
});

describe('pulse schedule', () => {
  it('never starts pulses on consecutive drawings: 6–10 apart idle, 3–4 in the charge window', () => {
    const firsts: number[] = []; // the first start, counted from the timeline's `from`
    const all: number[] = [];
    const idle: number[] = [];
    const charged: number[] = [];
    for (let id = 1; id <= 400; id++) {
      for (const tl of [HERO_TL, CALM_TL, pulseTimeline(2, 40)]) {
        const starts = pulseStarts(id, tl, 160);
        firsts.push(starts[0] - tl.from);
        gaps(starts).forEach((g, i) => {
          const d = starts[i + 1];
          all.push(g);
          if (!inCharge(tl, d)) idle.push(g);
          else if (d !== tl.charge![0]) charged.push(g); // the window's first drawing may end a longer gap
        });
      }
    }
    expectWithin(firsts, 0, 9, 'first start');
    expectWithin(all, 3, Infinity, 'gap');
    expectWithin(idle, 6, 10, 'idle gap');
    expectWithin(charged, 3, 4, 'charged gap');
    expect(charged.length).toBeGreaterThan(1000);
  });

  it('gives the limbs different phases', () => {
    const firsts = new Set(Array.from({ length: 40 }, (_, id) => pulseStarts(id + 1, HERO_TL, 60)[0]));
    expect(firsts.size).toBeGreaterThanOrEqual(8);
  });

  it('pops at the tip on 0.7 ± 0.02 of the passes over 10k seeds', () => {
    let pops = 0;
    const n = 10000;
    for (let id = 1; id <= n; id++) {
      const [start] = pulseStarts(id, HERO_TL, 40);
      const pass = start + pulseCentres(id, start).length - 1;
      if (pulsesAt(id, pass, HERO_TL).pops.some((p) => p.kind === 'tip')) pops++;
    }
    expect(Math.abs(pops / n - 0.7)).toBeLessThanOrEqual(0.02);
  });

  it('is pure: the same alone, after earlier k, backwards or between other limbs', () => {
    const tl = Object.freeze({ ...HERO_TL, charge: Object.freeze([28, 44] as const) });
    for (const id of [1, 7, 31, 4096]) {
      const alone = Array.from({ length: 120 }, (_, k) => pulsesAt(id, k, tl));
      const forward: unknown[] = [];
      for (let k = 0; k < 120; k++) forward.push(pulsesAt(id, k, tl));
      const backward: unknown[] = [];
      for (let k = 119; k >= 0; k--) backward[k] = pulsesAt(id, k, tl);
      const mixed = Array.from({ length: 120 }, (_, k) => (pulsesAt(id + 1, 119 - k, tl), pulsesAt(id, k, tl)));
      expect(forward).toEqual(alone);
      expect(backward).toEqual(alone);
      expect(mixed).toEqual(alone);
    }
    // Results are fresh objects: changing one changes nothing later.
    const a = pulsesAt(7, 30, tl);
    a.spans.push({ s: 0.5, len: 0.2, scale: 1.3, core: 0.5 });
    expect(pulsesAt(7, 30, tl).spans.length).toBe(a.spans.length - 1);
    expect(() => pulsesAt(7, 2.5, tl)).toThrow(/whole/);
  });
});

describe('pulse travel and look', () => {
  it('starts at 0.1 L, steps 0.25–0.35 L and crosses in 3–4 drawings', () => {
    const misses: string[] = [];
    const steps: number[] = [];
    let passes = 0;
    for (let id = 1; id <= 300; id++) {
      for (const start of pulseStarts(id, HERO_TL, 120)) {
        const c = pulseCentres(id, start);
        const at = `id ${id} start ${start} [${c.join(' ')}]`;
        steps.push(...gaps(c));
        if (c[0] !== 0.1) misses.push(`${at}: starts elsewhere`);
        if (!(c[c.length - 1] > 1 && c[c.length - 2] <= 1)) misses.push(`${at}: not just past the tip at the end`);
        if (c.length !== 4 && c.length !== 5) misses.push(`${at}: not 3 or 4 on the limb, then past the tip`);
        // pulsesAt shows it on the drawings it's on the limb, and not after.
        for (let age = 0; age < c.length; age++) {
          const shown = pulsesAt(id, start + age, HERO_TL).spans.some((s) => s.s === c[age]);
          if (shown !== age < c.length - 1) misses.push(`${at}: age ${age} ${shown ? 'shown' : 'missing'}`);
        }
        passes++;
      }
    }
    expectNone(misses);
    expectWithin(steps, 0.25, 0.35, 'step');
    expect(passes).toBeGreaterThan(1000);
  });

  it('draws each bulge 0.15–0.25 L long, ×1.2–1.4 wide, with a 45–65 % core', () => {
    const spans: PulseSpan[] = [];
    for (let id = 1; id <= 100; id++) for (let k = 0; k < 120; k++) spans.push(...pulsesAt(id, k, HERO_TL).spans);
    expect(spans.length).toBeGreaterThan(3000);
    expectWithin(spans.map((s) => s.len), 0.15, 0.25, 'len');
    expectWithin(spans.map((s) => s.scale), 1.2, 1.4, 'scale');
    expectWithin(spans.map((s) => s.core), 0.45, 0.65, 'core');
    expectWithin(spans.map((s) => s.s), 0.1, 1, 's');
  });

  it('shows nothing before the limb is idle', () => {
    expect(pulsesAt(1, 0, HERO_TL)).toEqual({ spans: [], pops: [] });
    const misses: string[] = [];
    for (let id = 1; id <= 50; id++) {
      for (let k = 0; k < HERO_TL.from; k++) {
        const { spans, pops } = pulsesAt(id, k, HERO_TL);
        if (spans.length + pops.length > 0) misses.push(`id ${id} k ${k}`);
      }
    }
    expectNone(misses);
  });
});

describe('pops', () => {
  it('never pops on consecutive drawings, and pops at random about 5 % of the time', () => {
    let random = 0;
    let drawings = 0;
    const misses: string[] = [];
    for (let id = 1; id <= 400; id++) {
      let before = false;
      for (let k = HERO_TL.from; k < 160; k++) {
        const { pops } = pulsesAt(id, k, HERO_TL);
        if (pops.length > 1) misses.push(`id ${id} k ${k}: ${pops.length} pops`);
        if (before && pops.length > 0) misses.push(`id ${id} k ${k}: pops again`);
        before = pops.length > 0;
        random += pops.filter((p) => p.kind === 'random').length;
        drawings++;
      }
    }
    expectNone(misses);
    expect(random / drawings).toBeGreaterThan(0.035);
    expect(random / drawings).toBeLessThan(0.06);
  });

  it('gives each pop 6–10 spikes of 0.3–1.4 r on a 0.15–0.3 r base round a 0.8–1.2 r core', () => {
    const pops: Pop[] = [];
    for (let id = 1; id <= 300; id++) for (let k = 14; k < 120; k++) pops.push(...pulsesAt(id, k, HERO_TL).pops);
    const tips = pops.filter((p) => p.kind === 'tip');
    const others = pops.filter((p) => p.kind !== 'tip');
    expect(tips.length).toBeGreaterThan(500);
    expect(others.filter((p) => p.kind === 'random').length).toBeGreaterThan(500);
    expectWithin(pops.map((p) => p.spikes.length), 6, 10, 'spikes');
    expectWithin(pops.map((p) => p.core), 0.8, 1.2, 'core');
    expect(tips.filter((p) => p.s !== 1 || p.side !== 1).length, 'tip pops off the tip').toBe(0);
    expectWithin(others.map((p) => p.s), 0.1, 0.9, 'random pop s');
    const spikes = pops.flatMap((p) => p.spikes);
    expectWithin(spikes.map((sp) => sp.length), 0.3, 1.4, 'spike length');
    expectWithin(spikes.map((sp) => sp.base), 0.15, 0.3, 'spike base');
    expectWithin(spikes.map((sp) => Math.abs(sp.angle)), 0, 0.75 * Math.PI, 'spike |angle|');
    const unordered = pops.filter((p) => p.spikes.some((sp, i) => i > 0 && !(sp.angle > p.spikes[i - 1].angle)));
    expect(unordered.length, 'pops whose spike angles do not rise').toBe(0);
    const lengths = spikes.map((sp) => sp.length).sort((a, b) => a - b);
    expect(lengths[lengths.length >> 1]).toBeCloseTo(0.6, 1); // lightning §5.4's median
  });

  it('fans a tip pop out of the tip, leaving the 90° toward the root open', () => {
    const pop: Pop = { kind: 'tip', s: 1, side: 1, core: 1, spikes: [-2.3, -1, 0, 1, 2.3].map((angle) => ({ angle, length: 1, base: 0.2 })) };
    const shape = popShape(tube, pop);
    expect(shape).not.toBeNull();
    const { centre, r, core, spikes } = shape!;
    expect(centre).toEqual([646, 300]);
    expect(r).toBeCloseTo(tube.sections[0].r, 9);
    expect(core).toBeCloseTo(R0 / 2, 9);
    for (const [, apex] of spikes) {
      const dir = Math.atan2(apex[1] - centre[1], apex[0] - centre[0]); // the tube runs along +x
      expect(Math.abs(dir)).toBeLessThanOrEqual(0.75 * Math.PI + 1e-9);
      expect(Math.hypot(apex[0] - centre[0], apex[1] - centre[1])).toBeCloseTo(core + R0, 9);
    }
    // A random pop sits on the skin's edge, on its side.
    const side = popShape(tube, { ...pop, kind: 'random', s: 0.5, side: -1 })!;
    expect(side.centre[0]).toBeCloseTo(200 + 223, 9);
    expect(side.centre[1]).toBeCloseTo(300 - R0, 9);
  });

  it('draws pops in the arc tones and emits them as a tight disc at ×1.7', () => {
    let k = 14;
    while (!pulsesAt(7, k, HERO_TL).pops.some((p) => p.kind === 'tip')) k++;
    const { pops } = pulsesAt(7, k, HERO_TL);
    const canvas = createCanvas(900, 600);
    const ctx = canvas.getContext('2d');
    drawPops(ctx, tube, pops);
    const px = ctx.getImageData(646, 300, 1, 1).data;
    expect([px[0], px[1], px[2], px[3]]).toEqual([0xa8, 0xf6, 0xff, 255]); // the core, on the tip
    const sink = recordingSink();
    emitPops(sink, tube, pops, 0.5);
    expect(sink.calls).toEqual([{ op: 'disc', c: [646, 300], r: 1.25 * R0, color: ARC_TONES.core, gain: POP_GLOW * 0.5 }]);
  });

  it('emits each pulse as a body and a core stroke at ×2', () => {
    const sink = recordingSink();
    emitPulses(sink, tube, [{ s: 0.5, len: 0.2, scale: 1.3, core: 0.5 }], 0.8, { body: '#e8203a', core: '#ffe3db' });
    expect(sink.calls.length).toBe(2);
    const [body, core] = sink.calls;
    expect(body).toMatchObject({ op: 'stroke', width: 2 * R0 * 1.3, color: '#e8203a', kind: 'body', gain: PULSE_GLOW * 0.8 });
    expect(core).toMatchObject({ op: 'stroke', width: R0 * 1.3, color: '#ffe3db', kind: 'core', gain: PULSE_GLOW * 0.8 });
    if (body.op !== 'stroke') throw new Error('expected a stroke');
    expect(body.points[0][0]).toBeCloseTo(200 + 0.4 * 446, 9);
    expect(body.points[body.points.length - 1][0]).toBeCloseTo(200 + 0.6 * 446, 9);
  });
});
