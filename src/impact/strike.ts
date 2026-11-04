// The strike (impact design §4, "Visuals"): what the limbs paint as they slam
// into P. Limbs first (Qai, Oct 29; fist first is out of scope): the steps
// S0..S6 run on the reference clock over j −8..−1, s = kr(j), so S3 holds two
// frames (j −5 and −4) and the white-out lands on the fist contact at j 0.
// Each step is a fresh drawing seeded by its step; nothing carries over from
// one to the next, and a step that holds two frames shows its drawing twice.
// The limbs are read where they are on the step's first frame (their tubes),
// whatever shape the rope physics and the body left them in.
//   - Beams: one smear per limb along mix(its held centreline, the chord from
//     its root to P, β), the step's beams turned together ±3.5° about P.
//     Near P they are one bundle, as the reference's one bolt: each beam
//     joins the bundle's axis over 60–30 % of the shortest one's length from
//     P, and only the lead (the one that bends least to join) goes on to P;
//     the others stop where they reach it, inside it, and one that runs
//     inside it from its root is not drawn. So the bundle is one beam wide at
//     P, and its light and core are one beam's, not one per limb (round 2's
//     four, piled up on the hero's near-parallel limbs, ran S1 at 4× the
//     reference's white). The width is w_b·m[s],
//     w_b = max(2·r_max, 0.05 S); the bundle's last quarter widens 1.25–2.7×
//     into P; on S6 the last 40 % swells to 0.30–0.38 S, with accent teeth
//     cut 0.02–0.04 S into its core. S0 is each limb's head: out of the
//     limb's end, along a curve into P, the first third shows, at half width,
//     tapering to a point at its far end. Flat cels: edge, fill, accent
//     tongues along one edge, and white core lenses.
//   - Splash: 2–5 jagged pieces round P in the accent, outside an empty
//     disc, bands with blades off them and a tooth every 0.21–0.32 U, flying
//     sideways from the strike by the measured angle table, lopsided to one
//     seeded side, laid on the floor, mirrored back into the frame and sized
//     to the area that shows: the step's % of the frame (×σ² only under
//     Reduce flashing, whose budget was set with it).
//   - Contact bursts on S1, S4 and S5: jagged discharge arcs out of P, an
//     arc the frame cuts mirrored back in as the splash's pieces are; on S1
//     and S4 a white flare star at P, the burst's hot core.
//   - Charge: an emission disc at P that grows into the white-out.
// The cels go into the front layer; the light goes into the glow sink. The
// splash, the bursts and the charge don't read the limbs (planStrikeContact),
// so they can be planned ahead of the frame that shows them.
// Full flashing is the default (decision 5). Under Reduce flashing
// (flash 'safe') the saturated reds are bent toward brown, gentle mode's G4:
// S6 alone covers 10–14 % of a 10° field in p0's reds. That mode also runs
// the strike gentle (decision 12: no flash in the strike): the widths calm,
// no swell, and the light only rises, step to step (GENTLE: the glow gains,
// the charge and the splash never drop, and the splash keeps S6's pieces,
// growing, instead of a fresh set each step). The export's flash ladder may
// also ask for strike calm (step 3, strikeOptions), which clamps the
// multipliers to 0.7–1.0 and the swell to 1.0·w_b. No Math.random, clocks
// or ctx.filter: every draw is rng(seed, stream, ...ints).
import type { Vec2 } from '../types/effect.ts';
import type { BrushTarget } from '../render/glow.ts';
import { resampleStroke } from '../render/brush.ts';
import { smoothstep } from '../render/geometry.ts';
import type { GlowSink, ImpactContext, Tube } from './contracts.ts';
import { kr } from './clock.ts';
import { floorFrame, mirrorIntoFrame } from './floor.ts';
import { redSafe } from './frames/gentle.ts';
import { mixHex, roles, type Palette } from './palette.ts';
import { int, normal, rng, uniform, type Rng } from './rng.ts';

// ---- The schedule (limbs first) ----------------------------------------------------------

export const STRIKE_STEPS = 7; // S0..S6
export const STRIKE_J = { first: -8, last: -1 } as const;

// The step drawn on j, or null outside the strike: S0 j −8, S1 −7, S2 −6,
// S3 −5 and −4, S4 −3, S5 −2, S6 −1 (f76..83 on the hero, I = 84).
export function strikeStep(j: number): number | null {
  return j >= STRIKE_J.first && j <= STRIKE_J.last ? kr(j) : null;
}

export const strikeStepAt = (f: number, I: number): number | null => strikeStep(f - I);

// The j whose limbs the step on j is drawn from: the step's first frame. So
// S3 is one drawing, from j −5, shown again on j −4.
export function strikeHold(j: number): number | null {
  const s = strikeStep(j);
  if (s === null) return null;
  let first = j;
  while (first > STRIKE_J.first && kr(first - 1) === s) first--;
  return first;
}

// The output frames that show step s, in order: one each, two for S3. The
// strike is a 1s layer: draw it once per step, from the limbs on the step's
// first frame, and show that drawing on every frame of the step.
export function strikeFrames(s: number, I: number): number[] {
  const frames: number[] = [];
  for (let j = STRIKE_J.first; j <= STRIKE_J.last; j++) if (kr(j) === s) frames.push(I + j);
  return frames;
}

// ---- The measured tables (design §4, §9; lightning §5.6, timing R2–R4) ---------------------

export const STRIKE = {
  mult: [0.5, 1.0, 0.71, 0.46, 1.37, 0.98, 1.0], // beam width × w_b, S0..S5; S6's far part (its last 40 % swells)
  minWidth: 0.05, // w_b = max(2·r_max, 0.05 S)
  calm: [0.7, 1.0] as const, // strike calm clamps the multipliers here, and the swell to 1.0·w_b
  swell: [0.3, 0.38] as const, // S6's last 40 %, × S
  contactEnd: [1, 1.25, 1.5, 1.25, 1.5, 2.7, 1], // the width at P, × the bundle's mean
  flare: 0.25, // the share of the bundle nearest P that widens to contactEnd
  merge: [0.3, 0.6] as const, // the beams join the bundle between these shares of the shortest one's length from P
  farEnd: [1, 1, 0.5, 1, 0.5, 0.15, 1], // S2, S4 and S5 taper to this × the near width at the far end
  coreShare: [0.2, 0.24, 0.15, 0.15, 0.3, 0.15, 0.43], // the white core's share of the width (S0: its rear half only)
  wobble: [0.0025, 0.0045, 0.004, 0.0015, 0.004, 0.005, 0.018], // edge RMS, × S
  // Glow gain per unit of core. The reference's white share runs k1..k6
  // 1.0 / 0.6 / 0.2 / 2.4 / 1.1 / 11.0 % (judge motion:1): S1 dim, S6 the
  // whitest by far. The table's S1 1.0 and S6 0.4 ran the other way on the
  // hero, S1 as hot as S6, whose swell never whitened. S1's white is now
  // little more than its flare star. S6 paints its white (SWELL_CORE): under
  // 0.8 its far halo keeps the lens white bar the teeth, which stay pink
  // (green ≈ 140 of 255 on the hero); under 1.4 they whitened with the rest,
  // and under 0.5 the halo's red tint greyed a quarter of the white.
  glow: [0.35, 0.6, 0.6, 0.35, 1.0, 0.5, 0.4],
  beta: [0.6, 0.8] as const, // the pull toward the chord
  turnDeg: 3.5, // about P, per step
  line: 0.004, // the edge line, × S
  splash: [0, 2.0, 3.0, 1.1, 7.1, 15.5, 18.8], // % of the frame
  pieces: [0, 4, 5, 3, 3, 2, 5], // splash pieces per step, as measured
  charge: [0, 0.11, 0.16, 0.06, 0.38, 0.82, 0.5], // the charge gain c
  bursts: [1, 4, 5], // the steps with a contact burst
  flares: [1, 4], // the steps with a white flare star at P
} as const;

// The S0 head's path: it leaves the limb's end between the limb's heading
// and P, its control point this share of the gap to P out.
const HEAD_LEAD = 0.4;

// S6's accent teeth (judge reference:8): along both edges of the swell, each
// 0.03–0.06 S along it, cut this deep into the core band, × S.
const SWELL_TEETH = { len: [0.03, 0.06] as const, depth: [0.02, 0.04] as const, gap: [0, 0.02] as const };

// S6's white-hot core. The reference's k6 core is 0.43 of the swell's width
// flat, but in the composite all of the swell goes white bar its accent
// teeth. Our glow can only whiten it through its far halo (σ 0.047 S), which
// whitened a round blob, teeth and all (judges motion:1, reference:8), so the
// swell paints its white: one lens in `tone.hot`, the teeth cut into it,
// under the step's glow. It is a teardrop, not a spindle: it rises from a
// point over the first `rise` of its length and runs on at full width into
// P, where the swell is widest (a spindle closed there, which left the white
// a third of the swell's area).
export const SWELL_CORE = {
  share: 0.8, // its mean share of the width
  most: 0.92, // the widest it opens, × the width, so its jagged edges stay inside the fill
  rise: 0.45, // the share of its length it widens over, from the root end
  root: [0.06, 0.14] as const, // the share of the beam left before it starts
  jag: { len: [0.012, 0.03] as const, bite: [0.1, 0.3] as const }, // its edges' teeth: × S along it, × its half width in
} as const;

// The flare star at P on S1 and S4 (lightning §2.6: a pale star ≈0.04 H
// across): 8–10 points out to 0.02–0.035 S round a body of 0.012 S, laid on
// the floor. It goes white in the composite, as the cores do.
export const FLARE = { points: [8, 10] as const, tip: [0.02, 0.035] as const, body: 0.012 } as const;

// Splash angles, measured from −d (back up the strike) on both sides:
// [from°, to°, share]. Nothing within 30° of the source, ≤ 8 % within 60°.
export const SPLASH_ANGLES: readonly (readonly [number, number, number])[] = [
  [0, 30, 0],
  [30, 60, 0.06],
  [60, 90, 0.25],
  [90, 120, 0.23],
  [120, 150, 0.31],
  [150, 180, 0.12],
];

// The splash's lengths are in its unit L, the one its area scales with: S
// under Full, where the area is the step's % of the frame, and U under Reduce
// flashing, where it is × σ² (the reference's U is its S, so both read its
// measurements as made).
export const SPLASH = {
  disc: [0.09, 0.2] as const, // the empty disc round P, × L
  blade: [0.1, 0.34] as const, // blade length, × L
  aspect: [3, 7] as const, // blade length ÷ base
  tooth: { len: 0.045, base: [0.017, 0.029] as const, every: [0.21, 0.32] as const }, // × L
  share: [0.58, 0.71] as const, // of the area on the seeded side
  rim: 0.004, // the dark rim, × L: its line share comes to the reference's 9–18 %
  glow: 0.5, // × the step's glow gain: the splash emits as body, it has almost no core
  grow: 2, // a side the frame edge cuts grows to show its area, up to 2² × it in all
} as const;

// A piece's band is one to three spines from its root, each a jagged blade
// `aspect` times as long as it is wide at its widest and at most `reach` L
// long: a band too big for one spine takes more, fanned `fan`° apart (judge
// reference:7: on one spine capped in length, the hero's S4–S6 pieces, sized
// to the frame, came out as flat blobs under twice as long as wide).
export const SPINE = {
  aspect: [4.5, 6] as const,
  reach: 0.8, // × L
  most: 3,
  fan: [12, 20] as const, // degrees between spines
  room: 0.85, // the share of the frame's room along the axis a spine may take
  shortest: 0.12, // × L: the reach never shortens past this
} as const;

// The splash's unit L (see SPLASH).
export const splashUnit = (frame: { S: number; U: number }, gentle = false): number => (gentle ? frame.U : frame.S);

export const BURST = {
  arcs: [6, 10] as const,
  reach: [0.1, 0.25] as const, // × U
  open: 45, // degrees either side of −d left open, toward the striker
  width: [0.006, 0.01] as const, // at the root, × S
  levels: 3, // midpoint displacements: 9 points an arc (a 4th level would move them under a pixel)
} as const;

// The gentle strike's light (Reduce flashing), S0..S6: each never below the
// step before, so a 10° field only ever brightens through the strike, and
// low enough that none brightens by 0.10 over a quarter of itself before
// the posters (export/flash.ts).
export const GENTLE_STRIKE = {
  glow: [0.08, 0.12, 0.12, 0.12, 0.16, 0.16, 0.2],
  charge: [0, 0.11, 0.16, 0.16, 0.38, 0.6, 0.8],
  splash: [0, 0.8, 1.0, 1.0, 1.4, 1.8, 2.2], // % of the frame, × σ²: S6's pieces, growing
} as const;

export const CHARGE_RADIUS = 0.05; // the disc is 0.05 U·(1 + 2c)

// The charge gain on j. On j 0..3 it fades from 1 to 0, which only shows
// when there are no posters (frames.count 0); otherwise the posters cover it.
export function chargeAt(j: number, posters = true): number {
  const s = strikeStep(j);
  if (s !== null) return STRIKE.charge[s];
  return !posters && j >= 0 && j <= 3 ? 1 - j / 3 : 0;
}

// ---- Inputs and outputs ----------------------------------------------------------------------

// What the strike reads from the scene. A missing `flash` is 'full', the default.
export type StrikeContext = Pick<ImpactContext, 'seed' | 'frame' | 'floor' | 'width' | 'height' | 'palette'> & Partial<Pick<ImpactContext, 'flash'>>;

// One limb as the strike sees it: its held centreline on the step's first frame.
export interface StrikeLimbPath {
  id?: number; // the stroke id, which seeds its beam; missing = its index
  root: Vec2; // frame px
  centerline: Vec2[]; // frame px, root first; pinned on P from S1
  rMax: number; // the tube's largest radius, px
}

export interface StrikeOptions {
  swell: boolean; // S6 swells (false: S6 is a plain 1.0·w_b beam)
  calm: boolean; // flash ladder step 3
  gentle?: boolean; // Reduce flashing: calm widths, no swell, and GENTLE_STRIKE's rising light
}

// The options for a flash mode and the export's flash-ladder step. Reduce
// flashing always runs the strike gentle; the ladder only runs under it, and
// from step 3 on it calms the strike too, so Full never calms it.
export const STRIKE_CALM_STEP = 3;
export function strikeOptions(flash: 'safe' | 'full' = 'full', ladder = 0): StrikeOptions {
  return { swell: true, calm: flash === 'safe' && ladder >= STRIKE_CALM_STEP, gentle: flash === 'safe' };
}

// A limb as the strike reads it, from its tube (lift/tube.ts) on the step's
// first frame: the sections' screen points, and the widest of their radii.
export function strikeLimbOf(tube: Tube): StrikeLimbPath {
  const sections = tube.sections;
  return { id: tube.id, root: sections[0].screen, centerline: sections.map((x) => x.screen), rMax: Math.max(...sections.map((x) => x.r)) };
}

export interface BeamStation {
  p: Vec2; // on the beam's centreline
  n: Vec2; // unit normal: `left` is along +n, `right` along −n
  q: number; // 1 at the root, 0 at the contact end
  w: number; // the planned width, px
  left: number; // the edge's distance from p, wobble included, px
  right: number;
}

// A beam's part in the step: the lead runs to P and is the bundle there; a
// strand joins the bundle and stops inside it; S0's head runs out of its
// limb's end toward P.
export type BeamRole = 'lead' | 'strand' | 'head';

export interface Beam {
  id: number;
  role: BeamRole;
  base: number; // w_b, px
  target: number; // the width the step asks for over `body`, px: w_b·m[s], or the swell on S6
  body: [number, number]; // the stations it applies to: q 0.25..0.9 on the lead, 0.1..0.9 on a strand, S6's last 40 %, S0's plateau
  stations: BeamStation[]; // root end (S0: the limb's end) first; q 1 there, 0 on P
  silhouette: Vec2[]; // the edge-tone shape, caps included
  fill: Vec2[] | null; // inside the edge line
  accent: Vec2[][]; // tongues along one edge
  core: Vec2[][]; // spindle lenses
  hot: boolean; // S6's swell: one white-hot lens over SWELL_CORE.share of it, in tone.hot
  teeth: Vec2[][]; // S6's accent teeth, cut into the core and painted over it
  coreShare: number; // the mean core width ÷ beam width (S0: over its rear half)
}

export interface SplashPart {
  kind: 'body' | 'blade';
  shape: Vec2[];
  teeth: Vec2[][];
}

export interface SplashPiece {
  side: 1 | -1; // which side of the strike axis, along ±v
  angle: number; // its axis, degrees from −d
  area: number; // the screen area it was sized to, px²
  parts: SplashPart[];
  mirrored: boolean; // all of it mirrored back into the frame
}

export interface Splash {
  target: number; // screen area, px²: the step's % of the frame × σ²
  disc: number; // the empty disc's radius, px
  side: 1 | -1; // the heavy side, the same for the whole strike
  share: number; // of the area on it
  rim: number; // px
  pieces: SplashPiece[];
}

export interface BurstArc {
  points: Vec2[]; // from P out
  width: number[]; // per point, px
  mirrored: boolean; // mirrored back into the frame through P
}

export interface StrikePlan {
  s: number;
  glow: number; // the step's glow gain
  beams: Beam[];
  splash: Splash | null;
  bursts: BurstArc[];
  flare: Vec2[] | null; // the white star at P, S1 and S4
  charge: { c: number; r: number } | null; // the emission disc at P
}

// ---- Plan and draw -----------------------------------------------------------------------------

// What step s puts round P without reading the limbs: the splash, the
// bursts, the flare and the charge. Pure in (seed, frame, floor, size,
// step), and most of the planning, so a caller can plan it ahead and hand it
// to planStrike.
export type StrikeContact = Pick<StrikePlan, 'splash' | 'bursts' | 'flare' | 'charge'>;
export function planStrikeContact(ictx: StrikeContext, s: number, gentle = false): StrikeContact {
  checkStep(s);
  const c = gentle ? GENTLE_STRIKE.charge[s] : STRIKE.charge[s];
  return {
    splash: planSplash(ictx, s, gentle),
    bursts: planBursts(ictx, s),
    flare: planFlare(ictx, s),
    charge: c > 0 ? { c, r: CHARGE_RADIUS * ictx.frame.U * (1 + 2 * c) } : null,
  };
}

// Everything step s draws, as geometry. Pure in (seed, frame, floor, size,
// step, limbs, options); `contact` is planStrikeContact's for the same
// context and step, when it was planned ahead.
export function planStrike(ictx: StrikeContext, s: number, limbs: readonly StrikeLimbPath[], opts: StrikeOptions, contact?: StrikeContact): StrikePlan {
  checkStep(s);
  const beams = s === 0 ? planHeads(ictx, limbs, opts) : planBundle(ictx, s, limbs, opts);
  return { s, glow: opts.gentle ? GENTLE_STRIKE.glow[s] : STRIKE.glow[s], beams, ...(contact ?? planStrikeContact(ictx, s, opts.gentle)) };
}

// Draws step s into the front layer and its light into the glow sink, and
// returns what it drew.
export function drawStrike(ctx: BrushTarget, sink: GlowSink, ictx: StrikeContext, s: number, limbs: readonly StrikeLimbPath[], opts: StrikeOptions, contact?: StrikeContact): StrikePlan {
  const plan = planStrike(ictx, s, limbs, opts, contact);
  paintStrike(ctx, sink, ictx, plan);
  return plan;
}

function checkStep(s: number) {
  if (!Number.isInteger(s) || s < 0 || s >= STRIKE_STEPS) throw new Error(`the strike has steps 0..6 (got ${s})`);
}

// The tones (design §4): the strike's from p0 (edge, accent, fill, core),
// S6's white-hot core mix(p1, white, 0.85) (the reference's composite core,
// #fdfcff), the splash rim mix(p0, p2, 0.45), and the bursts in the
// discharge set. Under Reduce flashing every saturated red among them goes
// through G4.
export function strikeTones(palette: Palette, flash: 'safe' | 'full' = 'full') {
  const r = roles(palette);
  const tones = { ...r.strike, hot: mixHex(r.paper, '#ffffff', 0.85), rim: mixHex(r.main, r.ink, 0.45), discharge: r.discharge };
  if (flash !== 'safe') return tones;
  const d = tones.discharge;
  return {
    edge: redSafe(tones.edge),
    accent: redSafe(tones.accent),
    fill: redSafe(tones.fill),
    core: redSafe(tones.core),
    hot: redSafe(tones.hot),
    rim: redSafe(tones.rim),
    discharge: { edge: redSafe(d.edge), band: redSafe(d.band), core: redSafe(d.core), pale: redSafe(d.pale) },
  };
}

// Draws a plan: the splash on the floor, in the accent over its dark rim (the
// reference's splash is the strike's hot colour, not the beam's pale fill);
// the beams over it, band by band across all the limbs, so where they meet
// they read as one, S6's accent teeth over the core; the bursts, then the
// flare star, on top. The glow sink gets the beam bodies and cores, the
// splash as body, the bursts, the flare as core and the charge disc.
export function paintStrike(ctx: BrushTarget, sink: GlowSink, ictx: StrikeContext, plan: StrikePlan) {
  const tone = strikeTones(ictx.palette, ictx.flash);
  const gain = plan.glow;
  const op = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = 'source-over';
  if (plan.splash) {
    const { rim, pieces } = plan.splash;
    const parts = pieces.flatMap((piece) => piece.parts);
    fillPolygons(ctx, splashCover(pieces, rim), tone.rim);
    fillPolygons(ctx, parts.flatMap((part) => [part.shape, ...part.teeth]), tone.accent);
    for (const part of parts) sink.fill(part.shape, tone.accent, 'body', gain * SPLASH.glow);
  }
  const beams = plan.beams;
  fillPolygons(ctx, beams.map((b) => b.silhouette), tone.edge);
  fillPolygons(ctx, beams.flatMap((b) => (b.fill ? [b.fill] : [])), tone.fill);
  fillPolygons(ctx, beams.flatMap((b) => b.accent), tone.accent);
  fillPolygons(ctx, beams.flatMap((b) => (b.hot ? [] : b.core)), tone.core);
  fillPolygons(ctx, beams.flatMap((b) => (b.hot ? b.core : [])), tone.hot);
  fillPolygons(ctx, beams.flatMap((b) => b.teeth), tone.accent);
  for (const b of beams) {
    sink.fill(b.silhouette, tone.accent, 'body', gain);
    for (const lens of b.core) sink.fill(lens, tone.core, 'core', gain);
  }
  if (plan.bursts.length) {
    const line = STRIKE.line * ictx.frame.S * 0.5;
    const d = tone.discharge;
    fillPolygons(ctx, plan.bursts.map((a) => ribbon(a.points, a.width.map((w) => w + 2 * line))), d.edge);
    fillPolygons(ctx, plan.bursts.map((a) => ribbon(a.points, a.width)), d.band);
    fillPolygons(ctx, plan.bursts.map((a) => ribbon(a.points, a.width.map((w) => 0.35 * w))), d.core);
    for (const a of plan.bursts) {
      const w = a.width[0];
      sink.stroke(a.points, w, d.band, 'body', gain);
      sink.stroke(a.points, 0.35 * w, d.core, 'core', gain);
    }
  }
  if (plan.flare) {
    fillPolygons(ctx, [plan.flare], tone.core);
    sink.fill(plan.flare, tone.core, 'core', gain);
  }
  if (plan.charge) sink.disc(ictx.frame.P, plan.charge.r, tone.core, plan.charge.c);
  ctx.globalCompositeOperation = op;
}

// ---- Beams ------------------------------------------------------------------------------------

// One beam to plan: its path, and its part in the step.
interface BeamSpec {
  id: number;
  r: Rng; // the beam's own draws, after β
  path: Vec2[]; // the root (S0: the limb's end) first
  base: number; // w_b, px
  role: BeamRole;
  cut: number; // a strand stops this far from P along its path, px
}

const beamBase = (limb: StrikeLimbPath, S: number) => Math.max(2 * limb.rMax, STRIKE.minWidth * S);
const usable = (limb: StrikeLimbPath) => limb.centerline.length >= 2 && limb.rMax >= 0;

// S0: each limb's head (breakdown phase 1: the bolt shows up a third of the
// way there). Its path leaves the limb's end between the limb's own heading
// and P, and bends into P (a quadratic curve); the first third of it shows,
// so the head runs on out of the limb. It is not turned about P, which
// would pull it off the limb's end. A limb already on P has no head.
function planHeads(ictx: StrikeContext, limbs: readonly StrikeLimbPath[], opts: StrikeOptions): Beam[] {
  const { P, S } = ictx.frame;
  return limbs.flatMap((limb, index) => {
    if (!usable(limb)) return [];
    const id = limb.id ?? index;
    const c = limb.centerline;
    const E = c[c.length - 1];
    const gap = Math.hypot(P[0] - E[0], P[1] - E[1]);
    if (!(gap > 0.03 * S)) return [];
    const toP: Vec2 = [(P[0] - E[0]) / gap, (P[1] - E[1]) / gap];
    const heading = unit(sub(E, c[Math.max(0, c.length - 4)]), toP);
    const C = add(E, unit(add(heading, toP), toP), HEAD_LEAD * gap);
    const path = Array.from({ length: 64 }, (_, k): Vec2 => {
      const t = k / 63;
      const a = (1 - t) * (1 - t);
      const b = 2 * (1 - t) * t;
      return [a * E[0] + b * C[0] + t * t * P[0], a * E[1] + b * C[1] + t * t * P[1]];
    });
    const beam = planBeam(ictx, 0, { id, r: rng(ictx.seed, 'beam', 0, id, 0), path, base: beamBase(limb, S), role: 'head', cut: 0 }, opts);
    return beam ? [beam] : [];
  });
}

// S1..S6: one beam per limb along the held centreline pulled toward the
// chord, ending on P (the tips are pinned), the step's beams turned together
// about P. With two or more, they join one bundle near P: a point σ px from
// P along a beam moves onto the axis point P + σ·â by 1 − smoothstep over
// STRIKE.merge of the shortest beam's length, â the mean heading from P to
// the beams' middles. The lead, the beam that moves least to join, runs on
// to P; each other stops at its first point, from its root, on the lead's
// edge (its centreline within the lead's half width of the lead's; by the
// merge's near end at the latest), so it ends inside the lead and its light
// doesn't pile up on the lead's. One that runs along the lead over nearly
// all its length is dropped: limbs that leave his back side by side (the
// hero's) make one beam.
function planBundle(ictx: StrikeContext, s: number, limbs: readonly StrikeLimbPath[], opts: StrikeOptions): Beam[] {
  const { P, u, S } = ictx.frame;
  const turn = uniform(rng(ictx.seed, 'bundle', s), -STRIKE.turnDeg, STRIKE.turnDeg) * DEG;
  const specs = limbs.flatMap((limb, index): BeamSpec[] => {
    if (!usable(limb)) return [];
    const id = limb.id ?? index;
    const r = rng(ictx.seed, 'beam', s, id, 0);
    const beta = uniform(r, STRIKE.beta[0], STRIKE.beta[1]);
    const held = resample(limb.centerline, 64);
    const R = limb.root;
    const m = held.length;
    let path = held.map((c, i): Vec2 => {
      const t = i / (m - 1);
      return [c[0] + (R[0] + (P[0] - R[0]) * t - c[0]) * beta, c[1] + (R[1] + (P[1] - R[1]) * t - c[1]) * beta];
    });
    const e = sub(P, path[m - 1]);
    path = path.map((p, i) => add(p, e, i / (m - 1)));
    path = path.map((p) => add(P, rotate(sub(p, P), turn)));
    return polylineLength(path) > 1 ? [{ id, r, path, base: beamBase(limb, S), role: 'lead', cut: 0 }] : [];
  });
  if (specs.length < 2) return specs.flatMap((spec) => planBeam(ictx, s, spec, opts) ?? []);

  const lengths = specs.map((spec) => polylineLength(spec.path));
  const shortest = Math.min(...lengths);
  const [from, to] = [STRIKE.merge[0] * shortest, STRIKE.merge[1] * shortest];
  const mid = specs.reduce<Vec2>((acc, spec, i) => add(acc, unit(sub(pointFromEnd(spec.path, 0.5 * lengths[i]), P), [0, 0])), [0, 0]);
  const axis = unit(mid, [-u[0], -u[1]]);
  const moved = specs.map((spec) => {
    const sigma = fromEnd(spec.path);
    let shift = 0;
    const path = spec.path.map((p, k) => {
      const w = 1 - smoothstep(from, to, sigma[k]);
      const onAxis = add(P, axis, sigma[k]);
      shift += w * Math.hypot(onAxis[0] - p[0], onAxis[1] - p[1]);
      return add(p, sub(onAxis, p), w);
    });
    return { path, shift };
  });
  const lead = moved.reduce((best, m, i) => (m.shift < moved[best].shift ? i : best), 0);
  const leadPath = moved[lead].path;
  const join = 0.5 * specs[lead].base * STRIKE.mult[s]; // the lead's half width
  return specs.flatMap((spec, i) => {
    const path = moved[i].path;
    if (i === lead) return planBeam(ictx, s, { ...spec, path, role: 'lead', cut: 0 }, opts) ?? [];
    const sigma = fromEnd(path);
    const k = path.findIndex((p, m) => sigma[m] <= from || distanceToLine(p, leadPath) <= join);
    const cut = k < 0 ? from : sigma[k];
    if (cut > 0.85 * sigma[0]) return [];
    return planBeam(ictx, s, { ...spec, path, role: 'strand', cut }, opts) ?? [];
  });
}

function planBeam(ictx: StrikeContext, s: number, spec: BeamSpec, opts: StrikeOptions): Beam | null {
  const { S } = ictx.frame;
  const { id, r, path, base, role } = spec;
  const total = polylineLength(path);
  if (!(total > 1)) return null;

  // Stations every 0.004 S (0.003 S for the swell's teeth). S0's head keeps
  // the first third from its limb's end; a strand stops `cut` px short of P.
  const n = clamp(Math.ceil(total / (S * (s === 6 ? 0.003 : 0.004))) + 1, 24, 480);
  const all = resample(path, n);
  const last = role === 'head' ? Math.ceil((n - 1) / 3) : role === 'strand' ? clamp(Math.floor((n - 1) * (1 - spec.cut / total)), 3, n - 1) : n - 1;
  const pts = all.slice(0, last + 1);
  const qs = pts.map((_, i) => 1 - i / (n - 1));
  const arc = qs.map((q) => (1 - q) * total);
  const normals = pts.map((_, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const t = unit(sub(b, a), [0, 1]);
    return perp(t);
  });

  const prof = beamProfile(s, qs, total, base, S, r, opts, role);

  // The edges wobble about the planned width, zero-mean over the body and,
  // from S1, at the table's RMS there, where it was measured (a strand's S6
  // body is its short stretch of the swell before it stops, which its own
  // mean would flatten; S0's head stays damped). S6's flame teeth were
  // measured on the swell: a beam that doesn't swell (calm, or swell off)
  // gets them in proportion to its width.
  const rmsPx = STRIKE.wobble[s] * S;
  const teeth = s === 6 ? Math.min(1, prof.target / (STRIKE.swell[0] * S)) : 1;
  const noise = (k: number) => {
    const o = edgeNoise(rng(ictx.seed, 'beam', s, id, k), arc, S, s, rmsPx);
    const scaled = o.map((v, i) => teeth * v * Math.min(1, prof.w[i] / (0.5 * prof.target)));
    const mean = meanOver(scaled, prof.body);
    const centred = scaled.map((v) => v - mean);
    const rms = Math.sqrt(meanOver(centred.map((v) => v * v), prof.body));
    const gain = s > 0 && rms > 0 ? Math.min(2, (teeth * rmsPx) / rms) : 1;
    return centred.map((v) => v * gain);
  };
  const oL = noise(1);
  const oR = noise(2);
  const stations: BeamStation[] = pts.map((p, i) => {
    const half = prof.w[i] / 2;
    return { p, n: normals[i], q: qs[i], w: prof.w[i], left: Math.max(0.15 * half, half + oL[i]), right: Math.max(0.15 * half, half + oR[i]) };
  });

  // The lead's contact end is flattened on the floor and ragged once pinned;
  // a strand's end, inside the bundle, and a head's point are round.
  const capJitter = rng(ictx.seed, 'beam', s, id, 5);
  const end = role === 'lead' ? { ragged: s >= 1, depth: 0.4 } : { ragged: false, depth: 1 };
  const lineAt = stations.map((st) => Math.min(STRIKE.line * S, 0.4 * Math.min(st.left, st.right)));
  const silhouette = outline(stations, () => 0, capJitter, end.ragged, end.depth);
  const fill = Math.max(...stations.map((st, i) => Math.min(st.left, st.right) - lineAt[i])) > 0.5 ? outline(stations, (i) => lineAt[i], rng(ictx.seed, 'beam', s, id, 5), end.ragged, end.depth) : null;
  const accentSide: 1 | -1 = rng(ictx.seed, 'beam', s, id, 3)() < 0.5 ? 1 : -1;
  const accent = fill ? tongues(rng(ictx.seed, 'beam', s, id, 4), stations, lineAt, arc, accentSide, S) : [];
  const lensed = fill ? lenses(rng(ictx.seed, 'beam', s, id, 6), s, stations, lineAt, accentSide, total, S, prof.swollen) : { core: [], share: 0, band: stations.map((): [number, number] => [0, 0]) };
  const cut = fill && s === 6 && prof.swollen ? swellTeeth(rng(ictx.seed, 'beam', s, id, 7), stations, lineAt, lensed.band, arc, S) : [];
  // The outlines with the points a fill can't tell from a straight edge
  // dropped: a canvas pays per edge, and most stations sit on straight runs.
  const lean = (poly: Vec2[]) => simplify(poly, OUTLINE_TOLERANCE);
  return {
    id,
    role,
    base,
    target: prof.target,
    body: prof.body,
    stations,
    silhouette: lean(silhouette),
    fill: fill && lean(fill),
    accent: accent.map(lean),
    core: lensed.core.map(lean),
    hot: s === 6 && prof.swollen,
    teeth: cut.map(lean),
    coreShare: lensed.share,
  };
}

const OUTLINE_TOLERANCE = 0.3; // px a dropped outline point may lie off the edge that replaces it

// A closed outline without the points that lie within `tol` px of the edge
// joining the kept points either side (Douglas–Peucker, split at the point
// farthest from the first).
function simplify(poly: readonly Vec2[], tol: number): Vec2[] {
  const n = poly.length;
  if (n <= 8) return poly.map((p): Vec2 => [p[0], p[1]]);
  let far = 0;
  let farthest = -1;
  for (let i = 1; i < n; i++) {
    const d = (poly[i][0] - poly[0][0]) ** 2 + (poly[i][1] - poly[0][1]) ** 2;
    if (d > farthest) {
      farthest = d;
      far = i;
    }
  }
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[far] = 1;
  const tol2 = tol * tol;
  const spans = [0, far, far, n]; // index n is the first point again
  while (spans.length) {
    const b = spans.pop()!;
    const a = spans.pop()!;
    if (b - a < 2) continue;
    const [ax, ay] = poly[a];
    const [bx, by] = poly[b % n];
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const px = poly[i][0] - ax;
      const py = poly[i][1] - ay;
      const t = l2 > 0 ? clamp((px * dx + py * dy) / l2, 0, 1) : 0;
      const d2 = (px - t * dx) ** 2 + (py - t * dy) ** 2;
      if (d2 > worst) {
        worst = d2;
        at = i;
      }
    }
    if (worst > tol2) {
      keep[at] = 1;
      spans.push(a, at, at, b);
    }
  }
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push([poly[i][0], poly[i][1]]);
  return out;
}

// The planned width at each station, and the stations (body) its target
// holds over. qs run from the root (1) to the contact end (0); a strand's
// stop short of it, S0's head's from its limb's end (1) to a third of the
// way to P.
function beamProfile(s: number, qs: number[], total: number, base: number, S: number, r: Rng, opts: StrikeOptions, role: BeamRole): { w: number[]; body: [number, number]; target: number; swollen: boolean } {
  const calm = opts.calm || (opts.gentle ?? false);
  const multOf = (k: number) => (calm ? clamp(STRIKE.mult[k], STRIKE.calm[0], STRIKE.calm[1]) : STRIKE.mult[k]);
  const n = qs.length;

  if (s === 0) {
    // The head: a point at the leading (far) end widening over 5 widths, and
    // a short tail out of the limb's end.
    const full = base * multOf(0);
    const visible = (qs[0] - qs[n - 1]) * total;
    const head = Math.min(5 * full, 0.55 * visible);
    const tail = Math.min(1.5 * full, 0.2 * visible);
    const hf = qs.map((q) => Math.min(1, ((q - qs[n - 1]) * total) / head));
    const tf = qs.map((q) => Math.min(1, ((qs[0] - q) * total) / tail));
    const w = qs.map((_, i) => full * Math.max(0.15, hf[i]) * Math.max(0.3, tf[i]));
    const plateau = qs.map((_, i) => i).filter((i) => hf[i] >= 1 && tf[i] >= 1);
    const body: [number, number] = plateau.length ? [plateau[0], plateau[plateau.length - 1]] : [0, n - 1];
    return { w, body, target: full, swollen: false };
  }

  const flares = role === 'lead';
  const window = stationsIn(qs, flares ? STRIKE.flare : 0.1, 0.9);
  if (s === 6 && opts.swell && !calm) {
    // The swell: the last 40 % at an absolute 0.30–0.38 S, held to q 0.55
    // and easing down to a quarter of it at the far end, as k6's widths run
    // (lightning §2.2: ≥ 0.8 of its near width to q 0.7, 0.3 at q 0.9).
    const swell = S * uniform(r, STRIKE.swell[0], STRIKE.swell[1]);
    const far = Math.max(base, 0.25 * swell);
    const w = qs.map((q) => (swell + (far - swell) * smoothstep(0.6, 1, q)) * rootTaper(q));
    return { w, body: stationsIn(qs, 0, 0.4), target: swell, swollen: true };
  }

  // S1 and S3 hold their width with 1–3 gentle bulges of ±30–50 %; S2, S4
  // and S5 taper toward the far end; S6 unswollen is flat. Normalised so the
  // mean over the body is exactly 1; then the lead's last quarter widens to
  // the contact end (judge reference:8: the bundle widened into P, where a
  // tenth narrowed it like a funnel). A strand ends inside the bundle, flat.
  const phase = uniform(r, 0, 2 * Math.PI);
  let shape: (x: number) => number;
  if (s === 1 || s === 3) {
    const bulges = int(r, 1, 3);
    const amp = uniform(r, 0.3, 0.5);
    shape = (x) => 1 + amp * Math.sin(Math.PI * bulges * x + phase);
  } else if (s === 6) {
    shape = (x) => 1 + 0.08 * Math.sin(2 * Math.PI * x + phase);
  } else {
    const far = STRIKE.farEnd[s];
    shape = (x) => (1 + (far - 1) * x) * (1 + 0.1 * Math.sin(2 * Math.PI * x + phase));
  }
  const raw = qs.map((q) => Math.max(0.12, shape((q - 0.1) / 0.8)));
  const mean = meanOver(raw, window);
  const end = flares ? STRIKE.contactEnd[s] : 1;
  const target = base * multOf(s);
  const w = raw.map((v, i) => {
    const b = v / mean;
    return target * (b + Math.max(0, end - b) * (1 - smoothstep(0, STRIKE.flare, qs[i]))) * rootTaper(qs[i]);
  });
  return { w, body: window, target, swollen: false };
}

// The last tenth at the root narrows to 0.4, so the beam grows out of the
// limb instead of starting on a round end. It lies outside every body window.
const rootTaper = (q: number) => 1 - 0.6 * smoothstep(0.9, 1, q);

// The stations whose q lies in [lo, hi], as an index range (qs decrease).
function stationsIn(qs: number[], lo: number, hi: number): [number, number] {
  let a = -1;
  let b = -1;
  qs.forEach((q, i) => {
    if (q >= lo - 1e-9 && q <= hi + 1e-9) {
      if (a < 0) a = i;
      b = i;
    }
  });
  return a < 0 ? [0, qs.length - 1] : [a, b];
}

// One edge's wobble, px per station: seeded knots every 0.013–0.03 S joined
// straight (S3 smooth, every 0.10–0.14 S), plus on S6 flame teeth of
// 0.02–0.04 S every 0.011–0.013 S. Scaled to `rms` over the whole edge.
function edgeNoise(r: Rng, arc: number[], S: number, s: number, rms: number): number[] {
  const n = arc.length;
  const L = arc[n - 1];
  const [lo, hi] = s === 3 ? [0.1, 0.14] : s === 6 ? [0.04, 0.07] : [0.013, 0.03];
  const knots: Vec2[] = [[-S * uniform(r, 0, hi), normal(r)]];
  while (knots[knots.length - 1][0] < L) knots.push([knots[knots.length - 1][0] + S * uniform(r, lo, hi), normal(r)]);
  let k = 0;
  const out = arc.map((x) => {
    while (k < knots.length - 2 && knots[k + 1][0] < x) k++;
    const [x0, v0] = knots[k];
    const [x1, v1] = knots[k + 1];
    return v0 + ((v1 - v0) * (x - x0)) / (x1 - x0);
  });
  if (s === 6) {
    // Flame teeth over the low wobble: ramps that drop sharply.
    const low = 0.0158 * S; // with teeth RMS ≈ 0.0087 S the edge comes to ≈ 0.018 S
    const rescaled = scaleRms(out, low);
    let a = -S * uniform(r, 0, 0.012);
    let b = a + S * uniform(r, 0.011, 0.013);
    let h = S * uniform(r, 0.02, 0.04);
    const toothed = rescaled.map((v, i) => {
      while (arc[i] >= b) {
        a = b;
        b = a + S * uniform(r, 0.011, 0.013);
        h = S * uniform(r, 0.02, 0.04);
      }
      return v + (h * (arc[i] - a)) / (b - a);
    });
    const mean = toothed.reduce((x, y) => x + y, 0) / n;
    return toothed.map((v) => v - mean);
  }
  return scaleRms(out, rms);
}

function scaleRms(values: number[], rms: number): number[] {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
  return values.map((v) => (sd > 0 ? ((v - mean) * rms) / sd : 0));
}

// A closed shape round the stations: the left edge to the contact end, a
// cap round it, the right edge back, a cap round the root end. `inset`
// pulls both edges in (for the fill inside the edge line). The contact cap
// is `depth` of a half disc (the lead's, 0.4, flattened against the floor)
// and ragged on the pinned steps.
function outline(st: BeamStation[], inset: (i: number) => number, r: Rng, ragged: boolean, depth: number): Vec2[] {
  const n = st.length;
  const half = (i: number, side: 'left' | 'right') => Math.max(0.3, st[i][side] - inset(i));
  const left = st.map((x, i) => add(x.p, x.n, half(i, 'left')));
  const right = st.map((x, i) => add(x.p, x.n, -half(i, 'right')));
  const tangent = (i: number): Vec2 => [st[i].n[1], -st[i].n[0]]; // n = perp(t), so t = (n_y, −n_x)
  const cap = (i: number, outward: Vec2, from: 1 | -1, jitter: number, depth: number): Vec2[] => {
    const l = half(i, 'left');
    const rr = half(i, 'right');
    const radius = (l + rr) / 2;
    const c = add(st[i].p, st[i].n, (l - rr) / 2);
    const steps = clamp(Math.round(radius / 2), 3, 12);
    const pts: Vec2[] = [];
    for (let k = 1; k < steps; k++) {
      const th = (Math.PI * k) / steps;
      const rad = radius * (1 + jitter * uniform(r, -1, 1));
      const across = from * Math.cos(th);
      pts.push(add(add(c, st[i].n, across * rad), outward, Math.sin(th) * rad * depth));
    }
    return pts;
  };
  const tEnd = tangent(n - 1);
  const tStart = tangent(0);
  return [...left, ...cap(n - 1, tEnd, 1, ragged ? 0.3 : 0, depth), ...right.reverse(), ...cap(0, [-tStart[0], -tStart[1]], -1, 0, 1)];
}

// Accent tongues (13–19 % of the area): 1–3 flame tongues along one edge,
// their inner border sawtoothed.
function tongues(r: Rng, st: BeamStation[], lineAt: number[], arc: number[], side: 1 | -1, S: number): Vec2[][] {
  const n = st.length;
  const spans = layout(r, n, int(r, 1, 3), uniform(r, 0.45, 0.7));
  return spans.map(([i0, i1]) => {
    const depth = uniform(r, 0.45, 0.75);
    const period = S * uniform(r, 0.012, 0.02);
    const offset = uniform(r, 0, period);
    const outer: Vec2[] = [];
    const inner: Vec2[] = [];
    for (let i = i0; i <= i1; i++) {
      const t = (i - i0) / (i1 - i0);
      const fh = Math.max(0, (side > 0 ? st[i].left : st[i].right) - lineAt[i]);
      const saw = ((arc[i] + offset) / period) % 1;
      const d = depth * fh * sinPow(Math.PI * t, 0.6) * (1 - 0.35 * saw);
      outer.push(add(st[i].p, st[i].n, side * fh));
      inner.push(add(st[i].p, st[i].n, side * (fh - d)));
    }
    return [...outer, ...inner.reverse()];
  });
}

// Core lenses: spindles with pointed ends, set a little off the accent side,
// sized so the mean core width ÷ beam width is the step's share. S0's core
// sits in the rear half of its head only; S6's swell (`hot`) has one broad
// teardrop from a little way out of its root into its end, at SWELL_CORE's
// share. `band` is each
// station's core, [top, bottom] along its normal ([0, 0] outside the lenses).
function lenses(r: Rng, s: number, st: BeamStation[], lineAt: number[], accentSide: 1 | -1, total: number, S: number, hot = false): { core: Vec2[][]; share: number; band: [number, number][] } {
  const n = st.length;
  const range = s === 0 ? Math.max(4, Math.floor(n / 2)) : n; // S0: from its tail at the limb to the middle of its head
  const visible = (st[0].q - st[n - 1].q) * total;
  const count = s === 0 || hot ? 1 : clamp(Math.round(visible / (0.22 * S)) + int(r, 0, 1), 1, 4);
  const spans: [number, number][] = hot ? [[Math.round(uniform(r, SWELL_CORE.root[0], SWELL_CORE.root[1]) * (n - 1)), n - 1]] : layout(r, Math.min(range, n), count, uniform(r, 0.7, 0.88));
  const spindle = new Array<number>(n).fill(0);
  for (const [i0, i1] of spans) {
    for (let i = i0; i <= i1; i++) {
      const t = (i - i0) / (i1 - i0);
      spindle[i] = hot ? sinPow((Math.PI / 2) * Math.min(1, t / SWELL_CORE.rise), 0.5) : sinPow(Math.PI * t, 0.6);
    }
  }
  const inRange = spindle.slice(0, Math.min(range, n));
  const meanSpindle = inRange.reduce((a, b) => a + b, 0) / inRange.length;
  const offs = spans.map(() => -accentSide * uniform(r, 0.05, 0.15));
  // The hot lens's edges run in flame teeth, as ragged as the swell round it
  // (a smooth white lens read as an egg): a sawtooth of SWELL_CORE.jag teeth,
  // each edge its own, biting in by up to a share of the lens's half width.
  const arc = st.map((x) => (st[0].q - x.q) * total);
  const jag = (): number[] => {
    const tooth = () => ({ len: S * uniform(r, SWELL_CORE.jag.len[0], SWELL_CORE.jag.len[1]), bite: uniform(r, SWELL_CORE.jag.bite[0], SWELL_CORE.jag.bite[1]) });
    let a = -S * uniform(r, 0, SWELL_CORE.jag.len[1]);
    let t = tooth();
    return arc.map((x) => {
      while (x >= a + t.len) {
        a += t.len;
        t = tooth();
      }
      return 1 - (t.bite * (x - a)) / t.len;
    });
  };
  const edges = hot ? [jag(), jag()] : null;
  // The lenses at core scale k, kept inside the fill; where the fill is too
  // thin a lens closes to a line, which costs share on a narrow beam.
  const build = (k: number) => {
    const core: Vec2[][] = [];
    const widths = new Array<number>(n).fill(0);
    const band = st.map((): [number, number] => [0, 0]);
    spans.forEach(([i0, i1], j) => {
      const top: Vec2[] = [];
      const bottom: Vec2[] = [];
      for (let i = i0; i <= i1; i++) {
        const half = st[i].w / 2;
        const hc = k * half * spindle[i];
        const c = offs[j] * half;
        const hi = Math.min(c + hc * (edges ? edges[0][i] : 1), st[i].left - lineAt[i] - 0.5);
        const lo = Math.max(c - hc * (edges ? edges[1][i] : 1), -(st[i].right - lineAt[i] - 0.5));
        const mid = (hi + lo) / 2;
        const up = Math.max(hi, mid);
        const down = Math.min(lo, mid);
        widths[i] = up - down;
        band[i] = [up, down];
        top.push(add(st[i].p, st[i].n, up));
        bottom.push(add(st[i].p, st[i].n, down));
      }
      if (i1 - i0 >= 2) core.push([...top, ...bottom.reverse()]);
    });
    const shares = widths.slice(0, Math.min(range, n)).map((w, i) => w / st[i].w);
    return { core, share: shares.reduce((a, b) => a + b, 0) / shares.length, band };
  };
  // Sized to the step's share, then once more for what the thin stretches cut
  // (a strand that stops in S6's swell is mostly its thin far part).
  const want = hot ? SWELL_CORE.share : STRIKE.coreShare[s];
  const most = hot ? SWELL_CORE.most : 0.8;
  const k = meanSpindle > 0 ? Math.min(most, want / meanSpindle) : 0;
  const first = build(k);
  if (!(first.share > 0) || first.share >= want || k >= most) return first;
  const second = build(Math.min(most, (k * want) / first.share));
  return second.share <= want ? second : first; // a lens that opens from a line can overshoot
}

// S6's accent teeth: along both edges of the swell (its stations with
// q ≤ 0.75, where the hot lens is broad), a run of flame teeth 0.03–0.06 S
// long, each rising from the fill's edge toward P and cut 0.02–0.04 S past
// the core's edge before it drops back (or to a tenth of the half width short
// of the centre line where there is no core). Painted over the white-hot core
// in the accent, under a glow that doesn't whiten them (judge reference:8).
function swellTeeth(r: Rng, st: BeamStation[], lineAt: number[], band: [number, number][], arc: number[], S: number): Vec2[][] {
  const swollen = st.map((x, i) => i).filter((i) => st[i].q <= 0.75);
  if (swollen.length < 3) return [];
  const [first, last] = [swollen[0], swollen[swollen.length - 1]];
  const out: Vec2[][] = [];
  for (const side of [1, -1] as const) {
    let a = arc[first] + S * uniform(r, 0, SWELL_TEETH.len[1]);
    while (a < arc[last]) {
      const b = Math.min(arc[last], a + S * uniform(r, SWELL_TEETH.len[0], SWELL_TEETH.len[1]));
      const depth = S * uniform(r, SWELL_TEETH.depth[0], SWELL_TEETH.depth[1]);
      const outer: Vec2[] = [];
      const inner: Vec2[] = [];
      for (let i = first; i <= last; i++) {
        if (arc[i] < a || arc[i] > b) continue;
        const t = (arc[i] - a) / Math.max(1e-9, b - a);
        const edge = Math.max(0, (side > 0 ? st[i].left : st[i].right) - lineAt[i]);
        const cored = band[i][0] > band[i][1];
        const reach = cored ? (side > 0 ? band[i][0] : -band[i][1]) : edge - depth; // the core's edge toward this side, from the centre line
        const tip = clamp(reach - depth, 0.1 * edge, edge);
        outer.push(add(st[i].p, st[i].n, side * edge));
        inner.push(add(st[i].p, st[i].n, side * (edge - (edge - tip) * t ** 1.5)));
      }
      if (outer.length >= 3) out.push([...outer, ...inner.reverse()]);
      a = b + S * uniform(r, SWELL_TEETH.gap[0], SWELL_TEETH.gap[1]);
    }
  }
  return out;
}

// `count` spans covering `coverage` of n stations, with seeded gaps between
// them and at the ends.
function layout(r: Rng, n: number, count: number, coverage: number): [number, number][] {
  const lengths = Array.from({ length: count }, () => uniform(r, 0.6, 1.4));
  const gaps = Array.from({ length: count + 1 }, () => uniform(r, 0.3, 1.7));
  const ls = lengths.reduce((a, b) => a + b, 0);
  const gs = gaps.reduce((a, b) => a + b, 0);
  const spans: [number, number][] = [];
  let at = 0;
  for (let k = 0; k < count; k++) {
    at += (gaps[k] / gs) * (1 - coverage) * (n - 1);
    const span = (lengths[k] / ls) * coverage * (n - 1);
    const i0 = Math.round(at);
    const i1 = Math.min(n - 1, Math.round(at + span));
    if (i1 - i0 >= 3) spans.push([i0, i1]);
    at += span;
  }
  return spans;
}

// ---- Splash ---------------------------------------------------------------------------------------

// A piece is first sized from its parts: the band's own area, and these
// shares of its blades' and teeth's (the rest overlaps the band). Then each
// side's union is measured and its pieces scaled to the side's share of the
// target, which takes out what the overlaps between pieces cost.
const BLADE_OVERLAP = 0.85; // of a blade's area outside the band it grows from
const TOOTH_OVERLAP = 0.8;
const SETTLED = 0.005; // a sizing pass that scales every side by less than this has converged

// The axes are drawn from this table. A piece spreads round its axis and
// has to fit between 30° and 180°, which smears the drawn table toward the
// middle bins; these weights are fitted (centre context, S1–S6, 200 seeds)
// so the splash's area lands on SPLASH_ANGLES.
const SPLASH_AXES: readonly (readonly [number, number, number])[] = [
  [0, 30, 0],
  [30, 60, 0.103],
  [60, 90, 0.221],
  [90, 120, 0.2195],
  [120, 150, 0.275],
  [150, 180, 0.157],
];

// An offset from P laid on the floor (the floor wings): its part along n̂
// (unit) scaled by floor.ratio, its part along t̂ kept.
export function onFloor(d: Vec2, up: Vec2, ratio: number): Vec2 {
  const along = dot(d, up) * (1 - ratio);
  return [d[0] - along * up[0], d[1] - along * up[1]];
}

// Sized to the step's % of the frame, as the reference's: it is the strike's
// paint, not a mass, and ×σ² left the hero's S6 at 7.5 % where the
// reference's shows 15–19 % (judges motion:1, reference:7); its lengths go in
// S with it. Gentle (Reduce flashing) keeps ×σ², which its flash budget was
// set with, and lengths in U, and draws S6's pieces at GENTLE_STRIKE's area on
// every step, so the splash grows in place instead of jumping.
function planSplash(ictx: StrikeContext, step: number, gentle = false): Splash | null {
  const pct = gentle ? GENTLE_STRIKE.splash[step] : STRIKE.splash[step];
  if (!(pct > 0)) return null;
  const s = gentle ? STRIKE_STEPS - 1 : step;
  const { P, u, v, U, sigma } = ictx.frame;
  const L = splashUnit(ictx.frame, gentle);
  const W = ictx.width;
  const H = ictx.height;
  const ratio = clamp(ictx.floor.ratio, 0.2, 1);
  const target = (pct / 100) * W * H * (gentle ? sigma * sigma : 1);
  const r = rng(ictx.seed, 'splash', s, 0);
  const heavy: 1 | -1 = rng(ictx.seed, 'splash', -1)() < 0.5 ? 1 : -1; // the same side for the whole strike
  const share = uniform(r, SPLASH.share[0] + 0.01, SPLASH.share[1] - 0.01); // a point inside, so the drawn share stays in the band
  const disc = L * uniform(r, SPLASH.disc[0], SPLASH.disc[1]);
  const rim = SPLASH.rim * L;
  const clear = disc + 2.5 * rim; // the rim mitres out to 2.5× at the sharpest tips
  const pad = 2.5 * rim + 0.5; // how far past its outline a piece can colour a pixel
  const count = STRIKE.pieces[s];
  const onHeavy = clamp(Math.round(count * share), 1, count - 1);
  const { n: up, t: across } = floorFrame(P, ictx.floor);

  // Each side's area split between its pieces; their axes stratified over
  // the table, so the pieces on a side spread out.
  const plans: { side: 1 | -1; area: number; angle: number }[] = [];
  for (const [side, k, total] of [[heavy, onHeavy, share], [-heavy as 1 | -1, count - onHeavy, 1 - share]] as const) {
    const weights = Array.from({ length: k }, () => uniform(r, 0.7, 1.3));
    const sum = weights.reduce((a, b) => a + b, 0);
    const order = shuffled(r, k);
    weights.forEach((w, i) => plans.push({ side, area: (target * total * w) / sum, angle: angleAt((order[i] + uniform(r, 0.1, 0.9)) / k) }));
  }

  const e1: Vec2 = [-u[0], -u[1]];
  // How far the frame lets a piece run from P along its axis, px: the most
  // of the four ways a cut piece can be mirrored back in (below). A piece
  // aimed at a near edge is built short and fat instead of long and cut
  // (blade-long pieces, P on an edge, showed under half their area). It is
  // measured as on a flat floor, so a floor's squash only shortens what
  // shows and the same piece lies on every floor.
  const exit = (w: Vec2): number => {
    let t = Infinity;
    if (Math.abs(w[0]) > 1e-9) t = Math.min(t, ((w[0] > 0 ? W : 0) - P[0]) / w[0]);
    if (Math.abs(w[1]) > 1e-9) t = Math.min(t, ((w[1] > 0 ? H : 0) - P[1]) / w[1]);
    return Math.max(0, t);
  };
  const roomAt = (angle: number, side: 1 | -1): number => {
    const e2: Vec2 = [side * v[0], side * v[1]];
    const w: Vec2 = [Math.cos(angle * DEG) * e1[0] + Math.sin(angle * DEG) * e2[0], Math.cos(angle * DEG) * e1[1] + Math.sin(angle * DEG) * e2[1]];
    const a = reflect(w, [0, 0], up);
    return Math.max(...[w, a, reflect(w, [0, 0], across), reflect(a, [0, 0], across)].map(exit));
  };
  const pieces: SplashPiece[] = [];
  plans.forEach((plan, i) => {
    const pr = rng(ictx.seed, 'splash', s, 1 + i);
    // Built in floor space at the area that squashes down to its screen area.
    const parts = buildPiece(pr, plan.area / ratio, L, disc + L * uniform(pr, 0.005, 0.05), roomAt(plan.angle, plan.side));
    // The axis, moved only as far as it takes for the whole piece to sit
    // between 30° and 180° on its own side, its rim and a half pixel of
    // anti-aliasing included.
    let lo = Infinity;
    let hi = -Infinity;
    for (const part of parts) for (const p of [...part.shape, ...part.teeth.flat()]) {
      const a = Math.atan2(p[1], p[0]) / DEG;
      const spill = Math.asin(Math.min(1, pad / Math.max(pad, Math.hypot(p[0], p[1])))) / DEG;
      lo = Math.min(lo, a - spill);
      hi = Math.max(hi, a + spill);
    }
    const angle = 30 - lo <= 180 - hi ? clamp(plan.angle, 30 - lo, 180 - hi) : (30 - lo + 180 - hi) / 2;
    const e2: Vec2 = [plan.side * v[0], plan.side * v[1]];
    const c = Math.cos(angle * DEG);
    const sn = Math.sin(angle * DEG);
    const radial: Vec2 = [c * e1[0] + sn * e2[0], c * e1[1] + sn * e2[1]];
    const tangential: Vec2 = [-sn * e1[0] + c * e2[0], -sn * e1[1] + c * e2[1]];
    // Floor space to the screen: offsets along n̂ squashed by floor.ratio.
    const place = ([x, y]: Vec2): Vec2 => add(P, onFloor([x * radial[0] + y * tangential[0], x * radial[1] + y * tangential[1]], up, ratio));
    let placed = parts.map((part) => ({ kind: part.kind, shape: part.shape.map(place), teeth: part.teeth.map((t) => t.map(place)) }));
    placed = clearOfDisc(placed, P, clear, place(parts[0].shape[0]));
    pieces.push({ side: plan.side, angle, area: plan.area, parts: placed, mirrored: false });
  });

  // Back into the frame first. A piece the frame cuts is mirrored across the
  // floor tangent through P (or, if that brings more of it on, across the
  // floor's up line, or both): one mostly off it for any gain, one mostly on
  // only when that brings 15 % more of it on, since growing a cut piece
  // pushes it further off. Mirrors about lines through P keep the empty disc
  // empty.
  const flips: ((p: Vec2) => Vec2)[] = [(p) => reflect(p, P, up), (p) => reflect(p, P, across), (p) => reflect(reflect(p, P, up), P, across)];
  const flip = (part: SplashPart, f: (p: Vec2) => Vec2): SplashPart => ({ kind: part.kind, shape: part.shape.map(f), teeth: part.teeth.map((t) => t.map(f)) });
  const onShare = (parts: SplashPart[]) => {
    let on = 0;
    let all = 0;
    for (const part of parts) {
      all += Math.abs(polygonArea(part.shape));
      on += clippedArea(part.shape, W, H);
    }
    return all > 0 ? on / all : 0;
  };
  for (const piece of pieces) {
    const here = onShare(piece.parts);
    if (here >= 0.9) continue;
    let best = here + (here < 0.5 ? 0.05 : 0.15);
    let pick: ((p: Vec2) => Vec2) | null = null;
    for (const f of flips) {
      const there = onShare(piece.parts.map((part) => flip(part, f)));
      if (there > best) {
        best = there;
        pick = f;
      }
    }
    if (pick) {
      const f = pick;
      piece.parts = piece.parts.map((part) => flip(part, f));
      piece.mirrored = true;
    }
  }

  // A part still wholly off the frame (a blade the piece's flip left out, or
  // one the sizing below pushed out) is mirrored on its own, by the first
  // flip that lands it.
  const off = (poly: Vec2[]) => mirrorIntoFrame([...poly, poly[0]], P, up, W, H).mirrored;
  const land = (): boolean => {
    let moved = false;
    for (const piece of pieces) {
      piece.parts = piece.parts.map((part) => {
        if (!off(part.shape)) return part;
        const f = flips.find((g) => !off(part.shape.map(g)));
        if (!f) return part;
        moved = true;
        return flip(part, f);
      });
    }
    return moved;
  };

  // Each side to its share of the target, as it shows: the union of its
  // pieces with their rim, measured on scanlines inside the frame, its pieces
  // scaled about their roots (the band's first point) and pushed clear of the
  // disc again. A side aims at its share times how much the two sides
  // overlap (mirrored pieces can land on each other), so the union of both
  // comes to the target. Up to four times, since scaling moves the overlaps
  // and the rim keeps its width; it stops once nothing moves. A piece cut by
  // the frame edge grows until what shows makes up the area, but a side never
  // grows past SPLASH.grow² × what it aims at in all, so a P in a corner
  // can't blow the splash up. Lines 0.012 U apart at most (4.6 px on the
  // hero at 608) keep the drawn area at 0.94–1.03 × the target (60 seeds on
  // five scenes, P in a corner and on an edge among them).
  const cell = Math.max(0.5, Math.min(0.012 * U, Math.sqrt(target) / 30));
  const sides = [[heavy, share], [-heavy as 1 | -1, 1 - share]] as const;
  for (let pass = 0; pass < 4; pass++) {
    let settled = !land();
    const mine = sides.map(([side]) => pieces.filter((p) => p.side === side));
    const covers = mine.map((m) => splashCover(m, rim));
    const [heavyArea, lightArea, bothArea] = unionAreas(covers, cell, W, H);
    const each = [heavyArea, lightArea];
    const overlap = bothArea.visible > 0 ? clamp((heavyArea.visible + lightArea.visible) / bothArea.visible, 1, 2) : 1;
    sides.forEach(([, total], i) => {
      const { all, visible } = each[i];
      if (!(visible > 0)) return;
      const aim = target * total * overlap;
      const k = Math.min(Math.sqrt(aim / visible), SPLASH.grow * Math.sqrt(aim / all));
      if (Math.abs(k - 1) > SETTLED) settled = false;
      for (const piece of mine[i]) {
        const root = piece.parts[0].shape[0];
        const grow = (p: Vec2): Vec2 => [root[0] + (p[0] - root[0]) * k, root[1] + (p[1] - root[1]) * k];
        const grown = piece.parts.map((part) => ({ kind: part.kind, shape: part.shape.map(grow), teeth: part.teeth.map((t) => t.map(grow)) }));
        piece.parts = clearOfDisc(grown, P, clear, root);
      }
    });
    if (settled) break;
  }

  // The last scaling can push a part out again; one that can't land
  // anywhere is dropped.
  land();
  const kept: SplashPiece[] = [];
  for (const piece of pieces) {
    const parts = piece.parts.filter((part) => !off(part.shape));
    if (parts.length) kept.push({ ...piece, parts });
  }
  return { target, disc, side: heavy, share, rim, pieces: kept };
}

// The axis angle at t (0..1) of the drawn table's cumulative share, degrees from −d.
function angleAt(t: number): number {
  const total = SPLASH_AXES.reduce((a, [, , w]) => a + w, 0);
  let acc = 0;
  for (const [from, to, w] of SPLASH_AXES) {
    if (w <= 0) continue;
    const next = acc + w / total;
    if (t < next) return from + ((to - from) * (t - acc)) / (next - acc);
    acc = next;
  }
  return 180;
}

function shuffled(r: Rng, n: number): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// One piece in its own floor space: x out from P along its axis, y across.
// Its band is one to three spines from `rho0` out (SPINE), each a jagged
// blade bowed a little and widest a third of the way along, its edges broken
// by knots every 0.03–0.07 L pushed in or out by up to a third of the half
// width, with a big tooth every 0.21–0.32 L along them; a fan of blades off
// the spines' ends, more off their sides. (Round 2 sawed both edges with a
// tooth every 0.025–0.05 U, which read as a fern.) Sized to `area`, px²,
// about its root. L is the splash's unit.
function buildPiece(r: Rng, area: number, L: number, rho0: number, room = Infinity): SplashPart[] {
  const g = clamp(Math.sqrt(area / (0.05 * L * L)), 0.3, 1); // 1 for the big S4–S6 pieces
  const fan = g > 0.6 ? int(r, 3, 5) : int(r, 1, 3);
  const sideBlades = clamp(Math.round(uniform(r, 0.5, 1.5) * (1 + 2 * g)), 1, 4);
  const specs = Array.from({ length: fan + sideBlades }, () => {
    const len = L * uniform(r, SPLASH.blade[0], SPLASH.blade[0] + (SPLASH.blade[1] - SPLASH.blade[0]) * g);
    return { len, base: len / uniform(r, SPLASH.aspect[0], SPLASH.aspect[1]), curl: uniform(r, -0.08, 0.08) };
  });
  const bladeArea = (b: { len: number; base: number }) => b.len * b.base * BLADE_FILL;
  const most = 0.5 * area;
  const blades = specs.reduce((a, b) => a + bladeArea(b), 0) * BLADE_OVERLAP;
  if (blades > most) {
    const k = Math.sqrt(most / blades);
    for (const b of specs) {
      b.len *= k;
      b.base *= k;
    }
  }

  // The spines: as many as it takes for each to hold its share of the band
  // at SPINE.aspect within SPINE.reach, fanned about the piece's axis. Where
  // the frame leaves less room than that, past the disc and the fan off the
  // ends, the reach shortens, and spines that can't hold their share that
  // short widen instead: a stub the frame shows whole carries more of the
  // area than a blade it cuts.
  const bandArea = Math.max(0.3 * area, area - Math.min(blades, most));
  const tips = Math.max(0, ...specs.slice(0, fan).map((b) => b.len));
  const reach = clamp(SPINE.room * (room - rho0) - 0.7 * tips, SPINE.shortest * L, SPINE.reach * L);
  const aspect = uniform(r, SPINE.aspect[0], SPINE.aspect[1]);
  const count = clamp(Math.ceil((bandArea * aspect) / (PROF_MEAN * reach * reach)), 1, SPINE.most);
  const spread = uniform(r, SPINE.fan[0], SPINE.fan[1]);
  const spines = Array.from({ length: count }, (_, k) => {
    const Lb = clamp(Math.sqrt((aspect * bandArea) / count / PROF_MEAN) * uniform(r, 0.9, 1.1), 0.08 * L, reach);
    const turn = (k - (count - 1) / 2) * spread + (count > 1 ? uniform(r, -3, 3) : 0);
    return spine(r, bandArea / count, Lb, turn * DEG, rho0, L);
  });
  const parts: SplashPart[] = spines.map((sp) => sp.part);

  // The fan off the spines' ends, ≈15–20° apart; the side blades off their
  // outer halves, 15–40° out to alternate sides. Dealt round the spines.
  const spacing = uniform(r, 15, 20);
  const fans = spines.map((_, k) => Math.floor(fan / count) + (k < fan % count ? 1 : 0));
  const sides = spines.map((_, k) => Math.floor(sideBlades / count) + (k < sideBlades % count ? 1 : 0));
  let next = 0;
  spines.forEach((sp, k) => {
    const endDir = unit(sub(sp.centre(1), sp.centre(0.9)), [1, 0]);
    for (let i = 0; i < fans[k]; i++) {
      const t = uniform(r, 0.82, 0.92);
      const turn = (i - (fans[k] - 1) / 2) * spacing + uniform(r, -4, 4);
      parts.push(bladePart(r, sp.centre(t), rotate(endDir, turn * DEG), specs[next++], L));
    }
  });
  let sign: 1 | -1 = r() < 0.5 ? 1 : -1;
  spines.forEach((sp, k) => {
    for (let j = 0; j < sides[k]; j++) {
      const t = 0.35 + (0.5 * (j + uniform(r, 0.2, 0.8))) / sides[k];
      const at = add(sp.centre(t), sp.normalAt(t), sign * 0.8 * sp.halfAt(t) * (1 + sign * sp.skew));
      const dir = rotate(unit(sub(sp.centre(Math.min(1, t + 0.05)), sp.centre(t)), [1, 0]), sign * uniform(r, 15, 40) * DEG);
      parts.push(bladePart(r, at, dir, specs[next++], L));
      sign = -sign as 1 | -1;
    }
  });

  // Sized to its area about its root.
  const est =
    BLADE_OVERLAP * parts.slice(count).reduce((a, p) => a + Math.abs(polygonArea(p.shape)), 0) +
    parts.slice(0, count).reduce((a, p) => a + Math.abs(polygonArea(p.shape)), 0) +
    TOOTH_OVERLAP * parts.reduce((a, p) => a + p.teeth.reduce((b, t) => b + Math.abs(polygonArea(t)), 0), 0);
  const k = Math.sqrt(area / est);
  const scale = ([x, y]: Vec2): Vec2 => [rho0 + (x - rho0) * k, y * k];
  return parts.map((p) => ({ kind: p.kind, shape: p.shape.map(scale), teeth: p.teeth.map((t) => t.map(scale)) }));
}

const PROF_MEAN = 0.749; // the mean of the band's profile sin(π t^0.7)^0.6 over t 0..1
const BLADE_FILL = 0.4; // a blade's area ÷ (length × base)

// One spine of a piece: a jagged band of `area` px², `Lb` long, from
// (rho0, 0) out along `turn` (radians from the piece's axis), with the big
// teeth along its edges; and its centre line, normal and half width, for the
// blades off it.
function spine(r: Rng, area: number, Lb: number, turn: number, rho0: number, L: number) {
  const dir: Vec2 = [Math.cos(turn), Math.sin(turn)];
  const side0 = perp(dir);
  const bow = uniform(r, -0.12, 0.12) * Lb;
  const skew = uniform(r, -0.25, 0.25);
  const centre = (t: number): Vec2 => add(add([rho0, 0], dir, Lb * t), side0, bow * 4 * t * (1 - t));
  const normalAt = (t: number): Vec2 => perp(unit(add([dir[0] * Lb, dir[1] * Lb], side0, bow * 4 * (1 - 2 * t)), dir));
  const prof = (t: number) => sinPow(Math.PI * t ** 0.7, 0.6);
  const knots = (): { t: number; o: number }[] => {
    const out: { t: number; o: number }[] = [];
    for (let x = L * uniform(r, 0.01, 0.04); x < Lb; x += L * uniform(r, 0.03, 0.07)) out.push({ t: x / Lb, o: uniform(r, -0.35, 0.25) });
    return out;
  };
  const upKnots = knots();
  const downKnots = knots();
  const edge = (side: 1 | -1, Wb: number, marks: { t: number; o: number }[]): Vec2[] =>
    marks.map(({ t, o }) => {
      const half = (Wb / 2) * prof(t) * (1 + side * skew);
      return add(centre(t), normalAt(t), side * Math.max(0.2 * half, half * (1 + o)));
    });
  const band = (Wb: number): Vec2[] => [centre(0), ...edge(1, Wb, upKnots), centre(1), ...edge(-1, Wb, downKnots).reverse()];
  // One Newton step on the width: d(area)/d(width) is the profile's integral.
  const span = Lb * PROF_MEAN;
  const W0 = area / span;
  const Wb = Math.max(0.01 * L, W0 + (area - Math.abs(polygonArea(band(W0)))) / span);
  const halfAt = (t: number) => (Wb / 2) * prof(t);
  const smooth = (side: 1 | -1) => Array.from({ length: 17 }, (_, k) => add(centre(k / 16), normalAt(k / 16), side * halfAt(k / 16) * (1 + side * skew)));
  const part: SplashPart = { kind: 'body', shape: band(Wb), teeth: [...teethAlong(r, smooth(1), 1, L), ...teethAlong(r, smooth(-1), -1, L)] };
  return { part, centre, normalAt, halfAt, skew };
}

function bladePart(r: Rng, base: Vec2, dir: Vec2, b: { len: number; base: number; curl: number }, L: number): SplashPart {
  const shape = bladeShape(base, dir, b.len, b.base, b.curl);
  const tip = shape[3];
  const m = perp(dir);
  return { kind: 'blade', shape, teeth: [...teethAlong(r, [shape[0], shape[1], shape[2], tip], 1, L, m), ...teethAlong(r, [shape[6], shape[5], shape[4], tip], -1, L, m)] };
}

// A curved blade from `base` along `dir`: its width falls as (1 − t)^1.25
// to a point, its tip bent by `curl` × its length.
function bladeShape(base: Vec2, dir: Vec2, len: number, width: number, curl: number): Vec2[] {
  const m = perp(dir);
  const at = (t: number, side: number): Vec2 => {
    const c = add(add(base, dir, len * t), m, curl * len * t * t);
    return add(c, m, (side * width * (1 - t) ** 1.25) / 2);
  };
  return [at(0, 1), at(1 / 3, 1), at(2 / 3, 1), at(1, 0), at(2 / 3, -1), at(1 / 3, -1), at(0, -1)];
}

// Teeth along an edge (a polyline running out from the root): one every
// 0.21–0.32 L, 0.045 L long at the median on a 0.017–0.029 L base, leaning
// toward the tip. `outward` says which side of travel is outside (+1: the
// left normal, perp of the tangent), or of `normalHint` when given.
function teethAlong(r: Rng, edge: Vec2[], outward: 1 | -1, L: number, normalHint?: Vec2): Vec2[][] {
  const length = polylineLength(edge);
  const teeth: Vec2[][] = [];
  const every = () => L * uniform(r, SPLASH.tooth.every[0], SPLASH.tooth.every[1]);
  for (let at = every() * uniform(r, 0.3, 1); at < length * 0.9; at += every()) {
    if (at < length * 0.12) continue;
    const { p, t } = pointAt(edge, at);
    const n0 = normalHint ?? perp(t);
    const o: Vec2 = [outward * n0[0], outward * n0[1]];
    const lean = uniform(r, 10, 50) * DEG;
    const dir = unit(add([o[0] * Math.cos(lean), o[1] * Math.cos(lean)], t, Math.sin(lean)), o);
    const len = L * clamp(SPLASH.tooth.len * Math.exp(normal(r, 0, 0.45)), 0.025, 0.1);
    const base = Math.min(L * uniform(r, SPLASH.tooth.base[0], SPLASH.tooth.base[1]), len / 1.2);
    const c = add(p, o, -0.25 * base);
    teeth.push([add(c, t, base / 2), add(c, dir, len), add(c, t, -base / 2)]);
  }
  return teeth;
}

// Pushes a piece out along its own direction until no part comes within
// `clear` of P: the empty disc plus the rim's reach.
function clearOfDisc(parts: SplashPart[], P: Vec2, clear: number, root: Vec2): SplashPart[] {
  const away = unit(sub(root, P), [0, -1]);
  let out = parts;
  for (let pass = 0; pass < 8; pass++) {
    const nearest = Math.min(...out.map((part) => Math.min(distanceTo(P, part.shape), ...part.teeth.map((t) => distanceTo(P, t)))));
    const short = clear + 1 - nearest;
    if (short <= 0) break;
    const shift = (p: Vec2) => add(p, away, short + 0.5);
    out = out.map((part) => ({ kind: part.kind, shape: part.shape.map(shift), teeth: part.teeth.map((t) => t.map(shift)) }));
  }
  return out;
}

// ---- Contact bursts ----------------------------------------------------------------------------

// S1, S4 and S5: 6–10 jagged arcs out of P by midpoint displacement, spread
// over the 270° away from the striker, reaching 0.10–0.25 U, flattened onto
// the floor (offsets along n̂ × floor.ratio). One frame each. An arc with
// under half of itself on the frame is mirrored on the floor through P, as
// the splash's pieces are: across the floor tangent, across n̂ or both,
// whichever puts the most of it on (judge reference:21: with P on the bottom
// edge, most of the hero's fell off it). A mirror that lands it inside the
// open cone toward the striker is turned out to the cone's edge.
function planBursts(ictx: StrikeContext, s: number): BurstArc[] {
  if (!(STRIKE.bursts as readonly number[]).includes(s)) return [];
  const { P, u, v, U, S } = ictx.frame;
  const ratio = clamp(ictx.floor.ratio, 0.2, 1);
  const { n: up, t: across } = floorFrame(P, ictx.floor);
  const r = rng(ictx.seed, 'burst', s);
  const count = int(r, BURST.arcs[0], BURST.arcs[1]);
  const spread = 360 - 2 * BURST.open;
  const e1: Vec2 = [-u[0], -u[1]];
  const squash = (p: Vec2): Vec2 => add(P, onFloor(sub(p, P), up, ratio));
  const W = ictx.width;
  const H = ictx.height;
  const onShare = (pts: Vec2[]) => pts.filter(([x, y]) => x >= 0 && x <= W && y >= 0 && y <= H).length / pts.length;
  const flips: ((p: Vec2) => Vec2)[] = [(p) => reflect(p, P, up), (p) => reflect(p, P, across), (p) => reflect(reflect(p, P, up), P, across)];
  // Turned about P until its end is BURST.open from −d̂, if it is closer (floor space).
  const outOfCone = (pts: Vec2[]): Vec2[] => {
    const end = sub(pts[pts.length - 1], P);
    const from = Math.acos(clamp(dot(end, e1) / Math.hypot(end[0], end[1]), -1, 1));
    if (from >= BURST.open * DEG) return pts;
    const side = e1[0] * end[1] - e1[1] * end[0] >= 0 ? 1 : -1;
    return pts.map((p) => add(P, rotate(sub(p, P), side * (BURST.open * DEG - from))));
  };
  return Array.from({ length: count }, (_, k) => {
    const ar = rng(ictx.seed, 'burst', s, k);
    const psi = (BURST.open + ((k + uniform(ar, 0.15, 0.85)) * spread) / count) * DEG;
    const dir: Vec2 = [Math.cos(psi) * e1[0] + Math.sin(psi) * v[0], Math.cos(psi) * e1[1] + Math.sin(psi) * v[1]];
    const reach = U * uniform(ar, BURST.reach[0], BURST.reach[1]);
    const end = add(P, dir, reach);
    let pts: Vec2[] = [P, end];
    let amp = 0.24;
    for (let level = 0; level < BURST.levels; level++) {
      const next: Vec2[] = [pts[0]];
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const d = sub(b, a);
        const mid = add([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], perp(d), amp * uniform(ar, -1, 1));
        next.push(mid, b);
      }
      pts = next;
      amp *= 0.55;
    }
    // A kink near the end can carry a point past the end's own distance:
    // pulled in about P, the arc reaches exactly as far as it was drawn to.
    const far = Math.max(...pts.map((p) => Math.hypot(p[0] - P[0], p[1] - P[1])));
    if (far > reach) pts = pts.map((p) => add(P, sub(p, P), reach / far));
    const w0 = S * uniform(ar, BURST.width[0], BURST.width[1]);
    let points = pts.map(squash);
    let mirrored = false;
    let on = onShare(points);
    if (on < 0.5) {
      for (const flip of flips) {
        const m = outOfCone(pts.map(flip)).map(squash);
        const share = onShare(m);
        if (share > on) [points, on, mirrored] = [m, share, true];
      }
    }
    return { points, width: points.map((_, i) => w0 * (1 - (0.75 * i) / (points.length - 1))), mirrored };
  });
}

// The flare star at P on S1 and S4: FLARE's points round its body, at a
// seeded turn, laid on the floor as the bursts are.
function planFlare(ictx: StrikeContext, s: number): Vec2[] | null {
  if (!(STRIKE.flares as readonly number[]).includes(s)) return null;
  const { P, S } = ictx.frame;
  const ratio = clamp(ictx.floor.ratio, 0.2, 1);
  const { n: up } = floorFrame(P, ictx.floor);
  const r = rng(ictx.seed, 'flare', s);
  const k = int(r, FLARE.points[0], FLARE.points[1]);
  const turn = uniform(r, 0, (2 * Math.PI) / k);
  const pts: Vec2[] = [];
  for (let i = 0; i < k; i++) {
    const a = turn + (2 * Math.PI * i) / k;
    const tip = S * uniform(r, FLARE.tip[0], FLARE.tip[1]);
    const body = S * FLARE.body * uniform(r, 0.85, 1.15);
    const b = a + Math.PI / k;
    pts.push([Math.cos(a) * tip, Math.sin(a) * tip], [Math.cos(b) * body, Math.sin(b) * body]);
  }
  return pts.map((d) => add(P, onFloor(d, up, ratio)));
}

// ---- Geometry helpers ---------------------------------------------------------------------------

const DEG = Math.PI / 180;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const add = (a: Vec2, b: Vec2, k = 1): Vec2 => [a[0] + b[0] * k, a[1] + b[1] * k];
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
const perp = (a: Vec2): Vec2 => [-a[1], a[0]];
const rotate = (a: Vec2, rad: number): Vec2 => [a[0] * Math.cos(rad) - a[1] * Math.sin(rad), a[0] * Math.sin(rad) + a[1] * Math.cos(rad)];
const reflect = (p: Vec2, P: Vec2, axis: Vec2): Vec2 => add(p, axis, -2 * dot(sub(p, P), axis));
// sin(x)^p, 0 where the sine dips below 0 (sin(π·m/m) can, by an ulp).
const sinPow = (x: number, p: number) => Math.max(0, Math.sin(x)) ** p;

function unit(a: Vec2, fallback: Vec2): Vec2 {
  const l = Math.hypot(a[0], a[1]);
  return l > 0 ? [a[0] / l, a[1] / l] : fallback;
}

function meanOver(values: number[], [a, b]: [number, number]): number {
  let sum = 0;
  for (let i = a; i <= b; i++) sum += values[i];
  return sum / (b - a + 1);
}

function polylineLength(pts: readonly Vec2[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return total;
}

// Each point's distance from the polyline's last point, along it.
function fromEnd(pts: readonly Vec2[]): number[] {
  const out = new Array<number>(pts.length).fill(0);
  for (let i = pts.length - 2; i >= 0; i--) out[i] = out[i + 1] + Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  return out;
}

// The point `d` px back along a polyline from its last point.
function pointFromEnd(pts: readonly Vec2[], d: number): Vec2 {
  return pointAt([...pts].reverse(), d).p;
}

// `count` points evenly spaced along a polyline.
function resample(pts: readonly Vec2[], count: number): Vec2[] {
  return resampleStroke(pts.map(([x, y]) => [x, y, 1]), count).points;
}

// The point `at` px along a polyline, and the unit tangent there.
function pointAt(pts: readonly Vec2[], at: number): { p: Vec2; t: Vec2 } {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (acc + seg >= at || i === pts.length - 1) {
      const w = seg > 0 ? clamp((at - acc) / seg, 0, 1) : 0;
      const d = sub(pts[i], pts[i - 1]);
      return { p: add(pts[i - 1], d, w), t: unit(d, [1, 0]) };
    }
    acc += seg;
  }
  return { p: pts[0], t: [1, 0] };
}

// Signed shoelace area: positive when the interior is to the left of travel
// in x-right, y-up terms (clockwise on a y-down screen).
export function polygonArea(poly: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

// The areas of unions of polygons, on scanlines `cell` px apart: each
// polygon's spans on a line (nonzero, as the canvas fills them), merged with
// the others'. Each edge is only visited on the lines it crosses. Within a
// fraction of a cell per edge crossing of the exact union, and cheap. One
// result per group of polygons, then one for all of them together: `all` is
// the whole union, `visible` the part of it inside the w × h frame.
function unionAreas(groups: readonly (readonly Vec2[][])[], cell: number, w: number, h: number): { all: number; visible: number }[] {
  const out = Array.from({ length: groups.length + 1 }, () => ({ all: 0, visible: 0 }));
  let top = Infinity;
  let bottom = -Infinity;
  for (const group of groups) {
    for (const p of group) {
      if (p.length < 3) continue;
      for (const q of p) {
        top = Math.min(top, q[1]);
        bottom = Math.max(bottom, q[1]);
      }
    }
  }
  const rows = Number.isFinite(top) ? Math.max(0, Math.ceil((bottom - top) / cell - 0.5)) : 0;
  if (!rows) return out;

  // Each line's crossings as [polygon, x, winding step] triples, polygon by
  // polygon. Line r is y = top + (r + ½)·cell, and an edge crosses it when
  // its lower end ≤ y < its upper end.
  const lines: number[][] = Array.from({ length: rows }, () => []);
  const groupOf: number[] = [];
  groups.forEach((group, g) => {
    for (const p of group) {
      if (p.length < 3) continue;
      const k = groupOf.length;
      groupOf.push(g);
      for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
        const a = p[j];
        const b = p[i];
        if (a[1] === b[1]) continue;
        const r0 = Math.max(0, Math.ceil((Math.min(a[1], b[1]) - top) / cell - 0.5));
        const r1 = Math.min(rows - 1, Math.ceil((Math.max(a[1], b[1]) - top) / cell - 0.5) - 1);
        const slope = (b[0] - a[0]) / (b[1] - a[1]);
        const step = b[1] > a[1] ? 1 : -1;
        for (let r = r0; r <= r1; r++) lines[r].push(k, a[0] + (top + (r + 0.5) * cell - a[1]) * slope, step);
      }
    }
  });

  const spans: Vec2[][] = groups.map(() => []);
  const xs: number[] = [];
  const steps: number[] = [];
  const add = (into: { all: number; visible: number }, list: Vec2[], onFrame: boolean) => {
    list.sort((a, b) => a[0] - b[0]);
    let end = -Infinity;
    for (const [a, b] of list) {
      if (b <= end) continue;
      const from = Math.max(a, end);
      into.all += (b - from) * cell;
      if (onFrame) into.visible += Math.max(0, Math.min(b, w) - Math.max(from, 0)) * cell;
      end = b;
    }
  };
  for (let r = 0; r < rows; r++) {
    const line = lines[r];
    for (const list of spans) list.length = 0;
    for (let i = 0; i < line.length; ) {
      // One polygon's crossings, sorted by x, then its nonzero spans.
      const k = line[i];
      xs.length = 0;
      steps.length = 0;
      for (; i < line.length && line[i] === k; i += 3) {
        let at = xs.length;
        while (at > 0 && xs[at - 1] > line[i + 1]) at--;
        xs.splice(at, 0, line[i + 1]);
        steps.splice(at, 0, line[i + 2]);
      }
      let wind = 0;
      let start = 0;
      for (let m = 0; m < xs.length; m++) {
        if (wind === 0) start = xs[m];
        wind += steps[m];
        if (wind === 0) spans[groupOf[k]].push([start, xs[m]]);
      }
    }
    const y = top + (r + 0.5) * cell;
    const onFrame = y >= 0 && y <= h;
    spans.forEach((list, g) => add(out[g], list, onFrame));
    add(out[groups.length], spans.flat(), onFrame);
  }
  return out;
}

// The area of a polygon inside the w × h frame (Sutherland–Hodgman against
// each side in turn).
function clippedArea(poly: readonly Vec2[], w: number, h: number): number {
  const sides: [number, 0 | 1, 1 | -1][] = [[0, 0, 1], [w, 0, -1], [0, 1, 1], [h, 1, -1]]; // keep sign·(p[axis] − at) ≥ 0
  let pts: Vec2[] = poly.map((p): Vec2 => [p[0], p[1]]);
  for (const [at, axis, sign] of sides) {
    if (!pts.length) return 0;
    const inside = (p: Vec2) => sign * (p[axis] - at) >= 0;
    const cut = (a: Vec2, b: Vec2): Vec2 => {
      const t = (at - a[axis]) / (b[axis] - a[axis]);
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    };
    const out: Vec2[] = [];
    pts.forEach((b, i) => {
      const a = pts[(i + pts.length - 1) % pts.length];
      if (inside(b)) {
        if (!inside(a)) out.push(cut(a, b));
        out.push(b);
      } else if (inside(a)) out.push(cut(a, b));
    });
    pts = out;
  }
  return pts.length >= 3 ? Math.abs(polygonArea(pts)) : 0;
}

// The distance from p to an open polyline.
function distanceToLine(p: Vec2, pts: readonly Vec2[]): number {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const d = sub(pts[i], a);
    const l2 = dot(d, d);
    const t = l2 > 0 ? clamp(dot(sub(p, a), d) / l2, 0, 1) : 0;
    best = Math.min(best, Math.hypot(p[0] - a[0] - d[0] * t, p[1] - a[1] - d[1] * t));
  }
  return best;
}

// The distance from p to a closed polygon's outline (0 inside it).
function distanceTo(p: Vec2, poly: readonly Vec2[]): number {
  let best = Infinity;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j];
    const b = poly[i];
    if ((b[1] > p[1]) !== (a[1] > p[1]) && p[0] < ((a[0] - b[0]) * (p[1] - b[1])) / (a[1] - b[1]) + b[0]) inside = !inside;
    const d = sub(b, a);
    const l2 = dot(d, d);
    const t = l2 > 0 ? clamp(dot(sub(p, a), d) / l2, 0, 1) : 0;
    best = Math.min(best, Math.hypot(p[0] - a[0] - d[0] * t, p[1] - a[1] - d[1] * t));
  }
  return inside ? 0 : best;
}

// The same polygon with its outline pushed out by d: each corner moved along
// its bisector, mitred to at most 2.5 d. This is the splash's rim, drawn
// under the shape itself. (An inset would be the other way round, but it
// turns inside out across the serrations and thin tips, and lands outside.)
// Where a notch is narrower than 2 d its two sides cross in a small loop,
// which only leaves a speck of the notch without rim.
export function outset(poly: readonly Vec2[], d: number): Vec2[] {
  const pos = oriented(poly);
  const n = pos.length;
  return pos.map((b, i) => {
    const a = pos[(i - 1 + n) % n];
    const c = pos[(i + 1) % n];
    const n1 = perp(unit(sub(b, a), [1, 0])); // inward, for a positive outline
    const n2 = perp(unit(sub(c, b), [1, 0]));
    const bis = unit(add(n1, n2), n1);
    return add(b, bis, -Math.min(2.5 * d, d / Math.max(0.3, dot(bis, n1))));
  });
}

// Every outline of a splash with its rim: what it covers on screen.
export const splashCover = (pieces: readonly SplashPiece[], rim: number): Vec2[][] =>
  pieces.flatMap((piece) => piece.parts.flatMap((part) => [part.shape, ...part.teeth].map((poly) => outset(poly, rim))));

function oriented(poly: readonly Vec2[]): readonly Vec2[] {
  return polygonArea(poly) >= 0 ? poly : [...poly].reverse();
}

// A ribbon round a polyline, `width` px across at each point.
function ribbon(points: Vec2[], width: number[]): Vec2[] {
  const n = points.length;
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(n - 1, i + 1)];
    const nrm = perp(unit(sub(b, a), [1, 0]));
    left.push(add(points[i], nrm, width[i] / 2));
    right.push(add(points[i], nrm, -width[i] / 2));
  }
  return [...left, ...right.reverse()];
}

// Fills polygons as one path, so they union (every one turned the same way,
// so the nonzero rule never cuts a hole where two overlap). Straight edges:
// lineTo where the target has it (a canvas does, and fills lines faster),
// otherwise a degenerate quadratic, which is a line.
function fillPolygons(ctx: BrushTarget, polys: readonly Vec2[][], color: string) {
  const shapes = polys.filter((p) => p.length >= 3);
  if (!shapes.length) return;
  const target = ctx as BrushTarget & { lineTo?(x: number, y: number): void };
  const line = typeof target.lineTo === 'function';
  ctx.fillStyle = color;
  ctx.beginPath();
  for (const poly of shapes) {
    const pts = oriented(poly);
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
      if (line) target.lineTo!(pts[i][0], pts[i][1]);
      else ctx.quadraticCurveTo(pts[i][0], pts[i][1], pts[i][0], pts[i][1]);
    }
    ctx.closePath();
  }
  ctx.fill();
}
