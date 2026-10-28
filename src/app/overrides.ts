// The plan panel's one-tap overrides (SPEC §10 W3). Wonder (or the rule)
// fills in each stroke's plan; any field Qai taps is recorded in
// effect.overrides under its field path, "strokes.<id>.<field>", and wins
// over every later plan. So a re-plan, after a redraw say, never undoes a
// choice he made by hand, and the choice travels with the effect JSON.
import type { BrushId, Effect, Stroke } from '../types/effect.ts';
import type { StrokePlan } from '../plan/plan.ts';

export const OVERRIDE_FIELDS = ['kind', 'anchor', 'bodyAngle', 'stiffness', 'layer', 'wobble', 'brush'] as const;
export type OverrideField = (typeof OVERRIDE_FIELDS)[number];

const keyOf = (id: number, field: OverrideField) => `strokes.${id}.${field}`;

// Writes each plan into its stroke, then puts the overrides back on top.
export function applyPlan(effect: Effect, plans: readonly StrokePlan[]): Effect {
  const out = structuredClone(effect);
  for (const plan of plans) {
    const stroke = out.strokes.find((s) => s.id === plan.id);
    if (!stroke) continue;
    stroke.kind = plan.kind;
    stroke.anchor = structuredClone(plan.anchor);
    stroke.bodyAngle = plan.bodyAngle;
    stroke.stiffness = plan.stiffness;
    stroke.wobble = plan.wobble;
    stroke.views.front.layer = plan.layer; // the plan reads the drawing frame, which is the front view
  }
  for (const stroke of out.strokes) {
    for (const field of OVERRIDE_FIELDS) {
      const key = keyOf(stroke.id, field);
      if (key in out.overrides) setField(stroke, field, structuredClone(out.overrides[key]));
    }
  }
  return out;
}

// One tap: sets the field on that stroke and records it as an override.
export function applyOverride(effect: Effect, strokeId: number, field: OverrideField, value: unknown): Effect {
  if (!OVERRIDE_FIELDS.includes(field)) throw new Error(`${field} is not a field the plan panel overrides`);
  const out = structuredClone(effect);
  const stroke = out.strokes.find((s) => s.id === strokeId);
  if (!stroke) throw new Error(`no stroke ${strokeId}`);
  setField(stroke, field, structuredClone(value));
  out.overrides[keyOf(strokeId, field)] = structuredClone(value);
  return out;
}

// Taps "back to the plan": forgets the override (the next plan sets it).
export function clearOverride(effect: Effect, strokeId: number, field: OverrideField): Effect {
  const out = structuredClone(effect);
  delete out.overrides[keyOf(strokeId, field)];
  return out;
}

export function isOverridden(effect: Effect, strokeId: number, field: OverrideField): boolean {
  return keyOf(strokeId, field) in effect.overrides;
}

function setField(stroke: Stroke, field: OverrideField, value: unknown) {
  switch (field) {
    case 'layer':
      stroke.views.front.layer = value as Stroke['views']['front']['layer'];
      break;
    case 'brush':
      stroke.brush = value as BrushId;
      break;
    case 'kind':
      stroke.kind = value as Stroke['kind'];
      break;
    case 'anchor':
      stroke.anchor = value as Stroke['anchor'];
      break;
    default:
      stroke[field] = value as number;
  }
}
