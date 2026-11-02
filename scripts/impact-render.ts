// The hero render (impact design §8, "the render-script window"; WP14): the
// probe clip's frames 0–159 through the impact scene (WP12), from the two
// test drawings, with contact sheets and a side-by-side with the reference.
//   - The drawings (decision 1): the limbs on their start frame, where they
//     grow out, and the cracks on the end frame, in clip px
//     (impact/test-drawings.json). The moments come from WP1's
//     momentsFromDrawings with the drawn frame, so the contact snap, P and d
//     are derived end to end; the slam takes the drawings' floor block. The
//     limbs are stored in torso space on the anchor track (hips mid on the
//     start frame), as app/engine.ts stores a stroke.
//   - The masks: the cached SAM person and face runs next to the clip (or in
//     fixtures/probe), checked against the clip's sha256. The stand-in pose
//     (samples/hero/pose.json, gitignored; INKWELL_HERO_POSE names another)
//     gives the turn and the bend. No network, nothing paid.
//   - The turn (decision 4): read from the pose track and held to the hand
//     keys over f50–74 (checkedTurn: the read turn while it stays within 45°
//     of them, else the hand keys); the hand keys too when the pose reads no
//     turn. --tap <frame> overrides it with one tap (direction +1).
//   - Flashing (decision 5): full impact frames are the default. Both MP4s
//     are made: impact-hero.mp4 in full mode, where the flash check only
//     warns, and impact-hero-reduced.mp4 under Reduce flashing, which walks
//     the 7-step ladder until the check passes, re-rendering only the frames
//     each step touches. When step 7 still fails it's FlashCheckError: there
//     is no impact-hero-reduced.mp4, as the app's export saves no file. The
//     step-0 render (what the preview shows with the toggle on) is kept for
//     review only, named impact-hero-reduced-failed-check.mp4 with its
//     sheets, and once everything else is written the run ends with that
//     error (exit 1). --flash full or safe makes only that one.
//   - --portrait crops a 9:16 window (608×1080 of 1920×1080) centred on his
//     mask's box at the contact, crops the masks, the pose and the drawings
//     with it, and renders it through the same pipeline (h = −1). Every
//     output name gets -portrait.
// Outputs, all in --out (never inside the repo): impact-hero.mp4 (H.264
// yuv420p crf 18, 30 fps, the clip's audio), impact-hero-sheet.png (every 4th
// frame, labelled f, j, k and the phase), impact-hero-slam.png (every frame
// on clip f70–130), impact-hero-closeup.png (every frame from I − 8 to
// I + 24, a 1.5× window about the punch-in centre mix(frame centre, P, 0.5)
// at 1:1, with -p1.. pages of 9 that read whole at about 2000 px),
// impact-vs-ref.png and .mp4 (j −8..31: the reference's comp-NN.png,
// NN = kr(j) + 1, read where it is, on the left; the hero on the right; with
// -p1.. pages of 10 pairs at half size), the -reduced MP4 and sheets,
// effect.json (and effect-reduced.json), moments.json (the derivation),
// timing.json (the main thread against 26 ms, every job, and the ms a frame
// of each part of the shot: the limbs and their electricity, the strike, the
// impact frames, the aftermath), flash.json and turn.json. The clip's frames
// are read once with ffmpeg into a raw file under --out, deleted at the end.
// Usage: node scripts/impact-render.ts --clip <clip.mp4> --drawings <test-drawings.json> --out <dir> [--ref <frames dir>] [--frames 0-159] [--tap <frame>] [--flash safe|full] [--tier full|phone] [--scale <× the clip's size>] [--portrait]
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage, type Canvas, type Image, type SKRSContext2D } from '@napi-rs/canvas';
import { frameMasks } from '../src/app/pipeline.ts';
import { checkFlashes, downsampleFrame, FlashCheckError, flashSummary, guardRed, type CheckFrame, type FlashReport } from '../src/export/flash.ts';
import { FREEZE_EXTRA, FREEZE_HOLD, POSTER_COUNT, drawingStart, kr, massGroup, type Phase } from '../src/impact/clock.ts';
import { momentsFromDrawings, type DrawnMoments } from '../src/impact/detect.ts';
import { brushSizeForWidth } from '../src/impact/frames/figure.ts';
import type { PosterSpec } from '../src/impact/frames/gentle.ts';
import { LADDER, touchedFrames, walkLadder } from '../src/impact/ladder.ts';
import { createImpactScene, type ImpactClip, type ImpactScene, type SceneOptions, type TurnRead } from '../src/impact/scene.ts';
import { cutsAt, DEVICE_GATE, JOB_MS, MAIN_BUDGET, tierCuts } from '../src/impact/tiers.ts';
import { turnAt } from '../src/lift/body.ts';
import { turnError, turnKeys, turnKeysFromTap } from '../src/lift/turn.ts';
import { drawingIndex } from '../src/motion/timing.ts';
import { DEFAULT_BRUSH, resampleStroke, type Point } from '../src/render/brush.ts';
import { EMERGE } from '../src/render/electric.ts';
import { nodeScratch } from '../src/render/headless.ts';
import { plateLuma } from '../src/render/limb.ts';
import { masksFromCache, readSamCache, toFrameMask, type SamMask } from '../src/sam/cache.ts';
import { trackPoses } from '../src/track/anchor.ts';
import { goodStandIns } from '../src/track/bend.ts';
import { anchorTransform, toTorso, torsoHeights, type TorsoTransform } from '../src/track/torso.ts';
import type { Mask, PointSet, Pose } from '../src/track/tracking.ts';
import { parseEffect, serializeEffect, type Ease, type Effect, type FloorBlock, type Moment, type Stroke, type Turn, type Vec2 } from '../src/types/effect.ts';
import { assertOutsideRepo, parseArgs } from './lib/out-dir.ts';
import { probeVideo } from './probe/ffmpeg.ts';

const USAGE =
  'usage: node scripts/impact-render.ts --clip <clip.mp4> --drawings <test-drawings.json> --out <dir> [--ref <frames dir>] [--frames 0-159] [--tap <frame>] [--flash safe|full] [--tier full|phone] [--scale <× the clip size>] [--portrait]';
const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const FPS = 30;
const DPS = 12;
const FIELD = 1080; // the internal frame's long side by default (scene.ts)
const DEFAULT_FRAMES: [number, number] = [0, 159];
const SHEET_EVERY = 4; // the sheet shows every 4th output frame
const STRIP = [70, 130] as const; // clip frames the slam strip shows, every one
const CLOSE_J = [-8, 24] as const; // the close-up: every frame from I − 8 to I + 24
const CLOSE_ZOOM = 1.5; // the close-up's window: 1/1.5 of the frame about the punch-in centre, at 1:1
const CLOSE_PAGE = 9; // close-up frames a page (3 × 3): a page reads whole at about 2000 px
const VS_PAGE = 10; // side-by-side pairs a page (2 × 5), at half size
const VS_J = [-8, 31] as const; // the side-by-side with the reference
const TIPS_J = [-8, 9] as const; // frames labelled with the tips' distance from P
const PLATE_CACHE = 8; // clip frames kept as RGBA
const MAX_LABEL_PX = 13;

// The hand keys (impact design §1, "Turn"): his spin, [frame, degrees]. They
// check the turn read from the pose over f50–74, within 45° (decision 4).
export const HAND_KEYS: readonly Vec2[] = [[0, 0], [50, 0], [54, 90], [60, 180], [68, 270], [74, 360], [999, 360]];
export const TURN_CHECK = { from: 50, to: 74, maxDeg: 45 } as const;
export const TAP_MODEL = 60; // the brief's tap (his back to the camera): its keys are reported beside the turn used
// The hero's floor (decision 10's facts): ratio and majorDeg from the drawings
// when they have them, up and persp as the brief gives them.
export const HERO_FLOOR: Readonly<FloorBlock> = { ratio: 0.763, majorDeg: 2.6, up: [0.04, -1], persp: 0.68 };
// Decision 10, for comparison with what the drawings derive.
export const HERO_FACTS = { I: 84, P: [942, 1061] as Vec2, d: [-0.06, 0.998] as Vec2 } as const;
export const STRIKE_NAMES = ['whip', 'pinned', 'stamp', 'thin', 'burst', 'burst', 'swell'] as const; // S0..S6 (design §8's table)
export const POSTER_NAMES = ['whiteout', 'split', 'radial', 'star', 'negative cross', 'streaks', 'negative strike'] as const; // IF1..IF7

// ---- The drawings --------------------------------------------------------------------------

export interface DrawnLimb {
  id: number;
  points: Vec2[]; // clip px on the start frame, root first
  pressure: number[];
  color: 0 | 1 | 2;
  stiffness: number;
  layer: 'behind' | 'front';
}

export interface DrawnCrack {
  id: number;
  points: Vec2[]; // clip px on the end frame
  pressure: number[];
  width: number[] | null; // the full stroke width at each point, clip px, when given
  color: 0 | 1 | 2;
  anchor: Vec2; // its ground anchor
}

export interface HeroDrawings {
  size: Vec2 | null; // the clip size they were drawn on, when given
  seed: number | undefined;
  palette: Effect['palette'];
  start: { frame: number; hips: Vec2 | null; strokes: DrawnLimb[] };
  end: { frame: number; floor: { ratio: number; majorDeg: number } | null; ease: Ease | null; strokes: DrawnCrack[] };
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const EASES: readonly Ease[] = ['linear', 'in', 'out', 'hold-snap'];

function num(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`the drawings' ${what} is not a number`);
  return v;
}

function vec(v: unknown, what: string): Vec2 {
  if (!Array.isArray(v) || v.length < 2) throw new Error(`the drawings' ${what} is not a point`);
  return [num(v[0], what), num(v[1], what)];
}

function strokeOf(v: unknown, what: string, ink: 0 | 1 | 2): { id: number; points: Vec2[]; pressure: number[]; color: 0 | 1 | 2; s: Json } {
  if (!isObj(v)) throw new Error(`the drawings' ${what} is not a stroke`);
  const id = num(v.id, `${what} id`);
  if (!Array.isArray(v.points) || v.points.length < 2) throw new Error(`the drawings' ${what} (id ${id}) needs two points or more`);
  const points = v.points.map((p, i) => vec(p, `${what} ${id} point ${i}`));
  const pressure = Array.isArray(v.pressure) ? v.pressure.map((p, i) => num(p, `${what} ${id} pressure ${i}`)) : points.map(() => 0.5);
  if (pressure.length !== points.length) throw new Error(`the drawings' ${what} ${id} has ${points.length} points and ${pressure.length} pressures`);
  const color = v.color === undefined ? ink : num(v.color, `${what} ${id} color`);
  if (color !== 0 && color !== 1 && color !== 2) throw new Error(`the drawings' ${what} ${id} color is 0, 1 or 2 (got ${color})`);
  return { id, points, pressure, color, s: v };
}

// The two drawings from impact/test-drawings.json's shape: start.strokes are
// the limbs, end.strokes the cracks. Anything malformed throws.
export function readDrawings(json: unknown): HeroDrawings {
  if (!isObj(json) || !isObj(json.start) || !isObj(json.end)) throw new Error('the drawings need a start drawing (the limbs) and an end drawing (the impact)');
  const { start, end } = json;
  if (!Array.isArray(start.strokes) || start.strokes.length === 0) throw new Error('the start drawing has no limb strokes');
  if (!Array.isArray(end.strokes) || end.strokes.length === 0) throw new Error('the end drawing has no impact strokes');
  const palette = Array.isArray(json.palette) && json.palette.length === 3 && json.palette.every((c) => typeof c === 'string') ? (json.palette as Effect['palette']) : (['#e8203a', '#f4f1ea', '#16141a'] as Effect['palette']);
  const body = isObj(start.body) ? start.body : null;
  const floor = isObj(end.floor) && typeof end.floor.smallCircleRatioAtP === 'number' && typeof end.floor.smallCircleMajorAxisDeg === 'number' ? { ratio: end.floor.smallCircleRatioAtP, majorDeg: end.floor.smallCircleMajorAxisDeg } : null;
  const slam = Array.isArray(json.moments) ? json.moments.find((m) => isObj(m) && m.kind === 'slam') : undefined;
  const ease = isObj(slam) && isObj(slam.ease) && EASES.includes(slam.ease.cracks as Ease) ? (slam.ease.cracks as Ease) : null;
  return {
    size: json.size === undefined ? null : vec(json.size, 'size'),
    seed: json.seed === undefined ? undefined : num(json.seed, 'seed'),
    palette: [palette[0], palette[1], palette[2]],
    start: {
      frame: num(start.frame, 'start frame'),
      hips: body && body.hipsMid !== undefined ? vec(body.hipsMid, 'start hips') : null,
      strokes: start.strokes.map((v, i): DrawnLimb => {
        const st = strokeOf(v, `limb ${i}`, 0);
        return { id: st.id, points: st.points, pressure: st.pressure, color: st.color, stiffness: st.s.stiffness === undefined ? 0.5 : num(st.s.stiffness, `limb ${st.id} stiffness`), layer: st.s.layer === 'front' ? 'front' : 'behind' };
      }),
    },
    end: {
      frame: num(end.frame, 'end frame'),
      floor,
      ease,
      strokes: end.strokes.map((v, i): DrawnCrack => {
        const st = strokeOf(v, `crack ${i}`, 2);
        const anchor = isObj(st.s.anchor) && st.s.anchor.xy !== undefined ? vec(st.s.anchor.xy, `crack ${st.id} anchor`) : st.points[0];
        const width = Array.isArray(st.s.width) ? st.s.width.map((w, k) => num(w, `crack ${st.id} width ${k}`)) : null;
        if (width && width.length !== st.points.length) throw new Error(`the drawings' crack ${st.id} has ${st.points.length} points and ${width.length} widths`);
        return { id: st.id, points: st.points, pressure: st.pressure, width, color: st.color, anchor };
      }),
    },
  };
}

// The drawings moved by (dx, 0): the portrait crop.
export function shiftDrawings(d: HeroDrawings, dx: number): HeroDrawings {
  const sh = (p: Vec2): Vec2 => [p[0] + dx, p[1]];
  return {
    ...d,
    start: { ...d.start, hips: d.start.hips && sh(d.start.hips), strokes: d.start.strokes.map((s) => ({ ...s, points: s.points.map(sh) })) },
    end: { ...d.end, strokes: d.end.strokes.map((s) => ({ ...s, points: s.points.map(sh), anchor: sh(s.anchor) })) },
  };
}

// ---- The effect ----------------------------------------------------------------------------

// A limb as the app stores it (app/engine.ts): 32 points by arc length, in
// torso space on the start frame (`at`: the anchor track's transform there).
export function limbStroke(l: DrawnLimb, at: TorsoTransform): Stroke {
  const { points, pressure } = resampleStroke(l.points.map((p, i): Point => [p[0], p[1], l.pressure[i]]));
  const torso = points.map((p) => toTorso(at, p));
  return {
    id: l.id,
    color: l.color,
    brush: 'limb',
    kind: 'strand',
    anchor: { type: 'concept', prompt: 'person' },
    bodyAngle: 180, // out of his back
    stiffness: l.stiffness,
    wobble: 1,
    views: { front: { points: torso, pressure, root: torso[0], layer: l.layer } },
  };
}

// A crack as a ground stroke: fixed frame px (tripod), as drawn, at the size
// its widths give on a clip `clipWidth` px wide (the ink brush's when it has none).
export function crackStroke(c: DrawnCrack, clipWidth: number): Stroke {
  const points = c.points.map((p): Vec2 => [p[0], p[1]]);
  return {
    id: c.id,
    color: c.color,
    ...(c.width ? { size: Math.round(brushSizeForWidth(c.width, clipWidth) * 100) / 100 } : {}),
    kind: 'rigid',
    anchor: { type: 'ground', xy: [c.anchor[0], c.anchor[1]] },
    bodyAngle: 0,
    stiffness: 1,
    wobble: 0,
    views: { front: { points, pressure: [...c.pressure], root: points[0], layer: 'behind' } },
  };
}

// The effect the two drawings make: the limbs and cracks, the emerge and slam
// moments as momentsFromDrawings derived them, with the impact frames in
// `flash` mode and the hero's floor; his turn only when there is one to give.
export function heroEffect(o: { drawings: HeroDrawings; moments: DrawnMoments; at: TorsoTransform; flash: 'safe' | 'full'; turn?: Turn | null; clipWidth?: number }): Effect {
  const { drawings: d, moments: m } = o;
  const floor: FloorBlock = { ratio: d.end.floor?.ratio ?? HERO_FLOOR.ratio, majorDeg: d.end.floor?.majorDeg ?? HERO_FLOOR.majorDeg, up: [HERO_FLOOR.up[0], HERO_FLOOR.up[1]], persp: HERO_FLOOR.persp };
  const slam: Moment = { ...m.slam, frames: { count: 7, flash: o.flash }, floor, ...(d.end.ease ? { ease: { cracks: d.end.ease } } : {}) };
  return {
    version: 1,
    brush: { ...DEFAULT_BRUSH },
    palette: [d.palette[0], d.palette[1], d.palette[2]],
    timing: { drawingsPerSecond: DPS },
    strokes: [...d.start.strokes.map((l) => limbStroke(l, o.at)), ...d.end.strokes.map((c) => crackStroke(c, o.clipWidth ?? d.size?.[0] ?? 1920))],
    moments: [m.emerge, slam],
    ...(o.turn ? { turn: o.turn } : {}),
    overrides: {},
  };
}

// ---- The turn (decision 4) -------------------------------------------------------------------

// Without a tap: no turn in the effect, and the scene holds the turn read from
// the pose to the hand keys. With one: the tap, direction +1, overrides it.
export function turnPlan(tap: number | undefined): { turn: Turn | null; check: SceneOptions['turn'] } {
  if (tap !== undefined) return { turn: { at: tap / FPS, dir: 1 }, check: undefined };
  return { turn: null, check: { known: HAND_KEYS.map((k): Vec2 => [k[0], k[1]]), from: TURN_CHECK.from, to: TURN_CHECK.to, maxDeg: TURN_CHECK.maxDeg } };
}

// The hand keys as his nudged keys: what the render uses when the pose reads no turn.
export const handTurn = (): Turn => ({ at: 60 / FPS, dir: 1, keys: HAND_KEYS.map(([f, deg]): [number, number] => [f / FPS, deg]) });

export type TurnUsed = 'pose' | 'hand' | 'tap' | 'none';

// Which keys the scene used, in plain words.
export function turnUsed(read: Pick<TurnRead, 'from' | 'checked'>): TurnUsed {
  if (read.from === 'tap') return 'tap';
  if (read.from === 'keys') return 'hand'; // the hand keys, given when the pose reads no turn
  if (read.from === 'pose') return read.checked?.used === 'known' ? 'hand' : 'pose';
  return 'none';
}

// turn.json: the keys used, the turn read from the pose (and its error), the
// tap model's keys (the brief's tap at f60, measured the same way), and θ per
// frame against the hand keys.
export function turnReport(o: { read: TurnRead; pose: readonly Vec2[]; frames: readonly number[] }) {
  const used = turnUsed(o.read);
  const hand = HAND_KEYS;
  const tap = turnKeysFromTap({ at: TAP_MODEL / FPS, dir: 1 }, FPS);
  const err = (keys: readonly Vec2[]) => Math.round(turnError(keys, hand, TURN_CHECK.from, TURN_CHECK.to) * 100) / 100;
  const r = (x: number) => Math.round(x * 100) / 100;
  return {
    note: `decision 4: the turn read from the stand-in pose is used while it stays within ${TURN_CHECK.maxDeg}° of the hand keys over f${TURN_CHECK.from}–${TURN_CHECK.to}, else the hand keys; a tap overrides both. Errors are the largest |θ − θ_hand| over f${TURN_CHECK.from}–${TURN_CHECK.to}, degrees.`,
    used,
    keys: o.read.keys.map((k) => [r(k[0]), r(k[1])]),
    maxError: err(o.read.keys),
    automatic: o.pose.length > 0 ? { keys: o.pose.map((k) => [r(k[0]), r(k[1])]), error: err(o.pose), within: err(o.pose) <= TURN_CHECK.maxDeg } : null,
    tapModel: { at: TAP_MODEL, keys: tap, error: err(tap) },
    hand: hand.map((k) => [k[0], k[1]]),
    perFrame: o.frames.map((f) => {
      const theta = turnAt(o.read.keys, f);
      const h = turnAt(hand, f);
      return { f, used: r(theta), hand: r(h), error: r(Math.abs(theta - h)), pose: o.pose.length > 0 ? r(turnAt(o.pose, f)) : null, tap: r(turnAt(tap, f)) };
    }),
  };
}

// ---- Portrait --------------------------------------------------------------------------------

// The 9:16 window's width for a clip `height` tall, even: 608 for 1080.
export const portraitWidth = (height: number): number => 2 * Math.round((height * 9) / 32);

// A mask's box, clip px: the raster's set cells. Null when it has none.
export function samBox(m: SamMask | null): { left: number; right: number; top: number; bottom: number } | null {
  if (!m) return null;
  const { left, top, right, bottom } = m.bounds;
  const sx = (right - left) / m.width;
  const sy = (bottom - top) / m.height;
  let c0 = Infinity;
  let c1 = -Infinity;
  let r0 = Infinity;
  let r1 = -Infinity;
  for (let r = 0; r < m.height; r++) {
    for (let c = 0; c < m.width; c++) {
      if (!m.raster[r * m.width + c]) continue;
      c0 = Math.min(c0, c);
      c1 = Math.max(c1, c);
      r0 = Math.min(r0, r);
      r1 = Math.max(r1, r);
    }
  }
  if (!(c1 >= c0)) return null;
  return { left: left + c0 * sx, right: left + (c1 + 1) * sx, top: top + r0 * sy, bottom: top + (r1 + 1) * sy };
}

// The window's left edge, clip px: centred on his box, inside the clip.
export function cropLeft(box: { left: number; right: number }, clipWidth: number, width: number): number {
  return Math.min(clipWidth - width, Math.max(0, Math.round((box.left + box.right) / 2 - width / 2)));
}

// A SAM mask in the window [x0, x0 + width): the raster columns whose centres
// fall inside it, with the bounds moved into the window's px. Null when no
// set cell is left.
export function cropSamMask(m: SamMask, x0: number, width: number): SamMask | null {
  const { left, top, right, bottom } = m.bounds;
  const sx = (right - left) / m.width;
  const c0 = Math.max(0, Math.ceil((x0 - left) / sx - 0.5));
  const c1 = Math.min(m.width, Math.ceil((x0 + width - left) / sx - 0.5));
  if (c1 <= c0) return null;
  const w = c1 - c0;
  const raster = new Uint8Array(w * m.height);
  let any = false;
  for (let r = 0; r < m.height; r++) {
    const row = m.raster.subarray(r * m.width + c0, r * m.width + c1);
    raster.set(row, r * w);
    any ||= row.some((v) => v !== 0);
  }
  if (!any) return null;
  return { width: w, height: m.height, raster, bounds: { left: left + c0 * sx - x0, top, right: left + c1 * sx - x0, bottom }, ...(m.confidence === undefined ? {} : { confidence: m.confidence }) };
}

// The stand-in moved by (dx, 0).
export function shiftBodies(bodies: readonly (PointSet | null)[], dx: number): (PointSet | null)[] {
  return bodies.map((b) => b && { x: b.x.map((x) => x + dx), y: Float32Array.from(b.y), confidence: Float32Array.from(b.confidence) });
}

// MediaPipe's 33 landmarks [x, y, visibility] as the stand-in's 15 points.
const CORE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 23, 24];
export function standInPoints(landmarks: unknown): PointSet | null {
  if (!Array.isArray(landmarks) || landmarks.length < 33) return null;
  const at = (i: number, k: number) => {
    const p = landmarks[CORE[i]];
    return Array.isArray(p) && typeof p[k] === 'number' ? p[k] : NaN;
  };
  return { x: Float32Array.from(CORE, (_, i) => at(i, 0)), y: Float32Array.from(CORE, (_, i) => at(i, 1)), confidence: Float32Array.from(CORE, (_, i) => at(i, 2)) };
}

// All 33 landmarks as a point set, for the limbs' crash-test dummy (lift/collide.ts).
export function skeletonPoints(landmarks: unknown): PointSet | null {
  if (!Array.isArray(landmarks) || landmarks.length < 33) return null;
  const at = (i: number, k: number) => {
    const p = landmarks[i];
    return Array.isArray(p) && typeof p[k] === 'number' ? p[k] : NaN;
  };
  const all = Array.from({ length: 33 }, (_, i) => i);
  return { x: Float32Array.from(all, (i) => at(i, 0)), y: Float32Array.from(all, (i) => at(i, 1)), confidence: Float32Array.from(all, (i) => at(i, 2)) };
}

// ---- Output frames, audio and names ------------------------------------------------------------

// The output frames that show clip frames first..last, both included. Under
// the freeze (ladder step 4 on) the posters hold over clip I on outputs
// I..I+34, clip I+1..I+8 isn't shown, and clip c ≥ I + 9 shows on c + 26.
export function outputWindow(first: number, last: number, I: number | null, freeze: boolean): [number, number] {
  if (!freeze || I === null) return [first, last];
  const held = I + POSTER_COUNT * FREEZE_HOLD - 1;
  const at = (c: number, end: boolean) => (c < I ? c : c < I + 9 ? (end ? held : I) : c + FREEZE_EXTRA);
  return [at(first, false), at(last, true)];
}

export type AudioSegment = { kind: 'clip'; from: number; to: number } | { kind: 'silence'; seconds: number };

// The audio under output frames a..b (both included), seconds: the clip's own
// at the same time, and under the freeze 26 frames of silence after I + 9.
export function audioSegments(a: number, b: number, I: number | null, freeze: boolean, fps = FPS): AudioSegment[] {
  const end = b + 1;
  const s = (f: number) => f / fps;
  if (!freeze || I === null) return [{ kind: 'clip', from: s(a), to: s(end) }];
  const gap0 = I + 9;
  const gap1 = gap0 + FREEZE_EXTRA;
  const out: AudioSegment[] = [];
  if (a < gap0) out.push({ kind: 'clip', from: s(a), to: s(Math.min(end, gap0)) });
  const quiet = Math.min(end, gap1) - Math.max(a, gap0);
  if (quiet > 0) out.push({ kind: 'silence', seconds: s(quiet) });
  if (end > gap1) out.push({ kind: 'clip', from: s(Math.max(a, gap1) - FREEZE_EXTRA), to: s(end - FREEZE_EXTRA) });
  return out;
}

// The segments as an ffmpeg -filter_complex on input 1 (the clip), ending in [aout].
export function audioFilter(segments: readonly AudioSegment[], rate: number, layout: string): string {
  const t = (x: number) => x.toFixed(6);
  const clips = segments.filter((sg) => sg.kind === 'clip').length;
  const parts: string[] = [];
  if (clips > 1) parts.push(`[1:a]asplit=${clips}${Array.from({ length: clips }, (_, i) => `[c${i}]`).join('')}`);
  let c = 0;
  const labels = segments.map((sg, i) => {
    const label = segments.length === 1 ? 'aout' : `s${i}`;
    if (sg.kind === 'clip') parts.push(`${clips > 1 ? `[c${c++}]` : '[1:a]'}atrim=start=${t(sg.from)}:end=${t(sg.to)},asetpts=PTS-STARTPTS[${label}]`);
    else parts.push(`anullsrc=channel_layout=${layout}:sample_rate=${rate},atrim=duration=${t(sg.seconds)}[${label}]`);
    return `[${label}]`;
  });
  if (segments.length > 1) parts.push(`${labels.join('')}concat=n=${segments.length}:v=0:a=1[aout]`);
  return parts.join(';');
}

// An output's file name: -portrait goes on the end.
export const outName = (base: string, ext: string, portrait: boolean): string => `${base}${portrait ? '-portrait' : ''}.${ext}`;

// The reference drawing for j: comp-NN.png, NN = kr(j) + 1.
export const refName = (j: number): string => `comp-${String(kr(j) + 1).padStart(2, '0')}.png`;

// The internal frame the scene renders at (scene.ts's rule): `size` on the
// long side, × the cut order's resolution.
export function internalSize(width: number, height: number, size: number, resolution: number): { W: number; H: number } {
  const s = Math.round(size * resolution) / Math.max(width, height);
  return { W: Math.round(width * s), H: Math.round(height * s) };
}

// A source rectangle, internal px.
export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

// The close-up's window on a W×H frame: 1/zoom of it, even, about the
// camera's punch-in centre mix(frame centre, P, 0.5) (design decision 7),
// kept inside the frame. P in internal px.
export function closeWindow(W: number, H: number, P: Vec2, zoom = CLOSE_ZOOM): Crop {
  const w = Math.min(W, 2 * Math.round(W / zoom / 2));
  const h = Math.min(H, 2 * Math.round(H / zoom / 2));
  const cx = (W / 2 + P[0]) / 2;
  const cy = (H / 2 + P[1]) / 2;
  return { x: Math.min(W - w, Math.max(0, Math.round(cx - w / 2))), y: Math.min(H - h, Math.max(0, Math.round(cy - h / 2))), w, h };
}

// ---- Labels ----------------------------------------------------------------------------------

// The phase in a few words: the limbs' emergence (grow 0–3, pop 0–1, from
// their age in drawings), then the slam's phases.
export function phaseLabel(phase: Phase | null, o: { age: number | null; group: number | null; poster?: PosterSpec | null }): string {
  if (phase === null || phase.kind === 'none' || phase.kind === 'coil') {
    const { age } = o;
    if (age !== null && age >= 0 && age < EMERGE.grow) return `grow ${age}`;
    if (age !== null && age >= EMERGE.grow && age < EMERGE.grow + EMERGE.pop) return `pop ${age - EMERGE.grow}`;
    if (phase?.kind === 'coil') return 'coil';
    return age === null || age < 0 ? 'footage' : 'idle';
  }
  if (phase.kind === 'strike') return `S${phase.s} ${STRIKE_NAMES[phase.s]}`;
  if (phase.kind === 'poster') {
    const spec = o.poster;
    const how = spec === undefined ? '' : spec === null ? ' (no poster)' : spec.glint ? ', glint' : `, ${spec.field}`;
    return `IF${phase.si + 1} ${POSTER_NAMES[phase.si]}${how}`;
  }
  if (phase.kind === 'aftermath') return `A${phase.A}${o.group !== null ? ` g${o.group}` : ''}`;
  if (phase.kind === 'decay') return `decay ${phase.alpha.toFixed(2)}`;
  return phase.kind === 'hold' ? 'hold' : 'scars';
}

// A sheet cell's lines: the clip frame (and the output frame when they
// differ), j, k and kr; the phase; and through the strike and the posters
// what the limbs show and how far their tips are from P.
export function frameLabel(o: { o: number; c: number; j: number | null; k: number; phase: string; limbs: string | null; tips: number | null }): string[] {
  const head = [`f${o.c}`];
  if (o.o !== o.c) head.push(`o${o.o}`);
  if (o.j !== null) head.push(`j${o.j}`);
  head.push(`k${o.k}`);
  if (o.j !== null && o.j >= VS_J[0] && o.j <= VS_J[1]) head.push(`kr${kr(o.j)}`);
  const lines = [head.join(' '), o.phase];
  if (o.limbs !== null && o.tips !== null) lines.push(`limbs ${o.limbs}, tips ${Math.round(o.tips)} px from P`);
  return lines;
}

// ---- Timing ----------------------------------------------------------------------------------

export interface FrameTime {
  o: number;
  clip: number;
  j: number | null;
  ms: number; // render() to a 1 px readback
  lines: Record<string, number>; // scene.timings()
}

export interface JobTime {
  key: string; // the job key without its kind and scene
  kind: 'limb' | 'mass' | 'poster';
  due: number;
  at: number; // the output frame it ran ahead of
  ms: number;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

export function stats(xs: readonly number[]): { n: number; median: number; p90: number; worst: number } {
  if (xs.length === 0) return { n: 0, median: 0, p90: 0, worst: 0 };
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, median: r2(s[Math.floor(s.length / 2)]), p90: r2(s[Math.min(s.length - 1, Math.floor(0.9 * s.length))]), worst: r2(s[s.length - 1]) };
}

// timing.json's numbers: the main thread against the 26 ms budget (all the
// frames, and the impact window j −10..45 the budget test holds), and every
// job against its line.
export function timingSummary(frames: readonly FrameTime[], jobs: readonly JobTime[], I: number | null) {
  const worst = frames.reduce<FrameTime | null>((a, b) => (a === null || b.ms > a.ms ? b : a), null);
  const window = frames.filter((f) => f.j !== null && f.j >= -10 && f.j <= 45);
  const kinds = ['limb', 'mass', 'poster'] as const;
  return {
    main: {
      budget: MAIN_BUDGET,
      ...stats(frames.map((f) => f.ms)),
      worstFrame: worst ? { o: worst.o, clip: worst.clip, j: worst.j, ms: worst.ms } : null,
      over: frames.filter((f) => f.ms > MAIN_BUDGET).length,
      impactWindow: I === null ? null : { from: I - 10, to: I + 45, ...stats(window.map((f) => f.ms)), over: window.filter((f) => f.ms > MAIN_BUDGET).length },
    },
    jobs: Object.fromEntries(
      kinds.map((kind) => {
        const mine = jobs.filter((jb) => jb.kind === kind);
        return [kind, { budget: JOB_MS[kind], ...stats(mine.map((jb) => jb.ms)), over: mine.filter((jb) => jb.ms > JOB_MS[kind]).length }];
      }),
    ),
  };
}

export interface Span {
  name: string;
  what: string;
  from: number; // clip frames, both included
  to: number;
}

// The parts of the shot timed apart (decision 11's numbers), in clip frames:
// the footage before the limbs, the limbs and their electricity (grow, pop,
// idle and the coil), the strike, the impact frames, the aftermath and the
// rest. Cut to first..last; a part with no frame left goes.
export function shotSpans(first: number, last: number, f1: number, I: number | null): Span[] {
  const grow = drawingStart(drawingIndex(f1, DPS), DPS); // the drawing that holds f1: the limbs start to grow
  const spans: Span[] = [{ name: 'footage', what: 'the clip before the limbs: the plate and the grade', from: first, to: grow - 1 }];
  if (I === null) spans.push({ name: 'limbs', what: 'the limbs and their electricity', from: grow, to: last });
  else {
    spans.push(
      { name: 'limbs', what: 'the limbs and their electricity: grow, pop, idle and the coil (j ≤ −9)', from: grow, to: I - 9 },
      { name: 'strike', what: 'the slam-down S0–S6 (j −8..−1)', from: I - 8, to: I - 1 },
      { name: 'impact', what: 'the impact frames IF1–IF7 (j 0..8)', from: I, to: I + 8 },
      { name: 'aftermath', what: 'fire, dust and lightning A0–A17 (j 9..31)', from: I + 9, to: I + 31 },
      { name: 'after', what: 'the hold, the decay and the scars, with the limbs idle (j ≥ 32)', from: I + 32, to: last },
    );
  }
  return spans.map((sp) => ({ ...sp, from: Math.max(first, sp.from), to: Math.min(last, sp.to) })).filter((sp) => sp.to >= sp.from);
}

// Each part's ms a frame: the main thread's (render() to a 1 px readback);
// the drawings (jobs) due on its frames, by kind, wherever they ran; and the
// two together, a frame with the drawings due on it (each is then held for
// its frames), as stats and as the mean over the part. `lines` are the
// medians of the scene's own timings() lines.
export function segmentTimes(frames: readonly FrameTime[], jobs: readonly JobTime[], spans: readonly Span[]) {
  const kinds = ['limb', 'mass', 'poster'] as const;
  return spans.map((sp) => {
    const mine = frames.filter((f) => f.clip >= sp.from && f.clip <= sp.to);
    const outs = new Set(mine.map((f) => f.o));
    const due = jobs.filter((jb) => outs.has(jb.due));
    const together = mine.map((f) => f.ms + due.filter((jb) => jb.due === f.o).reduce((a, jb) => a + jb.ms, 0));
    const names = [...new Set(mine.flatMap((f) => Object.keys(f.lines)))];
    return {
      name: sp.name,
      what: sp.what,
      clip: [sp.from, sp.to],
      frames: mine.length,
      main: stats(mine.map((f) => f.ms)),
      jobs: Object.fromEntries(kinds.map((k) => [k, stats(due.filter((jb) => jb.kind === k).map((jb) => jb.ms))] as const).filter(([, s]) => s.n > 0)),
      withDrawings: { ...stats(together), mean: r2(together.reduce((a, b) => a + b, 0) / Math.max(1, together.length)) },
      lines: Object.fromEntries(names.map((n) => [n, stats(mine.map((f) => f.lines[n] ?? 0)).median])),
    };
  });
}

// A report on frames checked from output frame `first` on, numbered as output
// frames (the checker counts from 0), so its windows, transitions and
// summary name the frames the MP4 shows.
export function atFrames(report: FlashReport, first: number): FlashReport {
  if (first === 0) return report;
  return {
    ...report,
    windows: report.windows.map((w) => ({ ...w, start: w.start + first, end: w.end + first })),
    transitions: report.transitions.map((t) => ({ ...t, frame: t.frame + first })),
  };
}

// The flash report without the parts that only repeat it: the windows and
// fields that flash at all (each field with its index, which the
// transitions name), and every transition as [frame, field, direction, kind].
export function flashBrief(report: FlashReport) {
  return {
    frames: report.frames,
    fps: report.fps,
    window: report.window,
    size: [report.width, report.height],
    radius: report.radius,
    worstGeneral: report.worstGeneral,
    worstRed: report.worstRed,
    pass: report.pass,
    summary: flashSummary(report),
    windows: report.windows.filter((w) => w.general > 0 || w.red > 0),
    fields: report.fields.flatMap((f, field) => (f.general > 0 || f.red > 0 ? [{ field, ...f }] : [])),
    transitions: report.transitions.map((t) => [t.frame, t.field, t.direction, t.kind] as const),
  };
}

const pick = (report: FlashReport) => ({ pass: report.pass, worstGeneral: report.worstGeneral, worstRed: report.worstRed, summary: flashSummary(report) });

// ---- The clip's frames -------------------------------------------------------------------------

// The clip's frames at the internal size, read once with ffmpeg in order into
// a raw RGB file (picking frames with a select filter costs about 0.6 s a
// frame), then read back one at a time.
class Plates {
  readonly width: number;
  readonly height: number;
  readonly count: number;
  readonly canvas: Canvas;
  private readonly ctx: SKRSContext2D;
  private readonly fd: number;
  private readonly bytes: number;
  private readonly cache = new Map<number, Uint8ClampedArray>();
  private shown = -1;

  constructor(file: string, width: number, height: number, count: number) {
    this.width = width;
    this.height = height;
    this.count = count;
    this.canvas = createCanvas(width, height);
    this.ctx = this.canvas.getContext('2d');
    this.fd = openSync(file, 'r');
    this.bytes = width * height * 3;
  }

  rgba(f: number): Uint8ClampedArray | null {
    if (!(f >= 0 && f < this.count)) return null;
    const hit = this.cache.get(f);
    if (hit) {
      this.cache.delete(f);
      this.cache.set(f, hit);
      return hit;
    }
    const rgb = Buffer.alloc(this.bytes);
    readSync(this.fd, rgb, 0, this.bytes, f * this.bytes);
    const out = new Uint8ClampedArray(this.width * this.height * 4);
    for (let p = 0, q = 0; p < this.bytes; p += 3, q += 4) {
      out[q] = rgb[p];
      out[q + 1] = rgb[p + 1];
      out[q + 2] = rgb[p + 2];
      out[q + 3] = 255;
    }
    this.cache.set(f, out);
    if (this.cache.size > PLATE_CACHE) this.cache.delete(this.cache.keys().next().value as number);
    return out;
  }

  // Clip frame f on the plate canvas, rasterized (so a render's timing doesn't
  // carry the upload: the app gets its frames from the decoder).
  image(f: number): Canvas {
    const c = Math.min(this.count - 1, Math.max(0, f));
    if (c !== this.shown) {
      const img = this.ctx.createImageData(this.width, this.height);
      img.data.set(this.rgba(c) as Uint8ClampedArray);
      this.ctx.putImageData(img, 0, 0);
      this.ctx.getImageData(0, 0, 1, 1);
      this.shown = c;
    }
    return this.canvas;
  }

  close() {
    closeSync(this.fd);
  }
}

function ffmpegTail(stderr: unknown): string {
  return String(stderr ?? '').trim().split('\n').slice(-6).join('\n');
}

function extractFrames(clip: string, file: string, n: number, W: number, H: number, crop: { x: number; width: number; height: number } | null) {
  const vf = [...(crop ? [`crop=${crop.width}:${crop.height}:${crop.x}:0`] : []), `scale=${W}:${H}:flags=area`].join(',');
  const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-i', clip, '-frames:v', String(n), '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgb24', file]);
  if (r.error) throw new Error(`ffmpeg didn't start (${r.error.message}). Install it: winget install Gyan.FFmpeg`);
  if (r.status !== 0) throw new Error(`ffmpeg failed reading the clip's frames:\n${ffmpegTail(r.stderr)}`);
  const got = statSync(file).size / (W * H * 3);
  if (got < n) throw new Error(`ffmpeg read ${got} of the clip's first ${n} frames`);
}

function probeAudio(file: string): { rate: number; layout: string } | null {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate,channels,channel_layout', '-of', 'json', file]);
  if (r.error) throw new Error(`ffprobe didn't start (${r.error.message})`);
  if (r.status !== 0) throw new Error(`ffprobe failed on ${file}:\n${ffmpegTail(r.stderr)}`);
  const s = JSON.parse(String(r.stdout)).streams?.[0];
  if (!s) return null;
  const channels = Number(s.channels) || 2;
  return { rate: Number(s.sample_rate) || 48000, layout: s.channel_layout || (channels === 1 ? 'mono' : channels === 2 ? 'stereo' : `${channels}c`) };
}

// ---- Encoding --------------------------------------------------------------------------------

interface Encoder {
  write(data: Uint8ClampedArray): Promise<void>;
  close(): Promise<void>;
}

// An H.264 MP4 (yuv420p, crf 18, 30 fps) fed RGBA frames, with the clip's
// audio through `audio`'s filter when given.
function encoder(file: string, width: number, height: number, audio: { clip: string; filter: string } | null): Encoder {
  const args = ['-hide_banner', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-r', String(FPS), '-i', 'pipe:0'];
  if (audio) args.push('-i', audio.clip, '-filter_complex', audio.filter, '-map', '0:v', '-map', '[aout]', '-c:a', 'aac', '-b:a', '192k');
  else args.push('-map', '0:v');
  if (width % 2 !== 0 || height % 2 !== 0) args.push('-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2');
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-movflags', '+faststart', file);
  const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => (err += String(d)));
  proc.stdin.on('error', () => {}); // a dead ffmpeg is reported by `done`
  const done = new Promise<void>((res, rej) => {
    proc.on('error', (e) => rej(new Error(`ffmpeg didn't start (${e.message})`)));
    proc.on('close', (code) => (code === 0 ? res() : rej(new Error(`ffmpeg failed writing ${file}:\n${ffmpegTail(err)}`))));
  });
  done.catch(() => {});
  return {
    async write(data) {
      if (!proc.stdin.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength))) await Promise.race([once(proc.stdin, 'drain'), done]);
    },
    async close() {
      proc.stdin.end();
      await done;
    },
  };
}

// ---- Sheets ----------------------------------------------------------------------------------

function label(ctx: SKRSContext2D, x: number, y: number, lines: readonly string[], px: number) {
  ctx.save();
  ctx.font = `${px}px sans-serif`;
  ctx.textBaseline = 'top';
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 6;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.62)';
  ctx.fillRect(x, y, w, lines.length * (px + 2) + 4);
  ctx.fillStyle = '#ffffff';
  lines.forEach((l, i) => ctx.fillText(l, x + 3, y + 2 + i * (px + 2)));
  ctx.restore();
}

const TITLE_PX = 15;
const TITLE_LINES = 4;
const GAP = 2;

// `text` broken at spaces into lines no wider than `width` px.
function wrap(ctx: SKRSContext2D, text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > width) {
      out.push(line);
      line = word;
    } else line = next;
  }
  if (line) out.push(line);
  return out;
}

// A grid of frames with their labels, under a title written when it's saved.
// With `src`, each cell shows that window of the frame (the close-up).
class Sheet {
  private readonly slots: Map<number, number>;
  private readonly cols: number;
  private readonly cw: number;
  private readonly ch: number;
  private readonly src: Crop | null;
  private readonly top: number;
  private readonly px: number;
  private readonly canvas: Canvas;
  private readonly ctx: SKRSContext2D;

  constructor(frames: readonly number[], cols: number, cw: number, ch: number, src: Crop | null = null) {
    this.slots = new Map(frames.map((o, i) => [o, i]));
    this.cols = Math.max(1, Math.min(cols, frames.length));
    this.cw = cw;
    this.ch = ch;
    this.src = src;
    this.px = Math.min(MAX_LABEL_PX, Math.max(9, Math.round(cw / 28)));
    this.top = TITLE_LINES * (TITLE_PX + 4) + 8;
    const rows = Math.max(1, Math.ceil(frames.length / this.cols));
    this.canvas = createCanvas(this.cols * (cw + GAP) - GAP, this.top + rows * (ch + GAP) - GAP);
    this.ctx = this.canvas.getContext('2d');
    this.ctx.fillStyle = '#16141a';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  get size(): number {
    return this.slots.size;
  }

  // `under`: the image's top rows, source px, the label goes below (the
  // side-by-side's own label bar, which it would cover otherwise).
  add(o: number, image: Canvas, lines: readonly string[], under = 0) {
    const i = this.slots.get(o);
    if (i === undefined) return;
    const x = (i % this.cols) * (this.cw + GAP);
    const y = this.top + Math.floor(i / this.cols) * (this.ch + GAP);
    const s = this.src ?? { x: 0, y: 0, w: image.width, h: image.height };
    this.ctx.drawImage(image, s.x, s.y, s.w, s.h, x, y, this.cw, this.ch);
    label(this.ctx, x + 3, y + 3 + Math.round((under * this.ch) / s.h), lines, this.px);
    this.ctx.getImageData(0, 0, 1, 1); // rasterize now: the source canvas changes next frame
  }

  // The title's lines, wrapped to the sheet's width, up to TITLE_LINES of them.
  save(file: string, title: readonly string[]) {
    const ctx = this.ctx;
    ctx.fillStyle = '#16141a';
    ctx.fillRect(0, 0, this.canvas.width, this.top);
    ctx.fillStyle = '#f4f1ea';
    ctx.font = `${TITLE_PX}px sans-serif`;
    ctx.textBaseline = 'top';
    const lines = title.flatMap((l) => wrap(ctx, l, this.canvas.width - 16));
    lines.slice(0, TITLE_LINES).forEach((l, i) => ctx.fillText(l, 8, 6 + i * (TITLE_PX + 4)));
    writeFileSync(file, this.canvas.toBuffer('image/png'));
  }
}

// A sheet cut into pages of `per` frames; each page keeps only its own.
function paged(frames: readonly number[], per: number, make: (frames: readonly number[]) => Sheet): Sheet[] {
  const out: Sheet[] = [];
  for (let i = 0; i < frames.length; i += per) out.push(make(frames.slice(i, i + per)));
  return out;
}

// A title with the page's number on its first line.
const pageTitle = (title: readonly string[], i: number, n: number): string[] => [`${title[0]} Page ${i + 1} of ${n}.`, ...title.slice(1)];

const BAR = 32; // the side-by-side's label bar, px
const PAIR_GAP = 8;

// The side-by-side (j −8..31): the reference's comp-NN.png scaled to the
// hero's height on the left, the hero frame on the right, labelled, into an
// MP4 and a grid. The reference frames are read where they are; the pairs go
// only to --out.
class VsRef {
  readonly missing = new Set<string>();
  readonly pairs: { o: number; c: number; j: number; ref: string }[] = [];
  private readonly dir: string;
  private readonly W: number;
  private readonly H: number;
  private readonly refW: number;
  private readonly canvas: Canvas;
  private readonly ctx: SKRSContext2D;
  private readonly video: Encoder;
  private readonly grid: Sheet;
  private readonly pages: Sheet[]; // the grid's pairs VS_PAGE a page at half size, to read whole
  private readonly cache = new Map<string, Image | null>();

  private constructor(dir: string, W: number, H: number, refW: number, frames: readonly number[], mp4: string) {
    this.dir = dir;
    this.W = W;
    this.H = H;
    this.refW = refW;
    const width = refW + PAIR_GAP + W;
    const height = BAR + H;
    this.canvas = createCanvas(width, height);
    this.ctx = this.canvas.getContext('2d');
    this.video = encoder(mp4, width, height, null);
    this.grid = new Sheet(frames, 3, Math.round(width / 3), Math.round(height / 3));
    this.pages = paged(frames, VS_PAGE, (fr) => new Sheet(fr, 2, Math.round(width / 2), Math.round(height / 2)));
  }

  // Null when the folder has none of the reference frames.
  static async open(dir: string, W: number, H: number, frames: readonly number[], mp4: string): Promise<VsRef | null> {
    const sample = ['comp-01.png', 'comp-08.png'].map((n) => join(dir, n)).find((f) => existsSync(f));
    if (!sample) return null;
    const img = await loadImage(sample);
    const refW = 2 * Math.round((img.width * H) / img.height / 2);
    return new VsRef(dir, W, H, refW, frames, mp4);
  }

  private async ref(name: string): Promise<Image | null> {
    if (!this.cache.has(name)) {
      const file = join(this.dir, name);
      this.cache.set(name, existsSync(file) ? await loadImage(file) : null);
      if (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value as string);
    }
    return this.cache.get(name) ?? null;
  }

  async add(o: number, c: number, j: number, hero: Canvas, phase: string) {
    if (j < VS_J[0] || j > VS_J[1]) return;
    const name = refName(j);
    const img = await this.ref(name);
    if (!img) {
      this.missing.add(name);
      return;
    }
    const { ctx, W, H, refW } = this;
    ctx.fillStyle = '#16141a';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(img, 0, 0, img.width, img.height, 0, BAR, refW, H);
    ctx.drawImage(hero, 0, 0, W, H, refW + PAIR_GAP, BAR, W, H);
    ctx.fillStyle = '#f4f1ea';
    ctx.font = '19px sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(`reference ${name.replace('.png', '')} (kr ${kr(j)})`, 10, BAR / 2);
    ctx.fillText(`hero f${c} j${j}: ${phase}`, refW + PAIR_GAP + 10, BAR / 2);
    const data = ctx.getImageData(0, 0, this.canvas.width, this.canvas.height).data;
    await this.video.write(data);
    const lines = [`${name.replace('.png', '')} | f${c} j${j}`, phase];
    this.grid.add(o, this.canvas, lines, BAR);
    for (const page of this.pages) page.add(o, this.canvas, lines, BAR);
    this.pairs.push({ o, c, j, ref: name });
  }

  // Writes the video, the grid to `png` and its pages to pageFile(i); returns the PNGs.
  async close(png: string, title: readonly string[], pageFile: (i: number) => string): Promise<string[]> {
    try {
      await this.video.close();
    } catch (e) {
      if (this.pairs.length > 0) throw e; // no pair at all: no video either
    }
    this.grid.save(png, title);
    const written = [png];
    this.pages.forEach((page, i) => {
      page.save(pageFile(i), pageTitle(title, i, this.pages.length));
      written.push(pageFile(i));
    });
    return written;
  }
}

// ---- Rendering -------------------------------------------------------------------------------

interface HeroFacts {
  I: number;
  P: Vec2; // clip px
  f1: number; // the limbs' start frame
  slamLimbs: Set<number>;
}

interface FrameInfo {
  c: number;
  j: number;
  phase: string;
  lines: string[];
}

const settle = (image: unknown) => {
  const c = image as { width?: number; getContext?(id: '2d'): { getImageData(x: number, y: number, w: number, h: number): unknown } } | null;
  if (c && c.getContext && (c.width ?? 0) > 0) c.getContext('2d').getImageData(0, 0, 1, 1);
};

class Renderer {
  readonly W: number;
  readonly H: number;
  readonly canvas: Canvas;
  readonly ctx: SKRSContext2D;
  private readonly plates: Plates;
  private readonly hero: HeroFacts;
  private readonly video: (clip: number) => Canvas;

  constructor(plates: Plates, hero: HeroFacts) {
    this.plates = plates;
    this.hero = hero;
    this.W = plates.width;
    this.H = plates.height;
    this.canvas = createCanvas(this.W, this.H);
    this.ctx = this.canvas.getContext('2d');
    this.video = (c) => plates.image(c);
  }

  // The jobs due over the next frames, each timed as the worker would run it
  // (to a 1 px readback of each part: the raster is lazy).
  ahead(scene: ImpactScene, o: number, log: JobTime[]) {
    for (const job of scene.jobs(o)) {
      const t0 = performance.now();
      const layer = scene.runJob(job);
      for (const part of layer.parts) settle(part.image);
      log.push({ key: job.key.split(':').slice(2).join(':'), kind: job.kind, due: job.due, at: o, ms: r2(performance.now() - t0) });
    }
  }

  // Output frame o on the frame canvas. The main thread's time is render()
  // to a 1 px readback; the plate is uploaded and the canvas cleared before.
  draw(scene: ImpactScene, o: number): { ms: number; lines: Record<string, number> } {
    const ctx = this.ctx;
    this.plates.image(scene.clipOf(o));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, this.W, this.H);
    ctx.getImageData(0, 0, 1, 1);
    const t0 = performance.now();
    scene.render(ctx as never, this.video, o);
    ctx.getImageData(0, 0, 1, 1);
    const ms = performance.now() - t0;
    // Reduce flashing's export guard (src/export/export.ts finish): no
    // saturated red pixel leaves it. After the timing: it is the export's.
    if (scene.context?.flash === 'safe') {
      const img = ctx.getImageData(0, 0, this.W, this.H);
      if (guardRed(img.data) > 0) ctx.putImageData(img, 0, 0);
    }
    return { ms, lines: scene.timings() };
  }

  // What output frame o shows, for its label. Read after draw(): the parts
  // are drawn by then, so frameLayers only lays them out again.
  info(scene: ImpactScene, o: number): FrameInfo {
    const { I, f1 } = this.hero;
    const c = scene.clipOf(o);
    const j = c - I;
    const L = scene.frameLayers(o);
    const k = drawingIndex(c, DPS);
    const phase = phaseLabel(L.phase, { age: k - drawingIndex(f1, DPS), group: j >= 9 ? massGroup(c, I, DPS) : null, poster: L.phase?.kind === 'poster' ? L.posterSpec : undefined });
    const tips = j >= TIPS_J[0] && j <= TIPS_J[1] ? this.tips(scene, c) : null;
    return { c, j, phase, lines: frameLabel({ o, c, j, k, phase, limbs: L.limbs?.kind ?? (L.phase?.kind === 'poster' ? 'silhouette' : null), tips }) };
  }

  // The slam limbs' tips' largest distance from P on clip frame c, internal px.
  tips(scene: ImpactScene, c: number): number | null {
    const fr = scene.frames3d()[c];
    if (!fr) return null;
    const { P, slamLimbs } = this.hero;
    let worst: number | null = null;
    for (const p of fr.placed) {
      if (!slamLimbs.has(p.id) || p.points.length === 0) continue;
      const tip = p.points[p.points.length - 1];
      worst = Math.max(worst ?? 0, Math.hypot(tip[0] - P[0], tip[1] - P[1]) * scene.scale);
    }
    return worst;
  }

  checkFrame(): CheckFrame {
    const img = this.ctx.getImageData(0, 0, this.W, this.H);
    return downsampleFrame({ data: img.data, width: this.W, height: this.H });
  }
}

interface PassSinks {
  name: string;
  encoder: Encoder | null;
  sheets: Sheet[];
  vs: VsRef | null;
  timing: { frames: FrameTime[]; jobs: JobTime[]; readback: number[] } | null;
}

// Renders `frames` in order into the sinks; returns each frame's flash-check copy.
async function renderPass(r: Renderer, scene: ImpactScene, frames: readonly number[], sinks: PassSinks): Promise<Map<number, CheckFrame>> {
  const checks = new Map<number, CheckFrame>();
  const t0 = performance.now();
  if (sinks.timing && frames.length > 0) r.ahead(scene, frames[0] - 1, sinks.timing.jobs);
  for (const [i, o] of frames.entries()) {
    if (sinks.timing) r.ahead(scene, o, sinks.timing.jobs);
    const { ms, lines } = r.draw(scene, o);
    const tr = performance.now();
    const img = r.ctx.getImageData(0, 0, r.W, r.H);
    const readMs = performance.now() - tr;
    checks.set(o, downsampleFrame({ data: img.data, width: r.W, height: r.H }));
    const info = r.info(scene, o);
    if (sinks.timing) {
      sinks.timing.frames.push({ o, clip: info.c, j: info.j, ms: r2(ms), lines: Object.fromEntries(Object.entries(lines).map(([k, v]) => [k, r2(v)])) });
      sinks.timing.readback.push(readMs);
    }
    if (sinks.encoder) await sinks.encoder.write(img.data);
    for (const sheet of sinks.sheets) sheet.add(o, r.canvas, info.lines);
    if (sinks.vs) await sinks.vs.add(o, info.c, info.j, r.canvas, info.phase);
    if ((i + 1) % 20 === 0 || i === frames.length - 1) log(`  ${sinks.name}: ${i + 1}/${frames.length} frames, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  }
  return checks;
}

function log(line: string) {
  process.stdout.write(`${line}\n`);
}

const range = (a: number, b: number): number[] => Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i);

function memo<T>(cache: Map<number, T>, f: number, make: () => T): T {
  if (cache.has(f)) return cache.get(f) as T;
  const v = make();
  cache.set(f, v);
  return v;
}

function unitNear(units: readonly (number | null)[], f: number): number | null {
  for (let d = 0; d < units.length; d++) {
    const found = units[f - d] ?? units[f + d];
    if (found != null) return found;
  }
  return null;
}

// The cached SAM run `name` for this clip: next to the clip, else in
// fixtures/probe, whichever was made from these bytes.
async function cachedMasks(clip: string, name: string, sha: string, frames: number): Promise<{ masks: (SamMask | null)[]; file: string }> {
  const tried: string[] = [];
  for (const file of [join(dirname(clip), name), join(REPO, 'fixtures', 'probe', name)]) {
    if (!existsSync(file) || tried.includes(file)) continue;
    tried.push(file);
    const json: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (readSamCache(json).clipSha256 !== sha) continue;
    return { masks: await masksFromCache(json, frames), file };
  }
  throw new Error(`no cached ${name} for this clip (sha256 ${sha.slice(0, 12)}…) next to it or in fixtures/probe${tried.length ? ` (${tried.join(', ')} are another clip's)` : ''}; the render reads cached SAM runs only`);
}

function standIn(frames: number): { bodies: (PointSet | null)[]; skeleton: (PointSet | null)[]; file: string } | null {
  const file = process.env.INKWELL_HERO_POSE ?? join(REPO, 'samples', 'hero', 'pose.json');
  if (!existsSync(file)) return null;
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(raw)) throw new Error(`${file} is not a stand-in pose (an array of frames)`);
  return { bodies: Array.from({ length: frames }, (_, f) => standInPoints(raw[f])), skeleton: Array.from({ length: frames }, (_, f) => skeletonPoints(raw[f])), file };
}

function derive(d: HeroDrawings, person: (SamMask | null)[], S: number): DrawnMoments {
  return momentsFromDrawings({
    limbs: d.start.strokes.map((s) => ({ id: s.id, points: s.points })),
    f1: d.start.frame,
    cracks: d.end.strokes.map((s) => ({ id: s.id, points: s.points })),
    fDrawn: d.end.frame,
    masks: person,
    S,
    seed: d.seed,
  });
}

// ---- Main ------------------------------------------------------------------------------------

export async function main(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  if (!args.out || !args.clip || !args.drawings) throw new Error(USAGE);
  if (args.positional.length > 0) throw new Error(`unexpected ${args.positional.join(' ')}\n${USAGE}`);
  const outDir = assertOutsideRepo(args.out, REPO);
  const clipPath = resolve(args.clip);
  if (!existsSync(clipPath)) throw new Error(`no clip at ${clipPath}`);
  const refDir = args.ref ? resolve(args.ref) : null;
  if (refDir && !existsSync(refDir)) throw new Error(`no reference frames at ${refDir}`);
  const [first, last] = args.frames ?? DEFAULT_FRAMES;
  const tier = args.tier ?? 'full';
  const portrait = args.portrait;
  const modes: ('full' | 'safe')[] = args.flash ? [args.flash] : ['full', 'safe'];
  const file = (base: string, ext: string) => join(outDir, outName(base, ext, portrait));
  const started = performance.now();

  // The clip, its masks, the stand-in and the drawings.
  const info = probeVideo(clipPath);
  if (Math.abs(info.fps - FPS) > 0.01) throw new Error(`the clip runs at ${info.fps} fps; the impact scene runs at 30`);
  if (last >= info.frames) throw new Error(`--frames ${first}-${last} runs past the clip's ${info.frames} frames`);
  if (args.tap !== undefined && args.tap >= info.frames) throw new Error(`--tap ${args.tap} is past the clip's ${info.frames} frames`);
  const audio = probeAudio(clipPath);
  const sha = createHash('sha256').update(readFileSync(clipPath)).digest('hex');
  const personRun = await cachedMasks(clipPath, 'sam-person.json', sha, info.frames);
  const faceRun = await cachedMasks(clipPath, 'sam-face.json', sha, info.frames);
  const pose = standIn(info.frames);
  const drawn = readDrawings(JSON.parse(readFileSync(resolve(args.drawings), 'utf8')));
  if (drawn.size && (drawn.size[0] !== info.width || drawn.size[1] !== info.height)) throw new Error(`the drawings are for a ${drawn.size[0]}×${drawn.size[1]} clip; this one is ${info.width}×${info.height}`);
  log(`clip ${basename(clipPath)} ${info.width}×${info.height}, ${info.frames} frames${audio ? '' : ', no audio'}; stand-in ${pose ? basename(pose.file) : 'missing'}`);

  // The derivation on the whole frame; --portrait then crops round his box at I.
  const H0 = info.height;
  let W0 = info.width;
  let person = personRun.masks;
  let face = faceRun.masks;
  let bodies = pose?.bodies ?? null;
  let skeleton = pose?.skeleton ?? null;
  let drawings = drawn;
  let moments = derive(drawings, person, Math.min(W0, H0));
  let crop: number | null = null;
  if (portrait) {
    if (H0 >= W0) throw new Error('--portrait crops a 9:16 window out of a landscape clip; this clip is already portrait');
    const width = portraitWidth(H0);
    const I0 = moments.snap.frame;
    const box = samBox(person[I0]) ?? person.map(samBox).find((b) => b !== null) ?? { left: W0 / 2, right: W0 / 2 };
    crop = cropLeft(box, W0, width);
    const x0 = crop;
    person = person.map((m) => (m ? cropSamMask(m, x0, width) : null));
    face = face.map((m) => (m ? cropSamMask(m, x0, width) : null));
    bodies = bodies && shiftBodies(bodies, -x0);
    skeleton = skeleton && shiftBodies(skeleton, -x0);
    drawings = shiftDrawings(drawn, -x0);
    W0 = width;
    moments = derive(drawings, person, Math.min(W0, H0));
    log(`portrait: the ${width}×${H0} window from x ${x0}, centred on his box on f${I0}`);
  }
  const CW = W0;
  const CH = H0;
  const f1 = drawings.start.frame;
  const units = torsoHeights(frameMasks(person, CW, CH), CW, CH);
  const b1 = bodies?.[f1] ?? null;
  const standHips: Vec2 | null = b1 ? [(b1.x[13] + b1.x[14]) / 2, (b1.y[13] + b1.y[14]) / 2] : null; // CORE's hips: MediaPipe's 23 and 24
  const box1 = samBox(person[f1]);
  const hips = drawings.start.hips ?? standHips ?? (box1 ? ([(box1.left + box1.right) / 2, (box1.top + box1.bottom) / 2] as Vec2) : null);
  if (!hips) throw new Error(`no anchor for the limbs on f${f1}: no hips in the drawings, no stand-in and no person mask there`);
  const poses: Pose[] | null = trackPoses(person, { frame: f1, xy: hips }, FPS);
  if (!poses) throw new Error(`no anchor track from f${f1}: the person masks don't follow him`);
  const at = anchorTransform(poses[f1], unitNear(units, f1) ?? 0.25 * CH);

  // The internal frame and the clip as the scene reads it. The person masks
  // are cut at the internal size (at most 1080 on the long side), the face
  // masks at a quarter of the clip's, as the app's.
  const size = args.scale ? Math.round(Math.max(CW, CH) * args.scale) : FIELD;
  const cuts = cutsAt(tierCuts(tier));
  const { W, H } = internalSize(CW, CH, size, cuts.resolution);
  const maskStep = Math.max(CW / W, Math.max(CW, CH) / FIELD);
  const personFm = new Map<number, Mask | null>();
  const faceFm = new Map<number, Mask | null>();
  const personMasks = person;
  const faceMasks = face;
  let plates: Plates | null = null;
  const clip: ImpactClip = {
    width: CW,
    height: CH,
    frames: info.frames,
    personMask: (f) =>
      memo(personFm, f, () => {
        const m = personMasks[f];
        return m ? toFrameMask(m, CW, CH, maskStep) : null;
      }),
    faceMask: (f) =>
      memo(faceFm, f, () => {
        const m = faceMasks[f];
        return m ? toFrameMask(m, CW, CH, 4) : null;
      }),
    poses,
    bodies,
    skeleton,
    units,
    luma: (f) => {
      const rgba = plates?.rgba(f) ?? null;
      return rgba ? plateLuma({ data: rgba, width: W, height: H }, W / CW) : null;
    },
    audio: audio ?? undefined,
  };

  // The turn: decided on the first scene made (decision 4).
  const plan = turnPlan(args.tap);
  let turn = plan.turn;
  const opts: SceneOptions = { tier, make: nodeScratch, size, clock: () => performance.now(), ...(plan.check ? { turn: plan.check } : {}) };
  const effectOf = (flash: 'safe' | 'full') => heroEffect({ drawings, moments, at, flash, turn, clipWidth: CW });
  let firstScene = createImpactScene(effectOf(modes[0]), clip, opts);
  let read = firstScene.turn();
  let fallback = false;
  if (read.from === 'none' && !turn) {
    turn = handTurn();
    fallback = true;
    firstScene = createImpactScene(effectOf(modes[0]), clip, opts);
    read = firstScene.turn();
  }
  if (firstScene.width !== W || firstScene.height !== H) throw new Error(`the scene renders at ${firstScene.width}×${firstScene.height}, not the ${W}×${H} worked out here`);
  const ctx = firstScene.context;
  if (!ctx) throw new Error('the effect has no slam');
  const I = ctx.I;
  const P = moments.slam.xy;
  const good = bodies ? goodStandIns(bodies, { mask: (f) => clip.personMask(f), width: CW, height: CH }) : undefined;
  const poseKeys = bodies ? turnKeys(undefined, bodies, FPS, good).keys : [];
  const turnJson = { ...turnReport({ read, pose: poseKeys, frames: range(first, last) }), handKeysGiven: fallback };
  const turnText =
    turnJson.used === 'pose'
      ? `read from the pose, ${turnJson.automatic?.error}° from the hand keys`
      : turnJson.used === 'hand'
        ? `the hand keys (the pose ${turnJson.automatic ? `reads ${turnJson.automatic.error}° off them` : 'reads no turn'})`
        : turnJson.used === 'tap'
          ? `tap at f${args.tap}, ${turnJson.maxError}° from the hand keys`
          : 'none';
  log(`I f${I}${moments.snap.moved ? ` (drawn on f${moments.snap.drawnOn})` : ''}, P (${P.map((v) => v.toFixed(1)).join(', ')}), d (${moments.strike.dir.map((v) => v.toFixed(3)).join(', ')}) by ${moments.strike.by}; turn: ${turnText}; ${W}×${H}, tier ${tier}`);
  for (const p of moments.problems) log(`  problem: ${p}`);

  const sizeText = `${basename(clipPath)} ${info.width}×${info.height}${crop !== null ? `, portrait window x ${crop}–${crop + CW}` : ''}, rendered at ${W}×${H}, tier ${tier} (cuts ${firstScene.cuts.n})`;
  const facts = `limbs drawn on f${f1}, impact drawn on f${drawings.end.frame}, contact I f${I}; P (${P.map((v) => v.toFixed(1)).join(', ')}), d (${moments.strike.dir.map((v) => v.toFixed(3)).join(', ')}); sigma ${ctx.frame.sigma.toFixed(3)}, U ${(ctx.frame.U / firstScene.scale).toFixed(0)} clip px, J_end ${ctx.jEnd}, h ${ctx.frame.h}`;
  const title = (what: string, flash: string) => [`Inkwell hero render (WP14): ${what}. ${sizeText}`, facts, `turn: ${turnText}. Flash check: ${flash}`];
  const hero: HeroFacts = { I, P: [P[0], P[1]], f1, slamLimbs: new Set(moments.slam.limbs ?? []) };

  // Effects and the derivation.
  mkdirSync(outDir, { recursive: true });
  const effects: Record<'full' | 'safe', Effect> = { full: effectOf('full'), safe: effectOf('safe') };
  for (const flash of ['full', 'safe'] as const) {
    const text = serializeEffect(effects[flash]);
    const parsed = parseEffect(text);
    if ('problems' in parsed) throw new Error(`the derived effect doesn't parse: ${parsed.problems.join('; ')}`);
    writeFileSync(file(flash === 'full' ? 'effect' : 'effect-reduced', 'json'), text);
  }
  const offFacts = Math.hypot(P[0] - (HERO_FACTS.P[0] - (crop ?? 0)), P[1] - HERO_FACTS.P[1]);
  writeFileSync(
    file('moments', 'json'),
    `${JSON.stringify(
      {
        note: 'what momentsFromDrawings derived from the two drawings (WP1), and the scene context the slam renders with (WP12); clip px, of the portrait window with --portrait',
        drawn: { limbs: f1, impact: drawings.end.frame },
        snap: moments.snap,
        I,
        P,
        Pdrawn: moments.point.drawn,
        pFrom: moments.point.from,
        snapped: moments.point.snapped,
        ends: moments.point.ends,
        d: moments.strike.dir,
        dBy: moments.strike.by,
        problems: moments.problems,
        decision10: { ...HERO_FACTS, Pshift: crop ?? 0, offPx: r2(offFacts) },
        context: { seed: ctx.seed, S: ctx.frame.S, sigma: r2(ctx.frame.sigma * 1000) / 1000, U: r2(ctx.frame.U), h: ctx.frame.h, u: ctx.frame.u, jEnd: ctx.jEnd, posters: ctx.posters, crackEase: ctx.crackEase, floor: ctx.floor },
        anchor: { frame: f1, hips, unit: r2(at.unit) },
        internal: { width: W, height: H, scale: firstScene.scale, crop },
        sources: { person: personRun.file, face: faceRun.file, standIn: pose?.file ?? null, clipSha256: sha },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(file('turn', 'json'), `${JSON.stringify(turnJson, null, 2)}\n`);

  // The clip's frames, once, at the internal size.
  const work = join(outDir, `.impact-render-${process.pid}`);
  mkdirSync(work, { recursive: true });
  const outputs: string[] = [];
  const flashJson: Record<string, unknown> = { check: 'WCAG 2.3.1 general and red flashes, area based (src/export/flash.ts), on every output frame copied down to 160 px wide; it passes with at most 3 general flashes and no red flash in any second', fps: FPS };
  let timingJson: Record<string, unknown> | null = null;
  let reducedError: string | null = null;
  try {
    const n = Math.min(info.frames, last + 5);
    const raw = join(work, `clip-${W}x${H}.rgb`);
    const t0 = performance.now();
    extractFrames(clipPath, raw, n, W, H, crop === null ? null : { x: crop, width: CW, height: CH });
    plates = new Plates(raw, W, H, n);
    log(`read ${n} clip frames at ${W}×${H} in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    const r = new Renderer(plates, hero);
    const sheetCols = W >= H ? 8 : 12;
    const stripCols = W >= H ? 10 : 14;
    const sheetFor = (frames: readonly number[]) => new Sheet(frames.filter((o) => (o - frames[0]) % SHEET_EVERY === 0), sheetCols, Math.round(W / 3), Math.round(H / 3));
    const stripFor = (scene: ImpactScene, frames: readonly number[]) => new Sheet(frames.filter((o) => scene.clipOf(o) >= STRIP[0] && scene.clipOf(o) <= STRIP[1]), stripCols, Math.round(W / 4), Math.round(H / 4));
    // The close-up: every frame from I − 8 to I + 24, its window at 1:1; the first pass also cuts it into pages.
    const closeWin = closeWindow(W, H, [P[0] * firstScene.scale, P[1] * firstScene.scale]);
    const closeFrames = (scene: ImpactScene, frames: readonly number[]) => frames.filter((o) => scene.clipOf(o) - I >= CLOSE_J[0] && scene.clipOf(o) - I <= CLOSE_J[1]);
    const closeFor = (scene: ImpactScene, frames: readonly number[]) => new Sheet(closeFrames(scene, frames), W >= H ? 6 : 10, closeWin.w, closeWin.h, closeWin);
    const closePagesFor = (scene: ImpactScene, frames: readonly number[]) => paged(closeFrames(scene, frames), CLOSE_PAGE, (fr) => new Sheet(fr, W >= H ? 3 : 5, closeWin.w, closeWin.h, closeWin));
    const closeAbout = `every frame from I${CLOSE_J[0]} to I+${CLOSE_J[1]} close up: the ${closeWin.w}×${closeWin.h} window at (${closeWin.x}, ${closeWin.y}), 1:1, ${CLOSE_ZOOM}× about mix(frame centre, P, 0.5)`;
    const saveClose = (close: Sheet, pages: readonly Sheet[], base: string, what: string, verdict: string) => {
      if (close.size === 0) return;
      close.save(file(base, 'png'), title(`${what}, ${closeAbout}`, verdict));
      outputs.push(file(base, 'png'));
      pages.forEach((page, i) => {
        page.save(file(`${base}-p${i + 1}`, 'png'), pageTitle(title(`${what}, ${closeAbout}`, verdict), i, pages.length));
        outputs.push(file(`${base}-p${i + 1}`, 'png'));
      });
    };
    const audioFor = (a: number, b: number, freeze: boolean) => (audio ? { clip: clipPath, filter: audioFilter(audioSegments(a, b, I, freeze), audio.rate, audio.layout) } : null);
    const timing = { frames: [] as FrameTime[], jobs: [] as JobTime[], readback: [] as number[] };
    let vsDone = false;
    let timed = false;
    let paging = true;

    // One pass with everything that comes off the first render: the side-by-side, the close-up's pages and the timing.
    const firstPass = async (scene: ImpactScene, mp4: string, sheetName: string, stripName: string, what: string, name: string) => {
      const frames = range(first, last);
      const vsFrames = frames.filter((o) => scene.clipOf(o) - I >= VS_J[0] && scene.clipOf(o) - I <= VS_J[1]);
      const vs = !vsDone && refDir && vsFrames.length > 0 ? await VsRef.open(refDir, W, H, vsFrames, file('impact-vs-ref', 'mp4')) : null;
      if (!vsDone && refDir && !vs) log(`  no comp-NN.png in ${refDir}: no side-by-side`);
      const sheet = sheetFor(frames);
      const strip = stripFor(scene, frames);
      const close = closeFor(scene, frames);
      const pages = paging ? closePagesFor(scene, frames) : [];
      paging = false;
      const enc = encoder(mp4, W, H, audioFor(first, last, false));
      const checks = await renderPass(r, scene, frames, { name, encoder: enc, sheets: [sheet, strip, close, ...pages], vs, timing: timed ? null : timing });
      await enc.close();
      if (vs) {
        const vsTitle = [`Inkwell hero render (WP14) beside the reference, j ${VS_J[0]}..${VS_J[1]}: left comp-NN.png (NN = kr(j) + 1), right the hero, ${what}`, facts, vs.missing.size ? `missing: ${[...vs.missing].join(', ')}` : `${vs.pairs.length} pairs`];
        const pngs = await vs.close(file('impact-vs-ref', 'png'), vsTitle, (i) => file(`impact-vs-ref-p${i + 1}`, 'png'));
        outputs.push(file('impact-vs-ref', 'mp4'), ...pngs);
        vsDone = true;
      }
      timed = true;
      return { checks, sheet, strip, close, pages, sheetName, stripName };
    };

    // Full impact frames: the check only warns (decision 5).
    if (modes.includes('full')) {
      const scene = modes[0] === 'full' ? firstScene : createImpactScene(effects.full, clip, opts);
      log('full impact frames (the default):');
      const pass = await firstPass(scene, file('impact-hero', 'mp4'), 'impact-hero-sheet', 'impact-hero-slam', 'full impact frames', 'full');
      outputs.push(file('impact-hero', 'mp4'));
      const report = atFrames(checkFlashes(pass.checks.values(), FPS), first);
      const verdict = report.pass ? flashSummary(report) : `warns: ${flashSummary(report)}`;
      for (const [sheet, base] of [[pass.sheet, pass.sheetName], [pass.strip, pass.stripName]] as const) {
        sheet.save(file(base, 'png'), title(`full impact frames (the default)${base.endsWith('slam') ? `, every frame on clip f${STRIP[0]}–${STRIP[1]}` : `, every ${SHEET_EVERY}th frame`}`, verdict));
        outputs.push(file(base, 'png'));
      }
      saveClose(pass.close, pass.pages, 'impact-hero-closeup', 'full impact frames (the default)', verdict);
      flashJson.full = { video: outName('impact-hero', 'mp4', portrait), mode: 'full', warning: report.pass ? null : flashSummary(report), ...flashBrief(report) };
      log(`  flash check: ${flashSummary(report)}`);
    }

    // Reduce flashing: the ladder, re-rendering only what each step touches.
    if (modes.includes('safe')) {
      const base = modes[0] === 'safe' ? firstScene : createImpactScene(effects.safe, clip, opts);
      const mp4 = file('impact-hero-reduced', 'mp4');
      log('Reduce flashing:');
      const pass0 = await firstPass(base, mp4, 'impact-hero-reduced-sheet', 'impact-hero-reduced-slam', 'Reduce flashing', 'reduced, step 0');
      const report0 = atFrames(checkFlashes(pass0.checks.values(), FPS), first);
      const rows: Record<string, unknown>[] = [{ step: 0, name: 'none', rendered: pass0.checks.size, ...pick(report0) }];
      log(`  step 0: ${flashSummary(report0)}`);
      let prev = pass0.checks;
      const walk = walkLadder('safe', (step) => {
        if (step === 0) return report0;
        const sc = base.degraded(step);
        const [a, b] = outputWindow(first, last, I, sc.degrade.freeze);
        const touched = touchedFrames(step, I, sc.outputLength());
        const checks = new Map<number, CheckFrame>();
        let rendered = 0;
        for (let o = a; o <= b; o++) {
          const kept = o >= touched.from && o < touched.to ? undefined : prev.get(o);
          if (kept) {
            checks.set(o, kept);
            continue;
          }
          r.draw(sc, o);
          checks.set(o, r.checkFrame());
          rendered++;
        }
        prev = checks;
        const report = atFrames(checkFlashes(checks.values(), FPS), a);
        const ladder = LADDER[step - 1];
        rows.push({ step, name: ladder.name, what: ladder.what, rendered, ...pick(report) });
        log(`  step ${step} (${ladder.name}, ${rendered} frames re-rendered): ${flashSummary(report)}`);
        return report;
      });
      let sheets = { sheet: pass0.sheet, strip: pass0.strip, close: pass0.close, pages: pass0.pages };
      let window: [number, number] = [first, last];
      if (walk.pass && walk.step > 0) {
        // The passing step's render, in full, over the step-0 one.
        const sc = base.degraded(walk.step);
        window = outputWindow(first, last, I, sc.degrade.freeze);
        const frames = range(window[0], window[1]);
        sheets = { sheet: sheetFor(frames), strip: stripFor(sc, frames), close: closeFor(sc, frames), pages: pass0.pages.length > 0 ? closePagesFor(sc, frames) : [] };
        const enc = encoder(mp4, W, H, audioFor(window[0], window[1], sc.degrade.freeze));
        await renderPass(r, sc, frames, { name: `reduced, step ${walk.step}`, encoder: enc, sheets: [sheets.sheet, sheets.strip, sheets.close, ...sheets.pages], vs: null, timing: null });
        await enc.close();
      }
      let error: string | null = null;
      // The step-0 render kept for review when every step fails, under a name that says so.
      const reviewBase = 'impact-hero-reduced-failed-check';
      const failedFiles = [file(reviewBase, 'mp4'), ...['sheet', 'slam', 'closeup'].map((s) => file(`${reviewBase}-${s}`, 'png'))];
      if (walk.pass) {
        const what = `Reduce flashing, ladder step ${walk.step}${walk.step > 0 ? ` (${LADDER[walk.step - 1].name})` : ''}`;
        sheets.sheet.save(file('impact-hero-reduced-sheet', 'png'), title(`${what}, every ${SHEET_EVERY}th frame`, flashSummary(walk.report)));
        sheets.strip.save(file('impact-hero-reduced-slam', 'png'), title(`${what}, every frame on clip f${STRIP[0]}–${STRIP[1]}`, flashSummary(walk.report)));
        outputs.push(mp4, file('impact-hero-reduced-sheet', 'png'), file('impact-hero-reduced-slam', 'png'));
        saveClose(sheets.close, sheets.pages, 'impact-hero-reduced-closeup', what, flashSummary(walk.report));
        for (const f of failedFiles) rmSync(f, { force: true }); // an earlier run's
      } else {
        error = new FlashCheckError(walk.report).message;
        reducedError = error;
        // No impact-hero-reduced.mp4: the app's export saves no file here
        // (decision 5). What the preview shows with the toggle on (step 0) is
        // kept for review only.
        const review = failedFiles[0];
        rmSync(review, { force: true });
        renameSync(mp4, review);
        for (const f of ['sheet', 'slam', 'closeup'].map((s) => file(`impact-hero-reduced-${s}`, 'png'))) rmSync(f, { force: true }); // an earlier run's
        const what = 'Reduce flashing as the preview shows it (ladder step 0). It FAILS the flash check at every ladder step, so the export saves no file (FlashCheckError): for review only';
        const verdict = `fails. Step 0: ${flashSummary(report0)} Step ${walk.step}: ${flashSummary(walk.report)}`;
        sheets.sheet.save(file(`${reviewBase}-sheet`, 'png'), title(`${what}, every ${SHEET_EVERY}th frame`, verdict));
        sheets.strip.save(file(`${reviewBase}-slam`, 'png'), title(`${what}, every frame on clip f${STRIP[0]}–${STRIP[1]}`, verdict));
        outputs.push(review, file(`${reviewBase}-sheet`, 'png'), file(`${reviewBase}-slam`, 'png'));
        saveClose(sheets.close, sheets.pages, `${reviewBase}-closeup`, what, verdict);
        log(`  FlashCheckError: ${error} There is no ${outName('impact-hero-reduced', 'mp4', portrait)}; the step-0 render is kept for review as ${basename(review)}.`);
      }
      flashJson.reduced = {
        video: walk.pass ? outName('impact-hero-reduced', 'mp4', portrait) : null,
        reviewVideo: walk.pass ? null : outName(reviewBase, 'mp4', portrait),
        reviewNote: walk.pass ? null : 'every ladder step fails, so the export would save no file (FlashCheckError); this is the step-0 render (what the preview shows with Reduce flashing on), kept for review only',
        mode: 'safe',
        step: walk.step,
        stepName: walk.step > 0 ? LADDER[walk.step - 1].name : null,
        outputFrames: window,
        ladder: rows,
        error,
        ...flashBrief(walk.report),
        step0: walk.step > 0 ? { note: 'the gentle plan as the preview shows it, before the ladder', ...flashBrief(report0) } : null,
      };
    }

    // Timing: the first pass's main thread and jobs.
    const physics = firstScene.timings().physics ?? 0;
    timingJson = {
      note: 'the Node proxy (@napi-rs/canvas, one process) at the internal size. Each job is timed alone, as the worker runs it, before the frames that need it; each frame is render() to a 1 px readback (the raster is lazy), after its plate is uploaded. The full-frame readback for the encoder and the flash check is outside the frame. The tiers are Node-timed (WP12); the iPhone run of the device gate is pending (decision 9).',
      pass: modes[0] === 'full' ? 'full' : 'reduced, step 0',
      size: [W, H],
      tier,
      cuts: firstScene.cuts.n,
      physics: { msPerFrame: r2(physics), frames: info.frames, note: 'the lift, the turn and the strike controller, run once for the whole clip' },
      deviceGate: { ...DEVICE_GATE, note: 'Qai’s iPhone run is pending (decision 9)' },
      ...timingSummary(timing.frames, timing.jobs, I),
      segmentsNote: 'ms a frame for each part of the shot: main is the main thread a frame; jobs are the drawings due on the part’s frames, by kind, each drawn once and then held (limbs on 12 a second, posters 1–2 frames, masses by group); withDrawings is a frame’s main thread plus the drawings due on it, and its mean is the part’s average ms a frame with every drawing counted. Physics (above) is apart.',
      segments: segmentTimes(timing.frames, timing.jobs, shotSpans(first, last, f1, I)),
      readback: stats(timing.readback),
      frames: timing.frames,
      eachJob: timing.jobs,
    };
    writeFileSync(file('timing', 'json'), `${JSON.stringify(timingJson, null, 2)}\n`);
    writeFileSync(file('flash', 'json'), `${JSON.stringify(flashJson, null, 2)}\n`);
  } finally {
    plates?.close();
    rmSync(work, { recursive: true, force: true });
  }

  const tm = timingJson as { main?: { worstFrame: { o: number; ms: number } | null; median: number }; segments?: ReturnType<typeof segmentTimes> } | null;
  log(`done in ${((performance.now() - started) / 1000).toFixed(0)} s:`);
  for (const f of [...outputs, ...['effect', 'effect-reduced', 'moments', 'timing', 'flash', 'turn'].map((b) => file(b, 'json'))]) log(`  ${f}`);
  if (tm?.main?.worstFrame) log(`main thread: worst ${tm.main.worstFrame.ms} ms (o${tm.main.worstFrame.o}), median ${tm.main.median} ms, budget ${MAIN_BUDGET} ms`);
  for (const sg of tm?.segments ?? []) {
    const jobs = Object.entries(sg.jobs).map(([k, s]) => `${s.n} ${k} drawings median ${s.median} ms, worst ${s.worst}`);
    log(`  ${sg.name} f${sg.clip[0]}–${sg.clip[1]}: main median ${sg.main.median} ms, worst ${sg.main.worst}; ${jobs.length ? `${jobs.join('; ')}; ` : ''}with the drawings ${sg.withDrawings.mean} ms a frame on average, worst ${sg.withDrawings.worst}`);
  }
  log(`turn: ${turnText}`);
  // Reduce flashing enforces the check (decision 5): the run fails without its MP4.
  if (reducedError) throw new Error(`Reduce flashing failed the flash check at every ladder step, so there is no ${outName('impact-hero-reduced', 'mp4', portrait)} (FlashCheckError: ${reducedError} See flash.json.) Its step-0 render is kept for review as ${outName('impact-hero-reduced-failed-check', 'mp4', portrait)}; the other outputs are written.`);
}

const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
if (process.argv[1] && fold(resolve(process.argv[1])) === fold(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}
