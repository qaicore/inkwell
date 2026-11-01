// The export's flash check (impact design §5, "Gentle mode"; WCAG 2.3.1,
// general and red flashes, area based). The export copies every finished
// frame down to 160 px wide (downsampleFrame) and checks the copies:
//   - Per pixel: the WCAG relative luminance L, and the red value
//     Q = 320·max(0, R − G − B) on linear R, G, B.
//   - Fields: the 10° visual field is a circle 0.78 S across (S, the frame's
//     short side), centred every 0.1 S. The part of a circle off the frame
//     never flashes, so a field's share is out of the whole circle.
//   - A transition: L moves 0.10 or more, with the darker side below 0.80, over
//     25 % or more of a field. Each pixel tracks its extreme, the brightest or
//     darkest it has been since its own last transition, so a ramp is one
//     transition however many frames it takes (a 2-frame ramp is not a ladder
//     step). A field transitions when 25 % of it has turned the same way since
//     the field last did, and then waits for the opposite way, so a field's
//     transitions alternate: two rises with nothing darker between them are
//     one, however long the pause. (Design §5's table lists the return at j 9
//     and wash 1's rise as two; they count once, see the tests.)
//   - A red transition: Q moves more than 20 to or from a saturated red
//     (linear R/(R+G+B) ≥ 0.8), over 25 % or more of a field.
//   - A flash is a pair of opposing transitions. In every 1 s window, a field
//     with n transitions has floor(n/2) flashes.
// It passes with at most 3 general flashes and no red flash in every window
// (design §5, G5; WCAG itself allows 3 red ones). The export runs it on every
// clip (decision 5; WP13 wires it): full flashing is the default, and there a
// fail only shows the plain warning beside the Reduce flashing toggle; with
// Reduce flashing on, the export walks the 7-step ladder and throws
// FlashCheckError if the last step still fails.
import { linear } from '../impact/palette.ts';

export const CHECK_WIDTH = 160; // px: the frames are checked this wide
export const FIELD_DIAMETER = 0.78; // × S: the 10° field, 5.2 cm at ~30 cm on a phone
export const FIELD_STEP = 0.1; // × S: field centres
export const FIELD_SHARE = 0.25; // of a field: the least a transition covers
export const MIN_CHANGE = 0.1; // ΔL of a general transition ...
export const DARK_BELOW = 0.8; // ... whose darker side is below this
export const RED_RATIO = 0.8; // saturated red: linear R/(R+G+B) at least this
export const RED_SCALE = 320; // Q = RED_SCALE·max(0, R − G − B)
export const RED_CHANGE = 20; // ΔQ of a red transition: more than this
export const MAX_GENERAL = 3; // general flashes allowed in any second
export const MAX_RED = 0; // red flashes allowed in any second

// "0.10 or more" still holds for a change that float rounding left at 0.0999…
const CHANGE = MIN_CHANGE - 1e-9;
// 8-bit sRGB → linear light, and each channel's share of L.
const LIN = Float64Array.from({ length: 256 }, (_, i) => linear(i));
const LR = LIN.map((l) => 0.2126 * l);
const LG = LIN.map((l) => 0.7152 * l);
const LB = LIN.map((l) => 0.0722 * l);
// A pixel's code in an event image: ups count in the low 16 bits and downs in
// the high ones, so one running sum along a row counts both.
const UP = 1;
const DOWN = 0x10000;
const MAX_WIDTH = 0xffff; // px: a row's counts fit their 16 bits
// A pass over the frame costs about this many steps through one leaver's
// fields, per pixel (measured on noise and on red flicker, Node 24).
const PASS_COST = 1.5;

// An RGBA frame, row-major, 4 bytes a pixel: ImageData has this shape. The
// alpha byte is ignored; the frames are opaque video.
export interface CheckFrame {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export type FlashKind = 'general' | 'red';

export interface FlashTransition {
  frame: number; // the first frame showing the new state; frames count from 0, the first one checked
  field: number; // index into FlashReport.fields
  direction: 1 | -1; // brighter or darker; for red, redder or less red
  kind: FlashKind;
}

// One 1 s window and its worst field's flashes.
export interface FlashWindow {
  start: number; // first frame
  end: number; // last frame, included
  general: number;
  red: number;
}

export interface FlashField {
  x: number; // centre, check-frame px
  y: number;
  general: number; // flashes in its worst window
  red: number;
}

export interface FlashReport {
  frames: number; // how many were checked
  fps: number;
  window: number; // frames in a 1 s window: ceil(fps)
  width: number; // the checked frames' size, px
  height: number;
  radius: number; // a field's radius, px: 0.39 S
  worstGeneral: number; // the most general flashes in any window of any field
  worstRed: number;
  windows: FlashWindow[]; // every window, in order
  transitions: FlashTransition[]; // every field's, in frame order
  fields: FlashField[];
  pass: boolean; // worstGeneral ≤ 3 and worstRed = 0
}

export interface FlashChecker {
  push(frame: CheckFrame): void; // the next frame, in order
  report(): FlashReport; // the frames so far
}

// Thrown by the export when Reduce flashing is on and the ladder's last step
// still fails, which means the footage flashes on its own (design §5). It
// carries the report; nothing is saved.
export class FlashCheckError extends Error {
  readonly report: FlashReport;
  constructor(report: FlashReport, message = flashSummary(report)) {
    super(message);
    this.name = 'FlashCheckError';
    this.report = report;
  }
}

// Checks a whole clip. Every frame must be the same size; 160 px wide is what
// the fields and the 2 ms budget are made for, but any size up to 65535 px
// wide works.
export function checkFlashes(frames: Iterable<CheckFrame>, fps: number): FlashReport {
  let checker: FlashChecker | null = null;
  for (const frame of frames) {
    checker ??= flashChecker(frame.width, frame.height, fps);
    checker.push(frame);
  }
  return checker ? checker.report() : emptyReport(validFps(fps));
}

// The check one frame at a time, so the export can feed it while it encodes
// instead of keeping every frame. report() can be called at any point.
export function flashChecker(width: number, height: number, fps: number): FlashChecker {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error(`flash check frames need a whole-pixel size (got ${width} × ${height})`);
  if (width > MAX_WIDTH) throw new Error(`flash check frames are at most ${MAX_WIDTH} px wide (got ${width}); check them ${CHECK_WIDTH} px wide`);
  const rate = validFps(fps);
  const grid = fieldGrid(width, height);
  const n = width * height;
  const F = grid.centres.length;
  const need = FIELD_SHARE * grid.area; // pixels in 25 % of a field
  const { spanStart, spans, memberStart, members } = grid;
  const stride = width + 1; // a row of the prefix image

  // Per pixel: the general (g) and red (r) state. dir is the way its last
  // transition went (0 before the first), at the frame it happened on. hi and
  // lo are the extremes since then: after a rise only hi is kept, and after a
  // fall only lo. For red, hiSat and loSat are the extremes over the
  // saturated-red states only (±Infinity when there were none).
  const gDir = new Int8Array(n);
  const gAt = new Int32Array(n).fill(-1);
  const gHi = new Float64Array(n);
  const gLo = new Float64Array(n);
  const rDir = new Int8Array(n);
  const rAt = new Int32Array(n).fill(-1);
  const rHi = new Float64Array(n);
  const rLo = new Float64Array(n);
  const rHiSat = new Float64Array(n);
  const rLoSat = new Float64Array(n);
  const gCode = new Int32Array(n); // this frame's pixel transitions, as UP, DOWN or 0
  const rCode = new Int32Array(n);
  const pre = new Uint32Array(stride * height); // per row, running sums of an event image's codes

  const general = fieldStates(F, n);
  const red = fieldStates(F, n);
  const transitions: FlashTransition[] = [];
  let count = 0;

  // Row by row running sums of an event image, so the ups and downs over any
  // span of a row are one subtraction.
  const prefix = (codes: Int32Array) => {
    for (let y = 0, i = 0, o = 0; y < height; y++) {
      let sum = 0;
      pre[o++] = 0;
      for (let x = 0; x < width; x++) {
        sum += codes[i++];
        pre[o++] = sum;
      }
    }
  };

  // Adds `sign` × the counts over field f's spans to its tallies.
  const add = (state: FieldStates, f: number, sign: number) => {
    let ups = 0;
    let downs = 0;
    for (let s = spanStart[f], end = spanStart[f + 1]; s < end; s += 2) {
      const v = pre[spans[s + 1]] - pre[spans[s]];
      ups += v & 0xffff;
      downs += v >>> 16;
    }
    state.up[f] += sign * ups;
    state.down[f] += sign * downs;
  };

  const perPixel = members.length / n; // the fields a pixel is in, about 48
  const order = Int32Array.from({ length: F }, (_, f) => f); // the fields, latest last transition first
  const scratch = new Int32Array(n); // the passes' image of leavers; all 0 between releases
  const byAt = new Int32Array(n); // a release's leavers, latest entry first
  let mark = new Int32Array(0); // by frame: the release that last met a leaver from it ...
  let rank = new Int32Array(0); // ... and the frame's place among that release's entry frames
  let stamp = 0;

  // Takes this frame's leavers off the fields that count them: those whose
  // last transition came before the leaver's state began. A few go one at a
  // time, through the fields each one is in (about 48 each).
  const release = (state: FieldStates) => {
    const m = state.left;
    if (m === 0) return;
    state.left = 0;
    if (m * perPixel > n && inPasses(state, m)) return;
    const { leftPixel, leftCode, leftAt, since } = state;
    for (let i = 0; i < m; i++) {
      const p = leftPixel[i];
      const at = leftAt[i];
      const tally = leftCode[i] === UP ? state.up : state.down;
      for (let k = memberStart[p], end = memberStart[p + 1]; k < end; k++) {
        const f = members[k];
        tally[f] -= (since[f] - at) >>> 31; // 1 when at > since[f]
      }
    }
  };

  // Many leavers (noise, flickering fire) go in passes over the frame
  // instead, when that costs less: by the frame their states began, latest
  // first, each group joins an image of leavers, and its prefix comes off the
  // run of fields, by last transition, that count exactly the leavers so far.
  // False leaves them to go one at a time.
  const inPasses = (state: FieldStates, m: number): boolean => {
    const { leftPixel, leftCode, leftAt, since } = state;
    if (mark.length < count) {
      const size = Math.max(count, 2 * mark.length);
      const grown = new Int32Array(size);
      grown.set(mark);
      mark = grown;
      rank = new Int32Array(size);
    }
    stamp++;
    const ats: number[] = []; // the entry frames, once each
    for (let i = 0; i < m; i++) {
      const at = leftAt[i];
      if (mark[at] !== stamp) {
        mark[at] = stamp;
        ats.push(at);
      }
    }
    const q = ats.length;
    ats.sort((a, b) => b - a);
    order.sort((a, b) => since[b] - since[a]);
    // ats[i]'s run: the fields whose last transition is in [ats[i + 1], ats[i]).
    let first = 0;
    while (first < F && since[order[first]] >= ats[0]) first++; // they count none
    let passes = 0;
    for (let i = 0, k = first; i < q && k < F; i++) {
      const next = i + 1 < q ? ats[i + 1] : -Infinity;
      if (since[order[k]] < next) continue;
      passes++;
      while (k < F && since[order[k]] >= next) k++;
    }
    if (passes * n * PASS_COST >= m * perPixel) return false;

    // The leavers by entry frame, latest first.
    for (let i = 0; i < q; i++) rank[ats[i]] = i;
    const starts = new Int32Array(q + 1);
    for (let j = 0; j < m; j++) starts[rank[leftAt[j]] + 1]++;
    for (let i = 0; i < q; i++) starts[i + 1] += starts[i];
    const put = starts.slice(0, q);
    for (let j = 0; j < m; j++) byAt[put[rank[leftAt[j]]]++] = j;
    let added = 0; // byAt[0 .. added) are in the image
    for (let i = 0, k = first; i < q && k < F; i++) {
      for (; added < starts[i + 1]; added++) {
        const j = byAt[added];
        scratch[leftPixel[j]] = leftCode[j];
      }
      const next = i + 1 < q ? ats[i + 1] : -Infinity;
      if (since[order[k]] < next) continue; // no field in this run
      prefix(scratch);
      for (; k < F && since[order[k]] >= next; k++) add(state, order[k], -1);
    }
    for (let x = 0; x < added; x++) scratch[leftPixel[byAt[x]]] = 0;
    return true;
  };

  // Takes this frame's leavers off, adds its pixel transitions to each field,
  // then flips the fields that have reached 25 % the way they were waiting
  // for.
  const settle = (state: FieldStates, codes: Int32Array, t: number, kind: FlashKind) => {
    release(state);
    prefix(codes);
    const { dir, since, up, down, times } = state;
    let minSince = t;
    for (let f = 0; f < F; f++) {
      add(state, f, 1);
      const ups = up[f];
      const downs = down[f];
      const was = dir[f];
      let flip = 0;
      if (was !== 1 && ups >= need) flip = 1;
      if (was !== -1 && downs >= need && (flip === 0 || downs > ups)) flip = -1;
      if (flip !== 0) {
        dir[f] = flip;
        since[f] = t;
        up[f] = 0;
        down[f] = 0;
        times[f].push(t);
        transitions.push({ frame: t, field: f, direction: flip as 1 | -1, kind });
      }
      if (since[f] < minSince) minSince = since[f];
    }
    state.minSince = minSince;
  };

  // The first frame only sets every pixel's extremes.
  const start = (d: CheckFrame['data']) => {
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      const R = LIN[d[i]];
      const G = LIN[d[i + 1]];
      const B = LIN[d[i + 2]];
      const sum = R + G + B;
      const sat = sum > 0 && R >= RED_RATIO * sum;
      const q = R > G + B ? RED_SCALE * (R - G - B) : 0;
      gHi[p] = gLo[p] = LR[d[i]] + LG[d[i + 1]] + LB[d[i + 2]];
      rHi[p] = rLo[p] = q;
      rHiSat[p] = sat ? q : -Infinity;
      rLoSat[p] = sat ? q : Infinity;
    }
  };

  const push = (frame: CheckFrame) => {
    if (frame.width !== width || frame.height !== height) throw new Error(`flash check frames must all be ${width} × ${height} (frame ${count} is ${frame.width} × ${frame.height})`);
    const d = frame.data;
    if (d.length < 4 * n) throw new Error(`flash check frame ${count} has ${d.length} bytes, not ${4 * n} (RGBA, ${width} × ${height})`);
    const t = count++;
    if (t === 0) return start(d);
    // A pixel that turns again leaves the state it entered at gAt or rAt. Only
    // a field whose last transition came before that counts it, and none did
    // before the earliest field's.
    const gMin = general.minSince;
    const rMin = red.minSince;
    const { leftPixel: gLeftPixel, leftCode: gLeftCode, leftAt: gLeftAt } = general;
    const { leftPixel: rLeftPixel, leftCode: rLeftCode, leftAt: rLeftAt } = red;
    let gLeft = 0;
    let rLeft = 0;
    let gAny = false;
    let rAny = false;
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      const r8 = d[i];
      const g8 = d[i + 1];
      const b8 = d[i + 2];

      // General: after a rise, a fall of 0.10 from the brightest since, to
      // below 0.80; after a fall, a rise of 0.10 from the darkest since, if
      // that was below 0.80; before the first, the larger of the two.
      const L = LR[r8] + LG[g8] + LB[b8];
      const gd = gDir[p];
      let gc = 0;
      if (gd > 0) {
        const hi = gHi[p];
        if (L > hi) gHi[p] = L;
        else if (L < DARK_BELOW && hi - L >= CHANGE) gc = DOWN;
      } else if (gd < 0) {
        const lo = gLo[p];
        if (L < lo) gLo[p] = L;
        else if (lo < DARK_BELOW && L - lo >= CHANGE) gc = UP;
      } else {
        let hi = gHi[p];
        let lo = gLo[p];
        if (L > hi) gHi[p] = hi = L;
        if (L < lo) gLo[p] = lo = L;
        const fall = L < DARK_BELOW ? hi - L : -1;
        const rise = lo < DARK_BELOW ? L - lo : -1;
        if (fall >= CHANGE || rise >= CHANGE) gc = rise >= fall ? UP : DOWN;
      }
      if (gc !== 0) {
        if (gd !== 0 && gAt[p] > gMin) {
          gLeftPixel[gLeft] = p;
          gLeftCode[gLeft] = gd > 0 ? UP : DOWN;
          gLeftAt[gLeft++] = gAt[p];
        }
        gAt[p] = t;
        if (gc === UP) {
          gDir[p] = 1;
          gHi[p] = L;
        } else {
          gDir[p] = -1;
          gLo[p] = L;
        }
        gAny = true;
      }
      gCode[p] = gc;

      // Red: the same on Q, where one end of the change must be saturated
      // red: from any state if this one is, else from the saturated extreme.
      // R > G + B needs r8 above g8 and b8, so most pixels never look up their
      // linear values. A pixel with no red in it (Q 0, which no saturated red
      // is) can only fall, from a saturated red, so most skip the rest.
      let q = 0;
      let sat = false;
      if (r8 > g8 && r8 > b8) {
        const R = LIN[r8];
        const G = LIN[g8];
        const B = LIN[b8];
        q = R > G + B ? RED_SCALE * (R - G - B) : 0;
        sat = q > 0 && R >= RED_RATIO * (R + G + B);
      }
      const rd = rDir[p];
      if (q === 0) {
        rLo[p] = 0;
        if (rd < 0 || rHiSat[p] <= RED_CHANGE) {
          rCode[p] = 0;
          continue;
        }
      }
      let rc = 0;
      if (rd > 0) {
        let hi = rHi[p];
        let hiSat = rHiSat[p];
        if (q > hi) rHi[p] = hi = q;
        if (sat && q > hiSat) rHiSat[p] = hiSat = q;
        if ((sat ? hi : hiSat) - q > RED_CHANGE) rc = DOWN;
      } else if (rd < 0) {
        let lo = rLo[p];
        let loSat = rLoSat[p];
        if (q < lo) rLo[p] = lo = q;
        if (sat && q < loSat) rLoSat[p] = loSat = q;
        if (q - (sat ? lo : loSat) > RED_CHANGE) rc = UP;
      } else {
        let hi = rHi[p];
        let lo = rLo[p];
        let hiSat = rHiSat[p];
        let loSat = rLoSat[p];
        if (q > hi) rHi[p] = hi = q;
        if (q < lo) rLo[p] = lo = q;
        if (sat) {
          if (q > hiSat) rHiSat[p] = hiSat = q;
          if (q < loSat) rLoSat[p] = loSat = q;
        }
        const fall = (sat ? hi : hiSat) - q;
        const rise = q - (sat ? lo : loSat);
        if (fall > RED_CHANGE || rise > RED_CHANGE) rc = rise >= fall ? UP : DOWN;
      }
      if (rc !== 0) {
        if (rd !== 0 && rAt[p] > rMin) {
          rLeftPixel[rLeft] = p;
          rLeftCode[rLeft] = rd > 0 ? UP : DOWN;
          rLeftAt[rLeft++] = rAt[p];
        }
        rAt[p] = t;
        if (rc === UP) {
          rDir[p] = 1;
          rHi[p] = q;
          rHiSat[p] = sat ? q : -Infinity;
        } else {
          rDir[p] = -1;
          rLo[p] = q;
          rLoSat[p] = sat ? q : Infinity;
        }
        rAny = true;
      }
      rCode[p] = rc;
    }
    general.left = gLeft;
    red.left = rLeft;
    // A field's tallies only grow on frames with pixel transitions, so a
    // quiet frame flips nothing.
    if (gAny) settle(general, gCode, t, 'general');
    if (rAny) settle(red, rCode, t, 'red');
  };

  const report = (): FlashReport => {
    const window = windowFrames(rate);
    const starts = count === 0 ? 0 : Math.max(1, count - window + 1);
    const gWorst = new Int32Array(starts);
    const rWorst = new Int32Array(starts);
    const fields = grid.centres.map(([x, y], f): FlashField => ({ x, y, general: sweep(general.times[f], starts, window, gWorst), red: sweep(red.times[f], starts, window, rWorst) }));
    const windows = Array.from({ length: starts }, (_, w): FlashWindow => ({ start: w, end: Math.min(count, w + window) - 1, general: gWorst[w], red: rWorst[w] }));
    const worstGeneral = Math.max(0, ...fields.map((f) => f.general));
    const worstRed = Math.max(0, ...fields.map((f) => f.red));
    return {
      frames: count,
      fps: rate,
      window,
      width,
      height,
      radius: grid.radius,
      worstGeneral,
      worstRed,
      windows,
      transitions: transitions.slice(),
      fields,
      pass: worstGeneral <= MAX_GENERAL && worstRed <= MAX_RED,
    };
  };

  return { push, report };
}

// The check in one plain sentence, for the export sheet's warning and for
// FlashCheckError. It names the worst second's frames, counted from the
// first one checked.
export function flashSummary(report: FlashReport): string {
  // The first window holding the worst; one always does when it is above 0.
  const frames = (worst: number, of: (w: FlashWindow) => number) => {
    const w = report.windows.find((x) => of(x) === worst)!;
    return `frames ${w.start}–${w.end}`;
  };
  const parts: string[] = [];
  if (report.worstGeneral > MAX_GENERAL) parts.push(`flashes more than ${MAX_GENERAL} times a second (${report.worstGeneral} times in ${frames(report.worstGeneral, (w) => w.general)})`);
  if (report.worstRed > MAX_RED) {
    const what = report.worstRed === 1 ? 'has a saturated red flash' : `has ${report.worstRed} saturated red flashes in one second`;
    parts.push(`${what} (${frames(report.worstRed, (w) => w.red)})`);
  }
  if (parts.length > 0) return `This video ${parts.join(' and ')}.`;
  if (report.worstGeneral === 0) return 'This video does not flash.';
  return `This video flashes at most ${report.worstGeneral === 1 ? 'once' : `${report.worstGeneral} times`} in any second, with no red flash.`;
}

// A frame copied down to `width` px wide, its height in proportion, for the
// check. Each pixel is the mean of the pixels in its box taken in linear
// light, the way light adds up in the eye, so a fine black-and-white pattern
// checks as the mid grey it looks like, not as the darker mean of its sRGB
// values. A frame already that narrow comes back as it is.
export function downsampleFrame(frame: CheckFrame, width = CHECK_WIDTH): CheckFrame {
  const { width: W, height: H, data } = frame;
  if (W <= width) return frame;
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round((H * w) / W));
  const col = Int32Array.from({ length: W }, (_, x) => Math.floor((x * w) / W));
  const sums = new Float64Array(3 * w * h);
  const counts = new Int32Array(w * h);
  for (let y = 0; y < H; y++) {
    const row = Math.floor((y * h) / H) * w;
    for (let x = 0, i = 4 * y * W; x < W; x++, i += 4) {
      const o = row + col[x];
      sums[3 * o] += LIN[data[i]];
      sums[3 * o + 1] += LIN[data[i + 1]];
      sums[3 * o + 2] += LIN[data[i + 2]];
      counts[o]++;
    }
  }
  const out = new Uint8ClampedArray(4 * w * h);
  for (let o = 0; o < w * h; o++) {
    out[4 * o] = toByte(sums[3 * o] / counts[o]);
    out[4 * o + 1] = toByte(sums[3 * o + 1] / counts[o]);
    out[4 * o + 2] = toByte(sums[3 * o + 2] / counts[o]);
    out[4 * o + 3] = 255;
  }
  return { data: out, width: w, height: h };
}

// ---- Internals ------------------------------------------------------------------------

interface FieldStates {
  dir: Int8Array; // the way its last transition went; 0 before the first
  since: Int32Array; // the frame of its last transition; −1 before the first
  up: Int32Array; // pixels that turned brighter since then and still are
  down: Int32Array; // pixels that turned darker since then and still are
  times: number[][]; // its transition frames
  minSince: number; // the earliest `since` of any field
  // This frame's pixels that left a state a field may still count, the first
  // `left` of them: the pixel, the state it left (UP or DOWN) and the frame
  // it had entered that state on.
  left: number;
  leftPixel: Int32Array;
  leftCode: Int32Array;
  leftAt: Int32Array;
}

const fieldStates = (F: number, n: number): FieldStates => ({
  dir: new Int8Array(F),
  since: new Int32Array(F).fill(-1),
  up: new Int32Array(F),
  down: new Int32Array(F),
  times: Array.from({ length: F }, () => []),
  minSince: -1,
  left: 0,
  leftPixel: new Int32Array(n),
  leftCode: new Int32Array(n),
  leftAt: new Int32Array(n),
});

interface FieldGrid {
  centres: [number, number][]; // px, row by row
  radius: number; // px
  area: number; // pixel positions inside a whole circle, on the frame or not
  spanStart: Int32Array; // field f's rows are spans[spanStart[f] .. spanStart[f + 1]) ...
  spans: Int32Array; // ... as pairs of prefix-image indices (width + 1 a row): the row's sums before x0, and through x1
  memberStart: Int32Array; // pixel p is in the fields members[memberStart[p] .. memberStart[p + 1])
  members: Uint16Array;
}

// Field centres every 0.1 S, the grid centred on the frame; a pixel is in a
// field when it lies within 0.39 S of its centre.
function fieldGrid(width: number, height: number): FieldGrid {
  const S = Math.min(width, height);
  const radius = (FIELD_DIAMETER / 2) * S;
  const step = Math.max(1, Math.round(FIELD_STEP * S));
  const axis = (size: number) => {
    const count = Math.floor((size - 1) / step) + 1;
    const first = Math.floor((size - 1 - (count - 1) * step) / 2);
    return Array.from({ length: count }, (_, i) => first + i * step);
  };
  const xs = axis(width);
  const centres = axis(height).flatMap((y) => xs.map((x): [number, number] => [x, y]));
  if (centres.length > 0xffff) throw new Error(`too many flash fields (${centres.length}); check frames ${CHECK_WIDTH} px wide`);
  const R = Math.floor(radius);
  const half = Int32Array.from({ length: R + 1 }, (_, dy) => Math.floor(Math.sqrt(radius * radius - dy * dy)));
  let area = 0;
  for (let dy = -R; dy <= R; dy++) area += 2 * half[Math.abs(dy)] + 1;

  const stride = width + 1;
  const spanList: number[] = [];
  const spanStart = new Int32Array(centres.length + 1);
  const memberStart = new Int32Array(width * height + 1);
  centres.forEach(([cx, cy], f) => {
    spanStart[f] = spanList.length;
    for (let dy = -R; dy <= R; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= height) continue;
      const x0 = Math.max(0, cx - half[Math.abs(dy)]);
      const x1 = Math.min(width - 1, cx + half[Math.abs(dy)]);
      if (x0 > x1) continue;
      spanList.push(y * stride + x0, y * stride + x1 + 1);
      for (let x = x0; x <= x1; x++) memberStart[y * width + x + 1]++;
    }
  });
  spanStart[centres.length] = spanList.length;
  for (let p = 0; p < width * height; p++) memberStart[p + 1] += memberStart[p];
  const spans = Int32Array.from(spanList);
  const members = new Uint16Array(memberStart[width * height]);
  const fill = memberStart.slice(0, width * height);
  for (let f = 0; f < centres.length; f++) {
    for (let s = spanStart[f]; s < spanStart[f + 1]; s += 2) {
      const y = Math.floor(spans[s] / stride); // pixel y·width + x sits at prefix index y·stride + x
      for (let a = spans[s]; a < spans[s + 1]; a++) members[fill[a - y]++] = f;
    }
  }
  return { centres, radius, area, spanStart, spans, memberStart, members };
}

// One field's transition frames → its most flashes in any window, also
// raising each window's worst in `worst`.
function sweep(times: readonly number[], starts: number, window: number, worst: Int32Array): number {
  let most = 0;
  let lo = 0;
  let hi = 0;
  for (let w = 0; w < starts; w++) {
    while (lo < times.length && times[lo] < w) lo++;
    while (hi < times.length && times[hi] < w + window) hi++;
    const flashes = (hi - lo) >> 1;
    if (flashes > worst[w]) worst[w] = flashes;
    if (flashes > most) most = flashes;
  }
  return most;
}

// A 1 s window is ceil(fps) frames, so at 29.97 fps it is never short of a second.
const windowFrames = (fps: number) => Math.max(1, Math.ceil(fps - 1e-9));

function validFps(fps: number): number {
  if (!Number.isFinite(fps) || fps <= 0) throw new Error(`the flash check needs a frame rate above 0 (got ${fps})`);
  return fps;
}

function emptyReport(fps: number): FlashReport {
  return { frames: 0, fps, window: windowFrames(fps), width: 0, height: 0, radius: 0, worstGeneral: 0, worstRed: 0, windows: [], transitions: [], fields: [], pass: true };
}

// Linear light → the nearest 8-bit sRGB value.
function toByte(l: number): number {
  let lo = 0;
  let hi = 255;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (LIN[mid] < l) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && l - LIN[lo - 1] < LIN[lo] - l ? lo - 1 : lo;
}
