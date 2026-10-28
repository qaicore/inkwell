import { describe, expect, it } from 'vitest';
import { applyOverride, applyPlan, clearOverride, isOverridden } from '../../src/app/overrides.ts';
import { parseEffect, serializeEffect, type Effect } from '../../src/types/effect.ts';
import type { StrokePlan } from '../../src/plan/plan.ts';

const EFFECT: Effect = {
  version: 1,
  brush: { size: 28, thinning: 0.65, smoothing: 0.6, streamline: 0.45 },
  palette: ['#000000', '#ff0000', '#ffffff'],
  timing: { drawingsPerSecond: 12 },
  strokes: [
    {
      id: 1,
      color: 1,
      kind: 'strand',
      anchor: { type: 'concept', prompt: 'person' },
      bodyAngle: 0,
      stiffness: 0.5,
      wobble: 1,
      views: { front: { points: [[0, 0], [0.2, 0.1]], pressure: [0.5, 0.5], root: [0, 0], layer: 'front' } },
    },
  ],
  overrides: {},
};
const PLAN: StrokePlan[] = [{ id: 1, kind: 'rigid', anchor: { type: 'concept', prompt: 'head' }, bodyAngle: 90, stiffness: 1, layer: 'behind', wobble: 0.2, reason: 'a horn' }];

describe('overrides', () => {
  it('a tapped field beats every later plan until it is cleared', () => {
    const tapped = applyOverride(applyPlan(EFFECT, PLAN), 1, 'stiffness', 0.1);
    expect(isOverridden(tapped, 1, 'stiffness')).toBe(true);
    expect(applyPlan(tapped, PLAN).strokes[0].stiffness).toBe(0.1);
    expect(applyPlan(clearOverride(tapped, 1, 'stiffness'), PLAN).strokes[0].stiffness).toBe(1);
  });
  it('never changes the effect it was given', () => {
    const before = serializeEffect(EFFECT);
    applyOverride(applyPlan(EFFECT, PLAN), 1, 'layer', 'behind');
    expect(serializeEffect(EFFECT)).toBe(before);
  });
  it('refuses a stroke that does not exist', () => {
    expect(() => applyOverride(EFFECT, 9, 'kind', 'rigid')).toThrow(/no stroke 9/);
  });
});

describe('parseEffect', () => {
  it('round-trips', () => {
    const e = applyOverride(EFFECT, 1, 'brush', 'neon-round');
    expect(parseEffect(serializeEffect(e))).toEqual({ effect: e });
  });
  it('reads an effect saved before the brushes', () => {
    expect('effect' in parseEffect(JSON.stringify(EFFECT))).toBe(true);
  });
  it('lists what is wrong instead of throwing', () => {
    const bad = { ...EFFECT, timing: { drawingsPerSecond: 24 }, strokes: [{ ...EFFECT.strokes[0], brush: 'crayon' }] };
    const r = parseEffect(JSON.stringify(bad));
    expect('problems' in r && r.problems).toEqual(['timing.drawingsPerSecond is not 12 or 8', 'strokes[0].brush is not a brush']);
    expect(parseEffect('{')).toEqual({ problems: ['not JSON'] });
  });
});
