// Contact sheets (SPEC §8.6), the pictures motion-critic judges: one cell
// per drawing, a timing strip of the tip path, and a reference strip. They
// draw with the same brush code as the app (Node only: @napi-rs/canvas).
import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import type { Effect, Vec2 } from '../types/effect.ts';
import type { AnimatedFrame, PlacedStroke } from '../motion/animate.ts';
import { toPixels, toTorso, type TorsoTransform } from '../track/torso.ts';
import { drawStrokes } from './headless.ts';

const INK = '#202024';
const MUTED = '#6c6c78';
const PAPER = '#ffffff';
const SILHOUETTE = '#c9c9cf';
const FONT = '12px sans-serif';

// What a cell shows besides the strokes. θ, facing, view weights, preset and
// fallback are the turn's (M3); until then every drawing is the front view.
export interface CellInfo {
  theta: number; // degrees
  facing: string;
  weights: string; // e.g. "front 1.00"
  preset: string;
  fallback: boolean;
}

export interface SheetOptions {
  frames: AnimatedFrame[];
  effect: Effect;
  body: (f: number) => TorsoTransform; // where the gray figure stands
  crop: { x: number; y: number; size: number }; // the square of the frame each cell shows, px
  cell: number; // cell size, px
  columns: number;
  scale: number; // brush scale: frame width / 1080
  banner: string[];
  info: (frame: AnimatedFrame) => CellInfo;
}

// One cell per drawing: the frame where drawing k is first shown, placed
// with that frame's transform. Behind strokes go under the figure and front
// ones over it, as compose.ts does with the person mask.
export function contactSheet(o: SheetOptions): Buffer {
  const firsts = o.frames.filter((fr, i) => i === 0 || fr.k !== o.frames[i - 1].k);
  const rows = Math.ceil(firsts.length / o.columns);
  const bannerHeight = 18 * o.banner.length + 12;
  const labelHeight = 46;
  const canvas = createCanvas(o.columns * o.cell, bannerHeight + rows * (o.cell + labelHeight));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  banner(ctx, o.banner);
  firsts.forEach((fr, n) => {
    const left = (n % o.columns) * o.cell;
    const top = bannerHeight + Math.floor(n / o.columns) * (o.cell + labelHeight);
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, o.cell, o.cell);
    ctx.clip();
    const zoom = o.cell / o.crop.size;
    ctx.setTransform(zoom, 0, 0, zoom, left - o.crop.x * zoom, top - o.crop.y * zoom);
    drawStrokes(ctx, fr.placed, o.effect, o.scale, ['behind']);
    figure(ctx, o.body(fr.f));
    drawStrokes(ctx, fr.placed, o.effect, o.scale, ['front']);
    ctx.restore();
    ctx.strokeStyle = '#dcdce2';
    ctx.lineWidth = 1;
    ctx.strokeRect(left + 0.5, top + 0.5, o.cell - 1, o.cell - 1);
    const info = o.info(fr);
    text(ctx, `k ${fr.k}  f ${fr.f}${info.fallback ? '  FALLBACK' : ''}`, left + 6, top + o.cell + 14, INK);
    // Spelled out: the sheet's font has no θ glyph.
    text(ctx, `theta ${info.theta.toFixed(0)} deg ${info.facing} · ${info.weights}`, left + 6, top + o.cell + 28, MUTED);
    text(ctx, `preset ${info.preset}`, left + 6, top + o.cell + 42, MUTED);
  });
  return canvas.toBuffer('image/png');
}

// The tip path of one stroke against time, in torso units relative to its
// root: the simulated tip (thin, continuous) and the held drawing's tip
// (thick, stepped), with a tick at every drawing change.
export function timingStrip(o: {
  frames: AnimatedFrame[];
  strokeId: number;
  anchor: (f: number) => TorsoTransform;
  banner: string[];
  width?: number;
}): Buffer {
  const width = o.width ?? 1400;
  const plot = 150; // px per channel
  const bannerHeight = 18 * o.banner.length + 12;
  const canvas = createCanvas(width, bannerHeight + 2 * plot + 60);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  banner(ctx, o.banner);

  const rows = o.frames.map((fr) => {
    const t = o.anchor(fr.f);
    const sim = fr.sim.find((s) => s.id === o.strokeId)!.points;
    const held = fr.held.find((h) => h.id === o.strokeId)!.points;
    const simTip = toTorso(t, sim[sim.length - 1]);
    const heldTip = held[held.length - 1];
    return { f: fr.f, k: fr.k, sim: simTip, held: heldTip };
  });
  const left = 60;
  const right = width - 20;
  const xOf = (f: number) => left + ((right - left) * f) / Math.max(1, rows.length - 1);
  (['x', 'y'] as const).forEach((axis, a) => {
    const top = bannerHeight + 10 + a * (plot + 20);
    const values = rows.flatMap((r) => [r.sim[a], r.held[a]]);
    const lo = Math.min(...values) - 0.02;
    const hi = Math.max(...values) + 0.02;
    const yOf = (v: number) => top + plot - ((v - lo) / (hi - lo)) * plot;
    ctx.strokeStyle = '#e4e4ea';
    ctx.lineWidth = 1;
    ctx.strokeRect(left, top, right - left, plot);
    rows.forEach((r, i) => {
      if (i > 0 && r.k !== rows[i - 1].k) {
        ctx.strokeStyle = '#c4c4cc';
        ctx.beginPath();
        ctx.moveTo(xOf(r.f), top);
        ctx.lineTo(xOf(r.f), top + plot);
        ctx.stroke();
      }
    });
    line(ctx, rows.map((r): Vec2 => [xOf(r.f), yOf(r.sim[a])]), '#8a8a96', 1);
    const stepped: Vec2[] = [];
    rows.forEach((r, i) => {
      if (i > 0) stepped.push([xOf(r.f), yOf(rows[i - 1].held[a])]);
      stepped.push([xOf(r.f), yOf(r.held[a])]);
    });
    line(ctx, stepped, '#e8203a', 2.5);
    text(ctx, `tip ${axis}`, 8, top + 14, INK);
    text(ctx, hi.toFixed(2), 8, top + 30, MUTED);
    text(ctx, lo.toFixed(2), 8, top + plot - 4, MUTED);
  });
  const bottom = bannerHeight + 10 + 2 * (plot + 20);
  text(ctx, 'frame 0', left, bottom + 4, MUTED);
  text(ctx, `frame ${rows.length - 1}`, right - 70, bottom + 4, MUTED);
  text(ctx, 'gray: simulated tip (smooth)   red: held drawing tip (stepped)   ticks: drawing changes   units: torso heights from the root', left + 120, bottom + 4, INK);
  return canvas.toBuffer('image/png');
}

// A square of the frame, px.
export interface View {
  x: number;
  y: number;
  size: number;
}

// Reference cells: each is a set of strokes already in px, drawn with the
// effect's brush, or a note saying what's missing. A cell shows `view` when
// it has one, so cells that share a view share a scale and a root position;
// otherwise it's fitted to its strokes. `root` marks the root with a dot.
export function referenceStrip(o: {
  cells: { title: string; strokes?: AnimatedFrame['placed']; view?: View; root?: Vec2; note?: string }[];
  effect: Effect;
  cell: number;
  scale: number;
  banner: string[];
}): Buffer {
  const bannerHeight = 18 * o.banner.length + 12;
  const canvas = createCanvas(Math.max(1, o.cells.length) * o.cell, bannerHeight + o.cell + 24);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  banner(ctx, o.banner);
  o.cells.forEach((c, n) => {
    const left = n * o.cell;
    const top = bannerHeight;
    ctx.strokeStyle = '#dcdce2';
    ctx.strokeRect(left + 0.5, top + 0.5, o.cell - 1, o.cell - 1);
    if (c.strokes && c.strokes.length > 0) {
      const view = c.view ?? fit(c.strokes.flatMap((s) => s.points), o.effect.brush.size * o.scale * 2);
      ctx.save();
      ctx.beginPath();
      ctx.rect(left, top, o.cell, o.cell);
      ctx.clip();
      const zoom = o.cell / view.size;
      ctx.setTransform(zoom, 0, 0, zoom, left - view.x * zoom, top - view.y * zoom);
      drawStrokes(ctx, c.strokes, o.effect, o.scale);
      if (c.root) {
        ctx.fillStyle = MUTED;
        ctx.beginPath();
        ctx.arc(c.root[0], c.root[1], 4 / zoom, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    } else {
      wrapText(ctx, c.note ?? '', left + 10, top + 24, o.cell - 20);
    }
    text(ctx, c.title, left + 6, top + o.cell + 16, INK);
  });
  return canvas.toBuffer('image/png');
}

// One stroke, big enough to judge the line and its boil: consecutive drawings
// at `zoom` times the frame's own pixels, each shifted so its root sits at
// the same spot, over a faint grid of 10 frame px.
export function lineStrip(o: {
  cells: { title: string; stroke: PlacedStroke; root: Vec2 }[];
  effect: Effect;
  scale: number; // brush scale: frame width / 1080
  zoom: number;
  columns: number;
  banner: string[];
}): Buffer {
  const strokes = o.cells.map((c) => ({ ...c.stroke, points: c.stroke.points.map((p): Vec2 => [p[0] - c.root[0], p[1] - c.root[1]]) }));
  const all = strokes.flatMap((s) => s.points);
  const pad = o.effect.brush.size * o.scale * 2;
  const x0 = Math.min(...all.map((p) => p[0])) - pad;
  const y0 = Math.min(...all.map((p) => p[1])) - pad;
  const x1 = Math.max(...all.map((p) => p[0])) + pad;
  const y1 = Math.max(...all.map((p) => p[1])) + pad;
  const width = Math.ceil((x1 - x0) * o.zoom);
  const height = Math.ceil((y1 - y0) * o.zoom);
  const rows = Math.ceil(o.cells.length / o.columns);
  const bannerHeight = 18 * o.banner.length + 12;
  const labelHeight = 22;
  const canvas = createCanvas(Math.max(Math.min(o.columns, o.cells.length) * width, 900), bannerHeight + rows * (height + labelHeight));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  banner(ctx, o.banner);
  o.cells.forEach((c, n) => {
    const left = (n % o.columns) * width;
    const top = bannerHeight + Math.floor(n / o.columns) * (height + labelHeight);
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, width, height);
    ctx.clip();
    ctx.setTransform(o.zoom, 0, 0, o.zoom, left - x0 * o.zoom, top - y0 * o.zoom);
    ctx.strokeStyle = '#eeeef2';
    ctx.lineWidth = 1 / o.zoom;
    ctx.beginPath();
    for (let x = Math.ceil(x0 / 10) * 10; x < x1; x += 10) {
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
    }
    for (let y = Math.ceil(y0 / 10) * 10; y < y1; y += 10) {
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
    }
    ctx.stroke();
    drawStrokes(ctx, [strokes[n]], o.effect, o.scale);
    ctx.restore();
    ctx.strokeStyle = '#dcdce2';
    ctx.lineWidth = 1;
    ctx.strokeRect(left + 0.5, top + 0.5, width - 1, height - 1);
    text(ctx, c.title, left + 6, top + height + 16, INK);
  });
  return canvas.toBuffer('image/png');
}

// The smallest square around `points`, with `pad` px on every side.
export function fit(points: Vec2[], pad: number): View {
  const x0 = Math.min(...points.map((p) => p[0])) - pad;
  const y0 = Math.min(...points.map((p) => p[1])) - pad;
  const size = Math.max(Math.max(...points.map((p) => p[0])) + pad - x0, Math.max(...points.map((p) => p[1])) + pad - y0);
  return { x: x0, y: y0, size };
}

// A plain gray figure standing in for the person mask: head, torso, arms
// and legs, posed by the body's torso transform.
function figure(ctx: SKRSContext2D, t: TorsoTransform) {
  ctx.fillStyle = SILHOUETTE;
  const ellipse = (c: Vec2, rx: number, ry: number) => {
    const [x, y] = toPixels(t, c);
    ctx.beginPath();
    ctx.ellipse(x, y, rx * t.unit, ry * t.unit, t.angle, 0, Math.PI * 2);
    ctx.fill();
  };
  const limb = (from: Vec2, to: Vec2, width: number) => {
    const a = toPixels(t, from);
    const b = toPixels(t, to);
    ctx.strokeStyle = SILHOUETTE;
    ctx.lineCap = 'round';
    ctx.lineWidth = width * t.unit;
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
  };
  ellipse([0, -0.95], 0.2, 0.25);
  ellipse([0, -0.1], 0.33, 0.6);
  limb([-0.28, -0.5], [-0.42, 0.35], 0.14);
  limb([0.28, -0.5], [0.42, 0.35], 0.14);
  limb([-0.15, 0.35], [-0.2, 1.55], 0.2);
  limb([0.15, 0.35], [0.2, 1.55], 0.2);
}

function banner(ctx: SKRSContext2D, lines: string[]) {
  lines.forEach((l, i) => text(ctx, l, 8, 18 + i * 18, i === 0 ? '#b0122a' : INK, i === 0 ? 'bold 13px sans-serif' : FONT));
}

function text(ctx: SKRSContext2D, s: string, x: number, y: number, color: string, font = FONT) {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
}

function wrapText(ctx: SKRSContext2D, s: string, x: number, y: number, width: number) {
  ctx.font = FONT;
  ctx.fillStyle = MUTED;
  let lineText = '';
  let row = 0;
  for (const word of s.split(' ')) {
    const next = lineText ? `${lineText} ${word}` : word;
    if (ctx.measureText(next).width > width && lineText) {
      ctx.fillText(lineText, x, y + row * 16);
      lineText = word;
      row++;
    } else lineText = next;
  }
  if (lineText) ctx.fillText(lineText, x, y + row * 16);
}

function line(ctx: SKRSContext2D, points: Vec2[], color: string, width: number) {
  if (points.length < 2) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (const p of points.slice(1)) ctx.lineTo(p[0], p[1]);
  ctx.stroke();
}
