// Line boil (SPEC §8.4): each drawing nudges the centerline a little, the way
// a line traced again by hand never lands in quite the same place. The nudge
// for drawing k is b = A · n(k mod cycle, i): it repeats every `cycle`
// drawings, and it runs even at rest. It's applied to the centerline before
// perfect-freehand builds the outline, so the outline stays clean.
import type { Vec2 } from '../types/effect.ts';

export interface BoilParams {
  maxPx: number; // strongest offset, px at 1080 wide (reference/timing.json)
  cycle: number; // drawings before it repeats
}

// One offset per centerline point, in px at `width` wide. `wobble` (0..1)
// scales it per stroke. Each offset's length is at most maxPx · wobble.
export function boilOffsets(k: number, strokeId: number, count: number, boil: BoilParams, wobble: number, width = 1080): Vec2[] {
  const amount = boil.maxPx * wobble * (width / 1080);
  const phase = ((k % boil.cycle) + boil.cycle) % boil.cycle;
  const x = smoothNoise(strokeId, phase, 0);
  const y = smoothNoise(strokeId, phase, 1);
  return Array.from({ length: count }, (_, i): Vec2 => {
    const t = count > 1 ? i / (count - 1) : 0;
    let dx = x(t);
    let dy = y(t);
    const length = Math.hypot(dx, dy);
    if (length > 1) {
      dx /= length;
      dy /= length;
    }
    return [dx * amount, dy * amount];
  });
}

// Seeded smooth noise along a stroke, t from 0 (root) to 1 (tip), in -1..1:
// a main wave of 2 to 3 waves per stroke, with seeded phase, plus a smaller,
// slower one so the shape isn't a pure sine.
function smoothNoise(strokeId: number, phase: number, channel: number) {
  const r = random(strokeId, phase, channel);
  const waves = 2 + r();
  const p1 = r() * Math.PI * 2;
  const p2 = r() * Math.PI * 2;
  const mix = 0.2 + r() * 0.15; // share of the smaller wave
  return (t: number) => (1 - mix) * Math.sin(Math.PI * 2 * waves * t + p1) + mix * Math.sin(Math.PI * waves * t + p2);
}

// mulberry32, seeded from three integers: the same stroke, phase and channel
// always give the same numbers, so two runs give the same drawing.
function random(a: number, b: number, c: number) {
  let s = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b + 1, 0x85ebca77) ^ Math.imul(c + 1, 0xc2b2ae3d)) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
