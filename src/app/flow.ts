// The two-drawing flow (impact design §1; WP13): what the bottom sheet asks
// for next, as a pure state machine the page (main.ts) drives. Qai draws the
// limbs on one frame and the impact on a later one, and nothing else is asked
// of him (decision 1):
//   idle → limbs (the sheet opens on f1) → Done → impact (the sheet opens
//   on the cue) → Done: the snap, then everything derived (detect.ts's
//   momentsFromDrawings) → preview, replayed from I − 20. No tap between
//   the two drawings.
//   - Draw limbs opens on the first frame where the person mask is at least
//     0.6 of its median area: the app's stand-in has no wrists for
//     suggestArmsOpen. A root more than 0.05 S off the person snaps onto the
//     nearest mask pixel (the page highlights it for 300 ms). 1–6 strokes, all
//     on one frame.
//   - The turn needs no tap (decision 4): with effect.turn left out, the
//     scene reads the turn from the stand-in pose where it reads as one, else
//     there's none. More → Turn holds the optional override: This frame (his
//     back faces you here), the direction toggle, No tap to go back to the
//     pose's turn, and the keys a frame either way.
//   - Draw impact opens on suggestImpactFrame's cue: the frame he parked the
//     scrubber on, the audio onset, the mask's sharpest stop. 2–8 strokes, all
//     on one frame. Done snaps the contact (the toast says when it moved) and
//     checks R1 before anything is derived.
//   - More: Move contact ±1 (slam.at), the aftermath 1.5–3 s, the turn
//     override and its keys ±1 frame. One Reduce flashing toggle sits on the impact sheet and the
//     export sheet (decision 5): the full impact frames by default.
// Positions are clip px. The masks are the cached SAM ones; asSamMasks gives
// the stand-in's the same shape, so the detector reads either.
import type { EmergeMoment, Moment, Turn, Vec2 } from '../types/effect.ts';
import type { SamMask } from '../sam/cache.ts';
import type { Mask } from '../track/tracking.ts';
import { momentsFromDrawings, R1_GAP, R1_MESSAGE, SLAM_AFTERMATH, SLAM_FRAMES, suggestImpactFrame, type DrawnLine, type DrawnMoments, type Masks } from '../impact/detect.ts';
import { turnKeysFromTap } from '../lift/turn.ts';

const FPS = 30;
export const LIMB_STROKES = { min: 1, max: 6 } as const;
export const IMPACT_STROKES = { min: 2, max: 8 } as const;
export const ROOT_SNAP = 0.05; // × S: a root farther than this off the person snaps onto it
export const ROOT_FLASH_MS = 300; // how long the page highlights a snapped root
export const OPEN_AREA = 0.6; // × the person mask's median area: where Draw limbs opens
export const REPLAY_FROM = 20; // frames before the contact the preview replays from
export const AFTERMATH_SECONDS = { min: 1.5, max: 3 } as const;
export const TURN_ASK = 'Optional: if he turns around, tap This frame where his back faces you.';

export type Step = 'idle' | 'limbs' | 'impact' | 'preview';

// A drawn line and the frame it was drawn on.
export interface DrawnOn extends DrawnLine {
  frame: number;
}

export interface Flow {
  step: Step;
  frame: number; // the frame the current sheet opened on: the page seeks there on each step
  f1: number | null; // the limb drawing's frame, once it's done
  limbs: number[]; // its stroke ids
  dir: 1 | -1; // the turn override's direction toggle, s
  turn: Turn | null; // his optional tap in More, with any nudged keys; null: none, so the pose's turn or none
  fDrawn: number | null; // the impact drawing's frame, once it's done
  cracks: number[]; // its stroke ids
  derived: DrawnMoments | null; // what Done read from the two drawings
  contact: number | null; // I: the snap's frame, then Move contact's
  flash: 'safe' | 'full'; // 'safe' is Reduce flashing
  aftermath: number; // seconds, 1.5..3
  toast: string | null; // the snap's, for the page to show once
  message: string | null; // what the sheet says: R1, a stroke count out of range
}

// What Draw impact needs to pick its frame (suggestImpactFrame).
export interface ImpactCue {
  parked: number | null; // the frame he left the scrubber on, if he moved it there himself
  audio?: readonly number[] | null; // the clip's 10 ms envelope (engine.ts's audioEnvelope)
  masks: Masks;
  S: number; // the frame's short side, px
}

export function initialFlow(): Flow {
  return {
    step: 'idle',
    frame: 0,
    f1: null,
    limbs: [],
    dir: 1,
    turn: null,
    fDrawn: null,
    cracks: [],
    derived: null,
    contact: null,
    flash: SLAM_FRAMES.flash,
    aftermath: SLAM_AFTERMATH.seconds,
    toast: null,
    message: null,
  };
}

// ---- The steps -------------------------------------------------------------------------

// Draw limbs: the sheet opens on f1 (suggestLimbFrame), or on the limbs he
// already drew, to change them.
export function openLimbs(flow: Flow, f1: number): Flow {
  return { ...flow, step: 'limbs', frame: flow.f1 ?? f1, toast: null, message: null };
}

// Done on the limbs: 1–6 strokes on one frame, which is f1, and the impact
// sheet opens on the cue straight away: nothing is asked in between
// (decision 1). New limbs undo whatever was derived from the old ones, so
// the impact's Done runs again.
export function limbsDone(flow: Flow, limbs: readonly DrawnOn[], cue: ImpactCue): Flow {
  const problem = drawingProblem(limbs, LIMB_STROKES, 'limb');
  if (problem) return { ...flow, message: problem };
  const f1 = limbs[0].frame;
  return openImpact({ ...flow, f1, limbs: limbs.map((l) => l.id), derived: null, contact: null, toast: null, message: null }, cue);
}

// More → This frame, the turn's optional override (decision 4): his back
// faces the camera on `frame` (f_b), and he spins the toggle's way; the
// scene builds the tap's five keys (lift/turn.ts). The sheet stays where it is.
export function turnTap(flow: Flow, frame: number): Flow {
  return { ...flow, turn: { at: frame / FPS, dir: flow.dir }, toast: null, message: null };
}

// More → No tap: the override goes, so the turn is read from his pose where
// it reads as one, else there's none.
export function clearTurn(flow: Flow): Flow {
  return flow.turn ? { ...flow, turn: null } : flow;
}

// The direction toggle, s = ±1. A tap already made spins the other way too,
// its nudged keys mirrored.
export function setTurnDir(flow: Flow, dir: 1 | -1): Flow {
  if (dir === flow.dir) return flow;
  if (!flow.turn) return { ...flow, dir };
  const keys = flow.turn.keys?.map(([s, deg]): [number, number] => [s, deg === 0 ? 0 : -deg]);
  return { ...flow, dir, turn: { ...flow.turn, dir, ...(keys ? { keys } : {}) } };
}

// Draw impact: the sheet opens where he drew the impact before, else on the
// cue. The limbs come first: R1 and the cue both need f1.
export function openImpact(flow: Flow, cue: ImpactCue): Flow {
  if (flow.f1 === null) return { ...flow, message: 'Draw the limbs first.' };
  const frame = flow.fDrawn ?? suggestImpactFrame({ parked: cue.parked, f1: flow.f1, audio: cue.audio, masks: cue.masks, S: cue.S }).frame;
  return { ...flow, step: 'impact', frame, toast: null, message: null };
}

// Done on the impact: 2–8 strokes on one frame. The contact snaps (G1, under
// the drawn P), R1 is checked on it, and the rest is derived. A contact too
// early for the limbs keeps the sheet open with R1's message; otherwise the
// preview replays from I − 20, with the toast when the contact moved.
export function impactDone(flow: Flow, drawings: { limbs: readonly DrawnLine[]; cracks: readonly DrawnOn[] }, masks: Masks, S: number): Flow {
  if (flow.f1 === null) return { ...flow, message: 'Draw the limbs first.' };
  const problem = drawingProblem(drawings.cracks, IMPACT_STROKES, 'impact');
  if (problem) return { ...flow, message: problem };
  const fDrawn = drawings.cracks[0].frame;
  const cracks = drawings.cracks.map((c) => c.id);
  const derived = momentsFromDrawings({ limbs: drawings.limbs, f1: flow.f1, cracks: drawings.cracks, fDrawn, masks, S, turn: flow.turn ?? undefined });
  const I = derived.snap.frame;
  const r1 = r1Problem(flow.f1, I);
  if (r1) return { ...flow, step: 'impact', fDrawn, cracks, derived: null, contact: null, toast: null, message: r1 };
  const notes = derived.problems.filter((p) => !p.startsWith(R1_MESSAGE));
  return { ...flow, step: 'preview', frame: Math.max(0, I - REPLAY_FROM), fDrawn, cracks, derived, contact: I, toast: derived.snap.toast, message: notes.length > 0 ? notes.join('; ') : null };
}

// Back, from the limbs or the impact sheet: nothing he drew is lost, and the
// moments stay as the last Done left them.
export function back(flow: Flow): Flow {
  if (flow.step !== 'limbs' && flow.step !== 'impact') return flow;
  return { ...flow, step: flow.derived ? 'preview' : 'idle', toast: null, message: null };
}

// A limb or an impact stroke undone or cleared away: what was derived from
// its drawing goes, so that drawing's Done runs again; the strokes left keep
// their frame.
export function forgetStroke(flow: Flow, id: number): Flow {
  const after = (f: Flow): Flow => ({ ...f, step: f.step === 'preview' ? 'idle' : f.step, derived: null, contact: null, toast: null });
  if (flow.limbs.includes(id)) {
    const limbs = flow.limbs.filter((l) => l !== id);
    return after({ ...flow, f1: limbs.length > 0 ? flow.f1 : null, limbs });
  }
  if (flow.cracks.includes(id)) {
    const cracks = flow.cracks.filter((c) => c !== id);
    return after({ ...flow, fDrawn: cracks.length > 0 ? flow.fDrawn : null, cracks });
  }
  return flow;
}

// ---- More ------------------------------------------------------------------------------

// Move contact frame ±1: the escape hatch where the detector misses (a kick
// into a wall, a person walking out of frame). It moves slam.at only; P and d
// stay as derived. Never earlier than R1 allows.
export function moveContact(flow: Flow, by: 1 | -1, frames: number): Flow {
  if (flow.contact === null || flow.f1 === null) return flow;
  const to = Math.min(frames - 1, Math.max(0, flow.contact + by));
  if (to === flow.contact) return flow;
  const r1 = r1Problem(flow.f1, to);
  if (r1) return { ...flow, message: r1 };
  return { ...flow, contact: to, frame: to, toast: null, message: null };
}

export function setFlash(flow: Flow, flash: 'safe' | 'full'): Flow {
  return flash === flow.flash ? flow : { ...flow, flash };
}

// The aftermath's length, 1.5–3 s, to a tenth.
export function setAftermath(flow: Flow, seconds: number): Flow {
  const s = Math.min(AFTERMATH_SECONDS.max, Math.max(AFTERMATH_SECONDS.min, Math.round(seconds * 10) / 10));
  return s === flow.aftermath ? flow : { ...flow, aftermath: s };
}

// His turn's keys, [frame, degrees]: the nudged ones, else the tap's five.
export const turnKeyFrames = (turn: Turn): Vec2[] => turnKeysFromTap(turn, FPS);

// More → Turn keys: key `index` one frame earlier or later ("he drags any key
// that's off"). The keys stay in time order, so a key can't pass its neighbour.
export function nudgeTurnKey(flow: Flow, index: number, by: 1 | -1): Flow {
  if (!flow.turn) return flow;
  const keys = turnKeyFrames(flow.turn);
  if (index < 0 || index >= keys.length) return flow;
  const f = keys[index][0] + by;
  if (f < 0 || (index > 0 && f <= keys[index - 1][0]) || (index < keys.length - 1 && f >= keys[index + 1][0])) return flow;
  const moved = keys.map(([kf, deg], i): [number, number] => [(i === index ? f : kf) / FPS, deg]);
  return { ...flow, turn: { ...flow.turn, keys: moved } };
}

// ---- What the effect gets ------------------------------------------------------------

// The flow's part of the effect JSON (engine.ts's effectOf): the limbs'
// emerge moment once they're done, the slam once the impact is, with More's
// settings on it, and his tap.
export function flowMoments(flow: Flow): { moments: (Moment | EmergeMoment)[]; turn: Turn | null } {
  const moments: (Moment | EmergeMoment)[] = [];
  if (flow.f1 !== null && flow.limbs.length > 0) moments.push({ kind: 'emerge', at: flow.f1 / FPS, strokes: [...flow.limbs] });
  if (flow.derived && flow.contact !== null) {
    const slam = flow.derived.slam;
    moments.push({
      ...slam,
      at: flow.contact / FPS,
      limbs: [...flow.limbs],
      frames: { count: slam.frames?.count ?? SLAM_FRAMES.count, flash: flow.flash },
      aftermath: { ...(slam.aftermath ?? SLAM_AFTERMATH), seconds: flow.aftermath },
    });
  }
  return { moments, turn: flow.turn };
}

// R1 (design §1): the limbs need 15 frames to grow out and pop before the
// contact. detect.ts's wording.
export function r1Problem(f1: number, I: number): string | null {
  if (I >= f1 + R1_GAP) return null;
  return `${R1_MESSAGE}: they grow out on f${f1}, so the contact needs f${f1 + R1_GAP} or later (it is f${I})`;
}

function drawingProblem(lines: readonly DrawnOn[], range: { min: number; max: number }, name: 'limb' | 'impact'): string | null {
  const what = name === 'limb' ? 'limbs' : 'impact strokes';
  if (lines.length < range.min) return name === 'limb' ? 'Draw the limbs first: 1 to 6 strokes, from his body outward.' : 'Draw 2 to 8 impact strokes, outward from where the hit lands.';
  if (lines.length > range.max) return `That's ${lines.length} ${what}; ${range.max} at most.`;
  const frames = [...new Set(lines.map((l) => l.frame))].sort((a, b) => a - b);
  if (frames.length > 1) return `The ${what} are one drawing: draw them all on one frame (they're on ${frames.map((f) => `f${f}`).join(', ')}).`;
  return null;
}

// ---- Masks -------------------------------------------------------------------------------

// A whole-frame mask (the stand-in's, or the tracker's) as a cached SAM mask
// over the whole frame, so the detector reads it.
export function asSamMask(m: Mask, width: number, height: number): SamMask {
  const raster = new Uint8Array(m.width * m.height);
  for (let i = 0; i < raster.length; i++) raster[i] = m.alpha[i] >= 128 ? 1 : 0;
  return { width: m.width, height: m.height, raster, bounds: { left: 0, top: 0, right: width, bottom: height } };
}

export function asSamMasks(masks: readonly (Mask | null)[], width: number, height: number): (SamMask | null)[] {
  return masks.map((m) => (m ? asSamMask(m, width, height) : null));
}

// The person's area on a mask, frame px².
export function maskArea(m: SamMask): number {
  let n = 0;
  for (let i = 0; i < m.raster.length; i++) if (m.raster[i]) n++;
  return (n * (m.bounds.right - m.bounds.left) * (m.bounds.bottom - m.bounds.top)) / (m.width * m.height);
}

// Where Draw limbs opens: the first frame where the person mask is at least
// 0.6 of its median area, so he's in frame and whole. 0 without masks.
export function suggestLimbFrame(masks: Masks): number {
  const areas = masks.map((m) => (m ? maskArea(m) : null));
  const found = areas.filter((a): a is number => a !== null && a > 0).sort((a, b) => a - b);
  if (found.length === 0) return 0;
  const mid = found.length >> 1;
  const median = found.length % 2 ? found[mid] : (found[mid - 1] + found[mid]) / 2;
  const f = areas.findIndex((a) => a !== null && a >= OPEN_AREA * median);
  return Math.max(0, f);
}

// The centre of the mask pixel nearest p; p's own when it's on the person.
// Null on an empty mask.
export function nearestPixel(m: SamMask, p: Vec2): Vec2 | null {
  const sx = (m.bounds.right - m.bounds.left) / m.width;
  const sy = (m.bounds.bottom - m.bounds.top) / m.height;
  let best: Vec2 | null = null;
  let bestD = Infinity; // squared
  for (let r = 0; r < m.height; r++) {
    const y = m.bounds.top + (r + 0.5) * sy;
    const dy = y - p[1];
    if (dy * dy >= bestD) continue;
    for (let c = 0; c < m.width; c++) {
      if (!m.raster[r * m.width + c]) continue;
      const x = m.bounds.left + (c + 0.5) * sx;
      const d = (x - p[0]) * (x - p[0]) + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = [x, y];
      }
    }
  }
  return best;
}

// The root snap: a limb whose first point is more than 0.05 S off the person
// has it moved onto the nearest mask pixel; the rest of the stroke stays as
// drawn. `moved` is where the root went, for the highlight; null when it stayed.
export function snapRoot<P extends readonly number[]>(points: readonly P[], mask: SamMask | null, S: number): { points: P[]; moved: Vec2 | null } {
  const root = points[0];
  if (!root || !mask) return { points: [...points], moved: null };
  const at = nearestPixel(mask, [root[0], root[1]]);
  if (!at || Math.hypot(at[0] - root[0], at[1] - root[1]) <= ROOT_SNAP * S) return { points: [...points], moved: null };
  const snapped = [at[0], at[1], ...root.slice(2)] as unknown as P;
  return { points: [snapped, ...points.slice(1)], moved: at };
}
