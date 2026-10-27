/// <reference types="node" />
// Shared plumbing for the engine acceptance tests (tests/M1/ on). Nothing here implements the engine.
// - need(): loads a contract module (SPEC §6) with a clear message when it's missing or lacks an export.
// - readReference()/timingDps()/timingBoil(): Qai's reference files, read at runtime. A missing file fails
//   with "<path> missing: Qai must add it"; there is no fallback, and reference/timing.example.json is never read.
// - specPhysics(): the §8.7 parameter table, parsed from docs/SPEC.md at runtime, so the physics tests run
//   with SPEC's values rather than whatever DEFAULT_PHYSICS says.
// - Seeded synthetic test input: a moving torso pose and tendril shapes in torso space. torsoToPx() only
//   turns that input into pixel targets for the P tests; the engine's own src/track/torso.ts is what A1 checks.
// - Geometry for the measurements (outline distance, arc length) and a PNG header reader.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type Evidence, ROOT, readText } from './evidence.ts';

export type V2 = [number, number];

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---------- contract modules ----------

/** Imports a contract module, failing clearly when the file, the import or a named export is missing. */
export async function need<T>(rel: string, wanted: Record<string, 'function' | 'object'>, load: () => Promise<T>): Promise<T> {
  if (!existsSync(join(ROOT, rel))) throw new Error(`${rel} missing: the builder must add it (SPEC §6 module contract)`);
  let mod: T;
  try {
    mod = await load();
  } catch (e) {
    throw new Error(`${rel} exists but failed to load: ${errMsg(e)}`);
  }
  const rec = mod as Record<string, unknown>;
  const bad = Object.entries(wanted)
    .filter(([name, kind]) => rec[name] === null || typeof rec[name] !== kind)
    .map(([name, kind]) => `${name} (${kind})`);
  if (bad.length) throw new Error(`${rel} does not export ${bad.join(', ')} (the module contract)`);
  return mod;
}

/** Runs `fn` once and records `check` as PASS with its value, or FAIL with the reason, then rethrows. */
export async function recorded<T>(ev: Evidence, check: string, threshold: unknown, fn: () => Promise<T> | T, show?: (v: T) => unknown): Promise<T> {
  let v: T;
  try {
    v = await fn();
  } catch (e) {
    ev.record(check, 'missing or invalid', threshold, false, errMsg(e));
    throw e;
  }
  ev.record(check, show ? show(v) : 'present', threshold, true);
  return v;
}

// ---------- Qai's reference files ----------

export function readReference(rel: string): unknown {
  const p = join(ROOT, rel);
  if (!existsSync(p)) throw new Error(`${rel} missing: Qai must add it (SPEC §11)`);
  try {
    return JSON.parse(readText(p)) as unknown;
  } catch (e) {
    throw new Error(`${rel} is not valid JSON: ${errMsg(e)}`);
  }
}

const TIMING = 'reference/timing.json';

/** reference/timing.json `dps`: 12 (on 2s) or 8 (on 3s), SPEC §11 and §7. */
export function timingDps(): 12 | 8 {
  const t = readReference(TIMING) as { dps?: unknown } | null;
  const dps = t?.dps;
  if (dps !== 12 && dps !== 8) throw new Error(`${TIMING} "dps" is ${JSON.stringify(dps)}: SPEC §11 allows 12 (on 2s) or 8 (on 3s)`);
  return dps;
}

/** reference/timing.json `boil`: maxPx at 1080 wide, cycle in drawings (SPEC §8.4, §11). */
export function timingBoil(): { maxPx: number; cycle: number } {
  const t = readReference(TIMING) as { boil?: { maxPx?: unknown; cycle?: unknown } } | null;
  const maxPx = t?.boil?.maxPx;
  const cycle = t?.boil?.cycle;
  if (typeof maxPx !== 'number' || !Number.isFinite(maxPx) || maxPx < 0) {
    throw new Error(`${TIMING} "boil.maxPx" is ${JSON.stringify(maxPx)}: expected a number of px at 1080 wide`);
  }
  if (typeof cycle !== 'number' || !Number.isInteger(cycle) || cycle < 1) {
    throw new Error(`${TIMING} "boil.cycle" is ${JSON.stringify(cycle)}: expected a whole number of drawings`);
  }
  return { maxPx, cycle };
}

// ---------- SPEC §8.7, read at runtime ----------

export interface SpecPhysics {
  dt: number;
  passes: number;
  damping: number;
  gravity: number;
  bendLimitDeg: number;
  /** k = pullCoeff · stiffness², from the "shape pull" row. */
  pullCoeff: number;
}

export function specPhysics(): SpecPhysics {
  const spec = readText(join(ROOT, 'docs', 'SPEC.md'));
  const start = spec.indexOf('### 8.7');
  if (start < 0) throw new Error('docs/SPEC.md has no "### 8.7" parameter table');
  const end = spec.indexOf('\n## ', start);
  const section = spec.slice(start, end < 0 ? undefined : end);
  const cell = (row: string): string => {
    const m = section.match(new RegExp(`^\\|\\s*${row}\\s*\\|([^|\\n]+)\\|`, 'mi'));
    if (!m) throw new Error(`docs/SPEC.md §8.7 has no "${row}" row`);
    return (m[1] ?? '').trim();
  };
  const num = (row: string): number => {
    const c = cell(row);
    const frac = c.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
    const v = frac ? Number(frac[1]) / Number(frac[2]) : Number(c.match(/^-?\d+(?:\.\d+)?/)?.[0]);
    if (!Number.isFinite(v)) throw new Error(`docs/SPEC.md §8.7 "${row}" is "${c}": no number to read`);
    return v;
  };
  const pull = cell('shape pull').match(/k\s*=\s*(\d+(?:\.\d+)?)\s*·\s*stiffness²/);
  if (!pull) throw new Error(`docs/SPEC.md §8.7 "shape pull" is "${cell('shape pull')}": expected k = <c>·stiffness²`);
  return {
    dt: num('dt'),
    passes: num('constraint passes'),
    damping: num('damping'),
    gravity: num('gravity'),
    bendLimitDeg: num('bend limit'),
    pullCoeff: Number(pull[1]),
  };
}

/** SPEC §8.7 as a PhysicsParams-shaped object (the contract's field names). */
export function specParams(over: Partial<{ dt: number; passes: number; damping: number; gravity: number; bendLimitDeg: number | null }> = {}): {
  dt: number;
  passes: number;
  damping: number;
  gravity: number;
  bendLimitDeg: number | null;
} {
  const s = specPhysics();
  return { dt: s.dt, passes: s.passes, damping: s.damping, gravity: s.gravity, bendLimitDeg: s.bendLimitDeg, ...over };
}

// ---------- seeded synthetic input ----------

/** mulberry32: a small seeded PRNG, uniform in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Same fields as the contract's TorsoTransform: origin px, angle rad (0 upright), unit = px per torso height. */
export interface Pose {
  x: number;
  y: number;
  angle: number;
  unit: number;
}

interface Wave {
  a: number;
  f: number;
  p: number;
}

/**
 * Seeded smooth random torso motion on a 1080 x 1920 frame, as a function of time in seconds: sums of random
 * sinusoids (translation up to about 5 torso heights/s, rotation up to about 2 rad/s, scale +-25%), the range of
 * a fast side-step, lean and walk toward the camera. `drift` adds a constant velocity (px/s) and `spin` a constant
 * angular velocity (rad/s), so the pose can be made to move on every frame. `jumps` adds an instant jump of up to
 * `size` torso heights every `every` seconds (a tracking glitch), for checks that must hold even then.
 */
export function randomMotion(
  seed: number,
  o: { cx?: number; cy?: number; unit?: number; drift?: V2; spin?: number; grow?: number; jumps?: { every: number; size: number } } = {},
): (t: number) => Pose {
  const r = rng(seed);
  const unit0 = o.unit ?? 420;
  const cx = o.cx ?? 540;
  const cy = o.cy ?? 960;
  const waves = (n: number, amp: V2, freq: V2): Wave[] =>
    Array.from({ length: n }, () => ({ a: amp[0] + (amp[1] - amp[0]) * r(), f: freq[0] + (freq[1] - freq[0]) * r(), p: 2 * Math.PI * r() }));
  const X = waves(4, [0.05, 0.3], [0.1, 1.2]);
  const Y = waves(4, [0.03, 0.15], [0.1, 1.2]);
  const A = waves(3, [0.03, 0.15], [0.05, 0.8]);
  const U = waves(3, [0.02, 0.08], [0.05, 0.4]);
  const sum = (ws: Wave[], t: number) => ws.reduce((v, w) => v + w.a * Math.sin(2 * Math.PI * w.f * t + w.p), 0);
  const jumpList: V2[] = [];
  if (o.jumps) for (let i = 0; i < 200; i++) jumpList.push([(r() * 2 - 1) * o.jumps.size * unit0, (r() * 2 - 1) * o.jumps.size * unit0]);
  const drift = o.drift ?? [0, 0];
  return (t: number): Pose => {
    let jx = 0;
    let jy = 0;
    if (o.jumps) {
      // Alternates: away by a random jump, then back to zero, so the pose stays on the frame.
      const n = Math.min(jumpList.length - 1, Math.floor(t / o.jumps.every));
      if (n % 2 === 1) [jx, jy] = jumpList[n]!;
    }
    return {
      x: cx + unit0 * sum(X, t) + drift[0] * t + jx,
      y: cy + unit0 * sum(Y, t) + drift[1] * t + jy,
      angle: sum(A, t) + (o.spin ?? 0) * t,
      unit: unit0 * (1 + sum(U, t) + (o.grow ?? 0) * t),
    };
  };
}

/** Test-side torso -> px (x right, y down, rotated by angle), used only to feed P-test physics targets. */
export function torsoToPx(t: Pose, p: V2): V2 {
  const c = Math.cos(t.angle);
  const s = Math.sin(t.angle);
  return [t.x + t.unit * (c * p[0] - s * p[1]), t.y + t.unit * (s * p[0] + c * p[1])];
}

/**
 * A seeded tendril in torso space: n points, evenly spaced, `length` torso heights long, root first, with a
 * random start direction (never within 20 degrees of straight up) and a gentle random bend.
 */
export function tendril(seed: number, n = 32, length = 0.8): V2[] {
  const r = rng(seed);
  const root: V2 = [(r() * 2 - 1) * 0.3, -0.4 + r() * 0.5];
  // Direction in screen terms (y down): -pi/2 is straight up. Start 20 to 180 degrees away from it.
  let a = -Math.PI / 2 + (Math.PI / 9 + r() * ((8 * Math.PI) / 9)) * (r() < 0.5 ? 1 : -1);
  const bend = (r() * 2 - 1) * 1.6;
  const ds = length / (n - 1);
  const pts: V2[] = [root];
  for (let i = 1; i < n; i++) {
    a += bend / (n - 1);
    const q = pts[i - 1]!;
    pts.push([q[0] + ds * Math.cos(a), q[1] + ds * Math.sin(a)]);
  }
  return pts;
}

// ---------- geometry ----------

export const dist = (a: V2, b: V2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function polylineLength(pts: V2[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1]!, pts[i]!);
  return s;
}

/** Closest point on segment ab to p: its distance and the parameter u in [0, 1]. */
export function segDist(p: V2, a: V2, b: V2): { d: number; u: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const u = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return { d: Math.hypot(p[0] - (a[0] + u * dx), p[1] - (a[1] + u * dy)), u };
}

/** Distance from p to an open polyline, and the arc length at the closest point. */
export function projectOnPolyline(p: V2, pts: V2[]): { d: number; s: number } {
  let best = { d: Infinity, s: 0 };
  let along = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const len = dist(a, b);
    const r = segDist(p, a, b);
    if (r.d < best.d) best = { d: r.d, s: along + r.u * len };
    along += len;
  }
  return best;
}

/** Shoelace area of a closed polygon (absolute value). */
export function polygonArea(poly: V2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}

/** Points along a closed polygon's boundary, at most `step` px apart (vertices included). */
export function boundarySamples(poly: V2[], step: number): V2[] {
  const out: V2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const n = Math.max(1, Math.ceil(dist(a, b) / step));
    for (let j = 0; j < n; j++) out.push([a[0] + ((b[0] - a[0]) * j) / n, a[1] + ((b[1] - a[1]) * j) / n]);
  }
  return out;
}

/** Distance from p to a closed polygon's boundary. */
export function distToBoundary(p: V2, poly: V2[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    // Cheap reject: the segment's bounding box is farther than the best so far.
    const minX = Math.min(a[0], b[0]) - best;
    const maxX = Math.max(a[0], b[0]) + best;
    const minY = Math.min(a[1], b[1]) - best;
    const maxY = Math.max(a[1], b[1]) + best;
    if (p[0] < minX || p[0] > maxX || p[1] < minY || p[1] > maxY) continue;
    const d = segDist(p, a, b).d;
    if (d < best) best = d;
  }
  return best;
}

/**
 * Mean distance between two closed outlines: boundary samples of each (every `step` px) to the other's boundary,
 * averaged; returns both directions and the larger one (the stricter of the two).
 */
export function outlineDistance(a: V2[], b: V2[], step = 0.5): { ab: number; ba: number; mean: number } {
  const directed = (from: V2[], to: V2[]) => {
    const s = boundarySamples(from, step);
    let total = 0;
    for (const p of s) total += distToBoundary(p, to);
    return s.length ? total / s.length : Infinity;
  };
  const ab = directed(a, b);
  const ba = directed(b, a);
  return { ab, ba, mean: Math.max(ab, ba) };
}

// ---------- bytes ----------

/** Float64 bytes of a flat number list: byte-identical arrays give equal buffers (-0 and NaN payloads included). */
export function f64Bytes(values: number[]): Buffer {
  return Buffer.from(new Float64Array(values).buffer);
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height from a PNG's IHDR chunk, or null when the bytes aren't a PNG. */
export function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIG) || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
