// The electricity's sheet (impact design §3, WP4): what render/arcs3d.ts and
// render/pulse.ts draw, at 1:1, for Qai to judge the look. Rows:
//   1–3. every phase on a straight synthetic tube (syntheticTube) on the
//        hero's clocks (limbs drawn on k 8, contact I 84): the emergence, the
//        pop, idle, the coil, the strike window, the aftermath with its
//        tip → P arc, and the phone tier's cut;
//   4. a tube bending through depth, and its far/near split drawn as lines;
//   5. timing: an idle limb on k 40–43, each placement held for a pair and
//      crawling on its second drawing, the shapes new on every drawing;
//   6–7. a cord pulse travelling over 6 drawings to its tip pop, then both
//      kinds of pop at ×2;
//   8. the arc tones on three limb colours, and the flicker on the 1s clock;
//   9. 24 arcs at 1080×608 (4 limbs in the strike window), timed, and the
//      aftermath's arcs from the tips down to P.
// The tube under the arcs is a flat stand-in: p0 with a dark outline, its
// radius bulged by the pulses the way WP3's limb bulges it, with a pale core
// through each bulge. The shaded limb is WP3's and the glow WP10's, so neither
// is drawn here. Synthetic rows at S 1080 (the 1080p export's scale), the last
// row at S 608 (the app's 1080×608). Reads no files; no network, no paid calls.
// Usage: node scripts/sheets/arcs-sheet.ts --out <dir>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, Path2D, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import { syntheticTube, type Palette, type PulseSpan, type Tube, type TubeSection, type Vec2, type Vec3 } from '../../src/impact/contracts.ts';
import { c1 } from '../../src/impact/clock.ts';
import { mixHex, toOklch } from '../../src/impact/palette.ts';
import {
  ARC_TONES,
  ARC_WIDTH,
  GROWN,
  arcFlicker,
  arcPhase,
  arcPlans,
  arcTones,
  drawArcs,
  sectionAt,
  sheathArcs,
  shownOf,
  type ArcPhase,
  type ArcTones,
  type LinePath,
  type SheathArcs,
} from '../../src/render/arcs3d.ts';
import { drawPops, limbClock, popShape, pulseCentres, pulseStarts, pulseTimeline, pulsesAt, type Pop } from '../../src/render/pulse.ts';
import { assertOutsideRepo, parseArgs } from '../lib/out-dir.ts';

const USAGE = 'usage: node scripts/sheets/arcs-sheet.ts --out <dir>';
const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const args = parseArgs(process.argv.slice(2));
if (!args.out) throw new Error(USAGE);
const outDir = assertOutsideRepo(args.out, REPO);

const S = 1080; // the synthetic rows' short side: arcs 8 px wide, r 21.6 px
const R0 = 0.02 * S;
const LINE_W = 0.0031; // × S: the stand-in's outline (WP3's limb outline)
const PALETTE: Palette = ['#e8203a', '#f4f1ea', '#16141a']; // the app's default, and the test drawings'
const HERO = { emerge: 8, I: 84, P: [530, 597] as Vec2 }; // limbs drawn on f22 (k 8), contact on f84; P at 1080×608
const TL = pulseTimeline(HERO.emerge, HERO.I); // from 14, charge [28, 44]
const ID = 7;
const GREY = '#585858'; // compositing's C15 plate
const INK = '#111111';
const MUTED = '#555555';
// The canvas font has no Greek, so the labels spell nu_z and phi out.
const FONT = '15px sans-serif';
const SMALL = '14px sans-serif';
const CW = 520; // a synthetic cell
const CH = 240;
const newPath = (): LinePath => new Path2D(); // Node has no global Path2D: drawArcs takes @napi-rs/canvas's

type Ctx = SKRSContext2D;

interface Cell {
  canvas: Canvas;
  label: string[]; // one or two lines under it
}
interface Row {
  title: string;
  cells: Cell[];
}

// A cell on the plate; `draw` paints it and returns its label.
function cell(w: number, h: number, draw: (ctx: Ctx) => string[], bg = GREY): Cell {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  const label = draw(ctx);
  return { canvas, label };
}

function text(ctx: Ctx, s: string, x: number, y: number, color = INK, font = FONT) {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
}

function cross(ctx: Ctx, [x, y]: Vec2, label = 'P', color = '#ffffff', r = 7) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x - r, y);
  ctx.lineTo(x + r, y);
  ctx.moveTo(x, y - r);
  ctx.lineTo(x, y + r);
  ctx.stroke();
  text(ctx, label, x + r + 3, y - 4, color, SMALL);
}

// ---- Tubes ----------------------------------------------------------------------------------------

const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale3 = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const unit3 = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

// Design §2's radius profile, with full pressure.
const profile = (R: number) => (t: number) => Math.max(0.8, R * (1 + 0.22 * Math.max(0, 1 - t / 0.14) ** 2) * (1 - t) ** 0.55);

// A tube along a 3D curve (x, y on screen, z toward the camera), framed the
// way design §2 frames one: sections at equal arc length, central-difference
// tangents, and a double-reflection rotation-minimizing frame from the root's
// screen normal. Seen orthographically.
function curveTube(curve: (t: number) => Vec3, n: number, radius: (s: number) => number, id: number): Tube {
  const M = 4000;
  const dense = Array.from({ length: M + 1 }, (_, i) => curve(i / M));
  const cum = [0];
  for (let i = 1; i <= M; i++) cum.push(cum[i - 1] + Math.hypot(...sub3(dense[i], dense[i - 1])));
  const length = cum[M];
  const cs: Vec3[] = [];
  for (let q = 0, i = 0; q < n; q++) {
    const target = (length * q) / (n - 1);
    while (i < M - 1 && cum[i + 1] < target) i++;
    const f = Math.min(1, Math.max(0, (target - cum[i]) / (cum[i + 1] - cum[i] || 1)));
    cs.push([0, 1, 2].map((d) => dense[i][d] + (dense[i + 1][d] - dense[i][d]) * f) as Vec3);
  }
  const Ts = cs.map((_, i) => unit3(sub3(cs[Math.min(n - 1, i + 1)], cs[Math.max(0, i - 1)])));
  const n0: Vec3 = unit3([-Ts[0][1], Ts[0][0], 0]);
  const Ns: Vec3[] = [unit3(sub3(n0, scale3(Ts[0], dot3(n0, Ts[0]))))];
  for (let i = 0; i < n - 1; i++) {
    const v1 = sub3(cs[i + 1], cs[i]);
    const k1 = dot3(v1, v1);
    const rL = sub3(Ns[i], scale3(v1, (2 / k1) * dot3(v1, Ns[i])));
    const tL = sub3(Ts[i], scale3(v1, (2 / k1) * dot3(v1, Ts[i])));
    const v2 = sub3(Ts[i + 1], tL);
    const k2 = dot3(v2, v2);
    Ns.push(unit3(k2 > 1e-18 ? sub3(rL, scale3(v2, (2 / k2) * dot3(v2, rL))) : rL));
  }
  const sections = cs.map((c, i): TubeSection => {
    const s = i / (n - 1);
    const t2 = Math.hypot(Ts[i][0], Ts[i][1]) || 1;
    return { c, T: Ts[i], N: Ns[i], B: cross3(Ts[i], Ns[i]), r: radius(s), s, front: true, screen: [c[0], c[1]], normal: [-Ts[i][1] / t2, Ts[i][0] / t2] };
  });
  return { id, sections, length };
}

// The straight synthetic tube of rows 1–3 and 5–8: N down the screen, B toward
// the camera, so ν_z = sin φ.
const straight = (id = ID) => syntheticTube(94, 446, R0, [37, 100], id);
const xOn = (s: number) => 37 + 446 * s; // its centreline's x at s
const P_CELL: Vec2 = [436, 222]; // P in a synthetic cell, below the tip

// The hero's four limbs at 1080×608, as the arcs test times them.
function heroLimbs(): Tube[] {
  const r0 = 0.02 * 608;
  const limbs: [Vec2, number, number, number][] = [
    [[520, 170], 251, 0.35, 1],
    [[560, 170], 252, -0.3, 1],
    [[500, 200], 243, 0.6, -1],
    [[580, 200], 245, -0.6, -1],
  ];
  return limbs.map(([root, length, tilt, bend], i) => {
    const dir: Vec2 = [Math.sin(tilt), Math.cos(tilt)];
    const perp: Vec2 = [-dir[1], dir[0]];
    return curveTube(
      (t) => [
        root[0] + length * 0.97 * (dir[0] * t) + 30 * bend * Math.sin(Math.PI * t) * perp[0],
        root[1] + length * 0.97 * (dir[1] * t) + 30 * bend * Math.sin(Math.PI * t) * perp[1],
        40 * Math.sin(Math.PI * t * 1.3) * bend,
      ],
      94,
      profile(r0),
      11 + i,
    );
  });
}

// ---- The stand-in limb and the electricity ------------------------------------------------------

interface Look {
  body: string;
  line: string;
  core: string;
}
const lookOf = (p: Palette): Look => ({ body: p[0], line: mixHex(p[0], p[2], 0.75), core: mixHex(p[1], p[0], 0.15) });
const RED = lookOf(PALETTE);

// A pulse's weight at s: a raised cosine over its length, as WP3's limb has it.
function bump(p: PulseSpan, s: number): number {
  const x = Math.abs(s - p.s) / (p.len / 2);
  return p.len > 0 && x < 1 ? 0.5 * (1 + Math.cos(Math.PI * x)) : 0;
}

// The stand-in: the tube's flat silhouette up to `shown` of its length, with
// round ends, the radius × (1 + (scale − 1)·bump) in a pulse, and a pale core
// ±core·bump·r about the centreline there.
function drawTube(ctx: Ctx, tube: Tube, look: Look, scaleS: number, shown = 1, pulses: readonly PulseSpan[] = []) {
  const n = 160;
  const samples = Array.from({ length: n + 1 }, (_, i) => {
    const s = (shown * i) / n;
    const p = sectionAt(tube, s);
    let w = 0;
    let pulse: PulseSpan | null = null;
    for (const q of pulses) {
      const b = bump(q, s);
      if (b > w) [w, pulse] = [b, q];
    }
    return { p, r: p.r * (pulse ? 1 + (pulse.scale - 1) * w : 1), core: pulse ? pulse.core * w : 0 };
  });
  const side = (i: number, k: number): Vec2 => {
    const { p, r } = samples[i];
    return [p.screen[0] + k * r * p.normal[0], p.screen[1] + k * r * p.normal[1]];
  };
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const [x, y] = side(i, 1);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  const end = samples[n];
  const a1 = Math.atan2(end.p.normal[1], end.p.normal[0]);
  ctx.arc(end.p.screen[0], end.p.screen[1], end.r, a1, a1 - Math.PI, true); // round the tip, the way the tangent points
  for (let i = n; i >= 0; i--) ctx.lineTo(...side(i, -1));
  const start = samples[0];
  const a0 = Math.atan2(start.p.normal[1], start.p.normal[0]);
  ctx.arc(start.p.screen[0], start.p.screen[1], start.r, a0 + Math.PI, a0, true); // and round the root
  ctx.closePath();
  ctx.fillStyle = look.body;
  ctx.fill();
  ctx.lineJoin = 'round';
  ctx.lineWidth = LINE_W * scaleS;
  ctx.strokeStyle = look.line;
  ctx.stroke();
  // The pulses' cores, one polygon a run of samples inside a bulge.
  ctx.fillStyle = look.core;
  for (let i = 0; i <= n; ) {
    if (samples[i].core <= 0) {
      i++;
      continue;
    }
    const from = Math.max(0, i - 1);
    while (i <= n && samples[i].core > 0) i++;
    const to = Math.min(n, i);
    ctx.beginPath();
    for (let q = from; q <= to; q++) {
      const { p, r, core } = samples[q];
      const [x, y] = [p.screen[0] + core * r * p.normal[0], p.screen[1] + core * r * p.normal[1]];
      if (q === from) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    for (let q = to; q >= from; q--) {
      const { p, r, core } = samples[q];
      ctx.lineTo(p.screen[0] - core * r * p.normal[0], p.screen[1] - core * r * p.normal[1]);
    }
    ctx.closePath();
    ctx.fill();
  }
}

interface Scene {
  k: number; // limbClock
  phase: ArcPhase;
  S?: number; // missing = 1080
  P?: Vec2;
  fewer?: boolean;
  look?: Look;
  tones?: ArcTones;
  pulses?: readonly PulseSpan[];
  pops?: readonly Pop[];
}

// The far arcs, the stand-in tube over them, then the near arcs and the pops:
// the order the stack draws them in.
function drawLimbArcs(ctx: Ctx, tube: Tube, sc: Scene): SheathArcs {
  const scaleS = sc.S ?? S;
  const tones = sc.tones ?? ARC_TONES;
  const out = sheathArcs(tube, sc.k, sc.phase, tube.id, { S: scaleS, P: sc.P ?? null, fewer: sc.fewer });
  drawArcs(ctx, out.far, tones, newPath);
  drawTube(ctx, tube, sc.look ?? RED, scaleS, shownOf(sc.phase), sc.pulses);
  drawArcs(ctx, out.near, tones, newPath);
  if (sc.pops?.length) drawPops(ctx, tube, sc.pops, tones);
  return out;
}

function stats(out: SheathArcs): string {
  const runs = [...out.far, ...out.near];
  const arcs = new Set(runs.filter((r) => r.kind === 'sheath').map((r) => r.arc)).size;
  const tips = runs.filter((r) => r.kind === 'tip').length;
  return `${arcs} arcs${tips ? ` + ${tips} tip arc` : ''} in ${out.far.length} far runs and ${out.near.length - tips} near`;
}

const kAt = (j: number) => limbClock(HERO.I + j, HERO.I);
const phaseOf = (age: number | null, j: number | null): ArcPhase => {
  const phase = arcPhase(age, j);
  if (!phase) throw new Error(`no arcs at age ${age}, j ${j}`);
  return phase;
};

function phaseCell(tube: Tube, title: string, sc: Scene): Cell {
  return cell(CW, CH, (ctx) => {
    const out = drawLimbArcs(ctx, tube, sc);
    if (sc.P) cross(ctx, sc.P);
    return [title, stats(out)];
  });
}

// ---- Rows ---------------------------------------------------------------------------------------

function emergenceRow(): Row {
  const cells = [0, 1, 2, 3].map((age) =>
    phaseCell(straight(), `age ${age} (k ${HERO.emerge + age}): grows to ${Math.round(100 * GROWN[age])} % of L; 2 arcs`, { k: HERO.emerge + age, phase: phaseOf(age, null) }),
  );
  return { title: 'Emergence, ages 0–3, on a straight synthetic tube (N down the screen, B toward the camera, so nu_z = sin phi): far runs go under the tube, near runs over it', cells };
}

function popIdleRow(): Row {
  return {
    title: 'The pop, idle and the coil (the hero’s clocks: limbs drawn on k 8, contact I 84; k is limbClock)',
    cells: [
      phaseCell(straight(), `age 4 (k ${HERO.emerge + 4}): the pop, flash 1.0: twice the idle count, cores 0.6 w`, { k: HERO.emerge + 4, phase: phaseOf(4, null) }),
      phaseCell(straight(), `age 5 (k ${HERO.emerge + 5}): flash 0.5, cores 0.45 w`, { k: HERO.emerge + 5, phase: phaseOf(5, null) }),
      phaseCell(straight(), 'idle (k 40): limb.arcs 3, the low crackle after the pop', { k: 40, phase: phaseOf(null, null) }),
      phaseCell(straight(), `coil, j −12 (k ${kAt(-12)}): still 3, while the pulses quicken`, { k: kAt(-12), phase: phaseOf(null, -12) }),
    ],
  };
}

function strikeRow(): Row {
  return {
    title: 'The strike window and the aftermath (the posters, j 0..8, carry no electricity: with frames.count 0 the strike count shows there)',
    cells: [
      phaseCell(straight(), `strike window, j −5 (k ${kAt(-5)}): twice the idle count; k steps on kr`, { k: kAt(-5), phase: phaseOf(null, -5) }),
      phaseCell(straight(), `aftermath, j 14 (k ${kAt(14)}): plus an arc from the tip onto P (j 9..20)`, { k: kAt(14), phase: phaseOf(null, 14), P: P_CELL }),
      phaseCell(straight(), `aftermath, j 25 (k ${kAt(25)}): the tip arc ended at j 20`, { k: kAt(25), phase: phaseOf(null, 25), P: P_CELL }),
      phaseCell(straight(), `phone tier, j −5 (k ${kAt(-5)}): cut 6 keeps the idle 3`, { k: kAt(-5), phase: phaseOf(null, -5), fewer: true }),
    ],
  };
}

function bentRow(): Row {
  const tube = curveTube((t) => [50 + 420 * t, 120 + 55 * Math.sin(2 * Math.PI * t), 90 * Math.sin(Math.PI * t)], 94, profile(R0), ID);
  const P: Vec2 = [424, 226];
  const split = cell(CW, CH, (ctx) => {
    const out = sheathArcs(tube, kAt(-5), phaseOf(null, -5), tube.id, { S });
    // The tube's silhouette, dashed.
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.lineWidth = 1.5;
    for (const k of [1, -1]) {
      ctx.beginPath();
      tube.sections.forEach((sec, i) => {
        const x = sec.screen[0] + k * sec.r * sec.normal[0];
        const y = sec.screen[1] + k * sec.r * sec.normal[1];
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
    ctx.restore();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const [runs, color] of [[out.far, '#ff9a3c'], [out.near, '#5fe6ff']] as const) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      for (const run of runs) {
        ctx.beginPath();
        run.points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        ctx.stroke();
      }
    }
    ctx.fillStyle = '#ffffff';
    let shared = 0;
    for (const run of out.far) {
      for (const i of [0, run.points.length - 1]) {
        if (run.nz[i] !== 0) continue;
        ctx.beginPath();
        ctx.arc(run.points[i][0], run.points[i][1], 3, 0, 2 * Math.PI);
        ctx.fill();
        shared++;
      }
    }
    return [`the split on j −5: far runs orange, near runs cyan; ${shared} shared points white (nu_z 0)`, 'dashed: the tube’s silhouette, which covers the far runs inside it'];
  });
  return {
    title: 'A tube bending through depth (z up to 90 px toward the camera mid-way), tapered as design §2: the arcs keep to its frame',
    cells: [
      phaseCell(tube, 'idle (k 40)', { k: 40, phase: phaseOf(null, null) }),
      phaseCell(tube, `strike window, j −5 (k ${kAt(-5)})`, { k: kAt(-5), phase: phaseOf(null, -5) }),
      phaseCell(tube, `aftermath, j 14 (k ${kAt(14)}): the tip arc onto P`, { k: kAt(14), phase: phaseOf(null, 14), P }),
      split,
    ],
  };
}

const BAR = ['#ffd84d', '#ff7ab8', '#7dff9a', '#c9a6ff', '#ffb36b', '#6be4ff'];

function timingRow(): Row {
  const idle = phaseOf(null, null);
  const cells = [40, 41, 42, 43].map((k) =>
    cell(CW, CH, (ctx) => {
      drawLimbArcs(ctx, straight(), { k, phase: idle });
      const plans = arcPlans(ID, k, idle);
      plans.forEach((p, i) => {
        const y = 182 + i * 16;
        ctx.lineCap = 'butt';
        ctx.strokeStyle = BAR[i % BAR.length];
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(xOn(p.s0), y);
        ctx.lineTo(xOn(p.s0 + p.span), y);
        ctx.stroke();
        ctx.strokeStyle = '#ffffff'; // the pair's placement, before the crawl
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(xOn(p.base), y - 7);
        ctx.lineTo(xOn(p.base), y + 7);
        ctx.stroke();
      });
      const slot = Math.floor(k / 2);
      return [
        k % 2 === 0 ? `k ${k}: slot ${slot}, the pair’s first drawing` : `k ${k}: slot ${slot} again: each arc 15 % of its span on`,
        `s0 ${plans.map((p) => p.s0.toFixed(3)).join(', ')}; turns ${plans.map((p) => p.turns.toFixed(2)).join(', ')}`,
      ];
    }),
  );
  return {
    title: 'Timing on an idle limb, k 40–43: where each arc sits, its span and its winding hold for floor(k/2) and crawl on the second drawing; turns, phi0, lift, kinks and gaps reseed every k (bars: the spans; ticks: the pair’s placement)',
    cells,
  };
}

// A limb whose pulse crosses in 4 drawings and pops at the tip, with no other
// pop near it, before the coil.
function findPulse(): { id: number; start: number; centres: number[]; next: number } {
  for (let id = 1; id <= 2000; id++) {
    const starts = pulseStarts(id, TL, 40);
    for (const [i, start] of starts.entries()) {
      if (start < TL.from + 2 || start + 5 >= (TL.charge?.[0] ?? Infinity)) continue;
      const centres = pulseCentres(id, start);
      if (centres.length !== 5) continue;
      const pops = [0, 1, 2, 3, 4, 5].map((d) => pulsesAt(id, start + d, TL).pops);
      if (pops[4].length === 1 && pops[4][0].kind === 'tip' && pops.every((p, d) => d === 4 || p.length === 0)) return { id, start, centres, next: starts[i + 1] };
    }
  }
  throw new Error('no limb in 1..2000 has a clean 4-drawing pulse with a tip pop before the coil');
}

function findRandomPop(): { id: number; k: number; pop: Pop } {
  for (let id = 1; id <= 2000; id++) {
    for (let k = TL.from; k < (TL.charge?.[0] ?? 60); k++) {
      const pop = pulsesAt(id, k, TL).pops.find((p) => p.kind === 'random');
      if (pop && pop.s > 0.3 && pop.s < 0.7) return { id, k, pop };
    }
  }
  throw new Error('no random pop in the middle of a limb in 1..2000');
}

function pulseCell(id: number, k: number, label: (spans: readonly PulseSpan[], pops: readonly Pop[]) => string[]): Cell {
  const { spans, pops } = pulsesAt(id, k, TL);
  return cell(CW, CH, (ctx) => {
    drawLimbArcs(ctx, straight(id), { k, phase: phaseOf(null, null), pulses: spans, pops });
    return label(spans, pops);
  });
}

function zoomCell(id: number, k: number, pop: Pop, label: string[]): Cell {
  const tube = straight(id);
  const shape = popShape(tube, pop);
  if (!shape) throw new Error('no pop shape');
  return cell(CW, CH, (ctx) => {
    ctx.save();
    ctx.translate(CW / 2, CH / 2);
    ctx.scale(2, 2);
    ctx.translate(-shape.centre[0], -shape.centre[1]);
    drawLimbArcs(ctx, tube, { k, phase: phaseOf(null, null), pulses: pulsesAt(id, k, TL).spans, pops: [pop] });
    ctx.restore();
    return label;
  });
}

const range = (xs: number[]) => `${Math.min(...xs).toFixed(2)}–${Math.max(...xs).toFixed(2)}`;
const popText = (pop: Pop) => `${pop.spikes.length} spikes of ${range(pop.spikes.map((sp) => sp.length))} r on a core ${pop.core.toFixed(2)} r across`;

function pulseRows(): Row[] {
  const { id, start, centres, next } = findPulse();
  const travel = [0, 1, 2, 3].map((d) =>
    pulseCell(id, start + d, (spans) => {
      const p = spans.find((q) => q.s === centres[d]);
      if (!p) throw new Error(`limb ${id} shows no pulse at ${centres[d]} on k ${start + d}`);
      return [`k ${start + d}: the pulse at ${p.s.toFixed(2)} L${d === 0 ? ' (it starts at 0.1 L)' : `, ${(centres[d] - centres[d - 1]).toFixed(2)} L on`}`, `bulge ${p.len.toFixed(2)} L long, ×${p.scale.toFixed(2)} wide, core ${Math.round(100 * p.core)} %`];
    }),
  );
  const popped = pulseCell(id, start + 4, (_, pops) => [`k ${start + 4}: past the tip (${centres[4].toFixed(2)} L): it pops (p 0.7)`, popText(pops[0])]);
  const after = pulseCell(id, start + 5, () => ['k ' + (start + 5) + ': a pop lasts one drawing', `the next pulse starts on k ${next} (idle: U{6..10} drawings apart)`]);
  const tipPop = pulsesAt(id, start + 4, TL).pops[0];
  const random = findRandomPop();
  return [
    { title: `A cord pulse over 6 drawings (limb ${id}, idle, k ${start}–${start + 5}): 0.1 L, then 0.25–0.35 L a drawing, 3 or 4 drawings on the limb, then the tip`, cells: travel },
    {
      title: 'The pop it ends in, and the pops at ×2: 6–10 spikes of 0.3–1.4 r on a 0.15–0.3 r base, fanned over 270° with the open 90° toward the root',
      cells: [
        popped,
        after,
        zoomCell(id, start + 4, tipPop, [`×2: limb ${id}’s tip pop, k ${start + 4}`, popText(tipPop)]),
        zoomCell(random.id, random.k, random.pop, [`×2: a random pop (p 0.06 a drawing), limb ${random.id}, k ${random.k}, at ${random.pop.s.toFixed(2)} L`, popText(random.pop)]),
      ],
    },
  ];
}

function tonesRow(): Row {
  const h = (c: string) => Math.round(toOklch(c).h);
  const palettes: Palette[] = [PALETTE, ['#3a6cff', '#f4f1ea', '#16141a'], ['#22cc44', '#f4f1ea', '#16141a']];
  const cells = palettes.map((p) => {
    const tones = arcTones(p);
    const turned = tones.body !== ARC_TONES.body;
    return cell(CW, CH, (ctx) => {
      drawLimbArcs(ctx, straight(), { k: kAt(-5), phase: phaseOf(null, -5), look: lookOf(p), tones });
      [tones.edge, tones.body, tones.core].forEach((c, i) => {
        ctx.fillStyle = c;
        ctx.fillRect(12 + i * 28, 12, 24, 24);
      });
      return [
        `p0 ${p[0]} (hue ${h(p[0])}°): arcs ${tones.edge} / ${tones.body} / ${tones.core}`,
        turned ? `turned by roles() (p0 within 60° of 262°): body hue ${h(tones.body)}°` : `limbs3d’s blues as measured: body hue ${h(tones.body)}°`,
      ];
    });
  });
  const flicker = cell(CW, CH, (ctx) => {
    const f0 = 70;
    const frames = 40;
    const bw = 11;
    const x0 = 20;
    const base = 196;
    const tall = 150;
    for (let i = 0; i < frames; i++) {
      const f = f0 + i;
      const v = arcFlicker(ID, c1(f, HERO.I));
      ctx.fillStyle = ARC_TONES.body;
      ctx.fillRect(x0 + i * (bw + 1), base - v * tall, bw, v * tall);
      if (i > 0 && c1(f, HERO.I) === c1(f - 1, HERO.I)) {
        ctx.strokeStyle = '#ffffff'; // a 2-frame step: both frames hold
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x0 + (i - 1) * (bw + 1) + 2, base + 8);
        ctx.lineTo(x0 + i * (bw + 1) + bw - 2, base + 8);
        ctx.stroke();
      }
    }
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 1;
    for (const v of [0.6, 1]) {
      ctx.beginPath();
      ctx.moveTo(x0, base - v * tall);
      ctx.lineTo(x0 + frames * (bw + 1), base - v * tall);
      ctx.stroke();
      text(ctx, v.toFixed(1), x0 + frames * (bw + 1) + 4, base - v * tall + 5, '#ffffff', SMALL);
    }
    const xI = x0 + (HERO.I - f0) * (bw + 1) + bw / 2;
    text(ctx, 'j 0', xI - 9, base + 30, '#ffffff', SMALL);
    text(ctx, `f ${f0}`, x0, base + 30, '#ffffff', SMALL);
    text(ctx, `f ${f0 + frames - 1}`, x0 + (frames - 1) * (bw + 1) - 18, base + 30, '#ffffff', SMALL);
    return [`arcFlicker(${ID}, c1) on f ${f0}–${f0 + frames - 1} (I ${HERO.I}): 0.6 + 0.4·hash01(id, c1, 7)`, 'c1 = kr(f − I) holds on both frames of each 2-frame step (white)'];
  });
  return { title: 'Arc tones on three limb colours (arcTones), and the glow’s flicker on the 1s clock (the composite multiplies the cached emission by it)', cells: [...cells, flicker] };
}

// The arcs alone, as the unit test times them: shapes and drawing, flushed.
function heroTiming(tubes: Tube[]): number {
  const canvas = createCanvas(1080, 608);
  const ctx = canvas.getContext('2d');
  const time = (k: number) => {
    const t0 = performance.now();
    for (const tube of tubes) {
      const out = sheathArcs(tube, k, { kind: 'strike', j: -5 }, tube.id, { S: 608 });
      drawArcs(ctx, out.far, ARC_TONES, newPath);
      drawArcs(ctx, out.near, ARC_TONES, newPath);
    }
    ctx.getImageData(0, 0, 1, 1); // make sure the raster work is done
    return performance.now() - t0;
  };
  for (let i = 0; i < 20; i++) time(100 + i);
  const ms = Array.from({ length: 10 }, (_, i) => time(40 + i)).sort((a, b) => a - b);
  return (ms[4] + ms[5]) / 2;
}

function heroRow(): { row: Row; ms: number } {
  const tubes = heroLimbs();
  const ms = heroTiming(tubes);
  const frame = (title: string, j: number, P?: Vec2) =>
    cell(1080, 608, (ctx) => {
      const k = kAt(j);
      let arcs = 0;
      let tips = 0;
      for (const tube of tubes) {
        const out = drawLimbArcs(ctx, tube, { k, phase: phaseOf(null, j), S: 608, P });
        const runs = [...out.far, ...out.near];
        arcs += new Set(runs.filter((r) => r.kind === 'sheath').map((r) => r.arc)).size;
        tips += runs.filter((r) => r.kind === 'tip').length;
      }
      if (P) cross(ctx, P);
      return [title, `${arcs} sheath arcs${tips ? ` and ${tips} tip arcs` : ''} at k ${k}; arcs ${(ARC_WIDTH * 608).toFixed(1)} px wide, r0 ${(0.02 * 608).toFixed(1)} px`];
    });
  return {
    row: {
      title: `24 arcs at 1080×608 (S 608): 4 limbs × 6 in the strike window draw in ${ms.toFixed(1)} ms, shapes included (median of 10; budget 11 ms, 0.45 ms an arc)`,
      cells: [frame('the strike window, j −5', -5), frame(`the aftermath, j 14: arcs from the tips down onto P (${HERO.P.join(', ')})`, 14, HERO.P)],
    },
    ms,
  };
}

// ---- The sheet ----------------------------------------------------------------------------------

const hero = heroRow();
const rows: Row[] = [emergenceRow(), popIdleRow(), strikeRow(), bentRow(), timingRow(), ...pulseRows(), tonesRow(), hero.row];
const PAD = 16;
const GAP = 8;
const TITLE = 34;
const LINE = 18;
const BANNER = [
  'Limb electricity (impact WP4, design §3): render/arcs3d.ts and render/pulse.ts on synthetic tubes, not Qai’s drawings.',
  `Synthetic rows at S 1080 (the 1080p export’s scale, 1:1); the last row at S 608 (the app’s 1080×608). Arcs ${ARC_WIDTH} S wide in three bands, ${ARC_TONES.edge} / ${ARC_TONES.body} / core 0.30 w ${ARC_TONES.core}, the width stepped in quarters toward the ends.`,
  'Under them a flat stand-in limb (p0, a dark outline, a pale core through each pulse’s bulge): the shaded limb is WP3’s and the glow WP10’s, so neither is here.',
];
const rowWidth = (r: Row) => r.cells.reduce((w, c) => w + c.canvas.width, 0) + GAP * (r.cells.length - 1);
const rowHeight = (r: Row) => TITLE + Math.max(...r.cells.map((c) => c.canvas.height)) + 8 + LINE * Math.max(...r.cells.map((c) => c.label.length)) + PAD;
const width = Math.max(...rows.map(rowWidth)) + 2 * PAD;
const top = PAD + BANNER.length * 22 + 8;
const sheet = createCanvas(width, top + rows.reduce((h, r) => h + rowHeight(r), 0));
const ctx = sheet.getContext('2d');
ctx.fillStyle = '#ffffff';
ctx.fillRect(0, 0, sheet.width, sheet.height);
ctx.textBaseline = 'alphabetic';
BANNER.forEach((l, i) => text(ctx, l, PAD, PAD + 16 + i * 22, i === 0 ? '#1d3fd0' : INK, i === 0 ? 'bold 17px sans-serif' : FONT));
let y = top;
for (const row of rows) {
  text(ctx, row.title, PAD, y + 22, INK, 'bold 17px sans-serif');
  let x = PAD;
  const h = Math.max(...row.cells.map((c) => c.canvas.height));
  for (const c of row.cells) {
    ctx.drawImage(c.canvas, x, y + TITLE);
    c.label.forEach((l, i) => text(ctx, l, x, y + TITLE + h + 8 + 13 + i * LINE, i === 0 ? INK : MUTED, i === 0 ? FONT : SMALL));
    x += c.canvas.width + GAP;
  }
  y += rowHeight(row);
}
mkdirSync(outDir, { recursive: true });
const file = join(outDir, 'arcs-sheet.png');
writeFileSync(file, sheet.toBuffer('image/png'));
process.stdout.write(`arcs sheet: ${file} (${sheet.width}×${sheet.height})\n24 arcs at 1080×608: ${hero.ms.toFixed(1)} ms (median of 10; budget 11)\n`);
