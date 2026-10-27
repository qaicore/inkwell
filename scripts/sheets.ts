// The contact sheets for the active milestone (SPEC §8.6), written by
// npm run verify next to the test evidence: sheet.png, timing-strip.png and
// reference-strip.png in the milestone's folder, plus sheets.json saying what
// they were made from. motion-critic reads them.
//
// Until the required clips have masks, the motion comes from a seeded,
// synthetic side-step (a stand-in for a tracked anchor) and the strokes are a
// demo effect, not Qai's. Every image says so in red at the top.
// Reads only local files: no network.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Effect, Stroke, Vec2 } from '../src/types/effect.ts';
import { animate, type PlacedStroke } from '../src/motion/animate.ts';
import type { BoilParams } from '../src/motion/boil.ts';
import { DEFAULT_BRUSH, resampleStroke, type Point } from '../src/render/brush.ts';
import { contactSheet, referenceStrip, timingStrip } from '../src/render/sheet.ts';
import { toPixels, type TorsoTransform } from '../src/track/torso.ts';

const root = process.cwd();
const milestone = readFileSync(join(root, 'verify', 'ACTIVE'), 'utf8').replace(/^﻿/, '').trim();
const dir = join(root, 'verify', 'out', milestone);
mkdirSync(dir, { recursive: true });

// ---- Qai's reference, when it exists ------------------------------------------

type Timing = { dps: 12 | 8; boil: BoilParams; lash?: { keys?: { drawing: number; tip: Vec2 }[] } };
function readTiming(): Timing | null {
  const path = join(root, 'reference', 'timing.json');
  if (!existsSync(path)) return null;
  const t = JSON.parse(readFileSync(path, 'utf8')) as Partial<Timing>;
  if ((t.dps !== 12 && t.dps !== 8) || typeof t.boil?.maxPx !== 'number' || typeof t.boil?.cycle !== 'number') return null;
  return t as Timing;
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
const PLACEHOLDER: Timing = { dps: 12, boil: { maxPx: 1.5, cycle: 3 } };
const used = timing ?? PLACEHOLDER;

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

const refCells: { title: string; strokes?: PlacedStroke[]; note?: string }[] = [];
const keys = timing?.lash?.keys;
if (keys && keys.length > 0) {
  // Each key as a strand from the root to Qai's tip position, in the same brush.
  for (const key of keys) {
    const line: Point[] = Array.from({ length: 50 }, (_, i) => {
      const s = i / 49;
      return [540 + key.tip[0] * UNIT * s, 900 + key.tip[1] * UNIT * s, 0.95 - 0.5 * s];
    });
    const { points, pressure } = resampleStroke(line, 32);
    refCells.push({ title: `lash key at drawing ${key.drawing}`, strokes: [{ id: 1, points, pressure, layer: 'front' }] });
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
  referenceStrip({ cells: refCells, effect: { ...effect, strokes: [effect.strokes[0]] }, cell: 260, scale: WIDTH / 1080, banner: ['REFERENCE: Qai\'s keys and strokes in the effect\'s brush (stroke color is the demo palette\'s first)', timingLine] }),
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
