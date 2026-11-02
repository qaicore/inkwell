// The seven impact frames (impact design §5, "The posters"; study impact.md
// §7.5–§7.8): flat two-tone posters aimed at P, each drawn from the layout's
// anchors (layout.ts), its own seeded streams, the palette and the figure
// (figure.ts). Sizes are in S, the frame's short side.
//   - IF1 whiteout: paper tinted toward p0 round the hot spot, three ink
//     shards upstream with their tips aimed at P, an unaimed wedge downstream,
//     and 46 ± 6 accent spindles along the ground line, all pointing at P.
//   - IF2 split: an ink disc upstream whose edge passes 0.017 S short of P
//     (layout.ts swings it until it splits the frame: two edges, a corner,
//     42–52 % of it), its visible edge feathered by 12–20 hairy paper tongues
//     biting in (and, on the comp, a dense comb of fine paper spikes), streaks
//     along it and a paper sliver where the axis leaves the frame. Gentle mode (G2) fills the disc with the tint and draws its edge
//     as a 0.012 S ink line.
//   - IF3 radial: 61 ± 6 speed lines 0.006 S wide (median; p90 0.012 S),
//     each broken into 2–4 dashes, converging on F, thinner on the striker's
//     side (weight 0.45 within ±45° of −u): 16 ± 3 inner ones at 0.16–0.32 S,
//     the rest in from the border to no nearer than 0.47 S, so nothing comes
//     within 0.07 S of F; a corner wedge or two; a crosshair at 60 % accent,
//     its long line along the frame's short side.
//   - IF4 star: a screen-aligned four-point ink star at G, small stars in
//     whole ink rings at S1 and S2, and 8 big and 14 small spikes in from the
//     border, aimed at G, kept clear of where the star's arms leave the frame.
//   - IF5 negative cross: on ink, a paper cross at the same G running off
//     every edge, and rings: 0.476 S at ring5, 0.14 and 0.10 S at S1 and S2
//     with their crosshairs.
//   - IF6 streaks: 25 ± 4 accent wedges thrown back along −u on lines
//     through V6 (slid onto the frame as the HUD is), each at least half on
//     the frame; hairlines far upstream, two scribbles, a tan cross and a tick.
//   - IF7 negative strike: on ink, a paper comet up −u from P, its edges torn
//     by irregular teeth, its head stopping short of the crater, a splash of
//     6–12 ragged blades with orange hairlines bursting from round the crater
//     (round P when the crater is off the frame), the ink crater, four rings
//     and their marks.
// Z-order: field, field elements, lines, his mark, the figure, star or cross,
// HUD. No electricity on any poster. A few marks lie over him (Z.over):
// IF3's speed lines and IF6's fan on his paper fill, under his contour, and
// IF7's splash over his fist, so his paper fill can't hide them.
// The ink guard: a light field (IF2's ink split aside) carries at most 35 %
// ink. When the figure's silhouette would push past that, the body is drawn
// as a contour with the limbs kept solid; then the countable elements are
// dropped, largest first, until it holds. Areas are estimated from the
// shapes, clipped to the frame, so overlaps only make the guard stricter.
// The comp grade (impact.md §7.8, round 3's measurements of the comp): on
// light fields ink is graded by thickness, as the panel's is: thick ink stays
// p2 (black), and only ink within 0.006 S of paper (thin strokes, and a band
// along every thick shape's edge) turns warm brown, mix(p2, #5e2710, 0.85).
// Each thick ink shape carries its core, the shape shrunk 0.006 S, built with
// the shape (an offset loop turns inside out at a thin tip, so arms, wedges
// and spikes shrink their own profiles). Open paper is near white,
// mix(p1, white, 0.6) and at least as light as #fbfaf5; cream is only the
// 0.006 S fringe round ink shapes. The big ink shapes (IF1's shards, IF2's
// disc, IF4's star and spikes) get dry-brush hair: 6–14 streaks per 0.1 S of
// edge, 0.01–0.04 S long, 1–2 px wide, along the stroke's motion, ink frayed
// out past the edge and paper scratched into it. IF1 is the exception: its
// field tints toward the beam's fill (the strike colour the panel's pink
// stands for) from that near-white paper, and its ink is plum,
// mix(p2, p0, 0.3), as k7's is. On dark fields paper turns #fefcd6 and glows
// into the sink, which the compositor colours through the hot ramp
// (gentle.ts's posterHotRamp). `flat` skips the grade and the glow: the
// posters as the reference's flat panel, which is how the coverage targets
// were measured. In reduced mode (spec.redSafe) every tone goes through G4's
// redSafe.
// Every line is a fill where it can be (a stroke rasterises slower than a
// fill of the same edges) and every batch of one colour one path: the budget
// is 8 ms a poster at 1080×608 in Node. With opts.scratch IF6 draws its
// recoil copy once and blits it three times.
// Every draw is rng(seed, 'ifN', element, ...): no Math.random, clocks or
// ctx.filter, so two renders hash the same.
import type { Vec2 } from '../../types/effect.ts';
import type { MakeScratch } from '../../render/glow.ts';
import type { GlowSink, ImpactContext } from '../contracts.ts';
import { mixHex, roles, type Palette } from '../palette.ts';
import { int, normal, rng, uniform, type Rng } from '../rng.ts';
import { CONTOUR, EDGE, offsetLoop, offsetLoops, oriented, paintMarksAndFigure, perimeter, signedArea, type FigurePaint, type PosterFigure, type PosterTarget } from './figure.ts';
import { posterSpec, redSafe, type PosterSpec } from './gentle.ts';
import { physicalAt, placePhysical, posterLayout, reach, SPLIT_SHORT, type PosterLayout } from './layout.ts';

export { EDGE }; // S: ink this near paper is thin ink (brown in the comp); deeper is core (p2)

export const INK_CAP = 0.35; // of the frame: the most ink a light field carries
export const CREAM = '#fefcd6'; // the comp's paper on dark fields, and the fringe on light ones
export const ORANGE_BAND = '#db8c1b'; // IF7's comp band round the comet
const WARM_INK = '#5e2710'; // light fields' thin ink in the comp: mix(p2, this, 0.85)
const INK_GRADE = 0.85;
const PAPER_WHITE = 0.6; // light fields' open paper in the comp: mix(p1, white, 0.6) ...
const PAPER_MIN = '#fbfaf5'; // ... and at least this light (Rec.601 luma)
const IF1_INK = 0.3; // IF1's ink on its tint: mix(p2, p0, 0.3), k7's plum
const IF1_SPRAY = 0.45; // IF1's spray in the comp: mix(its plum, the beam's fill, 0.45), k7's magenta
const ACCENT_GRADE = 0.2; // light fields' accents, muted toward the paper
const RING_DARK = 0.45; // rings on dark fields: mix(ring, ink, 0.45), grey-brown
const FRINGE = 0.006; // S: the cream fringe outside ink shapes
const FRINGE_SHOWS = 12; // a fringe on plain paper this close to cream (largest channel gap, 0..255) can't be seen
const DEG = Math.PI / 180;
const CALM = 0.4; // G7 (gentle.ts): IF4's star, IF5's cross and IF7's comet at this × their width
// Dry-brush hair: per 0.1 S of edge, length (S), width (px); a third are
// paper; and on a stroke with a motion, only its dry end, past this fraction
// of the way along it (each hair is a fill of its own, about 7 µs in Node).
export const HAIR = { per: [6, 9], length: [0.01, 0.04], width: [1, 2], paper: 1 / 3, dry: 0.65 } as const;

// ---- The recipes' numbers (design §5's table; impact.md §4 and §7.6) -------------------

export const IF1 = {
  tint: [0.03, 0.17], // s(r) = 0.03 + 0.17·min(1, r/S) round the hot spot
  shards: [
    { area: 0.0408, at: [-0.47, -0.49], tip: 0.39 }, // area: of the frame; at: the centroid (a, b); tip: its distance from P
    { area: 0.0174, at: [-0.33, 0.41], tip: 0.31 },
    { area: 0.0066, at: [-0.8, -0.26], tip: 0.74 },
  ],
  areaSpread: 0.25, // each shard's area × 1 ± this
  aim: 11, // degrees: shard tips point at P within this
  // A shard is a brush dagger: its tip toward P, widest 60–70 % of the way
  // back, and a ragged tail splitting into 3–6 hairs.
  dagger: { widest: [0.6, 0.7], hairs: [3, 6], reach: [0.15, 0.45] },
  wedge: { area: 0.008, at: [0.18, -0.17], off: 49 }, // downstream, not aimed: its axis this far off P's
  // 46 ± 6 spindles. The panel's sizes are of its strokes of 40 px or more,
  // so the draws are held to that: lognormal [median, σ, min, max].
  spray: { count: [40, 52], u: [0.02, 0.15], length: [0.054, 0.55, 0.03, 0.29], width: [0.008, 0.45, 0.005, 0.018], aim: 12 },
} as const;

export const IF2 = {
  short: SPLIT_SHORT, // the disc's edge stops this far short of P (layout.ts swings disc2 so the disc splits the frame)
  wobble: 0.012, // its edge's ripple, ± S
  clearP: 0.2, // S: no tongue or streak on the edge this near P, where he stands
  tongues: { count: [12, 20], length: [0.024, 0.063], base: [0.01, 0.022], spread: 25, hairs: [1, 3] }, // hairs: paper hairs out of each tongue's tip
  // The comb (comp): k8's visible edge is a dry brush's, a dense comb of fine
  // paper spikes biting 0.01–0.055 S into the disc, 10–16 to each 0.1 S of
  // edge, leaning together (± `lean`°, each ± `spread`° more). The flat
  // poster keeps its half-ink feather instead.
  comb: { per: [10, 16], length: [0.01, 0.055], base: [0.0025, 0.0065], lean: 30, spread: 12 },
  streaks: { count: [6, 10], length: [0.1, 0.47], width: [0.003, 0.01], off: [0.01, 0.06] },
  sliver: { length: [0.26, 0.32], width: [0.07, 0.09], streaks: [2, 4] },
  edgeLine: 0.012, // G2: the tinted disc's ink edge
  // The edge's feather on the flat poster: the disc grown 0.012 S at half ink
  // under it, so a band that wide outside the edge goes mid-grey (the flat
  // panel's 1.5 % mid). The comp has its cream fringe there instead.
  feather: { width: 0.012, alpha: 0.5 },
} as const;

export const IF3 = {
  count: [55, 67],
  inner: { count: [13, 19], from: [0.16, 0.28], to: 0.32 },
  outer: 0.47, // the outer lines' inner ends stay this far from F
  clear: 0.07, // nothing nearer F than this
  upstream: 0.45, // the angular weight within ±45° of −u
  length: [0.09, 0.55, 0.03, 0.31],
  width: [0.006, 0.54, 0.002, 0.018], // median 0.006 S, p90 0.012 S: hairlines, not spikes
  dashes: [2, 4], // each line broken into this many dashes
  gap: [0.08, 0.2], // of a line's length, between two dashes
  tilt: 4, // degrees off radial
  corners: { length: [0.2, 0.28], width: [0.06, 0.08] },
  crosshair: { short: 0.65, long: 0.31, weights: [0.006, 0.004], alpha: 0.6, tilt: 4 }, // k9's crosshair is about 2 px in the comp
} as const;

export const IF4 = {
  star: { reach: 0.75, wide: 0.05, core: 0.09, coreReach: 0.2, scale: [0.85, 1.3] }, // t(r) = S·[0.05(1 − (r/0.75 S)²)₊ + 0.09(1 − r/0.2 S)₊]
  small: [
    { at: 'S1', reach: [0.165, 0.175], width: 0.008, core: 0.03, coreReach: 0.035, ring: 0.072 }, // reach: [long side, short side]
    { at: 'S2', reach: [0.075, 0.075], width: 0.005, core: 0.018, coreReach: 0.02, ring: 0.042 },
  ],
  spikes: { big: 8, small: 14, bigReach: [0.14, 0.21], bigBase: [0.05, 0.09], smallReach: [0.05, 0.1], smallBase: [0.015, 0.035], aim: 9, clear: 0.05 },
  ringWidth: 0.003, // the small stars' rings: whole, in ink
  hairClear: 0.1, // S: no hair within this of G, where the arms overlap
} as const;

export const IF5 = {
  cross: { base: 0.028, mid: 0.035, midReach: 0.5, core: 0.08, coreReach: 0.05 }, // t(r) = S·[0.028 + 0.035(1 − r/0.5 S)₊ + 0.08(1 − r/0.05 S)₊]: k11's arms are 0.025–0.038 S wide at 0.5–0.8 S
  rings: [
    { at: 'ring5', r: 0.476, cross: null },
    { at: 'S1', r: 0.14, cross: { long: 0.42, short: 0.38 } },
    { at: 'S2', r: 0.1, cross: { long: 0.23, short: 0.29 } },
  ],
  ringWidth: 0.003,
} as const;

export const IF6 = {
  // Length and width are lognormal on one draw, so the long streaks are the
  // wide ones: medians 0.05 and 0.009 S, max 0.57 and 0.087, the widths mostly
  // under 0.02 S, about 1.5 % of the frame (the panel's 2.2 % accent, with the
  // hairlines and scribbles).
  // Each starts 0.04–0.2 S up −u from V6 (slid onto the frame by the
  // layout); one less than half on the frame is drawn again, up to `tries`.
  wedges: { count: [21, 29], spread: 11, from: [0.04, 0.2], length: [0.05, 1.1, 0.012, 0.57], width: [0.009, 0.75, 0.005, 0.087], jitter: 0.25, shows: 0.5, tries: 12 },
  hairlines: { count: [3, 5], from: [-0.55, -0.5], to: [-0.8, -0.7], side: [-0.15, 0.25], spread: 6, width: 0.0025 },
  scribbles: { along: 0.25, across: 0.1, turns: [9, 13], width: 0.004 },
  cross: { short: 0.37, long: 0.13 },
  tick: 0.13,
  markWidth: 0.004,
} as const;

export const IF7 = {
  // Half-widths along the comet (s in S up −u from P): the envelope is 0.11 S
  // across at P and 0.16 at 0.04 S (k13's solid beam: its 0.28 S there is
  // the beam with its splash), 0.21 at 0.2–0.5 and 0.11 at 1.0 (k13's outer
  // extent); its head is a round cap stopping 0.03 S past P, short of the
  // crater, so the burst rings a dark core as k13's does; and its edges are
  // torn by irregular teeth, 0.01–0.05 S apart and 0.005–0.03 S deep,
  // trailing back up the axis, so its fill lands near the panel's 8.7 %
  // paper. With the splash it covers about 60 / 45 / 14 % of the circles
  // 0.05 / 0.08–0.11 / 0.25 S round P (k13's; impact.md §4.7).
  comet: { head: 0.03, half: [[0, 0.055], [0.04, 0.08], [0.2, 0.105], [0.5, 0.105], [1, 0.055], [1.6, 0.03]], teeth: [0.01, 0.05], depth: [0.005, 0.03], tilt: 2 },
  // The splash: 6–12 ragged blades 0.05–0.2 S long (two of them long) out
  // of a ring round the crater (round P when the crater is off the frame),
  // clear of the comet, each with a hairline running on past its tip; over
  // him, so his fist doesn't hide it.
  splash: { count: [6, 12], length: [0.05, 0.13], long: 0.2, base: [0.025, 0.05], clear: 25, ring: 0.03, notches: [2, 4], hairline: [0.3, 0.8], hairWidth: 0.0025 },
  crater: 0.03,
  band: 0.07, // the orange band's stroke (half of it shows)
  rings: [
    { at: 'ring7', r: 0.54, mark: null },
    { at: 'cross6', r: 0.25, mark: 'plus' },
    { at: 'ring7c', r: 0.17, mark: 'plus' },
    { at: 'ring7d', r: 0.05, mark: 'crosshair' },
  ],
  crosshair: { short: 0.6, long: 0.35 },
  plus: [0.03, 0.06],
  bar: { short: 0.07, long: 0.04 },
  ringWidth: 0.004,
} as const;

// ---- Tones ----------------------------------------------------------------------------------

export interface PosterTones {
  field: string; // the field's solid colour
  fg: string; // the motif: ink on light fields (thick ink, in the comp), paper on dark ones
  edge: string | null; // light comp: thin ink and the 0.006 S band along thick ink's edge (null: fg throughout)
  bg: string; // the field's tone, for shapes cut back into it
  accent: string;
  ring: string;
  tan: string;
  orange: string;
  tint(s: number): string; // IF1's field and G2's disc: paper toward p0 (the beam's fill in the comp) by s, G3 applied
  fringe: string | null; // the cream fringe outside ink shapes (light comp)
  emit: string | null; // what paper shapes glow in (dark comp)
}

// The tones poster `spec` paints with, graded for the comp unless `flat`.
export function posterTones(palette: Palette, spec: PosterSpec, flat = false): PosterTones {
  const [p0, p1, p2] = palette;
  const light = spec.field === 'light';
  const comp = light && !flat;
  const whiteout = comp && spec.si === 0;
  const paper = flat ? p1 : openPaper(p1);
  const R = roles([p0, paper, p2]);
  const ink = whiteout ? mixHex(p2, p0, IF1_INK) : p2;
  const thin = whiteout ? ink : mixHex(p2, WARM_INK, INK_GRADE);
  // In the comp the tint runs toward the beam's fill, the colour the strike
  // shows; the flat poster keeps the panel's tint toward p0.
  const tint = flat ? R : roles([R.strike.fill, paper, p2]);
  const safe = spec.redSafe ? redSafe : (c: string) => c;
  const ring = flat || light ? R.ring : mixHex(R.ring, p2, RING_DARK);
  const accent = whiteout ? mixHex(ink, R.strike.fill, IF1_SPRAY) : comp ? mixHex(R.accent, paper, ACCENT_GRADE) : R.accent;
  return {
    field: safe(light ? paper : p2),
    fg: safe(light ? ink : flat ? p1 : CREAM),
    edge: comp ? safe(thin) : null,
    bg: safe(light ? paper : p2),
    accent: safe(accent),
    ring: safe(ring),
    tan: safe(ring),
    orange: safe(ORANGE_BAND),
    tint: (s) => safe(tint.tint(s, spec.minL)),
    fringe: comp ? safe(CREAM) : null,
    emit: !light && !flat && !spec.calm ? safe(CREAM) : null,
  };
}

// Light fields' open paper in the comp: p1 most of the way to white, and no
// darker than #fbfaf5 (Rec.601 luma), the panel's open paper being
// #fdfdfd–#ffffff where the cream grade left it #f9f6dc.
export function openPaper(p1: string): string {
  const floor = luma601(PAPER_MIN);
  let t = PAPER_WHITE;
  let c = mixHex(p1, '#ffffff', t);
  while (luma601(c) < floor && t < 1) {
    t = Math.min(1, t + 0.02);
    c = mixHex(p1, '#ffffff', t);
  }
  return c;
}

function luma601(color: string): number {
  const x = parseInt(color.slice(1), 16);
  return 0.299 * ((x >> 16) & 255) + 0.587 * ((x >> 8) & 255) + 0.114 * (x & 255);
}

// ---- Shapes ---------------------------------------------------------------------------------

// The z-order: field elements, lines, his mark, the figure, what lies over
// him (IF3's lines and IF6's fan between his paper fill and his contour,
// IF7's splash), star or cross, HUD.
export const Z = { element: 1, line: 2, mark: 3, figure: 4, over: 5, star: 6, hud: 7 } as const;
type Layer = (typeof Z)[keyof typeof Z];
export type PosterRole = 'fg' | 'bg' | 'accent' | 'ring' | 'tan' | 'orange' | 'tint';
type Role = PosterRole;

// A circular arc, centre c, radius r, from angle a0 to a1 (radians, y down).
export interface PosterArc {
  c: Vec2;
  r: number;
  a0: number;
  a1: number;
}
type Arc = PosterArc;

// One batch of a poster's shapes: one colour, one layer, one path.
export interface PosterShape {
  z: Layer;
  role: Role;
  polys?: Vec2[][]; // filled, each one wound positive
  core?: (Vec2[] | null)[]; // light comp, fg: each poly shrunk 0.006 S (null: thin), painted fg over the polys in the edge tone; no cores: thin ink, edge tone throughout
  lines?: Vec2[][]; // stroked
  arcs?: Arc[]; // stroked with the lines
  closed?: boolean; // the lines are loops
  width?: number; // stroke width, px
  cap?: 'round' | 'butt';
  alpha?: number;
  area: number; // px² on the frame: the ink guard's estimate
  trim: boolean; // a countable element the guard may drop
  glow: boolean; // paper that glows on dark fields
  fringe?: boolean; // false: no comp fringe (bands and edges that only shape another fill)
  of?: { shape: PosterShape; at: number[] }; // hair: the batch it grew on, and which of its polys each hair is on (the guard drops them together)
}
type Shape = PosterShape;

// What a poster's recipe builds, before the ink guard and the paint.
export interface PosterDraft {
  si: number;
  L: PosterLayout;
  spec: PosterSpec;
  light: boolean;
  comp: boolean; // the comp grade is on (not flat)
  shapes: PosterShape[];
  field: 'solid' | 'tint';
  disc: Vec2[] | null; // IF2's ink split, for the figure's XOR
  centre: Vec2 | null; // the star or cross at G, IF3's F
  counts: Record<string, number>;
}

interface Draft extends PosterDraft {
  r(element: number, ...ints: number[]): Rng;
  inset: number; // px: 0.006 S where the comp grades this poster's ink by thickness, else 0 (no cores to build)
}

export interface PosterOptions {
  spec?: PosterSpec; // the plan's spec for this poster (gentle.ts); posterSpec(si, ictx.flash) when missing
  flat?: boolean; // the flat poster: no comp grade and no glow
  tint?: boolean; // IF1's tinted field; false paints it plain paper (default true)
  layout?: PosterLayout; // posterLayout(ictx), when the caller already has it
  scratch?: MakeScratch; // a scratch canvas maker (the brushes' and the glow's): IF6 blits its recoil copies from one
}

export interface PosterReport {
  si: number;
  spec: PosterSpec;
  light: boolean;
  ink: number; // the guard's estimate of the ink share, 0..1 (light fields; 1 on dark ones)
  contour: boolean; // the guard drew his body as a contour
  trimmed: number; // elements the guard dropped
  centre: Vec2 | null; // G on IF4 and IF5, F on IF3
  counts: Record<string, number>; // elements drawn, by kind
}

export type PosterContext = Pick<ImpactContext, 'frame' | 'width' | 'height' | 'seed' | 'palette'> & Partial<Pick<ImpactContext, 'flash'>>;

// Poster si on ctx (frame px, the whole frame), with its glow into `sink`.
// `figure` is figure.ts's posterFigure for the same poster (NO_FIGURE for none).
export function drawPoster(ctx: PosterTarget, sink: GlowSink, ictx: PosterContext, si: number, figure: PosterFigure, opts: PosterOptions = {}): PosterReport {
  const d = draft(ictx, si, opts);
  const guard = inkGuard(d, figure);
  const tones = posterTones(ictx.palette, d.spec, !d.comp);
  paint(ctx, sink, d, tones, figure, guard.contour, opts.scratch);
  return { si, spec: d.spec, light: d.light, ink: guard.ink, contour: guard.contour, trimmed: guard.trimmed, centre: d.centre, counts: d.counts };
}

// What poster si would draw, before the ink guard: its shapes in frame px,
// for the tests to measure.
export const posterShapes = (ictx: PosterContext, si: number, opts: PosterOptions = {}): PosterDraft => draft(ictx, si, opts);

function draft(ictx: PosterContext, si: number, opts: PosterOptions): Draft {
  if (!Number.isInteger(si) || si < 0 || si > 6) throw new Error(`a poster is si 0..6 (got ${si})`);
  const spec = opts.spec ?? posterSpec(si, ictx.flash ?? 'full');
  if (spec.si !== si) throw new Error(`poster ${si} was given the spec of poster ${spec.si}`);
  const stream = `if${si + 1}`;
  const L = opts.layout ?? posterLayout(ictx);
  const light = spec.field === 'light';
  const comp = !(opts.flat ?? false);
  const d: Draft = {
    si,
    L,
    spec,
    light,
    comp,
    shapes: [],
    field: 'solid',
    disc: null,
    centre: null,
    counts: {},
    r: (element, ...ints) => rng(ictx.seed, stream, element, ...ints),
    inset: comp && light && si !== 0 ? EDGE * L.S : 0, // IF1's plum isn't graded
  };
  RECIPES[si](d);
  if (opts.tint === false) d.field = 'solid';
  return d;
}

// ---- IF1 whiteout ---------------------------------------------------------------------------

function whiteout(d: Draft) {
  const { L } = d;
  const S = L.S;
  const frame = L.width * L.height;
  d.field = 'tint';
  const daggers: Brushed[] = IF1.shards.map((s, i) => {
    const r = d.r(0, i);
    const area = s.area * frame * uniform(r, 1 - IF1.areaSpread, 1 + IF1.areaSpread);
    const C = physicalAt(L, s.at[0] + uniform(r, -0.03, 0.03), s.at[1] + uniform(r, -0.03, 0.03));
    const tip = Math.max(0.1, s.tip + uniform(r, -0.03, 0.03)) * S;
    const k = dagger(r);
    const length = Math.max(len(sub(C, L.P)) - tip, 0.05 * S) / k.cx; // so the tip lands `tip` from P
    const axis = rotate(unit(sub(C, L.P)), uniform(r, -IF1.aim, IF1.aim)); // the tip toward P
    return { poly: placed(L, shard(k, C, axis, length, area)), dir: axis };
  });
  const shards = fill(Z.element, 'fg', daggers.map((b) => b.poly), L, { trim: true });
  d.shapes.push(shards);
  pushHair(d, Z.element, daggers, d.r(3), shards);
  {
    const r = d.r(1);
    const { area, at, off } = IF1.wedge;
    const A = area * frame * uniform(r, 0.8, 1.2);
    const C = physicalAt(L, at[0] + uniform(r, -0.03, 0.03), at[1] + uniform(r, -0.03, 0.03));
    const axis = rotate(unit(sub(C, L.P)), (r() < 0.5 ? -1 : 1) * uniform(r, off - 15, off + 15));
    const length = Math.sqrt(6 * A); // elongation about 3.5
    d.shapes.push(fill(Z.element, 'fg', [placed(L, shard(kite(r), C, axis, length, A))], L, { trim: true }));
  }
  const r = d.r(2);
  const { count, u, length, width, aim } = IF1.spray;
  const n = int(r, count[0], count[1]);
  const along = [-reach(L.P, neg(L.v), L.width, L.height), reach(L.P, L.v, L.width, L.height)]; // the ground line through P, on the frame
  const drawn: { C: Vec2; toP: Vec2; zl: number; zw: number }[] = [];
  for (let i = 0; i < n; i++) {
    // A spindle on P itself is drawn again elsewhere on the line.
    let C: Vec2 = L.P;
    for (let k = 0; k < 8 && len(sub(L.P, C)) < 0.04 * S; k++) C = add(add(L.P, L.u, normal(r, u[0], u[1]) * S), L.v, uniform(r, along[0], along[1]));
    if (len(sub(L.P, C)) < 0.04 * S) continue;
    drawn.push({ C, toP: rotate(unit(sub(L.P, C)), uniform(r, -aim, aim)), zl: normal(r), zw: normal(r) });
  }
  // The sizes are held to the panel's medians: 46 lognormal draws stray
  // ±10 % from theirs, so the draws are centred on their own median first.
  const zl = middle(drawn.map((q) => q.zl));
  const zw = middle(drawn.map((q) => q.zw));
  const spindles = drawn.map(({ C, toP, ...q }) => {
    const l = lognormalAt(length, q.zl - zl) * S;
    return placed(L, spindle(C, toP, l, Math.min(lognormalAt(width, q.zw - zw) * S, l / 3)));
  });
  d.shapes.push(fill(Z.line, 'accent', spindles, L, { trim: true }));
  count1(d, { shards: IF1.shards.length, wedge: 1, spray: spindles.length });
}

// A shard's shape: its tip at x = 0 and its far end near x = 1, with its
// centroid (cx, cy) and area in those units.
interface Kite {
  pts: Vec2[];
  cx: number;
  cy: number;
  area: number;
}

function kite(r: Rng): Kite {
  const side = (k: number) => ([[0.3, 0.55], [0.6, 1], [0.88, 0.6]] as const).map(([x, y]): Vec2 => [x * uniform(r, 0.94, 1.06), k * y * uniform(r, 0.85, 1.15)]);
  const pts: Vec2[] = [[0, 0], ...side(1), [1, uniform(r, -0.2, 0.2)], ...side(-1).reverse()];
  const [cx, cy] = centroid(pts);
  return { pts, cx, cy, area: Math.abs(signedArea(pts)) };
}

// A brush dagger (k7's shards): the tip at x = 0, widest 60–70 % of the way
// back, then a ragged tail splitting into 3–6 hairs that reach on past x = 1.
function dagger(r: Rng): Kite {
  const { widest, hairs, reach: tailReach } = IF1.dagger;
  const m = uniform(r, widest[0], widest[1]);
  const side = (k: number): Vec2[] => [
    [0.3 * m, k * 0.42 * uniform(r, 0.85, 1.15)],
    [0.68 * m, k * 0.8 * uniform(r, 0.9, 1.1)],
    [m, k],
    [m + 0.07, k * 0.78],
  ];
  // The tail: prongs across it from the top side to the bottom one, each a
  // hair with its own reach, notched back between.
  const nh = int(r, hairs[0], hairs[1]);
  const prongs: Vec2[] = [];
  for (let j = 0; j < nh; j++) {
    const y0 = 0.78 - (1.56 * j) / nh;
    const y1 = 0.78 - (1.56 * (j + 1)) / nh;
    prongs.push([1 + uniform(r, tailReach[0], tailReach[1]), (y0 + y1) / 2 + uniform(r, -0.08, 0.08)]);
    if (j < nh - 1) prongs.push([m + 0.1 + uniform(r, 0.02, 0.14), y1]);
  }
  const pts: Vec2[] = [[0, 0], ...side(1), ...prongs, ...side(-1).reverse()];
  const [cx, cy] = centroid(pts);
  return { pts, cx, cy, area: Math.abs(signedArea(pts)) };
}

// The kite `length` long along `axis` (its tip toward −axis), centred on C and
// scaled across to cover `area` px².
function shard(k: Kite, C: Vec2, axis: Vec2, length: number, area: number): Vec2[] {
  const w = area / Math.max(1e-9, k.area * length);
  return oriented(k.pts.map(([x, y]) => local(C, axis, (x - k.cx) * length, (y - k.cy) * w)));
}

// A polygon's area centroid.
function centroid(pts: readonly Vec2[]): Vec2 {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % n];
    const c = x0 * y1 - x1 * y0;
    a += c;
    cx += (x0 + x1) * c;
    cy += (y0 + y1) * c;
  }
  return Math.abs(a) < 1e-12 ? [pts[0][0], pts[0][1]] : [cx / (3 * a), cy / (3 * a)];
}

// A physical polygon placed by the layout (mirrored across P along u when it
// is wholly off the frame), wound positive again after the mirror.
const placed = (L: PosterLayout, poly: Vec2[]): Vec2[] => oriented(placePhysical(L, poly));

// A hair from `from`, `length` px along dir: `width` px at its widest, a
// third of the way, and pointed at both ends (four points: each hair is a
// fill of its own share of the path).
function needle(from: Vec2, dir: Vec2, length: number, width: number): Vec2[] {
  return oriented([from, local(from, dir, 0.3 * length, width / 2), local(from, dir, length, 0), local(from, dir, 0.3 * length, -width / 2)]);
}

// A shape for the dry brush: its outline, the way the brush moved along it
// (null: along the edge, all round), and where it gets no hair.
interface Brushed {
  poly: Vec2[];
  dir: Vec2 | null;
  skip?: (p: Vec2) => boolean;
}

// Where a stroke's dry end starts: HAIR.dry of the way along `dir` across
// the outline (−Infinity with no motion: hair all round).
function dryFrom(poly: readonly Vec2[], dir: Vec2 | null): number {
  if (!dir) return -Infinity;
  let lo = Infinity;
  let hi = -Infinity;
  for (const q of poly) {
    const s = dot(q, dir);
    if (s < lo) lo = s;
    if (s > hi) hi = s;
  }
  return lo + HAIR.dry * (hi - lo);
}

// Dry-brush hair on the items' edges, the light comp only: every
// 0.1 S / U(6, 14) of edge on the frame, a 1–2 px streak 0.01–0.04 S long
// along the brush's motion, a third of them paper scratched in from the edge
// and the rest ink frayed out past it (thin ink: the edge tone). Each starts
// a little back along its motion and 0.3–1.2 of its width off the edge.
// `source` is the batch the items are, index for index: a hair goes with its
// shape when the guard drops it.
function pushHair(d: Draft, z: Layer, items: readonly Brushed[], r: Rng, source?: Shape) {
  if (!d.comp || !d.light) return;
  const { L } = d;
  const S = L.S;
  const sets = { ink: { polys: [] as Vec2[][], at: [] as number[] }, paper: { polys: [] as Vec2[][], at: [] as number[] } };
  const spacing = () => (0.1 * S) / uniform(r, HAIR.per[0], HAIR.per[1]);
  items.forEach(({ poly, dir, skip }, at) => {
    const dry = dryFrom(poly, dir);
    let next = spacing() * r();
    for (let i = 0, n = poly.length; i < n; i++) {
      const a = poly[i];
      const e = sub(poly[(i + 1) % n], a);
      const el = len(e);
      if (el < 1e-6) continue;
      const t: Vec2 = [e[0] / el, e[1] / el];
      const out: Vec2 = [t[1], -t[0]]; // outward, the loop wound positive (y down)
      for (; next < el; next += spacing()) {
        const p = add(a, t, next);
        if ((dir && dot(p, dir) < dry) || !inside(p, L.width, L.height) || skip?.(p)) continue;
        const paper = r() < HAIR.paper;
        const l = uniform(r, HAIR.length[0], HAIR.length[1]) * S;
        const w = uniform(r, HAIR.width[0], HAIR.width[1]);
        let along = dir ?? t;
        if (dot(along, out) >= 0 === paper) along = neg(along); // ink frays out, paper scratches in
        const from = add(add(p, out, (paper ? -1 : 1) * uniform(r, 0.3, 1.2) * w), along, -uniform(r, 0.1, 0.35) * l);
        const set = paper ? sets.paper : sets.ink;
        set.polys.push(needle(from, along, l, w));
        set.at.push(at);
      }
      next -= el;
    }
  });
  for (const [role, set] of [['fg', sets.ink], ['bg', sets.paper]] as const) {
    if (set.polys.length === 0) continue;
    d.shapes.push({ ...fill(z, role, set.polys, L, { fringe: false }), of: source ? { shape: source, at: set.at } : undefined });
  }
}

// A spindle centred on C along `axis`: pointed at both ends, widest 0.4 of the way.
function spindle(C: Vec2, axis: Vec2, length: number, width: number): Vec2[] {
  const profile = [[0, 0], [0.15, 0.6], [0.4, 1], [0.7, 0.65], [1, 0]] as const;
  const o = add(C, axis, -length / 2);
  const top = profile.map(([x, y]) => local(o, axis, x * length, (y * width) / 2));
  const bottom = profile.slice(1, -1).map(([x, y]) => local(o, axis, x * length, (-y * width) / 2)).reverse();
  return oriented([...top, ...bottom]);
}

// ---- IF2 split ------------------------------------------------------------------------------

function split(d: Draft) {
  const { L, spec } = d;
  const S = L.S;
  const tinted = spec.disc === 'tint';
  const D = L.physical.disc2;
  const R = Math.max(0.05 * S, len(sub(D, L.P)) - IF2.short * S);
  const disc = rippledCircle(D, R, IF2.wobble * S, d.r(0));
  d.disc = tinted ? null : disc;
  if (tinted) {
    // G2: the edge line is the disc grown by half of it in ink, under the
    // tinted disc shrunk by half.
    const edge = IF2.edgeLine * S;
    d.shapes.push(fill(Z.element, 'fg', [offsetLoop(disc, edge / 2)], L, { area: clippedArea(disc, L.width, L.height) > 0 ? polylineLength(disc, true) * edge : 0, fringe: false }));
    d.shapes.push({ z: Z.element, role: 'tint', polys: [offsetLoop(disc, -edge / 2)], area: 0, trim: false, glow: false });
  } else {
    if (!d.comp) d.shapes.push(fill(Z.element, 'fg', [offsetLoop(disc, IF2.feather.width * S)], L, { alpha: IF2.feather.alpha, ink: false, fringe: false }));
    // The disc is the one shape big and smooth enough (its ripple bends
    // 15 px or more) to shrink as an offset loop.
    d.shapes.push(fill(Z.element, 'fg', [disc], L, { core: d.inset ? [offsetLoop(disc, -d.inset)] : undefined }));
    pushHair(d, Z.element, [{ poly: disc, dir: null }], d.r(4));
  }
  // Where the edge shows, clear of him (he stands at P, over the edge's
  // downstream side): the tongues and streaks go there, so the whole edge
  // reads feathered.
  const edgeAt = (r: Rng): number | null => {
    for (let k = 0; k < 64; k++) {
      const th = uniform(r, 0, 2 * Math.PI);
      const n: Vec2 = [Math.cos(th), Math.sin(th)];
      const E = add(D, n, R);
      if (inside(E, L.width, L.height, 0.01 * S) && len(sub(E, L.P)) > IF2.clearP * S) return th;
    }
    return null;
  };
  const t = d.r(1);
  const tongues: Vec2[][] = [];
  const nt = int(t, IF2.tongues.count[0], IF2.tongues.count[1]);
  let flames = 0;
  for (let i = 0; i < nt; i++) {
    const th = edgeAt(t);
    if (th === null) break;
    flames++;
    const n: Vec2 = [Math.cos(th), Math.sin(th)];
    const base = add(D, n, R + 0.006 * S);
    const dir = rotate(neg(n), uniform(t, -IF2.tongues.spread, IF2.tongues.spread)); // biting in
    const length = uniform(t, IF2.tongues.length[0], IF2.tongues.length[1]) * S + 0.006 * S;
    tongues.push(flame(base, dir, length, uniform(t, IF2.tongues.base[0], IF2.tongues.base[1]) * S, t));
    // Hairy: a hair or three running on out of the tongue's tip.
    const nh = int(t, IF2.tongues.hairs[0], IF2.tongues.hairs[1]);
    for (let k = 0; k < nh; k++) tongues.push(needle(add(base, dir, uniform(t, 0.5, 0.8) * length), rotate(dir, uniform(t, -8, 8)), uniform(t, 0.4, 1) * length, uniform(t, HAIR.width[0], HAIR.width[1])));
  }
  d.shapes.push(fill(Z.element, tinted ? 'fg' : 'bg', tongues, L, { trim: true, ink: tinted }));
  // The comb (comp, ink disc): each spike's root just outside the rippled
  // edge, read off the disc's points (one every 0.016 S, at even angles).
  let comb = 0;
  if (d.comp && !tinted) {
    const c = d.r(5);
    const { per, length, base, lean, spread } = IF2.comb;
    const nd = disc.length;
    const angle = (p: Vec2) => Math.atan2(p[1] - D[1], p[0] - D[0]);
    const forward = Math.sin(angle(disc[1]) - angle(disc[0])) > 0; // oriented() may have reversed it
    const edgeR = (th: number): number => {
      const k = ((Math.round((th / (2 * Math.PI)) * nd) % nd) + nd) % nd;
      return len(sub(disc[forward ? k : nd - 1 - k], D));
    };
    const tilt = uniform(c, -lean, lean);
    const step = (0.1 * S) / R;
    const spikes: Vec2[][] = [];
    for (let a = 0; a < 2 * Math.PI; a += step) {
      const m = int(c, per[0], per[1]);
      for (let k = 0; k < m; k++) {
        const th = a + uniform(c, 0, step);
        const n: Vec2 = [Math.cos(th), Math.sin(th)];
        const E = add(D, n, edgeR(th));
        if (!inside(E, L.width, L.height, 0.01 * S) || len(sub(E, L.P)) <= IF2.clearP * S) continue;
        const l = uniform(c, length[0], length[1]) * S;
        spikes.push(flame(add(E, n, 0.003 * S), rotate(neg(n), tilt + uniform(c, -spread, spread)), l + 0.003 * S, uniform(c, base[0], base[1]) * S, c));
      }
    }
    if (spikes.length) d.shapes.push(fill(Z.element, 'bg', spikes, L, { trim: true, ink: false }));
    comb = spikes.length;
  }
  const s = d.r(2);
  const ns = int(s, IF2.streaks.count[0], IF2.streaks.count[1]);
  const bands: Record<'accent' | 'fg', Vec2[][]> = { accent: [], fg: [] };
  for (let i = 0; i < ns; i++) {
    const th = edgeAt(s);
    if (th === null) break;
    const rad = R + uniform(s, IF2.streaks.off[0], IF2.streaks.off[1]) * S;
    const span = (uniform(s, IF2.streaks.length[0], IF2.streaks.length[1]) * S) / rad;
    const band = arcBand(D, rad, th - span / 2, th + span / 2, uniform(s, IF2.streaks.width[0], IF2.streaks.width[1]) * S);
    bands[s() < 0.5 ? 'accent' : 'fg'].push(band);
  }
  for (const role of ['accent', 'fg'] as const) if (bands[role].length) d.shapes.push(fill(Z.line, role, bands[role], L, { trim: true, fringe: false }));
  const streaks = bands.accent.length + bands.fg.length;
  // The sliver: paper where the axis leaves the frame upstream, if that's in the disc.
  const v = d.r(3);
  const out = reach(L.P, neg(L.u), L.width, L.height);
  const E = add(L.P, L.u, -out);
  let sliver = 0;
  if (out > 0 && len(sub(E, D)) < R - 0.02 * S) {
    const from = add(E, L.u, -0.02 * S);
    const length = uniform(v, IF2.sliver.length[0], IF2.sliver.length[1]) * S;
    const tip = add(from, rotate(L.u, uniform(v, -4, 4)), length);
    d.shapes.push(fill(Z.element, 'bg', [wedge(from, tip, uniform(v, IF2.sliver.width[0], IF2.sliver.width[1]) * S, 1.3)], L, { ink: false }));
    const lines: Vec2[][] = [];
    const nl = int(v, IF2.sliver.streaks[0], IF2.sliver.streaks[1]);
    for (let i = 0; i < nl; i++) {
      const a = add(E, perp(L.u), uniform(v, -0.02, 0.02) * S);
      lines.push([add(a, L.u, uniform(v, 0.01, 0.04) * S), add(a, L.u, uniform(v, 0.12, 0.22) * S)]);
    }
    d.shapes.push(stroke(Z.line, 'accent', lines, 0.003 * S, L, { trim: true }));
    sliver = 1;
  }
  count1(d, { tongues: flames, comb, streaks, sliver });
}

// A flame tongue from `base` along `dir`: a narrow, slightly bent triangle.
function flame(base: Vec2, dir: Vec2, length: number, width: number, r: Rng): Vec2[] {
  const bend = uniform(r, -0.25, 0.25) * width;
  return oriented([local(base, dir, 0, width / 2), local(base, dir, 0.55 * length, width * 0.22 + bend), local(base, dir, length, bend), local(base, dir, 0.5 * length, -width * 0.25 + bend), local(base, dir, 0, -width / 2)]);
}

// A circle whose radius ripples by up to ±amp, at three seeded wavelengths
// (0.21, 0.09 and 0.05 S of arc), as one polygon.
function rippledCircle(c: Vec2, R: number, amp: number, r: Rng): Vec2[] {
  const S = amp / IF2.wobble;
  const waves = ([[0.21, 0.5], [0.09, 0.3], [0.05, 0.2]] as const).map(([lambda, a]) => ({ k: (2 * Math.PI * R) / (lambda * S), a, phase: uniform(r, 0, 2 * Math.PI) }));
  const n = Math.max(96, Math.min(480, Math.ceil((2 * Math.PI * R) / (0.016 * S))));
  const pts: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    const ripple = waves.reduce((sum, w) => sum + w.a * Math.sin(Math.round(w.k) * th + w.phase), 0);
    pts.push([c[0] + (R + amp * ripple) * Math.cos(th), c[1] + (R + amp * ripple) * Math.sin(th)]);
  }
  return oriented(pts);
}

// A band along a circle's arc from a0 to a1, `width` at its middle and
// pointed at both ends.
function arcBand(c: Vec2, R: number, a0: number, a1: number, width: number): Vec2[] {
  const n = Math.max(6, Math.ceil(((a1 - a0) * R) / 6));
  const outer: Vec2[] = [];
  const inner: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = a0 + (a1 - a0) * t;
    const h = (width / 2) * Math.sin(Math.PI * t);
    outer.push([c[0] + (R + h) * Math.cos(a), c[1] + (R + h) * Math.sin(a)]);
    inner.push([c[0] + (R - h) * Math.cos(a), c[1] + (R - h) * Math.sin(a)]);
  }
  return oriented([...outer, ...inner.slice(1, -1).reverse()]);
}

// ---- IF3 radial -----------------------------------------------------------------------------

function radial(d: Draft) {
  const { L } = d;
  const S = L.S;
  const F = L.hud.F;
  d.centre = F;
  const r = d.r(0);
  const total = int(r, IF3.count[0], IF3.count[1]);
  const innerCount = int(r, IF3.inner.count[0], IF3.inner.count[1]);
  const up = Math.atan2(-L.u[1], -L.u[0]);
  // An angle from the lines' density: weight 0.45 within ±45° of −u, 1 elsewhere.
  const angle = (ok: (th: number) => boolean): number | null => {
    for (let k = 0; k < 200; k++) {
      const th = uniform(r, -Math.PI, Math.PI);
      const off = Math.abs(Math.atan2(Math.sin(th - up), Math.cos(th - up)));
      if (off <= Math.PI / 4 && r() > IF3.upstream) continue;
      if (ok(th)) return th;
    }
    return null;
  };
  // Each line is a brush line broken into dashes, over his paper fill
  // (Z.over), so the inner ring shows across him: F sits in his body. Its
  // width is held to k9's on every poster, not just on average (61 draws
  // stray by up to a fifth at their 90th percentile): the draws are centred
  // on their own median and scaled to their own 90th percentile first.
  const wr = d.r(3);
  const zs = Array.from({ length: total }, () => normal(wr));
  const zm = middle(zs);
  const z90 = zs.slice().sort((a, b) => a - b)[Math.floor(0.9 * total)];
  const spread = z90 > zm ? Math.min(2, Math.max(0.5, Z90 / (z90 - zm))) : 1;
  const widthOf = (i: number) => lognormalAt(IF3.width, (zs[i] - zm) * spread) * S;
  const lines: Vec2[][] = [];
  let inner = 0;
  for (let i = 0; i < innerCount; i++) {
    const th = angle(() => true);
    if (th === null) break;
    const dir: Vec2 = [Math.cos(th), Math.sin(th)];
    const from = uniform(r, IF3.inner.from[0], IF3.inner.from[1]);
    const to = Math.min(IF3.inner.to, from + Math.max(0.02, lognormal(r, IF3.length) * 0.75));
    const w = widthOf(i);
    const a = add(F, dir, to * S);
    lines.push(...dashed(a, add(a, rotate(dir, uniform(r, -IF3.tilt, IF3.tilt)), -(to - from) * S), w, r));
    inner++;
  }
  let outer = 0;
  for (let i = inner; i < total; i++) {
    const room = (th: number) => reach(F, [Math.cos(th), Math.sin(th)], L.width, L.height) >= (IF3.outer + 0.04) * S;
    const th = angle(room);
    if (th === null) break;
    const dir: Vec2 = [Math.cos(th), Math.sin(th)];
    const border = reach(F, dir, L.width, L.height);
    const length = lognormal(r, IF3.length) * S;
    const from = Math.max(border - length, IF3.outer * S);
    const outerEnd = add(F, dir, border + 0.02 * S);
    const w = widthOf(i);
    lines.push(...dashed(outerEnd, add(outerEnd, rotate(dir, uniform(r, -IF3.tilt, IF3.tilt)), -(border + 0.02 * S - from)), w, r));
    outer++;
  }
  d.shapes.push(fill(Z.over, 'fg', lines, L, { trim: true, fringe: false })); // thin ink: no cream fringe
  // A corner wedge or two, in the corners furthest downstream.
  const c = d.r(1);
  const corners: Vec2[] = [[0, 0], [L.width, 0], [L.width, L.height], [0, L.height]];
  corners.sort((p, q) => dot(sub(q, F), L.u) - dot(sub(p, F), L.u));
  const nc = c() < 0.5 ? 1 : 2;
  const wedges: Vec2[][] = [];
  const cores: (Vec2[] | null)[] = [];
  for (const corner of corners.slice(0, nc)) {
    const toF = unit(sub(F, corner));
    const from = add(corner, toF, -0.02 * S);
    const to = add(from, rotate(toF, uniform(c, -6, 6)), uniform(c, IF3.corners.length[0], IF3.corners.length[1]) * S);
    const w = uniform(c, IF3.corners.width[0], IF3.corners.width[1]) * S;
    wedges.push(wedge(from, to, w, 1));
    cores.push(d.inset ? wedgeCore(from, to, w, d.inset) : null);
  }
  d.shapes.push(fill(Z.element, 'fg', wedges, L, { trim: true, core: d.inset ? cores : undefined }));
  // The crosshair: its long line along the frame's short side, centred; the
  // short one 60/40, the longer part downstream.
  const h = d.r(2);
  const { short, long, weights, alpha, tilt } = IF3.crosshair;
  const k = 0.5 + uniform(h, -0.05, 0.05);
  const sgn = dot(L.u, L.long) >= 0 ? 1 : -1;
  const s1 = rotate(L.short, uniform(h, -tilt, tilt));
  const l1 = rotate(L.long, uniform(h, -tilt, tilt));
  d.shapes.push(stroke(Z.hud, 'accent', [[add(F, s1, -short * k * S), add(F, s1, short * (1 - k) * S)]], weights[0] * S, L, { alpha, cap: 'butt' }));
  d.shapes.push(stroke(Z.hud, 'accent', [[add(F, l1, -sgn * long * 0.4 * S), add(F, l1, sgn * long * 0.6 * S)]], weights[1] * S, L, { alpha, cap: 'butt' }));
  count1(d, { lines: inner + outer, inner, outer, corners: nc, crosshair: 1 });
}

// A speed line from A to B, `w` wide, broken into 2–4 dashes 0.08–0.2 of its
// length apart: each dash a brush spindle `w` wide at its widest (1 px at
// least), since k9's lines keep their width along them; a line that tapered
// to its inner end left the inner dashes hairlines (median 0.0025 S).
function dashed(A: Vec2, B: Vec2, w: number, r: Rng): Vec2[][] {
  const n = int(r, IF3.dashes[0], IF3.dashes[1]);
  const gaps = Array.from({ length: n - 1 }, () => uniform(r, IF3.gap[0], IF3.gap[1]));
  const parts = Array.from({ length: n }, () => uniform(r, 0.6, 1.4));
  const ink = Math.max(0.2, 1 - gaps.reduce((s, g) => s + g, 0));
  const sum = parts.reduce((s, p) => s + p, 0);
  const axis = unit(sub(B, A));
  const total = len(sub(B, A));
  const out: Vec2[][] = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    const t1 = t + (ink * parts[i]) / sum;
    out.push(spindle(lerp(A, B, (t + t1) / 2), axis, (t1 - t) * total, Math.max(1, w)));
    t = t1 + (gaps[i] ?? 0);
  }
  return out;
}

// The core of wedge(A, B, w0, 1): its triangle shrunk `inset` px.
function wedgeCore(A: Vec2, B: Vec2, w0: number, inset: number): Vec2[] | null {
  const n = perp(unit(sub(B, A)));
  const tri: [Vec2, Vec2, Vec2] = [add(A, n, w0 / 2), B, add(A, n, -w0 / 2)];
  return shrinkAbout(tri, tri, inset);
}

// pts scaled about tri's incentre so that tri's sides move `inset` px in (a
// triangle's inward offset, exactly; near enough for a shape close to its
// triangle), or null where tri is no thicker than that: no core.
function shrinkAbout(pts: readonly Vec2[], tri: readonly [Vec2, Vec2, Vec2], inset: number): Vec2[] | null {
  const [a, b, c] = tri;
  const la = len(sub(b, c));
  const lb = len(sub(c, a));
  const lc = len(sub(a, b));
  const p = la + lb + lc;
  const rho = p > 0 ? (2 * Math.abs(signedArea([a, b, c]))) / p : 0; // the inradius
  if (rho <= 1.05 * inset) return null;
  const I: Vec2 = [(la * a[0] + lb * b[0] + lc * c[0]) / p, (la * a[1] + lb * b[1] + lc * c[1]) / p];
  const k = (rho - inset) / rho;
  return oriented(pts.map((q) => lerp(I, q, k)));
}

// ---- IF4 star -------------------------------------------------------------------------------

function star(d: Draft) {
  const { L } = d;
  const S = L.S;
  const G = L.hud.G;
  d.centre = G;
  // The spikes, in from the border and aimed at G, clear of where the arms leave the frame.
  const r = d.r(0);
  const { big, small, bigReach, bigBase, smallReach, smallBase, aim, clear } = IF4.spikes;
  const n = big + small;
  const around = 2 * (L.width + L.height);
  const exits = [[G[0], 0], [L.width, G[1]], [G[0], L.height], [0, G[1]]].map(([x, y]) => perimeterAt(x, y, L.width, L.height));
  const phase = r();
  const bigs = new Set(Array.from({ length: big }, (_, k) => Math.floor(((k + phase) * n) / big) % n));
  const spikes: Brushed[] = [];
  const spikeCores: (Vec2[] | null)[] = [];
  for (let i = 0; i < n; i++) {
    const isBig = bigs.has(i);
    const base = uniform(r, ...(isBig ? bigBase : smallBase)) * S;
    let s = (((i + phase + uniform(r, -0.3, 0.3)) / n) * around + around) % around;
    for (const e of exits) {
      const gap = ringGap(s, e, around);
      const need = clear * S + base / 2;
      if (Math.abs(gap) < need) s = (e + (gap >= 0 ? need : -need) + around) % around;
    }
    const { p, inward, along } = perimeterPoint(s, L.width, L.height);
    const dir = rotate(unit(sub(G, p)), uniform(r, -aim, aim));
    const reachPx = uniform(r, ...(isBig ? bigReach : smallReach)) * S;
    const b0 = add(add(p, along, -base / 2), inward, -0.01 * S);
    const b1 = add(add(p, along, base / 2), inward, -0.01 * S);
    const tip = add(p, dir, reachPx / Math.max(0.35, dot(dir, inward)));
    const m0 = add(lerp(b0, tip, 0.5), perp(dir), uniform(r, -0.15, 0.15) * base);
    const m1 = add(lerp(b1, tip, 0.5), perp(dir), uniform(r, -0.15, 0.15) * base);
    spikes.push({ poly: oriented([b0, m0, tip, m1, b1]), dir, skip: isBig ? undefined : () => true }); // hair on the big ones
    spikeCores.push(d.inset ? shrinkAbout([b0, m0, tip, m1, b1], [b0, tip, b1], d.inset) : null);
  }
  const spikeBatch = fill(Z.element, 'fg', spikes.map((s) => s.poly), L, { trim: true, core: d.inset ? spikeCores : undefined });
  d.shapes.push(spikeBatch);
  pushHair(d, Z.element, spikes, d.r(3), spikeBatch);
  // The big star: one tapering arm per screen direction, each its own scale.
  const a = d.r(1);
  const { reach: R, wide, core, coreReach, scale } = IF4.star;
  const thin = d.spec.calm ? CALM : 1;
  const dirs = [L.long, L.short, neg(L.long), neg(L.short)];
  const arms = dirs.map((e) => {
    const k = uniform(a, scale[0], scale[1]);
    const length = R * S * k ** 0.25;
    return arm(G, e, length, (x) => thin * k * S * (wide * Math.max(0, 1 - (x / (R * S)) ** 2) + core * Math.max(0, 1 - x / (coreReach * S))), STAR_SAMPLES, a, d.inset);
  });
  d.shapes.push(fill(Z.star, 'fg', arms.map((m) => m.poly), L, { core: d.inset ? arms.map((m) => m.core) : undefined }));
  // Hair along the arms, but not where they cross at G.
  const hub = IF4.hairClear * S;
  pushHair(d, Z.star, arms.map((m, i) => ({ poly: m.poly, dir: dirs[i], skip: (p: Vec2) => len(sub(p, G)) < hub })), d.r(4));
  // The small stars at S1 and S2, each in a whole ring.
  const smallStars: Armed[] = [];
  const rings: Arc[] = [];
  IF4.small.forEach((st, i) => {
    const q = d.r(2, i);
    const c = L.hud[st.at];
    const [alongLong, alongShort] = st.reach;
    for (const [e, reachS] of [[L.long, alongLong], [L.short, alongShort], [neg(L.long), alongLong], [neg(L.short), alongShort]] as const) {
      const length = reachS * S * uniform(q, 0.9, 1.1);
      smallStars.push(arm(c, e, length, (x) => S * (st.width * Math.max(0, 1 - x / length) + st.core * Math.max(0, 1 - x / (st.coreReach * S))), SMALL_SAMPLES, undefined, d.inset));
    }
    rings.push({ c, r: st.ring * S, a0: 0, a1: 2 * Math.PI });
  });
  d.shapes.push(fill(Z.star, 'fg', smallStars.map((m) => m.poly), L, { core: d.inset ? smallStars.map((m) => m.core) : undefined }));
  d.shapes.push(stroke(Z.hud, 'fg', [], IF4.ringWidth * S, L, { arcs: rings }));
  count1(d, { spikes: spikes.length, big, small, star: 1, smallStars: IF4.small.length, rings: rings.length });
}

const STAR_SAMPLES = [0, 0.02, 0.05, 0.09, 0.14, 0.2, 0.27, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.93, 1];
const SMALL_SAMPLES = [0, 0.05, 0.12, 0.22, 0.35, 0.5, 0.7, 1];

// A tapering arm from c along e, `length` px long, full width t(x) at x px
// out, sampled at `at` (fractions of the length). With r, each side's width
// wavers ±8 %: a brush edge. With `inset`, its core too: each side moved in
// that far, ending where the arm gets thinner than twice it (null: no core).
interface Armed {
  poly: Vec2[];
  core: Vec2[] | null;
}

function arm(c: Vec2, e: Vec2, length: number, t: (x: number) => number, at: readonly number[], r?: Rng, inset = 0): Armed {
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  const coreLeft: Vec2[] = [];
  const coreRight: Vec2[] = [];
  let tip: Vec2 | null = null;
  let last = { x: 0, q: 0 };
  for (const f of at) {
    const x = f * length;
    const h = t(x) / 2;
    const hl = h * (r ? uniform(r, 0.92, 1.08) : 1);
    const hr = h * (r ? uniform(r, 0.92, 1.08) : 1);
    left.push(local(c, e, x, hl));
    right.push(local(c, e, x, -hr));
    if (inset <= 0 || tip) continue;
    const q = Math.min(hl, hr) - inset;
    if (q > 0) {
      coreLeft.push(local(c, e, x, hl - inset));
      coreRight.push(local(c, e, x, -(hr - inset)));
      last = { x, q };
    } else if (coreLeft.length) tip = local(c, e, last.x + ((x - last.x) * last.q) / (last.q - q), 0);
  }
  const poly = oriented([...left, ...right.reverse()]);
  const core = coreLeft.length >= 2 ? oriented([...coreLeft, ...(tip ? [tip] : []), ...coreRight.reverse()]) : null;
  return { poly, core };
}

// ---- IF5 negative cross ---------------------------------------------------------------------

function negativeCross(d: Draft) {
  const { L } = d;
  const S = L.S;
  const G = L.hud.G;
  d.centre = G;
  const { base, mid, midReach, core, coreReach } = IF5.cross;
  const thin = d.spec.calm ? CALM : 1;
  const t = (x: number) => thin * S * (base + mid * Math.max(0, 1 - x / (midReach * S)) + core * Math.max(0, 1 - x / (coreReach * S)));
  const arms = [L.long, L.short, neg(L.long), neg(L.short)].map((e) => {
    const length = reach(G, e, L.width, L.height) + 0.05 * S; // every arm runs off the frame
    const at = [0, 0.01, 0.025, 0.04, 0.05, 0.07, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5].map((x) => (x * S) / length).filter((f) => f < 1);
    return arm(G, e, length, t, [...at, 1], undefined, d.inset);
  });
  d.shapes.push(fill(Z.star, 'fg', arms.map((m) => m.poly), L, { glow: true, core: d.inset ? arms.map((m) => m.core) : undefined }));
  const rings: Arc[] = [];
  const hairs: Vec2[][] = [];
  IF5.rings.forEach((ring, i) => {
    const q = d.r(1, i);
    const c = L.hud[ring.at];
    rings.push({ c, r: ring.r * S, a0: 0, a1: 2 * Math.PI });
    if (ring.cross) hairs.push(...crosshair(c, L, ring.cross.short * S, ring.cross.long * S, q));
  });
  d.shapes.push(stroke(Z.hud, 'ring', hairs, IF5.ringWidth * S, L, { cap: 'butt', arcs: rings }));
  count1(d, { cross: 1, rings: rings.length, crosshairs: hairs.length / 2 });
}

// Two screen-aligned lines through c, `short` px along the frame's short
// side and `long` along its long side, each split unevenly about c.
function crosshair(c: Vec2, L: PosterLayout, short: number, long: number, r: Rng): Vec2[][] {
  const k1 = uniform(r, 0.35, 0.65);
  const k2 = uniform(r, 0.35, 0.65);
  return [
    [add(c, L.short, -short * k1), add(c, L.short, short * (1 - k1))],
    [add(c, L.long, -long * k2), add(c, L.long, long * (1 - k2))],
  ];
}

// ---- IF6 streaks ----------------------------------------------------------------------------

function streaks(d: Draft) {
  const { L, light } = d;
  const S = L.S;
  const tone: Role = light ? 'accent' : 'fg';
  const V6 = L.physical.V6;
  const back = Math.atan2(-L.u[1], -L.u[0]);
  const r = d.r(0);
  const { count, spread, from, length, width, shows, tries } = IF6.wedges;
  const n = int(r, count[0], count[1]);
  const wedges: Vec2[][] = [];
  for (let i = 0; i < n; i++) {
    // A wedge less than half on the frame is drawn again (not mirrored: the
    // fan stays on the lines through V6).
    for (let k = 0; k < tries; k++) {
      const th = back + uniform(r, -spread, spread) * DEG;
      const dir: Vec2 = [Math.cos(th), Math.sin(th)];
      const a = add(V6, dir, uniform(r, from[0], from[1]) * S);
      const z = normal(r);
      const l = Math.min(length[3], Math.max(length[2], length[0] * Math.exp(length[1] * z))) * S;
      const w = Math.min(width[3], Math.max(width[2], width[0] * Math.exp(width[1] * z + IF6.wedges.jitter * normal(r)))) * S;
      const poly = wedge(a, add(a, dir, l), Math.min(w, l / 2.5), 1);
      if (clippedArea(poly, L.width, L.height) >= shows * Math.abs(signedArea(poly))) {
        wedges.push(poly);
        break;
      }
    }
  }
  // Over his paper fill, under his contour: the fan reads across him.
  d.shapes.push(fill(Z.over, tone, wedges, L, { trim: true, glow: true }));
  const h = d.r(1);
  const hl = IF6.hairlines;
  const nh = int(h, hl.count[0], hl.count[1]);
  const hairlines: Vec2[][] = [];
  for (let i = 0; i < nh; i++) {
    const a0 = uniform(h, hl.from[0], hl.from[1]);
    const a1 = uniform(h, hl.to[0], hl.to[1]);
    const b0 = uniform(h, hl.side[0], hl.side[1]);
    const b1 = b0 + (a1 - a0) * Math.tan(uniform(h, -hl.spread, hl.spread) * DEG);
    hairlines.push(placePhysical(L, [physicalAt(L, a0, b0), physicalAt(L, a1, b1)], false));
  }
  d.shapes.push(stroke(Z.line, tone, hairlines, hl.width * S, L, { trim: true, glow: true }));
  const z = d.r(2);
  const scribbles = (['scribble1', 'scribble2'] as const).map((name) => {
    const c = L.physical[name];
    const turns = int(z, IF6.scribbles.turns[0], IF6.scribbles.turns[1]);
    const pts: Vec2[] = [];
    for (let k = 0; k <= turns; k++) {
      const along = (k / turns - 0.5) * IF6.scribbles.along * S + uniform(z, -0.01, 0.01) * S;
      const across = (k % 2 === 0 ? -0.5 : 0.5) * IF6.scribbles.across * S * uniform(z, 0.5, 1);
      pts.push(add(add(c, L.u, along), L.v, across));
    }
    return placePhysical(L, pts, false);
  });
  d.shapes.push(stroke(Z.line, tone, scribbles, IF6.scribbles.width * S, L, { trim: true, glow: true }));
  // The tan cross and the tick (HUD): screen-aligned.
  const m = d.r(3);
  const marks = [...crosshair(L.hud.cross6, L, IF6.cross.short * S, IF6.cross.long * S, m)];
  const tick = L.hud.tick6;
  marks.push([add(tick, L.short, -IF6.tick * S * 0.5), add(tick, L.short, IF6.tick * S * 0.5)]);
  d.shapes.push(stroke(Z.hud, 'tan', marks, IF6.markWidth * S, L, { cap: 'butt' }));
  count1(d, { wedges: wedges.length, hairlines: nh, scribbles: 2, cross: 1, tick: 1 });
}

// ---- IF7 negative strike --------------------------------------------------------------------

function negativeStrike(d: Draft) {
  const { L, light } = d;
  const S = L.S;
  const r = d.r(0);
  const { head, half, teeth, depth, tilt } = IF7.comet;
  const axis = rotate(neg(L.u), uniform(r, -tilt, tilt)); // up the strike axis, toward the striker
  const end = (reach(L.P, axis, L.width, L.height) + 0.05 * S) / S;
  const thin = d.spec.calm ? CALM : 1;
  const halfAt = (s: number) => {
    if (s <= 0) return thin * half[0][1] * Math.sqrt(Math.max(0, 1 - (s / head) ** 2));
    for (let i = 1; i < half.length; i++) {
      const [s1, h1] = half[i];
      const [s0, h0] = half[i - 1];
      if (s <= s1) return thin * (h0 + ((h1 - h0) * (s - s0)) / (s1 - s0));
    }
    return thin * half[half.length - 1][1];
  };
  // Teeth: past the head, each side's edge runs out from a notch 0.005–0.03 S
  // inside the envelope to the envelope over a tooth 0.01–0.05 S long, then
  // snaps back in: irregular points trailing back up the axis, like the
  // streaks of a thrown brush.
  const head1 = (sign: number): Vec2[] => {
    const pts: Vec2[] = [];
    for (let k = 0; k < 4; k++) {
      const s = -head + (k * head) / 4;
      pts.push(local(L.P, axis, s * S, sign * halfAt(s) * S));
    }
    return pts;
  };
  const side = (sign: number): Vec2[] => {
    const pts = head1(sign);
    let s = 0;
    while (s < end) {
      const top = Math.min(end, s + uniform(r, teeth[0], teeth[1]));
      const deep = thin * uniform(r, depth[0], depth[1]);
      pts.push(local(L.P, axis, s * S, sign * Math.max(0, halfAt(s) - deep) * S));
      pts.push(local(L.P, axis, top * S, sign * halfAt(top) * S));
      s = top;
    }
    pts.push(local(L.P, axis, end * S, 0));
    return pts;
  };
  const comet = oriented([...side(1), ...side(-1).reverse().slice(1)]);
  if (d.comp && !light && !d.spec.calm) {
    // The comp's orange band: the envelope, without its teeth, grown by half
    // the band under the comet, so it shows round it and in its notches.
    const envelope = (sign: number): Vec2[] => [...head1(sign), ...half.slice(1).filter(([s]) => s < end).map(([s, w]) => local(L.P, axis, s * S, sign * w * S)), local(L.P, axis, end * S, sign * halfAt(end) * S)];
    const hull = oriented([...envelope(1), ...envelope(-1).reverse()]);
    d.shapes.push(fill(Z.element, 'orange', [offsetLoop(hull, (IF7.band / 2) * S)], L, { ink: false, fringe: false }));
  }
  d.shapes.push(fill(Z.element, 'fg', [comet], L, { glow: true }));
  // The splash: 6–12 ragged blades out of a ring round the crater (round P
  // when the crater is off the frame, as under a floor along the frame's
  // edge), clear of the comet, two of them long, each with an orange
  // hairline running on past its tip (k13's); over him, so his fist can't
  // hide it. A blade starts at the ring or 0.015 S inside the comet's edge,
  // whichever is further out (paper on its paper wouldn't show), and one
  // mostly off the frame is thrown again, up to 6 times.
  const sp = d.r(1);
  const { count, length, long, base, clear, ring, notches, hairline, hairWidth } = IF7.splash;
  const C = inside(L.physical.crater, L.width, L.height) ? L.physical.crater : L.P;
  const n = int(sp, count[0], count[1]);
  const blades: Vec2[][] = [];
  const hairs: Vec2[][] = [];
  const up = Math.atan2(axis[1], axis[0]);
  for (let i = 0; i < n; i++) {
    let poly: Vec2[] = [];
    let dir: Vec2 = axis;
    let from: Vec2 = C;
    let l = 0;
    for (let k = 0; k < 6; k++) {
      const th = up + (uniform(sp, clear, 360 - clear) + uniform(sp, -4, 4)) * DEG;
      dir = [Math.cos(th), Math.sin(th)];
      l = (i < 2 ? uniform(sp, length[1], long) : uniform(sp, length[0], length[1])) * S;
      from = add(C, dir, Math.max(ring * S, exit(comet, C, dir, 0.005 * S, 0.5 * S) - 0.015 * S));
      poly = blade(from, dir, l, thin * uniform(sp, base[0], base[1]) * S, int(sp, notches[0], notches[1]), sp);
      if (clippedArea(poly, L.width, L.height) >= 0.5 * Math.abs(signedArea(poly))) break;
    }
    blades.push(poly);
    const tipAt = add(from, dir, 0.8 * l);
    hairs.push(needle(tipAt, rotate(dir, uniform(sp, -5, 5)), (0.2 + uniform(sp, hairline[0], hairline[1])) * l, Math.max(1, hairWidth * S)));
  }
  d.shapes.push(fill(Z.over, 'fg', blades, L, { trim: true, glow: true }));
  d.shapes.push(fill(Z.over, 'orange', hairs, L, { trim: true, fringe: false }));
  // The crater: an ink hole in the head.
  d.shapes.push(fill(Z.element, 'bg', [placed(L, circlePoints(L.physical.crater, IF7.crater * S, 0, 2 * Math.PI).slice(0, -1))], L, { ink: false }));
  // The rings and their marks (HUD).
  const h = d.r(2);
  const lines: Vec2[][] = [];
  const rings: Arc[] = [];
  for (const ring of IF7.rings) {
    const c = L.hud[ring.at];
    rings.push({ c, r: ring.r * S, a0: 0, a1: 2 * Math.PI });
    if (ring.mark === 'plus') lines.push(...plus(c, L, uniform(h, IF7.plus[0], IF7.plus[1]) * S));
    if (ring.mark === 'crosshair') lines.push(...crosshair(c, L, IF7.crosshair.short * S, IF7.crosshair.long * S, h));
  }
  lines.push(...plus(L.hud.tick6, L, uniform(h, IF7.plus[0], IF7.plus[1]) * S));
  const bar = L.hud.bar7;
  const sgn = dot(L.u, L.long) >= 0 ? 1 : -1;
  lines.push([add(bar, L.short, (-IF7.bar.short * S) / 2), add(bar, L.short, (IF7.bar.short * S) / 2)], [bar, add(bar, L.long, sgn * IF7.bar.long * S)]);
  d.shapes.push(stroke(Z.hud, 'ring', lines, IF7.ringWidth * S, L, { cap: 'butt', arcs: rings }));
  count1(d, { comet: 1, splash: blades.length, crater: 1, rings: IF7.rings.length, plus: 3, bar: 1 });
}

// How far from o along dir the ray leaves `poly`, in steps of `step` px up
// to `max` (0 if o is outside it).
function exit(poly: readonly Vec2[], o: Vec2, dir: Vec2, step: number, max: number): number {
  let s = 0;
  while (s < max && pointIn(poly, add(o, dir, s + step))) s += step;
  return pointIn(poly, o) ? s : 0;
}

// Even-odd point in polygon.
function pointIn(poly: readonly Vec2[], [x, y]: Vec2): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// A ragged blade from `from`, `width` wide there, to a point `length` along
// dir, each side barbed out and notched back in `notches` times.
function blade(from: Vec2, dir: Vec2, length: number, width: number, notches: number, r: Rng): Vec2[] {
  const side = (sgn: number): Vec2[] => {
    const pts: Vec2[] = [local(from, dir, 0, (sgn * width) / 2)];
    for (let k = 1; k <= notches; k++) {
      const x = k / (notches + 1);
      const h = (width / 2) * (1 - x);
      pts.push(local(from, dir, (x - 0.06) * length, sgn * h * uniform(r, 1, 1.25)));
      pts.push(local(from, dir, x * length, sgn * h * uniform(r, 0.35, 0.6)));
    }
    return pts;
  };
  return oriented([...side(1), local(from, dir, length, 0), ...side(-1).reverse()]);
}

// A "+" of arm a px each way, screen-aligned.
function plus(c: Vec2, L: PosterLayout, a: number): Vec2[][] {
  return [
    [add(c, L.short, -a), add(c, L.short, a)],
    [add(c, L.long, -a), add(c, L.long, a)],
  ];
}

const RECIPES: readonly ((d: Draft) => void)[] = [whiteout, split, radial, star, negativeCross, streaks, negativeStrike];

// ---- The ink guard --------------------------------------------------------------------------

function inkGuard(d: Draft, fig: PosterFigure): { ink: number; contour: boolean; trimmed: number } {
  const frame = d.L.width * d.L.height;
  if (!d.light || d.spec.disc === 'ink') return { ink: d.light ? 0 : 1, contour: false, trimmed: 0 };
  const inky = d.shapes.filter((s) => s.area > 0);
  const fixed = inky.filter((s) => !s.trim).reduce((sum, s) => sum + s.area, 0);
  const line = CONTOUR * d.L.S;
  const limbEdges = fig.limbs.reduce((sum, l) => sum + perimeter(l), 0);
  const outline = (fig.personLength + limbEdges) * line;
  const contourStyle = d.si === 2 || d.si === 5; // IF3 and IF6 draw him as a contour anyway
  const solid = contourStyle ? outline * (d.si === 5 ? 4 : 1) : fig.personArea + fig.limbArea;
  const asContour = fig.personLength * line + fig.limbArea;
  const cap = INK_CAP * frame;
  const contour = !contourStyle && fixed + solid + fig.markArea > cap;
  let total = fixed + (contour ? asContour : solid) + fig.markArea;
  const trimmable = inky.filter((s) => s.trim);
  total += trimmable.reduce((sum, s) => sum + s.area, 0);
  let trimmed = 0;
  // Largest first: a shape is a whole group's batch, so drop its pieces one by one.
  const pieces: { shape: Shape; i: number; area: number }[] = [];
  for (const shape of trimmable) {
    const parts = shape.polys ?? shape.lines ?? [];
    parts.forEach((p, i) => pieces.push({ shape, i, area: partArea(shape, p, d.L) }));
  }
  pieces.sort((a, b) => b.area - a.area);
  const drop = new Map<Shape, Set<number>>();
  for (const piece of pieces) {
    if (total <= cap) break;
    let set = drop.get(piece.shape);
    if (!set) drop.set(piece.shape, (set = new Set()));
    set.add(piece.i);
    total -= piece.area;
    trimmed++;
  }
  for (const [shape, set] of drop) {
    if (shape.polys) shape.polys = shape.polys.filter((_, i) => !set.has(i));
    if (shape.core) shape.core = shape.core.filter((_, i) => !set.has(i));
    if (shape.lines) shape.lines = shape.lines.filter((_, i) => !set.has(i));
  }
  // A shape's hair goes with it.
  for (const shape of d.shapes) {
    const set = shape.of && drop.get(shape.of.shape);
    if (!set || !shape.of || !shape.polys) continue;
    const at = shape.of.at;
    shape.polys = shape.polys.filter((_, k) => !set.has(at[k]));
    shape.of = { shape: shape.of.shape, at: at.filter((i) => !set.has(i)) };
  }
  return { ink: Math.max(0, total) / frame, contour, trimmed };
}

function partArea(shape: Shape, part: Vec2[], L: PosterLayout): number {
  return shape.polys ? clippedArea(part, L.width, L.height) : polylineLength(part, shape.closed ?? false) * (shape.width ?? 0);
}

// ---- Painting --------------------------------------------------------------------------------

function paint(ctx: PosterTarget, sink: GlowSink, d: Draft, T: PosterTones, fig: PosterFigure, contour: boolean, scratch?: MakeScratch) {
  const { L } = d;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  const tint = d.field === 'tint' ? tintField(ctx, T, L) : null;
  ctx.fillStyle = tint ? tint.outer : T.field;
  ctx.fillRect(0, 0, L.width, L.height);
  if (tint?.gradient) {
    // The gradient only where it varies: a gradient costs per pixel.
    ctx.fillStyle = tint.gradient;
    ctx.beginPath();
    ctx.arc(tint.c[0], tint.c[1], tint.R + 1, 0, 2 * Math.PI);
    ctx.fill();
  }
  // The cream fringe is drawn where it can be seen: round the star or cross,
  // the figure and his mark, which lie over other shapes, and round the field
  // elements on a tinted field or a paper far from cream. On a paper within
  // FRINGE_SHOWS of cream it would cost a fill per batch for nothing.
  const fringe = T.fringe ? FRINGE * L.S : 0;
  const plain = d.field !== 'tint' && T.fringe !== null && channelGap(T.field, T.fringe) <= FRINGE_SHOWS;
  const shapes = d.shapes.slice().sort((a, b) => a.z - b.z); // stable: recipe order within a layer
  const layer = (z: Layer) => {
    for (const s of shapes) if (s.z === z) paintShape(ctx, sink, s, T, plain && z < Z.star ? 0 : fringe);
  };
  layer(Z.element);
  layer(Z.line);
  // What lies over him: the figure paints it where it goes (IF3 and IF6
  // between his paper fill and his contour), or after him.
  let overDone = false;
  const over = () => {
    if (overDone) return;
    overDone = true;
    layer(Z.over);
  };
  const fp: FigurePaint = {
    si: d.si,
    spec: d.spec,
    ink: d.light ? T.fg : T.bg,
    paper: d.light ? T.bg : T.fg,
    accent: T.accent,
    ring: T.ring,
    P: L.P,
    u: L.u,
    S: L.S,
    width: L.width,
    height: L.height,
    disc: d.disc,
    contour,
    emit: T.emit,
    fringe: T.fringe ? { color: T.fringe, width: fringe } : null,
    scratch: scratch ?? null,
    edge: d.light ? T.edge : null,
    over,
  };
  paintMarksAndFigure(ctx, sink, fig, fp);
  over();
  layer(Z.star);
  layer(Z.hud);
  ctx.restore();
}

// IF1's field: s(r) = 0.03 + 0.17·min(1, r/S) round the hot spot. The tint is
// linear in s (an sRGB mix) until it reaches its cap (tintMax, or G3's
// floor), so it is a two-stop gradient out to R, where s reaches the cap,
// and the cap's colour (outer) beyond: a canvas gradient's cost grows with
// its stops. A tint bent by G4's redSafe gets the ramp's quarter points too.
interface TintField {
  outer: string;
  gradient: ReturnType<PosterTarget['createRadialGradient']> | null;
  c: Vec2;
  R: number;
}

function tintField(ctx: PosterTarget, T: PosterTones, L: PosterLayout): TintField {
  const [s0, ds] = IF1.tint;
  const top = T.tint(s0 + ds);
  const c = L.physical.hot;
  if (T.tint(s0) === top) return { outer: top, gradient: null, c, R: 0 };
  let lo: number = s0;
  let hi = s0 + ds;
  for (let k = 0; k < 24; k++) {
    const mid = (lo + hi) / 2;
    if (T.tint(mid) === top) hi = mid;
    else lo = mid;
  }
  const R = (L.S * (hi - s0)) / ds;
  const g = ctx.createRadialGradient(c[0], c[1], 0, c[0], c[1], R);
  const at = (f: number) => T.tint(s0 + (hi - s0) * f);
  const straight = channelGap(at(0.5), mixHex(at(0), at(1), 0.5)) <= 2;
  const stops = straight ? [0, 1] : [0, 0.25, 0.5, 0.75, 1];
  for (const f of stops) g.addColorStop(f, at(f));
  return { outer: at(1), gradient: g, c, R };
}

// The largest difference between two colours' channels, 0..255.
function channelGap(a: string, b: string): number {
  const x = parseInt(a.slice(1), 16);
  const y = parseInt(b.slice(1), 16);
  let gap = 0;
  for (let k = 0; k < 24; k += 8) gap = Math.max(gap, Math.abs(((x >> k) & 255) - ((y >> k) & 255)));
  return gap;
}

// One batch. In the light comp, ink fills get a `fringe` px cream fringe:
// the shape grown that much in cream, under it; and ink is graded by
// thickness: a batch in the edge tone, then its cores (if it has them) in
// thick ink over it.
function paintShape(ctx: PosterTarget, sink: GlowSink, s: Shape, T: PosterTones, fringe: number) {
  const graded = s.role === 'fg' && T.edge !== null && T.edge !== T.fg;
  const color = s.role === 'tint' ? T.tint(1) : graded && T.edge ? T.edge : T[s.role];
  ctx.globalAlpha = s.alpha ?? 1;
  if (s.polys) {
    if (s.polys.length > 0) {
      if (fringe > 0 && T.fringe && s.role === 'fg' && s.fringe !== false) {
        ctx.fillStyle = T.fringe;
        ctx.beginPath();
        for (const poly of offsetLoops(s.polys, fringe)) addPath(ctx, poly, true);
        ctx.fill();
      }
      ctx.fillStyle = color;
      ctx.beginPath();
      for (const poly of s.polys) addPath(ctx, poly, true);
      ctx.fill();
      if (graded && s.core?.some((c) => c)) {
        ctx.fillStyle = T.fg;
        ctx.beginPath();
        for (const core of s.core) if (core) addPath(ctx, core, true);
        ctx.fill();
      }
      if (T.emit && s.glow && s.role === 'fg') for (const poly of s.polys) sink.fill(poly, T.emit, 'body', 1);
    }
  } else if ((s.lines && s.lines.length > 0) || (s.arcs && s.arcs.length > 0)) {
    ctx.beginPath();
    for (const line of s.lines ?? []) addPath(ctx, line, s.closed ?? false);
    for (const a of s.arcs ?? []) {
      ctx.moveTo(a.c[0] + a.r * Math.cos(a.a0), a.c[1] + a.r * Math.sin(a.a0));
      ctx.arc(a.c[0], a.c[1], a.r, a.a0, a.a1);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = s.width ?? 1;
    ctx.lineCap = s.cap ?? 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    if (T.emit && s.glow && s.role === 'fg') for (const line of s.lines ?? []) sink.stroke(s.closed ? [...line, line[0]] : line, s.width ?? 1, T.emit, 'body', 1);
  }
  ctx.globalAlpha = 1;
}

function addPath(ctx: PosterTarget, pts: readonly Vec2[], closed: boolean) {
  if (pts.length < 2) return;
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  if (closed) ctx.closePath();
}

// ---- Shape makers -----------------------------------------------------------------------------

interface ShapeOptions {
  trim?: boolean;
  glow?: boolean;
  ink?: boolean; // counts toward the guard: by default the dark roles (fg, accent) on light fields
  area?: number; // the guard's estimate, px², when the outline overstates it
  alpha?: number;
  cap?: 'round' | 'butt';
  closed?: boolean;
  fringe?: boolean; // false: no comp fringe
  arcs?: Arc[]; // stroked with the lines
  core?: (Vec2[] | null)[]; // the polys' cores, index for index (PosterShape.core)
}

const inkRole = (role: Role) => role === 'fg' || role === 'accent';

function fill(z: Layer, role: Role, polys: Vec2[][], L: PosterLayout, o: ShapeOptions = {}): Shape {
  const ink = o.ink ?? inkRole(role);
  const area = !ink ? 0 : (o.area ?? polys.reduce((sum, p) => sum + clippedArea(p, L.width, L.height), 0));
  return { z, role, polys, core: o.core, area: area * (o.alpha ?? 1), trim: o.trim ?? false, glow: o.glow ?? false, alpha: o.alpha, fringe: o.fringe };
}

function stroke(z: Layer, role: Role, lines: Vec2[][], width: number, L: PosterLayout, o: ShapeOptions = {}): Shape {
  const ink = o.ink ?? inkRole(role);
  const arcs = o.arcs ?? [];
  const length = lines.reduce((sum, l) => sum + polylineLength(l, o.closed ?? false), 0) + arcs.reduce((sum, a) => sum + a.r * Math.abs(a.a1 - a.a0), 0);
  const area = !ink ? 0 : (o.area ?? length * width);
  return { z, role, lines, arcs: arcs.length ? arcs : undefined, width, closed: o.closed, cap: o.cap, alpha: o.alpha, area: area * (o.alpha ?? 1), trim: o.trim ?? false, glow: o.glow ?? false };
}

function count1(d: Draft, counts: Record<string, number>) {
  Object.assign(d.counts, counts);
}

// ---- Geometry ---------------------------------------------------------------------------------

const add = (a: Vec2, b: Vec2, k = 1): Vec2 => [a[0] + k * b[0], a[1] + k * b[1]];
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const neg = (a: Vec2): Vec2 => [-a[0], -a[1]];
const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
const len = (a: Vec2) => Math.hypot(a[0], a[1]);
const perp = (a: Vec2): Vec2 => [-a[1], a[0]];
const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const unit = (a: Vec2): Vec2 => {
  const l = len(a);
  return l > 0 ? [a[0] / l, a[1] / l] : [0, 1];
};
const rotate = (a: Vec2, deg: number): Vec2 => {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  return [a[0] * c - a[1] * s, a[0] * s + a[1] * c];
};
// o + x·ax + y·perp(ax).
const local = (o: Vec2, ax: Vec2, x: number, y: number): Vec2 => [o[0] + ax[0] * x - ax[1] * y, o[1] + ax[1] * x + ax[0] * y];
const inside = ([x, y]: Vec2, w: number, h: number, margin = 0) => x >= margin && x <= w - margin && y >= margin && y <= h - margin;

// A lognormal draw from [median, σ, min, max], in S.
function lognormal(r: Rng, p: readonly [number, number, number, number]): number {
  return lognormalAt(p, normal(r));
}

// [median, σ, min, max] at z standard deviations.
function lognormalAt([median, sigma, lo, hi]: readonly [number, number, number, number], z: number): number {
  return Math.min(hi, Math.max(lo, median * Math.exp(sigma * z)));
}

// The standard normal's 90th percentile.
const Z90 = 1.2816;

// The middle value (the upper one of an even count), 0 for none.
function middle(xs: readonly number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

// A wedge from A (w0 wide) to a point at B, its width (1 − s)^τ of the way.
function wedge(A: Vec2, B: Vec2, w0: number, tau = 1, n = 4): Vec2[] {
  const axis = unit(sub(B, A));
  const length = len(sub(B, A));
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const s = i / n;
    const h = (w0 / 2) * (1 - s) ** tau;
    left.push(local(A, axis, s * length, h));
    right.push(local(A, axis, s * length, -h));
  }
  return oriented([...left, B, ...right.reverse()]);
}

// Points on a circle from angle a0 to a1, about 6 px apart.
function circlePoints(c: Vec2, R: number, a0: number, a1: number): Vec2[] {
  const n = Math.max(12, Math.ceil((Math.abs(a1 - a0) * R) / 6));
  return Array.from({ length: n + 1 }, (_, i): Vec2 => {
    const a = a0 + ((a1 - a0) * i) / n;
    return [c[0] + R * Math.cos(a), c[1] + R * Math.sin(a)];
  });
}

export function polylineLength(pts: readonly Vec2[], closed = false): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  if (closed && pts.length > 2) s += Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]);
  return s;
}

// A polygon's area inside the w × h frame (Sutherland–Hodgman against each edge).
export function clippedArea(poly: readonly Vec2[], w: number, h: number): number {
  let pts: Vec2[] = poly.map((p): Vec2 => [p[0], p[1]]);
  const edges: [(p: Vec2) => number][] = [[(p) => p[0]], [(p) => w - p[0]], [(p) => p[1]], [(p) => h - p[1]]];
  for (const [inside] of edges) {
    if (pts.length === 0) break;
    const out: Vec2[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const da = inside(a);
      const db = inside(b);
      if (da >= 0) out.push(a);
      if (da >= 0 !== db >= 0) out.push(lerp(a, b, da / (da - db)));
    }
    pts = out;
  }
  return Math.abs(signedArea(pts));
}

// The frame's border as one loop of length 2(w + h), from (0, 0) clockwise:
// the distance along it of an edge point, and the point at a distance.
function perimeterAt(x: number, y: number, w: number, h: number): number {
  if (y <= 0) return Math.min(w, Math.max(0, x));
  if (x >= w) return w + Math.min(h, Math.max(0, y));
  if (y >= h) return w + h + (w - Math.min(w, Math.max(0, x)));
  return 2 * w + h + (h - Math.min(h, Math.max(0, y)));
}

function perimeterPoint(s: number, w: number, h: number): { p: Vec2; inward: Vec2; along: Vec2 } {
  if (s < w) return { p: [s, 0], inward: [0, 1], along: [1, 0] };
  if (s < w + h) return { p: [w, s - w], inward: [-1, 0], along: [0, 1] };
  if (s < 2 * w + h) return { p: [w - (s - w - h), h], inward: [0, -1], along: [-1, 0] };
  return { p: [0, h - (s - 2 * w - h)], inward: [1, 0], along: [0, -1] };
}

// The signed distance from e to s round a loop of length `around`, −around/2..around/2.
function ringGap(s: number, e: number, around: number): number {
  let g = (s - e) % around;
  if (g > around / 2) g -= around;
  if (g < -around / 2) g += around;
  return g;
}
