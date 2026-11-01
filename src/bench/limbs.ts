// The limb bench (impact design §10, "Device gate"; WP17): times the impact's
// limb drawing and the main thread's share of a frame on the phone itself.
// bench.html runs it (`npm run dev:phone`, then /bench.html on the phone) and
// prints the medians; the unit test runs one iteration of each job in Node.
//   - The limbs: the hero's four test limbs at the test lengths, 32-point
//     constant-curvature arcs (limb-render.test.ts builds the same ones), over
//     a stand-in plate with heroclip's lumas and a stand-in mask of him.
//   - A limb drawing is design §10's worker line, the whole job for one
//     drawing: the four tubes built from the held limbs (the capture), their
//     outline classes, sheath arcs and pulses; per limb the far arcs, the
//     tube, then the near arcs and the pops, each in its layer, behind or
//     front; the glow they emit, blurred; and a 1 px readback of both layers,
//     so the raster work is done inside the time (the Node tests do the same).
//     Its drawings are the strike window's, j −8..−1 in turn, the ones the
//     worker draws ahead at 15 a second: 24 arcs is the full tier's 6 a limb,
//     12 the phone tier's cut 6, 3 a limb. The look is decision 8's: the root
//     burst, the crackle, the key light from the upper left turned toward P.
//   - The two layers hold all four limbs, sized to their box plus 0.1 S, the
//     way the stack keeps a cached layer (stack.ts): the bitmap of its box.
//   - The frame, on the main thread, each job after the plate is drawn and
//     settled, untimed: the pinned stamp (both layers through the similarity
//     about P that carries the roots 2.5, 4 px), the person cutout (drawPerson,
//     the mask decoded ahead at 1080×608, his half grade included), the grade
//     (applyGrade's three ops, the aftermath's g1, the heaviest), and the three
//     together in stack order, which is what the gate reads. A timed run does
//     its job 10 times in a row, then reads 1 px of the frame back through a
//     1×1 canvas, and counts a tenth of that: a frame's cost when frames run
//     back to back, with the readback's wait (timed alone too) shared out. The
//     frame's own context is never read back: Chrome moves a canvas that is
//     read back often onto the CPU, and the app never reads its view back.
//   - Timing: untimed warm-ups, then the median of 20 runs. The clock is passed
//     in, so nothing that draws reads one; only the page's glue below does.
// The gate: a 24-arc limb drawing ≤ 50 ms in the worker, and stamp + cutout +
// grade ≤ 14 ms on the main thread. A miss (no OffscreenCanvas 2D in a worker
// is one) means WP12 starts from the phone tier and records the numbers.
// The same file is the bench's worker: run in a worker scope it answers the
// page (the guard at the bottom), and anywhere else it only defines things.
import { jEnd } from '../impact/clock.ts';
import type { HeldLimb, Palette, Tube, Vec2 } from '../impact/contracts.ts';
import { sigmaOf, strikeFrame } from '../impact/floor.ts';
import { buildTube } from '../lift/tube.ts';
import { arcPhase, arcTones, drawArcs, emitArcs, nativePath, sectionAt, sheathArcs, type ArcPhase, type ArcRun, type ArcTarget, type LinePath } from '../render/arcs3d.ts';
import { drawPerson } from '../render/compose.ts';
import type { BrushTarget, MakeScratch, Pixels, Scratch } from '../render/glow.ts';
import { applyGrade, gradeAt, type Grade } from '../render/grade.ts';
import { createGlow } from '../render/light.ts';
import { drawLimb, keySwing, limbR0, limbTones, outlineClasses, plateLuma, stampPinned, type LimbTarget, type PlateLuma, type StampLayer, type StampTarget } from '../render/limb.ts';
import { drawPops, emitPops, emitPulses, limbClock, pulsesAt, pulseTimeline, type PopTarget } from '../render/pulse.ts';
import { frameMask, type Box } from '../render/stack.ts';
import type { Mask } from '../track/tracking.ts';

export const BENCH = {
  width: 1080, // the app's internal frame (design §10)
  height: 608,
  runs: 20, // timed runs per job: the median is the result
  warm: 5, // untimed runs before them
  repeat: 10, // frame jobs per timed run, read back once at the end
  arcs: [12, 24] as const, // sheath arcs per drawing: the phone tier's and the full tier's
  gate: { worker: 50, main: 14 }, // ms: a 24-arc limb drawing in the worker; stamp + cutout + grade on the main thread
  pad: 0.1, // × S round the limbs: the layers' box
} as const;

// heroclip (1920×1080): contact on f84 at P, the strike along d, the limbs
// drawn on f22 (limb drawing k 8), his mask box 609 px tall at I (σ 0.63), the
// slam's seed 84 and the default 1.5 s aftermath (J_end 45).
export const HERO = { clipHeight: 1080, I: 84, P: [942, 1061], d: [-0.06, 0.998], emerge: 8, personHeight: 609, seed: 84, aftermath: 1.5, torsoUnit: 182 } as const;

// The hero's four test limbs (impact/test-drawings.json, start.strokes): the
// root, the heading out of it, how far it turns and its length, clip px.
export const HERO_LIMBS = [
  { id: 1, root: [778, 300], heading: -114, turn: -88, length: 446 },
  { id: 2, root: [838, 300], heading: -62, turn: 85, length: 447 },
  { id: 3, root: [790, 345], heading: 169, turn: -80, length: 432 },
  { id: 4, root: [828, 345], heading: 8.5, turn: 80, length: 435 },
] as const;

const PALETTE: Palette = ['#e8203a', '#f4f1ea', '#16141a']; // the app's default, and the test drawings'
const SCALE = BENCH.height / HERO.clipHeight; // clip px to the app's
const S = Math.min(BENCH.width, BENCH.height);
const J_END = jEnd(HERO.aftermath);
const TIMELINE = pulseTimeline(HERO.emerge, HERO.I); // from 14, charge [28, 44]
const ARC = arcTones(PALETTE);
const TONES = limbTones(PALETTE);
const MOVE: Vec2 = [2.5, 4]; // px: how far his roots have moved since the drawing, for the stamp
const PROBE: Vec2 = [456, 255]; // frame px: the torso's centre, which every frame job draws over, read back to settle
const PERSON = [70, 62, 58] as const; // the stand-in person's colour (limb-sheet.ts)
const LABEL = {
  stamp: 'stamp: both limb layers, pinned about P',
  cutout: 'cutout: mask decoded ahead, half grade',
  grade: 'grade: 3 ops',
  frame: 'stamp + cutout + grade, one frame',
  readback: `readback alone: 1 px, 1/${BENCH.repeat} of it in each frame job`,
};

// The main thread's frame jobs, in the order the page times them.
export const FRAME_JOBS = ['stamp', 'cutout', 'grade', 'frame', 'readback'] as const;
export type FrameJob = (typeof FRAME_JOBS)[number];
export type ArcCount = (typeof BENCH.arcs)[number];

// ---- The scene --------------------------------------------------------------------------

export const heroP = (): Vec2 => [HERO.P[0] * SCALE, HERO.P[1] * SCALE];

// The four limbs as held limbs at the app's size: 32 points along each arc,
// dipping away from the camera like the lift's dish, the root inside him
// (behind) and the rest over him.
export function heroHeld(): HeldLimb[] {
  const n = 32;
  return HERO_LIMBS.map((l) => {
    const step = (l.length * SCALE) / (n - 1);
    const points: Vec2[] = [];
    const z: number[] = [];
    let [x, y] = [l.root[0] * SCALE, l.root[1] * SCALE];
    for (let i = 0; i < n; i++) {
      const d = i * step;
      points.push([x, y]);
      z.push(-0.3 * d - (0.08 * d * d) / (HERO.torsoUnit * SCALE));
      const a = ((l.heading + (l.turn * (i + 0.5)) / (n - 1)) * Math.PI) / 180;
      x += Math.cos(a) * step;
      y += Math.sin(a) * step;
    }
    const pressure = points.map((_, i) => (i <= 4 ? 0.8 + 0.05 * i : 1 - (0.9 * (i - 4)) / (n - 5)));
    return { id: l.id, points, z, pressure, front: points.map((_, i) => i > 4), length: step * (n - 1) };
  });
}

// A stand-in for his mask at 1080×608 (the repo carries no footage): a head,
// a torso and capsules for the arms and legs, about 290 × 520 px, with the
// limbs' roots inside the torso.
export function standInMask(): Mask {
  const { width, height } = BENCH;
  const alpha = new Uint8ClampedArray(width * height);
  const capsules = [
    [410, 170, 330, 300, 18], // the arms
    [502, 170, 585, 300, 18],
    [430, 360, 405, 560, 24], // the legs
    [482, 360, 510, 560, 24],
  ] as const;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [px, py] = [x + 0.5, y + 0.5];
      const inside =
        Math.hypot(px - 455, py - 105) < 32 ||
        ((px - 456) / 62) ** 2 + ((py - 255) / 120) ** 2 < 1 ||
        capsules.some(([x0, y0, x1, y1, r]) => toSegment(px, py, x0, y0, x1, y1) < r);
      if (inside) alpha[y * width + x] = 255;
    }
  }
  return { width, height, alpha };
}

// What every job draws over: his mask, the clip frame with him in it, and its
// luma for the outline classes.
export interface Scene {
  mask: Mask;
  video: Scratch;
  luma: PlateLuma;
}

// The clip frame: heroclip's lumas round him as limb-sheet.ts stands them in
// (the wall Y 130, the floor Y 95 from y 470, the dark dresser Y 19 lower
// left), and the stand-in person where the mask is.
export function standInScene(make: MakeScratch): Scene {
  const { width, height } = BENCH;
  const mask = standInMask();
  const video = make(width, height);
  const ctx = video.ctx as BrushTarget & { createImageData(w: number, h: number): Pixels };
  const pixels = ctx.createImageData(width, height);
  const data = pixels.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const grey = x >= 120 && x < 420 && y >= 175 && y < 470 ? 19 : y >= 470 ? 95 : 130;
      const [r, g, b] = mask.alpha[i] > 0 ? PERSON : [grey, grey, grey];
      data[4 * i] = r;
      data[4 * i + 1] = g;
      data[4 * i + 2] = b;
      data[4 * i + 3] = 255;
    }
  }
  ctx.putImageData(pixels, 0, 0);
  return { mask, video, luma: plateLuma(pixels) };
}

// ---- The limb drawing -------------------------------------------------------------------

// Drawing i of a run: the strike window's limb drawings, j −8..−1 in turn.
export interface Drawing {
  j: number; // frames since contact
  k: number; // the limbs' electricity clock (limbClock)
  age: number; // limb drawings since the emergence
  phase: ArcPhase;
  swing: number; // the key light's turn toward P (keySwing): 0 on S0, 1 from j −7
}

export function drawingOf(i: number): Drawing {
  const j = -8 + (((i % 8) + 8) % 8);
  const k = limbClock(HERO.I + j, HERO.I);
  const age = k - HERO.emerge;
  return { j, k, age, phase: arcPhase(age, j) ?? { kind: 'idle' }, swing: keySwing(j, J_END) };
}

export interface DrawingStats {
  arcs: number; // sheath arcs drawn, all four limbs
  pulses: number;
  pops: number;
  glow: boolean; // anything emitted
}

export interface LimbBenchOptions {
  scene?: Scene; // missing = standInScene(make)
  newPath?: (() => LinePath) | null; // drawArcs' path maker: missing = the page's Path2D; Node passes @napi-rs/canvas's
}

export interface LimbBench {
  scene: Scene;
  box: Box; // the layers' place on the frame
  behind: Scratch; // the two cached layers, box-sized
  front: Scratch;
  draw(arcs: ArcCount, i: number): DrawingStats;
}

type LayerTarget = LimbTarget & ArcTarget & PopTarget;

export function createLimbBench(make: MakeScratch, opts: LimbBenchOptions = {}): LimbBench {
  const scene = opts.scene ?? standInScene(make);
  const newPath = opts.newPath === undefined ? nativePath() : opts.newPath;
  const R0 = limbR0(S);
  const limbs = heroHeld();
  const box = layerBox(limbs.map((held) => buildTube(held, R0)));
  const [w, h] = [box.x1 - box.x0, box.y1 - box.y0];
  const behind = make(w, h);
  const front = make(w, h);
  const glow = createGlow(make, BENCH.width, BENCH.height, { main: PALETTE[0] });
  const P = heroP();
  const b = behind.ctx as unknown as LayerTarget;
  const f = front.ctx as unknown as LayerTarget;
  const layer = (runs: readonly ArcRun[], inFront: boolean) => runs.filter((run) => run.front === inFront);
  return {
    scene,
    box,
    behind,
    front,
    draw(arcs, i) {
      const d = drawingOf(i);
      const swing = d.swing > 0 ? { P, w: d.swing } : null;
      for (const ctx of [behind.ctx, front.ctx]) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.clearRect(0, 0, w, h);
        ctx.setTransform(1, 0, 0, 1, -box.x0, -box.y0); // frame px from here on
      }
      glow.clear();
      const stats: DrawingStats = { arcs: 0, pulses: 0, pops: 0, glow: false };
      for (const held of limbs) {
        const tube = buildTube(held, R0);
        const outline = outlineClasses(tube, scene.luma, { S, palette: PALETTE });
        const { far, near } = sheathArcs(tube, d.k, d.phase, held.id, { S, P, fewer: arcs === 12 });
        const { spans, pops } = pulsesAt(held.id, d.k, TIMELINE);
        drawArcs(b, layer(far, false), ARC, newPath);
        drawArcs(f, layer(far, true), ARC, newPath);
        drawLimb(b, f, tube, { S, k: d.k, palette: PALETTE, age: d.age, pulses: spans, swing, outline, mask: scene.mask, glow });
        drawArcs(b, layer(near, false), ARC, newPath);
        drawArcs(f, layer(near, true), ARC, newPath);
        for (const pop of pops) drawPops(sectionAt(tube, pop.s).front ? f : b, tube, [pop], ARC);
        emitArcs(glow, [...far, ...near], 1, ARC);
        emitPulses(glow, tube, spans, 1, TONES);
        emitPops(glow, tube, pops, 1, ARC);
        stats.arcs += new Set([...far, ...near].filter((run) => run.kind === 'sheath').map((run) => run.arc)).size;
        stats.pulses += spans.length;
        stats.pops += pops.length;
      }
      stats.glow = !glow.empty;
      glow.blur();
      behind.ctx.getImageData(0, 0, 1, 1); // make sure the raster work is done
      front.ctx.getImageData(0, 0, 1, 1);
      return stats;
    },
  };
}

// The limb layers as the stamp takes them: behind, then front.
export function layersOf(bench: Pick<LimbBench, 'box' | 'behind' | 'front'>): [StampLayer, StampLayer] {
  return [bench.behind.canvas, bench.front.canvas].map((image): StampLayer => ({ image, ...boxLayer(bench.box) })) as [StampLayer, StampLayer];
}

// ---- The frame --------------------------------------------------------------------------

export interface FrameBenchOptions {
  scene?: Scene; // missing = standInScene(make)
  target?: Scratch; // the frame: missing = make(1080, 608); the page passes its on-screen canvas, as the app draws onto its view
  layers?: readonly [StampLayer, StampLayer]; // behind and front: missing = a 24-arc drawing (j −5) made here
  newPath?: (() => LinePath) | null; // for that drawing
}

export interface FrameBench {
  target: Scratch;
  plate(): void; // the clip frame onto the frame, ungraded: what the others draw over
  grade(): void;
  stamp(): void;
  cutout(): void;
  frame(): void; // grade, stamp behind, cutout, stamp front: the stack's order
  settle(): void; // reads 1 px of the frame back, through a 1×1 canvas
}

// The grade the frame times: the aftermath's first hold group (j 12), which
// uses all three of applyGrade's ops: the 'color' fill, the 'screen' pool
// round P and the 'multiply' white balance.
export function benchGrade(): Grade {
  const { width, height } = BENCH;
  const frame = strikeFrame(heroP(), [HERO.d[0], HERO.d[1]], S, sigmaOf(HERO.personHeight * SCALE, S), width, height, HERO.seed);
  return gradeAt(12, { jEnd: J_END, frame, palette: PALETTE });
}

export function createFrameBench(make: MakeScratch, opts: FrameBenchOptions = {}): FrameBench {
  const { width, height } = BENCH;
  const scene = opts.scene ?? standInScene(make);
  const target = opts.target ?? make(width, height);
  const layers = opts.layers ?? drawnLayers(make, scene, opts.newPath);
  const ctx = target.ctx;
  const grade = benchGrade();
  const P = heroP();
  const roots = heroHeld().map((held) => held.points[0]);
  const rootOld: Vec2 = [roots.reduce((s, p) => s + p[0], 0) / roots.length, roots.reduce((s, p) => s + p[1], 0) / roots.length];
  const rootNew: Vec2 = [rootOld[0] + MOVE[0], rootOld[1] + MOVE[1]];
  frameMask(make, scene.mask, width, height); // decoded ahead, as the app does for the next frames
  const probe = make(1, 1);
  const stamp = (layer: StampLayer) => stampPinned(ctx as unknown as StampTarget, layer, rootOld, rootNew, P);
  const bench: FrameBench = {
    target,
    plate() {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.drawImage(scene.video.canvas as never, 0, 0, width, height, 0, 0, width, height);
    },
    grade: () => applyGrade(ctx, grade, width, height),
    stamp() {
      stamp(layers[0]);
      stamp(layers[1]);
    },
    cutout: () => drawPerson(ctx as unknown as CanvasRenderingContext2D, make, scene.video.canvas as unknown as CanvasImageSource, scene.mask, width, height, grade),
    frame() {
      bench.grade();
      stamp(layers[0]);
      bench.cutout();
      stamp(layers[1]);
    },
    settle() {
      probe.ctx.drawImage(target.canvas as never, PROBE[0], PROBE[1], 1, 1, 0, 0, 1, 1);
      probe.ctx.getImageData(0, 0, 1, 1);
    },
  };
  return bench;
}

function drawnLayers(make: MakeScratch, scene: Scene, newPath: (() => LinePath) | null | undefined): [StampLayer, StampLayer] {
  const limbs = createLimbBench(make, { scene, newPath });
  limbs.draw(24, 3);
  return layersOf(limbs);
}

// ---- Timing and the gate ----------------------------------------------------------------

export interface TimeOptions {
  runs?: number; // missing = BENCH.runs
  warm?: number; // missing = BENCH.warm
  setup?: (i: number) => void; // before each run, untimed
  repeat?: number; // timeFrame's jobs per run: missing = BENCH.repeat
}

// Run i's times, ms, after the warm-ups (runs `runs`.. on). `now` is the
// clock: the page passes performance.now, the tests a fake one.
export function timeRuns(run: (i: number) => void, now: () => number, opts: TimeOptions = {}): number[] {
  const runs = opts.runs ?? BENCH.runs;
  const warm = opts.warm ?? BENCH.warm;
  const once = (i: number) => {
    opts.setup?.(i);
    const t0 = now();
    run(i);
    return now() - t0;
  };
  for (let i = 0; i < warm; i++) once(runs + i);
  return Array.from({ length: runs }, (_, i) => once(i));
}

// The middle time; with an even count, the mean of the middle two.
export function median(ms: readonly number[]): number {
  if (ms.length === 0) return NaN;
  const sorted = [...ms].sort((a, b) => a - b);
  const h = sorted.length >> 1;
  return sorted.length % 2 ? sorted[h] : (sorted[h - 1] + sorted[h]) / 2;
}

// One job's times.
export interface Series {
  key: string; // 'limbs12', 'limbs24' or a FrameJob
  label: string;
  ms: number[];
  arcs?: number; // a limb drawing's sheath arcs
}

export function timeLimbs(bench: LimbBench, arcs: ArcCount, now: () => number, opts: TimeOptions = {}): Series {
  let drawn = 0;
  const ms = timeRuns((i) => void (drawn = bench.draw(arcs, i).arcs), now, opts);
  return { key: `limbs${arcs}`, label: `limb drawing, ${arcs} arcs`, ms, arcs: drawn };
}

// A frame job's time per frame: `repeat` of them in a row, then one readback,
// over the plate drawn and settled untimed. The readback runs once, alone.
export function timeFrame(bench: FrameBench, job: FrameJob, now: () => number, opts: TimeOptions = {}): Series {
  const draw = job === 'readback' ? null : bench[job];
  const repeat = draw ? Math.max(1, opts.repeat ?? BENCH.repeat) : 1;
  const settled = () => {
    bench.plate();
    bench.settle();
  };
  const ms = timeRuns(() => {
    for (let n = 0; n < repeat; n++) draw?.();
    bench.settle();
  }, now, { ...opts, setup: settled });
  return { key: job, label: LABEL[job], ms: ms.map((t) => t / repeat) };
}

export interface Gate {
  worker: number | null; // ms: the 24-arc limb drawing's median in the worker; null when it couldn't run there
  main: number; // ms: stamp + cutout + grade, one frame, median
  workerPass: boolean;
  mainPass: boolean;
  pass: boolean;
}

export function gateOf(worker: readonly Series[] | null, main: readonly Series[]): Gate {
  const at = (list: readonly Series[] | null, key: string) => {
    const series = list?.find((s) => s.key === key);
    return series ? median(series.ms) : null;
  };
  const w = at(worker, 'limbs24');
  const m = at(main, 'frame') ?? NaN;
  const workerPass = w !== null && w <= BENCH.gate.worker;
  const mainPass = m <= BENCH.gate.main;
  return { worker: w, main: m, workerPass, mainPass, pass: workerPass && mainPass };
}

export interface BenchReport {
  runs: number;
  warm: number;
  repeat: number; // frame jobs per run
  worker: Series[] | null; // null: no OffscreenCanvas 2D in a worker, or no worker
  workerNote: string; // what ran the worker's jobs, or why it couldn't
  main: Series[]; // the limb drawings, then the frame jobs
  stamped: string; // what the stamp drew: the worker's bitmaps or this thread's canvases
  hidden: boolean; // the page went to the background during the run, so the times are off
  device: string;
}

// The results as text, for Qai to post.
export function formatReport(r: BenchReport): string {
  const gate = gateOf(r.worker, r.main);
  const ms = (v: number) => `${v.toFixed(1)} ms`;
  const line = (where: string, s: Series, mark = '') => `${where}, ${s.label}: ${ms(median(s.ms))} (${ms(Math.min(...s.ms))} to ${ms(Math.max(...s.ms))})${mark}`;
  const verdict = (pass: boolean) => (pass ? 'pass' : 'miss');
  const lines = [`Inkwell limb bench (WP17): medians of ${r.runs} runs at ${BENCH.width}×${BENCH.height}, after ${r.warm} warm-ups; frame jobs per frame, ${r.repeat} in a row and read back once`];
  if (r.worker) for (const s of r.worker) lines.push(line('worker', s, s.key === 'limbs24' ? `; gate ≤ ${BENCH.gate.worker} ms: ${verdict(gate.workerPass)}` : ''));
  else lines.push(`worker, limb drawing, 24 arcs: not run; gate ≤ ${BENCH.gate.worker} ms: miss`);
  for (const s of r.main) lines.push(line('main', s, s.key === 'frame' ? `; gate ≤ ${BENCH.gate.main} ms: ${verdict(gate.mainPass)}` : ''));
  lines.push(gate.pass ? 'gate: pass, WP12 can start from the full tier' : 'gate: miss, WP12 starts from the phone tier and records these numbers');
  lines.push(`worker: ${r.workerNote}; stamped: ${r.stamped}`);
  lines.push(`device: ${r.device}`);
  if (r.hidden) lines.push('the page went to the background during the run: run it again with the screen on');
  return lines.join('\n');
}

// ---- Small helpers ------------------------------------------------------------------------

// The four tubes' box on the frame, padded by 0.1 S: room for the arcs (λ up
// to 2.1 r), the root burst (2.4 × the root radius) and the crackle's sparks.
function layerBox(tubes: readonly Tube[]): Box {
  const pad = BENCH.pad * S;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const tube of tubes) {
    for (const { screen, r } of tube.sections) {
      x0 = Math.min(x0, screen[0] - r);
      y0 = Math.min(y0, screen[1] - r);
      x1 = Math.max(x1, screen[0] + r);
      y1 = Math.max(y1, screen[1] + r);
    }
  }
  return {
    x0: Math.max(0, Math.floor(x0 - pad)),
    y0: Math.max(0, Math.floor(y0 - pad)),
    x1: Math.min(BENCH.width, Math.ceil(x1 + pad)),
    y1: Math.min(BENCH.height, Math.ceil(y1 + pad)),
  };
}

const boxLayer = (box: Box) => ({ width: box.x1 - box.x0, height: box.y1 - box.y0, x0: box.x0, y0: box.y0 });

// The distance from (x, y) to the segment from (x0, y0) to (x1, y1).
function toSegment(x: number, y: number, x0: number, y0: number, x1: number, y1: number): number {
  const [dx, dy] = [x1 - x0, y1 - y0];
  const t = Math.min(1, Math.max(0, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy));
}

// ---- In the browser: the worker and the page ----------------------------------------------

type ToWorker = { type: 'run'; runs: number; warm: number };
type FromWorker =
  | { type: 'progress'; text: string }
  | { type: 'done'; series: Series[]; box: Box; layers: ImageBitmap[] }
  | { type: 'no2d' }
  | { type: 'error'; message: string };

interface WorkerScope {
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (e: MessageEvent<ToWorker>) => void): void;
}

// Canvases in the browser, made as the app makes them (engine.ts's
// browserScratch): an OffscreenCanvas where there is one, which a worker
// needs, and a context that says it reads back, so Safari and Chrome keep it
// on the CPU.
export const browserMake: MakeScratch = (width, height) => {
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as unknown as BrushTarget | null;
  if (!ctx) throw new Error(`no 2D context for a ${width}×${height} canvas`);
  return { canvas, ctx };
};

// The worker's side: on 'run', both limb series on OffscreenCanvas, then the
// last drawing's layers as bitmaps, which the page stamps.
export function serveBench(scope: WorkerScope): void {
  const now = () => performance.now();
  scope.addEventListener('message', (e) => {
    if (e.data?.type !== 'run') return;
    const opts = { runs: e.data.runs, warm: e.data.warm };
    try {
      if (typeof OffscreenCanvas === 'undefined' || !new OffscreenCanvas(1, 1).getContext('2d')) return scope.postMessage({ type: 'no2d' });
      const bench = createLimbBench(browserMake);
      const series: Series[] = [];
      for (const arcs of BENCH.arcs) {
        scope.postMessage({ type: 'progress', text: `In the worker: limb drawings with ${arcs} arcs` });
        series.push(timeLimbs(bench, arcs, now, opts));
      }
      const layers = [bench.behind, bench.front].map((s) => (s.canvas as OffscreenCanvas).transferToImageBitmap());
      scope.postMessage({ type: 'done', series, box: bench.box, layers }, layers);
    } catch (err) {
      scope.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  });
}

interface WorkerRun {
  series: Series[] | null;
  note: string;
  layers: [StampLayer, StampLayer] | null;
}

// Starts the worker on this same file and waits for its series.
function runWorker(say: (text: string) => void, opts: { runs: number; warm: number }): Promise<WorkerRun> {
  return new Promise((resolve) => {
    let worker: Worker | null = null;
    let timer = 0;
    const finish = (run: WorkerRun) => {
      clearTimeout(timer);
      worker?.terminate();
      resolve(run);
    };
    const failed = (note: string) => finish({ series: null, note, layers: null });
    try {
      worker = new Worker(new URL(import.meta.url), { type: 'module' });
    } catch (err) {
      failed(`no module worker (${err instanceof Error ? err.message : String(err)})`);
      return;
    }
    timer = window.setTimeout(() => failed('the worker gave no answer in 120 s'), 120_000);
    worker.addEventListener('message', (e: MessageEvent<FromWorker>) => {
      const msg = e.data;
      if (msg.type === 'progress') say(msg.text);
      else if (msg.type === 'no2d') failed('no OffscreenCanvas 2D in a worker, so WP12 would draw on the main thread');
      else if (msg.type === 'error') failed(`the worker failed: ${msg.message}`);
      else {
        const [behind, front] = msg.layers;
        const at = boxLayer(msg.box);
        finish({ series: msg.series, note: 'OffscreenCanvas 2D', layers: [{ image: behind, ...at }, { image: front, ...at }] });
      }
    });
    worker.addEventListener('error', (e) => failed(`the worker didn't start (${e.message || 'no detail'})`));
    worker.postMessage({ type: 'run', ...opts } satisfies ToWorker);
  });
}

// The smallest step the clock takes: Safari rounds performance.now.
function timerStep(now: () => number): number {
  let step = Infinity;
  for (let n = 0; n < 5; n++) {
    const t0 = now();
    let t1 = now();
    while (t1 === t0) t1 = now();
    step = Math.min(step, t1 - t0);
  }
  return step;
}

const rest = () => new Promise<void>((done) => setTimeout(done, 60)); // lets the status paint between jobs

// The whole bench: the worker's series, this thread's, then the frame jobs on
// the page's canvas.
async function runBench(view: HTMLCanvasElement, say: (text: string) => void): Promise<BenchReport> {
  const now = () => performance.now();
  const opts = { runs: BENCH.runs, warm: BENCH.warm, repeat: BENCH.repeat };
  let hidden = document.hidden;
  const onHide = () => void (hidden ||= document.hidden);
  document.addEventListener('visibilitychange', onHide);
  try {
    say('In the worker: starting');
    const worker = await runWorker(say, opts);
    const limbs = createLimbBench(browserMake);
    const main: Series[] = [];
    for (const arcs of BENCH.arcs) {
      say(`On this thread: limb drawings with ${arcs} arcs`);
      await rest();
      main.push(timeLimbs(limbs, arcs, now, opts));
    }
    const ctx = view.getContext('2d');
    if (!ctx) throw new Error('the page canvas has no 2D context');
    const frame = createFrameBench(browserMake, { scene: limbs.scene, target: { canvas: view, ctx: ctx as unknown as BrushTarget }, layers: worker.layers ?? layersOf(limbs) });
    for (const job of FRAME_JOBS) {
      say(`On this thread: ${LABEL[job]}`);
      await rest();
      main.push(timeFrame(frame, job, now, opts));
    }
    frame.plate();
    frame.frame(); // leave the frame on screen
    const device = `${navigator.userAgent}; dpr ${devicePixelRatio}; ${navigator.hardwareConcurrency || '?'} cores; timer step ${timerStep(now).toFixed(3)} ms`;
    return { ...opts, worker: worker.series, workerNote: worker.note, main, stamped: worker.layers ? 'the worker’s bitmaps' : 'this thread’s canvases', hidden, device };
  } finally {
    document.removeEventListener('visibilitychange', onHide);
  }
}

// The page's rows and verdict.
function show(doc: Document, r: BenchReport) {
  const gate = gateOf(r.worker, r.main);
  const body = doc.getElementById('results') as HTMLTableSectionElement;
  const ms = (v: number) => v.toFixed(1);
  body.replaceChildren();
  const row = (cells: string[], mark: 'pass' | 'miss' | null) => {
    const tr = doc.createElement('tr');
    cells.forEach((text, i) => {
      const td = doc.createElement('td');
      td.textContent = text;
      if (i >= 2 && i <= 3) td.className = 'num';
      if (i === 4 && mark) td.className = mark;
      tr.append(td);
    });
    body.append(tr);
  };
  const series = (where: string, s: Series, limit: number | null, pass: boolean) =>
    row([where, s.label, ms(median(s.ms)), `${ms(Math.min(...s.ms))}–${ms(Math.max(...s.ms))}`, limit === null ? '' : `≤ ${limit}: ${pass ? 'pass' : 'miss'}`], limit === null ? null : pass ? 'pass' : 'miss');
  if (r.worker) for (const s of r.worker) series('worker', s, s.key === 'limbs24' ? BENCH.gate.worker : null, gate.workerPass);
  else row(['worker', r.workerNote, '–', '–', `≤ ${BENCH.gate.worker}: miss`], 'miss');
  for (const s of r.main) series('main', s, s.key === 'frame' ? BENCH.gate.main : null, gate.mainPass);
  const verdict = doc.getElementById('verdict')!;
  verdict.hidden = false;
  verdict.className = gate.pass ? 'pass' : 'miss';
  verdict.textContent = gate.pass ? 'Gate: pass. WP12 can start from the full tier.' : 'Gate: miss. WP12 starts from the phone tier and records these numbers.';
  const report = doc.getElementById('report') as HTMLTextAreaElement;
  report.value = formatReport(r);
  doc.getElementById('report-box')!.hidden = false;
}

// bench.html's script: wires up Run and Copy.
export function mountBench(doc: Document = document): void {
  const run = doc.getElementById('run') as HTMLButtonElement;
  const copy = doc.getElementById('copy') as HTMLButtonElement;
  const status = doc.getElementById('status')!;
  const report = doc.getElementById('report') as HTMLTextAreaElement;
  const view = doc.getElementById('frame') as HTMLCanvasElement;
  const say = (text: string) => void (status.textContent = text);
  run.addEventListener('click', async () => {
    run.disabled = true;
    try {
      const r = await runBench(view, say);
      show(doc, r);
      say(r.hidden ? 'Done, but the page went to the background: run it again.' : 'Done. Copy the results and post them.');
    } catch (err) {
      say(`The bench failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      run.disabled = false;
    }
  });
  copy.addEventListener('click', async () => {
    report.select();
    try {
      await navigator.clipboard.writeText(report.value);
      say('Copied.');
    } catch {
      say(doc.execCommand('copy') ? 'Copied.' : 'Select the text and copy it.');
    }
  });
}

// In a worker scope this file is the bench's worker.
const scope = globalThis as unknown as { WorkerGlobalScope?: abstract new () => unknown };
if (typeof scope.WorkerGlobalScope === 'function' && globalThis instanceof scope.WorkerGlobalScope) serveBench(globalThis as unknown as WorkerScope);
