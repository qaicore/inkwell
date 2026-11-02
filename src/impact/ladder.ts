// The export's flash ladder (impact design §5): when a Reduce flashing export
// fails the flash check (export/flash.ts), it degrades through these seven
// steps in order, re-checking after each. The steps add up, and each one
// re-renders only the frames it touches. After step 7 the footage itself
// flashes, and the export throws FlashCheckError. The ladder never runs under
// full flashing, and the preview always plays the normal timing; only the
// export walks it (WP13).
//   1. Wash 3 becomes a bolt brightening (2 transitions fewer).
//   2. Wash 1 becomes a bolt brightening (2 fewer).
//   3. Strike calm: the beam multipliers clamped to 0.7–1.0, the S6 swell to
//      1.0·w_b (strike.ts), and the plate lift kept at 1 through the strike.
//   4. The slow replay, as a freeze: each poster holds 5 frames, so output
//      frames I..I+34 are posters over clip frame I held still, and from
//      output I+35 the clip resumes at frame I+9 (clock.ts's freezeMap). The
//      export is 26 frames longer, and its audio gets 26 frames of silence
//      after I+9.
//   5. Polarity lock: every poster light (frames/gentle.ts).
//   6. Glint only: G6's IF4 glint held 8 frames, with no washes, no
//      brightenings, no veil and no A5–6 flash; the masses at 0.6.
//   7. No flash elements: no posters (the frames.count 0 plan), and still no
//      washes, veil or flash; no lightning, and the masses at 0.3.
// Steps 6 and 7 keep the freeze of step 4, since the steps add up: under them
// the clip still holds at frame I for output I..I+34, under the glint and
// after it, and the export stays 26 frames longer.
// The masses (the burst, the cluster and the dust) stay opaque through step
// 5: Reduce flashing lays them at the luminance of what's under them
// (scene.ts), so they show the destruction without moving a field's light,
// and only the last two steps fade them as well (judge round 2: fixed at 0.3,
// the destruction was gone). The debris and the sparks keep scene.ts's own
// gentle opacity.
import type { FlashReport } from '../export/flash.ts';
import type { WashMode } from './aftermath/washes.ts';
import { FREEZE_EXTRA, FREEZE_HOLD, POSTER_COUNT, freezeMap } from './clock.ts';
import { STRIKE_CALM_STEP } from './strike.ts';

export const LADDER_STEPS = 7;
export const WASH3_STEP = 1;
export const WASH1_STEP = 2;
export const FREEZE_STEP = 4;
export const POLARITY_STEP = 5;
export const GLINT_STEP = 6;
export const NO_POSTERS_STEP = 7;
export { STRIKE_CALM_STEP };

export interface LadderStep {
  step: number; // 1..7
  name: string;
  what: string;
}

export const LADDER: readonly LadderStep[] = [
  { step: 1, name: 'wash-3-bolt', what: 'wash 3 becomes a bolt brightening' },
  { step: 2, name: 'wash-1-bolt', what: 'wash 1 becomes a bolt brightening' },
  { step: 3, name: 'strike-calm', what: 'strike calm: beams ×0.7–1.0, the S6 swell 1.0·w_b, the plate lift at 1 through the strike' },
  { step: 4, name: 'freeze', what: 'the slow replay as a freeze: each poster holds 5 frames over the held clip, 26 frames longer' },
  { step: 5, name: 'polarity-lock', what: 'polarity lock: every poster light' },
  { step: 6, name: 'glint', what: "glint only: G6's IF4 held 8 frames, no washes, brightenings, veil or A5–6 flash; the masses at 0.6" },
  { step: 7, name: 'no-flash', what: 'no flash elements: no posters, no washes, no veil, no flash, no lightning; the masses at 0.3' },
];

// The masses' opacity under Reduce flashing at each step, 0..7.
export const MASS_ALPHA: readonly number[] = [1, 1, 1, 1, 1, 1, 0.6, 0.3];

// What one step asks of the layers: every step up to it, at once.
export interface Degrade {
  step: number; // 0..7; always 0 under full flashing
  washes: { w1: WashMode; w3: WashMode }; // washes.ts's ladder hooks (steps 1 and 2)
  calm: boolean; // step 3: strikeOptions(flash, step) calms the strike, and the plate lift stays at 1 on j −8..−1
  freeze: boolean; // step 4: the clip holds at I under the posters (freezeMap)
  noFlash: boolean; // step 6: no washes, brightenings, veil, A5–6 flash or charge white-out
  posters: 'seven' | 'glint' | 'none'; // what the poster plan shows (posterPlan with ladder = step); 'none' from step 7
  masses: number; // the masses' opacity (MASS_ALPHA): 1 under full flashing
}

export function degradeAt(step: number, flash: 'safe' | 'full'): Degrade {
  if (!Number.isInteger(step) || step < 0 || step > LADDER_STEPS) throw new Error(`the flash ladder has steps 0..${LADDER_STEPS} (got ${step})`);
  const s = flash === 'safe' ? step : 0;
  return {
    step: s,
    washes: { w1: s >= WASH1_STEP ? 'bolt' : 'flood', w3: s >= WASH3_STEP ? 'bolt' : 'flood' },
    calm: s >= STRIKE_CALM_STEP,
    freeze: s >= FREEZE_STEP,
    noFlash: s >= GLINT_STEP,
    posters: s >= NO_POSTERS_STEP ? 'none' : s >= GLINT_STEP ? 'glint' : 'seven',
    masses: MASS_ALPHA[s],
  };
}

// How many output frames a clip of `frames` frames makes, with its contact on
// I (null: no slam).
export function outputLength(frames: number, I: number | null, d: Degrade): number {
  return frames + (d.freeze && I !== null ? FREEZE_EXTRA : 0);
}

// The clip frame under output frame o.
export function clipOf(o: number, I: number | null, d: Degrade): number {
  return d.freeze && I !== null ? freezeMap(I, o).clip : o;
}

// The output frames step `step` changes against step − 1, [from, to), so the
// export re-renders only those. `length` is the output length at that step.
export function touchedFrames(step: number, I: number, length: number): { from: number; to: number } {
  if (!Number.isInteger(step) || step < 1 || step > LADDER_STEPS) throw new Error(`the flash ladder has steps 1..${LADDER_STEPS} (got ${step})`);
  const span = (from: number, to: number) => ({ from: Math.max(0, from), to: Math.min(length, to) });
  switch (step) {
    case WASH3_STEP:
      return span(I + 28, I + 34); // gentle wash 3, j 28–33
    case WASH1_STEP:
      return span(I + 20, I + 26); // gentle wash 1, j 20–25
    case STRIKE_CALM_STEP:
      return span(I - 8, I); // the strike, j −8..−1
    case POLARITY_STEP:
      return span(I, I + POSTER_COUNT * FREEZE_HOLD); // the posters, under the freeze
    default:
      return span(I, length); // the freeze moves every later frame; the glint and no posters touch the posters and every wash, veil and flash after them
  }
}

export interface LadderWalk {
  step: number; // the step that passed, or the last one tried
  pass: boolean;
  report: FlashReport; // that step's
  reports: FlashReport[]; // every step tried, from 0
}

// Walks the ladder: `check` renders the clip at a step and checks it. Under
// full flashing only step 0 is checked (a fail shows the warning); under
// Reduce flashing it stops at the first step that passes, and a walk that
// ends without one means the footage flashes on its own (FlashCheckError).
export function walkLadder(flash: 'safe' | 'full', check: (step: number) => FlashReport): LadderWalk {
  const last = flash === 'safe' ? LADDER_STEPS : 0;
  const reports: FlashReport[] = [];
  for (let step = 0; step <= last; step++) {
    const report = check(step);
    reports.push(report);
    if (report.pass) return { step, pass: true, report, reports };
  }
  return { step: last, pass: false, report: reports[reports.length - 1], reports };
}
