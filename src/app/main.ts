import { CanvasSink } from 'mediabunny';
import { DEFAULT_BRUSH, type Point } from '../render/brush';
import { FPS, frameTime, frameTimes, loadClip, type Clip } from '../video/clip';
import { exportClip } from '../export/export';
import { drawMaskTint, renderFrame, type Scene } from '../render/compose';
import { drawingIndex, EXAMPLE_TIMING, validateTiming, type Timing } from '../motion/timing';
import type { FollowMode } from '../track/standin';
import { torsoHeights } from '../track/torso';
import { followShapes, maskHasPerson, maskNear, smoothTrack, trackStroke, type Pose, type Tracking } from '../track/tracking';
import { animateStroke, browserScratch, drawLive, drawStroke, effectOf, PALETTE, type ClipMotion, type DrawnStroke, type Stroke } from './engine';
import { personAndFace, samTracking, type SamSource } from './pipeline';
import { applyOverride, applyPlan, isOverridden, OVERRIDE_FIELDS, type OverrideField } from './overrides';
import { renderPlanPanel } from './plan-panel';
import { cachedAnswer, sha256Hex } from '../sam/client';
import { masksFromCache, samCacheFile, type SamMask } from '../sam/cache';
import { samShape } from '../track/anchor';
import { planStrokes, type PlanInput, type PlanRequest, type PlanResult, type PlanTransport } from '../plan/plan';
import { proxyTransport } from '../plan/request';
import { drawPlanMarks, PLAN_IMAGE_LONG_SIDE, strokeColor } from '../plan/numbered';
import { serializeEffect, type BrushId, type Effect } from '../types/effect';

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
const downloadLink = $<HTMLAnchorElement>('download');
const playButton = $<HTMLButtonElement>('play');
const scrub = $<HTMLInputElement>('scrub');
const frameLabel = $<HTMLOutputElement>('frame-label');
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

// Tracking for the current clip, if it has been tracked. `makeTracking`
// builds it for a follow mode; each stroke's poses are worked out the first
// time they're needed and kept until the tracking changes.
let makeTracking: ((mode: FollowMode) => Tracking) | null = null;
let tracking: Tracking | null = null;
let torsoUnits: (number | null)[] | null = null; // torso height per frame, from tracking's masks
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

// Every frame's strokes, animated for the whole clip at once (src/app/engine.ts).
// Each stroke's drawings over the whole clip, by stroke id, worked out when
// first needed. Strokes move independently, so a new stroke is animated on
// its own and undo drops one entry; a new clip, tracking, timing or wobble
// changes every stroke (invalidate). `animation` is the same, frame by frame.
const perStroke = new Map<number, DrawnStroke[]>();
let animation: DrawnStroke[][] | null = null;
const invalidate = () => {
  perStroke.clear();
  animation = null;
};

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
  try {
    const next = await loadClip(file, name, (p) => setStatus(`Converting to H.264 at 30 fps… ${percent(p)}`));
    clip?.input.dispose();
    clip = next;
    frames = new CanvasSink(clip.track, { poolSize: 2 });
    frameBuffer.width = clip.width;
    frameBuffer.height = clip.height;
    strokes = [];
    makeTracking = null;
    forgetPlan();
    samRuns.clear();
    sam = () => null;
    sourceSha = '';
    useTracking();
    URL.revokeObjectURL(downloadUrl); // the last export was of the old clip
    downloadUrl = '';
    downloadLink.hidden = true;
    scrub.max = String(clip.frameCount - 1);
    sizeSlider.value = String(Math.round(clip.height / 64));
    sizeValue.value = sizeSlider.value;
    clipInfo.textContent = `${name} · ${clip.width}×${clip.height} · ${clip.frameCount} frames`;
    drop.hidden = true;
    view.hidden = false;
    layout();
    await seek(0);
    setStatus(`Converted in ${seconds(startedAt)} s. Draw on any frame.`);
    void connectSamCache(next, file);
  } catch (err) {
    console.error(err);
    setStatus(`Couldn't open that clip: ${errorText(err)}`);
  } finally {
    setBusy(false);
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

// The finished frame, the tracking overlay if it's on, then the stroke
// being drawn, on top of everything so you can see it while you draw.
function paint() {
  if (!clip) return;
  // Width and height are scaled separately, the same way pointFrom maps the
  // pointer, so the frame fills the canvas exactly.
  ctx.setTransform(view.width / clip.width, 0, 0, view.height / clip.height, 0, 0);
  ctx.imageSmoothingQuality = 'high';
  renderFrame(ctx, frameBuffer, frame, clip.width, clip.height, scene(), { make: browserScratch, drawStroke });
  if (showTracking.checked && tracking) paintTracking(clip);
  if (live) drawLive(ctx, live);
}

// What to draw. The export holds on to one of these, so changing the follow
// mode or drawing mid-export can't change the video halfway through.
function scene(): Scene {
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

function animated(): DrawnStroke[][] {
  if (!clip) return [];
  if (!animation) {
    const motion = clipMotion(clip);
    const each = strokes.map((stroke) => {
      let drawn = perStroke.get(stroke.id);
      if (!drawn) perStroke.set(stroke.id, (drawn = animateStroke(stroke, motion)));
      return drawn;
    });
    animation = Array.from({ length: clip.frameCount }, (_, f) => each.map((drawn) => drawn[f]));
  }
  return animation;
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
      .then((json) => (json ? masksFromCache(json, opened.frameCount) : null))
      .then((masks) => {
        if (!masks || clip !== opened) return;
        samRuns.set(file, masks);
        for (const s of strokes) {
          if (!s.anchor || samCacheFile(s.anchor, s.id) !== file) continue;
          strokePoses.delete(s.id);
          perStroke.delete(s.id);
        }
        animation = null;
        paint();
      })
      .catch((err: unknown) => console.warn(`Couldn't read ${file} from the cache`, err));
  }
}

// ---- SAM from the cache ------------------------------------------------------------

// Looks the clip up in the cache by its hashes. If SAM has been run on it
// (and paid for once), its masks replace the stand-in: the person cutout and
// what strokes follow.
async function connectSamCache(opened: Clip, source: Blob) {
  try {
    const hashes = [await sha256Hex(opened.file), await sha256Hex(source)];
    if (clip !== opened) return;
    sourceSha = hashes[1];
    sam = (file) => cachedAnswer(hashes, file);
    const fromCache = { id: opened.name, sha256: hashes[0], frames: opened.frameCount, width: opened.width, height: opened.height, fps: FPS };
    const { person, face } = await personAndFace(fromCache, sam);
    if (clip !== opened) return;
    samRuns.set('sam-person.json', person);
    samRuns.set('sam-face.json', face);
    makeTracking = () => samTracking(person, opened.width, opened.height);
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

// The effect for the current strokes with the taps on them.
const currentEffect = (): Effect => {
  const effect = effectOf(strokes, clipMotion(clip!), undefined, overrides);
  return auraColor === null ? effect : { ...effect, aura: { color: auraColor } };
};

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
  animation = null;
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

// The effect JSON (SPEC §7), the taps included: the project file.
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
  live = {
    id: nextStrokeId++,
    color: document.querySelector<HTMLInputElement>('input[name="color"]:checked')!.value,
    brush: brushSelect.value as BrushId,
    size: Number(sizeSlider.value),
    frame,
    pen: e.pointerType === 'pen',
    layer: document.querySelector<HTMLInputElement>('input[name="layer"]:checked')!.value === 'behind' ? 'behind' : 'front',
    kind: rigidToggle.checked ? 'rigid' : 'strand',
    stiffness: Number(stiffnessSlider.value) / 100,
    points: [pointFrom(e)],
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
  // A tap, or a press that never moved, has no direction to draw or
  // resample along: drop it.
  const distinct = new Set(live.points.map(([x, y]) => `${x},${y}`)).size;
  if (distinct >= 2) strokes.push(live);
  live = null;
  animation = null; // the new stroke is animated on its own
  updateButtons();
  requestPaint();
}
view.addEventListener('pointerup', finishStroke);
view.addEventListener('pointercancel', finishStroke);

function undo() {
  if (busy || strokes.length === 0) return;
  perStroke.delete(strokes.pop()!.id);
  animation = null;
  updateButtons();
  paint();
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

async function exportVideo() {
  if (!clip || busy) return;
  pause();
  setBusy(true);
  const startedAt = performance.now();
  try {
    const { width, height } = clip;
    const frameScene = scene();
    const video = await exportClip(
      clip,
      (exportCtx, image, i) => renderFrame(exportCtx, image, i, width, height, frameScene, { make: browserScratch, drawStroke }),
      (p) => setStatus(`Exporting… ${percent(p)}`),
    );
    const name = `${clip.name.replace(/\.[^.]+$/, '')}-inkwell.mp4`;
    URL.revokeObjectURL(downloadUrl);
    downloadUrl = URL.createObjectURL(video);
    downloadLink.href = downloadUrl;
    downloadLink.download = name;
    downloadLink.textContent = `Download (${megabytes(video.size)})`;
    downloadLink.hidden = false;
    let message = `Exported ${clip.frameCount} frames in ${seconds(startedAt)} s.`;
    if (import.meta.env.DEV) message += ` ${await saveToRenders(name, video)}`;
    setStatus(message);
  } catch (err) {
    console.error(err);
    setStatus(`Export failed: ${errorText(err)}`);
  } finally {
    setBusy(false);
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
  playButton.disabled = !ready;
  scrub.disabled = !ready;
  exportButton.disabled = !ready;
  undoButton.disabled = !ready || strokes.length === 0;
  clearButton.disabled = !ready || strokes.length === 0;
  rawButton.disabled = !ready || strokes.length === 0;
  planButton.disabled = !ready || strokes.length === 0;
  saveEffectButton.disabled = !ready || strokes.length === 0;
  saveDrawingsButton.disabled = !ready || strokes.length === 0;
  trackButton.disabled = !ready;
}

// ---- Tracking --------------------------------------------------------------------

// Switches to the tracking for the chosen follow mode, or to none.
function useTracking() {
  tracking = makeTracking ? makeTracking(followSelect.value as FollowMode) : null;
  torsoUnits = tracking && clip ? torsoHeights(tracking.masks, clip.width, clip.height) : null;
  strokePoses.clear();
  invalidate();
  trackingControls.hidden = tracking === null;
  paint();
}

// Dev only: until SAM 3.1 is connected, MediaPipe's pose model stands in for
// it. The import sits inside this check so production builds leave it out.
if (import.meta.env.DEV) {
  trackButton.hidden = false;
  trackButton.title = 'Dev only: MediaPipe pose stands in for SAM 3.1';
  trackButton.addEventListener('click', async () => {
    if (!clip || busy) return;
    pause();
    setBusy(true);
    const tracked = clip;
    const startedAt = performance.now();
    try {
      setStatus('Loading the stand-in tracker…');
      const { runStandIn, standInTracking } = await import('../track/standin');
      const standIn = await runStandIn(tracked, setStatus);
      if (clip !== tracked) return;
      makeTracking = (mode) => standInTracking(standIn, mode, tracked);
      useTracking();
      const found = standIn.bodies.filter(Boolean).length;
      const masked = standIn.masks.filter((mask) => mask && maskHasPerson(mask)).length;
      setStatus(
        `Found the person on ${found} of ${tracked.frameCount} frames, with a mask on ${masked}, ` +
          `in ${seconds(startedAt)} s (stand-in for SAM).`,
      );
    } catch (err) {
      console.error(err);
      setStatus(`Tracking failed: ${errorText(err)}`);
    } finally {
      setBusy(false);
    }
  });
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

playButton.addEventListener('click', () => (playing ? pause() : play()));
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
  updateButtons();
  paint();
});
exportButton.addEventListener('click', exportVideo);

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
    pause();
    const step = e.key === 'ArrowLeft' ? -1 : 1;
    seek(Math.min(clip.frameCount - 1, Math.max(0, targetFrame + step)));
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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
