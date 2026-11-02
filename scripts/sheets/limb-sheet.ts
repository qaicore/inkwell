// The limb brush's sheet (impact design §2, WP3): what lift/tube.ts and
// render/limb.ts draw, at 1:1, for Qai to judge the look. Rows:
//   1. tones: the cel ladder of p0 and four other colours, p0's next to
//      design §2's table;
//   2. the bands under three lights: the key light from the upper left,
//      swung half way toward P, and from P (the fire's light, decision 8);
//   3. the emergence, ages 0–5: the growth with its hot head, then the pop;
//   4. details: the socket ring and the root's glow burst, a cord pulse, an
//      idle drawing's crackle, and the outline's wobble on two drawings (×3);
//   5. limbs crossing a body mask: the lift's front flags as they come (the
//      stand-in is smaller than the mask, so they flip inside it), the flips
//      snapped to the mask's edge, and a debug view;
//   6. the outline by contrast over Y 20, 80 and 140 bands, and over a ramp;
//   7. the hero's four test limbs at 1080×608: over the clip's f22 under his
//      cached person mask when --clip is given, otherwise over a plate with
//      the lumas heroclip measured round them.
// `motion` draws limb-motion.png instead (decisions 15, 17 and 18): the hero's
// limbs as the impact scene's physics moves them, each limb's centreline on
// every drawing of the spin, the coil and whip, the pin and the release as an
// onion skin over the body they collide with (needs --clip and --drawings).
// The synthetic rows are drawn at S 1080, the 1080p export's scale; the hero
// row at S 608, the app's internal 1080×608. No glow (the compositor, WP10,
// lays the emission down) and no arcs (WP4). Reads only local files: no
// network, no paid calls.
// Usage: node scripts/sheets/limb-sheet.ts [motion] --out <dir> [--drawings test-drawings.json] [--clip clip.mp4] [--scale 0.5]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import { frameMasks } from '../../src/app/pipeline.ts';
import { nullSink, type HeldLimb, type Palette, type PulseSpan, type Tube, type Vec2 } from '../../src/impact/contracts.ts';
import { momentsFromDrawings } from '../../src/impact/detect.ts';
import { deltaE } from '../../src/impact/palette.ts';
import { liftBodies, project, toCamera, TORSO, type Body3D, type Vec3 } from '../../src/lift/body.ts';
import { dummyBodies } from '../../src/lift/collide.ts';
import { animate3d, liftStroke } from '../../src/lift/lift.ts';
import { bulgeSide, limbsFirst, strikeController } from '../../src/lift/strike.ts';
import { buildTube, chunks, sectionAt, type Chunk } from '../../src/lift/tube.ts';
import { checkedTurn, turnKeys } from '../../src/lift/turn.ts';
import { resampleStroke } from '../../src/render/brush.ts';
import { LIMB } from '../../src/render/brushes.ts';
import { drawLimb, limbGrown, limbR0, limbTones, outlineClasses, outlineContrast, outlineLuma, plateLuma, type LimbOptions, type LimbTarget, type OutlineClass, type PlateLuma } from '../../src/render/limb.ts';
import { celTones, luma709 } from '../../src/render/tones.ts';
import { cachedFrames, masksFromCache, toFrameMask } from '../../src/sam/cache.ts';
import { trackPoses } from '../../src/track/anchor.ts';
import { goodStandIns, torsoBend } from '../../src/track/bend.ts';
import { anchorTransform, toPixels, toTorso, torsoHeights } from '../../src/track/torso.ts';
import type { Mask } from '../../src/track/tracking.ts';
import { HAND_KEYS, internalSize, readDrawings, skeletonPoints, standInPoints, TURN_CHECK } from '../impact-render.ts';
import { assertOutsideRepo, parseArgs } from '../lib/out-dir.ts';

const USAGE = 'usage: node scripts/sheets/limb-sheet.ts [motion] --out <dir> [--drawings test-drawings.json] [--clip clip.mp4] [--scale 0.5]';
const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const args = parseArgs(process.argv.slice(2));
if (!args.out) throw new Error(USAGE);
const outDir = assertOutsideRepo(args.out, REPO);

const PALETTE: Palette = ['#e8203a', '#f4f1ea', '#16141a']; // the app's default, and the test drawings'
const TONES = limbTones(PALETTE);
const GREY = '#585858'; // compositing's C15 plate
const INK = '#111111';
const MUTED = '#555555';
const FONT = '15px sans-serif';
const HERO = { width: 1080, height: 608, clipWidth: 1920, clipHeight: 1080, frame: 22, torsoUnit: 181.9 }; // torsoUnit: clip px on f22 (test-drawings.json)

type Ctx = SKRSContext2D;
type Pt = [number, number, number]; // x, y, depth (+ toward the camera)
const lt = (ctx: Ctx) => ctx as unknown as LimbTarget;

interface Cell {
  canvas: Canvas;
  label: string[]; // one or two lines under it
}
interface Row {
  title: string;
  cells: Cell[];
}

function cell(w: number, h: number, label: string[], draw: (ctx: Ctx) => void, bg = GREY): Cell {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  draw(ctx);
  return { canvas, label };
}

// A held limb of 32 points along curve(t), with the drawn pressure shape
// unless given: 0.8 at the root, full by the fifth point, 0.1 at the tip.
function limbAlong(id: number, curve: (t: number) => Pt, front: (p: Pt) => boolean = () => true, pressure?: (i: number) => number): HeldLimb {
  const n = 32;
  const pts = Array.from({ length: n }, (_, i) => curve(i / (n - 1)));
  const shape = pressure ?? ((i: number) => (i <= 4 ? 0.8 + 0.05 * i : 1 - (0.9 * (i - 4)) / (n - 5)));
  let length = 0;
  for (let i = 1; i < n; i++) length += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return { id, points: pts.map((p): Vec2 => [p[0], p[1]]), z: pts.map((p) => p[2]), pressure: pts.map((_, i) => shape(i)), front: pts.map((p) => front(p)), length };
}

// The same limb through drawn control points, resampled evenly the way the
// app resamples a stroke.
function limbThrough(id: number, control: Vec2[], depth: (t: number) => number, front: (p: Pt) => boolean): HeldLimb {
  const { points } = resampleStroke(control.map(([x, y]): [number, number, number] => [x, y, 1]));
  return limbAlong(id, (t) => {
    const p = points[Math.round(t * (points.length - 1))];
    return [p[0], p[1], depth(t)];
  }, front);
}

// Draws a limb's behind layer, then `between` (the person), then its front
// layer, so the occlusion reads as it will in the stack.
function layered(ctx: Ctx, w: number, h: number, draw: (behind: LimbTarget, front: LimbTarget) => void, between?: (ctx: Ctx) => void) {
  const behind = createCanvas(w, h);
  const front = createCanvas(w, h);
  draw(lt(behind.getContext('2d')), lt(front.getContext('2d')));
  ctx.drawImage(behind, 0, 0);
  between?.(ctx);
  ctx.drawImage(front, 0, 0);
}

function text(ctx: Ctx, s: string, x: number, y: number, color = INK, font = FONT) {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
}

function cross(ctx: Ctx, [x, y]: Vec2, color: string, r = 7) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x - r, y);
  ctx.lineTo(x + r, y);
  ctx.moveTo(x, y - r);
  ctx.lineTo(x, y + r);
  ctx.stroke();
}

function arrow(ctx: Ctx, from: Vec2, to: Vec2, color: string) {
  const a = Math.atan2(to[1] - from[1], to[0] - from[0]);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(from[0], from[1]);
  ctx.lineTo(to[0], to[1]);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(to[0], to[1]);
  ctx.lineTo(to[0] - 12 * Math.cos(a - 0.4), to[1] - 12 * Math.sin(a - 0.4));
  ctx.lineTo(to[0] - 12 * Math.cos(a + 0.4), to[1] - 12 * Math.sin(a + 0.4));
  ctx.closePath();
  ctx.fill();
}

const greyHex = (y: number) => `#${Math.round(Math.min(255, Math.max(0, y))).toString(16).padStart(2, '0').repeat(3)}`;
const CLASS_COLOR: Record<OutlineClass, string> = { rim: TONES.light, 'rim+core': '#d9a3ad', line: TONES.line };

// ---- 1. Tones --------------------------------------------------------------------------------

function tonesRow(): Row {
  const colors = [PALETTE[0], '#3a6cff', '#fb6a04', '#22cc44', '#7a3cff'];
  const table = { line: '#27010e', shadow: '#680627', body: PALETTE[0], lit: '#ff8577', core: '#ffe3db' } as const;
  const names = ['line', 'shadow', 'body', 'lit', 'core'] as const;
  const ladder = cell(2160, 300, ['celTones per body colour, luma Rec. 709 (Y). Under p0: design §2’s table, and how far each tone is from it (ΔE 2000; the test allows 6)'], (ctx) => {
    colors.forEach((c, g) => {
      const x0 = 20 + g * 400;
      const t = celTones(c);
      text(ctx, g === 0 ? `p0 ${c} (the limb body)` : c, x0, 22, INK, 'bold 15px sans-serif');
      names.forEach((name, i) => {
        const x = x0 + i * 74;
        ctx.fillStyle = t[name];
        ctx.fillRect(x, 32, 68, 68);
        text(ctx, name, x, 118, INK, '13px sans-serif');
        text(ctx, t[name], x, 134, MUTED, '13px sans-serif');
        text(ctx, `Y ${luma709(t[name]).toFixed(0)}`, x, 150, MUTED, '13px sans-serif');
        if (g !== 0) return;
        ctx.fillStyle = table[name];
        ctx.fillRect(x, 170, 68, 44);
        text(ctx, table[name], x, 232, MUTED, '13px sans-serif');
        text(ctx, `ΔE ${deltaE(t[name], table[name]).toFixed(1)}`, x, 248, INK, '13px sans-serif');
      });
      if (g === 0) text(ctx, 'design §2 table', x0, 268, MUTED, '13px sans-serif');
    });
    const x = 2020;
    for (const [i, [name, color]] of [['p1 rim', TONES.light], ['back rim', TONES.rim]].entries()) {
      ctx.fillStyle = color;
      ctx.fillRect(x, 32 + i * 120, 68, 68);
      ctx.strokeStyle = '#999999';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, 32 + i * 120 + 0.5, 67, 67);
      text(ctx, name, x, 118 + i * 120, INK, '13px sans-serif');
      text(ctx, color, x, 134 + i * 120, MUTED, '13px sans-serif');
    }
  }, '#ffffff');
  return { title: 'Tones (render/tones.ts)', cells: [ladder] };
}

// ---- 2. Bands under three lights ------------------------------------------------------------------

function bandsRow(): Row {
  const S = 1080;
  const P: Vec2 = [380, 392];
  const tube = buildTube(limbAlong(21, (t) => [110 + 500 * t, 250 - 150 * Math.sin(Math.PI * t * 1.1) + 40 * t, 140 * Math.sin(Math.PI * t)]), limbR0(S));
  const mid = sectionAt(tube, 46).screen;
  const lights: { label: string[]; swing: LimbOptions['swing'] }[] = [
    { label: ['the key light, norm(−0.6, −0.75, 0.3): from the upper left', 'body N·L ≥ −0.08, lit N·L ≥ 0.5, core N·H ≥ 0.9, back rim N·Lb ≥ 0.35'], swing: null },
    { label: ['swung half way toward P (w 0.5), per section', 'keySwing: 0 through S0, 1 from S1 (j −7) until the decay'], swing: { P, w: 0.5 } },
    { label: ['lit from P (w 1): from S1 through the fire and the aftermath', 'the decay takes it back to the key light by J_end'], swing: { P, w: 1 } },
  ];
  return {
    title: 'Cel bands under three lights (closed-form intervals, no per-pixel work)',
    cells: lights.map(({ label, swing }) =>
      cell(720, 405, label, (ctx) => {
        layered(ctx, 720, 405, (behind, front) => drawLimb(behind, front, tube, { S, k: 3, palette: PALETTE, crackle: 0, swing }));
        if (swing) {
          cross(ctx, P, '#ffffff');
          text(ctx, 'P', P[0] + 10, P[1] - 4, '#ffffff');
          arrow(ctx, [P[0] + (mid[0] - P[0]) * 0.25, P[1] + (mid[1] - P[1]) * 0.25], [P[0] + (mid[0] - P[0]) * 0.6, P[1] + (mid[1] - P[1]) * 0.6], '#ffffff');
        } else arrow(ctx, [30, 30], [110, 130], '#ffffff');
      }),
    ),
  };
}

// ---- 3. Emergence -----------------------------------------------------------------------------

// A quarter circle from a root low on the left up to a tip high on the right.
const curve = (id: number) => limbAlong(id, (t) => [320 - 255 * Math.cos((Math.PI / 2) * t), 330 - 255 * Math.sin((Math.PI / 2) * t), -40 * t]);

function growthRow(): Row {
  const S = 1080;
  const tube = buildTube(curve(31), limbR0(S));
  const says = ['grows to 44 %, the head hot', 'grows to 75 %', 'grows to 94 %', 'grows to 100 %', 'pops: flash 1, 14 sparks', 'pops: flash 0.5, sparks farther, thinner'];
  return {
    title: 'Emergence, ages 0–5 (EMERGE grow 4, pop 2; on 2s, k = k(f1) + age)',
    cells: says.map((say, age) =>
      cell(360, 405, [`age ${age}: ${say}`, age < 4 ? `visible ${(100 * limbGrown(age)).toFixed(1)} % of L; the last 30 % hot` : 'tau_lit falls toward 0.2, tau_core toward 0.6'], (ctx) => {
        layered(ctx, 360, 405, (behind, front) => drawLimb(behind, front, tube, { S, k: 10 + age, palette: PALETTE, age }));
      }),
    ),
  };
}

// ---- 4. Details ------------------------------------------------------------------------------

function detailsRow(): Row {
  const S = 1080;
  const tube = buildTube(curve(41), limbR0(S));
  const base: LimbOptions = { S, k: 4, palette: PALETTE, crackle: 0 };
  const pulse: PulseSpan = { s: 0.45, len: 0.22, scale: 1.3, core: 0.55 };
  const draw = (opts: LimbOptions) => (ctx: Ctx) => layered(ctx, 360, 405, (behind, front) => drawLimb(behind, front, tube, opts));
  // The first idle drawing from k 4 on whose seeded crackle fires.
  const pixels = (opts: LimbOptions) => {
    const c = createCanvas(360, 405);
    drawLimb(lt(c.getContext('2d')), lt(c.getContext('2d')), tube, opts);
    return Buffer.from(c.getContext('2d').getImageData(0, 0, 360, 405).data.buffer);
  };
  let k = 4;
  while (k < 64 && pixels({ ...base, k }).equals(pixels({ ...base, k, crackle: undefined }))) k++;
  // The outline ×3 about a stretch near the root, on two drawings.
  const zoom = (kk: number) => (ctx: Ctx) => {
    const src = createCanvas(360, 405);
    const sctx = src.getContext('2d');
    sctx.fillStyle = GREY;
    sctx.fillRect(0, 0, 360, 405);
    drawLimb(lt(sctx), lt(sctx), tube, { ...base, k: kk, root: 'none' });
    const at = sectionAt(tube, 30).screen;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, at[0] - 60, at[1] - 67.5, 120, 135, 0, 0, 360, 405);
  };
  return {
    title: 'Details: the root, a cord pulse, the idle crackle, the outline wobble',
    cells: [
      cell(360, 405, ['socket ring (root ‘ring’): line tone,', `${LIMB.socket} × the root radius`], draw({ ...base, root: 'ring' })),
      cell(360, 405, ['glow burst over the socket', '(root ‘burst’, the default: decision 8)'], draw(base)),
      cell(360, 405, ['cord pulse at s 0.45: radius × 1.3,', 'core 55 % of the width (pulse.ts sends these)'], draw({ ...base, pulses: [pulse] })),
      cell(360, 405, [`idle crackle (k ${k}): flash 0.35 and sparks`, 'on a seeded 1 drawing in 4; glow flickers ×0.6–1'], draw({ ...base, k, crackle: undefined })),
      cell(360, 405, ['outline ±30 %, ×1.35 on the shadow side', '(×3): drawing k 0'], zoom(0)),
      cell(360, 405, ['the same on k 1: reseeded on k mod 3,', 'the boil’s cycle, so k 3 draws k 0 again'], zoom(1)),
    ],
  };
}

// ---- 5. Occlusion -------------------------------------------------------------------------------

function occlusionRow(): Row {
  const S = 1080;
  const W = 720;
  const H = 405;
  // The person (the mask) and the lift's stand-in body, which is smaller: his
  // hair and his clothes reach past it.
  const torso = { cx: 360, cy: 290, rx: 95, ry: 135 };
  const head = { cx: 360, cy: 105, r: 52 };
  const inPerson = (x: number, y: number) => ((x - torso.cx) / torso.rx) ** 2 + ((y - torso.cy) / torso.ry) ** 2 < 1 || Math.hypot(x - head.cx, y - head.cy) < head.r || (Math.abs(x - 360) < 25 && y > 140 && y < 170);
  const inStandIn = (x: number, y: number) => ((x - torso.cx) / (torso.rx - 15)) ** 2 + ((y - torso.cy) / (torso.ry - 15)) ** 2 < 1 || Math.hypot(x - head.cx, y - head.cy) < head.r - 18 || (Math.abs(x - 360) < 12 && y > 140 && y < 170);
  const mask: Mask = { width: W, height: H, alpha: new Uint8ClampedArray(W * H) };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (inPerson(x + 0.5, y + 0.5)) mask.alpha[y * W + x] = 255;
  const person = createCanvas(W, H);
  const pctx = person.getContext('2d');
  const img = pctx.createImageData(W, H);
  for (let i = 0; i < W * H; i++) [img.data[4 * i], img.data[4 * i + 1], img.data[4 * i + 2], img.data[4 * i + 3]] = [163, 148, 134, mask.alpha[i]];
  pctx.putImageData(img, 0, 0);

  // Both limbs root behind him; a point is in front once it's off the
  // stand-in, as the lift's flags have it.
  const front = ([x, y]: Pt) => !inStandIn(x, y);
  const a = buildTube(limbThrough(51, [[330, 300], [262, 312], [190, 300], [130, 250], [100, 170], [96, 90]], (t) => -40 - 60 * t, front), limbR0(S));
  const b = buildTube(limbThrough(52, [[392, 255], [470, 240], [540, 192], [560, 130], [530, 84], [470, 70], [400, 92], [330, 100], [262, 86], [200, 60]], (t) => -40 - 60 * t, front), limbR0(S));
  const tubes = [a, b];
  const raw = tubes.map((t) => chunks(t));
  const snapped = tubes.map((t) => chunks(t, mask));
  const flips = (runs: Chunk[]) => runs.slice(1).map((r) => (r.front ? r.from : runs[runs.indexOf(r) - 1].to));
  const scene = (runsFor: (i: number) => Chunk[]) => (ctx: Ctx) =>
    layered(ctx, W, H, (behind, fr) => tubes.forEach((t, i) => drawLimb(behind, fr, t, { S, k: 2, palette: PALETTE, crackle: 0, chunks: runsFor(i), mask })), (c) => c.drawImage(person, 0, 0));
  const debug = (ctx: Ctx) => {
    ctx.globalAlpha = 0.45;
    ctx.drawImage(person, 0, 0);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#222222';
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(torso.cx, torso.cy, torso.rx - 15, torso.ry - 15, 0, 0, 2 * Math.PI);
    ctx.moveTo(head.cx + head.r - 18, head.cy);
    ctx.arc(head.cx, head.cy, head.r - 18, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.setLineDash([]);
    tubes.forEach((t, i) => {
      for (const run of snapped[i]) {
        ctx.strokeStyle = run.front ? '#f08a24' : '#2f6fdc';
        ctx.lineWidth = run.front ? 5 : 9;
        ctx.beginPath();
        for (let x = run.from; x <= run.to + 1e-9; x += 0.25) {
          const p = sectionAt(t, Math.min(run.to, x)).screen;
          if (x === run.from) ctx.moveTo(p[0], p[1]);
          else ctx.lineTo(p[0], p[1]);
        }
        ctx.stroke();
      }
      for (const x of flips(raw[i])) {
        const p = sectionAt(t, x).screen;
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(p[0] - 6, p[1] - 6);
        ctx.lineTo(p[0] + 6, p[1] + 6);
        ctx.moveTo(p[0] + 6, p[1] - 6);
        ctx.lineTo(p[0] - 6, p[1] + 6);
        ctx.stroke();
      }
      for (const x of flips(snapped[i])) {
        const p = sectionAt(t, x).screen;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(p[0], p[1], 5, 0, 2 * Math.PI);
        ctx.fill();
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    });
    text(ctx, 'blue: behind runs (one section past each flip), orange: front runs', 12, 22, '#ffffff');
    text(ctx, 'dashed: the stand-in body; ×: the flags’ flips; white dots: snapped to the mask’s edge', 12, 42, '#ffffff');
  };
  // How far each of the flags' flips moved: to the nearest snapped one.
  const moved = tubes.flatMap((t, i) =>
    flips(raw[i]).map((x) => {
      const at = sectionAt(t, x).screen;
      return Math.min(...flips(snapped[i]).map((q) => Math.hypot(...sub(sectionAt(t, q).screen, at))));
    }),
  );
  return {
    title: 'Front and behind over a person mask (chunks): the snap fixes the hair bleed of f92 and f104',
    cells: [
      cell(W, H, ['the lift’s front flags as they come (no snap): the stand-in is smaller', 'than the mask, so each limb pokes over his hair and clothes at the flips'], scene((i) => raw[i])),
      cell(W, H, ['each flip moved to where the centreline crosses the mask’s edge,', `within ±6 sections (here ${moved.map((d) => d.toFixed(0)).join(', ')} px)`], scene((i) => snapped[i])),
      cell(W, H, ['the runs and the flips', 'behind runs go under the person cutout, front runs over it'], debug),
    ],
  };
}

const sub = (p: Vec2, q: Vec2): Vec2 => [p[0] - q[0], p[1] - q[1]];

// ---- 6. Outline by contrast --------------------------------------------------------------------

function outlineRow(): Row {
  const S = 1080;
  const W = 1080;
  const H = 320;
  const bands = [
    { to: 360, Y: 20 },
    { to: 720, Y: 80 },
    { to: 1080, Y: 140 },
  ];
  const bandY = (x: number) => bands.find((b) => x < b.to)?.Y ?? 140;
  const rampY = (x: number) => 150 - (130 * x) / W;
  const panel = (id: number, Y: (x: number) => number, label: string[]) => {
    const tube = buildTube(limbAlong(id, (t) => [40 + 1000 * t, 140 + 45 * Math.sin(5 * t), 0]), limbR0(S));
    const luma: PlateLuma = (x) => Y(x);
    const cls = outlineClasses(tube, luma, { S, palette: PALETTE });
    const seen = outlineLuma(tube, luma, LIMB.linePx * S);
    const worst = Math.min(...cls.map((c, i) => outlineContrast(c, seen[i], PALETTE)));
    const runs = cls.reduce<{ cls: OutlineClass; n: number }[]>((out, c, i) => (i > 0 && c === cls[i - 1] ? (out[out.length - 1].n++, out) : [...out, { cls: c, n: 1 }]), []);
    return cell(W, H, [...label, `runs ${runs.map((r) => `${r.cls} ${r.n}`).join(', ')}; the worst section ${worst.toFixed(1)}:1 (3:1 wanted)`], (ctx) => {
      for (let x = 0; x < W; x++) {
        ctx.fillStyle = greyHex(Y(x));
        ctx.fillRect(x, 0, 1, H);
      }
      layered(ctx, W, H, (behind, front) => drawLimb(behind, front, tube, { S, k: 5, palette: PALETTE, crackle: 0, outline: cls, root: 'none' }));
      tube.sections.forEach((sec, i) => {
        const x0 = i === 0 ? sec.screen[0] : (sec.screen[0] + tube.sections[i - 1].screen[0]) / 2;
        const x1 = i === tube.sections.length - 1 ? sec.screen[0] : (sec.screen[0] + tube.sections[i + 1].screen[0]) / 2;
        ctx.fillStyle = CLASS_COLOR[cls[i]];
        ctx.fillRect(x0, 262, Math.max(1, x1 - x0), 14);
      });
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 1;
      ctx.strokeRect(40.5, 262.5, 1000, 14);
      text(ctx, 'class per section:  rim = p1 rim  ·  rim+core = p1 rim, 1 px line-tone core  ·  line = the line tone', 40, 300, '#ffffff', '13px sans-serif');
    });
  };
  return {
    title: 'Outline by contrast (heroclip G10): Y > 100 line, Y < 60 p1 rim, between rim + core; ±5 Y hysteresis, runs ≥ 6 sections',
    cells: [
      panel(61, bandY, ['over Y 20, 80 and 140 bands (dark footage, the floor, a wall)']),
      panel(62, rampY, ['over a ramp from Y 150 down to 20: it switches once per threshold']),
    ],
  };
}

// ---- 7. The hero's four test limbs ------------------------------------------------------------------

interface HeroScene {
  limbs: HeldLimb[];
  plate: Canvas;
  person: Canvas | null; // the plate cut out by his mask, drawn over the behind layer
  mask: Mask | null;
  source: string[];
}

// The four stand-in limbs of impact/test-drawings.json (start.strokes, f22),
// as constant-curvature arcs: root, heading, turn and length, clip px. Used
// without --drawings.
const HERO_ARCS = [
  { id: 1, root: [778, 300], heading: -114, turn: -88, length: 446 },
  { id: 2, root: [838, 300], heading: -62, turn: 85, length: 447 },
  { id: 3, root: [790, 345], heading: 169, turn: -80, length: 432 },
  { id: 4, root: [828, 345], heading: 8.5, turn: 80, length: 435 },
] as const;

// Clip px to the app's 1080×608.
const toApp = ([x, y]: readonly number[]): Vec2 => [(x * HERO.width) / HERO.clipWidth, (y * HERO.height) / HERO.clipHeight];

// A drawn limb lifted onto a stand-in dish behind him: it bends away from the
// camera as it leaves his back (the lift does this for real), and every point
// is behind him, as the stand-in drawings' layer says on f22.
function heroHeld(id: number, points: Vec2[], pressure: number[]): HeldLimb {
  const raw = points.map((p, i): [number, number, number] => [p[0], p[1], pressure[i]]);
  const even = resampleStroke(raw);
  const unit = (HERO.torsoUnit * HERO.width) / HERO.clipWidth;
  let d = 0;
  const z = even.points.map((p, i) => {
    if (i > 0) d += Math.hypot(p[0] - even.points[i - 1][0], p[1] - even.points[i - 1][1]);
    return -0.3 * d - (0.08 * d * d) / unit;
  });
  return { id, points: even.points, z, pressure: even.pressure, front: even.points.map(() => false), length: d };
}

function heroLimbs(): { limbs: HeldLimb[]; source: string } {
  if (args.drawings) {
    const json = JSON.parse(readFileSync(args.drawings, 'utf8')) as { start?: { frame?: number; strokes?: { id: number; brush: string; points: number[][]; pressure: number[] }[] } };
    const strokes = (json.start?.strokes ?? []).filter((s) => s.brush === 'limb');
    if (strokes.length === 0) throw new Error(`${args.drawings} has no limb strokes under start.strokes`);
    return { limbs: strokes.map((s) => heroHeld(s.id, s.points.map(toApp), s.pressure)), source: `limbs: ${args.drawings}` };
  }
  const limbs = HERO_ARCS.map((l) => {
    const n = 29;
    const step = l.length / (n - 1);
    const pts: Vec2[] = [];
    let x: number = l.root[0];
    let y: number = l.root[1];
    for (let i = 0; i < n; i++) {
      pts.push(toApp([x, y]));
      const a = ((l.heading + (l.turn * (i + 0.5)) / (n - 1)) * Math.PI) / 180;
      x += Math.cos(a) * step;
      y += Math.sin(a) * step;
    }
    return heroHeld(l.id, pts, pts.map((_, i) => (i <= 4 ? 0.8 + 0.05 * i : 1 - (0.9 * (i - 4)) / (n - 5))));
  });
  return { limbs, source: 'limbs: arcs fitted to the stand-in drawings (pass --drawings for the strokes themselves)' };
}

// One frame of the clip at the app's size, as a PNG, by ffmpeg.
function clipFrame(clip: string, f: number): Buffer {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', clip, '-vf', `select=eq(n\\,${f}),scale=${HERO.width}:${HERO.height}`, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'], { maxBuffer: 1 << 27 });
  if (r.error) throw new Error(`ffmpeg didn't run (${r.error.message}); it's needed for --clip`);
  if (r.status !== 0 || r.stdout.length === 0) throw new Error(`ffmpeg couldn't read frame ${f} of ${clip}: ${String(r.stderr)}`);
  return r.stdout;
}

// His cached person mask on frame f (fixtures/probe/sam-person.json), at the
// app's size; null when the cache isn't for this clip.
async function personMask(clip: string, f: number): Promise<{ mask: Mask | null; note: string }> {
  const path = join(REPO, 'fixtures', 'probe', 'sam-person.json');
  if (!existsSync(path)) return { mask: null, note: 'no person mask: fixtures/probe/sam-person.json is missing' };
  const json = JSON.parse(readFileSync(path, 'utf8')) as { clipSha256: string };
  const sha = createHash('sha256').update(readFileSync(clip)).digest('hex');
  if (sha !== json.clipSha256) return { mask: null, note: 'no person mask: the cached one is for another clip' };
  const sam = (await masksFromCache(json, cachedFrames(json)))[f];
  if (!sam) return { mask: null, note: `no person mask: SAM found nobody on f${f}` };
  const full = toFrameMask(sam, HERO.clipWidth, HERO.clipHeight, 1);
  const mask: Mask = { width: HERO.width, height: HERO.height, alpha: new Uint8ClampedArray(HERO.width * HERO.height) };
  for (let y = 0; y < HERO.height; y++) {
    const row = Math.min(full.height - 1, Math.floor(((y + 0.5) * HERO.clipHeight) / HERO.height));
    for (let x = 0; x < HERO.width; x++) mask.alpha[y * HERO.width + x] = full.alpha[row * full.width + Math.min(full.width - 1, Math.floor(((x + 0.5) * HERO.clipWidth) / HERO.width))];
  }
  return { mask, note: `his cached SAM person mask on f${f}` };
}

async function heroScene(): Promise<HeroScene> {
  const { limbs, source } = heroLimbs();
  const plate = createCanvas(HERO.width, HERO.height);
  const ctx = plate.getContext('2d');
  if (args.clip) {
    ctx.drawImage(await loadImage(clipFrame(args.clip, HERO.frame)), 0, 0, HERO.width, HERO.height);
    const { mask, note } = await personMask(args.clip, HERO.frame);
    let person: Canvas | null = null;
    if (mask) {
      person = createCanvas(HERO.width, HERO.height);
      const img = ctx.getImageData(0, 0, HERO.width, HERO.height);
      for (let i = 0; i < mask.alpha.length; i++) img.data[4 * i + 3] = mask.alpha[i];
      person.getContext('2d').putImageData(img, 0, 0);
    }
    return { limbs, plate, person, mask, source: [`the clip’s f${HERO.frame} (${args.clip}), ${note}`, source] };
  }
  // Without the clip: the wall (Y 130) and the door behind him, the dark
  // dresser lower left (Y 19), the floor (Y 95), and a grey person.
  ctx.fillStyle = greyHex(130);
  ctx.fillRect(0, 0, HERO.width, HERO.height);
  ctx.fillStyle = greyHex(95);
  ctx.fillRect(0, 470, HERO.width, HERO.height - 470);
  ctx.fillStyle = greyHex(19);
  ctx.fillRect(120, 175, 300, 295);
  const mask: Mask = { width: HERO.width, height: HERO.height, alpha: new Uint8ClampedArray(HERO.width * HERO.height) };
  for (let y = 0; y < HERO.height; y++) {
    for (let x = 0; x < HERO.width; x++) {
      const inBody = ((x - 456) / 52) ** 2 + ((y - 250) / 115) ** 2 < 1 || Math.hypot(x - 455, y - 100) < 30 || (Math.abs(x - 456) < 34 && y > 300 && y < 440);
      if (inBody) mask.alpha[y * HERO.width + x] = 255;
    }
  }
  const person = createCanvas(HERO.width, HERO.height);
  const img = person.getContext('2d').createImageData(HERO.width, HERO.height);
  for (let i = 0; i < mask.alpha.length; i++) [img.data[4 * i], img.data[4 * i + 1], img.data[4 * i + 2], img.data[4 * i + 3]] = [70, 62, 58, mask.alpha[i]];
  person.getContext('2d').putImageData(img, 0, 0);
  return { limbs, plate, person, mask, source: ['a stand-in plate with heroclip’s lumas (pass --clip for the footage)', source] };
}

// The four limbs' fills at 1080×608, tubes included: median of 10.
function heroTiming(limbs: HeldLimb[]): number {
  const behind = createCanvas(HERO.width, HERO.height).getContext('2d');
  const front = createCanvas(HERO.width, HERO.height).getContext('2d');
  const R0 = limbR0(HERO.height);
  const once = (k: number) => {
    behind.clearRect(0, 0, HERO.width, HERO.height);
    front.clearRect(0, 0, HERO.width, HERO.height);
    const t0 = performance.now();
    for (const h of limbs) drawLimb(lt(behind), lt(front), buildTube(h, R0), { S: HERO.height, k, palette: PALETTE, glow: nullSink });
    behind.getImageData(0, 0, 1, 1);
    front.getImageData(0, 0, 1, 1);
    return performance.now() - t0;
  };
  for (let i = 0; i < 3; i++) once(100 + i);
  const ms = Array.from({ length: 10 }, (_, i) => once(40 + i)).sort((a, b) => a - b);
  return (ms[4] + ms[5]) / 2;
}

async function heroRow(): Promise<{ row: Row; ms: number; classes: string[] }> {
  const scene = await heroScene();
  const S = HERO.height;
  const R0 = limbR0(S);
  const plateCtx = scene.plate.getContext('2d');
  const luma = plateLuma(plateCtx.getImageData(0, 0, HERO.width, HERO.height));
  const tubes: Tube[] = scene.limbs.map((h) => buildTube(h, R0));
  const classes = tubes.map((t) => outlineClasses(t, luma, { S, palette: PALETTE }));
  const opts = (i: number): LimbOptions => ({ S, k: 8, palette: PALETTE, outline: classes[i], mask: scene.mask });
  const summary = tubes.map((t, i) => {
    const seen = outlineLuma(t, luma, LIMB.linePx * S);
    const counts = (['line', 'rim+core', 'rim'] as const).map((c) => [c, classes[i].filter((x) => x === c).length] as const).filter(([, n]) => n > 0);
    const outside = t.sections.map((sec, j) => j).filter((j) => !scene.mask || !onPerson(scene.mask, t.sections[j].screen));
    const ys = outside.map((j) => seen[j]).sort((a, b) => a - b);
    return `limb ${t.id} (L ${scene.limbs[i].length.toFixed(0)} px drawn, ${t.length.toFixed(0)} in 3D): ${counts.map(([c, n]) => `${c} ${n}`).join(', ')}; median Y off him ${ys.length ? ys[ys.length >> 1].toFixed(0) : '–'}`;
  });
  const ms = heroTiming(scene.limbs);
  const composite = cell(HERO.width, HERO.height, [`the four test limbs (layer behind, k 8), outline classes from the plate: ${scene.source[0]}`, scene.source[1]], (ctx) => {
    ctx.drawImage(scene.plate, 0, 0);
    layered(ctx, HERO.width, HERO.height, (behind, front) => tubes.forEach((t, i) => drawLimb(behind, front, t, opts(i))), scene.person ? (c) => c.drawImage(scene.person!, 0, 0) : undefined);
  });
  const debug = cell(HERO.width, HERO.height, ['the same with nothing over them, and each section’s outline class beside it:', 'white dot rim, pink rim+core, dark line (heroclip: limb 3 lies over the dresser, Y about 19, and takes the rim)'], (ctx) => {
    ctx.globalAlpha = 0.55;
    ctx.drawImage(scene.plate, 0, 0);
    ctx.globalAlpha = 1;
    layered(ctx, HERO.width, HERO.height, (behind, front) => tubes.forEach((t, i) => drawLimb(behind, front, t, { ...opts(i), mask: null })));
    tubes.forEach((t, i) => {
      t.sections.forEach((sec, j) => {
        const off = sec.r + 7;
        ctx.fillStyle = CLASS_COLOR[classes[i][j]];
        ctx.beginPath();
        ctx.arc(sec.screen[0] + sec.normal[0] * off, sec.screen[1] + sec.normal[1] * off, 2.2, 0, 2 * Math.PI);
        ctx.fill();
      });
      const tip = t.sections[t.sections.length - 1].screen;
      text(ctx, `${t.id}`, tip[0] + 6, tip[1] - 6, '#ffffff', 'bold 16px sans-serif');
    });
    summary.forEach((s, i) => text(ctx, s, 12, HERO.height - 82 + i * 20, '#ffffff', '14px sans-serif'));
  });
  return { row: { title: `The hero’s four test limbs at 1080×608 (S 608, R0 ${R0.toFixed(1)} px): 4 limbs in ${ms.toFixed(1)} ms (median of 10; budget 25)`, cells: [composite, debug] }, ms, classes: summary };
}

function onPerson(mask: Mask, [x, y]: Vec2): boolean {
  const col = Math.floor(x);
  const row = Math.floor(y);
  return col >= 0 && row >= 0 && col < mask.width && row < mask.height && mask.alpha[row * mask.width + col] >= 128;
}

// ---- The motion sheet (decisions 15, 17 and 18) ------------------------------------------------

// `motion`: how the hero's limbs move, as the impact scene moves them. The
// rig is scene.ts's liftOf rebuilt from impact-render.ts's inputs: his cached
// person masks (cut at the internal size: --scale's, else the app's 1080),
// the stand-in pose (samples/hero/pose.json), the turn read from it and held
// to the hand keys, the bend, his crash-test dummy (the capsules and the mask
// scan), and the limbs-first strike on the contact, P and d that
// momentsFromDrawings derives from the two drawings. No boil, so only the
// motion shows. One cell per stretch: each limb's centreline on every drawing
// in it, an onion skin coloured by time (blue first, red last; dashed where
// its front flags put it behind him), over the body it collides with on the
// stretch's middle frame: his person mask (grey), the egg and the capsules
// (outlined), and P (a cross) round the strike.
const STRETCHES: readonly (readonly [string, number, number])[] = [
  ['the spin', 50, 74],
  ['the coil and the whip', 68, 78],
  ['the pin', 77, 92],
  ['the release', 93, 130],
];
const MOTION_CELL = { width: 620, height: 700 };
const MOTION_FIELD = 1080; // the app's internal long side (scene.ts's FIELD)

// The convex hull of points (Andrew's monotone chain).
function hull(points: readonly Vec2[]): Vec2[] {
  const p = [...points].sort((u, v) => u[0] - v[0] || u[1] - v[1]);
  const right = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]) <= 0;
  const half = (list: readonly Vec2[]) => {
    const out: Vec2[] = [];
    for (const q of list) {
      while (out.length >= 2 && right(out[out.length - 2], out[out.length - 1], q)) out.pop();
      out.push(q);
    }
    return out.slice(0, -1);
  };
  return [...half(p), ...half([...p].reverse())];
}

// His torso egg's outline on screen: the hull of its surface, projected.
function eggOutline(b: Body3D): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i <= 16; i++) {
    const v = (Math.PI * i) / 16;
    for (let j = 0; j < 32; j++) {
      const u = (2 * Math.PI * j) / 32;
      const q: Vec3 = [TORSO.a * Math.sin(v) * Math.cos(u), TORSO.cy + TORSO.b * Math.cos(v), TORSO.c * Math.sin(v) * Math.sin(u)];
      pts.push(project(b, toCamera(b, q)).xy);
    }
  }
  return hull(pts);
}

async function motionRows(): Promise<{ rows: Row[]; notes: string[] }> {
  if (!args.clip || !args.drawings) throw new Error(`the motion sheet needs --clip and --drawings\n${USAGE}`);
  const [CW, CH, FPS] = [HERO.clipWidth, HERO.clipHeight, 30];
  const cachePath = join(REPO, 'fixtures', 'probe', 'sam-person.json');
  const json = JSON.parse(readFileSync(cachePath, 'utf8')) as { clipSha256: string };
  if (createHash('sha256').update(readFileSync(args.clip)).digest('hex') !== json.clipSha256) throw new Error(`${cachePath} holds another clip's person masks`);
  const n = cachedFrames(json);
  const person = await masksFromCache(json, n);
  const posePath = join(REPO, 'samples', 'hero', 'pose.json');
  if (!existsSync(posePath)) throw new Error(`the motion sheet needs the stand-in pose at ${posePath}`);
  const raw = JSON.parse(readFileSync(posePath, 'utf8')) as unknown[];
  const stand = Array.from({ length: n }, (_, f) => standInPoints(raw[f]));
  const skeleton = Array.from({ length: n }, (_, f) => skeletonPoints(raw[f]));
  const drawings = readDrawings(JSON.parse(readFileSync(args.drawings, 'utf8')));
  const drawn = drawings.start.frame;
  // The contact, P, d and the seed, as impact-render derives them.
  const moments = momentsFromDrawings({
    limbs: drawings.start.strokes.map((s) => ({ id: s.id, points: s.points })),
    f1: drawn,
    cracks: drawings.end.strokes.map((s) => ({ id: s.id, points: s.points })),
    fDrawn: drawings.end.frame,
    masks: person,
    S: Math.min(CW, CH),
    seed: drawings.seed,
  });
  const I = moments.snap.frame;
  const P: Vec2 = [moments.slam.xy[0], moments.slam.xy[1]];
  const d: Vec2 = moments.slam.dir ? [moments.slam.dir[0], moments.slam.dir[1]] : [0, 1];
  // The internal frame: the person masks are cut at its size, and the limb's
  // root radius is the tube's R0 there, in clip px.
  const { W, H } = internalSize(CW, CH, args.scale ? Math.round(Math.max(CW, CH) * args.scale) : MOTION_FIELD, 1);
  const s = W / CW;
  const radius = limbR0(Math.min(W, H)) / s;
  const step = Math.max(CW / W, Math.max(CW, CH) / MOTION_FIELD);
  const cut = new Map<number, Mask | null>();
  const maskOn = (f: number): Mask | null => {
    if (!cut.has(f)) {
      const m = person[f];
      cut.set(f, m ? toFrameMask(m, CW, CH, step) : null);
    }
    return cut.get(f) ?? null;
  };
  // The anchor track, the torso unit, the turn, the bend and the bodies, as liftOf has them.
  const units = torsoHeights(frameMasks(person, CW, CH), CW, CH);
  const unitNear = (f: number): number => {
    for (let k = 0; k < units.length; k++) {
      const u = units[f - k] ?? units[f + k];
      if (u != null) return u;
    }
    return 0.25 * CH;
  };
  const b1 = stand[drawn];
  const hips: Vec2 | null = drawings.start.hips ?? (b1 ? [(b1.x[13] + b1.x[14]) / 2, (b1.y[13] + b1.y[14]) / 2] : null);
  const track = hips ? trackPoses(person, { frame: drawn, xy: hips }, FPS) : null;
  if (!track || track.length === 0) throw new Error(`no anchor track from f${drawn}`);
  const poses = Array.from({ length: n }, (_, f) => track[Math.min(f, track.length - 1)]);
  const good = goodStandIns(stand, { mask: maskOn, width: CW, height: CH });
  const read = turnKeys(undefined, stand, FPS, good);
  const keys = read.from === 'pose' ? checkedTurn(read.keys, HAND_KEYS, TURN_CHECK.from, TURN_CHECK.to, TURN_CHECK.maxDeg).keys : read.keys;
  const unit0 = unitNear(drawn);
  const bodies = liftBodies(poses, unit0, drawn, keys, torsoBend(stand, drawn, FPS, good));
  // The limbs as the app stores them (32 points by arc length, through torso space), lifted on the drawn frame.
  const at = anchorTransform(poses[drawn], unit0);
  const px = new Map<number, Vec2[]>();
  const lifted = drawings.start.strokes.map((l) => {
    const even = resampleStroke(l.points.map((p, i): [number, number, number] => [p[0], p[1], l.pressure[i]]));
    const points = even.points.map((p) => toPixels(at, toTorso(at, [p[0], p[1]])));
    px.set(l.id, points);
    return liftStroke(l.id, points, [...even.pressure], bodies[drawn], 'strand', l.stiffness, 1);
  });
  const dummies = dummyBodies({ bodies, joints: skeleton, mask: maskOn, width: CW, height: CH });
  const ids = moments.slam.limbs ?? lifted.map((l) => l.id);
  const control = strikeController({
    ...limbsFirst(I),
    P,
    d,
    limbs: ids.map((id) => ({ id, side: bulgeSide(px.get(id) ?? []) })),
    unit: bodies[I].unit,
    seed: moments.slam.seed ?? I,
    dps: 12,
    dummies,
    radius,
  });
  const frames = animate3d({ strokes: lifted, bodies, frames: n, dps: 12, boil: { maxPx: 0, cycle: 3 }, width: CW, emerge: new Map(lifted.map((l) => [l.id, drawn])), control, slam: { I, posters: true }, dummies, radius });

  const cells = STRETCHES.map(([name, a, b]) => {
    const mid = Math.round((a + b) / 2);
    const body = dummies[mid].body;
    const shown = Array.from({ length: b - a + 1 }, (_, k) => a + k).filter((f) => f === a || frames[f].capture !== frames[f - 1].capture);
    const egg = eggOutline(body);
    const capsules = dummies[mid].capsules.map((c) => ({ A: project(body, c.a), B: project(body, c.b), r: c.r }));
    const strike = a <= I + 9 && b >= I - 8;
    // The box round every drawn point of the stretch and his middle body, fitted to the cell.
    const all: Vec2[] = [...egg, ...capsules.flatMap((c) => [c.A.xy, c.B.xy]), ...shown.flatMap((f) => frames[f].placed.flatMap((p) => p.points)), ...(strike ? [P] : [])];
    const [x0, x1] = [Math.min(...all.map((q) => q[0])) - 40, Math.max(...all.map((q) => q[0])) + 40];
    const [y0, y1] = [Math.min(...all.map((q) => q[1])) - 40, Math.max(...all.map((q) => q[1])) + 40];
    const K = Math.min(MOTION_CELL.width / (x1 - x0), MOTION_CELL.height / (y1 - y0));
    const ox = (MOTION_CELL.width - K * (x1 - x0)) / 2 - K * x0;
    const oy = (MOTION_CELL.height - K * (y1 - y0)) / 2 - K * y0;
    const to = (q: Vec2): Vec2 => [ox + K * q[0], oy + K * q[1]];
    const label = [`${name}, f${a}–${b}: ${shown.length} drawings, blue first, red last`, `his mask, the egg and the capsules on f${mid}; ${K.toFixed(2)}× clip px`];
    return cell(
      MOTION_CELL.width,
      MOTION_CELL.height,
      label,
      (ctx) => {
        // His person mask, grey.
        const m = maskOn(mid);
        if (m) {
          const layer = createCanvas(m.width, m.height);
          const lc = layer.getContext('2d');
          const img = lc.createImageData(m.width, m.height);
          for (let i = 0; i < m.alpha.length; i++) [img.data[4 * i], img.data[4 * i + 1], img.data[4 * i + 2], img.data[4 * i + 3]] = [125, 125, 135, m.alpha[i] >= 128 ? 110 : 0];
          lc.putImageData(img, 0, 0);
          ctx.drawImage(layer, ox, oy, K * CW, K * CH);
        }
        // The egg and the capsules, outlined.
        ctx.strokeStyle = 'rgba(235, 235, 240, 0.6)';
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        ctx.beginPath();
        egg.forEach((q, i) => (i === 0 ? ctx.moveTo(...to(q)) : ctx.lineTo(...to(q))));
        ctx.closePath();
        ctx.stroke();
        for (const c of capsules) {
          const [pa, pb] = [to(c.A.xy), to(c.B.xy)];
          const [ra, rb] = [K * c.r * c.A.near, K * c.r * c.B.near];
          const ang = Math.atan2(pb[1] - pa[1], pb[0] - pa[0]);
          ctx.beginPath();
          ctx.arc(pb[0], pb[1], rb, ang - Math.PI / 2, ang + Math.PI / 2);
          ctx.arc(pa[0], pa[1], ra, ang + Math.PI / 2, ang + (3 * Math.PI) / 2);
          ctx.closePath();
          ctx.stroke();
        }
        // The onion skin: every limb on every drawing, coloured by time, dashed where behind him.
        shown.forEach((f, k) => {
          const hue = 240 - (240 * k) / Math.max(1, shown.length - 1);
          for (const p of frames[f].placed) {
            ctx.strokeStyle = `hsl(${hue}, 90%, 60%)`;
            ctx.lineWidth = 1.6;
            for (let j = 0; j + 1 < p.points.length; ) {
              const front = p.front[j] && p.front[j + 1];
              ctx.setLineDash(front ? [] : [4, 3]);
              ctx.beginPath();
              ctx.moveTo(...to(p.points[j]));
              while (j + 1 < p.points.length && (p.front[j] && p.front[j + 1]) === front) ctx.lineTo(...to(p.points[++j]));
              ctx.stroke();
            }
            ctx.setLineDash([]);
            const tip = to(p.points[p.points.length - 1]);
            ctx.fillStyle = `hsl(${hue}, 90%, 60%)`;
            ctx.fillRect(tip[0] - 2.5, tip[1] - 2.5, 5, 5);
          }
        });
        if (strike) cross(ctx, to(P), '#ffffff');
      },
      '#16141a',
    );
  });
  const scanned = dummies.filter((q) => q.scan).length;
  const turn = read.from === 'pose' ? 'read from the pose and held to the hand keys over f50–74' : `from ${read.from}`;
  const notes = [
    `The turn ${turn}; contact I f${I}, P (${P[0].toFixed(1)}, ${P[1].toFixed(1)}), d (${d[0].toFixed(3)}, ${d[1].toFixed(3)}); the limbs drawn on f${drawn}.`,
    `Internal frame ${W}×${H}: person masks cut every ${step.toFixed(2)} clip px, ${scanned} of ${n} frames scanned; root radius ${radius.toFixed(1)} clip px.`,
  ];
  return { rows: [{ title: 'The hero’s limbs as the scene moves them: onion skins over the body they collide with', cells }], notes };
}

// ---- The sheet ----------------------------------------------------------------------------------

const MOTION = args.positional[0] === 'motion';
if (args.positional.length > (MOTION ? 1 : 0)) throw new Error(`unexpected ${args.positional.join(' ')}\n${USAGE}`);
const motion = MOTION ? await motionRows() : null;
const hero = motion ? null : await heroRow();
const rows: Row[] = motion ? motion.rows : [tonesRow(), bandsRow(), growthRow(), detailsRow(), occlusionRow(), outlineRow(), hero!.row];
const PAD = 16;
const GAP = 8;
const TITLE = 34;
const LINE = 18;
const BANNER = motion
  ? [
      'Limb motion (decisions 15, 17 and 18): lift/lift.ts, lift/strand3d.ts, lift/strike.ts and lift/collide.ts on the hero’s stand-in drawings, not Qai’s.',
      'Each limb’s drawn centreline on every drawing of a stretch, blue first and red last, over his person mask (grey), the egg and the capsules.',
      ...motion.notes,
    ]
  : [
      'Limb brush (impact WP3, design §2): lift/tube.ts, render/limb.ts, render/tones.ts. Test scenes and the stand-in test drawings, not Qai’s.',
      'Synthetic rows at S 1080 (the 1080p export’s scale, 1:1); the hero row at S 608 (the app’s 1080×608). No glow (WP10’s compositor) and no arcs (WP4).',
      `Palette p0 ${PALETTE[0]}, p1 ${PALETTE[1]}, p2 ${PALETTE[2]}. Limb radius R0 = ${LIMB.radius} S × size/28; outline ${LIMB.linePx} S; bands ${LIMB.bands.join(' / ')}.`,
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
const file = join(outDir, motion ? 'limb-motion.png' : 'limb-sheet.png');
writeFileSync(file, sheet.toBuffer('image/png'));
if (motion) process.stdout.write(`limb motion: ${file} (${sheet.width}×${sheet.height})\n${motion.notes.join('\n')}\n`);
else process.stdout.write(`limb sheet: ${file} (${sheet.width}×${sheet.height})\n4 hero limbs at 1080×608: ${hero!.ms.toFixed(1)} ms (median of 10)\n${hero!.classes.join('\n')}\n`);
