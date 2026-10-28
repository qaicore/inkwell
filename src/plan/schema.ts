// The stroke plan's fixed schema (SPEC §9). PLAN_SCHEMA goes to Muse Wonder
// as its structured output format; validatePlan checks what comes back
// against the same rules, plus the ones the schema leaves out: ranges and
// lengths (strict structured output doesn't take them; the probe's facing
// schema worked without them) and each stroke asked about exactly once.
// Wonder's output is untrusted text: nothing here throws on it.
import type { StrokePlan } from './plan.ts';

const NUMBER = { type: 'number' } as const;
const XY = { type: 'array', items: NUMBER, description: '[x, y] in frame pixels' } as const;

export const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['strokes'],
  properties: {
    strokes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'kind', 'anchor', 'bodyAngle', 'stiffness', 'layer', 'wobble', 'reason'],
        properties: {
          id: { type: 'integer', description: 'the number drawn at the stroke root' },
          kind: { type: 'string', enum: ['strand', 'rigid'], description: 'rigid follows the body exactly (horns, halo); strand swings (tails, tendrils, hair)' },
          anchor: {
            description: 'what the root attaches to',
            anyOf: [
              {
                type: 'object',
                additionalProperties: false,
                required: ['type', 'prompt'],
                properties: { type: { type: 'string', enum: ['concept'] }, prompt: { type: 'string', description: 'a body part SAM can find, like "person", "head", "hand"' } },
              },
              {
                type: 'object',
                additionalProperties: false,
                required: ['type', 'time', 'xy'],
                properties: { type: { type: 'string', enum: ['point'] }, time: { type: 'number', description: 'seconds into the clip' }, xy: XY },
              },
              {
                type: 'object',
                additionalProperties: false,
                required: ['type', 'xy'],
                properties: { type: { type: 'string', enum: ['ground'] }, xy: XY },
              },
            ],
          },
          bodyAngle: { type: 'number', description: '0 to under 360 degrees around the torso: 0 chest, 90 his right side, 180 center of back, 270 his left side' },
          stiffness: { type: 'number', description: '0 to 1: 0 hangs like a rope, 1 keeps the drawn shape' },
          layer: { type: 'string', enum: ['behind', 'front'], description: 'behind or in front of the body, facing the camera' },
          wobble: { type: 'number', description: '0 to 1: how much the line boils' },
          reason: { type: 'string', description: 'one line on why' },
        },
      },
    },
  },
} as const;

export type PlanCheck = { ok: true; strokes: StrokePlan[] } | { ok: false; problems: string[] };

// Wonder's output text against the schema, for the stroke ids it was asked
// about. The plans come back with only the schema's fields.
export function validatePlan(text: string, ids: readonly number[]): PlanCheck {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, problems: ['the output is not JSON'] };
  }
  const list = (json as { strokes?: unknown } | null)?.strokes;
  if (!json || typeof json !== 'object' || Array.isArray(json) || !Array.isArray(list)) return { ok: false, problems: ['the output has no "strokes" list'] };
  const problems: string[] = [];
  const strokes: StrokePlan[] = [];
  list.forEach((item, i) => {
    const p = checkStroke(item);
    if (typeof p === 'string') problems.push(`strokes[${i}]: ${p}`);
    else strokes.push(p);
  });
  // Ids as sent, valid entries or not, so a bad entry isn't also "missing".
  const got = list.flatMap((item) => (Number.isInteger((item as { id?: unknown } | null)?.id) ? [(item as { id: number }).id] : []));
  const missing = ids.filter((id) => !got.includes(id));
  const extra = got.filter((id) => !ids.includes(id));
  const twice = got.filter((id, i) => got.indexOf(id) !== i);
  if (missing.length) problems.push(`no plan for stroke ${missing.join(', ')}`);
  if (extra.length) problems.push(`plans for strokes not asked about: ${extra.join(', ')}`);
  if (twice.length) problems.push(`more than one plan for stroke ${[...new Set(twice)].join(', ')}`);
  return problems.length ? { ok: false, problems } : { ok: true, strokes };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const in01 = (v: unknown): v is number => isNum(v) && v >= 0 && v <= 1;
const isXy = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every(isNum);

function checkStroke(item: unknown): StrokePlan | string {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return 'not an object';
  const o = item as Record<string, unknown>;
  if (!Number.isInteger(o.id)) return 'id is not an integer';
  if (o.kind !== 'strand' && o.kind !== 'rigid') return `kind ${JSON.stringify(o.kind)} is not strand or rigid`;
  const anchor = checkAnchor(o.anchor);
  if (typeof anchor === 'string') return anchor;
  if (!isNum(o.bodyAngle) || o.bodyAngle < 0 || o.bodyAngle >= 360) return `bodyAngle ${JSON.stringify(o.bodyAngle)} is not in [0, 360)`;
  if (!in01(o.stiffness)) return `stiffness ${JSON.stringify(o.stiffness)} is not in 0..1`;
  if (o.layer !== 'behind' && o.layer !== 'front') return `layer ${JSON.stringify(o.layer)} is not behind or front`;
  if (!in01(o.wobble)) return `wobble ${JSON.stringify(o.wobble)} is not in 0..1`;
  if (typeof o.reason !== 'string' || !o.reason.trim()) return 'reason is not a line of text';
  return { id: o.id as number, kind: o.kind, anchor, bodyAngle: o.bodyAngle, stiffness: o.stiffness, layer: o.layer, wobble: o.wobble, reason: o.reason };
}

function checkAnchor(v: unknown): StrokePlan['anchor'] | string {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'anchor is not an object';
  const a = v as Record<string, unknown>;
  if (a.type === 'concept') return typeof a.prompt === 'string' && a.prompt.trim() ? { type: 'concept', prompt: a.prompt } : 'a concept anchor needs a prompt';
  if (a.type === 'point') return isNum(a.time) && a.time >= 0 && isXy(a.xy) ? { type: 'point', time: a.time, xy: [a.xy[0], a.xy[1]] } : 'a point anchor needs a time and an [x, y]';
  if (a.type === 'ground') return isXy(a.xy) ? { type: 'ground', xy: [a.xy[0], a.xy[1]] } : 'a ground anchor needs an [x, y]';
  return `anchor type ${JSON.stringify(a.type)} is not concept, point or ground`;
}
