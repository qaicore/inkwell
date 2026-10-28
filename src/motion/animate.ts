// The frame loop (SPEC §8.1): smooth physics underneath, drawings on top.
// Per video frame f:
//   1. advance every chain to f/30 in fixed steps, the targets interpolated
//      between the two frames' torso transforms;
//   2. k = floor(f·dps/30); when k changes, capture a new drawing: the chain,
//      back in torso space, plus boil(k). Otherwise keep the held drawing;
//   3. place the held drawing with this frame's own transform.
// So the shape steps on 2s while its placement follows the body every frame,
// and the simulation never stops, so momentum carries through the holds.
import type { Effect, Vec2 } from '../types/effect.ts';
import { DEFAULT_PHYSICS, createChain, stepChain, type Chain, type PhysicsParams } from '../physics/strand.ts';
import { lerpTransform, offsetToTorso, toPixels, toTorso, type TorsoTransform } from '../track/torso.ts';
import { boilOffsets, type BoilParams } from './boil.ts';
import { warpView, type BodyAngle } from './body.ts';
import { drawingIndex } from './timing.ts';

export interface HeldStroke {
  id: number;
  points: Vec2[]; // torso space, boil included
  pressure: number[];
  layer: 'behind' | 'front';
}
export type PlacedStroke = HeldStroke; // the same, with points in px

export interface AnimatedFrame {
  f: number;
  k: number; // drawing index
  held: HeldStroke[];
  placed: PlacedStroke[];
  sim: { id: number; points: Vec2[] }[]; // the chains themselves, px, no boil
}

export interface AnimateOptions {
  effect: Effect;
  frames: number;
  anchor: (strokeId: number, frame: number) => TorsoTransform;
  width: number; // frame width in px; boil is scaled from 1080 wide to this
  boil: BoilParams;
  physics?: PhysicsParams;
  fps?: number;
  // The body's facing and forward bend at a (fractional) frame, or null for
  // upright and facing the camera. When given, each target is turned with it
  // (body.ts) before the physics, and the layer follows.
  body?: (frame: number) => BodyAngle | null;
}

export function animate(opts: AnimateOptions): AnimatedFrame[] {
  const params = opts.physics ?? DEFAULT_PHYSICS;
  const fps = opts.fps ?? 30;
  const steps = Math.round(1 / (fps * params.dt));
  if (Math.abs(steps * fps * params.dt - 1) > 1e-9) throw new Error(`dt ${params.dt} doesn't divide a ${fps} fps frame`);
  const dps = opts.effect.timing.drawingsPerSecond;

  // M1 has the front view only; the turn (§8.5) blends views here later.
  // Until then, `body` turns the front view (the §8.5 single-view fallback).
  const strokes = opts.effect.strokes.map((stroke) => {
    const view = stroke.views.front;
    const shape = (frame: number) => {
      const at = opts.body?.(frame);
      return at ? warpView(view.points, (stroke.bodyAngle * Math.PI) / 180, at) : { points: view.points, layer: view.layer };
    };
    const target = (t: TorsoTransform, frame: number) => shape(frame).points.map((p) => toPixels(t, p));
    const chain: Chain = createChain(target(opts.anchor(stroke.id, 0), 0), stroke.kind, stroke.stiffness);
    return { stroke, view, shape, target, chain };
  });

  const out: AnimatedFrame[] = [];
  let held: HeldStroke[] = [];
  let lastK = -1;
  for (let f = 0; f < opts.frames; f++) {
    if (f > 0) {
      for (const s of strokes) {
        const from = opts.anchor(s.stroke.id, f - 1);
        const to = opts.anchor(s.stroke.id, f);
        for (let i = 1; i <= steps; i++) {
          const t = lerpTransform(from, to, i / steps);
          stepChain(s.chain, s.target(t, f - 1 + i / steps), t.unit, params);
        }
      }
    }
    const k = drawingIndex(f, dps, fps);
    if (k !== lastK) {
      lastK = k;
      held = strokes.map(({ stroke, view, shape, chain }) => {
        const t = opts.anchor(stroke.id, f);
        const boil = boilOffsets(k, stroke.id, chain.points.length, opts.boil, stroke.wobble, opts.width);
        return {
          id: stroke.id,
          points: chain.points.map((p, i): Vec2 => {
            const [x, y] = toTorso(t, p);
            const [bx, by] = offsetToTorso(t, boil[i]);
            return [x + bx, y + by];
          }),
          pressure: [...view.pressure],
          layer: opts.body ? shape(f).layer : view.layer,
        };
      });
    }
    out.push({
      f,
      k,
      held,
      placed: held.map((h) => {
        const t = opts.anchor(h.id, f);
        return { ...h, points: h.points.map((p) => toPixels(t, p)) };
      }),
      sim: strokes.map(({ stroke, chain }) => ({ id: stroke.id, points: chain.points.map((p): Vec2 => [p[0], p[1]]) })),
    });
  }
  return out;
}
