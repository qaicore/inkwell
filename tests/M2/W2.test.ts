/// <reference types="node" />
// W2 (SPEC §10, Wonder): every response either validates against the schema or falls back cleanly: invalid -> one
// retry -> nearest-mask rule with a visible note. 100%, no crash.
//
// Recorded/synthetic responses (the SPEC M2 row allows it for W2), fed through the real modules with an injected
// transport; nothing here can reach the network:
//   - src/plan/schema.ts  validatePlan(text, ids) and PLAN_SCHEMA (the structured-output schema, §9)
//   - src/plan/baseline.ts nearestMaskPlan(input): the nearest-mask rule (§10 definitions: nearest mask, default
//     stiffness and layer)
//   - src/plan/plan.ts    planStrokes(input, transport): the plan call. `transport` returns Wonder's raw output
//     text for one attempt (or throws); planStrokes never sees the API itself.
// The response under test is Wonder's output text: { "strokes": [ { id, kind, anchor, bodyAngle, stiffness, layer,
// wobble, reason } ] } with one entry per stroke id asked about (§9's per-stroke fields; anchor in §7's shape).
// Corpus: a valid response (and two valid variants), then invalid ones: malformed JSON (empty, truncated, prose,
// trailing text, null, a bare list), each field missing in turn, each enum wrong, wrong types, out-of-range numbers,
// and the wrong stroke ids (missing, extra, duplicated, none).
// Scenarios, each through planStrokes:
//   1. valid first                -> Wonder's plan, 1 transport call, no note
//   2. invalid, then valid        -> Wonder's plan from the retry, exactly 2 calls
//   3. invalid, then invalid      -> exactly 2 calls, then the nearest-mask rule's plan, with a note
//   4. transport throws (twice; once then valid) -> no throw, at most 2 calls, and a rule plan always carries a note
// Plus: validatePlan accepts every valid response and rejects every invalid one; PLAN_SCHEMA requires every §9 field.
// Stricter readings, flagged for Qai:
//   - "visible note" is PlanResult.note, a non-empty string whenever the rule's plan is used (and null otherwise); the
//     plan panel showing it is UI, not checked here;
//   - out-of-range numbers are invalid: stiffness and wobble outside 0..1, bodyAngle outside [0, 360);
//   - a response must cover exactly the stroke ids asked about, once each;
//   - a concept prompt is any non-empty string; this test doesn't fix a vocabulary.
import { afterAll, describe, expect, it } from 'vitest';
import { Evidence } from '../helpers/evidence.ts';
import { errMsg, need, recorded } from '../helpers/engine.ts';
import type { PlanInput, PlanResult, PlanTransport, StrokePlan } from '../../src/plan/plan.ts';
import type { SamMask } from '../../src/sam/cache.ts';

type PlanModule = typeof import('../../src/plan/plan.ts');
type SchemaModule = typeof import('../../src/plan/schema.ts');
type BaselineModule = typeof import('../../src/plan/baseline.ts');

const ID = 'W2';
const FIELDS = ['id', 'kind', 'anchor', 'bodyAngle', 'stiffness', 'layer', 'wobble', 'reason'] as const;

const ev = new Evidence(ID, [
  'modules load',
  'PLAN_SCHEMA requires every plan field',
  'nearest-mask rule baseline',
  'validator accepts every valid response',
  'validator rejects every invalid response',
  'valid first: Wonder plan, no retry',
  'invalid then valid: exactly one retry',
  'invalid twice: nearest-mask fallback with a note',
  'transport errors: no crash, clean fallback',
  'no crash, 100% handled',
]);
afterAll(() => ev.write());

// ---------- synthetic frame: a person and a face mask on a 1080 x 1920 frame ----------

function boxMask(left: number, top: number, right: number, bottom: number, cell = 4): SamMask {
  const width = Math.round((right - left) / cell);
  const height = Math.round((bottom - top) / cell);
  return { width, height, raster: new Uint8Array(width * height).fill(1), bounds: { left, top, right, bottom }, confidence: 0.95 };
}

const PERSON = boxMask(340, 300, 740, 1800);
const FACE = boxMask(480, 320, 600, 470);
const line = (from: [number, number], to: [number, number], n = 32): [number, number, number][] =>
  Array.from({ length: n }, (_, i) => [from[0] + ((to[0] - from[0]) * i) / (n - 1), from[1] + ((to[1] - from[1]) * i) / (n - 1), 0.4 + 0.5 * Math.sin((Math.PI * i) / (n - 1))]);

const INPUT: PlanInput = {
  frame: 12,
  strokes: [
    { id: 1, points: line([540, 1000], [900, 1300]) }, // from the torso, far from the face
    { id: 2, points: line([520, 330], [470, 180]) }, // from the top of the head
    { id: 3, points: line([700, 1200], [1000, 1500]) },
  ],
  masks: { person: PERSON, face: FACE },
};
const IDS = INPUT.strokes.map((s) => s.id);

// ---------- the corpus ----------

type Obj = Record<string, unknown>;
const plan = (id: number, over: Obj = {}): Obj => ({
  id,
  kind: 'strand',
  anchor: { type: 'concept', prompt: 'person' },
  bodyAngle: 180,
  stiffness: 0.3,
  layer: 'behind',
  wobble: 0.5,
  reason: 'a tendril out of his back',
  ...over,
});
const VALID_OBJ = {
  strokes: [
    plan(1),
    plan(2, { kind: 'rigid', anchor: { type: 'concept', prompt: 'head' }, bodyAngle: 0, stiffness: 1, layer: 'front', wobble: 0.2, reason: 'a horn on his head' }),
    plan(3, { anchor: { type: 'point', time: 0.4, xy: [700, 1200] }, bodyAngle: 90, stiffness: 0, wobble: 1, reason: 'a rope from his right hip' }),
  ],
};
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const VALID = JSON.stringify(VALID_OBJ);
const VALID_VARIANTS: { name: string; text: string }[] = [
  { name: 'valid', text: VALID },
  { name: 'valid, strokes in another order', text: JSON.stringify({ strokes: [VALID_OBJ.strokes[2], VALID_OBJ.strokes[0], VALID_OBJ.strokes[1]] }) },
  { name: 'valid, pretty-printed, edge values', text: JSON.stringify({ strokes: VALID_OBJ.strokes.map((s, i) => ({ ...s, stiffness: i === 0 ? 0 : s.stiffness, wobble: i === 1 ? 1 : s.wobble, bodyAngle: i === 2 ? 359.5 : s.bodyAngle })) }, null, 2) },
];
const EXPECTED: Obj[] = VALID_OBJ.strokes;

function mutate(fn: (strokes: Obj[]) => void): string {
  const o = clone(VALID_OBJ);
  fn(o.strokes);
  return JSON.stringify(o);
}

const INVALID: { name: string; text: string }[] = [
  { name: 'malformed: empty', text: '' },
  { name: 'malformed: truncated', text: VALID.slice(0, Math.floor(VALID.length / 2)) },
  { name: 'malformed: prose', text: 'Stroke 1 is a tendril on his back; stroke 2 is a horn.' },
  { name: 'malformed: trailing text', text: `${VALID} Hope this helps!` },
  { name: 'malformed: null', text: 'null' },
  { name: 'malformed: bare list', text: JSON.stringify(VALID_OBJ.strokes) },
  { name: 'schema: strokes not a list', text: JSON.stringify({ strokes: { 1: VALID_OBJ.strokes[0] } }) },
  ...FIELDS.map((f) => ({ name: `missing field: ${f}`, text: mutate((s) => void delete s[1]![f]) })),
  { name: 'wrong enum: kind', text: mutate((s) => void (s[0]!.kind = 'floppy')) },
  { name: 'wrong enum: layer', text: mutate((s) => void (s[0]!.layer = 'middle')) },
  { name: 'wrong enum: anchor.type', text: mutate((s) => void (s[0]!.anchor = { type: 'bone', prompt: 'spine' })) },
  { name: 'wrong type: stiffness as string', text: mutate((s) => void (s[0]!.stiffness = '0.3')) },
  { name: 'wrong type: bodyAngle null', text: mutate((s) => void (s[0]!.bodyAngle = null)) },
  { name: 'wrong type: wobble boolean', text: mutate((s) => void (s[0]!.wobble = true)) },
  { name: 'wrong type: id as string', text: mutate((s) => void (s[0]!.id = '1')) },
  { name: 'wrong type: reason a number', text: mutate((s) => void (s[0]!.reason = 5)) },
  { name: 'wrong type: anchor a string', text: mutate((s) => void (s[0]!.anchor = 'person')) },
  { name: 'anchor: empty concept prompt', text: mutate((s) => void (s[0]!.anchor = { type: 'concept', prompt: '' })) },
  { name: 'anchor: point without xy', text: mutate((s) => void (s[2]!.anchor = { type: 'point', time: 0.4 })) },
  { name: 'anchor: point xy of 3 numbers', text: mutate((s) => void (s[2]!.anchor = { type: 'point', time: 0.4, xy: [1, 2, 3] })) },
  { name: 'range: stiffness 1.5', text: mutate((s) => void (s[0]!.stiffness = 1.5)) },
  { name: 'range: stiffness -0.1', text: mutate((s) => void (s[0]!.stiffness = -0.1)) },
  { name: 'range: wobble 2', text: mutate((s) => void (s[0]!.wobble = 2)) },
  { name: 'range: bodyAngle 400', text: mutate((s) => void (s[0]!.bodyAngle = 400)) },
  { name: 'range: bodyAngle -30', text: mutate((s) => void (s[0]!.bodyAngle = -30)) },
  { name: 'ids: stroke 3 missing', text: mutate((s) => void s.pop()) },
  { name: 'ids: extra stroke 4', text: mutate((s) => void s.push(plan(4))) },
  { name: 'ids: stroke 1 twice', text: mutate((s) => void (s[1] = plan(1))) },
  { name: 'ids: no strokes', text: JSON.stringify({ strokes: [] }) },
];

// ---------- helpers ----------

interface Script {
  calls: number;
  transport: PlanTransport;
}
/** A transport that answers attempt n with replies[n]; a reply of Error throws; past the script it throws too. */
function script(replies: (string | Error)[]): Script {
  const s: Script = {
    calls: 0,
    transport: async () => {
      const r = replies[s.calls];
      s.calls++;
      if (r === undefined) throw new Error(`transport called ${s.calls} times; the scenario allows ${replies.length}`);
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return s;
}

const pick = (p: unknown): Obj => Object.fromEntries(FIELDS.map((f) => [f, (p as Obj | null)?.[f]]));
const sortById = (ps: readonly unknown[]): Obj[] => [...ps].map(pick).sort((a, b) => (a.id as number) - (b.id as number));
const samePlans = (a: readonly unknown[], b: readonly unknown[]) => JSON.stringify(sortById(a)) === JSON.stringify(sortById(b));

async function run(mod: PlanModule, replies: (string | Error)[]): Promise<{ result: PlanResult | null; calls: number; threw: string | null }> {
  const s = script(replies);
  try {
    const result = await mod.planStrokes(structuredClone(INPUT), s.transport);
    return { result, calls: s.calls, threw: null };
  } catch (e) {
    return { result: null, calls: s.calls, threw: errMsg(e) };
  }
}

/** Every object in a JSON schema tree that has `properties` containing all of `fields`, with its `required`. */
function findRequired(schema: unknown, fields: readonly string[]): string[] | null {
  const stack: unknown[] = [schema];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== 'object') continue;
    const o = n as Obj;
    const props = o.properties as Obj | undefined;
    if (props && fields.every((f) => f in props)) return Array.isArray(o.required) ? (o.required as string[]) : [];
    for (const v of Object.values(o)) stack.push(v);
  }
  return null;
}

// ---------- tests ----------

describe('W2 schema check, one retry, nearest-mask fallback', () => {
  it('W2 every response validates or falls back cleanly', async () => {
    const mods = await recorded(ev, 'modules load', 'src/plan/plan.ts (planStrokes), src/plan/schema.ts (validatePlan, PLAN_SCHEMA), src/plan/baseline.ts (nearestMaskPlan)', async () => ({
      plan: await need('src/plan/plan.ts', { planStrokes: 'function' }, () => import('../../src/plan/plan.ts')),
      schema: await need('src/plan/schema.ts', { validatePlan: 'function', PLAN_SCHEMA: 'object' }, () => import('../../src/plan/schema.ts')),
      baseline: await need('src/plan/baseline.ts', { nearestMaskPlan: 'function' }, () => import('../../src/plan/baseline.ts')),
    })) as { plan: PlanModule; schema: SchemaModule; baseline: BaselineModule };

    // The schema sent to Wonder names every §9 field as required.
    const required = findRequired(mods.schema.PLAN_SCHEMA, FIELDS.filter((f) => f !== 'id'));
    const missingReq = required === null ? [...FIELDS] : FIELDS.filter((f) => !required.includes(f));
    ev.record('PLAN_SCHEMA requires every plan field', required ?? 'no stroke object with all the plan fields', `required: ${FIELDS.join(', ')}`, missingReq.length === 0,
      missingReq.length ? `not required: ${missingReq.join(', ')}` : '');

    // The rule: one plan per stroke, concept anchors on the masks it was given, default stiffness and layer for all.
    const rule = mods.baseline.nearestMaskPlan(structuredClone(INPUT)) as StrokePlan[];
    const ruleIds = rule.map((p) => p.id).sort((a, b) => a - b);
    const prompts = rule.map((p) => (p.anchor as { type?: string; prompt?: string }).type === 'concept' ? (p.anchor as { prompt: string }).prompt : null);
    const ruleOk =
      JSON.stringify(ruleIds) === JSON.stringify(IDS) &&
      prompts.every((p) => p === 'person' || p === 'face') &&
      prompts[rule.findIndex((p) => p.id === 1)] === 'person' &&
      new Set(rule.map((p) => p.stiffness)).size === 1 &&
      new Set(rule.map((p) => p.layer)).size === 1;
    ev.record('nearest-mask rule baseline', rule.map(pick), 'one plan per stroke; concept anchor "person" or "face" (the masks given); the torso stroke on "person"; one default stiffness and layer', ruleOk);

    // The validator on its own.
    const accepts = VALID_VARIANTS.map((v) => ({ name: v.name, r: mods.schema.validatePlan(v.text, IDS) }));
    const badAccept = accepts.filter((a) => !a.r.ok || !samePlans(a.r.strokes, EXPECTED)).map((a) => `${a.name}: ${a.r.ok ? 'fields differ from the response' : a.r.problems.join(', ')}`);
    ev.record('validator accepts every valid response', `${accepts.length - badAccept.length}/${accepts.length}`, `${accepts.length}/${accepts.length}, fields as sent`, badAccept.length === 0, badAccept.join('; '));
    const rejects = INVALID.map((b) => {
      try {
        return { name: b.name, ok: mods.schema.validatePlan(b.text, IDS).ok === false, err: '' };
      } catch (e) {
        return { name: b.name, ok: false, err: `threw: ${errMsg(e)}` };
      }
    });
    const badReject = rejects.filter((r) => !r.ok).map((r) => `${r.name}${r.err ? ` (${r.err})` : ' (accepted)'}`);
    ev.record('validator rejects every invalid response', `${rejects.length - badReject.length}/${rejects.length}`, `${rejects.length}/${rejects.length}, never a throw`, badReject.length === 0, badReject.join('; '));

    const outcomes: { scenario: string; ok: boolean; why: string }[] = [];
    const note = (r: PlanResult | null) => typeof r?.note === 'string' && r.note.trim().length > 0;

    // 1. valid first
    {
      const failures: string[] = [];
      for (const v of VALID_VARIANTS) {
        const o = await run(mods.plan, [v.text]);
        const ok = !o.threw && o.calls === 1 && o.result?.source === 'wonder' && o.result.attempts === 1 && samePlans(o.result.strokes, EXPECTED) && (o.result.note === null || o.result.note === undefined || o.result.note === '');
        outcomes.push({ scenario: `valid first (${v.name})`, ok, why: o.threw ?? `calls ${o.calls}, source ${o.result?.source}, attempts ${o.result?.attempts}, note ${JSON.stringify(o.result?.note)}` });
        if (!ok) failures.push(v.name);
      }
      ev.record('valid first: Wonder plan, no retry', `${VALID_VARIANTS.length - failures.length}/${VALID_VARIANTS.length}`, "source 'wonder', 1 call, attempts 1, the response's fields, no note", failures.length === 0, failures.join('; '));
    }

    // 2. invalid, then valid
    {
      const failures: string[] = [];
      for (const b of INVALID) {
        const o = await run(mods.plan, [b.text, VALID]);
        const ok = !o.threw && o.calls === 2 && o.result?.source === 'wonder' && o.result.attempts === 2 && samePlans(o.result.strokes, EXPECTED);
        outcomes.push({ scenario: `invalid then valid (${b.name})`, ok, why: o.threw ?? `calls ${o.calls}, source ${o.result?.source}` });
        if (!ok) failures.push(`${b.name}: ${o.threw ?? `calls ${o.calls}, source ${o.result?.source}, attempts ${o.result?.attempts}`}`);
      }
      ev.record('invalid then valid: exactly one retry', `${INVALID.length - failures.length}/${INVALID.length}`, "exactly 2 calls, then source 'wonder' with the retry's fields", failures.length === 0, failures.slice(0, 10).join('; '));
    }

    // 3. invalid, then a second, different invalid one
    {
      const failures: string[] = [];
      for (let i = 0; i < INVALID.length; i++) {
        const a = INVALID[i]!;
        const b = INVALID[(i + 7) % INVALID.length]!;
        const o = await run(mods.plan, [a.text, b.text]);
        const ok = !o.threw && o.calls === 2 && o.result?.source === 'rule' && samePlans(o.result.strokes, rule) && note(o.result);
        outcomes.push({ scenario: `invalid twice (${a.name} / ${b.name})`, ok, why: o.threw ?? `calls ${o.calls}, source ${o.result?.source}` });
        if (!ok) failures.push(`${a.name} / ${b.name}: ${o.threw ?? `calls ${o.calls}, source ${o.result?.source}, note ${JSON.stringify(o.result?.note)}`}`);
      }
      ev.record('invalid twice: nearest-mask fallback with a note', `${INVALID.length - failures.length}/${INVALID.length}`, "exactly 2 calls, then source 'rule' with nearestMaskPlan's plan and a non-empty note", failures.length === 0, failures.slice(0, 10).join('; '));
    }

    // 4. the transport itself fails
    {
      const failures: string[] = [];
      const cases: { name: string; replies: (string | Error)[] }[] = [
        { name: 'throws twice', replies: [new Error('connection reset'), new Error('connection reset')] },
        { name: 'throws, then valid', replies: [new Error('timeout'), VALID] },
        { name: 'invalid, then throws', replies: [INVALID[0]!.text, new Error('timeout')] },
      ];
      for (const c of cases) {
        const o = await run(mods.plan, c.replies);
        const r = o.result;
        const clean = !!r && ((r.source === 'wonder' && samePlans(r.strokes, EXPECTED)) || (r.source === 'rule' && samePlans(r.strokes, rule) && note(r)));
        const ok = !o.threw && o.calls <= 2 && clean;
        outcomes.push({ scenario: `transport ${c.name}`, ok, why: o.threw ?? `calls ${o.calls}, source ${r?.source}` });
        if (!ok) failures.push(`${c.name}: ${o.threw ?? `calls ${o.calls}, source ${r?.source}, note ${JSON.stringify(r?.note)}`}`);
      }
      ev.record('transport errors: no crash, clean fallback', `${cases.length - failures.length}/${cases.length}`, "no throw, <= 2 calls; Wonder's valid plan, or the rule's plan with a note", failures.length === 0, failures.join('; '));
    }

    const handled = outcomes.filter((o) => o.ok).length;
    const pct = (100 * handled) / outcomes.length;
    ev.record('no crash, 100% handled', `${handled}/${outcomes.length} (${pct.toFixed(1)}%)`, '100%, no crash', handled === outcomes.length,
      outcomes.filter((o) => !o.ok).slice(0, 8).map((o) => `${o.scenario}: ${o.why}`).join('; '));

    expect(missingReq, 'W2 PLAN_SCHEMA does not require these fields').toEqual([]);
    expect(ruleOk, 'W2 nearestMaskPlan is not the nearest-mask rule with default stiffness and layer').toBe(true);
    expect(badAccept, 'W2 valid responses the validator rejected').toEqual([]);
    expect(badReject, 'W2 invalid responses the validator accepted').toEqual([]);
    expect(outcomes.filter((o) => !o.ok).map((o) => `${o.scenario}: ${o.why}`), 'W2 responses not handled cleanly (threshold 100%)').toEqual([]);
  }, 120_000);
});
