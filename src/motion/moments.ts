// Moments on the clip's timeline (SPEC §8.9): when things happen, in drawings.
//   - emergeAges: for each stroke an 'emerge' moment covers, how many
//     drawings ago it came out (negative before), for the electric and limb
//     brushes (an emerge with no stroke list covers both).
//   - suggestArmsOpen: a frame for that moment, from the stand-in's wrists,
//     for Qai to confirm or move. Free and local. It looks for the clip's
//     first fast opening: the wrists' spread (armSpread) rising faster than
//     OPEN_SPEED per frame, by at least MIN_RISE in all (a slam later on
//     opens the arms too, and the kagune comes out before that). It returns
//     the first frame where the spread is within 10% of where that rise tops
//     out.
import type { BrushId, Effect, EmergeMoment, Vec2 } from '../types/effect.ts';
import { drawingIndex } from './timing.ts';

const FPS = 30; // the converted clip's rate (SPEC §8.1)
const OPEN_SPEED = 0.06; // torso lengths per frame
const SETTLE = 15; // frames after the rise to look for its top
const MIN_RISE = 0.5;
const EMERGING: readonly (BrushId | undefined)[] = ['electric', 'limb']; // the brushes that grow out of him

export function emergeAges(effect: Effect, k: number): Map<number, number> {
  const ages = new Map<number, number>();
  const dps = effect.timing.drawingsPerSecond;
  for (const m of effect.moments ?? []) {
    if (m.kind !== 'emerge') continue;
    const at = drawingIndex(Math.round(m.at * FPS), dps, FPS);
    const ids = (m as EmergeMoment).strokes ?? effect.strokes.filter((s) => EMERGING.includes(s.brush)).map((s) => s.id);
    for (const id of ids) ages.set(id, k - at);
  }
  return ages;
}

// The wrists' distance apart over his size: the larger of the spine
// (shoulders to hips) and the shoulder width. Bending forward shortens the
// spine on screen and turning narrows the shoulders, never both, so the
// spread doesn't blow up in a crouch or a spin.
export function armSpread(p: { shoulders: [Vec2, Vec2]; hips: [Vec2, Vec2]; wrists: [Vec2, Vec2] }): number {
  const d = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const mid = (pair: [Vec2, Vec2]): Vec2 => [(pair[0][0] + pair[1][0]) / 2, (pair[0][1] + pair[1][1]) / 2];
  return d(...p.wrists) / Math.max(d(mid(p.shoulders), mid(p.hips)), d(...p.shoulders), 1e-6);
}

// `spread` is armSpread per frame (null where the stand-in has no body).
// Returns a frame, or null if the arms never open fast.
export function suggestArmsOpen(spread: (number | null)[]): number | null {
  let best: { from: number; to: number } | null = null;
  let start = -1;
  for (let f = 1; f <= spread.length; f++) {
    const a = spread[f - 1];
    const b = f < spread.length ? spread[f] : null;
    const opening = a !== null && b !== null && b - a > OPEN_SPEED;
    if (opening && start < 0) start = f - 1;
    if (!opening && start >= 0) {
      if (spread[f - 1]! - spread[start]! >= MIN_RISE) {
        best = { from: start, to: f - 1 };
        break;
      }
      start = -1;
    }
  }
  if (!best) return null;
  let top = spread[best.to]!;
  for (let f = best.to; f < Math.min(spread.length, best.to + SETTLE); f++) top = Math.max(top, spread[f] ?? top);
  const base = spread[best.from]!;
  for (let f = best.from; f < spread.length; f++) if (spread[f] !== null && spread[f]! >= base + 0.9 * (top - base)) return f;
  return best.to;
}
