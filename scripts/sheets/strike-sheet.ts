// The strike's sheet (impact design §4, WP5): what impact/strike.ts draws on
// S0..S6, for Qai to judge the look. Every row runs S0..S6 left to right:
//   1. centre: P in the middle of the app's 1080×608, striking straight down
//      (d (0, 1)) on the default floor, over the C15 grey, at half size;
//   2. the same at 1:1 round P, with what the plan put there marked over it:
//      P, the empty disc, the charge disc (it is only light, for the glow
//      sink), and the numbers each step measures;
//   3. edge: the hero's P (942, 1061) at the bottom edge, striking along
//      d (−0.06, 0.998) on his floor, over the clip's f76–f83 when --clip is
//      given (S3 is one drawing, from f79, shown on f79 and f80), otherwise
//      over a plate; half size;
//   4. the same at 1:1 round P;
//   5. calm: the edge row under Reduce flashing at flash-ladder step 3
//      (strikeOptions('safe', 3)): the multipliers clamped to 0.7–1.0, the
//      swell to 1.0·w_b, every red through G4.
// The limbs are stand-ins: four flat tubes from his back (the stand-in
// pose's shoulders on each frame) roped out round his flank and back in to
// P, still in flight on S0 (the app's rope limbs, F1, go round his body; the
// strike reads wherever they are and assumes no shape). Rows 1, 3 and 5 are
// composited with the strike's own glow (render/light.ts, gain 1, as the
// scene lays it), so their white share compares with the reference's k1–k6
// (1.0 / 0.6 / 0.2 / 2.4 / 1.1 / 11.0 %, min(R, G, B) ≥ 240); rows 2 and 4
// are the flat cels. Each step also measures the bundle's drawn width
// across it near P (0.03–0.09 S out) and the splash's share of the frame.
// Reads only local files: no network, no paid calls.
// Usage: node scripts/sheets/strike-sheet.ts --out <dir> [--clip clip.mp4]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import { nullSink, type FloorModel, type Palette, type Vec2 } from '../../src/impact/contracts.ts';
import { DEFAULT_FLOOR, strikeFrame } from '../../src/impact/floor.ts';
import { STRIKE, STRIKE_STEPS, paintStrike, planStrike, planStrikeContact, strikeFrames, strikeLimbOf, strikeOptions, type StrikeContext, type StrikeLimbPath, type StrikeOptions, type StrikePlan } from '../../src/impact/strike.ts';
import { buildTube, flatHeld } from '../../src/lift/tube.ts';
import type { BrushTarget } from '../../src/render/glow.ts';
import { nodeScratch } from '../../src/render/headless.ts';
import { createGlow } from '../../src/render/light.ts';
import { limbR0 } from '../../src/render/limb.ts';
import { readFrames } from '../probe/ffmpeg.ts';
import { assertOutsideRepo, parseArgs } from '../lib/out-dir.ts';

const USAGE = 'usage: node scripts/sheets/strike-sheet.ts --out <dir> [--clip clip.mp4]';
const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const args = parseArgs(process.argv.slice(2));
if (!args.out) throw new Error(USAGE);
const outDir = assertOutsideRepo(args.out, REPO);

const PALETTE: Palette = ['#e8203a', '#f4f1ea', '#16141a']; // the app's default
const W = 1080; // the app's internal frame
const H = 608;
const K = W / 1920; // clip px to app px
const I = 84; // his contact frame
const SEED = 84;
const SIGMA = 0.63; // sigmaOf his box on f84
const HERO_FLOOR: FloorModel = { ratio: 0.763, majorDeg: 2.6, up: [0.04, -1], persp: 0.68 }; // his slam's floor
const GREY = '#585858'; // compositing's C15 plate
const INK = '#111111';
const MUTED = '#555555';
const FONT = '15px sans-serif';
const THUMB = 0.5; // rows 1, 3 and 5
const CROP: Vec2 = [540, 304]; // rows 2 and 4, 1:1

type Ctx = SKRSContext2D;
const bt = (ctx: Ctx) => ctx as unknown as BrushTarget;

interface Cell {
  canvas: Canvas;
  label: string[];
}
interface Row {
  title: string;
  cells: Cell[];
}

function text(ctx: Ctx, s: string, x: number, y: number, color = INK, font = FONT) {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
}

// ---- The scenes ---------------------------------------------------------------------------------

interface Scene {
  name: string;
  ictx: StrikeContext;
  opts: StrikeOptions;
  limbs: (s: number) => StrikeLimbPath[];
  plate: (s: number) => Canvas;
}

const contextOf = (P: Vec2, d: Vec2, floor: FloorModel, flash: 'safe' | 'full'): StrikeContext => ({
  seed: SEED,
  frame: strikeFrame(P, d, Math.min(W, H), SIGMA, W, H, SEED),
  floor,
  width: W,
  height: H,
  palette: PALETTE,
  flash,
});

// The four test limbs' roots (impact/test-drawings.json, f22), in shoulder
// widths: across his back from the shoulders' midpoint, and down it.
const ROOTS: readonly Vec2[] = [
  [-0.214, 0.229],
  [0.243, 0.229],
  [-0.107, 0.573],
  [0.182, 0.573],
];

// His shoulders on f76–f83 in the stand-in pose (samples/hero/pose.json),
// clip px: their midpoint, and the vector from his right shoulder to his left.
const SHOULDERS: Readonly<Record<number, readonly [Vec2, Vec2]>> = {
  76: [[951.5, 177], [183, 8]],
  77: [[948.5, 231], [181, -18]],
  78: [[944, 304.5], [182, -11]],
  79: [[943.5, 377.5], [179, -33]],
  80: [[948.5, 450.5], [171, -81]],
  81: [[954, 511], [162, -80]],
  82: [[961, 564.5], [158, -81]],
  83: [[971, 625.5], [180, -33]],
};

// Four stand-in limbs from a back (its shoulders' midpoint and across
// vector, app px), roped round his body as the app's are (F1): each swings
// out past his flank on its own side, around, and in to P from the side, a
// cubic with a twist along it; on S0 still in flight, its tip out to its
// side and short of P. Through lift/tube.ts as the app's flat tubes, at the
// app's S.
function standIn(mid: Vec2, across: Vec2, P: Vec2, s: number): StrikeLimbPath[] {
  const w = Math.hypot(across[0], across[1]);
  const b: Vec2 = [across[0] / w, across[1] / w];
  const down: Vec2 = b[0] >= 0 ? [-b[1], b[0]] : [b[1], -b[0]];
  return ROOTS.map(([x, y], i) => {
    const R: Vec2 = [mid[0] + w * (x * b[0] + y * down[0]), mid[1] + w * (x * b[1] + y * down[1])];
    const side = x < 0 ? 1 : -1; // along the chord's left normal: the limbs left of his spine swing left
    const toP: Vec2 = [P[0] - R[0], P[1] - R[1]];
    const L0 = Math.hypot(toP[0], toP[1]);
    const n0: Vec2 = [-toP[1] / L0, toP[0] / L0];
    const E: Vec2 = s >= 1 ? P : [R[0] + 0.7 * toP[0] + side * 0.25 * L0 * n0[0], R[1] + 0.7 * toP[1] + side * 0.25 * L0 * n0[1]];
    const d: Vec2 = [E[0] - R[0], E[1] - R[1]];
    const L = Math.hypot(d[0], d[1]);
    const n: Vec2 = [-d[1] / L, d[0] / L];
    const reach = (0.3 + 0.08 * i) * L * side; // out past the flank, each limb its own way
    const c1: Vec2 = [R[0] + 0.15 * d[0] + reach * n[0], R[1] + 0.15 * d[1] + reach * n[1]];
    const c2: Vec2 = [R[0] + 0.75 * d[0] + 0.6 * reach * n[0], R[1] + 0.75 * d[1] + 0.6 * reach * n[1]];
    const count = 40;
    const pts = Array.from({ length: count }, (_, k): Vec2 => {
      const t = k / (count - 1);
      const [a0, a1, a2, a3] = [(1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t * t, t ** 3];
      const twist = 0.025 * L * Math.sin(3 * Math.PI * t) * Math.sin(Math.PI * t);
      return [a0 * R[0] + a1 * c1[0] + a2 * c2[0] + a3 * E[0] + twist * n[0], a0 * R[1] + a1 * c1[1] + a2 * c2[1] + a3 * E[1] + twist * n[1]];
    });
    const pressure = pts.map((_, k) => (k <= 4 ? 0.8 + 0.05 * k : 1 - (0.9 * (k - 4)) / (count - 5)));
    return strikeLimbOf(buildTube(flatHeld(i + 1, pts, pressure), limbR0(H)));
  });
}

const firstFrame = (s: number) => strikeFrames(s, I)[0];

function solid(color: string): Canvas {
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, W, H);
  return c;
}

// The clip's f76–f83 at the app's size, by ffmpeg; without --clip, a plate
// with the lumas round P (the wall Y 130, the floor Y 95).
function heroPlates(): { plate: (s: number) => Canvas; source: string } {
  const frames = Array.from({ length: STRIKE_STEPS }, (_, s) => firstFrame(s));
  if (args.clip) {
    const images = readFrames(args.clip, frames, W, H);
    const plates = new Map<number, Canvas>();
    for (const [f, img] of images) {
      const c = createCanvas(W, H);
      const ctx = c.getContext('2d');
      const data = ctx.createImageData(W, H);
      for (let i = 0; i < W * H; i++) {
        data.data[4 * i] = img.data[3 * i];
        data.data[4 * i + 1] = img.data[3 * i + 1];
        data.data[4 * i + 2] = img.data[3 * i + 2];
        data.data[4 * i + 3] = 255;
      }
      ctx.putImageData(data, 0, 0);
      plates.set(f, c);
    }
    return { plate: (s) => plates.get(firstFrame(s))!, source: `the clip’s f${frames[0]}–f${frames[frames.length - 1]}` };
  }
  const c = solid('#828282');
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#5f5f5f';
  ctx.fillRect(0, 470, W, H - 470);
  return { plate: () => c, source: 'a plate with the lumas round P (pass --clip for the footage)' };
}

const heroP: Vec2 = [942 * K, 1061 * K];
const heroD: Vec2 = [-0.06, 0.998];
const heroLimbs = (s: number) => {
  const [mid, across] = SHOULDERS[firstFrame(s)];
  return standIn([mid[0] * K, mid[1] * K], [across[0] * K, across[1] * K], heroP, s);
};
const centreP: Vec2 = [W / 2, H / 2];
const centreLimbs = (s: number) => standIn([centreP[0], 40], [100, 0], centreP, s);

const hero = heroPlates();
const grey = solid(GREY);
const SCENES = {
  centre: { name: 'centre', ictx: contextOf(centreP, [0, 1], DEFAULT_FLOOR, 'full'), opts: strikeOptions('full'), limbs: centreLimbs, plate: () => grey },
  edge: { name: 'edge', ictx: contextOf(heroP, heroD, HERO_FLOOR, 'full'), opts: strikeOptions('full'), limbs: heroLimbs, plate: hero.plate },
  calm: { name: 'calm', ictx: contextOf(heroP, heroD, HERO_FLOOR, 'safe'), opts: strikeOptions('safe', 3), limbs: heroLimbs, plate: hero.plate },
} satisfies Record<string, Scene>;

// ---- Drawing and measuring a step -------------------------------------------------------------

interface Step {
  s: number;
  plan: StrikePlan;
  frame: Canvas; // the plate with the strike and its glow over it, W × H
  flat: Canvas; // the plate with the cels alone
  widths: number[]; // each beam's mean width over its body ÷ its target
  ratio: number; // target ÷ w_b
  area: number; // the splash's drawn area ÷ its target (NaN without one)
  splash: number; // the splash's drawn area, % of the frame
  white: number; // % of the composited frame at min(R, G, B) ≥ 240
  bundle: number; // the drawn width across the lead, 0.03–0.09 S from P, mean, × S
  core: number[]; // each beam's core share
}

// The drawn width across the lead `at` px from P along it: the opaque
// pixels on the perpendicular there.
function widthAcross(data: Uint8ClampedArray, plan: StrikePlan, P: Vec2, at: number): number {
  const lead = plan.beams.find((b) => b.role === 'lead');
  if (!lead) return NaN;
  const off = (p: Vec2) => Math.abs(Math.hypot(p[0] - P[0], p[1] - P[1]) - at);
  const st = lead.stations.reduce((best, x) => (off(x.p) < off(best.p) ? x : best));
  const len = Math.hypot(st.p[0] - P[0], st.p[1] - P[1]);
  if (!(len > 0)) return NaN;
  const dir: Vec2 = [(st.p[0] - P[0]) / len, (st.p[1] - P[1]) / len];
  const c: Vec2 = [P[0] + dir[0] * at, P[1] + dir[1] * at];
  let run = 0;
  for (let k = -400; k <= 400; k += 0.5) {
    const x = Math.floor(c[0] - dir[1] * k);
    const y = Math.floor(c[1] + dir[0] * k);
    if (x >= 0 && y >= 0 && x < W && y < H && data[(y * W + x) * 4 + 3] > 127) run += 0.5;
  }
  return run;
}

const alpha = (scene: Scene, plan: StrikePlan) => {
  const c = createCanvas(W, H).getContext('2d');
  paintStrike(bt(c), nullSink, scene.ictx, plan);
  return c.getImageData(0, 0, W, H).data;
};

function drawStep(scene: Scene, s: number): Step {
  const plan = planStrike(scene.ictx, s, scene.limbs(s), scene.opts);
  const { P, S } = scene.ictx.frame;
  const flat = createCanvas(W, H);
  const fctx = flat.getContext('2d');
  fctx.drawImage(scene.plate(s), 0, 0);
  paintStrike(bt(fctx), nullSink, scene.ictx, plan);
  const frame = createCanvas(W, H);
  const ctx = frame.getContext('2d');
  ctx.drawImage(scene.plate(s), 0, 0);
  const glow = createGlow(nodeScratch, W, H, { main: PALETTE[0] });
  paintStrike(bt(ctx), glow, scene.ictx, plan);
  glow.composite(bt(ctx), 1);
  const px = ctx.getImageData(0, 0, W, H).data;
  let hot = 0;
  for (let i = 0; i < px.length; i += 4) if (Math.min(px[i], px[i + 1], px[i + 2]) >= 240) hot++;
  const widths = plan.beams.map((b) => {
    const [a, z] = b.body;
    let sum = 0;
    for (let i = a; i <= z; i++) sum += b.stations[i].left + b.stations[i].right;
    return sum / (z - a + 1) / b.target;
  });
  let area = NaN;
  let splash = 0;
  if (plan.splash) {
    const data = alpha(scene, { ...plan, beams: [], bursts: [], flare: null, charge: null });
    let sum = 0;
    for (let i = 3; i < data.length; i += 4) sum += data[i];
    area = sum / 255 / plan.splash.target;
    splash = (100 * sum) / 255 / (W * H);
  }
  const beamsAlone = alpha(scene, { ...plan, splash: null, bursts: [], flare: null, charge: null });
  const across = [0.03, 0.06, 0.09].map((k) => widthAcross(beamsAlone, plan, P, k * S)).filter((x) => x > 0);
  const bundle = across.length ? across.reduce((a, b) => a + b, 0) / across.length / S : NaN;
  const beam = plan.beams.find((b) => b.role !== 'strand') ?? plan.beams[0];
  return { s, plan, frame, flat, widths, ratio: beam ? beam.target / beam.base : NaN, area, splash, white: (100 * hot) / (W * H), bundle, core: plan.beams.map((b) => b.coreShare) };
}

const range = (xs: number[], digits = 2) => {
  if (!xs.length) return '–';
  const lo = Math.min(...xs).toFixed(digits);
  const hi = Math.max(...xs).toFixed(digits);
  return lo === hi ? lo : `${lo}–${hi}`;
};

function stepTitle(s: number): string {
  const frames = strikeFrames(s, I);
  const js = frames.map((f) => `${f - I}`.replace('-', '−'));
  return `S${s} · j ${js.join(', ')} · f${frames.join(', f')}${frames.length > 1 ? ' (one drawing)' : ''}`;
}

function thumb(step: Step, scene: Scene): Cell {
  const canvas = createCanvas(W * THUMB, H * THUMB);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(step.frame, 0, 0, W * THUMB, H * THUMB);
  const { s, plan } = step;
  const S = scene.ictx.frame.S;
  const swollen = s === 6 && scene.opts.swell && !scene.opts.calm;
  const what = [
    s === 0 ? `${plan.beams.length} heads out of the limb ends` : swollen ? `swell ${(Math.max(...plan.beams.map((b) => b.target)) / S).toFixed(3)} S` : `${step.ratio.toFixed(2)} w_b (m ${STRIKE.mult[s]})`,
    plan.splash ? `splash ${step.splash.toFixed(1)} % of the frame (${STRIKE.splash[s]}${scene.ictx.flash === 'safe' ? ' × σ²' : ''}), ${plan.splash.pieces.length} pieces` : 'no splash',
  ];
  const light = [
    `white ${step.white.toFixed(2)} %`,
    Number.isNaN(step.bundle) ? '' : `bundle ${step.bundle.toFixed(3)} S at P`,
    plan.bursts.length ? `burst ${plan.bursts.length} arcs (${plan.bursts.filter((a) => a.mirrored).length} mirrored)` : '',
    plan.flare ? 'flare' : '',
  ].filter(Boolean);
  return { canvas, label: [stepTitle(s), what.join(' · '), light.join(' · ')] };
}

function detail(step: Step, scene: Scene): Cell {
  const { P, U, S } = scene.ictx.frame;
  const x0 = Math.round(Math.min(W - CROP[0], Math.max(0, P[0] - CROP[0] / 2)));
  const y0 = Math.round(Math.min(H - CROP[1], Math.max(0, P[1] - CROP[1] / 2)));
  const canvas = createCanvas(CROP[0], CROP[1]);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(step.flat, x0, y0, CROP[0], CROP[1], 0, 0, CROP[0], CROP[1]);
  const p: Vec2 = [P[0] - x0, P[1] - y0];
  const { plan } = step;
  ctx.lineWidth = 1.5;
  if (plan.splash) {
    ctx.strokeStyle = '#5fd3ff';
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.arc(p[0], p[1], plan.splash.disc, 0, 2 * Math.PI);
    ctx.stroke();
  }
  if (plan.charge) {
    ctx.strokeStyle = '#ffe14d';
    ctx.setLineDash([1.5, 3]);
    ctx.beginPath();
    ctx.arc(p[0], p[1], plan.charge.r, 0, 2 * Math.PI);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.strokeStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(p[0] - 6, p[1]);
  ctx.lineTo(p[0] + 6, p[1]);
  ctx.moveTo(p[0], p[1] - 6);
  ctx.lineTo(p[0], p[1] + 6);
  ctx.stroke();
  const sp = plan.splash;
  const teeth = plan.beams.reduce((n, b) => n + b.teeth.length, 0);
  const first = [`beams ${range(step.widths)}× their width`, `core ${range(step.core)} (${STRIKE.coreShare[step.s]})`, plan.s === 6 && !scene.opts.calm ? `S6 ${(Math.max(...plan.beams.map((b) => b.target)) / S).toFixed(3)} S, ${teeth} teeth` : ''].filter(Boolean);
  const second = sp
    ? [`splash ${step.area.toFixed(3)}× its area`, `${Math.round(100 * sp.share)} % on ${sp.side > 0 ? '+v' : '−v'}`, `disc ${(sp.disc / U).toFixed(3)} U`, plan.charge ? `c ${plan.charge.c}` : ''].filter(Boolean)
    : ['no splash', plan.charge ? `c ${plan.charge.c}` : 'no charge'];
  return { canvas, label: [first.join(' · '), second.join(' · ')] };
}

// ---- Timing -----------------------------------------------------------------------------------------

// Per step on the edge scene at 1080×608, medians of 10 seeds: planning
// what goes round P (it doesn't read the limbs, so it can be planned ahead),
// planning the beams, and painting, the canvas flushed (Skia records the
// path calls and fills them when the pixels are read).
interface Timing {
  contact: number[];
  beams: number[];
  paint: number[];
}
function timing(scene: Scene): Timing {
  const target = createCanvas(W, H).getContext('2d');
  const limbs = Array.from({ length: STRIKE_STEPS }, (_, s) => scene.limbs(s));
  const median = (xs: number[]) => {
    const a = [...xs].sort((p, q) => p - q);
    return (a[4] + a[5]) / 2;
  };
  for (let warm = 0; warm < 3; warm++) for (let s = 0; s < STRIKE_STEPS; s++) paintStrike(bt(target), nullSink, scene.ictx, planStrike({ ...scene.ictx, seed: 900 + warm }, s, limbs[s], scene.opts));
  const out: Timing = { contact: [], beams: [], paint: [] };
  for (let s = 0; s < STRIKE_STEPS; s++) {
    const a: number[] = [];
    const b: number[] = [];
    const c: number[] = [];
    for (let i = 0; i < 10; i++) {
      const ictx = { ...scene.ictx, seed: 100 + i };
      target.clearRect(0, 0, W, H);
      target.getImageData(0, 0, 1, 1);
      const t0 = performance.now();
      const contact = planStrikeContact(ictx, s);
      const t1 = performance.now();
      const p = planStrike(ictx, s, limbs[s], scene.opts, contact);
      const t2 = performance.now();
      paintStrike(bt(target), nullSink, ictx, p);
      target.getImageData(0, 0, 1, 1);
      const t3 = performance.now();
      a.push(t1 - t0);
      b.push(t2 - t1);
      c.push(t3 - t2);
    }
    out.contact.push(median(a));
    out.beams.push(median(b));
    out.paint.push(median(c));
  }
  return out;
}

// ---- The sheet ----------------------------------------------------------------------------------

const steps = (scene: Scene) => Array.from({ length: STRIKE_STEPS }, (_, s) => drawStep(scene, s));
const centre = steps(SCENES.centre);
const edge = steps(SCENES.edge);
const calm = steps(SCENES.calm);
const ms = timing(SCENES.edge);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const fmtP = (p: Vec2) => `(${p[0].toFixed(1)}, ${p[1].toFixed(1)})`;

const rows: Row[] = [
  { title: `Centre: P ${fmtP(centreP)} in the app’s 1080×608, d (0, 1), the default floor (ratio 0.5), sigma ${SIGMA}, over the C15 grey, with its glow (half size)`, cells: centre.map((st) => thumb(st, SCENES.centre)) },
  { title: 'Centre at 1:1 round P, the flat cels: P (cross), the empty disc (dashed), the charge disc (dotted: it is only light, for the glow sink)', cells: centre.map((st) => detail(st, SCENES.centre)) },
  { title: `Edge: the hero’s P (942, 1061), at ${fmtP(heroP)} in the app, d (−0.06, 0.998), his floor (ratio 0.763, up (0.04, −1)), over ${hero.source}, with its glow (half size)`, cells: edge.map((st) => thumb(st, SCENES.edge)) },
  { title: 'Edge at 1:1 round P, the flat cels: splash pieces and burst arcs the frame cuts are mirrored back in, each splash side sized to what shows', cells: edge.map((st) => detail(st, SCENES.edge)) },
  { title: 'Calm: the edge under Reduce flashing at flash-ladder step 3, strikeOptions(‘safe’, 3): m clamped to 0.7–1.0, S6 at 1.0·w_b, G4’s tones, with its glow (half size)', cells: calm.map((st) => thumb(st, SCENES.calm)) },
];

const PAD = 16;
const GAP = 8;
const TITLE = 34;
const LINE = 18;
const BANNER = [
  'Strike (impact WP5, design §4): impact/strike.ts, limbs first (decision 2): S0..S6 on j −8..−1, s = kr(j), so S3 holds j −5 and −4. Rope-like stand-in limbs, not Qai’s.',
  `Beams w_b·m[s], w_b = max(2·r_max, 0.05 S), m ${STRIKE.mult.join(' / ')}, one bundle near P that widens into it (×${STRIKE.contactEnd.slice(1, 6).join(' / ')}); S6's last 40 % swells to 0.30–0.38 S with accent teeth; S0's heads run a third of the way to P out of the limb ends.`,
  `Splash in the accent, ${STRIKE.splash.join(' / ')} % of the frame (× σ² under Reduce flashing only), pieces ${STRIKE.pieces.join(' / ')}; bursts on S1, S4, S5, mirrored onto the frame; a white flare star at P on S1 and S4. Reference white k1–k6: 1.0 / 0.6 / 0.2 / 2.4 / 1.1 / 11.0 %.`,
  `Palette p0 ${PALETTE[0]}, p1 ${PALETTE[1]}, p2 ${PALETTE[2]}. Full flashing (the default) on rows 1–4. Rows 1, 3 and 5 composite the strike's glow at gain 1, the charge disc in it.`,
  `Node, edge scene at 1080×608, per step on average (medians of 10): ${mean(ms.contact).toFixed(1)} ms planning round P (splash, bursts, charge: no limbs, so it can be planned ahead) + ${mean(ms.beams).toFixed(1)} ms the beams + ${mean(ms.paint).toFixed(1)} ms painting; S6 ${ms.contact[6].toFixed(1)} + ${ms.beams[6].toFixed(1)} + ${ms.paint[6].toFixed(1)}. Design §10's proxy budget: 6 ms.`,
];
const rowWidth = (r: Row) => r.cells.reduce((w, c) => w + c.canvas.width, 0) + GAP * (r.cells.length - 1);
const rowHeight = (r: Row) => TITLE + Math.max(...r.cells.map((c) => c.canvas.height)) + 8 + LINE * Math.max(...r.cells.map((c) => c.label.length)) + PAD;
const width = Math.max(...rows.map(rowWidth)) + 2 * PAD;
const top = PAD + BANNER.length * 22 + 8;
const sheet = createCanvas(width, top + rows.reduce((h, r) => h + rowHeight(r), 0));
const ctx = sheet.getContext('2d');
ctx.fillStyle = '#ffffff';
ctx.fillRect(0, 0, sheet.width, sheet.height);
BANNER.forEach((l, i) => text(ctx, l, PAD, PAD + 16 + i * 22, i === 0 ? '#b0122a' : INK, i === 0 ? 'bold 17px sans-serif' : FONT));
let y = top;
for (const row of rows) {
  text(ctx, row.title, PAD, y + 22, INK, 'bold 17px sans-serif');
  let x = PAD;
  const h = Math.max(...row.cells.map((c) => c.canvas.height));
  for (const c of row.cells) {
    ctx.drawImage(c.canvas, x, y + TITLE);
    c.label.forEach((l, i) => text(ctx, l, x, y + TITLE + h + 8 + 13 + i * LINE, i === 0 ? INK : MUTED, i === 0 ? FONT : '14px sans-serif'));
    x += c.canvas.width + GAP;
  }
  y += rowHeight(row);
}
mkdirSync(outDir, { recursive: true });
const file = join(outDir, 'strike-sheet.png');
writeFileSync(file, sheet.toBuffer('image/png'));

const report = (name: string, list: Step[]) =>
  list
    .map((st) => {
      const splash = Number.isNaN(st.area) ? '–' : `${st.splash.toFixed(2)} % of the frame, ${st.area.toFixed(3)}× its target, ${st.plan.splash!.pieces.length} pieces`;
      const bursts = `${st.plan.bursts.length} (${st.plan.bursts.filter((a) => a.mirrored).length} mirrored)`;
      return `${name} S${st.s}: white ${st.white.toFixed(2)} %; bundle ${Number.isNaN(st.bundle) ? '–' : `${st.bundle.toFixed(3)} S`}; beams ${range(st.widths, 3)}× width, ${st.ratio.toFixed(3)} w_b; splash ${splash}; bursts ${bursts}; flare ${st.plan.flare ? 'yes' : 'no'}`;
    })
    .join('\n');
// S6's swell over S4's bundle (≈3× in the reference), and the white S6 ÷ S1 (≥ 3×; 11× in the reference).
const swellOver = (list: Step[]) => {
  const swell = Math.max(...list[6].plan.beams.map((b) => b.target)) / SCENES.edge.ictx.frame.S;
  return `S6 swell ${swell.toFixed(3)} S ÷ S4 bundle ${list[4].bundle.toFixed(3)} S = ${(swell / list[4].bundle).toFixed(2)}×; white S6 ÷ S1 = ${(list[6].white / list[1].white).toFixed(2)}×`;
};
process.stdout.write(
  `strike sheet: ${file} (${sheet.width}×${sheet.height})\n` +
    `ms per step, S0..S6: contact ${ms.contact.map((v) => v.toFixed(2)).join(' ')}; beams ${ms.beams.map((v) => v.toFixed(2)).join(' ')}; paint ${ms.paint.map((v) => v.toFixed(2)).join(' ')}\n` +
    `${report('centre', centre)}\n${report('edge', edge)}\n${report('calm', calm)}\n` +
    `centre: ${swellOver(centre)}\nedge: ${swellOver(edge)}\n`,
);
