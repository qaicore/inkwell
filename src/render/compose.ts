// Draws one finished frame at clip size. The preview and the export both
// draw through here, so they always match. Strokes set to "behind" go under
// the person: they're drawn on the frame first, then the person is cut out
// of the frame and laid back on top of them. The flame aura goes first of
// all, right on the video, so the cutout covers its inside.
//
// With a slam on the frame (scene.impact), the frame goes through the layer
// stack instead (stack.ts, design §7): the graded plate, the aura, the
// impact's own layers, the strokes with the limbs (behind ones in slot 7,
// the rest in slot 9), the person cut out at half the grade, the glow, all
// under the camera; or the poster alone.
//
// Pure: no DOM at load and nothing from ../app at run time. The canvases come
// from deps.make, and the strokes draw through deps.drawStroke.
import type { DrawnStroke } from '../app/engine.ts';
import type { FrameLayers, LayerDraw, StackSlot } from '../impact/contracts.ts';
import type { Mask } from '../track/tracking.ts';
import { drawFlameAura } from './aura.ts';
import type { BrushTarget, MakeScratch, Scratch } from './glow.ts';
import { applyGrade, isNeutral, PERSON_AMT, type Grade } from './grade.ts';
import { createLayerCache, decodeMask, drawStack, frameMask, type Affine, type LayerCache } from './stack.ts';

type Aura = { color: string; k: number; torsoPx: number };

// What to draw over the video on each frame.
export type Scene = {
  strokes(frame: number): DrawnStroke[]; // already animated and placed
  personMask(frame: number): Mask | null; // null when there's no tracking
  aura?(frame: number): Aura | null; // the flame aura (SPEC §8.6), torso height in clip px
  impact?(frame: number): ImpactFrame | null; // the slam on this frame; missing or null draws the frame as before
};

// The slam's part of one frame.
export interface ImpactFrame {
  layers: FrameLayers; // the impact's own slots, or its poster
  camera: Affine | null; // frame px to frame px (cameraAt); null: none
  grade: Grade | null; // the plate grade (gradeAt); null: none
}

// What the frame draws with: a canvas maker for its offscreen canvases, and
// the stroke renderer.
export interface ComposeDeps {
  make: MakeScratch;
  drawStroke(ctx: CanvasRenderingContext2D, stroke: DrawnStroke): void;
}

export function renderFrame(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  frame: number,
  width: number,
  height: number,
  scene: Scene,
  deps: ComposeDeps,
) {
  const impact = scene.impact?.(frame) ?? null;
  if (impact) {
    renderImpact(ctx, image, frame, width, height, scene, deps, impact);
    return;
  }
  ctx.drawImage(image, 0, 0, width, height);
  const aura = scene.aura?.(frame) ?? null;
  const strokes = scene.strokes(frame);
  const behind = strokes.filter((stroke) => stroke.layer === 'behind');
  const mask = behind.length > 0 || aura ? scene.personMask(frame) : null;
  if (aura && mask) drawAura(ctx as unknown as BrushTarget, deps.make, aura, mask, width);
  for (const stroke of behind) deps.drawStroke(ctx, stroke);
  if (mask) ctx.drawImage(cutOut(deps.make, image, mask, width, height), 0, 0, width, height);
  for (const stroke of strokes) {
    if (stroke.layer !== 'behind') deps.drawStroke(ctx, stroke);
  }
}

function drawAura(ctx: BrushTarget, make: MakeScratch, aura: Aura, mask: Mask, width: number) {
  const scale = width / mask.width;
  drawFlameAura(ctx, make, { mask: mask.alpha, width: mask.width, height: mask.height, color: aura.color, k: aura.k, torsoPx: aura.torsoPx / scale, scale });
}

// ---- The slam ---------------------------------------------------------------------------

function renderImpact(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  frame: number,
  width: number,
  height: number,
  scene: Scene,
  deps: ComposeDeps,
  impact: ImpactFrame,
) {
  const cache = cacheFor(deps.make, width, height);
  if (impact.layers.poster) {
    drawStack(ctx as unknown as BrushTarget, impact.layers, null, cache);
    return;
  }
  const aura = scene.aura?.(frame) ?? null;
  const strokes = scene.strokes(frame);
  const mask = scene.personMask(frame);
  const grade = impact.grade && !isNeutral(impact.grade) ? impact.grade : null;
  const own = impact.layers.slots;
  const slots: Partial<Record<StackSlot, LayerDraw[]>> = { ...own };
  // Ours go first in each slot, under the impact's own.
  const put = (slot: StackSlot, draw: (c: CanvasRenderingContext2D) => void) => {
    slots[slot] = [{ key: null, draw: (c) => draw(c as unknown as CanvasRenderingContext2D) }, ...(own[slot] ?? [])];
  };
  put('plate', (c) => {
    c.drawImage(image, 0, 0, width, height);
    if (grade) applyGrade(c as unknown as BrushTarget, grade, width, height);
  });
  if (aura && mask) put('aura', (c) => drawAura(c as unknown as BrushTarget, deps.make, aura, mask, width));
  const behind = strokes.filter((stroke) => stroke.layer === 'behind');
  const front = strokes.filter((stroke) => stroke.layer !== 'behind');
  if (behind.length > 0) put('limbsBehind', (c) => behind.forEach((stroke) => deps.drawStroke(c, stroke)));
  if (mask) put('person', (c) => drawPerson(c, deps.make, image, mask, width, height, grade));
  if (front.length > 0) put('limbsFront', (c) => front.forEach((stroke) => deps.drawStroke(c, stroke)));
  drawStack(ctx as unknown as BrushTarget, { ...impact.layers, slots }, impact.camera, cache);
}

// One layer cache per canvas maker, for the current frame size.
const caches = new WeakMap<MakeScratch, LayerCache>();
function cacheFor(make: MakeScratch, width: number, height: number): LayerCache {
  let cache = caches.get(make);
  if (!cache || cache.width !== width || cache.height !== height) caches.set(make, (cache = createLayerCache(make, width, height)));
  return cache;
}

// The person on the stack (slot 8): the frame graded at PERSON_AMT, cut out
// with the mask at the frame's size (frameMask, decoded ahead), over the
// mask's box only: a 'copy', the grade, one 1:1 'destination-in' and the
// draw. The person canvas holds only the box, at its (0, 0), so drawing it
// copies no more than the box.
export function drawPerson(ctx: CanvasRenderingContext2D, make: MakeScratch, image: CanvasImageSource, mask: Mask, width: number, height: number, grade: Grade | null) {
  const m = frameMask(make, mask, width, height);
  if (!m) return;
  const { x0, y0 } = m.box;
  const w = m.box.x1 - x0;
  const h = m.box.y1 - y0;
  const p = personBox(make, w, h);
  const c = p.ctx as unknown as CanvasRenderingContext2D;
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha = 1;
  c.globalCompositeOperation = 'source-over';
  c.clearRect(0, 0, w, h);
  c.beginPath();
  c.rect(0, 0, w, h);
  c.clip();
  // The frame onto the cleared box, 1:1 and unsmoothed: what 'copy' does.
  // No transform for this and the 'destination-in': @napi-rs/canvas places
  // those two ops' unbounded area without it.
  c.imageSmoothingEnabled = false;
  c.drawImage(image, -x0, -y0, width, height);
  if (grade) {
    c.save();
    c.translate(-x0, -y0); // the grade works in frame px
    applyGrade(p.ctx, grade, width, height, PERSON_AMT);
    c.restore();
  }
  c.globalCompositeOperation = 'destination-in';
  c.drawImage(m.scratch.canvas as CanvasImageSource, 0, 0, w, h, 0, 0, w, h);
  c.restore();
  ctx.drawImage(p.canvas as CanvasImageSource, 0, 0, w, h, x0, y0, w, h);
}

// The slam's person canvas per canvas maker, grown to the largest box yet.
const personBoxes = new WeakMap<MakeScratch, Scratch>();
function personBox(make: MakeScratch, w: number, h: number): Scratch {
  let s = personBoxes.get(make);
  if (!s || s.canvas.width < w || s.canvas.height < h) personBoxes.set(make, (s = make(Math.max(w, s?.canvas.width ?? 0), Math.max(h, s?.canvas.height ?? 0))));
  return s;
}

// ---- The cutout -------------------------------------------------------------------------

// The person canvas per canvas maker, at the frame's size.
const people = new WeakMap<MakeScratch, Scratch>();
function personCanvas(make: MakeScratch, width: number, height: number): Scratch {
  let s = people.get(make);
  if (!s || s.canvas.width !== width || s.canvas.height !== height) people.set(make, (s = make(width, height)));
  return s;
}

// The frame's pixels wherever the mask says person, clear everywhere else:
// one 'copy' of the frame, then one 'destination-in' of the mask, decoded
// ahead into a bitmap (decodeMask). Made fresh every time: the preview reuses
// one canvas for every frame, so there's nothing safe to cache it on.
function cutOut(make: MakeScratch, image: CanvasImageSource, mask: Mask, width: number, height: number): CanvasImageSource {
  const decoded = decodeMask(make, mask);
  const p = personCanvas(make, width, height);
  const c = p.ctx as unknown as CanvasRenderingContext2D;
  // The copy at the canvas's first-use smoothing every time: the mask's
  // 'high' would otherwise stick and filter the next frame's 1:1 copy.
  c.imageSmoothingQuality = 'low';
  c.globalCompositeOperation = 'copy';
  c.drawImage(image, 0, 0, width, height);
  c.globalCompositeOperation = 'destination-in';
  c.imageSmoothingQuality = 'high';
  c.drawImage(decoded.canvas as CanvasImageSource, 0, 0, width, height);
  c.globalCompositeOperation = 'source-over';
  return p.canvas as CanvasImageSource;
}

// ---- The tracking tint ------------------------------------------------------------------

let tintCanvases: { mask: HTMLCanvasElement; maskCtx: CanvasRenderingContext2D; tint: HTMLCanvasElement; tintCtx: CanvasRenderingContext2D } | null = null;
let paintedMask: Mask | null = null;

// Tints the person mask, to check the tracking by eye. Browser only: its
// canvases are made on the first call.
export function drawMaskTint(ctx: CanvasRenderingContext2D, mask: Mask, width: number, height: number) {
  if (!tintCanvases) {
    const m = document.createElement('canvas');
    const t = document.createElement('canvas');
    tintCanvases = { mask: m, maskCtx: m.getContext('2d')!, tint: t, tintCtx: t.getContext('2d')! };
  }
  const { mask: maskCanvas, maskCtx, tint, tintCtx } = tintCanvases;
  if (paintedMask !== mask) {
    if (maskCanvas.width !== mask.width || maskCanvas.height !== mask.height) {
      maskCanvas.width = mask.width;
      maskCanvas.height = mask.height;
    }
    const pixels = maskCtx.createImageData(mask.width, mask.height);
    for (let i = 0; i < mask.alpha.length; i++) pixels.data[i * 4 + 3] = mask.alpha[i];
    maskCtx.putImageData(pixels, 0, 0);
    paintedMask = mask;
  }
  tint.width = mask.width;
  tint.height = mask.height;
  tintCtx.drawImage(maskCanvas, 0, 0);
  tintCtx.globalCompositeOperation = 'source-in';
  tintCtx.fillStyle = '#38e1ff';
  tintCtx.fillRect(0, 0, mask.width, mask.height);
  tintCtx.globalCompositeOperation = 'source-over';
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.drawImage(tint, 0, 0, width, height);
  ctx.restore();
}
