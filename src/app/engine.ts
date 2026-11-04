// The app's strokes on the engine (SPEC §8). A drawn stroke is resampled to
// 32 points and stored in torso space around its root, as it was on the frame
// it was drawn on; tracking moves that root on every other frame. The whole
// clip is then animated at once (src/motion/animate.ts): the physics runs
// underneath, and the drawings are held on 2s or 3s with the boil on top.
// The preview and the export both draw from the result, so they match.
//
// The impact (impact design §1, §10; WP13). Limb strokes (the 'limb' brush)
// and ground strokes (the impact's cracks, in fixed frame px) belong to the
// impact scene (impact/scene.ts), which lifts, lights and slams them. Once
// the effect has limbs or a slam, the page draws the whole frame through it,
// with the other strokes animated here and scaled onto its internal frame.
// effectOf writes the flow's emerge and slam moments and his turn tap
// (flow.ts), with the floor read from him on the slam (withFloor), and the
// clip's sound is read once into the 10 ms envelope that the impact sheet's
// cue reads (detect.ts).
import type { Anchor, BrushId, Effect, Stroke as EffectStroke, Turn, Vec2 } from '../types/effect.ts';
import { animate } from '../motion/animate.ts';
import type { BodyAngle } from '../motion/body.ts';
import type { BoilParams } from '../motion/boil.ts';
import { emergeAges } from '../motion/moments.ts';
import type { Timing } from '../motion/timing.ts';
import { DEFAULT_BRUSH, resampleStroke, type Point } from '../render/brush.ts';
import { brushSettings, drawBrushStroke, LIMB_BRUSH, type BrushTarget, type MakeScratch } from '../render/brushes.ts';
import { anchorTransform, toTorso, type TorsoTransform } from '../track/torso.ts';
import { maskNear, type Mask, type PointSet, type Pose } from '../track/tracking.ts';
import { toFrameMask, type SamMask } from '../sam/cache.ts';
import type { Tier } from '../impact/contracts.ts';
import type { FloorEstimate } from '../impact/floor-estimate.ts';
import { createImpactScene, type ImpactClip, type ImpactScene, type SceneOptions } from '../impact/scene.ts';

// One line as drawn, in clip pixels. Its first point is its root, the end
// that gets attached to the body.
export type Stroke = {
  id: number;
  color: string;
  brush: BrushId;
  size: number; // ink brush diameter at full pressure, clip px; the other brushes scale from it
  frame: number; // the frame it was drawn on
  pen: boolean; // real pen pressure; a mouse gets an even 0.5
  layer: 'front' | 'behind'; // in front of the person, or tucked behind them
  kind: 'strand' | 'rigid';
  stiffness: number; // strands: 0 = rope ... 1 = stiff
  points: Point[];
  // From the plan (src/plan) or a tap on it; until then the root is a point
  // on the person, at the chest, boiling fully. The impact's strokes are
  // ground-anchored: fixed frame px, they never move.
  anchor?: Anchor;
  bodyAngle?: number;
  wobble?: number; // 0..1, scales the boil
};

// The app's three inks, in effect palette order.
export const PALETTE: Effect['palette'] = ['#e8203a', '#f4f1ea', '#16141a'];

// A stroke as it appears on one frame, in clip pixels.
export type DrawnStroke = {
  id: number;
  points: [number, number][];
  pressure: number[];
  layer: 'front' | 'behind';
  color: string;
  brush: BrushId;
  size: number; // px on this frame: the drawn size, scaled with the body
  k: number; // drawing index: the neon flicker changes with it
  emerge?: number; // drawings since its emerge moment (negative: not out yet); missing = always out
};

export interface ClipMotion {
  frameCount: number;
  width: number;
  height: number;
  // The tracked pose of a stroke's root on every frame, relative to the frame
  // it was drawn on; null when there's no tracking.
  poses(stroke: Stroke): Pose[] | null;
  units: (number | null)[] | null; // torso height on each frame, from the person masks
  timing: Timing;
  wobble: boolean; // boil on or off
  // His facing and bend on each frame (motion/body.ts): every stroke's target
  // turns with it, the way §8.5's single view does. Missing = upright, facing
  // the camera.
  body?: ((frame: number) => BodyAngle | null) | null;
  // The impact flow's (flow.ts): the limbs' emerge and the slam, and his turn
  // tap. Missing = none.
  moments?: Effect['moments'];
  turn?: Turn | null;
}

// Without masks there's no torso to measure, so assume a person about 70% of
// the frame tall (torso = 0.35 of that, SPEC §8.1). It sets how hard gravity
// pulls, in pixels.
const DEFAULT_TORSO_SHARE = 0.25;
// A ground stroke's torso space is the frame itself: its points are frame px.
const GROUND: TorsoTransform = { x: 0, y: 0, angle: 0, unit: 1 };

// Every frame's strokes, for the whole clip.
export function animateStrokes(strokes: Stroke[], m: ClipMotion): DrawnStroke[][] {
  if (strokes.length === 0) return Array.from({ length: m.frameCount }, () => []);
  const ground = strokes.filter(isGround);
  if (m.body && ground.length > 0 && ground.length < strokes.length) {
    // Ground strokes never turn with him: they're animated apart, and each
    // frame is put back in drawing order.
    const fixed = animateStrokes(ground, m);
    const order = new Map(strokes.map((stroke, i) => [stroke.id, i]));
    return animateStrokes(strokes.filter((s) => !isGround(s)), m).map((frame, f) => [...frame, ...fixed[f]].sort((a, b) => order.get(a.id)! - order.get(b.id)!));
  }
  const anchors = new Map(strokes.map((stroke) => [stroke.id, anchorFor(stroke, m)]));
  const effect = effectOf(strokes, m, anchors);
  const byId = new Map(strokes.map((stroke) => [stroke.id, stroke]));
  const frames = animate({
    effect,
    frames: m.frameCount,
    anchor: (id, f) => anchors.get(id)!(f),
    width: m.width,
    boil: m.timing.boil,
    body: ground.length === 0 ? (m.body ?? undefined) : undefined,
  });
  const emerging = (effect.moments ?? []).some((moment) => moment.kind === 'emerge');
  return frames.map((frame) => {
    const ages = emerging ? emergeAges(effect, frame.k) : null;
    return frame.placed.map((placed) => {
      const stroke = byId.get(placed.id)!;
      const grown = anchors.get(placed.id)!(frame.f).unit / anchors.get(placed.id)!(stroke.frame).unit;
      const drawn: DrawnStroke = {
        id: placed.id,
        points: placed.points,
        pressure: placed.pressure,
        layer: placed.layer,
        color: stroke.color,
        brush: stroke.brush,
        size: stroke.size * grown,
        k: frame.k,
      };
      const age = ages?.get(placed.id);
      return age === undefined ? drawn : { ...drawn, emerge: age };
    });
  });
}

// The effect JSON for the app's strokes (SPEC §7): each stored in torso
// space around its root, as it sat on the frame it was drawn on, and the
// ground strokes in frame px; with the flow's moments and turn when it has
// them, and the limb brush sized by the first limb's size. Each ground (impact)
// stroke keeps its own drawn size, so its crack renders as wide as he drew it.
export function effectOf(strokes: Stroke[], m: ClipMotion, anchors = new Map(strokes.map((stroke) => [stroke.id, anchorFor(stroke, m)])), overrides: Effect['overrides'] = {}): Effect {
  const limb = strokes.find((stroke) => stroke.brush === 'limb');
  return {
    version: 1,
    brush: DEFAULT_BRUSH,
    ...(limb ? { brushes: { limb: { ...brushSettings(INK_SETTINGS, 'limb'), size: limbBrushSize(limb.size, Math.min(m.width, m.height)) } } } : {}),
    palette: PALETTE,
    timing: { drawingsPerSecond: m.timing.dps },
    strokes: strokes.map((stroke) => toEffectStroke(stroke, anchors.get(stroke.id)!(stroke.frame), m.wobble, m.width)),
    ...(m.moments && m.moments.length > 0 ? { moments: m.moments } : {}),
    ...(m.turn ? { turn: m.turn } : {}),
    overrides,
  };
}

// A limb's drawn size is its root's diameter in clip px, and it sets the limb
// brush's size (decision 8): the default, 0.04 S, is the brush's own 28, a
// root radius R0 of 0.020 S (render/limb.ts's limbR0).
export const LIMB_ROOT = 0.04; // × S: the size a limb is drawn at unless he changes it
export const limbBrushSize = (size: number, S: number): number => (LIMB_BRUSH.size * size) / (LIMB_ROOT * S);

// One stroke on every frame. Strokes never touch each other, so this is the
// stroke's own share of animateStrokes, and the page can keep it per stroke.
export function animateStroke(stroke: Stroke, m: ClipMotion): DrawnStroke[] {
  return animateStrokes([stroke], m).map((frame) => frame[0]);
}

// Scratch canvases for the textured and neon brushes in the browser. Reads
// back pixels, so the context says so (Safari and Chrome keep it on the CPU).
export const browserScratch: MakeScratch = (width, height) => {
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as unknown as BrushTarget;
  return { canvas, ctx };
};
const INK_SETTINGS = { brush: DEFAULT_BRUSH };

// Draws one stroke with its brush: the same brush code the engine's tests
// and contact sheets use. The stroke's size is the ink brush's on this frame,
// and every brush scales from it (fine tips, the glow's radius, the grain).
// An emerging stroke (electric, limb) grows out by its age.
export function drawStroke(ctx: CanvasRenderingContext2D, stroke: DrawnStroke) {
  drawBrushStroke(ctx as unknown as BrushTarget, browserScratch, {
    id: stroke.id,
    points: stroke.points,
    pressure: stroke.pressure,
    color: stroke.color,
    emerge: stroke.emerge,
    brush: stroke.brush,
    settings: brushSettings(INK_SETTINGS, stroke.brush),
    scale: stroke.size / DEFAULT_BRUSH.size,
    k: stroke.k,
  });
}

// The stroke still being drawn, straight from the pointer.
export function drawLive(ctx: CanvasRenderingContext2D, stroke: Stroke) {
  drawStroke(ctx, {
    id: stroke.id,
    points: stroke.points.map(([x, y]): [number, number] => [x, y]),
    pressure: stroke.points.map(([, , pressure]) => pressure),
    layer: stroke.layer,
    color: stroke.color,
    brush: stroke.brush,
    size: stroke.size,
    k: 0,
  });
}

const isGround = (stroke: Stroke) => stroke.anchor?.type === 'ground';

// Where a stroke's torso space sits on each frame: its root, turned and
// scaled by tracking. On the frame it was drawn on, that's the root, upright,
// at the torso height measured there. A ground stroke never moves.
function anchorFor(stroke: Stroke, m: ClipMotion): (f: number) => TorsoTransform {
  if (isGround(stroke)) return () => GROUND;
  const [x, y] = stroke.points[0];
  const unit = unitNear(m.units, stroke.frame) ?? DEFAULT_TORSO_SHARE * m.height;
  const poses = m.poses(stroke);
  const still: TorsoTransform = { x, y, angle: 0, unit };
  return (f) => (poses ? anchorTransform(poses[f], unit) : still);
}

// A stroke's size is its brush size in clip px; the effect keeps a ground
// stroke's as px at 1080 wide (the brush's unit), `width` the clip's.
function toEffectStroke(stroke: Stroke, at: TorsoTransform, wobble: boolean, width: number): EffectStroke {
  const { points, pressure } = resampleStroke(stroke.points);
  const ground = isGround(stroke);
  return {
    id: stroke.id,
    color: Math.max(0, PALETTE.indexOf(stroke.color)) as 0 | 1 | 2,
    brush: stroke.brush,
    ...(ground && stroke.size > 0 ? { size: Math.round(((stroke.size * 1080) / width) * 100) / 100 } : {}),
    kind: stroke.kind,
    anchor: stroke.anchor ?? { type: 'point', time: stroke.frame / 30, xy: [stroke.points[0][0], stroke.points[0][1]] },
    bodyAngle: stroke.bodyAngle ?? 0,
    stiffness: stroke.stiffness,
    wobble: wobble && !ground ? (stroke.wobble ?? 1) : 0,
    views: { front: { points: points.map((p) => toTorso(at, p)), pressure, root: ground ? [points[0][0], points[0][1]] : [0, 0], layer: stroke.layer } },
  };
}

// The torso height on frame f, or the nearest frame that has one.
function unitNear(units: (number | null)[] | null, f: number): number | null {
  if (!units) return null;
  for (let d = 0; d < units.length; d++) {
    const found = units[f - d] ?? units[f + d];
    if (found != null) return found;
  }
  return null;
}

// ---- The impact scene --------------------------------------------------------------------------

// The slam's floor (round 3, F8): the floor read from him (impact/floor-
// estimate.ts) goes on a slam that has none of its own. An estimate that fell
// back leaves the slam as it is, so the scene draws DEFAULT_FLOOR, as before.
export function withFloor(moments: Effect['moments'], estimate: FloorEstimate | null): Effect['moments'] {
  if (!moments || !estimate || estimate.from !== 'person') return moments;
  const { ratio, majorDeg, up, persp } = estimate.floor;
  return moments.map((m) => (m.kind === 'slam' && !m.floor ? { ...m, floor: { ratio, majorDeg, up: [up[0], up[1]], persp } } : m));
}

// The effect has an impact for the scene to draw: limbs, or a slam.
export const hasImpact = (effect: Effect): boolean => effect.strokes.some((st) => st.brush === 'limb') || (effect.moments ?? []).some((m) => m.kind === 'slam');

// The strokes the impact scene draws itself, as its rig.own has them: every
// limb, and once there's a slam its cracks (slam.strokes, else every ground
// stroke). The page animates the others.
export function sceneOwns(stroke: Stroke, effect: Effect): boolean {
  if (stroke.brush === 'limb') return true;
  const slam = (effect.moments ?? []).find((m) => m.kind === 'slam');
  return slam !== undefined && slam.kind === 'slam' && isGround(stroke) && (slam.strokes ?? [stroke.id]).includes(stroke.id);
}

// What the impact scene reads of the clip, as plain data, so a worker can be
// handed the same (render-worker.ts).
export interface ClipData {
  width: number;
  height: number;
  frames: number;
  masks: (Mask | null)[] | null; // the tracking's person masks; null without tracking
  faces: (SamMask | null)[] | null; // SAM's face masks, from the cache; null without them
  bodies: (PointSet | null)[] | null; // the stand-in's landmarks, for the turn and the bend; null without
  skeleton?: (PointSet | null)[] | null; // the stand-in's 33 landmarks, for the limbs' crash-test dummy; missing = `bodies` (head and neck alone)
  units: (number | null)[] | null; // torso heights (torsoHeights)
  id?: string; // names this data on every thread, for the physics' key (impact/scene.ts); missing = the object itself
}

// The clip as the scene reads it: the person mask, or the nearest within 15
// frames as the plain preview has it; the face mask at a quarter of the
// frame, decoded once; and `poses`, the track the limbs ride (anchorTrack).
export function impactClip(data: ClipData, poses: readonly Pose[]): ImpactClip {
  const faces = new Map<number, Mask | null>();
  return {
    width: data.width,
    height: data.height,
    frames: data.frames,
    personMask: (f) => (data.masks ? maskNear(data.masks, f) : null),
    faceMask: (f) => {
      if (!data.faces) return null;
      if (!faces.has(f)) {
        const m = data.faces[f];
        faces.set(f, m ? toFrameMask(m, data.width, data.height) : null);
      }
      return faces.get(f) ?? null;
    },
    poses,
    bodies: data.bodies,
    skeleton: data.skeleton ?? null,
    units: data.units,
    source: data.id ?? data,
  };
}

// The limbs' track: their mean root on the frame they were drawn on, taken
// along by the tracking (`follow`, trackStroke's) on every frame, or held
// still without it. Their torso space rides it: the lift's body anchor.
export function anchorTrack(limbs: readonly Stroke[], frames: number, follow: ((root: Vec2, frame: number) => Pose[] | null) | null): Pose[] {
  const n = limbs.length;
  const root: Vec2 = n > 0 ? [limbs.reduce((a, s) => a + s.points[0][0], 0) / n, limbs.reduce((a, s) => a + s.points[0][1], 0) / n] : [0, 0];
  const tracked = n > 0 && follow ? follow(root, limbs[0].frame) : null;
  return tracked && tracked.length === frames ? tracked : Array.from({ length: frames }, () => ({ x: root[0], y: root[1], angle: 0, scale: 1 }));
}

// Strokes in clip px on a frame `s` times the size.
export function scaleStrokes(strokes: readonly DrawnStroke[], s: number): DrawnStroke[] {
  if (s === 1) return [...strokes];
  return strokes.map((st) => ({ ...st, points: st.points.map(([x, y]): [number, number] => [x * s, y * s]), size: st.size * s }));
}

export interface SceneSetup {
  tier: Tier;
  size?: number; // the internal frame's long side; missing = 1080
  cuts?: number; // the cut order's steps; missing = the tier's
  boil?: BoilParams;
  make?: MakeScratch; // missing = browserScratch
  strokes?: (clip: number) => DrawnStroke[]; // the other strokes on a clip frame, clip px (animateStrokes')
  physics?: SceneOptions['physics']; // worked out elsewhere, or 'wait' for it (lift/sim-worker.ts); missing = worked out here
}

// The impact scene for the preview or the export: every stroke animated
// together, the limbs and the cracks by the scene itself, the others scaled
// onto its frame. Null when the effect has no impact, where the plain
// renderFrame draws the frame.
export function impactScene(effect: Effect, clip: ImpactClip, setup: SceneSetup): ImpactScene | null {
  if (!hasImpact(effect)) return null;
  let scale = 1;
  const scene = createImpactScene(effect, clip, {
    tier: setup.tier,
    make: setup.make ?? browserScratch,
    size: setup.size,
    cuts: setup.cuts,
    boil: setup.boil,
    strokes: (c) => scaleStrokes(setup.strokes?.(c) ?? [], scale),
    drawStroke,
    physics: setup.physics,
  });
  scale = scene.scale;
  return scene;
}

// ---- The sound -----------------------------------------------------------------------------------

export const ENVELOPE_MS = 10;

// The clip's sound as detect.ts's cue reads it: the RMS of the mono mix every
// 10 ms, value i starting i·10 ms after `skip` seconds in.
export function audioEnvelope(channels: readonly Float32Array[], sampleRate: number, skip = 0): number[] {
  const n = channels.reduce((min, ch) => Math.min(min, ch.length), Infinity);
  if (channels.length === 0 || !(n > 0) || !(sampleRate > 0)) return [];
  const step = (sampleRate * ENVELOPE_MS) / 1000;
  const start = Math.max(0, Math.round(skip * sampleRate));
  const out: number[] = [];
  for (let i = 0; start + Math.round(i * step) < n; i++) {
    const a = start + Math.round(i * step);
    const b = Math.min(n, start + Math.round((i + 1) * step));
    let sum = 0;
    for (let j = a; j < b; j++) {
      let v = 0;
      for (const ch of channels) v += ch[j];
      v /= channels.length;
      sum += v * v;
    }
    out.push(Math.sqrt(sum / Math.max(1, b - a)));
  }
  return out;
}

// Decodes the clip's sound once with Web Audio into that envelope, from its
// first frame (`start`, the clip's first frame time; the sound is taken to
// start at 0). Null when there's no sound or the browser can't decode it, and
// the cue falls back to the mask.
export async function decodeEnvelope(file: Blob, start: number): Promise<number[] | null> {
  try {
    const Offline = globalThis.OfflineAudioContext ?? (globalThis as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
    if (!Offline) return null;
    const audio = new Offline(1, 1, 44100);
    const buffer = await audio.decodeAudioData(await file.arrayBuffer());
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
    const envelope = audioEnvelope(channels, buffer.sampleRate, start);
    return envelope.length > 0 ? envelope : null;
  } catch {
    return null;
  }
}
