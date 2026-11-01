// The effect JSON (SPEC §7): everything Qai drew, stored in torso space so it
// rides the body. The project file that moves between iPad and desktop is this.

export type Vec2 = [number, number]; // torso space: origin at anchor, x toward screen right when upright, y down, unit = torso height

export interface StrokeView {
  points: Vec2[]; // resampled by arc length (32 by default, see A6), same count in every view
  pressure: number[]; // one value per point, 0..1
  root: Vec2; // where the stroke attaches in this view
  layer: 'behind' | 'front'; // relative to the body in this view
}

export type BrushId = 'ink' | 'textured' | 'fine-ink' | 'fine-textured' | 'neon-straight' | 'neon-round' | 'electric' | 'blade' | 'trail' | 'limb';

// The limb brush (impact design §2): a cel-shaded 3D tube on the lifted
// centreline, with electricity crawling over it. Lengths are shares of S, the
// frame's short side.
export interface LimbSettings {
  radius: number; // R0 = radius·S·(size/28)
  taper: number; // the radius falls as (1 − t)^taper from root to tip
  socket: number; // the ring where the limb enters the body, × the root radius
  bands: [number, number, number]; // cel thresholds on N·H: body, lit, core
  linePx: number; // outline width
  arcs: number; // sheath arcs per limb when idle
  arcLift: [number, number]; // how far an arc stands off the axis, × r: U[min, max]
  pulseEvery: [number, number]; // limb drawings between cord pulses when idle: U{min..max}
}

export interface BrushSettings {
  size: number; // perfect-freehand, px at 1080 wide
  thinning: number;
  smoothing: number;
  streamline: number;
  grain?: number; // textured brushes: 0..1, how much of the fill the grain removes
  glow?: { radiusPx: number; intensity: number }; // neon, electric, blade, trail and limb brushes, at 1080 wide
  bolt?: { bendPx: number; ampPx: number; elbows: number; shards: number }; // electric: bend spacing, sideways reach, share of sharp elbows, shards per drawing at most, at 1080 wide
  limb?: LimbSettings; // the limb brush
}

export type Anchor =
  | { type: 'concept'; prompt: string }
  | { type: 'point'; time: number; xy: [number, number] }
  | { type: 'ground'; xy: [number, number] }; // fixed frame pixels (tripod): cracks on the floor

export interface Stroke {
  id: number; // drawing order; the same id in every view
  color: 0 | 1 | 2;
  brush?: BrushId; // missing = 'ink'
  size?: number; // ground strokes: the brush size it was drawn at, px at 1080 wide; missing = the effect's brush size
  accent?: 0 | 1 | 2; // blade: the color of the reflected light on its shadow edge; missing = its own color
  kind: 'strand' | 'rigid'; // rigid = follows its target exactly (horns, halo)
  anchor: Anchor;
  appear?: { at: number; drawOn: number }; // seconds: hidden before `at`, then drawn on from the root over `drawOn`
  bodyAngle: number; // degrees around the torso: 0 chest, 90 his right side, 180 center of back, 270 his left side
  stiffness: number; // strands only: 0 = rope ... 1 = stiff
  wobble: number; // boil scale 0..1
  views: { front: StrokeView; side?: StrokeView; back?: StrokeView; left?: StrokeView };
}

export type Ease = 'linear' | 'in' | 'out' | 'hold-snap';

// When the electric strokes grow out of his back (SPEC §8.9): Qai taps the
// frame, or confirms the one suggested from the stand-in's wrists. The limbs
// grow out on the frame they were drawn on (impact design §1).
export interface EmergeMoment {
  kind: 'emerge';
  at: number; // seconds into the clip
  strokes?: number[]; // stroke ids; missing = every electric and limb stroke
}

// How the floor lies on screen around the impact point (impact design §6): a
// floor circle of radius R draws as an ellipse with semi-axes R along majorDeg
// and ratio·R along up, its far half squashed by 1 + persp·R/U.
export interface FloorBlock {
  ratio: number; // 0.2..1
  majorDeg: number; // screen degrees, y down
  up: [number, number]; // screen direction away from the camera along the floor
  persp: number; // 0 or more
}

export interface Moment {
  kind: 'slam';
  at: number; // seconds into the clip
  xy: [number, number]; // impact point, frame pixels
  by: 'body' | 'effect'; // his fist (Qai taps the frame), or the end of the slam preset
  // The impact (impact design §1). All optional, so effects saved before it still read.
  dir?: [number, number]; // strike direction, screen, y down; missing = (0, 1)
  seed?: number; // missing = fnv1a of the impact stroke ids
  strokes?: number[]; // the impact (crack) strokes; missing = every ground stroke
  limbs?: number[]; // the limbs that slam down; missing = every limb stroke
  frames?: { count: 0 | 7; flash: 'safe' | 'full' }; // the impact frames; missing = { 7, 'full' }: full is the default, 'safe' is Reduce flashing (Qai, Oct 29)
  aftermath?: { seconds: number; scale: number; scarSeconds: number }; // missing = { 1.5, 1, 3 }; seconds 1.5..3
  floor?: FloorBlock; // missing = { 0.5, 0, (0, −1), 0 }
  // c628565's fields, kept as they were: they parse and round-trip, but nothing
  // draws the ring or the bursts, and only ease.cracks is read (Qai, Oct 29).
  bursts?: { color: 0 | 1 | 2; brush: BrushId; count: number; seed: number }; // electric arcs out from xy
  ring?: { color: 0 | 1 | 2; seed: number }; // shockwave ring along the floor, fist slams
  ease?: Partial<Record<'cracks' | 'ring' | 'bursts', Ease>>; // missing = 'out'
}

// His turn (SPEC §8.5): one tap on the frame where his back faces the camera,
// and the direction he spins. It overrides the turn read from the pose track.
export interface Turn {
  at: number; // seconds into the clip: his back faces the camera
  dir: 1 | -1; // direction of travel
  keys?: [number, number][]; // [seconds, degrees], nudged by hand, in time order; they win over the tap's
}

export interface Effect {
  version: 1;
  brush: BrushSettings; // the ink brush
  brushes?: Partial<Record<Exclude<BrushId, 'ink'>, BrushSettings>>; // missing = the §8.8 defaults
  palette: [string, string, string];
  timing: { drawingsPerSecond: 12 | 8 };
  strokes: Stroke[];
  presets?: { name: string; at: number }[]; // seconds into the clip
  moments?: (Moment | EmergeMoment)[];
  turn?: Turn; // missing = the turn read from the pose track where it's reliable, else no turn
  aura?: { color: 0 | 1 | 2 }; // the flame aura around the person (§8.6); missing = none
  listing?: { name: string; tags: string[]; by: string }; // the gallery entry (X3)
  overrides: Record<string, unknown>; // one-tap overrides, keyed by field path
}

// Facing classes (SPEC §7), each within 45° of its angle: front 0°, right 90°
// (his right side toward the camera), back 180°, left 270°.
export type Facing = 'front' | 'right' | 'back' | 'left';

// ---- The project file ---------------------------------------------------------
// The effect JSON is the file that moves between devices (SPEC §6), so it's
// read as untrusted: parseEffect checks the shape before anything uses it.

export const BRUSH_IDS: readonly BrushId[] = ['ink', 'textured', 'fine-ink', 'fine-textured', 'neon-straight', 'neon-round', 'electric', 'blade', 'trail', 'limb'];

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
const isSlam = (m: Record<string, unknown>) => m.kind === 'slam' && isNum(m.at) && isVec(m.xy) && (m.by === 'body' || m.by === 'effect');
const isEmerge = (m: Record<string, unknown>) => m.kind === 'emerge' && isNum(m.at) && (m.strokes === undefined || (Array.isArray(m.strokes) && m.strokes.every(isNum)));
const isColor = (v: unknown) => v === 0 || v === 1 || v === 2;
const isNums = (v: unknown, n: number) => Array.isArray(v) && v.length === n && v.every(isNum);
const isIds = (v: unknown) => Array.isArray(v) && v.every((x) => Number.isInteger(x));
const isDir = (v: unknown) => isVec(v) && (v[0] !== 0 || v[1] !== 0);
const shown = (v: unknown) => (v === undefined ? 'missing' : JSON.stringify(v));
const LIMB_NUMBERS = ['radius', 'taper', 'socket', 'linePx', 'arcs'];

function brushProblems(b: unknown, where: string): string[] {
  if (!isObj(b)) return [`${where} is not an object`];
  const p = ['size', 'thinning', 'smoothing', 'streamline'].filter((k) => !isNum(b[k])).map((k) => `${where}.${k} is not a number`);
  if (b.grain !== undefined && !(isNum(b.grain) && b.grain >= 0 && b.grain <= 1)) p.push(`${where}.grain is not in 0..1`);
  if (b.glow !== undefined && !(isObj(b.glow) && isNum(b.glow.radiusPx) && isNum(b.glow.intensity))) p.push(`${where}.glow is not { radiusPx, intensity }`);
  if (b.bolt !== undefined && !(isObj(b.bolt) && ['bendPx', 'ampPx', 'elbows', 'shards'].every((k) => isNum((b.bolt as Record<string, unknown>)[k])))) p.push(`${where}.bolt is not { bendPx, ampPx, elbows, shards }`);
  const limb = b.limb;
  if (limb !== undefined && !(isObj(limb) && LIMB_NUMBERS.every((k) => isNum(limb[k])) && isNums(limb.bands, 3) && isNums(limb.arcLift, 2) && isNums(limb.pulseEvery, 2))) {
    p.push(`${where}.limb is not { radius, taper, socket, bands, linePx, arcs, arcLift, pulseEvery }`);
  }
  return p;
}

// The impact fields of a slam (impact design §1). c628565's bursts, ring and
// ease are left unchecked, as they were.
function slamProblems(m: Record<string, unknown>, where: string): string[] {
  const p: string[] = [];
  if (m.dir !== undefined && !isDir(m.dir)) p.push(`${where}.dir is not a direction [x, y]`);
  if (m.seed !== undefined && !isNum(m.seed)) p.push(`${where}.seed is not a number`);
  for (const k of ['strokes', 'limbs']) if (m[k] !== undefined && !isIds(m[k])) p.push(`${where}.${k} is not a list of stroke ids`);
  const { frames, aftermath, floor } = m;
  if (frames !== undefined) {
    if (!isObj(frames)) p.push(`${where}.frames is not { count, flash }`);
    else {
      if (frames.count !== 0 && frames.count !== 7) p.push(`${where}.frames.count is not 0 or 7 (it is ${shown(frames.count)})`);
      if (frames.flash !== 'safe' && frames.flash !== 'full') p.push(`${where}.frames.flash is not safe or full (it is ${shown(frames.flash)})`);
    }
  }
  if (aftermath !== undefined) {
    if (!isObj(aftermath)) p.push(`${where}.aftermath is not { seconds, scale, scarSeconds }`);
    else {
      const { seconds, scale, scarSeconds } = aftermath;
      if (!(isNum(seconds) && seconds >= 1.5 && seconds <= 3)) p.push(`${where}.aftermath.seconds is not in 1.5..3 (it is ${shown(seconds)})`);
      if (!(isNum(scale) && scale > 0)) p.push(`${where}.aftermath.scale is not a number above 0`);
      if (!(isNum(scarSeconds) && scarSeconds >= 0)) p.push(`${where}.aftermath.scarSeconds is not a number of seconds`);
    }
  }
  if (floor !== undefined) {
    if (!isObj(floor)) p.push(`${where}.floor is not { ratio, majorDeg, up, persp }`);
    else {
      if (!(isNum(floor.ratio) && floor.ratio >= 0.2 && floor.ratio <= 1)) p.push(`${where}.floor.ratio is not in 0.2..1 (it is ${shown(floor.ratio)})`);
      if (!isNum(floor.majorDeg)) p.push(`${where}.floor.majorDeg is not a number of degrees`);
      if (!isDir(floor.up)) p.push(`${where}.floor.up is not a direction [x, y]`);
      if (!(isNum(floor.persp) && floor.persp >= 0)) p.push(`${where}.floor.persp is not a number, 0 or more`);
    }
  }
  return p;
}

function turnProblems(t: unknown): string[] {
  if (!isObj(t)) return ['turn is not { at, dir, keys }'];
  const p: string[] = [];
  if (!isNum(t.at)) p.push('turn.at is not a number of seconds');
  if (t.dir !== 1 && t.dir !== -1) p.push('turn.dir is not 1 or -1');
  const keys = t.keys;
  if (keys !== undefined) {
    if (!(Array.isArray(keys) && keys.every(isVec))) p.push('turn.keys is not a list of [seconds, degrees]');
    else if (keys.some((k, i) => i > 0 && !(k[0] > keys[i - 1][0]))) p.push('turn.keys are not in time order');
  }
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
  if (s.size !== undefined && !(isNum(s.size) && s.size > 0)) p.push(`${where}.size is not a positive number`);
  if (s.accent !== undefined && !isColor(s.accent)) p.push(`${where}.accent is not 0, 1 or 2`);
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
  if (e.moments !== undefined && !(Array.isArray(e.moments) && e.moments.every((m) => isObj(m) && (isSlam(m) || isEmerge(m))))) p.push('moments is not a list of slams and emerges');
  if (Array.isArray(e.moments)) e.moments.forEach((m, i) => { if (isObj(m) && isSlam(m)) p.push(...slamProblems(m, `moments[${i}]`)); });
  if (e.turn !== undefined) p.push(...turnProblems(e.turn));
  if (e.listing !== undefined && !(isObj(e.listing) && typeof e.listing.name === 'string' && Array.isArray(e.listing.tags) && typeof e.listing.by === 'string')) p.push('listing is not { name, tags, by }');
  if (e.aura !== undefined && !(isObj(e.aura) && isColor(e.aura.color))) p.push('aura is not { color: 0, 1 or 2 }');
  if (!isObj(e.overrides)) p.push('overrides is not an object');
  return p;
}
