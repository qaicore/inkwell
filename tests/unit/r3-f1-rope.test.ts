// Round 3, F1: rope limbs that collide with his body (decisions 15 and 17).
// Synthetic only: a body that stands, spins once (f48–76, as the hero's
// turn), bends double for the slam (I 84) and rises, with a 33-landmark
// stand-in drawn off the same body, four kagune limbs at stiffness 0.1 and
// the limbs-first strike. The targets are decision 15's and 17's numbers:
// the tip lags the root (≥ 2 frames), the shape moves between drawings
// (≥ 3° moving, ≥ 1° still), the release keeps the drawn length (0.85–1.15×)
// and a bow, the whip's bend runs from the inner half to the outer, and no
// centreline point is ever more than 2 px inside him.
import { describe, expect, it } from 'vitest';
import type { StrikeController, StrikeStep, Vec3 } from '../../src/impact/contracts.ts';
import { project, toBody, toCamera, type Body3D } from '../../src/lift/body.ts';
import { dummyBodies, frontFlags, insideDepth, routeAround, type Dummy } from '../../src/lift/collide.ts';
import { animate3d, liftStroke, type Lifted } from '../../src/lift/lift.ts';
import { createChain3, ROPE3D, stepChain3 } from '../../src/lift/strand3d.ts';
import { limbsFirst, strikeController } from '../../src/lift/strike.ts';
import type { PointSet } from '../../src/track/tracking.ts';
import type { Vec2 } from '../../src/types/effect.ts';

const FRAMES = 160;
const I = 84;
const { land: LAND, release: RELEASE } = limbsFirst(I);
const UNIT = 200;
const DRAWN = 22;
const P: Vec2 = [980, 900]; // about a limb's length from the roots once he bends, as on the hero
const D: Vec2 = [0, 1];
const R0 = 0.02 * 1080; // lift.ts's root radius on a 1920 × 1080 clip

const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

// Standing till f48, one turn by f76, bent double (1.6 rad) from f80 to f96, up again by f130.
function bodiesOf(): Body3D[] {
  return Array.from({ length: FRAMES }, (_, f) => ({
    x: 960 + 30 * Math.sin(f / 40),
    y: 560,
    unit: UNIT,
    yaw: 2 * Math.PI * smooth((f - 48) / 28),
    pitch: 1.6 * (smooth((f - 76) / 6) - smooth((f - 100) / 30)),
    roll: 0,
  }));
}

// A standing body's landmarks in the egg's frame (torso units, x his left, y down, z out of his chest).
const LANDMARKS: [number, Vec3][] = [
  [0, [0, -1.2, 0.17]],
  [7, [0.12, -1.25, 0]],
  [8, [-0.12, -1.25, 0]],
  [11, [0.24, -0.9, 0]],
  [12, [-0.24, -0.9, 0]],
  [13, [0.32, -0.38, 0]],
  [14, [-0.32, -0.38, 0]],
  [15, [0.34, 0.12, 0.05]],
  [16, [-0.34, 0.12, 0.05]],
  [23, [0.14, 0.22, 0]],
  [24, [-0.14, 0.22, 0]],
  [25, [0.14, 0.95, 0.02]],
  [26, [-0.14, 0.95, 0.02]],
  [27, [0.14, 1.65, -0.02]],
  [28, [-0.14, 1.65, -0.02]],
];
function skeletonOf(b: Body3D): PointSet {
  const x = new Float32Array(33).fill(NaN);
  const y = new Float32Array(33).fill(NaN);
  const confidence = new Float32Array(33);
  for (const [i, at] of LANDMARKS) {
    const xy = project(b, toCamera(b, at)).xy;
    [x[i], y[i], confidence[i]] = [xy[0], xy[1], 1];
  }
  return { x, y, confidence };
}

// A curve of 32 points off his upper back, drawn on `b`, 2.2 torso heights
// long as the hero's are, so the slammed limbs reach P as theirs do.
const REACH = 2.2;
function strokePx(b: Body3D, dir: number, bendBy: number, from: Vec2): Vec2[] {
  return Array.from({ length: 32 }, (_, i): Vec2 => {
    const s = i / 31;
    const a = dir + bendBy * s;
    return [b.x + from[0] * b.unit + REACH * b.unit * s * Math.cos(a), b.y + from[1] * b.unit + REACH * b.unit * s * Math.sin(a)];
  });
}
const PRESSURE = Array.from({ length: 32 }, (_, i) => 1 - 0.6 * (i / 31));
// Two up and out over his shoulders, two out and down from his lower back.
const LIMBS: [number, number, Vec2][] = [
  [-2.6, 0.7, [-0.12, -0.72]],
  [-0.55, -0.7, [0.12, -0.72]],
  [2.7, -0.6, [-0.1, -0.35]],
  [0.45, 0.6, [0.1, -0.35]],
];
const strokesOn = (b: Body3D): Lifted[] => LIMBS.map(([dir, bendBy, from], i) => liftStroke(i + 1, strokePx(b, dir, bendBy, from), PRESSURE, b, 'strand', 0.1));

interface Logged {
  at: StrikeStep;
  points: Vec3[][];
}
function recording(inner: StrikeController, log: Logged[]): StrikeController {
  return {
    land: inner.land,
    release: inner.release,
    step(at) {
      log.push({ at, points: at.limbs.map((l) => l.points.map((p): Vec3 => [p[0], p[1], p[2]])) });
      return inner.step(at);
    },
  };
}

function run(withDummy = true) {
  const bodies = bodiesOf();
  const dummies = withDummy ? dummyBodies({ bodies, joints: bodies.map(skeletonOf), width: 1920, height: 1080 }) : null;
  const strokes = strokesOn(bodies[DRAWN]);
  const log: Logged[] = [];
  const control = recording(strikeController({ ...limbsFirst(I), P, d: D, limbs: strokes.map((s) => ({ id: s.id })), unit: UNIT, seed: 84, dummies, radius: R0 }), log);
  const frames = animate3d({ strokes, bodies, frames: FRAMES, dps: 12, boil: { maxPx: 0, cycle: 3 }, width: 1920, emerge: new Map(strokes.map((s) => [s.id, DRAWN])), control, slam: { I, posters: true }, dummies, radius: R0 });
  return { bodies, dummies, strokes, frames, log };
}

// ---- Measures ---------------------------------------------------------------------------------

type V3 = readonly number[];
const sub = (a: V3, b: V3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const polyLength = (pts: readonly V3[]) => pts.slice(1).reduce((s, q, i) => s + Math.hypot(...sub(q, pts[i])), 0);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

// Each segment's direction in the root's frame (e1 the root segment, e2 toward the chord).
function shapeDirs(pts: readonly V3[]): Vec3[] {
  const e1 = norm(sub(pts[1], pts[0]));
  const chord = sub(pts[pts.length - 1], pts[0]);
  const e2 = norm(sub(chord, e1.map((v) => v * dot(chord, e1))));
  const e3 = cross(e1, e2);
  return pts.slice(1, -1).map((p, i) => {
    const u = norm(sub(pts[i + 2], p));
    return [dot(u, e1), dot(u, e2), dot(u, e3)];
  });
}
// The median over joints of how far (degrees) each segment turned in the root's frame.
function shapeChange(a: readonly V3[], b: readonly V3[]): number {
  const [da, db] = [shapeDirs(a), shapeDirs(b)];
  return median(da.map((u, i) => (Math.acos(Math.max(-1, Math.min(1, dot(u, db[i])))) * 180) / Math.PI));
}

function unwrap(angles: number[]): number[] {
  const out = [angles[0]];
  for (let i = 1; i < angles.length; i++) out.push(out[i - 1] + Math.atan2(Math.sin(angles[i] - angles[i - 1]), Math.cos(angles[i] - angles[i - 1])));
  return out;
}
// The lag (frames) at the peak of the normalised cross-correlation of the tip's angular velocity against the root's.
function lagAtPeak(root: number[], tip: number[], maxLag: number): number {
  const wr = root.slice(1).map((v, i) => v - root[i]);
  const wt = tip.slice(1).map((v, i) => v - tip[i]);
  let best = 0;
  let bestCorr = -Infinity;
  for (let L = 0; L <= maxLag; L++) {
    let [s, sa, sb] = [0, 0, 0];
    for (let f = L; f < wt.length; f++) {
      s += wr[f - L] * wt[f];
      sa += wr[f - L] ** 2;
      sb += wt[f] ** 2;
    }
    const c = sa > 0 && sb > 0 ? s / Math.sqrt(sa * sb) : -Infinity;
    if (c > bestCorr) [best, bestCorr] = [L, c];
  }
  return best;
}

function sagittaRatio(pts: readonly Vec2[]): number {
  const [a, b] = [pts[0], pts[pts.length - 1]];
  const c = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return Math.max(...pts.map((p) => Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / c)) / c;
}

// The turning (radians) between consecutive segments from node `from` to `to`.
const bend = (pts: readonly V3[], from: number, to: number) => {
  let s = 0;
  for (let i = Math.max(1, from); i < Math.min(pts.length - 1, to); i++) s += Math.acos(Math.max(-1, Math.min(1, dot(norm(sub(pts[i], pts[i - 1])), norm(sub(pts[i + 1], pts[i]))))));
  return s;
};

// ---- The rope ---------------------------------------------------------------------------------

describe('rope limbs (decision 15)', () => {
  const { bodies, frames, log, strokes } = run();

  it('drags the tip behind the root through the turn: ≥ 2 frames at the peak of the cross-correlation', () => {
    // The upper limbs reach out sideways, so their heading about his spine is
    // well defined: the azimuth of the root segment and of the tip segment.
    for (const i of [0, 1]) {
      const fs = Array.from({ length: 25 }, (_, k) => 50 + k);
      const azimuth = (f: number, a: number, b: number) => {
        const pts = frames[f].sim[i].points;
        const n = pts.length;
        const v = sub(pts[b < 0 ? n + b : b], pts[a < 0 ? n + a : a]);
        return Math.atan2(v[0], v[2]);
      };
      const lag = lagAtPeak(unwrap(fs.map((f) => azimuth(f, 0, 3))), unwrap(fs.map((f) => azimuth(f, -4, -1))), 8);
      expect(lag, `limb ${i + 1}`).toBeGreaterThanOrEqual(2);
    }
  });

  it('winds the coil back root first: every target node turns later the further out it is', () => {
    const at = log.filter((s) => s.at.f === LAND - 3 && s.at.sub === s.at.steps)[0];
    const ctl = strikeController({ ...limbsFirst(I), P, d: D, limbs: strokes.map((s) => ({ id: s.id })), unit: UNIT, seed: 84 });
    const orders = ctl.step(at.at);
    for (const [i, l] of at.at.limbs.entries()) {
      const target = orders[i]!.target!;
      const R = project(at.at.body, l.target[0]).xy;
      const turn = (j: number) => {
        const a = project(at.at.body, l.target[j]).xy;
        const b = project(at.at.body, target[j]).xy;
        return Math.abs(Math.atan2(Math.sin(Math.atan2(b[1] - R[1], b[0] - R[0]) - Math.atan2(a[1] - R[1], a[0] - R[0])), Math.cos(Math.atan2(b[1] - R[1], b[0] - R[0]) - Math.atan2(a[1] - R[1], a[0] - R[0]))));
      };
      if (turn(31) < 1e-6) continue; // pointing at P: no coil
      expect(turn(8), `limb ${l.id}`).toBeGreaterThan(turn(31));
    }
  });

  it('keeps the shape moving between drawings: a median joint turn ≥ 3° through the turn and ≥ 1° standing', () => {
    const starts = frames.flatMap((fr, f) => (f > 0 && fr.capture !== frames[f - 1].capture ? [f] : []));
    for (const [from, to, least] of [[50, 74, 3], [24, 48, 1]] as const) {
      const caps = starts.filter((f) => f >= from && f <= to);
      for (let i = 0; i < 4; i++) {
        const turns = caps.slice(1).map((f, k) => shapeChange(frames[caps[k]].sim[i].points, frames[f].sim[i].points));
        expect(median(turns), `limb ${i + 1} f${from}–${to}`).toBeGreaterThanOrEqual(least);
      }
    }
  });

  it('runs the whip from the inner half to the outer: the outer half turns over to C later', () => {
    const steps = log.filter((s) => s.at.f >= LAND - 2 && s.at.f <= LAND);
    for (let i = 0; i < 4; i++) {
      // Each half's segments' mean turn from where they were at the strike's start, and the step it is half done.
      const dir = (pts: readonly V3[], j: number) => {
        const d = sub(pts[j + 1], pts[j]);
        const l = Math.hypot(...d) || 1;
        return d.map((v) => v / l);
      };
      const turn = (k: number, from: number, to: number) => {
        let sum = 0;
        for (let j = from; j < to; j++) {
          const [a, b] = [dir(steps[0].points[i], j), dir(steps[k].points[i], j)];
          sum += Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
        }
        return sum / (to - from);
      };
      const halfDone = (from: number, to: number) => {
        const all = turn(steps.length - 1, from, to);
        return steps.findIndex((_, k) => turn(k, from, to) >= all / 2);
      };
      expect(halfDone(16, 31), `limb ${i + 1}`).toBeGreaterThanOrEqual(halfDone(1, 16));
    }
  });

  it('lands every tip on P from the landing to the release, round his body', () => {
    for (let f = LAND; f < RELEASE; f++) {
      for (const p of frames[f].placed) expect(Math.hypot(p.points.at(-1)![0] - P[0], p.points.at(-1)![1] - P[1]), `f${f} limb ${p.id}`).toBeLessThan(0.5);
    }
  });

  it('keeps every limb within 0.85–1.15× its drawn length (per torso height) on every frame of the release and after, bowed', () => {
    for (let f = RELEASE; f <= 130; f++) {
      frames[f].sim.forEach((s, i) => {
        const r = polyLength(s.points) / bodies[f].unit / strokes[i].drawn!;
        expect(r, `f${f} limb ${s.id}`).toBeGreaterThanOrEqual(0.85);
        expect(r, `f${f} limb ${s.id}`).toBeLessThanOrEqual(1.15);
      });
    }
    // Never drawn straight: every drawing bows at least 0.06 of its chord.
    for (let f = RELEASE; f <= 130; f++) for (const p of frames[f].placed) expect(sagittaRatio(p.points), `f${f} limb ${p.id}`).toBeGreaterThanOrEqual(0.06);
  });

  it('gives byte-identical frames on two runs', () => {
    const again = run().frames;
    expect(again.map((fr) => fr.sim.map((s) => s.points.flat()).flat())).toEqual(frames.map((fr) => fr.sim.map((s) => s.points.flat()).flat()));
  });
});

// ---- The dummy --------------------------------------------------------------------------------

describe('the crash-test dummy (decision 17)', () => {
  const { bodies, dummies, frames } = run();

  it('builds the egg and ten capsules from a 33-landmark stand-in, and the egg alone without one', () => {
    expect(dummies![30].capsules.map((c) => c.part).sort()).toEqual(['forearm', 'forearm', 'head', 'neck', 'shin', 'shin', 'thigh', 'thigh', 'upperArm', 'upperArm']);
    expect(dummyBodies({ bodies, joints: null, width: 1920, height: 1080 }).every((d) => d.capsules.length === 0)).toBe(true);
  });

  it('keeps the shoulders on the egg however far the pose puts them behind it', () => {
    const b = bodies[90];
    const off = skeletonOf(b);
    off.y[11] += 0.5 * UNIT; // the pose's left shoulder half a torso down the screen: behind his back on a bent egg
    const d = dummyBodies({ bodies: [b], joints: [off], width: 1920, height: 1080 })[0];
    const arm = d.capsules.find((c) => c.part === 'upperArm')!; // the left one: from the moved shoulder
    // The shoulder in the egg's frame: on his torso, within 0.1 of its
    // standing place across and down and 0.08 in depth, however far the pose put it.
    const [x, y, z] = toBody(b, arm.a);
    expect(Math.abs(x - 0.24)).toBeLessThanOrEqual(0.1 + 1e-9);
    expect(Math.abs(y + 0.9)).toBeLessThanOrEqual(0.1 + 1e-9);
    expect(Math.abs(z)).toBeLessThanOrEqual(0.08 + 1e-9);
  });

  it('never leaves a limb`s centreline more than 2 px inside him, on any frame', () => {
    let worst = 0;
    let where = '';
    for (let f = 0; f < FRAMES; f++) {
      for (const s of frames[f].sim) {
        s.points.forEach((q, j) => {
          const d = insideDepth(dummies![f], q);
          if (d > worst) [worst, where] = [d, `f${f} limb ${s.id} node ${j}`];
        });
      }
    }
    expect(worst, where).toBeLessThanOrEqual(2);
  });

  it('routes a curve round him by its depth alone: the same place on screen, outside every part', () => {
    const d = dummies![90];
    const b = d.body;
    const through: Vec3[] = Array.from({ length: 24 }, (_, k) => toCamera(b, [-0.6 + (1.2 * k) / 23, -0.5, 0]));
    const routed = routeAround(d, through, through.map(() => 10), 1);
    routed.forEach((q, k) => {
      const [a, c] = [project(b, through[k]).xy, project(b, q).xy];
      expect(Math.hypot(a[0] - c[0], a[1] - c[1])).toBeLessThan(1e-6);
      expect(insideDepth(d, q)).toBeLessThanOrEqual(1e-6);
    });
  });
});

describe('front and behind (decision 17)', () => {
  const b: Body3D = { x: 960, y: 560, unit: UNIT, yaw: 0, pitch: 0, roll: 0 };
  const d: Dummy = { body: b, capsules: [] };
  const across = (z: number): Vec3[] => Array.from({ length: 21 }, (_, k) => toCamera(b, [-1 + k / 10, -0.4, z]));

  it('says in front over his chest only when the limb is nearer than his chest, and behind behind his back', () => {
    expect(frontFlags(d, across(0.5)).every(Boolean)).toBe(true);
    expect(frontFlags(d, across(-0.5)).some(Boolean)).toBe(false);
  });

  it('flips only over his body: a run off him takes the side of the body next to it that shows', () => {
    // Behind him from his back, out past his side, then in front of his chest:
    // the stretch beside him is in front, so the flip falls on his outline.
    const pts: Vec3[] = [...across(-0.5).slice(8, 13), ...Array.from({ length: 6 }, (_, k) => toCamera(b, [0.5 + 0.05 * k, -0.4, -0.3 + 0.15 * k])), ...across(0.5).slice(9, 13)];
    const flags = frontFlags(d, pts);
    const over = pts.map((p) => insideDepth(d, [p[0], p[1], 0]) > 0 || Math.abs(project(b, p).xy[0] - b.x) < 0.33 * UNIT);
    for (let k = 1; k < pts.length; k++) if (flags[k] !== flags[k - 1]) expect(over[k] || over[k - 1], `flip at ${k}`).toBe(true);
    expect(flags.slice(5, 11).every(Boolean)).toBe(true);
  });
});

// ---- The shape pull ---------------------------------------------------------------------------

describe('the shape pull (strand3d.ts)', () => {
  it('never tears the chain past nodes it leaves hanging off places inside him', () => {
    // A straight chain, 20 px a segment, pulled hard (stiffness 1) toward a
    // shape 120 px below it from node 3 out, where nodes 3–5's places are
    // inside a forearm: those hang, 0–2 and 6–11 are pulled. Unclamped, node 6
    // jumps 60 px off node 5 and the two mending passes can't close that.
    const n = 12;
    const start = Array.from({ length: n }, (_, i): Vec3 => [20 * i, 0, 0]);
    const shape = start.map((p, i): Vec3 => [p[0], i >= 3 ? 120 : 0, 0]);
    const far: Body3D = { x: -1e4, y: -1e4, unit: UNIT, yaw: 0, pitch: 0, roll: 0 }; // the egg well away
    const dummy: Dummy = { body: far, capsules: [{ part: 'forearm', a: [60, 120, 0], b: [100, 120, 0], r: 15 }] };
    expect([3, 4, 5].map((i) => insideDepth(dummy, shape[i]) > 0)).toEqual([true, true, true]);
    expect([2, 6].map((i) => insideDepth(dummy, shape[i]) > 0)).toEqual([false, false]);
    const chain = createChain3(start, 'strand', 0.1);
    stepChain3(chain, start, UNIT, ROPE3D, { target: shape, stiffness: 1 }, { dummy, radii: new Array<number>(n).fill(0), from: 1 });
    const stretch = chain.points.slice(1).map((p, i) => Math.hypot(...sub(p, chain.points[i])) / 20);
    expect(Math.max(...stretch)).toBeLessThan(1.12);
    expect(chain.points[n - 1][1]).toBeGreaterThan(30); // and the pulled end did come toward its place
  });
});
