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
//     on first use, and is kept by exactly its inputs (physicsKeyOf), so a
//     scene built again for anything else (Reduce flashing, the aftermath,
//     the colours) takes it as it is. The app works it out in a worker
//     (lift/sim-worker.ts) and hands it in (SceneOptions.physics); until it
//     comes, the scene shows the limbs as drawn, riding him (drawnPhysics).
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
//   - The masses (the burst, then the cluster, with the dust over its base)
//     stand in front of him, uncut, in both flash modes (judge round 2: the
//     face cut left holes in the smoke). Their decay is the cluster's own
//     erosion (aftermath/), so they aren't faded again here, but for its
//     last frames (fire.ts FADE_FRAMES).
//   - Finishing: the camera (WP7), the grade (the strike calm keeps its lift
//     at 1), the glow, and from j 9 the face cut on the thin front FX: his
//     face mask dilated 0.03 S, hard-edged; nothing is cut on a frame with no
//     face mask.
//   - The glow (decision 8's look) lights only what can be seen: a limb's
//     arcs, pulses and pops behind him glow off his mask only, as the limb
//     itself does (render/limb.ts), and while the burst shows (A0–2) nothing
//     of the limbs glows within 0.6 U of P. Over j 9–31 the limbs' arcs glow
//     at most half as bright as the lightning's ribbons. The masses keep their
//     own colours: each flood's wash glows right over the flood, under him,
//     and from j 9 the limbs' glow goes on under the masses; only the
//     lightning's glow lies over them, as its ribbons do.
//   - The flash ladder (ladder.ts) only runs under Reduce flashing (decision
//     5): opts.degrade picks the step, and degraded(step) is the same scene at
//     another step, sharing the physics and the drawn parts. Reduce flashing
//     lays the burst, the cluster and the dust opaque, at the luminance of
//     what's under them averaged over 0.03 S cells (lumaPart, lumaBlit):
//     their hue over it with the 'color' blend, their ink and shadows as a
//     slight 'soft-light', at the ladder's mass opacity.
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
import { inFront, liftBodies, project, toCamera, type Body3D } from '../lift/body.ts';
import { dummyBodies, type Dummy } from '../lift/collide.ts';
import { animate3d, liftStroke, type Frame3D, type Lifted } from '../lift/lift.ts';
import { bulgeSide, limbsFirst, strikeController } from '../lift/strike.ts';
import { buildTube, onMask, silhouette } from '../lift/tube.ts';
import { checkedTurn, turnKeys, type TurnSource } from '../lift/turn.ts';
import type { BoilParams } from '../motion/boil.ts';
import { drawingIndex, EXAMPLE_TIMING, frameAt } from '../motion/timing.ts';
import { arcFlicker, arcPhase, arcTones, drawArcs, emitArcs, nativePath, sectionAt, sheathArcs, type ArcRun, type ArcTarget, type LinePath } from '../render/arcs3d.ts';
import { brushSettings, LIMB } from '../render/brushes.ts';
import { renderFrame, type ComposeDeps, type ImpactFrame, type Scene } from '../render/compose.ts';
import { scratch, type BrushTarget, type MakeScratch, type Pixels, type Scratch } from '../render/glow.ts';
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
const CUT = { reach: 0.03, quarter: 4 } as const; // × S; buffer px per frame px
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
// ... and the burst, the cluster and the dust stand opaque at the plate's
// luminance (judge round 2: faded to 0.3 and 0.6 they hid the destruction).
// Each covers what's under it with that averaged over LUMA_CELL cells, so no
// detail of the plate shows through, and shows its hue and chroma there by
// the 'color' blend, which keeps the luma (W3C compositing's SetLum), and its
// ink and shadows as a 'soft-light' shade under that, darkest on its ink. On
// a flat plate of any grey, L then moves by under 0.1 (lumaBlit): a soft
// light darkens the midtones most and black and white not at all, where a
// multiply darkened a light plate by as much as 0.2; and a saturated yellow,
// which the 'color' blend lifts by up to 0.15 at a light plate's luma (SetLum
// keeps the luma in gamma, where L is linear), is shaded down by that lift
// beforehand (lumaPart's pull). Their reds are raised first so the blend's
// result keeps G ≥ 0.55·R on 8 bits (G4, see lumaPart), so no red field
// turns. The grade holds still from the return (grade.ts, still) and the
// floods have no dark edge (washes.ts), so neither tips a field late. The
// ladder's mass opacity (Degrade.masses) fades them only at its last two
// steps. The debris and the sparks, thin and moving every frame, stay at
// GENTLE_FX, and at STILL_FX on the ladder's last step.
const LUMA_SHADE = 0.1; // the shade's grey on the darkest ink: 0.5 − this (0.5 leaves the plate as it is)
const LUMA_LIFT = 0.06; // the 'color' blend's lift of L a tint keeps unshaded (see liftPull)
const LUMA_CELL = 0.03; // × S: the plate under a mass is averaged over cells this wide (his shirt's print is gone at that)
const GENTLE_FX = 0.3;
const STILL_FX = 0.25;
const LUMA_RED = 0.55; // G4: G at least this × R
const QUIET: Pulses = { spans: [], pops: [] };
const FIRE_CLEAR = 0.6; // U round P: none of the limbs glows there while the burst shows
const ARC_AFTER = 0.5; // over j 9–31 the limbs' arcs glow at most this × the ribbons (judge round 2)

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
  skeleton?: readonly (PointSet | null)[] | null; // the stand-in's 33 landmarks, for the limbs' crash-test dummy (lift/collide.ts); missing = bodies' (head and neck alone)
  units?: readonly (number | null)[] | null; // his torso height per frame, clip px (torsoHeights); missing = 0.25 × the clip's height
  source?: string | object; // what its masks, landmarks and torso heights come from, for the physics' key: clips with the same source read the same (a string names it on every thread); missing = the clip itself
  luma?(f: number): PlateLuma | null; // the plate's luma on frame f, clip px, for the limbs' outline classes; missing = the line tone all along
  audio?: unknown; // carried for the export: the freeze adds 26 frames of silence after I + 9 (WP13)
}

export interface SceneOptions {
  tier: Tier;
  make: MakeScratch;
  degrade?: number; // 0..7: the flash ladder's step; it only applies under Reduce flashing
  cuts?: number; // 0..6: the cut order's steps taken (tiers.ts); missing = tierCuts(tier)
  size?: number; // the internal frame's long side before the resolution cut; missing = 1080
  newPath?: (() => LinePath) | null; // drawArcs' path maker; missing = Path2D where there is one
  boil?: BoilParams; // missing = EXAMPLE_TIMING.boil
  turn?: { known: readonly Vec2[]; from: number; to: number; maxDeg?: number }; // checkedTurn on a turn read from the pose
  clock?: () => number; // ms; only timings() reads it
  strokes?: (clip: number) => DrawnStroke[]; // the effect's other strokes on a clip frame, on the internal frame (the limbs and cracks are dropped)
  drawStroke?: ComposeDeps['drawStroke'];
  // The physics worked out elsewhere (another scene's physics(), packed or
  // not), or 'wait' while it is: the result kept for these inputs if there
  // is one (keepPhysics), else the limbs as drawn (drawnPhysics). Missing =
  // worked out here on first use, or taken from what's kept.
  physics?: ScenePhysics | PackedPhysics | 'wait';
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
  gains: Record<string, number>; // the glows' gains: 'arc:<id>', 'flood', 'lightning', 'ribbons' (the ribbons' glow, boost and all), 'charge'
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
  readonly physicsKey: string; // exactly the physics' inputs (physicsKeyOf)
  readonly waiting: boolean; // the limbs show as drawn until the physics comes (SceneOptions.physics 'wait')
  physics(): ScenePhysics;
  turn(): TurnRead;
  bodies(): readonly Body3D[];
  frames3d(): readonly Frame3D[];
  tubesAt(clip: number): readonly Tube[]; // internal px, far first
  clipOf(o: number): number;
  frameLayers(o: number): SceneLayers;
  impact(o: number): ImpactFrame | null;
  render(ctx: BrushTarget, video: unknown, o: number): void; // video: the clip frame's image, or (clip) => it
  jobs(o: number): DrawingJob[];
  missing(o: number): DrawingJob[]; // the drawings frame o itself still lacks (jobs(o) lists the frames after it); none = render(o) draws nothing on the page but the frame's own glows and cutout
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

// A scene's physics: the turn, the bodies and the limbs on every frame, as
// plain data, so another thread can work it out and post it back.
export interface ScenePhysics {
  key: string; // its inputs (physicsKeyOf)
  bodies: Body3D[];
  frames: Frame3D[];
  start: number[]; // the first frame of the capture placed on each frame
  turn: TurnRead;
  ms: number; // the physics per frame, ms (with opts.clock)
  drawn?: boolean; // the limbs as drawn, un-simulated (drawnPhysics): never kept
}
type Lift = ScenePhysics;

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
  physicsKey: string;
  waiting: boolean; // the physics is worked out elsewhere and isn't here: the limbs as drawn
  store: Map<string, DrawnPart>;
  glowSets: Map<string, Glow[]>;
  spare: Glow[];
  world: Map<string, { glow: Glow; content: string }>;
  posterGlows: Map<string, Glow>;
  tubes: Map<number, Tube[]>;
  edges: WeakMap<Mask, Vec2[][]>;
  faces: WeakMap<Mask, Mask>;
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
    physicsKey: '',
    waiting: false,
    store: new Map(),
    glowSets: new Map(),
    spare: [],
    world: new Map(),
    posterGlows: new Map(),
    tubes: new Map(),
    edges: new WeakMap(),
    faces: new WeakMap(),
    scenes: new Map(),
  };
  rig.base = slam && I !== null ? slamContext(rig, slam, I, crackIds) : null;
  rig.physicsKey = physicsKeyOf(rig);
  // The physics is settled here, so what a scene shows (and its id says)
  // doesn't change with what's kept after it's made.
  const given = opts.physics;
  if (given === 'wait') {
    rig.lift = keptPhysics(rig.physicsKey);
    rig.waiting = rig.lift === null;
  } else if (given) {
    rig.lift = 'pts' in given ? unpackPhysics(given) : given;
    if (rig.lift.key !== rig.physicsKey) throw new Error('createImpactScene: the physics handed in was worked out for other inputs');
  }
  const poseDigest = clip.poses.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.angle.toFixed(4)},${p.scale.toFixed(4)}`).join(';');
  rig.sceneId = fnv1a32(JSON.stringify(effect), clip.width, clip.height, clip.frames, poseDigest, W, H, cuts.n, ...(rig.waiting ? ['drawn'] : [])).toString(16);
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

// The physics, once: the turn, the bodies, and the limbs on every frame;
// what's kept for its inputs, or worked out here and kept.
function liftOf(rig: Rig): Lift {
  if (rig.lift) return rig.lift;
  if (rig.waiting) return (rig.lift = drawnPhysics(rig));
  const kept = keptPhysics(rig.physicsKey);
  if (kept) return (rig.lift = kept);
  rig.lift = simulate(rig);
  keepPhysics(rig.lift);
  return rig.lift;
}

// His crash-test dummy on every frame (lift/collide.ts): the egg, and
// capsules from the stand-in's landmarks: all 33 where the clip has them
// (its skeleton: head, neck, arms and legs), else the 15 that move with the
// body (head and neck alone); the egg alone without a pose.
export function dummyOf(clip: ImpactClip, bodies: readonly Body3D[]): Dummy[] {
  return dummyBodies({ bodies, joints: clip.skeleton ?? clip.bodies ?? null, mask: (f) => clip.personMask(f), width: clip.width, height: clip.height });
}

// The turn and the bodies on every frame: the physics' first part, quick,
// which the limbs as drawn ride too.
function bodiesOf(rig: Rig): { bodies: Body3D[]; turn: TurnRead; limbStrokes: Stroke[] } {
  const { clip, effect } = rig;
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
  return { bodies, turn: { keys, from: read.from, checked }, limbStrokes };
}

// The physics itself: each limb lifted on the frame it was drawn on and run
// through animate3d, the strike controller taking it round his body.
function simulate(rig: Rig): Lift {
  const { clip } = rig;
  const t0 = rig.now?.() ?? 0;
  const n = clip.frames;
  const { bodies, turn, limbStrokes } = bodiesOf(rig);
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
    // His body, for the limbs to collide with and go round (decision 17), and their root radius in clip px.
    const dummies = dummyOf(clip, bodies);
    const radius = rig.R0 / rig.s;
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
            dummies,
            radius,
          })
        : undefined;
    frames = animate3d({
      strokes: lifted,
      bodies,
      frames: n,
      dps: rig.dps,
      boil: rig.opts.boil ?? EXAMPLE_TIMING.boil,
      width: clip.width,
      height: clip.height, // the floor's bottom edge after the release (missing, a 16:9 clip's: a portrait clip's limbs went flat 2/3 of the way up)
      emerge: new Map(limbStrokes.flatMap((st) => (rig.emerge.has(st.id) ? [[st.id, rig.emerge.get(st.id) as number] as const] : []))),
      control,
      slam: I !== null && rig.base ? { I, posters: rig.base.posters } : undefined,
      dummies,
      radius,
    });
  }
  const ms = rig.now && n > 0 ? (rig.now() - t0) / n : 0;
  return { key: rig.physicsKey, bodies, frames, start: startsOf(frames), turn, ms };
}

// The first frame of the capture placed on each frame.
function startsOf(frames: readonly Frame3D[]): number[] {
  const start: number[] = [];
  frames.forEach((fr, f) => start.push(f > 0 && frames[f - 1].capture === fr.capture ? start[f - 1] : f));
  return start;
}

// While the physics is worked out elsewhere: each limb lifted on the frame
// it was drawn on and carried by his body as it was drawn, un-simulated,
// from the first frame of its emergence drawing, drawn anew on 2s, each
// frame marked as the physics marks it.
function drawnPhysics(rig: Rig): Lift {
  const { clip, I, base } = rig;
  const n = clip.frames;
  const { bodies, turn, limbStrokes } = bodiesOf(rig);
  const frames: Frame3D[] = [];
  if (limbStrokes.length > 0 && bodies.length === n && n > 0) {
    const lifted = limbStrokes.map((st) => {
      const f = drawnFrame(rig, st);
      return liftStroke(st.id, strokePx(rig, st, f), [...st.views.front.pressure], bodies[f], st.kind, st.stiffness, st.wobble);
    });
    const born = limbStrokes.map((st) => {
      const at = rig.emerge.get(st.id);
      if (at === undefined) return 0;
      let f = Math.max(0, at);
      const k = drawingIndex(f, rig.dps);
      while (f > 0 && drawingIndex(f - 1, rig.dps) === k) f--;
      return f;
    });
    const slams = limbStrokes.some((st) => rig.limbs.get(st.id)?.slam);
    const strike = I !== null && rig.slam && base && slams && I >= 0 && I < n ? limbsFirst(I) : undefined;
    // A frame's limbs are placed when they're first read: the page shows a
    // frame or two of them before the physics comes (decision 20).
    const placedOn: Frame3D['placed'][] = [];
    const place = (f: number): Frame3D['placed'] => {
      const b = bodies[f];
      return lifted.flatMap((l, j) => {
        if (born[j] > f) return [];
        const pts = l.points.map((q) => toCamera(b, q));
        const seen = pts.map((p) => project(b, p));
        return [
          {
            id: l.id,
            points: seen.map(({ xy }) => xy),
            z: pts.map((p) => p[2]),
            pressure: l.pressure.map((p, i) => Math.min(1, p * seen[i].near)),
            front: pts.map((p) => inFront(b, p)),
            length: l.length,
            depth: pts.reduce((sum, p) => sum + p[2], 0) / pts.length,
          },
        ];
      });
    };
    let capture = -1;
    let lastK = -1;
    for (let f = 0; f < n; f++) {
      const k = drawingIndex(f, rig.dps);
      if (k !== lastK) [lastK, capture] = [k, capture + 1];
      const drawing: LimbDrawing = I !== null && base ? limbDrawingAt(f, I, strike, base.posters) : 'grid';
      frames.push({
        f,
        k,
        capture,
        drawing,
        get placed() {
          return (placedOn[f] ??= place(f));
        },
        sim: [],
      });
    }
  }
  return { key: rig.physicsKey, bodies, frames, start: startsOf(frames), turn, ms: 0, drawn: true };
}

// The physics' inputs, as one string: what it reads of the effect (the
// limbs as drawn, when they emerge and which of them slam; the slam's I, P,
// d, seed and posters; the turn, and its check; the drawings a second, the
// boil and the limbs' root radius) and of the clip (its size, the anchor
// track, and its source: the masks, the stand-in's landmarks and the torso
// heights). Nothing else changes it: not the flash, the aftermath, the
// colours or the tier's cuts but the resolution.
function physicsKeyOf(rig: Rig): string {
  const { clip, effect } = rig;
  const limbs = effect.strokes
    .filter((st) => rig.limbs.has(st.id))
    .map((st) => ({
      id: st.id,
      anchor: st.anchor,
      kind: st.kind,
      stiffness: st.stiffness,
      wobble: st.wobble,
      points: st.views.front.points,
      pressure: st.views.front.pressure,
      emerge: rig.emerge.get(st.id) ?? null,
      slam: rig.limbs.get(st.id)?.slam ?? false,
    }));
  const slam = rig.I !== null && rig.slam && rig.base ? { I: rig.I, xy: rig.slam.xy, dir: rig.slam.dir ?? null, seed: rig.base.seed, posters: rig.base.posters } : null;
  const source = clip.source ?? clip;
  return JSON.stringify({
    source: typeof source === 'string' ? source : sourceId(source),
    clip: [clip.width, clip.height, clip.frames],
    poses: clip.poses.map((p) => [p.x, p.y, p.angle, p.scale]),
    turn: effect.turn ?? null,
    check: rig.opts.turn ?? null,
    limbs,
    slam,
    dps: rig.dps,
    boil: rig.opts.boil ?? EXAMPLE_TIMING.boil,
    radius: rig.R0 / rig.s,
  });
}

// A number for an object that names a clip's source on this thread.
const sources = new WeakMap<object, number>();
let nextSource = 1;
function sourceId(o: object): number {
  let id = sources.get(o);
  if (id === undefined) sources.set(o, (id = nextSource++));
  return id;
}

// The physics worked out, by key, the least recently used dropped past
// PHYSICS_KEPT (each is a few MB). The limbs as drawn are never kept.
const PHYSICS_KEPT = 3;
const physicsKept = new Map<string, ScenePhysics>();
export function keepPhysics(p: ScenePhysics): void {
  if (p.drawn) return;
  physicsKept.delete(p.key);
  physicsKept.set(p.key, p);
  while (physicsKept.size > PHYSICS_KEPT) physicsKept.delete(physicsKept.keys().next().value as string);
}
export function keptPhysics(key: string): ScenePhysics | null {
  const hit = physicsKept.get(key);
  if (!hit) return null;
  physicsKept.delete(key);
  physicsKept.set(key, hit);
  return hit;
}
// Everything kept goes (a new clip, say).
export function forgetPhysics(): void {
  physicsKept.clear();
}

// The physics as a few flat arrays, to post between threads: a structured
// clone copies them whole, where tens of thousands of small arrays take a
// phone's main thread longer than a frame to clone. unpackPhysics gives the
// same numbers back exactly.
export interface PackedPhysics {
  key: string;
  turn: TurnRead;
  ms: number;
  start: Int32Array;
  bodies: Float64Array; // x, y, unit, yaw, pitch, roll a frame
  frames: Int32Array; // f, k, capture, drawing (its place in `drawings`), and how many placed and sim a frame
  drawings: LimbDrawing[];
  limbs: Float64Array; // id, points, length, depth a placed limb, then id, points a chain
  pts: Float64Array; // x, y, z, pressure a placed point, then x, y, z a chain's
  front: Uint8Array; // a placed point's
}

export function packPhysics(p: ScenePhysics): PackedPhysics {
  const drawings: LimbDrawing[] = [];
  const frames = new Int32Array(6 * p.frames.length);
  const limbs: number[] = [];
  const pts: number[] = [];
  const front: number[] = [];
  p.frames.forEach((fr, f) => {
    let d = drawings.indexOf(fr.drawing);
    if (d < 0) d = drawings.push(fr.drawing) - 1;
    frames.set([fr.f, fr.k, fr.capture, d, fr.placed.length, fr.sim.length], 6 * f);
    for (const pl of fr.placed) {
      limbs.push(pl.id, pl.points.length, pl.length, pl.depth);
      pl.points.forEach((xy, i) => {
        pts.push(xy[0], xy[1], pl.z[i], pl.pressure[i]);
        front.push(pl.front[i] ? 1 : 0);
      });
    }
    for (const c of fr.sim) {
      limbs.push(c.id, c.points.length);
      for (const q of c.points) pts.push(q[0], q[1], q[2]);
    }
  });
  const bodies = new Float64Array(6 * p.bodies.length);
  p.bodies.forEach((b, f) => bodies.set([b.x, b.y, b.unit, b.yaw, b.pitch, b.roll], 6 * f));
  return { key: p.key, turn: p.turn, ms: p.ms, start: Int32Array.from(p.start), bodies, frames, drawings, limbs: Float64Array.from(limbs), pts: Float64Array.from(pts), front: Uint8Array.from(front) };
}

export function unpackPhysics(q: PackedPhysics): ScenePhysics {
  const bodies: Body3D[] = [];
  for (let i = 0; i < q.bodies.length; i += 6) bodies.push({ x: q.bodies[i], y: q.bodies[i + 1], unit: q.bodies[i + 2], yaw: q.bodies[i + 3], pitch: q.bodies[i + 4], roll: q.bodies[i + 5] });
  const frames: Frame3D[] = [];
  let [l, p, b] = [0, 0, 0];
  for (let i = 0; i < q.frames.length; i += 6) {
    const placed: Frame3D['placed'] = [];
    for (let k = 0; k < q.frames[i + 4]; k++, l += 4) {
      const pl = { id: q.limbs[l], points: [] as Vec2[], z: [] as number[], pressure: [] as number[], front: [] as boolean[], length: q.limbs[l + 2], depth: q.limbs[l + 3] };
      for (let j = 0; j < q.limbs[l + 1]; j++, p += 4, b++) {
        pl.points.push([q.pts[p], q.pts[p + 1]]);
        pl.z.push(q.pts[p + 2]);
        pl.pressure.push(q.pts[p + 3]);
        pl.front.push(q.front[b] === 1);
      }
      placed.push(pl);
    }
    const sim: Frame3D['sim'] = [];
    for (let k = 0; k < q.frames[i + 5]; k++, l += 2) {
      const chain: Frame3D['sim'][number] = { id: q.limbs[l], points: [] };
      for (let j = 0; j < q.limbs[l + 1]; j++, p += 3) chain.points.push([q.pts[p], q.pts[p + 1], q.pts[p + 2]]);
      sim.push(chain);
    }
    frames.push({ f: q.frames[i], k: q.frames[i + 1], capture: q.frames[i + 2], drawing: q.drawings[q.frames[i + 3]], placed, sim });
  }
  return { key: q.key, bodies, frames, start: Array.from(q.start), turn: q.turn, ms: q.ms };
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

// Reduce flashing's mass part: the mass painted as usual into a canvas twice
// its box's height, then its tint on top and its shade under it. The tint is
// the mass with its reds raised so that G − B ≥ 0.55·(R − B) (G4): the
// 'color' blend shifts every channel alike and, where it clips, scales them
// about the luma alike, so that ratio survives it, and the result keeps
// G ≥ 0.55·R. The shade is a grey with the mass's alpha for a 'soft-light':
// 0.5 (no change) where the mass is light, 0.5 − LUMA_SHADE on its darkest
// ink, and darker by the tint's liftPull. (A 'screen' to lift the burst's
// body on a dark plate went over 0.1 L on a mid one.) Drawn once a drawing,
// so the per-pixel pass stays off the frame. Exported for the tests.
export function lumaPart(make: MakeScratch, key: string, slot: DrawnPart['slot'], name: string, box: Box | null, draw: (ctx: BrushTarget) => void): DrawnPart {
  if (!box) return partOf(key, slot, name, null, null);
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  const sc = make(w, 2 * h);
  const ctx = sc.ctx as BrushTarget & { createImageData(w: number, h: number): Pixels };
  ctx.setTransform(1, 0, 0, 1, -box.x0, -box.y0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  draw(ctx);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const tint = ctx.getImageData(0, 0, w, h);
  const shade = ctx.createImageData(w, h);
  const t = tint.data;
  const g = shade.data;
  const pulls = new Map<number, number>(); // by the raised tint's rgb: a mass has few colours
  for (let i = 0; i < t.length; i += 4) {
    if (t[i + 3] === 0) continue;
    const y = (0.2126 * t[i] + 0.7152 * t[i + 1] + 0.0722 * t[i + 2]) / 255;
    const lift = t[i + 2] + LUMA_RED * (t[i] - t[i + 2]); // only a red over its blue can turn a red field
    if (t[i] > t[i + 2] && t[i + 1] < lift) t[i + 1] = Math.min(255, Math.ceil(lift));
    const rgb = (t[i] << 16) | (t[i + 1] << 8) | t[i + 2];
    let pull = pulls.get(rgb);
    if (pull === undefined) pulls.set(rgb, (pull = liftPull(t[i] / 255, t[i + 1] / 255, t[i + 2] / 255)));
    g[i] = g[i + 1] = g[i + 2] = Math.round(255 * Math.max(0, 0.5 - LUMA_SHADE * (1 - y) ** 2 - pull));
    g[i + 3] = t[i + 3];
  }
  ctx.putImageData(tint, 0, 0);
  ctx.putImageData(shade, 0, h);
  return partOf(key, slot, name, box, sc.canvas);
}

// The 'color' blend keeps the plate's luma in gamma (SetLum: 0.3 R + 0.59 G +
// 0.11 B), so a saturated tint lands brighter in linear L than the grey it
// replaces: a burst yellow by 0.04 on a mid plate and by 0.15 on one at
// L 0.7. That lift past LUMA_LIFT, at the light lumas where it peaks, over
// how much a soft-light grey of 0.5 − 1 darkens a plate there, is how much
// darker the tint's shade goes. Inks, browns, reds and the dust need none.
const PULL_AT = [0.6, 0.7, 0.78, 0.84, 0.9, 0.95]; // plate lumas, gamma
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function liftPull(r: number, g: number, b: number): number {
  let pull = 0;
  for (const l of PULL_AT) {
    const d = l - (0.3 * r + 0.59 * g + 0.11 * b);
    let c0 = r + d;
    let c1 = g + d;
    let c2 = b + d;
    // W3C ClipColor: scaled about the luma back into 0..1.
    const n = Math.min(c0, c1, c2);
    const x = Math.max(c0, c1, c2);
    const k = n < 0 ? l / (l - n) : x > 1 ? (1 - l) / (x - l) : 1;
    c0 = l + (c0 - l) * k;
    c1 = l + (c1 - l) * k;
    c2 = l + (c2 - l) * k;
    const up = 0.2126 * linear(c0) + 0.7152 * linear(c1) + 0.0722 * linear(c2) - linear(l);
    // A soft light of 0.5 − s takes 2·s·l·(1 − l) off the luma, so s·that·dL/dl off L.
    const per = 2 * l * (1 - l) * (2.4 / 1.055) * ((l + 0.055) / 1.055) ** 1.4;
    pull = Math.max(pull, (up - LUMA_LIFT) / per);
  }
  return pull;
}

// A lumaPart laid on the frame at `alpha`, opaque (judge round 2: laid
// straight on, by the blends alone, the plate's every detail showed through
// the smoke, his shirt's print and all): what's on the frame under its box,
// averaged over cells `cell` frame px wide (averaged), its shade by
// 'soft-light' and its tint by 'color' over that, which keeps the shaded
// luma, cut to the mass's own coverage and laid on. So the mass hides the
// plate and still sits at its luminance, within a cell. With no `make`, or a
// frame that can't be read back, the shade and the tint go straight onto
// the frame, at the plate's luma pixel by pixel. Exported for the tests.
export function lumaBlit(part: DrawnPart, alpha: number, make?: MakeScratch, cell = 0): LayerDraw {
  return {
    key: null,
    draw: (ctx) => {
      if (!part.image || !(alpha > 0)) return;
      const { x0, y0, width: w, height: h } = part;
      const image = part.image as never;
      const under = make && cell > 0 ? averaged(ctx, make, part, cell) : null;
      if (alpha < 1) ctx.globalAlpha *= alpha;
      const u = under ? under.ctx : ctx;
      const [dx, dy] = under ? [0, 0] : [x0, y0];
      u.globalCompositeOperation = 'soft-light';
      u.drawImage(image, 0, h, w, h, dx, dy, w, h);
      u.globalCompositeOperation = 'color';
      u.drawImage(image, 0, 0, w, h, dx, dy, w, h);
      if (!under) return;
      u.globalCompositeOperation = 'destination-in';
      u.drawImage(image, 0, 0, w, h, 0, 0, w, h);
      u.globalCompositeOperation = 'source-over';
      ctx.drawImage(under.canvas as never, 0, 0, w, h, x0, y0, w, h);
    },
  };
}

// What's on the frame under a part's box, averaged over cells `cell` frame px
// wide: shrunk to a pixel a cell (scratch slot 3) and stretched back,
// smoothed, into a canvas at the box (slot 4), opaque wherever the box is on
// the frame. Null when the frame can't be read back: a context without its
// canvas or getTransform, a turned transform, or a box off the frame.
function averaged(ctx: BrushTarget, make: MakeScratch, part: DrawnPart, cell: number): Scratch | null {
  const t = ctx as BrushTarget & { canvas?: { width: number; height: number }; getTransform?(): { a: number; b: number; c: number; d: number; e: number; f: number } };
  const m = t.getTransform?.();
  const frame = t.canvas;
  if (!m || !frame || m.b !== 0 || m.c !== 0 || !(m.a > 0) || !(m.d > 0)) return null;
  const { x0, y0, width: w, height: h } = part;
  // The box on the frame's canvas, as far as it's on it ...
  const cx0 = Math.max(0, m.a * x0 + m.e);
  const cy0 = Math.max(0, m.d * y0 + m.f);
  const cx1 = Math.min(frame.width, m.a * (x0 + w) + m.e);
  const cy1 = Math.min(frame.height, m.d * (y0 + h) + m.f);
  if (!(cx1 > cx0 && cy1 > cy0)) return null;
  // ... and that, in the box's own px.
  const bw = (cx1 - cx0) / m.a;
  const bh = (cy1 - cy0) / m.d;
  const sw = Math.max(1, Math.round(bw / cell));
  const sh = Math.max(1, Math.round(bh / cell));
  const small = scratch(make, 3, sw, sh);
  const sc = small.ctx as BrushTarget & { imageSmoothingQuality?: string };
  sc.imageSmoothingEnabled = true;
  sc.imageSmoothingQuality = 'high';
  sc.drawImage(frame as never, cx0, cy0, cx1 - cx0, cy1 - cy0, 0, 0, sw, sh);
  const box = scratch(make, 4, w, h);
  const bc = box.ctx as BrushTarget & { imageSmoothingQuality?: string };
  bc.imageSmoothingEnabled = true;
  bc.imageSmoothingQuality = 'high'; // bicubic: no cell's corners show
  bc.drawImage(small.canvas as never, 0, 0, sw, sh, (cx0 - m.e) / m.a - x0, (cy0 - m.f) / m.d - y0, bw, bh);
  return box;
}

// What a mass part needs: its content key, its alpha on the frame, and how to draw it.
interface PartSpec {
  name: string;
  slot: StackSlot;
  key: string;
  alpha: number;
  luma?: boolean; // drawn by lumaPart and laid by lumaBlit (Reduce flashing's burst, cluster and dust)
  box(): Box | null;
  paint(ctx: BrushTarget, make: MakeScratch): void;
}

// A mass drawing (fire.ts's MassDrawing) as a part: painted opaque, faded by the blit.
function massSpec(name: string, slot: StackSlot, key: string, alpha: number, drawing: () => MassDrawing | null, W: number, H: number, luma = false): PartSpec {
  let d: MassDrawing | null | undefined;
  const get = () => (d === undefined ? (d = drawing()) : d);
  return {
    name,
    slot,
    key: luma ? `${key}:luma` : key,
    alpha,
    luma,
    box: () => {
      const m = get();
      return m ? boxOf(m.shapes.map((sh) => sh.points), PART_PAD, W, H) : null;
    },
    paint: (ctx) => paint(ctx, get(), true),
  };
}

// The stretches of these arc runs that can be seen to glow (render/limb.ts's
// rule for the limb's own glow): a run in front of him whole, a run behind
// him where it's off his mask.
function seenRuns(runs: readonly ArcRun[], mask: Mask | null, scale: number): ArcRun[] {
  if (!mask) return [...runs];
  const out: ArcRun[] = [];
  for (const run of runs) {
    if (run.front) {
      out.push(run);
      continue;
    }
    let from = -1;
    const flush = (to: number) => {
      if (from >= 0 && to - from >= 2) out.push({ ...run, points: run.points.slice(from, to), width: run.width.slice(from, to), nz: run.nz.slice(from, to) });
      from = -1;
    };
    run.points.forEach((q, i) => {
      if (onMask(mask, scale, q[0], q[1])) flush(i);
      else if (from < 0) from = i;
    });
    flush(run.points.length);
  }
  return out;
}

// Recorded glow with nothing within r of P: strokes cut where they come
// closer, discs, fills and washes dropped when they do.
function clearOf(calls: readonly GlowCall[], P: Vec2, r: number): GlowCall[] {
  const far = (q: readonly number[]) => Math.hypot(q[0] - P[0], q[1] - P[1]) > r;
  const out: GlowCall[] = [];
  for (const c of calls) {
    if (c.op === 'disc') {
      if (far(c.c)) out.push(c);
    } else if (c.op !== 'stroke') {
      if (c.outline.every(far)) out.push(c);
    } else if (c.points.length === 1) {
      if (far(c.points[0])) out.push(c);
    } else {
      let run: Vec2[] = [];
      for (const q of c.points) {
        if (far(q)) run.push(q);
        else {
          if (run.length >= 2) out.push({ ...c, points: run });
          run = [];
        }
      }
      if (run.length >= 2) out.push({ ...c, points: run });
    }
  }
  return out;
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

// The cut at quarter size: 255 within 0.03 S of the source and 0 beyond, with
// no feather (judge round 2: a soft hole read as a smudge in the smoke), from
// a two-pass chamfer distance (weights 3 and 4, within 6 % of the true
// distance). The stack's upscale smooths its edge over a quarter's pixel.
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
  const alpha = new Uint8ClampedArray(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = d[i] <= reach ? 255 : 0;
  return { width: w, height: h, alpha };
}

// The face cut on clip frame c, from his face mask; none on a frame without
// one (judge round 2: the old fallback, the top 20 % of his box, landed on his
// back and shirt while he crouched).
function faceCut(rig: Rig, c: number): Mask | null {
  const { W, H, S, clip } = rig;
  const f = Math.min(Math.max(0, clip.frames - 1), Math.max(0, c));
  const face = clip.faceMask(f);
  if (!face) return null;
  let cut = rig.faces.get(face);
  if (!cut) {
    const sx = face.width / W;
    const sy = face.height / H;
    cut = cutMask((x, y) => face.alpha[Math.min(face.height - 1, Math.floor(y * sy)) * face.width + Math.min(face.width - 1, Math.floor(x * sx))] >= 128, W, H, S);
    rig.faces.set(face, cut);
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
    const maskScale = mask ? mask.width / W : 1;
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
      // While the burst shows (A0–2) the tip arcs wait for A3, and nothing
      // glows within FIRE_CLEAR U of P, so the flame reads (judge round 1).
      const { far, near } = sheathArcs(tube, k, phase, tube.id, { S, P: P && !fireOn ? P : undefined, idle: rig.settings.arcs, lift: rig.settings.arcLift, fewer: rig.cuts.fewerArcs });
      const side = (runs: ArcRun[], inFront: boolean) => runs.filter((run) => run.front === inFront);
      if (b && f) {
        drawArcs(b, side(far, false), tones, newPath);
        drawArcs(f, side(far, true), tones, newPath);
        drawLimb(b, f, tube, { S, k, palette: rig.palette, settings: rig.settings, age, pulses: spans, swing, outline, mask, maskScale, glow: steady });
        drawArcs(b, side(near, false), tones, newPath);
        drawArcs(f, side(near, true), tones, newPath);
        for (const pop of pops) drawPops(sectionAt(tube, pop.s).front ? f : b, tube, [pop], tones);
      }
      // The glow lights only what can be seen, as the limb's own does: a
      // pulse, a pop or an arc behind him glows off his mask only (judge
      // round 2: arcs behind his head glowed over it, a cyan cap on f55–57).
      const seen = (s: number) => {
        const sec = sectionAt(tube, s);
        return sec.front || !mask || !onMask(mask, maskScale, sec.screen[0], sec.screen[1]);
      };
      emitPulses(steady, tube, spans.filter((sp) => seen(sp.s)), 1, pulseTones);
      emitPops(steady, tube, pops.filter((pop) => seen(pop.s)), 1, tones);
      const own = recordingSink();
      const lit = seenRuns([...far, ...near], mask, maskScale);
      emitArcs(own, fireOn && P ? lit.filter((run) => run.points.every((q) => Math.hypot(q[0] - P[0], q[1] - P[1]) > clear)) : lit, 1, tones);
      if (own.calls.length > 0) arcs.push({ id: tube.id, calls: own.calls });
    }
    back?.ctx.setTransform(1, 0, 0, 1, 0, 0);
    front?.ctx.setTransform(1, 0, 0, 1, 0, 0);
    // While the burst shows, none of the limbs glows within FIRE_CLEAR U of P:
    // the tips bundled there on the release lit a ball over the fire (judge
    // round 2, f93–94).
    const glow: DrawnGlow[] = [{ id: null, calls: fireOn && P ? clearOf(steady.calls, P, clear) : steady.calls }, ...arcs];
    return [keep(rig, partOf(kb, 'limbsBehind', 'limbsBehind', box, back?.canvas ?? null)), keep(rig, partOf(kf, 'limbsFront', 'limbsFront', box, front?.canvas ?? null, glow))];
  };

  // ---- Masses ----

  // The parts the masses draw on clip frame c, in stack order: the cracks,
  // the fire or the cluster, then the dust over its base, then the front FX's
  // wisps, debris, the A5–6 veil and the particles, then the A5–6 flash. The
  // keys are the clocks' (cheap): each says what the drawing shows, its fade
  // apart. The veil and the flash cut the person out of the frame's own mask,
  // so they are drawn per frame.
  const massSpecs = (c: number): PartSpec[] => {
    if (!ectx || I === null) return [];
    const out: PartSpec[] = [];
    const j = c - I;
    const cc = crackClock(ectx, c);
    if (cc) out.push(massSpec('cracks', 'cracks', `cracks:${cc.fraction.toFixed(4)}:${cc.cool.toFixed(5)}`, cc.alpha, () => crackShapes(ectx, c), W, H));
    const mc = massClock(ectx, c);
    if (!mc || !(mc.alpha > 0)) return out;
    // The burst, the cluster and the dust over its base stand in front of him
    // uncut, in both flash modes (judges: he crouches over P and hid them, and
    // a face cut left holes in the smoke). They decay by their own erosion
    // (fire.ts), not by a fade on top: mc.alpha is 1 until its last
    // FADE_FRAMES frames. Reduce flashing lays them at the plate's luma.
    const opacity = degrade.masses;
    const solid = opacity * mc.alpha;
    if (mc.g <= 1) out.push(massSpec('fire', 'masses', `fire:${mc.g}:${mc.start}`, solid, () => fireShapes(ectx, c), W, H, gentle));
    else out.push(massSpec('cluster', 'masses', `cluster:${mc.g}:${mc.start}`, solid, () => clusterShapes(ectx, c), W, H, gentle));
    if (mc.g >= 1) out.push(massSpec('dust', 'masses', `dust:${mc.g}:${mc.start}`, solid, () => dustShapes(ectx, c), W, H, gentle));
    const age = drawingAge(ectx, c);
    // Reduce flashing holds the wisps under +0.08 L, like the veil (washes.ts's liftCap).
    const wispAlpha = gentle ? Math.min(wispOpacity(age.A), liftCap(rig.palette[1])) : wispOpacity(age.A);
    if (wispKind(age.A)) out.push(massSpec('wisps', 'fx', `wisp:${age.k}:${age.A}:${age.start}`, wispAlpha * mc.alpha, () => wispShapes(ectx, c), W, H));
    // The debris and the sparks are thin FX that move every frame: Reduce
    // flashing keeps them at GENTLE_FX (STILL_FX at the ladder's last step).
    const thin = !gentle ? 1 : degrade.posters === 'none' ? STILL_FX : GENTLE_FX;
    out.push(massSpec('debris', 'fx', `debris:${mc.g}:${mc.start}:${chunkDrawing(ectx, c)}`, thin * mc.alpha, () => debrisShapes(ectx, c), W, H));
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
        alpha: thin * pf.alpha,
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

  const ensure = (sp: PartSpec, mk: MakeScratch): DrawnPart => stored(rig, sp.key) ?? keep(rig, (sp.luma ? lumaPart : drawPart)(mk, sp.key, sp.slot, sp.name, sp.box(), (ctx) => sp.paint(ctx, mk)));

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

    // The cracks and the masses; the front FX's 2s parts wait for the floods.
    const specs = massSpecs(c);
    for (const sp of specs) {
      if (sp.slot === 'fx' || sp.slot === 'flash' || !(sp.alpha > 0)) continue;
      const part = ensure(sp, make);
      if (part.image) add(sp.slot, sp.name, sp.key, sp.alpha, 'composite', sp.luma ? lumaBlit(part, sp.alpha, make, LUMA_CELL * S) : blit(part, sp.alpha));
    }

    // The floods, each with its wide glow right over it, under him and the
    // masses (judge round 2: laid over the cluster, the wash turned the smoke
    // violet on f113–118, where the reference's stays orange-brown); then the
    // front FX: the 2s parts, then the lightning, then the A5–6 flash.
    if (ictx && j !== null && j >= 9) {
      const fd: FloodDrawing | null = floodShapes(ictx, j, washOpts);
      if (fd) {
        add('floods', 'flood', fd.key, fd.level, 'energy', { key: null, draw: (ctx) => paintFlood(ctx, make, fd, W, H) });
        const content = fd.key.slice(0, fd.key.lastIndexOf(':'));
        const wash = () => [[worldGlow(rig, make, 'flood', content, () => floodCalls(fd)), fd.level] as const];
        add('floods', 'floodGlow', `${content}@${fd.level}`, fd.level, 'glow', { key: null, draw: (ctx) => compositeGlows(ctx, wash()) });
        gains.flood = fd.level;
      }
    }
    for (const sp of specs) {
      if (sp.slot !== 'fx' || !(sp.alpha > 0)) continue;
      const part = ensure(sp, make);
      if (part.image) add('fx', sp.name, sp.key, sp.alpha, 'composite', blit(part, sp.alpha));
    }
    const lp = lightningPlan(c);
    const boltGlow = gentle ? GENTLE_BOLT_GLOW : 1;
    if (lp) {
      const part = lightningPart(lp);
      if (part.image) add('fx', 'lightning', part.key, lp.gain, 'energy', blit(part, gentle ? GENTLE_BOLT : 1));
      world.push({ name: 'lightning', content: part.key, calls: () => part.glow?.[0]?.calls ?? [], gain: boltGlow });
      gains.lightning = lp.gain;
      gains.ribbons = lp.gain * lp.boost * boltGlow; // the ribbons' glow, all told: the arcs' cap below is half of it
    }
    for (const sp of specs) {
      if (sp.slot !== 'flash' || !(sp.alpha > 0)) continue;
      const part = ensure(sp, make);
      if (part.image) add('flash', sp.name, sp.key, sp.alpha, 'composite', blit(part, sp.alpha));
    }

    // The glow: the limbs' through their stamp (each limb's arcs at its own
    // flicker), then the frame's own (the strike's, the charge's, the
    // lightning's); one composite when both go in one slot and the stamp is
    // the identity (a fresh drawing), as each composite lays two full images.
    // From j 9 the limbs' glow goes on right over the limbs in front, under
    // the masses that stand in front of them (judge round 2: laid over the
    // cluster, their red light turned the smoke rose); the lightning's stays
    // on top, over the smoke its ribbons crawl on.
    const limbSlot: StackSlot = j !== null && j >= 9 ? 'limbsFront' : 'glow';
    const worldKey = world.map((w) => `${w.content}@${w.gain}`).join('|');
    const worldEntries = () => world.map((w) => [worldGlow(rig, make, w.name, w.content, w.calls), w.gain] as const);
    let worldDone = world.length === 0;
    if (limbGlow && (limbGlow.part.glow?.length ?? 0) > 0) {
      const { part, T } = limbGlow;
      const k1 = c1(c, I);
      const own = part.glow ?? [];
      // Over the measured aftermath the arcs glow at most half as bright as
      // the ribbons' glow (judge round 2: they outshone them), and half of
      // the ribbons' full gain before the first bolt.
      const cap = j !== null && j >= 9 && j <= 31 ? ARC_AFTER * (lp ? lp.gain * lp.boost * boltGlow : 1) : Infinity;
      const arcGains = own.map((g) => (g.id === null ? (gentle ? GENTLE_LIMB_GLOW : 1) : gentle ? GENTLE_ARC : Math.min(cap, arcFlicker(g.id, k1))));
      own.forEach((g, i) => {
        if (g.id !== null) gains[`arc:${g.id}`] = arcGains[i];
      });
      const limbKey = `${part.key}@${arcGains.map((g) => g.toFixed(4)).join(',')}`;
      const limbEntries = () => glowSet(rig, part, make).map((glow, i) => [glow, arcGains[i]] as const);
      if (limbSlot === 'glow' && isIdentity(T) && !worldDone) {
        add('glow', 'glow', `${limbKey}|${worldKey}`, 1, 'glow', { key: null, draw: (ctx) => compositeGlows(ctx, [...limbEntries(), ...worldEntries()]) });
        worldDone = true;
      } else {
        add(limbSlot, 'limbGlow', limbKey, 1, 'glow', {
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
    physicsKey: rig.physicsKey,
    waiting: rig.waiting,
    physics: () => liftOf(rig),
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
    missing: (o) => jobsAt(o),
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
