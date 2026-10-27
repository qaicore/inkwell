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

// timing.json's contents, or null if they don't have a usable dps and boil.
export function parseTiming(json: unknown): Timing | null {
  const t = json as Partial<Timing> | null;
  if (!t || (t.dps !== 12 && t.dps !== 8)) return null;
  const boil = t.boil;
  if (typeof boil?.maxPx !== 'number' || !(boil.maxPx >= 0) || !Number.isInteger(boil.cycle) || boil.cycle < 2) return null;
  return t as Timing;
}

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
