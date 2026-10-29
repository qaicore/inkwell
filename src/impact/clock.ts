// The impact's clocks (impact design §0), all in integer math so a frame lands
// on the same step on every device. f is the output frame at 30 fps, I the
// contact frame and j = f − I.
//   - k(f) = floor(f·dps/30): the global drawing clock (motion/timing.ts).
//   - kr(j) = 7 + floor(4j/5): the reference clock, 24 drawings a second at real
//     speed; at 30 fps its steps hold 2, 1, 1, 1 frames. The strike is kr 0..6
//     (j −8..−1), the posters kr 7..13 (j 0..8), the aftermath kr 14..31 (j 9..31).
//   - k24(f) = floor(4f/5): the same 24 a second, for clips with no slam.
// After j 31 comes a hold span, then a 14-frame linear decay that ends exactly
// at J_end = round(30·aftermath.seconds).
import { drawingIndex } from '../motion/timing.ts';

export const DECAY_FRAMES = 14;
export const POSTER_COUNT = 7;

export const kr = (j: number): number => 7 + Math.floor((4 * j) / 5);
export const k24 = (f: number): number => Math.floor((4 * f) / 5);

// The 1s clock: kr with a slam, k24 without.
export const c1 = (f: number, I?: number | null): number => (I === null || I === undefined ? k24(f) : kr(f - I));

export const jEnd = (seconds: number): number => Math.round(30 * seconds);

// Every decaying layer's opacity: 1 up to J_end − 14, then linear to exactly 0 at J_end.
export const decayAlpha = (j: number, end: number): number => Math.min(1, Math.max(0, (end - j) / DECAY_FRAMES));

// The first output frame of global drawing k.
export const drawingStart = (k: number, dps: number): number => Math.ceil((30 * k) / dps);

export type Phase =
  | { kind: 'none' } // before the coil
  | { kind: 'coil' } // j −14..−9
  | { kind: 'strike'; s: number } // j −8..−1: S0..S6
  | { kind: 'poster'; si: number } // j 0..8: IF1..IF7 are si 0..6
  | { kind: 'aftermath'; A: number } // j 9..31: the reference age, 0..17
  | { kind: 'hold' } // j 32..J_end − 14 (empty at 1.5 s)
  | { kind: 'decay'; alpha: number } // j J_end − 13..J_end
  | { kind: 'after' }; // past J_end: the scars only

export function phaseAt(j: number, end: number): Phase {
  if (j < -14) return { kind: 'none' };
  if (j <= -9) return { kind: 'coil' };
  if (j <= -1) return { kind: 'strike', s: kr(j) };
  if (j <= 8) return { kind: 'poster', si: kr(j) - 7 };
  if (j > end) return { kind: 'after' };
  if (j > end - DECAY_FRAMES) return { kind: 'decay', alpha: decayAlpha(j, end) };
  if (j <= 31) return { kind: 'aftermath', A: kr(j) - 14 };
  return { kind: 'hold' };
}

// kr 14..31 → the measured hold groups g0..g8.
const GROUP_OF_KR = [0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 5, 6, 6, 6, 7, 7, 8];

// The hold group of the 2s mass layers on frame f, or null before j 9. A
// drawing takes its group from kr at its first frame, so a group never changes
// mid-drawing. j 9 always starts a drawing, even mid-grid, so the fire burst
// never loses a frame. Once kr has passed 31 (a drawing starting at j 32 or
// later), each new drawing takes the next number: 9, 10, … On the hero (I 84,
// 12 dps): g0 f93, g1 f95, g2 f98, g3 f100, g4 f103, g5 f105, g6 f108 and f110,
// g7 f113, g8 f115–117, g9 f118.
export function massGroup(f: number, I: number, dps: number): number | null {
  if (f - I < 9) return null;
  const start = Math.max(drawingStart(drawingIndex(f, dps), dps), I + 9);
  const r = kr(start - I);
  if (r <= 31) return GROUP_OF_KR[r - 14];
  const k32 = drawingIndex(I + 32, dps);
  const firstPast = drawingStart(k32, dps) < I + 32 ? k32 + 1 : k32; // the first drawing that starts at j 32 or later
  return 9 + drawingIndex(start, dps) - firstPast;
}

// What a limb shows on frame f (design §4, "Clock"):
//   - 'tube': a freshly shaded tube drawing, on land − 1, land and every second
//     frame after it up to the release; the release itself forces a new drawing;
//   - 'stamp': the last tube carried by the similarity about P, between them;
//   - 'silhouette': poster frames (j 0..8) draw the tube's outline only;
//   - 'grid': the 2s grid, everywhere else.
// Limbs first (land I − 7, release I + 9): tubes on j −8, −7, −5, −3 and −1,
// stamps on −6, −4 and −2, silhouettes on j 0..8, and a new drawing on j 9.
// `posters` false (frames.count 0) shows the limbs as the physics leaves them.
export type LimbDrawing = 'tube' | 'stamp' | 'silhouette' | 'grid';
export function limbDrawingAt(f: number, I: number, strike?: { land: number; release: number }, posters = true): LimbDrawing {
  const j = f - I;
  if (posters && j >= 0 && j <= 8) return 'silhouette';
  if (!strike) return 'grid';
  const { land, release } = strike;
  if (f === release || f === land - 1 || f === land) return 'tube';
  if (f > land && f < release) return (f - land) % 2 === 0 ? 'tube' : 'stamp';
  return 'grid';
}

// The camera's punch-in (design §7): 1.08 from contact through j 9, easing
// back to 1 by j 39. Posters ignore the camera.
export function zoomAt(j: number): number {
  if (j < 0) return 1;
  if (j <= 9) return 1.08;
  if (j >= 39) return 1;
  const t = 1 - (j - 9) / 30;
  return 1 + 0.08 * t * t;
}

// The slow replay (design §5, ladder step 4): each poster holds 5 frames, so
// output frames I..I+34 are posters over clip frame I held still; from output
// I+35 the clip resumes at frame I+9, so later output frames show clip frame o − 26.
export const FREEZE_HOLD = 5;
export const FREEZE_EXTRA = POSTER_COUNT * FREEZE_HOLD - 9; // 26 frames longer
export function freezeMap(I: number, o: number): { clip: number; si: number | null } {
  if (o < I) return { clip: o, si: null };
  if (o < I + POSTER_COUNT * FREEZE_HOLD) return { clip: I, si: Math.floor((o - I) / FREEZE_HOLD) };
  return { clip: o - FREEZE_EXTRA, si: null };
}

// How many output frames each poster holds: kr's 2, 1, 1, 1, 2, 1, 1, or 5
// each under the slow replay.
export function posterHolds(freeze = false): number[] {
  if (freeze) return Array.from({ length: POSTER_COUNT }, () => FREEZE_HOLD);
  const holds = new Array<number>(POSTER_COUNT).fill(0);
  for (let j = 0; j <= 8; j++) holds[kr(j) - 7]++;
  return holds;
}
