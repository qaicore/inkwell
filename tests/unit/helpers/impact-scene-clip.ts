// A synthetic slam for the impact scene's tests (WP12): the hero's numbers
// (contact on f84 at P, striking along d, seed 84, decision 10's floor) on a
// crouching blob (frames/figure.ts's syntheticCrouch), with four limbs drawn
// out of his back on f22 (their emerge frame), the six hero cracks, and a
// turn tapped at f60. 180 frames at 1920×1080, or 1080×1920 in portrait with
// everything moved round its own P; the plate is mid-grey. Everything is
// built here; nothing lives under fixtures/.
import { createCanvas } from '@napi-rs/canvas';
import { syntheticCrouch } from '../../../src/impact/frames/figure.ts';
import { createImpactScene, type ImpactClip, type ImpactScene, type SceneOptions } from '../../../src/impact/scene.ts';
import { nodeScratch } from '../../../src/render/headless.ts';
import type { Mask, Pose } from '../../../src/track/tracking.ts';
import { anchorTransform, toTorso } from '../../../src/track/torso.ts';
import type { Effect, Moment, Stroke, Vec2 } from '../../../src/types/effect.ts';
import { HERO, HERO_CRACKS, asGroundStrokes } from './impact-drawings.ts';

export const FRAMES = 180;
export const DRAWN = 22; // the limbs' emerge frame, which they're drawn on
export const UNIT = 200; // his torso, clip px
export const LIMB_IDS = [1, 2, 3, 4];
export const CRACK_IDS = HERO_CRACKS.map((c) => c.id);
export const FLOOR = { ratio: 0.763, majorDeg: 2.6, up: [0.04, -1] as [number, number], persp: 0.68 };
export const PALETTE: Effect['palette'] = ['#e8203a', '#f4f1ea', '#16141a'];
export const PLATE = 128; // the plate's grey, 8-bit
const ROOT = [0.125, 0.26] as const; // the anchor (his back), × S along (side, up) from P
const HEAD = [0.07, 0.375, 0.046, 0.056] as const; // syntheticCrouch's head ellipse: centre and radii, × S

// The limbs as drawn on f22: cubics from his back, up and out, × S along
// (side, up) from P: root, two controls, tip. About 0.4 S long.
const CURVES: readonly (readonly number[])[] = [
  [0.105, 0.29, 0.15, 0.45, 0.3, 0.6, 0.42, 0.62],
  [0.135, 0.275, 0.22, 0.4, 0.4, 0.5, 0.5, 0.45],
  [0.115, 0.25, 0.2, 0.32, 0.38, 0.33, 0.48, 0.25],
  [0.145, 0.235, 0.25, 0.25, 0.4, 0.18, 0.46, 0.08],
];

export interface SceneSetup {
  flash?: 'safe' | 'full'; // missing = 'full' (decision 5)
  seconds?: number; // the aftermath; missing = 1.5
  count?: 0 | 7; // the impact frames; missing = 7
  tap?: boolean; // the turn tapped at f60; missing = true
  portrait?: boolean;
}

export interface SceneClip {
  effect: Effect;
  clip: ImpactClip;
  P: Vec2; // clip px
  d: Vec2;
}

export function sceneClip(setup: SceneSetup = {}): SceneClip {
  const { flash = 'full', seconds = 1.5, count = 7, tap = true, portrait = false } = setup;
  const width = portrait ? HERO.height : HERO.width;
  const height = portrait ? HERO.width : HERO.height;
  const S = Math.min(width, height);
  const P: Vec2 = portrait ? [540, 1900] : [HERO.P[0], HERO.P[1]];
  const d: Vec2 = [HERO.d[0], HERO.d[1]];
  const shift: Vec2 = [P[0] - HERO.P[0], P[1] - HERO.P[1]];
  const up: Vec2 = [-d[0], -d[1]];
  const side: Vec2 = [d[1], -d[0]];
  const at = (s: number, t: number): Vec2 => [P[0] + S * (s * side[0] + t * up[0]), P[1] + S * (s * side[1] + t * up[1])];
  const root = at(ROOT[0], ROOT[1]);
  // The anchor drifts a couple of px and rolls a little.
  const poses: Pose[] = Array.from({ length: FRAMES }, (_, f) => ({ x: root[0] + 2 * Math.sin(f / 9), y: root[1] + 1.5 * Math.sin(f / 7), angle: 0.01 * Math.sin(f / 11), scale: 1 }));
  const torso = anchorTransform(poses[DRAWN], UNIT);
  const limbs: Stroke[] = CURVES.map((c, i) => {
    const n = 24;
    const px = Array.from({ length: n + 1 }, (_, k): Vec2 => {
      const q = k / n;
      const w = [(1 - q) ** 3, 3 * q * (1 - q) ** 2, 3 * q * q * (1 - q), q ** 3];
      return at(w[0] * c[0] + w[1] * c[2] + w[2] * c[4] + w[3] * c[6], w[0] * c[1] + w[1] * c[3] + w[2] * c[5] + w[3] * c[7]);
    });
    const points = px.map((p) => toTorso(torso, p));
    return {
      id: LIMB_IDS[i],
      color: 0,
      brush: 'limb',
      kind: 'strand',
      anchor: { type: 'concept', prompt: 'back' },
      bodyAngle: 180,
      stiffness: 0.1,
      wobble: 1,
      views: { front: { points, pressure: points.map((_, k) => 1 - (0.6 * k) / n), root: points[0], layer: 'behind' } },
    };
  });
  const cracks = asGroundStrokes(HERO_CRACKS.map((c) => ({ ...c, points: c.points.map((p): Vec2 => [p[0] + shift[0], p[1] + shift[1]]) })));
  const slam: Moment = {
    kind: 'slam',
    at: HERO.I / 30,
    xy: [P[0], P[1]],
    by: 'body',
    dir: [d[0], d[1]],
    seed: HERO.seed,
    strokes: CRACK_IDS,
    limbs: LIMB_IDS,
    frames: { count, flash },
    aftermath: { seconds, scale: 1, scarSeconds: 3 },
    floor: FLOOR,
  };
  const effect: Effect = {
    version: 1,
    brush: { size: 28, thinning: 0.65, smoothing: 0.6, streamline: 0.45 },
    palette: PALETTE,
    timing: { drawingsPerSecond: 12 },
    strokes: [...limbs, ...cracks],
    moments: [{ kind: 'emerge', at: DRAWN / 30, strokes: LIMB_IDS }, slam],
    ...(tap ? { turn: { at: 2, dir: 1 as const } } : {}),
    overrides: {},
  };
  const person = syntheticCrouch(width, height, P, d, S).mask;
  const face = headMask(width / 4, height / 4, (x, y) => {
    const rx = (4 * x + 2 - P[0]) / S;
    const ry = (4 * y + 2 - P[1]) / S;
    const s = rx * side[0] + ry * side[1];
    const t = rx * up[0] + ry * up[1];
    return Math.hypot((s - HEAD[0]) / HEAD[2], (t - HEAD[1]) / HEAD[3]) <= 1;
  });
  const clip: ImpactClip = {
    width,
    height,
    frames: FRAMES,
    personMask: () => person,
    faceMask: () => face,
    poses,
    bodies: null,
    units: Array.from({ length: FRAMES }, () => UNIT),
    luma: () => () => PLATE,
  };
  return { effect, clip, P, d };
}

// A mask w × h (quarter size here), 255 where `inside`.
function headMask(w: number, h: number, inside: (x: number, y: number) => boolean): Mask {
  const alpha = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (inside(x, y)) alpha[y * w + x] = 255;
  return { width: w, height: h, alpha };
}

export function sceneOf(setup: SceneSetup = {}, opts: Partial<SceneOptions> = {}): ImpactScene & { setup: SceneClip } {
  const sc = sceneClip(setup);
  return Object.assign(createImpactScene(sc.effect, sc.clip, { tier: 'full', make: nodeScratch, ...opts }), { setup: sc });
}

// The plate, mid-grey, at the internal frame's size.
const plates = new Map<string, unknown>();
export function plate(W: number, H: number): unknown {
  let p = plates.get(`${W}x${H}`);
  if (!p) {
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = `rgb(${PLATE}, ${PLATE}, ${PLATE})`;
    ctx.fillRect(0, 0, W, H);
    plates.set(`${W}x${H}`, (p = canvas));
  }
  return p;
}

// Output frame o rendered on a fresh canvas: its RGBA.
export function renderAt(scene: ImpactScene, o: number): { data: Uint8ClampedArray; width: number; height: number } {
  const canvas = createCanvas(scene.width, scene.height);
  const ctx = canvas.getContext('2d');
  scene.render(ctx as never, plate(scene.width, scene.height), o);
  const img = ctx.getImageData(0, 0, scene.width, scene.height);
  return { data: img.data, width: img.width, height: img.height };
}
