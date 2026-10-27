// node scripts/scan-secrets.mjs: has a secret leaked into git?
// Loads .env and .dev.vars inside this process, then looks for each secret
// value in every file git tracks or would track (untracked but not ignored,
// so a leak is caught before it's committed), in what's staged, and in the
// whole history (git log -p --all, commit messages included). On a hit it
// prints where and which variable, never the value, and exits 1.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readEnvFile } from './lib/env.ts';

const root = process.cwd();

// Which variables hold secrets, by name. Others (DAILY_SPEND_CAP_USD) are
// settings, and their values ("5") would match everywhere.
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSCODE|CREDENTIAL)/i;
// Shorter values match ordinary text too often to tell a leak from noise.
const MIN_LENGTH = 8;

const secrets = new Map(); // value -> variable names
const tooShort = new Set();
const unreadable = [];
let envFiles = 0;
for (const name of ['.env', '.dev.vars']) {
  const env = readEnvFile(join(root, name));
  if (!env) continue;
  envFiles++;
  if (env.badLines.length > 0) unreadable.push(`${name} line ${env.badLines.join(', ')}`);
  for (const [key, value] of Object.entries(env.values)) {
    if (!SECRET_NAME.test(key) || !value) continue;
    if (value.length < MIN_LENGTH) {
      tooShort.add(key);
      continue;
    }
    secrets.set(value, [...new Set([...(secrets.get(value) ?? []), key])]);
  }
}

// A secret that can't be scanned for can't be shown clean: a line that
// isn't KEY=value may hold one, and the line itself is never printed.
if (unreadable.length > 0) {
  process.stdout.write(
    `scan-secrets: ${unreadable.join('; ')} isn't KEY=value, so there's no telling what to look for. Fix it (an unclosed quote?), or save the file as UTF-8.\n`,
  );
  process.exit(1);
}
if (tooShort.size > 0) {
  process.stdout.write(
    `scan-secrets: ${[...tooShort].join(', ')} ${tooShort.size === 1 ? 'is' : 'are'} under ${MIN_LENGTH} characters: too short to scan for leaks, and easy to guess. Use a longer value.\n`,
  );
  process.exit(1);
}
if (envFiles === 0 || secrets.size === 0) {
  process.stdout.write(`scan-secrets: ${envFiles === 0 ? 'no .env or .dev.vars' : 'no secret values set'}, so there is nothing to look for.\n`);
  process.exit(0);
}

// Everything printed after this point names files, and a file's name can
// hold a key too, so every value is masked first (longest first, in case one
// value contains another).
const values = [...secrets.keys()].sort((a, b) => b.length - a.length);
const redact = (text) => values.reduce((out, value) => out.replaceAll(value, '[redacted]'), text);

const git = (args) => {
  const r = spawnSync('git', args, { cwd: root, maxBuffer: 1 << 30 });
  if (r.status !== 0) {
    process.stderr.write(redact(`scan-secrets: git ${args[0]} failed: ${r.stderr.toString().trim()}\n`));
    process.exit(2);
  }
  return r.stdout;
};

const hits = [];
const lineOf = (buf, index) => {
  let line = 1;
  for (let i = buf.indexOf(10); i !== -1 && i < index; i = buf.indexOf(10, i + 1)) line++;
  return line;
};

// Each value as a file could hold it: UTF-8, or UTF-16LE (what Windows
// PowerShell 5.1's ">" writes).
const needles = [...secrets].map(([value, names]) => ({ value, names: names.join(', '), bytes: [Buffer.from(value), Buffer.from(value, 'utf16le')] }));

// 1. The working tree, as git sees it, byte for byte, so binary files count.
const files = git(['ls-files', '-co', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean);
let scanned = 0;
for (const rel of files) {
  const path = join(root, rel);
  if (!existsSync(path) || !statSync(path).isFile()) continue;
  const buf = readFileSync(path);
  scanned++;
  for (const { value, names, bytes } of needles) {
    if (rel.includes(value)) hits.push(`${rel} (file name) ${names}`);
    for (const needle of bytes) {
      for (let at = buf.indexOf(needle); at !== -1; at = buf.indexOf(needle, at + 1)) hits.push(`${rel}:${lineOf(buf, at)} ${names}`);
    }
  }
}

// Hits in a patch from git log -p or git diff. Line numbers come from the
// hunk headers ("@@ -a,b +c,d @@" starts the new file at line c). `label`
// turns the current commit (none for a diff) into the start of a hit.
// The patches are made with --text, so binary files show their bytes instead
// of "Binary files differ", and NULs are dropped from each line, which turns
// UTF-16 text back into plain characters.
function scanPatch(patch, label) {
  let commit = '';
  let file = '';
  let newLine = 0;
  let inDiff = false;
  for (const raw of patch.split('\n')) {
    const line = raw.replaceAll('\0', '');
    if (line.startsWith('commit ')) {
      commit = line.slice(7, 14);
      file = '';
      inDiff = false;
    } else if (line.startsWith('diff --git ')) {
      inDiff = true;
      file = line.replace(/^diff --git a\/(.*) b\/.*$/, '$1');
    } else if (inDiff && line.startsWith('+++ ')) {
      if (line !== '+++ /dev/null') file = line.slice(6);
    } else if (inDiff && line.startsWith('@@')) {
      newLine = Number(line.match(/\+(\d+)/)?.[1] ?? 0) - 1;
    }
    const isAdded = inDiff && line.startsWith('+') && !line.startsWith('+++ ');
    const isContext = inDiff && line.startsWith(' ');
    const isRemoved = inDiff && line.startsWith('-') && !line.startsWith('--- ');
    if (isAdded || isContext) newLine++;
    for (const [value, names] of secrets) {
      if (!line.includes(value)) continue;
      const where = !inDiff
        ? '(commit message)'
        : isAdded || isContext
          ? `${file}:${newLine}`
          : `${file} ${isRemoved ? '(removed line)' : '(diff header: a file name or hunk context)'}`;
      hits.push(`${label(commit)} ${where} ${names.join(', ')}`);
    }
  }
}

// 2. The index: a key that was staged and then deleted or changed in the
// working tree is in no file and no commit yet, but the next commit takes it.
scanPatch(git(['diff', '--cached', '-p', '--text', '--no-color', '--no-ext-diff']).toString(), () => 'staged');

// 3. Every commit on every ref. Merge commits (stashes are merges too) show
// no diff by default; --diff-merges=first-parent diffs them against the
// branch they joined, so a key added while resolving a merge, or one that
// lives only in a stash, shows up.
const log = git(['log', '-p', '--all', '--text', '--diff-merges=first-parent', '--no-color', '--no-ext-diff']);
scanPatch(log.toString(), (commit) => `history ${commit}`);

if (hits.length > 0) {
  process.stdout.write(redact(`scan-secrets: found a secret value in ${hits.length} place(s):\n${[...new Set(hits)].map((h) => `  ${h}`).join('\n')}\n`));
  process.exit(1);
}
const checked = [...new Set([...secrets.values()].flat())].join(', ');
process.stdout.write(`scan-secrets: clean. Checked ${checked} in ${scanned} files and the full history.\n`);
