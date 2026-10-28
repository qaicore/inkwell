// The nearest-mask rule (SPEC §10): the dumb baseline Wonder's plan must
// beat (W1), and what the app falls back to when Wonder can't answer (W2).
// Each stroke attaches to the mask nearest its root, with default physics.
// A root inside two masks goes to the smaller one, the more specific part
// (a root on the face is on the person too).
import type { SamMask } from '../sam/cache.ts';
import type { PlanInput, StrokePlan } from './plan.ts';

// The defaults: what a stroke gets when nobody has said otherwise. The same
// as the app's controls start at.
export const DEFAULT_PLAN = { kind: 'strand', bodyAngle: 0, stiffness: 0.5, layer: 'front', wobble: 1 } as const;

export function nearestMaskPlan(input: PlanInput): StrokePlan[] {
  const masks = Object.entries(input.masks).flatMap(([prompt, m]) => (m ? [{ prompt, m, area: area(m) }] : []));
  return input.strokes.map((stroke) => {
    const [x, y] = stroke.points[0];
    let best: { prompt: string; d: number; area: number } = { prompt: 'person', d: Infinity, area: Infinity };
    for (const { prompt, m, area: a } of masks) {
      const d = distance(m, x, y);
      if (d < best.d || (d === best.d && a < best.area)) best = { prompt, d, area: a };
    }
    return {
      id: stroke.id,
      ...DEFAULT_PLAN,
      anchor: { type: 'concept', prompt: best.prompt },
      reason: masks.length ? `nearest mask: ${best.prompt}` : 'no masks on this frame: person',
    };
  });
}

// Distance from (x, y) to the nearest set raster cell, 0 inside one, in
// frame px.
function distance(m: SamMask, x: number, y: number): number {
  const sx = (m.bounds.right - m.bounds.left) / m.width;
  const sy = (m.bounds.bottom - m.bounds.top) / m.height;
  let best = Infinity;
  for (let row = 0, i = 0; row < m.height; row++) {
    const top = m.bounds.top + row * sy;
    const dy = Math.max(top - y, 0, y - (top + sy));
    if (dy >= best) {
      i += m.width;
      continue;
    }
    for (let col = 0; col < m.width; col++, i++) {
      if (!m.raster[i]) continue;
      const left = m.bounds.left + col * sx;
      const d = Math.hypot(Math.max(left - x, 0, x - (left + sx)), dy);
      if (d < best) best = d;
    }
  }
  return best;
}

function area(m: SamMask): number {
  let n = 0;
  for (let i = 0; i < m.raster.length; i++) n += m.raster[i] ? 1 : 0;
  return (n * (m.bounds.right - m.bounds.left) * (m.bounds.bottom - m.bounds.top)) / (m.width * m.height);
}
