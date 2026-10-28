/// <reference types="node" />
// PROBE (SPEC §10, gates): fixtures/probe/report.md and strip.png exist and contain everything listed in the Probe
// part of §9:
//   1. the median and p95 frame-to-frame centroid jump for each prompt (person, face, the back point), as % of body
//      height
//   2. the face-present timeline
//   3. Wonder's 8 labels
//   4. fixtures/probe/strip.png, every 10th frame with the masks overlaid
//   plus §9's run itself: SAM three ways (person, face, one point on his back, propagated in both directions).
//
// Read at runtime: fixtures/probe/report.md and strip.png, and, to check the report's numbers against what the probe
// actually got back, the cached responses next to them: sam-person.json, sam-face.json, sam-back.json and
// wonder-facing.json (missing = FAIL; nothing is re-requested).
//   - Jumps are recomputed here from the cached masks (decoded with the probe's @meta-sam/parser reader; centroid and
//     box measured from the raster here): jump(f) = |c(f) - c(f - 1)| / person box height(f), over consecutive frames
//     that both have a mask; percentiles linear between closest ranks. The report's 2-decimal figures must match
//     within rounding (0.005 points).
//   - The face-present runs listed in the report must equal the runs of frames with a cached face mask.
//   - Wonder's table must have exactly 8 rows, valid classes (§7) and confidences 0..1, equal to the cached labels.
//   - strip.png must decode as a PNG with real content (not one flat color); the report must say it's every 10th
//     frame and name the overlay for each of the three prompts.
// Stricter readings, flagged for Qai:
//   - "exist" means exist in the repo: report.md and strip.png are tracked by git with no uncommitted changes, so
//     the evidence the checkers read is the evidence Qai committed (committing it is Qai's call);
//   - the report's numbers must agree with the cached SAM and Wonder responses, not just be present.
// Not decided here (Qai's call, recorded as notes): whether this run counts as the §9 probe. §9 describes a 10 s slow
// turn; the Oct 27 result says the clip was the hero spin and slam. The test reports the clip's length and the back
// point's frame, and leaves "a frame where his back shows" to Qai.
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { framesFromRecords, parseCachedOutput, type FrameMask } from '../../scripts/probe/masks.ts';
import { Evidence, ROOT, git, readText } from '../helpers/evidence.ts';
import { errMsg, pngSize } from '../helpers/engine.ts';

const ID = 'PROBE';
const DIR = 'fixtures/probe';
const STRIP_EVERY = 10; // SPEC §9
const LABELS = 8; // SPEC §9
const CLASSES = ['front', 'right', 'back', 'left'];
const ROUNDING = 0.005 + 1e-9;

const ev = new Evidence(ID, [
  'report.md and strip.png exist',
  'report.md and strip.png committed',
  'centroid jump: median and p95 per prompt, % of body height',
  'centroid jumps match the cached SAM responses',
  'face-present timeline',
  'face-present timeline matches the cached face masks',
  'back point placed on one frame and propagated both ways',
  "Wonder's 8 labels",
  'strip.png: every 10th frame with the masks overlaid',
  'clip and back point (for Qai)',
]);
afterAll(() => ev.write());

const has = (rel: string) => existsSync(join(ROOT, rel));

function report(): string {
  const rel = `${DIR}/report.md`;
  if (!has(rel)) throw new Error(`${rel} missing: Qai runs npm run probe once he says go (SPEC §9)`);
  return readText(join(ROOT, rel));
}

function cached(name: string): Record<string, unknown> {
  const rel = `${DIR}/${name}`;
  if (!has(rel)) throw new Error(`${rel} missing: the probe caches it next to report.md; Qai must add it (SPEC §9)`);
  try {
    return JSON.parse(readText(join(ROOT, rel))) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`${rel} is not valid JSON: ${errMsg(e)}`);
  }
}

/** The markdown section under "## <title...>" up to the next "## ". */
function section(md: string, title: RegExp): string | null {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s/.test(l) && title.test(l));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

/** Rows of the first markdown table in `text`, keyed by its header cells. */
function table(text: string): Record<string, string>[] {
  const rows = text.split(/\r?\n/).filter((l) => /^\s*\|/.test(l));
  if (rows.length < 2) return [];
  const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const head = cells(rows[0]!).map((h) => h.toLowerCase());
  return rows.slice(2).map((r) => Object.fromEntries(cells(r).map((c, i) => [head[i] ?? `c${i}`, c])));
}

const pct = (cell: string | undefined): number | null => {
  const m = cell?.match(/^(-?\d+(?:\.\d+)?)\s*%$/);
  return m ? Number(m[1]) : null;
};

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const at = p * (s.length - 1);
  const lo = Math.floor(at);
  const hi = Math.min(s.length - 1, lo + 1);
  return s[lo]! + (s[hi]! - s[lo]!) * (at - lo);
}

interface Moments {
  cx: number;
  cy: number;
  boxH: number;
}

function moments(m: FrameMask): Moments | null {
  const sx = (m.bounds.right - m.bounds.left) / m.width;
  const sy = (m.bounds.bottom - m.bounds.top) / m.height;
  let n = 0;
  let sc = 0;
  let sr = 0;
  let top = -1;
  let bottom = -1;
  for (let r = 0; r < m.height; r++) {
    let any = false;
    for (let c = 0; c < m.width; c++) {
      if (!m.raster[r * m.width + c]) continue;
      n++;
      sc += c;
      sr += r;
      any = true;
    }
    if (any) {
      if (top < 0) top = r;
      bottom = r;
    }
  }
  if (!n) return null;
  return { cx: m.bounds.left + (sc / n + 0.5) * sx, cy: m.bounds.top + (sr / n + 0.5) * sy, boxH: (bottom - top + 1) * sy };
}

async function decode(json: Record<string, unknown>, name: string, frames: number): Promise<(Moments | null)[]> {
  if (typeof json.rawOutput !== 'string') throw new Error(`${DIR}/${name} has no rawOutput`);
  const masks = framesFromRecords((await parseCachedOutput(json.rawOutput)).records, frames);
  return masks.map((m) => (m ? moments(m) : null));
}

function frameCountOf(md: string): number | null {
  const m = md.match(/(\d+)\s+frames at\s+30\s*fps/i);
  return m ? Number(m[1]) : null;
}

function runsOf(present: boolean[]): string[] {
  const out: { a: number; b: number; p: boolean }[] = [];
  present.forEach((p, f) => {
    const last = out[out.length - 1];
    if (last && last.p === p) last.b = f;
    else out.push({ a: f, b: f, p });
  });
  return out.map((r) => `${r.a}-${r.b}:${r.p ? 'face' : 'no face'}`);
}

describe('PROBE report and strip', () => {
  it('PROBE report.md and strip.png exist and are committed', () => {
    const files = [`${DIR}/report.md`, `${DIR}/strip.png`];
    const missing = files.filter((f) => !has(f));
    ev.record('report.md and strip.png exist', missing.length ? { missing } : 'both present', 'both files exist', missing.length === 0,
      missing.length ? `${missing.join(', ')} missing: Qai runs npm run probe once he says go (SPEC §9)` : '');
    const tracked = git(['ls-files', '--', ...files]).stdout.split(/\r?\n/).filter(Boolean);
    const dirty = git(['status', '--porcelain', '--', ...files]).stdout.split(/\r?\n/).filter(Boolean);
    const untracked = files.filter((f) => !tracked.includes(f));
    const ok = untracked.length === 0 && dirty.length === 0;
    ev.record('report.md and strip.png committed', { untracked, uncommitted: dirty }, 'tracked by git, no uncommitted changes', ok,
      ok ? '' : 'the probe run is on disk but not committed; whether it counts, and committing it, is Qai\'s call (stricter reading of "exist")');
    expect(missing, 'PROBE files missing').toEqual([]);
    expect(ok, `PROBE evidence not committed: untracked ${JSON.stringify(untracked)}, uncommitted ${JSON.stringify(dirty)}`).toBe(true);
  });

  it('PROBE centroid jumps: median and p95 per prompt, as % of body height, matching the cached SAM runs', async () => {
    let md = '';
    let rows: Record<string, string>[] = [];
    let sec: string | null = null;
    try {
      md = report();
      sec = section(md, /centroid jump/i);
      rows = sec ? table(sec) : [];
    } catch (e) {
      ev.record('centroid jump: median and p95 per prompt, % of body height', 'missing', 'a table with median and p95 for person, face and the back point', false, errMsg(e));
      throw e;
    }
    const want = [
      { name: 'person', match: /`?person`?/i, file: 'sam-person.json' },
      { name: 'face', match: /`?face`?/i, file: 'sam-face.json' },
      { name: 'back point', match: /back/i, file: 'sam-back.json' },
    ];
    const found = want.map((w) => {
      const row = rows.find((r) => w.match.test(r.prompt ?? '') && (w.name !== 'person' || !/back/i.test(r.prompt ?? '')));
      return { ...w, row, median: pct(row?.median), p95: pct(row?.p95) };
    });
    const unitOk = !!sec && /body height/i.test(sec) && /%/.test(sec);
    const present = found.every((f) => f.median !== null && f.p95 !== null) && unitOk;
    ev.record('centroid jump: median and p95 per prompt, % of body height', found.map((f) => ({ prompt: f.name, median: f.median, p95: f.p95 })),
      'median and p95 (in %) for person, face and the back point, stated as % of body height', present,
      present ? '' : `${!sec ? 'no "Centroid jump" section' : !unitOk ? 'the section does not say the jumps are % of body height' : `rows missing or unreadable: ${found.filter((f) => f.median === null || f.p95 === null).map((f) => f.name).join(', ')}`}`);

    const frames = frameCountOf(md);
    const mismatches: string[] = [];
    const recomputed: { prompt: string; median: number | null; p95: number | null }[] = [];
    try {
      if (frames === null) throw new Error('report.md does not state the clip\'s frame count ("<n> frames at 30 fps")');
      const person = cached('sam-person.json');
      const processed = (person.usage as { video_frames_processed?: unknown } | undefined)?.video_frames_processed;
      if (processed !== frames) mismatches.push(`report says ${frames} frames, sam-person.json processed ${JSON.stringify(processed)}`);
      const personM = await decode(person, 'sam-person.json', frames);
      for (const f of found) {
        const json = f.file === 'sam-person.json' ? person : cached(f.file);
        if (json.model !== 'sam-3.1') mismatches.push(`${f.file} model is ${JSON.stringify(json.model)}, not sam-3.1`);
        const m = f.file === 'sam-person.json' ? personM : await decode(json, f.file, frames);
        const jumps: number[] = [];
        for (let i = 1; i < frames; i++) {
          const a = m[i - 1];
          const b = m[i];
          const h = personM[i]?.boxH;
          if (!a || !b || !h) continue;
          jumps.push((100 * Math.hypot(b.cx - a.cx, b.cy - a.cy)) / h);
        }
        const med = percentile(jumps, 0.5);
        const p95 = percentile(jumps, 0.95);
        recomputed.push({ prompt: f.name, median: med, p95 });
        if (f.median === null || med === null || Math.abs(f.median - med) > ROUNDING) mismatches.push(`${f.name} median: report ${f.median}%, cache ${med}%`);
        if (f.p95 === null || p95 === null || Math.abs(f.p95 - p95) > ROUNDING) mismatches.push(`${f.name} p95: report ${f.p95}%, cache ${p95}%`);
      }
    } catch (e) {
      mismatches.push(errMsg(e));
    }
    ev.record('centroid jumps match the cached SAM responses', recomputed, `report figures within ${0.005} points of the jumps recomputed from the cached masks`,
      mismatches.length === 0, mismatches.join('; '));
    expect(present, 'PROBE report.md lacks median/p95 jumps per prompt as % of body height').toBe(true);
    expect(mismatches, 'PROBE report jumps vs cached SAM masks').toEqual([]);
  }, 300_000);

  it('PROBE face-present timeline, matching the cached face masks', async () => {
    let md = '';
    let sec: string | null = null;
    try {
      md = report();
      sec = section(md, /face.?present/i);
    } catch (e) {
      ev.record('face-present timeline', 'missing', 'a face-present timeline section', false, errMsg(e));
      throw e;
    }
    const listed = (sec ?? '')
      .split(/\r?\n/)
      .map((l) => l.match(/^\s*-\s*frames\s+(\d+)\s*-\s*(\d+)\b.*:\s*(face|no face)\s*$/i))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => `${Number(m[1])}-${Number(m[2])}:${m[3]!.toLowerCase()}`);
    const bar = /```[\s\S]*?[#.]{3,}[\s\S]*?```/.test(sec ?? '');
    const present = !!sec && listed.length > 0 && bar;
    ev.record('face-present timeline', { runs: listed, bar }, 'a timeline bar and the face / no-face frame ranges', present,
      present ? '' : !sec ? 'no "Face-present timeline" section' : 'the section has no bar or no frame ranges');

    let truth: string[] = [];
    let problem = '';
    try {
      const frames = frameCountOf(md);
      if (frames === null) throw new Error('report.md does not state the clip\'s frame count');
      const face = await decode(cached('sam-face.json'), 'sam-face.json', frames);
      truth = runsOf(face.map(Boolean));
    } catch (e) {
      problem = errMsg(e);
    }
    const same = !problem && JSON.stringify(listed) === JSON.stringify(truth);
    ev.record('face-present timeline matches the cached face masks', { report: listed, cache: truth }, 'identical runs', same, problem);
    expect(present, 'PROBE report.md lacks the face-present timeline').toBe(true);
    expect(same, `PROBE timeline vs cache: ${problem}`).toBe(true);
  }, 300_000);

  it('PROBE back point: one point on one frame, propagated in both directions', () => {
    let notes = '';
    let ok = false;
    let measured: unknown = 'missing';
    try {
      const md = report();
      const sec = section(md, /back point/i) ?? '';
      const m = sec.match(/\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)\)\s*on frame\s+(\d+)/i);
      const both = /both directions/i.test(sec);
      const back = cached('sam-back.json');
      const point = back.point as { frame?: unknown; x?: unknown; y?: unknown } | undefined;
      const prop = (back.metadata as { propagation_direction?: unknown } | undefined)?.propagation_direction;
      const promptIsPoint = typeof back.text === 'string' && /<\|point;/.test(back.text);
      measured = { report: m ? { x: Number(m[1]), y: Number(m[2]), frame: Number(m[3]) } : null, saysBothDirections: both, cache: { point, propagation: prop, promptIsPoint } };
      const agree = !!m && !!point && Number(m[3]) === point.frame && Number(m[1]) === point.x && Number(m[2]) === point.y;
      ok = !!m && both && prop === 'both' && promptIsPoint && agree && back.model === 'sam-3.1';
      if (!ok) notes = [!m && 'report gives no "(x, y) on frame n"', !both && 'report does not say it was propagated in both directions', prop !== 'both' && `sam-back.json propagation_direction is ${JSON.stringify(prop)}`, !promptIsPoint && 'sam-back.json prompt is not a point', m && !agree && 'report and sam-back.json disagree on the point'].filter(Boolean).join('; ');
    } catch (e) {
      notes = errMsg(e);
    }
    ev.record('back point placed on one frame and propagated both ways', measured, 'report names the point and frame; the cached run is a SAM 3.1 point prompt propagated both ways', ok, notes);
    expect(ok, `PROBE back point: ${notes}`).toBe(true);
  });

  it("PROBE Wonder's 8 labels, matching the cached facing response", () => {
    let rows: { frame: number; label: string; conf: number }[] = [];
    let notes = '';
    let ok = false;
    try {
      const md = report();
      const sec = section(md, /wonder/i) ?? '';
      rows = table(sec).map((r) => ({ frame: Number(r.frame), label: (r['wonder says'] ?? '').toLowerCase(), conf: Number(r.confidence) }));
      const valid = rows.length === LABELS && rows.every((r) => Number.isInteger(r.frame) && CLASSES.includes(r.label) && r.conf >= 0 && r.conf <= 1);
      const cache = cached('wonder-facing.json');
      const labels = Array.isArray(cache.labels) ? (cache.labels as { frame?: unknown; facing?: unknown; confidence?: unknown }[]) : [];
      const agree = labels.length === rows.length && labels.every((l, i) => l.frame === rows[i]!.frame && l.facing === rows[i]!.label && typeof l.confidence === 'number' && Math.abs(l.confidence - rows[i]!.conf) <= ROUNDING);
      ok = valid && agree;
      if (!valid) notes = `report has ${rows.length} rows (need ${LABELS}, each with a frame, a class from ${CLASSES.join('/')} and a confidence 0..1)`;
      else if (!agree) notes = 'report labels differ from wonder-facing.json';
    } catch (e) {
      notes = errMsg(e);
    }
    ev.record("Wonder's 8 labels", rows, `${LABELS} rows: frame, facing class, confidence 0..1; equal to the cached labels`, ok, notes);
    expect(ok, `PROBE Wonder labels: ${notes}`).toBe(true);
  });

  it('PROBE strip.png: every 10th frame with the masks overlaid', async () => {
    let notes = '';
    let ok = false;
    let measured: unknown = 'missing';
    try {
      const rel = `${DIR}/strip.png`;
      if (!has(rel)) throw new Error(`${rel} missing: Qai runs npm run probe once he says go (SPEC §9)`);
      const buf = readFileSync(join(ROOT, rel));
      const size = pngSize(buf);
      if (!size) throw new Error(`${rel} is not a PNG`);
      const { createCanvas, loadImage } = await import('@napi-rs/canvas');
      const img = await loadImage(buf);
      const c = createCanvas(img.width, img.height);
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, img.width, img.height).data;
      const colors = new Set<number>();
      for (let i = 0; i < data.length && colors.size < 1000; i += 4 * 97) colors.add((data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!);
      const sec = section(report(), /strip/i) ?? '';
      const every = sec.match(/every\s+(\d+)(?:st|nd|rd|th)?\s+frame/i);
      const overlays = { person: /person/i.test(sec), face: /face/i.test(sec), back: /back point/i.test(sec) };
      measured = { width: size.width, height: size.height, sampledColors: colors.size, every: every ? Number(every[1]) : null, overlays };
      ok = colors.size > 16 && !!every && Number(every[1]) === STRIP_EVERY && overlays.person && overlays.face && overlays.back;
      if (!ok) notes = [colors.size <= 16 && 'strip.png is (nearly) one flat color', (!every || Number(every[1]) !== STRIP_EVERY) && `report does not say the strip is every ${STRIP_EVERY}th frame`, !(overlays.person && overlays.face && overlays.back) && 'report does not name the overlay for each of person, face and the back point'].filter(Boolean).join('; ');
    } catch (e) {
      notes = errMsg(e);
    }
    ev.record('strip.png: every 10th frame with the masks overlaid', measured, `a decodable PNG with content; every ${STRIP_EVERY}th frame; overlays for person, face, back point`, ok, notes);
    expect(ok, `PROBE strip: ${notes}`).toBe(true);
  }, 120_000);

  it('PROBE clip and back point, reported for Qai (not judged)', () => {
    let measured: unknown = 'unknown';
    let notes = '';
    try {
      const md = report();
      const frames = frameCountOf(md);
      const back = cached('sam-back.json').point as { frame?: unknown } | undefined;
      measured = { frames, seconds: frames === null ? null : frames / 30, backPointFrame: back?.frame ?? null };
      notes = `§9 describes a 10 s slow turn; this clip is ${frames === null ? 'of unknown length' : `${(frames / 30).toFixed(1)} s`} (the Oct 27 result: the hero spin and slam). Whether this run counts as the probe, and whether frame ${String(back?.frame ?? '?')} shows his back, is Qai's call.`;
    } catch (e) {
      notes = errMsg(e);
    }
    ev.record('clip and back point (for Qai)', measured, 'informational: Qai decides whether this run counts', true, notes);
  });
});
