/// <reference types="node" />
// W1 (SPEC §10, Wonder): attachment accuracy on 30 labeled strokes (fixtures/strokes/labels.json) vs the nearest-mask
// rule; also report stiffness and layer accuracy. Threshold: >= 21/30 and strictly better than the rule.
//
// Offline only: Wonder's plan responses are read from the cache, never requested. Inputs, read at runtime
// (missing = FAIL, no fallback):
//   - fixtures/strokes/labels.json (Qai's, §11):
//       { "strokes": [ { "id": 1, "attach": ["head"], "stiffness": 0.9, "layer": "front" }, ... ] }   exactly 30
//     `attach` lists the anchor concept prompts Qai accepts for that stroke (the first is his own word); "point" in
//     the list means a point anchor is right for it.
//   - fixtures/strokes/wonder-plan.json (the cached Wonder plan calls, one per drawing, §9), in the shape of the
//     probe's cached facing call:
//       { "model": "muse-wonder-...", "calls": [ { "clip": "side-step", "clipSha256": "...", "frame": 40,
//         "strokes": [ { "id": 1, "points": [[x, y, pressure], ...] } ],       <- the strokes as drawn, clip px
//         "attempts": [ { "status": "completed", "text": "<Wonder's output text>" }, ... ] } ] }
//   - fixtures/<clip>/sam-person.json and sam-face.json for every clip a call names (the masks on the drawing frame
//     that the nearest-mask rule picks from; cache shape as in fixtures/probe/).
// Measured on the real modules: each call is replayed through src/plan/plan.ts planStrokes() with a transport that
// returns the cached attempts in order (so the schema check and the one retry run as in the app); the rule is
// src/plan/baseline.ts nearestMaskPlan() on the same input; masks from src/sam/cache.ts masksFromCache().
// Attachment is right when the plan's concept prompt, lowercased and trimmed, is in the label's `attach` list (also
// lowercased and trimmed), or the plan's anchor is a point and `attach` has "point".
// Stricter readings, flagged for Qai:
//   - a stroke whose call fell back to the rule counts as wrong for Wonder (Wonder didn't plan it);
//   - if planStrokes asks for an attempt the cache doesn't have, the cache is incomplete: FAIL;
//   - the cached responses must be Muse Wonder's (model "muse-wonder..."), for the same clip as the SAM masks;
//   - the 30 labeled strokes and the cached strokes must be the same set, once each;
//   - stiffness counts as right within 0.15 of the label (report only; SPEC sets no stiffness or layer threshold).
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Evidence, ROOT, readText } from '../helpers/evidence.ts';
import { errMsg, need, recorded } from '../helpers/engine.ts';
import type { PlanInput, PlanResult, PlanTransport, StrokePlan } from '../../src/plan/plan.ts';
import type { SamMask } from '../../src/sam/cache.ts';

type PlanModule = typeof import('../../src/plan/plan.ts');
type BaselineModule = typeof import('../../src/plan/baseline.ts');
type SamCacheModule = typeof import('../../src/sam/cache.ts');

const ID = 'W1';
const N = 30; // labeled strokes (SPEC §10 W1, §11)
const MIN_RIGHT = 21; // >= 21/30
const STIFF_TOL = 0.15; // report only
const LABELS = 'fixtures/strokes/labels.json';
const PLANS = 'fixtures/strokes/wonder-plan.json';

const ev = new Evidence(ID, [
  'modules load',
  'labels.json: 30 labeled strokes',
  'cached Wonder plan calls',
  'SAM masks for the drawing frames',
  'cached responses complete',
  'attachment: Wonder >= 21/30',
  'attachment: Wonder strictly better than the nearest-mask rule',
  'stiffness and layer accuracy (report)',
]);
afterAll(() => ev.write());

type V2 = [number, number];
interface Label {
  id: number;
  attach: string[];
  stiffness: number;
  layer: 'front' | 'behind';
}
interface Call {
  clip: string;
  clipSha256: string;
  frame: number;
  strokes: { id: number; points: [number, number, number][] }[];
  attempts: { status?: string; text: string }[];
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const norm = (s: string) => s.trim().toLowerCase();

function readJson(rel: string, who: string): unknown {
  const p = join(ROOT, rel);
  if (!existsSync(p)) throw new Error(`${rel} missing: ${who}`);
  try {
    return JSON.parse(readText(p)) as unknown;
  } catch (e) {
    throw new Error(`${rel} is not valid JSON: ${errMsg(e)}`);
  }
}

function loadLabels(): Label[] {
  const j = readJson(LABELS, 'Qai must add it: 30 test strokes drawn in the app, each with what it attaches to, its stiffness and its layer (SPEC §11)') as { strokes?: unknown } | null;
  const list = Array.isArray(j?.strokes) ? (j.strokes as Record<string, unknown>[]) : null;
  if (!list) throw new Error(`${LABELS} has no "strokes" list`);
  const bad = list.filter((l) => !Number.isInteger(l?.id) || !Array.isArray(l.attach) || l.attach.length === 0 || !l.attach.every((a) => typeof a === 'string' && a.trim()) ||
    !isNum(l.stiffness) || l.stiffness < 0 || l.stiffness > 1 || (l.layer !== 'front' && l.layer !== 'behind'));
  if (bad.length) throw new Error(`${LABELS}: ${bad.length} entries aren't { id, attach: [concepts], stiffness 0..1, layer front|behind } (first: ${JSON.stringify(bad[0])})`);
  const ids = list.map((l) => l.id as number);
  if (new Set(ids).size !== ids.length) throw new Error(`${LABELS} repeats a stroke id`);
  if (list.length !== N) throw new Error(`${LABELS} labels ${list.length} strokes; W1 is scored on ${N}`);
  return list as unknown as Label[];
}

function loadCalls(): { model: string; calls: Call[] } {
  const j = readJson(PLANS, 'Qai must add it: the cached Wonder plan responses for the 30 labeled strokes, recorded once he says go (SPEC §3, §9); tests never call Wonder') as
    { model?: unknown; calls?: unknown } | null;
  if (typeof j?.model !== 'string' || !/muse-wonder/i.test(j.model)) throw new Error(`${PLANS} "model" is ${JSON.stringify(j?.model)}: W1 is measured on Muse Wonder output only (SPEC §3)`);
  const calls = Array.isArray(j.calls) ? (j.calls as Record<string, unknown>[]) : null;
  if (!calls || calls.length === 0) throw new Error(`${PLANS} has no "calls"`);
  calls.forEach((c, i) => {
    const where = `${PLANS} calls[${i}]`;
    if (typeof c.clip !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(c.clip)) throw new Error(`${where} has no clip id`);
    if (typeof c.clipSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(c.clipSha256)) throw new Error(`${where} has no clipSha256`);
    if (!Number.isInteger(c.frame) || (c.frame as number) < 0) throw new Error(`${where} has no drawing frame`);
    const strokes = c.strokes as { id?: unknown; points?: unknown }[] | undefined;
    if (!Array.isArray(strokes) || strokes.length === 0 || !strokes.every((s) => Number.isInteger(s?.id) && Array.isArray(s.points) && s.points.length >= 2 &&
      (s.points as unknown[]).every((p) => Array.isArray(p) && p.length === 3 && p.every(isNum)))) {
      throw new Error(`${where} strokes aren't [{ id, points: [[x, y, pressure], ...] }]`);
    }
    const attempts = c.attempts as { text?: unknown }[] | undefined;
    if (!Array.isArray(attempts) || attempts.length === 0 || !attempts.every((a) => typeof a?.text === 'string')) throw new Error(`${where} has no cached attempts with output text`);
  });
  return { model: j.model, calls: calls as unknown as Call[] };
}

function samJson(clip: string, name: string): Record<string, unknown> {
  const rel = `fixtures/${clip}/${name}`;
  const j = readJson(rel, `Qai must add it: npm run fixtures:refresh -- ${clip}, once he says go (SPEC §3, §9)`) as Record<string, unknown> | null;
  if (j?.model !== 'sam-3.1') throw new Error(`${rel} "model" is ${JSON.stringify(j?.model)}, not sam-3.1`);
  return j;
}

const framesOf = (j: Record<string, unknown>): number => {
  const n = (j.usage as { video_frames_processed?: unknown } | undefined)?.video_frames_processed;
  if (!Number.isInteger(n) || (n as number) < 1) throw new Error('SAM cache has no usage.video_frames_processed');
  return n as number;
};

function attachedRight(p: StrokePlan | undefined, label: Label): boolean {
  if (!p) return false;
  const a = p.anchor as { type?: string; prompt?: unknown };
  const accepted = label.attach.map(norm);
  if (a.type === 'concept' && typeof a.prompt === 'string') return accepted.includes(norm(a.prompt));
  if (a.type === 'point') return accepted.includes('point');
  return false;
}

describe('W1 Wonder attachment vs the nearest-mask rule', () => {
  it('W1 Wonder attaches >= 21 of 30 labeled strokes right and beats the nearest-mask rule', async () => {
    const mods = await recorded(ev, 'modules load', 'src/plan/plan.ts (planStrokes), src/plan/baseline.ts (nearestMaskPlan), src/sam/cache.ts (masksFromCache)', async () => ({
      plan: await need('src/plan/plan.ts', { planStrokes: 'function' }, () => import('../../src/plan/plan.ts')),
      baseline: await need('src/plan/baseline.ts', { nearestMaskPlan: 'function' }, () => import('../../src/plan/baseline.ts')),
      cache: await need('src/sam/cache.ts', { masksFromCache: 'function' }, () => import('../../src/sam/cache.ts')),
    })).catch(() => null) as { plan: PlanModule; baseline: BaselineModule; cache: SamCacheModule } | null;

    // Inputs are checked even when the modules are missing, so every missing file is reported at once.
    const labels = await recorded(ev, 'labels.json: 30 labeled strokes', `${LABELS}: exactly ${N} strokes with attach, stiffness, layer`, loadLabels, (l) => l.length).catch((e: unknown) => e as Error);
    const cached = await recorded(ev, 'cached Wonder plan calls', `${PLANS}: Muse Wonder responses covering the ${N} labeled strokes`, () => {
      const c = loadCalls();
      if (Array.isArray(labels)) {
        const cachedIds = c.calls.flatMap((k) => k.strokes.map((s) => s.id));
        const labelIds = labels.map((l) => l.id);
        const missing = labelIds.filter((i) => !cachedIds.includes(i));
        const extra = cachedIds.filter((i) => !labelIds.includes(i));
        const twice = cachedIds.filter((i, k) => cachedIds.indexOf(i) !== k);
        if (missing.length || extra.length || twice.length) throw new Error(`${PLANS} strokes vs ${LABELS}: missing ${JSON.stringify(missing)}, unlabeled ${JSON.stringify(extra)}, cached twice ${JSON.stringify(twice)}`);
      }
      return c;
    }, (c) => ({ model: c.model, calls: c.calls.length, strokes: c.calls.reduce((n, k) => n + k.strokes.length, 0) })).catch((e: unknown) => e as Error);
    if (labels instanceof Error) throw labels;
    if (cached instanceof Error) throw cached;
    if (!mods) throw new Error('W1 modules missing (see "modules load")');

    // The masks on each drawing frame.
    const inputs = await recorded(ev, 'SAM masks for the drawing frames', 'sam-person.json and sam-face.json (SAM 3.1, same clip hash as the call) for every clip a call names', async () => {
      const byClip = new Map<string, { person: (SamMask | null)[]; face: (SamMask | null)[]; sha: string }>();
      const out: PlanInput[] = [];
      for (const c of cached.calls) {
        if (!byClip.has(c.clip)) {
          const pj = samJson(c.clip, 'sam-person.json');
          const fj = samJson(c.clip, 'sam-face.json');
          if (pj.clipSha256 !== fj.clipSha256) throw new Error(`fixtures/${c.clip}/sam-person.json and sam-face.json are for different clips`);
          byClip.set(c.clip, {
            person: await mods.cache.masksFromCache(pj, framesOf(pj)),
            face: await mods.cache.masksFromCache(fj, framesOf(fj)),
            sha: pj.clipSha256 as string,
          });
        }
        const m = byClip.get(c.clip)!;
        if (m.sha !== c.clipSha256) throw new Error(`${PLANS} call on ${c.clip} frame ${c.frame} is for another clip hash than fixtures/${c.clip}/sam-person.json`);
        if (c.frame >= m.person.length) throw new Error(`${PLANS} call on ${c.clip} frame ${c.frame} is past the clip's ${m.person.length} frames`);
        out.push({ frame: c.frame, strokes: c.strokes, masks: { person: m.person[c.frame] ?? null, face: m.face[c.frame] ?? null } });
      }
      return out;
    }, (i) => `${i.length} drawing frames`);

    // Replay each call through the real plan call; the rule on the same input.
    const wonder = new Map<number, StrokePlan>();
    const rule = new Map<number, StrokePlan>();
    const incomplete: string[] = [];
    const fellBack: string[] = [];
    for (let i = 0; i < cached.calls.length; i++) {
      const c = cached.calls[i]!;
      const input = inputs[i]!;
      let n = 0;
      const transport: PlanTransport = async () => {
        const a = c.attempts[n++];
        if (!a) {
          incomplete.push(`${c.clip} frame ${c.frame}: attempt ${n} asked for, ${c.attempts.length} cached`);
          throw new Error('not in the cache');
        }
        return a.text;
      };
      const result: PlanResult = await mods.plan.planStrokes(structuredClone(input), transport);
      if (result.source === 'wonder') for (const p of result.strokes) wonder.set(p.id, p);
      else fellBack.push(`${c.clip} frame ${c.frame} (${result.note ?? 'no note'})`);
      for (const p of mods.baseline.nearestMaskPlan(structuredClone(input))) rule.set(p.id, p);
    }
    ev.record('cached responses complete', incomplete.length ? incomplete : 'every attempt planStrokes asked for was cached', 'no attempt missing from the cache', incomplete.length === 0);

    const score = (plans: Map<number, StrokePlan>) => {
      let attach = 0;
      let stiff = 0;
      let layer = 0;
      const wrong: { id: number; got: unknown; want: string[] }[] = [];
      for (const l of labels) {
        const p = plans.get(l.id);
        if (attachedRight(p, l)) attach++;
        else wrong.push({ id: l.id, got: p?.anchor ?? null, want: l.attach });
        if (p && Math.abs(p.stiffness - l.stiffness) <= STIFF_TOL) stiff++;
        if (p && p.layer === l.layer) layer++;
      }
      return { attach, stiff, layer, wrong };
    };
    const w = score(wonder);
    const r = score(rule);
    ev.record('attachment: Wonder >= 21/30', `${w.attach}/${N}`, `>= ${MIN_RIGHT}/${N}`, w.attach >= MIN_RIGHT,
      `${fellBack.length ? `fell back to the rule (counted wrong for Wonder): ${fellBack.join('; ')}; ` : ''}wrong: ${JSON.stringify(w.wrong.slice(0, 10))}`);
    ev.record('attachment: Wonder strictly better than the nearest-mask rule', { wonder: w.attach, rule: r.attach }, 'wonder > rule, same 30 strokes', w.attach > r.attach);
    ev.record('stiffness and layer accuracy (report)', { wonder: { stiffness: `${w.stiff}/${N}`, layer: `${w.layer}/${N}` }, rule: { stiffness: `${r.stiff}/${N}`, layer: `${r.layer}/${N}` } },
      `reported, no threshold (stiffness right within ${STIFF_TOL})`, true);

    expect(incomplete, 'W1 cached Wonder responses incomplete').toEqual([]);
    expect(w.attach, `W1 Wonder attached ${w.attach}/${N} right (threshold >= ${MIN_RIGHT})`).toBeGreaterThanOrEqual(MIN_RIGHT);
    expect(w.attach, `W1 Wonder ${w.attach} vs rule ${r.attach} (must be strictly better)`).toBeGreaterThan(r.attach);
  }, 300_000);
});
