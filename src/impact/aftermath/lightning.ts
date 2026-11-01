// The lightning crawl (impact design §6 "Energy" and "Decay and the time map";
// lightning study §3; destruction §4.9, §6.10): blue ribbons and thin bolts,
// redrawn on every kr step and seeded rng(seed, 'bolt', kr), so both frames of
// a 2-frame step draw the same and nothing carries from one step to the next.
//   - How many, by the reference age A = kr − 14: A3–6 2–3 ribbons, 0.85 U of
//     path in all, the longest spanning 0.4–0.5 U, 0.006–0.009 S wide with no
//     core (the lead-in); A7–11 4–9 ribbons, 3.5–5 U, the longest 0.6–0.8 U;
//     from A12 2–7 ribbons, 3.5–6 U, the longest 0.6–1.3 U. The hold span and
//     the decay run the from-A12 band. A main ribbon (path ≥ 0.25 U) has a
//     median width of 0.021–0.024 S on A7–8 and 0.042–0.073 S from A9.
//   - Paths follow real edges: the sources the caller passes (WP12: the
//     cluster outline, the cracks, the person-mask edge near P, the limbs),
//     plus floor arcs round P and the floor line through it. A ribbon walks
//     along one, zigzagging off it with kinks of 40–85° every 2–8 median
//     widths (the segments head at most 42.5° off the source, so the turns
//     alternate round it), plus a smooth offset of at most 0.3 of the width.
//   - Width: 2–4 pools between pinches, max/min 4–8. The pools never overlap,
//     so each pinch comes down to the narrowest width, and the profile is
//     solved on the nodes, so the median and the ratio are exact. A pool
//     swells to about 2–2.5 × the median (lightning study §6.6 measures 2–3 ×)
//     where the ribbon is long enough for it; on a short one its shape fills
//     out so it is no wider than it is long. The ends are 0.2–1.5 × the median,
//     and each edge wobbles by up to a tenth. A kink's outer corner is round.
//   - Core: over 22–80 % of a main ribbon's length, centred on its widest
//     pools, 13–42 % of the width, off-centre by 0.07–0.24 of the half-width;
//     none where the ribbon is under 0.009 S. The cross-section reads
//     edge | band | edge | core | edge | band | edge, with a pale streak in a
//     wide late core.
//   - Eyes: a strand that splits off and rejoins, about one per 0.72 U of path.
//   - Thin bolts: U{1..3}, 0.1–0.26 U long, 0.005–0.010 S wide, tortuosity
//     1.03–1.09, no kinks and no core.
//   - Tones: the discharge set (decision 6), edge, band, core and pale.
//   - Gain: linear to 0 at J_end − 5, with one last full-gain kr step on
//     J_end − 7 (the last flicker), read per kr step at its last frame so a
//     step never changes mid-step. A wash turned bolt brightening (washes.ts)
//     multiplies the glow on its step and pales the core.
//   - iPhone tier: at most 4 ribbons (the longest) of at most 48 nodes each,
//     and no eyes.
// The gain is the layer's opacity (baked in, through a scratch) and its glow
// gain. Pass the sources as they are on the kr step's first frame
// (krSpan(j).first), so a 2-frame step draws the same on both frames.
import type { Vec2 } from '../../types/effect.ts';
import type { GlowSink, ImpactContext, LayerDraw } from '../contracts.ts';
import type { BrushTarget, MakeScratch } from '../../render/glow.ts';
import { kr } from '../clock.ts';
import { floorCircle } from '../floor.ts';
import { mixHex, roles } from '../palette.ts';
import { fnv1a32, int, rng, uniform, type Rng } from '../rng.ts';
import { boltBoost, boxOf, clamp, energyFrame, faded, fillUnion, krSpan, memo, onFloor, sceneKey, type EnergyFrame, type WashOptions } from './washes.ts';

const DEG = Math.PI / 180;
const TAU = 2 * Math.PI;
// A vector's length: Math.hypot guards against overflow these lengths never
// reach, at about nine times the cost.
const hyp = (x: number, y: number) => Math.sqrt(x * x + y * y);

// ---- The measured rules ----------------------------------------------------------------------

export interface RibbonBand {
  name: 'lead' | 'early' | 'mid' | 'late';
  count: readonly [number, number];
  total: readonly [number, number]; // U: all the ribbons' paths together
  longest: readonly [number, number]; // U: the longest ribbon's extent
  median: readonly [number, number]; // × S: a main ribbon's median width
  core: boolean; // pools, cores and eyes
}

export const RIBBON_BANDS: Readonly<Record<RibbonBand['name'], RibbonBand>> = {
  lead: { name: 'lead', count: [2, 3], total: [0.8, 0.9], longest: [0.4, 0.5], median: [0.006, 0.009], core: false }, // A3–6
  early: { name: 'early', count: [4, 9], total: [3.5, 5], longest: [0.6, 0.8], median: [0.021, 0.024], core: true }, // A7–8
  mid: { name: 'mid', count: [4, 9], total: [3.5, 5], longest: [0.6, 0.8], median: [0.042, 0.073], core: true }, // A9–11
  late: { name: 'late', count: [2, 7], total: [3.5, 6], longest: [0.6, 1.3], median: [0.042, 0.073], core: true }, // A12 on, the hold, the decay
};

export const KINK = { min: 40, max: 85, spacing: [2, 8] } as const; // degrees; × the median width
export const POOLS = { count: [2, 4], ratio: [4.4, 7.6], least: 4 } as const; // the ratio is drawn inside the measured 4–8, and lowered toward its least only where a pool would swell past POOL_MAX
export const CORE = { coverage: [0.3, 0.7], most: 0.76, share: [0.2, 0.32], wobble: 0.15, shift: [0.07, 0.24], thin: 0.009 } as const; // share × (1 ± wobble) stays in 0.13–0.42; a node's step never takes the coverage past most
export const BOLTS = { count: [1, 3], length: [0.1, 0.26], width: [0.005, 0.01], tortuosity: [1.035, 1.085] } as const;
export const MAIN_PATH = 0.25; // U: shorter ribbons are thinner, × SHORT_WIDTH
export const PHONE_RIBBONS = 4;
export const PHONE_NODES = 48;
export const BOLT_FADE = 9; // frames: the gain falls from 1 on J_end − 14 to 0 on J_end − 5
const SHORT_WIDTH = 0.6;
const HEADING_MAX = 42.5 * DEG; // a segment's heading off its source
const OFFSET_MAX = 1.6; // × the kink width: the most a ribbon strays off its source
const WOBBLE = 0.3; // × the median width: the smooth offset's reach
const EDGE_WOBBLE = 0.1; // × the half-width
const LEAD_KINK = 0.022; // × S: the lead-in's kinks are spaced as an early ribbon's
const MIN_PATH = 0.1; // U
const TORT = [1.12, 1.3] as const; // a ribbon's path / extent, as planned (a zigzag on a gentle source makes 1.1–1.3)
const POOL_SLOT = 4; // × the median width: the least path per pool beyond the first two
const POOL_SHAPE = [1.5, 0.5] as const; // a pool's cos^q exponent: q 1.5 swells to 2–2.5 × the median, filled out toward 0.5 on a short ribbon
const POOL_ROUND = 1; // the widest pool's width over its length, at most (while the shape can fill out)
const POOL_MAX = 3; // × the median width: the widest a pool swells (lightning study §6.6: 2–3 ×)
const JOIN = 15 * DEG; // a turn sharper than this gets a round outer corner and an exact inner miter
const SIMPLIFY = 0.3; // px: a strip's sides are thinned (Douglas–Peucker) to this; a fill costs about 1 µs a vertex
const EYE_EVERY = 0.72; // U of path per eye
const SOURCE_REACH = 1.6; // U from P
const FLOOR_RADII = [0.45, 0.75, 1.05] as const; // U: the floor arcs round P
const TRACK_STEP = 0.02; // U
const MIN_TRACK = 0.08; // U

// The band for frame I + j, or null before A3.
export function bandAt(j: number): RibbonBand | null {
  const A = kr(j) - 14;
  if (A < 3) return null;
  if (A <= 6) return RIBBON_BANDS.lead;
  if (A <= 8) return RIBBON_BANDS.early;
  if (A <= 11) return RIBBON_BANDS.mid;
  return RIBBON_BANDS.late;
}

// The bolts' gain on frame I + j, per kr step: 1 until the fade, then linear
// to 0 at J_end − 5, read at the step's last frame; the step holding J_end − 7
// flickers back to full. 0 before A3.
export function boltGain(ictx: ImpactContext, j: number): number {
  if (kr(j) < 17) return 0;
  const { first, last } = krSpan(j);
  const flicker = ictx.jEnd - 7;
  if (first <= flicker && flicker <= last) return 1;
  return clamp((ictx.jEnd - 5 - last) / BOLT_FADE, 0, 1);
}

// ---- The plan --------------------------------------------------------------------------------

export interface Strand {
  path: Vec2[]; // frame px
  width: number[]; // full width per node, px
}

export interface Ribbon extends Strand {
  main: boolean; // drawn at the band's median width; a short cored ribbon (under 0.25 U as planned) is thinner
  left: number[]; // half-width on the left of the path (its normal (−ty, tx)), px, edge wobble in
  right: number[];
  core: number[]; // the core's share of the width per node; 0 where there's none
  coreShift: number[]; // the core's centre off the path per node, px, + to the left
  kinks: number[]; // node indices
  turns: number[]; // the kinks' planned turns, degrees
  pools: number; // the width profile's pools
  median: number; // px, over the nodes
  ratio: number; // max / min width over the nodes
  length: number; // path length, px
  extent: number; // the largest distance between two nodes, px
  eyes: Strand[];
}

export interface LightningPlan {
  j: number;
  kr: number;
  A: number;
  band: RibbonBand['name'];
  gain: number; // the layer's opacity, and the glow's
  boost: number; // × the glow on a bolt brightening, else 1
  ribbons: Ribbon[];
  bolts: Strand[];
  tones: { edge: string; band: string; core: string; pale: string };
  line: number; // px: the ink line's width
  key: string;
}

export interface LightningOptions extends WashOptions {
  maxRibbons?: number; // the cut order's step 3: 4 → 2 ribbons
  floor?: boolean; // follow the floor arcs and line round P as well (default true)
}

// The lightning on frame I + j, crawling along `sources` (frame px
// polylines), or null when nothing shows: before A3, from J_end − 5, past
// J_end.
export function ribbons(ictx: ImpactContext, j: number, sources: readonly (readonly Vec2[])[] = [], opts: LightningOptions = {}): LightningPlan | null {
  const band = bandAt(j);
  const gain = boltGain(ictx, j);
  if (!band || !(gain > 0) || j > ictx.jEnd) return null;
  const k = kr(j);
  const fr = energyFrame(ictx);
  const { S, U } = fr;
  const phone = ictx.tier === 'phone';
  const tracks = prepare(ictx, fr, sources, opts.floor !== false, band);
  if (tracks.length === 0) return null;
  const r = rng(ictx.seed, 'bolt', k);

  // How many and how long: the longest ribbon's extent E, the rest sharing
  // what's left of the total, none longer than the longest. A few ribbons
  // can't carry the band's whole total under its longest extent, so the
  // total stays where they can.
  const count = int(r, band.count[0], band.count[1]);
  const eLo = band.longest[0] * U;
  const eHi = band.longest[1] * U;
  const most = Math.min(band.total[1] * U, count * eHi * TORT[1]);
  let total = most < band.total[0] * U ? most : uniform(r, band.total[0] * U, most);
  const E = uniform(r, Math.min(eHi, Math.max(eLo, total / (count * TORT[1]))), eHi);
  const top = E * clamp(total / (count * E), TORT[0], TORT[1]);
  total = Math.min(total, count * top);
  const lengths = [top, ...share(r, total - top, count - 1, MIN_PATH * U, top)];
  const main = lengths.map((l) => !band.core || l >= MAIN_PATH * U);
  const medians = lengths.map((_, i) => uniform(r, band.median[0], band.median[1]) * S * (main[i] ? 1 : SHORT_WIDTH));
  const keep = Math.max(0, Math.min(count, phone ? PHONE_RIBBONS : count, opts.maxRibbons ?? count));
  const chosen = lengths
    .map((_, i) => i)
    .sort((a, b) => lengths[b] - lengths[a] || a - b)
    .slice(0, keep)
    .sort((a, b) => a - b);

  const taken = takenGrid(ictx.width, ictx.height, U);
  const made: { rb: Ribbon; want: number; build: (length: number) => Ribbon | null }[] = [];
  let longest = 0;
  for (const i of chosen) {
    // Where it runs is drawn once; a rebuild only changes how far it goes.
    const place = placeOn(rng(ictx.seed, 'bolt', k, i + 1, 0), tracks, taken, lengths[i]);
    const build = (length: number) => buildRibbon(rng(ictx.seed, 'bolt', k, i + 1), place, length, medians[i], main[i], band, fr, phone);
    const first = i === chosen[0];
    const cap = first ? 0.98 * eHi : 0.97 * longest;
    const low = first ? 1.02 * eLo : 0;
    let want = lengths[i];
    let rb = build(want);
    // The path keeps its planned length where it can; the longest keeps its
    // extent in the band, and the rest stay under it. A rebuild redraws the
    // zigzag, so it can miss again: the best try is kept.
    const miss = (x: Ribbon) => (x.extent > cap ? x.extent / cap - 1 : x.extent < low ? low / x.extent - 1 : 0) + 0.01 * Math.abs(x.length / lengths[i] - 1);
    let best = rb ? { rb, want } : null;
    for (let tries = 0; rb && tries < 6; tries++) {
      const asPlanned = (rb.extent * lengths[i]) / rb.length;
      let scale = 1;
      if (rb.extent > cap) scale = (0.99 * cap) / rb.extent;
      else if (rb.extent < low) scale = (1.01 * low) / rb.extent;
      else if (Math.abs(rb.length / lengths[i] - 1) > 0.04 && asPlanned <= cap && asPlanned >= low) scale = lengths[i] / rb.length;
      if (scale === 1) break;
      want = Math.max(MIN_PATH * U, want * scale);
      rb = build(want) ?? rb;
      if (best && miss(rb) < miss(best.rb)) best = { rb, want };
    }
    if (!best) continue;
    if (first) longest = best.rb.extent;
    take(taken, best.rb);
    made.push({ rb: best.rb, want: best.want, build });
  }
  // Fit the band's total, with every ribbon there (the phone's cap and the
  // cut order mean to draw less). Short of it: lengthen the longest up to the
  // band's longest extent, then the others, each still under it. Over it
  // (each ribbon keeps its planned length only to 4 %): shorten the others.
  const need = band.total[0] * U;
  const room = band.total[1] * U;
  let sum = made.reduce((s, m) => s + m.rb.length, 0);
  for (let pass = 0; pass < 3 && keep === count && (sum < need || sum > room); pass++) {
    const grow = sum < need;
    for (let q = grow ? 0 : made.length - 1; grow ? q < made.length : q > 0; q += grow ? 1 : -1) {
      if (sum >= need && sum <= room) break;
      const m = made[q];
      const cap = q === 0 ? 0.98 * eHi : 0.97 * longest;
      const f = grow ? Math.min(1.6, (0.99 * cap) / m.rb.extent, 1 + (1.01 * need - sum) / m.rb.length) : Math.max(0.6, 1 - (sum - 0.99 * room) / m.rb.length);
      if (Math.abs(f - 1) < 0.005) continue;
      const next = m.build(Math.max(MIN_PATH * U, m.want * f));
      if (!next || next.extent > cap) continue;
      sum += next.length - m.rb.length;
      m.rb = next;
      m.want = Math.max(MIN_PATH * U, m.want * f);
      if (q === 0) longest = m.rb.extent;
    }
  }
  const out = made.map((m) => m.rb);
  const bolts: Strand[] = [];
  for (let b = 0, n = int(r, BOLTS.count[0], BOLTS.count[1]); b < n; b++) {
    const bolt = buildBolt(rng(ictx.seed, 'bolt', k, 100 + b), tracks, fr, phone);
    if (bolt) bolts.push(bolt);
  }

  const boost = boltBoost(ictx, j, opts);
  const d = roles(ictx.palette).discharge;
  const tones = { edge: d.edge, band: d.band, core: boost > 1 ? mixHex(d.core, d.pale, 0.45) : d.core, pale: d.pale };
  const key = ['bolt', sceneKey(ictx), k, gain.toFixed(4), boost, opts.maxRibbons ?? '-', opts.floor === false ? 'nf' : 'f', sourcesHash(sources)].join(':');
  return { j, kr: k, A: k - 14, band: band.name, gain, boost, ribbons: out, bolts, tones, line: Math.max(1, 0.0022 * S), key };
}

// `total` split into `count` random parts, each within [lo, hi]: random
// weights, levelled by bisection so the parts still add up to `total` where
// [count·lo, count·hi] allows it.
function share(r: Rng, total: number, count: number, lo: number, hi: number): number[] {
  if (count <= 0) return [];
  const w = Array.from({ length: count }, () => uniform(r, 0.5, 1.5));
  const sum = (m: number) => w.reduce((s, x) => s + clamp(m * x, lo, hi), 0);
  let a = 0;
  let b = (2 * hi) / Math.min(...w);
  for (let i = 0; i < 40; i++) {
    const m = (a + b) / 2;
    if (sum(m) < total) a = m;
    else b = m;
  }
  return w.map((x) => clamp(((a + b) / 2) * x, lo, hi));
}

// ---- Sources ---------------------------------------------------------------------------------

interface Track {
  pts: Vec2[]; // resampled and smoothed, frame px
  cum: number[]; // arc length at each point
  tan: Vec2[]; // unit tangent at each point
  kap: number[]; // signed curvature (1/px): + turns toward (−ty, tx)
  length: number;
}

// The sources cut to the frame and to SOURCE_REACH of P, as tracks at the
// scale of the band's widest ribbons. A line's tracks are kept by its exact
// points (most of them, the cracks and the floor, are the same on every kr
// step), so a step only smooths the lines that moved.
const trackCache = new Map<string, Track[]>();

function prepare(ictx: ImpactContext, fr: EnergyFrame, sources: readonly (readonly Vec2[])[], floor: boolean, band: RibbonBand): Track[] {
  const { width: W, height: H } = ictx;
  const reach = SOURCE_REACH * fr.U;
  const step = TRACK_STEP * fr.U;
  const scale = band.median[1] * fr.S;
  const lines: (readonly Vec2[])[] = [...sources];
  if (floor) lines.push(...floorLines(ictx, fr));
  const out: Track[] = [];
  const scene = fnv1a32(W, H, fr.P[0], fr.P[1], reach, step, scale);
  for (const line of lines) {
    const key = `${scene}:${lineKey(line)}`;
    out.push(...memo(trackCache, key, () => tracksOf(line, W, H, fr, reach, step, scale), 128));
  }
  return out;
}

function tracksOf(line: readonly Vec2[], W: number, H: number, fr: EnergyFrame, reach: number, step: number, scale: number): Track[] {
  const out: Track[] = [];
  let run: Vec2[] = [];
  const flush = () => {
    const t = run.length >= 2 ? makeTrack(run, step, scale) : null;
    if (t && t.length >= MIN_TRACK * fr.U) out.push(t);
    run = [];
  };
  for (const p of line) {
    if (p[0] >= 1 && p[0] <= W - 1 && p[1] >= 1 && p[1] <= H - 1 && hyp(p[0] - fr.P[0], p[1] - fr.P[1]) <= reach) run.push(p);
    else flush();
  }
  flush();
  return out;
}

// A polyline's exact key: its length and two 32-bit hashes over every
// coordinate's float64 bits.
const keyBits = new Float64Array(2);
const keyWords = new Uint32Array(keyBits.buffer);
function lineKey(line: readonly Vec2[]): string {
  let h1 = 0x811c9dc5;
  let h2 = line.length;
  for (const p of line) {
    keyBits[0] = p[0];
    keyBits[1] = p[1];
    for (let k = 0; k < 4; k++) {
      h1 = Math.imul(h1 ^ keyWords[k], 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ keyWords[k], 0x5bd1e995) >>> 0;
      h2 = (h2 ^ (h2 >>> 15)) >>> 0;
    }
  }
  return `${line.length}:${h1}:${h2}`;
}

// The floor round P: the floor line through P, along t̂, and the middles of
// three floor circles, θ 0.2π–0.8π on the far side and 1.2π–1.8π on the near
// one (only the far side when P is low on the frame). Their tight ends by the
// floor line are left out: a zigzag along them would fold.
export function floorLines(ictx: ImpactContext, fr: EnergyFrame): Vec2[][] {
  const lines: Vec2[][] = [[onFloor(fr, fr.U, 0, -1.2), onFloor(fr, fr.U, 0, 1.2)]];
  for (const R of FLOOR_RADII) {
    const { points, closed } = floorCircle(fr.P, R * fr.U, ictx.floor, { U: fr.U, height: ictx.height, segments: 96 });
    lines.push(points.slice(10, 39)); // θ = 2πi/96: 0.21π..0.79π
    if (closed) lines.push(points.slice(58, 87)); // 1.21π..1.79π
  }
  return lines;
}

function resample(raw: readonly Vec2[], step: number): Vec2[] {
  const out: Vec2[] = [[raw[0][0], raw[0][1]]];
  let carry = 0;
  for (let i = 1; i < raw.length; i++) {
    const a = raw[i - 1];
    const b = raw[i];
    const seg = hyp(b[0] - a[0], b[1] - a[1]);
    if (seg === 0) continue;
    let d = step - carry;
    while (d <= seg) {
      out.push([a[0] + ((b[0] - a[0]) * d) / seg, a[1] + ((b[1] - a[1]) * d) / seg]);
      d += step;
    }
    carry = seg - (d - step);
  }
  const last = raw[raw.length - 1];
  const tail = out[out.length - 1];
  if (hyp(last[0] - tail[0], last[1] - tail[1]) > 0.25 * step) out.push([last[0], last[1]]);
  return out;
}

// [1, 2, 1]/4 smoothing, the ends kept.
function smooth(pts: Vec2[], passes: number): Vec2[] {
  let out = pts;
  for (let pass = 0; pass < passes && out.length >= 3; pass++) {
    const p = out;
    out = p.map((q, i): Vec2 => (i === 0 || i === p.length - 1 ? q : [(p[i - 1][0] + 2 * q[0] + p[i + 1][0]) / 4, (p[i - 1][1] + 2 * q[1] + p[i + 1][1]) / 4]));
  }
  return out;
}

// A source as a track at the ribbons' scale: resampled every `scale` px and
// smoothed there, so wiggles narrower than a ribbon is wide are gone, then
// every `step` px and smoothed again over about half a scale (σ), so its
// tangent turns smoothly: a corner left in it would swing a wide ribbon's
// edges into teeth. The curvature is the turn over ±scale: the bend a ribbon
// that wide feels.
function makeTrack(raw: readonly Vec2[], step: number, scale: number): Track | null {
  const coarse = Math.max(step, scale);
  const passes = Math.max(2, Math.round(0.5 * (coarse / step) ** 2)); // [1, 2, 1]/4 adds ½ sample² of variance a pass
  const pts = smooth(resample(smooth(resample(raw, coarse), 2), step), passes);
  const n = pts.length;
  if (n < 3) return null;
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + hyp(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const tan = pts.map((_, i): Vec2 => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    const len = hyp(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
  });
  const m = Math.max(1, Math.round(coarse / step));
  const kap = pts.map((_, i) => {
    const i0 = Math.max(0, i - m);
    const i1 = Math.min(n - 1, i + m);
    if (cum[i1] - cum[i0] <= 0) return 0;
    let turn = Math.atan2(tan[i1][1], tan[i1][0]) - Math.atan2(tan[i0][1], tan[i0][0]);
    while (turn > Math.PI) turn -= TAU;
    while (turn < -Math.PI) turn += TAU;
    return turn / (cum[i1] - cum[i0]);
  });
  return { pts, cum, tan, kap, length: cum[n - 1] };
}

// The track at arc length s, run on straight past its ends.
function trackAt(tr: Track, s: number): { p: Vec2; T: Vec2; kap: number } {
  const n = tr.pts.length;
  if (s <= 0) return { p: [tr.pts[0][0] + s * tr.tan[0][0], tr.pts[0][1] + s * tr.tan[0][1]], T: tr.tan[0], kap: 0 };
  if (s >= tr.length) {
    const e = s - tr.length;
    return { p: [tr.pts[n - 1][0] + e * tr.tan[n - 1][0], tr.pts[n - 1][1] + e * tr.tan[n - 1][1]], T: tr.tan[n - 1], kap: 0 };
  }
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (tr.cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const f = (s - tr.cum[lo]) / Math.max(1e-9, tr.cum[hi] - tr.cum[lo]);
  const a = tr.pts[lo];
  const b = tr.pts[hi];
  const tx = tr.tan[lo][0] + f * (tr.tan[hi][0] - tr.tan[lo][0]);
  const ty = tr.tan[lo][1] + f * (tr.tan[hi][1] - tr.tan[lo][1]);
  const len = hyp(tx, ty) || 1;
  return { p: [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])], T: [tx / len, ty / len], kap: tr.kap[lo] + f * (tr.kap[hi] - tr.kap[lo]) };
}

// The sources over quarter pixels, for the cache key: two 32-bit hashes, as
// lineKey's (FNV-1a over every argument would cost a tenth of a plan).
function sourcesHash(sources: readonly (readonly Vec2[])[]): string {
  let h1 = 0x811c9dc5;
  let h2 = sources.length;
  const mix = (v: number) => {
    h1 = Math.imul(h1 ^ v, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ v, 0x5bd1e995) >>> 0;
    h2 = (h2 ^ (h2 >>> 15)) >>> 0;
  };
  for (const line of sources) {
    mix(line.length);
    for (const p of line) {
      mix(Math.round(p[0] * 4) | 0);
      mix(Math.round(p[1] * 4) | 0);
    }
  }
  return `${h1}:${h2}`;
}

// ---- One ribbon ----------------------------------------------------------------------------

interface Place {
  tr: Track;
  s0: number; // where on the track it starts
  dir: 1 | -1; // which way it runs along it
}

// Where the ribbons drawn so far lie: cells of 0.08 U, marked under their bands.
interface Taken {
  cell: number; // px
  cols: number;
  rows: number;
  hit: Uint8Array;
}

function takenGrid(width: number, height: number, U: number): Taken {
  const cell = Math.max(4, 0.08 * U);
  const cols = Math.ceil(width / cell) + 1;
  const rows = Math.ceil(height / cell) + 1;
  return { cell, cols, rows, hit: new Uint8Array(cols * rows) };
}

function isTaken(t: Taken, p: Vec2): boolean {
  const cx = Math.floor(p[0] / t.cell);
  const cy = Math.floor(p[1] / t.cell);
  return cx >= 0 && cy >= 0 && cx < t.cols && cy < t.rows && t.hit[cy * t.cols + cx] === 1;
}

function take(t: Taken, rb: Ribbon) {
  for (let i = 0; i < rb.path.length; i++) {
    const cx = Math.floor(rb.path[i][0] / t.cell);
    const cy = Math.floor(rb.path[i][1] / t.cell);
    const reach = Math.ceil(rb.width[i] / 2 / t.cell);
    for (let gy = Math.max(0, cy - reach); gy <= Math.min(t.rows - 1, cy + reach); gy++) {
      for (let gx = Math.max(0, cx - reach); gx <= Math.min(t.cols - 1, cx + reach); gx++) t.hit[gy * t.cols + gx] = 1;
    }
  }
}

// A track for a ribbon of path `length`: long ones weigh more, and of six
// tries the one whose run crosses the fewest cells the ribbons already there
// took wins, so the ribbons spread over the sources instead of piling up at P.
function placeOn(r: Rng, tracks: Track[], taken: Taken, length: number): Place {
  const weights = tracks.map((t) => Math.min(t.length, length) * (t.length >= 0.9 * length ? 2 : 1));
  const sum = weights.reduce((s, w) => s + w, 0);
  let best: Place | null = null;
  let bestCost = Infinity;
  for (let i = 0; i < 6; i++) {
    let x = r() * sum;
    let pick = 0;
    while (pick < tracks.length - 1 && x >= weights[pick]) x -= weights[pick++];
    const tr = tracks[pick];
    const run = Math.min(tr.length, 0.9 * length);
    const dir: 1 | -1 = r() < 0.5 ? 1 : -1;
    const s0 = dir === 1 ? uniform(r, 0, tr.length - run) : uniform(r, run, tr.length);
    let hits = 0;
    let samples = 0;
    for (let s = 0; s <= run; s += taken.cell, samples++) if (isTaken(taken, trackAt(tr, s0 + dir * s).p)) hits++;
    const cost = hits / Math.max(1, samples);
    if (cost < bestCost) {
      best = { tr, s0, dir };
      bestCost = cost;
    }
    if (cost === 0) break;
  }
  return best as Place;
}

interface Seg {
  d: number; // path length, px
  a: number; // heading off the track, radians, + toward its left normal
}

// The kink plan: segments of 2–8 widths, each turn 40–85° across the source,
// steering back when the ribbon has strayed OFFSET_MAX widths off it.
function zigzag(r: Rng, length: number, base: number): { segs: Seg[]; turns: number[] } {
  const segs: Seg[] = [];
  const turns: number[] = [];
  const omax = OFFSET_MAX * base;
  const [dMin, dMax] = [KINK.spacing[0] * base, KINK.spacing[1] * base];
  let a = (r() < 0.5 ? -1 : 1) * uniform(r, 15, 40) * DEG;
  let o = 0;
  let used = 0;
  for (;;) {
    const sa = Math.abs(Math.sin(a));
    const room = sa > 0.05 ? (omax - Math.sign(a) * o) / sa : Infinity;
    const rest = length - used;
    let d = Math.min(uniform(r, dMin, dMax), Math.max(dMin, room));
    if (rest <= dMax) d = rest; // the last one
    else if (rest - d < dMin) d = rest - dMin; // so the last is at least dMin
    segs.push({ d, a });
    o += d * Math.sin(a);
    used += d;
    if (used >= length - 1e-6) break;
    const sgn = a === 0 ? (o > 0 ? -1 : 1) : -Math.sign(a);
    const lo = Math.max(0, KINK.min * DEG - Math.abs(a));
    const away = sgn === Math.sign(o) && Math.abs(o) > 0.3 * omax;
    const m = lo + (HEADING_MAX - lo) * (away ? 0.25 : 1) * r();
    turns.push((m + Math.abs(a)) / DEG);
    a = sgn * m;
  }
  return { segs, turns };
}

// A ribbon of path `length` along its place.
function buildRibbon(r: Rng, place: Place, length: number, median: number, main: boolean, band: RibbonBand, fr: EnergyFrame, phone: boolean): Ribbon | null {
  const { S, U } = fr;
  const base = band.core ? median : Math.max(median, LEAD_KINK * S);
  const { segs, turns } = zigzag(r, length, base);
  const V: [number, number][] = [[0, 0]]; // vertices: (along the track, off it), px
  const Sv = [0]; // their arc length along the path
  for (const sg of segs) {
    const [x, o] = V[V.length - 1];
    V.push([x + sg.d * Math.cos(sg.a), o + sg.d * Math.sin(sg.a)]);
    Sv.push(Sv[Sv.length - 1] + sg.d);
  }
  const L = Sv[Sv.length - 1];
  if (!(L > 0)) return null;

  // The width profile: K pools between pinches, and clubs at the ends. The
  // pools tile the ribbon, each over 72 % of its slot, so they never overlap
  // and every pinch between two comes down to 0; a ribbon gets no more pools
  // than leaves POOL_SLOT medians of path each (but always two).
  const drawn = band.core ? int(r, POOLS.count[0], POOLS.count[1]) : 0;
  const K = Math.min(drawn, Math.max(POOLS.count[0], Math.floor(L / (POOL_SLOT * median))));
  const hw = (0.36 * L) / Math.max(1, K);
  const pools = Array.from({ length: K }, (_, k) => ({ c: ((k + 0.5 + uniform(r, -0.1, 0.1)) / K) * L, h: 1 }));
  if (K > 0) {
    const peak = int(r, 0, K - 1);
    pools.forEach((p, k) => (p.h = k === peak ? 1 : uniform(r, 0.75, 1)));
  }
  const ends = [uniform(r, 0, 0.3), uniform(r, 0, 0.3)];
  const club = (0.3 * L) / Math.max(1, K);
  const profile = (s: number, shape: number) => {
    let p = 0;
    for (const q of pools) {
      const x = (s - q.c) / hw;
      if (x > -1 && x < 1) p = Math.max(p, q.h * Math.cos((Math.PI / 2) * x) ** shape);
    }
    if (s < club) p = Math.max(p, ends[0] * Math.cos(((Math.PI / 2) * s) / club) ** 2);
    if (L - s < club) p = Math.max(p, ends[1] * Math.cos(((Math.PI / 2) * (L - s)) / club) ** 2);
    return p;
  };
  // Pool centres and the pinches between them are always nodes.
  const specials: number[] = [];
  pools.forEach((q, k) => {
    specials.push(q.c);
    if (k > 0) specials.push((pools[k - 1].c + q.c) / 2);
  });

  // Nodes: none inside a kink's clearance, so the inner side of a sharp turn
  // can't fold back over its neighbours.
  const clear = turns.map((t, k) => Math.min(0.45 * Math.min(segs[k].d, segs[k + 1].d), 0.95 * median * Math.tan((t * DEG) / 2)));
  let spacing = Math.max(3, median / 2);
  let nodes = nodePositions(Sv, clear, spacing, specials);
  for (let tries = 0; phone && nodes.s.length > PHONE_NODES && tries < 8; tries++) {
    spacing *= (nodes.s.length / PHONE_NODES) * 1.08;
    nodes = nodePositions(Sv, clear, spacing, specials);
  }
  if (phone && nodes.s.length > PHONE_NODES) nodes = nodePositions(Sv, clear.map(() => 0), L / (PHONE_NODES - 1), []);
  const sNodes = nodes.s;
  const n = sNodes.length;

  // Widths, solved on the nodes so the median and the max/min ratio are
  // exact. The widest comes out at R / (1 + (R − 1)·pMed) × the median, so a
  // fuller shape (a higher median profile) swells less: it fills out until
  // the widest pool is no wider than it is long, nor than POOL_MAX medians.
  const width = new Array<number>(n);
  if (K > 0) {
    let R = uniform(r, POOLS.ratio[0], POOLS.ratio[1]);
    // The profile on the nodes and its order statistics, kept for the shape
    // they were taken at: a lower ratio only changes the lift.
    let measured = NaN;
    const p = new Array<number>(n);
    let pMed = 0;
    let pMin = 0;
    let pMax = 0;
    const measure = (shape: number) => {
      if (shape === measured) return;
      measured = shape;
      for (let i = 0; i < n; i++) p[i] = profile(sNodes[i], shape);
      const sorted = Float64Array.from(p).sort();
      pMed = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
      pMin = sorted[0];
      pMax = sorted[sorted.length - 1];
    };
    const lift = () => (pMax - R * pMin > 1e-6 ? (pMax - R * pMin) / (R - 1) : 0.25 * Math.max(pMax, 1e-3));
    // The widest node's width at this shape and ratio.
    const widest = (shape: number) => {
      measure(shape);
      const l = lift();
      return (median / (l + pMed)) * (l + pMax);
    };
    let shape: number = POOL_SHAPE[0];
    const most = Math.min(POOL_ROUND * 2 * hw, POOL_MAX * median);
    while (widest(shape) > most && shape > POOL_SHAPE[1]) shape = Math.max(POOL_SHAPE[1], 0.7 * shape);
    // Still too wide at the fullest shape (nodes mostly in the pinches and
    // the clubs, on a ribbon only a few widths long): a lower ratio, down to
    // the measured least.
    for (let tries = 0; tries < 6 && R > POOLS.least && widest(shape) > most; tries++) R = Math.max(POOLS.least, 0.85 * R);
    // The widths at the shape and ratio it ended on.
    measure(shape);
    const l = lift();
    const b = median / (l + pMed);
    for (let i = 0; i < n; i++) width[i] = b * (l + p[i]);
  } else {
    const ph = uniform(r, 0, TAU);
    const lam = uniform(r, 0.25, 0.5) * L;
    const v = sNodes.map((s) => (1 + 0.2 * Math.sin((TAU * s) / lam + ph)) * (0.55 + 0.45 * Math.min(1, (4 * s) / L, (4 * (L - s)) / L)));
    const sorted = Float64Array.from(v).sort();
    const vMed = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    for (let i = 0; i < n; i++) width[i] = (median * v[i]) / vMed;
  }

  // Positions: the zigzag plus a slow wobble, off the track. Where the track
  // bends tighter than that leaves room for (the inner edge would turn inside
  // out), the offset is pulled out of the bend, by a correction spread over
  // two widths either side so the path bends there instead of jumping.
  const ph1 = uniform(r, 0, TAU);
  const ph2 = uniform(r, 0, TAU);
  const lam1 = uniform(r, 20, 32) * median;
  const lam2 = uniform(r, 12, 18) * median;
  const half = 1.2 * median;
  const at: { p: Vec2; T: Vec2 }[] = [];
  const off: number[] = [];
  const over: number[] = []; // how far each node leans too far into a left bend
  const under: number[] = []; // and into a right one
  let seg = 0;
  for (let i = 0; i < n; i++) {
    const s = sNodes[i];
    while (seg < segs.length - 1 && s > Sv[seg + 1]) seg++;
    const f = s - Sv[seg];
    const a = trackAt(place.tr, place.s0 + place.dir * (V[seg][0] + f * Math.cos(segs[seg].a)));
    const o = V[seg][1] + f * Math.sin(segs[seg].a) + WOBBLE * median * (0.67 * Math.sin((TAU * s) / lam1 + ph1) + 0.33 * Math.sin((TAU * s) / lam2 + ph2));
    const kap = place.dir * a.kap;
    const room = Math.abs(kap) > 1e-9 ? 0.7 / Math.abs(kap) - half : Infinity; // the most the offset may lean into the bend
    at.push({ p: a.p, T: [place.dir * a.T[0], place.dir * a.T[1]] });
    off.push(o);
    over.push(kap > 0 ? Math.max(0, o - room) : 0);
    under.push(kap < 0 ? Math.max(0, -room - o) : 0);
  }
  const lower = spread(sNodes, over, 2 * median);
  const raise = spread(sNodes, under, 2 * median);
  const path = at.map(({ p, T }, i): Vec2 => {
    const o = off[i] - lower[i] + raise[i];
    return [p[0] - T[1] * o, p[1] + T[0] * o];
  });

  // Edge wobble, side by side.
  const lamE = uniform(r, 0.012, 0.03) * S;
  const phL = uniform(r, 0, TAU);
  const phR = uniform(r, 0, TAU);
  const left = width.map((w, i) => (w / 2) * (1 + EDGE_WOBBLE * Math.sin((TAU * sNodes[i]) / lamE + phL)));
  const right = width.map((w, i) => (w / 2) * (1 + EDGE_WOBBLE * Math.sin((TAU * sNodes[i]) / lamE + phR)));

  // The core: runs grown out from the widest pools' centres, node by node
  // toward the wider side, until they cover 30–70 % of the length. No cyan
  // below 0.009 S, nor where the core and its ink lines wouldn't fit inside
  // the band.
  const core = new Array<number>(n).fill(0);
  const coreShift = new Array<number>(n).fill(0);
  const line = Math.max(1, 0.0022 * S);
  if (K > 0) {
    const target = uniform(r, CORE.coverage[0], CORE.coverage[1]) * L;
    const shareBase = uniform(r, CORE.share[0], CORE.share[1]);
    const shift = (r() < 0.5 ? -1 : 1) * uniform(r, CORE.shift[0], CORE.shift[1]);
    const phase = uniform(r, 0, TAU);
    const sh = sNodes.map((s) => shareBase * (1 + CORE.wobble * Math.sin((TAU * s) / (6 * median) + phase)));
    const fits = (i: number) => core[i] === 0 && width[i] >= CORE.thin * S && (Math.abs(shift) + sh[i]) * (width[i] / 2) + 2 * line <= width[i] / 2;
    const gap = (i: number) => hyp(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]); // node i to i + 1, as drawn
    // The drawn length a node adds to the core: its links to cored neighbours.
    const gain = (i: number) => (i > 0 && core[i - 1] > 0 ? gap(i - 1) : 0) + (i < n - 1 && core[i + 1] > 0 ? gap(i) : 0);
    let covered = 0;
    const take = (i: number) => {
      covered += gain(i);
      core[i] = sh[i];
      coreShift[i] = shift * (width[i] / 2);
    };
    let all = 0;
    for (let i = 0; i < n - 1; i++) all += gap(i);
    const goal = (target / L) * all;
    const byHeight = pools.map((q, k) => ({ q, k })).sort((x, y) => y.q.h - x.q.h || x.k - y.k);
    for (const { q } of byHeight) {
      if (covered >= goal) break;
      let c = 0;
      for (let i = 1; i < n; i++) if (Math.abs(sNodes[i] - q.c) < Math.abs(sNodes[c] - q.c)) c = i;
      if (!fits(c) || covered + gain(c) > CORE.most * all) continue;
      take(c);
      let a = c;
      let b = c;
      while (covered < goal) {
        const left = a > 0 && fits(a - 1) && covered + gain(a - 1) <= CORE.most * all;
        const right = b < n - 1 && fits(b + 1) && covered + gain(b + 1) <= CORE.most * all;
        if (!left && !right) break;
        if (left && (!right || width[a - 1] >= width[b + 1])) take(--a);
        else take(++b);
      }
    }
  }

  // Eyes: a thinner strand that splits off and rejoins.
  const eyes: Strand[] = [];
  if (K > 0 && !phone) {
    for (let e = 0, count = Math.floor(L / (EYE_EVERY * U) + r()); e < count; e++) {
      const le = Math.min(0.4 * L, uniform(r, 0.1, 0.22) * U);
      const a = uniform(r, 0.12 * L, Math.max(0.12 * L, 0.88 * L - le));
      const D = (r() < 0.5 ? -1 : 1) * uniform(r, 0.9, 1.4) * median;
      const strand: Vec2[] = [];
      for (let i = 0; i < n; i++) {
        const s = sNodes[i];
        if (s < a || s > a + le) continue;
        const nrm = normalAt(path, i);
        const o = D * Math.sin((Math.PI * (s - a)) / le);
        strand.push([path[i][0] + nrm[0] * o, path[i][1] + nrm[1] * o]);
      }
      if (strand.length >= 3) eyes.push({ path: strand, width: strand.map(() => 0.42 * median) });
    }
  }

  const sortedW = Float64Array.from(width).sort();
  const med = sortedW.length % 2 ? sortedW[(sortedW.length - 1) / 2] : (sortedW[sortedW.length / 2 - 1] + sortedW[sortedW.length / 2]) / 2;
  let lengthPx = 0;
  for (let i = 1; i < n; i++) lengthPx += hyp(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
  const rb: Ribbon = {
    main,
    path,
    width,
    left,
    right,
    core,
    coreShift,
    kinks: nodes.kinks,
    turns,
    pools: K,
    median: med,
    ratio: sortedW[sortedW.length - 1] / sortedW[0],
    length: lengthPx,
    extent: extentOf(path),
    eyes,
  };
  return rb;
}

// Node arc positions along the path: the vertices, an even run between each
// pair outside the kinks' clearances, and the special positions (inside a
// clearance too: the strip's inner side leaves out what would fold).
function nodePositions(Sv: number[], clear: number[], spacing: number, specials: number[]): { s: number[]; kinks: number[] } {
  const s = [0];
  const kinks: number[] = [];
  const nSeg = Sv.length - 1;
  for (let k = 0; k < nSeg; k++) {
    const a = Sv[k];
    const b = Sv[k + 1];
    const lo = a + (k > 0 ? clear[k - 1] : 0);
    const hi = b - (k < nSeg - 1 ? clear[k] : 0);
    const inner: { x: number; special: boolean }[] = [];
    if (hi > lo) {
      const count = Math.max(1, Math.ceil((hi - lo) / spacing));
      for (let i = 0; i <= count; i++) inner.push({ x: lo + ((hi - lo) * i) / count, special: false });
    }
    const mine = specials.filter((x) => x > a && x < b);
    const kept = inner.filter((p) => !mine.some((x) => Math.abs(x - p.x) < 0.3 * spacing));
    const all = [...kept, ...mine.map((x) => ({ x, special: true }))].sort((p, q) => p.x - q.x);
    const gap = Math.min(0.5, 0.25 * spacing);
    for (const p of all) if (p.x - s[s.length - 1] > gap && b - p.x > gap) s.push(p.x);
    s.push(b);
    if (k < nSeg - 1) kinks.push(s.length - 1);
  }
  return { s, kinks };
}

// The most of `need` within `reach` (arc length) of each node, averaged over
// the same reach: never less than `need` anywhere, and smooth.
function spread(s: readonly number[], need: readonly number[], reach: number): number[] {
  if (!need.some((v) => v > 0)) return need.map(() => 0);
  const n = s.length;
  const near = (i: number, f: (k: number) => void) => {
    for (let k = i; k >= 0 && s[i] - s[k] <= reach; k--) f(k);
    for (let k = i + 1; k < n && s[k] - s[i] <= reach; k++) f(k);
  };
  const most = need.map((_, i) => {
    let m = 0;
    near(i, (k) => (m = Math.max(m, need[k])));
    return m;
  });
  return most.map((_, i) => {
    let sum = 0;
    let count = 0;
    near(i, (k) => {
      sum += most[k];
      count++;
    });
    return sum / count;
  });
}

// The unit normal (−ty, tx) at node i: the mean of its two segments'.
function normalAt(path: readonly Vec2[], i: number): Vec2 {
  const n = path.length;
  const seg = (k: number): Vec2 => {
    const a = path[clamp(k, 0, n - 2)];
    const b = path[clamp(k, 0, n - 2) + 1];
    const len = hyp(b[0] - a[0], b[1] - a[1]) || 1;
    return [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
  };
  const p = seg(i - 1);
  const q = seg(i);
  const x = i === 0 ? q[0] : i === n - 1 ? p[0] : p[0] + q[0];
  const y = i === 0 ? q[1] : i === n - 1 ? p[1] : p[1] + q[1];
  const len = hyp(x, y) || 1;
  return [x / len, y / len];
}

// The largest distance between two nodes: between two corners of their
// convex hull (Andrew's monotone chain).
function extentOf(path: readonly Vec2[]): number {
  const pts = [...path].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const turn = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const chain = (order: readonly Vec2[]) => {
    const out: Vec2[] = [];
    for (const p of order) {
      while (out.length >= 2 && turn(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    return out.slice(0, -1);
  };
  const hull = pts.length < 3 ? pts : [...chain(pts), ...chain([...pts].reverse())];
  let best = 0;
  for (let i = 0; i < hull.length; i++) {
    const [x, y] = hull[i];
    for (let k = i + 1; k < hull.length; k++) {
      const dx = hull[k][0] - x;
      const dy = hull[k][1] - y;
      if (dx * dx + dy * dy > best) best = dx * dx + dy * dy;
    }
  }
  return Math.sqrt(best);
}

// ---- Thin bolts --------------------------------------------------------------------------------

// A thin bolt: off a track at 25–70°, a chord with a gentle two-sine wobble
// sized for its tortuosity, its ends tapered.
function buildBolt(r: Rng, tracks: Track[], fr: EnergyFrame, phone: boolean): Strand | null {
  const { S, U } = fr;
  const sum = tracks.reduce((s, t) => s + t.length, 0);
  let x = r() * sum;
  let pick = 0;
  while (pick < tracks.length - 1 && x >= tracks[pick].length) x -= tracks[pick++].length;
  const at = trackAt(tracks[pick], uniform(r, 0, tracks[pick].length));
  const turn = (r() < 0.5 ? -1 : 1) * uniform(r, 25, 70) * DEG;
  const dir: Vec2 = [at.T[0] * Math.cos(turn) - at.T[1] * Math.sin(turn), at.T[0] * Math.sin(turn) + at.T[1] * Math.cos(turn)];
  const nrm: Vec2 = [-dir[1], dir[0]];
  const L = uniform(r, BOLTS.length[0], BOLTS.length[1]) * U;
  const w = uniform(r, BOLTS.width[0], BOLTS.width[1]) * S;
  const la = L * uniform(r, 0.6, 1);
  const lb = L * uniform(r, 0.25, 0.4);
  const pa = uniform(r, 0, TAU);
  const pb = uniform(r, 0, TAU);
  const goal = uniform(r, BOLTS.tortuosity[0], BOLTS.tortuosity[1]);
  const count = phone ? 16 : 20;
  const offsets = (amp: number) => Array.from({ length: count + 1 }, (_, i) => {
    const s = (L * i) / count;
    return amp * (0.7 * Math.sin((TAU * s) / la + pa) + 0.3 * Math.sin((TAU * s) / lb + pb)) * Math.sin((Math.PI * s) / L);
  });
  const tortuosity = (o: number[]) => {
    let len = 0;
    for (let i = 1; i <= count; i++) len += hyp(L / count, o[i] - o[i - 1]);
    return len / L;
  };
  let amp = 0.04 * L;
  for (let pass = 0; pass < 3; pass++) {
    const t = tortuosity(offsets(amp));
    if (t > 1 + 1e-9) amp *= Math.sqrt((goal - 1) / (t - 1));
  }
  const o = offsets(amp);
  const path = o.map((off, i): Vec2 => {
    const s = (L * i) / count;
    return [at.p[0] + dir[0] * s + nrm[0] * off, at.p[1] + dir[1] * s + nrm[1] * off];
  });
  // sin(π·i/count) can come out a hair under 0 at i = count: a fractional power of it would be NaN.
  return { path, width: path.map((_, i) => w * (0.45 + 0.55 * Math.max(0, Math.sin((Math.PI * i) / count)) ** 0.6)) };
}

// ---- Shapes and paint -----------------------------------------------------------------------

export interface LightningShapes {
  edge: Vec2[][]; // the ink, everything's full width
  band: Vec2[][];
  coreEdge: Vec2[][]; // the ink lines round the cores
  core: Vec2[][];
  pale: Vec2[][];
}

const shapeCache = new WeakMap<LightningPlan, LightningShapes>();

// The plan's polygons, band by band across all of it, so ribbons that cross
// merge into one another.
export function lightningShapes(plan: LightningPlan): LightningShapes {
  const hit = shapeCache.get(plan);
  if (hit) return hit;
  const e = plan.line;
  const out: LightningShapes = { edge: [], band: [], coreEdge: [], core: [], pale: [] };
  const paleMin = plan.band === 'late' || plan.band === 'mid' ? 0.012 : Infinity; // × S: a wide late core gets a pale streak
  for (const rb of plan.ribbons) {
    out.edge.push(strip(rb.path, rb.left, rb.right.map((v) => -v), true));
    out.band.push(strip(rb.path, rb.left.map((v) => Math.max(0.25, v - e)), rb.right.map((v) => -Math.max(0.25, v - e)), true));
    for (const [i0, i1] of runsOf(rb.core)) {
      const idx = Array.from({ length: i1 - i0 + 1 }, (_, k) => i0 + k);
      const P = idx.map((i) => rb.path[i]);
      const c = idx.map((i) => (rb.core[i] * rb.width[i]) / 2);
      const sh = idx.map((i) => rb.coreShift[i]);
      out.coreEdge.push(strip(P, c.map((v, k) => sh[k] + v + e), c.map((v, k) => sh[k] - v - e), false));
      out.core.push(strip(P, c.map((v, k) => sh[k] + v), c.map((v, k) => sh[k] - v), false));
      const wide = c.map((v) => 2 * v >= paleMin * (plan.line / 0.0022 >= 1 ? plan.line / 0.0022 : 1));
      for (const [k0, k1] of runsOf(wide.map((b) => (b ? 1 : 0)))) {
        const ks = Array.from({ length: k1 - k0 + 1 }, (_, k) => k0 + k);
        out.pale.push(strip(ks.map((k) => P[k]), ks.map((k) => sh[k] + 0.25 * c[k]), ks.map((k) => sh[k] - 0.25 * c[k]), false));
      }
    }
    for (const eye of rb.eyes) {
      out.edge.push(strip(eye.path, eye.width.map((w) => w / 2), eye.width.map((w) => -w / 2), true));
      out.band.push(strip(eye.path, eye.width.map((w) => Math.max(0.25, w / 2 - e)), eye.width.map((w) => -Math.max(0.25, w / 2 - e)), true));
    }
  }
  for (const b of plan.bolts) {
    out.edge.push(strip(b.path, b.width.map((w) => w / 2), b.width.map((w) => -w / 2), true));
    out.band.push(strip(b.path, b.width.map((w) => Math.max(0.25, w / 2 - e)), b.width.map((w) => -Math.max(0.25, w / 2 - e)), true));
  }
  shapeCache.set(plan, out);
  return out;
}

// A strip along `path` between offsets `left` and `right` (signed, + along
// the normal (−ty, tx)), with round caps when asked.
function strip(path: readonly Vec2[], left: readonly number[], right: readonly number[], caps: boolean): Vec2[] {
  const n = path.length;
  if (n < 2) return [];
  const T: Vec2[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = path[i + 1][0] - path[i][0];
    const dy = path[i + 1][1] - path[i][1];
    const len = hyp(dx, dy) || 1;
    T.push([dx / len, dy / len]);
  }
  const out = thin(side(path, T, left), SIMPLIFY);
  if (caps) out.push(...cap(path[n - 1], path[n - 2], [-T[n - 2][1], T[n - 2][0]], left[n - 1], right[n - 1]));
  const R = thin(side(path, T, right), SIMPLIFY);
  for (let i = R.length - 1; i >= 0; i--) out.push(R[i]);
  if (caps) out.push(...cap(path[0], path[1], [T[0][1], -T[0][0]], -right[0], -left[0]));
  return out;
}

// Douglas–Peucker: the polyline's points less those within `tol` px of the
// chord that skips them. The ends stay. The coordinates are copied into
// typed arrays first (kept between calls), for the inner loop's sake.
let thinX = new Float64Array(256);
let thinY = new Float64Array(256);
let thinKeep = new Uint8Array(256);
let thinStack = new Int32Array(512);
function thin(pts: Vec2[], tol: number): Vec2[] {
  const n = pts.length;
  if (n < 3) return pts;
  if (thinX.length < n) {
    thinX = new Float64Array(2 * n);
    thinY = new Float64Array(2 * n);
    thinKeep = new Uint8Array(2 * n);
    thinStack = new Int32Array(4 * n);
  }
  const xs = thinX;
  const ys = thinY;
  const keep = thinKeep;
  const stack = thinStack;
  for (let i = 0; i < n; i++) {
    xs[i] = pts[i][0];
    ys[i] = pts[i][1];
    keep[i] = 0;
  }
  keep[0] = 1;
  keep[n - 1] = 1;
  // Each split takes one pair off and puts two on: under 2n entries at once.
  let top = 0;
  stack[top++] = 0;
  stack[top++] = n - 1;
  while (top > 0) {
    const b = stack[--top];
    const a = stack[--top];
    const ax = xs[a];
    const ay = ys[a];
    const dx = xs[b] - ax;
    const dy = ys[b] - ay;
    const len = hyp(dx, dy);
    let far = -1;
    let most = tol;
    if (len > 1e-9) {
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs(dx * (ys[i] - ay) - dy * (xs[i] - ax)) / len;
        if (d > most) {
          most = d;
          far = i;
        }
      }
    } else {
      for (let i = a + 1; i < b; i++) {
        const d = hyp(xs[i] - ax, ys[i] - ay);
        if (d > most) {
          most = d;
          far = i;
        }
      }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack[top++] = a;
      stack[top++] = far;
      stack[top++] = far;
      stack[top++] = b;
    }
  }
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) if (keep[i] === 1) out.push(pts[i]);
  return out;
}

// One side of a strip, `off` (signed) from each node of `path` (T: its unit
// segment directions). A node turning by less than JOIN takes the bisector,
// lengthened toward the miter by at most ×1.18. A sharper turn (a kink) gets
// a round corner on its outer side, so a wide pool there doesn't come to a
// point, and the exact miter on its inner one, where the points either side
// that would fold back past the miter are left out: a fold turns a sliver of
// the ribbon inside out, a hole under the nonzero fill.
function side(path: readonly Vec2[], T: readonly Vec2[], off: readonly number[]): Vec2[] {
  const n = path.length;
  const out: Vec2[] = [];
  let guard = 1; // the points before this are behind a corner: never left out
  let fold: { M: Vec2; t: Vec2 } | null = null; // the last inner miter: points before it along t are left out
  const push = (q: Vec2) => {
    if (fold && (q[0] - fold.M[0]) * fold.t[0] + (q[1] - fold.M[1]) * fold.t[1] < 0) return;
    fold = null;
    out.push(q);
  };
  for (let i = 0; i < n; i++) {
    const p = path[i];
    const o = off[i];
    if (i === 0 || i === n - 1) {
      const t = T[i === 0 ? 0 : n - 2];
      push([p[0] - t[1] * o, p[1] + t[0] * o]);
      continue;
    }
    const a = T[i - 1];
    const b = T[i];
    const turn = Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]); // + toward the normal
    const nx = -a[1] - b[1]; // the two segments' normals, summed
    const ny = a[0] + b[0];
    const len = hyp(nx, ny);
    if (len < 1e-6) {
      push([p[0] - b[1] * o, p[1] + b[0] * o]);
      continue;
    }
    if (Math.abs(turn) < JOIN || o === 0) {
      const m = o / clamp((nx * -b[1] + ny * b[0]) / len, 0.85, 1) / len;
      push([p[0] + nx * m, p[1] + ny * m]);
    } else if (Math.sign(o) === Math.sign(turn)) {
      const m = o / Math.max(0.4, Math.cos(turn / 2)) / len;
      const M: Vec2 = [p[0] + nx * m, p[1] + ny * m];
      while (out.length > guard) {
        const q = out[out.length - 1];
        if ((q[0] - M[0]) * a[0] + (q[1] - M[1]) * a[1] <= 0) break;
        out.pop();
      }
      out.push(M);
      guard = out.length;
      fold = { M, t: b };
    } else {
      const steps = Math.ceil(Math.abs(turn) / JOIN);
      for (let k = 0; k <= steps; k++) {
        const c = Math.cos((turn * k) / steps);
        const s = Math.sin((turn * k) / steps);
        out.push([p[0] + (-a[1] * c - a[0] * s) * o, p[1] + (a[0] * c - a[1] * s) * o]);
      }
      guard = out.length;
      fold = null;
    }
  }
  return out;
}

// Three points of a round cap at `end`, facing away from `prev`, from the
// left offset round to the right one.
function cap(end: Vec2, prev: Vec2, N: Vec2, left: number, right: number): Vec2[] {
  const dx = end[0] - prev[0];
  const dy = end[1] - prev[1];
  const len = hyp(dx, dy) || 1;
  const T: Vec2 = [dx / len, dy / len];
  const nl = hyp(N[0], N[1]) || 1;
  const Nu: Vec2 = [N[0] / nl, N[1] / nl];
  const h = (left - right) / 2;
  const mid = (left + right) / 2;
  const c: Vec2 = [end[0] + Nu[0] * mid, end[1] + Nu[1] * mid];
  return [45, 90, 135].map((deg): Vec2 => {
    const a = deg * DEG;
    return [c[0] + h * (Math.cos(a) * Nu[0] + Math.sin(a) * T[0]), c[1] + h * (Math.cos(a) * Nu[1] + Math.sin(a) * T[1])];
  });
}

// Runs of consecutive non-zero entries, as [first, last] index pairs, 2 long or more.
function runsOf(v: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= v.length; i++) {
    const on = i < v.length && v[i] > 0;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      if (i - 1 > start) out.push([start, i - 1]);
      start = -1;
    }
  }
  return out;
}

// Paints the plan at its gain, as one layer: ink, band, the cores' ink, the
// cores, the pale streaks.
export function paintLightning(ctx: BrushTarget, make: MakeScratch, plan: LightningPlan | null, width: number, height: number) {
  if (!plan) return;
  const sh = lightningShapes(plan);
  faded(ctx, make, plan.gain, boxOf(sh.edge, 2, width, height), (c) => {
    fillUnion(c, sh.edge, plan.tones.edge);
    fillUnion(c, sh.band, plan.tones.band);
    fillUnion(c, sh.coreEdge, plan.tones.edge);
    fillUnion(c, sh.core, plan.tones.core);
    fillUnion(c, sh.pale, plan.tones.pale);
  });
}

// The glow: each ribbon's band as a body, each core run as a core, the eyes
// and bolts as bodies, at gain × boost.
export function emitLightning(sink: GlowSink, plan: LightningPlan | null) {
  if (!plan) return;
  const gain = plan.gain * plan.boost;
  for (const rb of plan.ribbons) {
    sink.stroke(rb.path, rb.median, plan.tones.band, 'body', gain);
    for (const [i0, i1] of runsOf(rb.core)) {
      const idx = Array.from({ length: i1 - i0 + 1 }, (_, k) => i0 + k);
      const path = idx.map((i): Vec2 => {
        const N = normalAt(rb.path, i);
        return [rb.path[i][0] + N[0] * rb.coreShift[i], rb.path[i][1] + N[1] * rb.coreShift[i]];
      });
      const widths = idx.map((i) => rb.core[i] * rb.width[i]).sort((a, b) => a - b);
      sink.stroke(path, widths[widths.length >> 1], plan.tones.core, 'core', gain);
    }
    for (const eye of rb.eyes) sink.stroke(eye.path, eye.width[0], plan.tones.band, 'body', gain);
  }
  for (const b of plan.bolts) sink.stroke(b.path, Math.max(...b.width), plan.tones.band, 'body', gain);
}

export function lightningLayer(ictx: ImpactContext, j: number, sources: readonly (readonly Vec2[])[], make: MakeScratch, opts: LightningOptions = {}): LayerDraw | null {
  const plan = ribbons(ictx, j, sources, opts);
  return plan ? { key: plan.key, draw: (ctx) => paintLightning(ctx, make, plan, ictx.width, ictx.height) } : null;
}
