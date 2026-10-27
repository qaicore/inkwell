// The contact sheets for the active milestone (SPEC §8.6), written by
// npm run verify next to the test evidence: sheet.png, timing-strip.png,
// line-strip.png and reference-strip.png in the milestone's folder, plus
// sheets.json saying what they were made from. motion-critic reads them.
//
// Until the required clips have masks, the motion comes from a seeded,
// synthetic side-step (a stand-in for a tracked anchor) and the strokes are a
// demo effect, not Qai's. Every image says so in red at the top.
// Reads only local files: no network.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Effect, Stroke, Vec2 } from '../src/types/effect.ts';
import { animate, type PlacedStroke } from '../src/motion/animate.ts';
import { EXAMPLE_TIMING, parseTiming, type Timing } from '../src/motion/timing.ts';
import { DEFAULT_BRUSH, resampleStroke, type Point } from '../src/render/brush.ts';
import { contactSheet, fit, lineStrip, referenceStrip, timingStrip, type View } from '../src/render/sheet.ts';
import { toPixels, type TorsoTransform } from '../src/track/torso.ts';

const root = process.cwd();
const milestone = readFileSync(join(root, 'verify', 'ACTIVE'), 'utf8').replace(/^﻿/, '').trim();
const dir = join(root, 'verify', 'out', milestone);
mkdirSync(dir, { recursive: true });

// ---- Qai's reference, when it exists ------------------------------------------

function readTiming(): Timing | null {
  const path = join(root, 'reference', 'timing.json');
  return existsSync(path) ? parseTiming(JSON.parse(readFileSync(path, 'utf8'))) : null;
}
type RawStrokes = { width: number; brush: Effect['brush']; strokes: { id: number; points: Point[] }[] };
function readRaw(): RawStrokes | null {
  const path = join(root, 'reference', 'raw-strokes.json');
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as RawStrokes) : null;
}
const timing = readTiming();
const raw = readRaw();
// Without timing.json the sheets still show the engine working, with the
// example's numbers, and say so; the tests fail instead.
const used = timing ?? EXAMPLE_TIMING;

// ---- The synthetic scene -----------------------------------------------------------

const FRAMES = 90; // 3 s
const WIDTH = 1080;
const UNIT = 420; // px per torso height: a person about 1200 px tall
// A side-step: one torso height to screen right over 0.4 s, a hold, and back.
// The body leans into the move.
function body(f: number): TorsoTransform {
  const t = f / 30;
  const ease = (a: number, b: number) => {
    const u = Math.min(1, Math.max(0, (t - a) / (b - a)));
    return u * u * (3 - 2 * u);
  };
  const s = ease(0.3, 0.7) - ease(1.6, 2.0);
  const speed = (ease(0.3, 0.7) * (1 - ease(0.3, 0.7)) - ease(1.6, 2.0) * (1 - ease(1.6, 2.0))) * 4;
  return { x: 540 + UNIT * s, y: 900 - 0.04 * UNIT * Math.sin(Math.PI * s), angle: 0.08 * speed, unit: UNIT };
}
// Each stroke rides its own point on the body (a point anchor).
function anchorOn(rootOnBody: Vec2) {
  return (f: number): TorsoTransform => {
    const b = body(f);
    const [x, y] = toPixels(b, rootOnBody);
    return { x, y, angle: b.angle, unit: b.unit };
  };
}

// Demo strokes, in torso space from their own root, resampled to 32 points.
function demo(id: number, color: 0 | 1 | 2, kind: Stroke['kind'], stiffness: number, wobble: number, layer: 'front' | 'behind', curve: (s: number) => Vec2): Stroke {
  const dense: Point[] = Array.from({ length: 200 }, (_, i) => {
    const s = i / 199;
    const [x, y] = curve(s);
    return [x, y, 0.95 - 0.5 * s];
  });
  const { points, pressure } = resampleStroke(dense, 32);
  return {
    id,
    color,
    kind,
    anchor: { type: 'point', time: 0, xy: [0, 0] },
    bodyAngle: 0,
    stiffness,
    wobble,
    views: { front: { points, pressure, root: [0, 0], layer } },
  };
}
const ROOTS = new Map<number, Vec2>([
  [1, [0.12, 0.3]], // tail, at the hip
  [2, [-0.26, -0.48]], // tendril, at the shoulder
  [3, [-0.1, -1.12]], // horns
  [4, [0.1, -1.12]],
]);
const effect: Effect = {
  version: 1,
  brush: raw?.brush ?? DEFAULT_BRUSH,
  palette: ['#e8203a', '#f4f1ea', '#16141a'],
  timing: { drawingsPerSecond: used.dps },
  strokes: [
    demo(1, 0, 'strand', 0.3, 1, 'behind', (s) => [0.85 * s, 0.35 * s * s - 0.12 * Math.sin(Math.PI * s)]),
    demo(2, 2, 'strand', 0.15, 1, 'front', (s) => [-0.45 * s, -0.5 * s + 0.07 * Math.sin(2 * Math.PI * s)]),
    demo(3, 2, 'rigid', 1, 0.6, 'front', (s) => [-0.1 * s - 0.06 * s * s, -0.26 * s]),
    demo(4, 2, 'rigid', 1, 0.6, 'front', (s) => [0.1 * s + 0.06 * s * s, -0.26 * s]),
  ],
  overrides: {},
};
const anchors = new Map([...ROOTS].map(([id, at]) => [id, anchorOn(at)]));
const frames = animate({ effect, frames: FRAMES, anchor: (id, f) => anchors.get(id)!(f), width: WIDTH, boil: used.boil });

// ---- The images ---------------------------------------------------------------------

const source = 'SYNTHETIC STAND-IN: a seeded side-step anchor and demo strokes, not a clip and not Qai\'s strokes';
const timingLine = timing
  ? `timing from reference/timing.json: ${used.dps} dps, boil ${used.boil.maxPx} px every ${used.boil.cycle} drawings`
  : `reference/timing.json MISSING: placeholder ${used.dps} dps, boil ${used.boil.maxPx} px every ${used.boil.cycle} drawings (the example's numbers)`;
const strokesLine = 'strokes: 1 tail (red, strand, stiffness 0.3, behind), 2 tendril (strand, stiffness 0.15), 3-4 horns (rigid); gravity and damping from SPEC §8.7';

writeFileSync(
  join(dir, 'sheet.png'),
  contactSheet({
    frames,
    effect,
    body,
    crop: { x: 120, y: 280, size: 1320 },
    cell: 220,
    columns: 9,
    scale: WIDTH / 1080,
    banner: [source, timingLine, strokesLine, 'one cell per drawing, at the first frame it is shown; the figure is a gray stand-in for the person mask'],
    info: () => ({ theta: 0, facing: 'front', weights: 'front 1.00', preset: 'none', fallback: false }),
  }),
);

writeFileSync(
  join(dir, 'timing-strip.png'),
  timingStrip({
    frames,
    strokeId: 1,
    anchor: anchors.get(1)!,
    banner: [source, timingLine, 'stroke 1 (the tail): the anchor steps right over frames 9-21, holds, steps back over frames 48-60, then holds'],
  }),
);

// The tail at twice the frame's size for boil.cycle + 1 drawings in a row, at
// the end of the clip, when the body has held still for nearly a second. The
// tail is nearly settled by then, so most of what changes from cell to cell is
// the boil, and the last cell's boil repeats the first's. The banner says how
// much of it is still the physics.
const firsts = frames.filter((fr, i) => i === 0 || fr.k !== frames[i - 1].k);
const lineDrawings = firsts.slice(-(used.boil.cycle + 1));
const tailFrom = (fr: (typeof frames)[number], points: Vec2[]): Vec2[] => {
  const anchor = anchors.get(1)!(fr.f);
  return points.map((p): Vec2 => [p[0] - anchor.x, p[1] - anchor.y]);
};
const simTail = (fr: (typeof frames)[number]) => tailFrom(fr, fr.sim.find((s) => s.id === 1)!.points);
const physicsMove = Math.max(
  ...lineDrawings.slice(1).map((fr, i) => {
    const [a, b] = [simTail(lineDrawings[i]), simTail(fr)];
    return Math.max(...a.map((p, j) => Math.hypot(p[0] - b[j][0], p[1] - b[j][1])));
  }),
);
writeFileSync(
  join(dir, 'line-strip.png'),
  lineStrip({
    cells: lineDrawings.map((fr) => {
      const anchor = anchors.get(1)!(fr.f);
      return { title: `drawing ${fr.k} (frame ${fr.f}, boil phase ${fr.k % used.boil.cycle})`, stroke: fr.placed.find((p) => p.id === 1)!, root: [anchor.x, anchor.y] };
    }),
    effect,
    scale: WIDTH / 1080,
    zoom: 2,
    columns: 2,
    banner: [
      source,
      timingLine,
      `stroke 1 (the tail) at 2x the frame's pixels, the last ${used.boil.cycle + 1} drawings of the clip; each cell is shifted so the root is in the same place; grid: 10 frame px`,
      `the physics still moves the tail up to ${physicsMove.toFixed(1)} px from one drawing to the next here; the rest of the change is the boil (up to ${used.boil.maxPx} px per point)`,
    ],
  }),
);

const refCells: { title: string; strokes?: PlacedStroke[]; view?: View; root?: Vec2; note?: string }[] = [];
const keys = timing?.lash?.keys;
if (keys && keys.length > 0) {
  // timing.json gives each key's tip position only, not the drawn pose, so a
  // key is a straight line from the root to that tip. All key cells share one
  // view, so their scale and the root's place match and the tips compare.
  const rootPx: Vec2 = [540, 900];
  const tipPx = (tip: Vec2): Vec2 => [rootPx[0] + tip[0] * UNIT, rootPx[1] + tip[1] * UNIT];
  const view = fit([rootPx, ...keys.map((key) => tipPx(key.tip))], effect.brush.size * 4);
  for (const key of keys) {
    const [x, y] = tipPx(key.tip);
    const line: Point[] = Array.from({ length: 50 }, (_, i) => {
      const s = i / 49;
      return [rootPx[0] + (x - rootPx[0]) * s, rootPx[1] + (y - rootPx[1]) * s, 0.95 - 0.5 * s];
    });
    const { points, pressure } = resampleStroke(line, 32);
    refCells.push({
      title: `drawing ${key.drawing}: tip at (${key.tip[0]}, ${key.tip[1]})`,
      strokes: [{ id: 1, points, pressure, layer: 'front' }],
      view,
      root: rootPx,
    });
  }
} else {
  refCells.push({ title: 'lash keys', note: 'reference/timing.json is missing, so there are no keys to draw yet. Qai adds it from his traced lash (SPEC §11).' });
}
if (raw) {
  const s = 1080 / raw.width;
  refCells.push({
    title: 'Qai\'s raw strokes (A6)',
    strokes: raw.strokes.map((st) => ({
      id: 1,
      points: st.points.map((p): Vec2 => [p[0] * s, p[1] * s]),
      pressure: st.points.map((p) => p[2]),
      layer: 'front' as const,
    })),
  });
} else {
  refCells.push({ title: 'raw strokes (A6)', note: 'reference/raw-strokes.json is missing: Qai exports his strokes from the app (SPEC §11).' });
}
refCells.push({ title: 'demo effect at rest (synthetic)', strokes: frames[0].placed.map((p) => ({ ...p, id: 1 })) });
writeFileSync(
  join(dir, 'reference-strip.png'),
  referenceStrip({
    cells: refCells,
    effect: { ...effect, strokes: [effect.strokes[0]] },
    cell: 260,
    scale: WIDTH / 1080,
    banner: [
      'REFERENCE: Qai\'s lash keys and raw strokes in the effect\'s brush (stroke color is the demo palette\'s first)',
      timingLine,
      'lash keys: each key\'s tip position from timing.json (torso heights from the root, the dot), drawn as a straight root-to-tip line, not a drawn pose; the key cells share one scale and root position',
      'the other cells are each fitted to their own strokes',
    ],
  }),
);

writeFileSync(
  join(dir, 'sheets.json'),
  `${JSON.stringify(
    {
      milestone,
      source: 'synthetic',
      note: source,
      timing: timing ? 'reference/timing.json' : 'missing: placeholder values',
      rawStrokes: raw ? 'reference/raw-strokes.json' : 'missing',
      frames: FRAMES,
      drawings: new Set(frames.map((f) => f.k)).size,
      dps: used.dps,
      boil: used.boil,
    },
    null,
    2,
  )}\n`,
);
process.stdout.write(`sheets: ${milestone} contact sheets from ${timing ? 'reference timing' : 'placeholder timing'} (synthetic stand-in motion)\n`);
