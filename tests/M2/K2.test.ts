/// <reference types="node" />
// K2 (SPEC §10, tracking): jitter. RMS frame-to-frame anchor motion after smoothing, in frames marked `still`:
// < 0.3% of body height (start).
//
// Clips: fixtures/required-clips.json for the milestone in verify/ACTIVE (a criterion run on fewer clips fails, §11).
// Inputs per clip, read at runtime (missing = FAIL, no fallback, no stand-in tracker):
//   - fixtures/<clip>/truth.json      Qai's `still` stretches (inclusive frame ranges) and roots (/label page, §11)
//   - fixtures/<clip>/sam-person.json SAM 3.1 `person` run (body height = that frame's person-mask box height)
//   - fixtures/<clip>/sam-root.json   SAM 3.1 point run seeded at the first truth root, propagated both ways (§9)
//   (cache shape as in fixtures/probe/sam-*.json; see K1.)
// Measured on the real modules: src/sam/cache.ts masksFromCache() and src/track/anchor.ts trackAnchor(), seeded at
// the first truth root. For every pair of consecutive frames (f - 1, f) inside one still stretch:
// motion = |smoothed(f) - smoothed(f - 1)| / body height(f); RMS over all such pairs of the clip, in %.
// Stricter readings, flagged for Qai:
//   - "anchor" is every anchor kind the app makes from SAM: the point anchor (sam-root.json) and the concept anchor
//     on the person mask (sam-person.json, seeded at the same root); both must pass;
//   - each clip must pass on its own; a clip with no still stretch (or none with a person mask) fails, since the
//     criterion can't be measured there; a still pair with no person mask fails the clip;
//   - both caches must be SAM 3.1 output for the same clip (same clipSha256).
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { framesFromRecords, parseCachedOutput, type FrameMask } from '../../scripts/probe/masks.ts';
import { Evidence, ROOT, activeMilestone, readText } from '../helpers/evidence.ts';
import { errMsg, need, recorded } from '../helpers/engine.ts';

type V2 = [number, number];
type SamCacheModule = typeof import('../../src/sam/cache.ts');
type AnchorModule = typeof import('../../src/track/anchor.ts');

const ID = 'K2';
const FPS = 30;
const RMS_MAX = 0.3; // % of body height (SPEC §10 K2, start)
const ANCHORS = ['point', 'person'] as const;

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
    return { error: `${rel} has no clip list for ${m.id}: K2 needs at least one clip (SPEC §11)` };
  }
  return { milestone: m.id, clips: list as string[] };
}

const REQ = requiredClips();
const CLIPS = 'clips' in REQ ? REQ.clips : [];

const ev = new Evidence(ID, [
  'required clips',
  'modules load',
  ...CLIPS.flatMap((c) => [`${c}: inputs`, ...ANCHORS.map((a) => `${c}: jitter (${a} anchor)`)]),
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
  if (!roots || roots.length < 1) problems.push(`${rel} has no roots: the anchor is seeded at the first one`);
  else if (!roots.every((r) => Number.isInteger(r?.frame) && (r.frame as number) >= 0 && isXy(r.xy))) problems.push(`${rel} has a root that isn't { frame: whole number, xy: [x, y] }`);
  const still = Array.isArray(t?.still) ? (t.still as unknown[]) : null;
  if (!still) problems.push(`${rel} "still" is not a list`);
  else if (still.length === 0) problems.push(`${rel} marks no still stretches: K2 is measured in frames marked still (Qai drags them on the /label page, SPEC §11)`);
  else if (!still.every((s) => Array.isArray(s) && s.length === 2 && Number.isInteger(s[0]) && Number.isInteger(s[1]) && (s[0] as number) <= (s[1] as number))) {
    problems.push(`${rel} has a still stretch that isn't [first, last] whole frames`);
  }
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
  if (s.model !== 'sam-3.1') problems.push(`${rel} "model" is ${JSON.stringify(s.model)}: K2 is measured on SAM 3.1 output only (SPEC §3), never the stand-in`);
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
    const last = Math.max(...truth.still.map((s) => s[1]));
    if (last >= person.frames) problems.push(`${truthRel} marks still frames up to ${last}, past the ${person.frames} frames SAM processed`);
  }
  if (problems.length || !truth || !person || !root || !seed) throw new Error(problems.join('; '));
  return { clip, truth, person, root, seed: { frame: truth.roots[0]!.frame, xy: truth.roots[0]!.xy }, frames: person.frames };
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

async function loadModules(): Promise<{ cache: SamCacheModule; anchor: AnchorModule }> {
  const cache = await need('src/sam/cache.ts', { masksFromCache: 'function' }, () => import('../../src/sam/cache.ts'));
  const anchor = await need('src/track/anchor.ts', { trackAnchor: 'function' }, () => import('../../src/track/anchor.ts'));
  return { cache, anchor };
}

// ---------- tests ----------

describe('K2 jitter in still frames', () => {
  it('K2 required clips and modules', async () => {
    ev.record('required clips', 'clips' in REQ ? REQ.clips : REQ.error, 'fixtures/required-clips.json lists the clips for verify/ACTIVE', 'clips' in REQ,
      'clips' in REQ ? `milestone ${REQ.milestone}` : REQ.error);
    await recorded(ev, 'modules load', 'src/sam/cache.ts (masksFromCache), src/track/anchor.ts (trackAnchor)', loadModules);
    expect('clips' in REQ, 'error' in REQ ? REQ.error : '').toBe(true);
  });

  for (const clip of CLIPS) {
    it(`K2 ${clip}: RMS frame-to-frame motion of the smoothed anchor in still frames < ${RMS_MAX}% of body height`, async () => {
      const input = await recorded(ev, `${clip}: inputs`, 'truth.json (with still stretches), sam-person.json and sam-root.json (SAM 3.1, same clip)',
        () => loadClip(clip), (i) => ({ frames: i.frames, still: i.truth.still, seed: i.seed }));
      const { cache, anchor } = await loadModules();
      const heights = await bodyHeights(input.person);
      const failures: string[] = [];
      for (const kind of ANCHORS) {
        const masks = await cache.masksFromCache(kind === 'point' ? input.root.json : input.person.json, input.frames);
        const smoothed = anchor.trackAnchor(masks, input.seed, FPS).smoothed as V2[];
        let sumSq = 0;
        let pairs = 0;
        const unscored: number[] = [];
        let worst = { frame: -1, pct: 0 };
        for (const [a, b] of input.truth.still) {
          for (let f = a + 1; f <= b; f++) {
            const p = smoothed[f - 1];
            const q = smoothed[f];
            const h = heights[f];
            if (!p || !q || !isXy(p) || !isXy(q) || !h) {
              unscored.push(f);
              continue;
            }
            const pct = (100 * Math.hypot(q[0] - p[0], q[1] - p[1])) / h;
            sumSq += pct * pct;
            pairs++;
            if (pct > worst.pct) worst = { frame: f, pct };
          }
        }
        const rms = pairs ? Math.sqrt(sumSq / pairs) : Infinity;
        const pass = smoothed.length === input.frames && pairs > 0 && unscored.length === 0 && rms < RMS_MAX;
        ev.record(`${clip}: jitter (${kind} anchor)`, rms, `< ${RMS_MAX}% of body height (RMS over still frame pairs)`, pass,
          `${pairs} still pairs; largest step ${worst.pct.toFixed(4)}% at frame ${worst.frame}${unscored.length ? `; unscored (no person mask or anchor): frames ${unscored.slice(0, 12).join(', ')}` : ''}${smoothed.length !== input.frames ? `; trackAnchor returned ${smoothed.length} frames, clip has ${input.frames}` : ''}`);
        if (!pass) failures.push(`${kind} anchor RMS ${rms}% over ${pairs} pairs (${unscored.length} unscored)`);
      }
      expect(failures, `K2 ${clip}: threshold < ${RMS_MAX}% of body height`).toEqual([]);
    }, 300_000);
  }
});
