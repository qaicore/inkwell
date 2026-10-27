/// <reference types="node" />
// R5 (SPEC §10, rules): no weakened checks. <id> is the milestone in verify/ACTIVE.
//   Diff 1: git log -p milestone-<id>-start..HEAD -- docs/SPEC.md reference tests/golden "fixtures/*/truth.json"
//           fixtures/manual fixtures/required-clips.json .claude
//           Every commit there must carry the approval token in its message (only Qai writes it).
//   Diff 2: git log -p milestone-<id>-tests..HEAD -- tests/<id>
//           Any loosened assertion fails.
//   Any uncommitted change on those paths (git status --porcelain) fails.
//
// Stricter readings, flagged for Qai:
//   - Diff 1 also covers fixtures/strokes/labels.json and fixtures/clips.json (Qai's files under SPEC §2.5).
//   - Diff 2 runs for every tests/M<n> with n <= <id>, each from its own milestone-M<n>-tests tag, so an earlier
//     milestone's tests can't be loosened later; tests/helpers/ (shared by those tests) is checked from the
//     earliest tests tag. Each tag must exist, be an ancestor of HEAD, and contain tests/M<n>.
//   - "Loosened" is judged conservatively, per commit without the approval token: a removed line carrying a
//     number, an assertion, a comparison, control flow, a pass flag or a string literal (comment-only lines,
//     import lines and unchanged moves of non-assertion lines excepted); an added skip/only/todo/fails, catch,
//     ts-ignore, env gate or bare return; a deleted or renamed test file. Anything else (new tests, new
//     imports) passes.
//   - The status check covers tests/M<n> and tests/helpers/ too, untracked files included.
//   - The tests/helpers/ scan skips the commits the milestone-M<n>-tests tags point at: that is where each
//     milestone's tests, and the helpers they share, are written. Every later commit to tests/helpers/ is
//     checked, and the tests/M<n> scans skip nothing.
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Evidence, ROOT, activeMilestone, git } from '../helpers/evidence.ts';

const ID = 'R5';
const APPROVED = ['[qai', 'approved]'].join('-');
const PROTECTED = [
  'docs/SPEC.md',
  'reference',
  'tests/golden',
  'fixtures/*/truth.json',
  'fixtures/manual',
  'fixtures/required-clips.json',
  '.claude',
  // §2.5: Qai's labels and consent records.
  'fixtures/strokes/labels.json',
  'fixtures/clips.json',
];
const HELPERS = 'tests/helpers';

const ev = new Evidence(ID, [
  'loosening detector self-check',
  'verify/ACTIVE',
  'start tag',
  'unapproved commits on protected paths',
  'tests tags',
  'loosened assertions after the tests tag',
  'uncommitted changes on checked paths',
]);
afterAll(() => ev.write());

// ---------- the loosening detector ----------

// Whole-line comments only: `// ...` or a one-line `/* ... */`. A `*`-led line could be a continued expression.
const COMMENT_ONLY = /^\s*\/\/|^\s*\/\*.*\*\/\s*$/;
const ASSERTION = /\bexpect\b|\bassert\b|\.to[A-Z]\w*\s*\(|\.not\b|\bfail\s*\(|\bthrow\b/;
const WEAKENING_REMOVAL =
  /\d|\bexpect\b|\bassert\b|\.to[A-Z]\w*|\.not\b|[<>]|[!=]==?|\b(it|test|describe)\s*[.(]|\bthreshold\b|\bpass\b|\bthrow\b|\bfail\b|&&|\|\||\?|\bif\b|\breturn\b|\bfor\b|\bwhile\b|\bevery\b|\bsome\b|\bfilter\b|\bfind\b|\bMath\.|\brecord\b|\bexpected\b/;
// A removed string literal can narrow what a check covers ('docs/SPEC.md' dropped from a list) or widen what
// it allows ('.jpg' added to one). Import lines are exempt: fixing a path there loosens nothing.
const STRING_LITERAL = /(['"`]).*?\1/;
const IMPORT_LINE = /^(?:import\b|export\b.*\bfrom\b|\}\s*from\b)/;
const WEAKENING_ADDITION =
  /\.(skip|todo|fails|only|skipIf|runIf)\b|\b(xit|xtest|xdescribe|fit|fdescribe)\s*\(|\bcatch\b|@ts-(nocheck|ignore|expect-error)|\bprocess\.env\b|\breturn\s*;|\bpass\s*[:=]\s*true\b|\bif\s*\(\s*(true|false|0|1)\s*\)|\bretry\s*:|\bpassWithNoTests\b/;

/** Findings in one commit's `git show -U0` patch for a test folder. Empty means nothing was loosened. */
function looseningFindings(patch: string): string[] {
  const findings: string[] = [];
  const files: { name: string; removed: string[]; added: string[]; deleted: boolean; renamed: boolean }[] = [];
  let cur: (typeof files)[number] | undefined;
  for (const line of patch.split('\n')) {
    const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (header) {
      cur = { name: header[2] ?? header[1] ?? '?', removed: [], added: [], deleted: false, renamed: false };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('deleted file mode')) cur.deleted = true;
    else if (line.startsWith('rename from') || line.startsWith('copy from')) cur.renamed = true;
    else if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('@@') || line.startsWith('index ')) continue;
    else if (line.startsWith('-')) cur.removed.push(line.slice(1).replace(/\r$/, ''));
    else if (line.startsWith('+')) cur.added.push(line.slice(1).replace(/\r$/, ''));
  }
  for (const f of files) {
    if (f.deleted) findings.push(`${f.name}: test file deleted`);
    if (f.renamed) findings.push(`${f.name}: test file renamed or copied`);
    const addedPool = new Map<string, number>();
    for (const a of f.added) addedPool.set(a.trim(), (addedPool.get(a.trim()) ?? 0) + 1);
    for (const r of f.removed) {
      const t = r.trim();
      if (!t || COMMENT_ONLY.test(t)) continue;
      // An unchanged non-assertion line that only moved or was re-indented is not a change.
      const n = addedPool.get(t) ?? 0;
      if (n > 0 && !ASSERTION.test(t)) {
        addedPool.set(t, n - 1);
        continue;
      }
      if (WEAKENING_REMOVAL.test(t) || (STRING_LITERAL.test(t) && !IMPORT_LINE.test(t))) findings.push(`${f.name}: removed or changed "${t.slice(0, 160)}"`);
    }
    for (const a of f.added) {
      const t = a.trim();
      if (t && !COMMENT_ONLY.test(t) && WEAKENING_ADDITION.test(t)) findings.push(`${f.name}: added "${t.slice(0, 160)}"`);
    }
  }
  return findings;
}

// ---------- git plumbing ----------

function tagCommit(tag: string): string | null {
  const r = git(['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`]);
  return r.status === 0 ? r.stdout.trim() : null;
}

function isAncestor(commit: string): boolean {
  return git(['merge-base', '--is-ancestor', commit, 'HEAD']).status === 0;
}

interface Commit {
  hash: string;
  subject: string;
  approved: boolean;
}

function commitsTouching(range: string, paths: string[]): Commit[] {
  const r = git(['log', '--format=%H%x1f%s%x1f%B%x1e', range, '--', ...paths]);
  if (r.status !== 0) throw new Error(`git log ${range} failed: ${r.stderr.trim()}`);
  return r.stdout
    .split('\x1e')
    .map((s) => s.replace(/^\s+/, ''))
    .filter(Boolean)
    .map((s) => {
      const [hash = '', subject = '', body = ''] = s.split('\x1f');
      return { hash, subject, approved: body.includes(APPROVED) };
    });
}

function filesIn(hash: string, paths: string[]): string[] {
  const r = git(['show', '--format=', '--name-status', '--no-renames', hash, '--', ...paths]);
  return r.stdout.split('\n').map((l) => l.trim().replace(/\t/g, ' ')).filter(Boolean);
}

function patchOf(hash: string, paths: string[]): string {
  const r = git(['show', '--format=', '-U0', '--no-renames', '--no-color', '--no-ext-diff', hash, '--', ...paths]);
  if (r.status !== 0) throw new Error(`git show ${hash} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

function testDirsUpTo(active: number): number[] {
  const out: number[] = [];
  for (let n = 0; n <= active; n++) {
    const onDisk = existsSync(join(ROOT, 'tests', `M${n}`));
    const inHead = git(['ls-tree', '-d', '--name-only', 'HEAD', `tests/M${n}`]).stdout.trim() !== '';
    if (onDisk || inHead) out.push(n);
  }
  return out;
}

// The commits the tests/helpers/ scan checks: not approved ones, and not a milestone's own tests commit.
function helperCommitsToCheck(commits: Commit[], testsTags: Set<string>): Commit[] {
  return commits.filter((c) => !c.approved && !testsTags.has(c.hash));
}

// ---------- the tests ----------

describe('R5 no weakened checks', () => {
  it('R5 the loosening detector flags weakening edits and passes harmless ones', () => {
    const d = (body: string, extra = '') =>
      `diff --git a/tests/M1/A1.test.ts b/tests/M1/A1.test.ts\n${extra}index 1..2 100644\n--- a/tests/M1/A1.test.ts\n+++ b/tests/M1/A1.test.ts\n@@ -1 +1 @@\n${body}\n`;
    const cases: [string, string, boolean][] = [
      ['threshold changed', d("-    expect(drift).toBeLessThan(0.02);\n+    expect(drift).toBeLessThan(0.03);"), true],
      ['operator relaxed', d('-    const pass = p95 < limit;\n+    const pass = p95 <= limit;'), true],
      ['assertion removed', d('-    expect(changes).toBe(36);'), true],
      ['assertion moved under a condition', d("+    if (frames.length) {\n-    expect(changes).toBe(36);\n+    expect(changes).toBe(36);\n+    }"), true],
      ['test skipped', d("-  it('A1 holds', () => {\n+  it.skip('A1 holds', () => {"), true],
      ['error swallowed', d('+    try { run(); } catch { /* ignore */ }'), true],
      ['file deleted', d('-  expect(1).toBe(1);', 'deleted file mode 100644\n'), true],
      ['protected path dropped from a list', d("-  'docs/SPEC.md',"), true],
      ['allowed list widened', d("-const ALLOWED_PREFIXES = ['src/sam/', 'functions/'];\n+const ALLOWED_PREFIXES = ['src/sam/', 'functions/', 'src/'];"), true],
      ['extension added to a set', d("-const DRAWING_EXTS = new Set(['.svg', '.png']);\n+const DRAWING_EXTS = new Set(['.svg', '.png', '.jpg']);"), true],
      ['multi-line import path fixed', d("-} from '../../src/motion/hold.ts';\n+} from '../../src/motion/held.ts';"), false],
      ['import path fixed', d("-import { hold } from '../../src/motion/hold.ts';\n+import { hold } from '../../src/motion/held.ts';"), false],
      ['new test added', d("+  it('A1 also checks placement', () => {\n+    expect(slide).toBeLessThan(0.5);\n+  });"), false],
      ['comment reworded', d('-  // 3 s at 30 fps\n+  // three seconds at 30 fps'), false],
      ['non-assertion line re-indented', d('-  const clip = synthClip(seed);\n+    const clip = synthClip(seed);'), false],
    ];
    const wrong = cases.filter(([, patch, flagged]) => (looseningFindings(patch).length > 0) !== flagged).map(([n]) => n);
    // The helpers scan skips the tests-tag commit and approved commits, and nothing else.
    const commits: Commit[] = [
      { hash: 'later', subject: 'adds a catch to a helper', approved: false },
      { hash: 'tagged', subject: 'test(M1): acceptance tests', approved: false },
      { hash: 'signed', subject: 'approved change', approved: true },
    ];
    const kept = helperCommitsToCheck(commits, new Set(['tagged'])).map((c) => c.hash);
    if (kept.join(',') !== 'later') wrong.push(`helpers scan kept ${JSON.stringify(kept)}, not ["later"]`);
    ev.record('loosening detector self-check', { misjudged: wrong }, [], wrong.length === 0);
    expect(wrong, 'R5 loosening detector misjudged a planted case').toEqual([]);
  });

  it('R5 protected paths change only in approved commits, tests/<id> is not loosened, nothing is uncommitted', () => {
    const a = activeMilestone();
    ev.record('verify/ACTIVE', 'id' in a ? a.id : a.error, 'a milestone id like M0', 'id' in a, 'error' in a ? a.error : '');
    if (!('id' in a)) throw new Error(a.error);
    const active = a.id;
    const activeN = Number(active.slice(1));

    // Diff 1.
    const startTag = `milestone-${active}-start`;
    const start = tagCommit(startTag);
    const startOk = start !== null && isAncestor(start);
    ev.record('start tag', start ? (isAncestor(start) ? `${startTag} = ${start.slice(0, 7)}` : `${startTag} is not an ancestor of HEAD`) : `${startTag} missing`,
      'exists and is an ancestor of HEAD', startOk,
      start ? '' : `tag ${startTag} missing: /milestone creates it at the start (SPEC §4)`);
    let unapproved: { commit: string; subject: string; files: string[] }[] = [];
    if (start) {
      unapproved = commitsTouching(`${start}..HEAD`, PROTECTED)
        .filter((c) => !c.approved)
        .map((c) => ({ commit: c.hash.slice(0, 7), subject: c.subject, files: filesIn(c.hash, PROTECTED) }));
    }
    ev.record('unapproved commits on protected paths', start ? unapproved : 'not measured: start tag missing', [], startOk && unapproved.length === 0,
      unapproved.map((u) => `${u.commit} "${u.subject}": ${u.files.join(', ')}`).join('; '));

    // Diff 2, for every tests/M<n> up to the active milestone, plus tests/helpers.
    const dirs = testDirsUpTo(activeN);
    if (!dirs.includes(activeN)) dirs.push(activeN);
    dirs.sort((x, y) => x - y);
    const tagProblems: string[] = [];
    const findings: string[] = [];
    let earliestTests: string | null = null;
    const testsTags = new Set<string>();
    for (const n of dirs) {
      const dir = `tests/M${n}`;
      const tag = `milestone-M${n}-tests`;
      const c = tagCommit(tag);
      if (!c) {
        tagProblems.push(`tag ${tag} missing: tag the commit that adds ${dir} (SPEC §4 step 2)`);
        continue;
      }
      if (!isAncestor(c)) {
        tagProblems.push(`tag ${tag} is not an ancestor of HEAD (history was rewritten)`);
        continue;
      }
      if (git(['ls-tree', '-r', '--name-only', c, '--', dir]).stdout.trim() === '') {
        tagProblems.push(`tag ${tag} has no ${dir}: it must point at the commit that adds the tests`);
        continue;
      }
      earliestTests ??= c;
      testsTags.add(c);
      for (const commit of commitsTouching(`${c}..HEAD`, [dir])) {
        if (commit.approved) continue;
        for (const f of looseningFindings(patchOf(commit.hash, [dir]))) findings.push(`${commit.hash.slice(0, 7)} "${commit.subject}": ${f}`);
      }
    }
    if (earliestTests) {
      for (const commit of helperCommitsToCheck(commitsTouching(`${earliestTests}..HEAD`, [HELPERS]), testsTags)) {
        for (const f of looseningFindings(patchOf(commit.hash, [HELPERS]))) findings.push(`${commit.hash.slice(0, 7)} "${commit.subject}": ${f}`);
      }
    }
    ev.record('tests tags', tagProblems.length ? tagProblems : dirs.map((n) => `milestone-M${n}-tests ok`),
      'milestone-M<n>-tests exists, is an ancestor of HEAD and contains tests/M<n>, for every n <= active', tagProblems.length === 0,
      tagProblems.join('; '));
    ev.record('loosened assertions after the tests tag', findings, [], tagProblems.length === 0 && findings.length === 0,
      tagProblems.length ? 'only partly measured: a tests tag is missing' : findings.join('; '));

    // Uncommitted changes.
    const checked = [...PROTECTED, ...dirs.map((n) => `tests/M${n}`), HELPERS];
    const st = git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...checked]);
    if (st.status !== 0) throw new Error(`git status failed: ${st.stderr.trim()}`);
    const dirty: string[] = [];
    const parts = st.stdout.split('\0').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i] ?? '';
      dirty.push(p);
      if (/^[RC]/.test(p)) i++; // a rename's source path follows
    }
    ev.record('uncommitted changes on checked paths', dirty, [], dirty.length === 0,
      dirty.length ? 'commit these (Qai commits his own files with the approval token)' : '');

    expect(startOk, `start tag ${startTag}: missing or not an ancestor of HEAD`).toBe(true);
    expect(unapproved, `protected paths changed without the approval token:\n${JSON.stringify(unapproved, null, 2)}`).toEqual([]);
    expect(tagProblems, tagProblems.join('\n')).toEqual([]);
    expect(findings, `loosened checks:\n${findings.join('\n')}`).toEqual([]);
    expect(dirty, `uncommitted changes on checked paths:\n${dirty.join('\n')}`).toEqual([]);
  });
});
