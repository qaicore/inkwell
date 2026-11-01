// Sparks and embers (impact design §6 "Energy" and "Decay and the time map";
// destruction §4.2, §6.3, §8): amber ovals on the 2s hold groups, seeded
// rng(seed, 'spark', g) and rng(seed, 'ember', g). A group's particles hold
// for all of its frames. At each group change about half of them carry over,
// each moved by at most 0.035 U in a random direction (jitter, no outward
// drift), and the rest are drawn afresh.
//   - Sparks. g0 (A0), the burst: 25 at r 0.06–0.5 U from P (p50 0.34), low
//     and wide (n p50 about 0.15 U), their long axes radial. g1 (A1–2), the
//     ring: 52–54 at r 0.46–0.8 U (p50 0.63), 45° to the −t side of n̂ and 70°
//     to the +t side, their axes mostly not radial. From g2 (A3) the halo:
//     the same ring, 18·0.92^(A−3) of them. Long axis 0.013 U (A0), 0.019 U
//     (A1–2), then 0.015 U (A3–5) falling to 0.008 U by A12; elongation
//     1.5–2.5; #fdcd02 with a paler core and, on the full tier, a thin dark
//     ring (the fire's bubble ink). A spark born wholly off the frame is
//     mirrored across P along u (G5), once, where it's born.
//   - Embers. From g2 (A3): 35–59 dots on the smoke (13–21 under the A5–6
//     flash), inside the cluster's envelope (destruction §6.4), 0.016 U long
//     at A3 to 0.009 U by A10, coloured #ffdf3e → #ffdb5b → #ffb259 by age.
//   - The hold span (g9 on) keeps g8's counts and carries over the same way;
//     the decay fades the held shapes by decayAlpha per output frame, so
//     they're gone at J_end.
//   - Tiers: at most 30 of each on the phone, with no rings; `half` (the
//     cut order's step 4) halves the counts.
// Positions are kept in the energy frame (n up the floor, t toward the
// strike's side, in U) and scaled by the group's zoom like the masses. A
// carried particle keeps its id, so it can be followed across groups. One
// layer draws both, embers under sparks, in the front FX (slot 10).
import type { Vec2 } from '../../types/effect.ts';
import type { ImpactContext, LayerDraw } from '../contracts.ts';
import type { BrushTarget, MakeScratch } from '../../render/glow.ts';
import { massGroup, zoomAt } from '../clock.ts';
import { mirrorIntoFrame } from '../floor.ts';
import { FIRE, mixHex } from '../palette.ts';
import { int, rng, uniform, type Rng } from '../rng.ts';
import { ENERGY_DPS, GROUP_AGE, LAST_GROUP, ZOOM_PEAK, boxOf, clamp, energyFrame, faded, fillUnion, groupClock, memo, onFloor, sceneKey, type EnergyContext, type EnergyFrame } from './washes.ts';

const DEG = Math.PI / 180;
const TAU = 2 * Math.PI;

// ---- The measured rules ----------------------------------------------------------------------

export type ParticleKind = 'spark' | 'ember';

export const SPARKS = { burst: 25, ring: [52, 54], halo: 18, fall: 0.92 } as const;
// Embers per hold group, g0..g8 (none before A3; 13–21 under the A5–6 flash); later groups keep g8's.
export const EMBERS: readonly (readonly [number, number])[] = [[0, 0], [0, 0], [39, 49], [13, 21], [35, 43], [44, 59], [49, 54], [40, 54], [35, 45]];
export const CARRY = [0.45, 0.55] as const; // the share of a group change's smaller side that carries over
export const JITTER = 0.035; // U: the most a carried particle moves (under 0.05 U on screen with the zoom's drift)
export const PHONE_PARTICLES = 30; // of each kind
export const SPARK_TONES = { body: FIRE.amber, core: '#ffd350', ring: mixHex(FIRE.line[0], FIRE.line[1], 0.5) } as const; // core: between #ffcc57 and #ffda4a
const EMBER_RAMP: readonly [number, string][] = [[3, FIRE.embers[0]], [7, '#ffdb5b'], [12, FIRE.embers[1]]];
const EMBER_SHADES = [0, 0.15, 0.3]; // each ember's mix toward the ramp's end
const SPARK_LENGTH: readonly [number, number][] = [[0, 0.013], [1, 0.019], [2, 0.019], [3, 0.015], [5, 0.015], [7, 0.012], [10, 0.009], [12, 0.008]];
const EMBER_LENGTH: readonly [number, number][] = [[3, 0.016], [10, 0.009]];

// A piecewise-linear table, held flat past its ends.
function table(points: readonly (readonly [number, number])[], x: number): number {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    if (x <= x1) {
      const [x0, y0] = points[i - 1];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return points[points.length - 1][1];
}

// How many sparks a group of reference age A draws, as [lo, hi].
export function sparkCount(A: number): readonly [number, number] {
  if (A <= 0) return [SPARKS.burst, SPARKS.burst];
  if (A <= 2) return SPARKS.ring;
  const n = Math.round(SPARKS.halo * SPARKS.fall ** (A - 3));
  return [n, n];
}

// How many embers hold group g draws, as [lo, hi].
export const emberCount = (g: number): readonly [number, number] => EMBERS[Math.min(g, LAST_GROUP)];

export const sparkLength = (A: number): number => table(SPARK_LENGTH, A); // U
export const emberLength = (A: number): number => table(EMBER_LENGTH, A); // U

// The embers' colour at reference age A.
export function emberColor(A: number): string {
  if (A <= EMBER_RAMP[0][0]) return EMBER_RAMP[0][1];
  for (let i = 1; i < EMBER_RAMP.length; i++) {
    const [a1, c1] = EMBER_RAMP[i];
    if (A <= a1) {
      const [a0, c0] = EMBER_RAMP[i - 1];
      return mixHex(c0, c1, (A - a0) / (a1 - a0));
    }
  }
  return EMBER_RAMP[EMBER_RAMP.length - 1][1];
}

// ---- Groups ------------------------------------------------------------------------------------

export interface Particle {
  id: number; // kept when it carries over
  n: number; // U up the floor from P, before the group's zoom
  t: number; // U across it, toward the strike's side
  axis: number; // the long axis, radians from n̂ toward t̂
  size: number; // × the group's length
  elong: number; // long axis / short axis
  shade: number; // an ember's shade, an index into EMBER_SHADES; 0 for sparks
  born: number; // the group it was drawn in
}

export interface ParticleGroup {
  kind: ParticleKind;
  g: number;
  A: number; // the reference age it stands for
  start: number; // its first output frame
  zoom: number; // 1.08 / zoomAt(start − I): positions and sizes × this
  length: number; // U: the long axis at size 1
  particles: Particle[]; // the carried ones first, in their old order
  carried: number; // how many came from the group before
  from: number; // how many that group had (0 for the first)
}

export interface ParticleOptions {
  half?: boolean; // the cut order's step 4: half as many
}

interface Slot {
  g: number;
  start: number;
}

// The hold groups that occur from j 9 up to group g, with their first frames.
function slotsTo(ictx: EnergyContext, g: number): Slot[] {
  const dps = ictx.dps ?? ENERGY_DPS;
  const out: Slot[] = [];
  for (let f = ictx.I + 9; f - ictx.I <= 900; f++) {
    const h = massGroup(f, ictx.I, dps) as number;
    if (h > g) break;
    if (out.length === 0 || out[out.length - 1].g !== h) out.push({ g: h, start: f });
  }
  return out;
}

const groups = new Map<string, ParticleGroup | null>();

// Hold group g's sparks or embers, built from the first group on (each one
// carries over from the one before), or null where there are none.
export function particleGroup(ictx: EnergyContext, kind: ParticleKind, g: number, opts: ParticleOptions = {}): ParticleGroup | null {
  const base = `${kind}:${sceneKey(ictx)}:${ictx.I}:${ictx.dps ?? ENERGY_DPS}:${opts.half ? 'half' : 'all'}`;
  const hit = groups.get(`${base}:${g}`);
  if (hit !== undefined) return hit;
  const slots = slotsTo(ictx, g);
  if (slots.length === 0 || slots[slots.length - 1].g !== g) return null;
  const fr = energyFrame(ictx);
  let prev: ParticleGroup | null = null;
  for (const slot of slots) {
    const before: ParticleGroup | null = prev;
    prev = memo(groups, `${base}:${slot.g}`, () => buildGroup(ictx, fr, kind, slot, before, opts), 160);
  }
  return prev;
}

function buildGroup(ictx: EnergyContext, fr: EnergyFrame, kind: ParticleKind, slot: Slot, prev: ParticleGroup | null, opts: ParticleOptions): ParticleGroup | null {
  const A = GROUP_AGE[Math.min(slot.g, LAST_GROUP)];
  if (kind === 'ember' && A < 3) return null;
  const r = rng(ictx.seed, kind, slot.g);
  const [lo, hi] = kind === 'spark' ? sparkCount(A) : emberCount(slot.g);
  let count = int(r, lo, hi);
  if (ictx.tier === 'phone') count = Math.min(count, PHONE_PARTICLES);
  if (opts.half) count = Math.round(count / 2);
  const zoom = ZOOM_PEAK / zoomAt(slot.start - ictx.I);
  const length = kind === 'spark' ? sparkLength(A) : emberLength(A);
  const old = prev?.particles ?? [];

  // About half of the smaller side carries over: a seeded pick, moved by up to JITTER.
  const keep = Math.min(count, old.length, Math.round(uniform(r, CARRY[0], CARRY[1]) * Math.min(old.length, count)));
  const order = old.map((_, i) => i);
  for (let i = 0; i < keep; i++) {
    const k = i + Math.floor(r() * (order.length - i));
    [order[i], order[k]] = [order[k], order[i]];
  }
  const out: Particle[] = order
    .slice(0, keep)
    .sort((a, b) => a - b)
    .map((i) => {
      const p = old[i];
      const d = JITTER * Math.sqrt(r());
      const phi = uniform(r, 0, TAU);
      return { ...p, n: p.n + d * Math.cos(phi), t: p.t + d * Math.sin(phi) };
    });
  for (let i = 0; out.length < count; i++) {
    const p = kind === 'spark' ? freshSpark(r, A) : freshEmber(r, A);
    const id = slot.g * 1000 + i;
    out.push(kind === 'spark' ? mirrored(ictx, fr, { ...p, id, born: slot.g }, zoom, length) : { ...p, id, born: slot.g });
  }
  return { kind, g: slot.g, A, start: slot.start, zoom, length, particles: out, carried: keep, from: old.length };
}

type Fresh = Omit<Particle, 'id' | 'born'>;

// A new spark: the burst's on A0, the ring's after.
function freshSpark(r: Rng, A: number): Fresh {
  if (A <= 0) {
    const rad = 0.06 + 0.44 * r() ** 0.65;
    const th = (r() < 0.5 ? -1 : 1) * uniform(r, 30, 90) * DEG;
    const axis = r() < 0.8 ? th + uniform(r, -25, 25) * DEG : uniform(r, 0, Math.PI);
    return { n: rad * Math.cos(th), t: rad * Math.sin(th), axis, size: uniform(r, 0.75, 1.25), elong: uniform(r, 1.5, 2.5), shade: 0 };
  }
  const rad = 0.46 + (0.34 * (r() + r())) / 2;
  const th = uniform(r, -45, 70) * DEG;
  const axis = r() < 0.25 ? th + uniform(r, -30, 30) * DEG : uniform(r, 0, Math.PI);
  return { n: rad * Math.cos(th), t: rad * Math.sin(th), axis, size: uniform(r, 0.75, 1.25), elong: uniform(r, 1.5, 2.5), shade: 0 };
}

// The cluster's envelope at reference age A (destruction §6.4): a dome on the
// floor line, n 0.10–0.71 U and |t| ≤ 0.41 U at A3–4; from A7 its top at
// 0.74–0.77 U and t from −0.50 to +0.47 U; its base down to 0.04–0.06 U by A10.
export function emberEnvelope(A: number): { base: number; top: number; t0: number; t1: number } {
  const k = clamp((A - 3) / 4, 0, 1);
  const kb = clamp((A - 3) / 7, 0, 1);
  return { base: 0.1 - 0.05 * kb, top: 0.71 + 0.045 * k, t0: -0.41 - 0.09 * k, t1: 0.41 + 0.06 * k };
}

// Whether (n, t) is inside the envelope's dome.
export function inEnvelope(e: ReturnType<typeof emberEnvelope>, n: number, t: number): boolean {
  const tc = (e.t0 + e.t1) / 2;
  const hw = (e.t1 - e.t0) / 2;
  const x = (t - tc) / hw;
  return x > -1 && x < 1 && n >= e.base && n <= e.base + (e.top - e.base) * Math.sqrt(1 - x * x);
}

// A new ember, anywhere on the dome, evenly by area.
function freshEmber(r: Rng, A: number): Fresh {
  const e = emberEnvelope(A);
  let n = (e.base + e.top) / 2;
  let t = (e.t0 + e.t1) / 2;
  for (let tries = 0; tries < 32; tries++) {
    const tn = uniform(r, e.t0, e.t1);
    const nn = uniform(r, e.base, e.top);
    if (inEnvelope(e, nn, tn)) {
      n = nn;
      t = tn;
      break;
    }
  }
  return { n, t, axis: uniform(r, 0, Math.PI), size: uniform(r, 0.8, 1.2), elong: uniform(r, 1, 1.6), shade: int(r, 0, EMBER_SHADES.length - 1) };
}

// A spark wholly off the frame where it's born, mirrored across P along u.
function mirrored(ictx: ImpactContext, fr: EnergyFrame, p: Particle, zoom: number, length: number): Particle {
  const u = ictx.frame.u;
  const pts = ovalOf(fr, p, fr.U * zoom, length, 8);
  if (!mirrorIntoFrame(pts, fr.P, u, ictx.width, ictx.height).mirrored) return p;
  // u in the floor frame: (u·n̂, u·t̂); reflect the centre and the axis there.
  const un = u[0] * fr.n[0] + u[1] * fr.n[1];
  const ut = u[0] * fr.t[0] + u[1] * fr.t[1];
  const d = p.n * un + p.t * ut;
  const an = Math.cos(p.axis);
  const at = Math.sin(p.axis);
  const da = an * un + at * ut;
  return { ...p, n: p.n - 2 * d * un, t: p.t - 2 * d * ut, axis: Math.atan2(at - 2 * da * ut, an - 2 * da * un) };
}

// ---- One frame ---------------------------------------------------------------------------------

export interface ParticleFrame {
  j: number;
  g: number;
  alpha: number; // decayAlpha(j, J_end): the layer's opacity
  unit: number; // px per U on this group: U × its zoom
  sparks: ParticleGroup | null;
  embers: ParticleGroup | null;
  key: string;
}

// The sparks and embers on frame f, or null when there are none: before j 9,
// and from J_end on.
export function particles(ictx: EnergyContext, f: number, opts: ParticleOptions = {}): ParticleFrame | null {
  const clock = groupClock(ictx, f);
  if (!clock || !(clock.alpha > 0)) return null;
  const sparks = particleGroup(ictx, 'spark', clock.g, opts);
  const embers = particleGroup(ictx, 'ember', clock.g, opts);
  if (!sparks && !embers) return null;
  const fr = energyFrame(ictx);
  return {
    j: clock.j,
    g: clock.g,
    alpha: clock.alpha,
    unit: fr.U * clock.zoom,
    sparks,
    embers,
    key: ['particles', sceneKey(ictx), ictx.I, ictx.dps ?? ENERGY_DPS, clock.g, opts.half ? 'half' : 'all', clock.alpha.toFixed(4)].join(':'),
  };
}

// A particle's centre on the frame, px.
export const particleAt = (fr: EnergyFrame, p: Particle, unit: number): Vec2 => onFloor(fr, unit, p.n, p.t);

// A particle's oval, px: `count` points round it, `grow` px bigger all round.
function ovalOf(fr: EnergyFrame, p: Particle, unit: number, length: number, count: number, grow = 0, scale = 1): Vec2[] {
  const c = particleAt(fr, p, unit);
  const dir: Vec2 = [Math.cos(p.axis) * fr.n[0] + Math.sin(p.axis) * fr.t[0], Math.cos(p.axis) * fr.n[1] + Math.sin(p.axis) * fr.t[1]];
  const a = (0.5 * length * p.size * unit * scale) + grow;
  const b = Math.max(0.5 * scale, (0.5 * length * p.size * unit * scale) / p.elong) + grow;
  const out: Vec2[] = [];
  for (let i = 0; i < count; i++) {
    const th = (TAU * i) / count;
    const x = a * Math.cos(th);
    const y = b * Math.sin(th);
    out.push([c[0] + x * dir[0] - y * dir[1], c[1] + x * dir[1] + y * dir[0]]);
  }
  return out;
}

export interface ParticleShapes {
  embers: { color: string; polys: Vec2[][] }[];
  rings: Vec2[][]; // the sparks' dark rings: the full tier only
  sparks: Vec2[][];
  cores: Vec2[][];
}

const shapeCache = new WeakMap<ParticleFrame, ParticleShapes>();

export function particleShapes(ictx: ImpactContext, pf: ParticleFrame): ParticleShapes {
  const hit = shapeCache.get(pf);
  if (hit) return hit;
  const fr = energyFrame(ictx);
  const phone = ictx.tier === 'phone';
  const count = phone ? 8 : 12;
  const ring = Math.max(0.75, 0.0016 * fr.S);
  const out: ParticleShapes = { embers: [], rings: [], sparks: [], cores: [] };
  if (pf.embers) {
    const base = emberColor(pf.embers.A);
    const by = EMBER_SHADES.map((s) => ({ color: mixHex(base, FIRE.embers[1], s), polys: [] as Vec2[][] }));
    for (const p of pf.embers.particles) by[p.shade].polys.push(ovalOf(fr, p, pf.unit, pf.embers.length, count));
    out.embers = by.filter((b) => b.polys.length > 0);
  }
  if (pf.sparks) {
    for (const p of pf.sparks.particles) {
      if (!phone) out.rings.push(ovalOf(fr, p, pf.unit, pf.sparks.length, count, ring));
      out.sparks.push(ovalOf(fr, p, pf.unit, pf.sparks.length, count));
      if ((0.5 * pf.sparks.length * p.size * pf.unit) / p.elong >= 1) out.cores.push(ovalOf(fr, p, pf.unit, pf.sparks.length, count, 0, 0.5));
    }
  }
  shapeCache.set(pf, out);
  return out;
}

// Paints a frame's particles at its decay alpha, as one layer: embers, then
// the sparks' rings, bodies and cores.
export function paintParticles(ctx: BrushTarget, make: MakeScratch, ictx: ImpactContext, pf: ParticleFrame | null) {
  if (!pf) return;
  const sh = particleShapes(ictx, pf);
  const all = [...sh.embers.flatMap((e) => e.polys), ...sh.rings, ...sh.sparks];
  faded(ctx, make, pf.alpha, boxOf(all, 2, ictx.width, ictx.height), (c) => {
    for (const e of sh.embers) fillUnion(c, e.polys, e.color);
    fillUnion(c, sh.rings, SPARK_TONES.ring);
    fillUnion(c, sh.sparks, SPARK_TONES.body);
    fillUnion(c, sh.cores, SPARK_TONES.core);
  });
}

export function particleLayer(ictx: EnergyContext, f: number, make: MakeScratch, opts: ParticleOptions = {}): LayerDraw | null {
  const pf = particles(ictx, f, opts);
  return pf ? { key: pf.key, draw: (ctx) => paintParticles(ctx, make, ictx, pf) } : null;
}
