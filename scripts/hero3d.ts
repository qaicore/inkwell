// EXPERIMENT (exp/hero-3d-lift): the hero electric kagune, squashed flat on
// the turn (samples/hero/hero.ts, today's stand-in for M3) next to the same
// four strokes lifted onto a 3D body stand-in (src/lift/). Frames 0–159 of
// the probe clip, cached SAM person masks only: no network, no paid calls.
// Writes hero3d-side-by-side.mp4 (squash left, 3D right), a contact sheet
// with a debug row (the stand-in torso, and each centreline point green in
// front of him, red behind) and timing.json.
// Usage: node scripts/hero3d.ts <clip.mp4> <outDir>
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createCanvas, loadImage, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import type { Effect, Vec2 } from '../src/types/effect.ts';
import { masksFromCache, toFrameMask } from '../src/sam/cache.ts';
import { trackPoses } from '../src/track/anchor.ts';
import { anchorTransform, toTorso, torsoHeights } from '../src/track/torso.ts';
import { frameMasks } from '../src/app/pipeline.ts';
import { animate } from '../src/motion/animate.ts';
import { resampleStroke } from '../src/render/brush.ts';
import { drawStrokes } from '../src/render/headless.ts';
import { bendFromHeight, bodyFrom, HEAD, upperHeight, project, toCamera, TORSO, turnAt, type Body3D, type Vec3 } from '../src/lift/body.ts';
import { animate3d, liftStroke, type Placed3D } from '../src/lift/lift.ts';

const [clip, outDir] = process.argv.slice(2);
if (!clip || !outDir) throw new Error('usage: node scripts/hero3d.ts <clip.mp4> <outDir>');
const CW = 1920, CH = 1080, OW = 960, OH = 540, S = OW / CW;
const FRAMES = 160;
const DRAWN = 30;
const ROOT: Vec2 = [826, 420];
const KEYS: Vec2[] = [[0, 0], [50, 0], [54, 90], [60, 180], [68, 270], [74, 360], [999, 360]];
const BOIL = { maxPx: 1.5, cycle: 3 };
const DPS = 12;
const BRUSH_SCALE = OW / 1080;

// ---- Frames and masks -----------------------------------------------------------------

const frameDir = 'samples/hero3d/frames'; // gitignored, reused between runs
if (!existsSync(frameDir) || readdirSync(frameDir).length < FRAMES) {
  mkdirSync(frameDir, { recursive: true });
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', clip, '-frames:v', String(FRAMES), '-vf', `scale=${OW}:${OH}`, `${frameDir}/%04d.png`]);
  if (r.status !== 0) throw new Error(String(r.stderr));
}
const person = await masksFromCache(JSON.parse(readFileSync('fixtures/probe/sam-person.json', 'utf8')), 254);
const units = torsoHeights(frameMasks(person, CW, CH), CW, CH);
const unit0 = units[DRAWN]!;
const tracked = trackPoses(person, { frame: DRAWN, xy: ROOT }, 30);
if (!tracked) throw new Error("no pose track from the root");
const poses = tracked;
const cutouts = person.map((p) => (p ? toFrameMask(p, CW, CH, 2) : null));

// ---- The four tendrils, drawn on frame DRAWN (as in samples/hero/hero.ts) ---------------

const curve = (n: number, f: (t: number) => Vec2) => Array.from({ length: n }, (_, i) => f(i / (n - 1)));
function tendril(end: Vec2, bend: number): Vec2[] {
  const [rx, ry] = ROOT;
  const nx = -(end[1] - ry), ny = end[0] - rx;
  const len = Math.hypot(nx, ny);
  return curve(40, (t) => {
    const b = bend * Math.sin(2 * Math.PI * t);
    return [rx + (end[0] - rx) * t + (nx / len) * b, ry + (end[1] - ry) * t + (ny / len) * b];
  });
}
const DRAWINGS = [tendril([500, 110], 60), tendril([1150, 110], -60), tendril([470, 660], -55), tendril([1180, 660], 55)];
const taper = (n: number) => Array.from({ length: n }, (_, i) => 1 - 0.65 * (i / (n - 1)));
const resampled = DRAWINGS.map((pts) => resampleStroke(pts.map((p, j) => [p[0], p[1], taper(pts.length)[j]])) as { points: Vec2[]; pressure: number[] });

const at = anchorTransform(poses[DRAWN], unit0);
const effect: Effect = {
  version: 1,
  brush: { size: 28, thinning: 0.65, smoothing: 0.6, streamline: 0.45 },
  palette: ['#e8203a', '#f4f1ea', '#16141a'],
  timing: { drawingsPerSecond: DPS },
  strokes: resampled.map(({ points, pressure }, i) => {
    const torso = points.map((p) => toTorso(at, p));
    return {
      id: i + 1, color: 0, brush: 'electric', kind: 'strand', anchor: { type: 'concept', prompt: 'back' }, bodyAngle: 180, stiffness: 0.1, wobble: 1,
      views: { front: { points: torso, pressure, root: torso[0], layer: 'behind' } },
    };
  }),
  overrides: {},
} as unknown as Effect;

// ---- A: today's squash (samples/hero/hero.ts, look a) ------------------------------------

let t0 = performance.now();
const flatFrames = animate({ effect, frames: FRAMES, anchor: (_id, f) => anchorTransform(poses[f], unit0), width: CW, boil: BOIL, fps: 30 });
const flatSimMs = (performance.now() - t0) / FRAMES;
function squashed(f: number) {
  const fr = flatFrames[f];
  const cos = Math.cos((turnAt(KEYS, f) * Math.PI) / 180);
  const pivot = poses[f].x;
  const layer = cos >= 0 ? 'behind' : 'front';
  const c = Math.abs(cos) < 0.08 ? Math.sign(cos || 1) * 0.08 : cos;
  return fr.placed.map((p) => ({ ...p, layer: layer as 'behind' | 'front', points: p.points.map(([x, y]): Vec2 => [(pivot + (x - pivot) * c) * S, y * S]) }));
}

// ---- B: the 3D lift ------------------------------------------------------------------------

t0 = performance.now();
const heights = person.slice(0, FRAMES).map((m, f) => (m ? upperHeight(m, poses[f], unit0) : null));
const still = heights.slice(0, 50).filter((h): h is number => h !== null).sort((x, y) => x - y);
const pitch = bendFromHeight(heights, still[still.length >> 1]);
const bodies: Body3D[] = poses.slice(0, FRAMES).map((p, f) => bodyFrom(p, unit0, turnAt(KEYS, f), pitch[f]));
const lifted = resampled.map(({ points, pressure }, i) => liftStroke(i + 1, points, pressure, bodies[DRAWN], 'strand', 0.1));
const frames3d = animate3d({ strokes: lifted, bodies, frames: FRAMES, dps: DPS, boil: BOIL, width: CW });
const liftSimMs = (performance.now() - t0) / FRAMES;

// ---- Drawing ------------------------------------------------------------------------------

const canvas = (w = OW, h = OH) => createCanvas(w, h);
const maskCanvas = canvas();
const maskCtx = maskCanvas.getContext('2d');
const personCanvas = canvas();
const personCtx = personCanvas.getContext('2d');
const layers = Array.from({ length: 4 }, () => ({ back: canvas(), front: canvas(), mask: canvas() }));

function cutout(ctx: SKRSContext2D, img: CanvasImageSourceLike, f: number) {
  const mask = cutouts[f];
  if (!mask) return;
  const md = maskCtx.createImageData(OW, OH);
  for (let i = 0; i < mask.alpha.length; i++) md.data[i * 4 + 3] = mask.alpha[i];
  maskCtx.putImageData(md, 0, 0);
  personCtx.globalCompositeOperation = 'copy';
  personCtx.drawImage(img as never, 0, 0);
  personCtx.globalCompositeOperation = 'destination-in';
  personCtx.drawImage(maskCanvas, 0, 0);
  personCtx.globalCompositeOperation = 'source-over';
  ctx.drawImage(personCanvas, 0, 0);
}
type CanvasImageSourceLike = Awaited<ReturnType<typeof loadImage>>;

// Squash: behind strokes, the cutout, front strokes (one layer for the whole drawing).
function drawFlat(ctx: SKRSContext2D, img: CanvasImageSourceLike, f: number) {
  const placed = squashed(f);
  ctx.drawImage(img, 0, 0);
  drawStrokes(ctx, placed, effect, BRUSH_SCALE, ['behind'], flatFrames[f].k);
  cutout(ctx, img, f);
  drawStrokes(ctx, placed, effect, BRUSH_SCALE, ['front'], flatFrames[f].k);
}

// 3D: a stroke wholly behind him goes under the cutout and one wholly in
// front over it, drawn straight onto the frame. A stroke that crosses him is
// drawn whole on its own layer, then cut along its length by a mask of its
// in-front points: the behind part under the cutout, the front part over it.
// Both parts come from one picture, so where he doesn't cover it there's no
// seam. Strokes go far to near.
const FRONT_MASK_PX = 70; // wide enough for the bolt's sideways reach and shards
function drawLifted(ctx: SKRSContext2D, img: CanvasImageSourceLike, f: number) {
  const fr = frames3d[f];
  const order = [...fr.placed].sort((a, b) => a.depth - b.depth);
  ctx.drawImage(img, 0, 0);
  const over: (Canvas | Placed3D)[] = [];
  const draw = (c: SKRSContext2D, p: Placed3D) =>
    drawStrokes(c, [{ id: p.id, points: p.points.map(([x, y]): Vec2 => [x * S, y * S]), pressure: p.pressure, layer: 'behind' }], effect, BRUSH_SCALE, ['behind'], fr.k);
  order.forEach((p, j) => {
    const nFront = p.front.filter(Boolean).length;
    if (nFront === 0) return draw(ctx, p);
    if (nFront === p.front.length) return void over.push(p);
    const L = layers[j];
    const bctx = L.back.getContext('2d');
    bctx.clearRect(0, 0, OW, OH);
    draw(bctx, p);
    frontMask(L.mask, p.points.map(([x, y]): Vec2 => [x * S, y * S]), p.front);
    const fctx = L.front.getContext('2d');
    fctx.globalCompositeOperation = 'copy';
    fctx.drawImage(L.back, 0, 0);
    fctx.globalCompositeOperation = 'destination-in';
    fctx.drawImage(L.mask, 0, 0);
    fctx.globalCompositeOperation = 'source-over';
    bctx.globalCompositeOperation = 'destination-out';
    bctx.drawImage(L.mask, 0, 0);
    bctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(L.back, 0, 0);
    over.push(L.front);
  });
  cutout(ctx, img, f);
  for (const o of over) {
    if ('points' in o) draw(ctx, o);
    else ctx.drawImage(o, 0, 0);
  }
}

function frontMask(c: Canvas, pts: Vec2[], front: boolean[]) {
  const m = c.getContext('2d');
  m.clearRect(0, 0, OW, OH);
  m.strokeStyle = '#fff';
  m.lineCap = 'round';
  m.lineWidth = FRONT_MASK_PX;
  m.beginPath();
  const mid = (a: Vec2, b: Vec2): Vec2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  for (let i = 0; i < pts.length; i++) {
    if (!front[i]) continue;
    const a = i > 0 ? mid(pts[i - 1], pts[i]) : pts[i];
    const b = i < pts.length - 1 ? mid(pts[i], pts[i + 1]) : pts[i];
    m.moveTo(a[0], a[1]);
    m.lineTo(pts[i][0], pts[i][1]);
    m.lineTo(b[0], b[1]);
  }
  m.stroke();
}

// Debug: the torso stand-in as three outlines, and the simulated centreline
// points colored by layer.
function drawDebug(ctx: SKRSContext2D, img: CanvasImageSourceLike, f: number) {
  ctx.drawImage(img, 0, 0);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(0, 0, OW, OH);
  const b = bodies[f];
  const ring = (fn: (a: number) => Vec3) => {
    ctx.beginPath();
    for (let i = 0; i <= 48; i++) {
      const { xy } = project(b, toCamera(b, fn((i / 48) * Math.PI * 2)));
      if (i === 0) ctx.moveTo(xy[0] * S, xy[1] * S);
      else ctx.lineTo(xy[0] * S, xy[1] * S);
    }
    ctx.stroke();
  };
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#7fd8ff';
  ring((a) => [TORSO.a * Math.cos(a), TORSO.cy + TORSO.b * Math.sin(a), 0]);
  ring((a) => [0, TORSO.cy + TORSO.b * Math.sin(a), TORSO.c * Math.cos(a)]);
  ring((a) => [TORSO.a * Math.cos(a), TORSO.cy, TORSO.c * Math.sin(a)]);
  ring((a) => [HEAD.r * Math.cos(a), HEAD.cy + HEAD.r * Math.sin(a), 0]);
  // His chest direction, so the turn reads.
  const c0 = project(b, toCamera(b, [0, TORSO.cy, 0])).xy;
  const c1 = project(b, toCamera(b, [0, TORSO.cy, 0.6])).xy;
  ctx.strokeStyle = '#ffe14d';
  ctx.beginPath();
  ctx.moveTo(c0[0] * S, c0[1] * S);
  ctx.lineTo(c1[0] * S, c1[1] * S);
  ctx.stroke();
  for (const p of frames3d[f].placed as Placed3D[]) {
    p.points.forEach(([x, y], i) => {
      ctx.fillStyle = p.front[i] ? '#3dff6e' : '#ff3d3d';
      ctx.fillRect(x * S - 2, y * S - 2, 4, 4);
    });
  }
}

function label(ctx: SKRSContext2D, text: string) {
  ctx.font = '20px sans-serif';
  const w = ctx.measureText(text).width + 16;
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(0, 0, w, 30);
  ctx.fillStyle = '#fff';
  ctx.fillText(text, 8, 22);
}

// ---- Render -----------------------------------------------------------------------------

mkdirSync(outDir, { recursive: true });
const out = `${outDir}/hero3d-side-by-side.mp4`;
const enc = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${OW * 2}x${OH}`, '-r', '30', '-i', '-', '-i', clip, '-map', '0:v', '-map', '1:a?', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-c:a', 'aac', out]);
let encErr = '';
enc.stderr.on('data', (d) => (encErr += d));

const SHEET_EVERY = 8;
const shots: { flat: Buffer; lifted: Buffer; debug: Buffer }[] = [];
const TURN = { from: 50, to: 76, every: 2 };
const turnShots: { flat: Buffer; lifted: Buffer; debug: Buffer }[] = [];
const both = canvas(OW * 2, OH);
const bctx = both.getContext('2d');
const a = canvas(), b = canvas(), d = canvas();
let flatMs = 0, liftMs = 0;
for (let f = 0; f < FRAMES; f++) {
  const img = await loadImage(`${frameDir}/${String(f + 1).padStart(4, '0')}.png`);
  const tag = `f${f} θ${Math.round(turnAt(KEYS, f))}° bend ${Math.round((bodies[f].pitch * 180) / Math.PI)}°`;
  let t = performance.now();
  drawFlat(a.getContext('2d'), img, f);
  flatMs += performance.now() - t;
  t = performance.now();
  drawLifted(b.getContext('2d'), img, f);
  liftMs += performance.now() - t;
  label(a.getContext('2d'), `now: squash · ${tag}`);
  label(b.getContext('2d'), `3D lift · ${tag}`);
  bctx.drawImage(a, 0, 0);
  bctx.drawImage(b, OW, 0);
  const rgba = bctx.getImageData(0, 0, OW * 2, OH).data;
  if (!enc.stdin.write(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength))) await new Promise((r) => enc.stdin.once('drain', r));
  const inTurn = f >= TURN.from && f <= TURN.to && (f - TURN.from) % TURN.every === 0;
  if (f % SHEET_EVERY === 0 || inTurn) {
    drawDebug(d.getContext('2d'), img, f);
    label(d.getContext('2d'), `debug · ${tag}`);
    const shot = { flat: a.toBuffer('image/png'), lifted: b.toBuffer('image/png'), debug: d.toBuffer('image/png') };
    if (f % SHEET_EVERY === 0) shots.push(shot);
    if (inTurn) turnShots.push(shot);
  }
}
enc.stdin.end();
await new Promise<void>((res, rej) => enc.on('close', (code) => (code === 0 ? res() : rej(new Error(encErr)))));
console.log('wrote', out);

// ---- Contact sheets: per band of 10 frames, rows squash / 3D / debug ----------------------

const CELL_W = 384, CELL_H = 216, LABEL = 28;
const rows = ['now: squash', '3D lift', 'debug: stand-in torso and head; points green = in front of him, red = behind'] as const;
async function contactSheet(list: typeof shots, what: string, file: string, PER_ROW: number) {
  const bands = Math.ceil(list.length / PER_ROW);
  const sheet = createCanvas(CELL_W * PER_ROW, bands * rows.length * (CELL_H + LABEL));
  const sc = sheet.getContext('2d');
  sc.fillStyle = '#fff';
  sc.fillRect(0, 0, sheet.width, sheet.height);
  sc.font = '20px sans-serif';
  for (let band = 0; band < bands; band++) {
    for (let r = 0; r < rows.length; r++) {
      const y = (band * rows.length + r) * (CELL_H + LABEL);
      sc.fillStyle = '#000';
      sc.fillText(`${rows[r]} (${what})`, 8, y + 21);
      for (let i = 0; i < PER_ROW; i++) {
        const shot = list[band * PER_ROW + i];
        if (!shot) break;
        const im = await loadImage([shot.flat, shot.lifted, shot.debug][r]);
        sc.drawImage(im, i * CELL_W, y + LABEL, CELL_W, CELL_H);
      }
    }
  }
  writeFileSync(`${outDir}/${file}`, sheet.toBuffer('image/png'));
}
await contactSheet(shots, `every ${SHEET_EVERY}th frame, 0–159`, 'hero3d-contact-sheet.png', 10);
await contactSheet(turnShots, `the spin, every ${TURN.every}nd frame, ${TURN.from}–${TURN.to}`, 'hero3d-turn-closeup.png', 7);

const timing = {
  note: 'ms per frame in Node (@napi-rs/canvas) on this Windows PC, 960×540 output, 4 electric tendrils',
  squash: { simulate: +flatSimMs.toFixed(2), draw: +(flatMs / FRAMES).toFixed(1) },
  lift3d: { simulate: +liftSimMs.toFixed(2), draw: +(liftMs / FRAMES).toFixed(1) },
};
writeFileSync(`${outDir}/timing.json`, JSON.stringify(timing, null, 2));
console.log(timing);
