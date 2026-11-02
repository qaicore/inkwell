// The slam bench (impact design §10; round 3, F7): times the frames that miss
// the budget in Node, on the phone itself, from inputs the phone has without
// the clip. bench.html runs it after the limb bench (limbs.ts), the worker's
// part in the worker and the frames on the page's canvas; the unit test runs
// it once in Node.
//   - The slam: the scene budget test's synthetic one (tests/unit/helpers/
//     impact-scene-clip.ts, built again here, since src never imports a test):
//     the hero's numbers (contact on f84 at P, striking along d, seed 84, the
//     floor of decision 10) on frames/figure.ts's crouching blob at 1920×1080,
//     four limbs drawn out of his back on f22, six cracks from P with the
//     hero's directions and lengths, and the turn tapped at f60. The plate is
//     mid-grey. The whole impact scene (scene.ts) runs on it at 1080×608.
//   - Main thread: a whole strike frame (j −8..−1, f76–83) and a whole
//     aftermath frame (j 18–28, f102–112), each render() onto the frame and a
//     1 px readback through a 1×1 canvas, as limbs.ts settles. Before each
//     frame its drawings are run ahead untimed (the worker's work), and the
//     two frames before each window are drawn untimed, as playback would have.
//     The result is the median frame; the design's line is 26 ms.
//   - Worker: every drawing due on f93–115 (j 9..31, the aftermath's first
//     23 frames, j 9's limb and mass drawings included), each drawn alone and
//     read back 1 px a part, as the worker runs them; their sum over the
//     window's 767 ms is the load. The design's line is 80 %.
// One pass of each, on a fresh scene (the physics included, untimed): about
// 3 s of work in Node, so the whole bench stays near 25 s on a phone.
import { brushSizeForWidth, syntheticCrouch } from '../impact/frames/figure.ts';
import { createImpactScene, type ImpactClip, type ImpactScene } from '../impact/scene.ts';
import { MAIN_BUDGET, WORKER_LOAD } from '../impact/tiers.ts';
import type { DrawingJob, DrawnLayer } from '../impact/contracts.ts';
import type { LinePath } from '../render/arcs3d.ts';
import type { BrushTarget, MakeScratch, Scratch } from '../render/glow.ts';
import type { Mask, Pose } from '../track/tracking.ts';
import { anchorTransform, toTorso } from '../track/torso.ts';
import type { Effect, Moment, Stroke, Vec2 } from '../types/effect.ts';

const FPS = 30;
const WIDTH = 1920; // the synthetic clip, px
const HEIGHT = 1080;
const FRAMES = 180;
const DRAWN = 22; // the limbs' emerge frame, which they're drawn on
const UNIT = 200; // his torso, clip px
const PLATE = 128; // the plate's grey, 8-bit
const LIMB_IDS = [1, 2, 3, 4];
const ROOT = [0.125, 0.26] as const; // the anchor (his back), × S along (side, up) from P
const HEAD = [0.07, 0.375, 0.046, 0.056] as const; // syntheticCrouch's head ellipse: centre and radii, × S
const FLOOR = { ratio: 0.763, majorDeg: 2.6, up: [0.04, -1] as [number, number], persp: 0.68 };
const PALETTE: Effect['palette'] = ['#e8203a', '#f4f1ea', '#16141a'];

// The limbs as drawn on f22: cubics from his back, up and out, × S along
// (side, up) from P: root, two controls, tip. About 0.4 S long.
const CURVES: readonly (readonly number[])[] = [
  [0.105, 0.29, 0.15, 0.45, 0.3, 0.6, 0.42, 0.62],
  [0.135, 0.275, 0.22, 0.4, 0.4, 0.5, 0.5, 0.45],
  [0.115, 0.25, 0.2, 0.32, 0.38, 0.33, 0.48, 0.25],
  [0.145, 0.235, 0.25, 0.25, 0.4, 0.18, 0.46, 0.08],
];

// The hero's six cracks (impact/test-drawings.json, end.strokes) as rays from
// P: the id, the heading (degrees, y down) and the length to the last point,
// clip px. Each is drawn as a jagged line tapering 7 → 1.4 px.
const CRACKS = [
  { id: 11, heading: 180, length: 432 },
  { id: 12, heading: -132, length: 162 },
  { id: 13, heading: -66, length: 248 },
  { id: 14, heading: -44, length: 180 },
  { id: 15, heading: -3.5, length: 259 },
  { id: 16, heading: 21, length: 50 },
] as const;

// The slam's numbers: the clip frames each part of the bench covers.
export const SLAM = {
  I: 84, // contact
  P: [942, 1061] as Vec2,
  d: [-0.06, 0.998] as Vec2,
  seed: 84,
  strike: [76, 83] as const, // j −8..−1
  aftermath: [102, 112] as const, // j 18..28
  load: [93, 115] as const, // j 9..31: the drawings due here, against the window
  lead: 2, // frames drawn untimed before each timed window
  line: { main: MAIN_BUDGET, load: WORKER_LOAD }, // design §10: 26 ms a main-thread frame, the worker at most 80 % busy
} as const;

export const SLAM_FRAMES = ['strike', 'aftermath'] as const;
export type SlamFrame = (typeof SLAM_FRAMES)[number];

const LABEL: Record<SlamFrame, string> = {
  strike: 'strike frame, f76–83 (j −8..−1)',
  aftermath: 'aftermath frame, f102–112 (j 18–28)',
};

// ---- The synthetic slam ------------------------------------------------------------------

export interface SlamInputs {
  effect: Effect;
  clip: ImpactClip;
}

export function slamInputs(): SlamInputs {
  const { P, d } = SLAM;
  const S = Math.min(WIDTH, HEIGHT);
  const up: Vec2 = [-d[0], -d[1]];
  const side: Vec2 = [d[1], -d[0]];
  const at = (s: number, t: number): Vec2 => [P[0] + S * (s * side[0] + t * up[0]), P[1] + S * (s * side[1] + t * up[1])];
  const root = at(ROOT[0], ROOT[1]);
  // The anchor drifts a couple of px and rolls a little.
  const poses: Pose[] = Array.from({ length: FRAMES }, (_, f) => ({ x: root[0] + 2 * Math.sin(f / 9), y: root[1] + 1.5 * Math.sin(f / 7), angle: 0.01 * Math.sin(f / 11), scale: 1 }));
  const torso = anchorTransform(poses[DRAWN], UNIT);
  const limbs: Stroke[] = CURVES.map((c, i) => {
    const n = 24;
    const px = Array.from({ length: n + 1 }, (_, k): Vec2 => {
      const q = k / n;
      const w = [(1 - q) ** 3, 3 * q * (1 - q) ** 2, 3 * q * q * (1 - q), q ** 3];
      return at(w[0] * c[0] + w[1] * c[2] + w[2] * c[4] + w[3] * c[6], w[0] * c[1] + w[1] * c[3] + w[2] * c[5] + w[3] * c[7]);
    });
    const points = px.map((p) => toTorso(torso, p));
    return {
      id: LIMB_IDS[i],
      color: 0,
      brush: 'limb',
      kind: 'strand',
      anchor: { type: 'concept', prompt: 'back' },
      bodyAngle: 180,
      stiffness: 0.1,
      wobble: 1,
      views: { front: { points, pressure: points.map((_, k) => 1 - (0.6 * k) / n), root: points[0], layer: 'behind' } },
    };
  });
  const cracks = CRACKS.map((c): Stroke => {
    const n = Math.max(3, Math.round(c.length / 18));
    const a = (c.heading * Math.PI) / 180;
    const [ux, uy] = [Math.cos(a), Math.sin(a)];
    const points = Array.from({ length: n + 1 }, (_, k): Vec2 => {
      const t = (k / n) * c.length;
      const off = k === 0 ? 0 : 6 * Math.sin(1.7 * k + c.id); // the jag, px across the ray
      return [P[0] + t * ux - off * uy, P[1] + t * uy + off * ux];
    });
    const width = points.map((_, k) => 7 - (5.6 * k) / n);
    return {
      id: c.id,
      color: 2,
      size: brushSizeForWidth(width, WIDTH),
      kind: 'rigid',
      anchor: { type: 'ground', xy: [P[0], P[1]] },
      bodyAngle: 0,
      stiffness: 1,
      wobble: 0,
      views: { front: { points, pressure: points.map((_, k) => 1 - (0.78 * k) / n), root: [P[0], P[1]], layer: 'behind' } },
    };
  });
  const slam: Moment = {
    kind: 'slam',
    at: SLAM.I / FPS,
    xy: [P[0], P[1]],
    by: 'body',
    dir: [d[0], d[1]],
    seed: SLAM.seed,
    strokes: CRACKS.map((c) => c.id),
    limbs: LIMB_IDS,
    frames: { count: 7, flash: 'full' },
    aftermath: { seconds: 1.5, scale: 1, scarSeconds: 3 },
    floor: FLOOR,
  };
  const effect: Effect = {
    version: 1,
    brush: { size: 28, thinning: 0.65, smoothing: 0.6, streamline: 0.45 },
    palette: PALETTE,
    timing: { drawingsPerSecond: 12 },
    strokes: [...limbs, ...cracks],
    moments: [{ kind: 'emerge', at: DRAWN / FPS, strokes: LIMB_IDS }, slam],
    turn: { at: 2, dir: 1 },
    overrides: {},
  };
  const person = syntheticCrouch(WIDTH, HEIGHT, P, d, S).mask;
  const face = quarterMask(WIDTH / 4, HEIGHT / 4, (x, y) => {
    const rx = (4 * x + 2 - P[0]) / S;
    const ry = (4 * y + 2 - P[1]) / S;
    const s = rx * side[0] + ry * side[1];
    const t = rx * up[0] + ry * up[1];
    return Math.hypot((s - HEAD[0]) / HEAD[2], (t - HEAD[1]) / HEAD[3]) <= 1;
  });
  const clip: ImpactClip = {
    width: WIDTH,
    height: HEIGHT,
    frames: FRAMES,
    personMask: () => person,
    faceMask: () => face,
    poses,
    bodies: null,
    units: Array.from({ length: FRAMES }, () => UNIT),
    luma: () => () => PLATE,
  };
  return { effect, clip };
}

// A mask w × h, 255 where `inside`.
function quarterMask(w: number, h: number, inside: (x: number, y: number) => boolean): Mask {
  const alpha = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (inside(x, y)) alpha[y * w + x] = 255;
  return { width: w, height: h, alpha };
}

// ---- The bench ---------------------------------------------------------------------------

export interface SlamBenchOptions {
  inputs?: SlamInputs; // missing = slamInputs()
  target?: Scratch; // the frame: missing = make(W, H); the page passes its on-screen canvas
  cuts?: number; // the cut order's steps (tiers.ts); missing = 0, the full tier
  newPath?: (() => LinePath) | null; // missing = the page's Path2D; Node passes @napi-rs/canvas's
}

export interface SlamBench {
  scene: ImpactScene;
  target: Scratch;
  ahead(o: number): void; // runs the jobs listed up to frame o, untimed
  render(o: number): void; // frame o onto the target
  settle(): void; // reads 1 px of the frame back, through a 1×1 canvas
  job(job: DrawingJob): DrawnLayer; // one drawing, as the worker draws it, each part read back 1 px
}

export function createSlamBench(make: MakeScratch, opts: SlamBenchOptions = {}): SlamBench {
  const { effect, clip } = opts.inputs ?? slamInputs();
  const scene = createImpactScene(effect, clip, { tier: 'full', make, cuts: opts.cuts ?? 0, ...(opts.newPath !== undefined ? { newPath: opts.newPath } : {}) });
  const { width: W, height: H } = scene;
  const target = opts.target ?? make(W, H);
  const video = make(W, H);
  video.ctx.fillStyle = `rgb(${PLATE}, ${PLATE}, ${PLATE})`;
  video.ctx.fillRect(0, 0, W, H);
  const probe = make(1, 1);
  let listed = -Infinity; // the last frame whose jobs have run
  const bench: SlamBench = {
    scene,
    target,
    ahead(o) {
      for (let f = Math.max(listed + 1, o - 4); f <= o; f++) for (const job of scene.jobs(f)) scene.runJob(job);
      listed = Math.max(listed, o);
    },
    render: (o) => scene.render(target.ctx, video.canvas, o),
    settle() {
      probe.ctx.drawImage(target.canvas as never, W >> 1, H >> 1, 1, 1, 0, 0, 1, 1);
      probe.ctx.getImageData(0, 0, 1, 1);
    },
    job(job) {
      const layer = scene.runJob(job);
      for (const part of layer.parts) (part.image as { getContext?(id: '2d'): BrushTarget | null } | null)?.getContext?.('2d')?.getImageData(0, 0, 1, 1);
      return layer;
    },
  };
  scene.frames3d(); // the physics runs once, ahead of the clip, untimed
  return bench;
}

// ---- Timing ------------------------------------------------------------------------------

// One window's frames, one sample a frame (ms).
export interface SlamSeries {
  key: SlamFrame;
  label: string;
  frames: number[]; // the clip frames timed
  ms: number[];
}

// The window's frames in playback order: each frame's drawings run ahead,
// the `lead` frames before it drawn untimed, then each frame timed to its
// readback. `now` is the clock: the page passes performance.now.
export function timeSlamFrames(bench: SlamBench, key: SlamFrame, now: () => number): SlamSeries {
  const [from, to] = SLAM[key];
  const frames: number[] = [];
  const ms: number[] = [];
  for (let o = from - SLAM.lead; o <= to; o++) {
    bench.ahead(o);
    const t0 = now();
    bench.render(o);
    bench.settle();
    const t = now() - t0;
    if (o < from) continue;
    frames.push(o);
    ms.push(t);
  }
  return { key, label: LABEL[key], frames, ms };
}

// The worker's load over the aftermath: what the drawings due on f93–115 cost.
export interface SlamLoad {
  frames: readonly [number, number];
  windowMs: number; // the window's length, ms
  jobs: { kind: DrawingJob['kind']; due: number; ms: number }[];
  busyMs: number;
  load: number; // busyMs / windowMs
}

export function timeSlamLoad(bench: SlamBench, now: () => number): SlamLoad {
  const [from, to] = SLAM.load;
  const jobs: SlamLoad['jobs'] = [];
  const seen = new Set<string>();
  for (let o = from - 1; o < to; o++) {
    for (const job of bench.scene.jobs(o)) {
      if (job.due < from || job.due > to || seen.has(job.key)) continue;
      seen.add(job.key);
      const t0 = now();
      bench.job(job);
      jobs.push({ kind: job.kind, due: job.due, ms: now() - t0 });
    }
  }
  const windowMs = ((to - from + 1) * 1000) / FPS;
  const busyMs = jobs.reduce((s, j) => s + j.ms, 0);
  return { frames: SLAM.load, windowMs, jobs, busyMs, load: busyMs / windowMs };
}
