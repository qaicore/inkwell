import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, Path2D } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { recordingSink, syntheticTube, type Tube, type TubeSection, type Vec2, type Vec3 } from '../../src/impact/contracts.ts';
import { c1 } from '../../src/impact/clock.ts';
import { roles, toOklch, hueDelta } from '../../src/impact/palette.ts';
import {
  ARC_LIFT,
  ARC_TONES,
  ARC_WIDTH,
  CRAWL,
  GROWN,
  arcCount,
  arcFlicker,
  arcPhase,
  arcPlans,
  arcSamples,
  arcTones,
  drawArcs,
  emitArcs,
  sectionAt,
  sheathArcs,
  shownOf,
  type ArcPhase,
  type LinePath,
  type ArcRun,
  type ArcTarget,
  type SheathArcs,
} from '../../src/render/arcs3d.ts';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const S = 1080; // the hero's short side
const R0 = 0.02 * S; // 21.6 px
const W = ARC_WIDTH * S; // the arc width, 8 px
const P: Vec2 = [942, 1061];
const ID = 7;
const napiPath = (): LinePath => new Path2D(); // Node has no global Path2D: drawArcs takes @napi-rs/canvas's

const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit3 = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const scale3 = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];

// Design §2's radius profile, with full pressure.
const profile = (R: number) => (t: number) => Math.max(0.8, R * (1 + 0.22 * Math.max(0, 1 - t / 0.14) ** 2) * (1 - t) ** 0.55);

// A tube along a 3D curve, framed the way design §2 frames one: sections at
// equal arc length, central-difference tangents, and a double-reflection
// rotation-minimizing frame from the root's screen normal. Seen orthographically.
function curveTube(curve: (t: number) => Vec3, n: number, radius: (s: number) => number, id = 1): Tube {
  const M = 4000;
  const dense = Array.from({ length: M + 1 }, (_, i) => curve(i / M));
  const cum = [0];
  for (let i = 1; i <= M; i++) cum.push(cum[i - 1] + Math.hypot(...sub3(dense[i], dense[i - 1])));
  const length = cum[M];
  const cs: Vec3[] = [];
  for (let q = 0, i = 0; q < n; q++) {
    const target = (length * q) / (n - 1);
    while (i < M - 1 && cum[i + 1] < target) i++;
    const f = Math.min(1, Math.max(0, (target - cum[i]) / (cum[i + 1] - cum[i] || 1)));
    cs.push([0, 1, 2].map((d) => dense[i][d] + (dense[i + 1][d] - dense[i][d]) * f) as Vec3);
  }
  const Ts = cs.map((_, i) => unit3(sub3(cs[Math.min(n - 1, i + 1)], cs[Math.max(0, i - 1)])));
  const Ns: Vec3[] = [];
  const n0: Vec3 = unit3([-Ts[0][1], Ts[0][0], 0]);
  Ns.push(unit3(sub3(n0, scale3(Ts[0], dot3(n0, Ts[0])))));
  for (let i = 0; i < n - 1; i++) {
    const v1 = sub3(cs[i + 1], cs[i]);
    const k1 = dot3(v1, v1);
    const rL = sub3(Ns[i], scale3(v1, (2 / k1) * dot3(v1, Ns[i])));
    const tL = sub3(Ts[i], scale3(v1, (2 / k1) * dot3(v1, Ts[i])));
    const v2 = sub3(Ts[i + 1], tL);
    const k2 = dot3(v2, v2);
    Ns.push(unit3(k2 > 1e-18 ? sub3(rL, scale3(v2, (2 / k2) * dot3(v2, rL))) : rL));
  }
  const sections = cs.map((c, i): TubeSection => {
    const s = i / (n - 1);
    const t2 = Math.hypot(Ts[i][0], Ts[i][1]) || 1;
    return { c, T: Ts[i], N: Ns[i], B: cross3(Ts[i], Ns[i]), r: radius(s), s, front: true, screen: [c[0], c[1]], normal: [-Ts[i][1] / t2, Ts[i][0] / t2] };
  });
  return { id, sections, length };
}

// A straight tube whose frame is turned α about T: N = (0, cos α, sin α).
function tiltedTube(alpha: number, id = 3): Tube {
  const t = syntheticTube(94, 446, R0, [200, 300], id);
  const N: Vec3 = [0, Math.cos(alpha), Math.sin(alpha)];
  const B: Vec3 = [0, -Math.sin(alpha), Math.cos(alpha)];
  return { ...t, sections: t.sections.map((s) => ({ ...s, N, B })) };
}

const straight = syntheticTube(94, 446, R0, [200, 300], ID);
const bent = curveTube((t) => [200 + 420 * t, 300 + 70 * Math.sin(2 * Math.PI * t), 90 * Math.sin(Math.PI * t)], 94, () => R0, ID);
const tapered = curveTube((t) => [200 + 420 * t, 300 + 70 * Math.sin(2 * Math.PI * t), 90 * Math.sin(Math.PI * t)], 94, profile(R0), ID);

const phases: Record<string, ArcPhase> = {
  idle: { kind: 'idle' },
  grow0: { kind: 'grow', age: 0 },
  grow3: { kind: 'grow', age: 3 },
  pop: { kind: 'pop', age: 4 },
  coil: { kind: 'coil', j: -12 },
  strike: { kind: 'strike', j: -5 },
  poster: { kind: 'strike', j: 4 },
  aftermath: { kind: 'aftermath', j: 14 },
  late: { kind: 'aftermath', j: 25 },
};

const allRuns = (a: SheathArcs) => [...a.far, ...a.near];
const sheathOf = (a: SheathArcs) => allRuns(a).filter((r) => r.kind === 'sheath');
const arcsIn = (a: SheathArcs) => new Set(sheathOf(a).map((r) => r.arc)).size;
const tipsIn = (a: SheathArcs) => a.near.filter((r) => r.kind === 'tip').length;

// The distance from p to the tube's screen centreline.
function axisDistance(tube: Tube, p: Vec2): number {
  let best = Infinity;
  const secs = tube.sections;
  for (let i = 1; i < secs.length; i++) {
    const [ax, ay] = secs[i - 1].screen;
    const dx = secs[i].screen[0] - ax;
    const dy = secs[i].screen[1] - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy));
  }
  return best;
}

// A context that counts stroke() calls and remembers each one's width.
function countingTarget(): ArcTarget & { strokes: { width: number; style: unknown; moves: number }[] } {
  let moves = 0;
  const t = {
    strokeStyle: '' as unknown,
    lineWidth: 1,
    lineCap: 'butt' as CanvasLineCap,
    lineJoin: 'miter' as CanvasLineJoin,
    strokes: [] as { width: number; style: unknown; moves: number }[],
    beginPath: () => void (moves = 0),
    moveTo: () => void moves++,
    lineTo: () => {},
    stroke: () => void t.strokes.push({ width: t.lineWidth, style: t.strokeStyle, moves }),
  };
  return t;
}

// The four hero limbs at 1080×608 (S 608): lengths 446, 447, 432 and 435 px
// at 1080 high, scaled; R0 = 0.02 S = 12.2 px.
function perfLimbs(): Tube[] {
  const s = 608;
  const r0 = 0.02 * s;
  const limbs: [Vec2, number, number, number][] = [
    [[520, 170], 251, 0.35, 1],
    [[560, 170], 252, -0.3, 1],
    [[500, 200], 243, 0.6, -1],
    [[580, 200], 245, -0.6, -1],
  ];
  return limbs.map(([root, length, tilt, bend], i) => {
    const dir: Vec2 = [Math.sin(tilt), Math.cos(tilt)];
    const perp: Vec2 = [-dir[1], dir[0]];
    // A gentle bend and some depth; the arc length comes out a little over `length`.
    return curveTube(
      (t) => [
        root[0] + length * 0.97 * (dir[0] * t) + 30 * bend * Math.sin(Math.PI * t) * perp[0],
        root[1] + length * 0.97 * (dir[1] * t) + 30 * bend * Math.sin(Math.PI * t) * perp[1],
        40 * Math.sin(Math.PI * t * 1.3) * bend,
      ],
      94,
      profile(r0),
      11 + i,
    );
  });
}

function renderLimbs(tubes: Tube[], k: number, newPath: (() => LinePath) | null = napiPath): Buffer {
  const canvas = createCanvas(1080, 608);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#3a3a40';
  ctx.fillRect(0, 0, 1080, 608);
  for (const tube of tubes) {
    const arcs = sheathArcs(tube, k, { kind: 'strike', j: -5 }, tube.id, { S: 608 });
    drawArcs(ctx, arcs.far, ARC_TONES, newPath);
    drawArcs(ctx, arcs.near, ARC_TONES, newPath);
  }
  return Buffer.from(ctx.getImageData(0, 0, 1080, 608).data);
}

describe('arcPhase and arcCount', () => {
  it('gives each phase its design §3 count', () => {
    const count = (age: number | null, j: number | null) => {
      const ph = arcPhase(age, j);
      return ph ? arcCount(ph) : null;
    };
    expect(count(-1, null)).toBeNull(); // not out yet
    expect([0, 1, 2, 3].map((a) => count(a, null))).toEqual([2, 2, 2, 2]);
    expect([4, 5].map((a) => count(a, null))).toEqual([6, 6]);
    expect(count(null, null)).toBe(3);
    expect(count(6, null)).toBe(3);
    expect([-14, -9].map((j) => count(null, j))).toEqual([3, 3]); // the coil
    expect([-8, -1, 0, 8].map((j) => count(null, j))).toEqual([6, 6, 6, 6]);
    expect([9, 20, 21, 31].map((j) => count(null, j))).toEqual([6, 6, 6, 6]);
    expect([-20, 32, 60].map((j) => count(null, j))).toEqual([3, 3, 3]);
    expect(arcPhase(2, -5)).toEqual({ kind: 'grow', age: 2 }); // the emergence comes first
  });

  it('cuts the strike window and the aftermath to the idle count on the phone tier, and follows limb.arcs', () => {
    expect(arcCount({ kind: 'strike', j: 0 }, 3, true)).toBe(3);
    expect(arcCount({ kind: 'aftermath', j: 12 }, 3, true)).toBe(3);
    expect(arcCount({ kind: 'pop', age: 4 }, 3, true)).toBe(6);
    expect(arcCount({ kind: 'strike', j: 0 }, 4)).toBe(8);
    expect(arcCount({ kind: 'grow', age: 1 }, 1)).toBe(1);
    expect(arcCount({ kind: 'idle' }, 0)).toBe(0);
  });
});

describe('sheathArcs', () => {
  it('draws the phase count of arcs on every drawing, plus one tip arc to P on j 9..20', () => {
    for (let k = 30; k < 50; k++) {
      expect(arcsIn(sheathArcs(straight, k, phases.idle, ID, { S }))).toBe(3);
      expect(arcsIn(sheathArcs(straight, k, phases.grow0, ID, { S }))).toBe(2);
      expect(arcsIn(sheathArcs(straight, k, phases.pop, ID, { S }))).toBe(6);
      expect(arcsIn(sheathArcs(straight, k, phases.coil, ID, { S }))).toBe(3);
      expect(arcsIn(sheathArcs(bent, k, phases.strike, ID, { S }))).toBe(6);
      const after = sheathArcs(bent, k, phases.aftermath, ID, { S, P });
      expect([arcsIn(after), tipsIn(after)]).toEqual([6, 1]);
      const late = sheathArcs(bent, k, phases.late, ID, { S, P });
      expect([arcsIn(late), tipsIn(late)]).toEqual([6, 0]);
    }
    for (const j of [9, 20]) expect(tipsIn(sheathArcs(bent, 40, { kind: 'aftermath', j }, ID, { S, P }))).toBe(1);
    expect(tipsIn(sheathArcs(bent, 40, { kind: 'aftermath', j: 21 }, ID, { S, P }))).toBe(0);
    expect(tipsIn(sheathArcs(bent, 40, phases.aftermath, ID, { S }))).toBe(0); // no P, no tip arc
    expect(arcsIn(sheathArcs(bent, 40, phases.strike, ID, { S, fewer: true }))).toBe(3);
  });

  it('keeps every arc point within λmax·r + w of the tube axis', () => {
    // The worst point's distance past its bound, with where it was.
    let worst = { over: -Infinity, at: '' };
    const check = (over: number, at: () => string) => {
      if (over > worst.over) worst = { over, at: at() };
    };
    const tubes = [straight, tiltedTube(0.7), tiltedTube(-2.1), bent];
    let points = 0;
    for (const [t, tube] of tubes.entries()) {
      for (let k = 0; k < 24; k++) {
        for (const [name, ph] of Object.entries({ idle: phases.idle, pop: phases.pop, strike: phases.strike, grow3: phases.grow3 })) {
          for (const run of sheathOf(sheathArcs(tube, k, ph, ID + k, { S }))) {
            for (const p of run.points) {
              check(axisDistance(tube, p) - (ARC_LIFT[1] * R0 + W), () => `tube ${t} k ${k} ${name}`);
              points++;
            }
          }
        }
      }
    }
    expect(points).toBeGreaterThan(10000);
    // On a tapering tube, against the radius where each sample sits.
    for (let k = 0; k < 24; k++) {
      for (const plan of arcPlans(ID, k, phases.strike)) {
        for (const p of arcSamples(tapered, plan, W)) check(axisDistance(tapered, p.xy) - (ARC_LIFT[1] * sectionAt(tapered, p.a).r + W), () => `tapered k ${k} arc ${plan.arc}`);
      }
    }
    expect(worst.over, worst.at).toBeLessThanOrEqual(0);
  });

  it('splits far from near by the sign of ν_z, and the runs either side of a split share its point', () => {
    let far = 0;
    let near = 0;
    let samples = 0;
    let meetings = 0;
    for (const tube of [straight, tiltedTube(1.1), bent, tapered]) {
      for (let k = 0; k < 16; k++) {
        const arcs = sheathArcs(tube, k, phases.strike, ID, { S });
        for (const run of arcs.near) expect(run.near && run.nz.every((z) => z >= 0)).toBe(true);
        for (const run of arcs.far) expect(!run.near && run.nz.every((z) => z <= 0)).toBe(true);
        for (const run of sheathOf(arcs)) expect([run.points.length, run.width.length]).toEqual([run.nz.length, run.nz.length]);
        far += arcs.far.length;
        near += arcs.near.length;
        // Against each sample's own ν_z (arcSamples places the same points):
        // every sample a run keeps is on that run's side of the axis, unless
        // it sits in a graze, under 0.5 px on screen, folded into its neighbour.
        for (const plan of arcPlans(ID, k, phases.strike)) {
          const truth = new Map(arcSamples(tube, plan, W).map((p) => [p.xy.join(), p.nz]));
          for (const run of sheathOf(arcs)) {
            if (run.arc !== plan.arc) continue;
            for (const p of run.points) {
              const nz = truth.get(p.join());
              if (nz === undefined) continue; // a split or a taper step, not a sample
              samples++;
              if (run.near ? nz < 0 : nz > 0) expect(Math.abs(nz), `k ${k} arc ${plan.arc}`).toBeLessThan(0.25);
            }
          }
        }
        // A run that ends inside its piece (where the width isn't 0) meets
        // exactly one other run of its arc there, on the very same point; where
        // a far run meets a near one, ν_z reads 0 on both, so no gap shows.
        const ends = sheathOf(arcs).flatMap((run) => [0, run.points.length - 1].map((i) => ({ run, i, key: `${run.arc} ${run.points[i].join()}` })));
        for (const end of ends) {
          if (end.run.width[end.i] === 0) continue; // the piece's own end
          const other = ends.filter((e) => e.key === end.key && e.run !== end.run);
          expect(other.length).toBe(1);
          if (other[0].run.near !== end.run.near) {
            expect(Math.abs(end.run.nz[end.i])).toBe(0);
            meetings++;
          }
        }
      }
    }
    expect(far).toBeGreaterThan(50);
    expect(near).toBeGreaterThan(50);
    expect(samples).toBeGreaterThan(3000);
    expect(meetings).toBeGreaterThan(100);
  });

  it('puts each sample at d·(cos φ·N + sin φ·B) from the axis, and ν_z is that vector’s depth', () => {
    // Checked on constant-frame tubes against the frame directly; the worst
    // error of each kind over all the samples.
    const err = { nz: 0, y: 0, low: -Infinity, high: -Infinity };
    let samples = 0;
    for (const alpha of [0, 0.7, -2.1, Math.PI / 2]) {
      const tube = alpha === 0 ? straight : tiltedTube(alpha);
      const { N, B, screen } = tube.sections[0];
      for (let k = 0; k < 8; k++) {
        for (const plan of arcPlans(ID, k, phases.strike)) {
          for (const p of arcSamples(tube, plan, W)) {
            const nu = [0, 1, 2].map((d) => Math.cos(p.phi) * N[d] + Math.sin(p.phi) * B[d]);
            err.nz = Math.max(err.nz, Math.abs(p.nz - nu[2]));
            err.y = Math.max(err.y, Math.abs(p.xy[1] - screen[1] - p.d * nu[1]));
            err.low = Math.max(err.low, 1.05 * R0 - p.d); // the ends touch down on the skin ...
            err.high = Math.max(err.high, p.d - plan.lambda * R0); // ... and the middle rides at most λ·r off the axis
            samples++;
          }
        }
      }
    }
    expect(samples).toBeGreaterThan(1000);
    expect(err.nz).toBeLessThan(1e-9);
    expect(err.y).toBeLessThan(1e-6);
    expect(err.low).toBeLessThanOrEqual(1e-9);
    expect(err.high).toBeLessThanOrEqual(1e-9);
  });

  it('keeps shapes identical within a drawing and changes them on the next', () => {
    for (const [name, ph] of Object.entries(phases)) {
      const a = sheathArcs(bent, 40, ph, ID, { S, P });
      expect(sheathArcs(bent, 40, ph, ID, { S, P }), name).toEqual(a);
      const b = sheathArcs(bent, 41, ph, ID, { S, P });
      expect(allRuns(b).map((r) => r.points), name).not.toEqual(allRuns(a).map((r) => r.points));
    }
    // The kinks, turns and gaps reseed on every drawing.
    const [p40] = arcPlans(ID, 40, phases.idle);
    const [p41] = arcPlans(ID, 41, phases.idle);
    expect(p41.kinks).not.toEqual(p40.kinks);
    expect(p41.phi0).not.toBe(p40.phi0);
  });

  it('holds placement for a 2s pair, crawling 15 % of the span toward the tip on its second drawing', () => {
    for (let m = 0; m < 40; m++) {
      const a = arcPlans(ID, 2 * m, phases.strike);
      const b = arcPlans(ID, 2 * m + 1, phases.strike);
      const c = arcPlans(ID, 2 * m + 2, phases.strike);
      for (let i = 0; i < a.length; i++) {
        expect([b[i].base, b[i].span, Math.sign(b[i].turns)]).toEqual([a[i].base, a[i].span, Math.sign(a[i].turns)]);
        expect(a[i].s0).toBe(a[i].base);
        expect(b[i].s0 - a[i].s0).toBeCloseTo(CRAWL * a[i].span, 12);
        expect(c[i].base).not.toBe(a[i].base);
        expect(b[i].s0 + b[i].span).toBeLessThanOrEqual(0.94 + 1e-12);
        expect(a[i].s0).toBeGreaterThanOrEqual(0.06);
      }
    }
  });

  it('draws spans, turns, lift, kinks and gaps from design §3’s ranges', () => {
    // Each quantity's range over 4320 arcs, against design §3's.
    const range = () => ({ lo: Infinity, hi: -Infinity });
    const seen = { span: range(), turns: range(), lambda: range(), deg: range(), gap: range(), visible: range() };
    const add = (r: { lo: number; hi: number }, v: number) => {
      r.lo = Math.min(r.lo, v);
      r.hi = Math.max(r.hi, v);
    };
    const pieces = new Set<number>();
    let ordered = true;
    for (let id = 1; id <= 60; id++) {
      for (let k = 0; k < 12; k++) {
        for (const p of arcPlans(id, k, phases.strike)) {
          add(seen.span, p.span);
          add(seen.turns, Math.abs(p.turns));
          add(seen.lambda, p.lambda);
          for (const kink of p.kinks) {
            add(seen.deg, Math.abs(kink.deg));
            add(seen.gap, kink.gap);
          }
          let t = 0;
          for (const [t0, t1] of p.pieces) {
            ordered &&= t0 >= t - 1e-12 && t1 > t0;
            t = t1;
          }
          ordered &&= t <= 1 + 1e-12;
          add(seen.visible, p.pieces.reduce((sum, [t0, t1]) => sum + t1 - t0, 0));
          pieces.add(p.pieces.length);
        }
      }
    }
    const within = (r: { lo: number; hi: number }, lo: number, hi: number) => r.lo >= lo - 1e-9 && r.hi <= hi + 1e-9;
    expect(within(seen.span, 0.2, 0.38), JSON.stringify(seen.span)).toBe(true);
    expect(within(seen.turns, 0.5, 1.2), JSON.stringify(seen.turns)).toBe(true);
    expect(within(seen.lambda, ARC_LIFT[0], ARC_LIFT[1]), JSON.stringify(seen.lambda)).toBe(true);
    expect(within(seen.deg, 40, 85), JSON.stringify(seen.deg)).toBe(true);
    expect(within(seen.gap, 2, 8), JSON.stringify(seen.gap)).toBe(true);
    expect(within(seen.visible, 0.55, 0.75), JSON.stringify(seen.visible)).toBe(true);
    // And they fill those ranges.
    expect(seen.span.hi - seen.span.lo).toBeGreaterThan(0.17);
    expect(seen.deg.hi - seen.deg.lo).toBeGreaterThan(40);
    expect(ordered).toBe(true);
    expect([...pieces].sort()).toEqual([1, 2, 3]);
  });

  it('keeps a growing limb’s arcs on the part that shows', () => {
    for (let age = 0; age < 4; age++) {
      const ph: ArcPhase = { kind: 'grow', age };
      expect(shownOf(ph)).toBe(GROWN[age]);
      let along = -Infinity; // the farthest sample along the tube, past the shown part
      let past = -Infinity; // the farthest drawn point past the shown end, px
      const x = straight.sections[0].screen[0] + straight.length * GROWN[age];
      for (let k = 0; k < 30; k++) {
        for (const plan of arcPlans(ID, k, ph)) for (const p of arcSamples(straight, plan, W, shownOf(ph))) along = Math.max(along, p.a - GROWN[age]);
        for (const run of sheathOf(sheathArcs(straight, k, ph, ID, { S }))) for (const p of run.points) past = Math.max(past, p[0] - x);
      }
      expect(along, `age ${age}`).toBeLessThanOrEqual(0);
      expect(past, `age ${age}`).toBeLessThanOrEqual(1e-9);
    }
  });

  it('runs the tip arc from the tip down onto P, over the person', () => {
    for (let k = 0; k < 20; k++) {
      const tip = sheathArcs(bent, k, phases.aftermath, ID, { S, P }).near.find((r) => r.kind === 'tip');
      expect(tip).toBeDefined();
      const run = tip as ArcRun;
      const end = bent.sections[bent.sections.length - 1].screen;
      expect(run.points[0][0]).toBeCloseTo(end[0], 9);
      expect(run.points[0][1]).toBeCloseTo(end[1], 9);
      expect(run.points[run.points.length - 1][0]).toBeCloseTo(P[0], 6);
      expect(run.points[run.points.length - 1][1]).toBeCloseTo(P[1], 6);
      expect(run.near && run.front).toBe(true);
      expect(run.width[0]).toBe(0);
      expect(Math.max(...run.width)).toBeCloseTo(W, 9);
    }
  });

  it('tapers each run’s width to its piece ends and never past w', () => {
    for (let k = 0; k < 10; k++) {
      for (const run of sheathOf(sheathArcs(bent, k, phases.strike, ID, { S }))) {
        expect(run.base).toBeCloseTo(W, 12);
        expect(run.width.every((w) => w >= 0 && w <= W + 1e-9)).toBe(true);
      }
    }
  });

  it('returns nothing for a tube it cannot read', () => {
    const empty: Tube = { id: 1, sections: straight.sections.slice(0, 1), length: 446 };
    expect(sheathArcs(empty, 3, phases.idle, 1, { S })).toEqual({ far: [], near: [] });
    expect(sheathArcs({ ...straight, length: 0 }, 3, phases.idle, 1, { S })).toEqual({ far: [], near: [] });
  });
});

describe('drawArcs and emitArcs', () => {
  it('strokes three bands in at most 12 calls, stepping the width in quarters', () => {
    const t = countingTarget();
    const runs = perfLimbs().flatMap((tube) => allRuns(sheathArcs(tube, 40, phases.strike, tube.id, { S: 608 })));
    drawArcs(t, runs);
    expect(t.strokes.length).toBeLessThanOrEqual(12);
    expect([t.lineCap, t.lineJoin]).toEqual(['butt', 'round']);
    const w = ARC_WIDTH * 608;
    const bodies = t.strokes.filter((s) => s.style === ARC_TONES.body).map((s) => s.width);
    for (const b of bodies) expect([1, 2, 3, 4].some((q) => Math.abs(b - Math.round(((w * q) / 4) * 100) / 100) < 1e-9)).toBe(true);
    expect(t.strokes.map((s) => s.style).filter((v, i, a) => a.indexOf(v) === i)).toEqual([ARC_TONES.edge, ARC_TONES.body, ARC_TONES.core]);
    // Every run starts a subpath in each band, so nothing is dropped.
    const moves = t.strokes.filter((s) => s.style === ARC_TONES.body).reduce((sum, s) => sum + s.moves, 0);
    expect(moves).toBeGreaterThanOrEqual(runs.length);
  });

  it('traces each width step once with a path maker and strokes it in all three bands, in band order', () => {
    type Counted = LinePath & { moves: number };
    const made: Counted[] = [];
    const maker = (): LinePath => {
      const p: Counted = { moves: 0, moveTo: () => void p.moves++, lineTo: () => {} };
      made.push(p);
      return p;
    };
    const order: { style: unknown; path: number }[] = [];
    const ctx: ArcTarget = {
      strokeStyle: '',
      lineWidth: 1,
      lineCap: 'butt',
      lineJoin: 'miter',
      beginPath: () => {
        throw new Error('the context path is not used');
      },
      moveTo: () => {},
      lineTo: () => {},
      stroke: (path?: LinePath) => void order.push({ style: ctx.strokeStyle, path: made.indexOf(path as Counted) }),
    };
    const runs = perfLimbs().flatMap((tube) => allRuns(sheathArcs(tube, 40, phases.strike, tube.id, { S: 608 })));
    drawArcs(ctx, runs, ARC_TONES, maker);
    expect(made.length).toBe(4);
    expect(order.map((s) => s.style)).toEqual([...Array(4).fill(ARC_TONES.edge), ...Array(4).fill(ARC_TONES.body), ...Array(4).fill(ARC_TONES.core)]);
    expect(order.map((s) => s.path)).toEqual([0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3]);
    expect([ctx.lineCap, ctx.lineJoin]).toEqual(['butt', 'round']);
    // The same subpaths as the context route's body band.
    const t = countingTarget();
    drawArcs(t, runs);
    const bodyMoves = t.strokes.filter((s) => s.style === ARC_TONES.body).reduce((sum, s) => sum + s.moves, 0);
    expect(made.reduce((sum, p) => sum + p.moves, 0)).toBe(bodyMoves);
  });

  it('draws the same pixels with a Path2D as on the context', () => {
    const tubes = perfLimbs();
    for (const k of [40, 47]) expect(renderLimbs(tubes, k, napiPath).equals(renderLimbs(tubes, k, null))).toBe(true);
  });

  // Decision 11: about 1.5 × the worst median under the whole unit suite (its
  // serial group, four runs, Nov 2). Design 10.8 ms (24 arcs at ≤ 0.45 ms,
  // design §3 and §10); today 7.5–9.0 ms.
  const ARCS_MS = 13.5;
  it('draws 24 arcs at 1080×608 in ≤ 13.5 ms (median of 10; design 10.8 ms), shapes included', () => {
    const tubes = perfLimbs();
    const ks = Array.from({ length: 10 }, (_, i) => 40 + i);
    const count = (k: number) => tubes.reduce((n, tube) => n + arcsIn(sheathArcs(tube, k, phases.strike, tube.id, { S: 608 })), 0);
    expect(ks.map(count)).toEqual(ks.map(() => 24));
    const canvas = createCanvas(1080, 608);
    const ctx = canvas.getContext('2d');
    const time = (k: number) => {
      const t0 = performance.now();
      for (const tube of tubes) {
        const out = sheathArcs(tube, k, phases.strike, tube.id, { S: 608 });
        drawArcs(ctx, out.far, ARC_TONES, napiPath);
        drawArcs(ctx, out.near, ARC_TONES, napiPath);
      }
      ctx.getImageData(0, 0, 1, 1); // make sure the raster work is done
      return performance.now() - t0;
    };
    for (let i = 0; i < 20; i++) time(100 + i); // warm up: the JIT, and the canvas
    const ms = ks.map(time).sort((a, b) => a - b);
    const median = (ms[4] + ms[5]) / 2;
    console.log(`arcs: ${median.toFixed(2)} ms for 24 arcs (median of 10, 1080×608)`);
    expect(median, `ms: ${ms.map((m) => m.toFixed(1)).join(' ')}`).toBeLessThanOrEqual(ARCS_MS);
  });

  it('renders the same pixels twice, and different ones on another drawing', () => {
    const tubes = perfLimbs();
    const hash = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');
    const a = hash(renderLimbs(tubes, 40));
    expect(hash(renderLimbs(tubes, 40))).toBe(a);
    expect(hash(renderLimbs(tubes, 41))).not.toBe(a);
  });

  it('emits each run’s body and core, the far ones at half gain', () => {
    const arcs = sheathArcs(bent, 12, phases.strike, ID, { S });
    const sink = recordingSink();
    emitArcs(sink, [...arcs.far, ...arcs.near], 0.8);
    const runs = [...arcs.far, ...arcs.near];
    expect(sink.calls.length).toBe(2 * runs.length);
    runs.forEach((run, i) => {
      const [body, core] = sink.calls.slice(2 * i, 2 * i + 2);
      expect(body).toMatchObject({ op: 'stroke', width: run.base, color: ARC_TONES.body, kind: 'body', gain: run.near ? 0.8 : 0.4 });
      expect(core).toMatchObject({ op: 'stroke', width: run.base * run.core, color: ARC_TONES.core, kind: 'core', gain: run.near ? 0.8 : 0.4 });
    });
  });

  it('widens the cores on the pop flash, 1.0 then 0.5', () => {
    const core = (age: number) => arcPlans(ID, 12, { kind: 'pop', age })[0].core;
    expect(core(4)).toBeCloseTo(0.6, 12);
    expect(core(5)).toBeCloseTo(0.45, 12);
    expect(arcPlans(ID, 12, phases.idle)[0].core).toBeCloseTo(0.3, 12);
  });
});

describe('arcFlicker', () => {
  it('holds on both frames of a 2-frame kr step and stays in 0.6..1', () => {
    const I = 84;
    let held = 0;
    const values = new Set<number>();
    for (let f = I - 8; f < I + 31; f++) {
      const a = arcFlicker(ID, c1(f, I));
      const b = arcFlicker(ID, c1(f + 1, I));
      if (c1(f, I) === c1(f + 1, I)) {
        expect(b).toBe(a);
        held++;
      }
      expect(a).toBeGreaterThanOrEqual(0.6);
      expect(a).toBeLessThan(1);
      values.add(a);
    }
    expect(held).toBeGreaterThanOrEqual(7); // kr holds 2 frames once in every 5
    expect(values.size).toBeGreaterThan(25); // and changes on every other step
    // Without a slam it runs on k24.
    expect(arcFlicker(ID, c1(20))).toBe(arcFlicker(ID, c1(21)));
  });
});

describe('arcTones', () => {
  it('keeps limbs3d’s blues for red limbs and turns them with the discharge set for blue ones', () => {
    expect(arcTones(['#e8203a', '#fff4e6', '#1a1a1a'])).toEqual(ARC_TONES);
    const violet: [string, string, string] = ['#7a3cff', '#fff4e6', '#1a1a1a'];
    const turn = hueDelta(toOklch('#2542fc').h, toOklch(roles(violet).discharge.band).h);
    expect(turn).toBeGreaterThan(20); // h(p0) 289° is within 60° of 262°
    const tones = arcTones(violet);
    for (const band of ['edge', 'body', 'core'] as const) {
      // Within the 8-bit hex's rounding.
      expect(Math.abs(hueDelta(toOklch(ARC_TONES[band]).h, toOklch(tones[band]).h) - turn)).toBeLessThan(1.5);
    }
  });
});

describe('arcs3d and pulse source', () => {
  it('uses no Math.random, Date, performance.now or ctx.filter', () => {
    for (const f of ['arcs3d', 'pulse']) {
      const code = readFileSync(resolve(REPO, 'src/render', `${f}.ts`), 'utf8').replace(/\/\/.*$/gm, '');
      expect(code, f).not.toMatch(/Math\.random|\bDate\b|performance\.now|\.filter\s*=/);
    }
  });
});
