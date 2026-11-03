// EXPERIMENT (exp/hero-3d-lift): lift a stroke drawn on one frame onto the
// 3D body stand-in, simulate it in 3D, and hand back 2D drawings on 2s.
//
// Lifting (the depth rule): the root goes on the torso's back surface. The
// rest of the stroke lies on a curved sheet behind him, like a satellite dish
// bolted to his back and facing away: the farther a point is from the root on
// the drawing, the deeper it sits behind him (SLOPE per torso height, plus
// CURVE for the dish's curl). Each point keeps exactly where it was drawn on
// the drawing frame, so frame `drawn` looks the same as before.
//
// The frame loop is animate()'s (SPEC §8.1) with the chain in 3D:
//   1. step the 3D chains to f/30, targets from the interpolated body (the
//      rope's drive, below), colliding with his dummy (collide.ts) when
//      there is one;
//   2. when the drawing index k changes, capture a drawing: project the chain
//      to the screen (a free strand that would look straighter than
//      ROPE.least is drawn bowed the way it bends: never a rod), store it in
//      2D torso space plus boil(k), and note per point whether it's in front
//      of his body (his dummy's, when there is one) and how deep it is;
//   3. place the held drawing with this frame's 2D torso transform.
// So the shape and the layer change only on drawings (on 2s), the way a
// hand-drawn turn is drawn, while the placement follows him every frame.
//
// The rope's drive (decision 15): a limb moves like a heavy rope or a
// tentacle, never as one stiff piece. Its target is the lifted drawing, but
//   - dragged: each node takes up the body's turn, bend and lean through a
//     spring of its own (damping ratio ROPE.follow), quick at the root
//     (rootHz) and slow at the tip (tipHz), so the root leads, the tip trails
//     its turns by a few drawings, and when he stops the tip swings on past
//     and settles back in a smaller swing or two;
//   - undulating: a slow bend wave runs from root to tip, growing toward the
//     tip, in the screen plane and toward the camera, its phase seeded per
//     limb, so a limb's own curve changes from drawing to drawing even while
//     he stands still;
//   - never straight: a target that would look straighter than ROPE.bow on
//     screen (seen edge-on, as when he bends double, his back's dish faces up
//     and a drawn curve is a line) is bowed on screen to ROPE.bow, the way
//     the drawing bows (strike.ts's bowedOnScreen), mirrored while he faces
//     away from the way he was drawn.
// The chain keeps the target's bends as a tentacle keeps its curl
// (strand3d.ts), so it takes up the drag, the wave and the bow without being
// pulled to the target as one piece. A rigid stroke keeps the drawing as it is.
//
// For the impact (design §2, §4):
//   - each chain starts on the first frame of its stroke's emergence drawing,
//     resting on that frame's body. Before that the stroke isn't there;
//   - a strike controller's orders apply on every physics step (strand3d.ts);
//   - with a controller, a drawing is captured on every frame from the whip's
//     first (strike.ts whipFrom: land − 2) to the release, so a pinned tip is
//     exact on every frame, and the release forces a new drawing. A limb
//     whose tip is pinned at the frame's end is
//     captured without boil, so its tip sits exactly on the pin (the strike
//     redraws it 15 times a second anyway, design §4 "Clock").
//     Every frame is marked with what the limbs show (clock.ts).
import type { Vec2 } from '../types/effect.ts';
import type { HeldLimb, StrikeController } from '../impact/contracts.ts';
import { limbDrawingAt, type LimbDrawing } from '../impact/clock.ts';
import { rng, uniform } from '../impact/rng.ts';
import type { PhysicsParams } from '../physics/strand.ts';
import { boilOffsets, type BoilParams } from '../motion/boil.ts';
import { drawingIndex } from '../motion/timing.ts';
import { offsetToTorso, toPixels, toTorso } from '../track/torso.ts';
import { backDepth, flat, inFront, lerpBody, project, toBody, toCamera, unproject, type Body3D, type Vec3 } from './body.ts';
import { collideChain, frontFlags, insideDepth, lerpDummy, routeAround, scanPush, type Dummy } from './collide.ts';
import { createChain3, ROPE3D, stepChain3, type Chain3, type Contact } from './strand3d.ts';
import { bowedOnScreen, bulgeSide, floorHeight, sagittaRatio, whipFrom, type LimbStep, type Strike } from './strike.ts';
import { radiusAt, ROOT_FLARE } from './tube.ts';

// The dish: SLOPE and CURVE per torso height from the root, and by the root it
// curls out of his back, `exit` deeper over the first `exitSpan` (a smoothstep),
// so a limb grows out of him before it follows his back: side on or bent
// double, the stretch by the root otherwise lies along his back, over his
// outline, and could only clear him with a dive through him (decision 17).
export const SHEET = { slope: 0.3, curve: 0.08, exit: 0.1, exitSpan: 0.16 };
const SKIN = 0.03; // the root sits this far off his back, so it's never inside the torso

// The rope's drive (decision 15).
export const ROPE = {
  rootHz: 6, // a node at the root takes up the body's turn this fast (its spring's natural frequency) ...
  tipHz: 0.8, // ... the tip this slowly, and the nodes between on (1 − t)² of the way
  follow: 0.5, // the springs' damping ratio: the tip overshoots a stopped turn by about a sixth and swings back
  // The bend wave: a standing limb's own curve changes 1–12° a joint between
  // drawings (decision 19(b)), a rope's undulation running down it: over 1.2
  // limb lengths at 0.42 Hz it was 0.5°, frozen under the boil. Shorter and
  // quicker, not wider: a wider swing takes the coiling limbs into him.
  waveDeg: 22, // the bend wave's turn at the tip, in the screen plane ...
  depthDeg: 9, // ... and toward the camera
  waveHz: 0.8,
  depthHz: 0.29,
  waveLength: 0.8, // limb lengths one wave spans
  grow: 1, // the wave grows as t^grow toward the tip
  bow: 0.16, // the least sagitta over chord the target shows on screen: the chain, swinging, keeps over a third of it
  least: 0.07, // the least sagitta over chord a drawing of it shows (decision 15's 0.06, and room for the boil)
};
export const LIMB_RADIUS = 0.02; // × the clip's short side: the limb's root radius when none is given (decision 8's R0)

export interface Lifted {
  id: number;
  points: Vec3[]; // body units
  pressure: number[];
  kind: 'strand' | 'rigid';
  stiffness: number;
  wobble: number;
  length: number; // px: the stroke's length as drawn
  drawn?: number; // torso units: that length over the torso height it was drawn at (missing: the lifted length)
}

// `px`: the stroke in screen px on the drawing frame, root first.
export function liftStroke(id: number, px: Vec2[], pressure: number[], body: Body3D, kind: Lifted['kind'], stiffness: number, wobble = 1, sheet: { slope: number; curve: number; exit?: number; exitSpan?: number } = SHEET): Lifted {
  const t = flat(body);
  const flatPts = px.map((p) => toTorso(t, p));
  const [rx, ry] = flatPts[0];
  const rootZ = backDepth(rx, ry) - SKIN;
  const out = (r: number) => (sheet.exit && sheet.exitSpan ? sheet.exit * smoothstep(r / sheet.exitSpan) : 0);
  const points = px.map((p, i): Vec3 => {
    const [x, y] = flatPts[i];
    const r = Math.hypot(x - rx, y - ry);
    const z = (rootZ - sheet.slope * r - sheet.curve * r * r - out(r)) * body.unit;
    // This depth, seen through this frame's camera, must land where he drew it.
    return toBody(body, unproject(body, p, z));
  });
  let length = 0;
  for (let i = 1; i < px.length; i++) length += Math.hypot(px[i][0] - px[i - 1][0], px[i][1] - px[i - 1][1]);
  return { id, points, pressure, kind, stiffness, wobble, length, drawn: length / body.unit };
}

// A placed drawing: the limb the way the tube takes it (impact/contracts.ts), plus its depth.
export interface Placed3D extends HeldLimb {
  depth: number; // mean camera z, px, for drawing order (far first)
}

export interface Frame3D {
  f: number;
  k: number;
  capture: number; // which held drawing is placed: 0, 1, 2, … in capture order
  drawing: LimbDrawing; // what the limbs show on this frame; 'grid' without a controller or a slam
  placed: Placed3D[];
  sim: { id: number; points: Vec3[] }[]; // the chains themselves, camera px, no boil
}

export interface Animate3DOptions {
  strokes: Lifted[];
  bodies: Body3D[]; // one per frame
  frames: number;
  dps: number;
  boil: BoilParams;
  width: number;
  physics?: PhysicsParams;
  fps?: number;
  emerge?: ReadonlyMap<number, number>; // stroke id → the frame it emerges on; missing = there from frame 0
  control?: StrikeController; // the strike hook
  slam?: { I: number; posters: boolean }; // the contact frame, to mark the poster frames
  dummies?: readonly Dummy[] | null; // his body on every frame (collide.ts): the limbs collide with it and take their front flags from it; missing = the egg's flags, no collisions
  radius?: number; // the limb's root radius before the flare, clip px (the tube's R0); missing = LIMB_RADIUS × the short side of a 16:9 clip
  height?: number; // the clip's height, px (the floor's bottom edge); missing = a 16:9 clip's
  floor?: { P: Vec2; d: Vec2 } | null; // the slam's floor line (through P, normal d̂ down into it); missing = the controller's (strike.ts Strike), if it has one
}

// One stroke's drive: each node's spring-followed turn, bend and lean, and its wave phases.
interface Drive {
  frac: number[]; // arc fractions of the drawing
  hz: number[]; // each node's follow frequency
  angle: Float64Array; // per node: yaw, pitch, roll
  speed: Float64Array;
  phase: [number, number];
  side: 1 | -1; // the way the drawing bows in his own frame (bulgeSide)
  radii: number[]; // the limb's radius at each node, px
  from: number; // the first node that collides
}

interface Held {
  id: number;
  points: Vec2[]; // 2D torso space, boil included
  z: number[]; // torso units, so the depth scales with him like the points
  pressure: number[];
  front: boolean[];
  depth: number;
  length: number;
}

export function animate3d(opts: Animate3DOptions): Frame3D[] {
  const params = opts.physics ?? ROPE3D;
  const fps = opts.fps ?? 30;
  const steps = Math.round(1 / (fps * params.dt));
  const { control } = opts;
  const strike = control ? { land: control.land, release: control.release } : undefined;
  const drawingAt = (f: number): LimbDrawing => {
    if (opts.slam) return limbDrawingAt(f, opts.slam.I, strike, opts.slam.posters);
    return strike ? limbDrawingAt(f, 0, strike, false) : 'grid';
  };
  const R0 = opts.radius ?? LIMB_RADIUS * opts.width * (9 / 16);
  const drives = opts.strokes.map((s) => driveOf(s, R0));
  // The slam's floor (decision 19(e)): from the release on, a struck limb's
  // drawings stay above the floor line through P and inside the frame's
  // bottom edge (onScreenAbove; the controller keeps its throw above it, and
  // placeOn's routing then takes the drawing round him in depth). The chain
  // itself isn't pushed up: lifted after its collisions, it went into him.
  const floor = opts.floor !== undefined ? opts.floor : control && 'floor' in control ? (control as Strike).floor : null;
  const bottom = opts.height ?? opts.width * (9 / 16);
  const dummies = opts.dummies && opts.dummies.length >= opts.frames ? opts.dummies : null;
  // Each strand's root out of his scanned body on every frame (rootShifts).
  const shifts = opts.strokes.map((s) => (dummies && s.kind === 'strand' ? rootShifts(s, opts.bodies, dummies, opts.frames) : null));
  // The drawing dragged and undulating at `time` s, its root out of him `w`
  // of the way from frame f − 1's place to frame f's (a rigid stroke as drawn).
  // From the release on, a struck limb's drawing is turned toward the screen
  // as far as it takes to show FACE of its length there (faceCamera): bent
  // over his fist, his back is nearly edge-on to the camera, and the limbs
  // lying on it would be drawn half as long as they are (decision 15(f)).
  const target = (s: Lifted, j: number, b: Body3D, time: number, f: number, w = 1) => {
    if (s.kind === 'rigid') return s.points.map((q) => toCamera(b, q));
    const raw = driven(s, drives[j], b, time);
    const pts = strike && f >= strike.release && struck[j] ? faceCamera(raw, FACE) : raw;
    const sh = shifts[j];
    if (!sh) return pts;
    const [a, c] = [sh[Math.max(0, f - 1)], sh[f]];
    const by: Vec3 = [a[0] + (c[0] - a[0]) * w, a[1] + (c[1] - a[1]) * w, a[2] + (c[2] - a[2]) * w];
    return pts.map((p): Vec3 => [p[0] + by[0], p[1] + by[1], p[2] + by[2]]);
  };
  // The first frame of each stroke's emergence drawing.
  const born = opts.strokes.map((s) => {
    const emerge = opts.emerge?.get(s.id);
    if (emerge === undefined) return 0;
    let f = Math.max(0, emerge);
    const k = drawingIndex(f, opts.dps, fps);
    while (f > 0 && drawingIndex(f - 1, opts.dps, fps) === k) f--;
    return f;
  });
  const chains: (Chain3 | null)[] = opts.strokes.map(() => null);
  // Each stroke's drawn length over its lifted one (torso units both), and
  // whether the controller has given it orders (it is one of the limbs).
  const struck = opts.strokes.map(() => false);
  const share = opts.strokes.map((s) => {
    const lifted = s.points.slice(1).reduce((sum, q, i) => sum + dist3(s.points[i], q), 0);
    return s.drawn !== undefined && lifted > 0 ? Math.min(1, s.drawn / lifted) : 1;
  });
  const pinned = opts.strokes.map(() => false); // the tip was pinned on the frame's last step

  // A held drawing placed on frame f's body. A strand is kept out of his
  // body there by its depth alone (routeAround: on screen it stays as drawn,
  // on 2s), from past its root's flare, and takes its front flags and its
  // depth from where that leaves it: a drawing held over a frame he moves on
  // goes behind or in front of him there, never through him (decisions 17
  // and 18). The flare is measured along the curve as it ends up, and the
  // curve routed again while any of it past there is still in him (a
  // routing eases its depth changes along the curve, which can leave a
  // point by the flare a little in him, on the steep edge of a part). Its
  // root's own segment, where the flare ends on it, is kept clear past the
  // flare as the root is (ROOT_CLEAR), not by the routing's margin.
  const kinds = new Map(opts.strokes.map((s) => [s.id, s.kind]));
  const placeOn = (h: Held, f: number): Placed3D => {
    const b = opts.bodies[f];
    const t = flat(b);
    const up = floor && strike && f >= strike.release && struck[opts.strokes.findIndex((s) => s.id === h.id)];
    const points = h.points.map((p, i) => (up && i > 0 ? onScreenAbove(toPixels(t, p), floor, bottom) : toPixels(t, p)));
    const z = h.z.map((v) => v * t.unit);
    if (!dummies || kinds.get(h.id) !== 'strand') return { ...h, points, z };
    let pts = points.map((xy, i) => unproject(b, xy, z[i]));
    const none = pts.map(() => 0);
    let from = pts.length;
    for (let round = 0; round < ROUTE_TRIES; round++) {
      const flare = flareEnd(pts, R0);
      if (flare >= from && !inPastFlare(dummies[f], pts, R0)) break;
      from = Math.min(from, flare);
      pts = routeAround(dummies[f], pts, none, from, undefined, (1 + ROOT_FLARE) * R0, ROOT_CLEAR);
    }
    return { ...h, points, z: pts.map((p) => p[2]), front: frontFlags(dummies[f], pts), depth: pts.reduce((sum, p) => sum + p[2], 0) / pts.length };
  };

  const out: Frame3D[] = [];
  let held: Held[] = [];
  let lastK = -1;
  let capture = -1;
  for (let f = 0; f < opts.frames; f++) {
    if (f > 0) {
      for (let i = 1; i <= steps; i++) {
        const b = lerpBody(opts.bodies[f - 1], opts.bodies[f], i / steps);
        const dummy = dummies ? lerpDummy(dummies[f - 1], dummies[f], i / steps) : null;
        const time = (f - 1 + i / steps) / fps;
        const live = opts.strokes.flatMap((s, j) => {
          const chain = chains[j];
          if (!chain) return [];
          follow(drives[j], b, params.dt);
          return [{ s, j, chain, target: target(s, j, b, time, f, i / steps) }];
        });
        const orders = control
          ? control.step({ f, sub: i, steps, body: b, limbs: live.map(({ s, chain, target }): LimbStep => ({ id: s.id, points: [...chain.points], target, stiffness: s.stiffness, drawn: s.drawn === undefined ? undefined : s.drawn * b.unit })) })
          : [];
        live.forEach(({ s, j, chain, target }, l) => {
          // From the release on, a struck strand is as long as it was drawn (decision
          // 15: the lift's depth made it longer), the controller's orders
          // while it eases out, its own share after.
          // Its target then bowed on screen as its drawings are (neverStraight),
          // so the rope curls in the physics too, not only where it is drawn.
          if (orders[l]) struck[j] = true;
          const order = orders[l] ?? (strike && f >= strike.release && struck[j] ? { restScale: share[j], target: neverStraight(b, target, drives[j].frac) } : null);
          const contact: Contact | null = dummy && s.kind === 'strand' ? { dummy, radii: drives[j].radii, from: drives[j].from } : null;
          stepChain3(chain, target, b.unit, params, order, contact);
          // Nailed to P: a pin from the landing to the release (from the
          // release on the controller lays the thrown rope on its own tip,
          // which is drawn as a free strand's).
          pinned[j] = !!order?.pin && !(strike && f >= strike.release);
        });
      }
    }
    opts.strokes.forEach((s, j) => {
      if (chains[j] || born[j] > f) return;
      settle(drives[j], opts.bodies[f]);
      const chain = createChain3(target(s, j, opts.bodies[f], f / fps, f), s.kind, s.stiffness);
      if (dummies && s.kind === 'strand') collideChain(dummies[f], chain.points, chain.prev, drives[j].radii, drives[j].from, chain.points.length, 1, chain.clear, false, true, false);
      chains[j] = chain;
    });
    const k = drawingIndex(f, opts.dps, fps);
    // Every frame from the whip's first (whipFrom: the inner half comes over
    // first, the tip onto P on land) to the release; on 2s everywhere else.
    if (k !== lastK || (strike && f >= whipFrom(strike) && f <= strike.release)) {
      lastK = k;
      capture++;
      const b = opts.bodies[f];
      const t = flat(b);
      held = opts.strokes.flatMap((s, j): Held[] => {
        const chain = chains[j];
        if (!chain) return [];
        // Never drawn straight (decision 15): a free strand that would look
        // straighter than ROPE.least on screen is drawn bowed the way it bends.
        // A whip's laid curve is pinned to its own tip before the landing,
        // and drawn bowed too: only the pinned rope on P is drawn as it is.
        const free = !pinned[j] || (strike !== undefined && f < strike.land);
        const pts = s.kind === 'strand' && free ? neverStraight(b, chain.points, drives[j].frac) : chain.points;
        const boil = pinned[j] ? null : boilOffsets(k, s.id, pts.length, opts.boil, s.wobble, opts.width);
        const seen = pts.map((p) => project(b, p));
        return [
          {
            id: s.id,
            points: easeJoints(
              easeJoints(
                easeJoints(
                  seen.map(({ xy }, i): Vec2 => {
                    const [x, y] = toTorso(t, xy);
                    if (!boil) return [x, y];
                    const [bx, by] = offsetToTorso(t, boil[i]);
                    return [x + bx, y + by];
                  }),
                  JOINT_FREE,
                ),
                JOINT,
                pinned[j],
              ),
              JOINT_CAP,
              true,
            ),
            z: pts.map((p) => p[2] / b.unit),
            // Nearer is a little wider, so depth reads in the line itself.
            pressure: s.pressure.map((p, i) => Math.min(1, p * seen[i].near)),
            front: dummies ? frontFlags(dummies[f], pts) : pts.map((p) => inFront(b, p)),
            depth: pts.reduce((sum, p) => sum + p[2], 0) / pts.length,
            length: s.length,
          },
        ];
      });
    }
    out.push({
      f,
      k,
      capture,
      drawing: drawingAt(f),
      placed: held.map((h) => placeOn(h, f)),
      sim: opts.strokes.flatMap((s, j) => {
        const chain = chains[j];
        return chain ? [{ id: s.id, points: chain.points.map((p): Vec3 => [p[0], p[1], p[2]]) }] : [];
      }),
    });
  }
  return out;
}

// The first node at least the flared root's radius from the root along the curve (or its length).
function flareEnd(pts: readonly Vec3[], R0: number): number {
  let along = 0;
  for (let i = 1; i < pts.length; i++) {
    along += dist3(pts[i - 1], pts[i]);
    if (along >= (1 + ROOT_FLARE) * R0) return i;
  }
  return pts.length;
}

// Is any of the curve past its flared root (the point the flare ends at, and
// eighths of each segment and its tip on from there) more than ROUTE_SLACK in him?
function inPastFlare(d: Dummy, pts: readonly Vec3[], R0: number): boolean {
  const flare = (1 + ROOT_FLARE) * R0;
  let along = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const l = dist3(pts[i], pts[i + 1]);
    const at = (t: number): Vec3 => [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t, pts[i][2] + (pts[i + 1][2] - pts[i][2]) * t];
    if (along < flare && along + l >= flare && insideDepth(d, at((flare - along) / l)) > ROUTE_SLACK) return true;
    for (let k = 0; k < 8; k++) if (along + (l * k) / 8 >= flare && insideDepth(d, at(k / 8)) > ROUTE_SLACK) return true;
    along += l;
  }
  return along >= flare && insideDepth(d, pts[pts.length - 1]) > ROUTE_SLACK;
}
const ROUTE_TRIES = 3; // routings of a held drawing at most
const ROUTE_SLACK = 0.5; // px a point past the flare may be in him without routing the drawing again

// How far a strand's root goes out of his scanned body on each frame (camera
// px; decision 18): the egg's back is where it grows from, but his mask stands
// out past the egg (clothes, his hair, an arm across his back seen side on,
// his back's edge bent double), and a root left inside buries the stretch by
// it, which then has to dive through him to come clear. The shortest way out
// (scanPush), smoothed over ±ROOT_SMOOTH frames so his mask's edge doesn't
// shake it, and pushed on out (ROOT_CLEAR px clear) on a frame the smoothing
// left it in; the whole target goes with it, so its shape holds.
function rootShifts(s: Lifted, bodies: readonly Body3D[], dummies: readonly Dummy[], frames: number): Vec3[] {
  const at = (f: number) => toCamera(bodies[f], s.points[0]);
  const raw = Array.from({ length: frames }, (_, f): Vec3 => {
    const scan = dummies[f].scan;
    const p = at(f);
    const hit = scan ? scanPush(scan, p, ROOT_CLEAR) : null;
    return hit ? sub3(hit.out, p) : [0, 0, 0];
  });
  return raw.map((_, f): Vec3 => {
    const sum: Vec3 = [0, 0, 0];
    let n = 0;
    for (let g = Math.max(0, f - ROOT_SMOOTH); g <= Math.min(frames - 1, f + ROOT_SMOOTH); g++, n++) for (let k = 0; k < 3; k++) sum[k] += raw[g][k];
    const by: Vec3 = [sum[0] / n, sum[1] / n, sum[2] / n];
    const scan = dummies[f].scan;
    const p = at(f);
    const q: Vec3 = [p[0] + by[0], p[1] + by[1], p[2] + by[2]];
    const hit = scan ? scanPush(scan, q, ROOT_CLEAR) : null;
    return hit ? sub3(hit.out, p) : by;
  });
}
const ROOT_SMOOTH = 2;
const ROOT_CLEAR = 2; // px

// A screen point kept FLOOR_PAD px above the floor line (lifted straight up
// −d̂, eased in as floorHeight has it, so the line rounds off on it instead
// of folding flat) and above the frame's bottom edge.
function onScreenAbove(xy: Vec2, floor: { P: Vec2; d: Vec2 }, bottom: number): Vec2 {
  const { P, d } = floor;
  const up = -((xy[0] - P[0]) * d[0] + (xy[1] - P[1]) * d[1]);
  const lift = floorHeight(up, FLOOR_PAD) - up;
  const [x, y] = lift > 1e-3 ? [xy[0] - d[0] * lift, xy[1] - d[1] * lift] : xy;
  return [x, Math.min(y, bottom - FLOOR_PAD)];
}

const FLOOR_PAD = 2; // px

// ---- The rope's drive ----------------------------------------------------------------------

function driveOf(s: Lifted, R0: number): Drive {
  const n = s.points.length;
  const along = [0];
  for (let i = 1; i < n; i++) along.push(along[i - 1] + dist3(s.points[i - 1], s.points[i]));
  const total = along[n - 1];
  const frac = along.map((a, i) => (total > 0 ? a / total : i / Math.max(1, n - 1)));
  const r = rng(s.id, 'rope wave');
  // The nodes within the flared root's radius of it grow out of his back.
  const from = frac.findIndex((t) => t * s.length >= (1 + ROOT_FLARE) * R0);
  return {
    frac,
    hz: frac.map((t) => ROPE.tipHz + (ROPE.rootHz - ROPE.tipHz) * (1 - t) ** 2),
    angle: new Float64Array(3 * n),
    speed: new Float64Array(3 * n),
    phase: [uniform(r, 0, 2 * Math.PI), uniform(r, 0, 2 * Math.PI)],
    side: bulgeSide(s.points.map((q): Vec2 => [q[0], q[1]])),
    radii: frac.map((t, i) => radiusAt(t, s.pressure[i] ?? 1, R0)),
    from: from < 0 ? n : Math.max(1, from),
  };
}

// Every node at rest at the body's turn, bend and lean: where a chain starts.
function settle(d: Drive, b: Body3D) {
  for (let i = 0; i < d.frac.length; i++) {
    d.angle.set([b.yaw, b.pitch, b.roll], 3 * i);
    d.speed.fill(0, 3 * i, 3 * i + 3);
  }
}

// One step of each node's spring toward the body's turn, bend and lean
// (semi-implicit Euler; the lean the short way round).
function follow(d: Drive, b: Body3D, dt: number) {
  const goal = [b.yaw, b.pitch, b.roll];
  for (let i = 1; i < d.frac.length; i++) {
    const w = 2 * Math.PI * d.hz[i];
    for (let k = 0; k < 3; k++) {
      const at = 3 * i + k;
      const x = d.angle[at];
      const off = k === 2 ? Math.atan2(Math.sin(goal[k] - x), Math.cos(goal[k] - x)) : goal[k] - x;
      d.speed[at] += (w * w * off - 2 * ROPE.follow * w * d.speed[at]) * dt;
      d.angle[at] += d.speed[at] * dt;
    }
  }
}

// The dragged and undulating target at `time` s: each drawn segment turned
// by the followed body of the node it ends at, chained from the root (so
// every segment keeps its drawn length however far apart the nodes' turns
// are), then turned by the bend wave at its arc fraction, then bowed on
// screen to ROPE.bow if it would look straighter (segments turned about the
// view axis, so the lengths still hold).
function driven(s: Lifted, d: Drive, b: Body3D, time: number): Vec3[] {
  const n = s.points.length;
  const root = toCamera(b, s.points[0]);
  const pts: Vec3[] = [root];
  for (let i = 1; i < n; i++) {
    const bi: Body3D = { ...b, yaw: d.angle[3 * i], pitch: d.angle[3 * i + 1], roll: d.angle[3 * i + 2] };
    const a = toCamera(bi, s.points[i]);
    const o = toCamera(bi, s.points[i - 1]);
    pts.push([pts[i - 1][0] + a[0] - o[0], pts[i - 1][1] + a[1] - o[1], pts[i - 1][2] + a[2] - o[2]]);
  }
  const rad = Math.PI / 180;
  const out: Vec3[] = [root];
  for (let i = 0; i < n - 1; i++) {
    const t = d.frac[i + 1];
    const reach = t ** ROPE.grow;
    const turn = ROPE.waveDeg * rad * reach * Math.sin(2 * Math.PI * (ROPE.waveHz * time - t / ROPE.waveLength) + d.phase[0]);
    const tilt = ROPE.depthDeg * rad * reach * Math.sin(2 * Math.PI * (ROPE.depthHz * time - t / ROPE.waveLength) + d.phase[1]);
    const seg = tiltUp(turnOnScreen(sub3(pts[i + 1], pts[i]), turn), tilt);
    out.push([out[i][0] + seg[0], out[i][1] + seg[1], out[i][2] + seg[2]]);
  }
  return bowedOnScreen(b, out, Math.cos(b.yaw) >= 0 ? d.side : d.side === 1 ? -1 : 1, d.frac, ROPE.bow);
}

// The drawn line's joints eased to `most` at the sharpest on screen: the
// chain's own joints are held to FOLD in 3D, but a segment seen end on (by
// the root, where the rope leaves his back toward or away from the camera)
// turns any way on screen, and a hairpin there reads as a fold however it
// lies in depth. Each joint past it, by a segment seen foreshortened to
// under JOINT_SHORT of the median (`every`: any, as on the strike's laid
// curve, whose stem out of his back turns over to P), is pulled toward its neighbours'
// middle by the share it is over, over a few passes; the root and the tip
// stay (a pinned tip on P), and so do the depths.
export function easeJoints(p: readonly Vec2[], most: number, every = false): Vec2[] {
  const q = p.map((v): Vec2 => [v[0], v[1]]);
  const end = q.length - 1;
  const lens = q.slice(1).map((v, i) => Math.hypot(v[0] - q[i][0], v[1] - q[i][1])).sort((a, b) => a - b);
  const short = every ? Infinity : JOINT_SHORT * (lens[lens.length >> 1] ?? 0); // only where a segment is seen this foreshortened ...
  const tip = Math.floor((1 - JOINT_TIP) * end); // ... or by the tip, which whips about free of him
  for (let pass = 0; pass < JOINT_PASSES; pass++) {
    let over = false;
    for (let i = 1; i < end; i++) {
      const [ax, ay, bx, by] = [q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1], q[i + 1][0] - q[i][0], q[i + 1][1] - q[i][1]];
      const [la, lb] = [Math.hypot(ax, ay), Math.hypot(bx, by)];
      if (la < 1e-6 || lb < 1e-6 || (Math.min(la, lb) > short && i < tip)) continue;
      const turn = Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb))));
      if (turn <= most) continue;
      over = true;
      const k = (turn - most) / turn;
      q[i] = [q[i][0] + ((q[i - 1][0] + q[i + 1][0]) / 2 - q[i][0]) * k, q[i][1] + ((q[i - 1][1] + q[i + 1][1]) / 2 - q[i][1]) * k];
    }
    if (!over) break;
  }
  return q;
}
const JOINT = (55 * Math.PI) / 180; // the sharpest a drawn joint turns on screen (decision 15: no fold over 60°)
const JOINT_FREE = (40 * Math.PI) / 180; // ... and by a foreshortened segment (JOINT_SHORT), the sharpest it turns
const JOINT_CAP = (58 * Math.PI) / 180; // ... and anywhere, the sharpest any drawn joint turns
const JOINT_PASSES = 40;
const JOINT_SHORT = 0.8; // × the median segment on screen: a joint is eased only next to a segment shorter than this ...
const JOINT_TIP = 0.15; // ... or within this share of the nodes of the tip

// The share of a limb's length on screen (camera x, y) over its length.
export function screenShare(pts: readonly Vec3[]): number {
  let [on, all] = [0, 0];
  for (let i = 1; i < pts.length; i++) {
    const [dx, dy, dz] = [pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]];
    on += Math.hypot(dx, dy);
    all += Math.hypot(dx, dy, dz);
  }
  return all > 0 ? on / all : 1;
}

// The limb turned rigidly about its root toward the screen plane, round the
// axis across its chord on screen, by the least share of the chord's angle
// out of that plane that shows `least` of its length on screen (all of the
// angle when even that falls short); as it is when it shows that already.
// So the turn grows from nothing as the limb tips edge-on, with no jump.
export function faceCamera(pts: Vec3[], least: number): Vec3[] {
  if (pts.length < 2 || screenShare(pts) >= least) return pts;
  const r = pts[0];
  const c = pts[pts.length - 1];
  const [cx, cy, cz] = [c[0] - r[0], c[1] - r[1], c[2] - r[2]];
  const m = Math.hypot(cx, cy);
  if (m < 1e-6) return pts;
  const ax: Vec3 = [-cy / m, cx / m, 0];
  const e = Math.atan2(cz, m); // the chord's angle out of the screen plane: turning by it lays the chord in it
  const turned = (th: number) => {
    const [co, si] = [Math.cos(th), Math.sin(th)];
    return pts.map((p): Vec3 => {
      const v: Vec3 = [p[0] - r[0], p[1] - r[1], p[2] - r[2]];
      const k = ax[0] * v[0] + ax[1] * v[1]; // a·v (a_z = 0)
      const x: Vec3 = [ax[1] * v[2], -ax[0] * v[2], ax[0] * v[1] - ax[1] * v[0]]; // a × v
      return [r[0] + v[0] * co + x[0] * si + ax[0] * k * (1 - co), r[1] + v[1] * co + x[1] * si + ax[1] * k * (1 - co), r[2] + v[2] * co + x[2] * si];
    });
  };
  if (screenShare(turned(e)) < least) return turned(e);
  let [lo, hi] = [0, 1];
  for (let k = 0; k < 14; k++) {
    const mid = (lo + hi) / 2;
    if (screenShare(turned(mid * e)) >= least) hi = mid;
    else lo = mid;
  }
  return turned(hi * e);
}
const FACE = 0.92;

// The chain as drawn: bowed on screen to at least ROPE.least of its chord,
// the way it already bends (bulgeSide), when it looks straighter than that.
// The simulation keeps its own shape; only the drawing is bowed.
function neverStraight(b: Body3D, pts: Vec3[], frac: readonly number[]): Vec3[] {
  const seen = pts.map((p): Vec2 => project(b, p).xy);
  return sagittaRatio(seen) < ROPE.least ? bowedOnScreen(b, pts, bulgeSide(seen), frac, ROPE.least) : pts;
}

// v turned by `a` about the camera's z axis.
function turnOnScreen(v: Vec3, a: number): Vec3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]];
}

// v turned by `a` toward the camera, keeping its direction on screen.
function tiltUp(v: Vec3, a: number): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  const xy = Math.hypot(v[0], v[1]);
  if (l === 0 || xy < 1e-9) return v;
  const e = Math.atan2(v[2], xy) + a;
  const k = (l * Math.cos(e)) / xy;
  return [v[0] * k, v[1] * k, l * Math.sin(e)];
}

const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dist3 = (a: Vec3, b: Vec3) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
const smoothstep = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

// One frame's limbs, the way the tube takes them.
export function heldLimbs(frame: Frame3D): HeldLimb[] {
  return frame.placed.map(({ id, points, z, pressure, front, length }) => ({ id, points, z, pressure, front, length }));
}
