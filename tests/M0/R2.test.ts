/// <reference types="node" />
// R2 (SPEC §10, rules): no anime material.
//   reference/ holds only JSON plus the drawings listed in reference/manifest.json.
//   fixtures/ holds only: JSON (cached SAM and Wonder responses, truth files, manual/); the clips listed in
//   fixtures/clips.json with consent noted; fixtures/probe/report.md and fixtures/probe/strip.png.
//
// Measured on every file on disk under reference/ and fixtures/ (tracked, untracked and gitignored alike:
// a local file is one `git add` away from the public repo) plus every tracked path there.
// Stricter readings, flagged for Qai:
//   - a manifest entry counts only if it names the file and carries a line saying it's his own work (§11),
//     and listed drawings must be svg or png (§11);
//   - a listed clip must be .mp4 or .mov (§1), name who is in it, and have consent noted: "self" only when
//     the only person is Qai, otherwise a written-consent date (YYYY-MM-DD) (§2.7, §11);
//   - file names that suggest anime frames or audio fail anywhere under reference/ and fixtures/, and for
//     tracked image, video or audio files anywhere in the repo (rules-auditor's R2 step).
// Reads Qai's manifest.json and clips.json at runtime; missing files fail, they are never defaulted.
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { Evidence, ROOT, git, slash } from '../helpers/evidence.ts';

const ID = 'R2';
const ev = new Evidence(ID, [
  'classifier self-check',
  'reference/manifest.json readable',
  'fixtures/clips.json readable',
  'reference/ files not allowed',
  'fixtures/ files not allowed',
  'anime-suggesting names',
]);
afterAll(() => ev.write());

// ---------- rules as pure functions ----------

const DRAWING_EXTS = new Set(['.svg', '.png']);
const CLIP_EXTS = new Set(['.mp4', '.mov']);
const MEDIA_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.tif', '.tiff', '.heic', '.svg',
  '.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.gifv',
  '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.flac', '.opus', '.wma',
]);
// Words in a file name that suggest anime footage, frames or audio.
const ANIME_NAME =
  /(anime|kaneki|ghoul|crunchyroll|funimation|episode|screencap|(^|[^a-z])s\d{1,2}e\d{1,3}([^0-9]|$)|(^|[^a-z])ep\.?[-_ ]?\d{1,3}([^0-9]|$)|(^|[^a-z])op\d?[-_ ]|(^|[^a-z])ost([^a-z]|$))/i;

interface Manifest {
  files: Map<string, string>; // normalized path -> problem ('' when the entry is fine)
  problems: string[];
}

function normRef(p: string): string {
  const s = slash(p.trim());
  return s.startsWith('reference/') ? s : `reference/${s}`;
}

function parseManifest(json: unknown): Manifest {
  const files = new Map<string, string>();
  const problems: string[] = [];
  const list = (json as { files?: unknown } | null)?.files;
  if (!Array.isArray(list)) {
    problems.push('reference/manifest.json has no "files" array');
    return { files, problems };
  }
  list.forEach((entry, i) => {
    if (typeof entry === 'string') {
      files.set(normRef(entry), `manifest entry ${i} ("${entry}") has no line saying it's Qai's own work`);
      return;
    }
    if (!entry || typeof entry !== 'object') {
      problems.push(`manifest entry ${i} is not an object`);
      return;
    }
    const rec = entry as Record<string, unknown>;
    const key = typeof rec.file === 'string' ? 'file' : typeof rec.path === 'string' ? 'path' : '';
    if (!key) {
      problems.push(`manifest entry ${i} names no file (expected a "file" or "path" field)`);
      return;
    }
    const statement = Object.entries(rec).some(([k, v]) => k !== key && typeof v === 'string' && v.trim() !== '');
    files.set(normRef(rec[key] as string), statement ? '' : `manifest entry ${i} has no line saying it's Qai's own work`);
  });
  return { files, problems };
}

function classifyReference(rel: string, manifest: Manifest): string {
  const ext = extname(rel).toLowerCase();
  if (ext === '.json') return '';
  const listed = manifest.files.get(rel);
  if (listed === undefined) return `${rel}: not JSON and not listed in reference/manifest.json`;
  if (!DRAWING_EXTS.has(ext)) return `${rel}: listed in the manifest but not an svg or png drawing`;
  return listed ? `${rel}: ${listed}` : '';
}

interface ClipEntry {
  id: string;
  people: string[];
  consent: string;
}

function parseClips(json: unknown): { byFile: Map<string, ClipEntry>; problems: string[] } {
  const byFile = new Map<string, ClipEntry>();
  const problems: string[] = [];
  const list = (json as { clips?: unknown } | null)?.clips;
  if (!Array.isArray(list)) {
    problems.push('fixtures/clips.json has no "clips" array');
    return { byFile, problems };
  }
  list.forEach((entry, i) => {
    const rec = (entry ?? {}) as Record<string, unknown>;
    if (typeof rec.file !== 'string' || !rec.file.trim()) {
      problems.push(`clips.json entry ${i} has no "file"`);
      return;
    }
    const people = Array.isArray(rec.people) ? rec.people.filter((p): p is string => typeof p === 'string') : [];
    byFile.set(slash(rec.file.trim()), {
      id: typeof rec.id === 'string' ? rec.id : `#${i}`,
      people,
      consent: typeof rec.consent === 'string' ? rec.consent.trim() : '',
    });
  });
  return { byFile, problems };
}

function consentProblem(c: ClipEntry): string {
  if (c.people.length === 0) return `clip ${c.id}: clips.json doesn't say who is in it`;
  if (!c.consent) return `clip ${c.id}: no consent noted in clips.json`;
  const onlyQai = c.people.every((p) => p.trim().toLowerCase() === 'qai');
  if (onlyQai) return c.consent.toLowerCase() === 'self' || /\d{4}-\d{2}-\d{2}/.test(c.consent) ? '' : `clip ${c.id}: consent "${c.consent}" is neither "self" nor a date`;
  if (c.consent.toLowerCase() === 'self') return `clip ${c.id}: shows ${c.people.join(', ')} but consent says "self"`;
  return /\d{4}-\d{2}-\d{2}/.test(c.consent) ? '' : `clip ${c.id}: consent "${c.consent}" has no written-consent date (YYYY-MM-DD)`;
}

function classifyFixture(rel: string, clips: Map<string, ClipEntry>): string {
  const ext = extname(rel).toLowerCase();
  if (ext === '.json') return '';
  if (rel === 'fixtures/probe/report.md' || rel === 'fixtures/probe/strip.png') return '';
  const clip = clips.get(rel);
  if (!clip) return `${rel}: not JSON, not a clip listed in fixtures/clips.json, not probe/report.md or probe/strip.png`;
  if (!CLIP_EXTS.has(ext)) return `${rel}: listed in clips.json but not an .mp4 or .mov clip`;
  const consent = consentProblem(clip);
  return consent ? `${rel}: ${consent}` : '';
}

function animeName(rel: string): boolean {
  return ANIME_NAME.test(rel.split('/').pop() ?? rel) || ANIME_NAME.test(rel);
}

// ---------- reading the repo ----------

function walk(rel: string): string[] {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return [];
  if (!statSync(abs).isDirectory()) return [rel];
  return readdirSync(abs).flatMap((name) => walk(`${rel}/${name}`));
}

function tracked(paths: string[]): string[] {
  const r = git(['ls-files', '-z', '--', ...paths]);
  if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr}`);
  return r.stdout.split('\0').filter(Boolean).map(slash);
}

function filesUnder(top: string): string[] {
  return [...new Set([...walk(top), ...tracked([top])])].sort();
}

function readJson(rel: string): { ok: true; json: unknown } | { ok: false; error: string } {
  const p = join(ROOT, rel);
  if (!existsSync(p)) return { ok: false, error: `${rel} missing: Qai must add it` };
  try {
    return { ok: true, json: JSON.parse(readFileSync(p, 'utf8')) };
  } catch (e) {
    return { ok: false, error: `${rel} is not valid JSON: ${(e as Error).message}` };
  }
}

// ---------- the tests ----------

describe('R2 no anime material: reference/ and fixtures/ hold only what SPEC allows', () => {
  it('R2 the classifier rejects planted violations and accepts allowed files', () => {
    const manifest = parseManifest({
      files: [{ file: 'reference/views/front.svg', note: 'my own drawing' }, 'reference/bare.png', { file: 'reference/x.jpg', note: 'mine' }],
    });
    const clips = parseClips({
      clips: [
        { id: 'probe', file: 'fixtures/probe/clip.mp4', people: ['Qai'], consent: 'self' },
        { id: 'friend', file: 'fixtures/friend-turn/clip.mp4', people: ['Qai', 'Sam'], consent: 'self' },
        { id: 'friend2', file: 'fixtures/friend2/clip.mov', people: ['Sam'], consent: 'written, 2026-11-01' },
      ],
    }).byFile;
    const cases: [string, boolean][] = [
      [classifyReference('reference/timing.json', manifest), true],
      [classifyReference('reference/views/front.svg', manifest), true],
      [classifyReference('reference/frame-012.png', manifest), false],
      [classifyReference('reference/bare.png', manifest), false],
      [classifyReference('reference/x.jpg', manifest), false],
      [classifyFixture('fixtures/side-step/truth.json', clips), true],
      [classifyFixture('fixtures/probe/report.md', clips), true],
      [classifyFixture('fixtures/probe/strip.png', clips), true],
      [classifyFixture('fixtures/probe/clip.mp4', clips), true],
      [classifyFixture('fixtures/friend2/clip.mov', clips), true],
      [classifyFixture('fixtures/friend-turn/clip.mp4', clips), false],
      [classifyFixture('fixtures/side-step/clip.mp4', clips), false],
      [classifyFixture('fixtures/side-step/frame.png', clips), false],
      [classifyFixture('fixtures/walk/audio.wav', clips), false],
      [classifyFixture('fixtures/probe/notes.md', clips), false],
    ];
    const wrong = cases.map(([reason, allowed], i) => ({ i, reason, allowed })).filter((c) => (c.reason === '') !== c.allowed);
    const names: [string, boolean][] = [
      ['fixtures/kaneki-frames.json', true],
      ['reference/tg_s01e12_still.json', true],
      ['assets/opening_ep3.png', true],
      ['fixtures/side-step/truth.json', false],
      ['reference/views/kagune.json', false],
      ['tests/golden/M1/sheet.png', false],
    ];
    const wrongNames = names.filter(([p, bad]) => animeName(p) !== bad).map(([p]) => p);
    const ok = wrong.length === 0 && wrongNames.length === 0;
    ev.record('classifier self-check', { misclassified: wrong.length + wrongNames.length }, 0, ok,
      ok ? '' : `wrong: ${JSON.stringify(wrong)} ${wrongNames.join(', ')}`);
    expect(wrong, 'R2 classifier misclassified a planted case').toEqual([]);
    expect(wrongNames, 'R2 name check misclassified a planted case').toEqual([]);
  });

  it('R2 reference/ holds only JSON plus the svg/png drawings listed in reference/manifest.json', () => {
    const m = readJson('reference/manifest.json');
    ev.record('reference/manifest.json readable', m.ok ? 'ok' : m.error, 'present, valid JSON, a "files" array', m.ok,
      m.ok ? '' : m.error);
    if (!m.ok) throw new Error(m.error);
    const manifest = parseManifest(m.json);
    const files = filesUnder('reference');
    const bad = [...manifest.problems, ...files.map((f) => classifyReference(f, manifest)).filter(Boolean)];
    ev.record('reference/ files not allowed', { files: files.length, notAllowed: bad }, [], bad.length === 0);
    expect(bad, `reference/ violations:\n${bad.join('\n')}`).toEqual([]);
  });

  it('R2 fixtures/ holds only JSON, consented clips from fixtures/clips.json, and probe/report.md + strip.png', () => {
    const c = readJson('fixtures/clips.json');
    ev.record('fixtures/clips.json readable', c.ok ? 'ok' : c.error, 'present, valid JSON, a "clips" array', c.ok,
      c.ok ? '' : c.error);
    if (!c.ok) throw new Error(c.error);
    const clips = parseClips(c.json);
    const files = filesUnder('fixtures');
    const bad = [...clips.problems, ...files.map((f) => classifyFixture(f, clips.byFile)).filter(Boolean)];
    ev.record('fixtures/ files not allowed', { files: files.length, notAllowed: bad }, [], bad.length === 0);
    expect(bad, `fixtures/ violations:\n${bad.join('\n')}`).toEqual([]);
  });

  it('R2 no file name suggests anime frames or audio (reference/, fixtures/, and tracked media anywhere)', () => {
    const scoped = [...filesUnder('reference'), ...filesUnder('fixtures')];
    const media = tracked(['.']).filter((p) => MEDIA_EXTS.has(extname(p).toLowerCase()));
    const hits = [...new Set([...scoped, ...media])].filter(animeName).sort();
    ev.record('anime-suggesting names', { checked: scoped.length + media.length, flagged: hits }, [], hits.length === 0);
    expect(hits, `file names suggesting anime material:\n${hits.join('\n')}`).toEqual([]);
  });
});
