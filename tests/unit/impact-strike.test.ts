// The strike (impact WP5, design §4), limbs first: the schedule on j −8..−1,
// the beams' widths, path, swell and calm clamps, the splash's area, empty
// disc, angles, floor and frame, the bursts' steps, the charge and the glow,
// S3's hold, the tones, and determinism. Everything is drawn here, on
// stand-in limbs; nothing is read from fixtures.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { nullSink, recordingSink, syntheticTube, type FloorModel, type GlowSink, type Palette, type Vec2 } from '../../src/impact/contracts.ts';
import { DEFAULT_FLOOR, floorFrame, strikeFrame } from '../../src/impact/floor.ts';
import { isSaturatedRed } from '../../src/impact/palette.ts';
import {
  BURST,
  CHARGE_RADIUS,
  SPLASH,
  SPLASH_ANGLES,
  STRIKE,
  STRIKE_J,
  chargeAt,
  drawStrike,
  onFloor,
  paintStrike,
  planStrike,
  planStrikeContact,
  strikeFrames,
  strikeHold,
  strikeLimbOf,
  strikeOptions,
  strikeStep,
  strikeStepAt,
  strikeTones,
  type StrikeContext,
  type StrikeLimbPath,
  type StrikePlan,
} from '../../src/impact/strike.ts';
import type { BrushTarget } from '../../src/render/glow.ts';
import { HERO } from './helpers/impact-drawings.ts';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PALETTE: Palette = ['#e8203a', '#f4f1ea', '#16141a'];
const W = 1080; // the app's internal frame
const H = 608;
const K = W / HERO.width; // clip px to app px
const HERO_FLOOR: FloorModel = { ratio: 0.763, majorDeg: 2.6, up: [0.04, -1], persp: 0.68 }; // his slam's floor
const FLAT: FloorModel = { ratio: 1, majorDeg: 0, up: [0, -1], persp: 0 };
const FULL = strikeOptions('full');

interface Scene {
  P?: Vec2;
  d?: Vec2;
  seed?: number;
  floor?: FloorModel;
  w?: number;
  h?: number;
  sigma?: number;
  flash?: 'safe' | 'full';
}
function context(o: Scene = {}): StrikeContext {
  const w = o.w ?? W;
  const h = o.h ?? H;
  const seed = o.seed ?? HERO.seed;
  return {
    seed,
    frame: strikeFrame(o.P ?? [w / 2, h / 2], o.d ?? [0, 1], Math.min(w, h), o.sigma ?? 0.63, w, h, seed),
    floor: o.floor ?? DEFAULT_FLOOR,
    width: w,
    height: h,
    palette: PALETTE,
    flash: o.flash ?? 'full',
  };
}
const heroP: Vec2 = [HERO.P[0] * K, HERO.P[1] * K];
const hero = (seed: number = HERO.seed, flash: 'safe' | 'full' = 'full') => context({ P: heroP, d: HERO.d, seed, floor: HERO_FLOOR, flash });

// A centreline from R to E bowed sideways by `bow` × its length at the middle.
function bowed(R: Vec2, E: Vec2, bow: number, n = 32): Vec2[] {
  const d: Vec2 = [E[0] - R[0], E[1] - R[1]];
  const L = Math.hypot(d[0], d[1]);
  const nrm: Vec2 = [-d[1] / L, d[0] / L];
  return Array.from({ length: n }, (_, k): Vec2 => {
    const t = k / (n - 1);
    const off = bow * L * Math.sin(Math.PI * t);
    return [R[0] + d[0] * t + nrm[0] * off, R[1] + d[1] * t + nrm[1] * off];
  });
}

// Four stand-in limbs from roots above P, each bowing out to its own side and
// back into P (from S1 on the tips are pinned there); on S0 still in flight,
// their tips short of P.
function limbs(ictx: StrikeContext, s: number, rMax = 0.012 * ictx.frame.S): StrikeLimbPath[] {
  const { P, S } = ictx.frame;
  const roots: Vec2[] = [[-0.3, -0.8], [0.25, -0.85], [-0.45, -0.6], [0.4, -0.55]];
  return roots.map(([a, b], i) => {
    const R: Vec2 = [P[0] + a * S, P[1] + b * S];
    const side = i % 2 ? 1 : -1;
    const E: Vec2 = s === 0 ? [R[0] + (P[0] - R[0]) * 0.6 + side * 0.1 * S, R[1] + (P[1] - R[1]) * 0.6] : P;
    return { id: i + 1, root: R, centerline: bowed(R, E, 0.12 * side), rMax };
  });
}

const bt = (ctx: unknown) => ctx as BrushTarget;
function render(ictx: StrikeContext, plan: StrikePlan, sink: GlowSink = nullSink): Uint8ClampedArray {
  const ctx = createCanvas(ictx.width, ictx.height).getContext('2d');
  paintStrike(bt(ctx), sink, ictx, plan);
  return ctx.getImageData(0, 0, ictx.width, ictx.height).data;
}
const splashOnly = (plan: StrikePlan): StrikePlan => ({ ...plan, beams: [], bursts: [], charge: null });
const beamsOnly = (plan: StrikePlan): StrikePlan => ({ ...plan, splash: null, bursts: [], charge: null });
const coverage = (data: Uint8ClampedArray) => {
  let sum = 0;
  for (let i = 3; i < data.length; i += 4) sum += data[i];
  return sum / 255;
};
const sha = (data: Uint8ClampedArray) => createHash('sha256').update(data).digest('hex');
const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
const DEG = 180 / Math.PI;

// The area of a polygon inside the w × h frame (Sutherland–Hodgman).
function areaOnFrame(poly: readonly Vec2[], w: number, h: number): number {
  let pts: Vec2[] = poly.map((p): Vec2 => [p[0], p[1]]);
  for (const [at, axis, sign] of [[0, 0, 1], [w, 0, -1], [0, 1, 1], [h, 1, -1]] as const) {
    const inside = (p: Vec2) => sign * (p[axis] - at) >= 0;
    const cut = (a: Vec2, b: Vec2): Vec2 => {
      const t = (at - a[axis]) / (b[axis] - a[axis]);
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    };
    const out: Vec2[] = [];
    pts.forEach((b, i) => {
      const a = pts[(i + pts.length - 1) % pts.length];
      if (inside(b)) {
        if (!inside(a)) out.push(cut(a, b));
        out.push(b);
      } else if (inside(a)) out.push(cut(a, b));
    });
    pts = out;
    if (!pts.length) return 0;
  }
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a / 2);
}

// ---- The schedule -------------------------------------------------------------------------------

describe('the schedule, limbs first', () => {
  it('draws S0..S6 on j −8..−1 by the reference clock, S3 on j −5 and −4', () => {
    const js = Array.from({ length: STRIKE_J.last - STRIKE_J.first + 1 }, (_, i) => STRIKE_J.first + i);
    expect(js).toEqual([-8, -7, -6, -5, -4, -3, -2, -1]);
    expect(js.map(strikeStep)).toEqual([0, 1, 2, 3, 3, 4, 5, 6]);
    for (const j of [-12, -9, 0, 1, 9]) expect(strikeStep(j)).toBeNull();
    expect(strikeStepAt(77, HERO.I)).toBe(1); // the limbs land on P at I − 7
    expect(strikeStepAt(84, HERO.I)).toBeNull(); // the white-out's frame
    expect(Array.from({ length: 7 }, (_, s) => strikeFrames(s, HERO.I))).toEqual([[76], [77], [78], [79, 80], [81], [82], [83]]);
  });

  it('holds S3 as one drawing from its first frame', () => {
    expect(strikeHold(-5)).toBe(-5);
    expect(strikeHold(-4)).toBe(-5);
    for (const j of [-8, -7, -6, -3, -2, -1]) expect(strikeHold(j)).toBe(j);
    expect(strikeHold(0)).toBeNull();
  });

  it('charges by the table, and fades over j 0..3 only when there are no posters', () => {
    expect([-8, -7, -6, -5, -4, -3, -2, -1].map((j) => chargeAt(j))).toEqual([0, 0.11, 0.16, 0.06, 0.06, 0.38, 0.82, 1]);
    expect([0, 1, 2, 3, 4].map((j) => chargeAt(j))).toEqual([0, 0, 0, 0, 0]);
    expect([0, 1, 2, 3, 4].map((j) => chargeAt(j, false))).toEqual([1, 1 - 1 / 3, 1 - 2 / 3, 0, 0]);
  });

  it('refuses a step outside 0..6', () => {
    for (const s of [-1, 7, 2.5]) expect(() => planStrike(context(), s, [], FULL)).toThrow(/steps 0\.\.6/);
  });
});

// ---- Tones ----------------------------------------------------------------------------------------

describe('tones', () => {
  it('paints the strike tones of p0 under full flashing', () => {
    const t = strikeTones(PALETTE);
    expect([t.edge, t.accent, t.fill, t.core]).toEqual(['#7f1a2a', '#e8203a', '#ef939b', '#f3d8d5']);
  });

  it('keeps no saturated red under Reduce flashing (G4)', () => {
    const t = strikeTones(PALETTE, 'safe');
    const all = [t.edge, t.accent, t.fill, t.core, t.rim, ...Object.values(t.discharge)];
    for (const c of all) expect(isSaturatedRed(c), c).toBe(false);
    // and the drawn pixels follow: no saturated red in a safe S4
    const ictx = hero(HERO.seed, 'safe');
    const data = render(ictx, planStrike(ictx, 4, limbs(ictx, 4), strikeOptions('safe')));
    let red = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 255) continue;
      const hex = `#${[data[i], data[i + 1], data[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
      if (isSaturatedRed(hex)) red++;
    }
    expect(red).toBe(0);
  });
});

// ---- Beams ----------------------------------------------------------------------------------------

describe('beams', () => {
  it('hold w_b·m[s] within 5 % over their body, w_b = max(2·r_max, 0.05 S)', () => {
    for (const rMaxOfS of [0.012, 0.04]) {
      for (let s = 0; s < 7; s++) {
        for (let seed = 1; seed <= 6; seed++) {
          const ictx = context({ P: [540, 560], seed });
          const S = ictx.frame.S;
          const plan = planStrike(ictx, s, limbs(ictx, s, rMaxOfS * S), { swell: false, calm: false });
          expect(plan.beams).toHaveLength(4);
          for (const b of plan.beams) {
            expect(b.base).toBeCloseTo(Math.max(2 * rMaxOfS * S, STRIKE.minWidth * S), 9);
            expect(b.target / b.base).toBeCloseTo(STRIKE.mult[s], 9);
            const [a, z] = b.body;
            let sum = 0;
            for (let i = a; i <= z; i++) sum += b.stations[i].left + b.stations[i].right;
            expect(Math.abs(sum / (z - a + 1) / b.target - 1)).toBeLessThan(0.05);
            // The contact end flares to at least ×1.25–2.7 of it (a bulge already wider stays).
            const end = b.stations[b.stations.length - 1].w / b.target;
            if (s >= 1 && s <= 5) expect(end).toBeGreaterThanOrEqual(STRIKE.contactEnd[s] - 1e-9);
            if (s === 5) expect(end).toBeCloseTo(STRIKE.contactEnd[5], 9);
          }
        }
      }
    }
  });

  it('draw that width: a straight beam measures w_b·m[s] within 5 % on the canvas', () => {
    for (const s of [1, 3, 4]) {
      for (const seed of [3, 4]) {
        const ictx = context({ P: [540, 580], seed });
        const R: Vec2 = [540, 60];
        const plan = planStrike(ictx, s, [{ id: 1, root: R, centerline: bowed(R, ictx.frame.P, 0), rMax: 0.012 * ictx.frame.S }], FULL);
        const [b] = plan.beams;
        const st = b.stations;
        const axis: Vec2 = [st[st.length - 1].p[0] - st[0].p[0], st[st.length - 1].p[1] - st[0].p[1]];
        const cos = Math.abs(axis[1]) / Math.hypot(axis[0], axis[1]);
        // The rows the body spans, two px in from either end.
        const [y0, y1] = [st[b.body[0]].p[1], st[b.body[1]].p[1]].sort((p, q) => p - q);
        const data = render(ictx, beamsOnly(plan));
        const widths: number[] = [];
        for (let y = Math.ceil(y0) + 2; y < Math.floor(y1) - 2; y++) {
          let row = 0;
          for (let x = 0; x < W; x++) row += data[(y * W + x) * 4 + 3] / 255;
          widths.push(row * cos);
        }
        expect(widths.length).toBeGreaterThan(200);
        expect(Math.abs(mean(widths) / b.target - 1), `S${s} seed ${seed}`).toBeLessThan(0.05);
      }
    }
  });

  it('swell S6 to 0.30–0.38 S over the last 40 %', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const ictx = context({ P: [540, 560], seed });
      const S = ictx.frame.S;
      const plan = planStrike(ictx, 6, limbs(ictx, 6), FULL);
      for (const b of plan.beams) {
        expect(b.target / S).toBeGreaterThanOrEqual(STRIKE.swell[0]);
        expect(b.target / S).toBeLessThanOrEqual(STRIKE.swell[1]);
        const near = b.stations.filter((x) => x.q <= 0.4);
        expect(Math.abs(mean(near.map((x) => x.left + x.right)) / b.target - 1)).toBeLessThan(0.05);
        expect(Math.max(...b.stations.filter((x) => x.q >= 0.6).map((x) => x.w))).toBeLessThan(b.target);
      }
    }
  });

  it('calm: the multipliers clamp to 0.7–1.0 and S6 stays at 1.0·w_b; only Reduce flashing from ladder step 3 calms', () => {
    expect(strikeOptions('full', 7)).toEqual({ swell: true, calm: false });
    expect(strikeOptions('safe', 2)).toEqual({ swell: true, calm: false });
    expect(strikeOptions('safe', 3)).toEqual({ swell: true, calm: true });
    const calm = strikeOptions('safe', 3);
    for (let s = 0; s < 7; s++) {
      for (let seed = 1; seed <= 4; seed++) {
        const ictx = context({ P: [540, 560], seed, flash: 'safe' });
        const plan = planStrike(ictx, s, limbs(ictx, s), calm);
        const want = s === 6 ? 1 : Math.min(STRIKE.calm[1], Math.max(STRIKE.calm[0], STRIKE.mult[s]));
        for (const b of plan.beams) {
          expect(b.target / b.base).toBeCloseTo(want, 9);
          expect(b.target / b.base).toBeGreaterThanOrEqual(STRIKE.calm[0]);
          expect(b.target / b.base).toBeLessThanOrEqual(STRIKE.calm[1]);
          const [a, z] = b.body;
          let sum = 0;
          for (let i = a; i <= z; i++) sum += b.stations[i].left + b.stations[i].right;
          expect(Math.abs(sum / (z - a + 1) / b.target - 1)).toBeLessThan(0.05);
        }
        // Calm is the beams' alone: what goes round P doesn't change.
        const full = planStrike(ictx, s, limbs(ictx, s), strikeOptions('safe', 2));
        expect(plan.splash).toEqual(full.splash);
        expect(plan.bursts).toEqual(full.bursts);
        expect(plan.charge).toEqual(full.charge);
      }
    }
  });

  it('shows only the third nearest the tip on S0, its head tapered to a point', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const ictx = context({ P: [540, 560], seed });
      const plan = planStrike(ictx, 0, limbs(ictx, 0), FULL);
      for (const b of plan.beams) {
        const st = b.stations;
        expect(st[0].q).toBeLessThanOrEqual(1 / 3 + 0.02);
        expect(st[st.length - 1].q).toBe(0);
        expect(st[st.length - 1].w).toBeLessThanOrEqual(0.2 * b.target);
        expect(Math.max(...st.map((x) => x.w))).toBeCloseTo(b.target, 6);
      }
    }
  });

  it('runs along mix(centreline, chord, β 0.6–0.8), turned ±3.5° about P by step, its end on P from S1', () => {
    const betas: number[] = [];
    const turns: number[] = [];
    for (let seed = 1; seed <= 30; seed++) {
      for (const s of [1, 4]) {
        const ictx = context({ P: [540, 580], seed });
        const { P } = ictx.frame;
        const R: Vec2 = [540, 80];
        const h = 0.15 * (P[1] - R[1]); // the bow at the middle
        const [b] = planStrike(ictx, s, [{ id: 1, root: R, centerline: bowed(R, P, 0.15), rMax: 5 }], FULL).beams;
        const st = b.stations;
        const end = st[st.length - 1].p;
        expect(Math.hypot(end[0] - P[0], end[1] - P[1])).toBeLessThan(1e-6);
        const root = st[0].p;
        const turn = (Math.atan2(root[1] - P[1], root[0] - P[0]) - Math.atan2(R[1] - P[1], R[0] - P[0])) * DEG;
        turns.push(turn);
        // The middle station's distance from the turned chord is (1 − β)·h.
        const mid = st.reduce((best, x) => (Math.abs(x.q - 0.5) < Math.abs(best.q - 0.5) ? x : best));
        const chord: Vec2 = [root[0] - P[0], root[1] - P[1]];
        const L = Math.hypot(chord[0], chord[1]);
        const off = Math.abs((mid.p[0] - P[0]) * chord[1] - (mid.p[1] - P[1]) * chord[0]) / L;
        betas.push(1 - off / h);
      }
    }
    for (const t of turns) expect(Math.abs(t)).toBeLessThanOrEqual(STRIKE.turnDeg + 1e-9);
    expect(Math.min(...turns)).toBeLessThan(-1.5);
    expect(Math.max(...turns)).toBeGreaterThan(1.5);
    for (const beta of betas) {
      expect(beta).toBeGreaterThan(STRIKE.beta[0] - 0.01);
      expect(beta).toBeLessThan(STRIKE.beta[1] + 0.01);
    }
    expect(Math.max(...betas) - Math.min(...betas)).toBeGreaterThan(0.1);
  });

  it('follows the core-share and edge-wobble tables', () => {
    for (let s = 0; s < 7; s++) {
      const shares: number[] = [];
      const wobble: number[] = [];
      for (let seed = 1; seed <= 15; seed++) {
        const ictx = context({ P: [540, 560], seed });
        for (const b of planStrike(ictx, s, limbs(ictx, s), FULL).beams) {
          shares.push(b.coreShare);
          const [a, z] = b.body;
          let e2 = 0;
          for (let i = a; i <= z; i++) e2 += (b.stations[i].left - b.stations[i].w / 2) ** 2 + (b.stations[i].right - b.stations[i].w / 2) ** 2;
          wobble.push(Math.sqrt(e2 / (2 * (z - a + 1))) / ictx.frame.S);
        }
      }
      expect(Math.abs(mean(shares) / STRIKE.coreShare[s] - 1), `S${s} core`).toBeLessThan(0.05);
      for (const x of shares) expect(x).toBeLessThanOrEqual(STRIKE.coreShare[s] + 1e-9);
      // S0 shows only its tapered head, which damps the wobble.
      if (s > 0) expect(Math.abs(mean(wobble) / STRIKE.wobble[s] - 1), `S${s} wobble`).toBeLessThan(0.12);
    }
  });

  it('read a limb from its tube', () => {
    const tube = syntheticTube(40, 300, 9, [100, 200], 7);
    const limb = strikeLimbOf({ ...tube, sections: tube.sections.map((x, i) => ({ ...x, r: 9 + 3 * Math.sin(i) })) });
    expect(limb.id).toBe(7);
    expect(limb.root).toEqual([100, 200]);
    expect(limb.centerline).toHaveLength(40);
    expect(limb.rMax).toBeCloseTo(Math.max(...Array.from({ length: 40 }, (_, i) => 9 + 3 * Math.sin(i))), 12);
  });
});

// ---- Splash ---------------------------------------------------------------------------------------

describe('splash', () => {
  const scenes: [string, (seed: number) => StrikeContext][] = [
    ['centre', (seed) => context({ seed })],
    ['hero', (seed) => hero(seed)],
    ['corner', (seed) => context({ P: [1060, 590], d: [0.3, 0.95], seed })],
    ['top edge', (seed) => context({ P: [300, 10], d: [0, -1], seed })],
    ['portrait', (seed) => context({ P: [304, 1000], seed, w: 608, h: 1080 })],
  ];

  it('covers the step’s % × σ² of the frame within ±15 %, outside an empty disc, every part on the frame', () => {
    let mirrored = 0;
    for (const [name, make] of scenes) {
      for (let seed = 1; seed <= 5; seed++) {
        const ictx = make(seed);
        const { P, U } = ictx.frame;
        for (let s = 1; s <= 6; s++) {
          const plan = planStrike(ictx, s, [], FULL);
          const sp = plan.splash!;
          const where = `${name} seed ${seed} S${s}`;
          expect(sp.target, where).toBeCloseTo((STRIKE.splash[s] / 100) * ictx.width * ictx.height * ictx.frame.sigma ** 2, 6);
          const data = render(ictx, splashOnly(plan));
          expect(Math.abs(coverage(data) / sp.target - 1), where).toBeLessThan(0.15);
          // The empty disc: 0.09–0.2 U, and not one pixel in it touched.
          expect(sp.disc / U).toBeGreaterThanOrEqual(SPLASH.disc[0]);
          expect(sp.disc / U).toBeLessThanOrEqual(SPLASH.disc[1]);
          let hits = 0;
          for (let y = Math.max(0, Math.floor(P[1] - sp.disc)); y <= Math.min(ictx.height - 1, Math.ceil(P[1] + sp.disc)); y++) {
            for (let x = Math.max(0, Math.floor(P[0] - sp.disc)); x <= Math.min(ictx.width - 1, Math.ceil(P[0] + sp.disc)); x++) {
              if (Math.hypot(x + 0.5 - P[0], y + 0.5 - P[1]) < sp.disc && data[(y * ictx.width + x) * 4 + 3] > 0) hits++;
            }
          }
          expect(hits, where).toBe(0);
          // 2–5 pieces, and no blade or body wholly off the frame.
          expect(sp.pieces.length).toBeGreaterThanOrEqual(2);
          expect(sp.pieces.length).toBeLessThanOrEqual(5);
          for (const piece of sp.pieces) {
            if (piece.mirrored) mirrored++;
            for (const part of piece.parts) expect(areaOnFrame(part.shape, ictx.width, ictx.height), `${where} ${part.kind}`).toBeGreaterThan(0);
          }
        }
      }
    }
    expect(mirrored).toBeGreaterThan(10); // P on an edge or in a corner sends pieces off the frame, and they come back mirrored
  });

  it('flies by the angle table, 58–71 % of it to one side (200 seeds, flat floor)', () => {
    const w = 540;
    const h = 304;
    const bins = new Array(SPLASH_ANGLES.length).fill(0);
    let pieces = 0;
    for (let seed = 0; seed < 200; seed++) {
      const a = seed * 2.399; // every heading, so the frame's edges don't favour one
      const ictx = context({ w, h, P: [w / 2, h / 2], d: [Math.cos(a), Math.sin(a)], seed, floor: FLAT });
      const { P, u, v } = ictx.frame;
      for (let s = 1; s <= 6; s++) {
        const plan = planStrike(ictx, s, [], FULL);
        const sp = plan.splash!;
        expect(sp.pieces.length).toBe(STRIKE.pieces[s]);
        pieces += sp.pieces.length;
        const data = render(ictx, splashOnly(plan));
        let heavy = 0;
        let all = 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const alpha = data[(y * w + x) * 4 + 3] / 255;
            if (!alpha) continue;
            const d: Vec2 = [x + 0.5 - P[0], y + 0.5 - P[1]];
            const along = -dot(d, u);
            const across = dot(d, v);
            const deg = Math.atan2(Math.abs(across), along) * DEG;
            bins[Math.min(bins.length - 1, Math.floor(deg / 30))] += alpha;
            all += alpha;
            if (Math.sign(across) === sp.side) heavy += alpha;
          }
        }
        expect(heavy / all, `seed ${seed} S${s}`).toBeGreaterThanOrEqual(SPLASH.share[0]);
        expect(heavy / all, `seed ${seed} S${s}`).toBeLessThanOrEqual(SPLASH.share[1]);
      }
    }
    const total = bins.reduce((p, q) => p + q, 0);
    SPLASH_ANGLES.forEach(([from, to, share], i) => expect(Math.abs((100 * bins[i]) / total - 100 * share), `${from}–${to}°`).toBeLessThanOrEqual(5));
    // Nothing within 30° of the source but a stray anti-aliased pixel where
    // sizing a piece tipped its rim over the line.
    expect(bins[0] / total).toBeLessThan(1e-5);
    expect(pieces).toBe(200 * STRIKE.pieces.reduce<number>((p, q) => p + q, 0));
  }, 120_000);

  it('lies on the floor: offsets along n̂ squashed by floor.ratio', () => {
    expect(onFloor([0, -10], [0, -1], 0.5)).toEqual([0, -5]);
    expect(onFloor([10, 0], [0, -1], 0.5)).toEqual([10, 0]);
    const up: Vec2 = [0.6, -0.8];
    const f = onFloor([3, 4], up, 0.25);
    expect(dot(f, up)).toBeCloseTo(0.25 * dot([3, 4], up), 12);
    expect(dot(f, [0.8, 0.6])).toBeCloseTo(dot([3, 4], [0.8, 0.6]), 12);
    // The drawn splash spreads along n̂ about floor.ratio as far, against t̂, as on a flat floor.
    for (let seed = 1; seed <= 6; seed++) {
      const spread = (ratio: number) => {
        const floor: FloorModel = { ratio, majorDeg: 0, up: [0, -1], persp: 0 };
        const ictx = context({ d: [0.4, 0.9], seed, floor, sigma: 0.4 });
        const { n, t } = floorFrame(ictx.frame.P, floor);
        let mn = 0;
        let mt = 0;
        for (const s of [2, 4, 6]) {
          const data = render(ictx, splashOnly(planStrike(ictx, s, [], FULL)));
          for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
              const alpha = data[(y * W + x) * 4 + 3];
              if (!alpha) continue;
              const d: Vec2 = [x + 0.5 - ictx.frame.P[0], y + 0.5 - ictx.frame.P[1]];
              mn += alpha * dot(d, n) ** 2;
              mt += alpha * dot(d, t) ** 2;
            }
          }
        }
        return Math.sqrt(mn / mt);
      };
      const k = spread(0.5) / spread(1);
      expect(k, `seed ${seed}`).toBeGreaterThan(0.45);
      expect(k, `seed ${seed}`).toBeLessThan(0.65);
    }
  });
});

// ---- Bursts, charge and glow -------------------------------------------------------------------

describe('bursts, charge and glow', () => {
  it('bursts only on S1, S4 and S5: 6–10 arcs reaching 0.10–0.25 U on the floor, none toward the striker', () => {
    for (let seed = 1; seed <= 12; seed++) {
      for (const ictx of [context({ seed, d: [0.3, 0.95] }), hero(seed)]) {
        const { P, u, U } = ictx.frame;
        const { n: up } = floorFrame(P, ictx.floor);
        const ratio = ictx.floor.ratio;
        for (let s = 0; s < 7; s++) {
          const bursts = planStrike(ictx, s, [], FULL).bursts;
          if (!(STRIKE.bursts as readonly number[]).includes(s)) {
            expect(bursts).toEqual([]);
            continue;
          }
          expect(bursts.length).toBeGreaterThanOrEqual(BURST.arcs[0]);
          expect(bursts.length).toBeLessThanOrEqual(BURST.arcs[1]);
          for (const arc of bursts) {
            expect(arc.points[0]).toEqual(P);
            // Back in floor space: n̂'s part ÷ floor.ratio.
            const flat = arc.points.map((p): Vec2 => {
              const d: Vec2 = [p[0] - P[0], p[1] - P[1]];
              const along = dot(d, up) * (1 / ratio - 1);
              return [d[0] + along * up[0], d[1] + along * up[1]];
            });
            const reach = Math.max(...flat.map((d) => Math.hypot(d[0], d[1])));
            expect(reach / U).toBeGreaterThanOrEqual(BURST.reach[0] - 1e-9);
            expect(reach / U).toBeLessThanOrEqual(BURST.reach[1] + 1e-9);
            const end = flat[flat.length - 1];
            const fromSource = Math.acos(Math.max(-1, Math.min(1, -dot(end, u) / Math.hypot(end[0], end[1])))) * DEG;
            expect(fromSource).toBeGreaterThanOrEqual(BURST.open - 1e-6);
            expect(arc.width[0] / ictx.frame.S).toBeGreaterThanOrEqual(BURST.width[0]);
            expect(arc.width[0] / ictx.frame.S).toBeLessThanOrEqual(BURST.width[1]);
          }
        }
      }
    }
  });

  it('sends the charge disc 0.05 U·(1 + 2c) and each step’s glow gains to the sink', () => {
    const ictx = hero();
    const { P, U } = ictx.frame;
    for (let s = 0; s < 7; s++) {
      const sink = recordingSink();
      const ctx = createCanvas(W, H).getContext('2d');
      const plan = drawStrike(bt(ctx), sink, ictx, s, limbs(ictx, s), FULL);
      const c = STRIKE.charge[s];
      const discs = sink.calls.flatMap((x) => (x.op === 'disc' ? [x] : []));
      if (c > 0) {
        expect(discs).toHaveLength(1);
        expect(discs[0].c).toEqual(P);
        expect(discs[0].r).toBeCloseTo(CHARGE_RADIUS * U * (1 + 2 * c), 9);
        expect(discs[0].gain).toBe(c);
      } else expect(discs).toHaveLength(0);
      const g = STRIKE.glow[s];
      const fills = sink.calls.flatMap((x) => (x.op === 'fill' ? [x] : []));
      const parts = plan.splash ? plan.splash.pieces.reduce((n, p) => n + p.parts.length, 0) : 0;
      const cores = plan.beams.reduce((n, b) => n + b.core.length, 0);
      expect(fills.filter((x) => x.kind === 'body' && x.gain === g)).toHaveLength(plan.beams.length);
      expect(fills.filter((x) => x.kind === 'core' && x.gain === g)).toHaveLength(cores);
      expect(fills.filter((x) => x.kind === 'body' && x.gain === g * SPLASH.glow)).toHaveLength(parts);
      expect(fills).toHaveLength(plan.beams.length + cores + parts);
      const strokes = sink.calls.flatMap((x) => (x.op === 'stroke' ? [x] : []));
      expect(strokes).toHaveLength(2 * plan.bursts.length);
      for (const x of strokes) expect(x.gain).toBe(g);
      expect(sink.calls.filter((x) => x.op === 'wash')).toHaveLength(0);
    }
  });

  it('has no splash, burst or charge on S0', () => {
    const plan = planStrike(hero(), 0, limbs(hero(), 0), FULL);
    expect(plan.splash).toBeNull();
    expect(plan.bursts).toEqual([]);
    expect(plan.charge).toBeNull();
  });
});

// ---- Holds and determinism -----------------------------------------------------------------------

describe('holds and determinism', () => {
  // A scene where the limbs move on every frame: j's own limbs differ.
  const movingLimbs = (ictx: StrikeContext, j: number) =>
    limbs(ictx, strikeStep(j) ?? 0).map((l) => ({ ...l, root: [l.root[0] + 9 * (j + 8), l.root[1]] as Vec2, centerline: l.centerline.map((p, i, all) => [p[0] + 9 * (j + 8) * (1 - i / (all.length - 1)), p[1]] as Vec2) }));
  const frameAt = (ictx: StrikeContext, j: number) => {
    const s = strikeStep(j)!;
    return sha(render(ictx, planStrike(ictx, s, movingLimbs(ictx, strikeHold(j)!), FULL)));
  };

  it('draws S3 the same on j −5 and −4', () => {
    const ictx = hero();
    expect(frameAt(ictx, -4)).toBe(frameAt(ictx, -5));
    expect(frameAt(ictx, -3)).not.toBe(frameAt(ictx, -4));
    expect(frameAt(ictx, -6)).not.toBe(frameAt(ictx, -5));
  });

  it('hashes the same for the same inputs, and differently for another seed or step', () => {
    const hashes = (seed: number) =>
      Array.from({ length: 7 }, (_, s) => {
        const ictx = hero(seed);
        return sha(render(ictx, planStrike(ictx, s, limbs(ictx, s), FULL)));
      });
    const a = hashes(HERO.seed);
    expect(hashes(HERO.seed)).toEqual(a);
    expect(new Set(a).size).toBe(7);
    const b = hashes(HERO.seed + 1);
    a.forEach((h, s) => expect(b[s]).not.toBe(h));
  });

  it('reads no Math.random, clock or ctx.filter in its source', () => {
    const code = readFileSync(resolve(REPO, 'src/impact/strike.ts'), 'utf8').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/Math\.random|\bDate\b|performance\.now|\.filter\s*=/);
  });

  it('draws without Math.random or clocks, and the same with what goes round P planned ahead', () => {
    const random = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random');
    });
    const now = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('Date.now');
    });
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
      throw new Error('performance.now');
    });
    try {
      for (let s = 0; s < 7; s++) {
        const ictx = hero();
        const ahead = planStrikeContact(ictx, s);
        const plan = planStrike(ictx, s, limbs(ictx, s), FULL);
        expect(planStrike(ictx, s, limbs(ictx, s), FULL, ahead)).toEqual(plan);
        expect(sha(render(ictx, plan))).toBe(sha(render(ictx, planStrike(ictx, s, limbs(ictx, s), FULL, ahead))));
      }
    } finally {
      random.mockRestore();
      now.mockRestore();
      clock.mockRestore();
    }
  });
});
