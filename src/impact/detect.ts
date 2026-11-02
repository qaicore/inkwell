// Moments from the two drawings (impact design §1, "What the app derives").
// Qai draws the limbs on one frame and the impact on a later one; the rest is
// read from the cached person masks under what he drew, offline:
//   - contactFrame: the frame his fist lands (G1), within ±10 frames of the one
//     he drew the impact on. Masks, not the pose: the stand-in's hand stops
//     24–29 px above the floor at contact and is missing on f89–101 (heroclip).
//   - impactPoint: P, where the impact strokes meet (R2), snapped onto the
//     bottom of the body on the contact frame, and the end of each stroke that
//     sits at P (where its draw-on starts).
//   - strikeDir: d, from how his fist moved into the hit.
//   - suggestImpactFrame: where the impact sheet opens, before he draws.
//   - snapContact: contactFrame, and the toast when it moved.
//   - momentsFromDrawings: all of it, as the effect's emerge and slam moments.
// Positions are frame px, y down (the masks' source px); lengths are shares of
// S, the frame's short side. The masks come from src/sam/cache.ts's
// masksFromCache: one per frame, null where SAM found nobody.
import type { EmergeMoment, Moment, Turn, Vec2 } from '../types/effect.ts';
import type { SamMask } from '../sam/cache.ts';
import { fnv1a32 } from './rng.ts';

const FPS = 30; // the converted clip's rate (SPEC §8.1)
export const SEARCH = 10; // frames either side of the drawn frame
const COLUMN = 0.1; // the detector's column, ± this × S around P
const FAST = 0.02; // S per frame: each of the two frames before contact falls this fast
const STOP = 0.01; // S per frame: contact falls slower than this
const SNAP = 0.06; // S: P moves onto the body only this far
const TIGHT = 0.08; // S: R2's widest cluster of stroke ends
const TIE = 0.01; // S: two clusters this close in spread are a tie
const FIST = 0.04; // S: the fist region's height above the lowest row
const MOVED = 0.03; // S: the fist moves at least this over I−3..I−1
const AT_P = 0.08; // S: a stroke end this near P draws on from there
export const R1_GAP = 15; // frames: 4 grow and 2 pop drawings at 12 dps
export const R1_MESSAGE = 'draw the impact later than the limbs'; // what the sheet says
const CUE_AFTER = 15; // frames after f1: where the impact can start
const CUE_FALLBACK = 45; // frames after f1, with no cue at all
const ENVELOPE_MS = 10; // one audio envelope value
const ONSET_SPAN = 10; // envelope values: the 100 ms an onset rises over
const ONSET_DB = 6; // the least rise that counts as a hit: double the amplitude

// The impact frames and the aftermath a new slam gets: the full impact frames,
// the reference's look, by default; 'safe' is the Reduce flashing toggle (Qai, Oct 29).
export const SLAM_FRAMES: Readonly<NonNullable<Moment['frames']>> = { count: 7, flash: 'full' };
export const SLAM_AFTERMATH: Readonly<NonNullable<Moment['aftermath']>> = { seconds: 1.5, scale: 1, scarSeconds: 3 };

export type Masks = readonly (SamMask | null)[];

// A line as drawn: frame px, in drawing order. The app's strokes ([x, y,
// pressure] points) and the test drawings fit as they are.
export interface DrawnLine {
  id: number;
  points: readonly (readonly number[])[];
}

export type End = 'start' | 'end';

export interface Contact {
  frame: number; // the contact frame, or the drawn frame when none was found
  found: boolean;
}

export interface Snap extends Contact {
  drawnOn: number; // the frame he drew the impact on
  moved: boolean;
  toast: string | null; // set when the contact moved off the drawn frame
}

export interface ImpactPoint {
  P: Vec2; // the impact point
  drawn: Vec2; // R2's point, before the snap
  from: End | 'all'; // which stroke ends R2 took; 'all' = no tight cluster, the middle of every point
  snapped: boolean; // P moved onto the bottom of the body
  ends: (End | null)[]; // per stroke, in order: the end at P, where its draw-on starts; null = drawn whole
  problems: string[];
}

export interface StrikeDir {
  dir: Vec2; // unit, screen, y down
  by: 'fist' | 'limbs' | 'down'; // which rule gave it
}

const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const xy = (p: readonly number[]): Vec2 => [p[0], p[1]];
const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ---- Reading a mask ---------------------------------------------------------------
// Raster pixel (col, row) of a cached mask covers an sx × sy patch of its
// bounds; its centre is at left + (col + 0.5)·sx, top + (row + 0.5)·sy.

function grid(m: SamMask) {
  const { left, top, right, bottom } = m.bounds;
  return { sx: (right - left) / m.width, sy: (bottom - top) / m.height };
}

// The columns whose pixel centres lie in [x0, x1].
function cols(m: SamMask, x0: number, x1: number): [number, number] {
  const { sx } = grid(m);
  return [Math.max(0, Math.ceil((x0 - m.bounds.left) / sx - 0.5)), Math.min(m.width - 1, Math.floor((x1 - m.bounds.left) / sx - 0.5))];
}

// The mask's lowest row with a pixel centre in [x0, x1]: its centre y, and its
// runs of pixels there as [first, last] centre x, left to right. Null if none.
export function lowestRow(m: SamMask, x0 = -Infinity, x1 = Infinity): { y: number; runs: Vec2[] } | null {
  const { sx, sy } = grid(m);
  const [c0, c1] = cols(m, x0, x1);
  if (c0 > c1) return null;
  const cx = (col: number) => m.bounds.left + (col + 0.5) * sx;
  for (let row = m.height - 1; row >= 0; row--) {
    const runs: Vec2[] = [];
    let start = -1;
    for (let col = c0; col <= c1 + 1; col++) {
      const on = col <= c1 && m.raster[row * m.width + col] !== 0;
      if (on && start < 0) start = col;
      if (!on && start >= 0) {
        runs.push([cx(start), cx(col - 1)]);
        start = -1;
      }
    }
    if (runs.length) return { y: m.bounds.top + (row + 0.5) * sy, runs };
  }
  return null;
}

// How far p is from the person: 0 inside, else to the nearest pixel centre.
export function distanceToMask(m: SamMask, p: Vec2): number {
  const { sx, sy } = grid(m);
  const col = Math.floor((p[0] - m.bounds.left) / sx);
  const row = Math.floor((p[1] - m.bounds.top) / sy);
  if (col >= 0 && col < m.width && row >= 0 && row < m.height && m.raster[row * m.width + col]) return 0;
  let best = Infinity; // squared
  for (let r = 0; r < m.height; r++) {
    const dy = m.bounds.top + (r + 0.5) * sy - p[1];
    if (dy * dy >= best) continue;
    for (let c = 0; c < m.width; c++) {
      if (!m.raster[r * m.width + c]) continue;
      const dx = m.bounds.left + (c + 0.5) * sx - p[0];
      best = Math.min(best, dx * dx + dy * dy);
    }
  }
  return Math.sqrt(best);
}

// The person's lowest row on frame f, inside the column x0..x1 (the whole
// width without one): null where there's no mask, or nothing in the column.
// Each frame is read once.
export type Track = (f: number) => number | null;
export function lowTrack(masks: Masks, x0 = -Infinity, x1 = Infinity): Track {
  const memo = new Map<number, number | null>();
  return (f) => {
    if (!memo.has(f)) {
      const m = masks[f];
      memo.set(f, m ? (lowestRow(m, x0, x1)?.y ?? null) : null);
    }
    return memo.get(f)!;
  };
}

// ---- The contact frame (G1) ---------------------------------------------------------

// Frame f is a contact when its lowest row falls less than STOP·S, right after
// two frames that each fell FAST·S or more. On the hero, under P: 46, 29, then
// 6 px on f84. At full width his feet are lower, and they still fall 12 px on
// f77, so the rule needs the column.
function isContact(low: Track, f: number, S: number): boolean {
  const fall = (g: number) => {
    const a = low(g - 1);
    const b = low(g);
    return a === null || b === null ? null : b - a;
  };
  const [now, before, first] = [fall(f), fall(f - 1), fall(f - 2)];
  return now !== null && before !== null && first !== null && now < STOP * S && before >= FAST * S && first >= FAST * S;
}

// Every contact on frames from..to, both included, in order.
export function contactsIn(low: Track, from: number, to: number, S: number): number[] {
  const hits: number[] = [];
  for (let f = Math.max(0, from); f <= to; f++) if (isContact(low, f, S)) hits.push(f);
  return hits;
}

// G1: the person's lowest row in a ±COLUMN·S column under the drawn P, within
// SEARCH frames of the frame he drew on. Of several contacts, the nearest to
// that frame wins (the earlier on a tie): he drew where he saw the hit. With
// none, the frame he drew on stands.
export function contactFrame(masks: Masks, fDrawn: number, Pdraw: Vec2, S: number): Contact {
  const low = lowTrack(masks, Pdraw[0] - COLUMN * S, Pdraw[0] + COLUMN * S);
  const hits = contactsIn(low, fDrawn - SEARCH, fDrawn + SEARCH, S);
  if (!hits.length) return { frame: fDrawn, found: false };
  return { frame: hits.reduce((best, f) => (Math.abs(f - fDrawn) < Math.abs(best - fDrawn) ? f : best)), found: true };
}

// What the impact sheet's Done does (design §1): the moment moves to the
// contact, and a toast says so when that's off the frame he drew on.
export function snapContact(masks: Masks, fDrawn: number, Pdraw: Vec2, S: number): Snap {
  const contact = contactFrame(masks, fDrawn, Pdraw, S);
  const moved = contact.frame !== fDrawn;
  return { ...contact, drawnOn: fDrawn, moved, toast: moved ? `Contact set to f${contact.frame}, drawn on f${fDrawn}` : null };
}

// ---- The impact point (R2 and the snap) ------------------------------------------------

// The point with the least total distance to all of them (Weiszfeld's
// iteration from the centroid): one stray end can't drag it, as it drags a mean.
export function geometricMedian(points: readonly Vec2[]): Vec2 {
  if (points.length === 0) throw new Error('geometricMedian needs at least one point');
  let x = points.reduce((s, p) => s + p[0], 0) / points.length;
  let y = points.reduce((s, p) => s + p[1], 0) / points.length;
  for (let i = 0; i < 200; i++) {
    let wx = 0;
    let wy = 0;
    let w = 0;
    for (const p of points) {
      const d = Math.hypot(p[0] - x, p[1] - y);
      if (d < 1e-9) continue; // standing on it: the others decide the step
      wx += p[0] / d;
      wy += p[1] / d;
      w += 1 / d;
    }
    if (w === 0) break; // every point is here
    const step = Math.hypot(wx / w - x, wy / w - y);
    x = wx / w;
    y = wy / w;
    if (step < 1e-6) break;
  }
  return [x, y];
}

// A cluster's middle, and its spread: the median distance to that middle.
function cluster(points: readonly Vec2[]) {
  const at = geometricMedian(points);
  return { at, spread: median(points.map((p) => dist(p, at))) };
}

// R2: the strokes' starts are one cluster and their ends another; the tighter
// one is where they meet, if it's within TIGHT·S. A tie (one stroke, or both
// as tight) goes to the one nearer the person on `mask`, then to the lower
// one, then to the starts: the hit is where the body meets the floor. With no
// tight cluster, P is the middle of every point drawn, and a problem says so.
export function drawnPoint(strokes: readonly DrawnLine[], mask: SamMask | null, S: number): { P: Vec2; from: End | 'all'; problems: string[] } {
  const lines = strokes.filter((s) => s.points.length > 0);
  if (!lines.length) throw new Error('the impact drawing has no points');
  const starts = cluster(lines.map((s) => xy(s.points[0])));
  const ends = cluster(lines.map((s) => xy(s.points[s.points.length - 1])));
  const tight = ([['start', starts], ['end', ends]] as const).filter(([, c]) => c.spread <= TIGHT * S);
  if (!tight.length) {
    const spread = Math.min(starts.spread, ends.spread) / S;
    return {
      P: geometricMedian(lines.flatMap((s) => s.points.map(xy))),
      from: 'all',
      problems: [`the impact strokes share no end (their tighter ends spread ${spread.toFixed(2)} S, more than ${TIGHT} S), so P is the middle of everything drawn`],
    };
  }
  let pick = tight[0];
  if (tight.length === 2) {
    const [a, b] = tight;
    if (Math.abs(a[1].spread - b[1].spread) > TIE * S) pick = a[1].spread <= b[1].spread ? a : b;
    else {
      const near = mask ? distanceToMask(mask, a[1].at) - distanceToMask(mask, b[1].at) : 0;
      const lower = b[1].at[1] - a[1].at[1];
      pick = near < 0 || (near === 0 && lower <= 0) ? a : b;
    }
  }
  return { P: pick[1].at, from: pick[0], problems: [] };
}

// The snap: P moves onto the person's lowest pixels in the ±SNAP·S column
// around it, on the contact frame, if they're within SNAP·S of it: to the
// middle of the run there nearest P, the bottom of the fist (heroclip G1).
// Null when nothing is that near.
export function snapToBody(p: Vec2, mask: SamMask | null, S: number): Vec2 | null {
  const low = mask && lowestRow(mask, p[0] - SNAP * S, p[0] + SNAP * S);
  if (!low) return null;
  const gap = ([a, b]: Vec2) => (p[0] < a ? a - p[0] : p[0] > b ? p[0] - b : 0);
  const run = low.runs.reduce((best, r) => (gap(r) < gap(best) ? r : best));
  const at: Vec2 = [(run[0] + run[1]) / 2, low.y];
  return dist(at, p) <= SNAP * S ? at : null;
}

// The end of a stroke at P (within AT_P·S), the nearer if both are; null when
// neither is, and the stroke is drawn whole (design §5).
export function fromP(points: readonly (readonly number[])[], P: Vec2, S: number): End | null {
  if (!points.length) return null;
  const a = dist(xy(points[0]), P);
  const b = dist(xy(points[points.length - 1]), P);
  if (Math.min(a, b) > AT_P * S) return null;
  return a <= b ? 'start' : 'end';
}

// P on contact frame I. R2's tie reads the mask he drew on (`drawnOn`, I by
// default), the snap the mask at I.
export function impactPoint(strokes: readonly DrawnLine[], masks: Masks, I: number, S: number, drawnOn = I): ImpactPoint {
  const drawn = drawnPoint(strokes, masks[drawnOn] ?? null, S);
  const snapped = snapToBody(drawn.P, masks[I] ?? null, S);
  const P = snapped ?? drawn.P;
  return { P, drawn: drawn.P, from: drawn.from, snapped: snapped !== null, ends: strokes.map((s) => fromP(s.points, P, S)), problems: drawn.problems };
}

// ---- The strike direction ----------------------------------------------------------------

// The fist region on one frame: the person's pixels in the ±COLUMN·S column
// under P, within FIST·S above that column's lowest row. Its centroid, or null.
function fistAt(m: SamMask | null | undefined, P: Vec2, S: number): Vec2 | null {
  if (!m) return null;
  const x0 = P[0] - COLUMN * S;
  const x1 = P[0] + COLUMN * S;
  const low = lowestRow(m, x0, x1);
  if (!low) return null;
  const { sx, sy } = grid(m);
  const [c0, c1] = cols(m, x0, x1);
  let n = 0;
  let x = 0;
  let y = 0;
  for (let row = m.height - 1; row >= 0; row--) {
    const cy = m.bounds.top + (row + 0.5) * sy;
    if (cy < low.y - FIST * S) break;
    for (let col = c0; col <= c1; col++) {
      if (!m.raster[row * m.width + col]) continue;
      n++;
      x += m.bounds.left + (col + 0.5) * sx;
      y += cy;
    }
  }
  return n ? [x / n, y / n] : null;
}

// d: how the fist region's centroid moved over I−3..I−1, if it moved MOVED·S
// or more (destruction §6.0). The lowest row alone is no good: on the hero its
// middle slides 14 px left on f84 as the fist flattens, 10° off. Then the mean
// direction from the limb tips to P; then straight down.
export function strikeDir(masks: Masks, I: number, P: Vec2, S: number, limbTips: readonly Vec2[] = []): StrikeDir {
  const a = fistAt(masks[I - 3], P, S);
  const b = fistAt(masks[I - 1], P, S);
  if (a && b) {
    const len = dist(a, b);
    if (len >= MOVED * S) return { dir: [(b[0] - a[0]) / len, (b[1] - a[1]) / len], by: 'fist' };
  }
  let sx = 0;
  let sy = 0;
  for (const t of limbTips) {
    const len = dist(t, P);
    if (len === 0) continue;
    sx += (P[0] - t[0]) / len;
    sy += (P[1] - t[1]) / len;
  }
  const len = Math.hypot(sx, sy);
  if (len > 1e-6) return { dir: [sx / len, sy / len], by: 'limbs' };
  return { dir: [0, 1], by: 'down' };
}

// ---- Where the impact sheet opens -------------------------------------------------------

// The strongest audio onset on frames from..to: the 10 ms envelope value that
// rises most above the previous 100 ms (their RMS), in dB, if it rises
// ONSET_DB or more. Value i starts at i·10 ms, on frame floor(i·10·30/1000).
function audioCue(envelope: readonly number[], from: number, to: number): number | null {
  const db = (v: number) => 20 * Math.log10(Math.max(v, 1e-5));
  let best: { f: number; rise: number } | null = null;
  for (let i = 1; i < envelope.length; i++) {
    const f = Math.floor((i * ENVELOPE_MS * FPS) / 1000);
    if (f < from || f > to) continue;
    let energy = 0;
    const span = Math.min(i, ONSET_SPAN);
    for (let k = i - span; k < i; k++) energy += envelope[k] * envelope[k];
    const rise = db(envelope[i]) - db(Math.sqrt(energy / span));
    if (rise >= ONSET_DB && (!best || rise > best.rise)) best = { f, rise };
  }
  return best?.f ?? null;
}

// The frame where the person's lowest point (full width) slows its fall the
// most, by STOP·S a frame or more, on frames from..to.
function maskCue(masks: Masks, from: number, to: number, S: number): number | null {
  const low = lowTrack(masks);
  let best: { f: number; slowed: number } | null = null;
  for (let f = Math.max(from, 2); f <= Math.min(to, masks.length - 1); f++) {
    const [a, b, c] = [low(f - 2), low(f - 1), low(f)];
    if (a === null || b === null || c === null || b - a <= 0) continue;
    const slowed = b - a - (c - b);
    if (slowed >= STOP * S && (!best || slowed > best.slowed)) best = { f, slowed };
  }
  return best?.f ?? null;
}

// Where the impact sheet opens (design §1). The contact detector needs his
// drawing, so it can't pick this frame; a cue within 10 frames of the hit is
// enough, since the snap finds the exact one. In order: the frame the scrubber
// is parked on, if it's at least f1 + 15; the strongest audio onset from
// f1 + 15 (`audio`: the clip's mono envelope, one RMS value per 10 ms); the
// person's sharpest stop from there; else f1 + 45. On the hero the onsets are
// the landing (f77) and the thump (f84.3), and the sharpest stop is f84.
export function suggestImpactFrame(o: { parked: number | null; f1: number; audio?: readonly number[] | null; masks: Masks; S: number }): { frame: number; by: 'parked' | 'audio' | 'mask' | 'fallback' } {
  const from = o.f1 + CUE_AFTER;
  const last = o.masks.length > 0 ? o.masks.length - 1 : Infinity;
  if (o.parked !== null && o.parked >= from) return { frame: o.parked, by: 'parked' };
  const heard = o.audio?.length ? audioCue(o.audio, from, last) : null;
  if (heard !== null) return { frame: heard, by: 'audio' };
  const seen = maskCue(o.masks, from, last, o.S);
  if (seen !== null) return { frame: seen, by: 'mask' };
  return { frame: Math.min(o.f1 + CUE_FALLBACK, last), by: 'fallback' };
}

// ---- Both drawings, as moments -----------------------------------------------------------

// A slam's seed when the effect doesn't set one: FNV-1a of its impact stroke ids.
export const impactSeed = (ids: readonly number[]): number => fnv1a32(...ids);

export interface Drawings {
  limbs: readonly DrawnLine[]; // the limb drawing, frame px on f1
  f1: number; // the frame the limbs were drawn on: they grow out there
  cracks: readonly DrawnLine[]; // the impact drawing, frame px
  fDrawn: number; // the frame the impact was drawn on
  masks: Masks; // the cached person masks, one per frame
  S: number; // the frame's short side, px
  seed?: number; // slam.seed; missing = impactSeed of the crack ids
  turn?: Turn; // his optional turn tap: it overrides the turn read from the pose track; passed through
}

export interface DrawnMoments {
  emerge: EmergeMoment;
  slam: Moment;
  turn?: Turn;
  snap: Snap; // the contact, and the toast when it moved
  point: ImpactPoint;
  strike: StrikeDir;
  problems: string[]; // R1, and an impact drawing with no shared end
}

// The two drawings as moments, and nothing else asked of him: no taps. The
// contact snaps first, so slam.at is the detected frame, and P and d are read
// on it. One slam, by his body: the limbs land on P first, on I − 7, and his
// fist on I (Qai, Oct 29).
export function momentsFromDrawings(o: Drawings): DrawnMoments {
  const { masks, S, f1, fDrawn } = o;
  const drawn = drawnPoint(o.cracks, masks[fDrawn] ?? null, S); // centres the detector's column
  const snap = snapContact(masks, fDrawn, drawn.P, S);
  const I = snap.frame;
  const point = impactPoint(o.cracks, masks, I, S, fDrawn);
  const tips = o.limbs.filter((l) => l.points.length > 0).map((l) => xy(l.points[l.points.length - 1]));
  const strike = strikeDir(masks, I, point.P, S, tips);
  const problems = [...point.problems];
  if (I < f1 + R1_GAP) problems.push(`${R1_MESSAGE}: they grow out on f${f1}, so the contact needs f${f1 + R1_GAP} or later (it is f${I})`);
  const limbs = o.limbs.map((l) => l.id);
  const strokes = o.cracks.map((c) => c.id);
  const emerge: EmergeMoment = { kind: 'emerge', at: f1 / FPS, strokes: limbs };
  const slam: Moment = {
    kind: 'slam',
    at: I / FPS,
    xy: point.P,
    by: 'body',
    dir: strike.dir,
    seed: o.seed ?? impactSeed(strokes),
    strokes,
    limbs,
    frames: { ...SLAM_FRAMES },
    aftermath: { ...SLAM_AFTERMATH },
  };
  return { emerge, slam, ...(o.turn ? { turn: o.turn } : {}), snap, point, strike, problems };
}
