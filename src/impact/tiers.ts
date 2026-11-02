// The preview's budget and its cut order (impact design §10), as data the
// scene (scene.ts) and the tests read. The budget is for the internal
// 1080×608 frame: the preview holds 24 fps, so a frame has 41 ms, of which
// the main thread takes at most 26 ms in the Node proxy and the worker that
// renders the drawings ahead stays under 80 % in every window.
//   - Main thread, every output frame: physics, stamping the cached limb
//     layers, the person cutout, the grade, the glow, the camera and the
//     layer composite, and the 1s energy on kr steps (lightning, beams,
//     bursts, splash).
//   - Worker, per drawing: a limb drawing (all the limbs, their arcs, pulses
//     and arc glow) 12 a second, 15 in the strike window; a mass drawing 12 a
//     second; the posters, 7 in 9 frames. j 9's limb and fire drawings render
//     during the posters, so j 9 costs the main thread no more than any frame.
// The design's posters window says 34 %; its own numbers, 7 posters at 8 ms
// plus j 9's limb (42 ms) and fire (12 ms) drawings in 300 ms, come to 37 %.
// windowLoad gives the latter.
//
// The cut order. If the main-thread frame misses 26 ms or the worker passes
// 80 % on the phone, the preview steps down this order, one recorded tier at
// a time (never automatically during an export, which always draws the full
// tier). The posters, the limbs and the cracks are never cut. Design §10's
// step 2, dropping the near glow buffer, is out of the order (round 3): it
// needs a switch in createGlow (render/light.ts) and the scene's glows, and
// the near halo is the limbs' and the lightning's hot edge, so the six steps
// here are design steps 1 and 3–7, renumbered 1–6.
//
// The device gate (WP17, decision 9): the tiers here are timed in Node. Qai's
// iPhone run of the bench (bench.html) is still to come; see PHONE_CUTS.
import type { DrawingJob, Tier } from './contracts.ts';

export const PROXY = { width: 1080, height: 608 } as const; // the internal frame the budget is for
export const FRAME_MS = 41; // ≥ 24 fps
export const MAIN_BUDGET = 26; // ms: the main-thread frame in the Node proxy
export const WORKER_LOAD = 0.8; // the most the worker may be busy in any window

export type MainLine = 'physics' | 'stamp' | 'cutout' | 'grade' | 'glow' | 'composite' | 'energy';

export interface BudgetLine {
  key: MainLine;
  what: string;
  iphone: readonly [number, number]; // the design's estimate on the iPhone, ms
  node: number; // the Node proxy's budget at 1080×608, ms
  every: 'frame' | 'kr'; // on every output frame, or on kr steps only
}

// Design §10's main-thread table.
export const MAIN_LINES: readonly BudgetLine[] = [
  { key: 'physics', what: 'physics, all limbs', iphone: [0, 0.5], node: 1, every: 'frame' },
  { key: 'stamp', what: 'stamp the cached limb layers (the torso transform, or the pinned similarity about P)', iphone: [1, 2], node: 3, every: 'frame' },
  { key: 'cutout', what: 'person cutout, from a mask decoded ahead into a bitmap', iphone: [3, 5], node: 6, every: 'frame' },
  { key: 'grade', what: 'grade (3 Canvas2D ops)', iphone: [2, 3], node: 4, every: 'frame' },
  { key: 'glow', what: 'glow: emission and a 3-pass blur at quarter res, then the composite', iphone: [2, 3], node: 4, every: 'frame' },
  { key: 'composite', what: 'camera and layer composite', iphone: [1, 2], node: 2, every: 'frame' },
  { key: 'energy', what: '1s energy (lightning, beams, bursts, splash), on kr steps only', iphone: [3, 5], node: 6, every: 'kr' },
];

// The main thread's frame at its worst, a kr step: every line.
export const mainBudget = (): number => MAIN_LINES.reduce((sum, line) => sum + line.node, 0);

// Design §10's worker table: each drawing's Node proxy budget, ms.
export const JOB_MS: Readonly<Record<DrawingJob['kind'], number>> = { limb: 42, mass: 12, poster: 8 };

export interface WorkerWindow {
  name: 'aftermath' | 'strike' | 'posters';
  ms: number; // how long the window lasts
  jobs: Readonly<Partial<Record<DrawingJob['kind'], number>>>; // how many drawings of each kind it asks for
}

// The worker's three windows:
//   - the aftermath, a second of 12 limb and 12 mass drawings;
//   - the strike, j −8..−1 (8 frames, 267 ms): tube drawings on j −8, −7, −5, −3 and −1;
//   - the posters, j 0..8 (9 frames, 300 ms): the 7 posters, and j 9's limb and fire drawings.
export const WORKER_WINDOWS: readonly WorkerWindow[] = [
  { name: 'aftermath', ms: 1000, jobs: { limb: 12, mass: 12 } },
  { name: 'strike', ms: (8 * 1000) / 30, jobs: { limb: 5 } },
  { name: 'posters', ms: (9 * 1000) / 30, jobs: { poster: 7, limb: 1, mass: 1 } },
];

// The share of a window the worker is busy, at the budget's times.
export function windowLoad(w: WorkerWindow): number {
  let busy = 0;
  for (const kind of Object.keys(w.jobs) as DrawingJob['kind'][]) busy += (w.jobs[kind] ?? 0) * JOB_MS[kind];
  return busy / w.ms;
}

// ---- The cut order ---------------------------------------------------------------------------

export interface Cut {
  step: number; // 1..6, in the order they're taken
  design: number; // its step in design §10's order
  name: string;
  what: string;
}

export const CUT_ORDER: readonly Cut[] = [
  { step: 1, design: 1, name: 'lightning-2s', what: 'lightning on 2s' },
  { step: 2, design: 3, name: 'ribbons', what: 'lightning 4 → 2 ribbons' },
  { step: 3, design: 4, name: 'particles', what: 'halve the particles' },
  { step: 4, design: 5, name: 'phone-cluster', what: 'the phone cluster (balls 0.033–0.05 U, at most 30, same area)' },
  { step: 5, design: 6, name: 'arcs', what: 'arcs 6 → 3 per limb in the strike window and the aftermath' },
  { step: 6, design: 7, name: 'resolution', what: 'preview at 0.75 resolution' },
];

// Design §10's step 2, out of the order (above).
export const UNCUT = [{ design: 2, name: 'near-glow', what: 'drop the near glow buffer', why: 'no switch in createGlow (render/light.ts); the near halo is the hot edge' }] as const;

export const NEVER_CUT = ['posters', 'limbs', 'cracks'] as const;
export const CUT_RESOLUTION = 0.75; // step 6's scale on the internal frame
export const CUT_RIBBONS = 2; // step 2's lightning ribbons

// What the first n cuts switch, as the scene's render options.
export interface Cuts {
  n: number; // 0..6
  lightning2s: boolean; // 1: the lightning holds on the 2s grid instead of every kr step
  maxRibbons: number | undefined; // 2: at most this many ribbons; undefined = the band's own
  halfParticles: boolean; // 3
  tier: Tier; // 4: 'phone' is the phone cluster, which also brings the lightning's and the particles' phone caps
  fewerArcs: boolean; // 5
  resolution: number; // 6: × the internal frame's size
}

export function cutsAt(n: number): Cuts {
  if (!Number.isInteger(n) || n < 0 || n > CUT_ORDER.length) throw new Error(`the cut order has steps 0..${CUT_ORDER.length} (got ${n})`);
  return {
    n,
    lightning2s: n >= 1,
    maxRibbons: n >= 2 ? CUT_RIBBONS : undefined,
    halfParticles: n >= 3,
    tier: n >= 4 ? 'phone' : 'full',
    fewerArcs: n >= 5,
    resolution: n >= 6 ? CUT_RESOLUTION : 1,
  };
}

// The cuts a tier starts from. The export and the desktop draw the full tier
// (no cuts, so their pixels never change with the phone's). The phone starts
// from the first step whose strike frame and aftermath frame fit MAIN_BUDGET
// with the worker at WORKER_LOAD or under, timed in Node on the slam bench's
// synthetic slam (src/bench/slam.ts, one pass a step, Nov 1, Node 24, under
// the other fixers' load, so ±30 % from run to run):
//   cuts  strike  aftermath  worker over f93–115
//   0     33–48   49–73       91–141 %   (the hero, round 2: 44.6, 56.2, 132–149 %)
//   1     36      49          94 %
//   2     32      40          97 %
//   3     34      45          89 %
//   4     33      44          91 %
//   5     30–49   39–67       75–115 %
//   6     21–37   28–35       63–101 %   (810×456)
// (median ms a frame; the full tier and steps 5 and 6 from 2–4 runs).
// No step fits in Node: the whole order, 6, comes closest, about half the
// full tier's cost, and is where the phone starts until Qai's iPhone run of
// bench.html, which times the full tier and this one, says otherwise.
export const PHONE_CUTS = 6;
export const tierCuts = (tier: Tier): number => (tier === 'phone' ? PHONE_CUTS : 0);

// The device gate on Qai's iPhone (bench.html). WP17's lines: a 24-arc limb
// drawing in the worker within 50 ms, and stamp + cutout + grade on the main
// thread within 14 ms. Round 3's, design §10's own: a whole strike frame
// (f76–83) and a whole aftermath frame (j 18–28) on the main thread within
// MAIN_BUDGET, and the worker's drawings over f93–115 at WORKER_LOAD or under.
export interface DeviceNumbers {
  worker: number;
  main: number;
  strike?: number;
  aftermath?: number;
  load?: number;
}
export const DEVICE_GATE = { worker: 50, main: 14, strike: MAIN_BUDGET, aftermath: MAIN_BUDGET, load: WORKER_LOAD, measured: null as DeviceNumbers | null } as const;
