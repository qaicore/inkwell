// The impact's camera (impact design §7): an 8 % punch-in from contact that
// eases back out by j 39, and a shake on j 9..18, as the scene comes back from
// the impact frames. It is one affine per output frame, frame px → canvas px,
// that the stack applies to everything it draws. The posters on j 0..8 ignore
// it: the stack draws FrameLayers.poster without the camera.
//   - Zoom: zoomAt(j) (clock.ts) about c_z = mix(frame centre, P, 0.5), which
//     keeps P nearer the frame than a centred punch-in.
//   - Shake: the one layer that moves on every output frame. Jolt n = j − 9
//     moves the scene 0.4·S·SHAKE_REF[n] along the strike axis, toward the
//     striker (−d̂) on even n and away on odd n, plus a seeded sideways part
//     of up to ±20 % of that. The reference's first jolt moves the picture
//     toward the striker (timing R9); 0.4 is its scale for live footage.
//   - Cap: no jolt shows the frame's edge. It is cut down, keeping its
//     direction, to the room the zoom leaves on the side the scene moves away
//     from. c_z sits low when P does, so that room is small below: on the hero,
//     22.4 px below and 64 px above, and the first jolt (up, 42 px) is cut to
//     22.4 px. Design §7's hero figures (42 px whole, then 21 px) take each
//     jolt's room from the side it moves toward: they are the cap for a shake
//     whose first jolt moves the picture away from the striker.
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
  zoom: number; // zoomAt(j)
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

// The camera on frame j (frames since contact): the zoom about c_z, then the
// capped shake. Before contact and from j 39 on it is exactly the identity.
export function cameraAt(j: number, ictx: CameraContext): Camera {
  const { width, height } = ictx;
  const centre = zoomCentre(ictx.frame.P, width, height);
  const zoom = zoomAt(j);
  const offset = capJolt(shakeAt(j, ictx), zoom, centre, width, height);
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
