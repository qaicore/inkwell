// WP2: the 3D lift's per-point depth, chain start and strike hook (impact
// design §2 and §4; src/lift/lift.ts and src/lift/strand3d.ts). Synthetic
// bodies and strokes only. The no-slam hashes were recorded from the lift as
// it was before WP2 (HEAD 4bef2d4), on these same generators.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { LimbControl, StrikeController, StrikeStep, Vec3 } from '../../src/impact/contracts.ts';
import { lerpBody, project, toCamera, type Body3D } from '../../src/lift/body.ts';
import { animate3d, heldLimbs, liftStroke, type Animate3DOptions, type Frame3D, type Lifted } from '../../src/lift/lift.ts';
import { drawingIndex } from '../../src/motion/timing.ts';
import type { Vec2 } from '../../src/types/effect.ts';

const FRAMES = 90;
const DRAWN = 10;
const BOIL = { maxPx: 1.5, cycle: 3 };
const sha = (values: number[]) => createHash('sha256').update(Buffer.from(new Float64Array(values).buffer)).digest('hex');
const dist3 = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], (a[2] ?? 0) - (b[2] ?? 0));
const dist2 = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// A body that wanders, breathes, bends and leans; `spin` adds a full turn on f30–60.
function bodies3d(spin: boolean, frames = FRAMES): Body3D[] {
  return Array.from({ length: frames }, (_, f) => {
    const t = f / 30;
    const turn = spin ? Math.min(1, Math.max(0, (f - 30) / 30)) : 0;
    return {
      x: 960 + 120 * Math.sin(2 * Math.PI * 0.4 * t) + 40 * t,
      y: 600 + 30 * Math.sin(2 * Math.PI * 0.7 * t),
      unit: 200 * (1 + 0.1 * Math.sin(2 * Math.PI * 0.3 * t)),
      yaw: 2 * Math.PI * turn * turn * (3 - 2 * turn),
      pitch: 0.6 * Math.max(0, Math.sin(2 * Math.PI * 0.25 * t)),
      roll: 0.15 * Math.sin(2 * Math.PI * 0.5 * t),
    };
  });
}

// A curl of 32 points from his upper back, drawn on the body `b`.
function strokePx(b: { x: number; y: number; unit: number }, dir: number, bendBy: number): Vec2[] {
  return Array.from({ length: 32 }, (_, i): Vec2 => {
    const s = i / 31;
    const a = dir + bendBy * s;
    return [b.x + 0.05 * b.unit + 1.2 * b.unit * s * Math.cos(a), b.y - 0.4 * b.unit + 1.2 * b.unit * s * Math.sin(a)];
  });
}

const PRESSURE = Array.from({ length: 32 }, (_, i) => 1 - 0.6 * (i / 31));
function strokesOn(b: Body3D): Lifted[] {
  return [
    liftStroke(1, strokePx(b, -2.4, 0.8), PRESSURE, b, 'strand', 0.1),
    liftStroke(2, strokePx(b, -0.7, -0.6), PRESSURE, b, 'strand', 0.45, 0.5),
    liftStroke(3, strokePx(b, 2.0, 0.3), PRESSURE, b, 'rigid', 1),
  ];
}

function run(extra: Partial<Animate3DOptions> = {}, spin = false, frames = FRAMES) {
  const bodies = bodies3d(spin, frames);
  const strokes = strokesOn(bodies[DRAWN]);
  return { bodies, strokes, frames: animate3d({ strokes, bodies, frames, dps: 12, boil: BOIL, width: 1920, ...extra }) };
}

// Every number the frames hold, in order, for hashing and exact comparison.
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

// The pre-WP2 hash: the fields the lift had then.
function noSlamHash(spin: boolean): string {
  const { frames } = run({}, spin);
  const v: number[] = [];
  for (const fr of frames) {
    v.push(fr.f, fr.k, fr.placed.length);
    for (const p of fr.placed) {
      v.push(p.id, p.depth, p.points.length);
      for (const q of p.points) v.push(q[0], q[1]);
      for (const q of p.pressure) v.push(q);
      for (const q of p.front) v.push(q ? 1 : 0);
    }
  }
  return sha(v);
}

const captured = (frames: Frame3D[], f: number) => f === 0 || frames[f].capture !== frames[f - 1].capture;
const onGrid = (f: number) => f === 0 || drawingIndex(f, 12) !== drawingIndex(f - 1, 12);

describe('per-point depth', () => {
  it('gives every placed point a finite camera depth, the chain`s own on a capture and scaled with him between', () => {
    const { frames, bodies } = run({}, true);
    let last = 0;
    for (const fr of frames) {
      expect(fr.placed.map((p) => p.id)).toEqual([1, 2, 3]);
      if (captured(frames, fr.f)) last = fr.f;
      for (const p of fr.placed) {
        expect(p.z).toHaveLength(p.points.length);
        expect(p.z.every(Number.isFinite)).toBe(true);
        const sim = frames[last].sim.find((s) => s.id === p.id)!;
        const scale = bodies[fr.f].unit / bodies[last].unit;
        p.z.forEach((z, i) => expect(z).toBeCloseTo(sim.points[i][2] * scale, 9));
      }
    }
    // Behind his back on the drawing frame, so deeper than the anchor.
    expect(frames[DRAWN].placed.every((p) => p.z.every((z) => z < 0))).toBe(true);
  });

  it('builds HeldLimb values, with the length as drawn', () => {
    const { frames, bodies } = run();
    const drawn = strokePx(bodies[DRAWN], -2.4, 0.8);
    let length = 0;
    for (let i = 1; i < drawn.length; i++) length += dist2(drawn[i], drawn[i - 1]);
    for (const fr of [frames[0], frames[DRAWN], frames[FRAMES - 1]]) {
      const limbs = heldLimbs(fr);
      expect(limbs.map((l) => Object.keys(l).sort())).toEqual(fr.placed.map(() => ['front', 'id', 'length', 'points', 'pressure', 'z']));
      limbs.forEach((l, i) => {
        const p = fr.placed[i];
        expect(l).toEqual({ id: p.id, points: p.points, z: p.z, pressure: p.pressure, front: p.front, length: p.length });
      });
      expect(limbs[0].length).toBeCloseTo(length, 9);
      expect(limbs[0].length).toBeGreaterThan(200);
    }
  });
});

describe('chain start', () => {
  it('creates each chain on the first frame of its emergence drawing, resting on that frame`s body', () => {
    // 12 dps: f22 is in drawing 8, which starts on f20; f40 starts drawing 16.
    const { frames, strokes, bodies } = run({ emerge: new Map([[1, 22], [2, 22], [3, 40]]) });
    for (const fr of frames) {
      const want = fr.f < 20 ? [] : fr.f < 40 ? [1, 2] : [1, 2, 3];
      expect(fr.sim.map((s) => s.id)).toEqual(want);
      expect(fr.placed.map((p) => p.id)).toEqual(want);
    }
    for (const [f, j] of [[20, 0], [20, 1], [40, 2]]) {
      const sim = frames[f].sim.find((s) => s.id === strokes[j].id)!;
      expect(sim.points).toEqual(strokes[j].points.map((q) => toCamera(bodies[f], q)));
    }
    expect(captured(frames, 20) && captured(frames, 40)).toBe(true);
  });

  it('leaves the other chains exactly as they were', () => {
    const plain = run().frames;
    const late = run({ emerge: new Map([[3, 40]]) }).frames;
    for (let f = 0; f < FRAMES; f++) {
      for (const id of [1, 2]) {
        expect(late[f].sim.find((s) => s.id === id)).toEqual(plain[f].sim.find((s) => s.id === id));
        expect(late[f].placed.find((p) => p.id === id)).toEqual(plain[f].placed.find((p) => p.id === id));
      }
    }
    // A stroke without an emergence, or emerging on frame 0, is there from the start.
    expect(flatten(run({ emerge: new Map([[1, 0]]) }).frames)).toEqual(flatten(plain));
  });
});

describe('the strike hook', () => {
  const PIN: Vec3 = [500, 500, 0];

  it('pins every tip to (500, 500) within 0.5 px on every step, with the roots on their anchors (P1)', () => {
    let steps = 0;
    let worstTip = 0;
    let worstRoot = 0;
    let previous: (readonly Vec3[])[] | null = null; // last step's targets: the roots it set
    const seen: StrikeStep[] = [];
    const control: StrikeController = {
      land: 1,
      release: FRAMES, // pinned from frame 1 on: every frame is captured
      step(at) {
        if (steps < 8) seen.push(at);
        if (previous) {
          at.limbs.forEach((l, i) => {
            worstTip = Math.max(worstTip, dist3(l.points[l.points.length - 1], PIN));
            worstRoot = Math.max(worstRoot, dist3(l.points[0], previous![i][0]));
          });
        }
        previous = at.limbs.map((l) => l.target);
        steps++;
        return at.limbs.map((): LimbControl => ({ pin: PIN }));
      },
    };
    const { frames, bodies, strokes } = run({ control });
    expect(steps).toBe((FRAMES - 1) * 4);
    expect(worstTip).toBeLessThan(0.5);
    expect(worstRoot).toBeLessThan(0.5);
    // What the hook is shown: the frame, the step, the body and each limb.
    expect(seen.map((s) => [s.f, s.sub, s.steps])).toEqual([[1, 1, 4], [1, 2, 4], [1, 3, 4], [1, 4, 4], [2, 1, 4], [2, 2, 4], [2, 3, 4], [2, 4, 4]]);
    expect(seen[1].body).toEqual(lerpBody(bodies[0], bodies[1], 2 / 4));
    expect(seen[1].limbs.map((l) => [l.id, l.stiffness])).toEqual([[1, 0.1], [2, 0.45], [3, 1]]);
    expect(seen[1].limbs[0].target).toEqual(strokes[0].points.map((q) => toCamera(seen[1].body, q)));
    // The frame ends, and the placed tips: pinned, so no boil.
    for (const fr of frames.slice(1)) {
      fr.sim.forEach((s, i) => {
        expect(dist3(s.points[s.points.length - 1], PIN)).toBeLessThan(0.5);
        expect(dist3(s.points[0], toCamera(bodies[fr.f], strokes[i].points[0]))).toBeLessThan(0.5);
      });
      expect(captured(frames, fr.f)).toBe(true);
      for (const p of fr.placed) expect(dist2(p.points[p.points.length - 1], [500, 500])).toBeLessThan(0.5);
    }
    expect(flatten(frames).every(Number.isFinite)).toBe(true);
  });

  it('leaves the lift alone when the controller gives no orders', () => {
    const idle: StrikeController = { land: 10_000, release: 10_016, step: (at) => at.limbs.map(() => null) };
    expect(flatten(run({ control: idle }).frames)).toEqual(flatten(run().frames));
    expect(run({ control: idle }).frames.every((fr) => fr.drawing === 'grid')).toBe(true);
  });

  it('applies the target, stiffness, rest-length scale and impulse orders', () => {
    // Target and stiffness: a target shifted 60 px right, at stiffness 1, pulls the tip over; the root stays put.
    const shifted: StrikeController = {
      land: 10_000,
      release: 10_016,
      step: (at) => at.limbs.map((l) => ({ target: l.target.map((p, i): Vec3 => (i === 0 ? [p[0], p[1], p[2]] : [p[0] + 60, p[1], p[2]])), stiffness: 1 })),
    };
    const { frames, bodies, strokes } = run({ control: shifted });
    const fr = frames[60];
    const tip = fr.sim[0].points[31];
    const drawnTip = toCamera(bodies[60], strokes[0].points[31]);
    expect(tip[0] - drawnTip[0]).toBeGreaterThan(40);
    expect(dist3(fr.sim[0].points[0], toCamera(bodies[60], strokes[0].points[0]))).toBeLessThan(0.5);

    // Rest-length scale: with no shape pull, every segment comes out at half its drawn length.
    const halved: StrikeController = { land: 10_000, release: 10_016, step: (at) => at.limbs.map(() => ({ restScale: 0.5, stiffness: 0 })) };
    const half = run({ control: halved });
    const chain = half.frames[30].sim[0].points;
    const drawn = half.strokes[0].points.map((q) => toCamera(lerpBody(half.bodies[29], half.bodies[30], 1), q));
    for (let i = 0; i < 31; i++) expect(dist3(chain[i], chain[i + 1])).toBeCloseTo(0.5 * dist3(drawn[i], drawn[i + 1]), 6);

    // Impulse: once, on f20's first step, 3000 px/s up for every node of limb 1.
    const kick: StrikeController = {
      land: 10_000,
      release: 10_016,
      step: (at) => at.limbs.map((l) => (at.f === 20 && at.sub === 1 && l.id === 1 ? { impulse: l.points.map((): Vec3 => [0, -3000, 0]) } : null)),
    };
    const kicked = run({ control: kick }).frames;
    const plain = run().frames;
    for (let f = 0; f < 20; f++) expect(kicked[f]).toEqual(plain[f]);
    expect(kicked[20].sim[0].points[31][1]).toBeLessThan(plain[20].sim[0].points[31][1] - 10);
    expect(kicked[20].sim[1]).toEqual(plain[20].sim[1]);
    expect(flatten(kicked).every(Number.isFinite)).toBe(true);
  });
});

describe('captures under a strike', () => {
  // Limbs first: land I − 7, release I + 9. The controller pins every tip
  // to P from the landing to the frame before the release.
  function strike(I: number) {
    const land = I - 7;
    const release = I + 9;
    const P: Vec3 = [1180, 820, 0];
    const control: StrikeController = { land, release, step: (at) => at.limbs.map(() => (at.f >= land && at.f < release ? { pin: P } : null)) };
    return { land, release, P, frames: run({ control, slam: { I, posters: true } }, false, 130).frames };
  }

  it('captures every frame f76–93 for land 77 and release 93 (I = 84), and keeps the grid elsewhere', () => {
    const { frames, P } = strike(84);
    for (let f = 0; f < 130; f++) expect(captured(frames, f), `f${f}`).toBe(f >= 76 && f <= 93 ? true : onGrid(f));
    const want = (f: number) => {
      if ([76, 77, 79, 81, 83, 93].includes(f)) return 'tube';
      if ([78, 80, 82].includes(f)) return 'stamp';
      if (f >= 84 && f <= 92) return 'silhouette';
      return 'grid';
    };
    for (let f = 0; f < 130; f++) expect(frames[f].drawing, `f${f}`).toBe(want(f));
    // The pin is exact on every pinned frame: no boil on a pinned tip.
    for (let f = 77; f <= 92; f++) for (const p of frames[f].placed) expect(dist2(p.points[31], [P[0], P[1]])).toBeLessThan(1e-6);
    expect(frames[93].placed.some((p) => dist2(p.points[31], [P[0], P[1]]) > 0.01)).toBe(true);
  });

  it('forces a new drawing on a release that falls mid-drawing (limbs first at I = 60)', () => {
    const { frames, land, release } = strike(60);
    expect([land, release]).toEqual([53, 69]);
    expect(drawingIndex(69, 12)).toBe(drawingIndex(68, 12)); // f69 is mid-drawing on the grid
    for (let f = 0; f < 130; f++) expect(captured(frames, f), `f${f}`).toBe(f >= 52 && f <= 69 ? true : onGrid(f));
    expect([52, 53, 55, 57, 59, 69].map((f) => frames[f].drawing)).toEqual(['tube', 'tube', 'tube', 'tube', 'tube', 'tube']);
    expect([54, 56, 58].map((f) => frames[f].drawing)).toEqual(['stamp', 'stamp', 'stamp']);
    expect(frames.slice(60, 69).every((fr) => fr.drawing === 'silhouette')).toBe(true);
  });

  it('marks the strike frames without posters when there is no slam', () => {
    const control: StrikeController = { land: 77, release: 93, step: (at) => at.limbs.map(() => null) };
    const { frames } = run({ control }, false, 100);
    expect(frames.slice(76, 94).map((fr) => fr.drawing)).toEqual(['tube', 'tube', ...Array.from({ length: 15 }, (_, i) => (i % 2 === 0 ? 'stamp' : 'tube')), 'tube']);
  });
});

describe('determinism and the no-slam output', () => {
  it('gives byte-identical arrays on two runs with every kind of order', () => {
    const control = (): StrikeController => ({
      land: 40,
      release: 56,
      step: (at) =>
        at.limbs.map((l) => {
          if (at.f < 39) return null;
          if (at.f === 56 && at.sub === 1) return { impulse: l.points.map((): Vec3 => [-200, 150, 30]) };
          if (at.f >= 56) return null;
          return { target: l.target.map((p): Vec3 => [p[0] - 40, p[1] + 25, p[2]]), stiffness: 0.8, restScale: 1.2, pin: at.f >= 40 ? [700, 640, 20] : null };
        }),
    });
    const a = flatten(run({ control: control(), slam: { I: 47, posters: true }, emerge: new Map([[2, 15]]) }, true).frames);
    const b = flatten(run({ control: control(), slam: { I: 47, posters: true }, emerge: new Map([[2, 15]]) }, true).frames);
    expect(a.every(Number.isFinite)).toBe(true);
    expect(sha(a)).toBe(sha(b));
  });

  it('matches the output recorded before WP2, with no controller, no emergence and no slam', () => {
    expect(noSlamHash(false)).toBe('ed58c3d4de57769194cfa6784a09ff06c66d72889bb27ae52e2d8d6b483417b1');
    expect(noSlamHash(true)).toBe('14eb5dfa1f0ff714bace3fa71049c7ea6ee203cbd7100fd389becbf39dd3ea93');
  });

  it('projects the placed root where the chain root projects on every capture', () => {
    const { frames, bodies } = run({ boil: { maxPx: 0, cycle: 3 } }, true);
    for (const fr of frames) {
      if (!captured(frames, fr.f)) continue;
      fr.placed.forEach((p, i) => expect(dist2(p.points[0], project(bodies[fr.f], fr.sim[i].points[0]).xy)).toBeLessThan(1e-6));
    }
  });
});
