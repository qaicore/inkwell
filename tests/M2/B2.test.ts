/// <reference types="node" />
// B2 (SPEC §10, brushes): each brush does its job: grain fixed to the stroke; neon glow stays near its line; fine tip
// thinner than ink. Thresholds: grain pixels move with the stroke (within 0.5 px under a pure translation); no glow
// pixel farther than 2 × glow.radiusPx from the centerline; fine-ink's widest point <= 0.5 × ink's on the same stroke
// (start).
//
// Measured on pixels from the real renderer, src/render/headless.ts renderPng(width, height, strokes, effect, scale,
// k), decoded with @napi-rs/canvas; the settings each brush resolves to come from src/render/brushes.ts
// brushSettings(effect, id). Strokes are seeded tendrils placed directly in px on a 1080 x 1080 canvas (scale 1).
//   - Grain: grain(x) = alpha(base brush) - alpha(textured brush), same stroke (textured's outline is ink's,
//     fine-textured's is fine-ink's, §8.8). The stroke is rendered again translated by T; the grain's own shift is
//     found by zero-mean cross-correlation of the two grain maps over the stroke's interior, searched over every
//     integer shift from 0 to T and 5 px around (so a grain that stays put on the screen peaks at 0), refined with a
//     parabola. |found - T| <= 0.5 px for T = (40, 25) and (-17, 33).
//   - Glow: every pixel with alpha > 0 in a neon render is within 2 × glow.radiusPx of the stroke's centerline (the
//     placed points' polyline); at the default settings and with effect.brushes setting a radius twice as large.
//   - Fine tip: the widest point of each render (2 × the largest distance from an inked pixel, alpha >= 128, to the
//     nearest un-inked one, minus 1) for fine-ink vs ink on the same three strokes; the worst ratio counts.
// SPEC §8.7 pins, read from docs/SPEC.md at runtime: the defaults an effect without `brushes` resolves to must be
// fine-tip size = 0.35 × the ink brush's size (fine-ink and fine-textured), grain 0.35 (textured, fine-textured), and
// neon glow radius 12 px, intensity 0.8 (both neon brushes), so the glow threshold is SPEC's, not the code's.
// Preconditions: grain removes some but not all of the fill; the neon brushes actually glow past their core.
// Stricter readings / open points, flagged for Qai:
//   - a sub-pixel translation (12.5, -7.25) is measured and reported but not gated (pixel grids make sub-pixel grain
//     shifts hard to measure exactly);
//   - "glow pixel" is any pixel the neon render touches at all (alpha > 0), core included.
import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { Effect, Stroke } from '../../src/types/effect.ts';
import { Evidence, ROOT, readText } from '../helpers/evidence.ts';
import { need, recorded, segDist, tendril, torsoToPx, type V2 } from '../helpers/engine.ts';

type HeadlessModule = typeof import('../../src/render/headless.ts');
type BrushesModule = typeof import('../../src/render/brushes.ts');
type Placed = Parameters<HeadlessModule['renderPng']>[2][number];

const ID = 'B2';
const W = 1080;
const H = 1080;
const GRAIN_TOL = 0.5; // px (SPEC §10 B2)
const GLOW_FACTOR = 2; // × glow.radiusPx
const FINE_RATIO = 0.5; // fine-ink widest <= 0.5 × ink widest (start)
const SHIFTS: V2[] = [[40, 25], [-17, 33]];
const SUBPIXEL: V2 = [12.5, -7.25];
const INK = { size: 28, thinning: 0.65, smoothing: 0.6, streamline: 0.45 };

const ev = new Evidence(ID, [
  'modules load',
  'SPEC §8.7 defaults',
  'precondition: grain removes part of the fill',
  'textured: grain moves with the stroke',
  'fine-textured: grain moves with the stroke',
  'grain under a sub-pixel translation (report)',
  'precondition: neon glows past its core',
  'neon-straight: glow within 2 × radius (default)',
  'neon-round: glow within 2 × radius (default)',
  'neon glow within 2 × radius (custom radius)',
  "fine-ink's widest point <= 0.5 × ink's",
]);
afterAll(() => ev.write());

// ---------- SPEC §8.7 ----------

function spec87(): { fineFactor: number; grain: number; glowRadius: number; glowIntensity: number } {
  const spec = readText(join(ROOT, 'docs', 'SPEC.md'));
  const start = spec.indexOf('### 8.7');
  if (start < 0) throw new Error('docs/SPEC.md has no "### 8.7" parameter table');
  const end = spec.indexOf('\n### ', start + 5);
  const sec = spec.slice(start, end < 0 ? undefined : end);
  const cell = (row: string) => {
    const m = sec.match(new RegExp(`^\\|\\s*${row}[^|]*\\|([^|\\n]+)\\|`, 'mi'));
    if (!m) throw new Error(`docs/SPEC.md §8.7 has no "${row}" row`);
    return m[1]!.trim();
  };
  const fine = cell('fine-tip size').match(/^(\d+(?:\.\d+)?)\s*×/);
  const grain = cell('grain').match(/^(\d+(?:\.\d+)?)/);
  const glow = cell('neon glow').match(/radius\s+(\d+(?:\.\d+)?)\s*px,\s*intensity\s+(\d+(?:\.\d+)?)/);
  if (!fine || !grain || !glow) throw new Error('docs/SPEC.md §8.7 fine-tip size, grain or neon glow row is not in the expected form');
  return { fineFactor: Number(fine[1]), grain: Number(grain[1]), glowRadius: Number(glow[1]), glowIntensity: Number(glow[2]) };
}

// ---------- input ----------

function effectWith(brush: string, extra: Partial<Effect> = {}): Effect {
  const points = tendril(1);
  const s: Stroke = {
    id: 7,
    color: 1,
    kind: 'strand',
    anchor: { type: 'concept', prompt: 'person' },
    bodyAngle: 0,
    stiffness: 1,
    wobble: 0,
    views: { front: { points, pressure: points.map(() => 0.6), root: points[0]!, layer: 'front' } },
  };
  (s as Stroke & { brush?: string }).brush = brush;
  return { version: 1, brush: { ...INK }, palette: ['#1b1b1f', '#c8323c', '#3fd0ff'], timing: { drawingsPerSecond: 12 }, strokes: [s], overrides: {}, ...extra };
}

function placedStroke(seed: number, offset: V2 = [0, 0]): Placed {
  const pts = tendril(seed, 32, 0.8);
  const pose = { x: 540 + offset[0], y: 520 + offset[1], angle: 0, unit: 420 };
  return {
    id: 7,
    points: pts.map((p) => torsoToPx(pose, p)),
    pressure: pts.map((_, i) => 0.35 + 0.6 * Math.sin((Math.PI * i) / (pts.length - 1))),
    layer: 'front',
  } as Placed;
}

// ---------- pixels ----------

let head: HeadlessModule;
async function alphaOf(effect: Effect, stroke: Placed): Promise<Float32Array> {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const png = Buffer.from(head.renderPng(W, H, [stroke], effect, 1, 0));
  const img = await loadImage(png);
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, W, H).data;
  const a = new Float32Array(W * H);
  for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3]! / 255;
  return a;
}

/** Grain map: how much of the base brush's fill the textured brush removed, per pixel. */
const grainMap = (base: Float32Array, tex: Float32Array) => base.map((v, i) => Math.max(0, v - tex[i]!));

/** Pixels fully inside the base outline, one pixel in from its edge. */
function interior(base: Float32Array): number[] {
  const out: number[] = [];
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    if (base[i]! >= 0.98 && base[i - 1]! >= 0.98 && base[i + 1]! >= 0.98 && base[i - W]! >= 0.98 && base[i + W]! >= 0.98) out.push(i);
  }
  return out;
}

/** Shift d of map B relative to map A (B(x + d) ≈ A(x)) by zero-mean cross-correlation over A's interior. */
function grainShift(gA: Float32Array, inA: number[], gB: Float32Array, inB: Set<number>, expect: V2): { d: V2; peak: number } {
  const meanA = inA.reduce((s, i) => s + gA[i]!, 0) / inA.length;
  let sumB = 0;
  for (const i of inB) sumB += gB[i]!;
  const meanB = sumB / inB.size;
  const rB = (i: number) => (inB.has(i) ? gB[i]! - meanB : 0);
  const lo: V2 = [Math.min(0, expect[0]) - 5, Math.min(0, expect[1]) - 5];
  const hi: V2 = [Math.max(0, expect[0]) + 5, Math.max(0, expect[1]) + 5];
  const C = new Map<string, number>();
  let best = { dx: 0, dy: 0, c: -Infinity };
  for (let dy = Math.floor(lo[1]); dy <= Math.ceil(hi[1]); dy++) for (let dx = Math.floor(lo[0]); dx <= Math.ceil(hi[0]); dx++) {
    let c = 0;
    for (const i of inA) {
      const x = (i % W) + dx;
      const y = Math.floor(i / W) + dy;
      if (x < 0 || x >= W || y < 0 || y >= H) continue;
      c += (gA[i]! - meanA) * rB(y * W + x);
    }
    C.set(`${dx},${dy}`, c);
    if (c > best.c) best = { dx, dy, c };
  }
  const at = (dx: number, dy: number) => C.get(`${dx},${dy}`);
  const refine = (m: number | undefined, z: number, p: number | undefined) => {
    if (m === undefined || p === undefined) return 0;
    const den = m - 2 * z + p;
    return den < 0 ? (0.5 * (m - p)) / den : 0;
  };
  const fx = refine(at(best.dx - 1, best.dy), best.c, at(best.dx + 1, best.dy));
  const fy = refine(at(best.dx, best.dy - 1), best.c, at(best.dx, best.dy + 1));
  return { d: [best.dx + fx, best.dy + fy], peak: best.c };
}

function distToLine(p: V2, pts: V2[]): number {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) best = Math.min(best, segDist(p, pts[i - 1]!, pts[i]!).d);
  return best;
}

/** Widest point: 2 × max distance (inked pixel to nearest un-inked pixel centre) - 1, via an exact distance transform. */
function widest(alpha: Float32Array): number {
  let x0 = W;
  let x1 = -1;
  let y0 = H;
  let y1 = -1;
  for (let i = 0; i < alpha.length; i++) if (alpha[i]! >= 0.5) {
    const x = i % W;
    const y = Math.floor(i / W);
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (x1 < 0) return 0;
  x0 -= 2; y0 -= 2; x1 += 2; y1 += 2;
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const INF = 1e20;
  const f = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const gx = x + x0;
    const gy = y + y0;
    const inked = gx >= 0 && gx < W && gy >= 0 && gy < H && alpha[gy * W + gx]! >= 0.5;
    f[y * w + x] = inked ? INF : 0;
  }
  const dt1 = (get: (i: number) => number, set: (i: number, v: number) => void, n: number) => {
    const v = new Int32Array(n);
    const z = new Float64Array(n + 1);
    const d = new Float64Array(n);
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = (get(q) + q * q - (get(v[k]!) + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      while (s <= z[k]!) {
        k--;
        s = (get(q) + q * q - (get(v[k]!) + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1]! < q) k++;
      d[q] = (q - v[k]!) * (q - v[k]!) + get(v[k]!);
    }
    for (let q = 0; q < n; q++) set(q, d[q]!);
  };
  for (let x = 0; x < w; x++) dt1((i) => f[i * w + x]!, (i, val) => (f[i * w + x] = val), h);
  for (let y = 0; y < h; y++) dt1((i) => f[y * w + i]!, (i, val) => (f[y * w + i] = val), w);
  let max = 0;
  for (let i = 0; i < f.length; i++) if (f[i]! < INF / 2 && f[i]! > max) max = f[i]!;
  return 2 * Math.sqrt(max) - 1;
}

// ---------- tests ----------

describe('B2 each brush does its job', () => {
  it('B2 grain fixed to the stroke, glow near its line, fine tip thinner than ink', async () => {
    const mods = await recorded(ev, 'modules load', 'src/render/headless.ts (renderPng), src/render/brushes.ts (brushSettings)', async () => ({
      head: await need('src/render/headless.ts', { renderPng: 'function' }, () => import('../../src/render/headless.ts')),
      brushes: await need('src/render/brushes.ts', { brushSettings: 'function' }, () => import('../../src/render/brushes.ts')),
    })) as { head: HeadlessModule; brushes: BrushesModule };
    head = mods.head;
    const failures: string[] = [];

    // SPEC §8.7 defaults
    const s87 = spec87();
    {
      const e = effectWith('ink');
      const got = (id: string) => mods.brushes.brushSettings(e, id as never) as { size: number; grain?: number; glow?: { radiusPx: number; intensity: number } };
      const near = (a: number | undefined, b: number) => a !== undefined && Math.abs(a - b) < 1e-9;
      const bad: string[] = [];
      for (const id of ['fine-ink', 'fine-textured']) if (!near(got(id).size, s87.fineFactor * INK.size)) bad.push(`${id} size ${got(id).size} (want ${s87.fineFactor} × ${INK.size})`);
      for (const id of ['textured', 'fine-textured']) if (!near(got(id).grain, s87.grain)) bad.push(`${id} grain ${got(id).grain} (want ${s87.grain})`);
      for (const id of ['neon-straight', 'neon-round']) {
        const g = got(id).glow;
        if (!g || !near(g.radiusPx, s87.glowRadius) || !near(g.intensity, s87.glowIntensity)) bad.push(`${id} glow ${JSON.stringify(g)} (want radius ${s87.glowRadius}, intensity ${s87.glowIntensity})`);
      }
      ev.record('SPEC §8.7 defaults', bad.length ? bad : 'all match', `fine size ${s87.fineFactor} × ink, grain ${s87.grain}, glow radius ${s87.glowRadius} px, intensity ${s87.glowIntensity}`, bad.length === 0);
      if (bad.length) failures.push(`defaults: ${bad.join('; ')}`);
    }

    // Grain
    {
      const pre: Record<string, number> = {};
      for (const [tex, base] of [['textured', 'ink'], ['fine-textured', 'fine-ink']] as const) {
        const stroke = placedStroke(31);
        const aBase = await alphaOf(effectWith(base), stroke);
        const aTex = await alphaOf(effectWith(tex), stroke);
        const gA = grainMap(aBase, aTex);
        const inA = interior(aBase);
        const removed = inA.length ? inA.reduce((s, i) => s + gA[i]!, 0) / inA.length : 0;
        pre[tex] = removed;
        const results: { T: V2; found: V2; err: number }[] = [];
        for (const T of [...SHIFTS, SUBPIXEL]) {
          const moved = placedStroke(31, T);
          const bBase = await alphaOf(effectWith(base), moved);
          const bTex = await alphaOf(effectWith(tex), moved);
          const gB = grainMap(bBase, bTex);
          const { d } = grainShift(gA, inA, gB, new Set(interior(bBase)), T);
          results.push({ T, found: [Number(d[0].toFixed(3)), Number(d[1].toFixed(3))], err: Math.hypot(d[0] - T[0], d[1] - T[1]) });
        }
        const gated = results.slice(0, SHIFTS.length);
        const worst = Math.max(...gated.map((r) => r.err));
        const ok = removed > 0.05 && removed < 0.95 && worst <= GRAIN_TOL;
        ev.record(`${tex}: grain moves with the stroke`, { worstErrPx: worst, shifts: gated }, `|grain shift - translation| <= ${GRAIN_TOL} px`, ok);
        if (!ok) failures.push(`${tex}: grain shift error ${worst} px (removed ${removed})`);
        if (tex === 'textured') ev.record('grain under a sub-pixel translation (report)', results[SHIFTS.length], `reported; ${GRAIN_TOL} px would be the threshold`, true);
      }
      const preOk = Object.values(pre).every((r) => r > 0.05 && r < 0.95);
      ev.record('precondition: grain removes part of the fill', pre, 'between 5% and 95% of the interior fill removed', preOk);
    }

    // Glow
    {
      const stroke = placedStroke(47);
      const line = stroke.points as V2[];
      const glowCheck = async (effect: Effect, id: string) => {
        const st = mods.brushes.brushSettings(effect, id as never) as { size: number; glow?: { radiusPx: number } };
        const radius = st.glow?.radiusPx ?? NaN;
        const a = await alphaOf(effect, stroke);
        let far = 0;
        let maxD = 0;
        let pastCore = 0;
        for (let i = 0; i < a.length; i++) {
          if (a[i]! <= 0) continue;
          const d = distToLine([(i % W) + 0.5, Math.floor(i / W) + 0.5], line);
          if (d > maxD) maxD = d;
          if (d > GLOW_FACTOR * radius) far++;
          if (d > st.size / 2 + 1) pastCore++;
        }
        return { radius, limit: GLOW_FACTOR * radius, maxDistPx: maxD, pixelsBeyond: far, pixelsPastCore: pastCore };
      };
      const glowPast: Record<string, number> = {};
      for (const id of ['neon-straight', 'neon-round']) {
        const r = await glowCheck(effectWith(id), id);
        glowPast[id] = r.pixelsPastCore;
        const ok = Number.isFinite(r.radius) && r.pixelsBeyond === 0;
        ev.record(`${id}: glow within 2 × radius (default)`, r, `no pixel farther than ${GLOW_FACTOR} × glow.radiusPx from the centerline`, ok);
        if (!ok) failures.push(`${id} default: ${r.pixelsBeyond} pixels beyond ${r.limit} px (max ${r.maxDistPx.toFixed(2)})`);
      }
      ev.record('precondition: neon glows past its core', glowPast, 'some pixels beyond half the brush size', Object.values(glowPast).every((n) => n > 0));
      const custom: Record<string, unknown> = {};
      let customOk = true;
      for (const id of ['neon-straight', 'neon-round']) {
        const base = mods.brushes.brushSettings(effectWith(id), id as never) as { glow?: { radiusPx: number; intensity: number } };
        const settings = { ...base, glow: { radiusPx: 2 * s87.glowRadius, intensity: base.glow?.intensity ?? s87.glowIntensity } };
        const e = effectWith(id, { brushes: { [id]: settings } as Effect['brushes'] });
        const r = await glowCheck(e, id);
        custom[id] = r;
        if (!(r.radius === 2 * s87.glowRadius && r.pixelsBeyond === 0)) customOk = false;
      }
      ev.record('neon glow within 2 × radius (custom radius)', custom, `effect.brushes radius ${2 * s87.glowRadius} px is used, and no pixel beyond 2 × it`, customOk);
      if (!customOk) failures.push('custom glow radius');
    }

    // Fine tip
    {
      const rows: { seed: number; ink: number; fine: number; ratio: number }[] = [];
      for (const seed of [52, 53, 54]) {
        const stroke = placedStroke(seed);
        const ink = widest(await alphaOf(effectWith('ink'), stroke));
        const fine = widest(await alphaOf(effectWith('fine-ink'), stroke));
        rows.push({ seed, ink, fine, ratio: ink > 0 ? fine / ink : Infinity });
      }
      const worst = Math.max(...rows.map((r) => r.ratio));
      const ok = rows.every((r) => r.ink > 0 && r.fine > 0) && worst <= FINE_RATIO;
      ev.record("fine-ink's widest point <= 0.5 × ink's", { worstRatio: worst, strokes: rows }, `<= ${FINE_RATIO}`, ok);
      if (!ok) failures.push(`fine-ink / ink widest ratio ${worst}`);
    }

    const failed = ev.checks.filter((c) => !c.pass).map((c) => `${c.name}: ${JSON.stringify(c.measured).slice(0, 200)}`);
    expect(failed, `B2 failing checks (${failures.join('; ')})`).toEqual([]);
  }, 600_000);
});
