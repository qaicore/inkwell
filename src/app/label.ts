// The /label page (dev only): Qai marks a clip's ground truth here, and it
// saves to fixtures/<clip>/truth.json in the SPEC §11 format. Three passes:
//   Roots   click the attach point on every 10th frame (it jumps on by itself)
//   Facing  F, R, B or L on every 6th frame (it jumps on by itself)
//   Still   drag across the timeline's bottom lane where he holds still
// The clip is converted exactly as the app converts it, so frame N here is
// frame N in the file SAM gets, and that file is saved alongside the labels.
import { CanvasSink } from 'mediabunny';
import type { Facing } from '../types/effect.ts';
import { FPS, frameTime, frameTimes, loadClip, type Clip } from '../video/clip.ts';
import {
  CLIP_ID,
  FACING_EVERY,
  FACING_KEYS,
  ROOT_EVERY,
  addStill,
  emptyTruth,
  markFrames,
  removeStillAt,
  serializeTruth,
  setFacing,
  setRoot,
  stillAt,
  validateTruth,
  type Truth,
} from './truth.ts';

type Pass = 'roots' | 'facing' | 'still';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $<HTMLElement>('stage');
const view = $<HTMLCanvasElement>('view');
const ctx = view.getContext('2d')!;
const drop = $<HTMLElement>('drop');
const fileInput = $<HTMLInputElement>('file');
const clipIdInput = $<HTMLInputElement>('clip-id');
const loadInput = $<HTMLInputElement>('load');
const statusText = $<HTMLElement>('status');
const saveButton = $<HTMLButtonElement>('save');
const downloadLink = $<HTMLAnchorElement>('download');
const playButton = $<HTMLButtonElement>('play');
const prevButton = $<HTMLButtonElement>('prev');
const nextButton = $<HTMLButtonElement>('next');
const frameLabel = $<HTMLOutputElement>('frame-label');
const progress = $<HTMLOutputElement>('progress');
const hint = $<HTMLElement>('hint');
const timeline = $<HTMLCanvasElement>('timeline');
const tctx = timeline.getContext('2d')!;

const FACING_COLORS: Record<Facing, string> = { front: '#5bbf6a', right: '#4a90e2', back: '#a36bd6', left: '#e8a03a' };
const HINTS: Record<Pass, string> = {
  roots: 'Click the attach point · every 10th frame · right-click or Delete clears · [ ] jump',
  facing: 'F front · R his right side · B back · L his left side · every 6th frame · Delete clears',
  still: 'Drag on the bottom lane, or S at the start and E at the end · click a stretch or Delete to remove it',
};

let clip: Clip | null = null;
let frames: CanvasSink | null = null;
let frame = 0; // the frame on screen
let targetFrame = 0; // the frame asked for last
let truth: Truth = emptyTruth('');
let history: Truth[] = []; // for Ctrl+Z
let dirty = false; // changed since the last save to fixtures/
let pass: Pass = 'roots';
let stillStart: number | null = null; // set by S, closed by E
let drag: { lane: 'still' | 'scrub'; from: number; to: number } | null = null; // on the timeline
let busy = false;
let playing = false;
let playToken = 0;
let downloadUrl = '';

const frameBuffer = document.createElement('canvas');
const frameCtx = frameBuffer.getContext('2d')!;

// ---- Opening a clip --------------------------------------------------------

async function openClip(file: Blob, name: string) {
  if (busy) return;
  pause();
  busy = true;
  updateControls();
  try {
    const next = await loadClip(file, name, (p) => setStatus(`Converting to H.264 at 30 fps… ${Math.round(p * 100)}%`));
    clip?.input.dispose();
    clip = next;
    frames = new CanvasSink(clip.track, { poolSize: 2 });
    frameBuffer.width = clip.width;
    frameBuffer.height = clip.height;
    drop.hidden = true;
    view.hidden = false;
    timeline.hidden = false;
    if (!CLIP_ID.test(clipIdInput.value)) clipIdInput.value = idFrom(name);
    truth = emptyTruth(clipIdInput.value);
    history = [];
    dirty = false;
    layout();
    await seek(0);
    setStatus(`${clip.frameCount} frames at ${clip.width}×${clip.height}.`);
    await loadExisting(clipIdInput.value);
  } catch (err) {
    console.error(err);
    setStatus(`Couldn't open that clip: ${errorText(err)}`, true);
  } finally {
    busy = false;
    updateControls();
  }
}

// "Side Step (2).MOV" -> "side-step-2"
function idFrom(name: string) {
  return (
    name
      .replace(/\.[^.]*$/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'clip'
  );
}

// Picks up where he left off: unsaved marks kept in this browser first, then
// the clip's truth.json in fixtures/, else a blank sheet.
async function loadExisting(id: string) {
  if (!CLIP_ID.test(id)) return;
  const draft = readDraft(id);
  if (draft) {
    useTruth(draft, `Restored unsaved labels for ${id} from this browser.`);
    dirty = true;
    return;
  }
  try {
    const status = (await (await fetch(`/__fixtures/${id}/`)).json()) as { truth?: boolean };
    if (!status.truth) return;
    const parsed: unknown = await (await fetch(`/fixtures/${id}/truth.json`, { cache: 'no-store' })).json();
    const checked = validateTruth(parsed);
    if ('problems' in checked) setStatus(`fixtures/${id}/truth.json has problems: ${checked.problems.join('; ')}`, true);
    else useTruth(checked.truth, `Loaded fixtures/${id}/truth.json.`);
  } catch (err) {
    console.error(err);
  }
}

function useTruth(next: Truth, message: string) {
  truth = { ...next, clip: clipIdInput.value };
  history = [];
  const last = Math.max(...truth.roots.map((r) => r.frame), ...truth.facing.map((f) => f.frame), ...truth.still.map((s) => s[1]), 0);
  const warning = clip && last >= clip.frameCount ? ` They go up to frame ${last} but this clip ends at ${clip.frameCount - 1}: is it the same clip?` : '';
  setStatus(message + warning, warning !== '');
  paint();
}

// ---- Changing the labels ---------------------------------------------------

function change(next: Truth, note: string) {
  history.push(truth);
  if (history.length > 500) history.shift();
  truth = next;
  dirty = true;
  writeDraft();
  setStatus(note);
  paint();
}

// Marks go on the frame he can see. Right after a jump the next frame may
// still be decoding; a key pressed then would land on the old one.
function settled() {
  if (frame === targetFrame) return true;
  setStatus(`Frame ${targetFrame} is still loading: press again.`);
  return false;
}

function undo() {
  const previous = history.pop();
  if (!previous) return;
  truth = previous;
  dirty = true;
  writeDraft();
  setStatus('Undone.');
  paint();
}

function markRoot(e: PointerEvent) {
  if (!clip || !settled()) return;
  if (frame % ROOT_EVERY !== 0) {
    setStatus(`Roots go on every ${ROOT_EVERY}th frame. Press ] for the next one.`);
    return;
  }
  const box = view.getBoundingClientRect();
  const xy: [number, number] = [((e.clientX - box.left) / box.width) * clip.width, ((e.clientY - box.top) / box.height) * clip.height];
  change(setRoot(truth, frame, xy), `Root on frame ${frame}.`);
  stepMark(1);
}

function markFacing(label: Facing) {
  if (!settled()) return;
  if (frame % FACING_EVERY !== 0) {
    setStatus(`Facing goes on every ${FACING_EVERY}th frame. Switch to the Facing pass (2) and use [ ].`);
    return;
  }
  change(setFacing(truth, frame, label), `Frame ${frame}: ${label}.`);
  if (pass === 'facing') stepMark(1);
}

function clearHere() {
  if (pass === 'roots' && truth.roots.some((r) => r.frame === frame)) change(setRoot(truth, frame, null), `Cleared the root on frame ${frame}.`);
  else if (pass === 'facing' && truth.facing.some((f) => f.frame === frame)) change(setFacing(truth, frame, null), `Cleared the facing on frame ${frame}.`);
  else if (pass === 'still' && stillAt(truth, frame)) change(removeStillAt(truth, frame), 'Removed that still stretch.');
}

// Jumps to the previous or next frame this pass marks.
function stepMark(direction: 1 | -1) {
  if (!clip) return;
  const every = pass === 'roots' ? ROOT_EVERY : FACING_EVERY;
  const base = Math.floor(targetFrame / every) * every;
  const next = direction > 0 ? base + every : targetFrame > base ? base : base - every;
  if (next < 0 || next >= clip.frameCount) {
    if (direction > 0) setStatus(`That was the last ${pass === 'roots' ? 'root' : 'facing'} frame.`);
    return;
  }
  pause();
  seek(next);
}

function setPass(next: Pass) {
  pass = next;
  for (const input of document.querySelectorAll<HTMLInputElement>('input[name="pass"]')) input.checked = input.value === next;
  stillStart = null;
  hint.textContent = HINTS[next];
  paint();
}

// ---- Saving ----------------------------------------------------------------

async function save() {
  if (!clip || busy) return;
  const id = clipIdInput.value;
  if (!CLIP_ID.test(id)) {
    setStatus('Give the clip an id first, like side-step (lowercase words joined by hyphens).', true);
    clipIdInput.focus();
    return;
  }
  busy = true;
  updateControls();
  try {
    const status = (await (await fetch(`/__fixtures/${id}/`)).json()) as { listed: boolean; truth: boolean; clip: boolean; error?: string };
    if (status.error) throw new Error(status.error);
    if (!status.listed) {
      setStatus(`${id} isn't in fixtures/clips.json yet: add its entry (who's in it, their consent), then save again. Download truth.json keeps the labels meanwhile.`, true);
      return;
    }
    const overwrite = status.truth && confirm(`fixtures/${id}/truth.json already exists. Replace it with these labels?`);
    if (status.truth && !overwrite) {
      setStatus('Not saved.');
      return;
    }
    await post(`/__fixtures/${id}/truth.json`, serializeTruth({ ...truth, clip: id }), overwrite);
    let saved = `fixtures/${id}/truth.json`;
    if (!status.clip) {
      setStatus('Saving the converted clip…');
      await post(`/__fixtures/${id}/clip.mp4`, clip.file, false);
      saved += ` and clip.mp4 (the converted file these frames are from)`;
    }
    dirty = false;
    clearDraft(id);
    setStatus(`Saved ${saved}. ${summary()}. Commit truth.json yourself with [qai-approved].`);
  } catch (err) {
    console.error(err);
    setStatus(`Couldn't save: ${errorText(err)}. Download truth.json keeps the labels.`, true);
  } finally {
    busy = false;
    updateControls();
  }
}

async function post(url: string, body: BodyInit, overwrite: boolean) {
  const response = await fetch(url, { method: 'POST', body, headers: overwrite ? { 'x-overwrite': '1' } : {} });
  const result = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(result.error ?? `${response.status} ${response.statusText}`);
}

// Unsaved marks survive a reload in this browser, keyed by clip id.
const draftKey = (id: string) => `inkwell-label:${id}`;
function writeDraft() {
  try {
    if (CLIP_ID.test(clipIdInput.value)) localStorage.setItem(draftKey(clipIdInput.value), serializeTruth(truth));
  } catch {
    // private window or storage blocked: the page still works, just without the safety net
  }
  updateDownload();
}
function readDraft(id: string): Truth | null {
  try {
    const text = localStorage.getItem(draftKey(id));
    const checked = text ? validateTruth(JSON.parse(text)) : null;
    return checked && 'truth' in checked ? checked.truth : null;
  } catch {
    return null;
  }
}
function clearDraft(id: string) {
  try {
    localStorage.removeItem(draftKey(id));
  } catch {
    // nothing kept, nothing to clear
  }
}

function updateDownload() {
  URL.revokeObjectURL(downloadUrl);
  downloadUrl = URL.createObjectURL(new Blob([serializeTruth({ ...truth, clip: clipIdInput.value })], { type: 'application/json' }));
  downloadLink.href = downloadUrl;
}

// ---- Showing frames --------------------------------------------------------

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
      if (wrapped && !playing) showFrame(target, wrapped.canvas);
    }
  } finally {
    seeking = false;
  }
}

function showFrame(i: number, image: CanvasImageSource) {
  frame = i;
  frameCtx.drawImage(image, 0, 0, frameBuffer.width, frameBuffer.height);
  paint();
}

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
    if (i === from) break;
    from = 0;
  }
}

function pause() {
  if (!playing) return;
  playing = false;
  playToken++;
  playButton.textContent = 'Play';
}

// ---- Painting --------------------------------------------------------------

function paint() {
  if (!clip) return;
  ctx.setTransform(view.width / clip.width, 0, 0, view.height / clip.height, 0, 0);
  ctx.drawImage(frameBuffer, 0, 0);
  const px = clip.width / view.getBoundingClientRect().width || 1; // clip pixels per CSS pixel

  // The last root before this frame, faint, so he clicks the same body point.
  const before = [...truth.roots].reverse().find((r) => r.frame < frame);
  if (before) ring(before.xy, 12 * px, '#ffffffa0', `${before.frame}`, px);
  const here = truth.roots.find((r) => r.frame === frame);
  if (here) ring(here.xy, 12 * px, '#e8203a', 'root', px);

  // Facing: this frame's label, or the last one before it, dimmed.
  const facingHere = truth.facing.find((f) => f.frame === frame);
  const facingBefore = [...truth.facing].reverse().find((f) => f.frame < frame);
  const shown = facingHere ?? facingBefore;
  ctx.font = `600 ${22 * px}px system-ui, sans-serif`;
  ctx.textBaseline = 'top';
  if (shown) {
    ctx.globalAlpha = facingHere ? 1 : 0.5;
    label(shown.label.toUpperCase(), 12 * px, 12 * px, FACING_COLORS[shown.label], px);
    ctx.globalAlpha = 1;
  }
  if (stillAt(truth, frame)) label('STILL', 12 * px, 44 * px, '#d0d0d8', px);
  if (stillStart !== null) label(`still from ${stillStart}…`, 12 * px, 76 * px, '#d0d0d8', px);

  const needs = pass === 'roots' ? frame % ROOT_EVERY === 0 : pass === 'facing' ? frame % FACING_EVERY === 0 : false;
  frameLabel.value = `frame ${frame} · ${(frame / FPS).toFixed(2)} s${needs ? ' · mark this one' : ''}`;
  progress.value = summary();
  paintTimeline();
}

function ring(xy: [number, number], r: number, color: string, text: string, px: number) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 * px;
  ctx.beginPath();
  ctx.arc(xy[0], xy[1], r, 0, Math.PI * 2);
  ctx.moveTo(xy[0] - r * 1.6, xy[1]);
  ctx.lineTo(xy[0] - r * 0.4, xy[1]);
  ctx.moveTo(xy[0] + r * 0.4, xy[1]);
  ctx.lineTo(xy[0] + r * 1.6, xy[1]);
  ctx.stroke();
  ctx.font = `${12 * px}px system-ui, sans-serif`;
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = color;
  ctx.fillText(text, xy[0] + r, xy[1] - r);
}

function label(text: string, x: number, y: number, color: string, px: number) {
  const width = ctx.measureText(text).width;
  ctx.fillStyle = '#000000b0';
  ctx.fillRect(x - 6 * px, y - 4 * px, width + 12 * px, 30 * px);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

// Three lanes: roots (every 10th), facing (every 6th, colored by class) and
// still stretches, with the playhead across all three.
function paintTimeline() {
  if (!clip) return;
  const dpr = devicePixelRatio;
  const width = timeline.clientWidth;
  const height = timeline.clientHeight;
  if (timeline.width !== Math.round(width * dpr)) timeline.width = Math.round(width * dpr);
  if (timeline.height !== Math.round(height * dpr)) timeline.height = Math.round(height * dpr);
  tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  tctx.clearRect(0, 0, width, height);
  const lane = height / 3;
  const x = (f: number) => (f / clip!.frameCount) * width;
  const cell = Math.max(1, width / clip.frameCount);

  tctx.fillStyle = '#202026';
  tctx.fillRect(0, 0, width, height);
  const roots = new Set(truth.roots.map((r) => r.frame));
  for (const f of markFrames(clip.frameCount, ROOT_EVERY)) {
    tctx.fillStyle = roots.has(f) ? '#e8203a' : '#4a4a55';
    tctx.fillRect(x(f), 3, Math.max(2, cell), lane - 6);
  }
  const facing = new Map(truth.facing.map((f) => [f.frame, f.label]));
  for (const f of markFrames(clip.frameCount, FACING_EVERY)) {
    const value = facing.get(f);
    tctx.fillStyle = value ? FACING_COLORS[value] : '#4a4a55';
    tctx.fillRect(x(f), lane + 3, Math.max(2, cell * FACING_EVERY - 1), lane - 6);
  }
  tctx.fillStyle = '#c8c8d0';
  for (const [s, e] of truth.still) tctx.fillRect(x(s), 2 * lane + 3, x(e + 1) - x(s), lane - 6);
  if (drag?.lane === 'still') {
    const [a, b] = [Math.min(drag.from, drag.to), Math.max(drag.from, drag.to)];
    tctx.fillStyle = '#c8c8d080';
    tctx.fillRect(x(a), 2 * lane + 3, x(b + 1) - x(a), lane - 6);
  }
  tctx.fillStyle = '#ffffff';
  tctx.fillRect(x(frame) + cell / 2 - 1, 0, 2, height);
}

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
new ResizeObserver(paintTimeline).observe(timeline);

function summary() {
  if (!clip) return '';
  const roots = markFrames(clip.frameCount, ROOT_EVERY).filter((f) => truth.roots.some((r) => r.frame === f)).length;
  const facing = markFrames(clip.frameCount, FACING_EVERY).filter((f) => truth.facing.some((m) => m.frame === f)).length;
  const still = truth.still.length;
  return `roots ${roots}/${markFrames(clip.frameCount, ROOT_EVERY).length} · facing ${facing}/${markFrames(clip.frameCount, FACING_EVERY).length} · ${still} still stretch${still === 1 ? '' : 'es'}`;
}

function updateControls() {
  const ready = clip !== null && !busy;
  for (const button of [saveButton, playButton, prevButton, nextButton]) button.disabled = !ready;
  downloadLink.hidden = clip === null;
}

// ---- Input -----------------------------------------------------------------

view.addEventListener('pointerdown', (e) => {
  if (!clip || busy || pass !== 'roots') return;
  if (e.button === 0) markRoot(e);
  else if (e.button === 2 && truth.roots.some((r) => r.frame === frame)) change(setRoot(truth, frame, null), `Cleared the root on frame ${frame}.`);
});
view.addEventListener('contextmenu', (e) => e.preventDefault());

// The timeline: drag the bottom lane to add a still stretch (a click on one
// removes it); anywhere else, click or drag to scrub.
function timelineFrame(e: PointerEvent) {
  const box = timeline.getBoundingClientRect();
  return Math.min(clip!.frameCount - 1, Math.max(0, Math.floor(((e.clientX - box.left) / box.width) * clip!.frameCount)));
}
timeline.addEventListener('pointerdown', (e) => {
  if (!clip || busy) return;
  timeline.setPointerCapture(e.pointerId);
  const box = timeline.getBoundingClientRect();
  const f = timelineFrame(e);
  drag = { lane: e.clientY - box.top > (box.height * 2) / 3 ? 'still' : 'scrub', from: f, to: f };
  pause();
  if (drag.lane === 'scrub') seek(f);
  paintTimeline();
});
timeline.addEventListener('pointermove', (e) => {
  if (!drag || !clip) return;
  drag.to = timelineFrame(e);
  if (drag.lane === 'scrub') seek(drag.to);
  paintTimeline();
});
timeline.addEventListener('pointerup', () => {
  if (!drag) return;
  const { lane, from, to } = drag;
  drag = null;
  if (lane === 'still') {
    if (from !== to) change(addStill(truth, from, to), `Still from ${Math.min(from, to)} to ${Math.max(from, to)}.`);
    else if (stillAt(truth, from)) change(removeStillAt(truth, from), 'Removed that still stretch.');
    else seek(from);
  }
  paintTimeline();
});
timeline.addEventListener('pointercancel', () => {
  drag = null;
  paintTimeline();
});

document.addEventListener('keydown', (e) => {
  if (e.target === clipIdInput) return;
  const key = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && key === 's') {
    e.preventDefault();
    save();
    return;
  }
  if (!clip || busy) return;
  if ((e.ctrlKey || e.metaKey) && key === 'z') {
    e.preventDefault();
    undo();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target instanceof HTMLButtonElement && (e.code === 'Space' || e.key === 'Enter')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (playing) pause();
    else play();
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    pause();
    const step = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1);
    seek(Math.min(clip.frameCount - 1, Math.max(0, targetFrame + step)));
  } else if (e.key === '[' || e.key === ']') {
    stepMark(e.key === ']' ? 1 : -1);
  } else if (key in FACING_KEYS) {
    pause();
    markFacing(FACING_KEYS[key]);
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    clearHere();
  } else if (e.key === '1' || e.key === '2' || e.key === '3') {
    setPass((['roots', 'facing', 'still'] as const)[Number(e.key) - 1]);
  } else if (key === 's' && pass === 'still') {
    stillStart = frame;
    paint();
  } else if (key === 'e' && pass === 'still' && stillStart !== null) {
    change(addStill(truth, stillStart, frame), `Still from ${Math.min(stillStart, frame)} to ${Math.max(stillStart, frame)}.`);
    stillStart = null;
    paint();
  }
});

for (const input of document.querySelectorAll<HTMLInputElement>('input[name="pass"]')) {
  input.addEventListener('change', () => setPass(input.value as Pass));
}
playButton.addEventListener('click', () => (playing ? pause() : play()));
prevButton.addEventListener('click', () => stepMark(-1));
nextButton.addEventListener('click', () => stepMark(1));
saveButton.addEventListener('click', save);
clipIdInput.addEventListener('change', async () => {
  const id = clipIdInput.value;
  if (!CLIP_ID.test(id)) {
    setStatus('Clip ids are lowercase words joined by hyphens, like side-step.', true);
    return;
  }
  const empty = truth.roots.length + truth.facing.length + truth.still.length === 0;
  truth = { ...truth, clip: id };
  if (empty && clip) await loadExisting(id);
  else writeDraft();
  paint();
});
loadInput.addEventListener('change', async () => {
  const file = loadInput.files?.[0];
  loadInput.value = '';
  if (!file) return;
  try {
    const checked = validateTruth(JSON.parse(await file.text()));
    if ('problems' in checked) setStatus(`${file.name} has problems: ${checked.problems.join('; ')}`, true);
    else {
      useTruth(checked.truth, `Loaded ${file.name}.`);
      dirty = true;
      writeDraft();
    }
  } catch (err) {
    setStatus(`Couldn't read ${file.name}: ${errorText(err)}`, true);
  }
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
addEventListener('beforeunload', (e) => {
  if (dirty) e.preventDefault();
});

// Buttons and pass toggles give the keys back to the page after a click.
document.addEventListener('click', () => {
  setTimeout(() => {
    const focused = document.activeElement;
    if (focused instanceof HTMLButtonElement || (focused instanceof HTMLInputElement && focused.type === 'radio')) focused.blur();
  });
});

// ?clip=<url> opens a clip on load and ?id=<clip id> names it, e.g.
// /label?clip=/samples/side-step.mp4&id=side-step
const params = new URLSearchParams(location.search);
clipIdInput.value = params.get('id') ?? '';
setPass('roots');
const clipUrl = params.get('clip');
if (clipUrl) {
  setStatus('Fetching clip…');
  fetch(clipUrl)
    .then((response) => {
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response.blob();
    })
    .then((blob) => openClip(blob, clipUrl.split('/').pop() || 'clip.mp4'))
    .catch((err) => setStatus(`Couldn't fetch ${clipUrl}: ${errorText(err)}`, true));
}

function setStatus(text: string, error = false) {
  statusText.textContent = text;
  statusText.classList.toggle('error', error);
}
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
