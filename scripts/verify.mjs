// npm run verify: the evidence the checker subagents read.
// 1. Stamps verify/out/tree.txt with scripts/tree-hash.mjs, before anything else runs, so a checker
//    can tell whether the code changed after this run.
// 2. Typechecks the acceptance tests (tsconfig.acceptance.json) into verify/out/typecheck.txt.
// 3. Runs tests/M0 .. tests/<ACTIVE> with vitest's JSON reporter into verify/out/tests.json. Each test
//    writes its own verify/out/<ID>.json. Earlier milestones' tests re-run at every milestone.
// 4. From M1 on, draws the contact sheets into verify/out/<ACTIVE>/ (scripts/sheets.ts) for motion-critic.
// 5. From M2 on, draws one sample per brush into verify/out/brushes/ (scripts/brush-sheets.ts), the B3
//    goldens-to-be.
// Reads only local files: no network, no keys.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { localBin } from './lib/bin.ts';

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

// tsc and vitest run straight from node_modules with this node, with no
// shell in between. npx would fetch a missing package from the registry
// instead, so without node_modules verify stops here.
let bins;
try {
  bins = { tsc: localBin(root, 'typescript', 'tsc'), vitest: localBin(root, 'vitest') };
} catch (err) {
  process.stderr.write(`verify: ${err.message}\n`);
  process.exit(1);
}
const node = (bin, args, options) => spawnSync(process.execPath, [bin, ...args], { cwd: root, ...options });

const tsc = node(bins.tsc, ['-p', 'tsconfig.acceptance.json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const tscText = `${tsc.stdout ?? ''}${tsc.stderr ?? ''}`.trim();
writeFileSync(join(out, 'typecheck.txt'), `${tsc.status === 0 ? 'PASS' : 'FAIL'}\n${tscText}\n`);
process.stdout.write(`verify: acceptance typecheck ${tsc.status === 0 ? 'passed' : 'FAILED'}\n${tscText ? `${tscText}\n` : ''}`);

let testsStatus = 1;
if (dirs.length === 0) {
  process.stderr.write('verify: no tests/M* folders to run\n');
} else {
  const vitest = node(bins.vitest, ['run', ...dirs, '--reporter=default', '--reporter=json', '--outputFile.json=verify/out/tests.json'], {
    stdio: 'inherit',
  });
  testsStatus = vitest.status ?? 1;
}

// The sheets are pictures of the engine, not a criterion, so a failure here
// is reported and fails the run, but never hides the test results above.
// They go in the active milestone's folder, so they need one; sheets.ts gets
// the id checked above instead of reading verify/ACTIVE again.
let sheetsStatus = 0;
if (active && upTo >= 1) {
  const sheets = spawnSync(process.execPath, [join(root, 'scripts', 'sheets.ts'), active], { cwd: root, stdio: 'inherit' });
  sheetsStatus = sheets.status ?? 1;
  if (sheetsStatus !== 0) process.stderr.write('verify: scripts/sheets.ts failed, so there are no contact sheets\n');
}
if (active && upTo >= 2) {
  const brushes = spawnSync(process.execPath, [join(root, 'scripts', 'brush-sheets.ts')], { cwd: root, stdio: 'inherit' });
  if (brushes.status !== 0) {
    sheetsStatus = brushes.status ?? 1;
    process.stderr.write('verify: scripts/brush-sheets.ts failed, so there are no brush samples\n');
  }
}

process.exit(tsc.status === 0 && testsStatus === 0 && sheetsStatus === 0 ? 0 : 1);
