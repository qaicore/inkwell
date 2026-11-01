// WP1: the moments from the two drawings (impact design §1, src/impact/detect.ts).
// Everything runs on synthetic masks, except the hero block at the end: it
// decodes the cached SAM person masks (fixtures/probe/sam-person.json, about
// 12 s) and reads the stand-in test drawings from the file that
// INKWELL_TEST_DRAWINGS names (impact/test-drawings.json in the notes). It
// skips when either is missing.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  R1_GAP,
  R1_MESSAGE,
  SLAM_AFTERMATH,
  SLAM_FRAMES,
  contactFrame,
  contactsIn,
  distanceToMask,
  drawnPoint,
  fromP,
  geometricMedian,
  impactPoint,
  impactSeed,
  lowTrack,
  lowestRow,
  momentsFromDrawings,
  snapContact,
  snapToBody,
  strikeDir,
  suggestImpactFrame,
  type DrawnLine,
} from '../../src/impact/detect.ts';
import { fnv1a32 } from '../../src/impact/rng.ts';
import { masksFromCache, type SamMask } from '../../src/sam/cache.ts';
import { parseEffect, serializeEffect, type Effect, type Stroke, type Vec2 } from '../../src/types/effect.ts';
import { HERO, HERO_CRACKS, MESSY_KINDS, messyDrawing } from './helpers/impact-drawings.ts';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const S = 1080; // the hero's short side
const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const degBetween = (a: Vec2, b: Vec2) => (Math.abs(Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1])) * 180) / Math.PI;

// ---- Synthetic masks ------------------------------------------------------------------

type Box = [number, number, number, number]; // x0, y0, x1, y1: frame px, half-open

// A cached mask stand-in: the union of boxes as a raster over their bounding
// box, `step` frame px a raster pixel (SAM's rasters aren't always 1:1).
function boxMask(boxes: readonly Box[], step = 1): SamMask {
  const left = Math.min(...boxes.map((b) => b[0]));
  const top = Math.min(...boxes.map((b) => b[1]));
  const width = Math.ceil((Math.max(...boxes.map((b) => b[2])) - left) / step);
  const height = Math.ceil((Math.max(...boxes.map((b) => b[3])) - top) / step);
  const raster = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) {
    const y = top + (row + 0.5) * step;
    for (let col = 0; col < width; col++) {
      const x = left + (col + 0.5) * step;
      if (boxes.some(([x0, y0, x1, y1]) => x >= x0 && x < x1 && y >= y0 && y < y1)) raster[row * width + col] = 1;
    }
  }
  return { width, height, raster, bounds: { left, top, right: left + width * step, bottom: top + height * step } };
}

// A fist 26 px wide under P (x 930–956) whose bottom is bottoms[f] on frame f.
const fist = (bottoms: readonly number[], step = 1, extra: (f: number) => Box[] = () => []) =>
  bottoms.map((b, f) => boxMask([[930, b - 60, 956, b], ...extra(f)], step));

// The bottom falls 61, 46, 31, 6, 1 px on frames at, at+1, … (S 1080), then rests:
// contact is the frame of the 6, at + 3.
function slamBottoms(at: number, frames: number, rest = 880): number[] {
  const falls = [61, 46, 31, 6, 1];
  const out: number[] = [];
  let y = rest;
  for (let f = 0; f < frames; f++) {
    if (f >= at && f < at + falls.length) y += falls[f - at];
    out.push(y);
  }
  return out;
}

// Him on the contact frame, after the hero's f84: torso and thigh, forearm, and
// the fist on the floor, whose lowest row is 1062 (centre 1062.5) at x 935–950,
// so its middle is (943, 1062.5).
const HERO_BODY: Box[] = [[880, 453, 1000, 1000], [925, 1000, 960, 1056], [935, 1056, 951, 1063]];
const FIST_BOTTOM: Vec2 = [943, 1062.5];
const body84 = () => boxMask(HERO_BODY);

const line = (id: number, points: Vec2[]): DrawnLine => ({ id, points });
const reversed = (l: DrawnLine): DrawnLine => ({ id: l.id, points: [...l.points].reverse() });

// ---- The contact frame ----------------------------------------------------------------

describe('contactFrame: the G1 detector', () => {
  const P: Vec2 = [943, 1000];
  const masks = fist(slamBottoms(10, 26)); // contact on f13

  it('finds contact on the frame of the 6 after falls of 61, 46 and 31 px', () => {
    expect(contactFrame(masks, 13, P, S)).toEqual({ frame: 13, found: true });
    expect(contactsIn(lowTrack(masks, P[0] - 108, P[0] + 108), 0, 25, S)).toEqual([13]);
  });

  it('searches 10 frames either side of the drawn frame', () => {
    expect(contactFrame(masks, 3, P, S)).toEqual({ frame: 13, found: true });
    expect(contactFrame(masks, 23, P, S)).toEqual({ frame: 13, found: true });
    expect(contactFrame(masks, 2, P, S)).toEqual({ frame: 2, found: false });
    expect(contactFrame(masks, 24, P, S)).toEqual({ frame: 24, found: false });
  });

  it('finds none for a blob that never stops, and keeps the drawn frame', () => {
    const falling = fist(Array.from({ length: 31 }, (_, f) => 300 + 30 * f));
    expect(contactFrame(falling, 15, P, S)).toEqual({ frame: 15, found: false });
  });

  it('needs the fast fall first: a slow one that stops is no contact', () => {
    const slow = fist(Array.from({ length: 26 }, (_, f) => 700 + 15 * Math.min(f, 12)));
    expect(contactFrame(slow, 12, P, S).found).toBe(false);
  });

  it('needs both frames before it fast, so a 21 px frame (under 0.02 S) breaks the run', () => {
    const bottoms = [880, 880, 880, 941, 962, 968, 968, 968]; // 61, 21, 6
    expect(contactsIn(lowTrack(fist(bottoms)), 0, 7, S)).toEqual([]);
  });

  it('reads the column under P: feet still falling outside it hide the stop at full width', () => {
    // Feet at x 1300–1400 are lower all along and fall 11 px a frame, like the
    // hero's on f74–94 (12 px on f77).
    const feet = (f: number): Box[] => [[1300, 700 + 11 * f, 1400, 800 + 11 * f]];
    const withFeet = fist(slamBottoms(10, 21, 500), 1, feet);
    expect(contactFrame(withFeet, 13, [943, 640], S)).toEqual({ frame: 13, found: true });
    expect(contactsIn(lowTrack(withFeet), 0, 20, S)).toEqual([]);
  });

  it('takes the contact nearest the drawn frame when the window holds two', () => {
    const two = slamBottoms(4, 30).map((y, f) => (f >= 14 ? y + slamBottoms(14, 30, 0)[f] : y));
    const hits = contactsIn(lowTrack(fist(two)), 0, 29, S);
    expect(hits).toEqual([7, 17]);
    expect(contactFrame(fist(two), 11, P, S).frame).toBe(7); // 4 back, 6 ahead
    expect(contactFrame(fist(two), 13, P, S).frame).toBe(17);
    expect(contactFrame(fist(two), 12, P, S).frame).toBe(7); // a tie: the earlier
  });

  it('reads rasters that are not 1:1 with the frame', () => {
    const coarse = fist(slamBottoms(10, 26), 2);
    expect(coarse[13].width).toBe(13);
    expect(contactFrame(coarse, 16, P, S)).toEqual({ frame: 13, found: true });
    const low = lowestRow(coarse[13])!;
    expect(low.y).toBeCloseTo(1023, 9); // rows of 2 px from 964: the last covers 1022–1024
    expect(low.runs).toEqual([[931, 955]]);
  });

  it('skips frames with no mask', () => {
    const gap = fist(slamBottoms(10, 26)).map((m, f) => (f === 11 ? null : m));
    expect(contactFrame(gap, 13, P, S).found).toBe(false);
  });
});

describe('snapContact', () => {
  const masks = fist(slamBottoms(10, 26));
  it('moves the moment to the contact, with a toast', () => {
    expect(snapContact(masks, 18, [943, 1000], S)).toEqual({ frame: 13, found: true, drawnOn: 18, moved: true, toast: 'Contact set to f13, drawn on f18' });
  });
  it('says nothing when he drew on the contact, or no contact is found', () => {
    expect(snapContact(masks, 13, [943, 1000], S)).toMatchObject({ frame: 13, moved: false, toast: null });
    expect(snapContact(masks, 24, [943, 1000], S)).toMatchObject({ frame: 24, found: false, moved: false, toast: null });
  });
});

// ---- The impact point ---------------------------------------------------------------------

describe('the P snap', () => {
  const m = body84();

  it('moves P onto the middle of the lowest run in its column', () => {
    expect(lowestRow(m, 943 - 0.06 * S, 943 + 0.06 * S)).toEqual({ y: 1062.5, runs: [[935.5, 950.5]] });
    expect(lowestRow(m, 1500, 1600)).toBeNull(); // a column off the mask
    expect(snapToBody([942, 1061], m, S)).toEqual(FIST_BOTTOM);
  });

  it('applies within 0.06 S, and not beyond it', () => {
    expect(snapToBody([943, 1062.5 + 0.05 * S], m, S)).toEqual(FIST_BOTTOM);
    expect(snapToBody([943 + 0.04 * S, 1062.5 + 0.03 * S], m, S)).toEqual(FIST_BOTTOM); // 0.05 S on the diagonal
    expect(snapToBody([943, 1062.5 + 0.07 * S], m, S)).toBeNull();
    expect(snapToBody([943 + 0.1 * S, 1062.5], m, S)).toBeNull(); // the column holds only his thigh, 85 px off
    expect(snapToBody([942, 1061], null, S)).toBeNull();
  });

  it('snaps down to the lowest pixels, not the nearest ones', () => {
    expect(snapToBody([943, 1062.5 - 0.05 * S], m, S)).toEqual(FIST_BOTTOM); // inside the forearm
  });

  it('impactPoint reports the drawn point, the snap and each stroke end at P', () => {
    // Three cracks out from the fist, one drawn in toward it, and a scribble far off.
    const strokes = [
      line(1, [[942, 1061], [700, 1050]]),
      line(2, [[944, 1059], [960, 1000]]),
      line(3, [[940, 1062], [1150, 1040]]),
      line(4, [[1200, 1040], [945, 1058]]),
      line(5, [[400, 500], [300, 400]]),
    ];
    const p = impactPoint(strokes, [m], 0, S);
    expect(p.from).toBe('start');
    expect(dist(p.drawn, [942, 1061])).toBeLessThan(3);
    expect(p.snapped).toBe(true);
    expect(p.P).toEqual(FIST_BOTTOM);
    expect(p.ends).toEqual(['start', 'start', 'start', 'end', null]);
    expect(p.problems).toEqual([]);
  });
});

describe('R2: where the impact strokes meet', () => {
  const m = body84();
  const out = [line(1, [[942, 1061], [700, 1050]]), line(2, [[942, 1061], [900, 900]]), line(3, [[942, 1061], [1150, 1040]])];

  it('takes the tighter of the starts and the ends', () => {
    expect(drawnPoint(out, m, S)).toEqual({ P: [942, 1061], from: 'start', problems: [] });
    expect(drawnPoint(out.map(reversed), m, S)).toEqual({ P: [942, 1061], from: 'end', problems: [] });
  });

  it('gives a single stroke (a tie) the end nearer the person', () => {
    const crack13 = line(13, [[942, 1061], [1042.7, 834.8]]); // its far end is 43 px off his thigh
    expect(distanceToMask(m, [942, 1061])).toBe(0);
    expect(distanceToMask(m, [1042.7, 834.8])).toBeCloseTo(Math.hypot(1042.7 - 999.5, 834.8 - 834.5), 9); // to the thigh's last pixel centre
    expect(drawnPoint([crack13], m, S)).toMatchObject({ P: [942, 1061], from: 'start' });
    expect(drawnPoint([reversed(crack13)], m, S)).toMatchObject({ P: [942, 1061], from: 'end' });
  });

  it('breaks a tie with no mask toward the lower end, where a body meets the floor', () => {
    const crack13 = line(13, [[1042.7, 834.8], [942, 1061]]);
    expect(drawnPoint([crack13], null, S)).toMatchObject({ P: [942, 1061], from: 'end' });
    expect(drawnPoint([reversed(crack13)], null, S)).toMatchObject({ P: [942, 1061], from: 'start' });
  });

  it('falls back to the middle of every point, with a problem, when no end is shared', () => {
    const scattered = [line(1, [[600, 900], [640, 880]]), line(2, [[1300, 900], [1340, 950]]), line(3, [[940, 600], [960, 560]])];
    const r = drawnPoint(scattered, m, S);
    expect(r.from).toBe('all');
    expect(r.P).toEqual(geometricMedian(scattered.flatMap((s) => s.points as Vec2[])));
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/share no end/);
  });

  it('refuses a drawing with no points', () => {
    expect(() => drawnPoint([], m, S)).toThrow(/no points/);
  });
});

describe('geometricMedian and fromP', () => {
  it('is not dragged by a stray point the way a mean is', () => {
    const gm = geometricMedian([[0, 0], [1, 0], [0, 1], [1, 1], [1000, 1000]]);
    expect(gm[0]).toBeGreaterThanOrEqual(0.5);
    expect(gm[0]).toBeLessThanOrEqual(1 + 1e-6);
    expect(gm[1]).toBeCloseTo(gm[0], 6);
    expect(geometricMedian([[3, 4]])).toEqual([3, 4]);
    expect(geometricMedian([[942, 1061], [942, 1061], [942, 1061]])).toEqual([942, 1061]);
    expect(dist(geometricMedian([[0, 0], [0, 0], [6, 8]]), [0, 0])).toBeLessThan(1e-5); // two of three win
    expect(() => geometricMedian([])).toThrow();
  });

  it('picks the end within 0.08 S of P, the nearer when both are, and none otherwise', () => {
    const P: Vec2 = [942, 1061];
    expect(fromP([[942, 1061], [500, 1060]], P, S)).toBe('start');
    expect(fromP([[500, 1060], [940, 1060]], P, S)).toBe('end');
    expect(fromP([[942 + 0.07 * S, 1061], [942, 1061 - 0.03 * S]], P, S)).toBe('end');
    expect(fromP([[942 + 0.09 * S, 1061], [500, 1060]], P, S)).toBeNull();
    expect(fromP([], P, S)).toBeNull();
  });
});

// The five messy drawings (WP0's helper), made from the hero's cracks around
// (942, 1061), on a mask shaped like his f84.
describe('the messy impact drawings', () => {
  const m = body84();
  for (const kind of MESSY_KINDS.filter((k) => k !== 'scattered')) {
    it(`${kind}: P within 0.02 S of (942, 1061)`, () => {
      const p = impactPoint(messyDrawing(kind), [m], 0, S);
      expect(dist(p.P, HERO.P)).toBeLessThan(0.02 * S);
      expect(p.problems).toEqual([]);
      expect(p.ends.some((e) => e !== null)).toBe(true);
    });
  }

  it('inward is read from its ends, single from the end nearer him', () => {
    expect(impactPoint(messyDrawing('inward'), [m], 0, S).from).toBe('end');
    expect(impactPoint(messyDrawing('single'), [m], 0, S).from).toBe('start');
  });

  it('scattered falls back to the geometric median and says so', () => {
    const strokes = messyDrawing('scattered');
    const p = impactPoint(strokes, [m], 0, S);
    expect(p.from).toBe('all');
    expect(p.drawn).toEqual(geometricMedian(strokes.flatMap((s) => s.points)));
    expect(p.problems).toHaveLength(1);
    expect(p.problems[0]).toMatch(/share no end/);
  });
});

// ---- The strike direction ------------------------------------------------------------------

describe('strikeDir: d', () => {
  const I = 10;
  const P: Vec2 = [943, 1062.5];

  it('follows the fist region, not the lowest row, which slides as the fist flattens', () => {
    // A fist falling straight down 40 px a frame, with a 2 px lip under it that
    // slides 10 px left a frame: the lowest row's middle runs 14° off.
    const masks = Array.from({ length: I }, (_, f) => {
      const b = 920 + 40 * (f - (I - 3));
      const lip = 950 - 10 * (f - (I - 3));
      return boxMask([[925, b - 100, 965, b], [lip - 5, b, lip + 5, b + 2]]);
    });
    const r = strikeDir(masks, I, P, S);
    expect(r.by).toBe('fist');
    expect(Math.hypot(...r.dir)).toBeCloseTo(1, 12);
    expect(degBetween(r.dir, [0, 1])).toBeLessThan(0.5);
    const mid = (f: number) => {
      const run = lowestRow(masks[f]!)!.runs[0];
      return [(run[0] + run[1]) / 2, lowestRow(masks[f]!)!.y] as Vec2;
    };
    const a = mid(I - 3);
    const b = mid(I - 1);
    expect(degBetween([b[0] - a[0], b[1] - a[1]], [0, 1])).toBeGreaterThan(10);
  });

  it('reads a slanted strike', () => {
    const masks = Array.from({ length: I }, (_, f) => {
      const k = f - (I - 3);
      return boxMask([[930 - 6 * k, 880 + 38 * k, 956 - 6 * k, 960 + 38 * k]]);
    });
    const r = strikeDir(masks, I, [931, 1036], S);
    expect(r.by).toBe('fist');
    expect(degBetween(r.dir, [-6, 38])).toBeLessThan(0.01);
  });

  it('falls back to the limb tips when the fist moves under 0.03 S', () => {
    const still = Array.from({ length: I }, (_, f) => boxMask([[930, 960 + f, 956, 1040 + f]]));
    const tips: Vec2[] = [[P[0] - 300, P[1] - 400], [P[0] - 400, P[1] - 300]];
    const r = strikeDir(still, I, P, S, tips);
    expect(r.by).toBe('limbs');
    expect(r.dir[0]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(r.dir[1]).toBeCloseTo(Math.SQRT1_2, 12);
  });

  it('falls back to the limb tips with no mask before contact, then to straight down', () => {
    const none: (SamMask | null)[] = Array.from({ length: I }, () => null);
    expect(strikeDir(none, I, P, S, [[P[0], P[1] - 500]])).toEqual({ dir: [0, 1], by: 'limbs' });
    const slanted = strikeDir(none, I, P, S, [[P[0] + 300, P[1] - 400]]).dir;
    expect(slanted[0]).toBeCloseTo(-0.6, 12);
    expect(slanted[1]).toBeCloseTo(0.8, 12);
    expect(strikeDir(none, I, P, S)).toEqual({ dir: [0, 1], by: 'down' });
    expect(strikeDir(none, I, P, S, [P])).toEqual({ dir: [0, 1], by: 'down' }); // a tip on P points nowhere
  });
});

// ---- Where the impact sheet opens -------------------------------------------------------------

describe('suggestImpactFrame: the cue', () => {
  const f1 = 22;
  const masks = fist(slamBottoms(60, 120)); // the sharpest stop is the contact, f63
  // One RMS value per 10 ms: quiet, with 50 ms bursts.
  const envelope = (seconds: number, bursts: { at: number; level: number }[]) => {
    const e = Array.from({ length: Math.round(seconds * 100) }, () => 0.001);
    for (const b of bursts) for (let i = 0; i < 5; i++) e[Math.round(b.at * 100) + i] = b.level;
    return e;
  };

  it('opens on the parked frame when it is at least f1 + 15', () => {
    expect(suggestImpactFrame({ parked: f1 + R1_GAP, f1, masks, S })).toEqual({ frame: 37, by: 'parked' });
    expect(suggestImpactFrame({ parked: 90, f1, masks, S })).toEqual({ frame: 90, by: 'parked' });
    expect(suggestImpactFrame({ parked: f1 + R1_GAP - 1, f1, masks, S }).by).not.toBe('parked');
  });

  it('else on the strongest onset from f1 + 15, over a louder one before it', () => {
    const audio = envelope(4, [{ at: 1.0, level: 0.5 }, { at: 2.5, level: 0.05 }, { at: 3.2, level: 0.1 }]);
    expect(suggestImpactFrame({ parked: f1, f1, audio, masks, S })).toEqual({ frame: 96, by: 'audio' }); // 3.20 s
    const one = envelope(4, [{ at: 1.0, level: 0.5 }, { at: 2.81, level: 0.05 }]);
    expect(suggestImpactFrame({ parked: null, f1, audio: one, masks, S })).toEqual({ frame: 84, by: 'audio' }); // 2.81 s
  });

  it('else on the sharpest stop of his lowest point', () => {
    expect(suggestImpactFrame({ parked: f1, f1, masks, S })).toEqual({ frame: 63, by: 'mask' });
    const flat = envelope(4, []); // no rise of 6 dB anywhere
    expect(suggestImpactFrame({ parked: f1, f1, audio: flat, masks, S })).toEqual({ frame: 63, by: 'mask' });
    const early = envelope(4, [{ at: 0.5, level: 0.5 }]); // only before f1 + 15
    expect(suggestImpactFrame({ parked: f1, f1, audio: early, masks, S }).by).toBe('mask');
  });

  it('else f1 + 45, inside the clip', () => {
    const still = Array.from({ length: 120 }, () => boxMask([[930, 900, 956, 1000]]));
    expect(suggestImpactFrame({ parked: f1, f1, masks: still, S })).toEqual({ frame: 67, by: 'fallback' });
    expect(suggestImpactFrame({ parked: null, f1, masks: [], S })).toEqual({ frame: 67, by: 'fallback' });
    expect(suggestImpactFrame({ parked: null, f1, masks: still.slice(0, 50), S })).toEqual({ frame: 49, by: 'fallback' });
  });

  it('ignores a stop before f1 + 15', () => {
    const early = fist(slamBottoms(20, 120)); // contact f23 < 37
    expect(suggestImpactFrame({ parked: null, f1, masks: early, S }).by).toBe('fallback');
  });
});

// ---- Both drawings ---------------------------------------------------------------------------

describe('momentsFromDrawings', () => {
  // The fist lands on f63 under (943, 1000); the limbs were drawn on f40.
  const masks = fist(slamBottoms(60, 120));
  const cracks = [line(11, [[943, 1000], [700, 990]]), line(12, [[943, 1000], [1150, 980]]), line(13, [[943, 1000], [990, 900]])];
  const limbs = [line(1, [[900, 500], [600, 300]]), line(2, [[960, 500], [1250, 300]])];
  const base = { limbs, f1: 40, cracks, fDrawn: 60, masks, S };

  it('snaps first, then writes the emerge and the slam', () => {
    const r = momentsFromDrawings(base);
    expect(r.snap).toMatchObject({ frame: 63, found: true, moved: true, toast: 'Contact set to f63, drawn on f60' });
    expect(r.emerge).toEqual({ kind: 'emerge', at: 40 / 30, strokes: [1, 2] });
    expect(r.slam).toEqual({
      kind: 'slam',
      at: 63 / 30,
      xy: [943, 1023.5], // drawn at (943, 1000), snapped onto the fist's bottom on f63
      by: 'body',
      dir: r.strike.dir,
      seed: fnv1a32(11, 12, 13),
      strokes: [11, 12, 13],
      limbs: [1, 2],
      frames: { count: 7, flash: 'full' },
      aftermath: { seconds: 1.5, scale: 1, scarSeconds: 3 },
    });
    expect(Math.round(r.slam.at * 30)).toBe(63);
    expect(r.point.snapped).toBe(true);
    expect(r.strike.by).toBe('fist');
    expect(degBetween(r.slam.dir!, [0, 1])).toBeLessThan(0.01);
    expect(r.problems).toEqual([]);
    expect(r.turn).toBeUndefined();
  });

  it('defaults to the full impact frames (Qai, Oct 29), 1.5 s of aftermath, and the crack-id seed', () => {
    expect(SLAM_FRAMES).toEqual({ count: 7, flash: 'full' });
    expect(SLAM_AFTERMATH).toEqual({ seconds: 1.5, scale: 1, scarSeconds: 3 });
    expect(impactSeed([11, 12, 13])).toBe(fnv1a32(11, 12, 13));
    expect(momentsFromDrawings({ ...base, seed: 84 }).slam.seed).toBe(84);
    expect(momentsFromDrawings({ ...base, cracks: [cracks[1], cracks[0], cracks[2]] }).slam.seed).toBe(fnv1a32(12, 11, 13));
  });

  it('flags R1: the contact must come 15 frames or more after the limbs', () => {
    const late = momentsFromDrawings({ ...base, f1: 63 - R1_GAP });
    expect(late.problems).toEqual([]);
    const early = momentsFromDrawings({ ...base, f1: 63 - R1_GAP + 1 });
    expect(early.problems).toHaveLength(1);
    expect(early.problems[0].startsWith(R1_MESSAGE)).toBe(true);
    expect(early.problems[0]).toContain('f64 or later (it is f63)');
    expect(early.slam.at * 30).toBeCloseTo(63, 9); // the slam is still made
  });

  it('keeps the drawn frame when there is no contact, and takes d from the limbs', () => {
    const r = momentsFromDrawings({ ...base, fDrawn: 100 });
    expect(r.snap).toMatchObject({ frame: 100, found: false, moved: false });
    expect(r.slam.at * 30).toBeCloseTo(100, 9);
    expect(r.strike.by).toBe('limbs'); // the fist rests on f97–99
  });

  it('carries the scattered fallback into its problems', () => {
    const r = momentsFromDrawings({ ...base, cracks: messyDrawing('scattered'), masks: [], fDrawn: 84, f1: 22 });
    expect(r.point.from).toBe('all');
    expect(r.problems.some((p) => /share no end/.test(p))).toBe(true);
  });

  it('passes his optional turn tap through', () => {
    const turn = { at: 2, dir: -1 as const };
    expect(momentsFromDrawings({ ...base, turn }).turn).toEqual(turn);
  });

  it('is deterministic', () => {
    expect(momentsFromDrawings(base)).toEqual(momentsFromDrawings(base));
  });

  it('writes moments that parseEffect accepts and round-trips', () => {
    const r = momentsFromDrawings({ ...base, turn: { at: 2, dir: 1 } });
    const ground = (c: DrawnLine): Stroke => ({
      id: c.id,
      color: 2,
      kind: 'rigid',
      anchor: { type: 'ground', xy: [c.points[0][0], c.points[0][1]] },
      bodyAngle: 0,
      stiffness: 1,
      wobble: 0,
      views: { front: { points: c.points as Vec2[], pressure: c.points.map(() => 1), root: [c.points[0][0], c.points[0][1]], layer: 'behind' } },
    });
    const limb = (l: DrawnLine): Stroke => ({ ...ground(l), brush: 'limb', color: 0, kind: 'strand', anchor: { type: 'concept', prompt: 'person' }, stiffness: 0.1 });
    const effect: Effect = {
      version: 1,
      brush: { size: 10, thinning: 0.6, smoothing: 0.5, streamline: 0.5 },
      palette: ['#e8203a', '#f4f1ea', '#16141a'],
      timing: { drawingsPerSecond: 12 },
      strokes: [...limbs.map(limb), ...cracks.map(ground)],
      moments: [r.emerge, r.slam],
      turn: r.turn,
      overrides: {},
    };
    const parsed = parseEffect(serializeEffect(effect));
    expect(parsed).toEqual({ effect: JSON.parse(serializeEffect(effect)) });
  });
});

describe('detect.ts stays deterministic', () => {
  it('reads no Math.random, clock or ctx.filter', () => {
    const code = readFileSync(resolve(REPO, 'src/impact/detect.ts'), 'utf8').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/Math\.random|\bDate\b|performance\.now|\.filter\s*=/);
  });
});

// ---- The hero clip ------------------------------------------------------------------------------

interface TestDrawings {
  seed: number;
  start: { frame: number; strokes: DrawnLine[] };
  end: { frame: number; contactPoint: Vec2; strokes: DrawnLine[]; strike: { imageDir81to83: Vec2 } };
}

const DRAWINGS = process.env.INKWELL_TEST_DRAWINGS;
const PERSON = resolve(REPO, 'fixtures/probe/sam-person.json');

describe.skipIf(!DRAWINGS || !existsSync(DRAWINGS) || !existsSync(PERSON))('the hero clip (cached masks, INKWELL_TEST_DRAWINGS)', () => {
  let masks: (SamMask | null)[] = [];
  let td: TestDrawings;
  beforeAll(async () => {
    td = JSON.parse(readFileSync(DRAWINGS!, 'utf8')) as TestDrawings;
    masks = await masksFromCache(JSON.parse(readFileSync(PERSON, 'utf8')), 254);
  }, 120_000);

  it('the test drawings are the ones the helper copies', () => {
    expect(td.start.frame).toBe(22);
    expect(td.end.frame).toBe(HERO.I);
    expect(td.end.contactPoint).toEqual([942, 1061]);
    expect(td.end.strokes.map((s) => s.points)).toEqual(HERO_CRACKS.map((c) => c.points));
  });

  for (const fDrawn of [74, 79, 84, 89, 94]) {
    it(`snaps an impact drawn on f${fDrawn} to contact f84, P and d`, () => {
      const r = momentsFromDrawings({ limbs: td.start.strokes, f1: td.start.frame, cracks: td.end.strokes, fDrawn, masks, S, seed: td.seed });
      expect(r.snap).toEqual({ frame: 84, found: true, drawnOn: fDrawn, moved: fDrawn !== 84, toast: fDrawn === 84 ? null : `Contact set to f84, drawn on f${fDrawn}` });
      expect(Math.round(r.slam.at * 30)).toBe(84);
      expect(dist(r.slam.xy, [942, 1061])).toBeLessThan(0.02 * S);
      expect(r.strike.by).toBe('fist');
      expect(degBetween(r.slam.dir!, td.end.strike.imageDir81to83)).toBeLessThan(3);
      expect(degBetween(r.slam.dir!, [-0.058, 0.998])).toBeLessThan(3);
      expect(r.point.ends).toEqual(['start', 'start', 'start', 'start', 'start', 'start']);
      expect(r.emerge).toEqual({ kind: 'emerge', at: 22 / 30, strokes: [1, 2, 3, 4] });
      expect(r.slam.seed).toBe(84);
      expect(r.problems).toEqual([]);
    });
  }

  it('the full-width detector finds nothing in f74–94, which is why the cue exists', () => {
    expect(contactsIn(lowTrack(masks), 74, 94, S)).toEqual([]);
    const P = HERO.P;
    expect(contactsIn(lowTrack(masks, P[0] - 0.1 * S, P[0] + 0.1 * S), 64, 104, S)).toEqual([84]);
  });

  it('the cue lands within 10 frames of the hit without audio', () => {
    const cue = suggestImpactFrame({ parked: 22, f1: 22, masks, S });
    expect(cue.by).toBe('mask');
    expect(Math.abs(cue.frame - 84)).toBeLessThanOrEqual(10);
  });

  it('the messy drawings on his own f84 mask: P within 0.02 S, scattered reported', () => {
    for (const kind of MESSY_KINDS) {
      const p = impactPoint(messyDrawing(kind), masks, 84, S);
      if (kind === 'scattered') {
        expect(p.from).toBe('all');
        expect(p.problems).toHaveLength(1);
      } else expect(dist(p.P, HERO.P), kind).toBeLessThan(0.02 * S);
    }
  });
});
