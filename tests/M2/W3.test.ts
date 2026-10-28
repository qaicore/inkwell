/// <reference types="node" />
// W3 (SPEC §10, Wonder): every plan field has a one-tap override that persists in the effect JSON. Threshold: all
// fields.
//
// API-free (recorded plan, SPEC M2 row). Real modules:
//   - src/app/overrides.ts  OVERRIDE_FIELDS (the fields the plan panel can override), applyPlan(effect, plans)
//     (writes Wonder's or the rule's plan into the effect, keeping overrides), applyOverride(effect, strokeId, field,
//     value) (one tap: returns the new effect)
//   - src/types/effect.ts   serializeEffect(effect) -> the project JSON text, parseEffect(text) -> { effect } or
//     { problems } (the file that moves between iPad and desktop, §6)
// The plan fields are §9's per-stroke plan output: kind, anchor, bodyAngle, stiffness, layer, wobble; plus the
// stroke's brush (§7 Stroke.brush, picked in the brush picker, §8.8). For each field, on stroke 1 of a two-stroke
// effect that already carries a plan:
//   1. one applyOverride call sets it to a value different from the plan's;
//   2. serializeEffect -> parseEffect round-trips the effect exactly (deep-equal);
//   3. after the round trip, stroke 1 has the override value (layer: views.front.layer, the view the plan sets) and
//      effect.overrides["strokes.1.<field>"] holds it;
//   4. stroke 2 is untouched;
//   5. re-applying the same plan (Wonder re-plans) keeps the override on stroke 1.
// Stricter readings, flagged for Qai:
//   - brush counts as a plan field here (§7 has it on Stroke; Wonder doesn't plan it, but the panel overrides it);
//   - "persists" includes surviving a re-plan, and the override key is the field path "strokes.<id>.<field>";
//   - reason is not overridable (it's Wonder's explanation, not a setting).
import { afterAll, describe, expect, it } from 'vitest';
import { Evidence } from '../helpers/evidence.ts';
import { errMsg, need, recorded, tendril } from '../helpers/engine.ts';
import type { Effect, Stroke } from '../../src/types/effect.ts';
import type { StrokePlan } from '../../src/plan/plan.ts';

type OverridesModule = typeof import('../../src/app/overrides.ts');
type EffectModule = typeof import('../../src/types/effect.ts');

const ID = 'W3';
const FIELDS = ['kind', 'anchor', 'bodyAngle', 'stiffness', 'layer', 'wobble', 'brush'] as const;
type Field = (typeof FIELDS)[number];

const ev = new Evidence(ID, [
  'modules load',
  'OVERRIDE_FIELDS covers every plan field',
  'plan applied and round-tripped',
  ...FIELDS.map((f) => `override persists: ${f}`),
]);
afterAll(() => ev.write());

function stroke(id: number): Stroke {
  const points = tendril(700 + id);
  return {
    id,
    color: 0,
    kind: 'strand',
    anchor: { type: 'concept', prompt: 'person' },
    bodyAngle: 0,
    stiffness: 0.5,
    wobble: 1,
    views: { front: { points, pressure: points.map(() => 0.6), root: points[0]!, layer: 'front' } },
  };
}

const BASE: Effect = {
  version: 1,
  brush: { size: 28, thinning: 0.65, smoothing: 0.6, streamline: 0.45 },
  palette: ['#1b1b1f', '#c8323c', '#f2efe6'],
  timing: { drawingsPerSecond: 12 },
  strokes: [stroke(1), stroke(2)],
  overrides: {},
};

const PLANS: StrokePlan[] = [
  { id: 1, kind: 'strand', anchor: { type: 'concept', prompt: 'person' }, bodyAngle: 180, stiffness: 0.3, layer: 'behind', wobble: 0.5, reason: 'a tendril out of his back' },
  { id: 2, kind: 'rigid', anchor: { type: 'concept', prompt: 'head' }, bodyAngle: 0, stiffness: 1, layer: 'front', wobble: 0.2, reason: 'a horn' },
];

/** A value for each field that differs from both plans (and from the unset brush). */
const OVERRIDE: Record<Field, unknown> = {
  kind: 'rigid',
  anchor: { type: 'point', time: 0.5, xy: [612, 845] },
  bodyAngle: 270,
  stiffness: 0.85,
  layer: 'front',
  wobble: 0,
  brush: 'neon-round',
};

function fieldOf(e: Effect, id: number, f: Field): unknown {
  const s = e.strokes.find((x) => x.id === id) as (Stroke & Record<string, unknown>) | undefined;
  if (!s) return undefined;
  if (f === 'layer') return s.views.front.layer;
  return s[f];
}
const planned = (id: number, f: Field): unknown => (f === 'brush' ? undefined : (PLANS.find((p) => p.id === id) as unknown as Record<string, unknown>)[f]);
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

describe('W3 one-tap overrides persist in the effect JSON', () => {
  it('W3 every plan field has an override that persists', async () => {
    const mods = await recorded(ev, 'modules load', 'src/app/overrides.ts (OVERRIDE_FIELDS, applyPlan, applyOverride), src/types/effect.ts (serializeEffect, parseEffect)', async () => ({
      o: await need('src/app/overrides.ts', { applyPlan: 'function', applyOverride: 'function', OVERRIDE_FIELDS: 'object' }, () => import('../../src/app/overrides.ts')),
      e: await need('src/types/effect.ts', { serializeEffect: 'function', parseEffect: 'function' }, () => import('../../src/types/effect.ts')),
    })) as { o: OverridesModule; e: EffectModule };

    const listed = [...(mods.o.OVERRIDE_FIELDS as readonly string[])];
    const notListed = FIELDS.filter((f) => !listed.includes(f));
    ev.record('OVERRIDE_FIELDS covers every plan field', listed, FIELDS.join(', '), notListed.length === 0, notListed.length ? `missing: ${notListed.join(', ')}` : '');

    const roundTrip = (e: Effect): Effect => {
      const parsed = mods.e.parseEffect(mods.e.serializeEffect(e));
      if (!('effect' in parsed)) throw new Error(`parseEffect rejected the serialized effect: ${(parsed as { problems: string[] }).problems.join('; ')}`);
      return parsed.effect;
    };

    const planned0 = await recorded(ev, 'plan applied and round-tripped', 'applyPlan sets every planned field; serialize -> parse is exact', () => {
      const e = mods.o.applyPlan(structuredClone(BASE), structuredClone(PLANS));
      const wrong = PLANS.flatMap((p) => FIELDS.filter((f) => f !== 'brush' && !eq(fieldOf(e, p.id, f), planned(p.id, f))).map((f) => `stroke ${p.id} ${f}: ${JSON.stringify(fieldOf(e, p.id, f))}`));
      if (wrong.length) throw new Error(`applyPlan didn't write the plan: ${wrong.join('; ')}`);
      const back = roundTrip(e);
      if (!eq(back, e)) throw new Error('serializeEffect -> parseEffect changed the effect');
      return e;
    });

    const failures: string[] = [];
    for (const f of FIELDS) {
      const problems: string[] = [];
      try {
        const tapped = mods.o.applyOverride(structuredClone(planned0), 1, f, structuredClone(OVERRIDE[f]));
        const back = roundTrip(tapped);
        if (!eq(back, tapped)) problems.push('round trip changed the effect');
        if (!eq(fieldOf(back, 1, f), OVERRIDE[f])) problems.push(`stroke 1 ${f} is ${JSON.stringify(fieldOf(back, 1, f))} after the round trip`);
        const key = `strokes.1.${f}`;
        if (!(key in back.overrides) || !eq(back.overrides[key], OVERRIDE[f])) problems.push(`effect.overrides["${key}"] is ${JSON.stringify(back.overrides[key])}`);
        if (!eq(fieldOf(back, 2, f), fieldOf(planned0, 2, f))) problems.push(`stroke 2 ${f} changed to ${JSON.stringify(fieldOf(back, 2, f))}`);
        const replanned = roundTrip(mods.o.applyPlan(structuredClone(back), structuredClone(PLANS)));
        if (!eq(fieldOf(replanned, 1, f), OVERRIDE[f])) problems.push(`a re-plan reset stroke 1 ${f} to ${JSON.stringify(fieldOf(replanned, 1, f))}`);
        if (!eq(replanned.overrides[key], OVERRIDE[f])) problems.push(`a re-plan dropped overrides["${key}"]`);
      } catch (e) {
        problems.push(`threw: ${errMsg(e)}`);
      }
      ev.record(`override persists: ${f}`, problems.length ? problems : 'persists', `one applyOverride; survives serialize/parse and a re-plan; key strokes.1.${f}; stroke 2 untouched`, problems.length === 0);
      if (problems.length) failures.push(`${f}: ${problems.join('; ')}`);
    }

    expect(notListed, 'W3 fields without an override').toEqual([]);
    expect(failures, `W3 overrides that don't persist (threshold: all ${FIELDS.length} fields)`).toEqual([]);
  });
});
