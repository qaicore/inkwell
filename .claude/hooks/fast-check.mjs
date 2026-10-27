// PostToolUse hook (Edit|Write): after a code edit, run `npm run check:fast` (typecheck + tests/unit).
// Exit 2 sends the failure back to Claude so it fixes it before the next step. Exit 0 is silent.
// It does nothing until package.json defines a check:fast script, so the kit works in an empty repo.
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();

let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
  input = {};
}
const file = String(input?.tool_input?.file_path ?? '').replaceAll('\\', '/');

// Only code edits trigger checks. Docs, reference data, fixtures and generated output don't.
const isCode = /\.(ts|tsx|js|mjs|cjs|json)$/.test(file);
const ignored = /(^|\/)(docs|reference|fixtures|verify|node_modules|dist|\.claude)\//.test(file);
if (!isCode || ignored) process.exit(0);

const pkgPath = join(root, 'package.json');
if (!existsSync(pkgPath)) process.exit(0);
let pkg = {};
try {
  pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
} catch {
  process.stderr.write('package.json is not valid JSON. Fix it first.\n');
  process.exit(2);
}
if (!pkg.scripts || !pkg.scripts['check:fast']) process.exit(0);

const run = spawnSync('npm run -s check:fast', {
  cwd: root,
  encoding: 'utf8',
  shell: true, // resolves npm.cmd on Windows
  timeout: 170_000,
});

if (run.status === 0) process.exit(0);

const tail = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.trim().split(/\r?\n/).slice(-60).join('\n');
const why = run.error ? `(${run.error.message})` : '';
process.stderr.write(`check:fast failed after editing ${file} ${why}\nFix this before the next step:\n${tail}\n`);
process.exit(2);
