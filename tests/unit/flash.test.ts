// WP11: the export's flash check (impact design §5, "Gentle mode"; WCAG 2.3.1,
// area based). Every test runs on synthetic frames at the check size, 160 × 90:
// S = 90, so a field is a circle of radius 35.1 px (3869 pixel positions,
// 25 % = 967.25 px), with centres every 9 px.
import { describe, expect, it } from 'vitest';
import {
  CHECK_WIDTH,
  FlashCheckError,
  checkFlashes,
  downsampleFrame,
  flashChecker,
  flashSummary,
  GUARD_RATIO,
  guardRed,
  type CheckFrame,
  type FlashKind,
  type FlashReport,
  type FlashTransition,
} from '../../src/export/flash.ts';
import { isSaturatedRed, linear, luminance } from '../../src/impact/palette.ts';
import { rng } from '../../src/impact/rng.ts';

const W = 160;
const H = 90;
const FPS = 30;
type Rgb = readonly [number, number, number];

// The 8-bit grey whose relative luminance is nearest L.
const greys = new Map<number, number>();
function grey(L: number): number {
  let best = greys.get(L);
  if (best !== undefined) return best;
  best = 0;
  for (let v = 1; v < 256; v++) if (Math.abs(linear(v) - L) < Math.abs(linear(best) - L)) best = v;
  greys.set(L, best);
  return best;
}

function paint(colour: (x: number, y: number) => Rgb, w = W, h = H): CheckFrame {
  const data = new Uint8ClampedArray(4 * w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = colour(x, y);
      const i = 4 * (y * w + x);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

const hexRgb = (hex: string): Rgb => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
const greyRgb = (L: number): Rgb => [grey(L), grey(L), grey(L)];
const solids = new Map<string, CheckFrame>();
function solid(rgb: Rgb): CheckFrame {
  const key = rgb.join();
  let frame = solids.get(key);
  if (!frame) solids.set(key, (frame = paint(() => rgb)));
  return frame;
}
const level = (L: number) => solid(greyRgb(L));

// Uniform frames: each [L, n] holds relative luminance L for n frames.
const holds = (...steps: [number, number][]): CheckFrame[] => steps.flatMap(([L, n]) => Array.from({ length: n }, () => level(L)));
// Each field's transition frames, of one kind.
const byField = (r: FlashReport, kind: FlashKind = 'general') => r.fields.map((_, f) => r.transitions.filter((t) => t.field === f && t.kind === kind).map((t) => t.frame));
// Every field saw exactly these transitions.
const everyField = (r: FlashReport, frames: number[], kind: FlashKind = 'general') => byField(r, kind).every((ts) => ts.join() === frames.join());
// The most flashes any field has in frames from..to, both included.
const flashesIn = (r: FlashReport, from: number, to: number) => Math.max(...byField(r).map((ts) => Math.floor(ts.filter((t) => t >= from && t <= to).length / 2)));
// A flicker: `a` and `b` swapping every `half` frames, `frames` long.
const strobe = (a: CheckFrame, b: CheckFrame, half: number, frames: number) => Array.from({ length: frames }, (_, f) => (Math.floor(f / half) % 2 === 0 ? a : b));

// Pixel positions within the field radius of (cx, cy), and how many of them
// pass `inside` and are on the frame.
function fieldShare(cx: number, cy: number, radius: number, inside: (x: number, y: number) => boolean) {
  let all = 0;
  let hit = 0;
  const R = Math.floor(radius);
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + dy * dy > radius * radius) continue;
      all++;
      const x = cx + dx;
      const y = cy + dy;
      if (x >= 0 && x < W && y >= 0 && y < H && inside(x, y)) hit++;
    }
  }
  return hit / all;
}

describe('the fields', () => {
  it('lays 18 × 10 fields of radius 0.39 S on a 160 × 90 frame, one every 0.1 S, centred on the frame', () => {
    const r = checkFlashes(holds([0.5, 2]), FPS);
    expect(CHECK_WIDTH).toBe(160);
    expect(r.width).toBe(W);
    expect(r.height).toBe(H);
    expect(r.radius).toBeCloseTo(35.1, 9);
    expect(r.fields.length).toBe(180);
    expect(r.fields[0]).toMatchObject({ x: 3, y: 4 });
    expect(r.fields[179]).toMatchObject({ x: 156, y: 85 });
    expect(r.fields[1].x - r.fields[0].x).toBe(9);
    expect(r.fields[18].y - r.fields[0].y).toBe(9);
    expect(fieldShare(78, 40, r.radius, () => true)).toBe(1); // a middle field lies wholly on the frame
  });
});

describe('general flashes', () => {
  it('passes 3 flashes in a second and fails 4', () => {
    const three = checkFlashes(holds([0.1, 10], [0.6, 4], [0.1, 4], [0.6, 4], [0.1, 4], [0.6, 4], [0.1, 30]), FPS);
    expect(everyField(three, [10, 14, 18, 22, 26, 30])).toBe(true);
    expect(three.transitions.filter((t) => t.field === 0).map((t) => t.direction)).toEqual([1, -1, 1, -1, 1, -1]);
    expect(three.worstGeneral).toBe(3);
    expect(three.pass).toBe(true);

    const four = checkFlashes(holds([0.1, 10], [0.6, 4], [0.1, 4], [0.6, 4], [0.1, 4], [0.6, 4], [0.1, 4], [0.6, 4], [0.1, 30]), FPS);
    expect(everyField(four, [10, 14, 18, 22, 26, 30, 34, 38])).toBe(true);
    expect(four.worstGeneral).toBe(4);
    expect(four.pass).toBe(false);
  });

  it('passes a strobe that turns every 5 frames (3 a second) and fails one that turns every 4', () => {
    const dark = level(0.1);
    const light = level(0.6);
    const every5 = checkFlashes(strobe(dark, light, 5, 120), FPS);
    expect(every5.worstGeneral).toBe(3);
    expect(every5.pass).toBe(true);
    const every4 = checkFlashes(strobe(dark, light, 4, 120), FPS);
    expect(every4.worstGeneral).toBe(4);
    expect(every4.pass).toBe(false);
    // A second is fps frames: at 24 fps, turning every 4 frames is 3 flashes a second.
    expect(checkFlashes(strobe(dark, light, 4, 120), 24).worstGeneral).toBe(3);
  });

  it('counts in 1 s windows: 8 transitions within 30 frames are 4 flashes, spread over 31 they are 3', () => {
    const lead = [[0.1, 10], [0.6, 4], [0.1, 4], [0.6, 4], [0.1, 4], [0.6, 4], [0.1, 4]] as [number, number][];
    const within = checkFlashes(holds(...lead, [0.6, 5], [0.1, 30]), FPS);
    expect(everyField(within, [10, 14, 18, 22, 26, 30, 34, 39])).toBe(true);
    expect(within.worstGeneral).toBe(4);
    const spread = checkFlashes(holds(...lead, [0.6, 6], [0.1, 30]), FPS);
    expect(everyField(spread, [10, 14, 18, 22, 26, 30, 34, 40])).toBe(true);
    expect(spread.worstGeneral).toBe(3);
    expect(spread.pass).toBe(true);
  });

  it('needs the darker side below 0.80: a flicker between two light states is no flash', () => {
    expect(checkFlashes(strobe(level(0.82), level(0.98), 2, 60), FPS).transitions).toEqual([]);
    expect(checkFlashes(strobe(level(0.7), level(0.9), 2, 60), FPS).worstGeneral).toBeGreaterThan(3);
  });

  it('needs a change of 0.10', () => {
    expect(checkFlashes(strobe(level(0.4), level(0.48), 2, 60), FPS).transitions).toEqual([]);
    expect(checkFlashes(strobe(level(0.4), level(0.52), 2, 60), FPS).worstGeneral).toBeGreaterThan(3);
  });

  it('does not count a flicker over less than 25 % of a field', () => {
    const need = 0.25 * 3869;
    expect(30 * 30).toBeLessThan(need);
    expect(32 * 32).toBeGreaterThan(need);
    const square = (side: number, L: number) => paint((x, y) => (Math.abs(x - 75.5) < side / 2 && Math.abs(y - 40.5) < side / 2 ? greyRgb(L) : greyRgb(0.1)));
    const small = checkFlashes(strobe(level(0.1), square(30, 0.9), 2, 60), FPS);
    expect(small.transitions).toEqual([]);
    expect(small.worstGeneral).toBe(0);
    expect(small.pass).toBe(true);

    const big = checkFlashes(strobe(level(0.1), square(32, 0.9), 2, 60), FPS);
    expect(big.worstGeneral).toBe(7); // 15 turns a second, in the fields that hold it
    const flashing = new Set(big.transitions.map((t) => t.field));
    big.fields.forEach((f, i) => {
      const share = fieldShare(f.x, f.y, big.radius, (x, y) => Math.abs(x - 75.5) < 16 && Math.abs(y - 40.5) < 16);
      expect(flashing.has(i), `field ${i}`).toBe(share >= 0.25);
    });
  });

  it('counts a return from 0.10 to 0.60 once, whether it takes 1, 2, 4 or 8 frames', () => {
    for (const ramp of [1, 2, 4, 8]) {
      const steps = Array.from({ length: ramp }, (_, i): [number, number] => [0.1 + (0.5 * (i + 1)) / ramp, 1]);
      const r = checkFlashes(holds([0.1, 10], ...steps, [0.6, 30]), FPS);
      expect(byField(r).every((ts) => ts.length === 1), `${ramp} frames`).toBe(true);
      expect(r.transitions.every((t) => t.direction === 1)).toBe(true);
      if (ramp <= 4) expect(everyField(r, [10]), `${ramp} frames`).toBe(true);
      expect(r.worstGeneral).toBe(0); // one transition is half a flash
    }
    // A frame-to-frame comparison would miss the 8-frame ramp altogether: no step of it reaches 0.10.
    const ramp8 = [0.1, ...Array.from({ length: 8 }, (_, i) => 0.1 + (0.5 * (i + 1)) / 8)].map((L) => linear(grey(L)));
    expect(Math.max(...ramp8.slice(1).map((L, i) => L - ramp8[i]))).toBeLessThan(0.1);
  });

  it('counts a rise, a pause and a further rise as one transition', () => {
    const r = checkFlashes(holds([0.1, 10], [0.35, 10], [0.6, 10], [0.1, 20]), FPS);
    expect(everyField(r, [10, 30])).toBe(true);
    expect(r.worstGeneral).toBe(1);
  });
});

describe('the field rules', () => {
  const dark = greyRgb(0.1);
  const light = greyRgb(0.6);

  it('counts a field that turns half brighter and half darker at once as one transition, not a flash', () => {
    const split = (left: Rgb, right: Rgb) => paint((x) => (x < W / 2 ? left : right));
    const r = checkFlashes([...Array.from({ length: 10 }, () => split(dark, light)), ...Array.from({ length: 30 }, () => split(light, dark))], FPS);
    expect(everyField(r, [10])).toBe(true);
    expect(r.worstGeneral).toBe(0);
  });

  it('turns a field once 25 % of it has turned since it last did: a wipe is one rise, then one fall', () => {
    // A light edge sweeps in from the left from frame 10, 6 px a frame, and a dark one from frame 60.
    const edge = (f: number) => 6 * (f < 60 ? f - 9 : f - 59);
    const frames = Array.from({ length: 100 }, (_, f) => paint((x) => ((f < 60 ? f >= 10 && x < edge(f) : x >= edge(f)) ? light : dark)));
    const r = checkFlashes(frames, FPS);
    // The first frame in from..to-1 on which the swept part is 25 % of the field.
    const first = (from: number, to: number, cx: number, cy: number) => {
      for (let f = from; f < to; f++) if (fieldShare(cx, cy, r.radius, (x) => x < edge(f)) >= 0.25) return f;
      return -1;
    };
    const got = byField(r);
    r.fields.forEach((field, i) => expect(got[i], `field ${i}`).toEqual([first(10, 60, field.x, field.y), first(60, 100, field.x, field.y)]));
    expect(r.worstGeneral).toBe(0); // each field's rise and fall are 50 frames apart
  });

  it('needs 25 % of a field turned at once: patches under that, turning in turn, never make a flash', () => {
    // Two 24 × 24 patches, each 15 % of a field. A middle field holds both.
    const A = (x: number, y: number) => x >= 52 && x < 76 && y >= 28 && y < 52;
    const B = (x: number, y: number) => x >= 84 && x < 108 && y >= 28 && y < 52;
    const lit = (...on: ((x: number, y: number) => boolean)[]) => paint((x, y) => (on.some((p) => p(x, y)) ? light : dark));
    const [none, a, b, ab] = [lit(), lit(A), lit(B), lit(A, B)];
    const middle = checkFlashes([none], FPS).fields.findIndex((f) => f.x === 75 && f.y === 40);
    expect(fieldShare(75, 40, 35.1, A)).toBeLessThan(0.25);
    expect(fieldShare(75, 40, 35.1, (x, y) => A(x, y) || B(x, y))).toBeGreaterThanOrEqual(0.25);

    // Together they are 30 % of it: a rise and a fall, one flash.
    const together = checkFlashes([none, none, ab, ab, none, none, ...Array.from({ length: 10 }, () => none)], FPS);
    expect(byField(together)[middle]).toEqual([2, 4]);
    expect(together.fields[middle].general).toBe(1);

    // In turn, over and over, they never are. Their falls add up until the field
    // turns, so it may turn darker once; it then waits for 25 % to brighten at once.
    const inTurn = checkFlashes([none, ...Array.from({ length: 12 }, () => [a, a, none, none, b, b, none, none]).flat()], FPS);
    expect(Math.max(...byField(inTurn).map((ts) => ts.length))).toBeLessThanOrEqual(1);
    expect(inTurn.worstGeneral).toBe(0);
  });
});

// The rules done the plain way, to check the fast bookkeeping against: every
// pixel's state on every frame, and every field recounted from all of them.
function plainTransitions(frames: CheckFrame[]): FlashTransition[] {
  const { width: w, height: h } = frames[0];
  const S = Math.min(w, h);
  const radius = (0.78 / 2) * S;
  const step = Math.max(1, Math.round(0.1 * S));
  const axis = (size: number) => {
    const count = Math.floor((size - 1) / step) + 1;
    const first = Math.floor((size - 1 - (count - 1) * step) / 2);
    return Array.from({ length: count }, (_, i) => first + i * step);
  };
  const centres = axis(h).flatMap((y) => axis(w).map((x) => [x, y]));
  const inside = (dx: number, dy: number) => dx * dx + dy * dy <= radius * radius;
  const R = Math.ceil(radius);
  let area = 0;
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) if (inside(dx, dy)) area++;
  const pixelsOf = centres.map(([cx, cy]) => Array.from({ length: w * h }, (_, p) => p).filter((p) => inside((p % w) - cx, Math.floor(p / w) - cy)));
  const kinds: FlashKind[] = ['general', 'red'];
  const pixels = kinds.map(() => Array.from({ length: w * h }, () => ({ dir: 0, at: -1, hi: 0, lo: 0, hiSat: -Infinity, loSat: Infinity })));
  const fields = kinds.map(() => centres.map(() => ({ dir: 0, since: -1 })));
  const out: FlashTransition[] = [];
  frames.forEach((frame, t) => {
    for (let p = 0; p < w * h; p++) {
      const [Rl, Gl, Bl] = [0, 1, 2].map((c) => linear(frame.data[4 * p + c]));
      const L = 0.2126 * Rl + 0.7152 * Gl + 0.0722 * Bl;
      const q = Rl > Gl + Bl ? 320 * (Rl - Gl - Bl) : 0;
      const sat = q > 0 && Rl >= 0.8 * (Rl + Gl + Bl);
      const [g, r] = [pixels[0][p], pixels[1][p]];
      if (t === 0) {
        Object.assign(g, { hi: L, lo: L });
        Object.assign(r, { hi: q, lo: q, hiSat: sat ? q : -Infinity, loSat: sat ? q : Infinity });
        continue;
      }
      // General: from the extreme since its own last transition, the darker side below 0.80.
      g.hi = Math.max(g.hi, L);
      g.lo = Math.min(g.lo, L);
      const fall = g.dir !== -1 && L < 0.8 ? g.hi - L : -1;
      const rise = g.dir !== 1 && g.lo < 0.8 ? L - g.lo : -1;
      if (fall >= 0.1 - 1e-9 || rise >= 0.1 - 1e-9) {
        g.dir = rise >= fall ? 1 : -1;
        g.at = t;
        if (g.dir > 0) g.hi = L;
        else g.lo = L;
      }
      // Red: Q by more than 20, one end a saturated red.
      r.hi = Math.max(r.hi, q);
      r.lo = Math.min(r.lo, q);
      if (sat) {
        r.hiSat = Math.max(r.hiSat, q);
        r.loSat = Math.min(r.loSat, q);
      }
      const rFall = r.dir !== -1 ? (sat ? r.hi : r.hiSat) - q : -Infinity;
      const rRise = r.dir !== 1 ? q - (sat ? r.lo : r.loSat) : -Infinity;
      if (rFall > 20 || rRise > 20) {
        r.dir = rRise >= rFall ? 1 : -1;
        r.at = t;
        if (r.dir > 0) Object.assign(r, { hi: q, hiSat: sat ? q : -Infinity });
        else Object.assign(r, { lo: q, loSat: sat ? q : Infinity });
      }
    }
    if (t === 0) return;
    kinds.forEach((kind, k) => {
      pixelsOf.forEach((ps, f) => {
        const field = fields[k][f];
        let up = 0;
        let down = 0;
        for (const p of ps) {
          const s = pixels[k][p];
          if (s.at > field.since) {
            if (s.dir > 0) up++;
            else down++;
          }
        }
        let flip: 0 | 1 | -1 = 0;
        if (field.dir !== 1 && up >= 0.25 * area) flip = 1;
        if (field.dir !== -1 && down >= 0.25 * area && (flip === 0 || down > up)) flip = -1;
        if (flip !== 0) {
          Object.assign(field, { dir: flip, since: t });
          out.push({ frame: t, field: f, direction: flip, kind });
        }
      });
    });
  });
  return out;
}

describe('against a plain recount', () => {
  // Seeded clips with many pixels turning at scattered times. Frame f's colours
  // come from its own random numbers.
  const clip = (w: number, h: number, frames: number, seed: number, frame: (r: () => number, f: number) => (x: number, y: number) => Rgb) =>
    Array.from({ length: frames }, (_, f) => paint(frame(rng(seed, 'flood', f), f), w, h));
  // Square cells `size` px across, each one colour.
  const cells = (w: number, h: number, size: number, pick: () => Rgb) => {
    const across = Math.ceil(w / size);
    const colours = Array.from({ length: across * Math.ceil(h / size) }, pick);
    return (x: number, y: number) => colours[Math.floor(y / size) * across + Math.floor(x / size)];
  };
  const byte = (r: () => number, from = 0): Rgb => {
    const v = from + Math.floor((256 - from) * r());
    return [v, v, v];
  };
  const reds: Rgb[] = [[255, 0, 0], hexRgb('#6a2c03'), [200, 30, 10], [255, 141, 0], [128, 128, 128], [0, 0, 0]];
  // Some pixels take a new grey or red each frame: 5 %, 20 %, 60 %, then all of
  // them. The leavers go one at a time on some frames and in passes on others.
  const changing = () => {
    let now = Array.from({ length: W * H }, (): Rgb => [0, 0, 0]);
    return clip(W, H, 40, 4, (r, f) => {
      const share = [0.05, 0.2, 0.6, 1][f % 4];
      const at = (now = now.map((v) => (r() < share ? (r() < 0.5 ? byte(r) : reds[Math.floor(r() * reds.length)]) : v)));
      return (x, y) => at[y * W + x];
    });
  };
  const clips: [string, () => CheckFrame[]][] = [
    ['grey noise', () => clip(W, H, 24, 1, (r) => () => byte(r))],
    ['red, orange and grey flicker', () => clip(W, H, 24, 2, (r) => () => reds[Math.floor(r() * reds.length)])],
    ['8 px blocks', () => clip(W, H, 30, 3, (r) => cells(W, H, 8, () => (r() < 0.5 ? greyRgb(0.05) : greyRgb(0.7))))],
    ['a share of the pixels changing each frame', changing],
    ['a portrait 36 × 60 in red, yellow and grey', () => clip(36, 60, 40, 5, (r, f) => cells(36, 60, 3, () => (r() < 0.5 ? [220, f % 3 === 0 ? 0 : 220, 0] : [30, 30, 30])))],
    ['stripes and noise, 77 × 41', () => clip(77, 41, 40, 12, (r, f) => (x, y) => ((x + 2 * y + 7 * f) % 50 < 25 ? greyRgb(0.02) : byte(r, 150)))],
  ];

  it.each(clips)('gives the same transitions on %s', (_, make) => {
    const frames = make();
    const fast = checkFlashes(frames, FPS).transitions;
    expect(fast.length).toBeGreaterThan(100);
    expect(fast).toEqual(plainTransitions(frames));
  });
});

describe('red flashes', () => {
  // Pure red and the grey with the same luminance: no general transition at all.
  const RED: Rgb = [255, 0, 0];
  const RED_GREY = greyRgb(luminance('#ff0000'));

  it('finds a saturated red flash that the luminance alone does not show, and fails on one', () => {
    expect(Math.abs(luminance('#ff0000') - linear(RED_GREY[0]))).toBeLessThan(0.001);
    const r = checkFlashes([solid(RED_GREY), ...strobe(solid(RED), solid(RED_GREY), 5, 20), ...Array.from({ length: 20 }, () => solid(RED_GREY))], FPS);
    expect(everyField(r, [1, 6, 11, 16], 'red')).toBe(true);
    expect(r.worstGeneral).toBe(0);
    expect(r.worstRed).toBe(2);
    expect(r.pass).toBe(false);
    // One red flash already fails: the budget allows none (design §5, G5).
    const once = checkFlashes([solid(RED_GREY), solid(RED), solid(RED), solid(RED_GREY), solid(RED_GREY)], FPS);
    expect(once.worstRed).toBe(1);
    expect(once.pass).toBe(false);
  });

  it('does not count the same red with its green raised to 0.55 R', () => {
    const orange: Rgb = [255, 141, 0]; // G = 0.553 R
    expect(isSaturatedRed('#ff8d00')).toBe(false);
    const orangeGrey = greyRgb(luminance('#ff8d00'));
    const r = checkFlashes(strobe(solid(orange), solid(orangeGrey), 5, 60), FPS);
    expect(r.worstRed).toBe(0);
    expect(r.worstGeneral).toBe(0);
    expect(r.pass).toBe(true);
  });

  it("follows design §5 G4's own example: #6a2c03 on black flashes red, #6a3b0a does not", () => {
    expect(isSaturatedRed('#6a2c03')).toBe(true);
    expect(isSaturatedRed('#6a3b0a')).toBe(false);
    const black = solid([0, 0, 0]);
    const red = checkFlashes(strobe(black, solid(hexRgb('#6a2c03')), 5, 60), FPS);
    expect(red.worstRed).toBe(3);
    expect(red.worstGeneral).toBe(0); // ΔL is only 0.049
    const brown = checkFlashes(strobe(black, solid(hexRgb('#6a3b0a')), 5, 60), FPS);
    expect(brown.worstRed).toBe(0);
    expect(brown.pass).toBe(true);
  });

  it('does not count a red flicker over less than 25 % of a field', () => {
    const patch = paint((x, y) => (Math.abs(x - 75.5) < 15 && Math.abs(y - 40.5) < 15 ? RED : RED_GREY));
    const r = checkFlashes(strobe(solid(RED_GREY), patch, 2, 60), FPS);
    expect(r.transitions).toEqual([]);
    expect(r.pass).toBe(true);
  });

  it("Reduce flashing's guard raises only the green of saturated reds, just under the ratio, and the strobe stops flashing red", () => {
    const share = (r: number, g: number, b: number) => linear(r) / (linear(r) + linear(g) + linear(b));
    const rnd = rng(7, 'guard');
    const data = new Uint8ClampedArray(4 * 4096);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = Math.floor(rnd() * 256);
      data[i + 1] = Math.floor(rnd() * 96);
      data[i + 2] = Math.floor(rnd() * 96);
      data[i + 3] = 255;
    }
    const before = data.slice();
    const changed = guardRed(data);
    let seen = 0;
    for (let i = 0; i < data.length; i += 4) {
      const [r, g0, b] = [before[i], before[i + 1], before[i + 2]];
      const g = data[i + 1];
      expect(data[i]).toBe(r);
      expect(data[i + 2]).toBe(b);
      expect(data[i + 3]).toBe(255);
      if (r > 0 && share(r, g0, b) >= GUARD_RATIO) {
        seen++;
        expect(share(r, g, b), `${r},${g0},${b} → ${g}`).toBeLessThan(GUARD_RATIO);
        expect(share(r, g - 1, b), `${r},${g0},${b} → ${g}: the least green`).toBeGreaterThanOrEqual(GUARD_RATIO);
      } else expect(g).toBe(g0);
    }
    expect(seen).toBeGreaterThan(100);
    expect(changed).toBe(seen);
    // Pure red strobed against its grey fails; guarded, no frame holds a saturated red.
    const guarded = (f: CheckFrame): CheckFrame => {
      const d = new Uint8ClampedArray(f.data);
      guardRed(d);
      return { data: d, width: f.width, height: f.height };
    };
    const frames = [solid(RED_GREY), ...strobe(solid(RED), solid(RED_GREY), 5, 20)];
    expect(checkFlashes(frames, FPS).worstRed).toBe(2);
    const safe = checkFlashes(frames.map(guarded), FPS);
    expect(safe.worstRed).toBe(0);
    expect(isSaturatedRed('#' + [...guarded(solid(RED)).data.slice(0, 3)].map((v) => v.toString(16).padStart(2, '0')).join(''))).toBe(false);
  });
});

describe('the impact frames', () => {
  it('counts the reference poster sequence as exactly 3 flashes', () => {
    // The room at 0.185, then IF1..IF7 at their comp luminance on the 30 fps holds 2, 1, 1, 1, 2, 1, 1, then 0.13.
    const r = checkFlashes(holds([0.185, 10], [0.75, 2], [0.51, 1], [0.96, 1], [0.87, 1], [0.07, 2], [0.97, 1], [0.1, 1], [0.13, 30]), FPS);
    // IF4 (0.96 → 0.87) and the return (0.10 → 0.13) are under 0.10.
    expect(everyField(r, [10, 12, 13, 15, 17, 18])).toBe(true);
    expect(r.worstGeneral).toBe(3);
    expect(r.pass).toBe(true);
  });

  // Gentle mode: IF1–IF4 light (relL ≥ 0.80), IF5–IF7 dark, then the scene back at 0.185.
  const gentle = (IF2: CheckFrame) => [...holds([0.185, 10], [0.85, 2]), IF2, ...holds([0.95, 1], [0.87, 1], [0.07, 2], [0.07, 1], [0.1, 1], [0.185, 30])];

  it('counts the gentle sequence with a light IF2 as 1 flash', () => {
    const r = checkFlashes(gentle(level(0.85)), FPS);
    expect(everyField(r, [10, 15, 19])).toBe(true); // the rise into IF1, the fall into IF5, the return
    expect(r.worstGeneral).toBe(1);
  });

  it('counts a half-ink IF2 as 2 flashes on the fields in the dark half and 1 on the others', () => {
    const ink = hexRgb('#16141a');
    const r = checkFlashes(gentle(paint((x) => (x < W / 2 ? ink : greyRgb(0.85)))), FPS);
    let dark = 0;
    r.fields.forEach((f, i) => {
      const inDark = fieldShare(f.x, f.y, r.radius, (x) => x < W / 2) >= 0.25;
      dark += inDark ? 1 : 0;
      expect(f.general, `field ${i}`).toBe(inDark ? 2 : 1);
      expect(byField(r)[i], `field ${i}`).toEqual(inDark ? [10, 12, 13, 15, 19] : [10, 15, 19]);
    });
    expect(dark).toBeGreaterThan(0);
    expect(dark).toBeLessThan(r.fields.length);
    expect(r.worstGeneral).toBe(2);
  });
});

// Design §5's gentle plan as uniform frames, with contact I on frame 20, so j = f − 20.
// The room is 0.185; the strike j −8..−1 swells by under 0.10; IF1–IF4 (j 0..4) are
// light and IF5–IF7 (j 5..8) dark; the scene returns on j 9; the A5–6 flash (j 15..17)
// stays under +0.10; wash 1 ramps up on j 20–21 to its j 22–23 plateau and down on
// j 24–25; wash 3 likewise on j 28–29 and 32–33.
//
// Design §5 (after timing.md §8) counts 6 transitions in j 0..29 and in j 5..34 by
// listing "the rise out of IF7" and "wash 1 up" apart. Both go up, and a flash is a
// pair of opposing transitions: with nothing darker between them they are one rise
// (WCAG's "an increase followed by a decrease"; the study's own area check merged
// them too). So as tabled the plan holds 5 transitions in each window: 2 flashes, one
// under the budget. It sits at exactly 3 only when the scene falls 0.10 or more
// between the return and wash 1; the reference's comp mean falls 0.09 there (0.25 on
// k20 to 0.17 on k21, as the dust veil clears). Without wash 3 that takes j 5..34 to
// 2 but leaves j 0..29 at 3. No luminance course gives 3 in j 0..29 with wash 3 and
// 2 without it: alternating transitions from the rise at j 0 to wash 3's rise at j 28
// are odd in number, so dropping the last one keeps floor(n/2).
describe("design §5's flash budget", () => {
  const I = 20;
  function plan(opts: { wash3?: boolean; dim?: boolean } = {}): CheckFrame[] {
    const { wash3 = true, dim = false } = opts;
    const wash1: Record<number, number> = { 20: 0.31, 21: 0.44, 22: 0.44, 23: 0.44, 24: 0.31 };
    const wash3s: Record<number, number> = { 28: 0.31, 29: 0.46, 30: 0.46, 31: 0.46, 32: 0.33 };
    const at = (j: number): number => {
      if (j < -3) return 0.185;
      if (j < 0) return [0.215, 0.235, 0.25][j + 3]; // the charge swell
      if (j <= 4) return [0.85, 0.85, 0.85, 0.92, 0.87][j];
      if (j <= 8) return [0.06, 0.06, 0.06, 0.08][j - 5];
      if (dim && j <= 13) return 0.32; // the fire burst, then smoke
      if (j >= 15 && j <= 17) return 0.255; // the A5–6 flash
      if (j in wash1) return wash1[j];
      if (wash3 && j in wash3s) return wash3s[j];
      return 0.185;
    };
    return Array.from({ length: I + 46 + 10 }, (_, f) => level(at(f - I)));
  }
  const j = (frames: number[]) => frames.map((f) => f - I);

  it('as tabled: the return and wash 1 make one rise, so j 0..29 and j 5..34 hold 2 flashes each, and 2 without wash 3', () => {
    const r = checkFlashes(plan(), FPS);
    expect(byField(r).every((ts) => j(ts).join() === [0, 5, 9, 24, 28, 32].join())).toBe(true);
    expect(flashesIn(r, I + 0, I + 29)).toBe(2);
    expect(flashesIn(r, I + 5, I + 34)).toBe(2);
    expect(r.worstGeneral).toBe(2);
    expect(r.worstRed).toBe(0);
    const without = checkFlashes(plan({ wash3: false }), FPS);
    expect(byField(without).every((ts) => j(ts).join() === [0, 5, 9, 24].join())).toBe(true);
    expect(without.worstGeneral).toBe(2);
  });

  it('with the scene dimming before wash 1: exactly 3 in j 0..29 and j 5..34; without wash 3, j 5..34 drops to 2 but j 0..29 stays at 3', () => {
    const r = checkFlashes(plan({ dim: true }), FPS);
    expect(byField(r).every((ts) => j(ts).join() === [0, 5, 9, 14, 20, 24, 28, 32].join())).toBe(true);
    expect(flashesIn(r, I + 0, I + 29)).toBe(3);
    expect(flashesIn(r, I + 5, I + 34)).toBe(3);
    expect(r.worstGeneral).toBe(3);
    expect(r.pass).toBe(true);
    const without = checkFlashes(plan({ dim: true, wash3: false }), FPS);
    expect(flashesIn(without, I + 5, I + 34)).toBe(2);
    expect(flashesIn(without, I + 0, I + 29)).toBe(3);
  });

  it('finds no transition in the strike (j −8..−1) or the A5–6 flash, and every one on its planned frame', () => {
    for (const r of [checkFlashes(plan(), FPS), checkFlashes(plan({ dim: true }), FPS)]) {
      const js = new Set(r.transitions.map((t) => t.frame - I));
      for (let x = -8; x <= -1; x++) expect(js.has(x)).toBe(false);
      for (const x of [15, 16, 17, 18]) expect(js.has(x)).toBe(false);
      for (const x of js) expect([0, 5, 9, 14, 20, 24, 28, 32]).toContain(x);
    }
  });
});

describe('the report', () => {
  const posters = () => holds([0.185, 10], [0.75, 2], [0.51, 1], [0.96, 1], [0.87, 1], [0.07, 2], [0.97, 1], [0.1, 1], [0.13, 30]);

  it('lists every 1 s window with its worst field, and each field with its worst window', () => {
    const r = checkFlashes(posters(), FPS);
    expect(r.frames).toBe(49);
    expect(r.window).toBe(30);
    expect(r.windows.length).toBe(49 - 30 + 1);
    expect(r.windows[0]).toEqual({ start: 0, end: 29, general: 3, red: 0 });
    expect(r.windows[11]).toEqual({ start: 11, end: 40, general: 2, red: 0 }); // the rise on frame 10 has left it
    expect(r.windows.at(-1)).toEqual({ start: 19, end: 48, general: 0, red: 0 });
    expect(r.fields.every((f) => f.general === 3 && f.red === 0)).toBe(true);
    expect(r.transitions.length).toBe(6 * 180);
    expect(r.transitions.map((t) => t.frame)).toEqual([...r.transitions.map((t) => t.frame)].sort((a, b) => a - b));
    // A clip shorter than a second is one window.
    const short = checkFlashes(holds([0.1, 5], [0.6, 5]), FPS);
    expect(short.windows).toEqual([{ start: 0, end: 9, general: 0, red: 0 }]);
  });

  it('gives the same report fed one frame at a time, on every run', () => {
    const frames = posters();
    const batch = checkFlashes(frames, FPS);
    const stream = flashChecker(W, H, FPS);
    for (const f of frames) stream.push(f);
    expect(stream.report()).toEqual(batch);
    expect(checkFlashes(frames, FPS)).toEqual(batch);
  });

  it('can report part-way through', () => {
    const frames = posters();
    const stream = flashChecker(W, H, FPS);
    frames.slice(0, 14).forEach((f) => stream.push(f));
    expect(stream.report().transitions.filter((t) => t.field === 0).map((t) => t.frame)).toEqual([10, 12, 13]);
    frames.slice(14).forEach((f) => stream.push(f));
    expect(stream.report()).toEqual(checkFlashes(frames, FPS));
  });

  it('passes an empty clip, and refuses frames of the wrong size or a bad frame rate', () => {
    expect(checkFlashes([], FPS)).toMatchObject({ frames: 0, worstGeneral: 0, worstRed: 0, windows: [], transitions: [], pass: true });
    expect(() => checkFlashes([level(0.5), paint(() => [0, 0, 0], 120, 90)], FPS)).toThrow(/must all be 160 × 90/);
    expect(() => checkFlashes([{ data: new Uint8ClampedArray(10), width: W, height: H }], FPS)).toThrow(/bytes/);
    expect(() => checkFlashes([level(0.5)], 0)).toThrow(/frame rate/);
    expect(() => checkFlashes([], Number.NaN)).toThrow(/frame rate/);
    expect(() => flashChecker(160.5, 90, FPS)).toThrow(/whole-pixel/);
    expect(() => flashChecker(70000, 1, FPS)).toThrow(/at most 65535 px wide/);
  });
});

describe('summary and error', () => {
  it('says plainly how often the video flashes', () => {
    const four = checkFlashes(holds([0.1, 10], [0.6, 4], [0.1, 4], [0.6, 4], [0.1, 4], [0.6, 4], [0.1, 4], [0.6, 4], [0.1, 30]), FPS);
    // The export sheet's warning in full mode (decision 5) starts with SPEC §8.9's words.
    expect(flashSummary(four)).toBe('This video flashes more than 3 times a second (4 times in frames 9–38).');
    expect(flashSummary(checkFlashes(holds([0.1, 10], [0.6, 4], [0.1, 30]), FPS))).toBe('This video flashes at most once in any second, with no red flash.');
    expect(flashSummary(checkFlashes(holds([0.1, 10], [0.6, 4], [0.1, 4], [0.6, 4], [0.1, 4], [0.6, 4], [0.1, 30]), FPS))).toBe('This video flashes at most 3 times in any second, with no red flash.');
    expect(flashSummary(checkFlashes(holds([0.5, 40]), FPS))).toBe('This video does not flash.');
    const red = checkFlashes([solid([127, 127, 127]), solid([255, 0, 0]), solid([255, 0, 0]), solid([127, 127, 127])], FPS);
    expect(flashSummary(red)).toBe('This video has a saturated red flash (frames 0–3).');
    const both = checkFlashes([solid([127, 127, 127]), ...strobe(solid([255, 0, 0]), solid([0, 0, 0]), 2, 30)], FPS);
    expect(both.worstGeneral).toBeGreaterThan(3);
    expect(both.worstRed).toBeGreaterThan(1);
    expect(flashSummary(both)).toMatch(/^This video flashes more than 3 times a second \(\d+ times in frames \d+–\d+\) and has \d+ saturated red flashes in one second \(frames \d+–\d+\)\.$/);
  });

  it('throws FlashCheckError with the report on it', () => {
    const report = checkFlashes(strobe(level(0.1), level(0.6), 2, 60), FPS);
    const error = new FlashCheckError(report);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('FlashCheckError');
    expect(error.report).toBe(report);
    expect(error.message).toBe(flashSummary(report));
    expect(new FlashCheckError(report, 'this clip flashes on its own').message).toBe('this clip flashes on its own');
  });
});

describe('downsampleFrame', () => {
  it('copies a frame down to 160 px wide, its height in proportion', () => {
    const hero = paint(() => [120, 120, 120], 1920, 1080);
    const small = downsampleFrame(hero);
    expect([small.width, small.height]).toEqual([160, 90]);
    expect(small.data.length).toBe(4 * 160 * 90);
    expect(small.data.every((v, i) => v === (i % 4 === 3 ? 255 : 120))).toBe(true);
    expect([downsampleFrame(paint(() => [0, 0, 0], 1080, 608)).height, downsampleFrame(paint(() => [0, 0, 0], 1080, 1920)).height]).toEqual([90, 284]);
    const already = level(0.5);
    expect(downsampleFrame(already)).toBe(already);
  });

  it('averages in linear light: a fine black-and-white pattern is the mid grey it looks like', () => {
    const checker = paint((x, y) => ((x + y) % 2 === 0 ? [0, 0, 0] : [255, 255, 255]), 320, 180);
    const small = downsampleFrame(checker);
    expect(Math.abs(linear(small.data[0]) - 0.5)).toBeLessThan(0.005);
    expect(new Set(Array.from(small.data.filter((_, i) => i % 4 === 0)))).toEqual(new Set([188]));
  });

  it('checks a full-size strobe the same as one drawn at 160 px', () => {
    const big = (L: number) => paint(() => greyRgb(L), 1920, 1080);
    const [dark, light] = [downsampleFrame(big(0.1)), downsampleFrame(big(0.6))];
    expect(checkFlashes(strobe(dark, light, 4, 60), FPS)).toEqual(checkFlashes(strobe(level(0.1), level(0.6), 4, 60), FPS));
  });
});

describe('speed', () => {
  // A busy 160 × 90 clip: a bright disc crossing a dark gradient with seeded
  // noise, a flickering square, and the reference posters part-way through.
  function busyClip(frames: number): CheckFrame[] {
    const posters = [0.75, 0.75, 0.51, 0.96, 0.87, 0.07, 0.07, 0.97, 0.1];
    return Array.from({ length: frames }, (_, f) => {
      const noise = rng(11, 'flood', f);
      const poster = f >= 60 && f < 60 + posters.length ? grey(posters[f - 60]) : -1;
      const cx = 20 + f;
      return paint((x, y) => {
        if (poster >= 0) return [poster, poster, poster];
        const disc = (x - cx) ** 2 + (y - 45) ** 2 < 400;
        const flick = f % 2 === 0 && Math.abs(x - 130) < 10 && Math.abs(y - 20) < 10;
        const v = disc || flick ? 230 : Math.min(255, 30 + x / 2 + Math.floor(noise() * 24));
        return [v, v, v];
      });
    });
  }

  // Design 2 ms a frame; today 0.96–1.34 under the whole unit suite (four
  // runs, Nov 2), so about 1.5 × the worst is the design line itself, and
  // the design line is the bound (decision 11).
  const msPerFrame = (frames: CheckFrame[]) => {
    const runs = Array.from({ length: 10 }, () => {
      const t0 = performance.now();
      checkFlashes(frames, FPS);
      return (performance.now() - t0) / frames.length;
    });
    return runs.sort((a, b) => a - b)[5];
  };

  it('checks a 160 × 90 frame in 2 ms or less (median of 10 runs)', () => {
    const ms = msPerFrame(busyClip(150));
    console.log(`flash check, busy clip: ${ms.toFixed(3)} ms a frame (median of 10 runs, 160×90)`);
    expect(ms).toBeLessThanOrEqual(2);
  });

  it('stays under 2 ms a frame when the whole frame flashes on every frame', () => {
    const ms = msPerFrame(strobe(level(0.1), level(0.9), 1, 150));
    console.log(`flash check, strobe: ${ms.toFixed(3)} ms a frame (median of 10 runs, 160×90)`);
    expect(ms).toBeLessThanOrEqual(2);
  });
});
