import { CanvasSink } from 'mediabunny';
import { DEFAULT_BRUSH, type Point } from '../render/brush';
import { FPS, frameTime, frameTimes, loadClip, type Clip } from '../video/clip';
import { exportClip, exportSize, isIPhone, type ExportPlan } from '../export/export';
import { FlashCheckError } from '../export/flash';
import { drawMaskTint, renderFrame, type Scene } from '../render/compose';
import type { BrushTarget } from '../render/brushes';
import { drawingIndex, EXAMPLE_TIMING, frameAt, validateTiming, type Timing } from '../motion/timing';
import type { FollowMode } from '../track/standin';
import { torsoHeights } from '../track/torso';
import { followShapes, maskHasPerson, maskNear, smoothTrack, trackStroke, type PointSet, type Pose, type Tracking } from '../track/tracking';
import {
  anchorTrack,
  animateStroke,
  browserScratch,
  decodeEnvelope,
  drawLive,
  drawStroke,
  effectOf,
  hasImpact,
  impactClip,
  impactScene,
  LIMB_ROOT,
  PALETTE,
  sceneOwns,
  withFloor,
  type ClipData,
  type ClipMotion,
  type DrawnStroke,
  type Stroke,
} from './engine';
import {
  asSamMasks,
  back,
  clearTurn,
  flowMoments,
  forgetStroke,
  IMPACT_STROKES,
  impactDone,
  initialFlow,
  LIMB_STROKES,
  limbsDone,
  moveContact,
  nudgeTurnKey,
  openImpact,
  openLimbs,
  ROOT_FLASH_MS,
  setAftermath,
  setFlash,
  setTurnDir,
  snapRoot,
  suggestLimbFrame,
  TURN_ASK,
  turnKeyFrames,
  turnTap,
  type DrawnOn,
  type Flow,
  type ImpactCue,
  type Step,
} from './flow';
import { HOLD_MS, PREVIEW_SIZE, startRenderAhead, type RenderAhead, type SceneData } from './render-worker';
import { personAndFace, samTrackingSliced, type SamSource } from './pipeline';
import { applyOverride, applyPlan, isOverridden, OVERRIDE_FIELDS, type OverrideField } from './overrides';
import { renderPlanPanel } from './plan-panel';
import { cachedAnswer, sha256Hex } from '../sam/client';
import { samCacheFile, type SamMask } from '../sam/cache';
import { maskReader } from '../sam/mask-worker';
import { samShape } from '../track/anchor';
import { planStrokes, type PlanInput, type PlanRequest, type PlanResult, type PlanTransport } from '../plan/plan';
import { proxyTransport } from '../plan/request';
import { drawPlanMarks, PLAN_IMAGE_LONG_SIDE, strokeColor } from '../plan/numbered';
import type { Tier } from '../impact/contracts';
import type { Masks } from '../impact/detect';
import { estimateFloor, type FloorEstimate } from '../impact/floor-estimate';
import { LADDER } from '../impact/ladder';
import { forgetPhysics, keepPhysics, packPhysics, unpackPhysics, type ImpactScene, type PackedPhysics } from '../impact/scene';
import { startSim, type Sim } from '../lift/sim-worker';
import { serializeEffect, type BrushId, type Effect, type Moment, type Vec2 } from '../types/effect';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $<HTMLElement>('stage');
const view = $<HTMLCanvasElement>('view');
const ctx = view.getContext('2d')!;
const drop = $<HTMLElement>('drop');
const fileInput = $<HTMLInputElement>('file');
const clipInfo = $<HTMLElement>('clip-info');
const statusText = $<HTMLElement>('status');
const timingNote = $<HTMLElement>('timing-note');
const exportButton = $<HTMLButtonElement>('export');
const exportSheet = $<HTMLElement>('export-sheet');
const exportGo = $<HTMLButtonElement>('export-go');
const flashExport = $<HTMLInputElement>('flash-export');
const flashWarning = $<HTMLElement>('flash-warning');
const downloadLink = $<HTMLAnchorElement>('download');
const shareButton = $<HTMLButtonElement>('share');
const playButton = $<HTMLButtonElement>('play');
const prevFrame = $<HTMLButtonElement>('prev-frame');
const nextFrame = $<HTMLButtonElement>('next-frame');
const scrub = $<HTMLInputElement>('scrub');
const frameLabel = $<HTMLOutputElement>('frame-label');
const sheetMessage = $<HTMLElement>('sheet-message');
const sheetMain = $<HTMLElement>('sheet-main');
const drawLimbsButton = $<HTMLButtonElement>('draw-limbs');
const drawImpactButton = $<HTMLButtonElement>('draw-impact');
const moreButton = $<HTMLButtonElement>('more');
const morePanel = $<HTMLElement>('more-panel');
const stepLimbs = $<HTMLElement>('step-limbs');
const limbsBack = $<HTMLButtonElement>('limbs-back');
const limbsUndo = $<HTMLButtonElement>('limbs-undo');
const limbsDoneButton = $<HTMLButtonElement>('limbs-done');
const turnAsk = $<HTMLElement>('turn-ask');
const turnDirButton = $<HTMLButtonElement>('turn-dir');
const turnHere = $<HTMLButtonElement>('turn-here');
const turnClearButton = $<HTMLButtonElement>('turn-clear');
const stepImpact = $<HTMLElement>('step-impact');
const flashImpact = $<HTMLInputElement>('flash-impact');
const impactBack = $<HTMLButtonElement>('impact-back');
const impactUndo = $<HTMLButtonElement>('impact-undo');
const impactDoneButton = $<HTMLButtonElement>('impact-done');
const contactEarlier = $<HTMLButtonElement>('contact-earlier');
const contactLater = $<HTMLButtonElement>('contact-later');
const contactLabel = $<HTMLOutputElement>('contact-label');
const aftermathSlider = $<HTMLInputElement>('aftermath');
const aftermathValue = $<HTMLOutputElement>('aftermath-value');
const turnKeysList = $<HTMLElement>('turn-keys');
const turnKeysNote = $<HTMLElement>('turn-keys-note');
const toastBox = $<HTMLElement>('toast');
const sizeSlider = $<HTMLInputElement>('size');
const sizeValue = $<HTMLOutputElement>('size-value');
const wobbleToggle = $<HTMLInputElement>('wobble');
const auraToggle = $<HTMLInputElement>('flame-aura');
const stiffnessSlider = $<HTMLInputElement>('stiffness');
const stiffnessValue = $<HTMLOutputElement>('stiffness-value');
const rigidToggle = $<HTMLInputElement>('rigid');
const brushSelect = $<HTMLSelectElement>('brush');
const planButton = $<HTMLButtonElement>('plan');
const planPanel = $<HTMLElement>('plan-panel');
const saveEffectButton = $<HTMLButtonElement>('save-effect');
const saveDrawingsButton = $<HTMLButtonElement>('save-drawings');
const rawButton = $<HTMLButtonElement>('raw-strokes');
const undoButton = $<HTMLButtonElement>('undo');
const clearButton = $<HTMLButtonElement>('clear');
const trackButton = $<HTMLButtonElement>('track');
const trackingControls = $<HTMLElement>('tracking-controls');
const followSelect = $<HTMLSelectElement>('follow');
const showTracking = $<HTMLInputElement>('show-tracking');

let clip: Clip | null = null;
let frames: CanvasSink | null = null; // for seeking; playback makes its own
let frame = 0; // the frame on screen
let targetFrame = 0; // the frame asked for last; the arrow keys step from it
let strokes: Stroke[] = [];
let live: Stroke | null = null; // the stroke being drawn right now
let livePointer = -1; // the finger or pen drawing it; any other touch is ignored
let nextStrokeId = 1;
let busy = false; // converting or exporting
let playing = false;
let playToken = 0; // bumping this stops the playback loop
let downloadUrl = '';
let exported: File | null = null; // the last export, for Save to Photos

// Tracking for the current clip, if it has been tracked. `makeTracking`
// builds it for a follow mode; each stroke's poses are worked out the first
// time they're needed and kept until the tracking changes.
let makeTracking: ((mode: FollowMode) => Tracking) | null = null;
let tracking: Tracking | null = null;
let torsoUnits: (number | null)[] | null = null; // torso height per frame, from tracking's masks
let standInBodies: (PointSet | null)[] | null = null; // the stand-in's landmarks: the impact's turn and bend
let standInSkeleton: (PointSet | null)[] | null = null; // all 33 of them: the limbs' dummy's arms and legs (lift/collide.ts)
let auraColor: 0 | 1 | 2 | null = null; // the flame aura's ink, or null when it's off
const strokePoses = new Map<number, Pose[] | null>();

// SAM 3.1 answers already paid for, by the clip's hashes (src/sam/client.ts),
// and the runs read so far: person, face, and each planned anchor's own.
let sam: SamSource = () => null;
let sourceSha = ''; // the opened file's SHA-256, which names the clip in drawings.json
const samRuns = new Map<string, (SamMask | null)[] | null>(); // null: asked, not cached

// The last plan and the taps on it (src/app/overrides.ts).
let plan: PlanResult | null = null;
let planColors = new Map<number, string>();
let overrides: Record<string, unknown> = {};

// The two drawings (src/app/flow.ts): which sheet is up, and what each Done
// read. The limbs are the 'limb' strokes; the impact's are ground-anchored.
let flow: Flow = initialFlow();
let envelope: number[] | null = null; // the clip's sound every 10 ms, for the impact sheet's cue
let rootFlash: { at: Vec2; until: number } | null = null; // a limb root that snapped onto him
let toastTimer = 0;
const TOAST_MS = 3000;
const ROOT_RING = 0.03; // × S: the snapped root's highlight
const LIMB_STIFFNESS = 0.1; // the limbs hang floppy (Qai's pick)
const isLimb = (stroke: Stroke) => stroke.brush === 'limb' && stroke.anchor?.type !== 'ground';
const isCrack = (stroke: Stroke) => stroke.anchor?.type === 'ground';
const shortSide = (c: Clip) => Math.min(c.width, c.height);

// Every frame's strokes, animated for the whole clip at once (src/app/engine.ts).
// Each stroke's drawings over the whole clip, by stroke id, worked out when
// first needed. Strokes move independently, so a new stroke is animated on
// its own and undo drops one entry; a new clip, tracking, timing or wobble
// changes every stroke (invalidate). `animation` is the same, frame by frame.
const perStroke = new Map<number, DrawnStroke[]>();
let animation: DrawnStroke[][] | null = null;
const invalidate = () => {
  perStroke.clear();
  dropPreview();
};

// The impact preview (impact/scene.ts). Once the effect has limbs or a slam,
// the scene draws the whole frame: the limbs and the cracks itself, the other
// strokes from `animation`. It's built the first time a frame needs it and
// dropped whenever the strokes, the flow or the tracking change. Its drawings
// are made ahead of the frames that show them, in a worker where there is one
// (render-worker.ts); the phone tier on an iPhone. Its physics is worked out
// in another (lift/sim-worker.ts), so a rebuild never holds the page: until
// it comes the scene shows the limbs as drawn, then it's built again with
// it. What comes back is kept by its key (keepPhysics), and packed for the
// render-ahead's worker; anything else he changes takes it as it is. The
// export waits for its own there too. Without that worker (or once it
// fails), the scenes work their physics out here.
let renderAhead: RenderAhead | null = null;
let sim: Sim | null = null;
// The physics wanted of the worker: the preview's, and the export's, which
// waits for it. The worker works out only the newest ask, so one is asked at
// a time (`running`), the export's first, and the other once that comes.
type Wanted = { key: string; data: SceneData };
const wanted: { preview: Wanted | null; export: (Wanted & { done: (physics: PackedPhysics | null) => void }) | null } = { preview: null, export: null };
let running = ''; // the key asked of the worker, until it comes
let failedKey = ''; // the preview's physics whose run failed: not asked for again
const packed = new Map<string, PackedPhysics>(); // what came back, by key, the newest last
const PACKED_KEPT = 3; // as many as the scene keeps
let preview: { scene: ImpactScene; effect: Effect } | null | undefined; // undefined: not built yet
let clipData: ClipData | null = null; // what the scene reads of the clip, built once per tracking
let clipDataCount = 0; // names each, for the physics' key on every thread
let detector: Masks | null = null; // the tracking's masks as the detector reads them
let limbPoses: { key: string; poses: Pose[] } | null = null; // the limbs' track (anchorTrack), by their ids
let bodyKey = ''; // the turn the other strokes were animated with
const previewTier: Tier = isIPhone(navigator.userAgent) ? 'phone' : 'full';
function dropPreview() {
  preview = undefined;
  animation = null;
}

// Qai's reference/timing.json sets the drawings per second and the boil. The
// dev server serves it; until it exists (and in production builds) the
// example file's numbers stand in, and the header says so.
// TODO(M4): where production builds get their timing from.
let timing: Timing = EXAMPLE_TIMING;
const EXAMPLE_NOTE = 'Timing: example numbers (reference/timing.json missing or invalid)';
timingNote.textContent = EXAMPLE_NOTE;
if (import.meta.env.DEV) {
  fetch('/reference/timing.json')
    .then((response) => (response.ok ? response.json() : null))
    .then((json) => {
      const read = validateTiming(json);
      if ('problem' in read) {
        if (json !== null) timingNote.textContent = `Timing: example numbers (reference/timing.json: ${read.problem})`;
        return;
      }
      timing = read.timing;
      timingNote.textContent = '';
      invalidate();
      paint();
    })
    .catch(() => {}); // missing (the dev server answers with the app page, not JSON): keep the example's numbers
}

// The video frame on screen, at full clip size. Every repaint starts from it.
const frameBuffer = document.createElement('canvas');
const frameCtx = frameBuffer.getContext('2d')!;

// ---- Opening a clip --------------------------------------------------------

async function openClip(file: Blob, name: string) {
  if (busy) return;
  pause();
  setBusy(true);
  const startedAt = performance.now();
  let opened: Clip | null = null;
  let cacheRead: Promise<void> = Promise.resolve();
  try {
    const next = await loadClip(file, name, (p) => setStatus(`Converting to H.264 at 30 fps… ${percent(p)}`));
    clip?.input.dispose();
    clip = next;
    frames = new CanvasSink(clip.track, { poolSize: 2 });
    frameBuffer.width = clip.width;
    frameBuffer.height = clip.height;
    strokes = [];
    makeTracking = null;
    standInBodies = null;
    standInSkeleton = null;
    forgetPhysics(); // the last clip's
    packed.clear();
    wanted.preview = null;
    running = failedKey = '';
    forgetPlan();
    samRuns.clear();
    sam = () => null;
    sourceSha = '';
    flow = { ...initialFlow(), flash: flow.flash };
    envelope = null;
    useTracking();
    URL.revokeObjectURL(downloadUrl); // the last export was of the old clip
    downloadUrl = '';
    downloadLink.hidden = true;
    exported = null;
    shareButton.hidden = true;
    flashWarning.hidden = true;
    scrub.max = String(clip.frameCount - 1);
    setSize(defaultSize(clip));
    clipInfo.textContent = `${name} · ${clip.width}×${clip.height} · ${clip.frameCount} frames`;
    drop.hidden = true;
    view.hidden = false;
    updateSheet();
    layout();
    await seek(0);
    setStatus(`Converted in ${seconds(startedAt)} s. Draw limbs to start the impact, or draw on any frame.`);
    cacheRead = connectSamCache(next, file);
    void decodeEnvelope(next.file, next.start).then((heard) => {
      if (clip === next) envelope = heard;
    });
    opened = next;
  } catch (err) {
    console.error(err);
    setStatus(`Couldn't open that clip: ${errorText(err)}`);
  } finally {
    setBusy(false);
  }
  // Dev only: the stand-in tracks every clip as it opens, no Track to press,
  // once the cache is read, so the two don't share the page's time.
  if (opened && trackStandIn) {
    const tracked = opened;
    void cacheRead.then(() => trackStandIn?.(tracked));
  }
}

// ---- Showing frames ------------------------------------------------------------

// Shows frame i. While one seek is decoding, newer requests replace older
// ones, so dragging the scrubber never builds up a backlog. `frame` only
// changes once the new picture is on screen, so a stroke started meanwhile
// belongs to the frame you can see.
let wantedFrame: number | null = null;
let seeking = false;
async function seek(i: number) {
  targetFrame = i;
  wantedFrame = i;
  if (seeking) return;
  seeking = true;
  try {
    while (wantedFrame !== null && clip && frames) {
      const target = wantedFrame;
      wantedFrame = null;
      const wrapped = await frames.getCanvas(frameTime(clip, target));
      if (wrapped && !playing) showFrame(target, wrapped.canvas); // playback has moved on
    }
  } finally {
    seeking = false;
  }
}

function showFrame(i: number, image: CanvasImageSource) {
  frame = i;
  frameCtx.drawImage(image, 0, 0, frameBuffer.width, frameBuffer.height);
  scrub.value = String(i);
  frameLabel.value = `frame ${i} · ${(i / FPS).toFixed(2)} s`;
  paint();
}

// One frame earlier or later, from the frame asked for last.
function stepFrame(by: number) {
  if (!clip || busy || live) return;
  pause();
  seek(Math.min(clip.frameCount - 1, Math.max(0, targetFrame + by)));
}

// Plays from the current frame at 30 fps, looping at the end.
async function play() {
  if (!clip || playing || busy) return;
  playing = true;
  playButton.textContent = 'Pause';
  const token = ++playToken;
  let from = targetFrame >= clip.frameCount - 1 ? 0 : targetFrame;
  while (token === playToken && clip) {
    const current = clip;
    const sink = new CanvasSink(current.track, { poolSize: 2 });
    const startedAt = performance.now();
    let i = from;
    for await (const wrapped of sink.canvasesAtTimestamps(frameTimes(current, from))) {
      if (token !== playToken) break;
      const wait = startedAt + ((i - from) * 1000) / FPS - performance.now();
      if (wait > 0) await sleep(wait);
      if (token !== playToken) break;
      targetFrame = i;
      if (wrapped) showFrame(i, wrapped.canvas);
      i++;
    }
    if (i === from) break; // nothing to play
    from = 0;
  }
}

function pause() {
  if (!playing) return;
  playing = false;
  playToken++;
  playButton.textContent = 'Play';
}

// ---- Painting ------------------------------------------------------------------

// The finished frame, the tracking overlay if it's on, a limb root that just
// snapped, then the stroke being drawn, on top of everything so you can see
// it while you draw. With an impact the scene draws the frame at its own
// internal size, and the drawings due next are asked for ahead. A scene
// built here is drawn on the next frame, so building it and drawing it the
// first time (its limbs and the other strokes, before the render-ahead has
// them) are two tasks, not one long one (decision 20: none may hold the page
// past 100 ms). Nor does the first paint of a rebuilt scene draw its limbs,
// masses and posters here: it asks the render-ahead's worker for them and
// holds the last frame on screen (or draws the plain frame, if the canvas
// shows another) until they come (R5, S2). That's only for a parked frame:
// playing has moved on before the worker answers, so holding there would drop
// the effect from the clip. Playing draws what's missing here, and runs late
// rather than plain.
let shownImpact: number | null = null; // the output frame the canvas holds from the impact scene; null = the plain frame, or nothing
let holdTimer = 0;
function paint() {
  if (!clip) return;
  if (preview === undefined && previewScene()) {
    requestPaint();
    return;
  }
  ctx.imageSmoothingQuality = playing ? 'low' : 'high'; // drawImage at 'high' is most of a played frame
  const impact = previewScene();
  let drawn = false;
  let held = false;
  if (impact && renderAhead && !playing && !renderAhead.ready(frame)) {
    // Its drawings are on their way: keep the frame the canvas holds if it's
    // this one, else the plain frame. The worker's arrival paints again.
    held = shownImpact === frame;
    drawn = held;
    if (!holdTimer) holdTimer = window.setTimeout(() => ((holdTimer = 0), requestPaint()), HOLD_MS + 100);
  } else if (impact) {
    try {
      ctx.setTransform(view.width / impact.width, 0, 0, view.height / impact.height, 0, 0);
      impact.render(ctx as unknown as BrushTarget, frameBuffer, frame);
      renderAhead?.ahead(frame);
      drawn = true;
      shownImpact = frame;
    } catch (err) {
      console.error(err);
      setStatus(`The impact preview failed, so this is the plain frame: ${errorText(err)}`);
      preview = null; // until the strokes or the flow change
      animation = null;
    }
  }
  // Width and height are scaled separately, the same way pointFrom maps the
  // pointer, so the frame fills the canvas exactly.
  ctx.setTransform(view.width / clip.width, 0, 0, view.height / clip.height, 0, 0);
  if (!drawn) {
    renderFrame(ctx, frameBuffer, frame, clip.width, clip.height, plainScene(), { make: browserScratch, drawStroke });
    shownImpact = null;
  }
  if (showTracking.checked && tracking) paintTracking(clip);
  paintRootFlash(clip);
  if (live) drawLive(ctx, live);
}

// What to draw without an impact. The export holds on to one of these, so
// changing the follow mode or drawing mid-export can't change the video
// halfway through.
function plainScene(): Scene {
  const frames = animated();
  const using = tracking;
  const units = torsoUnits;
  const dps = timing.dps;
  return {
    strokes: (i) => frames[i] ?? [],
    personMask: (i) => (using ? maskNear(using.masks, i) : null),
    aura: (i) => {
      const torsoPx = units?.[i];
      return auraColor !== null && torsoPx ? { color: PALETTE[auraColor], k: drawingIndex(i, dps), torsoPx } : null;
    },
  };
}

function clipMotion(c: Clip): ClipMotion {
  return {
    frameCount: c.frameCount,
    width: c.width,
    height: c.height,
    poses: posesFor,
    units: torsoUnits,
    timing,
    wobble: wobbleToggle.checked,
  };
}

// The strokes the page animates: all of them, or with an impact the ones its
// scene doesn't draw, turning with him when the scene reads a turn.
function animated(): DrawnStroke[][] {
  if (!clip) return [];
  if (!animation) {
    const impact = previewScene();
    const body = bodyOf(impact);
    if (body.key !== bodyKey) {
      bodyKey = body.key;
      perStroke.clear();
    }
    const motion: ClipMotion = { ...clipMotion(clip), body: body.at };
    const shown = preview ? strokes.filter((stroke) => !sceneOwns(stroke, preview!.effect)) : strokes;
    const each = shown.map((stroke) => {
      let drawn = perStroke.get(stroke.id);
      if (!drawn) perStroke.set(stroke.id, (drawn = animateStroke(stroke, motion)));
      return drawn;
    });
    animation = Array.from({ length: clip.frameCount }, (_, f) => each.map((drawn) => drawn[f]));
  }
  return animation;
}

// His facing and bend from the scene's lift, for the other strokes, when it
// reads a turn (his tap, or his pose); none otherwise. `key` changes when
// the turn does, and every stroke is animated again.
function bodyOf(impact: ImpactScene | null): { at: ClipMotion['body']; key: string } {
  const keys = impact ? impact.turn().keys : [];
  if (!impact || keys.length === 0) return { at: null, key: '' };
  const bodies = impact.bodies();
  return {
    at: (f) => {
      const b = bodies[f];
      return b ? { theta: b.yaw, pitch: b.pitch } : null;
    },
    key: JSON.stringify(keys),
  };
}

function posesFor(stroke: Stroke) {
  let poses = strokePoses.get(stroke.id);
  if (poses === undefined) {
    const [x, y] = stroke.points[0];
    const own = anchorMasks(stroke);
    if (own) poses = smoothTrack(followShapes(own.map((m) => (m ? samShape(m) : null)), [x, y], stroke.frame), [x, y], stroke.frame, FPS);
    else if (tracking) poses = trackStroke(tracking, [x, y], stroke.frame, FPS);
    else return null;
    strokePoses.set(stroke.id, poses);
  }
  return poses;
}

// The SAM run a stroke's planned anchor names, when it's cached and isn't
// the person (the person is `tracking`). Fetched in the background
// (loadAnchorRuns); until it arrives, the stroke follows the person.
function anchorMasks(stroke: Stroke): (SamMask | null)[] | null {
  const file = stroke.anchor ? samCacheFile(stroke.anchor, stroke.id) : null;
  if (!file || file === 'sam-person.json') return null;
  return samRuns.get(file) ?? null;
}

function loadAnchorRuns() {
  const opened = clip;
  if (!opened) return;
  for (const stroke of strokes) {
    const file = stroke.anchor ? samCacheFile(stroke.anchor, stroke.id) : null;
    if (!file || samRuns.has(file)) continue;
    samRuns.set(file, null);
    void Promise.resolve(sam(file))
      .then((json) => (json ? readMasks(json, opened.frameCount) : null))
      .then((masks) => {
        if (!masks || clip !== opened) return;
        samRuns.set(file, masks);
        for (const s of strokes) {
          if (!s.anchor || samCacheFile(s.anchor, s.id) !== file) continue;
          strokePoses.delete(s.id);
          perStroke.delete(s.id);
        }
        dropPreview();
        paint();
      })
      .catch((err: unknown) => console.warn(`Couldn't read ${file} from the cache`, err));
  }
}

// ---- The impact scene ------------------------------------------------------------

// The preview's scene, built for the current strokes and flow; null without
// an impact (or when it couldn't be built), where the plain frame is drawn.
function previewScene(): ImpactScene | null {
  if (!clip) return null;
  if (preview === undefined) {
    preview = null;
    const effect = currentEffect();
    let made: ImpactScene | null = null;
    let data: SceneData | null = null;
    if (hasImpact(effect)) {
      const poses = limbTrack(clip);
      data = { effect, poses, tier: previewTier, size: renderAhead?.size ?? PREVIEW_SIZE, boil: timing.boil };
      try {
        made = impactScene(effect, impactClip(clipDataOf(clip), poses), { tier: data.tier, size: data.size, boil: data.boil, strokes: (c) => animated()[c] ?? [], physics: sim ? 'wait' : undefined });
        if (made && sim) data = { ...data, physics: physicsFor(made, data) };
      } catch (err) {
        console.error(err);
        setStatus(`Couldn't build the impact preview: ${errorText(err)}`);
      }
    }
    preview = made ? { scene: made, effect } : null;
    renderAhead?.scene(made, made ? data : null);
  }
  return preview?.scene ?? null;
}

// The physics the render-ahead's worker builds the page's scene with: what
// came back for it, or 'wait' while the page's scene waits for it, wanted of
// the worker (not after its run failed).
function physicsFor(scene: ImpactScene, data: SceneData): PackedPhysics | 'wait' {
  const key = scene.physicsKey;
  if (!scene.waiting) {
    wanted.preview = null;
    let p = packed.get(key);
    if (!p) keepPacked((p = packPhysics(scene.physics())));
    return p;
  }
  wanted.preview = failedKey === key ? null : { key, data };
  askSim();
  return 'wait';
}

// The export's physics, from the worker: null when its run failed or the
// worker stopped, where the export's scene works it out itself.
function physicsAsked(key: string, data: SceneData): Promise<PackedPhysics | null> {
  return new Promise((done) => {
    wanted.export?.done(null);
    wanted.export = { key, data, done };
    askSim();
  });
}

// Asks the worker for what's wanted, the export's first, unless it's asked already.
function askSim() {
  const next = wanted.export ?? wanted.preview;
  if (!sim || !next || running === next.key) return;
  running = next.key;
  sim.run(next.key, next.data);
}

function keepPacked(p: PackedPhysics) {
  packed.delete(p.key);
  packed.set(p.key, p);
  while (packed.size > PACKED_KEPT) packed.delete(packed.keys().next().value as string);
}

// The clip as the scene reads it, once per tracking: the workers get a copy.
function clipDataOf(c: Clip): ClipData {
  if (!clipData) {
    clipData = {
      width: c.width,
      height: c.height,
      frames: c.frameCount,
      masks: tracking?.masks ?? null,
      faces: samRuns.get('sam-face.json') ?? null,
      bodies: standInBodies,
      skeleton: standInSkeleton,
      units: torsoUnits,
      id: `clip ${++clipDataCount}`,
    };
    renderAhead?.clip(clipData);
    sim?.clip(clipData);
    running = ''; // the worker drops what it was asked for the last one
  }
  return clipData;
}

// The limbs' track: their mean root, followed by the tracking.
function limbTrack(c: Clip): Pose[] {
  const limbs = strokes.filter(isLimb);
  const key = limbs.map((s) => s.id).join(',');
  if (limbPoses?.key !== key) {
    const using = tracking;
    limbPoses = { key, poses: anchorTrack(limbs, c.frameCount, using ? (root, f) => trackStroke(using, root, f, FPS) : null) };
  }
  return limbPoses.poses;
}

// The person masks the detector reads (impact/detect.ts): SAM's from the
// cache, else the tracking's, else none on every frame.
function detectorMasks(c: Clip): Masks {
  const person = samRuns.get('sam-person.json');
  if (person) return person;
  detector ??= tracking ? asSamMasks(tracking.masks, c.width, c.height) : Array.from({ length: c.frameCount }, () => null);
  return detector;
}

// What the impact sheet opens on: `parked` is the frame he moved the
// scrubber to himself, if he did.
const cue = (c: Clip, parked: number | null): ImpactCue => ({ parked, audio: envelope, masks: detectorMasks(c), S: shortSide(c) });
const parkedFrame = () => (frame !== flow.frame ? frame : null);
const linesOf = (list: Stroke[]): DrawnOn[] => list.map((s) => ({ id: s.id, points: s.points, frame: s.frame }));

// ---- The flow --------------------------------------------------------------------

// Moves the flow on: the preview is built again when the moments change, the
// snap's toast shows once, and each sheet opens on its own frame. Done on
// the impact replays from 20 frames before the contact.
function setFlow(next: Flow) {
  const before = flow;
  flow = next;
  if (JSON.stringify(flowMoments(before)) !== JSON.stringify(flowMoments(next))) dropPreview();
  if (next.toast && next.toast !== before.toast) showToast(next.toast);
  if (next.step !== before.step) preselect(next.step);
  updateSheet();
  updateButtons();
  if (clip && (next.step !== before.step || next.frame !== before.frame)) {
    pause();
    void seek(Math.min(clip.frameCount - 1, next.frame));
    if (before.step === 'impact' && next.step === 'preview') void play();
  }
  paint();
}

// What each sheet draws with until he changes it in More: the limb brush in
// the first ink for the limbs, floppy, its size the root's 0.04 S; black ink
// for the impact (pointerdown pins the impact's strokes to the ground). The
// scene layers the limbs itself, so the layer radio is left as it is.
function preselect(step: Step) {
  if (!clip) return;
  if (step === 'limbs') {
    brushSelect.value = 'limb';
    setInk(PALETTE[0]);
    rigidToggle.checked = false;
    stiffnessSlider.disabled = false;
    setStiffness(LIMB_STIFFNESS);
    setSize(Math.round(LIMB_ROOT * shortSide(clip)));
  } else if (step === 'impact') {
    brushSelect.value = 'ink';
    setInk(PALETTE[2]);
    setSize(defaultSize(clip));
  }
}

function updateSheet() {
  const { step } = flow;
  sheetMain.hidden = step === 'limbs' || step === 'impact';
  stepLimbs.hidden = step !== 'limbs';
  stepImpact.hidden = step !== 'impact';
  sheetMessage.textContent = flow.message ?? '';
  sheetMessage.hidden = !flow.message;
  turnDirButton.textContent = flow.dir === 1 ? 'Right side first' : 'Left side first';
  turnDirButton.setAttribute('aria-pressed', String(flow.dir === -1));
  flashImpact.checked = flow.flash === 'safe';
  flashExport.checked = flow.flash === 'safe';
  contactLabel.value = flow.contact === null ? 'not set' : `f${flow.contact}`;
  aftermathSlider.value = String(Math.round(flow.aftermath * 10));
  aftermathValue.value = `${flow.aftermath.toFixed(1)} s`;
  showTurnKeys();
}

// More → Turn: the optional override (decision 4). This frame marks where
// his back faces you; No tap goes back to the pose's turn; each of the tap's
// keys a frame earlier or later.
function showTurnKeys() {
  const keys = flow.turn ? turnKeyFrames(flow.turn) : [];
  turnClearButton.hidden = !flow.turn;
  turnKeysNote.textContent = flow.turn
    ? 'His back faces you on the middle key. Move any key that is off by a frame.'
    : 'No tap: the turn is read from his pose where it reads as one, else there is none.';
  turnKeysList.replaceChildren(
    ...keys.map(([f, deg], i) => {
      const row = document.createElement('div');
      row.className = 'group';
      const earlier = keyButton('◀', `Key ${i + 1} a frame earlier`, () => setFlow(nudgeTurnKey(flow, i, -1)));
      const later = keyButton('▶', `Key ${i + 1} a frame later`, () => setFlow(nudgeTurnKey(flow, i, 1)));
      const label = document.createElement('output');
      label.value = `f${f} · ${Math.round(deg)}°`;
      row.append(earlier, label, later);
      return row;
    }),
  );
}

function keyButton(text: string, label: string, onClick: () => void) {
  const button = document.createElement('button');
  button.className = 'big';
  button.textContent = text;
  button.setAttribute('aria-label', label);
  button.disabled = busy;
  button.addEventListener('click', onClick);
  return button;
}

function showToast(text: string) {
  toastBox.textContent = text;
  toastBox.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastBox.hidden = true), TOAST_MS);
}

// The highlight on a limb root that snapped onto him, for 300 ms.
function paintRootFlash(c: Clip) {
  if (!rootFlash) return;
  if (performance.now() > rootFlash.until) {
    rootFlash = null;
    return;
  }
  const S = shortSide(c);
  ctx.lineWidth = S / 250;
  ctx.strokeStyle = '#38e1ff';
  ctx.beginPath();
  ctx.arc(rootFlash.at[0], rootFlash.at[1], ROOT_RING * S, 0, Math.PI * 2);
  ctx.stroke();
}

// ---- SAM from the cache ------------------------------------------------------------

// Looks the clip up in the cache by its hashes. If SAM has been run on it
// (and paid for once), its masks replace the stand-in: the person cutout and
// what strokes follow.
// A cached SAM run decoded off the page, a few workers at once (sam/mask-worker.ts).
const readMasks = maskReader();

async function connectSamCache(opened: Clip, source: Blob) {
  try {
    const hashes = [await sha256Hex(opened.file), await sha256Hex(source)];
    if (clip !== opened) return;
    sourceSha = hashes[1];
    sam = (file) => cachedAnswer(hashes, file);
    const fromCache = { id: opened.name, sha256: hashes[0], frames: opened.frameCount, width: opened.width, height: opened.height, fps: FPS };
    const reading = (f: number) => clip === opened && setStatus(`Reading your clip… ${percent(f)}`);
    const { person, face } = await personAndFace(fromCache, sam, (json, count) => (reading(0), readMasks(json, count, reading)));
    if (clip !== opened) return;
    samRuns.set('sam-person.json', person);
    samRuns.set('sam-face.json', face);
    const cutouts = await samTrackingSliced(person, opened.width, opened.height, nextTask);
    if (clip !== opened) return;
    makeTracking = () => cutouts;
    useTracking();
    setStatus(`SAM 3.1 masks for this clip, from the cache: the person on ${person.filter(Boolean).length} of ${opened.frameCount} frames.`);
  } catch {
    // Not cached (or no cache to ask): the stand-in, in dev, or no tracking.
  }
}

// ---- The plan --------------------------------------------------------------------

// Plans the strokes drawn on this frame (one Wonder call per drawing, §9):
// a cached answer if there is one, otherwise Wonder through the proxy. A bad
// or missing answer falls back to the nearest-mask rule, with its note shown.
async function planDrawing() {
  if (!clip || busy) return;
  const drawn = strokes.filter((s) => s.frame === frame);
  if (drawn.length === 0) {
    setStatus('Draw on this frame first: the plan reads the strokes on the frame they were drawn on.');
    return;
  }
  pause();
  setBusy(true);
  setStatus('Reading your drawing…');
  try {
    const input: PlanInput = {
      frame,
      strokes: drawn.map((s) => ({ id: s.id, points: s.points })),
      masks: { person: samRuns.get('sam-person.json')?.[frame] ?? null, face: samRuns.get('sam-face.json')?.[frame] ?? null },
    };
    planColors = new Map(drawn.map((s, i) => [s.id, strokeColor(i)]));
    plan = await planStrokes(input, await cachedThenLive(input));
    usePlan();
    setStatus(plan.source === 'wonder' ? `Planned ${plan.strokes.length} stroke${plan.strokes.length === 1 ? '' : 's'}.` : 'Used the nearest-mask plan; see the note.');
  } catch (err) {
    console.error(err);
    setStatus(`Planning failed: ${errorText(err)}`);
  } finally {
    setBusy(false);
  }
}

// A cached plan call for exactly these strokes on this frame, replayed;
// otherwise the live call.
async function cachedThenLive(input: PlanInput): Promise<PlanTransport> {
  type Cached = { calls?: { frame: number; strokes: PlanInput['strokes']; attempts: { text: string }[] }[] };
  const cache = (await sam('wonder-plan.json')) as Cached | null;
  const same = (a: PlanInput['strokes'], b: PlanInput['strokes']) => JSON.stringify(a) === JSON.stringify(b);
  const call = cache?.calls?.find((c) => c.frame === input.frame && same(c.strokes, input.strokes));
  if (!call) return proxyTransport(numberedFrame);
  let n = 0;
  return async () => {
    const attempt = call.attempts[n++];
    if (!attempt) throw new Error('the cached call has no more attempts');
    return attempt.text;
  };
}

// The frame Wonder sees: each stroke in its own color, numbered at its root
// (src/plan/numbered.ts), 1024 px on the long side.
function numberedFrame(request: PlanRequest): string {
  const fit = PLAN_IMAGE_LONG_SIDE / Math.max(clip!.width, clip!.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(clip!.width * fit);
  canvas.height = Math.round(clip!.height * fit);
  const c = canvas.getContext('2d')!;
  c.drawImage(frameBuffer, 0, 0, canvas.width, canvas.height);
  drawPlanMarks(c, request.input.strokes, fit, (id) => planColors.get(id) ?? '#ffffff');
  return canvas.toDataURL('image/jpeg', 0.85);
}

// The effect for the current strokes with the taps on them, and the flow's
// moments and turn tap, the slam on the floor read from him.
const currentEffect = (): Effect => {
  const { moments, turn } = flowMoments(flow);
  const effect = effectOf(strokes, { ...clipMotion(clip!), moments: withFloor(moments, slamFloor(clip!, moments)), turn }, undefined, overrides);
  return auraColor === null ? effect : { ...effect, aura: { color: auraColor } };
};

// The slam's floor (impact/floor-estimate.ts): read once per P, contact and
// tracking from the stand-in pose and the detector's masks. Without a pose,
// or where it can't be read, it falls back and the slam keeps DEFAULT_FLOOR;
// the console says why.
let floorRead: { key: string; bodies: unknown; masks: Masks; estimate: FloorEstimate } | null = null;
function slamFloor(c: Clip, moments: Effect['moments']): FloorEstimate | null {
  const slam = (moments ?? []).find((m): m is Moment => m.kind === 'slam');
  if (!slam || slam.floor) return null;
  const I = frameAt(slam.at);
  const key = `${slam.xy[0]},${slam.xy[1]},${I}`;
  const masks = detectorMasks(c);
  if (floorRead?.key !== key || floorRead.bodies !== standInBodies || floorRead.masks !== masks) {
    const estimate = estimateFloor({ P: [slam.xy[0], slam.xy[1]], I, width: c.width, height: c.height, masks, bodies: standInBodies });
    console.info(`Impact floor: ${estimate.from === 'person' ? JSON.stringify(estimate.floor) : 'DEFAULT_FLOOR'} (${estimate.why})`);
    floorRead = { key, bodies: standInBodies, masks, estimate };
  }
  return floorRead.estimate;
}

// Writes the plan, with the taps on top, into the strokes, then redraws the
// panel. Fields the plan doesn't set (the brush) keep what the stroke has.
function usePlan() {
  if (!clip || !plan) return;
  const effect = applyPlan(currentEffect(), plan.strokes);
  for (const s of effect.strokes) {
    const stroke = strokes.find((x) => x.id === s.id);
    if (!stroke) continue;
    const anchorChanged = JSON.stringify(stroke.anchor) !== JSON.stringify(s.anchor);
    stroke.kind = s.kind;
    stroke.stiffness = s.stiffness;
    stroke.layer = s.views.front.layer;
    stroke.brush = s.brush ?? stroke.brush;
    stroke.anchor = s.anchor;
    stroke.bodyAngle = s.bodyAngle;
    stroke.wobble = s.wobble;
    perStroke.delete(s.id);
    if (anchorChanged) strokePoses.delete(s.id);
  }
  dropPreview();
  limbPoses = null;
  loadAnchorRuns();
  showPanel(effect);
  updateButtons();
  paint();
}

function showPanel(effect: Effect) {
  if (!plan) return;
  const rows = plan.strokes.flatMap((p) => {
    const s = effect.strokes.find((x) => x.id === p.id);
    if (!s) return [];
    const values: Record<OverrideField, unknown> = { kind: s.kind, anchor: s.anchor, bodyAngle: s.bodyAngle, stiffness: s.stiffness, layer: s.views.front.layer, wobble: s.wobble, brush: s.brush ?? 'ink' };
    const overridden = new Set(OVERRIDE_FIELDS.filter((f) => isOverridden(effect, p.id, f)));
    return [{ id: p.id, color: planColors.get(p.id) ?? '#ffffff', reason: p.reason, values, overridden }];
  });
  const events = {
    set: (id: number, field: OverrideField, value: unknown) => {
      overrides = applyOverride(currentEffect(), id, field, value).overrides;
      usePlan();
    },
    reset: (id: number, field: OverrideField) => {
      const rest = { ...overrides };
      delete rest[`strokes.${id}.${field}`];
      overrides = rest;
      usePlan();
    },
  };
  const rootOf = (id: number) => {
    const s = strokes.find((x) => x.id === id)!;
    return { time: s.frame / FPS, xy: [s.points[0][0], s.points[0][1]] as [number, number] };
  };
  renderPlanPanel(planPanel, rows, plan.note, plan.source, events, rootOf);
}

function forgetPlan() {
  plan = null;
  overrides = {};
  planPanel.hidden = true;
  planPanel.replaceChildren();
}

// The effect JSON (SPEC §7), the taps and the impact's moments included: the
// project file.
function saveEffect() {
  if (!clip || strokes.length === 0) return;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([serializeEffect(currentEffect())], { type: 'application/json' }));
  link.download = 'effect.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href));
}

// The person mask tinted blue, and a ring on each stroke's root.
function paintTracking(clip: Clip) {
  const mask = tracking ? maskNear(tracking.masks, frame) : null;
  if (mask) drawMaskTint(ctx, mask, clip.width, clip.height);
  ctx.lineWidth = clip.height / 300;
  for (const stroke of strokes) {
    const pose = posesFor(stroke)?.[frame];
    const [x, y] = pose ? [pose.x, pose.y] : stroke.points[0];
    ctx.strokeStyle = pose ? '#38e1ff' : '#ffb020'; // orange: not attached
    ctx.beginPath();
    ctx.arc(x, y, clip.height / 90, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// Pointer moves can arrive faster than the screen refreshes; paint once per frame.
let paintQueued = false;
function requestPaint() {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => {
    paintQueued = false;
    paint();
  });
}

// Fits the canvas inside the stage at the clip's aspect ratio, with enough
// real pixels to stay sharp on high-DPI screens.
function layout() {
  if (!clip) return;
  const box = stage.getBoundingClientRect();
  const style = getComputedStyle(stage);
  const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const fit = Math.min((box.width - padX) / clip.width, (box.height - padY) / clip.height);
  const cssWidth = Math.max(1, Math.floor(clip.width * fit));
  const cssHeight = Math.max(1, Math.floor(clip.height * fit));
  view.style.width = `${cssWidth}px`;
  view.style.height = `${cssHeight}px`;
  shownImpact = null; // resizing clears the canvas
  view.width = Math.round(cssWidth * devicePixelRatio);
  view.height = Math.round(cssHeight * devicePixelRatio);
  paint();
}
new ResizeObserver(layout).observe(stage);

// ---- Drawing -------------------------------------------------------------------

// Screen position to clip pixels. A pen reports its pressure. A mouse has
// none, so it draws at an even 0.5. A finger has none either, and it's the
// main way to draw on a phone, so its pressure is made up from speed
// (fingerPoint).
function pointFrom(e: PointerEvent): Point {
  const box = view.getBoundingClientRect();
  const x = ((e.clientX - box.left) / box.width) * clip!.width;
  const y = ((e.clientY - box.top) / box.height) * clip!.height;
  if (e.pointerType === 'touch') return fingerPoint(x, y);
  return [x, y, e.pointerType === 'pen' ? e.pressure : 0.5];
}

// Finger input, the way a brush pen behaves: slow is heavy, fast is light.
// Each point is pulled part of the way toward the finger (streamline), which
// takes the wobble out of quick finger strokes, and pressure eases toward a
// target set by how far the point moved, in brush sizes. Both happen once, as
// the stroke is drawn, so the stored stroke is what renders everywhere.
const FINGER_STREAMLINE = 0.5; // share of the way toward the finger each event
const FINGER_EASE = 0.3; // share of the way toward the target pressure each event
function fingerPoint(x: number, y: number): Point {
  const last = live?.points.at(-1);
  if (!last) return [x, y, 0.5];
  const px = last[0] + (x - last[0]) * (1 - FINGER_STREAMLINE);
  const py = last[1] + (y - last[1]) * (1 - FINGER_STREAMLINE);
  const speed = Math.hypot(px - last[0], py - last[1]) / Math.max(1, live!.size);
  const target = Math.min(1, Math.max(0.2, 1 - speed));
  return [px, py, last[2] + (target - last[2]) * FINGER_EASE];
}

// On the impact sheet every stroke is pinned to the ground: fixed frame px,
// rigid, behind him, no boil.
view.addEventListener('pointerdown', (e) => {
  if (!clip || busy || e.button !== 0) return;
  if (live) return; // a second finger while drawing: not a new stroke, and not a pinch
  livePointer = e.pointerId;
  pause();
  // Capture keeps the stroke going if the finger slides off the canvas. If a
  // browser refuses it, draw anyway.
  try {
    view.setPointerCapture(e.pointerId);
  } catch (err) {
    console.warn("Couldn't capture the pointer; strokes stop at the canvas edge.", err);
  }
  const first = pointFrom(e);
  const ground = flow.step === 'impact';
  live = {
    id: nextStrokeId++,
    color: document.querySelector<HTMLInputElement>('input[name="color"]:checked')!.value,
    brush: brushSelect.value as BrushId,
    size: Number(sizeSlider.value),
    frame,
    pen: e.pointerType === 'pen',
    layer: ground || document.querySelector<HTMLInputElement>('input[name="layer"]:checked')!.value === 'behind' ? 'behind' : 'front',
    kind: ground || rigidToggle.checked ? 'rigid' : 'strand',
    stiffness: ground ? 1 : Number(stiffnessSlider.value) / 100,
    points: [first],
    ...(ground ? { anchor: { type: 'ground' as const, xy: [first[0], first[1]] as [number, number] }, wobble: 0 } : {}),
  };
  requestPaint();
});

view.addEventListener('pointermove', (e) => {
  if (!live || e.pointerId !== livePointer) return;
  // A pen reports more positions than events; use them all for a smoother line.
  const events = e.getCoalescedEvents?.() ?? [];
  for (const event of events.length > 0 ? events : [e]) live.points.push(pointFrom(event));
  requestPaint();
});

function finishStroke(e: PointerEvent) {
  if (!live || e.pointerId !== livePointer) return;
  const drawn = live;
  live = null;
  // A tap, or a press that never moved, has no direction to draw or
  // resample along: drop it.
  const distinct = new Set(drawn.points.map(([x, y]) => `${x},${y}`)).size;
  if (distinct >= 2 && clip) {
    const full = fullDrawing(drawn);
    if (full) setFlow({ ...flow, message: full });
    else {
      if (flow.step === 'limbs' && isLimb(drawn)) snapLimbRoot(clip, drawn);
      strokes.push(drawn);
      dropPreview(); // and the new stroke is animated on its own
      if (flow.message) setFlow({ ...flow, message: null });
    }
  }
  updateButtons();
  requestPaint();
}
view.addEventListener('pointerup', finishStroke);
view.addEventListener('pointercancel', finishStroke);

// A seventh limb or a ninth impact stroke isn't kept, and the sheet says why.
function fullDrawing(stroke: Stroke): string | null {
  if (flow.step === 'limbs' && isLimb(stroke) && strokes.filter(isLimb).length >= LIMB_STROKES.max) return `${LIMB_STROKES.max} limbs at most: undo one to draw another.`;
  if (flow.step === 'impact' && strokes.filter(isCrack).length >= IMPACT_STROKES.max) return `${IMPACT_STROKES.max} impact strokes at most: undo one to draw another.`;
  return null;
}

// A limb whose root is off his body has it moved onto him (flow.ts's
// snapRoot), and the ring shows where for 300 ms.
function snapLimbRoot(c: Clip, stroke: Stroke) {
  const { points, moved } = snapRoot(stroke.points, detectorMasks(c)[stroke.frame] ?? null, shortSide(c));
  if (!moved) return;
  stroke.points = points;
  rootFlash = { at: moved, until: performance.now() + ROOT_FLASH_MS };
  setTimeout(requestPaint, ROOT_FLASH_MS + 20);
}

// The last stroke goes; on the limbs or the impact sheet, the last one of
// that drawing. Undoing a limb or an impact stroke undoes what its Done read.
function undo() {
  if (busy || strokes.length === 0) return;
  const of = flow.step === 'limbs' ? isLimb : flow.step === 'impact' ? isCrack : () => true;
  let i = strokes.length - 1;
  while (i >= 0 && !of(strokes[i])) i--;
  if (i < 0) return;
  const [gone] = strokes.splice(i, 1);
  perStroke.delete(gone.id);
  strokePoses.delete(gone.id);
  dropPreview();
  setFlow(forgetStroke(flow, gone.id));
}

// Qai's strokes exactly as drawn, for reference/raw-strokes.json (A6 checks
// the stored 32 points against them). The effect has one brush, so the size
// is the first stroke's, in px at 1080 wide.
function saveRawStrokes() {
  if (!clip || strokes.length === 0) return;
  const round = (v: number, places: number) => Number(v.toFixed(places));
  const raw = {
    width: clip.width,
    brush: { ...DEFAULT_BRUSH, size: round((strokes[0].size * 1080) / clip.width, 2) },
    strokes: strokes.map((stroke) => ({
      id: stroke.id,
      points: stroke.points.map(([x, y, pressure]) => [round(x, 2), round(y, 2), round(pressure, 3)]),
    })),
  };
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([`${JSON.stringify(raw)}\n`], { type: 'application/json' }));
  link.download = 'raw-strokes.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href));
  setStatus(`Saved ${strokes.length} stroke${strokes.length === 1 ? '' : 's'} as raw-strokes.json. Put it in reference/ for A6.`);
}

// The strokes by the frame they were drawn on, in clip pixels, for
// scripts/live/plan.mjs to record Wonder's plan of each drawing (W1, G1).
// sourceSha ties it to the clip file, so it can't be replayed on another.
function saveDrawings() {
  if (!clip || strokes.length === 0) return;
  const round = (v: number, places: number) => Number(v.toFixed(places));
  const frames = [...new Set(strokes.map((s) => s.frame))].sort((a, b) => a - b);
  const drawings = {
    sourceSha256: sourceSha || null,
    width: clip.width,
    height: clip.height,
    drawings: frames.map((frame) => ({
      frame,
      strokes: strokes.filter((s) => s.frame === frame).map((s) => ({ id: s.id, points: s.points.map(([x, y, p]) => [round(x, 1), round(y, 1), round(p, 3)]) })),
    })),
  };
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([`${JSON.stringify(drawings, null, 1)}
`], { type: 'application/json' }));
  link.download = 'drawings.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href));
  setStatus(`Saved ${strokes.length} stroke${strokes.length === 1 ? '' : 's'} on ${frames.length} frame${frames.length === 1 ? '' : 's'} as drawings.json, for npm run plan:record.`);
}

// ---- Exporting -----------------------------------------------------------------

// The export sheet's Export: 720p on an iPhone, 1080p elsewhere, the flash
// check on every export (src/export/export.ts). Full flashing saves the video
// and warns when it flashes more than 3 times a second; Reduce flashing walks
// the ladder, and saves nothing when even its last step can't pass.
async function exportVideo() {
  if (!clip || busy) return;
  pause();
  setBusy(true);
  // The last export's links go until this one is saved: a Reduce flashing
  // export that fails saves nothing, and mustn't look as if it had.
  flashWarning.hidden = true;
  downloadLink.hidden = true;
  shareButton.hidden = true;
  const startedAt = performance.now();
  try {
    const opened = clip;
    const size = exportSize(opened.width, opened.height, isIPhone(navigator.userAgent));
    const result = await exportClip(opened, await exportPlan(opened, size), (p, what) => setStatus(`${what}… ${percent(p)}`));
    const name = `${opened.name.replace(/\.[^.]+$/, '')}-inkwell.mp4`;
    URL.revokeObjectURL(downloadUrl);
    downloadUrl = URL.createObjectURL(result.video);
    downloadLink.href = downloadUrl;
    downloadLink.download = name;
    downloadLink.textContent = `Download (${megabytes(result.video.size)})`;
    downloadLink.hidden = false;
    exported = new File([result.video], name, { type: 'video/mp4' });
    shareButton.hidden = !canShareFile(exported);
    flashWarning.textContent = result.warning ? `${result.warning} Turn on Reduce flashing to keep it under that.` : '';
    flashWarning.hidden = result.warning === null;
    const said = [`Exported ${result.frames} frames at ${size.width}×${size.height} in ${seconds(startedAt)} s.`];
    if (result.step > 0) said.push(`Reduced flashing at step ${result.step}: ${LADDER[result.step - 1].what}.`);
    for (const note of result.notes) said.push(`${note.charAt(0).toUpperCase()}${note.slice(1)}.`);
    if (import.meta.env.DEV) said.push(await saveToRenders(name, result.video));
    setStatus(said.join(' '));
  } catch (err) {
    console.error(err);
    if (err instanceof FlashCheckError) {
      flashWarning.textContent = err.message;
      flashWarning.hidden = false;
      setStatus(err.message);
    } else setStatus(`Export failed: ${errorText(err)}`);
  } finally {
    setBusy(false);
  }
}

// What the export draws, held as it is now: with an impact, its scene at the
// export's size on the full tier with nothing cut, each ladder step its own
// (degraded) copy of it; otherwise the plain frame, scaled. The scene's
// physics is worked out first, in the physics' worker where there is one.
async function exportPlan(c: Clip, size: { width: number; height: number; long: number }): Promise<ExportPlan> {
  const effect = currentEffect();
  const others = animated();
  const poses = limbTrack(c);
  const setup = { tier: 'full' as const, size: size.long, cuts: 0, boil: timing.boil, strokes: (f: number) => others[f] ?? [] };
  let impact = hasImpact(effect) ? impactScene(effect, impactClip(clipDataOf(c), poses), { ...setup, physics: sim ? 'wait' : undefined }) : null;
  if (impact?.waiting) {
    setStatus("Working out the limbs' physics…");
    const physics = await physicsAsked(impact.physicsKey, { effect, poses, tier: setup.tier, size: setup.size, cuts: setup.cuts, boil: setup.boil });
    impact = impactScene(effect, impactClip(clipDataOf(c), poses), { ...setup, physics: physics ?? undefined });
  }
  const slam = (effect.moments ?? []).find((m): m is Moment => m.kind === 'slam');
  const plain = plainScene();
  const steps = new Map<number, ImpactScene>();
  return {
    width: size.width,
    height: size.height,
    I: impact && slam ? frameAt(slam.at) : null,
    flash: flow.flash,
    draw: (out, image, o, step) => {
      if (impact) {
        let at = steps.get(step);
        if (!at) steps.set(step, (at = impact.degraded(step)));
        out.setTransform(size.width / at.width, 0, 0, size.height / at.height, 0, 0);
        at.render(out as unknown as BrushTarget, image, o);
        return;
      }
      out.setTransform(size.width / c.width, 0, 0, size.height / c.height, 0, 0);
      renderFrame(out, image, o, c.width, c.height, plain, { make: browserScratch, drawStroke });
    },
  };
}

// Save to Photos: the share sheet, whose Save Video puts it in Photos on an
// iPhone. Where files can't be shared, Download is the way.
const canShareFile = (file: File) => typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
async function saveToPhotos() {
  if (!exported) return;
  try {
    await navigator.share({ files: [exported] });
  } catch (err) {
    if (!(err instanceof DOMException && err.name === 'AbortError')) setStatus(`Couldn't share it (${errorText(err)}); use Download.`);
  }
}

// Dev only: hands the export to the dev server, which writes it to renders/.
// The export has already worked by now, so a failure here is only a note.
async function saveToRenders(name: string, video: Blob) {
  try {
    const saved = await fetch(`/__renders/${encodeURIComponent(name)}`, { method: 'POST', body: video });
    if (!saved.ok) throw new Error(`${saved.status} ${saved.statusText}`);
    return `Saved to ${(await saved.json()).path}.`;
  } catch (err) {
    return `Couldn't save it to renders/ (${errorText(err)}); use Download.`;
  }
}

// ---- Controls ------------------------------------------------------------------

function setBusy(value: boolean) {
  busy = value;
  fileInput.disabled = value;
  followSelect.disabled = value; // switching tracking mid-export would split the video
  updateButtons();
}

function updateButtons() {
  const ready = clip !== null && !busy;
  const none = strokes.length === 0;
  playButton.disabled = !ready;
  prevFrame.disabled = !ready;
  nextFrame.disabled = !ready;
  scrub.disabled = !ready;
  exportButton.disabled = !ready;
  exportGo.disabled = !ready;
  undoButton.disabled = !ready || none;
  clearButton.disabled = !ready || none;
  rawButton.disabled = !ready || none;
  planButton.disabled = !ready || none;
  saveEffectButton.disabled = !ready || none;
  saveDrawingsButton.disabled = !ready || none;
  trackButton.disabled = !ready;
  drawLimbsButton.disabled = !ready;
  drawImpactButton.disabled = !ready || flow.f1 === null;
  for (const button of [limbsBack, limbsUndo, limbsDoneButton, turnDirButton, turnHere, turnClearButton, impactBack, impactUndo, impactDoneButton]) button.disabled = !ready;
  contactEarlier.disabled = !ready || flow.contact === null;
  contactLater.disabled = !ready || flow.contact === null;
  aftermathSlider.disabled = !ready;
  flashImpact.disabled = busy;
  flashExport.disabled = busy;
}

// The sheets' controls, set from code: the swatch and the sliders.
function setInk(color: string) {
  const swatch = document.querySelector<HTMLInputElement>(`input[name="color"][value="${color}"]`);
  if (swatch) swatch.checked = true;
}
function setStiffness(value: number) {
  stiffnessSlider.value = String(Math.round(value * 100));
  stiffnessValue.value = value.toFixed(2);
}
function setSize(px: number) {
  sizeSlider.value = String(Math.min(Number(sizeSlider.max), Math.max(Number(sizeSlider.min), px)));
  sizeValue.value = sizeSlider.value;
}
const defaultSize = (c: Clip) => Math.round(c.height / 64);

// ---- Tracking --------------------------------------------------------------------

// Switches to the tracking for the chosen follow mode, or to none.
function useTracking() {
  tracking = makeTracking ? makeTracking(followSelect.value as FollowMode) : null;
  torsoUnits = tracking && clip ? torsoHeights(tracking.masks, clip.width, clip.height) : null;
  strokePoses.clear();
  clipData = null;
  detector = null;
  limbPoses = null;
  invalidate();
  trackingControls.hidden = tracking === null;
  paint();
}

// Dev only: until SAM 3.1 is connected, MediaPipe's pose model stands in for
// it, on every clip as it opens (and again from Track). The import sits
// inside this check so production builds leave it out. Its landmarks also
// give the impact his turn and bend, and all 33 of them the limbs' dummy its
// arms and legs (lift/collide.ts). SAM's masks, once they're read from the
// cache, stay what strokes follow.
let trackStandIn: ((tracked: Clip) => Promise<void>) | null = null;
if (import.meta.env.DEV) {
  // There is no Track button to press (R5, S2): index.html's stays hidden.
  trackStandIn = async (tracked) => {
    if (clip !== tracked || busy) return;
    pause();
    setBusy(true);
    const startedAt = performance.now();
    try {
      setStatus('Loading the stand-in tracker…');
      const { runStandIn, standInTracking } = await import('../track/standin');
      const standIn = await runStandIn(tracked, setStatus);
      if (clip !== tracked) return;
      if (!samRuns.get('sam-person.json')) makeTracking = (mode) => standInTracking(standIn, mode, tracked);
      standInBodies = standIn.bodies;
      standInSkeleton = standIn.skeleton;
      useTracking();
      const found = standIn.bodies.filter(Boolean).length;
      const masked = standIn.masks.filter((mask) => mask && maskHasPerson(mask)).length;
      setStatus(
        `Found the person on ${found} of ${tracked.frameCount} frames, with a mask on ${masked}, ` +
          `in ${seconds(startedAt)} s (stand-in for SAM).`,
      );
    } catch (err) {
      console.error(err);
      // The effect still runs: on SAM's masks alone, with the egg for a body.
      setStatus(`Tracking failed: ${errorText(err)}. ${samRuns.get('sam-person.json') ? 'The effect runs on the SAM masks alone.' : 'Without a tracker, the effect has nothing to follow.'}`);
    } finally {
      setBusy(false);
    }
  };
}

followSelect.addEventListener('change', useTracking);
showTracking.addEventListener('change', paint);

// A stroke's layer is set when it's drawn, so say so when it's switched.
for (const input of document.querySelectorAll<HTMLInputElement>('input[name="layer"]')) {
  input.addEventListener('change', () => {
    const where = input.value === 'behind' ? 'behind the person (once the clip is tracked)' : 'in front';
    setStatus(`New strokes go ${where}. Strokes you've already drawn keep their layer.`);
  });
}

// The bottom sheet: the two drawings, then Done on each.
drawLimbsButton.addEventListener('click', () => {
  if (!clip || busy) return;
  setFlow(openLimbs(flow, suggestLimbFrame(detectorMasks(clip))));
});
limbsDoneButton.addEventListener('click', () => {
  if (!clip || busy) return;
  setFlow(limbsDone(flow, linesOf(strokes.filter(isLimb)), cue(clip, parkedFrame())));
});
turnHere.addEventListener('click', () => {
  if (!clip || busy) return;
  setFlow(turnTap(flow, frame));
});
turnClearButton.addEventListener('click', () => setFlow(clearTurn(flow)));
turnDirButton.addEventListener('click', () => setFlow(setTurnDir(flow, flow.dir === 1 ? -1 : 1)));
drawImpactButton.addEventListener('click', () => {
  if (!clip || busy) return;
  setFlow(openImpact(flow, cue(clip, parkedFrame())));
});
impactDoneButton.addEventListener('click', () => {
  if (!clip || busy) return;
  setFlow(impactDone(flow, { limbs: linesOf(strokes.filter(isLimb)), cracks: linesOf(strokes.filter(isCrack)) }, detectorMasks(clip), shortSide(clip)));
});
limbsBack.addEventListener('click', () => setFlow(back(flow)));
impactBack.addEventListener('click', () => setFlow(back(flow)));
limbsUndo.addEventListener('click', undo);
impactUndo.addEventListener('click', undo);
for (const toggle of [flashImpact, flashExport]) toggle.addEventListener('change', () => setFlow(setFlash(flow, toggle.checked ? 'safe' : 'full')));

// More: Move contact ±1, the aftermath, the turn keys, and every tool.
moreButton.addEventListener('click', () => {
  morePanel.hidden = !morePanel.hidden;
  moreButton.setAttribute('aria-expanded', String(!morePanel.hidden));
});
contactEarlier.addEventListener('click', () => clip && setFlow(moveContact(flow, -1, clip.frameCount)));
contactLater.addEventListener('click', () => clip && setFlow(moveContact(flow, 1, clip.frameCount)));
aftermathSlider.addEventListener('input', () => {
  aftermathValue.value = `${(Number(aftermathSlider.value) / 10).toFixed(1)} s`;
});
aftermathSlider.addEventListener('change', () => setFlow(setAftermath(flow, Number(aftermathSlider.value) / 10)));

exportButton.addEventListener('click', () => {
  exportSheet.hidden = !exportSheet.hidden;
  exportButton.setAttribute('aria-expanded', String(!exportSheet.hidden));
});
exportGo.addEventListener('click', exportVideo);
shareButton.addEventListener('click', saveToPhotos);

playButton.addEventListener('click', () => (playing ? pause() : play()));
prevFrame.addEventListener('click', () => stepFrame(-1));
nextFrame.addEventListener('click', () => stepFrame(1));
scrub.addEventListener('input', () => {
  pause();
  seek(Number(scrub.value));
});
sizeSlider.addEventListener('input', () => {
  sizeValue.value = sizeSlider.value;
});
// The flame aura takes the ink selected when it's turned on.
auraToggle.addEventListener('change', () => {
  const ink = document.querySelector<HTMLInputElement>('input[name="color"]:checked')!.value;
  const i = PALETTE.indexOf(ink);
  auraColor = auraToggle.checked && i >= 0 ? (i as 0 | 1 | 2) : null;
  dropPreview();
  paint();
});
wobbleToggle.addEventListener('change', () => {
  invalidate();
  paint();
});
stiffnessSlider.addEventListener('input', () => {
  stiffnessValue.value = (Number(stiffnessSlider.value) / 100).toFixed(2);
});
rigidToggle.addEventListener('change', () => {
  stiffnessSlider.disabled = rigidToggle.checked; // rigid strokes don't use it
});
rawButton.addEventListener('click', saveRawStrokes);
undoButton.addEventListener('click', undo);
planButton.addEventListener('click', planDrawing);
saveEffectButton.addEventListener('click', saveEffect);
saveDrawingsButton.addEventListener('click', saveDrawings);
clearButton.addEventListener('click', () => {
  strokes = [];
  forgetPlan();
  invalidate();
  limbPoses = null;
  setFlow({ ...initialFlow(), frame, flash: flow.flash, aftermath: flow.aftermath }); // staying on this frame
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) openClip(file, file.name);
  fileInput.value = '';
});
stage.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
stage.addEventListener('dragleave', () => drop.classList.remove('over'));
stage.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const file = e.dataTransfer?.files[0];
  if (file) openClip(file, file.name);
});

// Space plays and pauses, arrows step one frame, Ctrl+Z undoes. None of
// them while the pen is down: the frame would change under the stroke.
document.addEventListener('keydown', (e) => {
  if (!clip || busy || live) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undo();
    return;
  }
  // Leave keys to a focused slider, checkbox or button.
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLButtonElement) return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (playing) pause();
    else play();
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    stepFrame(e.key === 'ArrowLeft' ? -1 : 1);
  }
});

// A mouse click shouldn't leave a button, checkbox or radio focused, or the
// arrows and Space would work it instead of the video. Clicking a label
// focuses its input only after the click, so blur once the click is done.
let clickedWithPointer = false;
document.addEventListener('pointerdown', () => {
  clickedWithPointer = true;
});
document.addEventListener('click', () => {
  if (!clickedWithPointer) return; // Enter or Space on a focused control
  clickedWithPointer = false;
  setTimeout(() => {
    const focused = document.activeElement;
    const isToggle = focused instanceof HTMLInputElement && (focused.type === 'checkbox' || focused.type === 'radio');
    if (focused instanceof HTMLButtonElement || isToggle) focused.blur();
  });
});

turnAsk.textContent = TURN_ASK;
updateSheet();

// The render-ahead: a worker when it can draw, else between frames. The
// preview is built again at its size, and the worker gets the clip.
void startRenderAhead().then((ahead) => {
  renderAhead = ahead;
  ahead.arrived = requestPaint;
  if (clipData) ahead.clip(clipData);
  dropPreview();
  paint();
});

// The physics' worker. Each physics that comes back is kept, a preview
// waiting for it is built again and an export waiting for it goes on; then
// what's still wanted is asked for. A preview's run that fails leaves its
// limbs as drawn (it would fail here too), and an export's works it out on
// the page, which says why; a worker that doesn't start leaves the physics to
// the page.
const exportWaits = (physics: PackedPhysics | null, key?: string) => {
  const waiting = wanted.export;
  if (!waiting || (key !== undefined && waiting.key !== key)) return;
  wanted.export = null;
  waiting.done(physics);
};
sim = startSim(
  (physics) => {
    keepPhysics(unpackPhysics(physics));
    keepPacked(physics);
    if (running === physics.key) running = '';
    exportWaits(physics, physics.key);
    if (wanted.preview?.key === physics.key) {
      wanted.preview = null;
      if (preview?.scene.waiting && preview.scene.physicsKey === physics.key) {
        dropPreview();
        paint();
      }
    }
    askSim();
  },
  (key, message) => {
    console.warn(`The limbs' physics failed in its worker: ${message}`);
    if (key !== null) {
      if (running === key) running = '';
      exportWaits(null, key);
      if (wanted.preview?.key === key) {
        wanted.preview = null;
        failedKey = key;
        setStatus(`The limbs' physics failed, so they show as drawn: ${message}`);
      }
      askSim();
      return;
    }
    sim?.dispose();
    sim = null;
    running = '';
    wanted.preview = null;
    exportWaits(null);
    dropPreview();
    paint();
  },
);

// ?clip=<url> opens a clip on load, e.g. ?clip=/samples/test.mp4 in dev.
const clipUrl = new URLSearchParams(location.search).get('clip');
if (clipUrl) {
  setStatus('Fetching clip…');
  fetch(clipUrl)
    .then((response) => {
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response.blob();
    })
    .then((blob) => openClip(blob, clipUrl.split('/').pop() || 'clip.mp4'))
    .catch((err) => setStatus(`Couldn't fetch ${clipUrl}: ${errorText(err)}`));
}

// ---- Small helpers -------------------------------------------------------------

function setStatus(text: string) {
  statusText.textContent = text;
}
const percent = (p: number) => `${Math.round(p * 100)}%`;
const seconds = (since: number) => ((performance.now() - since) / 1000).toFixed(1);
const megabytes = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const nextTask = () => new Promise<void>((resume) => void setTimeout(resume, 0));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
