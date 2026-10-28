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

// ---- The project file ---------------------------------------------------------
// The effect JSON is the file that moves between devices (SPEC §6), so it's
// read as untrusted: parseEffect checks the shape before anything uses it.

export const BRUSH_IDS: readonly BrushId[] = ['ink', 'textured', 'fine-ink', 'fine-textured', 'neon-straight', 'neon-round'];

export function serializeEffect(effect: Effect): string {
  return `${JSON.stringify(effect, null, 2)}\n`;
}

export function parseEffect(text: string): { effect: Effect } | { problems: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { problems: ['not JSON'] };
  }
  const problems = effectProblems(json);
  return problems.length ? { problems } : { effect: json as Effect };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec = (v: unknown): v is Vec2 => Array.isArray(v) && v.length === 2 && v.every(isNum);
const isColor = (v: unknown) => v === 0 || v === 1 || v === 2;

function brushProblems(b: unknown, where: string): string[] {
  if (!isObj(b)) return [`${where} is not an object`];
  const p = ['size', 'thinning', 'smoothing', 'streamline'].filter((k) => !isNum(b[k])).map((k) => `${where}.${k} is not a number`);
  if (b.grain !== undefined && !(isNum(b.grain) && b.grain >= 0 && b.grain <= 1)) p.push(`${where}.grain is not in 0..1`);
  if (b.glow !== undefined && !(isObj(b.glow) && isNum(b.glow.radiusPx) && isNum(b.glow.intensity))) p.push(`${where}.glow is not { radiusPx, intensity }`);
  return p;
}

function anchorProblems(a: unknown, where: string): string[] {
  if (!isObj(a)) return [`${where} is not an object`];
  if (a.type === 'concept') return typeof a.prompt === 'string' ? [] : [`${where}.prompt is not text`];
  if (a.type === 'point') return isNum(a.time) && isVec(a.xy) ? [] : [`${where} is not { time, xy }`];
  if (a.type === 'ground') return isVec(a.xy) ? [] : [`${where}.xy is not [x, y]`];
  return [`${where}.type is not concept, point or ground`];
}

function viewProblems(v: unknown, where: string): string[] {
  if (!isObj(v)) return [`${where} is not an object`];
  const p: string[] = [];
  if (!Array.isArray(v.points) || v.points.length < 2 || !v.points.every(isVec)) p.push(`${where}.points is not a list of [x, y]`);
  if (!Array.isArray(v.pressure) || !v.pressure.every(isNum) || (Array.isArray(v.points) && v.pressure.length !== v.points.length)) p.push(`${where}.pressure doesn't match its points`);
  if (!isVec(v.root)) p.push(`${where}.root is not [x, y]`);
  if (v.layer !== 'behind' && v.layer !== 'front') p.push(`${where}.layer is not behind or front`);
  return p;
}

function strokeProblems(s: unknown, i: number): string[] {
  const where = `strokes[${i}]`;
  if (!isObj(s)) return [`${where} is not an object`];
  const p: string[] = [];
  if (!Number.isInteger(s.id)) p.push(`${where}.id is not an integer`);
  if (!isColor(s.color)) p.push(`${where}.color is not 0, 1 or 2`);
  if (s.brush !== undefined && !BRUSH_IDS.includes(s.brush as BrushId)) p.push(`${where}.brush is not a brush`);
  if (s.kind !== 'strand' && s.kind !== 'rigid') p.push(`${where}.kind is not strand or rigid`);
  p.push(...anchorProblems(s.anchor, `${where}.anchor`));
  if (s.appear !== undefined && !(isObj(s.appear) && isNum(s.appear.at) && isNum(s.appear.drawOn))) p.push(`${where}.appear is not { at, drawOn }`);
  for (const k of ['bodyAngle', 'stiffness', 'wobble']) if (!isNum(s[k])) p.push(`${where}.${k} is not a number`);
  if (!isObj(s.views)) return [...p, `${where}.views is not an object`];
  p.push(...viewProblems(s.views.front, `${where}.views.front`));
  for (const k of ['side', 'back', 'left']) if (s.views[k] !== undefined) p.push(...viewProblems(s.views[k], `${where}.views.${k}`));
  return p;
}

function effectProblems(e: unknown): string[] {
  if (!isObj(e)) return ['the effect is not an object'];
  const p: string[] = [];
  if (e.version !== 1) p.push('version is not 1');
  p.push(...brushProblems(e.brush, 'brush'));
  if (e.brushes !== undefined) {
    if (!isObj(e.brushes)) p.push('brushes is not an object');
    else for (const [id, b] of Object.entries(e.brushes)) {
      if (id === 'ink' || !BRUSH_IDS.includes(id as BrushId)) p.push(`brushes.${id} is not a brush`);
      else p.push(...brushProblems(b, `brushes.${id}`));
    }
  }
  if (!Array.isArray(e.palette) || e.palette.length !== 3 || !e.palette.every((c) => typeof c === 'string')) p.push('palette is not three colors');
  if (!isObj(e.timing) || (e.timing.drawingsPerSecond !== 12 && e.timing.drawingsPerSecond !== 8)) p.push('timing.drawingsPerSecond is not 12 or 8');
  if (!Array.isArray(e.strokes)) p.push('strokes is not a list');
  else {
    e.strokes.forEach((s, i) => p.push(...strokeProblems(s, i)));
    const ids = e.strokes.map((s) => (isObj(s) ? s.id : undefined));
    if (new Set(ids).size !== ids.length) p.push('two strokes share an id');
  }
  if (e.presets !== undefined && !(Array.isArray(e.presets) && e.presets.every((x) => isObj(x) && typeof x.name === 'string' && isNum(x.at)))) p.push('presets is not a list of { name, at }');
  if (e.moments !== undefined && !(Array.isArray(e.moments) && e.moments.every((m) => isObj(m) && m.kind === 'slam' && isNum(m.at) && isVec(m.xy) && (m.by === 'body' || m.by === 'effect')))) p.push('moments is not a list of slams');
  if (e.listing !== undefined && !(isObj(e.listing) && typeof e.listing.name === 'string' && Array.isArray(e.listing.tags) && typeof e.listing.by === 'string')) p.push('listing is not { name, tags, by }');
  if (!isObj(e.overrides)) p.push('overrides is not an object');
  return p;
}
