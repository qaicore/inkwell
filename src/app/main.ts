import { CanvasSink } from 'mediabunny';
import { drawStroke, wobbleTick, type Point, type Stroke } from '../render/brush';
import { FPS, frameTime, frameTimes, loadClip, type Clip } from '../video/clip';
import { exportClip } from '../export/export';
import { drawMaskTint, renderFrame, type Scene } from '../render/compose';
import type { FollowMode } from '../track/standin';
import { maskHasPerson, maskNear, trackStroke, type Pose, type Tracking } from '../track/tracking';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $<HTMLElement>('stage');
const view = $<HTMLCanvasElement>('view');
const ctx = view.getContext('2d')!;
const drop = $<HTMLElement>('drop');
const fileInput = $<HTMLInputElement>('file');
const clipInfo = $<HTMLElement>('clip-info');
const statusText = $<HTMLElement>('status');
const exportButton = $<HTMLButtonElement>('export');
const downloadLink = $<HTMLAnchorElement>('download');
const playButton = $<HTMLButtonElement>('play');
const scrub = $<HTMLInputElement>('scrub');
const frameLabel = $<HTMLOutputElement>('frame-label');
const sizeSlider = $<HTMLInputElement>('size');
const sizeValue = $<HTMLOutputElement>('size-value');
const wobbleToggle = $<HTMLInputElement>('wobble');
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
const strokePoses = new Map<number, Pose[] | null>();

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
  renderFrame(ctx, frameBuffer, frame, clip.width, clip.height, scene());
  if (showTracking.checked && tracking) paintTracking(clip);
  if (live) drawStroke(ctx, live, wobbleToggle.checked ? wobbleTick(frame) : null, null, false);
}

// What to draw, and where tracking puts it. The preview works each stroke's
// poses out as it needs them; the export passes in a fixed copy, so changing
// the follow mode mid-export can't change the video halfway through.
function scene(using = tracking, poses: (stroke: Stroke) => Pose[] | null = posesFor): Scene {
  return {
    strokes: [...strokes],
    wobble: wobbleToggle.checked,
    personMask: (i) => (using ? maskNear(using.masks, i) : null),
    pose: (stroke, i) => poses(stroke)?.[i] ?? null,
  };
}

function posesFor(stroke: Stroke) {
  if (!tracking) return null;
  let poses = strokePoses.get(stroke.id);
  if (poses === undefined) {
    const [x, y] = stroke.points[0];
    poses = trackStroke(tracking, [x, y], stroke.frame, FPS);
    strokePoses.set(stroke.id, poses);
  }
  return poses;
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

// Screen position to clip pixels. A mouse has no pressure, so it gets a
// placeholder and the brush works pressure out from speed instead.
function pointFrom(e: PointerEvent): Point {
  const box = view.getBoundingClientRect();
  return [
    ((e.clientX - box.left) / box.width) * clip!.width,
    ((e.clientY - box.top) / box.height) * clip!.height,
    e.pointerType === 'pen' ? e.pressure : 0.5,
  ];
}

view.addEventListener('pointerdown', (e) => {
  if (!clip || busy || e.button !== 0) return;
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
    size: Number(sizeSlider.value),
    frame,
    pen: e.pointerType === 'pen',
    layer: document.querySelector<HTMLInputElement>('input[name="layer"]:checked')!.value === 'behind' ? 'behind' : 'front',
    points: [pointFrom(e)],
  };
  requestPaint();
});

view.addEventListener('pointermove', (e) => {
  if (!live) return;
  // A pen reports more positions than events; use them all for a smoother line.
  const events = e.getCoalescedEvents?.() ?? [];
  for (const event of events.length > 0 ? events : [e]) live.points.push(pointFrom(event));
  requestPaint();
});

function finishStroke() {
  if (!live) return;
  strokes.push(live);
  live = null;
  updateButtons();
  requestPaint();
}
view.addEventListener('pointerup', finishStroke);
view.addEventListener('pointercancel', finishStroke);

function undo() {
  if (busy || strokes.length === 0) return;
  strokes.pop();
  updateButtons();
  paint();
}

// ---- Exporting -----------------------------------------------------------------

async function exportVideo() {
  if (!clip || busy) return;
  pause();
  setBusy(true);
  const startedAt = performance.now();
  try {
    const { width, height } = clip;
    const fixedPoses = new Map(strokes.map((stroke) => [stroke.id, posesFor(stroke)]));
    const frameScene = scene(tracking, (stroke) => fixedPoses.get(stroke.id) ?? null);
    const video = await exportClip(
      clip,
      (exportCtx, image, i) => renderFrame(exportCtx, image, i, width, height, frameScene),
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
  trackButton.disabled = !ready;
}

// ---- Tracking --------------------------------------------------------------------

// Switches to the tracking for the chosen follow mode, or to none.
function useTracking() {
  tracking = makeTracking ? makeTracking(followSelect.value as FollowMode) : null;
  strokePoses.clear();
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
wobbleToggle.addEventListener('change', paint);
undoButton.addEventListener('click', undo);
clearButton.addEventListener('click', () => {
  strokes = [];
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
