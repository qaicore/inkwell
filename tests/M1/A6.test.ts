/// <reference types="node" />
// A6 (SPEC §10, anime motion): line fidelity.
//   (a) Outline from the stored resampled points vs outline from Qai's raw input points, same brush: mean distance
//       < 1 px at 1080 wide. If it fails, raise the stored point count, not the threshold.
//   (b) Each stroke at rest at θ = 0 (gravity 0, wobble 0, stiffness 1 or rigid) vs outline (a): < 0.5 px.
//
// Input: Qai's reference/raw-strokes.json, read at runtime (missing = FAIL, no fallback):
//   { "width": <canvas px width it was drawn at>, "brush": { size, thinning, smoothing, streamline },
//     "strokes": [ { "id": 1, "points": [[x, y, pressure], ...] } ] }
// Coordinates are scaled by 1080 / width; brush.size is used as given, in px at 1080 wide (Effect.brush).
//   (a) stored = resampleStroke(raw) with the module's default count (SPEC §7: 32, §8.7: raise it if A6a fails).
//       Both outlines come from strokeOutline with the same brush. Distance = mean distance from every point along
//       one outline's boundary (sampled every 0.5 px) to the other's boundary, taken both ways; the larger of the
//       two means is compared, per stroke, and the worst stroke must pass.
//   (b) Each stroke is stored in torso space (toTorso with a still anchor), animated at rest with SPEC §8.7's physics
//       with gravity 0 (other values from docs/SPEC.md), wobble 0, the boil and dps from reference/timing.json, and
//       once as a strand at stiffness 1 and once as rigid. The placed points' outline (strokeOutline) is compared on
//       9 frames across 2 s, under two still anchors (upright, and tilted 0.25 rad).
// Stricter readings, flagged for Qai:
//   - "stiffness 1 or rigid": both must pass;
//   - "outline (a)": (b) is compared with both outlines of (a), the stored-points one and the raw-points one, and
//     both must be < 0.5 px;
//   - distances are per stroke (the worst stroke counts), and the larger of the two directions is used;
//   - "resampled by arc length" (§7): point i is the raw polyline at arc length i·L/(n - 1), within 1e-6 px, with
//     pressure interpolated the same way, and n >= 32.
// Preconditions: strokeOutline is a real outline (finite, positive area, moves with its points, grows with the
// brush size), and the distance metric passes a self-check on circles.
import { afterAll, describe, expect, it } from 'vitest';
import type { Effect, Stroke } from '../../src/types/effect.ts';
import { Evidence } from '../helpers/evidence.ts';
import {
  dist,
  need,
  outlineDistance,
  polygonArea,
  readReference,
  recorded,
  specParams,
  timingBoil,
  timingDps,
  type Pose,
  type V2,
} from '../helpers/engine.ts';

type BrushModule = typeof import('../../src/render/brush.ts');
type Brush = Parameters<BrushModule['strokeOutline']>[2];

const ID = 'A6';
const A_PX = 1;
const B_PX = 0.5;
const MIN_POINTS = 32;
const RAW = 'reference/raw-strokes.json';
const ev = new Evidence(ID, [
  'metric self-check',
  'modules load',
  'modules load for (b)',
  'reference/raw-strokes.json',
  'precondition: strokeOutline is a real outline',
  'stored points are resampled by arc length',
  '(a) stored-points outline vs raw-points outline, mean distance (worst stroke)',
  'reference/timing.json dps and boil',
  '(b) at rest vs the stored-points outline (a), strand at stiffness 1 and rigid',
  '(b) at rest vs the raw-points outline (a), strand at stiffness 1 and rigid',
]);
afterAll(() => ev.write());

// ---------- input ----------

interface RawStroke {
  id: number;
  xy: V2[];
  pressure: number[];
}

function readRaw(): { brush: Brush; strokes: RawStroke[]; width: number } {
  const j = readReference(RAW) as { width?: unknown; brush?: Record<string, unknown>; strokes?: unknown } | null;
  const width = j?.width;
  if (typeof width !== 'number' || !(width > 0)) throw new Error(`${RAW} "width" is ${JSON.stringify(width)}: expected the canvas width in px it was drawn at`);
  const b = j?.brush;
  const brushKeys = ['size', 'thinning', 'smoothing', 'streamline'] as const;
  const badKeys = brushKeys.filter((k) => typeof b?.[k] !== 'number' || !Number.isFinite(b[k] as number));
  if (!b || badKeys.length) throw new Error(`${RAW} "brush" needs numbers for ${badKeys.join(', ') || brushKeys.join(', ')}`);
  if (!((b.size as number) > 0)) throw new Error(`${RAW} "brush.size" must be > 0`);
  if (!Array.isArray(j?.strokes) || j.strokes.length === 0) throw new Error(`${RAW} has no "strokes"`);
  const scale = 1080 / width;
  const strokes = (j.strokes as unknown[]).map((s, n): RawStroke => {
    const rec = s as { id?: unknown; points?: unknown };
    if (typeof rec.id !== 'number') throw new Error(`${RAW} stroke ${n} has no numeric "id"`);
    if (!Array.isArray(rec.points) || rec.points.length < 2) throw new Error(`${RAW} stroke ${rec.id} needs at least 2 points`);
    const pts = rec.points as unknown[];
    pts.forEach((p, i) => {
      if (!Array.isArray(p) || p.length < 3 || !p.slice(0, 3).every((v) => typeof v === 'number' && Number.isFinite(v)) || (p[2] as number) < 0 || (p[2] as number) > 1) {
        throw new Error(`${RAW} stroke ${rec.id} point ${i} is ${JSON.stringify(p)}: expected [x, y, pressure 0..1]`);
      }
    });
    const arr = pts as [number, number, number][];
    return { id: rec.id, xy: arr.map((p): V2 => [p[0] * scale, p[1] * scale]), pressure: arr.map((p) => p[2]) };
  });
  return { brush: { size: b.size as number, thinning: b.thinning as number, smoothing: b.smoothing as number, streamline: b.streamline as number }, strokes, width };
}

/** The raw polyline at arc length s, with pressure interpolated the same way. */
function atArcLength(xy: V2[], pressure: number[], s: number): { p: V2; pr: number } {
  let along = 0;
  for (let i = 1; i < xy.length; i++) {
    const len = dist(xy[i - 1]!, xy[i]!);
    if (len > 0 && along + len >= s) {
      const u = Math.max(0, Math.min(1, (s - along) / len));
      const a = xy[i - 1]!;
      const b = xy[i]!;
      return { p: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u], pr: pressure[i - 1]! + (pressure[i]! - pressure[i - 1]!) * u };
    }
    along += len;
  }
  return { p: xy[xy.length - 1]!, pr: pressure[pressure.length - 1]! };
}

function totalLength(xy: V2[]): number {
  let s = 0;
  for (let i = 1; i < xy.length; i++) s += dist(xy[i - 1]!, xy[i]!);
  return s;
}

function circle(r: number, n = 256, c: V2 = [300, 300]): V2[] {
  return Array.from({ length: n }, (_, i): V2 => [c[0] + r * Math.cos((2 * Math.PI * i) / n), c[1] + r * Math.sin((2 * Math.PI * i) / n)]);
}

const finitePoly = (o: V2[]) => o.length >= 3 && o.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));

// ---------- shared state between the two parts ----------

interface Stored {
  id: number;
  raw: RawStroke;
  points: V2[];
  pressure: number[];
  rawOutline: V2[];
  storedOutline: V2[];
}

let stored: Stored[] | null = null;
let brushIn: Brush | null = null;

describe('A6 line fidelity', () => {
  it('A6 metric self-check: the outline distance measures what it says', () => {
    const r50 = circle(50);
    const same = outlineDistance(r50, r50).mean;
    const half = outlineDistance(r50, circle(50.5)).mean;
    const shifted = outlineDistance(r50, circle(50, 256, [303, 300])).mean;
    const ok = same < 1e-9 && Math.abs(half - 0.5) < 0.01 && shifted > 1 && shifted < 3;
    ev.record('metric self-check', { identical: same, radius50vs50_5: half, shifted3px: shifted }, 'identical 0; radius +0.5 px -> 0.5 px; 3 px shift -> between 1 and 3 px', ok);
    expect(ok, `A6 metric self-check failed: identical ${same}, +0.5 px ${half}, 3 px shift ${shifted}`).toBe(true);
  });

  it('A6 (a) the outline from the stored resampled points is within 1 px (mean) of the outline from the raw points, at 1080 wide', async () => {
    const brush = await recorded(ev, 'modules load', 'src/render/brush.ts exports resampleStroke, strokeOutline', () =>
      need('src/render/brush.ts', { resampleStroke: 'function', strokeOutline: 'function' }, () => import('../../src/render/brush.ts')),
    );
    const raw = await recorded(ev, RAW, 'width, brush and at least one stroke of [x, y, pressure] points', () => readRaw(),
      (r) => ({ width: r.width, scaleTo1080: 1080 / r.width, brush: r.brush, strokes: r.strokes.map((s) => ({ id: s.id, points: s.xy.length })) }));
    brushIn = raw.brush;
    const outline = (pts: V2[], pr: number[], b: Brush = raw.brush) => brush.strokeOutline(pts, pr, b) as V2[];

    // Precondition: strokeOutline is a real outline.
    const s0 = raw.strokes[0]!;
    const o0 = outline(s0.xy, s0.pressure);
    const d: V2 = [37.5, -12.25];
    const moved = outline(s0.xy.map((p): V2 => [p[0] + d[0], p[1] + d[1]]), s0.pressure);
    const equivariance = moved.length === o0.length ? Math.max(...moved.map((p, i) => dist([p[0] - d[0], p[1] - d[1]], o0[i]!))) : Infinity;
    const area = finitePoly(o0) ? polygonArea(o0) : 0;
    const bigger = polygonArea(outline(s0.xy, s0.pressure, { ...raw.brush, size: raw.brush.size * 2 }));
    const realOutline = finitePoly(o0) && area > 0 && equivariance <= 1e-6 && bigger > area;
    ev.record('precondition: strokeOutline is a real outline', { vertices: o0.length, areaPx2: area, areaWithDoubleSizePx2: bigger, translationErrorPx: equivariance },
      'finite, area > 0, moves with its points (1e-6 px), grows with brush size', realOutline);
    expect(realOutline, `A6 precondition: strokeOutline isn't a real outline (${o0.length} vertices, area ${area}, translation error ${equivariance}, double-size area ${bigger})`).toBe(true);

    // Resampling by arc length.
    const resampleProblems: string[] = [];
    let resampleErrPx = 0;
    let resampleErrPressure = 0;
    const list: Stored[] = [];
    for (const s of raw.strokes) {
      const r = brush.resampleStroke(s.xy.map(([x, y], i): [number, number, number] => [x, y, s.pressure[i]!]));
      const pts = r.points as V2[];
      const n = pts.length;
      if (n < MIN_POINTS) resampleProblems.push(`stroke ${s.id}: ${n} points, fewer than ${MIN_POINTS}`);
      if (r.pressure.length !== n) resampleProblems.push(`stroke ${s.id}: ${r.pressure.length} pressures for ${n} points`);
      const L = totalLength(s.xy);
      for (let i = 0; i < n; i++) {
        const want = atArcLength(s.xy, s.pressure, n > 1 ? (i * L) / (n - 1) : 0);
        const e = dist(pts[i]!, want.p);
        resampleErrPx = Math.max(resampleErrPx, Number.isFinite(e) ? e : Infinity);
        const ep = Math.abs((r.pressure[i] ?? NaN) - want.pr);
        resampleErrPressure = Math.max(resampleErrPressure, Number.isFinite(ep) ? ep : Infinity);
      }
      list.push({ id: s.id, raw: s, points: pts, pressure: r.pressure, rawOutline: outline(s.xy, s.pressure), storedOutline: outline(pts, r.pressure) });
    }
    const resampleOk = resampleProblems.length === 0 && resampleErrPx <= 1e-6 && resampleErrPressure <= 1e-6;
    ev.record('stored points are resampled by arc length',
      { counts: Object.fromEntries(list.map((s) => [`stroke ${s.id}`, s.points.length])), maxPointErrorPx: resampleErrPx, maxPressureError: resampleErrPressure, problems: resampleProblems },
      `>= ${MIN_POINTS} points; point i at arc length i·L/(n - 1) of the raw polyline within 1e-6 px; pressure the same way within 1e-6`, resampleOk);

    const perStroke = list.map((s) => ({ id: s.id, ...outlineDistance(s.storedOutline, s.rawOutline) }));
    const worst = perStroke.reduce((a, b) => (b.mean > a.mean ? b : a));
    stored = list;
    ev.record('(a) stored-points outline vs raw-points outline, mean distance (worst stroke)',
      { worstStroke: worst.id, worstMeanPx: worst.mean, perStroke: Object.fromEntries(perStroke.map((p) => [`stroke ${p.id}`, { storedToRaw: p.ab, rawToStored: p.ba }])) },
      `< ${A_PX} px at 1080 wide`, worst.mean < A_PX, worst.mean < A_PX ? '' : 'raise the stored point count (SPEC §8.7), not the threshold');

    expect(resampleOk, `A6 resampling: ${resampleProblems.join('; ')}; point error ${resampleErrPx} px, pressure error ${resampleErrPressure}`).toBe(true);
    expect(worst.mean, `A6 (a) stroke ${worst.id}: mean outline distance ${worst.mean} px, must be < ${A_PX} px`).toBeLessThan(A_PX);
  }, 120_000);

  it('A6 (b) each stroke at rest (gravity 0, wobble 0, stiffness 1 and rigid) is within 0.5 px of outline (a)', async () => {
    if (!stored || !brushIn) throw new Error('A6 (b) needs the stored strokes from (a), which did not get that far (see the (a) failure)');
    const list = stored;
    const brushSettings = brushIn;
    const { torso, anim, brush } = await recorded(ev, 'modules load for (b)', 'src/track/torso.ts (toTorso), src/motion/animate.ts (animate), src/render/brush.ts (strokeOutline)', async () => ({
      torso: await need('src/track/torso.ts', { toPixels: 'function', toTorso: 'function' }, () => import('../../src/track/torso.ts')),
      anim: await need('src/motion/animate.ts', { animate: 'function' }, () => import('../../src/motion/animate.ts')),
      brush: await need('src/render/brush.ts', { strokeOutline: 'function' }, () => import('../../src/render/brush.ts')),
    }));
    const { dps, boil } = await recorded(ev, 'reference/timing.json dps and boil', 'dps 12 or 8; boil present', () => ({ dps: timingDps(), boil: timingBoil() }), (v) => v);
    const physics = specParams({ gravity: 0 });

    const anchors: Pose[] = [
      { x: 540, y: 980, angle: 0, unit: 420 },
      { x: 500, y: 1010, angle: 0.25, unit: 380 },
    ];
    const FRAMES = 60;
    const SAMPLE = [0, 1, 2, 3, 5, 8, 13, 29, 59];
    const results: { label: string; vsStored: number; vsRaw: number; stroke: number; frame: number; maxPointDriftPx: number }[] = [];
    for (const [ai, anchor] of anchors.entries()) {
      for (const kind of ['strand', 'rigid'] as const) {
        const strokes: Stroke[] = list.map((s) => {
          const pts = s.points.map((p) => torso.toTorso(anchor, p) as V2);
          return {
            id: s.id,
            color: 0,
            kind,
            anchor: { type: 'point', time: 0, xy: s.points[0]! },
            bodyAngle: 0,
            stiffness: 1,
            wobble: 0,
            views: { front: { points: pts, pressure: s.pressure, root: pts[0]!, layer: 'front' } },
          };
        });
        const effect: Effect = {
          version: 1,
          brush: brushSettings,
          palette: ['#1b1b1f', '#c8323c', '#f2efe6'],
          timing: { drawingsPerSecond: dps },
          strokes,
          overrides: {},
        };
        const frames = anim.animate({ effect, frames: FRAMES, anchor: () => anchor, width: 1080, boil, physics });
        let worst = { label: `${kind}, anchor ${ai === 0 ? 'upright' : 'tilted 0.25 rad'}`, vsStored: 0, vsRaw: 0, stroke: 0, frame: 0, maxPointDriftPx: 0 };
        for (const [f, fr] of frames.entries()) {
          for (const s of list) {
            const placed = fr.placed.find((p) => p.id === s.id);
            if (!placed) {
              worst = { ...worst, vsStored: Infinity, vsRaw: Infinity, stroke: s.id, frame: f };
              continue;
            }
            const pp = placed.points as V2[];
            const drift = pp.length === s.points.length ? Math.max(...pp.map((p, i) => dist(p, s.points[i]!))) : Infinity;
            worst.maxPointDriftPx = Math.max(worst.maxPointDriftPx, Number.isFinite(drift) ? drift : Infinity);
            if (!SAMPLE.includes(f)) continue;
            const o = brush.strokeOutline(pp, placed.pressure, brushSettings) as V2[];
            const vsStored = finitePoly(o) ? outlineDistance(o, s.storedOutline).mean : Infinity;
            const vsRaw = finitePoly(o) ? outlineDistance(o, s.rawOutline).mean : Infinity;
            if (vsStored > worst.vsStored || vsRaw > worst.vsRaw) worst = { ...worst, stroke: s.id, frame: f };
            worst.vsStored = Math.max(worst.vsStored, vsStored);
            worst.vsRaw = Math.max(worst.vsRaw, vsRaw);
          }
        }
        if (frames.length !== FRAMES) worst = { ...worst, vsStored: Infinity, vsRaw: Infinity };
        results.push(worst);
      }
    }
    const show = Object.fromEntries(results.map((r) => [r.label, { vsStoredPx: r.vsStored, vsRawPx: r.vsRaw, worstStroke: r.stroke, worstFrame: r.frame, maxPointDriftPx: r.maxPointDriftPx }]));
    const worstStored = Math.max(...results.map((r) => r.vsStored));
    const worstRaw = Math.max(...results.map((r) => r.vsRaw));
    ev.record('(b) at rest vs the stored-points outline (a), strand at stiffness 1 and rigid', show, `< ${B_PX} px mean distance, every stroke, both kinds, both anchors`, worstStored < B_PX);
    ev.record('(b) at rest vs the raw-points outline (a), strand at stiffness 1 and rigid', show, `< ${B_PX} px mean distance, every stroke, both kinds, both anchors`, worstRaw < B_PX);

    expect(worstStored, `A6 (b) at rest vs the stored-points outline: ${worstStored} px, must be < ${B_PX} px (${JSON.stringify(show)})`).toBeLessThan(B_PX);
    expect(worstRaw, `A6 (b) at rest vs the raw-points outline: ${worstRaw} px, must be < ${B_PX} px (${JSON.stringify(show)})`).toBeLessThan(B_PX);
  }, 180_000);
});
