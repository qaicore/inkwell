// Where the impact frames put things (impact design §5, "Layout"; study
// impact.md §7.2). The strike axes are WP0's strikeFrame (h = −1 in portrait),
// X(a, b) = P + S·(a·u + b·v), and every anchor is jittered ±0.02 S on each
// axis by the 'hud' stream, once per slam, so IF4 and IF5 share one G and the
// small stars and rings stay concentric.
//   - The HUD family (the F crosshair, the G star and cross, S1, S2, ring5,
//     ring7, IF7's small rings and marks, IF6's tan cross and tick) slides back
//     up the strike axis: Δ = clamp(0.18 − u_max, 0, 0.20)·S, u_max being how
//     far P is from the frame edge along +u, in S. Δ is 0.1624 S on the hero
//     and 0 on the reference. An anchor still off the frame after the slide is
//     mirrored across the slid origin along u, then along v, then pulled inside
//     the frame by 0.02 S (the design leaves these cases open: on the hero,
//     IF6's cross and IF7's smallest ring sit below the floor).
//   - The physical family (the tint, shards, spray, disc2, the speed lines,
//     edge spikes, the A6/V6 streaks, the comet, the crater) stays on P. An
//     element whose whole extent is off the frame is mirrored across P along u
//     (WP0's mirrorIntoFrame), one element at a time, as it is drawn.
//   - The HUD is screen-aligned: crosshairs and the star's long, edge-reaching
//     arms run along the frame's short side, vertical in landscape and
//     horizontal in portrait.
import type { Vec2 } from '../../types/effect.ts';
import type { ImpactContext, StrikeFrame } from '../contracts.ts';
import { mirrorIntoFrame } from '../floor.ts';
import { rng, uniform } from '../rng.ts';

const SLIDE_AT = 0.18; // S: the HUD starts sliding when P is nearer the edge than this along +u
const SLIDE_MAX = 0.2; // S: and slides at most this far
const JITTER = 0.02; // S, on each axis
const INSET = 0.02; // S: how far inside the frame a clamped HUD anchor lands

// The physical anchors, as (a, b) about P.
export const PHYSICAL = {
  hot: [-0.15, 0.07], // IF1's tint centre
  disc2: [-0.63, -0.04], // IF2's ink disc
  A6: [0.05, 0.04], // IF6's streak apex
  V6: [0.17, 0.03], // where IF6's streak lines meet
  crater: [0.08, 0.02], // IF7
  scribble1: [-0.05, 0.12], // IF6's two zigzag clusters
  scribble2: [-0.05, -0.12],
} as const satisfies Record<string, readonly [number, number]>;

// The HUD anchors, as (a, b) about the slid origin. S1 and S2 are offsets from G.
export const HUD = {
  F: [-0.05, 0.02], // IF3's focus and crosshair
  G: [-0.08, 0.01], // IF4's star and IF5's cross
  S1: [-0.23, 0.05], // from G: IF4's small star, IF5's ring R1
  S2: [0.21, 0], // from G: IF4's small star, IF5's ring R2
  ring5: [-0.06, 0],
  ring7: [-0.01, 0.06],
  cross6: [0.3, -0.09], // IF6's tan cross; IF7's 0.25 ring with a "+"
  tick6: [-0.41, 0.22], // IF6's tick; IF7's "+"
  ring7c: [-0.45, -0.52], // IF7's 0.17 ring with a "+"
  ring7d: [0.39, 0.64], // IF7's 0.05 ring with the long crosshair
  bar7: [-0.11, -0.25], // IF7's "⊢"
} as const satisfies Record<string, readonly [number, number]>;

export type PhysicalAnchor = keyof typeof PHYSICAL;
export type HudAnchor = keyof typeof HUD;
const PHYSICAL_NAMES = Object.keys(PHYSICAL) as PhysicalAnchor[];
const HUD_NAMES = Object.keys(HUD) as HudAnchor[];

export interface PosterLayout {
  width: number; // frame px
  height: number;
  P: Vec2;
  u: Vec2;
  v: Vec2;
  S: number;
  h: 1 | -1;
  uMax: number; // P's distance to the frame edge along +u, in S
  slide: number; // Δ, px
  O: Vec2; // the HUD's origin: P − Δ·u
  short: Vec2; // the frame's short side on screen: (0, 1) in landscape, (1, 0) in portrait
  long: Vec2; // its long side
  physical: Record<PhysicalAnchor, Vec2>; // frame px
  hud: Record<HudAnchor, Vec2>; // frame px, slid, and on the frame
}

export type LayoutContext = Pick<ImpactContext, 'frame' | 'width' | 'height' | 'seed'>;

// The same strike frame with v on the other side: h = ±1 (the tests and the
// sheet use it to pin the reference's h = +1 or try both).
export function withSide(frame: StrikeFrame, h: 1 | -1): StrikeFrame {
  const [ux, uy] = frame.u;
  return { ...frame, P: [frame.P[0], frame.P[1]], u: [ux, uy], v: [-h * uy, h * ux], h };
}

// The frame's short and long sides as screen directions.
export function screenAxes(width: number, height: number): { short: Vec2; long: Vec2 } {
  return width >= height ? { short: [0, 1], long: [1, 0] } : { short: [1, 0], long: [0, 1] };
}

// How far P + t·dir stays on the w × h frame, in px (0 when P is off it).
export function reach(P: Vec2, dir: Vec2, w: number, h: number): number {
  let t = Infinity;
  if (dir[0] > 1e-12) t = Math.min(t, (w - P[0]) / dir[0]);
  else if (dir[0] < -1e-12) t = Math.min(t, -P[0] / dir[0]);
  if (dir[1] > 1e-12) t = Math.min(t, (h - P[1]) / dir[1]);
  else if (dir[1] < -1e-12) t = Math.min(t, -P[1] / dir[1]);
  return Number.isFinite(t) ? Math.max(0, t) : 0;
}

// The HUD slide: u_max (in S) and Δ (px).
export function hudSlide(P: Vec2, u: Vec2, S: number, width: number, height: number): { uMax: number; slide: number } {
  const uMax = reach(P, u, width, height) / S;
  return { uMax, slide: Math.min(SLIDE_MAX, Math.max(0, SLIDE_AT - uMax)) * S };
}

export function posterLayout(ctx: LayoutContext): PosterLayout {
  const { width, height, seed } = ctx;
  const { P, u, v, S, h } = ctx.frame;
  const { uMax, slide } = hudSlide(P, u, S, width, height);
  const O: Vec2 = [P[0] - slide * u[0], P[1] - slide * u[1]];
  const at = (o: Vec2, a: number, b: number): Vec2 => [o[0] + S * (a * u[0] + b * v[0]), o[1] + S * (a * u[1] + b * v[1])];
  // One jitter per anchor, by its place in the fixed lists (the 'hud' stream's
  // −1 is strikeFrame's choice of h).
  const jitter = (i: number): Vec2 => {
    const r = rng(seed, 'hud', i);
    return [uniform(r, -JITTER, JITTER), uniform(r, -JITTER, JITTER)];
  };
  const physical = {} as Record<PhysicalAnchor, Vec2>;
  PHYSICAL_NAMES.forEach((name, i) => {
    const [ja, jb] = jitter(i);
    physical[name] = at(P, PHYSICAL[name][0] + ja, PHYSICAL[name][1] + jb);
  });
  // (a, b) about O, jitter included; S1 and S2 ride on G's.
  const ab = {} as Record<HudAnchor, Vec2>;
  HUD_NAMES.forEach((name, i) => {
    const [ja, jb] = jitter(100 + i);
    ab[name] = [HUD[name][0] + ja, HUD[name][1] + jb];
  });
  for (const name of ['S1', 'S2'] as const) ab[name] = [ab[name][0] + ab.G[0], ab[name][1] + ab.G[1]];
  const hud = {} as Record<HudAnchor, Vec2>;
  for (const name of HUD_NAMES) hud[name] = onFrame(ab[name], (a, b) => at(O, a, b), width, height, INSET * S);
  return { width, height, P: [P[0], P[1]], u: [u[0], u[1]], v: [v[0], v[1]], S, h, uMax, slide, O, ...screenAxes(width, height), physical, hud };
}

// An anchor that is off the frame tries its mirrors (a, then b, then both);
// failing those, the least-off one is pulled `inset` inside the edge.
function onFrame([a, b]: Vec2, place: (a: number, b: number) => Vec2, w: number, h: number, inset: number): Vec2 {
  const tries = [place(a, b), place(-a, b), place(a, -b), place(-a, -b)];
  const off = ([x, y]: Vec2) => Math.max(0, -x, x - w) + Math.max(0, -y, y - h);
  const fit = tries.find((p) => off(p) === 0);
  if (fit) return fit;
  const best = tries.reduce((m, p) => (off(p) < off(m) ? p : m));
  return [Math.min(w - inset, Math.max(inset, best[0])), Math.min(h - inset, Math.max(inset, best[1]))];
}

// A physical element, placed: mirrored across P along u when its whole extent
// is off the frame. `closed` counts the edge from the last point to the first.
export function placePhysical(L: PosterLayout, points: Vec2[], closed = true): Vec2[] {
  const path = closed && points.length > 2 ? [...points, points[0]] : points;
  const { points: placed, mirrored } = mirrorIntoFrame(path, L.P, L.u, L.width, L.height);
  if (!mirrored) return points;
  return closed && points.length > 2 ? placed.slice(0, -1) : placed;
}

// X(a, b) about P (physical) and about the slid origin (HUD), in frame px.
export const physicalAt = (L: PosterLayout, a: number, b: number): Vec2 => [L.P[0] + L.S * (a * L.u[0] + b * L.v[0]), L.P[1] + L.S * (a * L.u[1] + b * L.v[1])];
export const hudAt = (L: PosterLayout, a: number, b: number): Vec2 => [L.O[0] + L.S * (a * L.u[0] + b * L.v[0]), L.O[1] + L.S * (a * L.u[1] + b * L.v[1])];
