import { describe, expect, it } from 'vitest';
import { planStrokes, type PlanInput, type PlanRequest } from '../../src/plan/plan.ts';
import { validatePlan } from '../../src/plan/schema.ts';
import { DEFAULT_PLAN, nearestMaskPlan } from '../../src/plan/baseline.ts';
import type { SamMask } from '../../src/sam/cache.ts';

function box(left: number, top: number, right: number, bottom: number): SamMask {
  const width = (right - left) / 10;
  const height = (bottom - top) / 10;
  return { width, height, raster: new Uint8Array(width * height).fill(1), bounds: { left, top, right, bottom } };
}

const INPUT: PlanInput = {
  frame: 4,
  strokes: [
    { id: 1, points: [[500, 900, 0.5], [700, 1000, 0.5]] },
    { id: 2, points: [[1000, 300, 0.5], [1050, 200, 0.5]] }, // off to the side: nearer the person's edge than the face
  ],
  masks: { person: box(300, 300, 800, 1800), face: box(450, 300, 650, 500), hand: null },
};

const plan = (id: number) => ({ id, kind: 'rigid', anchor: { type: 'concept', prompt: 'head' }, bodyAngle: 10, stiffness: 1, layer: 'front', wobble: 0, reason: 'a horn' });
const VALID = JSON.stringify({ strokes: [plan(1), plan(2)] });

describe('nearestMaskPlan', () => {
  it('attaches each root to the nearest mask, the smaller one when inside two, with default physics', () => {
    const rule = nearestMaskPlan(INPUT);
    expect(rule.map((p) => p.anchor)).toEqual([{ type: 'concept', prompt: 'person' }, { type: 'concept', prompt: 'person' }]);
    for (const p of rule) expect(p).toMatchObject(DEFAULT_PLAN);
    const onFace = nearestMaskPlan({ ...INPUT, strokes: [{ id: 3, points: [[550, 400, 0.5], [560, 300, 0.5]] }] });
    expect(onFace[0].anchor).toEqual({ type: 'concept', prompt: 'face' });
  });
});

describe('validatePlan', () => {
  it('keeps only the schema fields', () => {
    const r = validatePlan(JSON.stringify({ strokes: [{ ...plan(1), extra: 1 }, plan(2)] }), [1, 2]);
    expect(r.ok && Object.keys(r.strokes[0]).sort()).toEqual(['anchor', 'bodyAngle', 'id', 'kind', 'layer', 'reason', 'stiffness', 'wobble']);
  });
  it('says what was wrong', () => {
    const r = validatePlan(JSON.stringify({ strokes: [{ ...plan(1), stiffness: 2 }] }), [1, 2]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problems).toEqual(['strokes[0]: stiffness 2 is not in 0..1', 'no plan for stroke 2']);
  });
});

describe('planStrokes', () => {
  it('tells Wonder on the retry what was wrong', async () => {
    const asked: PlanRequest[] = [];
    const answers = ['not json', VALID];
    const r = await planStrokes(INPUT, async (req) => (asked.push(req), answers[asked.length - 1]));
    expect(r).toMatchObject({ source: 'wonder', attempts: 2, note: null });
    expect(asked.map((a) => a.attempt)).toEqual([1, 2]);
    expect(asked[0].prompt).not.toMatch(/couldn't be used/);
    expect(asked[1].prompt).toMatch(/couldn't be used: the output is not JSON/);
  });
  it('falls back to the rule with a note after two failures', async () => {
    let calls = 0;
    const r = await planStrokes(INPUT, async () => {
      calls++;
      throw new Error('offline');
    });
    expect(calls).toBe(2);
    expect(r.source).toBe('rule');
    expect(r.strokes).toEqual(nearestMaskPlan(INPUT));
    expect(r.note).toMatch(/nearest body mask/);
  });
});
