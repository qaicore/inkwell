// The impact's camera (impact design §7): a 4 % pull-back over the charge, an
// 8 % punch-in from contact that eases back out by j 39, and a shake on
// j 9..18, as the scene comes back from the impact frames. It is one affine
// per output frame, frame px → canvas px, that the stack applies to
// everything it draws. The posters on j 0..8 ignore it: the stack draws
// FrameLayers.poster without the camera.
//   - Pull-back: the reference's content shrinks by 4 % over the charge
//     (k1 0.995 to k5 0.957, breakdown phase 2). Footage has nothing outside
//     the frame to pull back to, so the camera creeps in to 1.04 over the coil
//     (j −14..−7) and eases back out to 1 by S5 (j −2): the same 4 % pull,
//     never an edge. S6 (j −1) is at 1, and contact punches to 1.08.
//   - Zoom: zoomAt(j) (clock.ts) about c_z = mix(frame centre, P, 0.5), which
//     keeps P nearer the frame than a centred punch-in; the pull-back is
//     about c_z too.
//   - Shake: the one layer that moves on every output frame. Jolt n = j − 9
//     moves the scene 0.4·S·SHAKE_REF[n] along the strike axis, toward the
//     striker (−d̂) on even n and away on odd n, plus a seeded sideways part
//     of up to ±20 % of that. The reference's first jolt moves the picture
//     toward the striker (timing R9) and is the biggest; 0.4 is its scale
//     for live footage.
//   - Cap: no jolt shows the frame's edge. Each jolt fits in the room the
//     zoom leaves on the side the scene moves away from, and the whole
//     envelope is cut by one factor, the smallest any jolt needs, so the
//     jolts keep the reference's 0.098 : 0.066 : 0.036 … and the first stays
//     the biggest. c_z sits low when P does, so the room is small below: on
//     the hero, 22.4 px below and 64 px above at 1.08, so the first jolt (up,
//     42 px) and with it the whole envelope is cut to 0.53 of itself (22.4,
//     15.1, 8.2 px …). Cutting each jolt alone (round 2) left the second
//     (down, 28.5 px) bigger than the first.
// j counts the scene's frames since contact, so under the slow replay (ladder
// step 4) it is the clip frame's j (freezeMap), not the output frame's.
import type { Vec2 } from '../types/effect.ts';
import type { ImpactContext, StrikeFrame } from './contracts.ts';
import { zoomAt } from './clock.ts';
import { rng, uniform } from './rng.ts';

export const SHAKE_FROM = 9; // the first jolt's j: the scene's first frame back from the posters
// × S: the reference's shake (timing R9), resampled to 30 fps, one jolt per output frame.
export const SHAKE_REF: readonly number[] = [0.098, 0.066, 0.036, 0.023, 0.017, 0.009, 0.011, 0.014, 0.016, 0.012];
export const SHAKE_SCALE = 0.4; // live footage takes 0.4 of a drawn background's shake
export const SHAKE_LATERAL = 0.2; // the seeded sideways part, up to ± this share of the jolt
// The pull-back over the charge: in to 1 + PULL over the coil, out to 1 by S5.
export const PULL = 0.04;
export const PULL_J = { from: -14, peak: -7, out: -2 } as const; // the coil's first frame, S1, S5

// ctx.setTransform's six numbers: x' = a·x + c·y + e, y' = b·x + d·y + f.
export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface Camera extends Affine {
  zoom: number; // cameraZoom(j)
  centre: Vec2; // c_z, frame px: the point the zoom holds still
  offset: Vec2; // the shake after the cap: how far the scene moves on the canvas, px
}

// What the camera reads from the impact. A whole ImpactContext will do.
export type CameraContext = Pick<ImpactContext, 'width' | 'height' | 'seed'> & { frame: Pick<StrikeFrame, 'P' | 'u' | 'S'> };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// c_z = mix(frame centre, P, 0.5), kept on the canvas, so that the zoom alone
// always covers it (only a P more than half a frame off it could pull c_z off).
export function zoomCentre(P: Vec2, width: number, height: number): Vec2 {
  return [clamp((width / 2 + P[0]) / 2, 0, width), clamp((height / 2 + P[1]) / 2, 0, height)];
}

// The zoom on frame j: the pull-back before contact (1 outside j −14..−2, so
// S6's swell is unzoomed), zoomAt(j) from contact on.
export function cameraZoom(j: number): number {
  if (j >= 0) return zoomAt(j);
  if (j <= PULL_J.from || j >= PULL_J.out) return 1;
  if (j <= PULL_J.peak) {
    const t = (j - PULL_J.from) / (PULL_J.peak - PULL_J.from);
    return 1 + PULL * t * t * (3 - 2 * t); // creeping in through the coil
  }
  const t = (PULL_J.out - j) / (PULL_J.out - PULL_J.peak);
  return 1 + PULL * t * t; // out fast from the landing, settling by S5
}

// Frame j's jolt before the cap, frame px; nothing off j 9..18.
export function shakeAt(j: number, ictx: CameraContext): Vec2 {
  if (!Number.isInteger(j)) throw new Error(`the camera takes whole frames since contact (got j=${j})`);
  const n = j - SHAKE_FROM;
  if (n < 0 || n >= SHAKE_REF.length) return [0, 0];
  const { u, S } = ictx.frame;
  const len = Math.hypot(u[0], u[1]);
  const [ux, uy] = len > 0 ? [u[0] / len, u[1] / len] : [0, 1]; // straight down without a direction, as strikeFrame does
  const size = SHAKE_SCALE * S * SHAKE_REF[n];
  const along = n % 2 === 0 ? -size : size; // along d̂: − is toward the striker
  const side = size * uniform(rng(ictx.seed, 'shake', j), -SHAKE_LATERAL, SHAKE_LATERAL); // along (−u_y, u_x)
  return [along * ux - side * uy, along * uy + side * ux];
}

// Jolt o, cut down with its direction kept until the frame, zoomed about
// `centre`, still covers the canvas. The zoomed frame overhangs each canvas
// edge by (zoom − 1) × c_z's distance to that edge, and that overhang is how
// far the scene can move away from the edge: right as far as it overhangs the
// left edge, up as far as it overhangs the bottom one.
export function capJolt(o: Vec2, zoom: number, centre: Vec2, width: number, height: number): Vec2 {
  const over = zoom - 1;
  let scale = 1;
  if (o[0] !== 0) scale = Math.min(scale, (over * (o[0] > 0 ? centre[0] : width - centre[0])) / Math.abs(o[0]));
  if (o[1] !== 0) scale = Math.min(scale, (over * (o[1] > 0 ? centre[1] : height - centre[1])) / Math.abs(o[1]));
  scale = Math.max(0, scale);
  return [o[0] * scale, o[1] * scale];
}

// The share of itself every jolt keeps: the least that any jolt of the
// envelope keeps under capJolt at its own frame's zoom. One factor for the
// whole shake, so its shape, first jolt biggest, survives the cap.
export function shakeKeep(ictx: CameraContext): number {
  const { width, height } = ictx;
  const centre = zoomCentre(ictx.frame.P, width, height);
  let keep = 1;
  for (let n = 0; n < SHAKE_REF.length; n++) {
    const j = SHAKE_FROM + n;
    const o = shakeAt(j, ictx);
    const len = Math.hypot(o[0], o[1]);
    if (!(len > 0)) continue;
    const fit = capJolt(o, cameraZoom(j), centre, width, height);
    keep = Math.min(keep, Math.hypot(fit[0], fit[1]) / len);
  }
  return keep;
}

// The camera on frame j (frames since contact): the zoom about c_z, then the
// capped shake. Before j −14, on S6 (j −1) and from j 39 on it is exactly the
// identity.
export function cameraAt(j: number, ictx: CameraContext): Camera {
  const { width, height } = ictx;
  const centre = zoomCentre(ictx.frame.P, width, height);
  const zoom = cameraZoom(j);
  const jolt = shakeAt(j, ictx);
  const keep = jolt[0] === 0 && jolt[1] === 0 ? 1 : shakeKeep(ictx);
  const offset: Vec2 = [jolt[0] * keep, jolt[1] * keep];
  return { a: zoom, b: 0, c: 0, d: zoom, e: centre[0] * (1 - zoom) + offset[0], f: centre[1] * (1 - zoom) + offset[1], zoom, centre, offset };
}

// Where frame point p lands on the canvas.
export function mapPoint(m: Affine, p: Vec2): Vec2 {
  return [m.a * p[0] + m.c * p[1] + m.e, m.b * p[0] + m.d * p[1] + m.f];
}

// outer ∘ inner: inner applies first. A canvas that already carries a view
// transform (the preview's frame-to-screen scale) takes
// composeAffine(view, camera), since setTransform replaces what is there.
export function composeAffine(outer: Affine, inner: Affine): Affine {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f,
  };
}
