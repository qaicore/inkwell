// The impact's layer stack (impact design §7), bottom to top:
//    1 plate: the video, graded        7 limbsBehind, with the far arcs
//    2 aura: the flame aura            8 person: the cutout, graded at 0.5
//    3 cracks                          9 limbsFront, with the near arcs
//    4 fire, and the cluster          10 fx: front FX and the dust veil, face-cut from j 9
//    5 dust: the band and wall, over  11 flash: the A5–6 flash, with its person-shaped hole
//      the cluster's base             12 glow: far by 'screen' and a tint, near by 'lighter'
//    6 floods
// The camera applies to all of it, on top of whatever transform the canvas
// already has (the preview's view). On a poster frame the poster replaces the
// whole stack and ignores the camera.
//
// Caching. A layer with a key draws once into a frame-sized offscreen canvas,
// which is read back once for the box its pixels fill; every frame after that
// draws only that box. Keyed layers always go through their bitmap, hit or
// miss, so a frame's pixels never depend on what the cache held. A keyed layer
// must draw on its own, source-over onto transparent pixels: a layer that
// blends with what's under it (the plate's grade, the glow) has key null and
// draws straight onto the frame. The cache keeps the last 6 bitmaps (design
// §10: at most 6 full-size layers).
//
// Layers with key null draw straight onto the frame, under the camera's
// transform. In Node, @napi-rs/canvas places the unbounded composite ops
// ('copy', 'source-in', 'source-out', 'destination-in', 'destination-atop')
// without the transform, so a layer that needs one draws into a canvas of its
// own and lays that down; the bounded ones ('source-over', 'lighter', the
// blend modes, 'destination-out') are fine.
//
// The face cut. When the frame has a face mask, the fx slot draws into its own
// canvas first, the face is cut out of that ('destination-out', with the mask
// at the frame's size, frameMask), and the rest goes on. A layer in fx that
// blends with the frame (anything but source-over) blends with the fx canvas
// instead.
import type { FrameLayers, LayerDraw, StackSlot } from '../impact/contracts.ts';
import type { Mask } from '../track/tracking.ts';
import type { BrushTarget, MakeScratch, Pixels, Scratch } from './glow.ts';

export const STACK_ORDER: readonly StackSlot[] = ['plate', 'aura', 'cracks', 'fire', 'dust', 'floods', 'limbsBehind', 'person', 'limbsFront', 'fx', 'flash', 'glow'];
export const CACHE_LAYERS = 6;
const BOX_PAD = 2; // px round a bitmap's content: a smoothed draw reads one past its edge

// ctx.setTransform's six numbers, as camera.ts has them: x' = a·x + c·y + e,
// y' = b·x + d·y + f. The camera maps frame px to frame px.
export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}
export const IDENTITY: Readonly<Affine> = Object.freeze({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

const isIdentity = (m: Affine) => m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0;

// The canvas calls the stack needs, past what BrushTarget has; the browser's
// canvas and @napi-rs/canvas both have them.
export interface StackTarget extends BrushTarget {
  save(): void;
  restore(): void;
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  clip(): void;
}

// A box in frame px: [x0, x1) × [y0, y1).
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Entry {
  scratch: Scratch;
  box: Box | null; // null: the layer drew nothing
}

// The stack's offscreen canvases for one frame size: the keyed layers'
// bitmaps (least recently used first) and the face cut's canvas.
export interface LayerCache {
  readonly make: MakeScratch;
  readonly width: number;
  readonly height: number;
  readonly capacity: number;
  readonly stats: { hits: number; misses: number };
  clear(): void;
}

interface CacheState extends LayerCache {
  entries: Map<string, Entry>;
  spare: Scratch[];
  fx: Scratch | null;
}

export function createLayerCache(make: MakeScratch, width: number, height: number, capacity = CACHE_LAYERS): LayerCache {
  const state: CacheState = {
    make,
    width,
    height,
    capacity: Math.max(1, Math.floor(capacity)),
    stats: { hits: 0, misses: 0 },
    entries: new Map(),
    spare: [],
    fx: null,
    clear() {
      for (const e of state.entries.values()) state.spare.push(e.scratch);
      state.entries.clear();
    },
  };
  return state;
}

// Draws one output frame's layers onto ctx: the poster alone when there is
// one, or else the 12 slots in order under the camera.
export function drawStack(ctx: BrushTarget, layers: FrameLayers, camera: Affine | null, cache: LayerCache) {
  const t = ctx as StackTarget;
  const state = cache as CacheState;
  if (layers.poster) {
    drawLayer(t, layers.poster, state);
    return;
  }
  t.save();
  if (camera && !isIdentity(camera)) t.transform(camera.a, camera.b, camera.c, camera.d, camera.e, camera.f);
  for (const slot of STACK_ORDER) {
    const list = layers.slots[slot];
    if (!list || list.length === 0) continue;
    if (slot === 'fx' && layers.faceCut) drawCut(t, list, layers.faceCut, state);
    else for (const layer of list) drawLayer(t, layer, state);
  }
  t.restore();
}

// One layer at frame px: a keyed one from its bitmap, any other straight on.
function drawLayer(ctx: StackTarget, layer: LayerDraw, cache: CacheState) {
  if (layer.key === null) {
    ctx.save();
    layer.draw(ctx);
    ctx.restore();
    return;
  }
  const { scratch, box } = bitmap(layer, cache);
  if (!box) return;
  const op = ctx.globalCompositeOperation;
  const alpha = ctx.globalAlpha;
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  ctx.drawImage(scratch.canvas as never, box.x0, box.y0, w, h, box.x0, box.y0, w, h);
  ctx.globalCompositeOperation = op;
  ctx.globalAlpha = alpha;
}

// A keyed layer's bitmap: from the cache, or drawn now into the least recently
// used one.
function bitmap(layer: LayerDraw, cache: CacheState): Entry {
  const key = layer.key!;
  const hit = cache.entries.get(key);
  if (hit) {
    cache.entries.delete(key);
    cache.entries.set(key, hit);
    cache.stats.hits++;
    return hit;
  }
  cache.stats.misses++;
  let scratch = cache.spare.pop();
  if (!scratch && cache.entries.size >= cache.capacity) {
    const [oldest, entry] = cache.entries.entries().next().value!;
    cache.entries.delete(oldest);
    scratch = entry.scratch;
  }
  scratch ??= cache.make(cache.width, cache.height);
  const c = scratch.ctx as StackTarget;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalCompositeOperation = 'source-over';
  c.globalAlpha = 1;
  c.clearRect(0, 0, cache.width, cache.height);
  c.save();
  layer.draw(c);
  c.restore();
  const entry: Entry = { scratch, box: contentBox(c.getImageData(0, 0, cache.width, cache.height), BOX_PAD) };
  cache.entries.set(key, entry);
  return entry;
}

// The fx slot with the face cut out of it.
function drawCut(ctx: StackTarget, list: LayerDraw[], face: Mask, cache: CacheState) {
  const { width, height } = cache;
  // Only the keyed layers' boxes are known; any other layer may draw anywhere.
  let area: Box | null = null;
  let whole = false;
  const bitmaps: (Entry | null)[] = [];
  for (const layer of list) {
    const e = layer.key === null ? null : bitmap(layer, cache);
    bitmaps.push(e);
    if (!e) whole = true;
    else if (e.box) area = area ? union(area, e.box) : { ...e.box };
  }
  if (whole) area = { x0: 0, y0: 0, x1: width, y1: height };
  if (!area) return;
  const w = area.x1 - area.x0;
  const h = area.y1 - area.y0;
  cache.fx ??= cache.make(width, height);
  const s = cache.fx.ctx as StackTarget;
  s.setTransform(1, 0, 0, 1, 0, 0);
  s.globalCompositeOperation = 'source-over';
  s.globalAlpha = 1;
  s.clearRect(0, 0, width, height);
  list.forEach((layer, i) => {
    const e = bitmaps[i];
    if (!e) drawLayer(s, layer, cache);
    else if (e.box) {
      const b = e.box;
      s.drawImage(e.scratch.canvas as never, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    }
  });
  // 'destination-out' leaves what the face's bitmap doesn't cover alone.
  const m = frameMask(cache.make, face, width, height);
  if (m) {
    const b = m.box;
    s.globalCompositeOperation = 'destination-out';
    s.drawImage(m.scratch.canvas as never, 0, 0, b.x1 - b.x0, b.y1 - b.y0, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    s.globalCompositeOperation = 'source-over';
  }
  const op = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(cache.fx.canvas as never, area.x0, area.y0, w, h, area.x0, area.y0, w, h);
  ctx.globalCompositeOperation = op;
}

// ---- Masks ------------------------------------------------------------------------------

const DECODED = 3; // masks kept decoded per canvas maker (design §10: the next 3 frames)
const UPSCALED = 6; // and at the frame's size: a person and a face mask a frame
const decoded = new WeakMap<MakeScratch, Map<Mask, Scratch>>();

// A mask as a bitmap at its own size: black, opaque where the mask is. Decoded
// once and kept for the last 3 masks, so a cutout or a face cut costs one
// drawImage. Call it ahead of the frame to keep the decode off it.
export function decodeMask(make: MakeScratch, mask: Mask): Scratch {
  let cache = decoded.get(make);
  if (!cache) decoded.set(make, (cache = new Map()));
  const hit = cache.get(mask);
  if (hit) {
    cache.delete(mask);
    cache.set(mask, hit);
    return hit;
  }
  let s: Scratch | undefined;
  if (cache.size >= DECODED) {
    const [oldest, old] = cache.entries().next().value!;
    cache.delete(oldest);
    if (old.canvas.width === mask.width && old.canvas.height === mask.height) s = old;
  }
  s ??= make(mask.width, mask.height);
  const ctx = s.ctx as BrushTarget & { createImageData(w: number, h: number): Pixels };
  const pixels = ctx.createImageData(mask.width, mask.height);
  const data = pixels.data;
  const alpha = mask.alpha;
  for (let i = 0; i < alpha.length; i++) data[i * 4 + 3] = alpha[i];
  ctx.putImageData(pixels, 0, 0);
  cache.set(mask, s);
  return s;
}

// A mask at the frame's size: decodeMask's bitmap upscaled once, smoothed
// ('high', as the cutout always drew it), over the mask's box only. Kept for
// the last 6 masks per canvas maker (the person and the face for the next 3
// frames). The cutout and the face cut then cost one 1:1 drawImage a frame
// instead of a ×4 resample. The bitmap holds only the box, at its (0, 0): a
// frame-sized canvas would cost a full-frame copy each time it's drawn after
// a change.
export interface FrameMask {
  scratch: Scratch; // at least the box's size; the box's pixels at (0, 0)
  box: Box; // frame px: where the mask has any alpha, padded for the smoothed upscale
}

type FrameMaskEntry = FrameMask & { width: number; height: number };
const upscaled = new WeakMap<MakeScratch, Map<Mask, FrameMaskEntry>>();

export function frameMask(make: MakeScratch, mask: Mask, width: number, height: number): FrameMask | null {
  const box = frameBox(mask, width, height);
  if (!box) return null;
  let cache = upscaled.get(make);
  if (!cache) upscaled.set(make, (cache = new Map()));
  const hit = cache.get(mask);
  if (hit) cache.delete(mask);
  if (hit && hit.width === width && hit.height === height) {
    cache.set(mask, hit);
    return hit;
  }
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  let s: Scratch | undefined;
  if (cache.size >= UPSCALED) {
    const [oldest, old] = cache.entries().next().value!;
    cache.delete(oldest);
    if (old.scratch.canvas.width >= w && old.scratch.canvas.height >= h) s = old.scratch;
  }
  s ??= make(w, h);
  const c = s.ctx as StackTarget & { imageSmoothingQuality?: string };
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalCompositeOperation = 'source-over';
  c.globalAlpha = 1;
  c.clearRect(0, 0, s.canvas.width, s.canvas.height);
  c.save();
  c.beginPath();
  c.rect(0, 0, w, h);
  c.clip();
  // A mask at the frame's own size is copied as it is: a cubic would blur it.
  c.imageSmoothingEnabled = mask.width !== width || mask.height !== height;
  c.imageSmoothingQuality = 'high';
  c.drawImage(decodeMask(make, mask).canvas as never, 0, 0, mask.width, mask.height, -box.x0, -box.y0, width, height);
  c.restore();
  const entry: FrameMaskEntry = { scratch: s, box, width, height };
  cache.set(mask, entry);
  return entry;
}

// The mask's box in frame px, padded for the smoothed upscale (a cubic reads
// two mask px past an edge), or null when the mask is empty.
export function frameBox(mask: Mask, width: number, height: number): Box | null {
  const b = maskBox(mask);
  if (!b) return null;
  const sx = width / mask.width;
  const sy = height / mask.height;
  const pad = 2 * Math.max(sx, sy) + 2;
  const x0 = Math.max(0, Math.floor(b.x0 * sx - pad));
  const y0 = Math.max(0, Math.floor(b.y0 * sy - pad));
  const x1 = Math.min(width, Math.ceil(b.x1 * sx + pad));
  const y1 = Math.min(height, Math.ceil(b.y1 * sy + pad));
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
}

const maskBoxes = new WeakMap<Mask, Box | null>();

// The box a mask's opaque pixels fill, in its own px, or null when it's empty.
export function maskBox(mask: Mask): Box | null {
  if (maskBoxes.has(mask)) return maskBoxes.get(mask)!;
  const { width: w, height: h, alpha } = mask;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      if (alpha[o + x] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  const box = x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
  maskBoxes.set(mask, box);
  return box;
}

// ---- Boxes ------------------------------------------------------------------------------

// The box of the pixels that aren't fully transparent, padded and clamped, or
// null when there are none.
export function contentBox(image: Pixels, pad = 0): Box | null {
  const { width: w, height: h, data } = image;
  const aligned = data.byteOffset % 4 === 0;
  const px = aligned ? new Uint32Array(data.buffer, data.byteOffset, w * h) : new Uint32Array(new Uint8Array(data).buffer);
  let y0 = 0;
  find: for (; y0 < h; y0++) {
    const o = y0 * w;
    for (let x = 0; x < w; x++) if (px[o + x] !== 0) break find;
  }
  if (y0 === h) return null;
  let y1 = h - 1;
  find: for (; y1 > y0; y1--) {
    const o = y1 * w;
    for (let x = 0; x < w; x++) if (px[o + x] !== 0) break find;
  }
  let x0 = w;
  let x1 = -1;
  for (let y = y0; y <= y1; y++) {
    const o = y * w;
    for (let x = 0; x < x0; x++) {
      if (px[o + x] !== 0) {
        x0 = x;
        break;
      }
    }
    for (let x = w - 1; x > x1; x--) {
      if (px[o + x] !== 0) {
        x1 = x;
        break;
      }
    }
  }
  return { x0: Math.max(0, x0 - pad), y0: Math.max(0, y0 - pad), x1: Math.min(w, x1 + 1 + pad), y1: Math.min(h, y1 + 1 + pad) };
}

export function union(a: Box, b: Box): Box {
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}
