// The app's strokes on the engine (SPEC §8). A drawn stroke is resampled to
// 32 points and stored in torso space around its root, as it was on the frame
// it was drawn on; tracking moves that root on every other frame. The whole
// clip is then animated at once (src/motion/animate.ts): the physics runs
// underneath, and the drawings are held on 2s or 3s with the boil on top.
// The preview and the export both draw from the result, so they match.
import type { Anchor, BrushId, Effect, Stroke as EffectStroke } from '../types/effect.ts';
import { animate } from '../motion/animate.ts';
import type { Timing } from '../motion/timing.ts';
import { DEFAULT_BRUSH, resampleStroke, type Point } from '../render/brush.ts';
import { brushSettings, drawBrushStroke, type BrushTarget, type MakeScratch } from '../render/brushes.ts';
import { anchorTransform, toTorso, type TorsoTransform } from '../track/torso.ts';
import type { Pose } from '../track/tracking.ts';

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
  // on the person, at the chest, boiling fully.
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
}

// Without masks there's no torso to measure, so assume a person about 70% of
// the frame tall (torso = 0.35 of that, SPEC §8.1). It sets how hard gravity
// pulls, in pixels.
const DEFAULT_TORSO_SHARE = 0.25;

// Every frame's strokes, for the whole clip.
export function animateStrokes(strokes: Stroke[], m: ClipMotion): DrawnStroke[][] {
  if (strokes.length === 0) return Array.from({ length: m.frameCount }, () => []);
  const anchors = new Map(strokes.map((stroke) => [stroke.id, anchorFor(stroke, m)]));
  const effect = effectOf(strokes, m, anchors);
  const byId = new Map(strokes.map((stroke) => [stroke.id, stroke]));
  const frames = animate({
    effect,
    frames: m.frameCount,
    anchor: (id, f) => anchors.get(id)!(f),
    width: m.width,
    boil: m.timing.boil,
  });
  return frames.map((frame) =>
    frame.placed.map((placed) => {
      const stroke = byId.get(placed.id)!;
      const grown = anchors.get(placed.id)!(frame.f).unit / anchors.get(placed.id)!(stroke.frame).unit;
      return {
        id: placed.id,
        points: placed.points,
        pressure: placed.pressure,
        layer: placed.layer,
        color: stroke.color,
        brush: stroke.brush,
        size: stroke.size * grown,
        k: frame.k,
      };
    }),
  );
}

// The effect JSON for the app's strokes (SPEC §7): each stored in torso
// space around its root, as it sat on the frame it was drawn on.
export function effectOf(strokes: Stroke[], m: ClipMotion, anchors = new Map(strokes.map((stroke) => [stroke.id, anchorFor(stroke, m)])), overrides: Effect['overrides'] = {}): Effect {
  return {
    version: 1,
    brush: DEFAULT_BRUSH,
    palette: PALETTE,
    timing: { drawingsPerSecond: m.timing.dps },
    strokes: strokes.map((stroke) => toEffectStroke(stroke, anchors.get(stroke.id)!(stroke.frame), m.wobble)),
    overrides,
  };
}

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
export function drawStroke(ctx: CanvasRenderingContext2D, stroke: DrawnStroke) {
  drawBrushStroke(ctx as unknown as BrushTarget, browserScratch, {
    id: stroke.id,
    points: stroke.points,
    pressure: stroke.pressure,
    color: stroke.color,
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

// Where a stroke's torso space sits on each frame: its root, turned and
// scaled by tracking. On the frame it was drawn on, that's the root, upright,
// at the torso height measured there.
function anchorFor(stroke: Stroke, m: ClipMotion): (f: number) => TorsoTransform {
  const [x, y] = stroke.points[0];
  const unit = unitNear(m.units, stroke.frame) ?? DEFAULT_TORSO_SHARE * m.height;
  const poses = m.poses(stroke);
  const still: TorsoTransform = { x, y, angle: 0, unit };
  return (f) => (poses ? anchorTransform(poses[f], unit) : still);
}

function toEffectStroke(stroke: Stroke, at: TorsoTransform, wobble: boolean): EffectStroke {
  const { points, pressure } = resampleStroke(stroke.points);
  return {
    id: stroke.id,
    color: Math.max(0, PALETTE.indexOf(stroke.color)) as 0 | 1 | 2,
    brush: stroke.brush,
    kind: stroke.kind,
    anchor: stroke.anchor ?? { type: 'point', time: stroke.frame / 30, xy: [stroke.points[0][0], stroke.points[0][1]] },
    bodyAngle: stroke.bodyAngle ?? 0,
    stiffness: stroke.stiffness,
    wobble: wobble ? (stroke.wobble ?? 1) : 0,
    views: { front: { points: points.map((p) => toTorso(at, p)), pressure, root: [0, 0], layer: stroke.layer } },
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
