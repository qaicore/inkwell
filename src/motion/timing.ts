// The drawing clock (SPEC §6, §8.4). After conversion the clip is constant
// 30 fps, so the frame index is the clock, and the drawing index comes from
// it in integer math: k = floor(f·dps/30). At 12 dps that changes on frames
// 0, 3, 5, 8, 10, … (on 2s and 3s); at 8 dps every 3 or 4 frames. Never
// floor(τ·dps): timestamps in integer microseconds break the cadence.
import type { Vec2 } from '../types/effect.ts';
import type { BoilParams } from './boil.ts';

// The parts of Qai's reference/timing.json (SPEC §11) the engine uses.
export interface Timing {
  dps: 12 | 8;
  boil: BoilParams;
  lash?: { keys?: { drawing: number; tip: Vec2 }[] };
}

// reference/timing.example.json's numbers, for while Qai's own file is
// missing. Whatever uses them says so.
export const EXAMPLE_TIMING: Timing = { dps: 12, boil: { maxPx: 1.5, cycle: 3 } };

// timing.json's contents, or why they can't drive the engine: dps 12 or 8,
// a boil, and lash keys the sheets can draw if there are any.
export function validateTiming(json: unknown): { timing: Timing } | { problem: string } {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return { problem: 'it is not a JSON object' };
  const t = json as { dps?: unknown; boil?: { maxPx?: unknown; cycle?: unknown }; lash?: { keys?: unknown } };
  if (t.dps !== 12 && t.dps !== 8) return { problem: '"dps" must be 12 or 8' };
  if (typeof t.boil?.maxPx !== 'number' || !(t.boil.maxPx >= 0)) return { problem: '"boil.maxPx" must be a number of px, 0 or more' };
  if (!Number.isInteger(t.boil.cycle) || (t.boil.cycle as number) < 2) return { problem: '"boil.cycle" must be a whole number of drawings, 2 or more' };
  const keys = t.lash?.keys;
  if (keys !== undefined && !(Array.isArray(keys) && keys.every(isKey))) {
    return { problem: '"lash.keys" must be a list of { "drawing": <whole number>, "tip": [x, y] }' };
  }
  return { timing: json as Timing };
}

const isKey = (k: unknown) => {
  const key = k as { drawing?: unknown; tip?: unknown } | null;
  return Number.isInteger(key?.drawing) && Array.isArray(key?.tip) && key.tip.length === 2 && key.tip.every(Number.isFinite);
};

export function drawingIndex(f: number, dps: number, fps = 30): number {
  if (!Number.isInteger(f) || !Number.isInteger(dps) || !Number.isInteger(fps)) {
    throw new Error(`drawingIndex takes whole numbers (got f=${f}, dps=${dps}, fps=${fps})`);
  }
  const n = f * dps;
  return (n - (((n % fps) + fps) % fps)) / fps;
}

// The frame index for a timestamp in seconds: f = round(τ·30).
export function frameAt(seconds: number, fps = 30): number {
  return Math.round(seconds * fps);
}
