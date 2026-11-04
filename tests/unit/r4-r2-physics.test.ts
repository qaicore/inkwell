// Round 4, R2: the limbs' physics fast and off the page (decision 20). The
// scene keeps its physics by exactly its inputs (scene.ts physicsKeyOf), so a
// scene built again for Reduce flashing, another aftermath or other colours
// takes it as it is. The page asks lift/sim-worker.ts for it and, until it
// comes, shows the limbs as drawn ('wait'); it crosses threads packed
// (packPhysics), exactly. The stand-in keeps all 33 of its points, which give
// the app's dummy its arms and legs. Offline: the synthetic slam
// (helpers/impact-scene-clip.ts) and a stand-in reply, both built here. Its
// times are in impact-scene-budget.test.ts, which runs serially.
import { describe, expect, it } from 'vitest';
import { impactClip, impactScene, type ClipData } from '../../src/app/engine.ts';
import type { SceneData } from '../../src/app/render-worker.ts';
import { syntheticCrouch } from '../../src/impact/frames/figure.ts';
import { createImpactScene, dummyOf, forgetPhysics, keepPhysics, keptPhysics, packPhysics, unpackPhysics, type ImpactClip, type ScenePhysics } from '../../src/impact/scene.ts';
import { serveSim, transferOf, type SimScope } from '../../src/lift/sim-worker.ts';
import { nodeScratch } from '../../src/render/headless.ts';
import { toPixels, anchorTransform } from '../../src/track/torso.ts';
import { readDevServerReply } from '../../src/track/standin.ts';
import type { Effect, Moment, Vec2 } from '../../src/types/effect.ts';
import { DRAWN, FRAMES, LIMB_IDS, UNIT, sceneClip } from './helpers/impact-scene-clip.ts';

const BORN = 20; // the first frame of the drawing the limbs emerge on (f22's, at 12 a second)
const CORE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 23, 24]; // standin.ts's: the points that move with the body

const opts = { tier: 'full' as const, make: nodeScratch };
const withSlam = (effect: Effect, change: Partial<Moment>): Effect => ({ ...effect, moments: effect.moments?.map((m) => (m.kind === 'slam' ? { ...m, ...change } : m)) });

// The synthetic slam and its physics, worked out once for the file.
const shared = sceneClip();
let worked: ScenePhysics | null = null;
const physicsOf = () => (worked ??= createImpactScene(shared.effect, shared.clip, opts).physics());

describe('the physics kept by its inputs', () => {
  it('is taken as it is by a scene built again for Reduce flashing, another aftermath or other colours', () => {
    forgetPhysics();
    const first = createImpactScene(shared.effect, shared.clip, opts);
    const p = first.physics();
    worked = p;
    expect(p.drawn).toBeUndefined();
    expect(p.frames).toHaveLength(FRAMES);
    expect(p.frames[100].sim.length).toBeGreaterThan(0); // worked out: the ropes are there
    const again = [
      withSlam(shared.effect, { frames: { count: 7, flash: 'safe' } }),
      withSlam(shared.effect, { aftermath: { seconds: 3, scale: 1, scarSeconds: 3 } }),
      { ...shared.effect, palette: ['#3a20e8', '#f4f1ea', '#16141a'] as Effect['palette'] },
    ];
    for (const effect of again) {
      const scene = createImpactScene(effect, shared.clip, opts);
      expect(scene.physicsKey).toBe(first.physicsKey);
      expect(scene.sceneId).not.toBe(first.sceneId);
      expect(scene.physics()).toBe(p); // the very same: not worked out again
    }
    expect(first.degraded(3).physics()).toBe(p);
  });

  it('is worked out again for anything it reads: a limb, the turn, the slam, the boil, the size or another clip', () => {
    const key = (effect: Effect, clip: ImpactClip = shared.clip, more: object = {}) => createImpactScene(effect, clip, { ...opts, ...more }).physicsKey;
    const base = key(shared.effect);
    const [limb, ...rest] = shared.effect.strokes;
    const moved = { ...limb, views: { front: { ...limb.views.front, points: limb.views.front.points.map(([x, y]): Vec2 => [x + 0.01, y]) } } };
    const { turn: _, ...untapped } = shared.effect;
    const keys = [
      key({ ...shared.effect, strokes: [moved, ...rest] }),
      key(untapped),
      key(withSlam(shared.effect, { seed: 85 })),
      key(withSlam(shared.effect, { at: 85 / 30 })),
      key(shared.effect, shared.clip, { boil: { maxPx: 3, cycle: 3 } }),
      key(shared.effect, shared.clip, { size: 720 }),
      key(shared.effect, sceneClip().clip),
    ];
    expect(new Set([base, ...keys]).size).toBe(keys.length + 1);
    // A clip's source names it on every thread: two copies of it, both named so, read alike.
    expect(key(shared.effect, { ...sceneClip().clip, source: 'clip 1' })).toBe(key(shared.effect, { ...sceneClip().clip, source: 'clip 1' }));
  });

  it('keeps the last three worked out, and never the limbs as drawn', () => {
    forgetPhysics();
    const p = physicsOf();
    const fake = (k: string): ScenePhysics => ({ ...p, key: k });
    keepPhysics(p);
    for (const k of ['a', 'b']) keepPhysics(fake(k));
    expect(keptPhysics(p.key)).toBe(p); // used: the newest now
    keepPhysics(fake('c'));
    expect(keptPhysics('a')).toBeNull();
    expect(keptPhysics(p.key)).toBe(p);
    keepPhysics({ ...p, key: 'drawn', drawn: true });
    expect(keptPhysics('drawn')).toBeNull();
    forgetPhysics();
    expect(keptPhysics(p.key)).toBeNull();
  });
});

describe('the physics across threads', () => {
  it('packs into a few flat arrays that give the same physics back exactly, cloned or not', () => {
    const p = physicsOf();
    const q = packPhysics(p);
    expect(unpackPhysics(q)).toEqual(p);
    expect(unpackPhysics(structuredClone(q))).toEqual(p);
    const moved = transferOf(q);
    expect(moved).toHaveLength(6);
    for (const b of moved) expect(b).toBeInstanceOf(ArrayBuffer);
    expect(new Set(moved).size).toBe(6);
  });

  it('is taken as handed in, packed or not, and refused when it was worked out for other inputs', () => {
    const p = physicsOf();
    const made = createImpactScene(shared.effect, shared.clip, opts);
    forgetPhysics();
    const given = createImpactScene(shared.effect, shared.clip, { ...opts, physics: p });
    expect(given.physics()).toBe(p);
    expect(given.waiting).toBe(false);
    const packed = createImpactScene(shared.effect, shared.clip, { ...opts, physics: packPhysics(p) });
    expect(packed.physics()).toEqual(p);
    expect(packed.sceneId).toBe(made.sceneId);
    expect(keptPhysics(p.key)).toBeNull(); // handed in is that scene's own: the render-ahead's worker keeps none
    expect(() => createImpactScene(withSlam(shared.effect, { seed: 85 }), shared.clip, { ...opts, physics: p })).toThrow(/other inputs/);
  });
});

describe('the limbs as drawn, while the physics is worked out', () => {
  it('shows each limb from its emergence drawing, carried by his body as he was worked out, as drawn on its frame, with no rope', () => {
    const p = physicsOf();
    forgetPhysics();
    const made = createImpactScene(shared.effect, shared.clip, { ...opts, physics: p });
    const wait = createImpactScene(shared.effect, shared.clip, { ...opts, physics: 'wait' });
    expect(wait.waiting).toBe(true);
    expect(wait.physicsKey).toBe(made.physicsKey);
    expect(wait.sceneId).not.toBe(made.sceneId); // its drawings aren't the physics'
    const drawn = wait.physics();
    expect(drawn.drawn).toBe(true);
    expect(keptPhysics(drawn.key)).toBeNull();
    expect(wait.bodies()).toEqual(p.bodies);
    expect(wait.turn()).toEqual(p.turn);
    const frames = wait.frames3d();
    expect(frames).toHaveLength(FRAMES);
    expect(frames.map((fr) => fr.drawing)).toEqual(p.frames.map((fr) => fr.drawing));
    expect(frames.map((fr) => fr.k)).toEqual(p.frames.map((fr) => fr.k));
    for (const fr of frames) {
      expect(fr.sim).toEqual([]);
      expect(fr.placed.map((pl) => pl.id)).toEqual(fr.f < BORN ? [] : LIMB_IDS);
    }
    // On the frame they were drawn on, the limbs are where they were drawn.
    const at = anchorTransform(shared.clip.poses[DRAWN], UNIT);
    frames[DRAWN].placed.forEach((pl, i) => {
      const as = shared.effect.strokes[i].views.front.points.map((q) => toPixels(at, q));
      pl.points.forEach((xy, k) => expect(Math.hypot(xy[0] - as[k][0], xy[1] - as[k][1])).toBeLessThan(1e-6));
    });
    // Captured anew with each drawing (on 2s and 3s at 12 a second), never in between.
    frames.forEach((fr, f) => {
      if (f > 0) expect(fr.capture - frames[f - 1].capture).toBe(fr.k === frames[f - 1].k ? 0 : 1);
    });
    expect(wait.tubesAt(DRAWN)).toHaveLength(LIMB_IDS.length);
  });

  it('is the physics itself once it is kept: the same scene id as a scene built with it', () => {
    const p = physicsOf();
    const made = createImpactScene(shared.effect, shared.clip, { ...opts, physics: p });
    keepPhysics(p);
    const wait = createImpactScene(shared.effect, shared.clip, { ...opts, physics: 'wait' });
    expect(wait.waiting).toBe(false);
    expect(wait.physics()).toBe(p);
    expect(wait.sceneId).toBe(made.sceneId);
  });
});

// ---- The stand-in's skeleton -----------------------------------------------------------------

// MediaPipe's 33 points on the crouching figure (figure.ts's syntheticCrouch),
// × S along (side, up) from P: head, shoulders, elbows, wrists, hands, hips,
// knees, ankles and feet, in its order.
const POINTS: readonly (readonly [number, number])[] = [
  [0.05, 0.37], [0.06, 0.385], [0.065, 0.387], [0.07, 0.388], [0.055, 0.385], [0.05, 0.387], [0.045, 0.388],
  [0.09, 0.38], [0.05, 0.38], [0.06, 0.35], [0.05, 0.35],
  [0.135, 0.27], [0.035, 0.275], [0.205, 0.18], [-0.01, 0.15], [0.175, 0.095], [0.0, 0.045],
  [0.17, 0.08], [0.005, 0.03], [0.18, 0.08], [-0.005, 0.03], [0.175, 0.09], [0.0, 0.04],
  [0.165, 0.13], [0.15, 0.12], [0.27, 0.19], [0.115, 0.04], [0.255, 0.035], [0.235, 0.025],
  [0.25, 0.025], [0.225, 0.02], [0.315, 0.018], [0.26, 0.02],
];
type Landmarks = { x: number[]; y: number[]; c: number[] };

function landmarks(P: Vec2, d: Vec2, S: number, picked: readonly number[] | null = null): Landmarks {
  const up: Vec2 = [-d[0], -d[1]];
  const side: Vec2 = [d[1], -d[0]];
  const at = (k: number): Vec2 => [P[0] + S * (POINTS[k][0] * side[0] + POINTS[k][1] * up[0]), P[1] + S * (POINTS[k][0] * side[1] + POINTS[k][1] * up[1])];
  const ks = picked ?? POINTS.map((_, k) => k);
  return { x: ks.map((k) => at(k)[0]), y: ks.map((k) => at(k)[1]), c: ks.map(() => 0.9) };
}

// The dev server's reply (tools/standin.py): a 4-byte header length, the
// JSON header, then every frame's mask.
function devServerReply(bodies: (Landmarks | null)[], hasMask: boolean[], mask: Uint8ClampedArray): Uint8Array {
  const header = new TextEncoder().encode(JSON.stringify({ bodies, hasMask }));
  const out = new Uint8Array(4 + header.length + hasMask.length * mask.length);
  new DataView(out.buffer).setUint32(0, header.length, true);
  out.set(header, 4);
  hasMask.forEach((has, i) => {
    if (has) out.set(mask, 4 + header.length + i * mask.length);
  });
  return out;
}

describe('the stand-in’s skeleton', () => {
  const S = Math.min(shared.clip.width, shared.clip.height);

  it('keeps all 33 points of a dev-server reply as the skeleton and the 15 that move with the body as its bodies; a 15-point reply has no skeleton', () => {
    const all = landmarks(shared.P, shared.d, S);
    const reply = devServerReply([all, null, landmarks(shared.P, shared.d, S, CORE)], [true, false, true], new Uint8ClampedArray(12).fill(255));
    const s = readDevServerReply(reply, 4, 4, 3);
    expect(Array.from(s.skeleton[0]!.x)).toEqual(all.x.map(Math.fround));
    expect(Array.from(s.skeleton[0]!.confidence)).toEqual(all.c.map(Math.fround));
    expect(Array.from(s.bodies[0]!.y)).toEqual(CORE.map((k) => Math.fround(all.y[k])));
    expect(s.bodies[1]).toBeNull();
    expect(s.skeleton[1]).toBeNull();
    expect(Array.from(s.bodies[2]!.x)).toEqual(CORE.map((k) => Math.fround(all.x[k]))); // an older script's 15 points, as they are
    expect(s.skeleton[2]).toBeNull();
    expect([s.bodies[3], s.skeleton[3], s.masks[3]]).toEqual([null, null, null]); // padded to the clip
    expect(s.masks.map((m) => (m ? m.alpha[0] : null))).toEqual([255, null, 255, null]);
  });

  it('gives the scene’s dummy its arms and legs after a Track with the stand-in: ten capsules; head and neck from the 15 points alone; the egg alone with no pose', () => {
    // Track's result as the dev server sends it back: the 33 points on every
    // frame, and a mask (a tenth of the clip) on every 30th, which the scene
    // takes for the frames round it.
    const mask = syntheticCrouch(192, 108, [shared.P[0] / 10, shared.P[1] / 10], shared.d, S / 10).mask;
    const bodies = Array.from({ length: FRAMES }, () => landmarks(shared.P, shared.d, S));
    const hasMask = Array.from({ length: FRAMES }, (_, f) => f % 30 === 0);
    const standIn = readDevServerReply(devServerReply(bodies, hasMask, mask.alpha), FRAMES, mask.width, mask.height);
    const data: ClipData = { width: shared.clip.width, height: shared.clip.height, frames: FRAMES, masks: standIn.masks, faces: null, bodies: standIn.bodies, skeleton: standIn.skeleton, units: [...(shared.clip.units ?? [])], id: 'stand-in' };
    const parts = (d: ClipData) => {
      const clip = impactClip(d, shared.clip.poses);
      const scene = impactScene(shared.effect, clip, { ...opts, physics: 'wait' })!;
      return new Set(dummyOf(clip, scene.bodies()).map((dummy) => dummy.capsules.map((c) => c.part).sort().join(' ')));
    };
    expect(parts(data)).toEqual(new Set(['forearm forearm head neck shin shin thigh thigh upperArm upperArm']));
    expect(parts({ ...data, skeleton: null })).toEqual(new Set(['head neck']));
    expect(parts({ ...data, bodies: null, skeleton: null })).toEqual(new Set(['']));
  });
});

// ---- The worker ----------------------------------------------------------------------------------

// A worker scope for serveSim, in this thread: what it posts, and a way to send to it.
function fakeScope() {
  const posted: { message: Parameters<SimScope['postMessage']>[0]; transfer?: Transferable[] }[] = [];
  const listeners: ((e: MessageEvent) => void)[] = [];
  const scope: SimScope = {
    postMessage: (message, transfer) => void posted.push({ message, transfer }),
    addEventListener: (_, listener) => void listeners.push(listener as (e: MessageEvent) => void),
  };
  const send = (data: unknown) => listeners.forEach((l) => l({ data } as MessageEvent));
  return { scope, posted, send };
}

describe('the physics’ worker', () => {
  const person = shared.clip.personMask(0);
  const clipData: ClipData = { width: shared.clip.width, height: shared.clip.height, frames: FRAMES, masks: Array.from({ length: FRAMES }, () => person), faces: null, bodies: null, units: [...(shared.clip.units ?? [])], id: 'clip w' };
  const scene: SceneData = { effect: shared.effect, poses: [...shared.clip.poses], tier: 'full', size: 1080 };
  const keyOf = (data: SceneData) => impactScene(data.effect, impactClip(clipData, data.poses), { tier: data.tier, size: data.size, cuts: data.cuts, boil: data.boil, physics: 'wait' })!.physicsKey;

  it('works out the newest physics asked for, as the page’s scene keys it, and moves it back packed', () => {
    const { scope, posted, send } = fakeScope();
    const due: (() => void)[] = [];
    serveSim(scope, (work) => void due.push(work));
    send({ type: 'clip', clip: clipData });
    const older: SceneData = { ...scene, size: 720 };
    send({ type: 'run', key: keyOf(older), scene: older });
    send({ type: 'run', key: keyOf(scene), scene });
    expect(due).toHaveLength(1); // one run for both asks
    due.shift()!();
    expect(posted).toHaveLength(1);
    const [{ message, transfer }] = posted;
    if (message.type !== 'physics') throw new Error(`the run failed: ${message.message}`);
    expect(message.physics.key).toBe(keyOf(scene));
    expect(transfer).toEqual(transferOf(message.physics));
    transfer!.forEach((b, i) => expect(b).toBe(transferOf(message.physics)[i]));
    const p = unpackPhysics(message.physics);
    expect(p.frames).toHaveLength(FRAMES);
    expect(p.frames[100].sim.length).toBeGreaterThan(0);
    // The page builds its scene with it, and the render-ahead's worker with the packed copy.
    const page = impactScene(scene.effect, impactClip(clipData, scene.poses), { tier: 'full', size: 1080, physics: p })!;
    expect(page.waiting).toBe(false);
  });

  it('says which run failed and why, and drops an ask when a new clip comes', () => {
    const { scope, posted, send } = fakeScope();
    const due: (() => void)[] = [];
    serveSim(scope, (work) => void due.push(work));
    send({ type: 'clip', clip: clipData });
    send({ type: 'run', key: 'not its key', scene });
    due.shift()!();
    expect(posted).toEqual([{ message: { type: 'failed', key: 'not its key', message: expect.stringMatching(/other inputs/) }, transfer: undefined }]);
    send({ type: 'run', key: keyOf(scene), scene });
    send({ type: 'clip', clip: { ...clipData, id: 'clip x' } });
    due.shift()!();
    expect(posted).toHaveLength(1);
  });
});
