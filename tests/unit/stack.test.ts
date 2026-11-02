// WP10: the layer stack and the frame compositor (impact design §7, §10):
// the slot order, the cache, the camera, the poster, the face cut, the masks;
// compose.ts loading in Node with nothing from ../app at run time, keeping
// its output exactly without an impact and routing through the stack with
// one; determinism; and the cutout and composite budgets at 1080×608.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCanvas, type Canvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import type { DrawnStroke } from '../../src/app/engine.ts';
import type { FrameLayers, LayerDraw, StackSlot } from '../../src/impact/contracts.ts';
import { drawFlameAura } from '../../src/render/aura.ts';
import { drawPerson, renderFrame, type ComposeDeps, type ImpactFrame, type Scene } from '../../src/render/compose.ts';
import type { BrushTarget, MakeScratch } from '../../src/render/glow.ts';
import { PERSON_AMT, applyGrade, gradeAt } from '../../src/render/grade.ts';
import { nodeScratch } from '../../src/render/headless.ts';
import { createGlow, glowLayer } from '../../src/render/light.ts';
import { CACHE_LAYERS, STACK_ORDER, contentBox, createLayerCache, decodeMask, drawStack, frameBox, frameMask, maskBox, type Affine } from '../../src/render/stack.ts';
import type { Mask } from '../../src/track/tracking.ts';

const REPO = resolve(import.meta.dirname, '../..');
type Ctx = CanvasRenderingContext2D;

const fill = (w: number, h: number, color: string): Canvas => {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  return c;
};
// A busy video frame: every channel varies, so a misplaced copy shows.
const video = (w: number, h: number): Canvas => {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const x = i % w;
    const y = (i / w) | 0;
    img.data[4 * i] = (x * 7 + y * 3) % 256;
    img.data[4 * i + 1] = (x * 3 + y * 11) % 256;
    img.data[4 * i + 2] = (x * 13 + y * 5) % 256;
    img.data[4 * i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
};
const pixels = (c: Canvas) => c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
const hash = (c: Canvas) => createHash('sha256').update(pixels(c)).digest('hex');
const at = (c: Canvas, x: number, y: number) => Array.from(c.getContext('2d').getImageData(x, y, 1, 1).data.slice(0, 3));
const rgbOf = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const brush = (c: Canvas) => c.getContext('2d') as unknown as BrushTarget;

// A quarter-size mask with one opaque rectangle, in mask px.
function rectMask(w: number, h: number, [x0, y0, x1, y1]: [number, number, number, number]): Mask {
  const alpha = new Uint8ClampedArray(w * h);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) alpha[y * w + x] = 255;
  return { width: w, height: h, alpha } as Mask;
}
// An upright ellipse at quarter size; by default the size of a person on the hero clip.
function personMask(w = 270, h = 152, cx = 135, cy = 80, rx = 30, ry = 70): Mask {
  const alpha = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      if (dx * dx + dy * dy < 1) alpha[y * w + x] = 255;
    }
  }
  return { width: w, height: h, alpha } as Mask;
}

// A layer that fills a rectangle, keyed or not; `log` records each draw.
const rectLayer = (key: string | null, color: string, [x, y, w, h]: [number, number, number, number], log?: string[], name = key ?? color): LayerDraw => ({
  key,
  draw(ctx) {
    log?.push(name);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  },
});
const frameLayers = (slots: FrameLayers['slots'], extra: Partial<FrameLayers> = {}): FrameLayers => ({ o: 0, clip: 0, j: 20, poster: null, slots, faceCut: null, ...extra });

// The stroke renderer, as a test double: a filled polygon in the stroke's colour.
const drawStroke = (ctx: Ctx, s: DrawnStroke) => {
  ctx.fillStyle = s.color;
  ctx.beginPath();
  ctx.moveTo(s.points[0][0], s.points[0][1]);
  for (const [x, y] of s.points.slice(1)) ctx.lineTo(x, y);
  ctx.closePath();
  ctx.fill();
};
const stroke = (id: number, layer: 'front' | 'behind', color: string, [x0, y0, x1, y1]: [number, number, number, number]): DrawnStroke =>
  ({
    id,
    points: [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ],
    pressure: [1, 1, 1, 1],
    layer,
    color,
    brush: 'ink',
  }) as DrawnStroke;
const deps = (make: MakeScratch = nodeScratch): ComposeDeps => ({ make, drawStroke });
const freshMaker = (): MakeScratch => (w, h) => nodeScratch(w, h); // its own caches

describe('the stack (design §7)', () => {
  it('has the 13 slots, bottom to top: the masses right over the limbs in front, under the thin fx', () => {
    expect(STACK_ORDER).toEqual(['plate', 'aura', 'cracks', 'fire', 'dust', 'floods', 'limbsBehind', 'person', 'limbsFront', 'masses', 'fx', 'flash', 'glow']);
    expect(STACK_ORDER.indexOf('masses')).toBe(STACK_ORDER.indexOf('limbsFront') + 1);
    expect(STACK_ORDER.indexOf('dust')).toBe(STACK_ORDER.indexOf('fire') + 1);
  });

  it('draws the slots in that order, whatever order they are given in, and each slot in its own order', () => {
    const log: string[] = [];
    const slots: Partial<Record<StackSlot, LayerDraw[]>> = {};
    for (const slot of [...STACK_ORDER].reverse()) slots[slot] = [rectLayer(null, '#102030', [0, 0, 1, 1], log, slot)];
    slots.fx = [rectLayer(null, '#000000', [0, 0, 1, 1], log, 'fx a'), rectLayer('fx b', '#000000', [0, 0, 1, 1], log, 'fx b')];
    drawStack(brush(fill(32, 18, '#000000')), frameLayers(slots), null, createLayerCache(nodeScratch, 32, 18));
    expect(log).toEqual([...STACK_ORDER.slice(0, 10), 'fx a', 'fx b', 'flash', 'glow']);
  });

  it('lays the dust over the cluster, and both under the person', () => {
    const [w, h] = [320, 180];
    const canvas = fill(w, h, '#000000');
    const slots = {
      fire: [rectLayer('cluster', '#c03010', [100, 100, 120, 60])],
      dust: [rectLayer('dust', '#8a8070', [160, 130, 120, 40])],
    };
    const image = video(w, h);
    const mask = rectMask(80, 45, [20, 20, 40, 45]); // frame x 80..160, y 80..180
    const scene: Scene = { strokes: () => [], personMask: () => mask, impact: () => ({ layers: frameLayers(slots), camera: null, grade: null }) };
    renderFrame(canvas.getContext('2d') as unknown as Ctx, image as never, 0, w, h, scene, deps());
    expect(at(canvas, 200, 150)).toEqual(rgbOf('#8a8070')); // dust over cluster
    expect(at(canvas, 200, 110)).toEqual(rgbOf('#c03010')); // cluster alone
    expect(at(canvas, 120, 120)).toEqual(at(image, 120, 120)); // the person over the cluster
  });

  it('caches a keyed layer: one draw, the same pixels from the bitmap; the last 6 kept', () => {
    const [w, h] = [160, 90];
    const cache = createLayerCache(nodeScratch, w, h);
    const log: string[] = [];
    const layer = rectLayer('limbs 12', '#e8203a', [20, 10, 40, 30], log);
    const frames = [0, 1, 2].map(() => {
      const c = fill(w, h, '#203040');
      drawStack(brush(c), frameLayers({ limbsBehind: [layer] }), null, cache);
      return hash(c);
    });
    expect(log).toEqual(['limbs 12']);
    expect(cache.stats).toEqual({ hits: 2, misses: 1 });
    expect(new Set(frames).size).toBe(1);
    const straight = fill(w, h, '#203040');
    drawStack(brush(straight), frameLayers({ limbsBehind: [rectLayer(null, '#e8203a', [20, 10, 40, 30])] }), null, createLayerCache(nodeScratch, w, h));
    expect(hash(straight)).toBe(frames[0]); // the bitmap draws what the layer draws
    // Six more keys push the first one out; it draws again on its next use.
    for (let i = 0; i < CACHE_LAYERS; i++) drawStack(brush(fill(w, h, '#000000')), frameLayers({ fire: [rectLayer(`mass ${i}`, '#ff8000', [i, 0, 10, 10], log)] }), null, cache);
    drawStack(brush(fill(w, h, '#000000')), frameLayers({ limbsBehind: [layer] }), null, cache);
    expect(log.filter((x) => x === 'limbs 12')).toHaveLength(2);
    // A keyed layer that draws nothing leaves the frame alone.
    const before = fill(w, h, '#203040');
    drawStack(brush(before), frameLayers({ cracks: [{ key: 'empty', draw: () => {} }] }), null, cache);
    expect(hash(before)).toBe(hash(fill(w, h, '#203040')));
  });

  it('applies the camera to the scene, on top of the canvas transform; a poster ignores it', () => {
    const [w, h] = [200, 120];
    const camera: Affine = { a: 1, b: 0, c: 0, d: 1, e: 12, f: 7 };
    const dot = rectLayer('dot', '#ffffff', [100, 60, 4, 4]);
    const shifted = fill(w, h, '#000000');
    drawStack(brush(shifted), frameLayers({ fx: [dot], glow: [{ ...dot, key: null }] }), camera, createLayerCache(nodeScratch, w, h));
    expect(at(shifted, 113, 68)).toEqual([255, 255, 255]);
    expect(at(shifted, 101, 61)).toEqual([0, 0, 0]);
    const view = fill(w, h, '#000000');
    const ctx = view.getContext('2d');
    ctx.setTransform(0.5, 0, 0, 0.5, 0, 0); // the preview's view
    drawStack(brush(view), frameLayers({ fx: [dot] }), camera, createLayerCache(nodeScratch, w, h));
    expect(at(view, 57, 34)).toEqual([255, 255, 255]); // the dot's (102, 61) moved by (12, 7), then halved
    // The poster alone, unmoved, whatever the slots hold.
    const poster = fill(w, h, '#000000');
    drawStack(brush(poster), frameLayers({ fx: [dot] }, { poster: rectLayer(null, '#fefcd6', [50, 50, 4, 4]) }), camera, createLayerCache(nodeScratch, w, h));
    expect(at(poster, 51, 51)).toEqual(rgbOf('#fefcd6'));
    expect(at(poster, 113, 68)).toEqual([0, 0, 0]);
  });

  it('cuts the face out of the fx slot, and only out of it', () => {
    const [w, h] = [160, 90];
    const face = rectMask(40, 22, [10, 5, 20, 12]); // frame x 40..80, y 20..48
    const layers = (cut: Mask | null) =>
      frameLayers({ plate: [rectLayer(null, '#203040', [0, 0, w, h])], fx: [rectLayer('veil', '#80c040', [0, 0, w, h]), rectLayer(null, '#ff00ff', [0, 80, w, 10])], glow: [rectLayer(null, '#ffffff', [0, 0, 8, 8])] }, { faceCut: cut });
    const cut = fill(w, h, '#000000');
    drawStack(brush(cut), layers(face), null, createLayerCache(nodeScratch, w, h));
    expect(at(cut, 60, 34)).toEqual(rgbOf('#203040')); // the face: the plate shows
    expect(at(cut, 120, 34)).toEqual(rgbOf('#80c040')); // elsewhere: the veil
    expect(at(cut, 60, 85)).toEqual(rgbOf('#ff00ff')); // an unkeyed fx layer goes through the cut canvas too
    expect(at(cut, 2, 2)).toEqual([255, 255, 255]); // the glow slot isn't cut
    const whole = fill(w, h, '#000000');
    drawStack(brush(whole), layers(null), null, createLayerCache(nodeScratch, w, h));
    expect(at(whole, 60, 34)).toEqual(rgbOf('#80c040'));
  });

  it('never cuts the masses: the smoke over his face stays whole, under the thin fx that are cut', () => {
    const [w, h] = [160, 90];
    const face = rectMask(40, 22, [10, 5, 20, 12]); // frame x 40..80, y 20..48
    const layers = frameLayers(
      { plate: [rectLayer(null, '#203040', [0, 0, w, h])], masses: [rectLayer('cluster', '#642c13', [0, 0, w, 60])], fx: [rectLayer('sparks', '#ffdf3e', [0, 30, w, 10])] },
      { faceCut: face },
    );
    const c = fill(w, h, '#000000');
    drawStack(brush(c), layers, null, createLayerCache(nodeScratch, w, h));
    expect(at(c, 60, 25)).toEqual(rgbOf('#642c13')); // the face, under the smoke: no hole
    expect(at(c, 60, 35)).toEqual(rgbOf('#642c13')); // the sparks are cut there ...
    expect(at(c, 120, 35)).toEqual(rgbOf('#ffdf3e')); // ... and nowhere else
    expect(at(c, 60, 70)).toEqual(rgbOf('#203040'));
  });
});

describe('masks and boxes', () => {
  it('finds a mask’s box, and pads it at the frame’s size for the smoothed upscale', () => {
    const m = rectMask(40, 30, [10, 5, 20, 9]);
    expect(maskBox(m)).toEqual({ x0: 10, y0: 5, x1: 20, y1: 9 });
    expect(maskBox(rectMask(8, 8, [0, 0, 0, 0]))).toBeNull();
    // ×4, padded by 2 mask px + 2: 10 px each way.
    expect(frameBox(m, 160, 120)).toEqual({ x0: 30, y0: 10, x1: 90, y1: 46 });
    expect(frameBox(rectMask(40, 30, [0, 0, 40, 30]), 160, 120)).toEqual({ x0: 0, y0: 0, x1: 160, y1: 120 });
  });

  it('decodes a mask once and keeps the last 3', () => {
    const masks = [0, 1, 2, 3].map((i) => rectMask(16, 9, [i, 0, i + 4, 9]));
    const first = decodeMask(nodeScratch, masks[0]);
    expect(decodeMask(nodeScratch, masks[0])).toBe(first);
    const alpha = (m: Mask) => Array.from(decodeMask(nodeScratch, m).ctx.getImageData(0, 0, 16, 9).data.filter((_, i) => i % 4 === 3));
    expect(alpha(masks[0])).toEqual(Array.from(masks[0].alpha));
    for (const m of masks.slice(1)) decodeMask(nodeScratch, m);
    expect(alpha(masks[0])).toEqual(Array.from(masks[0].alpha)); // re-decoded, the same
    expect(alpha(masks[3])).toEqual(Array.from(masks[3].alpha));
  });

  it('upscales a mask to the frame once: the same alpha as the cutout’s own smoothed ×4, over its box', () => {
    const [w, h] = [320, 180];
    const m = personMask(80, 45, 40, 22, 9, 20);
    const fm = frameMask(nodeScratch, m, w, h)!;
    expect(frameMask(nodeScratch, m, w, h)).toBe(fm);
    expect(fm.box).toEqual(frameBox(m, w, h));
    const direct = createCanvas(w, h);
    const d = direct.getContext('2d');
    d.imageSmoothingQuality = 'high';
    d.drawImage(decodeMask(nodeScratch, m).canvas as never, 0, 0, w, h);
    const want = d.getImageData(0, 0, w, h).data;
    const { x0, y0, x1, y1 } = fm.box;
    const got = fm.scratch.ctx.getImageData(0, 0, x1 - x0, y1 - y0).data;
    let worst = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) worst = Math.max(worst, Math.abs(got[((y - y0) * (x1 - x0) + (x - x0)) * 4 + 3] - want[(y * w + x) * 4 + 3]));
    expect(worst).toBeLessThanOrEqual(1);
    // Nothing outside the box.
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < x0 || x >= x1 || y < y0 || y >= y1) expect(want[(y * w + x) * 4 + 3]).toBe(0);
  });

  it('finds the box of the pixels that aren’t clear', () => {
    const w = 20;
    const h = 10;
    const data = new Uint8ClampedArray(w * h * 4);
    expect(contentBox({ data, width: w, height: h })).toBeNull();
    data[(3 * w + 5) * 4 + 3] = 1;
    data[(7 * w + 12) * 4] = 9; // colour with no alpha counts too: it isn't clear
    expect(contentBox({ data, width: w, height: h })).toEqual({ x0: 5, y0: 3, x1: 13, y1: 8 });
    expect(contentBox({ data, width: w, height: h }, 2)).toEqual({ x0: 3, y0: 1, x1: 15, y1: 10 });
  });
});

// HEAD's renderFrame (before WP10), on Node canvases: what compose.ts must
// still draw, exactly, when there is no impact.
function headRenderFrame(ctx: Ctx, image: Canvas, frame: number, width: number, height: number, scene: Scene) {
  ctx.drawImage(image as never, 0, 0, width, height);
  const aura = scene.aura?.(frame) ?? null;
  const strokes = scene.strokes(frame);
  const behind = strokes.filter((s) => s.layer === 'behind');
  const mask = behind.length > 0 || aura ? scene.personMask(frame) : null;
  if (aura && mask) {
    const scale = width / mask.width;
    drawFlameAura(ctx as unknown as BrushTarget, nodeScratch, { mask: mask.alpha, width: mask.width, height: mask.height, color: aura.color, k: aura.k, torsoPx: aura.torsoPx / scale, scale });
  }
  for (const s of behind) drawStroke(ctx, s);
  if (mask) {
    const maskCanvas = createCanvas(mask.width, mask.height);
    const mctx = maskCanvas.getContext('2d');
    const px = mctx.createImageData(mask.width, mask.height);
    for (let i = 0; i < mask.alpha.length; i++) px.data[i * 4 + 3] = mask.alpha[i];
    mctx.putImageData(px, 0, 0);
    const person = createCanvas(width, height);
    const p = person.getContext('2d');
    p.globalCompositeOperation = 'copy';
    p.drawImage(image, 0, 0, width, height);
    p.globalCompositeOperation = 'destination-in';
    p.imageSmoothingQuality = 'high';
    p.drawImage(maskCanvas, 0, 0, width, height);
    p.globalCompositeOperation = 'source-over';
    ctx.drawImage(person as never, 0, 0, width, height);
  }
  for (const s of strokes) if (s.layer !== 'behind') drawStroke(ctx, s);
}

describe('compose.ts', () => {
  it('loads in Node with no DOM and imports nothing from ../app at run time', () => {
    expect(typeof document).toBe('undefined');
    // The module graph compose.ts loads at run time: no file under src/app.
    const runtime = (file: string): string[] =>
      [...readFileSync(file, 'utf8').matchAll(/^import\s+(?!type\b)[^;]*?from\s+'(\.[^']+)'/gm)].map((m) => {
        const p = resolve(dirname(file), m[1]);
        return existsSync(p) ? p : `${p}.ts`;
      });
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const dep of runtime(file)) walk(dep);
    };
    walk(resolve(REPO, 'src/render/compose.ts'));
    expect(seen.size).toBeGreaterThan(3);
    const app = [...seen].filter((f) => f.replaceAll('\\', '/').includes('/src/app/'));
    expect(app).toEqual([]);
    // And plain Node (no vite, no DOM) can import it.
    const url = pathToFileURL(resolve(REPO, 'src/render/compose.ts')).href;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(url)}); if (typeof m.renderFrame !== 'function') process.exit(2);`], { cwd: REPO, encoding: 'utf8' });
    expect(run.stderr).not.toMatch(/Error/);
    expect(run.status).toBe(0);
  });

  const [w, h] = [320, 180];
  const image = video(w, h);
  const mask = personMask(80, 45, 40, 22, 9, 20); // frame x 124..196, y 8..168
  const strokes = [stroke(1, 'behind', '#e8203a', [110, 20, 210, 90]), stroke(2, 'front', '#f4f1ea', [150, 100, 260, 130]), stroke(3, 'behind', '#2542fc', [20, 120, 90, 170])];
  const scenes: [string, Scene][] = [
    ['no strokes', { strokes: () => [], personMask: () => mask }],
    ['front strokes only', { strokes: () => strokes.filter((s) => s.layer === 'front'), personMask: () => mask }],
    ['behind and front strokes with the cutout', { strokes: () => strokes, personMask: () => mask }],
    ['the flame aura and the cutout', { strokes: () => strokes, personMask: () => mask, aura: () => ({ color: '#ff6a00', k: 3, torsoPx: 60 }) }],
    ['no tracking', { strokes: () => strokes, personMask: () => null }],
    ['an impact that is null on this frame', { strokes: () => strokes, personMask: () => mask, impact: () => null }],
  ];
  for (const [name, scene] of scenes) {
    it(`draws exactly what it drew before WP10 without an impact: ${name}`, () => {
      const got = fill(w, h, '#000000');
      const want = fill(w, h, '#000000');
      renderFrame(got.getContext('2d') as unknown as Ctx, image as never, 4, w, h, scene, deps());
      headRenderFrame(want.getContext('2d') as unknown as Ctx, image, 4, w, h, scene);
      expect(Buffer.from(pixels(got)).equals(Buffer.from(pixels(want)))).toBe(true);
    });
  }

  it('routes a slam through the stack: its slots, our strokes first in theirs, the person over slot 7', () => {
    const log: string[] = [];
    const impact: ImpactFrame = {
      layers: frameLayers({ limbsBehind: [rectLayer('limb behind', '#00ff00', [0, 0, w, 20], log)], limbsFront: [rectLayer('limb front', '#0000ff', [0, 160, w, 20], log)] }),
      camera: null,
      grade: null,
    };
    const scene: Scene = { strokes: () => strokes, personMask: () => mask, impact: () => impact };
    const canvas = fill(w, h, '#000000');
    const d: ComposeDeps = {
      make: nodeScratch,
      drawStroke: (ctx, s) => {
        log.push(`stroke ${s.id}`);
        drawStroke(ctx, s);
      },
    };
    renderFrame(canvas.getContext('2d') as unknown as Ctx, image as never, 0, w, h, scene, d);
    expect(log).toEqual(['stroke 1', 'stroke 3', 'limb behind', 'stroke 2', 'limb front']);
    expect(at(canvas, 160, 40)).toEqual(at(image, 160, 40)); // the person over behind stroke 1
    expect(at(canvas, 120, 25)).toEqual(rgbOf('#e8203a')); // stroke 1 off the person
    expect(at(canvas, 160, 115)).toEqual(rgbOf('#f4f1ea')); // front stroke 2 over the person
    expect(at(canvas, 40, 150)).toEqual(rgbOf('#2542fc'));
    expect(at(canvas, 300, 170)).toEqual(rgbOf('#0000ff'));
  });

  it('grades the person at half strength: the half grade’s own pixels, inside the mask', () => {
    const ictx = { jEnd: 45, frame: { P: [200, 150] as [number, number], u: [0, 1] as [number, number], v: [1, 0] as [number, number], S: h, U: 0.85 * h, sigma: 0.85, h: 1 as const }, palette: ['#e8203a', '#f4f1ea', '#1a1a1a'] as [string, string, string] };
    const grade = gradeAt(31, ictx); // g8: the 'color' fill, the pool and the white balance
    const canvas = fill(w, h, '#000000');
    drawPerson(canvas.getContext('2d') as unknown as Ctx, nodeScratch, image as never, mask, w, h, grade);
    const want = fill(w, h, '#000000');
    want.getContext('2d').drawImage(image, 0, 0);
    applyGrade(brush(want), grade, w, h, PERSON_AMT);
    for (const [x, y] of [
      [160, 88],
      [150, 30],
      [175, 150],
      [140, 100],
    ] as const) {
      expect(at(canvas, x, y), `(${x}, ${y})`).toEqual(at(want, x, y));
    }
    expect(at(canvas, 100, 88)).toEqual([0, 0, 0]); // off the person: nothing
  });

  it('draws the poster alone on a poster frame', () => {
    const impact: ImpactFrame = { layers: frameLayers({ fx: [rectLayer(null, '#ff0000', [0, 0, w, h])] }, { poster: rectLayer('poster 3', '#101010', [0, 0, w, h]) }), camera: { a: 1, b: 0, c: 0, d: 1, e: 30, f: 0 }, grade: gradeAt(5, { jEnd: 45, frame: { P: [160, 150], u: [0, 1], v: [1, 0], S: h, U: 0.85 * h, sigma: 0.85, h: 1 }, palette: ['#e8203a', '#f4f1ea', '#1a1a1a'] }) };
    const canvas = fill(w, h, '#000000');
    renderFrame(canvas.getContext('2d') as unknown as Ctx, image as never, 0, w, h, { strokes: () => strokes, personMask: () => mask, impact: () => impact }, deps());
    expect(hash(canvas)).toBe(hash(fill(w, h, '#101010')));
  });

  it('hashes the same twice, with a fresh cache or a warm one', () => {
    const ictx = { jEnd: 45, frame: { P: [200, 150] as [number, number], u: [0, 1] as [number, number], v: [1, 0] as [number, number], S: h, U: 0.85 * h, sigma: 0.85, h: 1 as const }, palette: ['#e8203a', '#f4f1ea', '#1a1a1a'] as [string, string, string] };
    const render = (make: MakeScratch) => {
      const glow = createGlow(make, w, h, { main: '#e8203a' });
      glow.stroke(
        [
          [150, 30],
          [190, 150],
        ],
        8,
        '#e8203a',
        'body',
        1,
      );
      glow.disc([190, 150], 6, '#f4f1ea', 1);
      const impact: ImpactFrame = {
        layers: frameLayers(
          { fire: [rectLayer('fire', '#ff8a00', [150, 120, 120, 50])], dust: [rectLayer('dust', '#8a8070', [0, 150, w, 30])], fx: [rectLayer('sparks', '#fff4c0', [180, 100, 30, 30])], glow: [glowLayer([[glow, 0.6]])] },
          { faceCut: rectMask(80, 45, [36, 6, 44, 12]) },
        ),
        camera: { a: 1.08, b: 0, c: 0, d: 1.08, e: -0.08 * 200 + 1.3, f: -0.08 * 150 - 0.7 },
        grade: gradeAt(20, ictx),
      };
      const out: string[] = [];
      for (let i = 0; i < 2; i++) {
        const canvas = fill(w, h, '#000000');
        renderFrame(canvas.getContext('2d') as unknown as Ctx, image as never, 0, w, h, { strokes: () => strokes, personMask: () => mask, impact: () => impact }, deps(make));
        out.push(hash(canvas));
      }
      return out;
    };
    const [cold, warm] = render(freshMaker());
    expect(warm).toBe(cold);
    expect(render(freshMaker())).toEqual([cold, cold]);
  });
});

describe('budget at 1080×608 (design §10)', () => {
  const [W, H] = [1080, 608];
  const median = (time: () => number, warm = 5) => {
    for (let i = 0; i < warm; i++) time();
    const ms = Array.from({ length: 10 }, time).sort((a, b) => a - b);
    return { ms, median: (ms[4] + ms[5]) / 2 };
  };
  // Timed while other test files share the CPU (npm run check:fast runs them
  // all at once, and everything takes two to three times as long): a batch
  // over its bound is measured again, twice at most. Any other failure fails
  // at once. Decision 11: each bound is about 1.5 × the worst median measured
  // under the whole unit suite (five runs, Nov 2), with the design's number
  // and today's beside it.
  const UNDER_LOAD = { retry: { count: 2, delay: 300, condition: /to be less than or equal to/ } };
  const CUTOUT_MS = 11.5; // design 6 (§10's person cutout); today 3.6–7.7 under the whole suite
  const HALF_GRADE_MS = 13; // no design line; today 6.3–8.7 under the whole suite
  const STILL_MS = 7.5; // design 2 (§10's camera and layer composite); today 3.4–4.9 under the whole suite
  const CAMERA_MS = 19; // design 2; today 9.3–12.6 under the whole suite

  it('the person cutout, from a mask decoded ahead: ≤ 11.5 ms (median of 10; design 6 ms); with its half grade ≤ 13', UNDER_LOAD, () => {
    const image = video(W, H);
    const mask = personMask(); // a 248×568 px box
    frameMask(nodeScratch, mask, W, H); // ahead of the frame
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    const ictx = { jEnd: 45, frame: { P: [540, 560] as [number, number], u: [0, 1] as [number, number], v: [1, 0] as [number, number], S: H, U: 0.85 * H, sigma: 0.85, h: 1 as const }, palette: ['#e8203a', '#f4f1ea', '#1a1a1a'] as [string, string, string] };
    const run = (grade: ReturnType<typeof gradeAt> | null) => () => {
      const t0 = performance.now();
      drawPerson(ctx as unknown as Ctx, nodeScratch, image as never, mask, W, H, grade);
      ctx.getImageData(0, 0, 1, 1); // make sure the raster work is done
      return performance.now() - t0;
    };
    const plain = median(run(null));
    const graded = median(run(gradeAt(31, ictx)));
    console.log(`cutout: ${plain.median.toFixed(2)} ms, ${graded.median.toFixed(2)} ms with the person's half grade (g8) (medians of 10, 1080×608)`);
    expect(plain.median, `ms: ${plain.ms.map((m) => m.toFixed(1)).join(' ')}`).toBeLessThanOrEqual(CUTOUT_MS);
    // The half grade is the grade's three ops again over the person's box; held to a measured bound.
    expect(graded.median, `ms: ${graded.ms.map((m) => m.toFixed(1)).join(' ')}`).toBeLessThanOrEqual(HALF_GRADE_MS);
  });

  it('the camera and the layer composite: five cached layers, ≤ 7.5 ms still, ≤ 19 ms under the camera (design 2 ms)', UNDER_LOAD, () => {
    // Limbs behind and in front, fire and cluster, the dust band, the sparks:
    // each a keyed bitmap, stamped over its box. Measured alone: 1.6–2.0 ms
    // still, within design §10's 2 ms; under the 8 % punch-in every stamp is
    // a resample, 4.5–5.5 ms, and the plate's own draw goes from 1.7 to 4.6
    // (a line the design's table doesn't have). With every test file running
    // at once it is 3.4–4.9 ms still and 9.3–12.6 under the camera (Nov 2), so
    // the bounds are about 1.5 × the worst, to catch a regression without flaking.
    const blob = (key: string, color: string, path: (ctx: Ctx) => void): LayerDraw => ({
      key,
      draw(target) {
        const ctx = target as unknown as Ctx;
        ctx.fillStyle = color;
        ctx.strokeStyle = color;
        path(ctx);
      },
    });
    const slots = {
      limbsBehind: [blob('limbs behind', '#e8203a', (c) => { c.lineWidth = 60; c.beginPath(); c.moveTo(420, 120); c.lineTo(470, 330); c.lineTo(520, 560); c.stroke(); })],
      fire: [blob('fire', '#ff8a00', (c) => { c.beginPath(); c.arc(700, 520, 120, 0, 2 * Math.PI); c.fill(); c.fillRect(480, 470, 440, 90); })],
      dust: [blob('dust', '#8a8070', (c) => c.fillRect(0, 500, 1080, 108))],
      limbsFront: [blob('limbs front', '#f4f1ea', (c) => { c.lineWidth = 60; c.beginPath(); c.moveTo(640, 140); c.lineTo(600, 350); c.lineTo(560, 560); c.stroke(); })],
      fx: [blob('sparks', '#fff4c0', (c) => { for (let i = 0; i < 40; i++) { c.beginPath(); c.arc(400 + ((i * 97) % 400), 300 + ((i * 53) % 300), 4, 0, 2 * Math.PI); c.fill(); } })],
    };
    const cache = createLayerCache(nodeScratch, W, H);
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    const camera: Affine = { a: 1.08, b: 0, c: 0, d: 1.08, e: -0.08 * 600 + 3.3, f: -0.08 * 480 - 2.1 };
    const run = (cam: Affine | null) => () => {
      const t0 = performance.now();
      drawStack(ctx as unknown as BrushTarget, frameLayers(slots), cam, cache);
      ctx.getImageData(0, 0, 1, 1);
      return performance.now() - t0;
    };
    const still = median(run(null));
    const moving = median(run(camera));
    const plate = video(W, H);
    const plateAt = (cam: Affine | null) => () => {
      const t0 = performance.now();
      drawStack(ctx as unknown as BrushTarget, frameLayers({ plate: [{ key: null, draw: (c) => c.drawImage(plate as never, 0, 0, W, H, 0, 0, W, H) }] }), cam, cache);
      ctx.getImageData(0, 0, 1, 1);
      return performance.now() - t0;
    };
    const plate1 = median(plateAt(null));
    const plate2 = median(plateAt(camera));
    console.log(
      `composite: ${still.median.toFixed(2)} ms still, ${moving.median.toFixed(2)} ms under the camera; the plate's own draw ${plate1.median.toFixed(2)} still, ${plate2.median.toFixed(2)} under the camera (medians of 10, 1080×608)`,
    );
    expect(cache.stats.misses).toBe(5); // drawn once each, stamped after
    expect(still.median, `ms: ${still.ms.map((m) => m.toFixed(1)).join(' ')}`).toBeLessThanOrEqual(STILL_MS);
    expect(moving.median, `ms: ${moving.ms.map((m) => m.toFixed(1)).join(' ')}`).toBeLessThanOrEqual(CAMERA_MS);
  });
});
