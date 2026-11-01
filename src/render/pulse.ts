// Cord pulses and pops (impact design §3, lightning §5.4): every so often a
// bright pulse runs down a limb and sparks off its tip.
//   - Schedule. A limb's next pulse starts U{6..10} of its drawings after the
//     last (limb.pulseEvery), U{3..4} in the coil and strike window
//     (j −14..8), never on consecutive drawings: 3 apart at the least, which
//     keeps the tip pops apart too. The first one has a seeded phase, so the
//     limbs take turns.
//   - Travel. The centre starts at 0.1 L and steps U[0.25, 0.35] L a drawing:
//     3 or 4 drawings on the limb, and on the next it has passed the tip. k is
//     the limb's electricity clock (limbClock), which in the strike window
//     steps on every kr step, so there the pulse does too.
//   - Look. Each drawing the bulge is U[0.15, 0.25] L long, with the radius
//     ×U[1.2, 1.4] and the core band 45–65 % of the width inside it: a
//     PulseSpan, which WP3's tube draws. Its glow is ×2.
//   - Pops. When the centre passes the tip, a pop with p 0.7; besides those,
//     with p 0.06 a drawing, a random pop at a seeded spot on the skin. 6–10
//     spikes of 0.3–1.4 r (median 0.6 r) on a 0.15–0.3 r base, fanned over
//     270° with the open 90° toward the root, round a core 0.8–1.2 r across,
//     for one drawing. Never two drawings running.
// pulsesAt is pure: it replays the seeded schedule from the limb's first idle
// drawing up to k, so a drawing comes out the same alone, in order or out of
// order. Every draw is rng(id, 'pulse' | 'pop', ...): no Math.random, no clock.
import type { GlowSink, PulseSpan, Tube, Vec2 } from '../impact/contracts.ts';
import { kr } from '../impact/clock.ts';
import { int, rng, uniform, type Rng } from '../impact/rng.ts';
import { drawingIndex } from '../motion/timing.ts';
import { ARC_TONES, sectionAt, type ArcTarget, type ArcTones } from './arcs3d.ts';
import { EMERGE } from './electric.ts';

export const PULSE_EVERY: readonly [number, number] = [6, 10]; // limb drawings between pulses (limb.pulseEvery)
export const CHARGE_EVERY: readonly [number, number] = [3, 4]; // ... in the coil and strike window
const MIN_GAP = 3; // never closer: a pulse crosses in 3–4 drawings, so the tip pops stay apart too
const STRIKE = [-8, 8] as const; // j: the strike window, where the limb's clock steps on kr
const CHARGE = [-14, 8] as const; // j: the coil and the strike window, where pulses come every 3–4
const START = 0.1; // of L: where a pulse's centre starts
const STEP = [0.25, 0.35] as const; // of L, a drawing
const LENGTH = [0.15, 0.25] as const; // of L
const SCALE = [1.2, 1.4] as const; // the radius inside the bulge, ×
const CORE = [0.45, 0.65] as const; // the core band's share of the width inside it
export const TIP_POP = 0.7; // p of a pop when a pulse passes the tip
export const RANDOM_POP = 0.06; // p of a random pop on a drawing
const RANDOM_AT = [0.1, 0.9] as const; // where along the limb a random pop may sit ...
const TAPER = 0.55; // ... weighted by r, which falls as (1 − s)^0.55 (limb.taper)
const SPIKES = [6, 10] as const;
const SPIKE_LEN = [0.3, 1.4] as const; // × r past the core: 0.3 + 1.1·u², so the median is 0.58 r
const SPIKE_BASE = [0.15, 0.3] as const; // × r: the base's width
const POP_CORE = [0.8, 1.2] as const; // the core's diameter, × r
const FAN = 0.75 * Math.PI; // spikes fan ±135° about the pop's axis, so the open 90° faces the root
const SPIKE_FROM = 0.6; // a spike's base sits this far out in the core, × its radius
const RIM = 1.25; // the body-tone disc round the core, × the core's radius
const EDGE = 0.06; // × r: the edge line round the spikes and the rim (1.3 px on the hero)
const POP_R_AT = 0.2; // the pops' r is the tube's radius here, near the root: the tip tapers to 0.8 px
export const PULSE_GLOW = 2; // design §3
export const POP_GLOW = 1.7; // lightning §5.4 ...
const POP_GLOW_R = 1.25; // ... at a tight radius of 1–1.5 r
const PULSE_POINTS = 8; // points along a pulse's glow strokes

// ---- Clocks -------------------------------------------------------------------------------

// A limb's electricity clock on output frame f: the global drawing k(f) on the
// 2s grid, except that through the strike window (j −8..8) it steps on every
// kr step, so the pulses run into P at the reference's pace, and from j 9 it
// carries on from there on the grid. It never repeats or goes back. Pass it as
// k to sheathArcs and pulsesAt. On the hero (I 84, 12 dps): f75 30, f76 31,
// f77 32, f79 and f80 34, f83 37, f84 and f85 38, f92 44, f93 45, f95 46.
export function limbClock(f: number, I: number | null, dps = 12): number {
  const k = drawingIndex(f, dps);
  if (I === null || f - I < STRIKE[0]) return k;
  const before = drawingIndex(I + STRIKE[0] - 1, dps); // the last grid drawing before the window
  if (f - I <= STRIKE[1]) return before + 1 + kr(f - I) - kr(STRIKE[0]);
  const steps = kr(STRIKE[1]) - kr(STRIKE[0]) + 1; // 14
  return before + steps + 1 + k - drawingIndex(I + STRIKE[1] + 1, dps);
}

// ---- The schedule ---------------------------------------------------------------------------

// What pulsesAt needs to replay a limb's schedule, in the limb's drawings
// (limbClock). pulseTimeline builds it.
export interface PulseTimeline {
  from: number; // the limb's first idle drawing, after its emergence pop: nothing happens before it
  charge: readonly [number, number] | null; // the coil and strike window (j −14..8), both included; null without a slam
  every?: readonly [number, number]; // limb.pulseEvery: the idle interval ([6, 10])
}

// `emerge` is the limb drawing the limb was drawn on, where its emergence
// starts (null when it has none); I the contact frame (null without a slam).
// On the hero (emerge k 8, I 84): from 14, charge [28, 44].
export function pulseTimeline(emerge: number | null, I: number | null, dps = 12, every?: readonly [number, number]): PulseTimeline {
  const from = emerge === null ? 0 : emerge + EMERGE.grow + EMERGE.pop;
  const charge: [number, number] | null = I === null ? null : [limbClock(I + CHARGE[0], I, dps), limbClock(I + CHARGE[1], I, dps)];
  return every ? { from, charge, every } : { from, charge };
}

function interval(every: readonly [number, number] | undefined): [number, number] {
  const [a, b] = every ?? PULSE_EVERY;
  const lo = Math.max(MIN_GAP, Math.round(a));
  return [lo, Math.max(lo, Math.round(b))];
}

// The drawings the limb's pulses start on, up to `until`. The schedule starts
// from a seeded virtual pulse 1..lo drawings before `from`, so the first real
// one comes 0..hi−1 drawings into the limb's idle time. After a pulse on
// drawing s, the next waits for its idle gap, U{6..10}, or, on a drawing in
// the charge window, for its charge gap, U{3..4}; both are drawn at s.
export function pulseStarts(id: number, tl: PulseTimeline, until: number): number[] {
  const [lo, hi] = interval(tl.every);
  const inCharge = (d: number) => tl.charge !== null && d >= tl.charge[0] && d <= tl.charge[1];
  const gapsAfter = (s: number) => {
    const g = rng(id, 'pulse', s, 0);
    const idle = int(g, lo, hi);
    return { idle, charge: Math.min(idle, Math.max(MIN_GAP, int(g, CHARGE_EVERY[0], CHARGE_EVERY[1]))) };
  };
  const out: number[] = [];
  let last = tl.from - int(rng(id, 'pulse', tl.from, 3), 1, lo);
  let gap = gapsAfter(last);
  for (let d = tl.from; d <= until; d++) {
    if (d - last < (inCharge(d) ? gap.charge : gap.idle)) continue;
    out.push(d);
    last = d;
    gap = gapsAfter(d);
  }
  return out;
}

// A pulse's centres, one a drawing from its start: 0.1 L, then U[0.25, 0.35] L
// further each drawing, ending with the first one past the tip, the drawing
// it may pop on.
export function pulseCentres(id: number, start: number): number[] {
  const r = rng(id, 'pulse', start, 1);
  const centres = [START];
  while (centres[centres.length - 1] <= 1) centres.push(centres[centres.length - 1] + uniform(r, STEP[0], STEP[1]));
  return centres;
}

// ---- Pulses and pops ------------------------------------------------------------------------

export interface Spike {
  angle: number; // radians off the pop's axis, within ±135°
  length: number; // × r, past the core
  base: number; // × r: the base's width
}

export interface Pop {
  kind: 'tip' | 'random';
  s: number; // along the limb, 0..1: 1 for a tip pop
  side: 1 | -1; // a random pop's side of the limb: along + or − the screen normal
  core: number; // the core's diameter, × r
  spikes: Spike[];
}

export interface Pulses {
  spans: PulseSpan[]; // the bulges on the limb on this drawing
  pops: Pop[]; // at most one
}

// Limb `id`'s pulses and pops on its drawing k (limbClock). Pure: it replays
// the schedule from tl.from on every call, a few hundred integer steps at most.
export function pulsesAt(id: number, k: number, tl: PulseTimeline): Pulses {
  if (!Number.isInteger(k) || !Number.isInteger(tl.from)) throw new Error(`pulsesAt takes whole drawings (got k=${k}, from=${tl.from})`);
  const out: Pulses = { spans: [], pops: [] };
  if (k < tl.from) return out;
  const tips = new Set<number>(); // the drawings with a tip pop, up to k + 1
  for (const start of pulseStarts(id, tl, k)) {
    const centres = pulseCentres(id, start);
    const age = k - start;
    if (age < centres.length - 1) {
      const look = rng(id, 'pulse', start, 2, age);
      out.spans.push({ s: centres[age], len: uniform(look, LENGTH[0], LENGTH[1]), scale: uniform(look, SCALE[0], SCALE[1]), core: uniform(look, CORE[0], CORE[1]) });
    }
    const pass = start + centres.length - 1;
    if (pass <= k + 1 && rng(id, 'pop', pass, 0)() < TIP_POP) tips.add(pass);
  }
  if (tips.has(k)) {
    out.pops.push(popOf(id, k, 'tip', 1, 1));
  } else if (!tips.has(k - 1) && !tips.has(k + 1)) {
    // A random pop, unless the drawing before had one coming (drawn or not).
    const r = randomCoin(id, k);
    if (r && (k - 1 < tl.from || !randomCoin(id, k - 1))) {
      const lo = 1 - (1 - RANDOM_AT[0]) ** (1 + TAPER); // the share of ∫r below RANDOM_AT[0] ...
      const hi = 1 - (1 - RANDOM_AT[1]) ** (1 + TAPER); // ... and below RANDOM_AT[1]
      const s = 1 - (1 - uniform(r, lo, hi)) ** (1 / (1 + TAPER));
      out.pops.push(popOf(id, k, 'random', s, r() < 0.5 ? 1 : -1));
    }
  }
  return out;
}

// The random pop's coin on drawing d, and the rest of its stream when it lands.
function randomCoin(id: number, d: number): Rng | null {
  const r = rng(id, 'pop', d, 1);
  return r() < RANDOM_POP ? r : null;
}

function popOf(id: number, k: number, kind: Pop['kind'], s: number, side: 1 | -1): Pop {
  const r = rng(id, 'pop', k, 2);
  const core = uniform(r, POP_CORE[0], POP_CORE[1]);
  const n = int(r, SPIKES[0], SPIKES[1]);
  const spikes = Array.from({ length: n }, (_, q): Spike => {
    const angle = -FAN + (2 * FAN * (q + uniform(r, 0.2, 0.8))) / n;
    const u = r();
    return { angle, length: SPIKE_LEN[0] + (SPIKE_LEN[1] - SPIKE_LEN[0]) * u * u, base: uniform(r, SPIKE_BASE[0], SPIKE_BASE[1]) };
  });
  return { kind, s, side, core, spikes };
}

// ---- Drawing ----------------------------------------------------------------------------------

// A pop on screen: its spikes as triangles (one base corner, the point, the
// other base corner, all wound the same way) round a core disc.
export interface PopShape {
  centre: Vec2; // frame px
  r: number; // the r it is measured in, px
  core: number; // the core disc's radius, px
  rim: number; // the body-tone disc's radius, px
  spikes: [Vec2, Vec2, Vec2][];
}

// A tip pop sits on the tip, its axis along the tube's screen tangent; a
// random one on the skin's screen edge at s, its axis along ± the normal.
export function popShape(tube: Tube, pop: Pop): PopShape | null {
  if (tube.sections.length < 2) return null;
  const r = sectionAt(tube, POP_R_AT).r;
  let centre: Vec2;
  let axis: Vec2;
  if (pop.kind === 'tip') {
    const tip = tube.sections[tube.sections.length - 1];
    centre = [tip.screen[0], tip.screen[1]];
    axis = [tip.normal[1], -tip.normal[0]]; // normal = (−ty, tx), so this is (tx, ty)
  } else {
    const at = sectionAt(tube, pop.s);
    axis = [pop.side * at.normal[0], pop.side * at.normal[1]];
    centre = [at.screen[0] + axis[0] * at.r, at.screen[1] + axis[1] * at.r];
  }
  const core = (pop.core * r) / 2;
  const a0 = Math.atan2(axis[1], axis[0]);
  const spikes = pop.spikes.map((sp): [Vec2, Vec2, Vec2] => {
    const dx = Math.cos(a0 + sp.angle);
    const dy = Math.sin(a0 + sp.angle);
    const half = (sp.base * r) / 2;
    const bx = centre[0] + dx * SPIKE_FROM * core;
    const by = centre[1] + dy * SPIKE_FROM * core;
    const reach = core + sp.length * r;
    return [
      [bx - dy * half, by + dx * half],
      [centre[0] + dx * reach, centre[1] + dy * reach],
      [bx + dy * half, by - dx * half],
    ];
  });
  return { centre, r, core, rim: RIM * core, spikes };
}

// What drawPops needs on top of drawArcs' calls.
export interface PopTarget extends ArcTarget {
  fillStyle: unknown;
  closePath(): void;
  fill(): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
}

// The pops, after the near arcs: the spikes and a rim disc filled in the body
// tone over an edge line, then the core. Spikes and discs are filled
// separately, so their windings never cancel.
export function drawPops(ctx: PopTarget, tube: Tube, pops: readonly Pop[], tones: Readonly<ArcTones> = ARC_TONES) {
  for (const pop of pops) {
    const shape = popShape(tube, pop);
    if (!shape) continue;
    const { centre, r, core, rim, spikes } = shape;
    const spikePath = () => {
      ctx.beginPath();
      for (const [a, b, c] of spikes) {
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.lineTo(c[0], c[1]);
        ctx.closePath();
      }
    };
    const disc = (radius: number) => {
      ctx.beginPath();
      ctx.arc(centre[0], centre[1], radius, 0, 2 * Math.PI);
      ctx.closePath();
    };
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = 2 * Math.max(1, EDGE * r); // half of it shows past the fill
    ctx.strokeStyle = tones.edge;
    spikePath();
    ctx.stroke();
    disc(rim);
    ctx.stroke();
    ctx.fillStyle = tones.body;
    spikePath();
    ctx.fill();
    disc(rim);
    ctx.fill();
    ctx.fillStyle = tones.core;
    disc(core);
    ctx.fill();
  }
}

// The pops' glow: a tight disc of 1.25 r at ×1.7.
export function emitPops(sink: GlowSink, tube: Tube, pops: readonly Pop[], gain: number, tones: Readonly<ArcTones> = ARC_TONES) {
  for (const pop of pops) {
    const shape = popShape(tube, pop);
    if (shape) sink.disc(shape.centre, POP_GLOW_R * shape.r, tones.core, POP_GLOW * gain);
  }
}

// The pulses' glow, ×2: each bulge as a body stroke 2·r·scale wide along the
// tube's screen centreline, and a core stroke at its core share of that.
// `tones` are the limb's own (p0's body and core), not the arcs'.
export function emitPulses(sink: GlowSink, tube: Tube, spans: readonly PulseSpan[], gain: number, tones: { body: string; core: string }) {
  if (tube.sections.length < 2) return;
  for (const span of spans) {
    const a = Math.max(0, span.s - span.len / 2);
    const b = Math.min(1, span.s + span.len / 2);
    if (!(b > a)) continue;
    const points = Array.from({ length: PULSE_POINTS }, (_, i): Vec2 => {
      const p = sectionAt(tube, a + ((b - a) * i) / (PULSE_POINTS - 1)).screen;
      return [p[0], p[1]];
    });
    const width = 2 * sectionAt(tube, (a + b) / 2).r * span.scale;
    sink.stroke(points, width, tones.body, 'body', PULSE_GLOW * gain);
    sink.stroke(points, width * span.core, tones.core, 'core', PULSE_GLOW * gain);
  }
}
