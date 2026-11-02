// Round 3, F3: the strike build-up against the reference's k0–k6 (judge
// findings motion:1, reference:6, 7, 8 and 21): one bundle at P that widens
// into it, S0's heads out of the limbs, the splash in the accent with sparse
// teeth at % of the frame, its pieces blades on one to three spines, S6's
// white-hot teardrop with the accent teeth over it, its glow, the flare star
// on S1 and S4, and the bursts mirrored back onto the frame. Stand-in limbs only.
import { describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { nullSink, recordingSink, type FloorModel, type Palette, type Vec2 } from '../../src/impact/contracts.ts';
import { DEFAULT_FLOOR, floorFrame, strikeFrame } from '../../src/impact/floor.ts';
import {
  BURST,
  FLARE,
  SPINE,
  STRIKE,
  SWELL_CORE,
  paintStrike,
  planStrike,
  splashUnit,
  strikeOptions,
  strikeTones,
  type StrikeContext,
  type StrikeLimbPath,
  type StrikePlan,
} from '../../src/impact/strike.ts';
import type { BrushTarget } from '../../src/render/glow.ts';
import { nodeScratch } from '../../src/render/headless.ts';
import { createGlow } from '../../src/render/light.ts';
import { HERO } from './helpers/impact-drawings.ts';

const PALETTE: Palette = ['#e8203a', '#f4f1ea', '#16141a'];
const W = 1080;
const H = 608;
const K = W / HERO.width;
const HERO_FLOOR: FloorModel = { ratio: 0.763, majorDeg: 2.6, up: [0.04, -1], persp: 0.68 };
const FULL = strikeOptions('full');
const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function context(P: Vec2, seed: number, d: Vec2 = [0, 1], floor: FloorModel = DEFAULT_FLOOR, flash: 'full' | 'safe' = 'full'): StrikeContext {
  return { seed, frame: strikeFrame(P, d, Math.min(W, H), 0.63, W, H, seed), floor, width: W, height: H, palette: PALETTE, flash };
}
const hero = (seed: number = HERO.seed) => context([HERO.P[0] * K, HERO.P[1] * K], seed, HERO.d, HERO_FLOOR);

// Four limbs from roots round the body above P, each roped out to its own
// side and back in (rope limbs, F1: no straight bows assumed), their tips on
// P from S1, short of it on S0.
function limbs(ictx: StrikeContext, s: number, rMax = 0.012 * ictx.frame.S): StrikeLimbPath[] {
  const { P, S } = ictx.frame;
  const roots: Vec2[] = [[-0.3, -0.8], [0.25, -0.85], [-0.45, -0.6], [0.4, -0.55]];
  return roots.map(([a, b], i) => {
    const R: Vec2 = [P[0] + a * S, P[1] + b * S];
    const side = i % 2 ? 1 : -1;
    const E: Vec2 = s === 0 ? [R[0] + (P[0] - R[0]) * 0.6 + side * 0.1 * S, R[1] + (P[1] - R[1]) * 0.6] : P;
    const centerline = Array.from({ length: 40 }, (_, k): Vec2 => {
      const t = k / 39;
      const swing = side * 0.18 * S * Math.sin(Math.PI * t) + 0.03 * S * Math.sin(3 * Math.PI * t); // an S-bend round the body
      return [R[0] + (E[0] - R[0]) * t + swing, R[1] + (E[1] - R[1]) * t];
    });
    return { id: i + 1, root: R, centerline, rMax };
  });
}

const bt = (ctx: unknown) => ctx as BrushTarget;
function render(ictx: StrikeContext, plan: StrikePlan): Uint8ClampedArray {
  const ctx = createCanvas(ictx.width, ictx.height).getContext('2d');
  paintStrike(bt(ctx), nullSink, ictx, plan);
  return ctx.getImageData(0, 0, ictx.width, ictx.height).data;
}
const only = (plan: StrikePlan, keep: 'beams' | 'splash' | 'bursts'): StrikePlan => ({
  ...plan,
  beams: keep === 'beams' ? plan.beams : [],
  splash: keep === 'splash' ? plan.splash : null,
  bursts: keep === 'bursts' ? plan.bursts : [],
  flare: null,
  charge: null,
});
const hex = (data: Uint8ClampedArray, i: number) => `#${[data[i], data[i + 1], data[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

// The drawn width across the line from P along `dir`, `at` px out: opaque pixels on the perpendicular.
function widthAcross(data: Uint8ClampedArray, P: Vec2, dir: Vec2, at: number): number {
  const c: Vec2 = [P[0] + dir[0] * at, P[1] + dir[1] * at];
  const n: Vec2 = [-dir[1], dir[0]];
  let run = 0;
  for (let k = -400; k <= 400; k += 0.5) {
    const x = Math.floor(c[0] + n[0] * k);
    const y = Math.floor(c[1] + n[1] * k);
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    if (data[(y * W + x) * 4 + 3] > 127) run += 0.5;
  }
  return run;
}
// The bundle's heading out of P: from P to the lead's station `at` px up its path.
function leadDir(plan: StrikePlan, P: Vec2, at: number): Vec2 {
  const lead = plan.beams.find((b) => b.role === 'lead')!;
  const st = lead.stations.reduce((best, x) => (Math.abs(dist(x.p, P) - at) < Math.abs(dist(best.p, P) - at) ? x : best));
  const d = dist(st.p, P);
  return [(st.p[0] - P[0]) / d, (st.p[1] - P[1]) / d];
}

describe('the bundle (motion:1, reference:8)', () => {
  it('joins the beams near P: one lead runs on to P, the strands stop where they reach it', () => {
    for (let seed = 1; seed <= 8; seed++) {
      for (let s = 1; s <= 6; s++) {
        const ictx = context([540, 560], seed);
        const { P } = ictx.frame;
        const plan = planStrike(ictx, s, limbs(ictx, s), FULL);
        expect(plan.beams).toHaveLength(4);
        const leads = plan.beams.filter((b) => b.role === 'lead');
        expect(leads).toHaveLength(1);
        const lead = leads[0];
        expect(dist(lead.stations.at(-1)!.p, P)).toBeLessThan(1e-6);
        // Each beam's whole length from what it shows: its stations run evenly from q 1 to its end's q.
        const totals = plan.beams.map((b) => polyLength(b.stations.map((x) => x.p)) / (1 - b.stations.at(-1)!.q));
        const shortest = Math.min(...totals);
        for (const b of plan.beams.filter((x) => x.role === 'strand')) {
          const end = b.stations.at(-1)!.p;
          // It stops inside the lead, its centre on the lead's edge or nearer
          // (a station's spacing of slack), by the merge's near end at the latest.
          expect(dist(end, P) / shortest, `seed ${seed} S${s}`).toBeGreaterThan(STRIKE.merge[0] - 0.06);
          const gap = Math.min(...lead.stations.map((x) => dist(x.p, end)));
          expect(gap, `seed ${seed} S${s}`).toBeLessThanOrEqual(0.5 * lead.base * STRIKE.mult[s] + 0.005 * ictx.frame.S);
          // and nothing of it lies nearer P than that
          expect(b.stations.every((x) => dist(x.p, P) >= dist(end, P) - 0.01 * ictx.frame.S)).toBe(true);
        }
      }
    }
  });

  it('makes one beam of limbs that leave side by side and run along each other (the hero’s)', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const ictx = context([540, 560], seed);
      const { P, S } = ictx.frame;
      const one = limbs(ictx, 1)[0];
      const twin: StrikeLimbPath = { ...one, id: 9, root: [one.root[0] + 0.004 * S, one.root[1]], centerline: one.centerline.map(([x, y], k, all) => [x + 0.004 * S * (1 - k / (all.length - 1)), y]) };
      for (const s of [1, 4]) {
        const plan = planStrike(ictx, s, [one, twin], FULL);
        expect(plan.beams, `seed ${seed} S${s}`).toHaveLength(1);
        expect(plan.beams[0].role).toBe('lead');
        expect(dist(plan.beams[0].stations.at(-1)!.p, P)).toBeLessThan(1e-6);
      }
    }
  });

  it('is one beam wide near P, and on S4 no wider than 0.12 S, so S6’s swell reads ≈3× it', () => {
    for (const seed of [HERO.seed, 3, 7, 11]) {
      const ictx = hero(seed);
      const { P, S } = ictx.frame;
      const draw = (s: number) => {
        const plan = planStrike(ictx, s, limbs(ictx, s), FULL);
        return { plan, data: render(ictx, only(plan, 'beams')) };
      };
      const four = draw(4);
      const lead = four.plan.beams.find((b) => b.role === 'lead')!;
      const near = [0.03, 0.06, 0.09].map((k) => widthAcross(four.data, P, leadDir(four.plan, P, k * S), k * S));
      for (const w of near) {
        expect(w / S, `seed ${seed}`).toBeLessThanOrEqual(0.12);
        // One beam: what the lead's own stations give there, not four side by side.
        expect(w).toBeLessThan(1.35 * Math.max(...lead.stations.filter((x) => x.q < STRIKE.flare + 0.05).map((x) => x.w)));
      }
      const six = draw(6);
      const swell = Math.max(...six.plan.beams.map((b) => b.target));
      expect(swell / S).toBeGreaterThanOrEqual(STRIKE.swell[0]);
      const ratio = swell / (near.reduce((a, b) => a + b, 0) / near.length);
      expect(ratio, `seed ${seed}`).toBeGreaterThan(2.5);
    }
  });

  it('widens the lead into P over its last quarter, 1.25–2.7× its body', () => {
    for (let seed = 1; seed <= 10; seed++) {
      for (let s = 1; s <= 5; s++) {
        const ictx = context([540, 560], seed);
        const lead = planStrike(ictx, s, limbs(ictx, s), FULL).beams.find((b) => b.role === 'lead')!;
        const at = (q: number) => lead.stations.reduce((best, x) => (Math.abs(x.q - q) < Math.abs(best.q - q) ? x : best)).w;
        expect(at(0) / lead.target, `seed ${seed} S${s}`).toBeGreaterThanOrEqual(STRIKE.contactEnd[s] - 1e-9);
        // No funnel: nothing in the last tenth is narrower than the body's mean (round 2 narrowed it there).
        for (const x of lead.stations.filter((st) => st.q <= 0.1)) expect(x.w / lead.target).toBeGreaterThanOrEqual(1 - 1e-9);
      }
    }
  });
});

describe('S0: the heads (reference:6)', () => {
  it('run out of each limb’s end, a third of the way to P, at half w_b, the point at the far end', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const ictx = context([540, 560], seed);
      const { P, S } = ictx.frame;
      const ls = limbs(ictx, 0);
      const plan = planStrike(ictx, 0, ls, FULL);
      expect(plan.beams).toHaveLength(ls.length);
      for (const b of plan.beams) {
        const E = ls.find((l) => l.id === b.id)!.centerline.at(-1)!;
        const st = b.stations;
        expect(b.role).toBe('head');
        expect(dist(st[0].p, E)).toBeLessThan(1e-6);
        expect(b.target).toBeCloseTo(0.5 * Math.max(2 * 0.012 * S, STRIKE.minWidth * S), 9);
        // A third of the way: its point is a third of its path from E, which bends into P.
        expect(1 - st.at(-1)!.q).toBeCloseTo(1 / 3, 1);
        const left = dist(st.at(-1)!.p, P) / dist(E, P);
        expect(left, `seed ${seed}`).toBeGreaterThan(0.5);
        expect(left, `seed ${seed}`).toBeLessThan(0.8);
        expect(st.at(-1)!.w).toBeLessThan(0.2 * b.target); // the point
        expect(st[0].w).toBeGreaterThan(st.at(-1)!.w);
      }
    }
  });

  it('draws no head for a limb already on P', () => {
    const ictx = context([540, 560], 3);
    expect(planStrike(ictx, 0, limbs(ictx, 1), FULL).beams).toEqual([]);
  });
});

describe('the splash (reference:7)', () => {
  it('is sized to % of the frame under Full (no σ²), and keeps ×σ² under Reduce flashing', () => {
    const full = hero();
    const safe = { ...full, flash: 'safe' as const };
    expect(planStrike(full, 6, [], FULL).splash!.target).toBeCloseTo(0.188 * W * H, 6);
    const gentle = planStrike(safe, 6, [], strikeOptions('safe')).splash!;
    expect(gentle.target).toBeCloseTo(0.022 * W * H * full.frame.sigma ** 2, 6);
  });

  it('is filled in the accent (p0), over its dark rim, not in the beam’s pale fill', () => {
    for (const seed of [HERO.seed, 2, 5]) {
      const ictx = hero(seed);
      const tone = strikeTones(PALETTE);
      for (const s of [4, 6]) {
        const data = render(ictx, only(planStrike(ictx, s, [], FULL), 'splash'));
        const counts = new Map<string, number>();
        let opaque = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 255) continue;
          opaque++;
          const c = hex(data, i);
          counts.set(c, (counts.get(c) ?? 0) + 1);
        }
        expect(opaque).toBeGreaterThan(0);
        expect((counts.get(tone.accent) ?? 0) / opaque, `seed ${seed} S${s}`).toBeGreaterThan(0.75);
        expect(counts.get(tone.fill) ?? 0).toBe(0);
        expect(counts.get(tone.rim) ?? 0).toBeGreaterThan(0);
      }
    }
  });

  it('breaks its bands with sparse knots, not round 2’s dense saw: under one vertex per 0.03 L of edge', () => {
    for (const seed of [HERO.seed, 4, 9]) {
      const ictx = hero(seed);
      const L = splashUnit(ictx.frame);
      for (const s of [2, 5, 6]) {
        for (const piece of planStrike(ictx, s, [], FULL).splash!.pieces) {
          for (const body of piece.parts.filter((p) => p.kind === 'body')) {
            const perimeter = polyLength([...body.shape, body.shape[0]]);
            expect(body.shape.length / (perimeter / L), `seed ${seed} S${s}`).toBeLessThan(1 / 0.03 + 2);
            // Big teeth every 0.21–0.32 L along its two edges, no more.
            expect(body.teeth.length).toBeLessThanOrEqual(Math.ceil(perimeter / (0.21 * L)) + 2);
          }
        }
      }
    }
  });

  it('measures its lengths in S under Full (its area is % of the frame) and in U under Reduce flashing (×σ²)', () => {
    const { frame } = hero();
    expect(splashUnit(frame)).toBe(frame.S);
    expect(splashUnit(frame, true)).toBe(frame.U);
    for (const seed of [HERO.seed, 3, 8]) {
      const sp = planStrike(hero(seed), 6, [], FULL).splash!;
      expect(sp.disc / frame.S).toBeGreaterThanOrEqual(0.09);
      expect(sp.disc / frame.S).toBeLessThanOrEqual(0.2);
    }
  });

  it('builds the hero’s big pieces as blades on one to three spines, not flat blobs (judge: under twice as long as wide)', () => {
    const ratios: number[] = [];
    for (const seed of [HERO.seed, 2, 5, 7]) {
      const ictx = hero(seed);
      for (const s of [4, 5, 6]) {
        for (const piece of planStrike(ictx, s, [], FULL).splash!.pieces) {
          const bodies = piece.parts.filter((p) => p.kind === 'body');
          expect(bodies.length).toBeGreaterThanOrEqual(1);
          expect(bodies.length).toBeLessThanOrEqual(SPINE.most);
          expect(piece.parts.filter((p) => p.kind === 'blade').length).toBeGreaterThanOrEqual(1);
          for (const body of bodies) {
            const [long, wide] = principalSpread(body.shape);
            ratios.push(long / wide);
            // S5's heavy piece, a tenth of the frame, runs short of room and widens.
            expect(long / wide, `seed ${seed} S${s}`).toBeGreaterThan(1.7);
          }
        }
      }
    }
    ratios.sort((a, b) => a - b);
    expect(ratios[Math.floor(ratios.length / 2)]).toBeGreaterThan(3.5);
    expect(ratios.length).toBeGreaterThan(4 * (STRIKE.pieces[4] + STRIKE.pieces[5] + STRIKE.pieces[6])); // some pieces take more than one spine
  });
});

// The spread of a polygon's outline points along its two principal axes (root mean square).
function principalSpread(poly: readonly Vec2[]): [number, number] {
  const n = poly.length;
  const mx = poly.reduce((a, p) => a + p[0], 0) / n;
  const my = poly.reduce((a, p) => a + p[1], 0) / n;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (const [x, y] of poly) {
    xx += (x - mx) ** 2 / n;
    yy += (y - my) ** 2 / n;
    xy += ((x - mx) * (y - my)) / n;
  }
  const mid = (xx + yy) / 2;
  const rad = Math.sqrt(((xx - yy) / 2) ** 2 + xy * xy);
  return [Math.sqrt(mid + rad), Math.sqrt(Math.max(1e-9, mid - rad))];
}

describe('S6: the swell’s accent teeth (reference:8)', () => {
  it('cuts accent teeth 0.02–0.04 S into the core band along both edges, painted over the core', () => {
    for (const seed of [HERO.seed, 2, 6]) {
      const ictx = hero(seed);
      const plan = planStrike(ictx, 6, limbs(ictx, 6), FULL);
      const lead = plan.beams.find((b) => b.role === 'lead')!;
      expect(lead.teeth.length).toBeGreaterThanOrEqual(6);
      // Inside the core lenses, a share of what would be core shows the accent.
      const coreOnly = render(ictx, { ...only(plan, 'beams'), beams: plan.beams.map((b) => ({ ...b, teeth: [] })) });
      const withTeeth = render(ictx, only(plan, 'beams'));
      const tone = strikeTones(PALETTE);
      let core = 0;
      let cut = 0;
      for (let i = 0; i < coreOnly.length; i += 4) {
        if (coreOnly[i + 3] < 255 || hex(coreOnly, i) !== tone.hot) continue; // the swell's core is its white-hot lens
        core++;
        if (hex(withTeeth, i) === tone.accent) cut++;
      }
      expect(core).toBeGreaterThan(0);
      expect(cut / core, `seed ${seed}`).toBeGreaterThan(0.03);
      expect(cut / core).toBeLessThan(0.5); // the core still reads
    }
  });

  it('has no teeth off S6, nor on a calm or gentle S6', () => {
    const ictx = hero();
    for (let s = 1; s <= 5; s++) for (const b of planStrike(ictx, s, limbs(ictx, s), FULL).beams) expect(b.teeth).toEqual([]);
    for (const opts of [strikeOptions('safe'), strikeOptions('safe', 3), { swell: false, calm: false }]) {
      for (const b of planStrike(ictx, 6, limbs(ictx, 6), opts).beams) expect(b.teeth).toEqual([]);
    }
  });
});

describe('S6: the white-hot swell (motion:1, reference:8)', () => {
  it('paints its swollen beams’ core white: one teardrop, full width into P, over most of the swell', () => {
    const tone = strikeTones(PALETTE);
    expect(Math.min(...[1, 3, 5].map((i) => parseInt(tone.hot.slice(i, i + 2), 16)))).toBeGreaterThanOrEqual(240);
    for (const seed of [HERO.seed, 2, 6]) {
      const ictx = hero(seed);
      const plan = planStrike(ictx, 6, limbs(ictx, 6), FULL);
      for (const b of plan.beams) {
        expect(b.hot).toBe(true);
        expect(b.core).toHaveLength(1);
        expect(b.coreShare).toBeGreaterThan(0.4); // a strand stops early in the swell, its thin part a bigger share
        expect(b.coreShare).toBeLessThanOrEqual(SWELL_CORE.share + 1e-9);
      }
      // The lead's lens runs on at full width into P: as wide near P as at its middle.
      const lead = plan.beams.find((x) => x.role === 'lead')!;
      const mask = createCanvas(W, H).getContext('2d');
      mask.fillStyle = '#fff';
      mask.beginPath();
      lead.core[0].forEach(([x, y], k) => (k ? mask.lineTo(x, y) : mask.moveTo(x, y)));
      mask.closePath();
      mask.fill();
      const lensData = mask.getImageData(0, 0, W, H).data;
      const across = (lo: number, hi: number) => {
        const widths = lead.stations
          .filter((st) => st.q >= lo && st.q <= hi)
          .map((st) => {
            let run = 0;
            for (let k = -400; k <= 400; k += 0.5) {
              const x = Math.floor(st.p[0] + st.n[0] * k);
              const y = Math.floor(st.p[1] + st.n[1] * k);
              if (x >= 0 && y >= 0 && x < W && y < H && lensData[(y * W + x) * 4] > 127) run += 0.5;
            }
            return run;
          });
        return widths.reduce((a, b) => a + b, 0) / widths.length;
      };
      expect(across(0.03, 0.15), `seed ${seed}`).toBeGreaterThan(0.8 * across(0.45, 0.55));
      expect(across(0.45, 0.55)).toBeGreaterThan(1.5 * across(0.85, 0.95)); // and narrows toward the root
      // Painted: most of the swell's drawn pixels are white-hot.
      const data = render(ictx, only(plan, 'beams'));
      let hot = 0;
      let all = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 255) continue;
        all++;
        if (hex(data, i) === tone.hot) hot++;
      }
      expect(hot / all, `seed ${seed}`).toBeGreaterThan(0.35);
    }
  });

  it('keeps the table’s pale core on every other beam, and on a calm, gentle or unswollen S6', () => {
    const ictx = hero();
    for (let s = 0; s <= 5; s++) for (const b of planStrike(ictx, s, limbs(ictx, s), FULL).beams) expect(b.hot).toBe(false);
    for (const opts of [strikeOptions('safe'), strikeOptions('safe', 3), { swell: false, calm: false }]) {
      for (const b of planStrike(ictx, 6, limbs(ictx, 6), opts).beams) expect(b.hot).toBe(false);
    }
  });

  it('is the whitest step by far, its teeth still pink over its glow, and S1 is dim', () => {
    const white = (s: number, seed = HERO.seed) => {
      const ictx = hero(seed);
      const plan = planStrike(ictx, s, limbs(ictx, s), FULL);
      const canvas = createCanvas(W, H);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#5a4a40'; // a mid-dark room
      ctx.fillRect(0, 0, W, H);
      const glow = createGlow(nodeScratch, W, H, { main: PALETTE[0] });
      paintStrike(bt(ctx), glow, ictx, plan);
      glow.composite(bt(ctx), 1);
      const data = ctx.getImageData(0, 0, W, H).data;
      let n = 0;
      for (let i = 0; i < data.length; i += 4) if (Math.min(data[i], data[i + 1], data[i + 2]) >= 240) n++;
      return { share: n / (W * H), data, plan };
    };
    const s1 = white(1).share;
    const s6 = white(6);
    expect(s6.share).toBeGreaterThan(0.025);
    expect(s6.share).toBeGreaterThan(5 * s1);
    expect(s1).toBeLessThan(0.01);
    // The teeth over the white: their pixels' green channel stays well under the lens's.
    const teeth = createCanvas(W, H).getContext('2d');
    teeth.fillStyle = '#fff';
    for (const poly of s6.plan.beams.flatMap((b) => b.teeth)) {
      teeth.beginPath();
      poly.forEach(([x, y], k) => (k ? teeth.lineTo(x, y) : teeth.moveTo(x, y)));
      teeth.closePath();
      teeth.fill();
    }
    const mask = teeth.getImageData(0, 0, W, H).data;
    const hot = createCanvas(W, H).getContext('2d');
    paintStrike(bt(hot), nullSink, hero(), { ...only(s6.plan, 'beams'), beams: s6.plan.beams.map((b) => ({ ...b, teeth: [] })) });
    const lens = hot.getImageData(0, 0, W, H).data;
    const tone = strikeTones(PALETTE);
    const green = { teeth: 0, lens: 0 };
    const count = { teeth: 0, lens: 0 };
    for (let i = 0; i < mask.length; i += 4) {
      const k = mask[i] === 255 ? 'teeth' : hex(lens, i) === tone.hot ? 'lens' : null;
      if (!k) continue;
      green[k] += s6.data[i + 1];
      count[k]++;
    }
    expect(count.teeth).toBeGreaterThan(0);
    expect(count.lens).toBeGreaterThan(count.teeth);
    expect(green.lens / count.lens).toBeGreaterThan(240); // white under the glow
    expect(green.teeth / count.teeth).toBeLessThan(green.lens / count.lens - 40); // pink against it
  });
});

describe('the flare and the bursts (reference:8, 21)', () => {
  it('puts a white flare star at P on S1 and S4 only: 8–10 points out to 0.02–0.035 S, laid on the floor, emitting as core', () => {
    const ictx = hero();
    const { P, S } = ictx.frame;
    const { n: up } = floorFrame(P, ictx.floor);
    const tone = strikeTones(PALETTE);
    for (let s = 0; s < 7; s++) {
      const plan = planStrike(ictx, s, limbs(ictx, s), FULL);
      if (!(STRIKE.flares as readonly number[]).includes(s)) {
        expect(plan.flare).toBeNull();
        continue;
      }
      const star = plan.flare!;
      expect(star.length % 2).toBe(0);
      expect(star.length / 2).toBeGreaterThanOrEqual(FLARE.points[0]);
      expect(star.length / 2).toBeLessThanOrEqual(FLARE.points[1]);
      const flat = star.map((p): number => {
        const d: Vec2 = [p[0] - P[0], p[1] - P[1]];
        const along = (d[0] * up[0] + d[1] * up[1]) * (1 / ictx.floor.ratio - 1);
        return Math.hypot(d[0] + along * up[0], d[1] + along * up[1]) / S;
      });
      const tips = flat.filter((_, i) => i % 2 === 0);
      for (const t of tips) {
        expect(t).toBeGreaterThanOrEqual(FLARE.tip[0] - 1e-9);
        expect(t).toBeLessThanOrEqual(FLARE.tip[1] + 1e-9);
      }
      const sink = recordingSink();
      const ctx = createCanvas(W, H).getContext('2d');
      paintStrike(bt(ctx), sink, ictx, plan);
      expect(sink.calls.filter((c) => c.op === 'fill' && c.kind === 'core' && c.color === tone.core && c.outline.length === star.length && c.outline.every((p, i) => p[0] === star[i][0] && p[1] === star[i][1]))).toHaveLength(1);
    }
  });

  it('mirrors an arc the frame cuts back onto it, on the hero (P on the bottom edge), and none toward the striker', () => {
    let mirrored = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const ictx = hero(seed);
      const { P, u } = ictx.frame;
      const { n: up } = floorFrame(P, ictx.floor);
      for (const s of STRIKE.bursts) {
        for (const arc of planStrike(ictx, s, [], FULL).bursts) {
          const on = arc.points.filter(([x, y]) => x >= 0 && x <= W && y >= 0 && y <= H).length / arc.points.length;
          if (arc.mirrored) {
            mirrored++;
            expect(on).toBeGreaterThan(0);
          }
          const end = arc.points.at(-1)!;
          const d: Vec2 = [end[0] - P[0], end[1] - P[1]];
          const along = (d[0] * up[0] + d[1] * up[1]) * (1 / ictx.floor.ratio - 1);
          const flat: Vec2 = [d[0] + along * up[0], d[1] + along * up[1]];
          const fromSource = (Math.acos(Math.max(-1, Math.min(1, -(flat[0] * u[0] + flat[1] * u[1]) / Math.hypot(...flat)))) * 180) / Math.PI;
          expect(fromSource).toBeGreaterThanOrEqual(BURST.open - 1e-6);
        }
      }
    }
    expect(mirrored).toBeGreaterThan(30); // most of the hero's arcs head down, off the bottom edge
    // P in the middle of the frame: nothing to mirror.
    for (const arc of planStrike(context([540, 304], 3), 4, [], FULL).bursts) expect(arc.mirrored).toBe(false);
  });

  it('draws more of the hero’s bursts on the frame than it would unmirrored', () => {
    const ictx = hero();
    const plan = planStrike(ictx, 4, [], FULL);
    const shown = render(ictx, only(plan, 'bursts'));
    let px = 0;
    for (let i = 3; i < shown.length; i += 4) if (shown[i] > 127) px++;
    expect(px).toBeGreaterThan(0.0015 * W * H);
  });
});

function polyLength(pts: readonly Vec2[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  return L;
}
