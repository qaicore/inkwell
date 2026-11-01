// The impact scene (impact design §1–§10; WP12): every layer of one slam on
// every output frame, from the effect and the clip's cached tracking, at the
// internal frame: 1080 on the long side (× the cut order's resolution), so
// 1080×608 for 16:9 and 608×1080 in portrait.
//   - The slam: P, d, the seed and the floor from the slam moment; σ and U
//     from the person mask's box at I (the nearest mask within ±15 frames);
//     J_end from aftermath.seconds; the HUD side h from strikeFrame (−1 in
//     portrait).
//   - The lift (decision 4): his turn from the tap (turnKeysFromTap, inside
//     turnKeys), else read from the stand-in's pose track, else none (θ 0). A
//     turn read from the pose can be held to known keys (opts.turn, through
//     checkedTurn: the hero's hand keys over f50–74, within 45°). The limbs
//     are lifted on the frame they were drawn on (their emerge moment's) and
//     run through animate3d with the strike controller, limbs first (decision
//     2): land I − 7, release I + 9. The physics runs once, for every frame,
//     on first use.
//   - Limbs: a fresh tube drawing (WP3's tubes, WP4's arcs and pulses) on the
//     frames limbDrawingAt marks 'tube'; between them in the strike window the
//     last tube is stamped through the similarity about P that carries its
//     roots, so the pinned tips stay on P; everywhere else the 2s drawing is
//     carried by his torso's similarity since the frame it was captured on.
//   - The strike (WP5) on j −8..−1, one drawing a kr step. The posters (WP6)
//     on j 0..8, whose figure is his mask, the tubes' silhouettes and every
//     impact stroke. From j 9 the masses (WP8) and the energy (WP9): the
//     lightning crawls along the cluster's outline, the cracks, his mask's
//     edge within 0.3 U of P and the limbs.
//   - Finishing: the camera (WP7), the grade (the strike calm keeps its lift
//     at 1), the glow, and from j 9 the face cut on the front FX: his face
//     mask dilated 0.03 S with a 0.02 S feather, or the top 20 % of his box
//     when there's no face mask.
//   - The flash ladder (ladder.ts) only runs under Reduce flashing (decision
//     5): opts.degrade picks the step, and degraded(step) is the same scene at
//     another step, sharing the physics and the drawn parts.
// Render-ahead (design §10). Each 2s layer is drawn once per drawing into a
// canvas the size of its box, a part, kept by what it shows: the two limb
// layers (their glow kept as recorded calls), each mass, each poster (its
// glow baked in). jobs(o) lists the drawings due over the next frames that
// aren't drawn yet, and j 9's limb and mass drawings while the posters show;
// runJob draws one, and put takes a worker's. A job is pure in the effect,
// the clip's cached data and its key. frameLayers draws whatever is still
// missing itself, so a frame never depends on what ran ahead. The 1s energy
// (the strike, the lightning) is drawn on the main thread, once per kr step.
// Every layer is key-null: a keyed layer costs the stack a full-frame bitmap
// and a readback on every miss, and the parts already hold their boxes.
// Pure: no DOM at load, nothing random but rng, no clock but opts.clock (only
// timings() reads it).
import type { DrawnStroke } from '../app/engine.ts';
import type { BrushId, Effect, EmergeMoment, LimbSettings, Moment, Stroke } from '../types/effect.ts';
import type { Mask, PointSet, Pose } from '../track/tracking.ts';
import { goodStandIns, torsoBend } from '../track/bend.ts';
import { anchorTransform, toPixels, type TorsoTransform } from '../track/torso.ts';
import { liftBodies, type Body3D } from '../lift/body.ts';
import { animate3d, liftStroke, type Frame3D, type Lifted } from '../lift/lift.ts';
import { bulgeSide, limbsFirst, strikeController } from '../lift/strike.ts';
import { buildTube, silhouette } from '../lift/tube.ts';
import { checkedTurn, turnKeys, type TurnSource } from '../lift/turn.ts';
import type { BoilParams } from '../motion/boil.ts';
import { drawingIndex, EXAMPLE_TIMING, frameAt } from '../motion/timing.ts';
import { arcFlicker, arcPhase, arcTones, drawArcs, emitArcs, nativePath, sectionAt, sheathArcs, type ArcRun, type ArcTarget, type LinePath } from '../render/arcs3d.ts';
import { brushSettings, LIMB } from '../render/brushes.ts';
import { renderFrame, type ComposeDeps, type ImpactFrame, type Scene } from '../render/compose.ts';
import type { BrushTarget, MakeScratch } from '../render/glow.ts';
import { gradeAt, type Grade } from '../render/grade.ts';
import { compositeGlows, createGlow, type Glow } from '../render/light.ts';
import { drawLimb, keySwing, limbR0, limbTones, outlineClasses, pinnedSimilarity, type LimbTarget, type Matrix, type PlateLuma } from '../render/limb.ts';
import { drawPops, emitPops, emitPulses, limbClock, pulsesAt, pulseTimeline, type PopTarget, type Pulses, type PulseTimeline } from '../render/pulse.ts';
import { maskBox, type Affine, type StackTarget } from '../render/stack.ts';
import { cameraAt } from './camera.ts';
import { c1, drawingStart, jEnd, limbDrawingAt, phaseAt, type LimbDrawing, type Phase } from './clock.ts';
import { recordingSink, nullSink, type Crack, type DrawingJob, type DrawnGlow, type DrawnLayer, type DrawnPart, type FrameLayers, type GlowCall, type GlowSink, type ImpactContext, type LayerDraw, type Palette, type StackSlot, type Tier, type Tube, type Vec2 } from './contracts.ts';
import { impactSeed, SLAM_AFTERMATH, SLAM_FRAMES } from './detect.ts';
import { DEFAULT_FLOOR, sigmaOf, strikeFrame } from './floor.ts';
import { clipOf as ladderClipOf, degradeAt, outputLength as ladderLength, type Degrade } from './ladder.ts';
import { fnv1a32 } from './rng.ts';
import { CHARGE_RADIUS, chargeAt, paintStrike, planStrike, splashCover, strikeHold, strikeLimbOf, strikeOptions, strikeStep, strikeTones } from './strike.ts';
import { cutsAt, JOB_MS, tierCuts, type Cuts } from './tiers.ts';
import { shapes as clusterShapes, outline as clusterOutline } from './aftermath/cluster.ts';
import { crackClock, shapes as crackShapes } from './aftermath/cracks.ts';
import { chunkDrawing, shapes as debrisShapes } from './aftermath/debris.ts';
import { shapes as dustShapes } from './aftermath/dust.ts';
import { drawingAge, shapes as fireShapes, massClock, paint, type MassContext, type MassDrawing } from './aftermath/fire.ts';
import { emitLightning, lightningShapes, paintLightning, ribbons, type LightningPlan } from './aftermath/lightning.ts';
import { paintParticles, particles, particleShapes, type ParticleFrame } from './aftermath/particles.ts';
import { boxOf, emitFlood, flashShapes, floodShapes, groupClock, krSpan, liftCap, paintFlash, paintFlood, paintVeil, veilShapes, type Box, type FloodDrawing, type WashOptions } from './aftermath/washes.ts';
import { shapes as wispShapes, wispKind, wispOpacity } from './aftermath/wisps.ts';
import { drawPoster } from './frames/draw.ts';
import { drawOnEnd, posterFigure, traceMask, type PosterTarget } from './frames/figure.ts';
import { posterAt, posterHotRamp, posterPlan, redSafeCool, type PosterPlan, type PosterSpec } from './frames/gentle.ts';
import { posterLayout, type PosterLayout } from './frames/layout.ts';

const FPS = 30;
const FIELD = 1080; // the internal frame's long side (design §10)
const CUT = { reach: 0.03, feather: 0.02, head: 0.2, quarter: 4 } as const; // × S; the fallback's share of his box; buffer px per frame px
const EDGE_REACH = 0.3; // × U round P: the mask edge the lightning crawls along
const EDGE_CROP = 1.2; // the crop traced for it, × that reach
const SIGMA_REACH = 15; // frames either side of I to find his mask for σ
const STANDING = 0.7; // × H: his height when there's no mask to read
const TORSO_SHARE = 0.25; // × the clip's height: the torso without units (app/engine.ts's)
const STORE_SIZE = 64; // parts kept, least recently used dropped
const GLOW_SETS = 6; // limb drawings whose glow is kept blurred
const AHEAD = 3; // frames jobs looks ahead
const LIMB_PAD = 0.15; // × S round the limbs: their layers' box, before 2·r_max
const PART_PAD = 2; // px round a part's shapes
const BURST_PAD = 4; // px round the strike's bursts, past their widest
const MEMO = 32; // tube sets and lightning plans kept
const EMERGING: readonly (BrushId | undefined)[] = ['electric', 'limb']; // what an emerge with no stroke list covers (motion/moments.ts)
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
// Reduce flashing (decision 12): the limbs keep a steady charge, with no
// pulses running down them, no pops and the arcs' glow held at this gain
// instead of flickering 0.6–1.0, so the cord's own light never flashes.
const GENTLE_ARC = 0;
const GENTLE_LIMB_GLOW = 0.25; // the limbs' own steady glow (the root bursts and the cord), × this
// ... and the lightning is one steady draw from the cracks alone, the lead
// band's ribbons held in place to the fade with no flicker back (lightning.ts
// steady), its glow at this share and its ribbons at GENTLE_BOLT.
const GENTLE_BOLT_GLOW = 0.35;
const GENTLE_BOLT = 0.6; // the ribbons' own opacity
// ... and the 2s masses lie at these opacities, the cap on their swing: the
// smoke cluster, the dust, the debris and the sparks at GENTLE_MASS, the fire's
// flare at GENTLE_FIRE. Over a mid-grey plate the smoke's darkest line then
// moves L by about 0.10, and what a field gathers after the return at j 9 (the
// flare leaving, the smoke standing up, the limbs settling) stays under 25 %
// until the washes. The grade holds still from the return (grade.ts, still)
// and the floods have no dark edge (washes.ts), so neither tips it late.
const GENTLE_MASS = 0.3;
const GENTLE_FIRE = 0.6;
// The ladder's last step (no flash elements) also stills what is left: no
// lightning, and every mass, the fire and the sparks at this opacity.
const STILL_MASS = 0.25;
const QUIET: Pulses = { spans: [], pops: [] };
const FIRE_CLEAR = 0.6; // U round P: no arc glow there while the burst shows

// ---- Types ---------------------------------------------------------------------------

// The clip as the scene reads it: its size, the cached tracking and masks.
export interface ImpactClip {
  width: number; // clip px
  height: number;
  frames: number;
  personMask(f: number): Mask | null; // any resolution; null without one
  faceMask(f: number): Mask | null;
  poses: readonly Pose[]; // the anchor track, a pose per frame: where the strokes' torso space sits (track/tracking.ts)
  bodies?: readonly (PointSet | null)[] | null; // the stand-in's landmarks, for the turn and the bend; missing = none
  units?: readonly (number | null)[] | null; // his torso height per frame, clip px (torsoHeights); missing = 0.25 × the clip's height
  luma?(f: number): PlateLuma | null; // the plate's luma on frame f, clip px, for the limbs' outline classes; missing = the line tone all along
  audio?: unknown; // carried for the export: the freeze adds 26 frames of silence after I + 9 (WP13)
}

export interface SceneOptions {
  tier: Tier;
  make: MakeScratch;
  degrade?: number; // 0..7: the flash ladder's step; it only applies under Reduce flashing
  cuts?: number; // 0..7: the cut order's steps taken (tiers.ts); missing = tierCuts(tier)
  size?: number; // the internal frame's long side before the resolution cut; missing = 1080
  newPath?: (() => LinePath) | null; // drawArcs' path maker; missing = Path2D where there is one
  boil?: BoilParams; // missing = EXAMPLE_TIMING.boil
  turn?: { known: readonly Vec2[]; from: number; to: number; maxDeg?: number }; // checkedTurn on a turn read from the pose
  clock?: () => number; // ms; only timings() reads it
  strokes?: (clip: number) => DrawnStroke[]; // the effect's other strokes on a clip frame, on the internal frame (the limbs and cracks are dropped)
  drawStroke?: ComposeDeps['drawStroke'];
}

// One layer on a frame, for the tests and the sheets.
export interface ScenePart {
  slot: StackSlot | 'poster';
  name: string; // 'limbsFront', 'fire', 'strike', 'lightning', 'flood', 'limbGlow', …
  key: string; // what it shows: equal keys show equal pixels before the alpha
  alpha: number;
  layer: LayerDraw;
}

// What the limbs show on a frame: the drawing made on frame t, through T.
export interface LimbView {
  kind: LimbDrawing;
  t: number; // the clip frame the drawing was made on
  T: Matrix; // frame px on frame t → this frame
}

export interface SceneLayers extends FrameLayers {
  phase: Phase | null; // the clip frame's (phaseAt), or the poster's; null without a slam
  camera: Affine | null;
  grade: Grade | null;
  limbs: LimbView | null;
  posterSpec: PosterSpec | null;
  parts: ScenePart[]; // every layer, in the order the slots are filled
  gains: Record<string, number>; // the glows' gains: 'arc:<id>', 'flood', 'lightning', 'charge'
}

export interface TurnRead {
  keys: Vec2[];
  from: TurnSource;
  checked: { used: 'read' | 'known'; error: number } | null; // checkedTurn's verdict, with opts.turn
}

export interface ImpactScene {
  readonly width: number; // the internal frame
  readonly height: number;
  readonly scale: number; // internal px per clip px
  readonly context: ImpactContext | null; // this step's; null without a slam
  readonly degrade: Degrade;
  readonly cuts: Cuts;
  readonly sceneId: string;
  turn(): TurnRead;
  bodies(): readonly Body3D[];
  frames3d(): readonly Frame3D[];
  tubesAt(clip: number): readonly Tube[]; // internal px, far first
  clipOf(o: number): number;
  frameLayers(o: number): SceneLayers;
  impact(o: number): ImpactFrame | null;
  render(ctx: BrushTarget, video: unknown, o: number): void; // video: the clip frame's image, or (clip) => it
  jobs(o: number): DrawingJob[];
  runJob(job: DrawingJob | string, make?: MakeScratch): DrawnLayer;
  put(layer: DrawnLayer): void;
  outputLength(): number;
  timings(): Record<string, number>;
  degraded(step: number): ImpactScene;
}

// ---- The rig: what every ladder step shares ----------------------------------------------------

interface LimbInfo {
  id: number;
  emergeK: number | null; // the limb drawing it emerges on
  timeline: PulseTimeline;
  slam: boolean; // one of the limbs that slam down
}

interface Lift {
  bodies: Body3D[];
  frames: Frame3D[];
  start: number[]; // the first frame of the capture placed on each frame
  turn: TurnRead;
  ms: number; // the physics per frame, ms (with opts.clock)
}

interface Rig {
  effect: Effect;
  clip: ImpactClip;
  opts: SceneOptions;
  W: number;
  H: number;
  s: number;
  S: number;
  cuts: Cuts;
  dps: number;
  palette: Palette;
  slam: Moment | null;
  I: number | null;
  base: ImpactContext | null;
  settings: LimbSettings;
  R0: number;
  emerge: Map<number, number>; // stroke id → the frame it emerges on
  limbs: Map<number, LimbInfo>;
  strike: { land: number; release: number } | undefined;
  own: Set<number>; // the limb and crack strokes: the scene draws them
  sceneId: string;
  newPath: (() => LinePath) | null;
  now: (() => number) | null;
  lift: Lift | null;
  store: Map<string, DrawnPart>;
  glowSets: Map<string, Glow[]>;
  spare: Glow[];
  world: Map<string, { glow: Glow; content: string }>;
  posterGlows: Map<string, Glow>;
  tubes: Map<number, Tube[]>;
  edges: WeakMap<Mask, Vec2[][]>;
  faces: WeakMap<Mask, Mask>;
  heads: WeakMap<Mask, Mask>;
  scenes: Map<number, ImpactScene>;
}

export function createImpactScene(effect: Effect, clip: ImpactClip, opts: SceneOptions): ImpactScene {
  const cuts = cutsAt(opts.cuts ?? tierCuts(opts.tier));
  const size = Math.round((opts.size ?? FIELD) * cuts.resolution);
  const s = size / Math.max(clip.width, clip.height);
  const W = Math.round(clip.width * s);
  const H = Math.round(clip.height * s);
  const S = Math.min(W, H);
  const dps = effect.timing.drawingsPerSecond;
  const slam = (effect.moments ?? []).find((m): m is Moment => m.kind === 'slam') ?? null;
  const I = slam ? frameAt(slam.at) : null;
  const limbStrokes = effect.strokes.filter((st) => st.brush === 'limb');
  const brush = brushSettings(effect, 'limb');
  const settings = brush.limb ?? LIMB;
  const emerge = emergeFrames(effect);
  const slamLimbs = new Set(slam?.limbs ?? limbStrokes.map((st) => st.id));
  const limbs = new Map<number, LimbInfo>(
    limbStrokes.map((st) => {
      const at = emerge.get(st.id);
      const emergeK = at === undefined ? null : drawingIndex(at, dps);
      return [st.id, { id: st.id, emergeK, timeline: pulseTimeline(emergeK, I, dps, settings.pulseEvery), slam: slamLimbs.has(st.id) }];
    }),
  );
  const crackIds = slam ? (slam.strokes ?? effect.strokes.filter((st) => st.anchor.type === 'ground').map((st) => st.id)) : [];
  const rig: Rig = {
    effect,
    clip,
    opts,
    W,
    H,
    s,
    S,
    cuts,
    dps,
    // Reduce flashing cools a saturated red palette toward crimson (G4 for
    // the limbs, redSafeCool): red limbs whipping through a turn flash red on
    // their own, which no ladder step removes.
    palette: (slam?.frames?.flash === 'safe' ? effect.palette.map(redSafeCool) : [...effect.palette]) as Palette,
    slam,
    I,
    base: null,
    settings,
    R0: limbR0(S, brush.size, settings),
    emerge,
    limbs,
    strike: I !== null && limbStrokes.some((st) => slamLimbs.has(st.id)) ? limbsFirst(I) : undefined,
    own: new Set([...limbStrokes.map((st) => st.id), ...crackIds]),
    sceneId: '',
    newPath: opts.newPath === undefined ? nativePath() : opts.newPath,
    now: opts.clock ?? null,
    lift: null,
    store: new Map(),
    glowSets: new Map(),
    spare: [],
    world: new Map(),
    posterGlows: new Map(),
    tubes: new Map(),
    edges: new WeakMap(),
    faces: new WeakMap(),
    heads: new WeakMap(),
    scenes: new Map(),
  };
  rig.base = slam && I !== null ? slamContext(rig, slam, I, crackIds) : null;
  const poseDigest = clip.poses.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.angle.toFixed(4)},${p.scale.toFixed(4)}`).join(';');
  rig.sceneId = fnv1a32(JSON.stringify(effect), clip.width, clip.height, clip.frames, poseDigest, W, H, cuts.n).toString(16);
  return sceneOf(rig, opts.degrade ?? 0);
}

// The slam's context on the internal frame.
function slamContext(rig: Rig, slam: Moment, I: number, crackIds: readonly number[]): ImpactContext {
  const { effect, clip, W, H, s, S } = rig;
  const P: Vec2 = [slam.xy[0] * s, slam.xy[1] * s];
  const d: Vec2 = slam.dir ? [slam.dir[0], slam.dir[1]] : [0, 1];
  const seed = slam.seed ?? impactSeed(crackIds);
  const frames = slam.frames ?? SLAM_FRAMES;
  const aftermath = slam.aftermath ?? SLAM_AFTERMATH;
  const floor = slam.floor ?? DEFAULT_FLOOR;
  const frame = strikeFrame(P, d, S, sigmaOf(personHeight(clip, I, H) ?? STANDING * H, S), W, H, seed);
  const byId = new Map(effect.strokes.map((st) => [st.id, st]));
  const cracks: Crack[] = crackIds.flatMap((id): Crack[] => {
    const st = byId.get(id);
    if (!st || st.views.front.points.length < 2) return [];
    const points = strokePx(rig, st, I).map((p): Vec2 => [p[0] * s, p[1] * s]);
    // Each crack keeps the size it was drawn at (the effect's brush size when it has none).
    const brush = brushSettings(effect, st.brush ?? 'ink');
    return [{ id, points, pressure: [...st.views.front.pressure], brush: st.size ? { ...brush, size: st.size } : brush, color: st.color, fromP: drawOnEnd(points, P, S) }];
  });
  const at = (f: number) => Math.min(Math.max(0, clip.frames - 1), Math.max(0, f));
  return {
    I,
    jEnd: jEnd(aftermath.seconds),
    seed,
    frame,
    floor: { ratio: floor.ratio, majorDeg: floor.majorDeg, up: [floor.up[0], floor.up[1]], persp: floor.persp },
    width: W,
    height: H,
    palette: rig.palette,
    flash: frames.flash,
    posters: frames.count === 7,
    crackEase: slam.ease?.cracks ?? 'out',
    aftermath: { seconds: aftermath.seconds, scale: aftermath.scale, scarSeconds: aftermath.scarSeconds },
    tier: rig.cuts.tier,
    personMask: (f) => clip.personMask(at(f)),
    faceMask: (f) => clip.faceMask(at(f)),
    cracks,
  };
}

// His height on the internal frame: the person mask's box at I, or the
// nearest frame's within ±15.
function personHeight(clip: ImpactClip, I: number, H: number): number | null {
  for (let d = 0; d <= SIGMA_REACH; d++) {
    for (const f of d === 0 ? [I] : [I - d, I + d]) {
      if (f < 0 || f >= clip.frames) continue;
      const m = clip.personMask(f);
      const box = m ? maskBox(m) : null;
      if (m && box) return ((box.y1 - box.y0) * H) / m.height;
    }
  }
  return null;
}

// Each stroke an emerge moment covers, and the frame it emerges on.
function emergeFrames(effect: Effect): Map<number, number> {
  const out = new Map<number, number>();
  for (const m of effect.moments ?? []) {
    if (m.kind !== 'emerge') continue;
    const ids = (m as EmergeMoment).strokes ?? effect.strokes.filter((st) => EMERGING.includes(st.brush)).map((st) => st.id);
    for (const id of ids) out.set(id, frameAt(m.at));
  }
  return out;
}

// The frame a stroke was drawn on: its emergence (the limbs grow out on the
// frame they were drawn on), else its point anchor's time, else 0.
function drawnFrame(rig: Rig, st: Stroke): number {
  const at = rig.emerge.get(st.id) ?? (st.anchor.type === 'point' ? frameAt(st.anchor.time) : 0);
  return Math.min(Math.max(0, rig.clip.frames - 1), Math.max(0, at));
}

// A stroke in clip px on frame f: torso space through the anchor track (or
// its point anchor) at the torso height of the frame it was drawn on, as
// app/engine.ts places it; ground strokes as they are.
function strokePx(rig: Rig, st: Stroke, f: number): Vec2[] {
  const { clip } = rig;
  const unit = unitNear(clip.units ?? null, drawnFrame(rig, st)) ?? TORSO_SHARE * clip.height;
  let at: TorsoTransform | null = null;
  if (st.anchor.type === 'concept' && clip.poses.length > 0) at = anchorTransform(clip.poses[Math.min(clip.poses.length - 1, Math.max(0, f))], unit);
  else if (st.anchor.type === 'point') at = { x: st.anchor.xy[0], y: st.anchor.xy[1], angle: 0, unit };
  return st.views.front.points.map((p): Vec2 => (at ? toPixels(at, p) : [p[0], p[1]]));
}

// The torso height on frame f, or the nearest frame's that has one.
function unitNear(units: readonly (number | null)[] | null, f: number): number | null {
  if (!units) return null;
  for (let d = 0; d < units.length; d++) {
    const found = units[f - d] ?? units[f + d];
    if (found != null) return found;
  }
  return null;
}

// The physics, once: the turn, the bodies, and the limbs on every frame.
function liftOf(rig: Rig): Lift {
  if (rig.lift) return rig.lift;
  const { clip, effect } = rig;
  const t0 = rig.now?.() ?? 0;
  const n = clip.frames;
  const poses = clip.poses.length > 0 ? Array.from({ length: n }, (_, f) => clip.poses[Math.min(f, clip.poses.length - 1)]) : [];
  const stand = clip.bodies ? [...clip.bodies] : null;
  const good = stand ? goodStandIns(stand, { mask: (f) => clip.personMask(f), width: clip.width, height: clip.height }) : undefined;
  const read = turnKeys(effect.turn, stand, FPS, good);
  let keys = read.keys;
  let checked: TurnRead['checked'] = null;
  if (read.from === 'pose' && rig.opts.turn) {
    const c = checkedTurn(read.keys, rig.opts.turn.known, rig.opts.turn.from, rig.opts.turn.to, rig.opts.turn.maxDeg ?? 45);
    keys = c.keys;
    checked = { used: c.used, error: c.error };
  }
  const limbStrokes = effect.strokes.filter((st) => rig.limbs.has(st.id));
  const drawn = limbStrokes.length > 0 ? drawnFrame(rig, limbStrokes[0]) : 0;
  const unit0 = unitNear(clip.units ?? null, drawn) ?? TORSO_SHARE * clip.height;
  const bend = stand ? torsoBend(stand, drawn, FPS, good) : null;
  const bodies = poses.length > 0 ? liftBodies(poses, unit0, drawn, keys, bend) : [];
  let frames: Frame3D[] = [];
  if (limbStrokes.length > 0 && bodies.length === n && n > 0) {
    const px = new Map<number, Vec2[]>();
    const lifted: Lifted[] = limbStrokes.map((st) => {
      const f = drawnFrame(rig, st);
      const points = strokePx(rig, st, f);
      px.set(st.id, points);
      return liftStroke(st.id, points, [...st.views.front.pressure], bodies[f], st.kind, st.stiffness, st.wobble);
    });
    const slamIds = limbStrokes.filter((st) => rig.limbs.get(st.id)?.slam).map((st) => st.id);
    const I = rig.I;
    const control =
      I !== null && rig.slam && rig.base && slamIds.length > 0 && I >= 0 && I < n
        ? strikeController({
            ...limbsFirst(I),
            P: [rig.slam.xy[0], rig.slam.xy[1]],
            d: rig.slam.dir ? [rig.slam.dir[0], rig.slam.dir[1]] : [0, 1],
            limbs: slamIds.map((id) => ({ id, side: bulgeSide(px.get(id) ?? []) })),
            unit: bodies[I].unit,
            seed: rig.base.seed,
            dps: rig.dps,
          })
        : undefined;
    frames = animate3d({
      strokes: lifted,
      bodies,
      frames: n,
      dps: rig.dps,
      boil: rig.opts.boil ?? EXAMPLE_TIMING.boil,
      width: clip.width,
      emerge: new Map(limbStrokes.flatMap((st) => (rig.emerge.has(st.id) ? [[st.id, rig.emerge.get(st.id) as number] as const] : []))),
      control,
      slam: I !== null && rig.base ? { I, posters: rig.base.posters } : undefined,
    });
  }
  const start: number[] = [];
  frames.forEach((fr, f) => start.push(f > 0 && frames[f - 1].capture === fr.capture ? start[f - 1] : f));
  const ms = rig.now && n > 0 ? (rig.now() - t0) / n : 0;
  rig.lift = { bodies, frames, start, turn: { keys, from: read.from, checked }, ms };
  return rig.lift;
}

// The limbs on clip frame f as tubes on the internal frame, far first.
function tubesAt(rig: Rig, f: number): Tube[] {
  const hit = rig.tubes.get(f);
  if (hit) return hit;
  const fr = liftOf(rig).frames[f];
  const s = rig.s;
  const tubes = fr
    ? [...fr.placed]
        .sort((a, b) => a.depth - b.depth)
        .map((p) =>
          buildTube(
            { id: p.id, points: p.points.map((q): Vec2 => [q[0] * s, q[1] * s]), z: p.z.map((z) => z * s), pressure: p.pressure, front: p.front, length: p.length * s },
            rig.R0,
            { taper: rig.settings.taper },
          ),
        )
    : [];
  if (rig.tubes.size >= MEMO) rig.tubes.delete(rig.tubes.keys().next().value as number);
  rig.tubes.set(f, tubes);
  return tubes;
}

// The mean of the limbs' roots on clip frame f, internal px.
function meanRoot(rig: Rig, f: number): Vec2 {
  const placed = liftOf(rig).frames[f]?.placed ?? [];
  if (placed.length === 0) return [0, 0];
  let x = 0;
  let y = 0;
  for (const p of placed) {
    x += p.points[0][0];
    y += p.points[0][1];
  }
  return [(x / placed.length) * rig.s, (y / placed.length) * rig.s];
}

// His torso's similarity from frame t to frame c, internal px: what carries a
// held drawing placed on t to where it's placed on c.
function torsoSimilarity(bt: Body3D, bc: Body3D, s: number): Matrix {
  const k = bc.unit / bt.unit;
  const phi = bc.roll - bt.roll;
  const a = k * Math.cos(phi);
  const b = k * Math.sin(phi);
  return [a, b, -b, a, s * bc.x - (a * s * bt.x - b * s * bt.y), s * bc.y - (b * s * bt.x + a * s * bt.y)];
}

const isIdentity = (m: Matrix) => m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;

// The limbs' layers' box: every section ± its radius, 0.15 S + 2·r_max round
// that (the arcs, the pops and the sparks), and P (the tip arcs), whole
// pixels on the frame; null when it's off the frame.
function limbBox(tubes: readonly Tube[], P: Vec2 | null, S: number, W: number, H: number): Box | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let rMax = 0;
  for (const tube of tubes) {
    for (const { screen, r } of tube.sections) {
      x0 = Math.min(x0, screen[0] - r);
      y0 = Math.min(y0, screen[1] - r);
      x1 = Math.max(x1, screen[0] + r);
      y1 = Math.max(y1, screen[1] + r);
      rMax = Math.max(rMax, r);
    }
  }
  if (!(x1 >= x0)) return null;
  if (P) {
    x0 = Math.min(x0, P[0]);
    y0 = Math.min(y0, P[1]);
    x1 = Math.max(x1, P[0]);
    y1 = Math.max(y1, P[1]);
  }
  const pad = LIMB_PAD * S + 2 * rMax;
  const box = { x0: Math.max(0, Math.floor(x0 - pad)), y0: Math.max(0, Math.floor(y0 - pad)), x1: Math.min(W, Math.ceil(x1 + pad)), y1: Math.min(H, Math.ceil(y1 + pad)) };
  return box.x1 > box.x0 && box.y1 > box.y0 ? box : null;
}

// ---- Parts ----------------------------------------------------------------------------------

function stored(rig: Rig, key: string): DrawnPart | undefined {
  const hit = rig.store.get(key);
  if (hit) {
    rig.store.delete(key);
    rig.store.set(key, hit);
  }
  return hit;
}

function keep(rig: Rig, part: DrawnPart): DrawnPart {
  rig.store.delete(part.key);
  rig.store.set(part.key, part);
  while (rig.store.size > STORE_SIZE) rig.store.delete(rig.store.keys().next().value as string);
  return part;
}

// A fresh canvas the size of `box`, drawing in frame px.
function boxCanvas(make: MakeScratch, box: Box): { canvas: unknown; ctx: BrushTarget } {
  const sc = make(box.x1 - box.x0, box.y1 - box.y0);
  sc.ctx.setTransform(1, 0, 0, 1, -box.x0, -box.y0);
  sc.ctx.globalCompositeOperation = 'source-over';
  sc.ctx.globalAlpha = 1;
  return sc;
}

function partOf(key: string, slot: DrawnPart['slot'], name: string, box: Box | null, canvas: unknown, glow?: DrawnGlow[]): DrawnPart {
  if (!box) return { key, slot, name, image: null, x0: 0, y0: 0, width: 0, height: 0, glow };
  return { key, slot, name, image: canvas, x0: box.x0, y0: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0, glow };
}

// A part drawn into a canvas the size of its box.
function drawPart(make: MakeScratch, key: string, slot: DrawnPart['slot'], name: string, box: Box | null, draw: (ctx: BrushTarget) => void, glow?: DrawnGlow[]): DrawnPart {
  if (!box) return partOf(key, slot, name, null, null, glow);
  const sc = boxCanvas(make, box);
  draw(sc.ctx);
  sc.ctx.setTransform(1, 0, 0, 1, 0, 0);
  return partOf(key, slot, name, box, sc.canvas, glow);
}

// A part laid on the frame at `alpha`, through T.
function blit(part: DrawnPart, alpha = 1, T: Matrix = IDENTITY): LayerDraw {
  return {
    key: null,
    draw: (ctx) => {
      if (!part.image || !(alpha > 0)) return;
      if (!isIdentity(T)) (ctx as StackTarget).transform(T[0], T[1], T[2], T[3], T[4], T[5]);
      if (alpha < 1) ctx.globalAlpha *= alpha;
      ctx.drawImage(part.image as never, 0, 0, part.width, part.height, part.x0, part.y0, part.width, part.height);
    },
  };
}

// What a mass part needs: its content key, its alpha on the frame, and how to draw it.
interface PartSpec {
  name: string;
  slot: StackSlot;
  key: string;
  alpha: number;
  box(): Box | null;
  paint(ctx: BrushTarget, make: MakeScratch): void;
}

// A mass drawing (fire.ts's MassDrawing) as a part: painted opaque, faded by the blit.
function massSpec(name: string, slot: StackSlot, key: string, alpha: number, drawing: () => MassDrawing | null, W: number, H: number): PartSpec {
  let d: MassDrawing | null | undefined;
  const get = () => (d === undefined ? (d = drawing()) : d);
  return {
    name,
    slot,
    key,
    alpha,
    box: () => {
      const m = get();
      return m ? boxOf(m.shapes.map((sh) => sh.points), PART_PAD, W, H) : null;
    },
    paint: (ctx) => paint(ctx, get(), true),
  };
}

// ---- Glow -----------------------------------------------------------------------------------

function replay(sink: GlowSink, calls: readonly GlowCall[]) {
  for (const c of calls) {
    if (c.op === 'stroke') sink.stroke(c.points, c.width, c.color, c.kind, c.gain);
    else if (c.op === 'fill') sink.fill(c.outline, c.color, c.kind, c.gain);
    else if (c.op === 'disc') sink.disc(c.c, c.r, c.color, c.gain);
    else sink.wash(c.outline, c.color, c.gain);
  }
}

// A limb part's recorded glow in glow buffers, blurred: one per DrawnGlow.
function glowSet(rig: Rig, part: DrawnPart, make: MakeScratch): Glow[] {
  const hit = rig.glowSets.get(part.key);
  if (hit) {
    rig.glowSets.delete(part.key);
    rig.glowSets.set(part.key, hit);
    return hit;
  }
  const set = (part.glow ?? []).map((g) => {
    const glow = rig.spare.pop() ?? createGlow(make, rig.W, rig.H, { main: rig.palette[0] });
    replay(glow, g.calls);
    glow.blur();
    return glow;
  });
  rig.glowSets.set(part.key, set);
  while (rig.glowSets.size > GLOW_SETS) {
    const [key, old] = rig.glowSets.entries().next().value as [string, Glow[]];
    rig.glowSets.delete(key);
    for (const g of old) {
      g.clear();
      rig.spare.push(g);
    }
  }
  return set;
}

// A glow of the frame's own (the strike's, the lightning's, the flood's, the
// charge's), re-emitted only when what it shows changes.
function worldGlow(rig: Rig, make: MakeScratch, name: string, content: string, calls: () => readonly GlowCall[]): Glow {
  let w = rig.world.get(name);
  if (!w) rig.world.set(name, (w = { glow: createGlow(make, rig.W, rig.H, { main: rig.palette[0] }), content: '' }));
  if (w.content !== content) {
    w.glow.clear();
    replay(w.glow, calls());
    w.content = content;
  }
  return w.glow;
}

// ---- The face cut ----------------------------------------------------------------------------

// The cut at quarter size: 255 within 0.03 S of the source, falling linearly
// to 0 at 0.05 S, from a two-pass chamfer distance (weights 3 and 4, within
// 6 % of the true distance).
function cutMask(inside: (x: number, y: number) => boolean, W: number, H: number, S: number): Mask {
  const q = CUT.quarter;
  const w = Math.ceil(W / q);
  const h = Math.ceil(H / q);
  const far = 1e9;
  const d = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = inside((x + 0.5) * q, (y + 0.5) * q) ? 0 : far;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (v === 0) continue;
      if (x > 0) v = Math.min(v, d[i - 1] + 3);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 3);
        if (x > 0) v = Math.min(v, d[i - w - 1] + 4);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + 4);
      }
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (v === 0) continue;
      if (x < w - 1) v = Math.min(v, d[i + 1] + 3);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 3);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + 4);
        if (x > 0) v = Math.min(v, d[i + w - 1] + 4);
      }
      d[i] = v;
    }
  }
  const reach = ((CUT.reach * S) / q) * 3;
  const feather = ((CUT.feather * S) / q) * 3;
  const alpha = new Uint8ClampedArray(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = d[i] <= reach ? 255 : d[i] >= reach + feather ? 0 : Math.round((255 * (reach + feather - d[i])) / feather);
  return { width: w, height: h, alpha };
}

// The face cut on clip frame c: from his face mask, or the top 20 % of his box.
function faceCut(rig: Rig, c: number): Mask | null {
  const { W, H, S, clip } = rig;
  const f = Math.min(Math.max(0, clip.frames - 1), Math.max(0, c));
  const face = clip.faceMask(f);
  if (face) {
    let cut = rig.faces.get(face);
    if (!cut) {
      const sx = face.width / W;
      const sy = face.height / H;
      cut = cutMask((x, y) => face.alpha[Math.min(face.height - 1, Math.floor(y * sy)) * face.width + Math.min(face.width - 1, Math.floor(x * sx))] >= 128, W, H, S);
      rig.faces.set(face, cut);
    }
    return cut;
  }
  const person = clip.personMask(f);
  const box = person ? maskBox(person) : null;
  if (!person || !box) return null;
  let cut = rig.heads.get(person);
  if (!cut) {
    const sx = person.width / W;
    const sy = person.height / H;
    const bottom = box.y0 + CUT.head * (box.y1 - box.y0);
    cut = cutMask((x, y) => x * sx >= box.x0 && x * sx < box.x1 && y * sy >= box.y0 && y * sy < bottom, W, H, S);
    rig.heads.set(person, cut);
  }
  return cut;
}

// His mask's edge within 0.3 U of P, internal px: the runs of its traced
// outline that stay inside that reach.
function maskEdge(rig: Rig, ictx: ImpactContext, mask: Mask): Vec2[][] {
  const hit = rig.edges.get(mask);
  if (hit) return hit;
  const { W, H } = rig;
  const P = ictx.frame.P;
  const R = EDGE_REACH * ictx.frame.U;
  const sx = mask.width / W;
  const sy = mask.height / H;
  const half = EDGE_CROP * R * Math.max(sx, sy) + 4;
  const x0 = Math.max(0, Math.floor(P[0] * sx - half));
  const x1 = Math.min(mask.width, Math.ceil(P[0] * sx + half));
  const y0 = Math.max(0, Math.floor(P[1] * sy - half));
  const y1 = Math.min(mask.height, Math.ceil(P[1] * sy + half));
  const runs: Vec2[][] = [];
  if (x1 > x0 && y1 > y0) {
    const w = x1 - x0;
    const alpha = new Uint8ClampedArray(w * (y1 - y0));
    for (let y = y0; y < y1; y++) alpha.set(mask.alpha.subarray(y * mask.width + x0, y * mask.width + x1), (y - y0) * w);
    for (const loop of traceMask({ width: w, height: y1 - y0, alpha }).loops) {
      let run: Vec2[] = [];
      for (const [mx, my] of loop) {
        const p: Vec2 = [(mx + x0) / sx, (my + y0) / sy];
        if (Math.hypot(p[0] - P[0], p[1] - P[1]) <= R) run.push(p);
        else {
          if (run.length >= 2) runs.push(run);
          run = [];
        }
      }
      if (run.length >= 2) runs.push(run);
    }
  }
  rig.edges.set(mask, runs);
  return runs;
}

// ---- One ladder step ------------------------------------------------------------------------

type LayerTarget = LimbTarget & ArcTarget & PopTarget;

function sceneOf(rig: Rig, step: number): ImpactScene {
  const known = rig.scenes.get(step);
  if (known) return known;
  const { W, H, S, s, I, clip } = rig;
  const base = rig.base;
  const degrade = degradeAt(step, base?.flash ?? 'full');
  const gentle = base?.flash === 'safe';
  const still = gentle && degrade.posters === 'none'; // the ladder's step 7
  const ictx: ImpactContext | null = base ? { ...base, posters: base.posters && degrade.posters === 'seven' } : null;
  const ectx: MassContext | null = ictx ? { ...ictx, dps: rig.dps } : null;
  const washOpts: WashOptions = { washes: degrade.washes, noFlash: degrade.noFlash };
  const plan: PosterPlan | null = base ? posterPlan({ flash: base.flash, posters: base.posters, ladder: degrade.step }) : null;
  const plans = new Map<number, LightningPlan | null>();
  let layout: PosterLayout | null = null;
  let times: Record<string, number> = {};
  const now = rig.now;
  const make = rig.opts.make;
  const tones = arcTones(rig.palette);
  const pulseTones = limbTones(rig.palette);
  const length = ladderLength(clip.frames, I, degrade);

  const clipOf = (o: number) => ladderClipOf(o, I, degrade);
  const posterOn = (o: number): PosterSpec | null => (I !== null && plan ? posterAt(plan, o - I) : null);
  const timed = (line: string, draw: (ctx: BrushTarget) => void): ((ctx: BrushTarget) => void) => {
    if (!now) return draw;
    return (ctx) => {
      const t0 = now();
      draw(ctx);
      times[line] = (times[line] ?? 0) + now() - t0;
    };
  };

  // ---- Limbs ----

  const limbView = (c: number): LimbView | null => {
    const lift = liftOf(rig);
    const fr = lift.frames[c];
    if (!fr || fr.placed.length === 0) return null;
    const kind: LimbDrawing = I === null || !ictx ? 'grid' : limbDrawingAt(c, I, rig.strike, ictx.posters);
    if (kind === 'tube' || kind === 'silhouette') return { kind, t: c, T: IDENTITY };
    if (kind === 'stamp' && ictx) return { kind, t: c - 1, T: pinnedSimilarity(meanRoot(rig, c - 1), meanRoot(rig, c), ictx.frame.P) };
    const t = lift.start[c];
    return { kind, t, T: t === c ? IDENTITY : torsoSimilarity(lift.bodies[t], lift.bodies[c], s) };
  };

  const limbKeys = (t: number) => [`limbsBehind:${t}`, `limbsFront:${t}`] as const;

  // The limb drawing made on clip frame t: both layers, all the limbs, their
  // arcs, pulses and pops, and their glow as recorded calls (decision 8's
  // look: the root burst, the crackle, the key light swinging to P).
  const limbParts = (t: number, mk: MakeScratch): [DrawnPart, DrawnPart] | null => {
    const [kb, kf] = limbKeys(t);
    const hb = stored(rig, kb);
    const hf = stored(rig, kf);
    if (hb && hf) return [hb, hf];
    const tubes = tubesAt(rig, t);
    if (tubes.length === 0) return null;
    const j = I === null ? null : t - I;
    const k = limbClock(t, I, rig.dps);
    const P = ictx?.frame.P ?? null;
    const sw = ictx ? keySwing(j, ictx.jEnd) : 0;
    const swing = sw > 0 && P ? { P, w: sw } : null;
    const plate = clip.luma?.(t) ?? null;
    const luma: PlateLuma | null = plate ? (x, y) => plate(x / s, y / s) : null;
    const mask = clip.personMask(Math.min(Math.max(0, clip.frames - 1), t));
    const fireOn = ectx !== null && (massClock(ectx, t)?.g ?? Infinity) <= 1;
    const clear = FIRE_CLEAR * (ictx?.frame.U ?? 0);
    const box = limbBox(tubes, P, S, W, H);
    const steady = recordingSink();
    const arcs: DrawnGlow[] = [];
    const back = box ? boxCanvas(mk, box) : null;
    const front = box ? boxCanvas(mk, box) : null;
    const b = (back?.ctx ?? null) as LayerTarget | null;
    const f = (front?.ctx ?? null) as LayerTarget | null;
    const newPath = rig.newPath;
    for (const tube of tubes) {
      const info = rig.limbs.get(tube.id);
      if (!info) continue;
      const age = info.emergeK === null ? undefined : k - info.emergeK;
      const phase = arcPhase(age ?? null, j);
      if (!phase) continue;
      const { spans, pops } = gentle ? QUIET : pulsesAt(tube.id, k, info.timeline);
      const outline = luma ? outlineClasses(tube, luma, { S, palette: rig.palette, settings: rig.settings }) : null;
      // While the burst shows (A0–2) the tip arcs wait for A3, and no arc
      // glows within FIRE_CLEAR U of P, so the flame reads (judge round 1).
      const { far, near } = sheathArcs(tube, k, phase, tube.id, { S, P: P && !fireOn ? P : undefined, idle: rig.settings.arcs, lift: rig.settings.arcLift, fewer: rig.cuts.fewerArcs });
      const side = (runs: ArcRun[], inFront: boolean) => runs.filter((run) => run.front === inFront);
      if (b && f) {
        drawArcs(b, side(far, false), tones, newPath);
        drawArcs(f, side(far, true), tones, newPath);
        drawLimb(b, f, tube, { S, k, palette: rig.palette, settings: rig.settings, age, pulses: spans, swing, outline, mask, maskScale: mask ? mask.width / W : 1, glow: steady });
        drawArcs(b, side(near, false), tones, newPath);
        drawArcs(f, side(near, true), tones, newPath);
        for (const pop of pops) drawPops(sectionAt(tube, pop.s).front ? f : b, tube, [pop], tones);
      }
      emitPulses(steady, tube, spans, 1, pulseTones);
      emitPops(steady, tube, pops, 1, tones);
      const own = recordingSink();
      emitArcs(own, fireOn && P ? [...far, ...near].filter((run) => run.points.every((q) => Math.hypot(q[0] - P[0], q[1] - P[1]) > clear)) : [...far, ...near], 1, tones);
      if (own.calls.length > 0) arcs.push({ id: tube.id, calls: own.calls });
    }
    back?.ctx.setTransform(1, 0, 0, 1, 0, 0);
    front?.ctx.setTransform(1, 0, 0, 1, 0, 0);
    const glow: DrawnGlow[] = [{ id: null, calls: steady.calls }, ...arcs];
    return [keep(rig, partOf(kb, 'limbsBehind', 'limbsBehind', box, back?.canvas ?? null)), keep(rig, partOf(kf, 'limbsFront', 'limbsFront', box, front?.canvas ?? null, glow))];
  };

  // ---- Masses ----

  // The parts the masses draw on clip frame c, in stack order: the cracks,
  // the fire or the cluster, the dust, then the front FX's wisps, debris, the
  // A5–6 veil and the particles, then the A5–6 flash. The keys are the
  // clocks' (cheap): each says what the drawing shows, its fade apart. The
  // veil and the flash cut the person out of the frame's own mask, so they
  // are drawn per frame.
  const massSpecs = (c: number): PartSpec[] => {
    if (!ectx || I === null) return [];
    const out: PartSpec[] = [];
    const j = c - I;
    const cc = crackClock(ectx, c);
    if (cc) out.push(massSpec('cracks', 'cracks', `cracks:${cc.fraction.toFixed(4)}:${cc.cool.toFixed(5)}`, cc.alpha, () => crackShapes(ectx, c), W, H));
    const mc = massClock(ectx, c);
    if (!mc || !(mc.alpha > 0)) return out;
    const calm = still ? STILL_MASS : gentle ? GENTLE_MASS : 1;
    const flare = still ? STILL_MASS : gentle ? GENTLE_FIRE : 1;
    // The burst and the cluster stand in front of him, face-cut like the veil
    // (judge round 1: he crouches over P and hid them); the dust stays behind.
    // Reduce flashing keeps them behind him at his size (fire.ts massFrame).
    const front: StackSlot = gentle ? 'fire' : 'fx';
    if (mc.g <= 1) out.push(massSpec('fire', front, `fire:${mc.g}:${mc.start}`, flare * mc.alpha, () => fireShapes(ectx, c), W, H));
    else out.push(massSpec('cluster', front, `cluster:${mc.g}:${mc.start}`, calm * mc.alpha, () => clusterShapes(ectx, c), W, H));
    if (mc.g >= 1) out.push(massSpec('dust', 'dust', `dust:${mc.g}:${mc.start}`, calm * mc.alpha, () => dustShapes(ectx, c), W, H));
    const age = drawingAge(ectx, c);
    // Reduce flashing holds the wisps under +0.08 L, like the veil (washes.ts's liftCap).
    const wispAlpha = gentle ? Math.min(wispOpacity(age.A), liftCap(rig.palette[1])) : wispOpacity(age.A);
    if (wispKind(age.A)) out.push(massSpec('wisps', 'fx', `wisp:${age.k}:${age.A}:${age.start}`, wispAlpha * mc.alpha, () => wispShapes(ectx, c), W, H));
    out.push(massSpec('debris', 'fx', `debris:${mc.g}:${mc.start}:${chunkDrawing(ectx, c)}`, calm * mc.alpha, () => debrisShapes(ectx, c), W, H));
    const v = veilShapes(ectx, c, washOpts);
    if (v) {
      out.push({ name: 'veil', slot: 'fx', key: `veil:${c}`, alpha: 1, box: () => boxOf([v.rings[0]], PART_PAD, W, H), paint: (ctx, mk) => paintVeil(ctx, mk, v, ectx.personMask(c), W, H) });
    }
    const gc = groupClock(ectx, c);
    const pf = gc ? particles(ectx, c, { half: rig.cuts.halfParticles }) : null;
    if (gc && pf) {
      const opaque: ParticleFrame = { ...pf, alpha: 1 };
      out.push({
        name: 'particles',
        slot: 'fx',
        key: `particles:${gc.g}:${gc.start}:${rig.cuts.halfParticles ? 'half' : 'all'}`,
        alpha: calm * pf.alpha,
        box: () => {
          const sh = particleShapes(ectx, pf);
          return boxOf([...sh.embers.flatMap((e) => e.polys), ...sh.rings, ...sh.sparks], PART_PAD, W, H);
        },
        paint: (ctx, mk) => paintParticles(ctx, mk, ectx, opaque),
      });
    }
    const fl = j >= 9 ? flashShapes(ectx, c, washOpts) : null;
    if (fl) out.push({ name: 'flash', slot: 'flash', key: `flash:${c}`, alpha: 1, box: () => ({ x0: 0, y0: 0, x1: W, y1: H }), paint: (ctx, mk) => paintFlash(ctx, mk, fl, ectx.personMask(c), W, H) });
    return out;
  };

  const ensure = (sp: PartSpec, mk: MakeScratch): DrawnPart => stored(rig, sp.key) ?? keep(rig, drawPart(mk, sp.key, sp.slot, sp.name, sp.box(), (ctx) => sp.paint(ctx, mk)));

  // ---- The 1s energy ----

  // The strike on j −8..−1: step s from the slam limbs' tubes on its first frame.
  const strikePart = (j: number): DrawnPart | null => {
    if (!ictx || I === null) return null;
    const step = strikeStep(j);
    const first = strikeHold(j);
    if (step === null || first === null) return null;
    const key = `strike:${step}:${degrade.calm ? 'calm' : 'full'}`;
    const hit = stored(rig, key);
    if (hit) return hit;
    const limbs = tubesAt(rig, I + first)
      .filter((tube) => rig.limbs.get(tube.id)?.slam)
      .map(strikeLimbOf);
    const plan = planStrike(ictx, step, limbs, strikeOptions(ictx.flash, degrade.step));
    const polys: Vec2[][] = plan.beams.map((beam) => beam.silhouette);
    if (plan.splash) {
      polys.push(...splashCover(plan.splash.pieces, plan.splash.rim));
      for (const piece of plan.splash.pieces) for (const part of piece.parts) polys.push(part.shape, ...part.teeth);
    }
    let widest = 0;
    for (const burst of plan.bursts) {
      polys.push(burst.points);
      widest = Math.max(widest, ...burst.width);
    }
    const rec = recordingSink();
    const part = drawPart(make, key, 'fx', 'strike', boxOf(polys, PART_PAD + widest + BURST_PAD, W, H), (ctx) => paintStrike(ctx, rec, ictx, plan));
    part.glow = [{ id: null, calls: rec.calls }];
    return keep(rig, part);
  };

  // The lightning on clip frame c: the plan of its kr step (or of its 2s
  // drawing, cut 1), crawling along the sources on that step's first frame.
  const lightningPlan = (c: number): LightningPlan | null => {
    if (!ictx || !ectx || I === null) return null;
    const j = c - I;
    if (j < 9 || j > ictx.jEnd) return null;
    if (still) return null;
    const jl = rig.cuts.lightning2s || gentle ? Math.max(drawingStart(drawingIndex(c, rig.dps), rig.dps), I + 9) - I : krSpan(j).first;
    const memo = plans.get(jl);
    if (memo !== undefined) return memo;
    const cl = Math.min(clip.frames - 1, Math.max(0, I + jl));
    const sources: Vec2[][] = [];
    // Reduce flashing keeps to the still sources, the cracks and the floor
    // arcs, and draws steady: the ribbons crackle in place (GENTLE_BOLT_GLOW).
    const ol = gentle ? null : clusterOutline(ectx, cl);
    if (ol && ol.length >= 2) sources.push(ol);
    for (const cr of ictx.cracks) sources.push(cr.points);
    const mask = gentle ? null : clip.personMask(cl);
    if (mask) sources.push(...maskEdge(rig, ictx, mask));
    // The limbs only where they reach P (judge 1): runs of their points within
    // EDGE_REACH U of it, so the lightning crawls off the hit, not along them.
    const reach = EDGE_REACH * ictx.frame.U;
    const P = ictx.frame.P;
    for (const p of gentle ? [] : liftOf(rig).frames[cl]?.placed ?? []) {
      let run: Vec2[] = [];
      for (const q of p.points) {
        const v: Vec2 = [q[0] * s, q[1] * s];
        if (Math.hypot(v[0] - P[0], v[1] - P[1]) <= reach) run.push(v);
        else {
          if (run.length >= 2) sources.push(run);
          run = [];
        }
      }
      if (run.length >= 2) sources.push(run);
    }
    const lp = ribbons(ictx, jl, sources, { ...washOpts, maxRibbons: rig.cuts.maxRibbons, steady: gentle });
    if (plans.size >= MEMO) plans.delete(plans.keys().next().value as number);
    plans.set(jl, lp);
    return lp;
  };

  const lightningPart = (lp: LightningPlan): DrawnPart => {
    const key = `lightning:${lp.key}`;
    const hit = stored(rig, key);
    if (hit) return hit;
    const rec = recordingSink();
    emitLightning(rec, lp);
    const part = drawPart(make, key, 'fx', 'lightning', boxOf(lightningShapes(lp).edge, PART_PAD, W, H), (ctx) => paintLightning(ctx, make, lp, W, H));
    part.glow = [{ id: null, calls: rec.calls }];
    return keep(rig, part);
  };

  // ---- Posters ----

  // The clip frame poster si's figure is read on: its first output frame's.
  const figClipOf = (spec: PosterSpec): number => {
    const first = plan ? plan.steps.findIndex((st) => st !== null && st.si === spec.si) : 0;
    return clipOf((I ?? 0) + Math.max(0, first));
  };
  const posterKey = (spec: PosterSpec, fig: number) => `poster:${spec.si}:${spec.field}:${spec.disc}:${spec.minL}:${spec.redSafe ? 1 : 0}:${spec.glint ? 1 : 0}:${spec.calm ? 1 : 0}:${fig}`;

  // The poster, baked with its glow into a frame-sized canvas (the dark
  // fields' hot ramp; the light ones have none).
  const posterPart = (spec: PosterSpec, fig: number, mk: MakeScratch): DrawnPart => {
    const key = posterKey(spec, fig);
    const hit = stored(rig, key);
    if (hit || !ictx) return hit ?? partOf(key, 'poster', 'poster', null, null);
    const pctx = ictx;
    const sheet = (layout ??= posterLayout(pctx));
    const figure = posterFigure(pctx, spec.si, { person: clip.personMask(fig), limbs: tubesAt(rig, fig).map((tube) => silhouette(tube)) });
    let glow: Glow | null = null;
    if (spec.field === 'dark') {
      const ramp = posterHotRamp(spec);
      const id = ramp.join();
      glow = rig.posterGlows.get(id) ?? null;
      if (!glow) rig.posterGlows.set(id, (glow = createGlow(mk, W, H, { ramp })));
      glow.clear();
    }
    const part = drawPart(mk, key, 'poster', 'poster', { x0: 0, y0: 0, x1: W, y1: H }, (ctx) => {
      drawPoster(ctx as unknown as PosterTarget, glow ?? nullSink, pctx, spec.si, figure, { spec, layout: sheet, scratch: mk });
      glow?.composite(ctx);
    });
    return keep(rig, part);
  };

  // ---- One frame ----

  const frameLayers = (o: number): SceneLayers => {
    const t0 = now?.() ?? 0;
    times = {};
    const c = clipOf(o);
    const j = I === null ? null : c - I;
    const parts: ScenePart[] = [];
    const slots: Partial<Record<StackSlot, LayerDraw[]>> = {};
    const gains: Record<string, number> = {};
    const add = (slot: StackSlot, name: string, key: string, alpha: number, line: string, layer: LayerDraw) => {
      const timedLayer: LayerDraw = { key: null, draw: timed(line, layer.draw) };
      (slots[slot] ??= []).push(timedLayer);
      parts.push({ slot, name, key, alpha, layer: timedLayer });
    };

    // The posters replace the stack, camera and all.
    const spec = posterOn(o);
    if (spec && ictx) {
      const part = posterPart(spec, figClipOf(spec), make);
      const layer = blit(part);
      if (now) times.layers = now() - t0;
      return {
        o,
        clip: c,
        j,
        poster: layer,
        slots: {},
        faceCut: null,
        phase: { kind: 'poster', si: spec.si },
        camera: null,
        grade: null,
        limbs: null,
        posterSpec: spec,
        parts: [{ slot: 'poster', name: 'poster', key: part.key, alpha: 1, layer }],
        gains,
      };
    }

    // The limbs, behind the person and over him.
    const view = limbView(c);
    let limbGlow: { part: DrawnPart; T: Matrix } | null = null;
    if (view && view.kind !== 'silhouette') {
      const lp = limbParts(view.t, make);
      if (lp) {
        add('limbsBehind', 'limbsBehind', lp[0].key, 1, 'stamp', blit(lp[0], 1, view.T));
        add('limbsFront', 'limbsFront', lp[1].key, 1, 'stamp', blit(lp[1], 1, view.T));
        limbGlow = { part: lp[1], T: view.T };
      }
    }

    // The frame's own glows, composited together after the layers.
    const world: { name: string; content: string; calls: () => readonly GlowCall[]; gain: number }[] = [];

    // The strike, j −8..−1.
    if (j !== null && j >= -8 && j <= -1) {
      const sp = strikePart(j);
      if (sp) {
        if (sp.image) add('fx', 'strike', sp.key, 1, 'energy', blit(sp));
        world.push({ name: 'strike', content: sp.key, calls: () => sp.glow?.[0]?.calls ?? [], gain: 1 });
      }
    }

    // The charge's white-out on j 0..3, when no posters cover it.
    if (ictx && j !== null && j >= 0 && j <= 3 && !ictx.posters && !degrade.noFlash) {
      const ch = chargeAt(j, false);
      if (ch > 0) {
        const P = ictx.frame.P;
        const r = CHARGE_RADIUS * ictx.frame.U * (1 + 2 * ch);
        const core = strikeTones(rig.palette, ictx.flash).core;
        world.push({ name: 'charge', content: `charge:${j}`, calls: () => [{ op: 'disc', c: [P[0], P[1]], r, color: core, gain: ch }], gain: 1 });
        gains.charge = ch;
      }
    }

    // The masses behind the person; the front FX's 2s parts wait for the floods.
    const specs = massSpecs(c);
    for (const sp of specs) {
      if (sp.slot === 'fx' || sp.slot === 'flash' || !(sp.alpha > 0)) continue;
      const part = ensure(sp, make);
      if (part.image) add(sp.slot, sp.name, sp.key, sp.alpha, 'composite', blit(part, sp.alpha));
    }

    // The floods, then the front FX: the 2s parts, then the lightning, then
    // the A5–6 flash.
    if (ictx && j !== null && j >= 9) {
      const fd: FloodDrawing | null = floodShapes(ictx, j, washOpts);
      if (fd) {
        add('floods', 'flood', fd.key, fd.level, 'energy', { key: null, draw: (ctx) => paintFlood(ctx, make, fd, W, H) });
        world.push({ name: 'flood', content: fd.key.slice(0, fd.key.lastIndexOf(':')), calls: () => floodCalls(fd), gain: fd.level });
        gains.flood = fd.level;
      }
    }
    for (const sp of specs) {
      if (sp.slot !== 'fx' || !(sp.alpha > 0)) continue;
      const part = ensure(sp, make);
      if (part.image) add('fx', sp.name, sp.key, sp.alpha, 'composite', blit(part, sp.alpha));
    }
    const lp = lightningPlan(c);
    if (lp) {
      const part = lightningPart(lp);
      if (part.image) add('fx', 'lightning', part.key, lp.gain, 'energy', blit(part, gentle ? GENTLE_BOLT : 1));
      world.push({ name: 'lightning', content: part.key, calls: () => part.glow?.[0]?.calls ?? [], gain: gentle ? GENTLE_BOLT_GLOW : 1 });
      gains.lightning = lp.gain;
    }
    for (const sp of specs) {
      if (sp.slot !== 'flash' || !(sp.alpha > 0)) continue;
      const part = ensure(sp, make);
      if (part.image) add('flash', sp.name, sp.key, sp.alpha, 'composite', blit(part, sp.alpha));
    }

    // The glow: the limbs' through their stamp (each limb's arcs at its own
    // flicker), then the frame's own; one composite when the stamp is the
    // identity (a fresh drawing), as each composite lays two full images.
    const worldKey = world.map((w) => `${w.content}@${w.gain}`).join('|');
    const worldEntries = () => world.map((w) => [worldGlow(rig, make, w.name, w.content, w.calls), w.gain] as const);
    let worldDone = world.length === 0;
    if (limbGlow && (limbGlow.part.glow?.length ?? 0) > 0) {
      const { part, T } = limbGlow;
      const k1 = c1(c, I);
      const own = part.glow ?? [];
      const arcGains = own.map((g) => (g.id === null ? (gentle ? GENTLE_LIMB_GLOW : 1) : gentle ? GENTLE_ARC : arcFlicker(g.id, k1)));
      own.forEach((g, i) => {
        if (g.id !== null) gains[`arc:${g.id}`] = arcGains[i];
      });
      const limbKey = `${part.key}@${arcGains.map((g) => g.toFixed(4)).join(',')}`;
      const limbEntries = () => glowSet(rig, part, make).map((glow, i) => [glow, arcGains[i]] as const);
      if (isIdentity(T) && !worldDone) {
        add('glow', 'glow', `${limbKey}|${worldKey}`, 1, 'glow', { key: null, draw: (ctx) => compositeGlows(ctx, [...limbEntries(), ...worldEntries()]) });
        worldDone = true;
      } else {
        add('glow', 'limbGlow', limbKey, 1, 'glow', {
          key: null,
          draw: (ctx) => {
            if (!isIdentity(T)) (ctx as StackTarget).transform(T[0], T[1], T[2], T[3], T[4], T[5]);
            compositeGlows(ctx, limbEntries());
          },
        });
      }
    }
    if (!worldDone) add('glow', 'worldGlow', worldKey, 1, 'glow', { key: null, draw: (ctx) => compositeGlows(ctx, worldEntries()) });

    let camera: Affine | null = null;
    let grade: Grade | null = null;
    if (ictx && j !== null) {
      const cam = cameraAt(j, ictx);
      camera = { a: cam.a, b: cam.b, c: cam.c, d: cam.d, e: cam.e, f: cam.f };
      grade = gradeAt(j, ictx, gentle);
      if (degrade.calm && j >= -8 && j <= -1) grade = { ...grade, lift: 1 };
    }
    if (now) times.layers = now() - t0;
    return {
      o,
      clip: c,
      j,
      poster: null,
      slots,
      faceCut: ictx && j !== null && j >= 9 ? faceCut(rig, c) : null,
      phase: ictx && j !== null ? phaseAt(j, ictx.jEnd) : null,
      camera,
      grade,
      limbs: view,
      posterSpec: null,
      parts,
      gains,
    };
  };

  const impact = (o: number): ImpactFrame | null => {
    if (!ictx && rig.limbs.size === 0) return null;
    const layers = frameLayers(o);
    return { layers, camera: layers.camera, grade: layers.grade };
  };

  // render() lays the camera on once, over the finished frame: through the
  // stack it would resample every full-frame layer (the plate, the person,
  // the floods, the glow), about half the frame's time in Node.
  let flatten = false;
  const composeScene: Scene = {
    strokes: (o) => (rig.opts.strokes?.(clipOf(o)) ?? []).filter((st) => !rig.own.has(st.id)),
    personMask: (o) => clip.personMask(Math.min(clip.frames - 1, Math.max(0, clipOf(o)))),
    impact: (o) => {
      const frame = impact(o);
      return frame && flatten ? { ...frame, camera: null } : frame;
    },
  };
  const drawStroke = rig.opts.drawStroke ?? (() => {});
  let flat: { canvas: unknown; ctx: BrushTarget } | null = null;

  // ---- Jobs ----

  const jobsAt = (f: number): DrawingJob[] => {
    const out: DrawingJob[] = [];
    const spec = posterOn(f);
    if (spec) {
      const key = posterKey(spec, figClipOf(spec));
      if (!rig.store.has(key)) out.push({ key: `poster:${rig.sceneId}:${key.slice('poster:'.length)}`, kind: 'poster', due: f, estMs: JOB_MS.poster });
      return out;
    }
    const c = clipOf(f);
    const view = limbView(c);
    if (view && view.kind !== 'silhouette' && !limbKeys(view.t).every((key) => rig.store.has(key))) {
      out.push({ key: `limb:${rig.sceneId}:${view.t}`, kind: 'limb', due: f, estMs: JOB_MS.limb });
    }
    // One job a mass part, so each stays within its line.
    for (const sp of massSpecs(c)) {
      if (sp.alpha > 0 && !rig.store.has(sp.key)) out.push({ key: `mass:${rig.sceneId}:${degrade.step}:${c}:${sp.name}`, kind: 'mass', due: f, estMs: JOB_MS.mass });
    }
    return out;
  };

  const scene: ImpactScene = {
    width: W,
    height: H,
    scale: s,
    context: ictx,
    degrade,
    cuts: rig.cuts,
    sceneId: rig.sceneId,
    turn: () => liftOf(rig).turn,
    bodies: () => liftOf(rig).bodies,
    frames3d: () => liftOf(rig).frames,
    tubesAt: (f) => tubesAt(rig, f),
    clipOf,
    frameLayers,
    impact,
    render(ctx, video, o) {
      const t0 = now?.() ?? 0;
      const image = typeof video === 'function' ? (video as (clip: number) => unknown)(clipOf(o)) : video;
      const j = I === null ? null : clipOf(o) - I;
      const cam = ictx && j !== null && !posterOn(o) ? cameraAt(j, ictx) : null;
      const into = cam && !(cam.a === 1 && cam.b === 0 && cam.c === 0 && cam.d === 1 && cam.e === 0 && cam.f === 0) ? (flat ??= make(W, H)) : null;
      flatten = into !== null;
      if (into) into.ctx.setTransform(1, 0, 0, 1, 0, 0);
      renderFrame((into?.ctx ?? ctx) as unknown as CanvasRenderingContext2D, image as CanvasImageSource, o, W, H, composeScene, { make, drawStroke });
      flatten = false;
      if (into && cam) {
        const t = ctx as StackTarget;
        t.save();
        t.globalAlpha = 1;
        t.globalCompositeOperation = 'source-over';
        t.transform(cam.a, cam.b, cam.c, cam.d, cam.e, cam.f);
        t.drawImage(into.canvas as never, 0, 0, W, H, 0, 0, W, H);
        t.restore();
      }
      if (now) times.total = now() - t0;
    },
    jobs(o) {
      const out = new Map<string, DrawingJob>();
      const visit = (f: number) => {
        if (f < 0 || f >= length) return;
        for (const job of jobsAt(f)) if (!out.has(job.key)) out.set(job.key, job);
      };
      for (let f = o + 1; f <= o + AHEAD; f++) visit(f);
      if (posterOn(o)) {
        let f = o + 1;
        while (posterOn(f)) f++;
        visit(f);
      }
      return [...out.values()];
    },
    runJob(job, mk = make) {
      const key = typeof job === 'string' ? job : job.key;
      const [kind, id, ...rest] = key.split(':');
      if (id !== rig.sceneId) throw new Error(`runJob: ${key} is not this scene's (${rig.sceneId})`);
      if (kind === 'limb') {
        const parts = limbParts(Number(rest[0]), mk);
        if (parts) glowSet(rig, parts[1], mk); // blurred ahead too
        return { key, kind: 'limb', parts: parts ?? [] };
      }
      if (kind === 'mass') {
        const at = Number(rest[0]);
        if (at !== degrade.step) return sceneOf(rig, at).runJob(key, mk);
        const names = (rest[2] ?? '').split('+');
        return { key, kind: 'mass', parts: massSpecs(Number(rest[1])).filter((sp) => names.includes(sp.name)).map((sp) => ensure(sp, mk)) };
      }
      if (kind === 'poster') {
        const own = `poster:${rest.join(':')}`;
        const fig = Number(rest[rest.length - 1]);
        const spec = plan?.steps.find((st): st is PosterSpec => st !== null && posterKey(st, fig) === own);
        if (!spec) throw new Error(`runJob: no poster ${own} in this step's plan`);
        return { key, kind: 'poster', parts: [posterPart(spec, fig, mk)] };
      }
      throw new Error(`runJob: no job kind '${kind}' (${key})`);
    },
    put(layer) {
      for (const part of layer.parts) keep(rig, part);
    },
    outputLength: () => length,
    timings() {
      const out: Record<string, number> = { ...times, physics: liftOf(rig).ms };
      if (out.total !== undefined) {
        let mine = out.layers ?? 0;
        for (const line of ['stamp', 'energy', 'composite', 'glow']) mine += out[line] ?? 0;
        out.other = Math.max(0, out.total - mine); // the plate, the grade, the cutout, the face cut and the stack itself
      }
      return out;
    },
    degraded: (st) => sceneOf(rig, st),
  };
  rig.scenes.set(step, scene);
  return scene;
}

// The flood's wash at level 1: the composite gives it its level, so a ramp
// re-uses one blur.
function floodCalls(fd: FloodDrawing): GlowCall[] {
  const rec = recordingSink();
  emitFlood(rec, { ...fd, level: 1 });
  return rec.calls;
}
