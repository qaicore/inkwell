// WP2b: the strike controller (impact design §4, "Physics"; src/lift/strike.ts).
// Decision 2 settles the order, so every run here is limbs first: contact
// I = 84, land 77, release 93. Fist first is out of scope. Synthetic bodies
// and strokes only: four kagune limbs at stiffness 0.1 slam onto P, and a
// fifth stroke that isn't one of them rides along.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { LimbControl, StrikeController, StrikeStep, Vec3 } from '../../src/impact/contracts.ts';
import { project, toCamera, type Body3D } from '../../src/lift/body.ts';
import { animate3d, liftStroke, type Frame3D, type Lifted } from '../../src/lift/lift.ts';
import { bulgeSide, limbsFirst, speedExempt, strikeController, strikeCurve, strikePhase, strikeStem, whipFrom, type StrikeOptions } from '../../src/lift/strike.ts';
import type { Vec2 } from '../../src/types/effect.ts';

const I = 84;
const STRIKE_AT = limbsFirst(I);
const { land: LAND, release: RELEASE } = STRIKE_AT;
const STEPS = 4; // 120 Hz physics at 30 fps
const EASE = 20; // 8 drawings at 12 a second, in frames
const P: Vec2 = [1180, 1000];
const D: Vec2 = [-0.06, 0.998]; // the hero's strike direction, not quite unit length
const D_LEN = Math.hypot(D[0], D[1]);
const DHAT: Vec2 = [D[0] / D_LEN, D[1] / D_LEN];
const UNIT = 200;
const SEED = 84;
const LIMBS = [1, 2, 3, 4];
const DRAWN = 10;
const BOIL = { maxPx: 1.5, cycle: 3 };
const FRAMES = 130;

const sha = (values: number[]) => createHash('sha256').update(Buffer.from(new Float64Array(values).buffer)).digest('hex');
const dist2 = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const dist3 = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const polyLength = (pts: readonly (readonly number[])[]) => pts.slice(1).reduce((s, q, i) => s + dist3(pts[i], q), 0);
const angleOf = (v: Vec2) => Math.atan2(v[1], v[0]);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

// A body that wanders, breathes, bends and leans (lift-depth.test.ts's, no turn).
function bodies3d(frames: number): Body3D[] {
  return Array.from({ length: frames }, (_, f) => {
    const t = f / 30;
    return {
      x: 960 + 120 * Math.sin(2 * Math.PI * 0.4 * t) + 40 * t,
      y: 600 + 30 * Math.sin(2 * Math.PI * 0.7 * t),
      unit: UNIT * (1 + 0.1 * Math.sin(2 * Math.PI * 0.3 * t)),
      yaw: 0,
      pitch: 0.6 * Math.max(0, Math.sin(2 * Math.PI * 0.25 * t)),
      roll: 0.15 * Math.sin(2 * Math.PI * 0.5 * t),
    };
  });
}

// A curve of 32 points from his upper back, drawn on the body `b`.
function strokePx(b: Body3D, dir: number, bendBy: number): Vec2[] {
  return Array.from({ length: 32 }, (_, i): Vec2 => {
    const s = i / 31;
    const a = dir + bendBy * s;
    return [b.x + 0.05 * b.unit + 1.2 * b.unit * s * Math.cos(a), b.y - 0.4 * b.unit + 1.2 * b.unit * s * Math.sin(a)];
  });
}

const PRESSURE = Array.from({ length: 32 }, (_, i) => 1 - 0.6 * (i / 31));
function strokesOn(b: Body3D): Lifted[] {
  const limbs = ([[-2.4, 0.8], [-0.7, -0.6], [2.6, 0.5], [0.4, -0.5]] as const).map(([dir, bendBy], i) => liftStroke(i + 1, strokePx(b, dir, bendBy), PRESSURE, b, 'strand', 0.1));
  return [...limbs, liftStroke(5, strokePx(b, 1.6, 0.4), PRESSURE, b, 'strand', 0.45, 0.5)];
}

const options = (extra: Partial<StrikeOptions> = {}): StrikeOptions => ({ ...STRIKE_AT, P, d: D, limbs: LIMBS.map((id) => ({ id })), unit: UNIT, seed: SEED, ...extra });

// Every step the controller saw, with the chains as they were at its start.
interface Logged {
  at: StrikeStep;
  points: Vec3[][];
  orders: (LimbControl | null)[];
}
function recording(inner: StrikeController, log: Logged[]): StrikeController {
  return {
    land: inner.land,
    release: inner.release,
    step(at) {
      const orders = inner.step(at);
      log.push({ at, points: at.limbs.map((l) => l.points.map((p): Vec3 => [p[0], p[1], p[2]])), orders });
      return orders;
    },
  };
}
// Each step with the chains as they are after it: the next step's start.
const withAfter = (log: Logged[]) => log.slice(0, -1).map((s, k) => ({ ...s, after: log[k + 1].points }));

function run(frames = FRAMES, extra: Partial<StrikeOptions> = {}) {
  const bodies = bodies3d(frames);
  const strokes = strokesOn(bodies[DRAWN]);
  const log: Logged[] = [];
  const control = recording(strikeController(options(extra)), log);
  return { bodies, strokes, log, frames: animate3d({ strokes, bodies, frames, dps: 12, boil: BOIL, width: 1920, control, slam: { I, posters: true } }) };
}

// Every number the frames hold, in order (as in lift-depth.test.ts).
function flatten(frames: Frame3D[]): number[] {
  const v: number[] = [];
  for (const fr of frames) {
    v.push(fr.f, fr.k, fr.capture, fr.placed.length);
    for (const p of fr.placed) {
      v.push(p.id, p.depth, p.length);
      for (const q of p.points) v.push(q[0], q[1]);
      v.push(...p.z, ...p.pressure, ...p.front.map((x) => (x ? 1 : 0)));
    }
    for (const s of fr.sim) for (const q of s.points) v.push(s.id, ...q);
  }
  return v;
}

function flattenOrders(log: Logged[]): number[] {
  const v: number[] = [];
  for (const { at, orders } of log) {
    v.push(at.f, at.sub);
    for (const o of orders) {
      if (!o) {
        v.push(-1);
        continue;
      }
      v.push(o.stiffness ?? -1, o.restScale ?? -1, o.pin === undefined ? -1 : o.pin === null ? -2 : 1);
      if (o.pin) v.push(...o.pin);
      for (const q of o.target ?? []) v.push(...q);
      for (const q of o.impulse ?? []) v.push(...q);
    }
  }
  return v;
}

// One step's orders, called directly: the limbs on their own targets unless
// `points` says where the chains are.
function ordersAt(ctl: StrikeController, b: Body3D, strokes: Lifted[], f: number, sub: number, points?: Vec3[][]) {
  const at: StrikeStep = {
    f,
    sub,
    steps: STEPS,
    body: b,
    limbs: strokes.map((s, i) => {
      const target = s.points.map((q) => toCamera(b, q));
      return { id: s.id, points: points?.[i] ?? target, target, stiffness: s.stiffness };
    }),
  };
  return { at, orders: ctl.step(at) };
}

describe('the limbs-first schedule', () => {
  it('lands at I − 7 and lets go at I + 9, with the whip (land − 2..land, the tip onto P on land) and the recoil (the release and 5 frames on) exempt from the speed guard', () => {
    expect(limbsFirst(84)).toEqual({ land: 77, release: 93 });
    expect(whipFrom(STRIKE_AT)).toBe(75);
    expect([74, 75, 76, 77, 78, 92, 93, 94, 98, 99].map((f) => speedExempt(f, STRIKE_AT))).toEqual([false, true, true, true, false, false, true, true, true, false]);
  });

  it('runs coil, strike, pinned and release on the hero frames, with the coil at (j + 14)/6 and the release easing over 8 drawings', () => {
    const phase = (f: number, sub = STEPS) => strikePhase(f, sub, STEPS, STRIKE_AT, EASE);
    expect(phase(69)).toEqual({ kind: 'none' });
    expect(phase(70, 1)).toEqual({ kind: 'coil', p: 0 });
    expect(phase(70)).toEqual({ kind: 'coil', p: 0 }); // j −14: ease_in(0)
    for (let f = 71; f <= 74; f++) {
      const ph = phase(f);
      expect(ph.kind).toBe('coil');
      if (ph.kind === 'coil') expect(ph.p).toBeCloseTo((f - 70) / 6, 12);
    }
    for (const f of [75, 76, 77]) expect(phase(f, 1), `f${f}`).toEqual({ kind: 'strike' });
    for (let f = 78; f <= 92; f++) expect(phase(f, 1).kind, `f${f}`).toBe('pinned');
    expect(phase(93, 1)).toEqual({ kind: 'release', q: 0.0125, first: true });
    expect(phase(93, 2)).toEqual({ kind: 'release', q: 0.025, first: false });
    expect(phase(112)).toEqual({ kind: 'release', q: 1, first: false });
    expect(phase(113, 1)).toEqual({ kind: 'none' });
  });
});

describe('the strike curve', () => {
  const R: Vec2 = [700, 300];
  it('runs from the root to P and bows 0.12·|P − R| at its middle, to its side', () => {
    expect(strikeCurve(R, P, 1, 0)).toEqual(R);
    const end = strikeCurve(R, P, 1, 1);
    expect(dist2(end, P)).toBeLessThan(1e-9);
    const u: Vec2 = [P[0] - R[0], P[1] - R[1]];
    const len = Math.hypot(u[0], u[1]);
    for (const side of [1, -1] as const) {
      const mid = strikeCurve(R, P, side, 0.5);
      const off: Vec2 = [mid[0] - (R[0] + P[0]) / 2, mid[1] - (R[1] + P[1]) / 2];
      expect(Math.hypot(off[0], off[1]) / len).toBeCloseTo(0.12, 12);
      expect(Math.sign((off[0] * -u[1] + off[1] * u[0]) / len)).toBe(side); // along side·(−u_y, u_x)
    }
  });

  it('is similarity-covariant about P, so a stamp that carries the root keeps the tip on P', () => {
    const k = 0.8;
    const th = 0.35;
    const S = (q: Vec2): Vec2 => {
      const [x, y] = [q[0] - P[0], q[1] - P[1]];
      return [P[0] + k * (Math.cos(th) * x - Math.sin(th) * y), P[1] + k * (Math.sin(th) * x + Math.cos(th) * y)];
    };
    for (const side of [1, -1] as const) {
      for (const t of [0, 0.1, 0.37, 0.5, 0.8, 1]) expect(dist2(strikeCurve(S(R), P, side, t), S(strikeCurve(R, P, side, t)))).toBeLessThan(1e-9);
    }
  });

  it('bows the way the drawn limb bows', () => {
    const drawn = (side: 1 | -1) => Array.from({ length: 20 }, (_, i) => strikeCurve([100, 100], [400, 250], side, i / 19));
    expect(bulgeSide(drawn(1))).toBe(1);
    expect(bulgeSide(drawn(-1))).toBe(-1);
    expect(bulgeSide([[0, 0], [1, 1], [2, 2]])).toBe(1); // straight: either way, +1
  });
});

describe('the orders', () => {
  const bodies = bodies3d(FRAMES);
  const strokes = strokesOn(bodies[DRAWN]);
  const fresh = () => strikeController(options());

  it('gives no orders before the coil, after the release has eased out, or to a stroke that is not a limb', () => {
    const ctl = fresh();
    expect(ordersAt(ctl, bodies[69], strokes, 69, 4).orders.every((o) => o === null)).toBe(true);
    expect(ordersAt(ctl, bodies[113], strokes, 113, 1).orders.every((o) => o === null)).toBe(true);
    for (const [f, sub] of [[70, 1], [75, 4], [76, 2], [80, 3], [93, 1], [102, 4]]) {
      const { orders } = ordersAt(ctl, bodies[f], strokes, f, sub);
      expect(orders.slice(0, 4).every((o) => o !== null), `f${f}`).toBe(true);
      expect(orders[4], `f${f}`).toBeNull();
    }
  });

  it('turns each coil target about its root on screen, away from P, by 30°·ease_in, root first, z kept, and stiffens it from 0.1 toward 0.5', () => {
    const ctl = fresh();
    const b = bodies[74];
    const { at, orders } = ordersAt(ctl, b, strokes, 74, STEPS); // p = 4/6 at the root, (4 − 3)/(6 − 3) at the tip
    let turned = 0;
    at.limbs.slice(0, 4).forEach((l, i) => {
      const o = orders[i]!;
      const target = o.target!;
      expect(target[0]).toEqual(l.target[0]);
      target.forEach((q, j) => expect(q[2]).toBe(l.target[j][2]));
      const R = project(b, l.target[0]).xy;
      const from = (q: Vec3): Vec2 => {
        const xy = project(b, q).xy;
        return [xy[0] - R[0], xy[1] - R[1]];
      };
      const toP = angleOf([P[0] - R[0], P[1] - R[1]]);
      const before = Math.abs(wrap(angleOf(from(l.target.at(-1)!)) - toP));
      const after = Math.abs(wrap(angleOf(from(target.at(-1)!)) - toP));
      const turn = Math.abs(wrap(angleOf(from(target.at(-1)!)) - angleOf(from(l.target.at(-1)!))));
      const full = (30 * Math.PI) / 180;
      const away = Math.sin(before) / Math.sin((15 * Math.PI) / 180); // the coil fades within 15° of P or of straight away
      if (Math.abs(away) >= 1) {
        expect(turn).toBeCloseTo(full * (1 / 3) ** 3, 9);
        expect(after).toBeGreaterThan(before);
        // Root first: the middle has wound further than the tip.
        const mid = Math.abs(wrap(angleOf(from(target[15])) - angleOf(from(l.target[15]))));
        expect(mid).toBeGreaterThan(turn);
        turned++;
      }
      expect(o.stiffness!).toBeGreaterThanOrEqual(l.stiffness);
      expect(o.stiffness!).toBeLessThanOrEqual(0.5);
      expect(o.pin).toBeUndefined();
    });
    expect(turned).toBeGreaterThanOrEqual(3);
  });

  it('whips onto the strike curve laid on the chain, the inner half first and the tip onto P at the landing, then pins the tip onto P at the curve`s depth, rippling, with the rest lengths at the curve`s', () => {
    const ctl = fresh();
    // Mid-whip (u = 1/2): laid on the chain (its own tip pinned, so the lift
    // places it exactly), the root half already on C and the tip still out.
    const mid = ordersAt(ctl, bodies[76], strokes, 76, 2);
    const end = ordersAt(ctl, bodies[77], strokes, 77, STEPS); // the whip's end: on C, the tip on P
    mid.at.limbs.slice(0, 4).forEach((l, i) => {
      const o = mid.orders[i]!;
      expect(o.stiffness).toBe(1);
      expect(o.pin).toEqual(o.target!.at(-1));
      expect(o.target![0]).toEqual(l.target[0]);
      expect(dist2(project(bodies[76], o.pin!).xy, P)).toBeGreaterThan(20);
      const e = end.orders[i]!;
      expect(dist2(project(bodies[77], e.pin!).xy, P)).toBeLessThan(1e-6);
    });
    const b = bodies[80];
    const { at, orders } = ordersAt(ctl, b, strokes, 80, 3);
    at.limbs.slice(0, 4).forEach((l, i) => {
      const o = orders[i]!;
      const target = o.target!;
      expect(o.stiffness).toBe(1);
      expect(target[0]).toEqual(l.target[0]);
      expect(o.pin).toEqual(target.at(-1));
      expect(dist2(project(b, o.pin!).xy, P)).toBeLessThan(1e-6);
      const S = strikeStem(b, l.target[0]); // the curve sets off out of his back
      expect(o.pin![2] - S[2]).toBeCloseTo(0.25 * UNIT, 9); // z lifted 0.25 unit at the tip
      expect(o.restScale!).toBeCloseTo(polyLength(target) / polyLength(l.target), 12);
      // Every node past the stem lies on C (from the stem's end), bowed the
      // way the drawn limb bows, but for the ripple running down it:
      // 0.05·|P − R| at most, and there.
      const R = project(b, l.target[0]).xy;
      const RS = project(b, S).xy;
      const side = bulgeSide(l.target.map((q) => project(b, q).xy));
      const curve = Array.from({ length: 4001 }, (_, k) => strikeCurve(RS, P, side, k / 4000));
      const stem = dist2(R, RS);
      const off = target.filter((q) => dist2(project(b, q).xy, R) > stem + 1).map((q) => Math.min(...curve.map((c) => dist2(c, project(b, q).xy))));
      expect(off.length).toBeGreaterThan(target.length - 6);
      expect(Math.max(...off)).toBeLessThan(0.05 * dist2(P, R) + 0.5);
      expect(Math.max(...off)).toBeGreaterThan(1);
    });
  });

  it('lets go on the release: no pin, the drawn length back within the frame, a bow of it handing back to the drawing`s own target, and the recoil −d̂·1.5 unit/s·t_i ± 0.4 across on its first step only', () => {
    const ctl = fresh();
    const pinned = ordersAt(ctl, bodies[93], strokes, 92, STEPS).orders; // the chains on C, on the same body
    const chains = pinned.slice(0, 4).map((o) => o!.target!);
    chains.push(strokes[4].points.map((q) => toCamera(bodies[93], q)));
    const { at, orders } = ordersAt(ctl, bodies[93], strokes, 93, 1, chains);
    const across: Vec2 = [-DHAT[1], DHAT[0]];
    const laterals: number[] = [];
    at.limbs.slice(0, 4).forEach((l, i) => {
      const o = orders[i]!;
      expect(o.pin).toBeNull();
      // Half the way from the chain's length to the drawn length on each step.
      const scale = pinned[i]!.restScale!;
      expect(o.restScale!).toBeCloseTo(scale + (1 - scale) * 0.5, 9);
      // The target: the drawn length, from the root, held near stiffness 1.
      const target = o.target!;
      expect(target).toHaveLength(l.target.length);
      expect(target[0]).toEqual(l.target[0]);
      expect(Math.abs(polyLength(target) / polyLength(l.target) - 1)).toBeLessThan(0.02); // the pull out of P stretches it a little
      expect(o.stiffness!).toBeGreaterThan(0.99);
      const impulse = o.impulse!;
      expect(impulse).toHaveLength(l.target.length);
      expect(Math.hypot(...impulse[0])).toBe(0); // the root's share
      const tip = impulse.at(-1)!;
      expect(tip[2]).toBe(0);
      expect(tip[0] * DHAT[0] + tip[1] * DHAT[1]).toBeCloseTo(-1.5 * UNIT, 9);
      const lateral = (tip[0] * across[0] + tip[1] * across[1]) / (1.5 * UNIT);
      expect(Math.abs(lateral)).toBeLessThanOrEqual(0.4);
      laterals.push(lateral);
      // Each node's share of it grows along the chain.
      for (let j = 1; j < impulse.length; j++) expect(Math.hypot(...impulse[j])).toBeGreaterThan(Math.hypot(...impulse[j - 1]));
    });
    expect(new Set(laterals.map((x) => x.toFixed(9))).size).toBe(4); // seeded per limb
    for (const sub of [2, 3, 4]) expect(ordersAt(ctl, bodies[93], strokes, 93, sub).orders.every((o) => !o?.impulse)).toBe(true);
    const done = ordersAt(ctl, bodies[112], strokes, 112, STEPS).orders; // the end of the ease
    expect(done.slice(0, 4).map((o) => o!.restScale)).toEqual([1, 1, 1, 1]);
    for (const o of done.slice(0, 4)) expect(o!.stiffness).toBeCloseTo(0.1, 9);
  });

  it('draws the lateral from the seed: the same seed gives the same recoil, another seed another', () => {
    const recoil = (seed: number) => ordersAt(strikeController(options({ seed })), bodies[93], strokes, 93, 1).orders.slice(0, 4).map((o) => o!.impulse!.at(-1)!);
    expect(recoil(SEED)).toEqual(recoil(SEED));
    expect(recoil(SEED + 1)).not.toEqual(recoil(SEED));
  });

  it('refuses a schedule that is not whole frames with land < release, or a unit that is not positive', () => {
    expect(() => strikeController(options({ land: 93, release: 93 }))).toThrow();
    expect(() => strikeController(options({ land: 77.5 }))).toThrow();
    expect(() => strikeController(options({ unit: 0 }))).toThrow();
  });
});

describe('the strike in the lift (land 77, release 93)', () => {
  const { bodies, log, frames } = run();
  const steps = withAfter(log);

  it('projects every tip within 0.5 px of P on every step from the landing`s end to release − 1, and draws it there', () => {
    let worst = 0;
    let n = 0;
    for (const s of steps) {
      if (s.at.f < LAND || s.at.f >= RELEASE || (s.at.f === LAND && s.at.sub < STEPS)) continue; // the whip's last frame brings the tip onto P
      for (let i = 0; i < LIMBS.length; i++, n++) worst = Math.max(worst, dist2(project(s.at.body, s.after[i].at(-1)!).xy, P));
    }
    expect(n).toBe(((RELEASE - LAND - 1) * STEPS + 1) * LIMBS.length);
    expect(worst).toBeLessThan(0.5);
    for (let f = LAND; f < RELEASE; f++) {
      const placed = frames[f].placed.filter((p) => LIMBS.includes(p.id));
      expect(placed).toHaveLength(4);
      for (const p of placed) expect(dist2(p.points.at(-1)!, P), `f${f} limb ${p.id}`).toBeLessThan(0.5);
    }
  });

  it('keeps every root within 0.5 px of its anchor at every step (P1)', () => {
    let worst = 0;
    for (const s of steps) s.at.limbs.forEach((l, i) => (worst = Math.max(worst, dist2(project(s.at.body, s.after[i][0]).xy, project(s.at.body, l.target[0]).xy))));
    expect(worst).toBeLessThan(0.5);
  });

  it('has every segment back within 2 % of its rest length from 8 drawings after the release on (P2)', () => {
    // The rest length then: the lift's own, at the share of it the limb was drawn at (decision 15).
    const strokes = strokesOn(bodies[DRAWN]);
    const share = strokes.map((s) => Math.min(1, s.drawn! / s.points.slice(1).reduce((sum, q, k) => sum + dist3(s.points[k], q), 0)));
    const late = withAfter(run(160).log).filter((s) => s.at.f >= RELEASE + EASE);
    let worst = 0;
    for (const s of late) {
      expect(s.orders.every((o) => o === null)).toBe(true); // the limbs are the lift's again
      s.at.limbs.forEach((l, i) => {
        for (let j = 0; j + 1 < l.target.length; j++) {
          const rest = dist3(l.target[j], l.target[j + 1]) * (LIMBS.includes(l.id) ? share[i] : 1);
          worst = Math.max(worst, Math.abs(dist3(s.after[i][j], s.after[i][j + 1]) - rest) / rest);
        }
      });
    }
    expect(late.length).toBeGreaterThan(0);
    expect(worst).toBeLessThan(0.02);
  });

  it('pulls every tip out of P along −d on the release, and keeps it out along −d for the 3 frames after', () => {
    const back: Vec2 = [-DHAT[0], -DHAT[1]];
    LIMBS.forEach((id, i) => {
      const tip = (f: number) => project(bodies[f], frames[f].sim[i].points.at(-1)!).xy;
      // The drawn length comes back on the release frame, so the tip leaves P
      // back along C at once (and the pull carries it on up −d̂); after that
      // it may settle back a little onto its order, never back to P.
      const out = (f: number) => (tip(f)[0] - P[0]) * back[0] + (tip(f)[1] - P[1]) * back[1];
      expect(out(RELEASE), `limb ${id}`).toBeGreaterThan(20);
      for (let f = RELEASE + 1; f < RELEASE + 3; f++) expect(out(f), `limb ${id} f${f}`).toBeGreaterThan(0.5 * out(RELEASE));
      const [a, b] = [tip(RELEASE - 1), tip(RELEASE + 2)];
      const m: Vec2 = [b[0] - a[0], b[1] - a[1]];
      expect((m[0] * back[0] + m[1] * back[1]) / Math.hypot(m[0], m[1]), `limb ${id}`).toBeGreaterThan(0.5); // within 60° of −d
    });
    // The released throw, held near stiffness 1, now sets where the tips go:
    // the recoil's own share is checked on its step in 'the orders'.
  });

  it('leaves a stroke that is not one of the limbs exactly as the plain lift moves it', () => {
    const plain = animate3d({ strokes: strokesOn(bodies[DRAWN]), bodies, frames: FRAMES, dps: 12, boil: BOIL, width: 1920 });
    for (let f = 0; f < FRAMES; f++) expect(frames[f].sim[4].points, `f${f}`).toEqual(plain[f].sim[4].points);
  });

  it('gives byte-identical arrays on two runs, and a new seed changes nothing before the whip (the ripple is seeded too)', () => {
    const again = run();
    expect(sha(flatten(again.frames))).toBe(sha(flatten(frames)));
    expect(sha(flattenOrders(again.log))).toBe(sha(flattenOrders(log)));
    const other = run(FRAMES, { seed: SEED + 1 });
    const whip = whipFrom(STRIKE_AT);
    expect(sha(flatten(other.frames.slice(0, whip)))).toBe(sha(flatten(frames.slice(0, whip))));
    expect(sha(flatten(other.frames.slice(whip)))).not.toBe(sha(flatten(frames.slice(whip))));
  });
});

describe('10,000 steps (P3)', () => {
  it('gives no NaN, and keeps every tip under 20 torso heights a second on every frame but land − 1, land and the recoil', () => {
    const frames = 2501; // 2500 frames of 4 steps
    const bodies = bodies3d(frames);
    const strokes = strokesOn(bodies[DRAWN]);
    const inner = strikeController(options());
    let last: { f: number; unit: number; tips: Vec3[] } | null = null;
    let worst = 0;
    let bad = 0;
    let n = 0;
    const control: StrikeController = {
      land: inner.land,
      release: inner.release,
      step(at) {
        n++;
        for (const l of at.limbs) for (const p of l.points) if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) bad++;
        const tips = at.limbs.map((l): Vec3 => [...l.points[l.points.length - 1]]);
        if (last && !speedExempt(last.f, STRIKE_AT)) {
          const prev = last;
          tips.forEach((t, i) => (worst = Math.max(worst, (dist3(t, prev.tips[i]) * 120) / prev.unit)));
        }
        last = { f: at.f, unit: at.body.unit, tips };
        return inner.step(at);
      },
    };
    const out = animate3d({ strokes, bodies, frames, dps: 12, boil: BOIL, width: 1920, control, slam: { I, posters: true } });
    expect(n).toBe(10_000);
    expect(bad).toBe(0);
    expect(out.every((fr) => fr.placed.every((p) => p.points.every((q) => Number.isFinite(q[0]) && Number.isFinite(q[1]))))).toBe(true);
    expect(worst).toBeLessThan(20);
  });
});
