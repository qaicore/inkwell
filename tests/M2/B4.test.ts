/// <reference types="node" />
// B4 (SPEC §10, brushes): the flame aura follows the person and stays near him. On a synthetic mask: byte-identical
// across two renders of the same k; different between consecutive drawings; no aura pixel farther than 0.6 torso
// heights from the mask; moving the mask moves the aura with it (within 1 px at half resolution) (start).
//
// Measured on pixels from the real aura, src/render/aura.ts drawFlameAura(ctx, make, { mask, width, height, color, k,
// torsoPx }), drawn onto an empty @napi-rs/canvas the size of the frame with src/render/headless.ts nodeScratch for
// scratch buffers. The mask is a fixed synthetic person (head, neck, torso, arms, legs) on a 608 x 1080 frame
// (1080 on the long side, §1), 1 = person; torsoPx is one torso height in px, the unit of the aura's reach (§8.7).
//   - Same k: k = 0..3 rendered in two fresh module instances (vi.resetModules) with Math.random, Date.now and
//     performance.now different between them, plus k = 0 again at the end of the first run (after its scratch
//     buffers were reused); all RGBA bytes equal.
//   - Consecutive drawings: k -> k + 1 for k = 0..2 must change the aura's shape, i.e. the alpha of some pixel
//     outside the mask (the part that shows, §8.6), at torsoPx 260 and 160.
//   - Reach: every pixel with alpha > 0, embers and anything drawn inside the mask included, lies within
//     0.6 × torsoPx of the nearest mask pixel (exact Euclidean distance transform, pixel centres); for every render
//     made (k = 0..3 at torsoPx 260 and 160, and the moved masks).
//   - Moving the mask: the mask is translated by T = (24, -16) and (-36, 28) px (even, so it lands on the half-res
//     grid). Both renders are taken to half resolution (2 x 2 mean of the alpha outside the mask), and the aura's
//     shift is found by cross-correlation (search over every integer shift from 0 to T/2 and 3 half-res px around,
//     refined with a parabola). |found - T/2| <= 1 half-res px, at k = 0 and 1.
// Preconditions: the aura shows (alpha > 0 outside the mask) in every render.
// Stricter readings / open points, flagged for Qai:
//   - "moves with it" is read as the aura's bulk shift (cross-correlation), not a pixel-exact translation: the noise
//     that cuts the licks may live in screen space (§8.6 doesn't say), so licks are allowed to change. The
//     alpha-weighted centroid of the visible aura is measured and reported, not gated: a screen-space noise moves it
//     by a few half-res px on its own. If Qai wants the aura to translate exactly, the noise must ride the mask;
//   - "1 px at half resolution" is read as one half-res px (2 px at full res), measured on half-res images;
//   - "different between consecutive drawings" is read as a change in shape (alpha), not only in color;
//   - "aura pixel" is any pixel the aura touches (alpha > 0), embers included.
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { BrushTarget, MakeScratch } from '../../src/render/brushes.ts';
import { Evidence } from '../helpers/evidence.ts';
import { need, recorded, rng, type V2 } from '../helpers/engine.ts';

type AuraModule = typeof import('../../src/render/aura.ts');
type HeadlessModule = typeof import('../../src/render/headless.ts');

const ID = 'B4';
const W = 608;
const H = 1080;
const REACH = 0.6; // torso heights (SPEC §10 B4)
const HALF_TOL = 1; // px at half resolution (SPEC §10 B4)
const TORSOS = [260, 160]; // px per torso height: test input, two sizes so the reach must scale with it
const KS = [0, 1, 2, 3];
const MOVES: V2[] = [[24, -16], [-36, 28]];
const MOVE_KS = [0, 1];
const COLOR = '#c8323c';

const ev = new Evidence(ID, [
  'modules load',
  'precondition: the aura shows around the person',
  'byte-identical across two renders of the same k',
  'different between consecutive drawings',
  ...TORSOS.map((t) => `no aura pixel farther than 0.6 torso heights from the mask (torsoPx ${t})`),
  'moving the mask moves the aura with it',
  'aura centroid follows the mask (report)',
]);
afterAll(() => ev.write());

// ---------- the synthetic person ----------

function capsule(px: number, py: number, a: V2, b: V2, r: number): boolean {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const u = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - a[0] - u * dx, py - a[1] - u * dy) <= r;
}

/** A standing person, about 790 px tall, moved by `off` px. 1 = person, 0 = not. */
function personMask(off: V2 = [0, 0]): Uint8Array {
  const m = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const px = x + 0.5 - off[0];
    const py = y + 0.5 - off[1];
    const inside =
      ((px - 304) / 52) ** 2 + ((py - 265) / 62) ** 2 <= 1 || // head
      (px >= 284 && px <= 324 && py >= 315 && py <= 350) || // neck
      ((px - 304) / 105) ** 2 + ((py - 480) / 140) ** 2 <= 1 || // torso
      capsule(px, py, [210, 370], [172, 600], 26) || // arms
      capsule(px, py, [398, 370], [436, 600], 26) ||
      capsule(px, py, [262, 590], [252, 940], 36) || // legs
      capsule(px, py, [346, 590], [356, 940], 36);
    m[y * W + x] = inside ? 1 : 0;
  }
  return m;
}

// ---------- pixels ----------

interface Mods {
  aura: AuraModule;
  head: HeadlessModule;
}

async function load(): Promise<Mods> {
  return {
    aura: await need('src/render/aura.ts', { drawFlameAura: 'function' }, () => import('../../src/render/aura.ts')),
    head: await need('src/render/headless.ts', { nodeScratch: 'function' }, () => import('../../src/render/headless.ts')),
  };
}

async function render(m: Mods, mask: Uint8Array, k: number, torsoPx: number): Promise<Uint8ClampedArray> {
  const { createCanvas } = await import('@napi-rs/canvas');
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  // A copy, so an aura that writes into its mask can't change what the test measures against.
  m.aura.drawFlameAura(ctx as unknown as BrushTarget, m.head.nodeScratch as MakeScratch, { mask: mask.slice(), width: W, height: H, color: COLOR, k, torsoPx });
  return ctx.getImageData(0, 0, W, H).data;
}

/** Fresh module instances with Math.random and the clocks set from `seed`, so nothing outside k can steer the aura. */
async function isolated<T>(seed: number, fn: (m: Mods) => Promise<T>): Promise<T> {
  vi.resetModules();
  const random = rng(seed);
  const spies = [
    vi.spyOn(Math, 'random').mockImplementation(() => random()),
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000 + seed * 7_919_000),
    vi.spyOn(performance, 'now').mockReturnValue(seed * 104_729),
  ];
  try {
    return await fn(await load());
  } finally {
    for (const s of spies) s.mockRestore();
  }
}

/** Exact squared Euclidean distance from every pixel centre to the nearest source pixel centre (Felzenszwalb). */
function sqDistTo(source: Uint8Array, w: number, h: number): Float64Array {
  const INF = 1e20;
  const f = new Float64Array(w * h);
  for (let i = 0; i < f.length; i++) f[i] = source[i] ? 0 : INF;
  const n = Math.max(w, h);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const g = new Float64Array(n);
  const d = new Float64Array(n);
  const pass = (len: number, at: (q: number) => number) => {
    for (let q = 0; q < len; q++) g[q] = f[at(q)]!;
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = (g[q]! + q * q - (g[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      while (s <= z[k]!) {
        k--;
        s = (g[q]! + q * q - (g[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1]! < q) k++;
      d[q] = (q - v[k]!) * (q - v[k]!) + g[v[k]!]!;
    }
    for (let q = 0; q < len; q++) f[at(q)] = d[q]!;
  };
  for (let x = 0; x < w; x++) pass(h, (q) => q * w + x);
  for (let y = 0; y < h; y++) pass(w, (q) => y * w + q);
  return f;
}

/** Pixels the aura touches outside the mask: the part that shows around him (§8.6). */
function visibleCount(rgba: Uint8ClampedArray, mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (!mask[i] && rgba[i * 4 + 3]! > 0) n++;
  return n;
}

/** Reach: the farthest aura pixel from the mask, and how many lie beyond `limit` px. */
function reach(rgba: Uint8ClampedArray, d2: Float64Array, limit: number): { maxDistPx: number; pixelsBeyond: number } {
  let max = 0;
  let beyond = 0;
  for (let i = 0; i < d2.length; i++) {
    if (rgba[i * 4 + 3]! === 0) continue;
    const d = Math.sqrt(d2[i]!);
    if (d > max) max = d;
    if (d > limit) beyond++;
  }
  return { maxDistPx: Number(max.toFixed(2)), pixelsBeyond: beyond };
}

const HW = W / 2;
const HH = H / 2;

/** Half resolution: the 2 x 2 mean of the aura's alpha outside the mask (0..1). */
function halfVisible(rgba: Uint8ClampedArray, mask: Uint8Array): Float32Array {
  const out = new Float32Array(HW * HH);
  for (let y = 0; y < HH; y++) for (let x = 0; x < HW; x++) {
    let s = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const i = (2 * y + dy) * W + 2 * x + dx;
      if (!mask[i]) s += rgba[i * 4 + 3]! / 255;
    }
    out[y * HW + x] = s / 4;
  }
  return out;
}

/** Shift d of map B relative to map A (B(x + d) ≈ A(x)), by cross-correlation over A's support, half-res px. */
function auraShift(A: Float32Array, B: Float32Array, expect: V2): V2 {
  const sup: number[] = [];
  let mA = 0;
  for (let i = 0; i < A.length; i++) if (A[i]! > 0) {
    sup.push(i);
    mA += A[i]!;
  }
  if (!sup.length) return [NaN, NaN];
  mA /= sup.length;
  const C = new Map<string, number>();
  let best = { dx: 0, dy: 0, c: -Infinity };
  for (let dy = Math.min(0, expect[1]) - 3; dy <= Math.max(0, expect[1]) + 3; dy++) for (let dx = Math.min(0, expect[0]) - 3; dx <= Math.max(0, expect[0]) + 3; dx++) {
    let c = 0;
    for (const i of sup) {
      const x = (i % HW) + dx;
      const y = Math.floor(i / HW) + dy;
      if (x < 0 || x >= HW || y < 0 || y >= HH) continue;
      c += (A[i]! - mA) * B[y * HW + x]!;
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
  return [best.dx + refine(at(best.dx - 1, best.dy), best.c, at(best.dx + 1, best.dy)), best.dy + refine(at(best.dx, best.dy - 1), best.c, at(best.dx, best.dy + 1))];
}

function centroid(A: Float32Array): V2 {
  let sx = 0;
  let sy = 0;
  let s = 0;
  for (let i = 0; i < A.length; i++) if (A[i]! > 0) {
    sx += (i % HW) * A[i]!;
    sy += Math.floor(i / HW) * A[i]!;
    s += A[i]!;
  }
  return s > 0 ? [sx / s, sy / s] : [NaN, NaN];
}

const r3 = (v: number) => Number(v.toFixed(3));

// ---------- tests ----------

describe('B4 the flame aura', () => {
  it('B4 the flame aura is deterministic, changes on drawings, stays within 0.6 torso heights and moves with the mask', async () => {
    await recorded(ev, 'modules load', 'src/render/aura.ts (drawFlameAura), src/render/headless.ts (nodeScratch)', () => load());

    const mask0 = personMask();
    const moved = MOVES.map((T) => personMask(T));
    const d2Of = new Map<Uint8Array, Float64Array>([[mask0, sqDistTo(mask0, W, H)], ...moved.map((m): [Uint8Array, Float64Array] => [m, sqDistTo(m, W, H)])]);

    type Shot = { label: string; mask: Uint8Array; torsoPx: number; rgba: Uint8ClampedArray };
    const runA = await isolated(1, async (m) => {
      const shots: Shot[] = [];
      for (const t of TORSOS) for (const k of KS) shots.push({ label: `k${k} torso${t}`, mask: mask0, torsoPx: t, rgba: await render(m, mask0, k, t) });
      for (let j = 0; j < MOVES.length; j++) for (const k of MOVE_KS) {
        shots.push({ label: `k${k} torso${TORSOS[0]} moved ${MOVES[j]!.join(',')}`, mask: moved[j]!, torsoPx: TORSOS[0]!, rgba: await render(m, moved[j]!, k, TORSOS[0]!) });
      }
      const again = await render(m, mask0, 0, TORSOS[0]!);
      return { shots, again };
    });
    const runB = await isolated(2, async (m) => {
      const out: Uint8ClampedArray[] = [];
      for (const k of KS) out.push(await render(m, mask0, k, TORSOS[0]!));
      return out;
    });
    const shot = (label: string) => runA.shots.find((s) => s.label === label)!;

    // Precondition: it shows.
    const shows = runA.shots.map((s) => ({ render: s.label, visiblePixels: visibleCount(s.rgba, s.mask) }));
    ev.record('precondition: the aura shows around the person', shows.filter((s) => s.visiblePixels === 0).length ? shows : `${shows.length} renders, fewest visible pixels ${Math.min(...shows.map((s) => s.visiblePixels))}`, 'alpha > 0 outside the mask in every render', shows.every((s) => s.visiblePixels > 0));

    // Same k, byte-identical.
    {
      const differ: string[] = [];
      KS.forEach((k, j) => {
        const a = Buffer.from(shot(`k${k} torso${TORSOS[0]}`).rgba);
        if (!a.equals(Buffer.from(runB[j]!))) differ.push(`k${k}: run 1 vs run 2`);
      });
      if (!Buffer.from(runA.again).equals(Buffer.from(shot(`k0 torso${TORSOS[0]}`).rgba))) differ.push('k0: first vs last render of run 1');
      ev.record('byte-identical across two renders of the same k', differ.length ? differ : `k ${KS.join(', ')}: identical across fresh module instances and after buffer reuse`, 'all RGBA bytes identical', differ.length === 0);
    }

    // Consecutive drawings differ in shape.
    {
      const rows: { torsoPx: number; pair: string; alphaChangedPixels: number }[] = [];
      for (const t of TORSOS) for (let j = 1; j < KS.length; j++) {
        const a = shot(`k${KS[j - 1]} torso${t}`).rgba;
        const b = shot(`k${KS[j]} torso${t}`).rgba;
        let n = 0;
        for (let i = 0; i < mask0.length; i++) if (!mask0[i] && a[i * 4 + 3] !== b[i * 4 + 3]) n++;
        rows.push({ torsoPx: t, pair: `${KS[j - 1]}->${KS[j]}`, alphaChangedPixels: n });
      }
      ev.record('different between consecutive drawings', rows, 'the alpha of some pixel outside the mask changes on every consecutive pair', rows.every((r) => r.alphaChangedPixels > 0));
    }

    // Reach.
    for (const t of TORSOS) {
      const limit = REACH * t;
      const rows = runA.shots.filter((s) => s.torsoPx === t).map((s) => ({ render: s.label, ...reach(s.rgba, d2Of.get(s.mask)!, limit) }));
      const worst = Math.max(...rows.map((r) => r.maxDistPx));
      ev.record(
        `no aura pixel farther than 0.6 torso heights from the mask (torsoPx ${t})`,
        { worstDistPx: worst, renders: rows },
        `<= ${REACH} × ${t} = ${limit} px from the nearest mask pixel`,
        rows.every((r) => r.pixelsBeyond === 0),
      );
    }

    // Moving the mask.
    {
      const base = new Map(MOVE_KS.map((k) => [k, halfVisible(shot(`k${k} torso${TORSOS[0]}`).rgba, mask0)]));
      const rows: { T: V2; k: number; expectHalf: V2; foundHalf: V2; errHalfPx: number }[] = [];
      const cents: { T: V2; k: number; centroidShiftHalf: V2; errHalfPx: number }[] = [];
      for (let j = 0; j < MOVES.length; j++) for (const k of MOVE_KS) {
        const T = MOVES[j]!;
        const half: V2 = [T[0] / 2, T[1] / 2];
        const A = base.get(k)!;
        const B = halfVisible(shot(`k${k} torso${TORSOS[0]} moved ${T.join(',')}`).rgba, moved[j]!);
        const d = auraShift(A, B, half);
        rows.push({ T, k, expectHalf: half, foundHalf: [r3(d[0]), r3(d[1])], errHalfPx: r3(Math.hypot(d[0] - half[0], d[1] - half[1])) });
        const c0 = centroid(A);
        const c1 = centroid(B);
        const cs: V2 = [c1[0] - c0[0], c1[1] - c0[1]];
        cents.push({ T, k, centroidShiftHalf: [r3(cs[0]), r3(cs[1])], errHalfPx: r3(Math.hypot(cs[0] - half[0], cs[1] - half[1])) });
      }
      const worst = Math.max(...rows.map((r) => (Number.isFinite(r.errHalfPx) ? r.errHalfPx : Infinity)));
      ev.record('moving the mask moves the aura with it', { worstErrHalfPx: worst, moves: rows }, `|aura shift - mask shift| <= ${HALF_TOL} px at half resolution`, worst <= HALF_TOL);
      ev.record('aura centroid follows the mask (report)', cents, `reported; ${HALF_TOL} half-res px would be the threshold`, true, 'not gated: screen-space noise moves the centroid on its own (see the header)');
    }

    const failed = ev.checks.filter((c) => !c.pass).map((c) => `${c.name}: ${JSON.stringify(c.measured).slice(0, 200)}`);
    expect(ev.missing(), 'B4 checks that never ran').toEqual([]);
    expect(failed, 'B4 failing checks').toEqual([]);
  }, 300_000);
});
