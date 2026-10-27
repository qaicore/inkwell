// The app's strokes on the engine (SPEC §8). A drawn stroke is resampled to
// 32 points and stored in torso space around its root, as it was on the frame
// it was drawn on; tracking moves that root on every other frame. The whole
// clip is then animated at once (src/motion/animate.ts): the physics runs
// underneath, and the drawings are held on 2s or 3s with the boil on top.
// The preview and the export both draw from the result, so they match.
import type { Effect, Stroke as EffectStroke } from '../types/effect.ts';
import { animate } from '../motion/animate.ts';
import type { Timing } from '../motion/timing.ts';
import { DEFAULT_BRUSH, fillOutline, resampleStroke, strokeOutline, type Point } from '../render/brush.ts';
import { anchorTransform, toTorso, type TorsoTransform } from '../track/torso.ts';
import type { Pose } from '../track/tracking.ts';

// One line as drawn, in clip pixels. Its first point is its root, the end
// that gets attached to the body.
export type Stroke = {
  id: number;
  color: string;
  size: number; // brush diameter at full pressure, clip px
  frame: number; // the frame it was drawn on
  pen: boolean; // real pen pressure; a mouse gets an even 0.5
  layer: 'front' | 'behind'; // in front of the person, or tucked behind them
  kind: 'strand' | 'rigid';
  stiffness: number; // strands: 0 = rope ... 1 = stiff
  points: Point[];
};

// A stroke as it appears on one frame, in clip pixels.
export type DrawnStroke = {
  points: [number, number][];
  pressure: number[];
  layer: 'front' | 'behind';
  color: string;
  size: number; // px on this frame: the drawn size, scaled with the body
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
  const effect: Effect = {
    version: 1,
    brush: DEFAULT_BRUSH,
    palette: ['#e8203a', '#f4f1ea', '#16141a'],
    timing: { drawingsPerSecond: m.timing.dps },
    strokes: strokes.map((stroke) => toEffectStroke(stroke, anchors.get(stroke.id)!(stroke.frame), m.wobble)),
    overrides: {},
  };
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
      return { points: placed.points, pressure: placed.pressure, layer: placed.layer, color: stroke.color, size: stroke.size * grown };
    }),
  );
}

// Fills one stroke's outline: the same brush code the engine's tests and
// contact sheets use, with the stroke's own size.
export function drawStroke(ctx: CanvasRenderingContext2D, stroke: DrawnStroke) {
  fillOutline(ctx, strokeOutline(stroke.points, stroke.pressure, { ...DEFAULT_BRUSH, size: stroke.size }), stroke.color);
}

// The stroke still being drawn, straight from the pointer.
export function drawLive(ctx: CanvasRenderingContext2D, stroke: Stroke) {
  drawStroke(ctx, {
    points: stroke.points.map(([x, y]): [number, number] => [x, y]),
    pressure: stroke.points.map(([, , pressure]) => pressure),
    layer: stroke.layer,
    color: stroke.color,
    size: stroke.size,
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
    color: 0, // the app keeps its own colors; the engine doesn't use these
    kind: stroke.kind,
    anchor: { type: 'point', time: stroke.frame / 30, xy: [stroke.points[0][0], stroke.points[0][1]] },
    bodyAngle: 0,
    stiffness: stroke.stiffness,
    wobble: wobble ? 1 : 0,
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
