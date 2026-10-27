// npm run verify: the evidence the checker subagents read.
// 1. Stamps verify/out/tree.txt with scripts/tree-hash.mjs, before anything else runs, so a checker
//    can tell whether the code changed after this run.
// 2. Typechecks the acceptance tests (tsconfig.acceptance.json) into verify/out/typecheck.txt.
// 3. Runs tests/M0 .. tests/<ACTIVE> with vitest's JSON reporter into verify/out/tests.json. Each test
//    writes its own verify/out/<ID>.json. Earlier milestones' tests re-run at every milestone.
// Reads only local files: no network, no keys.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.cwd();
const out = join(root, 'verify', 'out');

const hash = spawnSync(process.execPath, [join(root, 'scripts', 'tree-hash.mjs')], { cwd: root, encoding: 'utf8' });
const tree = (hash.stdout ?? '').trim();
if (hash.status !== 0 || !tree) {
  process.stderr.write(`verify: scripts/tree-hash.mjs failed\n${hash.stderr ?? ''}`);
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'tree.txt'), `${tree}\n`);

// verify/ACTIVE may be UTF-16 if PowerShell wrote it with ">".
function readText(path) {
  const b = readFileSync(path);
  const s = b[0] === 0xff && b[1] === 0xfe ? b.toString('utf16le') : b.toString('utf8');
  return s.replace(/^﻿/, '').trim();
}

const milestoneDirs = existsSync(join(root, 'tests'))
  ? readdirSync(join(root, 'tests'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^M\d+$/.test(d.name))
      .map((d) => Number(d.name.slice(1)))
      .sort((a, b) => a - b)
  : [];
const activePath = join(root, 'verify', 'ACTIVE');
const active = existsSync(activePath) ? readText(activePath) : '';
if (active && !/^M\d+$/.test(active)) {
  process.stderr.write(`verify: verify/ACTIVE should hold a milestone id like M1, not "${active}"\n`);
  process.exit(1);
}
const upTo = active ? Number(active.slice(1)) : Infinity;
const dirs = milestoneDirs.filter((n) => n <= upTo).map((n) => `tests/M${n}/`);
process.stdout.write(`verify: tree ${tree}, milestone ${active || '(none active: all)'}, running ${dirs.join(' ') || 'nothing'}\n`);

// npm's .bin shims are .cmd files on Windows, so run through the shell there.
const run = (cmd) => spawnSync(cmd, { cwd: root, encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] });

const tsc = run('npx tsc -p tsconfig.acceptance.json');
const tscText = `${tsc.stdout ?? ''}${tsc.stderr ?? ''}`.trim();
writeFileSync(join(out, 'typecheck.txt'), `${tsc.status === 0 ? 'PASS' : 'FAIL'}\n${tscText}\n`);
process.stdout.write(`verify: acceptance typecheck ${tsc.status === 0 ? 'passed' : 'FAILED'}\n${tscText ? `${tscText}\n` : ''}`);

let testsStatus = 1;
if (dirs.length === 0) {
  process.stderr.write('verify: no tests/M* folders to run\n');
} else {
  const vitest = spawnSync(
    `npx vitest run ${dirs.join(' ')} --reporter=default --reporter=json --outputFile.json=verify/out/tests.json`,
    { cwd: root, shell: true, stdio: 'inherit' },
  );
  testsStatus = vitest.status ?? 1;
}

process.exit(tsc.status === 0 && testsStatus === 0 ? 0 : 1);
