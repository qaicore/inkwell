// WP9: the aftermath energy (impact design §6 "Energy" and "Decay and the
// time map", §5's gentle plan and ladder; build plan WP9): the lightning,
// the washes, the sparks and the embers, on the hero at the app's 1080×608
// (P (530, 597), d (−0.060, 0.998), the hero's floor block, seed 84). The
// lightning crawls along the synthetic sources WP12 will pass (the sheet's):
// a cluster outline over P, the hero's six cracks, a stand-in person's edge
// within 0.3 U of P and two limbs landing on P. Kinks are measured on
// straight sources, where a turn is the zigzag's own and not the source's.
// Full flashing is the default (decision 5); 'safe' is Reduce flashing, the
// gentle plan, where the ladder runs.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it, vi } from 'vitest';
import { nullSink, recordingSink, type GlowCall, type Palette, type Tier, type Vec2 } from '../../src/impact/contracts.ts';
import { decayAlpha, kr } from '../../src/impact/clock.ts';
import { strikeFrame } from '../../src/impact/floor.ts';
import { DISCHARGE, FIRE, linear, mixHex } from '../../src/impact/palette.ts';
import type { BrushTarget } from '../../src/render/glow.ts';
import { nodeScratch } from '../../src/render/headless.ts';
import type { Mask } from '../../src/track/tracking.ts';
import * as lightning from '../../src/impact/aftermath/lightning.ts';
import * as washes from '../../src/impact/aftermath/washes.ts';
import * as particles from '../../src/impact/aftermath/particles.ts';
import { HERO, HERO_CRACKS } from './helpers/impact-drawings.ts';

const TEST: Palette = ['#e8203a', '#f4f1ea', '#16141a']; // the app's default and the test drawings': its red leaves the discharge set unturned
const FLOOR = { ratio: 0.763, majorDeg: 2.6, up: [0.04, -1.0] as [number, number], persp: 0.68 }; // the hero's floor block (design §6)
const SIGMA = 0.63; // the hero's σ (destruction §7)
const W = 1080;
const H = 608;
const K = W / HERO.width; // clip px → frame px
const P: Vec2 = [HERO.P[0] * K, HERO.P[1] * K];
const BODY = { c: [P[0] + 70, P[1] - 200] as Vec2, a: 110, b: 215 }; // the sheet's stand-in person: an upright ellipse just past P
const SEEDS = [84, 1, 7, 15, 23, 42];
const LEAD_KINK = 0.022; // × S: the lead-in's kinks are spaced as an early ribbon's (lightning.ts)
const DEG = 180 / Math.PI;

function personMask(): Mask {
  const alpha = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5 - BODY.c[0]) / BODY.a;
      const v = (y + 0.5 - BODY.c[1]) / BODY.b;
      if (u * u + v * v <= 1) alpha[y * W + x] = 255;
    }
  }
  return { width: W, height: H, alpha };
}
const MASK = personMask();

interface SceneOptions {
  seed?: number;
  seconds?: number;
  tier?: Tier;
  flash?: 'full' | 'safe';
  mask?: boolean;
  P?: Vec2;
}
function scene(o: SceneOptions = {}): washes.EnergyContext {
  const seed = o.seed ?? HERO.seed;
  const seconds = o.seconds ?? 1.5;
  const mask = o.mask ? MASK : null;
  return {
    I: HERO.I,
    jEnd: Math.round(30 * seconds),
    seed,
    frame: strikeFrame(o.P ?? P, [HERO.d[0], HERO.d[1]], Math.min(W, H), SIGMA, W, H, seed),
    floor: FLOOR,
    width: W,
    height: H,
    palette: TEST,
    flash: o.flash ?? 'full',
    posters: true,
    crackEase: 'out',
    aftermath: { seconds, scale: 1, scarSeconds: 3 },
    tier: o.tier ?? 'full',
    personMask: () => mask,
    faceMask: () => null,
    cracks: [],
  };
}

// The sources WP12 passes: the cluster outline (a dome over P), the cracks,
// the person-mask edge within 0.3 U of P, and two limbs from his back to P.
function sources(ictx: washes.EnergyContext): Vec2[][] {
  const fr = washes.energyFrame(ictx);
  const dome = Array.from({ length: 49 }, (_, i): Vec2 => {
    const th = (Math.PI * i) / 48;
    return washes.onFloor(fr, fr.U, 0.05 + 0.705 * Math.sin(th), -0.5 + 0.97 * ((1 - Math.cos(th)) / 2));
  });
  const cracks = HERO_CRACKS.map((c) => c.points.map((p): Vec2 => [p[0] * K, p[1] * K]));
  const edge: Vec2[] = [];
  for (let i = 0; i <= 96; i++) {
    const th = (2 * Math.PI * i) / 96;
    const p: Vec2 = [BODY.c[0] + BODY.a * Math.cos(th), BODY.c[1] + BODY.b * Math.sin(th)];
    if (Math.hypot(p[0] - P[0], p[1] - P[1]) <= 0.3 * fr.U) edge.push(p);
  }
  const limb = (from: Vec2, bend: number) =>
    Array.from({ length: 24 }, (_, i): Vec2 => {
      const s = i / 23;
      return [from[0] + (P[0] - from[0]) * s + bend * Math.sin(Math.PI * s), from[1] + (P[1] - from[1]) * s];
    });
  return [dome, ...cracks, edge, limb([P[0] + 170, P[1] - 340], 40), limb([P[0] + 110, P[1] - 370], -50)];
}

// Two straight lines across the floor, 0.25 and 0.75 U up from P.
function straightSources(ictx: washes.EnergyContext): Vec2[][] {
  const fr = washes.energyFrame(ictx);
  return [0.25, 0.75].map((n) => Array.from({ length: 41 }, (_, i): Vec2 => washes.onFloor(fr, fr.U, n, -1.4 + (2.8 * i) / 40)));
}

// The first frame (j) of each kr step from j `from` to j `to`.
function krSteps(from: number, to: number): number[] {
  const out: number[] = [];
  for (let j = from; j <= to; j++) if (j === from || kr(j) !== kr(j - 1)) out.push(j);
  return out;
}

// Each hold group's first output frame, from j 9 to J_end − 1.
function groupStarts(ictx: washes.EnergyContext): number[] {
  const out: number[] = [];
  for (let f = ictx.I + 9; f < ictx.I + ictx.jEnd; f++) {
    const c = washes.groupClock(ictx, f)!;
    if (c.start === f) out[c.g] = f;
  }
  return out;
}

const sum = (v: readonly number[]) => v.reduce((s, x) => s + x, 0);
const median = (v: readonly number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
function cumulative(p: readonly Vec2[]): number[] {
  const out = [0];
  for (let i = 1; i < p.length; i++) out.push(out[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]));
  return out;
}
// The turn at node i, degrees.
function turnAt(p: readonly Vec2[], i: number): number {
  let d = Math.atan2(p[i + 1][1] - p[i][1], p[i + 1][0] - p[i][0]) - Math.atan2(p[i][1] - p[i - 1][1], p[i][0] - p[i - 1][0]);
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d) * DEG;
}
const onFrame = ([x, y]: Vec2) => x >= 0 && x <= W && y >= 0 && y <= H;
// Relative luminance of an 8-bit pixel.
const lum = (r: number, g: number, b: number) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

function canvas(fill?: string): BrushTarget {
  const ctx = createCanvas(W, H).getContext('2d');
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, W, H);
  }
  return ctx as unknown as BrushTarget;
}
// The share of the frame a layer painted onto a clear canvas covers.
function coverage(ctx: BrushTarget): number {
  const d = ctx.getImageData(0, 0, W, H).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
  return n / (W * H);
}

// Every plan over the seeds, on each kr step's first frame from A3 to the end of the lightning at 1.5 s.
function plans(src: (ictx: washes.EnergyContext) => Vec2[][], opts: lightning.LightningOptions = {}, tier: Tier = 'full') {
  const out: { at: string; ictx: washes.EnergyContext; plan: lightning.LightningPlan }[] = [];
  for (const seed of SEEDS) {
    const ictx = scene({ seed, tier });
    const lines = src(ictx);
    for (const j of krSteps(13, ictx.jEnd - 6)) {
      const plan = lightning.ribbons(ictx, j, lines, opts);
      expect(plan, `seed ${seed} j${j}`).not.toBeNull();
      out.push({ at: `seed ${seed} j${j} A${kr(j) - 14} ${plan!.band}`, ictx, plan: plan! });
    }
  }
  return out;
}
let heroCache: ReturnType<typeof plans> | null = null;
const heroPlans = () => (heroCache ??= plans(sources));
type Stroke = Extract<GlowCall, { op: 'stroke' }>;
const isStroke = (c: GlowCall): c is Stroke => c.op === 'stroke';

// ---- Lightning ------------------------------------------------------------------------------

describe('lightning', () => {
  it('draws 2–3 ribbons on A3–6, 4–9 on A7–11 and 2–7 from A12 (the hold and the decay too), none before A3', () => {
    for (const seconds of [1.5, 3]) {
      for (const seed of SEEDS.slice(0, 3)) {
        const ictx = scene({ seed, seconds });
        const src = sources(ictx);
        for (let j = 9; j <= ictx.jEnd + 1; j++) {
          const plan = lightning.ribbons(ictx, j, src);
          const A = kr(j) - 14;
          const at = `${seconds} s seed ${seed} j${j} A${A}`;
          if (A < 3 || j >= ictx.jEnd - 5) {
            expect(plan, at).toBeNull();
            continue;
          }
          const band = A <= 6 ? 'lead' : A <= 8 ? 'early' : A <= 11 ? 'mid' : 'late';
          expect(plan?.band, at).toBe(band);
          const [lo, hi] = lightning.RIBBON_BANDS[band].count;
          expect(plan!.ribbons.length, at).toBeGreaterThanOrEqual(lo);
          expect(plan!.ribbons.length, at).toBeLessThanOrEqual(hi);
        }
      }
    }
    expect(lightning.ribbons(scene(), 12, sources(scene()))).toBeNull(); // A2
    expect(lightning.ribbons(scene(), 13, sources(scene()))?.A).toBe(3); // the first, on j 13
  });

  it("keeps the band's total path and its longest extent (0.8–0.9 U and 0.4–0.5 U on the lead-in; 3.5–5 U and 0.6–0.8 U on A7–11; 3.5–6 U and 0.6–1.3 U from A12)", () => {
    for (const { at, ictx, plan } of heroPlans()) {
      const { U } = washes.energyFrame(ictx);
      const band = lightning.RIBBON_BANDS[plan.band];
      const total = sum(plan.ribbons.map((r) => r.length)) / U;
      const longest = Math.max(...plan.ribbons.map((r) => r.extent)) / U;
      // Two or three ribbons from A12, or four on A7–11, can't carry the
      // band's whole total with none longer than the longest: a zigzag on
      // these curved sources makes only 1.0–1.3 × its extent in path, so they
      // keep what they can, over 0.65 of the band's least total (at the least
      // 0.67 from A12 and 0.74 on A7–11 over 300 seeds).
      const enough = plan.band === 'lead' || plan.ribbons.length >= (plan.band === 'late' ? 4 : 5);
      expect(total, at).toBeLessThanOrEqual(band.total[1] + 1e-9);
      expect(total, at).toBeGreaterThanOrEqual((enough ? 1 : 0.65) * band.total[0] - 1e-9);
      expect(longest, at).toBeGreaterThanOrEqual(0.97 * band.longest[0]);
      expect(longest, at).toBeLessThanOrEqual(band.longest[1] + 1e-9);
      for (const r of plan.ribbons) expect(r.extent, at).toBeLessThanOrEqual(longest * U + 1e-9);
    }
  });

  it('draws a main ribbon at a median width of 0.021–0.024 S on A7–8 and 0.042–0.073 S from A9, the lead-in at 0.006–0.009 S', () => {
    let mains = 0;
    for (const { at, ictx, plan } of heroPlans()) {
      const S = ictx.frame.S;
      const [lo, hi] = lightning.RIBBON_BANDS[plan.band].median;
      for (const r of plan.ribbons) {
        // A short cored ribbon (under 0.25 U of path) is drawn thinner, × 0.6.
        const k = r.main ? 1 : 0.6;
        expect(r.median / S, at).toBeGreaterThanOrEqual(k * lo - 1e-9);
        expect(r.median / S, at).toBeLessThanOrEqual(k * hi + 1e-9);
        if (r.main) mains++;
      }
      expect(plan.ribbons[0].main, at).toBe(true);
    }
    expect(mains).toBeGreaterThan(0.6 * sum(heroPlans().map((p) => p.plan.ribbons.length)));
  });

  it('kinks it 40–85° every 2–8 median widths (on straight sources; the lead-in every 2–8 × 0.022 S)', () => {
    let kinks = 0;
    for (const { at, ictx, plan } of plans(straightSources, { floor: false })) {
      const S = ictx.frame.S;
      for (const r of plan.ribbons) {
        const cum = cumulative(r.path);
        const unit = plan.band === 'lead' ? Math.max(r.median, LEAD_KINK * S) : r.median;
        expect(r.turns.length, at).toBe(r.kinks.length);
        r.kinks.forEach((i, q) => {
          kinks++;
          expect(r.turns[q], at).toBeGreaterThanOrEqual(lightning.KINK.min - 1e-9);
          expect(r.turns[q], at).toBeLessThanOrEqual(lightning.KINK.max + 1e-9);
          expect(Math.abs(turnAt(r.path, i) - r.turns[q]), `${at} kink ${q}`).toBeLessThanOrEqual(5);
          // The smooth offset (at most 0.3 of the width) can shorten a 2-width segment's chord a little.
          if (q > 0) {
            const gap = (cum[i] - cum[r.kinks[q - 1]]) / unit;
            expect(gap, `${at} kink ${q}`).toBeGreaterThanOrEqual(1.8);
            expect(gap, `${at} kink ${q}`).toBeLessThanOrEqual(8.5);
          }
        });
      }
    }
    expect(kinks).toBeGreaterThan(300);
  });

  it('swells 2–4 pools between pinches at max/min 4–8, the widest at most 3 medians; the lead-in has none', () => {
    for (const { at, plan } of heroPlans()) {
      for (const r of plan.ribbons) {
        if (plan.band === 'lead') {
          expect(r.pools, at).toBe(0);
          expect(r.ratio, at).toBeLessThan(4);
          continue;
        }
        expect(r.pools, at).toBeGreaterThanOrEqual(2);
        expect(r.pools, at).toBeLessThanOrEqual(4);
        const lo = Math.min(...r.width);
        const hi = Math.max(...r.width);
        expect(hi / lo, at).toBeCloseTo(r.ratio, 9);
        expect(r.ratio, at).toBeGreaterThanOrEqual(4);
        expect(r.ratio, at).toBeLessThanOrEqual(8);
        expect(hi / r.median, at).toBeLessThanOrEqual(3 + 1e-9);
        // Measured: the runs of nodes over a third of the way from the narrowest to the widest.
        let runs = 0;
        let on = false;
        for (const w of r.width) {
          const up = w >= lo + 0.35 * (hi - lo);
          if (up && !on) runs++;
          on = up;
        }
        expect(runs, at).toBe(r.pools);
      }
    }
  });

  it("lays a core over 22–80 % of a main ribbon's length at 13–42 % of its width; the lead-in has none", () => {
    for (const { at, plan } of heroPlans()) {
      for (const r of plan.ribbons) {
        if (plan.band === 'lead') {
          expect(r.core.every((c) => c === 0), at).toBe(true);
          continue;
        }
        for (const c of r.core) if (c > 0) expect(c >= 0.13 && c <= 0.42, `${at} share ${c}`).toBe(true);
        if (!r.main) continue;
        const cum = cumulative(r.path);
        let cored = 0;
        for (let i = 0; i < r.path.length - 1; i++) if (r.core[i] > 0 && r.core[i + 1] > 0) cored += cum[i + 1] - cum[i];
        const share = cored / cum[cum.length - 1];
        expect(share, at).toBeGreaterThanOrEqual(0.22);
        expect(share, at).toBeLessThanOrEqual(0.8);
      }
    }
  });

  it('adds 1–3 thin bolts, 0.1–0.26 U long, 0.004–0.013 S wide, of tortuosity 1.03–1.09', () => {
    for (const { at, ictx, plan } of heroPlans()) {
      const { U, S } = washes.energyFrame(ictx);
      expect(plan.bolts.length, at).toBeGreaterThanOrEqual(1);
      expect(plan.bolts.length, at).toBeLessThanOrEqual(3);
      for (const b of plan.bolts) {
        const chord = Math.hypot(b.path[b.path.length - 1][0] - b.path[0][0], b.path[b.path.length - 1][1] - b.path[0][1]);
        const length = cumulative(b.path).at(-1)!;
        expect(chord / U, at).toBeGreaterThanOrEqual(0.1 - 1e-9);
        expect(chord / U, at).toBeLessThanOrEqual(0.26 + 1e-9);
        expect(Math.max(...b.width) / S, at).toBeGreaterThanOrEqual(0.004);
        expect(Math.max(...b.width) / S, at).toBeLessThanOrEqual(0.013);
        expect(length / chord, at).toBeGreaterThanOrEqual(1.03);
        expect(length / chord, at).toBeLessThanOrEqual(1.09);
      }
    }
  });

  it('draws in the discharge set (decision 6) and emits its glow at the gain: bands and bolts as bodies, core runs as cores', () => {
    for (const { at, plan } of heroPlans().filter((p) => p.ictx.seed === HERO.seed)) {
      expect(plan.tones, at).toEqual(DISCHARGE);
      expect(plan.boost, at).toBe(1);
      const sink = recordingSink();
      lightning.emitLightning(sink, plan);
      const strokes = sink.calls.filter(isStroke);
      expect(strokes.length, at).toBe(sink.calls.length);
      const bodies = plan.ribbons.length + sum(plan.ribbons.map((r) => r.eyes.length)) + plan.bolts.length;
      expect(strokes.filter((c) => c.kind === 'body').length, at).toBe(bodies);
      expect(strokes.filter((c) => c.kind === 'core').every((c) => c.color === DISCHARGE.core), at).toBe(true);
      expect(strokes.filter((c) => c.kind === 'core').length > 0, at).toBe(plan.band !== 'lead');
      expect(strokes.every((c) => c.gain === plan.gain), at).toBe(true);
    }
  });

  it('follows its sources: every ribbon starts within reach of one', () => {
    for (const { at, ictx, plan } of heroPlans().filter((p) => p.ictx.seed === HERO.seed)) {
      const lines = sources(ictx);
      const { U } = washes.energyFrame(ictx);
      const near = (p: Vec2) => {
        let best = Infinity;
        for (const line of lines) for (const q of line) best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1]));
        return best;
      };
      // The floor arcs and line round P are sources too; the ribbons stray at most 1.6 kink widths, plus the wobble.
      const fr = washes.energyFrame(ictx);
      const floor = lightning.floorLines(ictx, fr);
      for (const r of plan.ribbons) {
        const d = Math.min(near(r.path[0]), ...floor.map((line) => Math.min(...line.map((q) => Math.hypot(r.path[0][0] - q[0], r.path[0][1] - q[1])))));
        expect(d / U, at).toBeLessThan(0.25);
      }
    }
  });
});

// ---- The kr clock -------------------------------------------------------------------------------

describe('the kr clock', () => {
  it('draws the same lightning on both frames of a 2-frame kr step, a new one on every step, and the same again for the same j', () => {
    const ictx = scene();
    const src = sources(ictx);
    const pairs = [15, 20, 25, 30, 35]; // kr holds 2 frames on j 5k, 5k + 1
    for (const j of pairs) {
      expect(kr(j + 1), `j${j}`).toBe(kr(j));
      const first = lightning.ribbons(ictx, j, src)!;
      const second = lightning.ribbons(ictx, j + 1, src)!;
      expect(second.j, `j${j}`).toBe(j + 1);
      expect({ ...second, j }, `j${j}`).toEqual(first); // all but the frame it is for
    }
    const steps = krSteps(13, 39);
    for (let i = 1; i < steps.length; i++) {
      const a = lightning.ribbons(ictx, steps[i - 1], src)!;
      const b = lightning.ribbons(ictx, steps[i], src)!;
      expect(b.key, `j${steps[i]}`).not.toBe(a.key);
      expect(b.ribbons[0].path, `j${steps[i]}`).not.toEqual(a.ribbons[0].path);
      expect(b.bolts[0].path, `j${steps[i]}`).not.toEqual(a.bolts[0].path);
    }
    for (const j of steps) expect(lightning.ribbons(ictx, j, src), `j${j}`).toEqual(lightning.ribbons(scene(), j, sources(scene())));
    // The A17 flood holds its 2-frame step too.
    expect(washes.floodShapes(ictx, 31)).toEqual(washes.floodShapes(ictx, 30));
  });
});

// ---- Sparks and embers --------------------------------------------------------------------------

describe('sparks and embers', () => {
  it('draw the same particles on every frame of a hold group', () => {
    const ictx = scene({ seconds: 3 });
    const fr = washes.energyFrame(ictx);
    let groups = 0;
    for (let f = ictx.I + 10; f < ictx.I + ictx.jEnd; f++) {
      const a = particles.particles(ictx, f - 1)!;
      const b = particles.particles(ictx, f)!;
      if (a.g !== b.g) {
        groups++;
        expect(b.sparks!.particles, `f${f}`).not.toEqual(a.sparks!.particles);
        continue;
      }
      expect(b.unit, `f${f}`).toBe(a.unit);
      expect(b.sparks, `f${f}`).toEqual(a.sparks);
      expect(b.embers, `f${f}`).toEqual(a.embers);
      expect(particles.particleShapes(ictx, b), `f${f}`).toEqual(particles.particleShapes(ictx, a));
      expect(b.unit).toBeCloseTo(fr.U * b.sparks!.zoom, 9);
    }
    expect(groups).toBeGreaterThan(20);
  });

  it('carry 40–60 % of them over at each group change, each within 0.05 U, the rest drawn afresh', () => {
    for (const tier of ['full', 'phone'] as const) {
      const ictx = scene({ seconds: 3, tier });
      const fr = washes.energyFrame(ictx);
      const last = washes.groupClock(ictx, ictx.I + ictx.jEnd - 1)!.g;
      let changes = 0;
      for (const kind of ['spark', 'ember'] as const) {
        for (let g = 1; g <= last; g++) {
          const a = particles.particleGroup(ictx, kind, g - 1);
          const b = particles.particleGroup(ictx, kind, g);
          if (!a || !b) continue;
          const at = `${tier} ${kind} g${g - 1}→g${g}`;
          changes++;
          const before = new Map(a.particles.map((p) => [p.id, p]));
          const carried = b.particles.filter((p) => before.has(p.id));
          expect(carried.length, at).toBe(b.carried);
          const share = carried.length / Math.min(a.particles.length, b.particles.length);
          expect(share, at).toBeGreaterThanOrEqual(0.4);
          expect(share, at).toBeLessThanOrEqual(0.6);
          for (const p of carried) {
            const q = before.get(p.id)!;
            const x = particles.particleAt(fr, p, fr.U * b.zoom);
            const y = particles.particleAt(fr, q, fr.U * a.zoom);
            expect(Math.hypot(x[0] - y[0], x[1] - y[1]) / fr.U, at).toBeLessThanOrEqual(0.05);
            expect(Math.hypot(p.n - q.n, p.t - q.t), at).toBeLessThanOrEqual(particles.JITTER + 1e-12);
          }
          for (const p of b.particles) if (!before.has(p.id)) expect(p.born, at).toBe(g);
        }
      }
      expect(changes, tier).toBeGreaterThan(40);
    }
  });

  it('draw 25 burst sparks, 52–54 on the ring, then 18·0.92^(A−3); 35–59 embers from A3 (13–21 under the A5–6 flash); the hold keeps g8’s', () => {
    const ictx = scene({ seconds: 3 });
    const starts = groupStarts(ictx);
    expect(starts.length).toBeGreaterThan(20);
    starts.forEach((f, g) => {
      const pf = particles.particles(ictx, f)!;
      const A = washes.GROUP_AGE[Math.min(g, washes.LAST_GROUP)];
      const sparks = pf.sparks!.particles.length;
      if (g === 0) expect(sparks).toBe(25);
      else if (g === 1) expect(sparks >= 52 && sparks <= 54, `g1 ${sparks}`).toBe(true);
      else expect(sparks, `g${g}`).toBe(Math.round(18 * 0.92 ** (A - 3)));
      if (A < 3) {
        expect(pf.embers, `g${g}`).toBeNull();
        return;
      }
      const embers = pf.embers!.particles.length;
      const [lo, hi] = g === 3 ? [13, 21] : [35, 59];
      expect(embers >= lo && embers <= hi, `g${g} ${embers} embers`).toBe(true);
      expect(embers >= particles.EMBERS[Math.min(g, 8)][0] && embers <= particles.EMBERS[Math.min(g, 8)][1], `g${g}`).toBe(true);
    });
    // Sizes and colours by age.
    expect(particles.sparkLength(0)).toBeCloseTo(0.013, 12);
    expect(particles.sparkLength(1)).toBeCloseTo(0.019, 12);
    expect(particles.sparkLength(2)).toBeCloseTo(0.019, 12);
    expect(particles.sparkLength(3)).toBeCloseTo(0.015, 12);
    expect(particles.sparkLength(5)).toBeCloseTo(0.015, 12);
    expect(particles.sparkLength(12)).toBeCloseTo(0.008, 12);
    expect(particles.emberLength(3)).toBeCloseTo(0.016, 12);
    expect(particles.emberLength(10)).toBeCloseTo(0.009, 12);
    expect(particles.emberColor(3)).toBe(FIRE.embers[0]); // #ffdf3e
    expect(particles.emberColor(12)).toBe(FIRE.embers[1]); // #ffb259
    expect(particles.SPARK_TONES.body).toBe(FIRE.amber);
  });

  it('place the burst at r 0.06–0.5 U (p50 0.34), the ring and halo at 0.46–0.8 U (p50 0.63), the embers inside the cluster’s envelope', () => {
    const ictx = scene();
    const starts = groupStarts(ictx);
    const r = (p: particles.Particle) => Math.hypot(p.n, p.t);
    const burst = particles.particleGroup(ictx, 'spark', 0)!.particles;
    expect(burst.every((p) => r(p) >= 0.06 - 1e-9 && r(p) <= 0.5 + 1e-9)).toBe(true);
    expect(Math.abs(median(burst.map(r)) - 0.34)).toBeLessThan(0.06);
    const ring: number[] = [];
    for (let g = 1; g < starts.length; g++) {
      for (const p of particles.particleGroup(ictx, 'spark', g)!.particles) if (p.born === g) ring.push(r(p));
      const embers = particles.particleGroup(ictx, 'ember', g);
      if (!embers) continue;
      const env = particles.emberEnvelope(embers.A);
      for (const p of embers.particles) if (p.born === g) expect(particles.inEnvelope(env, p.n, p.t), `g${g} ember ${p.id}`).toBe(true);
    }
    expect(ring.length).toBeGreaterThan(80);
    expect(ring.every((x) => x >= 0.46 - 1e-9 && x <= 0.8 + 1e-9)).toBe(true);
    expect(Math.abs(median(ring) - 0.63)).toBeLessThan(0.04);
  });

  it('mirror a spark born off the frame across P along u, so each one is on the frame where it is born', () => {
    // The hero, and an impact on the top edge, where the ring above P would leave the frame.
    for (const top of [false, true]) {
      let mirrored = 0;
      for (const seed of SEEDS) {
        const ictx = scene({ seed, P: top ? [540, 24] : undefined });
        for (const f of groupStarts(ictx)) {
          const pf = particles.particles(ictx, f)!;
          const shapes = particles.particleShapes(ictx, pf);
          pf.sparks!.particles.forEach((p, i) => {
            if (p.born !== pf.g) return;
            expect(shapes.sparks[i].some(onFrame), `${top ? 'top' : 'hero'} seed ${seed} f${f} spark ${p.id}`).toBe(true);
            if (p.n < 0) mirrored++; // they're drawn up the floor (n > 0): below P only as a mirror image
          });
        }
      }
      if (top) expect(mirrored).toBeGreaterThan(100);
    }
  });
});

// ---- The decay ----------------------------------------------------------------------------------

describe('decay', () => {
  it('at 1.5 s and 3 s: the bolts hold full gain on the kr step through J_end − 7, then 0 from J_end − 5', () => {
    for (const seconds of [1.5, 3]) {
      const ictx = scene({ seconds });
      const src = sources(ictx);
      const end = ictx.jEnd;
      const gain = (j: number) => lightning.ribbons(ictx, j, src)?.gain ?? 0;
      expect(gain(end - 7), `${seconds} s`).toBe(1); // the last flicker
      expect(gain(end - 8), `${seconds} s`).toBeLessThan(1);
      expect(gain(end - 6), `${seconds} s`).toBeLessThan(0.25);
      expect(gain(end - 6), `${seconds} s`).toBeGreaterThan(0);
      for (let j = end - 5; j <= end + 2; j++) expect(lightning.ribbons(ictx, j, src), `${seconds} s j${j}`).toBeNull();
      // Linear to 0 at J_end − 5 before the flicker, read on each step's last frame, so a 2-frame step never changes mid-step.
      for (let j = 13; j < end - 7; j++) {
        const { last } = washes.krSpan(j);
        expect(gain(j), `${seconds} s j${j}`).toBeCloseTo(Math.min(1, Math.max(0, (end - 5 - last) / lightning.BOLT_FADE)), 12);
        if (kr(j + 1) === kr(j)) expect(gain(j + 1)).toBe(gain(j));
      }
      for (let j = end - 30; j < end - 8; j++) expect(gain(j + 1), `${seconds} s j${j}`).toBeLessThanOrEqual(gain(j));
    }
  });

  it('at 1.5 s and 3 s: the sparks and embers fade by decayAlpha(j, J_end) and are gone at J_end', () => {
    for (const seconds of [1.5, 3]) {
      const ictx = scene({ seconds });
      const end = ictx.jEnd;
      for (let j = 9; j <= end + 2; j++) {
        const pf = particles.particles(ictx, ictx.I + j);
        if (j >= end) {
          expect(pf, `${seconds} s j${j}`).toBeNull();
          continue;
        }
        expect(pf?.alpha, `${seconds} s j${j}`).toBe(decayAlpha(j, end));
      }
      // The last frame still paints them, faintly; J_end paints nothing.
      const before = canvas();
      particles.paintParticles(before, nodeScratch, ictx, particles.particles(ictx, ictx.I + end - 1));
      expect(coverage(before), `${seconds} s`).toBeGreaterThan(0);
      const at = canvas();
      particles.paintParticles(at, nodeScratch, ictx, particles.particles(ictx, ictx.I + end));
      expect(coverage(at), `${seconds} s`).toBe(0);
    }
  });

  it('runs the hold span (3 s, j 32 on) at the from-A12 band, with no washes and no brightenings', () => {
    const ictx = scene({ seconds: 3 });
    const src = sources(ictx);
    for (let j = 32; j < ictx.jEnd - 5; j++) {
      const plan = lightning.ribbons(ictx, j, src)!;
      expect(plan.band, `j${j}`).toBe('late');
      expect(plan.boost, `j${j}`).toBe(1);
      expect(washes.floodAt(ictx, j), `j${j}`).toBeNull();
    }
  });
});

// ---- Washes -------------------------------------------------------------------------------------

describe('washes', () => {
  it('full mode keeps the measured floods, A10 16 %, A11 30 %, A15 29 % and A17 58 %, layered ink, band, ink, fringe, field', () => {
    const ictx = scene();
    const seen: number[] = [];
    for (let j = 9; j <= ictx.jEnd + 1; j++) {
      const d = washes.floodShapes(ictx, j);
      const A = kr(j) - 14;
      const spec = washes.FLOODS.find((s) => s.A === A && j <= 31);
      if (!spec) {
        expect(d, `j${j}`).toBeNull();
        continue;
      }
      seen.push(A);
      expect(d!.wash, `j${j}`).toBe(spec.wash);
      expect(d!.level, `j${j}`).toBe(1);
      expect(Math.abs(d!.share - spec.area), `j${j}`).toBeLessThan(0.01);
      const roles = d!.layers.map((l) => l.role);
      expect(roles.slice(0, 4), `j${j}`).toEqual(['ink', 'band', 'ink', 'fringe']);
      expect(roles.slice(4).every((r) => r === 'field') && roles.length === (spec.field === 'deep' ? 8 : 6), `j${j}`).toBe(true);
      expect(d!.layers[0].color).toBe(DISCHARGE.edge);
      expect(d!.layers[1].color).toBe(DISCHARGE.band);
      if (spec.field === 'deep') {
        expect(d!.layers[4].color).toBe(DISCHARGE.core); // core at the edge, paling with depth
        expect(d!.layers.at(-1)!.color).toBe(DISCHARGE.pale);
      } else {
        expect(d!.layers[4].color).toBe(mixHex(DISCHARGE.core, DISCHARGE.pale, 0.5)); // a paler rim over a saturated inside
        expect(d!.layers.at(-1)!.color).toBe(DISCHARGE.core);
      }
      const ctx = canvas();
      washes.paintFlood(ctx, nodeScratch, d, W, H);
      expect(Math.abs(coverage(ctx) - spec.area), `j${j} pixels`).toBeLessThan(0.012);
      const sink = recordingSink();
      washes.emitFlood(sink, d);
      expect(sink.calls.map((c) => c.op)).toEqual(['wash']);
    }
    expect([...new Set(seen)]).toEqual([10, 11, 15, 17]);
    expect(seen.length).toBe(5); // A17 holds 2 frames
  });

  it('gentle mode has only washes 1 and 3, at most 25 % of the frame, each ramped over 2 frames up and 2 down; wash 2 brightens the bolts', () => {
    const ictx = scene({ flash: 'safe' });
    const src = sources(ictx);
    const ramp = [1 / 3, 2 / 3, 1, 1, 2 / 3, 1 / 3];
    for (let j = 9; j <= ictx.jEnd + 1; j++) {
      const d = washes.floodShapes(ictx, j);
      const w = j >= 20 && j <= 25 ? 1 : j >= 28 && j <= 33 ? 3 : 0;
      if (w === 0) {
        expect(d, `j${j}`).toBeNull();
        continue;
      }
      expect(d!.wash, `j${j}`).toBe(w);
      expect(d!.level, `j${j}`).toBeCloseTo(ramp[j - (w === 1 ? 20 : 28)], 12);
      expect(d!.share, `j${j}`).toBeLessThanOrEqual(0.25);
      // One shape a wash, the whole ramp through.
      expect(d!.outline, `j${j}`).toEqual(washes.floodShapes(ictx, w === 1 ? 20 : 28)!.outline);
      if (d!.level === 1) {
        const ctx = canvas();
        washes.paintFlood(ctx, nodeScratch, d, W, H);
        expect(coverage(ctx), `j${j} pixels`).toBeLessThanOrEqual(0.25);
      }
    }
    // Wash 2's step (A15, j 28) is a bolt brightening.
    expect(kr(28) - 14).toBe(15);
    const plan = lightning.ribbons(ictx, 28, src)!;
    expect(plan.boost).toBe(washes.BOLT_BOOST);
    expect(plan.tones.core).toBe(mixHex(DISCHARGE.core, DISCHARGE.pale, 0.45));
    const sink = recordingSink();
    lightning.emitLightning(sink, plan);
    expect(sink.calls.every((c) => isStroke(c) && c.gain === plan.gain * washes.BOLT_BOOST)).toBe(true);
    for (const j of [22, 23, 27, 29, 30, 31]) expect(washes.boltBoost(ictx, j), `j${j}`).toBe(1);
  });

  it("lays a ramp's kept flood as the flood faded through the scratch would be, byte for byte, kept or new", () => {
    const ictx = scene({ flash: 'safe' });
    // Out of order and repeated, over a plate, so the kept flood is both
    // reused and replaced.
    for (const [i, j] of [20, 21, 24, 25, 28, 29, 32, 33, 33, 21, 32, 20].entries()) {
      const d = washes.floodShapes(ictx, j)!;
      expect(d.level, `j${j}`).toBeLessThan(1);
      const kept = canvas('#585858');
      const through = canvas('#585858');
      if (i % 3 === 0) kept.globalAlpha = through.globalAlpha = 0.8;
      washes.paintFlood(kept, nodeScratch, d, W, H);
      washes.faded(through, nodeScratch, d.level, washes.boxOf([d.outline], 2, W, H), (c) => {
        for (const l of d.layers) washes.fillUnion(c, [l.points], l.color);
      });
      const a = kept.getImageData(0, 0, W, H).data;
      const b = through.getImageData(0, 0, W, H).data;
      let differ = 0;
      for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) differ++;
      expect(differ, `j${j}`).toBe(0);
    }
  });

  it("w1 and w3 'bolt' (ladder steps 1 and 2) leave no flood pixels and brighten the bolts on their plateaus instead", () => {
    const opts = { washes: { w1: 'bolt', w3: 'bolt' } } as const;
    const ictx = scene({ flash: 'safe' });
    const src = sources(ictx);
    for (let j = 9; j <= ictx.jEnd + 1; j++) {
      expect(washes.floodShapes(ictx, j, opts), `j${j}`).toBeNull();
      expect(washes.floodLayer(ictx, j, nodeScratch, opts), `j${j}`).toBeNull();
      const boosted = [22, 23, 28, 30, 31].includes(j); // wash 1's plateau (A10–11), wash 2 (A15), wash 3's (A17)
      expect(washes.boltBoost(ictx, j, opts), `j${j}`).toBe(boosted ? washes.BOLT_BOOST : 1);
      if (j >= 13 && j <= 39) expect(lightning.ribbons(ictx, j, src, opts)!.boost, `j${j}`).toBe(boosted ? washes.BOLT_BOOST : 1);
    }
    const ctx = canvas();
    for (let j = 9; j <= ictx.jEnd; j++) washes.paintFlood(ctx, nodeScratch, washes.floodShapes(ictx, j, opts), W, H);
    expect(coverage(ctx)).toBe(0);
    // In full mode (where the ladder doesn't run) the hooks still turn washes 1 and 3; wash 2 stays a flood.
    const full = scene();
    const left = krSteps(9, 31).filter((j) => washes.floodAt(full, j, opts));
    expect(left.map((j) => kr(j) - 14)).toEqual([15]);
    expect(washes.boltBoost(full, 22, opts)).toBe(washes.BOLT_BOOST);
    expect(washes.boltBoost(full, 30, opts)).toBe(washes.BOLT_BOOST);
    expect(washes.boltBoost(full, 28, opts)).toBe(1);
  });

  it('noFlash (ladder steps 6 and 7) drops the washes, the brightenings, the veil and the A5–6 flash', () => {
    for (const flash of ['full', 'safe'] as const) {
      const ictx = scene({ flash, mask: true });
      const src = sources(ictx);
      for (let j = 9; j <= ictx.jEnd + 1; j++) {
        const f = ictx.I + j;
        expect(washes.floodAt(ictx, j, { noFlash: true }), `${flash} j${j}`).toBeNull();
        expect(washes.boltBoost(ictx, j, { noFlash: true }), `${flash} j${j}`).toBe(1);
        expect(washes.veilShapes(ictx, f, { noFlash: true }), `${flash} j${j}`).toBeNull();
        expect(washes.flashShapes(ictx, f, { noFlash: true }), `${flash} j${j}`).toBeNull();
        if (j >= 13 && j <= 39) expect(lightning.ribbons(ictx, j, src, { noFlash: true })!.boost, `${flash} j${j}`).toBe(1);
      }
      expect(washes.veilShapes(ictx, ictx.I + 16), flash).not.toBeNull();
      expect(washes.flashShapes(ictx, ictx.I + 16), flash).not.toBeNull();
    }
  });

  it('lays the dust veil on A5–6 at α 0.64 with a feathered edge, at most 0.35 over the person', () => {
    const ictx = scene({ mask: true });
    const starts = groupStarts(ictx);
    for (let f = ictx.I + 9; f < ictx.I + ictx.jEnd; f++) {
      const v = washes.veilShapes(ictx, f);
      const g = washes.groupClock(ictx, f)!.g;
      expect(v === null, `f${f}`).toBe(g !== 3);
    }
    const v = washes.veilShapes(ictx, starts[3])!;
    expect(v.alpha).toBe(0.64);
    expect(v.personAlpha).toBeCloseTo(0.35, 12);
    const ctx = canvas();
    washes.paintVeil(ctx, nodeScratch, v, MASK, W, H);
    const d = ctx.getImageData(0, 0, W, H).data;
    let person = 0;
    let rest = 0;
    let over = 0;
    for (let i = 0; i < W * H; i++) {
      const a = d[4 * i + 3];
      if (MASK.alpha[i] > 0) {
        person = Math.max(person, a);
        if (a > 0) over++;
      } else rest = Math.max(rest, a);
    }
    expect(over).toBeGreaterThan(1000); // the veil does run over him
    expect(person / 255).toBeLessThanOrEqual(0.35 + 1.5 / 255);
    expect(Math.abs(rest / 255 - 0.64)).toBeLessThan(0.015);
  });

  it('flashes A5–6 as the frame less a hole round the cluster and the person, at 0.4; gentle mode covers at most 25 %', () => {
    const full = scene({ mask: true });
    const f = full.I + 16; // the drawing that starts on A5
    expect(washes.flashShapes(full, f - 1)).toBeNull();
    const fl = washes.flashShapes(full, f)!;
    expect(fl.A).toBe(5);
    expect(fl.alpha).toBe(0.4);
    expect(fl.holes.length).toBeGreaterThanOrEqual(2); // the hole round the cluster, splinters, the window
    const ctx = canvas();
    washes.paintFlash(ctx, nodeScratch, fl, MASK, W, H);
    const d = ctx.getImageData(0, 0, W, H).data;
    const alphaAt = ([x, y]: Vec2) => d[4 * (Math.floor(y) * W + Math.floor(x)) + 3];
    expect(Math.abs(alphaAt([5, 5]) / 255 - 0.4)).toBeLessThan(0.01);
    const fr = washes.energyFrame(full);
    const g3 = washes.groupClock(full, f)!;
    const hole = [-0.35, 0.35].map((t) => washes.onFloor(fr, fr.U * g3.zoom, 0.285, t)).find(([x, y]) => MASK.alpha[Math.floor(y) * W + Math.floor(x)] === 0)!;
    expect(alphaAt(hole)).toBe(0); // the hole round the cluster, off the person
    let person = 0;
    for (let i = 0; i < W * H; i++) if (MASK.alpha[i] > 0) person = Math.max(person, d[4 * i + 3]);
    expect(person).toBe(0);
    const gentle = scene({ mask: true, flash: 'safe' });
    const gl = washes.flashShapes(gentle, f)!;
    expect(gl.share).toBeLessThanOrEqual(washes.GENTLE_FLASH_AREA + 1e-6);
    const g = canvas();
    washes.paintFlash(g, nodeScratch, gl, MASK, W, H);
    expect(coverage(g)).toBeLessThanOrEqual(0.25);
  });

  it('keeps the gentle veil and flash under +0.10 L over grey backgrounds up to L 0.6', () => {
    const ictx = scene({ flash: 'safe' });
    const f = ictx.I + 16;
    const veil = washes.veilShapes(ictx, f)!;
    const flash = washes.flashShapes(ictx, f)!;
    expect(veil.alpha).toBeLessThan(washes.VEIL.alpha);
    for (const v of [12, 40, 80, 120, 160, 200]) {
      expect(lum(v, v, v)).toBeLessThanOrEqual(0.6);
      for (const [name, paint] of [
        ['veil', (c: BrushTarget) => washes.paintVeil(c, nodeScratch, veil, null, W, H)],
        ['flash', (c: BrushTarget) => washes.paintFlash(c, nodeScratch, flash, null, W, H)],
      ] as const) {
        const ctx = canvas(`rgb(${v},${v},${v})`);
        paint(ctx);
        const d = ctx.getImageData(0, 0, W, H).data;
        const base = lum(v, v, v);
        let most = 0;
        for (let i = 0; i < d.length; i += 4) most = Math.max(most, Math.abs(lum(d[i], d[i + 1], d[i + 2]) - base));
        expect(most, `${name} over grey ${v}`).toBeLessThan(0.1);
      }
    }
  });
});

// ---- Tiers and the cut order --------------------------------------------------------------------

describe('tiers and the cut order', () => {
  it('caps the phone tier at 4 ribbons of at most 48 nodes, with no eyes', () => {
    for (const { at, plan } of plans(sources, {}, 'phone')) {
      expect(plan.ribbons.length, at).toBeLessThanOrEqual(lightning.PHONE_RIBBONS);
      expect(plan.ribbons.length, at).toBeGreaterThanOrEqual(Math.min(lightning.PHONE_RIBBONS, lightning.RIBBON_BANDS[plan.band].count[0]));
      for (const r of plan.ribbons) {
        expect(r.path.length, at).toBeLessThanOrEqual(lightning.PHONE_NODES);
        expect(r.eyes.length, at).toBe(0);
      }
      for (const b of plan.bolts) expect(b.path.length, at).toBeLessThanOrEqual(lightning.PHONE_NODES);
    }
    // The full tier keeps its eyes, about one per 0.72 U of cored path.
    expect(heroPlans().some((p) => p.plan.ribbons.some((r) => r.eyes.length > 0))).toBe(true);
  });

  it('caps the phone tier at 30 sparks and 30 embers, with no rings', () => {
    const ictx = scene({ tier: 'phone', seconds: 3 });
    for (const f of groupStarts(ictx)) {
      const pf = particles.particles(ictx, f)!;
      expect(pf.sparks!.particles.length, `f${f}`).toBeLessThanOrEqual(particles.PHONE_PARTICLES);
      expect(pf.embers?.particles.length ?? 0, `f${f}`).toBeLessThanOrEqual(particles.PHONE_PARTICLES);
      expect(particles.particleShapes(ictx, pf).rings, `f${f}`).toEqual([]);
    }
    expect(particles.particles(ictx, groupStarts(ictx)[1])!.sparks!.particles.length).toBe(30);
    const full = particles.particles(scene(), groupStarts(scene())[1])!;
    expect(particles.particleShapes(scene(), full).rings.length).toBe(full.sparks!.particles.length);
  });

  it("follows the cut order: maxRibbons 2 (step 3) keeps the longest two, 'half' (step 4) halves the particles", () => {
    const ictx = scene();
    const src = sources(ictx);
    for (const j of krSteps(13, 39)) {
      const two = lightning.ribbons(ictx, j, src, { maxRibbons: 2 })!;
      expect(two.ribbons.length, `j${j}`).toBe(2);
      expect(two.ribbons[0].extent / washes.energyFrame(ictx).U, `j${j}`).toBeGreaterThanOrEqual(0.97 * lightning.RIBBON_BANDS[two.band].longest[0]);
    }
    for (const f of groupStarts(ictx)) {
      const pf = particles.particles(ictx, f)!;
      const half = particles.particles(ictx, f, { half: true })!;
      expect(half.sparks!.particles.length, `f${f}`).toBe(Math.round(pf.sparks!.particles.length / 2));
      if (pf.embers) expect(half.embers!.particles.length, `f${f}`).toBe(Math.round(pf.embers.particles.length / 2));
    }
  });
});

// ---- Determinism and budget ---------------------------------------------------------------------

interface Modules {
  lightning: typeof lightning;
  washes: typeof washes;
  particles: typeof particles;
}
// Frame I + j's energy, in stack order: the flood, the veil, the embers and
// sparks, the lightning, the A5–6 flash.
function renderEnergy(m: Modules, ictx: washes.EnergyContext, j: number, ctx: BrushTarget) {
  const f = ictx.I + j;
  ctx.fillStyle = '#585858';
  ctx.fillRect(0, 0, W, H);
  m.washes.paintFlood(ctx, nodeScratch, m.washes.floodShapes(ictx, j), W, H);
  m.washes.paintVeil(ctx, nodeScratch, m.washes.veilShapes(ictx, f), ictx.personMask(f), W, H);
  m.particles.paintParticles(ctx, nodeScratch, ictx, m.particles.particles(ictx, f));
  m.lightning.paintLightning(ctx, nodeScratch, m.lightning.ribbons(ictx, j, sources(ictx)), W, H);
  m.washes.paintFlash(ctx, nodeScratch, m.washes.flashShapes(ictx, f), ictx.personMask(f), W, H);
}

describe('determinism and budget', () => {
  it('renders the same pixels twice, from fresh modules', async () => {
    const js = [13, 16, 18, 22, 28, 30, 35, 39, 44];
    const hashes = (m: Modules) => {
      const ictx = scene({ mask: true });
      const ctx = canvas();
      return js.map((j) => {
        renderEnergy(m, ictx, j, ctx);
        return createHash('sha256').update(ctx.getImageData(0, 0, W, H).data).digest('hex');
      });
    };
    const first = hashes({ lightning, washes, particles });
    vi.resetModules();
    const fresh: Modules = {
      lightning: await import('../../src/impact/aftermath/lightning.ts'),
      washes: await import('../../src/impact/aftermath/washes.ts'),
      particles: await import('../../src/impact/aftermath/particles.ts'),
    };
    expect(fresh.lightning).not.toBe(lightning);
    expect(hashes(fresh)).toEqual(first);
    expect(new Set(first).size).toBe(js.length);
  });

  it('draws no randomness, clock or ctx.filter', () => {
    for (const file of ['lightning', 'washes', 'particles']) {
      const src = readFileSync(new URL(`../../src/impact/aftermath/${file}.ts`, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
      expect(src, file).not.toMatch(/Math\.random|Date\.now|new Date|performance\.now|\.filter\s*=/);
    }
  });

  // The median of 10, best of up to five runs of ten: other work on the
  // machine only ever slows a run down, and a step's runs are a pass apart,
  // so a burst of it doesn't take them all. The plan is made afresh on every
  // call; a flood's shapes are kept by wash, and a gentle wash's opaque flood
  // for its ramp, so after the warm-up a step times its plan and paints with
  // those built (a wash's first frame builds its shapes, about 0.5 ms more).
  it('plans and paints one kr step of lightning and flood at 1080×608 in 6 ms or less (median of 10), full flashing and Reduce flashing, both tiers', () => {
    const cases = (['full', 'phone'] as const).flatMap((tier) =>
      (['full', 'safe'] as const).map((flash) => {
        const ictx = scene({ tier, flash });
        const src = sources(ictx);
        const ctx = canvas();
        const once = (j: number) => {
          ctx.clearRect(0, 0, W, H);
          const plan = lightning.ribbons(ictx, j, src);
          lightning.paintLightning(ctx, nodeScratch, plan, W, H);
          lightning.emitLightning(nullSink, plan);
          const flood = washes.floodShapes(ictx, j);
          washes.paintFlood(ctx, nodeScratch, flood, W, H);
          washes.emitFlood(nullSink, flood);
          ctx.getImageData(0, 0, 1, 1); // the raster is done
        };
        const steps = krSteps(13, ictx.jEnd - 6);
        for (const j of steps) for (let k = 0; k < 2; k++) once(j); // warm up
        return { name: `${tier} ${flash}`, once, best: new Map(steps.map((j) => [j, Infinity])) };
      }),
    );
    for (let run = 0; run < 5; run++) {
      for (const c of cases) {
        for (const [j, best] of c.best) {
          if (best <= 6) continue;
          const times: number[] = [];
          for (let k = 0; k < 10; k++) {
            const t0 = process.hrtime.bigint();
            c.once(j);
            times.push(Number(process.hrtime.bigint() - t0) / 1e6);
          }
          c.best.set(j, Math.min(best, median(times)));
        }
      }
    }
    const report = cases.flatMap((c) => [...c.best].map(([j, t]) => `${c.name} j${j} ${t.toFixed(2)}`));
    const over = cases.flatMap((c) => [...c.best].filter(([, t]) => t > 6).map(([j]) => `${c.name} j${j}`));
    expect(over, report.join(', ')).toEqual([]);
  });
});
