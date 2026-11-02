// The aftermath energy's sheet (impact design §6 "Energy", WP9): what
// aftermath/lightning.ts, washes.ts and particles.ts draw, for Qai to judge
// the look. The hero's geometry at the app's 1080×608 (P (530, 597), d
// (−0.060, 0.998), the hero's floor block, seed 84, 1.5 s), on a grey plate
// (#585858) with synthetic sources: a cluster outline over P, the hero's six
// cracks, a stand-in person mask near P and two limbs landing on P, drawn
// faintly so the ribbons can be read against what they follow. Rows:
//   1. Full flashing, the default (decision 5): j 9..45, every frame;
//   2. Reduce flashing (gentle mode): j 18..35, the two washes' 2-frame ramps,
//      wash 2's bolt brightening and the capped veil and flash, the lightning
//      one steady draw from the cracks (as the scene draws it);
//   3. the hooks and tiers: the phone tier (4 × 48), the cut order's 2
//      ribbons and half the particles, w1 and w3 'bolt', and noFlash;
//   4. 1:1 crops round P: the lead-in, an early, a mid and a late kr step.
// Stack order as the compositor will lay it (design §7): floods, the person,
// then the front FX (veil, embers and sparks, lightning), the A5–6 flash, and
// the glow (WP10's render/light.ts). Reads only local files: no network, no
// paid calls. Writes energy-sheet.png to --out, which must be outside the repo.
// Usage: node scripts/sheets/energy-sheet.ts --out <dir>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import type { ImpactContext, Palette, Vec2 } from '../../src/impact/contracts.ts';
import { kr, massGroup } from '../../src/impact/clock.ts';
import { floorCircle, strikeFrame } from '../../src/impact/floor.ts';
import { emitLightning, paintLightning, ribbons, type LightningOptions } from '../../src/impact/aftermath/lightning.ts';
import { paintParticles, particles, type ParticleOptions } from '../../src/impact/aftermath/particles.ts';
import { emitFlood, energyFrame, flashShapes, floodShapes, onFloor, paintFlash, paintFlood, paintVeil, veilShapes } from '../../src/impact/aftermath/washes.ts';
import type { Mask } from '../../src/track/tracking.ts';
import type { BrushTarget } from '../../src/render/glow.ts';
import { nodeScratch } from '../../src/render/headless.ts';
import { createGlow } from '../../src/render/light.ts';
import { HERO, HERO_CRACKS } from '../../tests/unit/helpers/impact-drawings.ts';
import { assertOutsideRepo, parseArgs } from '../lib/out-dir.ts';

const USAGE = 'usage: node scripts/sheets/energy-sheet.ts --out <dir>';
const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const args = parseArgs(process.argv.slice(2));
if (!args.out) throw new Error(USAGE);
const outDir = assertOutsideRepo(args.out, REPO);

const PALETTE: Palette = ['#e8203a', '#f4f1ea', '#16141a']; // the app's default, and the test drawings'
const GREY = '#585858'; // compositing's C15 plate
const SOURCE = '#6c6c6c';
const PERSON = '#404040';
const INK = '#111111';
const MUTED = '#555555';
const FONT = '15px sans-serif';
const W = 1080;
const H = 608;
const K = W / HERO.width; // clip px → frame px
const P: Vec2 = [HERO.P[0] * K, HERO.P[1] * K];
const FLOOR = { ratio: 0.763, majorDeg: 2.6, up: [0.04, -1.0] as [number, number], persp: 0.68 }; // the hero's floor block (design §6)

type Ctx = SKRSContext2D;
const bt = (ctx: Ctx) => ctx as unknown as BrushTarget;

// A stand-in person: an upright ellipse whose lowest point sits just past P, frame-sized.
const BODY = { c: [P[0] + 70, P[1] - 200] as Vec2, a: 110, b: 215 };
function personMask(): Mask {
  const alpha = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5 - BODY.c[0]) / BODY.a;
      const v = (y + 0.5 - BODY.c[1]) / BODY.b;
      if (u * u + v * v <= 1) alpha[y * W + x] = 255;
    }
  }
  return { width: W, height: H, alpha };
}
const MASK = personMask();

function scene(over: Partial<ImpactContext> = {}): ImpactContext {
  return {
    I: HERO.I,
    jEnd: 45,
    seed: HERO.seed,
    frame: strikeFrame(P, HERO.d, Math.min(W, H), 0.63, W, H, HERO.seed),
    floor: FLOOR,
    width: W,
    height: H,
    palette: PALETTE,
    flash: 'full',
    posters: true,
    crackEase: 'out',
    aftermath: { seconds: 1.5, scale: 1, scarSeconds: 3 },
    tier: 'full',
    personMask: () => MASK,
    faceMask: () => null,
    cracks: [],
    ...over,
  };
}

// The synthetic sources WP12 would pass: the cluster outline (a dome over P,
// the envelope from A7), the cracks, the mask edge within 0.3 U of P, and two
// limbs from his back down to P.
function sources(ictx: ImpactContext): Vec2[][] {
  const fr = energyFrame(ictx);
  const dome: Vec2[] = Array.from({ length: 49 }, (_, i) => {
    const th = (Math.PI * i) / 48;
    return onFloor(fr, fr.U, 0.05 + 0.705 * Math.sin(th), -0.5 + 0.97 * ((1 - Math.cos(th)) / 2));
  });
  const cracks = HERO_CRACKS.map((c) => c.points.map((p): Vec2 => [p[0] * K, p[1] * K]));
  const edge: Vec2[] = [];
  for (let i = 0; i <= 96; i++) {
    const th = (2 * Math.PI * i) / 96;
    const p: Vec2 = [BODY.c[0] + BODY.a * Math.cos(th), BODY.c[1] + BODY.b * Math.sin(th)];
    if (Math.hypot(p[0] - P[0], p[1] - P[1]) <= 0.3 * fr.U) edge.push(p);
  }
  const limb = (from: Vec2, bend: number): Vec2[] =>
    Array.from({ length: 24 }, (_, i) => {
      const s = i / 23;
      return [from[0] + (P[0] - from[0]) * s + bend * Math.sin(Math.PI * s), from[1] + (P[1] - from[1]) * s];
    });
  return [dome, ...cracks, edge, limb([P[0] + 170, P[1] - 340], 40), limb([P[0] + 110, P[1] - 370], -50)];
}

interface Options {
  lightning?: LightningOptions;
  particles?: ParticleOptions;
}

// Frame I + j at 1080×608, the energy layers in stack order, and what it showed.
function frame(ictx: ImpactContext, j: number, src: Vec2[][], opts: Options = {}): { canvas: Canvas; info: string[] } {
  const f = ictx.I + j;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = GREY;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = SOURCE;
  ctx.lineWidth = 1.5;
  for (const line of src) {
    ctx.beginPath();
    line.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.stroke();
  }
  const fr = energyFrame(ictx);
  ctx.strokeStyle = '#626262';
  for (const R of [0.45, 0.75, 1.05]) {
    const { points } = floorCircle(fr.P, R * fr.U, ictx.floor, { U: fr.U, height: H, segments: 96 });
    ctx.beginPath();
    points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.stroke();
  }
  const wash = opts.lightning ?? {};
  const flood = floodShapes(ictx, j, wash);
  paintFlood(bt(ctx), nodeScratch, flood, W, H);
  ctx.fillStyle = PERSON;
  ctx.beginPath();
  ctx.ellipse(BODY.c[0], BODY.c[1], BODY.a, BODY.b, 0, 0, 2 * Math.PI);
  ctx.fill();
  const veil = veilShapes(ictx, f, wash);
  paintVeil(bt(ctx), nodeScratch, veil, MASK, W, H);
  const pf = particles(ictx, f, opts.particles);
  paintParticles(bt(ctx), nodeScratch, ictx, pf);
  // Reduce flashing draws the lightning steady, from the still sources (the scene's way).
  const gentle = ictx.flash === 'safe';
  const plan = ribbons(ictx, j, gentle ? src.slice(1, 1 + HERO_CRACKS.length) : src, { ...wash, steady: gentle });
  paintLightning(bt(ctx), nodeScratch, plan, W, H);
  const flash = flashShapes(ictx, f, wash);
  paintFlash(bt(ctx), nodeScratch, flash, MASK, W, H);
  const glow = createGlow(nodeScratch, W, H, { main: PALETTE[0] });
  emitFlood(glow, flood);
  emitLightning(glow, plan);
  glow.composite(bt(ctx));

  const g = massGroup(f, ictx.I, 12);
  const lines = [`j ${j} · f${f} · kr ${kr(j)} (A${kr(j) - 14}) · g${g ?? '–'}`];
  const parts: string[] = [];
  if (plan) parts.push(`${plan.ribbons.length} of ${plan.planned} ribbons ${plan.band}${gentle ? ' steady' : ''}, ${plan.bolts.length} thin · area ${((100 * plan.area) / (W * H)).toFixed(1)}% of ${((100 * plan.budget) / (W * H)).toFixed(1)}% · gain ${plan.gain.toFixed(2)}${plan.boost > 1 ? ` · boost ×${plan.boost}` : ''}`);
  else parts.push('no bolts');
  if (flood) parts.push(`wash ${flood.wash} ${(100 * flood.share * flood.level).toFixed(0)}%${flood.level < 1 ? ` (level ${flood.level.toFixed(2)})` : ''}`);
  if (veil) parts.push(`veil α ${veil.alpha.toFixed(2)}`);
  if (flash) parts.push(`flash α ${flash.alpha.toFixed(2)}, ${(100 * flash.share).toFixed(0)}%`);
  lines.push(parts.join(' · '));
  lines.push(pf ? `${pf.sparks?.particles.length ?? 0} sparks, ${pf.embers?.particles.length ?? 0} embers · α ${pf.alpha.toFixed(2)}` : 'no particles');
  return { canvas, info: lines };
}

interface Cell {
  canvas: Canvas;
  label: string[];
}
interface Row {
  title: string;
  cells: Cell[];
}

function scaled(src: Canvas, s: number, label: string[]): Cell {
  const canvas = createCanvas(Math.round(src.width * s), Math.round(src.height * s));
  canvas.getContext('2d').drawImage(src, 0, 0, canvas.width, canvas.height);
  return { canvas, label };
}

function crop(src: Canvas, x: number, y: number, w: number, h: number, label: string[]): Cell {
  const canvas = createCanvas(w, h);
  canvas.getContext('2d').drawImage(src, x, y, w, h, 0, 0, w, h);
  return { canvas, label };
}

// Cells of `per` to a row, so the sheet stays a sensible width.
function rows(title: string, cells: Cell[], per = 6): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < cells.length; i += per) out.push({ title: i === 0 ? title : '', cells: cells.slice(i, i + per) });
  return out;
}

const full = scene();
const gentle = scene({ flash: 'safe' });
const phone = scene({ tier: 'phone' });
const SRC = sources(full);
const HALF = 0.5;

const fullRow = rows(
  'Full flashing, the default (decision 5): j 9..45 at 1.5 s (J_end 45)',
  Array.from({ length: 37 }, (_, i) => {
    const { canvas, info } = frame(full, 9 + i, SRC);
    return scaled(canvas, HALF, info);
  }),
);
const gentleRow = rows(
  'Reduce flashing (gentle mode): j 18..35, washes 1 and 3 with 2-frame ramps, wash 2 as a bolt brightening, the veil and flash capped',
  Array.from({ length: 18 }, (_, i) => {
    const { canvas, info } = frame(gentle, 18 + i, SRC);
    return scaled(canvas, HALF, info);
  }),
);
const hooks: [string, ImpactContext, number, Options][] = [
  ['phone tier: 4 ribbons × 48 nodes, 30 particles, no rings', phone, 24, {}],
  ['cut order: 2 ribbons, half the particles', full, 24, { lightning: { maxRibbons: 2 }, particles: { half: true } }],
  ["w1 'bolt': A10 as a brightening, no flood", full, 22, { lightning: { washes: { w1: 'bolt' } } }],
  ["w3 'bolt': A17 as a brightening, no flood", full, 30, { lightning: { washes: { w3: 'bolt' } } }],
  ['noFlash: no washes, veil, flash or boost', full, 22, { lightning: { noFlash: true } }],
  ['noFlash on the A5–6 drawing', full, 16, { lightning: { noFlash: true } }],
];
const hookRow = rows(
  'Hooks and tiers',
  hooks.map(([what, ictx, j, opts]) => {
    const { canvas, info } = frame(ictx, j, SRC, opts);
    return scaled(canvas, HALF, [what, ...info]);
  }),
);
const crops = [14, 19, 22, 27].map((j) => {
  const { canvas, info } = frame(full, j, SRC);
  return crop(canvas, Math.round(P[0] - 330), H - 380, 660, 380, [`1:1 round P · ${info[0]}`, info[1]]);
});
const cropRow = rows('1:1 crops round P: the lead-in (A4), early (A8), mid (A10, wash 1) and late (A14)', crops, 4);

// ---- The sheet ----------------------------------------------------------------------------------

const all: Row[] = [...fullRow, ...gentleRow, ...hookRow, ...cropRow];
const PAD = 16;
const GAP = 8;
const TITLE = 34;
const LINE = 17;
const BANNER = [
  'Aftermath energy (impact WP9, design §6): aftermath/lightning.ts, washes.ts, particles.ts. Synthetic sources and a stand-in person, not Qai’s footage.',
  `The hero at 1080×608 (S 608, U ${energyFrame(full).U.toFixed(0)} px), P (${P[0].toFixed(0)}, ${P[1].toFixed(0)}), d (${HERO.d.join(', ')}), seed ${HERO.seed}; cells at ½ scale. Faint grey lines: the sources and the floor circles.`,
  'Stack: floods, the person, the veil, embers and sparks, lightning, the A5–6 flash, then the glow (render/light.ts). Sparks and embers keep the measured fire ramp.',
  "k21–31's measured set: ink #00017b, band #2c5cfc / #233cfd, core #22fded with a hot middle (composites #7efefd–#acfcfd), pale #abfdf4. The area budget drops and shortens ribbons, never thins them.",
  'Floods: ink, band, ink, pale fringe, field; the edge torn along its normal (teeth every 0.02–0.08 U, 0.01–0.04 U deep); A10–11 pale inside the core rim. The A5–6 flash has no window hole.',
];
function text(ctx: Ctx, s: string, x: number, y: number, color = INK, font = FONT) {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
}
const rowWidth = (r: Row) => r.cells.reduce((w, c) => w + c.canvas.width, 0) + GAP * (r.cells.length - 1);
const rowHeight = (r: Row) => (r.title ? TITLE : 8) + Math.max(...r.cells.map((c) => c.canvas.height)) + 8 + LINE * Math.max(...r.cells.map((c) => c.label.length)) + PAD;
const width = Math.max(...all.map(rowWidth)) + 2 * PAD;
const top = PAD + BANNER.length * 22 + 8;
const sheet = createCanvas(width, top + all.reduce((h, r) => h + rowHeight(r), 0));
const ctx = sheet.getContext('2d');
ctx.fillStyle = '#ffffff';
ctx.fillRect(0, 0, sheet.width, sheet.height);
ctx.textBaseline = 'alphabetic';
BANNER.forEach((l, i) => text(ctx, l, PAD, PAD + 16 + i * 22, i === 0 ? '#b0122a' : INK, i === 0 ? 'bold 17px sans-serif' : FONT));
let y = top;
for (const row of all) {
  const head = row.title ? TITLE : 8;
  if (row.title) text(ctx, row.title, PAD, y + 22, INK, 'bold 17px sans-serif');
  let x = PAD;
  const h = Math.max(...row.cells.map((c) => c.canvas.height));
  for (const c of row.cells) {
    ctx.drawImage(c.canvas, x, y + head);
    c.label.forEach((l, i) => text(ctx, l, x, y + head + h + 8 + 12 + i * LINE, i === 0 ? INK : MUTED, i === 0 ? '14px sans-serif' : '13px sans-serif'));
    x += c.canvas.width + GAP;
  }
  y += rowHeight(row);
}
mkdirSync(outDir, { recursive: true });
const file = join(outDir, 'energy-sheet.png');
writeFileSync(file, sheet.toBuffer('image/png'));
process.stdout.write(`energy sheet: ${file} (${sheet.width}×${sheet.height})\n`);
