// The aftermath masses' sheet (impact design §6 "Masses", WP8): what
// aftermath/fire.ts, cluster.ts, dust.ts, wisps.ts, debris.ts and cracks.ts
// draw, for Qai to judge the look. The hero's geometry at the app's 1080×608
// (P (530, 597) on the bottom edge, d (−0.060, 0.998), the hero's floor block,
// seed 84, 1.5 s), on a grey floor (#585858) with faint floor circles and the
// hero's six cracks. Rows, for the full tier and then the phone tier:
//   1. hold groups g0..g8, each at its first frame (A0..A17);
//   2. six drawings of the decay (f116..f128), eroding (the lumps, plumes and
//      specks shrink and drop out in a seeded order) and fading only on the
//      last 2 frames, to 0 at J_end (f129);
//   3. 1:1 crops round P of g1, g2, g4, g6 and g8.
// Stack order as the compositor will lay it (design §7): cracks, fire and
// cluster, dust over the cluster's base, then the front FX (wisps, debris).
// No person, no energy (WP9) and no glow (WP10). Reads only local files: no
// network, no paid calls. Writes mass-sheet.png to --out, which must be
// outside the repo.
// Usage: node scripts/sheets/mass-sheet.ts --out <dir>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import { nullSink, type Crack, type Palette, type Tier, type Vec2 } from '../../src/impact/contracts.ts';
import { floorCircle, strikeFrame } from '../../src/impact/floor.ts';
import * as cluster from '../../src/impact/aftermath/cluster.ts';
import * as cracks from '../../src/impact/aftermath/cracks.ts';
import * as debris from '../../src/impact/aftermath/debris.ts';
import * as dust from '../../src/impact/aftermath/dust.ts';
import * as fire from '../../src/impact/aftermath/fire.ts';
import * as wisps from '../../src/impact/aftermath/wisps.ts';
import { DEFAULT_BRUSH } from '../../src/render/brush.ts';
import type { BrushTarget } from '../../src/render/glow.ts';
import { HERO, HERO_CRACKS } from '../../tests/unit/helpers/impact-drawings.ts';
import { assertOutsideRepo, parseArgs } from '../lib/out-dir.ts';

const USAGE = 'usage: node scripts/sheets/mass-sheet.ts --out <dir>';
const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const args = parseArgs(process.argv.slice(2));
if (!args.out) throw new Error(USAGE);
const outDir = assertOutsideRepo(args.out, REPO);

const PALETTE: Palette = ['#e8203a', '#f4f1ea', '#16141a']; // the app's default, and the test drawings'
const GREY = '#585858'; // compositing's C15 plate
const CIRCLE = '#626262';
const INK = '#111111';
const MUTED = '#555555';
const W = 1080;
const H = 608;
const K = W / HERO.width; // clip px → frame px
const P: Vec2 = [HERO.P[0] * K, HERO.P[1] * K];
const S = Math.min(W, H);
const FLOOR = { ratio: 0.763, majorDeg: 2.6, up: [0.04, -1.0] as [number, number], persp: 0.68 }; // the hero's floor block (design §6)

type Ctx = SKRSContext2D;
const bt = (ctx: Ctx) => ctx as unknown as BrushTarget;

// The hero's cracks as the layers read them: the brush sized so the widest
// point matches (about 1.93 sizes at full pressure), drawn on from P.
const CRACKS: Crack[] = HERO_CRACKS.map((c) => ({
  id: c.id,
  points: c.points.map(([x, y]): Vec2 => [x * K, y * K]),
  pressure: [...c.pressure],
  brush: { ...DEFAULT_BRUSH, size: (Math.max(...c.width) * K * (1080 / W)) / 1.93 },
  color: 2,
  fromP: 'start',
}));

function scene(tier: Tier): fire.MassContext {
  return {
    I: HERO.I,
    jEnd: 45,
    seed: HERO.seed,
    frame: strikeFrame(P, [HERO.d[0], HERO.d[1]], S, 0.63, W, H, HERO.seed),
    floor: FLOOR,
    width: W,
    height: H,
    palette: PALETTE,
    flash: 'full',
    posters: true,
    crackEase: 'out',
    aftermath: { seconds: 1.5, scale: 1, scarSeconds: 3 },
    tier,
    personMask: () => null,
    faceMask: () => null,
    cracks: CRACKS,
  };
}

// Frame f at 1080×608, the WP8 layers in stack order, and what it showed.
function frame(ictx: fire.MassContext, f: number): { canvas: Canvas; info: string[] } {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = GREY;
  ctx.fillRect(0, 0, W, H);
  const fr = fire.massFrame(ictx);
  ctx.strokeStyle = CIRCLE;
  ctx.lineWidth = 1.5;
  for (const R of [0.45, 0.75, 1.05]) {
    const { points } = floorCircle(fr.P, R * fr.U, ictx.floor, { U: fr.U, height: H, segments: 96 });
    ctx.beginPath();
    points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.stroke();
  }
  const c = bt(ctx);
  cracks.draw(c, c, nullSink, ictx, f);
  fire.draw(c, c, nullSink, ictx, f);
  cluster.draw(c, c, nullSink, ictx, f);
  dust.draw(c, c, nullSink, ictx, f);
  wisps.draw(c, c, nullSink, ictx, f);
  debris.draw(c, c, nullSink, ictx, f);

  const clock = fire.massClock(ictx, f);
  const lines = [`j ${f - ictx.I} · f${f}` + (clock ? ` · g${clock.g} · A${clock.A} · α ${clock.alpha.toFixed(2)}` : ' · after J_end')];
  const parts: string[] = [];
  const fd = fire.shapes(ictx, f);
  const cd = cluster.shapes(ictx, f);
  const dd = dust.shapes(ictx, f);
  if (fd) parts.push(`fire ${fd.shapes.filter((s) => s.role === 'bubble').length} bubbles`);
  if (cd) parts.push(`cluster ${cd.state.stats.area.toFixed(3)} U² · hot ${cd.state.stats.hot.toFixed(2)} (h ${cd.state.hot.toFixed(2)}) · ${cd.state.balls.length} balls`);
  if (dd) parts.push(`dust ${dd.state.area.toFixed(3)} U²`);
  lines.push(parts.join(' · ') || 'no mass');
  const wd = wisps.shapes(ictx, f);
  const db = debris.shapes(ictx, f);
  const cr = cracks.shapes(ictx, f);
  const front: string[] = [];
  if (wd) front.push(`${wd.pieces.length} ${wd.kind}`);
  if (db) {
    const specks = db.bits.filter((b) => b.role === 'speck').length;
    const shards = db.bits.length - specks;
    front.push(`${specks} specks${shards ? `, ${shards} shards` : ''}${db.chunks.length ? `, ${db.chunks.length} chunks (k′${db.kp})` : ''}`);
  }
  if (cr) front.push(`cracks cool ${cr.cool.toFixed(2)}`);
  lines.push(front.join(' · '));
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
function rows(title: string, cells: Cell[], per = 5): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < cells.length; i += per) out.push({ title: i === 0 ? title : '', cells: cells.slice(i, i + per) });
  return out;
}

// Each hold group's first frame.
function groupStarts(ictx: fire.MassContext): number[] {
  const out: number[] = [];
  for (let f = ictx.I + 9; f <= ictx.I + ictx.jEnd; f++) {
    const c = fire.massClock(ictx, f);
    if (c && c.start === f) out[c.g] = f;
  }
  return out;
}

const HALF = 0.5;
const DECAY = [116, 118, 120, 123, 125, 128];
const all: Row[] = [];
for (const tier of ['full', 'phone'] as const) {
  const ictx = scene(tier);
  const starts = groupStarts(ictx);
  const name = tier === 'full' ? 'Full tier' : 'Phone tier (balls of 0.033–0.05 U, at most 30)';
  all.push(
    ...rows(
      `${name}: hold groups g0..g8 at their first frames`,
      starts.slice(0, 9).map((f) => {
        const { canvas, info } = frame(ictx, f);
        return scaled(canvas, HALF, info);
      }),
    ),
  );
  all.push(
    ...rows(
      `${name}: the decay, eroding, then fading on its last 2 frames to 0 at J_end (f129); the scars stay`,
      DECAY.map((f) => {
        const { canvas, info } = frame(ictx, f);
        return scaled(canvas, HALF, info);
      }),
      6,
    ),
  );
}
const full = scene('full');
const fullStarts = groupStarts(full);
all.push(
  ...rows(
    '1:1 crops round P (full tier): g1 the burst, g2 the first cluster, g4 under the dust wave, g6 the first carried group, g8',
    [1, 2, 4, 6, 8].map((g) => {
      const { canvas, info } = frame(full, fullStarts[g]);
      return crop(canvas, Math.round(P[0] - 330), H - 420, 660, 420, [`1:1 · ${info[0]}`, info[1]]);
    }),
    3,
  ),
);

// ---- The sheet ----------------------------------------------------------------------------------

const PAD = 16;
const GAP = 8;
const TITLE = 34;
const LINE = 17;
const U = fire.massFrame(full).U;
const BANNER = [
  'Aftermath masses (impact WP8, design §6): aftermath/fire.ts, cluster.ts, dust.ts, wisps.ts, debris.ts, cracks.ts. No person, no energy (WP9) and no glow (WP10).',
  `The hero at 1080×608 (S 608, U ${U.toFixed(0)} px), P (${P[0].toFixed(0)}, ${P[1].toFixed(0)}) on the bottom edge, d (${HERO.d.join(', ')}), seed ${HERO.seed}, 1.5 s; cells at ½ scale. Faint grey lines: floor circles at 0.45, 0.75 and 1.05 U.`,
  'Stack: cracks, fire and cluster, dust over the cluster’s base, then wisps and debris. Fire, smoke and dust keep the measured physical ramps (decision 6); the wisps are white (p1 lifted toward #ffffff) with a soft edge and streaks, the cracks cool from p1 to ink.',
];
function text(ctx: Ctx, s: string, x: number, y: number, color = INK, font = '15px sans-serif') {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
}
const rowWidth = (r: Row) => r.cells.reduce((w, c) => w + c.canvas.width, 0) + GAP * (r.cells.length - 1);
const rowHeight = (r: Row) => (r.title ? TITLE : 8) + Math.max(...r.cells.map((c) => c.canvas.height)) + 8 + LINE * Math.max(...r.cells.map((c) => c.label.length)) + PAD;
const width = Math.max(...all.map(rowWidth), 1500) + 2 * PAD;
const top = PAD + BANNER.length * 22 + 8;
const sheet = createCanvas(width, top + all.reduce((h, r) => h + rowHeight(r), 0));
const ctx = sheet.getContext('2d');
ctx.fillStyle = '#ffffff';
ctx.fillRect(0, 0, sheet.width, sheet.height);
ctx.textBaseline = 'alphabetic';
BANNER.forEach((l, i) => text(ctx, l, PAD, PAD + 16 + i * 22, i === 0 ? '#b0122a' : INK, i === 0 ? 'bold 17px sans-serif' : '15px sans-serif'));
let y = top;
for (const row of all) {
  const head = row.title ? TITLE : 8;
  if (row.title) text(ctx, row.title, PAD, y + 22, INK, 'bold 17px sans-serif');
  let x = PAD;
  const h = Math.max(...row.cells.map((c) => c.canvas.height));
  for (const c of row.cells) {
    ctx.drawImage(c.canvas, x, y + head);
    c.label.forEach((l, i) => text(ctx, l, x, y + head + h + 8 + 12 + i * LINE, i === 0 ? INK : MUTED, i === 0 ? '14px sans-serif' : '12px sans-serif'));
    x += c.canvas.width + GAP;
  }
  y += rowHeight(row);
}
mkdirSync(outDir, { recursive: true });
const file = join(outDir, 'mass-sheet.png');
writeFileSync(file, sheet.toBuffer('image/png'));
process.stdout.write(`mass sheet: ${file} (${sheet.width}×${sheet.height})\n`);
