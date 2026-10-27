/// <reference types="node" />
// R1 (SPEC §10, rules): `node scripts/scan-secrets.mjs` exits 0, and `.env` / `.dev.vars` were never
// committed (`git log --all -- .env .dev.vars` prints nothing).
//
// This test never opens .env or .dev.vars and never relays the scanner's raw output: it reports only
// the `file:line NAME` parts of each line, so a buggy scanner can't leak a key into the logs.
//
// To make "exits 0" impossible to fake with a scanner that does nothing, the scanner is also run on two
// throwaway git repos under verify/tmp/ (gitignored), seeded with synthetic canary values in their own
// .env and .dev.vars (variable names taken from env.example):
//   - leak repo: canaries in two tracked files, one deleted from history, one on a side branch. The
//     scanner must exit 1, name each file:line with the variable name, and print no part of any value.
//   - clean repo: the same .env/.dev.vars, nothing leaked. The scanner must exit 0.
import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Evidence, ROOT, git, run, slash } from '../helpers/evidence.ts';

const ID = 'R1';
const SCANNER_REL = 'scripts/scan-secrets.mjs';
const SCANNER = join(ROOT, SCANNER_REL);

const ev = new Evidence(ID, [
  'scan-secrets exit code (this repo)',
  'git log --all -- .env .dev.vars',
  'secret files ever committed or staged',
  'scanner on planted leaks (leak repo)',
  'scanner on a clean repo',
]);
afterAll(() => ev.write());

// ---------- helpers ----------

/** Variable names in env.example: [name, example value]. */
function envExample(): [string, string][] {
  const p = join(ROOT, 'env.example');
  if (!existsSync(p)) throw new Error('env.example missing: R1 takes the secret variable names from it');
  const vars: [string, string][] = [];
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && m[1] !== undefined && m[2] !== undefined) vars.push([m[1], m[2]]);
  }
  if (vars.length === 0) throw new Error('env.example has no NAME=value lines');
  return vars;
}

/** Seeded PRNG (mulberry32), so the canaries are the same on every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// No hex digits and no vowels: a canary fragment can't collide with a commit hash or an English word.
const CANARY_ALPHABET = 'ghjkmnpqrstvwxyz';
function canary(rand: () => number): string {
  let s = '';
  for (let i = 0; i < 32; i++) s += CANARY_ALPHABET[Math.floor(rand() * CANARY_ALPHABET.length)];
  return s;
}

/** True if any 8-character window of `value` appears in `text`. */
function leaksFragment(text: string, value: string): boolean {
  for (let i = 0; i + 8 <= value.length; i++) if (text.includes(value.slice(i, i + 8))) return true;
  return false;
}

/** Reduces scanner output to `file:line NAME` facts. Raw text is never relayed. */
function redact(output: string, names: string[]): { hits: string[]; withheld: number } {
  const hits: string[] = [];
  let withheld = 0;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const locs = [...slash(line).matchAll(/([\w./\[\]@-]+\.[\w]+|[\w./\[\]@-]*\.env|[\w./\[\]@-]*\.dev\.vars):(\d+)/g)].map(
      (m) => `${m[1]}:${m[2]}`,
    );
    const found = names.filter((n) => new RegExp(`(^|[^A-Za-z0-9_])${n}([^A-Za-z0-9_]|$)`).test(line));
    if (locs.length === 0 && found.length === 0) withheld++;
    else hits.push(`${locs.join(',') || '(no file:line)'} ${found.join(',') || '(no variable name)'}`.trim());
  }
  return { hits, withheld };
}

/** Child env for the throwaway repos: no inherited GIT_* (a hook's GIT_DIR would point at the real repo),
 *  no real secret variables, and CLAUDE_PROJECT_DIR set to the throwaway repo. */
function isolatedEnv(dir: string, secretNames: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^GIT_/i.test(k)) continue;
    if (secretNames.some((n) => n.toUpperCase() === k.toUpperCase())) continue;
    env[k] = v;
  }
  env.CLAUDE_PROJECT_DIR = dir;
  env.GIT_CONFIG_NOSYSTEM = '1';
  return env;
}

function tgit(dir: string, env: NodeJS.ProcessEnv, args: string[]): void {
  const r = run(
    'git',
    [
      '-c', 'user.name=R1 Test', '-c', 'user.email=r1@example.invalid', '-c', 'commit.gpgsign=false',
      '-c', 'core.autocrlf=false', '-c', 'core.hooksPath=.git/no-hooks', '-c', 'init.defaultBranch=main',
      ...args,
    ],
    { cwd: dir, env },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in the throwaway repo: ${r.stderr || r.error}`);
}

function write(dir: string, rel: string, text: string): void {
  const p = join(dir, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
}

const TMP_BASE = join(ROOT, 'verify', 'tmp');

/** A throwaway repo with the scanner (all of scripts/) copied in and synthetic .env / .dev.vars. */
function makeRepo(prefix: string, envText: string, devVarsText: string): { dir: string } {
  mkdirSync(TMP_BASE, { recursive: true });
  const dir = mkdtempSync(join(TMP_BASE, prefix));
  cpSync(join(ROOT, 'scripts'), join(dir, 'scripts'), { recursive: true });
  write(dir, '.gitignore', '.env\n.env.*\n!.env.example\n.dev.vars\n.dev.vars.*\nnode_modules/\nscripts/\n');
  write(dir, '.env', envText);
  write(dir, '.dev.vars', devVarsText);
  write(dir, 'env.example', readFileSync(join(ROOT, 'env.example'), 'utf8'));
  return { dir };
}

function runScanner(dir: string, env: NodeJS.ProcessEnv): { status: number | null; output: string; error: string } {
  const r = run(process.execPath, [join(dir, 'scripts', 'scan-secrets.mjs')], { cwd: dir, env, timeout: 60_000 });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}`, error: r.error };
}

// ---------- the tests ----------

describe('R1 secrets stay out of git', () => {
  it('R1 node scripts/scan-secrets.mjs exits 0 on this repo', () => {
    if (!existsSync(SCANNER)) {
      ev.record('scan-secrets exit code (this repo)', 'scripts/scan-secrets.mjs missing', 0, false,
        'scripts/scan-secrets.mjs missing: M0 checklist item 5 must add it');
      throw new Error('scripts/scan-secrets.mjs missing: M0 checklist item 5 must add it');
    }
    const names = envExample().map(([n]) => n);
    const r = run(process.execPath, [SCANNER], {
      cwd: ROOT,
      env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT },
      timeout: 120_000,
    });
    const { hits, withheld } = redact(`${r.stdout}\n${r.stderr}`, names);
    const ok = r.status === 0;
    ev.record('scan-secrets exit code (this repo)', r.status ?? `no exit code (${r.error})`, 0, ok,
      ok ? '' : `reported: ${hits.join('; ') || '(no file:line lines)'}${withheld ? `; ${withheld} other line(s) withheld` : ''}`);
    expect(r.status, `scan-secrets exit code: measured ${r.status}, threshold 0. Hits: ${hits.join('; ')}`).toBe(0);
  }, 180_000);

  it('R1 git log --all -- .env .dev.vars prints nothing', () => {
    const r = git(['log', '--all', '--', '.env', '.dev.vars']);
    const lines = r.stdout.split(/\r?\n/).filter((l) => l.trim() !== '');
    const commits = lines.filter((l) => /^commit [0-9a-f]{7,}/.test(l)).map((l) => l.slice(7, 19));
    const ok = r.status === 0 && lines.length === 0;
    ev.record('git log --all -- .env .dev.vars', r.status === 0 ? `${lines.length} line(s)` : `git failed: ${r.stderr.trim()}`,
      '0 lines', ok, commits.length ? `commits touching them: ${commits.join(', ')}` : '');
    expect(r.status, `git log failed: ${r.stderr}`).toBe(0);
    expect(lines.length, `git log --all -- .env .dev.vars printed ${lines.length} line(s), threshold 0`).toBe(0);
  });

  it('R1 no .env*, .dev.vars* file is anywhere in history or the index (stricter: any folder, any suffix)', () => {
    const log = git(['log', '--all', '--no-renames', '--format=', '--name-only']);
    const idx = git(['ls-files']);
    expect(log.status, `git log failed: ${log.stderr}`).toBe(0);
    expect(idx.status, `git ls-files failed: ${idx.stderr}`).toBe(0);
    const paths = new Set(
      `${log.stdout}\n${idx.stdout}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
    );
    const bad = [...paths].filter((p) => {
      const base = p.split('/').pop() ?? p;
      if (base === '.env.example') return false;
      return /^\.env(\..+)?$/.test(base) || /^\.dev\.vars(\..+)?$/.test(base);
    });
    ev.record('secret files ever committed or staged', bad, [], bad.length === 0);
    expect(bad, `secret files in git history or index: ${bad.join(', ')}`).toEqual([]);
  });

  it('R1 the scanner finds planted canaries (tracked files, deleted history, side branch) and prints no value', () => {
    const name = 'scanner on planted leaks (leak repo)';
    if (!existsSync(SCANNER)) {
      ev.record(name, 'scripts/scan-secrets.mjs missing', 'exit 1, every planted leak named, no value printed', false,
        'scripts/scan-secrets.mjs missing: M0 checklist item 5 must add it');
      throw new Error('scripts/scan-secrets.mjs missing: M0 checklist item 5 must add it');
    }
    const vars = envExample();
    const secretNames = vars.filter(([, v]) => v === '').map(([n]) => n);
    expect(secretNames.length, 'env.example has no empty NAME= lines, so R1 cannot tell which variables are secrets').toBeGreaterThanOrEqual(1);
    const keyVar = secretNames.includes('META_API_KEY') ? 'META_API_KEY' : (secretNames[0] as string);
    const otherVar = secretNames.find((n) => n !== keyVar) ?? keyVar;

    const rand = prng(0x5ec2e7);
    const envVals = new Map(secretNames.map((n) => [n, canary(rand)]));
    const devVals = new Map(secretNames.map((n) => [n, canary(rand)]));
    const fileText = (vals: Map<string, string>) =>
      vars.map(([n, v]) => `${n}=${vals.get(n) ?? v}`).join('\n') + '\n';

    const { dir } = makeRepo('r1-leak-', fileText(envVals), fileText(devVals));
    const env = isolatedEnv(dir, secretNames);
    try {
      tgit(dir, env, ['init', '-q']);
      write(dir, 'README.md', '# throwaway\nSpend cap: 5 dollars a day, 5 frames, version 1.5.\n');
      write(dir, 'old.txt', `${envVals.get(otherVar)}\n`);
      tgit(dir, env, ['add', '-A']);
      tgit(dir, env, ['commit', '-q', '-m', 'first']);
      // Side branch: a .dev.vars value that only `git log -p --all` can see.
      tgit(dir, env, ['checkout', '-q', '-b', 'side']);
      write(dir, 'branch.txt', `${devVals.get(otherVar)}\n`);
      tgit(dir, env, ['add', '-A']);
      tgit(dir, env, ['commit', '-q', '-m', 'side']);
      tgit(dir, env, ['checkout', '-q', 'main']);
      // Main: delete old.txt (history-only now), leak into two tracked files.
      rmSync(join(dir, 'old.txt'));
      write(dir, 'src/leak.ts', `// config\nexport const key = '${envVals.get(keyVar)}';\n`);
      write(dir, 'functions/leak.ts', `export const k = "${devVals.get(keyVar)}";\n`);
      tgit(dir, env, ['add', '-A']);
      tgit(dir, env, ['commit', '-q', '-m', 'second']);

      const r = runScanner(dir, env);
      const out = slash(r.output);
      const lines = out.split(/\r?\n/);
      const lineWith = (re: RegExp) => lines.find((l) => re.test(l)) ?? '';
      const expectations: [string, RegExp, string][] = [
        ['src/leak.ts:2', /(^|[^\w.-])src\/leak\.ts:2(\D|$)/, keyVar],
        ['functions/leak.ts:1', /(^|[^\w.-])functions\/leak\.ts:1(\D|$)/, keyVar],
        ['old.txt (deleted, in history)', /(^|[^\w.-])old\.txt:\d+/, otherVar],
        ['branch.txt (side branch only)', /(^|[^\w.-])branch\.txt:\d+/, otherVar],
      ];
      const problems: string[] = [];
      if (r.status !== 1) problems.push(`exit code ${r.status ?? `none (${r.error})`}, expected 1`);
      for (const [label, re, varName] of expectations) {
        const l = lineWith(re);
        if (!l) problems.push(`no hit for ${label}`);
        else if (!new RegExp(`(^|[^A-Za-z0-9_])${varName}([^A-Za-z0-9_]|$)`).test(l)) problems.push(`hit for ${label} does not name ${varName}`);
      }
      // Any path:line token (a path has a dot or a slash, so ".env:1" counts) must be one of the planted files.
      const plantedFiles = ['src/leak.ts', 'functions/leak.ts', 'old.txt', 'branch.txt'];
      const isPlanted = (p: string) => plantedFiles.some((f) => p === f || p.endsWith(`/${f}`));
      const falsePositives = [
        ...new Set(
          [...out.matchAll(/([\w./\[\]@-]*[./][\w\[\]@-]+):\d+/g)].map((m) => m[1] ?? '').filter((p) => !isPlanted(p)),
        ),
      ];
      if (falsePositives.length) {
        problems.push(`hits on files with no planted secret: ${falsePositives.join(', ')} (e.g. README.md's "5", or .env itself)`);
      }
      if (r.status !== 0 && r.status !== 1) {
        problems.push('the scanner crashed: it ran from a copy of scripts/ in a throwaway repo under verify/tmp/, with the repo root as its working directory and CLAUDE_PROJECT_DIR');
      }
      const leaked = [...envVals.values(), ...devVals.values()].some((v) => leaksFragment(r.output, v));
      if (leaked) problems.push('the output contains part of a secret value');

      const { hits } = redact(r.output, secretNames);
      ev.record(name, { exit: r.status, hits, valuePrinted: leaked },
        'exit 1; src/leak.ts:2, functions/leak.ts:1, old.txt:<n>, branch.txt:<n> each named with its variable; no other hits; no 8-char fragment of any value',
        problems.length === 0, problems.join('; '));
      expect(problems, `scanner on planted leaks: ${problems.join('; ')}`).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('R1 the scanner exits 0 on a clean repo whose .env and .dev.vars hold values', () => {
    const name = 'scanner on a clean repo';
    if (!existsSync(SCANNER)) {
      ev.record(name, 'scripts/scan-secrets.mjs missing', 'exit 0', false, 'scripts/scan-secrets.mjs missing: M0 checklist item 5 must add it');
      throw new Error('scripts/scan-secrets.mjs missing: M0 checklist item 5 must add it');
    }
    const vars = envExample();
    const secretNames = vars.filter(([, v]) => v === '').map(([n]) => n);
    const rand = prng(0xc1ea2);
    const vals = new Map(secretNames.map((n) => [n, canary(rand)]));
    const text = vars.map(([n, v]) => `${n}=${vals.get(n) ?? v}`).join('\n') + '\n';
    const { dir } = makeRepo('r1-clean-', text, text);
    const env = isolatedEnv(dir, secretNames);
    try {
      tgit(dir, env, ['init', '-q']);
      write(dir, 'README.md', '# throwaway\nSpend cap: 5 dollars a day, 5 frames, version 1.5.\n');
      write(dir, 'src/app.ts', 'export const fps = 30;\nexport const cap = 5;\n');
      tgit(dir, env, ['add', '-A']);
      tgit(dir, env, ['commit', '-q', '-m', 'clean']);
      const r = runScanner(dir, env);
      const { hits, withheld } = redact(r.output, secretNames);
      const leaked = [...vals.values()].some((v) => leaksFragment(r.output, v));
      const ok = r.status === 0 && !leaked;
      ev.record(name, { exit: r.status ?? `none (${r.error})`, hits, valuePrinted: leaked }, 'exit 0, no value printed', ok,
        ok ? '' : `reported: ${hits.join('; ') || '(none)'}${withheld ? `; ${withheld} line(s) withheld` : ''}`);
      expect(r.status, `scanner on a clean repo: exit ${r.status}, threshold 0. Hits: ${hits.join('; ')}`).toBe(0);
      expect(leaked, 'scanner printed part of a secret value').toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
