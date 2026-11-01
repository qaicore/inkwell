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
//   1. step the 3D chains to f/30, targets from the interpolated body;
//   2. when the drawing index k changes, capture a drawing: project the chain
//      to the screen, store it in 2D torso space plus boil(k), and note per
//      point whether it's in front of his body and how deep it is;
//   3. place the held drawing with this frame's 2D torso transform.
// So the shape and the layer change only on drawings (on 2s), the way a
// hand-drawn turn is drawn, while the placement follows him every frame.
//
// For the impact (design §2, §4):
//   - each chain starts on the first frame of its stroke's emergence drawing,
//     resting on that frame's body. Before that the stroke isn't there;
//   - a strike controller's orders apply on every physics step (strand3d.ts);
//   - with a controller, a drawing is captured on every frame from land − 1
//     to release − 1, so a pinned tip is exact on every frame, and the release
//     forces a new drawing. A limb whose tip is pinned at the frame's end is
//     captured without boil, so its tip sits exactly on the pin (the strike
//     redraws it 15 times a second anyway, design §4 "Clock").
//     Every frame is marked with what the limbs show (clock.ts).
import type { Vec2 } from '../types/effect.ts';
import type { HeldLimb, StrikeController } from '../impact/contracts.ts';
import { limbDrawingAt, type LimbDrawing } from '../impact/clock.ts';
import { DEFAULT_PHYSICS, type PhysicsParams } from '../physics/strand.ts';
import { boilOffsets, type BoilParams } from '../motion/boil.ts';
import { drawingIndex } from '../motion/timing.ts';
import { offsetToTorso, toPixels, toTorso } from '../track/torso.ts';
import { backDepth, flat, inFront, lerpBody, project, toBody, toCamera, unproject, type Body3D, type Vec3 } from './body.ts';
import { createChain3, stepChain3, type Chain3 } from './strand3d.ts';

export const SHEET = { slope: 0.3, curve: 0.08 };
const SKIN = 0.03; // the root sits this far off his back, so it's never inside the torso

export interface Lifted {
  id: number;
  points: Vec3[]; // body units
  pressure: number[];
  kind: 'strand' | 'rigid';
  stiffness: number;
  wobble: number;
  length: number; // px: the stroke's length as drawn
}

// `px`: the stroke in screen px on the drawing frame, root first.
export function liftStroke(id: number, px: Vec2[], pressure: number[], body: Body3D, kind: Lifted['kind'], stiffness: number, wobble = 1, sheet = SHEET): Lifted {
  const t = flat(body);
  const flatPts = px.map((p) => toTorso(t, p));
  const [rx, ry] = flatPts[0];
  const rootZ = backDepth(rx, ry) - SKIN;
  const points = px.map((p, i): Vec3 => {
    const [x, y] = flatPts[i];
    const r = Math.hypot(x - rx, y - ry);
    const z = (rootZ - sheet.slope * r - sheet.curve * r * r) * body.unit;
    // This depth, seen through this frame's camera, must land where he drew it.
    return toBody(body, unproject(body, p, z));
  });
  let length = 0;
  for (let i = 1; i < px.length; i++) length += Math.hypot(px[i][0] - px[i - 1][0], px[i][1] - px[i - 1][1]);
  return { id, points, pressure, kind, stiffness, wobble, length };
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
  const params = opts.physics ?? DEFAULT_PHYSICS;
  const fps = opts.fps ?? 30;
  const steps = Math.round(1 / (fps * params.dt));
  const { control } = opts;
  const strike = control ? { land: control.land, release: control.release } : undefined;
  const drawingAt = (f: number): LimbDrawing => {
    if (opts.slam) return limbDrawingAt(f, opts.slam.I, strike, opts.slam.posters);
    return strike ? limbDrawingAt(f, 0, strike, false) : 'grid';
  };
  const target = (s: Lifted, b: Body3D) => s.points.map((q) => toCamera(b, q));
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
  const pinned = opts.strokes.map(() => false); // the tip was pinned on the frame's last step

  const out: Frame3D[] = [];
  let held: Held[] = [];
  let lastK = -1;
  let capture = -1;
  for (let f = 0; f < opts.frames; f++) {
    if (f > 0) {
      for (let i = 1; i <= steps; i++) {
        const b = lerpBody(opts.bodies[f - 1], opts.bodies[f], i / steps);
        const live = opts.strokes.flatMap((s, j) => {
          const chain = chains[j];
          return chain ? [{ s, j, chain, target: target(s, b) }] : [];
        });
        const orders = control
          ? control.step({ f, sub: i, steps, body: b, limbs: live.map(({ s, chain, target }) => ({ id: s.id, points: [...chain.points], target, stiffness: s.stiffness })) })
          : [];
        live.forEach(({ j, chain, target }, l) => {
          const order = orders[l] ?? null;
          stepChain3(chain, target, b.unit, params, order);
          pinned[j] = !!order?.pin;
        });
      }
    }
    opts.strokes.forEach((s, j) => {
      if (!chains[j] && born[j] <= f) chains[j] = createChain3(target(s, opts.bodies[f]), s.kind, s.stiffness);
    });
    const k = drawingIndex(f, opts.dps, fps);
    if (k !== lastK || (strike && f >= strike.land - 1 && f <= strike.release)) {
      lastK = k;
      capture++;
      const b = opts.bodies[f];
      const t = flat(b);
      held = opts.strokes.flatMap((s, j): Held[] => {
        const chain = chains[j];
        if (!chain) return [];
        const pts = chain.points;
        const boil = pinned[j] ? null : boilOffsets(k, s.id, pts.length, opts.boil, s.wobble, opts.width);
        const seen = pts.map((p) => project(b, p));
        return [
          {
            id: s.id,
            points: seen.map(({ xy }, i): Vec2 => {
              const [x, y] = toTorso(t, xy);
              if (!boil) return [x, y];
              const [bx, by] = offsetToTorso(t, boil[i]);
              return [x + bx, y + by];
            }),
            z: pts.map((p) => p[2] / b.unit),
            // Nearer is a little wider, so depth reads in the line itself.
            pressure: s.pressure.map((p, i) => Math.min(1, p * seen[i].near)),
            front: pts.map((p) => inFront(b, p)),
            depth: pts.reduce((sum, p) => sum + p[2], 0) / pts.length,
            length: s.length,
          },
        ];
      });
    }
    const t = flat(opts.bodies[f]);
    out.push({
      f,
      k,
      capture,
      drawing: drawingAt(f),
      placed: held.map((h) => ({ ...h, points: h.points.map((p) => toPixels(t, p)), z: h.z.map((z) => z * t.unit) })),
      sim: opts.strokes.flatMap((s, j) => {
        const chain = chains[j];
        return chain ? [{ id: s.id, points: chain.points.map((p): Vec3 => [p[0], p[1], p[2]]) }] : [];
      }),
    });
  }
  return out;
}

// One frame's limbs, the way the tube takes them.
export function heldLimbs(frame: Frame3D): HeldLimb[] {
  return frame.placed.map(({ id, points, z, pressure, front, length }) => ({ id, points, z, pressure, front, length }));
}
