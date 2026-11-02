// Round 3, F8: the floor the app reads from him, with nothing asked of him
// (src/impact/floor-estimate.ts), and where the app puts it (engine.ts's
// withFloor; main.ts's slamFloor reads it once per P and contact). Synthetic
// cameras and a synthetic person first; then the hero: it decodes the cached
// SAM person masks (fixtures/probe/sam-person.json, about 12 s) and reads the
// cached stand-in pose (samples/hero/pose.json, gitignored, or the file
// INKWELL_HERO_POSE names), and skips when either is missing.
//
// The hand-measured floor (impact/test-drawings.json end.floor; HERO_FLOOR in
// scripts/impact-render.ts): camera f 922 px, principal point (960, 540),
// tilt 12.1°, roll 2.3°, the horizon y 304 → 342 → 380 across x 0 → 960 →
// 1920; at P a small floor circle's ratio 0.763 (0.741–0.791), its major axis
// 2.6°, up (0.04, −1), persp 0.68.
//
// The tolerances on the hero, and why:
//   - ratio ±0.06: the hand fit's own spread is ±0.025 (0.741–0.791), and
//     DEFAULT_FLOOR's 0.5 is 0.26 away, so inside it the estimate reads as
//     the hand-measured floor and never as the default. The focal length is
//     the room prior (DISTANCE): a 10 % wrong f moves the ratio about 0.07.
//   - majorDeg and up ±2°: the major axis turns about twice as far as the
//     camera roll does, and his hip line sways ±3° over the standing frames.
//   - persp ±0.06 of the hand-fit camera's at the same U: persp counts in
//     units of U. HERO_FLOOR's 0.68 is that camera at U 643; the scene's U on
//     the hero is 681–684, where it is 0.72 (and the rings end.floor measured
//     agree within 2 px).
//   - the horizon at P ±15 px, from his walk: 15 px moves the ratio 0.016.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { withFloor } from '../../src/app/engine.ts';
import { CAMERA_HEIGHT, DISTANCE, cameraFloor, estimateFloor, samMaskBox, type Camera, type FloorEstimate } from '../../src/impact/floor-estimate.ts';
import { DEFAULT_FLOOR, sigmaOf } from '../../src/impact/floor.ts';
import { masksFromCache, type SamMask } from '../../src/sam/cache.ts';
import type { PointSet } from '../../src/track/tracking.ts';
import type { EmergeMoment, FloorBlock, Moment, Vec2 } from '../../src/types/effect.ts';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const HERO_POSE = process.env.INKWELL_HERO_POSE ?? resolve(REPO, 'samples/hero/pose.json');
const HERO_MASKS = resolve(REPO, 'fixtures/probe/sam-person.json');
const CORE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 23, 24]; // the stand-in's points, from MediaPipe's 33
// The hero's impact, as the test drawings give it (helpers/impact-drawings.ts's HERO).
const HERO = { width: 1920, height: 1080, I: 84, P: [942, 1061] as Vec2 } as const;

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const angleBetween = (a: Vec2, b: Vec2) => deg(Math.acos(Math.min(1, (a[0] * b[0] + a[1] * b[1]) / (Math.hypot(a[0], a[1]) * Math.hypot(b[0], b[1])))));
const uOf = (personHeight: number) => sigmaOf(personHeight, 1080) * 1080; // scene.ts's U on a 1080-line clip

// The hand-fit hero camera, and the hand-measured floor at P.
const HERO_CAMERA: Camera = { f: 922, tilt: rad(12.1), roll: rad(2.3), cx: 960, cy: 540 };
const HAND = { ratio: 0.763, majorDeg: 2.6, up: [0.04, -1] as Vec2, persp: 0.68, horizonAtP: 304 + (76 * HERO.P[0]) / 1920 };
// end.floor.rings: a floor ring's half width and its far rise at P, px.
const RINGS: [number, number][] = [[60, 43], [149, 98], [298, 173], [447, 232], [596, 279], [894, 351]];

// ---- A synthetic person ------------------------------------------------------------------------

// A world point on the image of floor-estimate.ts's camera: x right, y up,
// z away from the camera, the floor y = 0 and the camera 1 up.
function view(cam: Camera, X: number, Y: number, Z: number): Vec2 {
  const st = Math.sin(cam.tilt);
  const ct = Math.cos(cam.tilt);
  const zc = -(Y - 1) * st + Z * ct;
  const u = X / zc;
  const w = (-(Y - 1) * ct - Z * st) / zc;
  const sr = Math.sin(cam.roll);
  const cr = Math.cos(cam.roll);
  return [cam.cx + cam.f * (cr * u - sr * w), cam.cy + cam.f * (sr * u + cr * w)];
}

// The horizon's row at x on that camera's image.
const horizonOf = (cam: Camera, x: number) => cam.cy - (cam.f * Math.tan(cam.tilt)) / Math.cos(cam.roll) + (x - cam.cx) * Math.tan(cam.roll);

// A person HP tall (the camera at CAMERA_HEIGHT of him) standing upright at
// (X, Z), facing the camera: the stand-in's 15 CORE points or MediaPipe's 33,
// and his mask as a one-cell raster over his box.
const HP = 1 / CAMERA_HEIGHT;
function person(cam: Camera, X: number, Z: number, n: 15 | 33): { body: PointSet; mask: SamMask } {
  const at = (x: number, y: number) => view(cam, X + x * HP, y * HP, Z);
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const confidence = new Float32Array(n).fill(0.99);
  const put = (i: number, p: Vec2) => {
    x[i] = p[0];
    y[i] = p[1];
  };
  for (let i = 0; i < 11; i++) put(i, at((i - 5) * 0.012, i === 0 ? 0.93 : 0.945)); // the nose, eyes, ears and mouth
  put(11, at(0.12, 0.82)); // his left shoulder, on the image right
  put(12, at(-0.12, 0.82));
  const hips: Vec2[] = [at(0.08, 0.52), at(-0.08, 0.52)];
  if (n === 15) {
    put(13, hips[0]);
    put(14, hips[1]);
  } else {
    put(13, at(0.15, 0.63)); // the elbows: where the CORE points keep his hips
    put(14, at(-0.15, 0.63));
    for (let i = 15; i <= 22; i++) put(i, at(i % 2 ? 0.16 : -0.16, 0.44)); // wrists and hands
    put(23, hips[0]);
    put(24, hips[1]);
    for (const [i, h] of [[25, 0.28], [27, 0.04], [29, 0.01], [31, 0]] as const) {
      put(i, at(0.08, h));
      put(i + 1, at(-0.08, h));
    }
  }
  const top = at(0, 1);
  const bottom = at(0, 0);
  const sides = [at(-0.15, 0.5), at(0.15, 0.5)];
  const mask: SamMask = { width: 1, height: 1, raster: Uint8Array.of(1), bounds: { left: Math.min(sides[0][0], sides[1][0]), top: top[1], right: Math.max(sides[0][0], sides[1][0]), bottom: bottom[1] } };
  return { body: { x, y, confidence }, mask };
}

// Standing 30 frames where the room prior puts him (DISTANCE of his height
// away), swaying a little; then, when he walks, 30 frames walking toward the
// camera from 4.5 to there (no mask needed on them).
const CAM: Camera = { f: 950, tilt: rad(10), roll: rad(1.5), cx: 960, cy: 540 };
const P: Vec2 = [1000, 900];
function scene(o: { walk: boolean; n: 15 | 33; standing?: number }): { masks: (SamMask | null)[]; bodies: (PointSet | null)[] } {
  const masks: (SamMask | null)[] = [];
  const bodies: (PointSet | null)[] = [];
  for (let k = 0; k < (o.standing ?? 30); k++) {
    const p = person(CAM, 0.3 + 0.01 * Math.sin(k), DISTANCE * HP, o.n);
    masks.push(p.mask);
    bodies.push(p.body);
  }
  if (o.walk) {
    for (let k = 0; k < 30; k++) {
      const t = k / 29;
      bodies.push(person(CAM, 0.9 - 0.6 * t, 4.5 - (4.5 - DISTANCE * HP) * t, o.n).body);
      masks.push(null);
    }
  }
  return { masks, bodies };
}
const estimateOn = (s: ReturnType<typeof scene>, at: Vec2 = P) => estimateFloor({ P: at, I: 10, width: 1920, height: 1080, masks: s.masks, bodies: s.bodies });

// ---- The camera's floor ------------------------------------------------------------------------

describe('cameraFloor', () => {
  it('gives the hand-measured floor at P from the hand-fit hero camera', () => {
    const U = uOf(609); // the scene's U on the hero (his f84 box)
    const fl = cameraFloor(HERO_CAMERA, HERO.P, U)!;
    expect(Math.abs(fl.ratio - HAND.ratio)).toBeLessThan(0.005);
    expect(Math.abs(fl.majorDeg - HAND.majorDeg)).toBeLessThan(0.2);
    expect(angleBetween(fl.up, HAND.up)).toBeLessThan(0.5);
    // Its far half fits the rings end.floor measured, from 5 cm to 1.5 m.
    for (const [R, rise] of RINGS) expect(Math.abs((fl.ratio * R) / (1 + (fl.persp * R) / U) - rise), `ring ${R} px`).toBeLessThan(2);
    // HERO_FLOOR's persp 0.68 is the same camera at U 643.
    expect(Math.abs(cameraFloor(HERO_CAMERA, HERO.P, 643)!.persp - HAND.persp)).toBeLessThan(0.01);
  });

  it('is exact for a level camera: ratio (y − cy) / f and persp U / f on the central column', () => {
    const cam: Camera = { f: 1000, tilt: 0, roll: 0, cx: 960, cy: 540 };
    for (const y of [640, 900, 1060]) {
      const fl = cameraFloor(cam, [960, y], 700)!;
      expect(fl.ratio).toBeCloseTo((y - 540) / 1000, 6);
      expect(fl.majorDeg).toBeCloseTo(0, 4);
      expect(fl.up[0]).toBeCloseTo(0, 6);
      expect(fl.up[1]).toBeCloseTo(-1, 6);
      expect(fl.persp).toBeCloseTo(0.7, 5);
    }
  });

  it('turns with the camera roll, clockwise on screen', () => {
    const cam: Camera = { f: 1000, tilt: 0, roll: rad(10), cx: 960, cy: 540 };
    const at: Vec2 = [960 - 360 * Math.sin(rad(10)), 540 + 360 * Math.cos(rad(10))]; // (960, 900) turned with it
    const fl = cameraFloor(cam, at, 700)!;
    expect(fl.ratio).toBeCloseTo(0.36, 6);
    expect(fl.majorDeg).toBeCloseTo(10, 4);
    expect(fl.up[0]).toBeCloseTo(Math.sin(rad(10)), 6);
    expect(fl.up[1]).toBeCloseTo(-Math.cos(rad(10)), 6);
    expect(fl.persp).toBeCloseTo(0.7, 5);
  });

  it('is null at or above the horizon', () => {
    const cam: Camera = { f: 1000, tilt: 0, roll: 0, cx: 960, cy: 540 };
    expect(cameraFloor(cam, [960, 400], 700)).toBeNull();
    expect(cameraFloor(cam, [960, 540], 700)).toBeNull();
  });
});

// ---- The estimate on a synthetic person ------------------------------------------------------

describe('estimateFloor on a synthetic person (f 950, tilt 10°, roll 1.5°)', () => {
  const truth = (s: ReturnType<typeof scene>) => cameraFloor(CAM, P, uOf(samMaskBox(s.masks[10])!.y1 - samMaskBox(s.masks[10])!.y0))!;
  const close = (e: FloorEstimate, t: FloorBlock) => {
    expect(e.from).toBe('person');
    expect(Math.abs(e.floor.ratio - t.ratio)).toBeLessThan(0.005);
    expect(Math.abs(e.floor.majorDeg - t.majorDeg)).toBeLessThan(0.2);
    expect(angleBetween(e.floor.up, t.up)).toBeLessThan(0.3);
    expect(Math.abs(e.floor.persp - t.persp)).toBeLessThan(0.02);
    expect(Math.abs(deg(e.camera!.tilt) - 10)).toBeLessThan(0.2);
    expect(Math.abs(deg(e.camera!.roll) - 1.5)).toBeLessThan(0.1);
    expect(Math.abs(e.camera!.f - CAM.f) / CAM.f).toBeLessThan(0.01); // he stands where the room prior says
    const hx = e.horizon!;
    expect(Math.abs(hx.y + (P[0] - hx.x) * Math.tan(e.camera!.roll) - horizonOf(CAM, P[0]))).toBeLessThan(3);
  };

  it('reads the horizon from his walk toward the camera', () => {
    const s = scene({ walk: true, n: 15 });
    const e = estimateOn(s);
    expect(e.horizon!.from).toBe('walk');
    expect(e.standing).toBe(30);
    close(e, truth(s));
  });

  it('reads it from the camera-height prior when he never walks, up his body in perspective', () => {
    const s = scene({ walk: false, n: 15 });
    const e = estimateOn(s);
    expect(e.horizon!.from).toBe('height');
    close(e, truth(s));
  });

  it('reads the stand-in`s 15 CORE points and MediaPipe`s 33 alike', () => {
    for (const walk of [true, false]) expect(estimateOn(scene({ walk, n: 33 }))).toEqual(estimateOn(scene({ walk, n: 15 })));
  });

  it('falls back to DEFAULT_FLOOR, saying why, when it can`t be read', () => {
    const s = scene({ walk: true, n: 15 });
    const cases: [FloorEstimate, RegExp][] = [
      [estimateFloor({ P, I: 10, width: 1920, height: 1080, masks: s.masks, bodies: null }), /no stand-in pose/],
      [estimateFloor({ P, I: 10, width: 1920, height: 1080, masks: s.masks, bodies: s.bodies.map(() => null) }), /no stand-in pose/],
      [estimateOn(scene({ walk: true, n: 15, standing: 5 })), /on 5 frames \(8 needed\)/],
      [estimateOn({ masks: s.masks.map(() => null), bodies: s.bodies }), /on 0 frames/], // no masks: his height is unread
      [estimateOn(s, [1000, 380]), /isn't clearly below the horizon/], // P 7 px under it
      [estimateOn(s, [1000, 200]), /isn't clearly below the horizon/],
    ];
    for (const [e, why] of cases) {
      expect(e.from).toBe('default');
      expect(e.floor).toEqual(DEFAULT_FLOOR);
      expect(e.why).toMatch(why);
      expect(e.camera).toBeNull();
    }
    expect(estimateOn(s, [1000, 1060]).from).toBe('person');
  });
});

// ---- Where the app puts it ------------------------------------------------------------------

describe('withFloor (engine.ts)', () => {
  const emerge: EmergeMoment = { kind: 'emerge', at: 0.7 };
  const slam: Moment = { kind: 'slam', at: 2.8, xy: [942, 1061], by: 'body' };
  const read = (from: 'person' | 'default'): FloorEstimate => ({
    floor: from === 'person' ? { ratio: 0.755, majorDeg: 2.1, up: [0.036, -0.999], persp: 0.72 } : { ...DEFAULT_FLOOR, up: [0, -1] },
    from,
    why: '',
    camera: null,
    horizon: null,
    standing: 0,
  });

  it('puts the floor read from him on a slam that has none', () => {
    const estimate = read('person');
    const out = withFloor([emerge, slam], estimate)!;
    expect(out[0]).toBe(emerge);
    expect((out[1] as Moment).floor).toEqual(estimate.floor);
    expect((out[1] as Moment).floor!.up).not.toBe(estimate.floor.up); // a copy: the effect owns it
    expect(slam.floor).toBeUndefined();
  });

  it('keeps a floor the slam has, and leaves the moments alone when the read fell back', () => {
    const own: Moment = { ...slam, floor: { ratio: 0.6, majorDeg: 0, up: [0, -1], persp: 0.1 } };
    expect(withFloor([emerge, own], read('person'))![1]).toBe(own);
    const moments = [emerge, slam];
    expect(withFloor(moments, read('default'))).toBe(moments);
    expect(withFloor(moments, null)).toBe(moments);
    expect(withFloor(undefined, read('person'))).toBeUndefined();
  });
});

// ---- The hero ----------------------------------------------------------------------------------

describe.skipIf(!existsSync(HERO_POSE) || !existsSync(HERO_MASKS))('the hero (cached masks and stand-in pose)', () => {
  let masks: (SamMask | null)[] = [];
  let bodies: (PointSet | null)[] = [];
  beforeAll(async () => {
    masks = await masksFromCache(JSON.parse(readFileSync(HERO_MASKS, 'utf8')), 254);
    const pose: (number[][] | null)[] = JSON.parse(readFileSync(HERO_POSE, 'utf8'));
    // The app's stand-in keeps the 15 CORE points (track/standin.ts).
    bodies = pose.map((q) => q && { x: Float32Array.from(CORE, (i) => q[i][0]), y: Float32Array.from(CORE, (i) => q[i][1]), confidence: Float32Array.from(CORE, (i) => q[i][2]) });
  }, 120_000);
  const onHero = (b: (PointSet | null)[]) => estimateFloor({ P: [HERO.P[0], HERO.P[1]], I: HERO.I, width: HERO.width, height: HERO.height, masks, bodies: b });
  const U = () => uOf(samMaskBox(masks[HERO.I])!.y1 - samMaskBox(masks[HERO.I])!.y0);
  const nearHand = (e: FloorEstimate) => {
    expect(e.from).toBe('person');
    expect(Math.abs(e.floor.ratio - HAND.ratio)).toBeLessThan(0.06);
    expect(Math.abs(e.floor.majorDeg - HAND.majorDeg)).toBeLessThan(2);
    expect(angleBetween(e.floor.up, HAND.up)).toBeLessThan(2);
    expect(Math.abs(e.floor.persp - cameraFloor(HERO_CAMERA, HERO.P, U())!.persp)).toBeLessThan(0.06);
  };

  it('lands near the hand-measured floor from his walk, with nothing asked of him', () => {
    const e = onHero(bodies);
    nearHand(e);
    expect(e.horizon!.from).toBe('walk');
    expect(Math.abs(e.horizon!.y + (HERO.P[0] - e.horizon!.x) * Math.tan(e.camera!.roll) - HAND.horizonAtP)).toBeLessThan(15);
    expect(Math.abs(deg(e.camera!.roll) - 2.3)).toBeLessThan(1.5);
    expect(Math.abs(deg(e.camera!.tilt) - 12.1)).toBeLessThan(1.5);
    // The fallback it replaces is far off: 0.26 in ratio, and no perspective.
    expect(Math.abs(DEFAULT_FLOOR.ratio - HAND.ratio)).toBeGreaterThan(0.25);
  });

  it('lands near it from the camera-height prior when only the frames he stands still on are tracked', () => {
    // Every frame whose torso is within ±12 % of his median one: no two
    // differ by 30 %, so no walking pair, and the horizon comes from his height.
    const length = (b: PointSet | null) =>
      b && Math.min(b.confidence[11], b.confidence[12], b.confidence[13], b.confidence[14]) >= 0.5 ? Math.hypot((b.x[11] + b.x[12] - b.x[13] - b.x[14]) / 2, (b.y[11] + b.y[12] - b.y[13] - b.y[14]) / 2) : null;
    const lengths = bodies.map(length).filter((v): v is number => v !== null).sort((a, b) => a - b);
    const mid = lengths[lengths.length >> 1];
    const still = bodies.map((b) => {
      const l = length(b);
      return l !== null && Math.abs(l / mid - 1) <= 0.12 ? b : null;
    });
    const e = onHero(still);
    nearHand(e);
    expect(e.horizon!.from).toBe('height');
  });
});
