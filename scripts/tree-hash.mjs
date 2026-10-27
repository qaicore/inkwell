// Prints a short sha256 over every file that defines behavior or its checks.
// Checker verdicts are stamped with it, and npm run verify records it in verify/out/tree.txt,
// so any later change to code, config, tests, spec, reference or checker setup makes them stale.
// Uses git's file list (tracked + untracked, minus ignored); falls back to a fixed list outside git.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const skip = (rel) =>
  /^(verify|node_modules|dist|coverage)\//.test(rel) ||
  rel === '.claude/settings.local.json' ||
  (/\.(mp4|mov|m4v|webm|png|jpg|jpeg|gif|wav|mp3)$/i.test(rel) &&
    !rel.startsWith('tests/golden/') &&
    !rel.startsWith('reference/'));

let files = [];
const git = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' });
if (git.status === 0 && git.stdout) {
  files = git.stdout.split('\0').filter(Boolean);
} else {
  const targets = ['src', 'functions', 'scripts', 'tests', 'reference', 'fixtures', 'docs', '.claude', 'package.json'];
  const walk = (abs) => {
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) {
      for (const name of readdirSync(abs).sort()) walk(join(abs, name));
    } else {
      files.push(relative(root, abs));
    }
  };
  for (const t of targets) walk(join(root, t));
}

files = [...new Set(files.map((f) => f.replaceAll('\\', '/')))]
  .filter((f) => !skip(f))
  .filter((f) => existsSync(join(root, f)))
  .sort();

const h = createHash('sha256');
for (const rel of files) {
  h.update(rel);
  h.update('\0');
  h.update(readFileSync(join(root, rel)));
  h.update('\0');
}
process.stdout.write(`${h.digest('hex').slice(0, 16)}\n`);
