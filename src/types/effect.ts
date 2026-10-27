// The effect JSON (SPEC §7): everything Qai drew, stored in torso space so it
// rides the body. The project file that moves between iPad and desktop is this.

export type Vec2 = [number, number]; // torso space: origin at anchor, x toward screen right when upright, y down, unit = torso height

export interface StrokeView {
  points: Vec2[]; // resampled by arc length (32 by default, see A6), same count in every view
  pressure: number[]; // one value per point, 0..1
  root: Vec2; // where the stroke attaches in this view
  layer: 'behind' | 'front'; // relative to the body in this view
}

export interface Stroke {
  id: number; // drawing order; the same id in every view
  color: 0 | 1 | 2;
  kind: 'strand' | 'rigid'; // rigid = follows its target exactly (horns, halo)
  anchor: { type: 'concept'; prompt: string } | { type: 'point'; time: number; xy: [number, number] };
  bodyAngle: number; // degrees around the torso: 0 chest, 90 his right side, 180 center of back, 270 his left side
  stiffness: number; // strands only: 0 = rope ... 1 = stiff
  wobble: number; // boil scale 0..1
  views: { front: StrokeView; side?: StrokeView; back?: StrokeView; left?: StrokeView };
}

export interface Effect {
  version: 1;
  brush: { size: number; thinning: number; smoothing: number; streamline: number };
  palette: [string, string, string];
  timing: { drawingsPerSecond: 12 | 8 };
  strokes: Stroke[];
  presets?: { name: string; at: number }[]; // seconds into the clip
  overrides: Record<string, unknown>; // one-tap overrides, keyed by field path
}

// Facing classes (SPEC §7), each within 45° of its angle: front 0°, right 90°
// (his right side toward the camera), back 180°, left 270°.
export type Facing = 'front' | 'right' | 'back' | 'left';
