// The drawing clock (SPEC §6, §8.4). After conversion the clip is constant
// 30 fps, so the frame index is the clock, and the drawing index comes from
// it in integer math: k = floor(f·dps/30). At 12 dps that changes on frames
// 0, 3, 5, 8, 10, … (on 2s and 3s); at 8 dps every 3 or 4 frames. Never
// floor(τ·dps): timestamps in integer microseconds break the cadence.

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
