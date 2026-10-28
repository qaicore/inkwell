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
//      point whether it's in front of his body;
//   3. place the held drawing with this frame's 2D torso transform.
// So the shape and the layer change only on drawings (on 2s), the way a
// hand-drawn turn is drawn, while the placement follows him every frame.
import type { Vec2 } from '../types/effect.ts';
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
  return { id, points, pressure, kind, stiffness, wobble };
}

export interface Placed3D {
  id: number;
  points: Vec2[]; // px
  pressure: number[];
  front: boolean[]; // per point: over his body (true) or under it
  depth: number; // mean camera z, px, for drawing order (far first)
}

export interface Frame3D {
  f: number;
  k: number;
  placed: Placed3D[];
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
}

interface Held {
  id: number;
  points: Vec2[]; // 2D torso space, boil included
  pressure: number[];
  front: boolean[];
  depth: number;
}

export function animate3d(opts: Animate3DOptions): Frame3D[] {
  const params = opts.physics ?? DEFAULT_PHYSICS;
  const fps = opts.fps ?? 30;
  const steps = Math.round(1 / (fps * params.dt));
  const target = (s: Lifted, b: Body3D) => s.points.map((q) => toCamera(b, q));
  const chains: Chain3[] = opts.strokes.map((s) => createChain3(target(s, opts.bodies[0]), s.kind, s.stiffness));

  const out: Frame3D[] = [];
  let held: Held[] = [];
  let lastK = -1;
  for (let f = 0; f < opts.frames; f++) {
    if (f > 0) {
      for (let i = 1; i <= steps; i++) {
        const b = lerpBody(opts.bodies[f - 1], opts.bodies[f], i / steps);
        opts.strokes.forEach((s, j) => stepChain3(chains[j], target(s, b), b.unit, params));
      }
    }
    const k = drawingIndex(f, opts.dps, fps);
    if (k !== lastK) {
      lastK = k;
      const b = opts.bodies[f];
      const t = flat(b);
      held = opts.strokes.map((s, j) => {
        const pts = chains[j].points;
        const boil = boilOffsets(k, s.id, pts.length, opts.boil, s.wobble, opts.width);
        const seen = pts.map((p) => project(b, p));
        return {
          id: s.id,
          points: seen.map(({ xy }, i): Vec2 => {
            const [x, y] = toTorso(t, xy);
            const [bx, by] = offsetToTorso(t, boil[i]);
            return [x + bx, y + by];
          }),
          // Nearer is a little wider, so depth reads in the line itself.
          pressure: s.pressure.map((p, i) => Math.min(1, p * seen[i].near)),
          front: pts.map((p) => inFront(b, p)),
          depth: pts.reduce((sum, p) => sum + p[2], 0) / pts.length,
        };
      });
    }
    const t = flat(opts.bodies[f]);
    out.push({ f, k, placed: held.map((h) => ({ ...h, points: h.points.map((p) => toPixels(t, p)) })) });
  }
  return out;
}
