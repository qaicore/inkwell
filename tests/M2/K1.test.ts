/// <reference types="node" />
// K1 (SPEC §10, tracking): root drift. A point anchor seeded at the clip's first truth.json root, compared with every
// later hand-marked root on every required clip: median < 2% of body height, p95 < 5%.
//
// Clips: fixtures/required-clips.json for the milestone in verify/ACTIVE (a criterion run on fewer clips fails, §11).
// Inputs per clip, read at runtime (missing = FAIL, no fallback, no stand-in tracker):
//   - fixtures/<clip>/truth.json      Qai's hand-marked roots (/label page, §11)
//   - fixtures/<clip>/sam-person.json SAM 3.1 `person` run, cached (body height = that frame's person-mask box height)
//   - fixtures/<clip>/sam-root.json   SAM 3.1 point run seeded at the first truth root, propagated both ways (§9)
//   Both caches use the probe's cache shape (fixtures/probe/sam-*.json): { clipSha256, model: "sam-3.1", text,
//   metadata, usage.video_frames_processed, rawOutput }, and the point run names its seed in `point: { frame, x, y }`
//   or in its `<Nf>..<|point;x=..;y=..|>` prompt text.
// Measured on the real modules: src/sam/cache.ts masksFromCache() decodes the point run, and src/track/anchor.ts
// trackAnchor() turns it into the smoothed anchor the app uses. Body height is computed here, independently, from the
// cached person masks (decoded with the probe's @meta-sam/parser reader, the box measured from the raster).
// Drift = |anchor(f) - truth root(f)| / body height(f) for every truth root after the first. Percentiles are linear
// between closest ranks.
// Stricter readings, flagged for Qai:
//   - each clip must pass on its own (not pooled);
//   - a later root on a frame with no person mask can't be scored and fails the clip;
//   - "seeded at the first root": the point run's seed is that root (same frame, within 1 px), and the anchor sits on
//     it on that frame (within 0.5 px);
//   - both caches must be SAM 3.1 output for the same clip (same clipSha256), never the stand-in.
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { framesFromRecords, parseCachedOutput, type FrameMask } from '../../scripts/probe/masks.ts';
import { Evidence, ROOT, activeMilestone, readText } from '../helpers/evidence.ts';
import { errMsg, need, recorded } from '../helpers/engine.ts';

type V2 = [number, number];
type SamCacheModule = typeof import('../../src/sam/cache.ts');
type AnchorModule = typeof import('../../src/track/anchor.ts');

const ID = 'K1';
const FPS = 30;
const MEDIAN_MAX = 2; // % of body height (SPEC §10 K1)
const P95_MAX = 5;

// ---------- which clips ----------

function requiredClips(): { milestone: string; clips: string[] } | { error: string } {
  const m = activeMilestone();
  if ('error' in m) return { error: m.error };
  const rel = 'fixtures/required-clips.json';
  if (!existsSync(join(ROOT, rel))) return { error: `${rel} missing: Qai must add it (SPEC §11)` };
  let j: unknown;
  try {
    j = JSON.parse(readText(join(ROOT, rel)));
  } catch (e) {
    return { error: `${rel} is not valid JSON: ${errMsg(e)}` };
  }
  const list = (j as Record<string, unknown> | null)?.[m.id];
  if (!Array.isArray(list) || list.length === 0 || !list.every((c) => typeof c === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(c))) {
    return { error: `${rel} has no clip list for ${m.id}: K1 needs at least one clip (SPEC §11)` };
  }
  return { milestone: m.id, clips: list as string[] };
}

const REQ = requiredClips();
const CLIPS = 'clips' in REQ ? REQ.clips : [];

const ev = new Evidence(ID, [
  'required clips',
  'modules load',
  ...CLIPS.flatMap((c) => [`${c}: inputs`, `${c}: anchor seeded at the first truth root`, `${c}: drift median`, `${c}: drift p95`]),
]);
afterAll(() => ev.write());

// ---------- inputs ----------

interface Truth {
  roots: { frame: number; xy: V2 }[];
  still: [number, number][];
}
interface SamCache {
  json: Record<string, unknown>;
  clipSha256: string;
  frames: number;
  rawOutput: string;
}
interface ClipInput {
  clip: string;
  truth: Truth;
  person: SamCache;
  root: SamCache;
  seed: { frame: number; xy: V2 };
  frames: number;
}

const refresh = (clip: string) => `Qai must add it: npm run fixtures:refresh -- ${clip}, once he says go (SPEC §3, §9)`;

function readJson(rel: string, who: string, problems: string[]): unknown {
  const p = join(ROOT, rel);
  if (!existsSync(p)) {
    problems.push(`${rel} missing: ${who}`);
    return undefined;
  }
  try {
    return JSON.parse(readText(p)) as unknown;
  } catch (e) {
    problems.push(`${rel} is not valid JSON: ${errMsg(e)}`);
    return undefined;
  }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isXy = (v: unknown): v is V2 => Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]);

function checkTruth(rel: string, clip: string, j: unknown, problems: string[]): Truth | undefined {
  if (j === undefined) return undefined;
  const t = j as { clip?: unknown; fps?: unknown; roots?: unknown; still?: unknown } | null;
  const before = problems.length;
  if (t?.clip !== clip) problems.push(`${rel} "clip" is ${JSON.stringify(t?.clip)}, expected "${clip}"`);
  if (t?.fps !== FPS) problems.push(`${rel} "fps" is ${JSON.stringify(t?.fps)}, expected ${FPS}`);
  const roots = Array.isArray(t?.roots) ? (t.roots as { frame?: unknown; xy?: unknown }[]) : null;
  if (!roots || roots.length < 2) problems.push(`${rel} needs at least 2 roots (the first seeds the anchor, the rest are scored); it has ${roots?.length ?? 0}`);
  else if (!roots.every((r) => Number.isInteger(r?.frame) && (r.frame as number) >= 0 && isXy(r.xy))) problems.push(`${rel} has a root that isn't { frame: whole number, xy: [x, y] }`);
  const still = Array.isArray(t?.still) ? (t.still as unknown[]) : null;
  if (!still) problems.push(`${rel} "still" is not a list`);
  if (problems.length > before) return undefined;
  const sorted = [...(roots as { frame: number; xy: V2 }[])].sort((a, b) => a.frame - b.frame);
  return { roots: sorted, still: still as [number, number][] };
}

function checkSam(rel: string, j: unknown, problems: string[]): SamCache | undefined {
  if (j === undefined) return undefined;
  const s = j as Record<string, unknown> | null;
  const before = problems.length;
  if (!s || typeof s !== 'object') {
    problems.push(`${rel} is not an object`);
    return undefined;
  }
  if (s.model !== 'sam-3.1') problems.push(`${rel} "model" is ${JSON.stringify(s.model)}: K1 is measured on SAM 3.1 output only (SPEC §3), never the stand-in`);
  if (typeof s.clipSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(s.clipSha256)) problems.push(`${rel} has no clipSha256 (SAM caches are keyed by clip hash, SPEC §6)`);
  if (typeof s.rawOutput !== 'string' || s.rawOutput.length === 0) problems.push(`${rel} has no rawOutput`);
  const frames = (s.usage as { video_frames_processed?: unknown } | undefined)?.video_frames_processed;
  if (!Number.isInteger(frames) || (frames as number) < 1) problems.push(`${rel} has no usage.video_frames_processed frame count`);
  if (problems.length > before) return undefined;
  return { json: s, clipSha256: s.clipSha256 as string, frames: frames as number, rawOutput: s.rawOutput as string };
}

function seedOf(s: Record<string, unknown>): { frame: number; xy: V2 } | null {
  const p = s.point as { frame?: unknown; x?: unknown; y?: unknown } | undefined;
  if (p && Number.isInteger(p.frame) && isNum(p.x) && isNum(p.y)) return { frame: p.frame as number, xy: [p.x, p.y] };
  const m = typeof s.text === 'string' ? s.text.match(/<(\d+)f>\d+<\|point;x=(-?\d+(?:\.\d+)?);y=(-?\d+(?:\.\d+)?)/) : null;
  return m ? { frame: Number(m[1]), xy: [Number(m[2]), Number(m[3])] } : null;
}

function loadClip(clip: string): ClipInput {
  const problems: string[] = [];
  const dir = `fixtures/${clip}`;
  const truthRel = `${dir}/truth.json`;
  const truth = checkTruth(truthRel, clip, readJson(truthRel, 'Qai must add it (made on the /label page, SPEC §11)', problems), problems);
  const person = checkSam(`${dir}/sam-person.json`, readJson(`${dir}/sam-person.json`, refresh(clip), problems), problems);
  const root = checkSam(`${dir}/sam-root.json`, readJson(`${dir}/sam-root.json`, refresh(clip), problems), problems);
  let seed: { frame: number; xy: V2 } | null = null;
  if (root) {
    seed = seedOf(root.json);
    if (!seed) problems.push(`${dir}/sam-root.json doesn't say where its point was placed (point: { frame, x, y } or a point prompt in "text")`);
    const dir2 = (root.json.metadata as { propagation_direction?: unknown } | undefined)?.propagation_direction;
    if (dir2 !== 'both') problems.push(`${dir}/sam-root.json metadata.propagation_direction is ${JSON.stringify(dir2)}: a point anchor is propagated in both directions (SPEC §9)`);
  }
  if (person && root && person.clipSha256 !== root.clipSha256) problems.push(`${dir}/sam-person.json and sam-root.json are for different clips (clipSha256 differs)`);
  if (person && root && person.frames !== root.frames) problems.push(`${dir}/sam-person.json covers ${person.frames} frames, sam-root.json ${root.frames}`);
  if (truth && seed) {
    const first = truth.roots[0]!;
    const off = Math.hypot(seed.xy[0] - first.xy[0], seed.xy[1] - first.xy[1]);
    if (seed.frame !== first.frame || off > 1) {
      problems.push(`${dir}/sam-root.json is seeded at frame ${seed.frame} (${seed.xy.join(', ')}), not at the first truth root, frame ${first.frame} (${first.xy.join(', ')})`);
    }
  }
  if (truth && person) {
    const last = truth.roots[truth.roots.length - 1]!.frame;
    if (last >= person.frames) problems.push(`${truthRel} marks frame ${last}, past the ${person.frames} frames SAM processed`);
  }
  if (problems.length || !truth || !person || !root || !seed) throw new Error(problems.join('; '));
  return { clip, truth, person, root, seed, frames: person.frames };
}

// ---------- independent measurements ----------

function boxHeight(m: FrameMask): number | null {
  let top = -1;
  let bottom = -1;
  for (let r = 0; r < m.height; r++) {
    let any = false;
    for (let c = 0; c < m.width; c++) {
      if (m.raster[r * m.width + c]) {
        any = true;
        break;
      }
    }
    if (any) {
      if (top < 0) top = r;
      bottom = r;
    }
  }
  if (top < 0) return null;
  return ((bottom - top + 1) * (m.bounds.bottom - m.bounds.top)) / m.height;
}

async function bodyHeights(person: SamCache): Promise<(number | null)[]> {
  const masks = framesFromRecords((await parseCachedOutput(person.rawOutput)).records, person.frames);
  return masks.map((m) => (m ? boxHeight(m) : null));
}

function percentile(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  const at = p * (s.length - 1);
  const lo = Math.floor(at);
  const hi = Math.min(s.length - 1, lo + 1);
  return s[lo]! + (s[hi]! - s[lo]!) * (at - lo);
}

async function loadModules(): Promise<{ cache: SamCacheModule; anchor: AnchorModule }> {
  const cache = await need('src/sam/cache.ts', { masksFromCache: 'function' }, () => import('../../src/sam/cache.ts'));
  const anchor = await need('src/track/anchor.ts', { trackAnchor: 'function' }, () => import('../../src/track/anchor.ts'));
  return { cache, anchor };
}

// ---------- tests ----------

describe('K1 root drift', () => {
  it('K1 required clips and modules', async () => {
    ev.record('required clips', 'clips' in REQ ? REQ.clips : REQ.error, 'fixtures/required-clips.json lists the clips for verify/ACTIVE', 'clips' in REQ,
      'clips' in REQ ? `milestone ${REQ.milestone}` : REQ.error);
    await recorded(ev, 'modules load', 'src/sam/cache.ts (masksFromCache), src/track/anchor.ts (trackAnchor)', loadModules);
    expect('clips' in REQ, 'error' in REQ ? REQ.error : '').toBe(true);
  });

  for (const clip of CLIPS) {
    it(`K1 ${clip}: point anchor vs every later hand-marked root, median < ${MEDIAN_MAX}% and p95 < ${P95_MAX}% of body height`, async () => {
      const input = await recorded(ev, `${clip}: inputs`, 'truth.json, sam-person.json and sam-root.json (SAM 3.1, same clip, seeded at the first truth root)',
        () => loadClip(clip), (i) => ({ frames: i.frames, roots: i.truth.roots.length, seed: i.seed }));
      const { cache, anchor } = await loadModules();
      const heights = await bodyHeights(input.person);
      const masks = await cache.masksFromCache(input.root.json, input.frames);
      const track = anchor.trackAnchor(masks, input.seed, FPS);
      const smoothed = track.smoothed as V2[];
      expect(smoothed.length, `K1 ${clip}: trackAnchor returned ${smoothed.length} frames for a ${input.frames}-frame clip`).toBe(input.frames);

      const at = smoothed[input.seed.frame];
      const seedOff = at && isXy(at) ? Math.hypot(at[0] - input.seed.xy[0], at[1] - input.seed.xy[1]) : Infinity;
      ev.record(`${clip}: anchor seeded at the first truth root`, { frame: input.seed.frame, offPx: seedOff }, '< 0.5 px from the seed on its own frame', seedOff < 0.5);

      const drifts: number[] = [];
      const unscored: number[] = [];
      const worst: { frame: number; pct: number }[] = [];
      for (const r of input.truth.roots.slice(1)) {
        const a = smoothed[r.frame];
        const h = heights[r.frame];
        if (!a || !isXy(a) || !h) {
          unscored.push(r.frame);
          continue;
        }
        const pct = (100 * Math.hypot(a[0] - r.xy[0], a[1] - r.xy[1])) / h;
        drifts.push(pct);
        worst.push({ frame: r.frame, pct });
      }
      worst.sort((a, b) => b.pct - a.pct);
      const ok = drifts.length > 0 && unscored.length === 0;
      const median = drifts.length ? percentile(drifts, 0.5) : Infinity;
      const p95 = drifts.length ? percentile(drifts, 0.95) : Infinity;
      const notes = `${drifts.length} roots scored${unscored.length ? `; unscored (no person mask or anchor): frames ${unscored.slice(0, 12).join(', ')}` : ''}; worst ${JSON.stringify(worst.slice(0, 5))}`;
      ev.record(`${clip}: drift median`, median, `< ${MEDIAN_MAX}% of body height`, ok && median < MEDIAN_MAX, notes);
      ev.record(`${clip}: drift p95`, p95, `< ${P95_MAX}% of body height`, ok && p95 < P95_MAX, notes);

      expect(seedOff, `K1 ${clip}: the anchor is ${seedOff} px from its seed on frame ${input.seed.frame}`).toBeLessThan(0.5);
      expect(unscored, `K1 ${clip}: truth roots that couldn't be scored`).toEqual([]);
      expect(median, `K1 ${clip}: median drift ${median}% (threshold < ${MEDIAN_MAX}%)`).toBeLessThan(MEDIAN_MAX);
      expect(p95, `K1 ${clip}: p95 drift ${p95}% (threshold < ${P95_MAX}%)`).toBeLessThan(P95_MAX);
    }, 300_000);
  }
});
