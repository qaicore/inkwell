// The impact frames' sheet (impact design §5, WP6): the seven posters that
// frames/draw.ts paints, for Qai to judge the look. Rows:
//   1. the reference geometry: 1080×634, P (520, 388), d (−0.8, 0.6), h = +1,
//      Full, no figure, comp grade (the dark posters with their hot glow);
//      under each, its flat coverage (black / white, Rec.601 luma < 40 and
//      ≥ 230) against the panel's;
//   2. the hero in Full, the default (decision 5): 1920×1080 drawn at
//      1080×608, P (942, 1061), d (−0.060, 0.998), a synthetic crouched
//      figure with four limbs pinned on P and the hero's six cracks; under
//      each, the comp's black / white (the round-3 targets: IF2 black ≥ 40,
//      IF4 black ≥ 5, IF3 and IF6 white ≥ 90, IF1 white ≥ 55) and the
//      counts the judges check (IF1's spray, IF2's tongues, IF3's inner
//      lines, IF6's wedges, IF7's splash);
//   3. the hero in Reduce flashing (gentle mode, G1–G4);
//   4. a synthetic portrait: 608×1080, P (300, 1040), d (0, 1), h = −1,
//      Reduce flashing, the same figure and cracks moved to its P.
// The glow is WP10's (render/light.ts), coloured through the hot ramp. Reads
// only local files: no network, no paid calls. Writes if-sheet.png to --out,
// which must be outside the repo.
// Usage: node scripts/sheets/if-sheet.ts --out <dir> [--drawings test-drawings.json]
//   --drawings: the cracks from its end.strokes (clip px, 1920×1080) instead
//   of the test helper's copy of them.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import { nullSink, type Crack, type Palette, type Vec2 } from '../../src/impact/contracts.ts';
import { strikeFrame } from '../../src/impact/floor.ts';
import { drawPoster, type PosterContext, type PosterReport } from '../../src/impact/frames/draw.ts';
import { crackFromStroke, NO_FIGURE, posterFigure, syntheticCrouch, type PosterFigure, type PosterTarget } from '../../src/impact/frames/figure.ts';
import { posterHotRamp, posterSpec, type PosterSpec } from '../../src/impact/frames/gentle.ts';
import { posterLayout, withSide } from '../../src/impact/frames/layout.ts';
import type { BrushTarget } from '../../src/render/glow.ts';
import { nodeScratch } from '../../src/render/headless.ts';
import { createGlow } from '../../src/render/light.ts';
import { HERO, HERO_CRACKS, type ImpactStroke } from '../../tests/unit/helpers/impact-drawings.ts';
import { assertOutsideRepo, parseArgs } from '../lib/out-dir.ts';

const USAGE = 'usage: node scripts/sheets/if-sheet.ts --out <dir> [--drawings test-drawings.json]';
const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const args = parseArgs(process.argv.slice(2));
if (!args.out) throw new Error(USAGE);
const outDir = assertOutsideRepo(args.out, REPO);

const PALETTE: Palette = ['#e8203a', '#f4f1ea', '#16141a']; // the app's default, and the test drawings'
const NAMES = ['whiteout', 'split', 'radial', 'star', 'negative cross', 'streaks', 'negative strike'];
const PANEL = [[8.1, 91.9], [47.3, 51.2], [1.9, 94.4], [11.0, 86.3], [92.7, 5.7], [0.9, 96.5], [87.9, 8.7]]; // flat black / white %, untinted (impact.md §3)
const COLUMN = 420; // px per poster on the sheet
const GAP = 14;
const MARGIN = 24;
const LABEL = 62; // px under each poster
// The counts shown under the figure rows, by poster.
const COUNTS: readonly (readonly string[])[] = [['spray'], ['tongues', 'comb', 'streaks'], ['inner', 'lines'], ['spikes'], ['rings'], ['wedges'], ['splash']];
const TITLE = 34; // px above each row
const BG = '#e9e7e2';
const INK = '#111111';
const MUTED = '#555555';
const FONT = '15px sans-serif';
const BOLD = 'bold 18px sans-serif';

interface Geometry {
  title: string;
  width: number;
  height: number;
  P: Vec2;
  d: Vec2;
  h?: 1 | -1; // pinned; otherwise strikeFrame's (−1 in portrait)
  flash: 'safe' | 'full';
  figure: boolean;
}

// The hero at 1080×608: clip px × 0.5625.
const K = 1080 / HERO.width;
const GEOMETRIES: Geometry[] = [
  { title: 'Reference geometry · 1080×634 · P (520, 388) · d (−0.8, 0.6) · h +1 · Full · no figure', width: 1080, height: 634, P: [520, 388], d: [-0.8, 0.6], h: 1, flash: 'full', figure: false },
  { title: 'Hero · 1920×1080 at 1080×608 · P (942, 1061) · d (−0.060, 0.998) · Full (the default) · synthetic crouch + the six cracks', width: 1080, height: 608, P: [HERO.P[0] * K, HERO.P[1] * K], d: [HERO.d[0], HERO.d[1]], flash: 'full', figure: true },
  { title: 'Hero · Reduce flashing (gentle: G1–G4)', width: 1080, height: 608, P: [HERO.P[0] * K, HERO.P[1] * K], d: [HERO.d[0], HERO.d[1]], flash: 'safe', figure: true },
  { title: 'Synthetic portrait · 608×1080 · P (300, 1040) · d (0, 1) · h −1 · Reduce flashing · the same figure and cracks', width: 608, height: 1080, P: [300, 1040], d: [0, 1], flash: 'safe', figure: true },
];

// The cracks in clip px: --drawings' end.strokes, or the helper's copy.
function clipCracks(): readonly ImpactStroke[] {
  if (!args.drawings) return HERO_CRACKS;
  const json = JSON.parse(readFileSync(resolve(args.drawings), 'utf8')) as { end?: { strokes?: { id: number; points: Vec2[]; pressure: number[]; width: number[] }[] } };
  const strokes = json.end?.strokes;
  if (!strokes?.length) throw new Error(`${args.drawings} has no end.strokes`);
  return strokes.map((s) => ({ id: s.id, points: s.points, pressure: s.pressure, width: s.width }));
}

// The cracks moved from the hero's P to g's and scaled to its frame.
function cracksFor(g: Geometry, S: number): Crack[] {
  const k = S / HERO.S;
  return clipCracks().map((s) => {
    const points = s.points.map(([x, y]): Vec2 => [g.P[0] + (x - HERO.P[0]) * k, g.P[1] + (y - HERO.P[1]) * k]);
    return crackFromStroke({ id: s.id, points, pressure: s.pressure, width: s.width.map((w) => w * k) }, g.P, S, g.width);
  });
}

interface Rendered {
  canvas: Canvas;
  report: PosterReport;
  spec: PosterSpec;
}

// Poster si on g; `flat` without the comp grade and the glow, as the panel's
// coverage was measured (with `tint` false, IF1 untinted).
function render(g: Geometry, si: number, flat = false, tint = true): Rendered {
  const S = Math.min(g.width, g.height);
  const base = strikeFrame(g.P, g.d, S, 1, g.width, g.height, HERO.seed);
  const frame = g.h ? withSide(base, g.h) : base;
  const ictx: PosterContext = { frame, width: g.width, height: g.height, seed: HERO.seed, palette: PALETTE, flash: g.flash };
  const spec = posterSpec(si, g.flash);
  let figure: PosterFigure = NO_FIGURE;
  if (g.figure) {
    const crouch = syntheticCrouch(g.width, g.height, g.P, frame.u, S);
    const cracks = cracksFor(g, S);
    figure = posterFigure({ I: HERO.I, frame, width: g.width, height: g.height, cracks, crackEase: 'out', personMask: () => crouch.mask }, si, { person: crouch.mask, limbs: crouch.limbs });
  }
  const canvas = createCanvas(g.width, g.height);
  const ctx = canvas.getContext('2d');
  const glow = spec.field === 'dark' && !flat ? createGlow(nodeScratch, g.width, g.height, { ramp: posterHotRamp(spec) }) : null;
  const report = drawPoster(ctx as unknown as PosterTarget, glow ?? nullSink, ictx, si, figure, { spec, flat, tint, layout: posterLayout(ictx), scratch: nodeScratch });
  glow?.composite(ctx as unknown as BrushTarget);
  return { canvas, report, spec };
}

// Black and white shares (%), Rec.601 luma < 40 and ≥ 230.
function coverage(canvas: Canvas): [number, number] {
  const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  let black = 0;
  let white = 0;
  for (let i = 0; i < data.length; i += 4) {
    const y = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    if (y < 40) black++;
    else if (y >= 230) white++;
  }
  const n = canvas.width * canvas.height;
  return [(100 * black) / n, (100 * white) / n];
}

function text(ctx: SKRSContext2D, s: string, x: number, y: number, color = INK, font = FONT) {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
}

// A landscape poster fills the column's width; a portrait one its height.
const cellHeight = (g: Geometry) => (g.height > g.width ? COLUMN : Math.round((COLUMN * g.height) / g.width));
const sheetW = 2 * MARGIN + 7 * COLUMN + 6 * GAP;
const sheetH = MARGIN + GEOMETRIES.reduce((s, g) => s + TITLE + cellHeight(g) + LABEL, 0) + MARGIN;
const sheet = createCanvas(sheetW, sheetH);
const sx = sheet.getContext('2d');
sx.fillStyle = BG;
sx.fillRect(0, 0, sheetW, sheetH);

let y = MARGIN;
for (const g of GEOMETRIES) {
  text(sx, g.title, MARGIN, y + 22, INK, BOLD);
  y += TITLE;
  const ch = cellHeight(g);
  for (let si = 0; si < 7; si++) {
    const { canvas, report, spec } = render(g, si);
    const x = MARGIN + si * (COLUMN + GAP);
    const w = g.height > g.width ? Math.round((ch * g.width) / g.height) : COLUMN;
    sx.drawImage(canvas, x + Math.round((COLUMN - w) / 2), y, w, ch);
    sx.strokeStyle = '#9a968e';
    sx.lineWidth = 1;
    sx.strokeRect(x + Math.round((COLUMN - w) / 2) - 0.5, y - 0.5, w + 1, ch + 1);
    const head = `IF${si + 1} ${NAMES[si]} · ${spec.field}${spec.disc ? ` · ${spec.disc} disc` : ''}`;
    text(sx, head, x, y + ch + 18);
    let detail: string;
    if (!g.figure) {
      const [b, wh] = coverage(render(g, si, true, false).canvas);
      detail = `flat${si === 0 ? ', untinted' : ''} ${b.toFixed(1)} / ${wh.toFixed(1)} (panel ${PANEL[si][0]} / ${PANEL[si][1]})`;
    } else {
      const parts = [!report.light ? 'dark field' : spec.disc === 'ink' ? 'ink split: no ink guard' : `ink ≈ ${(100 * report.ink).toFixed(1)} %`];
      if (report.contour) parts.push('body as contour');
      if (report.trimmed) parts.push(`${report.trimmed} trimmed`);
      detail = parts.join(' · ');
      const [b, wh] = coverage(canvas);
      const counts = COUNTS[si].map((k) => `${k} ${report.counts[k] ?? 0}`).join(' · ');
      text(sx, `comp ${b.toFixed(1)} / ${wh.toFixed(1)} · ${counts}`, x, y + ch + 56, MUTED);
    }
    text(sx, detail, x, y + ch + 37, MUTED);
  }
  y += ch + LABEL;
}

mkdirSync(outDir, { recursive: true });
const file = join(outDir, 'if-sheet.png');
writeFileSync(file, sheet.toBuffer('image/png'));
console.log(`wrote ${file} (${sheetW}×${sheetH})`);
