// Stop hook: a milestone can be claimed done only with fresh, passing verdicts from every required checker.
// Claude claims a milestone by writing its id to verify/CLAIM. Without a CLAIM file this hook does nothing,
// so Claude can still stop to ask Qai a question at any time.
// Blocking uses {"decision":"block","reason":...}; outcomes are shown to Qai with systemMessage.
import { readFileSync, existsSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const verifyDir = join(root, 'verify');
const claimPath = join(verifyDir, 'CLAIM');
const statePath = join(verifyDir, '.stop-gate.json');

// Reads UTF-8 or UTF-16 (Windows PowerShell 5.1 writes UTF-16 with "> file") and strips a BOM.
function readText(p) {
  const b = readFileSync(p);
  const s = b[0] === 0xff && b[1] === 0xfe ? b.toString('utf16le') : b.toString('utf8');
  return s.replace(/^﻿/, '');
}
const say = (obj) => {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
};

if (!existsSync(claimPath)) process.exit(0);

const milestone = readText(claimPath).trim();
rmSync(claimPath, { force: true });

const REQUIRED = {
  M0: ['acceptance-judge', 'rules-auditor'],
  M1: ['acceptance-judge', 'motion-critic', 'rules-auditor'],
  M2: ['acceptance-judge', 'tracking-auditor', 'rules-auditor'],
};
const required = REQUIRED[milestone] ?? ['acceptance-judge', 'motion-critic', 'tracking-auditor', 'rules-auditor'];

let state = { blocks: 0 };
try {
  if (existsSync(statePath)) state = JSON.parse(readText(statePath));
} catch {
  state = { blocks: 0 };
}

const hashRun = spawnSync(process.execPath, [join(root, 'scripts', 'tree-hash.mjs')], { cwd: root, encoding: 'utf8' });
const tree = (hashRun.stdout ?? '').trim();

const problems = [];
if (!tree) problems.push('scripts/tree-hash.mjs failed, so freshness cannot be checked');
for (const name of required) {
  const p = join(verifyDir, 'verdicts', `${name}.json`);
  if (!existsSync(p)) {
    problems.push(`${name}: no verdict yet (run /run-checkers)`);
    continue;
  }
  let v;
  try {
    v = JSON.parse(readText(p));
  } catch {
    problems.push(`${name}: verdict file is not valid JSON`);
    continue;
  }
  if (v.milestone !== milestone) problems.push(`${name}: verdict is for ${v.milestone}, not ${milestone}`);
  if (tree && v.tree !== tree) problems.push(`${name}: verdict is stale (code, tests or reference changed after it ran)`);
  if (v.verdict !== 'PASS') {
    const items = Array.isArray(v.must_fix) ? v.must_fix.slice(0, 3).join('; ') : '';
    problems.push(`${name}: ${v.verdict}${items ? ` - ${items}` : ''}`);
  }
}

if (problems.length === 0) {
  mkdirSync(verifyDir, { recursive: true });
  writeFileSync(
    join(verifyDir, `DONE-${milestone}.json`),
    JSON.stringify({ milestone, tree, verifiedAt: new Date().toISOString(), checkers: required }, null, 2),
  );
  rmSync(statePath, { force: true });
  say({ systemMessage: `${milestone} verified by ${required.length} checkers. Waiting for Qai's sign-off.` });
}

state.blocks = (state.blocks ?? 0) + 1;

if (state.blocks > 3) {
  // Claude claimed again after being told to stop: let it stop, tell Qai, and reset for the next cycle.
  rmSync(statePath, { force: true });
  say({ systemMessage: `${milestone} NOT verified after 3 blocked claims:\n- ${problems.join('\n- ')}` });
}

mkdirSync(verifyDir, { recursive: true });
writeFileSync(statePath, JSON.stringify(state));

const list = `- ${problems.join('\n- ')}`;
const next =
  state.blocks < 3
    ? 'Fix the code, run npm run verify and /run-checkers, then write the id to verify/CLAIM again.'
    : 'Do not write verify/CLAIM again. Stop and report these problems to Qai, with the evidence files.';
say({ decision: 'block', reason: `Milestone ${milestone} is not verified (claim ${state.blocks} of 3):\n${list}\n${next}` });
