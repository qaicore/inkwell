// The effect JSON (SPEC §7): everything Qai drew, stored in torso space so it
// rides the body. The project file that moves between iPad and desktop is this.

export type Vec2 = [number, number]; // torso space: origin at anchor, x toward screen right when upright, y down, unit = torso height

export interface StrokeView {
  points: Vec2[]; // resampled by arc length (32 by default, see A6), same count in every view
  pressure: number[]; // one value per point, 0..1
  root: Vec2; // where the stroke attaches in this view
  layer: 'behind' | 'front'; // relative to the body in this view
}

export type BrushId = 'ink' | 'textured' | 'fine-ink' | 'fine-textured' | 'neon-straight' | 'neon-round';

export interface BrushSettings {
  size: number; // perfect-freehand, px at 1080 wide
  thinning: number;
  smoothing: number;
  streamline: number;
  grain?: number; // textured brushes: 0..1, how much of the fill the grain removes
  glow?: { radiusPx: number; intensity: number }; // neon brushes, at 1080 wide
}

export type Anchor =
  | { type: 'concept'; prompt: string }
  | { type: 'point'; time: number; xy: [number, number] }
  | { type: 'ground'; xy: [number, number] }; // fixed frame pixels (tripod): cracks on the floor

export interface Stroke {
  id: number; // drawing order; the same id in every view
  color: 0 | 1 | 2;
  brush?: BrushId; // missing = 'ink'
  kind: 'strand' | 'rigid'; // rigid = follows its target exactly (horns, halo)
  anchor: Anchor;
  appear?: { at: number; drawOn: number }; // seconds: hidden before `at`, then drawn on from the root over `drawOn`
  bodyAngle: number; // degrees around the torso: 0 chest, 90 his right side, 180 center of back, 270 his left side
  stiffness: number; // strands only: 0 = rope ... 1 = stiff
  wobble: number; // boil scale 0..1
  views: { front: StrokeView; side?: StrokeView; back?: StrokeView; left?: StrokeView };
}

export type Ease = 'linear' | 'in' | 'out' | 'hold-snap';

export interface Moment {
  kind: 'slam';
  at: number; // seconds into the clip
  xy: [number, number]; // impact point, frame pixels
  by: 'body' | 'effect'; // his fist (Qai taps the frame), or the end of the slam preset
  bursts?: { color: 0 | 1 | 2; brush: BrushId; count: number; seed: number }; // electric arcs out from xy
  ring?: { color: 0 | 1 | 2; seed: number }; // shockwave ring along the floor, fist slams
  ease?: Partial<Record<'cracks' | 'ring' | 'bursts', Ease>>; // missing = 'out'
}

export interface Effect {
  version: 1;
  brush: BrushSettings; // the ink brush
  brushes?: Partial<Record<Exclude<BrushId, 'ink'>, BrushSettings>>; // missing = the §8.8 defaults
  palette: [string, string, string];
  timing: { drawingsPerSecond: 12 | 8 };
  strokes: Stroke[];
  presets?: { name: string; at: number }[]; // seconds into the clip
  moments?: Moment[];
  listing?: { name: string; tags: string[]; by: string }; // the gallery entry (X3)
  overrides: Record<string, unknown>; // one-tap overrides, keyed by field path
}

// Facing classes (SPEC §7), each within 45° of its angle: front 0°, right 90°
// (his right side toward the camera), back 180°, left 270°.
export type Facing = 'front' | 'right' | 'back' | 'left';
