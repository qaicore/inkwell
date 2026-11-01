// The black debris (impact design §6, "Debris"; destruction §4.3, §6.6, §7),
// in front of the person:
//   - specks: 10–43 black blobs about 0.010–0.015 U across, on the floor, in
//     the air, on the smoke and in the fire, redrawn with each hold group
//     (seed, 'debris', g): 12, 16, 26, 22, 41, 26, 32, 24 and 14 on g0..g8
//     (g3, g5 and g7, under the flash and the floods, between their measured
//     neighbours), and g8's count in the hold;
//   - shards, on g0–1 (A0–2) only: 5–8 slivers in the floor's colour (the
//     ink role), 0.03 U long at the median and one up to 0.2 U, 3–6 times as
//     long as wide, at r 0.45–0.72 U and ±80° from n̂, pointing out from P;
//   - big chunks, on their own 2s clock one frame late: chunk drawing
//     k′ = floor((f−1)·dps/30), with the age of global drawing k′. Four floor
//     chunks spawn over the drawings of A8–11, on the floor line at r
//     0.19–0.36 U (at the far end of a crack stroke there, when one is); one
//     more on the first drawing of A16, at r 0.55 U on the −t side; and 1–4
//     air chunks are up at a time over the cluster (n 0.2–1.1 U), each for
//     2–4 steps. The reference's chunks fly at the camera, which on the hero
//     is off the bottom edge within one step, so (destruction §7) the floor
//     chunks launch up and out along ±t̂, 20–45° above the floor line,
//     0.04–0.24 U a step, and fall back under gravity. Each grows ×1.1–1.45
//     a step from 0.06–0.10 U across, to at most 0.18 U. A chunk is gone once
//     it is wholly off the frame. None spawn in the decay; the ones up keep
//     flying through it.
//     Shape: 5–8 straight sides and 1–2 notches; from the outside in a
//     near-black seam, the warm rim line #744045, a dark line, then the
//     black body. Over the fire (within the fire part's reach of P) the line
//     is orange (#b05000 / #f86800) and twice as wide.
// Chunk tracks and sizes are in k0 framing: no zoom factor. Specks and
// shards are screen sizes at their age, so they are × the zoom factor about P
// (fire.ts). The colours are the reference's physical blacks, kept for every
// palette, except the shards (the ink role). Everything is × the decay.
import type { GlowSink, ImpactContext } from '../contracts.ts';
import type { BrushTarget } from '../../render/glow.ts';
import { drawingIndex } from '../../motion/timing.ts';
import { decayAlpha, drawingStart, kr } from '../clock.ts';
import { roles } from '../palette.ts';
import { int, normal, rng, uniform, type Rng } from '../rng.ts';
import { CLUSTER_AREA, hotShare } from './cluster.ts';
import {
  GROUP_AGE, LAST_MEASURED, MASS_DPS, clamp, massClock, massFrame, massKey, memo, paint, polygonArea, toFloor, toFrame,
  type FloorPt, type MassContext, type MassDrawing, type MassFrame, type MassShape,
} from './fire.ts';

const DEG = Math.PI / 180;

// ---- Specks and shards (the group clock) ----------------------------------------------

export const SPECKS = [12, 16, 26, 22, 41, 26, 32, 24, 14] as const; // per group, g0..g8
export const SPECK_D = 0.0125; // U across, the median (p50 0.010–0.015)
const SPECK_SPREAD = Math.log(2.2); // the smallest and largest are the median ÷ and × 2.2 (0.006–0.028 U)
export const SHARDS = { count: [5, 8], length: 0.031, longest: [0.1, 0.2], elongation: [3, 6], r: [0.45, 0.72], spread: 80 } as const;
const SPECK_BLACK = '#000000';

export interface Bit {
  role: 'speck' | 'shard';
  points: FloorPt[]; // in the floor frame, at the zoom factor 1
  c: FloorPt;
  size: number; // U: a speck's diameter, a shard's length
}

// Speck q of a group's count, q in 0..1: its size is stratified on a log
// scale, so every group's median is the measured one.
function speck(r: Rng, A: number, q: number): Bit {
  const d = SPECK_D * Math.exp(SPECK_SPREAD * (2 * q - 1));
  let c: FloorPt;
  if (r() < 0.3) {
    // On the floor, either side of P.
    c = [uniform(r, -0.03, 0.1), (r() < 0.5 ? -1 : 1) * uniform(r, 0.08, 0.9)];
  } else {
    // In the air, on the smoke, in the fire: out to a reach that grows with age.
    const reach = Math.min(0.95, 0.35 + 0.06 * A);
    const phi = uniform(r, -90, 90) * DEG;
    const rho = uniform(r, 0.06, reach);
    c = [rho * Math.cos(phi), rho * Math.sin(phi)];
  }
  const m = int(r, 6, 8);
  const base = r() * 2 * Math.PI;
  const points = Array.from({ length: m }, (_, i): FloorPt => {
    const th = base + (2 * Math.PI * i) / m;
    const rr = (d / 2) * uniform(r, 0.75, 1.2);
    return [c[0] + rr * Math.cos(th), c[1] + rr * Math.sin(th)];
  });
  return { role: 'speck', points, c, size: d };
}

function shard(r: Rng, longest: boolean): Bit {
  const L = longest ? uniform(r, SHARDS.longest[0], SHARDS.longest[1]) : clamp(SHARDS.length * Math.exp(normal(r, 0, 0.35)), 0.015, 0.08);
  const w = L / uniform(r, SHARDS.elongation[0], SHARDS.elongation[1]);
  const phi = uniform(r, -SHARDS.spread, SHARDS.spread) * DEG;
  const rho = uniform(r, SHARDS.r[0], SHARDS.r[1]);
  const c: FloorPt = [rho * Math.cos(phi), rho * Math.sin(phi)];
  const axis = phi + uniform(r, -35, 35) * DEG; // out from P, give or take
  const an = Math.cos(axis);
  const at = Math.sin(axis);
  // A sliver: a sharp tip out, a blunter back, and a kink on one side.
  const local: [number, number][] = [
    [L / 2, 0],
    [uniform(r, -0.1, 0.2) * L, w / 2],
    [-L / 2, uniform(r, -0.15, 0.15) * w],
    [uniform(r, -0.3, 0.05) * L, -w / 2],
  ];
  const points = local.map(([a, b]): FloorPt => [c[0] + a * an - b * at, c[1] + a * at + b * an]);
  return { role: 'shard', points, c, size: L };
}

const bitCache = new Map<string, Bit[]>();

// A group's specks and shards: pure in (seed, g).
export function bits(seed: number, g: number): Bit[] {
  return memo(bitCache, `${seed}:${g}`, () => {
    const r = rng(seed, 'debris', g);
    const A = GROUP_AGE[Math.min(g, LAST_MEASURED)];
    const out: Bit[] = [];
    if (g <= 1) {
      const count = int(r, SHARDS.count[0], SHARDS.count[1]);
      for (let i = 0; i < count; i++) out.push(shard(r, i === 0));
    }
    for (let i = 0, count = SPECKS[Math.min(g, LAST_MEASURED)]; i < count; i++) out.push(speck(r, A, (i + r()) / count));
    return out;
  });
}

// ---- Big chunks (the chunk clock) --------------------------------------------------------

export const CHUNKS = {
  floor: 4, // over A8–11
  floorAge: [8, 11],
  floorR: [0.19, 0.36],
  lateAge: 16,
  lateR: 0.55,
  air: [1, 4], // up at a time, from A8
  airN: [0.2, 1.1],
  airLife: [2, 4], // steps
  d0: [0.06, 0.1], // U across at spawn
  maxD: 0.18,
  grow: [1.1, 1.45], // per step
  step: [0.04, 0.24], // U per step
  launch: [20, 45], // degrees above the floor line
} as const;
const SEAM = '#0e0006';
const RIM = '#744045';
const DARK = '#120000';
const BODY = '#000000';
const FIRE_LINE = ['#b05000', '#f86800'] as const;
const EDGE = 0.0032; // U: the seam's and the rim line's width (2 px of the reference's 5 px edge)

export type ChunkKind = 'floor' | 'late' | 'air';
export interface ChunkTrack {
  id: number;
  kind: ChunkKind;
  spawn: number; // the chunk drawing k′ it first shows on
  age: number; // that drawing's reference age
  c0: FloorPt; // where it shows first, U from P (k0 framing)
  v0: FloorPt; // its first step, U
  gravity: number; // U per step², down n̂
  d0: number; // U across
  grow: number;
  spin: number; // radians per step
  life: number; // steps it lasts at most (Infinity for the floor chunks)
  shape: [number, number][]; // unit outline: (angle, radius) per vertex
  line: string | null; // the fire line's tone, when it flies over the fire
}

export interface ChunkAt {
  track: ChunkTrack;
  step: number; // steps since its spawn
  c: FloorPt;
  d: number; // U across (≤ CHUNKS.maxD)
  angle: number;
  points: FloorPt[]; // its outline, U
  overFire: boolean;
}

// The age of chunk drawing k′: that of global drawing k′ (from j 9).
export function chunkAge(ictx: MassContext, kp: number): number {
  const dps = ictx.dps ?? MASS_DPS;
  return kr(Math.max(drawingStart(kp, dps), ictx.I + 9) - ictx.I) - 14;
}

// The chunk drawing frame f shows.
export const chunkDrawing = (ictx: MassContext, f: number): number => drawingIndex(f - 1, ictx.dps ?? MASS_DPS);

function chunkShape(r: Rng): [number, number][] {
  const m = int(r, 5, 8);
  const base = r() * 2 * Math.PI;
  const verts: [number, number][] = [];
  for (let i = 0; i < m; i++) verts.push([base + (2 * Math.PI * (i + uniform(r, -0.22, 0.22))) / m, uniform(r, 0.8, 1.12)]);
  const notches = int(r, 1, 2);
  const at = int(r, 0, m - 1);
  const edges = notches === 1 ? [at] : [at, (at + Math.floor(m / 2)) % m];
  // Insert from the last edge back, so the indices hold.
  for (const e of [...edges].sort((a, b) => b - a)) {
    const a = verts[e];
    const b = verts[(e + 1) % m];
    let mid = (a[0] + (e + 1 === m ? b[0] + 2 * Math.PI : b[0])) / 2;
    if (mid > base + 2 * Math.PI) mid -= 2 * Math.PI;
    verts.splice(e + 1, 0, [mid, uniform(r, 0.5, 0.72)]);
  }
  // Scale to a unit area-equivalent diameter: area π/4.
  const pts = verts.map(([th, rr]): [number, number] => [rr * Math.cos(th), rr * Math.sin(th)]);
  const s = Math.sqrt(Math.PI / 4 / Math.abs(polygonArea(pts)));
  return verts.map(([th, rr]) => [th, rr * s]);
}

function outlineOf(shape: readonly [number, number][], c: FloorPt, d: number, angle: number, inset = 0): FloorPt[] {
  const k = Math.max(0, 1 - inset / (d / 2));
  return shape.map(([th, rr]): FloorPt => [c[0] + (d / 2) * k * rr * Math.cos(th + angle), c[1] + (d / 2) * k * rr * Math.sin(th + angle)]);
}

// Where a track is `step` steps after its spawn.
function trackAt(tr: ChunkTrack, step: number): { c: FloorPt; d: number; angle: number } {
  let n = tr.c0[0];
  let t = tr.c0[1];
  for (let i = 1; i <= step; i++) {
    let vn = tr.v0[0] - tr.gravity * (i - 1);
    let vt = tr.v0[1];
    const len = Math.hypot(vn, vt);
    if (len > CHUNKS.step[1]) {
      vn *= CHUNKS.step[1] / len;
      vt *= CHUNKS.step[1] / len;
    }
    n += vn;
    t += vt;
  }
  return { c: [n, t], d: Math.min(CHUNKS.maxD, tr.d0 * tr.grow ** step), angle: tr.spin * step };
}

function onFrame(fr: MassFrame, width: number, height: number, pts: readonly FloorPt[]): boolean {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    const [x, y] = toFrame(fr, fr.U, p);
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return x1 > 0 && x0 < width && y1 > 0 && y0 < height;
}

// The fire part's reach from P at age A: a half disc of the hot share of the cluster.
const fireReach = (A: number, g: number) => Math.sqrt((2 * Math.max(0, hotShare(Math.max(3, A))) * CLUSTER_AREA[Math.min(Math.max(g, 2), LAST_MEASURED)]) / Math.PI);

function floorTrack(r: Rng, id: number, kind: 'floor' | 'late', kp: number, age: number, c0: FloorPt): ChunkTrack {
  const side = c0[1] >= 0 ? 1 : -1;
  const theta = uniform(r, CHUNKS.launch[0], CHUNKS.launch[1]) * DEG;
  const speed = uniform(r, 0.08, 0.2);
  return {
    id,
    kind,
    spawn: kp,
    age,
    c0,
    v0: [speed * Math.sin(theta), side * speed * Math.cos(theta)],
    gravity: uniform(r, 0.025, 0.045),
    d0: uniform(r, CHUNKS.d0[0], CHUNKS.d0[1]),
    grow: uniform(r, CHUNKS.grow[0], CHUNKS.grow[1]),
    spin: uniform(r, -25, 25) * DEG,
    life: Infinity,
    shape: chunkShape(r),
    line: null,
  };
}

function airTrack(r: Rng, id: number, kp: number, age: number): ChunkTrack {
  const c0: FloorPt = [uniform(r, CHUNKS.airN[0], CHUNKS.airN[1]), uniform(r, -0.6, 0.6)];
  const out = Math.atan2(c0[1], c0[0]) + uniform(r, -30, 30) * DEG;
  const speed = uniform(r, 0.04, 0.1);
  return {
    id,
    kind: 'air',
    spawn: kp,
    age,
    c0,
    v0: [speed * Math.cos(out), speed * Math.sin(out)],
    gravity: uniform(r, 0, 0.012),
    d0: uniform(r, 0.048, 0.08),
    grow: uniform(r, 1.05, 1.3),
    spin: uniform(r, -20, 20) * DEG,
    life: int(r, CHUNKS.airLife[0], CHUNKS.airLife[1]) - 1,
    shape: chunkShape(r),
    line: null,
  };
}

// The crack ends at the floor chunks' radius: where they prefer to spawn.
function crackEnds(ictx: ImpactContext, fr: MassFrame): FloorPt[] {
  const out: FloorPt[] = [];
  for (const crack of ictx.cracks) {
    if (crack.points.length === 0) continue;
    const ends = crack.fromP === 'start' ? [crack.points[crack.points.length - 1]] : crack.fromP === 'end' ? [crack.points[0]] : [crack.points[0], crack.points[crack.points.length - 1]];
    for (const e of ends) {
      const p = toFloor(fr, fr.U, e);
      const rho = Math.hypot(p[0], p[1]);
      if (rho >= CHUNKS.floorR[0] && rho <= CHUNKS.floorR[1] && p[0] >= -0.17 && p[0] <= 0.08) out.push(p);
    }
  }
  return out;
}

const trackCache = new Map<string, ChunkTrack[]>();

// Every chunk track of the scene, in spawn order: pure in the scene, I, the
// drawing rate and J_end.
export function chunkTracks(ictx: MassContext): ChunkTrack[] {
  const dps = ictx.dps ?? MASS_DPS;
  const fr = massFrame(ictx);
  const ends = crackEnds(ictx, fr);
  const key = `${massKey(ictx)}:${ictx.I}:${dps}:${ictx.jEnd}:${ends.map((p) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`).join(';')}`;
  return memo(trackCache, key, () => {
    const first = drawingIndex(ictx.I + 8, dps); // the chunk drawing on j 9
    const last = drawingIndex(ictx.I + ictx.jEnd - 1, dps);
    const lastSpawn = drawingIndex(ictx.I + ictx.jEnd - 14 - 1, dps); // none in the decay
    const ages: { kp: number; age: number }[] = [];
    for (let kp = first; kp <= last; kp++) ages.push({ kp, age: chunkAge(ictx, kp) });
    const tracks: ChunkTrack[] = [];
    let id = 0;
    // The floor chunks: four over the drawings of A8–11.
    const floorAt = ages.filter((a) => a.age >= CHUNKS.floorAge[0] && a.age <= CHUNKS.floorAge[1] && a.kp <= lastSpawn);
    const firstFloor = floorAt.length ? floorAt : ages.filter((a) => a.age >= CHUNKS.floorAge[0] && a.kp <= lastSpawn).slice(0, 1);
    const free = [...ends];
    firstFloor.forEach((a, i) => {
      const count = Math.floor(CHUNKS.floor / firstFloor.length) + (i < CHUNKS.floor % firstFloor.length ? 1 : 0);
      const r = rng(ictx.seed, 'chunk', a.kp);
      for (let q = 0; q < count; q++) {
        let c0: FloorPt;
        if (free.length) {
          c0 = free.splice(int(r, 0, free.length - 1), 1)[0];
        } else {
          const side = r() < 0.65 ? 1 : -1;
          const rho = uniform(r, CHUNKS.floorR[0], CHUNKS.floorR[1]);
          const n = uniform(r, -0.02, 0.06);
          c0 = [n, side * Math.sqrt(Math.max(0, rho * rho - n * n))];
        }
        tracks.push(floorTrack(r, id++, 'floor', a.kp, a.age, c0));
      }
    });
    // The late one, farther out on the −t side.
    const late = ages.find((a) => a.age >= CHUNKS.lateAge);
    if (late && late.kp <= lastSpawn) {
      const r = rng(ictx.seed, 'chunk', late.kp, 1);
      const n = uniform(r, -0.02, 0.06);
      tracks.push(floorTrack(r, id++, 'late', late.kp, late.age, [n, -Math.sqrt(CHUNKS.lateR ** 2 - n * n)]));
    }
    // The air chunks: topped up to 1–4 on every drawing from A8.
    for (const a of ages) {
      if (a.age < CHUNKS.floorAge[0] || a.kp > lastSpawn) continue;
      const r = rng(ictx.seed, 'chunk', a.kp, 2);
      const want = int(r, CHUNKS.air[0], CHUNKS.air[1]);
      const up = tracks.filter((tr) => tr.kind === 'air' && tr.spawn < a.kp && chunkAt(ictx, fr, tr, a.kp)).length;
      for (let q = up; q < want; q++) tracks.push(airTrack(r, id++, a.kp, a.age));
    }
    for (const tr of tracks) tr.line = int(rng(ictx.seed, 'chunk', tr.spawn, 3, tr.id), 0, 1) ? FIRE_LINE[1] : FIRE_LINE[0];
    return tracks;
  });
}

// A track on chunk drawing k′, or null before its spawn, after its life, and
// from the first step it was wholly off the frame.
function chunkAt(ictx: MassContext, fr: MassFrame, tr: ChunkTrack, kp: number): ChunkAt | null {
  const step = kp - tr.spawn;
  if (step < 0 || step > tr.life) return null;
  let at = trackAt(tr, 0);
  for (let s = 0; s <= step; s++) {
    at = trackAt(tr, s);
    if (!onFrame(fr, ictx.width, ictx.height, outlineOf(tr.shape, at.c, at.d, at.angle))) return null;
  }
  const age = chunkAge(ictx, kp);
  let g = 2;
  while (g < LAST_MEASURED && GROUP_AGE[g + 1] <= age) g++;
  const overFire = at.c[0] > -0.02 && Math.hypot(at.c[0], at.c[1]) < fireReach(age, g);
  return { track: tr, step, c: at.c, d: at.d, angle: at.angle, points: outlineOf(tr.shape, at.c, at.d, at.angle), overFire };
}

// The chunks up on chunk drawing k′.
export function chunksOn(ictx: MassContext, kp: number): ChunkAt[] {
  const fr = massFrame(ictx);
  const out: ChunkAt[] = [];
  for (const tr of chunkTracks(ictx)) {
    const at = chunkAt(ictx, fr, tr, kp);
    if (at) out.push(at);
  }
  return out;
}

// ---- The drawing ----------------------------------------------------------------------------

export interface DebrisDrawing extends MassDrawing {
  g: number;
  kp: number; // the chunk drawing
  zoom: number; // the specks' and shards' size factor
  bits: Bit[]; // the group's specks and shards, in the floor frame at the zoom factor 1
  chunks: ChunkAt[];
}

// The debris on frame f, or null before j 9 and after J_end.
export function shapes(ictx: MassContext, f: number): DebrisDrawing | null {
  const clock = massClock(ictx, f);
  if (!clock) return null;
  const fr = massFrame(ictx);
  const unit = fr.U * clock.zoom;
  const ink = roles(ictx.palette).ink;
  const kp = chunkDrawing(ictx, f);
  const group = bits(ictx.seed, clock.g);
  const chunks = chunksOn(ictx, kp);
  const out: MassShape[] = [];
  for (const b of group) {
    out.push({ role: b.role, points: b.points.map((p) => toFrame(fr, unit, p)), color: b.role === 'shard' ? ink : SPECK_BLACK, round: b.role === 'speck' });
  }
  const px = (pts: FloorPt[]) => pts.map((p) => toFrame(fr, fr.U, p));
  for (const ch of chunks) {
    const ring = (inset: number) => px(outlineOf(ch.track.shape, ch.c, ch.d, ch.angle, inset));
    out.push({ role: 'chunk', points: px(ch.points), color: SEAM });
    if (ch.overFire) {
      out.push({ role: 'chunk-line', points: ring(EDGE), color: ch.track.line ?? FIRE_LINE[1] });
      out.push({ role: 'chunk-body', points: ring(3 * EDGE), color: BODY });
    } else {
      out.push({ role: 'chunk-rim', points: ring(EDGE), color: RIM });
      out.push({ role: 'chunk-dark', points: ring(2 * EDGE), color: DARK });
      out.push({ role: 'chunk-body', points: ring(2.5 * EDGE), color: BODY });
    }
  }
  return {
    layer: 'front',
    key: `debris:${massKey(ictx)}:${ictx.I}:${ictx.dps ?? MASS_DPS}:${ictx.jEnd}:${clock.g}:${unit.toFixed(3)}:${kp}`,
    alpha: decayAlpha(clock.j, ictx.jEnd),
    shapes: out,
    g: clock.g,
    kp,
    zoom: clock.zoom,
    bits: group,
    chunks,
  };
}

export function draw(_ctxBehind: BrushTarget, ctxFront: BrushTarget, _sink: GlowSink, ictx: MassContext, f: number, opaque = false) {
  paint(ctxFront, shapes(ictx, f), opaque);
}
