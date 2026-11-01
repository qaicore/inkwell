// WP2: frames without a pose (impact design §2, "Frames without a pose";
// src/track/bend.ts, src/lift/body.ts and animate.ts's body callback).
// Synthetic stand-ins, except the hero block at the end: it reads the cached
// stand-in pose (samples/hero/pose.json, gitignored, or the file
// INKWELL_HERO_POSE names) and decodes the cached SAM person masks
// (fixtures/probe/sam-person.json, about 12 s); it skips when either is
// missing. The no-slam hashes were recorded before WP2 (HEAD 4bef2d4).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { liftBodies, project, toCamera } from '../../src/lift/body.ts';
import { animate3d, liftStroke } from '../../src/lift/lift.ts';
import { animate, heldBody, type AnimatedFrame } from '../../src/motion/animate.ts';
import type { BodyAngle } from '../../src/motion/body.ts';
import { masksFromCache, toFrameMask } from '../../src/sam/cache.ts';
import { trackPoses } from '../../src/track/anchor.ts';
import { BLEND, gapWeights, goodStandIns, holdGaps, measuredBend, torsoBend, type Bend, type PoseGate } from '../../src/track/bend.ts';
import { torsoHeights } from '../../src/track/torso.ts';
import type { Mask, PointSet } from '../../src/track/tracking.ts';
import type { Effect, Vec2 } from '../../src/types/effect.ts';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const HERO_POSE = process.env.INKWELL_HERO_POSE ?? resolve(REPO, 'samples/hero/pose.json');
const HERO_MASKS = resolve(REPO, 'fixtures/probe/sam-person.json');
const FRAMES = 90;
const sha = (values: number[]) => createHash('sha256').update(Buffer.from(new Float64Array(values).buffer)).digest('hex');
const ease = (t: number) => t * t * (3 - 2 * t);
const deg = (r: number) => (r * 180) / Math.PI;

// ---- A synthetic stand-in -------------------------------------------------------------

// An upright body at 30 fps that leans, bends forward and turns side-on
// (frames 40–48) and back: shoulders 11 (his left) and 12, hips 13 and 14.
function standIn(f: number): PointSet {
  const t = f / 30;
  const roll = 0.2 * Math.sin(2 * Math.PI * 0.4 * t);
  const pitch = 0.9 * Math.max(0, Math.sin(2 * Math.PI * 0.3 * t));
  const side = f >= 40 && f <= 48 ? 0.15 : 1; // the shoulder width collapses side-on
  const cx = 900 + 60 * Math.sin(2 * Math.PI * 0.2 * t);
  const cy = 600;
  const spine = 180 * Math.cos(pitch);
  const half = 65 * side;
  const up: Vec2 = [Math.sin(roll), -Math.cos(roll)];
  const across: Vec2 = [Math.cos(roll), Math.sin(roll)];
  const hip: Vec2 = [cx, cy];
  const sh: Vec2 = [cx + up[0] * spine, cy + up[1] * spine];
  const x = new Float32Array(15);
  const y = new Float32Array(15);
  const confidence = new Float32Array(15).fill(0.99);
  const put = (i: number, p: Vec2) => {
    x[i] = p[0];
    y[i] = p[1];
  };
  for (let i = 0; i < 11; i++) put(i, [sh[0] + up[0] * 60 + across[0] * (i - 5) * 4, sh[1] + up[1] * 60 + across[1] * (i - 5) * 4]);
  put(11, [sh[0] + across[0] * half, sh[1] + across[1] * half]);
  put(12, [sh[0] - across[0] * half, sh[1] - across[1] * half]);
  put(13, [hip[0] + across[0] * 38 * side, hip[1] + across[1] * 38 * side]);
  put(14, [hip[0] - across[0] * 38 * side, hip[1] - across[1] * 38 * side]);
  return { x, y, confidence };
}

// The person mask: a box round him, at a quarter of the 1920 × 1080 frame.
const BOX = [700, 300, 1100, 900];
function boxMask(): Mask {
  const [width, height] = [480, 270];
  const alpha = new Uint8ClampedArray(width * height);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const [x, y] = [(col + 0.5) * 4, (row + 0.5) * 4];
      if (x >= BOX[0] && x < BOX[2] && y >= BOX[1] && y < BOX[3]) alpha[row * width + col] = 255;
    }
  }
  return { width, height, alpha };
}
const GATE: PoseGate = { mask: () => boxMask(), width: 1920, height: 1080 };

// Gap on f10–22 (no body, then a hip lost, then a shoulder lost), a phantom on f30.
function gapped(): (PointSet | null)[] {
  return Array.from({ length: FRAMES }, (_, f) => {
    if (f >= 10 && f <= 15) return null;
    const b = standIn(f);
    if (f >= 16 && f <= 19) b.confidence[13] = 0.2;
    if (f >= 20 && f <= 22) b.confidence[12] = 0.1;
    if (f === 30) {
      // A second body, off him, in another pose.
      const other = standIn(70);
      for (let i = 0; i < 15; i++) [b.x[i], b.y[i]] = [other.x[i] + 520, other.y[i]];
    }
    return b;
  });
}
const finite = (bend: Bend[]) => bend.every((b) => Number.isFinite(b.roll) && Number.isFinite(b.pitch));

describe('which stand-in frames are good', () => {
  it('needs both shoulders and both hips, and the shoulder midpoint on the dilated mask', () => {
    const bodies = gapped();
    const good = goodStandIns(bodies, GATE);
    for (let f = 0; f < FRAMES; f++) expect(good[f], `f${f}`).toBe(!((f >= 10 && f <= 22) || f === 30));
    // Without the mask the phantom counts; a frame without a mask doesn't.
    expect(goodStandIns(bodies)[30]).toBe(true);
    expect(goodStandIns(bodies, { ...GATE, mask: () => null }).some((g) => g)).toBe(false);
    // Just off the box is still on it within 0.03 S (32 px); farther isn't.
    const near = standIn(5);
    const shift = (b: PointSet, dx: number) => ({ ...b, x: b.x.map((v) => v + dx) });
    const midX = (near.x[11] + near.x[12]) / 2;
    expect(goodStandIns([shift(near, BOX[2] + 20 - midX)], GATE)).toEqual([true]);
    expect(goodStandIns([shift(near, BOX[2] + 45 - midX)], GATE)).toEqual([false]);
  });
});

describe('the gap rule', () => {
  it('weighs the good frames back in over 4 frames with smoothstep', () => {
    const T = true;
    const F = false;
    expect(BLEND).toBe(4);
    expect(gapWeights([T, T, F, F, T, T, T, T, T])).toEqual([1, 1, 0, 0, 0.15625, 0.5, 0.84375, 1, 1]);
    expect(gapWeights([F, F, T, T])).toEqual([0, 0, 1, 1]);
    expect(holdGaps([1, 2, 3, 4, 10, 10, 10, 10, 10], [T, T, F, F, T, T, T, T, T])).toEqual([1, 2, 2, 2, 3.25, 6, 8.75, 10, 10]);
    expect(holdGaps([5, 6, 7, 8], [F, F, T, T])).toEqual([7, 7, 7, 8]);
    expect(holdGaps([5, 6], [F, F])).toEqual([5, 6]);
    // A gap inside a blend holds the blended value.
    expect(holdGaps([0, 9, 4, 9, 8, 8, 8, 8], [T, F, T, F, T, T, T, T])).toEqual([0, 0, 0.625, 0.625, 1.77734375, 4.3125, 6.84765625, 8]);
  });

  it('holds f9 through the gap on f10–22, blends back over f23–26, ignores the phantom on f30, and has no NaN', () => {
    const bodies = gapped();
    const good = goodStandIns(bodies, GATE);
    const bend = torsoBend(bodies, 5, 30, good)!;
    const measured = measuredBend(bodies, 5, 30, good)!;
    expect(finite(bend) && finite(measured)).toBe(true);
    expect(bend[9]).toEqual(measured[9]);
    for (let f = 10; f <= 22; f++) expect(bend[f], `f${f}`).toEqual(bend[9]);
    for (let f = 23; f <= 26; f++) {
      const w = ease((f - 22) / 4);
      expect(bend[f].roll).toBeCloseTo(bend[9].roll + (measured[f].roll - bend[9].roll) * w, 12);
      expect(bend[f].pitch).toBeCloseTo(bend[9].pitch + (measured[f].pitch - bend[9].pitch) * w, 12);
    }
    expect(bend[26]).toEqual(measured[26]);
    expect(bend[23].pitch).not.toBeCloseTo(measured[23].pitch, 3); // it does blend
    // The phantom is a missing frame: the same as no body there.
    expect(bend[30]).toEqual(bend[29]);
    expect(bend.slice(35)).toEqual(measured.slice(35));
    const without = [...bodies];
    without[30] = null;
    expect(torsoBend(without, 5, 30, good)).toEqual(bend);
    expect(torsoBend(bodies, 5, 30, goodStandIns(bodies))![30]).not.toEqual(bend[30]);
  });

  it('leaves a series with no gap exactly as it was measured, and as it was before WP2', () => {
    const bodies = Array.from({ length: FRAMES }, (_, f) => standIn(f));
    const bend = torsoBend(bodies, 10, 30)!;
    expect(bend).toEqual(measuredBend(bodies, 10, 30));
    expect(sha(bend.flatMap((b) => [b.roll, b.pitch]))).toBe('72cedd8fa2b78481c7a85618c743d35c0935f362b8c9ea4a632fa5755f5d0d48');
  });

  it('is deterministic', () => {
    const run = () => torsoBend(gapped(), 5, 30, goodStandIns(gapped(), GATE))!.flatMap((b) => [b.roll, b.pitch]);
    expect(sha(run())).toBe(sha(run()));
  });
});

// ---- animate()'s body callback ----------------------------------------------------------

function effect2d(): Effect {
  const line = (n: number, a: number, len: number, bendBy: number): Vec2[] => {
    const pts: Vec2[] = [[0.05, -0.3]];
    for (let i = 1; i < n; i++) {
      const ang = a + (bendBy * i) / (n - 1);
      const q = pts[i - 1];
      pts.push([q[0] + (len / (n - 1)) * Math.cos(ang), q[1] + (len / (n - 1)) * Math.sin(ang)]);
    }
    return pts;
  };
  const stroke = (id: number, kind: 'strand' | 'rigid', stiffness: number, pts: Vec2[], bodyAngle: number, layer: 'behind' | 'front') => ({
    id, color: 0, brush: 'electric', kind, anchor: { type: 'concept', prompt: 'back' }, bodyAngle, stiffness, wobble: 1,
    views: { front: { points: pts, pressure: pts.map((_, i) => 1 - 0.5 * (i / (pts.length - 1))), root: pts[0], layer } },
  });
  return {
    version: 1,
    brush: { size: 28, thinning: 0.6, smoothing: 0.5, streamline: 0.45 },
    palette: ['#e8203a', '#f4f1ea', '#16141a'],
    timing: { drawingsPerSecond: 12 },
    strokes: [stroke(1, 'strand', 0.1, line(32, -2.2, 0.9, 0.9), 180, 'behind'), stroke(2, 'strand', 0.5, line(32, -0.9, 0.8, -0.7), 160, 'behind'), stroke(3, 'rigid', 1, line(24, 1.9, 0.5, 0.2), 0, 'front')],
    overrides: {},
  } as unknown as Effect;
}
const anchor2d = (_id: number, f: number) => {
  const t = f / 30;
  return { x: 540 + 90 * Math.sin(2 * Math.PI * 0.45 * t) + 30 * t, y: 900 + 25 * Math.sin(2 * Math.PI * 0.8 * t), angle: 0.12 * Math.sin(2 * Math.PI * 0.4 * t), unit: 300 * (1 + 0.08 * Math.sin(2 * Math.PI * 0.35 * t)) };
};
const body2d = (frame: number): BodyAngle => {
  const t = Math.min(1, Math.max(0, (frame - 25) / 30));
  return { theta: 2 * Math.PI * t * t * (3 - 2 * t), pitch: 0.5 * Math.max(0, Math.sin((2 * Math.PI * frame) / 80)) };
};
const run2d = (body?: (frame: number) => BodyAngle | null) => animate({ effect: effect2d(), frames: FRAMES, anchor: anchor2d, width: 1080, boil: { maxPx: 1.5, cycle: 3 }, ...(body ? { body } : {}) });
function hash2d(frames: AnimatedFrame[]): string {
  const v: number[] = [];
  for (const fr of frames) {
    v.push(fr.f, fr.k);
    for (const list of [fr.held, fr.placed]) {
      for (const h of list) {
        v.push(h.id, h.layer === 'front' ? 1 : 0);
        for (const q of h.points) v.push(q[0], q[1]);
        for (const q of h.pressure) v.push(q);
      }
    }
    for (const s of fr.sim) {
      v.push(s.id);
      for (const q of s.points) v.push(q[0], q[1]);
    }
  }
  return sha(v);
}

describe('animate()`s body callback', () => {
  // No pose on f40–50, while he turns.
  const gappy = (frame: number) => (frame > 39 && frame < 51 ? null : body2d(frame));

  it('holds the last angle through a null gap and blends back over 4 frames', () => {
    const held = heldBody(gappy, FRAMES);
    const good = Array.from({ length: FRAMES }, (_, f) => gappy(f) !== null);
    const theta = holdGaps(Array.from({ length: FRAMES }, (_, f) => body2d(f).theta), good);
    for (let f = 0; f < FRAMES; f++) expect(held(f)!.theta, `f${f}`).toBeCloseTo(theta[f], 12);
    for (const x of [39.25, 40, 44.5, 50]) expect(held(x)).toEqual(body2d(39));
    expect(held(51)!.theta).toBeCloseTo(body2d(39).theta + (body2d(51).theta - body2d(39).theta) * ease(1 / 4), 12);
    for (const x of [10.5, 38.75, 54, 54.25, 70.5]) expect(held(x)).toEqual(body2d(x)); // its own pose either side
    expect(Object.values(held(45)!).every(Number.isFinite)).toBe(true);
    // Never null: the callback itself. Always null: upright, facing the camera.
    expect(heldBody(body2d, FRAMES)).toBe(body2d);
    expect([0, 12.5, 89].map(heldBody(() => null, FRAMES))).toEqual([null, null, null]);
  });

  it('drives the physics with the held angle', () => {
    const gapped2d = run2d(gappy);
    const frozen = run2d((frame) => body2d(Math.min(frame, 39)));
    expect(gapped2d.slice(0, 51)).toEqual(frozen.slice(0, 51));
    expect(gapped2d.every((fr) => fr.sim.every((s) => s.points.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))))).toBe(true);
  });

  it('matches the output recorded before WP2, with and without a body', () => {
    expect(hash2d(run2d())).toBe('17dcf520649bbfa6abe2cfcd883ad7c8de78d846032a01c100bbdc309738e4d3');
    expect(hash2d(run2d(body2d))).toBe('504e81f7c4032f9c6bc9c0515379bbaa43052522c9e70be1fdfbe63a0a3606ee');
  });
});

// ---- The hero -----------------------------------------------------------------------------

const CORE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 23, 24]; // the stand-in's points, from MediaPipe's 33
const HAND: Vec2[] = [[0, 0], [50, 0], [54, 90], [60, 180], [68, 270], [74, 360], [999, 360]];
// The stand-in test limbs, drawn on f22 (impact/test-drawings.json): root, then tip.
const LIMBS: [Vec2, Vec2][] = [
  [[778, 300], [414.6, 159.1]],
  [[838, 300], [1212.2, 170]],
  [[790, 345], [520.4, 615.2]],
  [[828, 345], [1101.7, 623.2]],
];

describe.skipIf(!existsSync(HERO_POSE) || !existsSync(HERO_MASKS))('the hero', () => {
  it('holds f88`s bend and roll on f89–101, is back on the measured values by f105, and keeps the roots on the anchor pose', async () => {
    const pose: (number[][] | null)[] = JSON.parse(readFileSync(HERO_POSE, 'utf8'));
    const bodies = pose.map((q) => q && { x: Float32Array.from(CORE.map((i) => q[i][0])), y: Float32Array.from(CORE.map((i) => q[i][1])), confidence: Float32Array.from(CORE.map((i) => q[i][2])) });
    const person = await masksFromCache(JSON.parse(readFileSync(HERO_MASKS, 'utf8')), 254);
    const masks = person.map((m) => (m ? toFrameMask(m, 1920, 1080, 4) : null));
    const good = goodStandIns(bodies, { mask: (f) => masks[f], width: 1920, height: 1080 });
    for (let f = 89; f <= 101; f++) expect(good[f], `f${f}`).toBe(false);
    for (const f of [86, 87, 88, 102, 103, 104, 105]) expect(good[f], `f${f}`).toBe(true);
    for (let f = 188; f <= 203; f++) expect(good[f], `phantom f${f}`).toBe(false);

    const bend = torsoBend(bodies, 22, 30, good)!;
    const measured = measuredBend(bodies, 22, 30, good)!;
    for (let f = 89; f <= 101; f++) {
      expect(Math.abs(deg(bend[f].roll - bend[88].roll)), `roll f${f}`).toBeLessThan(0.1);
      expect(Math.abs(deg(bend[f].pitch - bend[88].pitch)), `pitch f${f}`).toBeLessThan(0.1);
    }
    expect(Math.abs(deg(bend[105].roll - measured[105].roll))).toBeLessThan(0.1);
    expect(Math.abs(deg(bend[105].pitch - measured[105].pitch))).toBeLessThan(0.1);
    expect(Math.abs(deg(bend[102].pitch - measured[102].pitch))).toBeGreaterThan(0.1); // blending

    // The lift on the anchor pose (the mask's, on every frame) with that bend.
    const unit0 = torsoHeights(masks, 1920, 1080)[22]!;
    const hip: Vec2 = [(pose[22]![23][0] + pose[22]![24][0]) / 2, (pose[22]![23][1] + pose[22]![24][1]) / 2];
    const poses = trackPoses(person, { frame: 22, xy: hip }, 30)!.slice(0, 120);
    const body = liftBodies(poses, unit0, 22, HAND, bend);
    const lifted = LIMBS.map(([root, tip], i) => {
      const n = 28;
      const bow = (s: number) => 0.08 * Math.sin(Math.PI * s);
      const px = Array.from({ length: n }, (_, j): Vec2 => {
        const s = j / (n - 1);
        const [dx, dy] = [tip[0] - root[0], tip[1] - root[1]];
        return [root[0] + dx * s - dy * bow(s), root[1] + dy * s + dx * bow(s)];
      });
      return liftStroke(i + 1, px, px.map(() => 1), body[22], 'strand', 0.1);
    });
    const frames = animate3d({ strokes: lifted, bodies: body, frames: 120, dps: 12, boil: { maxPx: 0, cycle: 3 }, width: 1920, emerge: new Map(lifted.map((s) => [s.id, 22])) });
    let worstSim = 0;
    let worstPlaced = 0;
    for (let f = 86; f <= 104; f++) {
      const capture = frames[f].capture !== frames[f - 1].capture;
      lifted.forEach((s, i) => {
        const anchorRoot = project(body[f], toCamera(body[f], s.points[0])).xy;
        const sim = project(body[f], frames[f].sim[i].points[0]).xy;
        worstSim = Math.max(worstSim, Math.hypot(sim[0] - anchorRoot[0], sim[1] - anchorRoot[1]));
        if (capture || (f >= 89 && f <= 101)) {
          const placed = frames[f].placed[i].points[0];
          worstPlaced = Math.max(worstPlaced, Math.hypot(placed[0] - anchorRoot[0], placed[1] - anchorRoot[1]));
        }
      });
    }
    expect(worstSim).toBeLessThan(1);
    expect(worstPlaced).toBeLessThan(1);
    expect(frames.every((fr) => fr.placed.every((p) => p.points.every((q) => Number.isFinite(q[0]) && Number.isFinite(q[1]))))).toBe(true);
  }, 120_000);
});
