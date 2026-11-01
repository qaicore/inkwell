// WP2: the turn keys (impact design §1, "Turn"; src/lift/turn.ts and
// body.ts's turnAt). Synthetic stand-ins, except the hero block at the end:
// it reads the cached stand-in pose (samples/hero/pose.json, gitignored, or
// the file INKWELL_HERO_POSE names) and skips when it's missing.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { turnAt, type Body3D } from '../../src/lift/body.ts';
import { animate3d, liftStroke } from '../../src/lift/lift.ts';
import { checkedTurn, TURN_STEP, turnError, turnFromPose, turnKeys, turnKeysFromTap } from '../../src/lift/turn.ts';
import type { PointSet } from '../../src/track/tracking.ts';
import type { Vec2 } from '../../src/types/effect.ts';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const HERO_POSE = process.env.INKWELL_HERO_POSE ?? resolve(REPO, 'samples/hero/pose.json');
const HAND: Vec2[] = [[0, 0], [50, 0], [54, 90], [60, 180], [68, 270], [74, 360], [999, 360]]; // Qai's hand keys for the hero
const CORE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 23, 24]; // the stand-in's points, from MediaPipe's 33

// A stand-in body turned θ degrees (body.ts's sense: +90 shows his right
// side), upright on screen. `spine` shortens the spine on screen (bent
// forward); `confused` is a tracker that always takes him to face the camera.
function standIn(theta: number, opts: { spine?: number; confused?: boolean; x?: number } = {}): PointSet {
  const unit = 200;
  const [cx, cy] = [opts.x ?? 900, 700];
  const t = (theta * Math.PI) / 180;
  const across = (x: number, z: number) => {
    const sx = Math.cos(t) * x + Math.sin(t) * z;
    return opts.confused ? Math.abs(Math.cos(t)) * x + Math.sin(t) * z : sx;
  };
  const spine = opts.spine ?? 1;
  const put = (x: number, y: number, z: number): Vec2 => [cx + unit * across(x, z), cy + unit * y * spine];
  const face: Vec2[] = [put(0, -1.35, 0.3), ...Array.from({ length: 10 }, (_, i) => put(0.04 * (i - 5), -1.4, 0.2))];
  const points = [...face, put(0.33, -1, 0), put(-0.33, -1, 0), put(0.2, 0, 0), put(-0.2, 0, 0)];
  return { x: Float32Array.from(points.map((p) => p[0])), y: Float32Array.from(points.map((p) => p[1])), confidence: new Float32Array(15).fill(0.99) };
}
const spinOf = (keys: Vec2[], frames = 100, opts: Parameters<typeof standIn>[1] = {}) => Array.from({ length: frames }, (_, f) => standIn(turnAt(keys, f), opts));

describe('turn keys from the tap', () => {
  it('builds the five keys a quarter turn apart, every 6 frames', () => {
    expect(TURN_STEP).toBe(6);
    expect(turnKeysFromTap({ at: 2.0, dir: 1 }, 30)).toEqual([[48, 0], [54, 90], [60, 180], [66, 270], [72, 360]]);
    expect(turnKeysFromTap({ at: 2.0, dir: -1 }, 30)).toEqual([[48, 0], [54, -90], [60, -180], [66, -270], [72, -360]]);
  });

  it('gives no keys without a turn, and his nudged keys when he has any', () => {
    expect(turnKeysFromTap(undefined)).toEqual([]);
    expect(turnKeysFromTap(null)).toEqual([]);
    const nudged = { at: 2.0, dir: 1 as const, keys: [[1.6, 0], [1.8, 90], [2.0, 180], [2.3, 270], [2.5, 360]] as [number, number][] };
    expect(turnKeysFromTap(nudged, 30)).toEqual([[48, 0], [54, 90], [60, 180], [69, 270], [75, 360]]);
    expect(turnKeysFromTap({ ...nudged, keys: [] }, 30)).toEqual(turnKeysFromTap({ at: 2.0, dir: 1 }, 30));
    expect(turnKeys(nudged, null).from).toBe('keys');
    expect(turnKeys({ at: 2.0, dir: 1 }, spinOf([[0, 0]])).from).toBe('tap');
  });

  it('turnAt is 0 with no keys, and follows the tap`s keys', () => {
    for (const f of [-5, 0, 60, 1000]) expect(turnAt([], f)).toBe(0);
    const keys = turnKeysFromTap({ at: 2.0, dir: 1 });
    expect([0, 48, 51, 57, 60, 69, 72, 200].map((f) => turnAt(keys, f))).toEqual([0, 0, 45, 135, 180, 315, 360, 360]);
  });
});

describe('no turn', () => {
  // A body that moves about with θ from `keys`, and three limbs drawn on his back on f10.
  function lift(keys: Vec2[]) {
    const bodies: Body3D[] = Array.from({ length: 100 }, (_, f) => ({
      x: 960 + 80 * Math.sin(f / 9),
      y: 620 + 20 * Math.sin(f / 7),
      unit: 200 * (1 + 0.05 * Math.sin(f / 11)),
      yaw: (turnAt(keys, f) * Math.PI) / 180,
      pitch: 0,
      roll: 0.1 * Math.sin(f / 13),
    }));
    const b = bodies[10];
    const limb = (id: number, a: number): Vec2[] => Array.from({ length: 24 }, (_, i): Vec2 => [b.x + 0.04 * b.unit * (id - 2) + 1.1 * b.unit * (i / 23) * Math.cos(a), b.y - 0.55 * b.unit + 1.1 * b.unit * (i / 23) * Math.sin(a)]);
    const pressure = Array.from({ length: 24 }, () => 1);
    const strokes = [-2.5, -0.6, 2.6].map((a, i) => liftStroke(i + 1, limb(i + 1, a), pressure, b, 'strand', 0.1));
    return animate3d({ strokes, bodies, frames: 100, dps: 12, boil: { maxPx: 1.5, cycle: 3 }, width: 1920 });
  }

  it('without a tap or a readable pose, θ is 0 on every frame and back-rooted limbs stay behind him through the spin', () => {
    // He spins on f40–64, but the tracker never shows his back.
    const confused = spinOf([[0, 0], [40, 0], [46, 90], [52, 180], [58, 270], [64, 360]], 100, { confused: true });
    const { keys, from } = turnKeys(undefined, confused);
    expect(from).toBe('none');
    expect(turnKeys(undefined, null)).toEqual({ keys: [], from: 'none' });
    for (let f = 0; f < 100; f++) expect(turnAt(keys, f)).toBe(0);
    const frames = lift(keys);
    for (const fr of frames) for (const p of fr.placed) expect(p.front.every((x) => !x), `f${fr.f} limb ${p.id}`).toBe(true);
  });

  it('with the tap, the same limbs come round in front of him', () => {
    const frames = lift(turnKeysFromTap({ at: 2.0, dir: 1 }));
    expect(frames.slice(56, 66).some((fr) => fr.placed.some((p) => p.front.some((x) => x)))).toBe(true);
  });
});

describe('the turn read from the pose', () => {
  const SPIN: Vec2[] = [[0, 0], [40, 0], [46, 90], [52, 180], [58, 270], [64, 360]];

  it('reads a spin from the shoulder and hip order, the side-on crossings and the nose', () => {
    const keys = turnFromPose(spinOf(SPIN));
    expect(keys).toHaveLength(5);
    expect(turnError(keys, SPIN, 0, 99)).toBeLessThan(10);
    expect(keys.map((k) => k[1])).toEqual([0, 90, 180, 270, 360]);
    expect(turnKeys(undefined, spinOf(SPIN)).from).toBe('pose');
  });

  it('reads the other direction, a slower spin and two spins', () => {
    const back: Vec2[] = SPIN.map(([f, d]) => [f, -d]);
    expect(turnError(turnFromPose(spinOf(back)), back, 0, 99)).toBeLessThan(10);
    const slow: Vec2[] = [[0, 0], [30, 0], [39, 90], [48, 180], [57, 270], [66, 360]];
    expect(turnError(turnFromPose(spinOf(slow)), slow, 0, 99)).toBeLessThan(10);
    const twice: Vec2[] = [...SPIN, [100, 360], [106, 450], [112, 540], [118, 630], [124, 720]];
    const keys = turnFromPose(spinOf(twice, 150));
    expect(keys).toHaveLength(10);
    expect(turnError(keys, twice, 0, 149)).toBeLessThan(10);
  });

  it('ignores frames bent forward, where the spine is too short to read across', () => {
    // Bent over on f75–80 with the order swapped, as the hero's stand-in shows at the slam.
    const bodies = spinOf(SPIN).map((b, f) => (f >= 75 && f <= 80 ? standIn(180, { spine: 0.2 }) : b));
    expect(turnError(turnFromPose(bodies), SPIN, 0, 99)).toBeLessThan(10);
  });

  it('reads no turn from a turn back, a turn that never comes back round, or a confused tracker', () => {
    expect(turnFromPose(spinOf([[0, 0], [40, 0], [46, 90], [52, 180], [58, 90], [64, 0]]))).toEqual([]);
    expect(turnFromPose(spinOf([[0, 0], [40, 0], [46, 90], [52, 180]]))).toEqual([]);
    expect(turnFromPose(spinOf(SPIN, 100, { confused: true }))).toEqual([]);
    expect(turnFromPose(spinOf([[0, 0]]))).toEqual([]);
  });

  it('a tap overrides the pose', () => {
    expect(turnKeys({ at: 3.0, dir: -1 }, spinOf(SPIN))).toEqual({ keys: turnKeysFromTap({ at: 3.0, dir: -1 }), from: 'tap' });
  });

  it('is used while it stays within 45° of known keys, and the known keys are used otherwise', () => {
    const read = turnFromPose(spinOf(SPIN));
    const near = checkedTurn(read, SPIN, 40, 64);
    expect(near.used).toBe('read');
    expect(near.keys).toEqual(read);
    expect(near.error).toBe(turnError(read, SPIN, 40, 64));
    // Known keys 8 frames later: 120° off at the worst.
    const late: Vec2[] = SPIN.map(([f, d]) => [f === 0 ? 0 : f + 8, d]);
    const far = checkedTurn(read, late, 40, 72);
    expect(far.used).toBe('known');
    expect(far.keys).toEqual(late);
    expect(far.error).toBeGreaterThan(45);
    // Nothing read: the whole turn is the error. The limit is inclusive.
    expect(checkedTurn([], SPIN, 40, 64)).toEqual({ keys: SPIN, used: 'known', error: 360 });
    expect(checkedTurn([], [[0, 0], [10, 45]], 0, 20).used).toBe('read');
  });

  it('is deterministic', () => {
    expect(turnFromPose(spinOf(SPIN))).toEqual(turnFromPose(spinOf(SPIN)));
  });
});

describe.skipIf(!existsSync(HERO_POSE))('the hero', () => {
  it('reads his spin within 45° of the hand keys over f50–74', () => {
    const pose: (number[][] | null)[] = JSON.parse(readFileSync(HERO_POSE, 'utf8'));
    const bodies = pose.map((q) => q && { x: Float32Array.from(CORE.map((i) => q[i][0])), y: Float32Array.from(CORE.map((i) => q[i][1])), confidence: Float32Array.from(CORE.map((i) => q[i][2])) });
    const { keys, from } = turnKeys(undefined, bodies);
    expect(from).toBe('pose');
    const error = turnError(keys, HAND, 50, 74);
    console.log(`hero turn from the pose: keys ${JSON.stringify(keys.map(([f, d]) => [Math.round(f * 100) / 100, d]))}, error ${error.toFixed(1)}° over f50–74`);
    expect(error).toBeLessThan(45);
    expect(turnAt(keys, 120)).toBe(360);
    // So the hero render uses it (decision 4 of the impact build).
    expect(checkedTurn(keys, HAND, 50, 74)).toEqual({ keys, used: 'read', error });
    // The tap on f60 is within 30° (design §1).
    expect(turnError(turnKeysFromTap({ at: 2.0, dir: 1 }), HAND, 50, 74)).toBeLessThanOrEqual(30);
  });
});
