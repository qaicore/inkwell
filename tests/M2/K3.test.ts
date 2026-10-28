/// <reference types="node" />
// K3 (SPEC §10, tracking): lag of the smoothed anchor behind the raw one, by cross-correlation over the fastest
// segment: <= 2 frames (start).
//
// Clips: fixtures/required-clips.json for the milestone in verify/ACTIVE (a criterion run on fewer clips fails, §11).
// Inputs per clip, read at runtime (missing = FAIL, no fallback, no stand-in tracker):
//   - fixtures/<clip>/truth.json      Qai's roots (the anchor is seeded at the first one, as in K1)
//   - fixtures/<clip>/sam-person.json SAM 3.1 `person` run
//   - fixtures/<clip>/sam-root.json   SAM 3.1 point run seeded at the first truth root, propagated both ways (§9)
//   (cache shape as in fixtures/probe/sam-*.json; see K1.)
// Measured on the real modules: src/sam/cache.ts masksFromCache() and src/track/anchor.ts trackAnchor(), which
// returns both the raw anchor (per frame, null where SAM lost it) and the smoothed one the app uses.
//   - Fastest segment: the 30-frame (1 s) window, with a raw anchor on every frame of it and the frame before, whose
//     mean raw anchor speed (px per frame) is highest.
//   - Lag: velocities v(f) = p(f) - p(f - 1). For L in -15..15 frames, the normalized cross-correlation of the
//     smoothed velocity at f with the raw velocity at f - L, summed over the segment's frames (x and y together).
//     The lag is the L with the highest correlation; L > 0 means the smoothed anchor trails the raw one.
//   - Self-check first: the estimator recovers known shifts (-2, 0, 3, 5 frames) of a seeded synthetic track.
// Stricter readings, flagged for Qai:
//   - the window length (30 frames) and search range (+-15) are this test's choices; SPEC doesn't fix them;
//   - a lead counts too: |lag| <= 2, so a smoother that runs ahead of the raw track fails as well;
//   - "anchor" is both anchor kinds the app makes from SAM: the point anchor (sam-root.json) and the concept anchor
//     on the person mask (sam-person.json); each clip and each anchor must pass on its own;
//   - both caches must be SAM 3.1 output for the same clip (same clipSha256).
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Evidence, ROOT, activeMilestone, readText } from '../helpers/evidence.ts';
import { errMsg, need, recorded, rng } from '../helpers/engine.ts';

type V2 = [number, number];
type SamCacheModule = typeof import('../../src/sam/cache.ts');
type AnchorModule = typeof import('../../src/track/anchor.ts');

const ID = 'K3';
const FPS = 30;
const LAG_MAX = 2; // frames (SPEC §10 K3, start)
const WINDOW = 30;
const SEARCH = 15;
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
    return { error: `${rel} has no clip list for ${m.id}: K3 needs at least one clip (SPEC §11)` };
  }
  return { milestone: m.id, clips: list as string[] };
}

const REQ = requiredClips();
const CLIPS = 'clips' in REQ ? REQ.clips : [];

const ev = new Evidence(ID, [
  'required clips',
  'modules load',
  'lag estimator self-check',
  ...CLIPS.flatMap((c) => [`${c}: inputs`, ...ANCHORS.map((a) => `${c}: lag (${a} anchor)`)]),
]);
afterAll(() => ev.write());

// ---------- inputs ----------

interface SamCache {
  json: Record<string, unknown>;
  clipSha256: string;
  frames: number;
}
interface ClipInput {
  person: SamCache;
  root: SamCache;
  seed: { frame: number; xy: V2 };
  frames: number;
}

const refresh = (clip: string) => `Qai must add it: npm run fixtures:refresh -- ${clip}, once he says go (SPEC §3, §9)`;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isXy = (v: unknown): v is V2 => Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]);

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

function checkSam(rel: string, j: unknown, problems: string[]): SamCache | undefined {
  if (j === undefined) return undefined;
  const s = j as Record<string, unknown> | null;
  const before = problems.length;
  if (!s || typeof s !== 'object') {
    problems.push(`${rel} is not an object`);
    return undefined;
  }
  if (s.model !== 'sam-3.1') problems.push(`${rel} "model" is ${JSON.stringify(s.model)}: K3 is measured on SAM 3.1 output only (SPEC §3), never the stand-in`);
  if (typeof s.clipSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(s.clipSha256)) problems.push(`${rel} has no clipSha256 (SAM caches are keyed by clip hash, SPEC §6)`);
  if (typeof s.rawOutput !== 'string' || s.rawOutput.length === 0) problems.push(`${rel} has no rawOutput`);
  const frames = (s.usage as { video_frames_processed?: unknown } | undefined)?.video_frames_processed;
  if (!Number.isInteger(frames) || (frames as number) < 1) problems.push(`${rel} has no usage.video_frames_processed frame count`);
  if (problems.length > before) return undefined;
  return { json: s, clipSha256: s.clipSha256 as string, frames: frames as number };
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
  const truthJson = readJson(truthRel, 'Qai must add it (made on the /label page, SPEC §11)', problems) as { clip?: unknown; fps?: unknown; roots?: unknown } | undefined;
  let first: { frame: number; xy: V2 } | null = null;
  if (truthJson !== undefined) {
    if (truthJson?.clip !== clip) problems.push(`${truthRel} "clip" is ${JSON.stringify(truthJson?.clip)}, expected "${clip}"`);
    if (truthJson?.fps !== FPS) problems.push(`${truthRel} "fps" is ${JSON.stringify(truthJson?.fps)}, expected ${FPS}`);
    const roots = Array.isArray(truthJson?.roots) ? (truthJson.roots as { frame?: unknown; xy?: unknown }[]) : [];
    const good = roots.filter((r) => Number.isInteger(r?.frame) && (r.frame as number) >= 0 && isXy(r.xy)) as { frame: number; xy: V2 }[];
    if (good.length === 0 || good.length !== roots.length) problems.push(`${truthRel} needs roots of { frame, xy }: the anchor is seeded at the first one`);
    else first = [...good].sort((a, b) => a.frame - b.frame)[0]!;
  }
  const person = checkSam(`${dir}/sam-person.json`, readJson(`${dir}/sam-person.json`, refresh(clip), problems), problems);
  const root = checkSam(`${dir}/sam-root.json`, readJson(`${dir}/sam-root.json`, refresh(clip), problems), problems);
  if (root) {
    const seed = seedOf(root.json);
    if (!seed) problems.push(`${dir}/sam-root.json doesn't say where its point was placed (point: { frame, x, y } or a point prompt in "text")`);
    else if (first && (seed.frame !== first.frame || Math.hypot(seed.xy[0] - first.xy[0], seed.xy[1] - first.xy[1]) > 1)) {
      problems.push(`${dir}/sam-root.json is seeded at frame ${seed.frame} (${seed.xy.join(', ')}), not at the first truth root, frame ${first.frame} (${first.xy.join(', ')})`);
    }
    const dir2 = (root.json.metadata as { propagation_direction?: unknown } | undefined)?.propagation_direction;
    if (dir2 !== 'both') problems.push(`${dir}/sam-root.json metadata.propagation_direction is ${JSON.stringify(dir2)}: a point anchor is propagated in both directions (SPEC §9)`);
  }
  if (person && root && person.clipSha256 !== root.clipSha256) problems.push(`${dir}/sam-person.json and sam-root.json are for different clips (clipSha256 differs)`);
  if (person && root && person.frames !== root.frames) problems.push(`${dir}/sam-person.json covers ${person.frames} frames, sam-root.json ${root.frames}`);
  if (problems.length || !person || !root || !first) throw new Error(problems.join('; '));
  return { person, root, seed: first, frames: person.frames };
}

// ---------- the measurement ----------

/** The WINDOW-frame segment [s, s + WINDOW) with raw on every frame from s - 1, of highest mean raw speed. */
function fastestSegment(raw: (V2 | null)[]): { start: number; meanSpeed: number } | null {
  let best: { start: number; meanSpeed: number } | null = null;
  for (let s = 1; s + WINDOW <= raw.length; s++) {
    let sum = 0;
    let ok = true;
    for (let f = s; f < s + WINDOW; f++) {
      const a = raw[f - 1];
      const b = raw[f];
      if (!a || !b) {
        ok = false;
        break;
      }
      sum += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    if (ok && (!best || sum / WINDOW > best.meanSpeed)) best = { start: s, meanSpeed: sum / WINDOW };
  }
  return best;
}

/** Lag L maximizing the normalized correlation of smoothed velocity at f with raw velocity at f - L, f in the segment. */
function lagOf(raw: (V2 | null)[], smooth: V2[], start: number): { lag: number; corr: number } {
  const vel = (p: (V2 | null)[], f: number): V2 | null => {
    const a = p[f - 1];
    const b = p[f];
    return f >= 1 && f < p.length && a && b ? [b[0] - a[0], b[1] - a[1]] : null;
  };
  let best = { lag: 0, corr: -Infinity };
  for (let L = -SEARCH; L <= SEARCH; L++) {
    let dot = 0;
    let ss = 0;
    let rr = 0;
    for (let f = start; f < start + WINDOW; f++) {
      const vs = vel(smooth, f);
      const vr = vel(raw, f - L);
      if (!vs || !vr) continue;
      dot += vs[0] * vr[0] + vs[1] * vr[1];
      ss += vs[0] * vs[0] + vs[1] * vs[1];
      rr += vr[0] * vr[0] + vr[1] * vr[1];
    }
    const c = ss > 0 && rr > 0 ? dot / Math.sqrt(ss * rr) : -Infinity;
    if (c > best.corr) best = { lag: L, corr: c };
  }
  return best;
}

function syntheticTrack(n: number, seed: number): V2[] {
  const r = rng(seed);
  const waves = Array.from({ length: 6 }, () => ({ a: 5 + 40 * r(), f: 0.2 + 2 * r(), p: 2 * Math.PI * r(), axis: r() < 0.5 ? 0 : 1 }));
  return Array.from({ length: n }, (_, f) => {
    const t = f / FPS;
    const p: V2 = [500, 900];
    for (const w of waves) p[w.axis] += w.a * Math.sin(2 * Math.PI * w.f * t + w.p);
    return p;
  });
}

async function loadModules(): Promise<{ cache: SamCacheModule; anchor: AnchorModule }> {
  const cache = await need('src/sam/cache.ts', { masksFromCache: 'function' }, () => import('../../src/sam/cache.ts'));
  const anchor = await need('src/track/anchor.ts', { trackAnchor: 'function' }, () => import('../../src/track/anchor.ts'));
  return { cache, anchor };
}

// ---------- tests ----------

describe('K3 lag of the smoothed anchor', () => {
  it('K3 lag estimator self-check on known shifts', () => {
    const raw = syntheticTrack(200, 77);
    const results = [-2, 0, 3, 5].map((shift) => {
      const smooth = raw.map((_, f) => raw[Math.min(raw.length - 1, Math.max(0, f - shift))]!);
      const seg = fastestSegment(raw.map((p, f) => (f >= 20 && f < 180 ? p : null)));
      return { shift, found: seg ? lagOf(raw, smooth, seg.start).lag : null };
    });
    const ok = results.every((r) => r.found === r.shift);
    ev.record('lag estimator self-check', results, 'recovers every known shift exactly', ok);
    expect(ok, `K3 self-check: ${JSON.stringify(results)}`).toBe(true);
  });

  it('K3 required clips and modules', async () => {
    ev.record('required clips', 'clips' in REQ ? REQ.clips : REQ.error, 'fixtures/required-clips.json lists the clips for verify/ACTIVE', 'clips' in REQ,
      'clips' in REQ ? `milestone ${REQ.milestone}` : REQ.error);
    await recorded(ev, 'modules load', 'src/sam/cache.ts (masksFromCache), src/track/anchor.ts (trackAnchor)', loadModules);
    expect('clips' in REQ, 'error' in REQ ? REQ.error : '').toBe(true);
  });

  for (const clip of CLIPS) {
    it(`K3 ${clip}: smoothed anchor lags the raw one by <= ${LAG_MAX} frames over the fastest segment`, async () => {
      const input = await recorded(ev, `${clip}: inputs`, 'truth.json (roots), sam-person.json and sam-root.json (SAM 3.1, same clip)',
        () => loadClip(clip), (i) => ({ frames: i.frames, seed: i.seed }));
      const { cache, anchor } = await loadModules();
      const failures: string[] = [];
      for (const kind of ANCHORS) {
        const masks = await cache.masksFromCache(kind === 'point' ? input.root.json : input.person.json, input.frames);
        const track = anchor.trackAnchor(masks, input.seed, FPS);
        const raw = (track.raw as (V2 | null)[]).map((p) => (p && isXy(p) ? p : null));
        const smooth = track.smoothed as V2[];
        const shapeOk = raw.length === input.frames && smooth.length === input.frames && smooth.every(isXy);
        const seg = shapeOk ? fastestSegment(raw) : null;
        const lag = seg ? lagOf(raw, smooth, seg.start) : null;
        const pass = shapeOk && !!lag && Math.abs(lag.lag) <= LAG_MAX;
        ev.record(`${clip}: lag (${kind} anchor)`, lag ? lag.lag : 'not measurable', `|lag| <= ${LAG_MAX} frames`, pass,
          !shapeOk
            ? `trackAnchor returned raw ${raw.length} / smoothed ${smooth.length} frames for a ${input.frames}-frame clip (smoothed must be finite on every frame)`
            : !seg
              ? `no ${WINDOW}-frame stretch with a raw anchor on every frame`
              : `segment frames ${seg.start}-${seg.start + WINDOW - 1}, mean raw speed ${seg.meanSpeed.toFixed(2)} px/frame, correlation ${lag!.corr.toFixed(3)}`);
        if (!pass) failures.push(`${kind} anchor: lag ${lag?.lag ?? 'n/a'}`);
      }
      expect(failures, `K3 ${clip}: threshold |lag| <= ${LAG_MAX} frames`).toEqual([]);
    }, 300_000);
  }
});
