/// <reference types="node" />
// G1 (SPEC §10, Gate 1): one clip runs end to end in the app from cached data: clip -> plan -> SAM -> physics ->
// stepped preview. (Ugly is fine, §3.)
//
// The clip is the probe clip, with everything cached next to it (missing = FAIL, nothing is requested):
//   - fixtures/probe/clip.mp4          the converted clip (its sha256 keys every cache, §6 "cache by clip hash")
//   - fixtures/probe/sam-person.json   SAM 3.1 `person` (the probe's own run), and sam-face.json
//   - fixtures/probe/wonder-plan.json  the cached Wonder plan call for strokes drawn on this clip, in the W1 cache
//                                      shape: { model, calls: [ { clip: "probe", clipSha256, frame, strokes:
//                                      [{ id, points: [[x, y, pressure], ...] }], attempts: [{ status, text }] } ] }
//   - fixtures/probe/<samCacheFile(anchor)> for every anchor the plan picks (sam-person.json for "person")
// Run through the app's own pipeline module, src/app/pipeline.ts runPipeline(), which src/app/main.ts must import
// (so the path tested is the app's path), with:
//   - transport: replays the cached attempts in order (no network; R4 forbids tests importing the API clients);
//   - sam(file): the cached SAM response fixtures/probe/<file>, or null when it isn't cached.
// Checks: the caches belong to this clip (sha256); the plan is Wonder's (validated), one per drawn stroke, and is
// written into the effect; SAM caches are read for person and for every planned anchor; the physics runs on every
// frame with finite points; the preview is stepped (frame f holds drawing k = floor(f·dps/30), identical within a
// drawing, and it changes); placed roots stay on him; the preview frames render (headless renderPng) with ink on
// them.
// Stricter readings, flagged for Qai:
//   - "clip -> plan" means Wonder's plan: a run that only got the rule's fallback doesn't pass G1;
//   - "stays on him": every placed root, on every frame with a person mask, lies within the person mask's box grown by
//     0.25 body heights (a test tolerance; G1 has no numeric threshold);
//   - boil numbers here are arbitrary test input (G1 is about the pipeline, not the look).
import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { framesFromRecords, parseCachedOutput, type FrameMask } from '../../scripts/probe/masks.ts';
import { Evidence, ROOT, readText } from '../helpers/evidence.ts';
import { errMsg, need, pngSize, recorded } from '../helpers/engine.ts';
import type { PlanTransport } from '../../src/plan/plan.ts';

type PipelineModule = typeof import('../../src/app/pipeline.ts');
type SamCacheModule = typeof import('../../src/sam/cache.ts');
type HeadlessModule = typeof import('../../src/render/headless.ts');
type V2 = [number, number];

const ID = 'G1';
const CLIP = 'probe';
const DIR = `fixtures/${CLIP}`;
const FPS = 30;
const BOIL = { maxPx: 2, cycle: 4 }; // arbitrary test input
const MARGIN = 0.25; // body heights, test tolerance

const ev = new Evidence(ID, [
  'modules load',
  'the app runs this pipeline',
  'cached inputs for the clip',
  'caches keyed by this clip',
  'plan: Wonder, one per stroke, in the effect',
  'SAM: person and every planned anchor read from the cache',
  'physics: every frame, finite',
  'stepped preview: held on drawings',
  'roots stay on him',
  'preview renders',
]);
afterAll(() => ev.write());

function readJson(rel: string, who: string): Record<string, unknown> {
  const p = join(ROOT, rel);
  if (!existsSync(p)) throw new Error(`${rel} missing: ${who}`);
  try {
    return JSON.parse(readText(p)) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`${rel} is not valid JSON: ${errMsg(e)}`);
  }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

interface Call {
  clip: string;
  clipSha256: string;
  frame: number;
  strokes: { id: number; points: [number, number, number][] }[];
  attempts: { text: string }[];
}

function loadInputs() {
  const clipRel = `${DIR}/clip.mp4`;
  if (!existsSync(join(ROOT, clipRel))) throw new Error(`${clipRel} missing: Qai must add it (SPEC §9, §11)`);
  const sha = createHash('sha256').update(readFileSync(join(ROOT, clipRel))).digest('hex');
  const person = readJson(`${DIR}/sam-person.json`, 'Qai must add it: the probe caches it (npm run probe, once he says go)');
  const face = readJson(`${DIR}/sam-face.json`, 'Qai must add it: the probe caches it (npm run probe, once he says go)');
  const plan = readJson(`${DIR}/wonder-plan.json`, 'Qai must add it: the cached Wonder plan call for strokes drawn on the probe clip, recorded once he says go (SPEC §3, §9); tests never call Wonder');
  if (person.model !== 'sam-3.1') throw new Error(`${DIR}/sam-person.json model is ${JSON.stringify(person.model)}`);
  if (typeof plan.model !== 'string' || !/muse-wonder/i.test(plan.model)) throw new Error(`${DIR}/wonder-plan.json model is ${JSON.stringify(plan.model)}: G1's plan is Muse Wonder's`);
  const calls = Array.isArray(plan.calls) ? (plan.calls as Call[]) : [];
  const call = calls[0];
  if (!call || call.clip !== CLIP || !Number.isInteger(call.frame) || !Array.isArray(call.strokes) || call.strokes.length === 0 || !Array.isArray(call.attempts) || call.attempts.length === 0) {
    throw new Error(`${DIR}/wonder-plan.json needs a call { clip: "probe", clipSha256, frame, strokes: [...], attempts: [...] }`);
  }
  const frames = (person.usage as { video_frames_processed?: unknown } | undefined)?.video_frames_processed;
  if (!Number.isInteger(frames)) throw new Error(`${DIR}/sam-person.json has no usage.video_frames_processed`);
  const size = typeof person.rawOutput === 'string' ? person.rawOutput.match(/;w=(\d+);h=(\d+)/) : null;
  if (!size) throw new Error(`${DIR}/sam-person.json rawOutput gives no frame size`);
  return { sha, person, face, call, frames: frames as number, width: Number(size[1]), height: Number(size[2]) };
}

function box(m: FrameMask): { left: number; top: number; right: number; bottom: number } | null {
  const sx = (m.bounds.right - m.bounds.left) / m.width;
  const sy = (m.bounds.bottom - m.bounds.top) / m.height;
  let l = Infinity;
  let r = -Infinity;
  let t = Infinity;
  let b = -Infinity;
  for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) {
    if (!m.raster[y * m.width + x]) continue;
    if (x < l) l = x;
    if (x > r) r = x;
    if (y < t) t = y;
    if (y > b) b = y;
  }
  if (l === Infinity) return null;
  return { left: m.bounds.left + l * sx, right: m.bounds.left + (r + 1) * sx, top: m.bounds.top + t * sy, bottom: m.bounds.top + (b + 1) * sy };
}

describe('G1 one clip end to end from cached data', () => {
  it('G1 clip -> plan -> SAM -> physics -> stepped preview', async () => {
    const mods = await recorded(ev, 'modules load', 'src/app/pipeline.ts (runPipeline), src/sam/cache.ts (samCacheFile), src/render/headless.ts (renderPng)', async () => ({
      pipe: await need('src/app/pipeline.ts', { runPipeline: 'function' }, () => import('../../src/app/pipeline.ts')),
      cache: await need('src/sam/cache.ts', { samCacheFile: 'function', masksFromCache: 'function' }, () => import('../../src/sam/cache.ts')),
      head: await need('src/render/headless.ts', { renderPng: 'function' }, () => import('../../src/render/headless.ts')),
    })).catch(() => null) as { pipe: PipelineModule; cache: SamCacheModule; head: HeadlessModule } | null;

    {
      const mainRel = 'src/app/main.ts';
      const main = existsSync(join(ROOT, mainRel)) ? readText(join(ROOT, mainRel)) : '';
      const wired = /\bfrom\s+['"]\.\/pipeline(?:\.ts)?['"]/.test(main);
      ev.record('the app runs this pipeline', wired ? `${mainRel} imports ./pipeline.ts` : `${mainRel} doesn't import ./pipeline.ts`, 'src/app/main.ts imports src/app/pipeline.ts', wired);
    }

    const inputs = await recorded(ev, 'cached inputs for the clip', `${DIR}: clip.mp4, sam-person.json, sam-face.json, wonder-plan.json`, loadInputs,
      (i) => ({ frames: i.frames, size: [i.width, i.height], drawingFrame: i.call.frame, strokes: i.call.strokes.length, attempts: i.call.attempts.length }));
    const keyed = inputs.person.clipSha256 === inputs.sha && inputs.face.clipSha256 === inputs.sha && inputs.call.clipSha256 === inputs.sha;
    ev.record('caches keyed by this clip', { clip: inputs.sha.slice(0, 12), person: String(inputs.person.clipSha256).slice(0, 12), face: String(inputs.face.clipSha256).slice(0, 12), plan: String(inputs.call.clipSha256).slice(0, 12) },
      'every cache carries the sha256 of fixtures/probe/clip.mp4', keyed);
    if (!mods) throw new Error('G1 modules missing (see "modules load")');

    // Run the pipeline from the cache.
    let calls = 0;
    const transport: PlanTransport = async () => {
      const a = inputs.call.attempts[calls++];
      if (!a) throw new Error('attempt not cached');
      return a.text;
    };
    const asked: string[] = [];
    const missing: string[] = [];
    const sam = (file: string): unknown => {
      asked.push(file);
      const p = join(ROOT, DIR, file);
      if (!/^[\w.-]+\.json$/.test(file) || !existsSync(p)) {
        missing.push(file);
        return null;
      }
      return JSON.parse(readText(p)) as unknown;
    };
    const out = await mods.pipe.runPipeline({
      clip: { id: CLIP, sha256: inputs.sha, frames: inputs.frames, width: inputs.width, height: inputs.height, fps: FPS },
      drawing: { frame: inputs.call.frame, strokes: inputs.call.strokes },
      transport,
      sam,
      boil: BOIL,
    });
    const { plan, effect, frames } = out;
    const ids = inputs.call.strokes.map((s) => s.id).sort((a, b) => a - b);

    // Plan
    {
      const planIds = plan.strokes.map((p) => p.id).sort((a, b) => a - b);
      const inEffect = plan.strokes.every((p) => {
        const s = effect.strokes.find((x) => x.id === p.id);
        return !!s && s.kind === p.kind && JSON.stringify(s.anchor) === JSON.stringify(p.anchor) && s.bodyAngle === p.bodyAngle && s.stiffness === p.stiffness && s.wobble === p.wobble && s.views.front.layer === p.layer;
      });
      const ok = plan.source === 'wonder' && JSON.stringify(planIds) === JSON.stringify(ids) && inEffect && calls <= 2;
      ev.record('plan: Wonder, one per stroke, in the effect', { source: plan.source, attempts: plan.attempts, note: plan.note, planIds, transportCalls: calls },
        "source 'wonder', a plan for every drawn stroke, each written into the effect's stroke", ok, plan.source !== 'wonder' ? `fell back: ${plan.note ?? ''}` : inEffect ? '' : 'the effect strokes do not carry the plan fields');
    }

    // SAM
    {
      const wanted = ['sam-person.json', ...plan.strokes.map((p) => mods.cache.samCacheFile(p.anchor, p.id))];
      const notAsked = wanted.filter((f) => !asked.includes(f));
      const personName = mods.cache.samCacheFile({ type: 'concept', prompt: 'person' }, 1);
      const ok = notAsked.length === 0 && missing.length === 0 && personName === 'sam-person.json';
      ev.record('SAM: person and every planned anchor read from the cache', { asked: [...new Set(asked)], missing, samCacheFileForPerson: personName },
        'sam-person.json and samCacheFile(anchor) for each planned stroke, all cached', ok,
        [notAsked.length && `never read: ${notAsked.join(', ')}`, missing.length && `not cached: ${missing.join(', ')} (Qai: npm run fixtures:refresh -- probe, once he says go)`, personName !== 'sam-person.json' && `samCacheFile(person) is ${personName}`].filter(Boolean).join('; '));
    }

    // Physics
    const finite = (pts: V2[]) => pts.every((p) => isNum(p[0]) && isNum(p[1]));
    const badFrames = frames
      .map((fr, f) => {
        const placedIds = fr.placed.map((s) => s.id).sort((a, b) => a - b);
        return JSON.stringify(placedIds) === JSON.stringify(ids) && fr.placed.every((s) => finite(s.points as V2[])) && fr.sim.every((s) => finite(s.points as V2[])) ? -1 : f;
      })
      .filter((f) => f >= 0);
    ev.record('physics: every frame, finite', { frames: frames.length, badFrames: badFrames.slice(0, 10) }, `${inputs.frames} frames, every stroke placed, finite points`,
      frames.length === inputs.frames && badFrames.length === 0);

    // Stepped preview
    {
      const dps = effect.timing.drawingsPerSecond;
      const wrongK: number[] = [];
      const changedInside: number[] = [];
      let changes = 0;
      for (let f = 0; f < frames.length; f++) {
        const k = Math.floor((f * dps) / FPS);
        if (frames[f]!.k !== k) wrongK.push(f);
        if (f === 0) continue;
        const same = JSON.stringify(frames[f]!.held) === JSON.stringify(frames[f - 1]!.held);
        if (k === Math.floor(((f - 1) * dps) / FPS) && !same) changedInside.push(f);
        if (!same) changes++;
      }
      ev.record('stepped preview: held on drawings', { dps, wrongK: wrongK.slice(0, 10), changedWithinADrawing: changedInside.slice(0, 10), drawingChanges: changes },
        'k = floor(f·dps/30); the held drawing is identical within a drawing and changes over the clip', wrongK.length === 0 && changedInside.length === 0 && changes > 0);
    }

    // Roots stay on him
    {
      const masks = framesFromRecords((await parseCachedOutput(inputs.person.rawOutput as string)).records, inputs.frames);
      const off: { f: number; id: number; by: number }[] = [];
      let checked = 0;
      frames.forEach((fr, f) => {
        const m = masks[f];
        const b = m ? box(m) : null;
        if (!b) return;
        const grow = MARGIN * (b.bottom - b.top);
        for (const s of fr.placed) {
          const r = s.points[0] as V2;
          checked++;
          const dx = Math.max(b.left - grow - r[0], 0, r[0] - (b.right + grow));
          const dy = Math.max(b.top - grow - r[1], 0, r[1] - (b.bottom + grow));
          if (dx > 0 || dy > 0) off.push({ f, id: s.id, by: Math.hypot(dx, dy) });
        }
      });
      ev.record('roots stay on him', { checked, off: off.length, worst: off.sort((a, b) => b.by - a.by).slice(0, 5) }, `every placed root within the person box grown by ${MARGIN} body heights`, checked > 0 && off.length === 0);
    }

    // Preview renders
    {
      const { createCanvas, loadImage } = await import('@napi-rs/canvas');
      const dps = effect.timing.drawingsPerSecond;
      const sample = frames.map((_, f) => f).filter((f) => f === 0 || Math.floor((f * dps) / FPS) !== Math.floor(((f - 1) * dps) / FPS)).slice(0, 8);
      const results: { f: number; size: string; inked: number }[] = [];
      for (const f of sample) {
        const png = Buffer.from(mods.head.renderPng(inputs.width, inputs.height, frames[f]!.placed, effect));
        const s = pngSize(png);
        const img = await loadImage(png);
        const c = createCanvas(img.width, img.height);
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, img.width, img.height).data;
        let inked = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i]! > 0) inked++;
        results.push({ f, size: s ? `${s.width}x${s.height}` : 'not a PNG', inked });
      }
      const ok = results.length > 0 && results.every((r) => r.size === `${inputs.width}x${inputs.height}` && r.inked > 0);
      ev.record('preview renders', results, `PNG ${inputs.width}x${inputs.height} with ink on every sampled drawing`, ok);
    }

    const failed = ev.checks.filter((c) => !c.pass).map((c) => c.name);
    expect(failed, 'G1 failing checks').toEqual([]);
  }, 300_000);
});
