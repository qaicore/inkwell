// npm run fixtures:refresh -- <clip>: SAM 3.1's masks for one fixture clip,
// cached next to it for the tests and the app (docs/SPEC.md §9, §11).
// COSTS MONEY. Run it only when Qai says go. It prints the cost and waits for
// a typed "yes" before the first paid call.
//
// On fixtures/<clip>/clip.mp4 (listed in fixtures/clips.json) it runs:
//   - sam-person.json  concept "person" (the cutout, body height, the rule)
//   - sam-face.json    concept "face"   (the nearest-mask rule)
//   - sam-root.json    one point at the first root in fixtures/<clip>/truth.json,
//                      propagated both ways (K1-K3); skipped until truth.json exists
//   - sam-<word>.json  each --concept, and each concept a recorded plan picks (--plan)
//   - sam-stroke-<id>.json  each point anchor a recorded plan picks (--plan)
// Every response is cached with the clip's hash: a second run only pays for
// what's missing, and the uploaded file id is reused. Trim the clip to the
// part that moves before labeling it; SAM bills every frame.
//
//   npm run fixtures:refresh -- side-step
//   npm run fixtures:refresh -- probe --plan fixtures/probe/wonder-plan.json
//   npm run fixtures:refresh -- walk --concept hand
//   npm run fixtures:refresh -- walk --dry-run   (prints the quote, spends nothing)
//   npm run fixtures:refresh -- walk --fresh     (re-upload and redo every call)
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildObjectPrompt } from '@meta-sam/parser';
import { MAX_CLIP_FRAMES, samCost } from '../../functions/_lib/pricing.ts';
import { samCacheFile } from '../../src/sam/cache.ts';
import { Budget, LEDGER, confirm, loadKeys, makeClient } from './meta.mjs';
import { SAM_METADATA, Stop, fileIdFor, fixtureClip, log, money, readCache, samRun, writeCache } from './clip.mjs';

const RUN_CAP_USD = 1.0; // this run, on top of DAILY_SPEND_CAP_USD across runs
const FPS = 30;

const root = process.cwd();

function parseArgs(argv) {
  const args = { clip: '', concepts: [], plan: '', fresh: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--concept') args.concepts.push(String(argv[++i] ?? ''));
    else if (a === '--plan') args.plan = String(argv[++i] ?? '');
    else if (a === '--fresh') args.fresh = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') {
      const lines = readFileSync(new URL(import.meta.url), 'utf8').split(/\r?\n/);
      log(lines.slice(0, lines.findIndex((l) => !l.startsWith('//'))).map((l) => l.slice(3)).join('\n'));
      process.exit(0);
    } else if (!a.startsWith('-') && !args.clip) args.clip = a;
    else throw new Stop(`Unknown option ${a}. Try: npm run fixtures:refresh -- --help`);
  }
  if (!args.clip) throw new Stop('Which clip? npm run fixtures:refresh -- side-step');
  return args;
}

// Every SAM run this clip needs: the fixed three, plus what was asked for.
function wanted(clip, args) {
  const runs = [
    { file: 'sam-person.json', label: 'SAM person', text: 'person', metadata: SAM_METADATA },
    { file: 'sam-face.json', label: 'SAM face', text: 'face', metadata: SAM_METADATA },
  ];
  const truthPath = join(clip.dir, 'truth.json');
  const first = existsSync(truthPath) ? [...(JSON.parse(readFileSync(truthPath, 'utf8')).roots ?? [])].sort((a, b) => a.frame - b.frame)[0] : null;
  if (first) runs.push(pointRun(clip, 'sam-root.json', 'SAM root point', first.frame, first.xy));
  else log(`fixtures/${clip.id}/truth.json has no roots yet, so sam-root.json waits (it's seeded at the first one).`);

  const concepts = new Set(args.concepts.map((c) => c.trim()).filter(Boolean));
  if (args.plan) {
    const plan = JSON.parse(readFileSync(join(root, args.plan), 'utf8'));
    for (const call of (plan.calls ?? []).filter((c) => c.clip === clip.id && c.clipSha256 === clip.sha)) {
      for (const p of call.plan ?? []) {
        if (p.anchor?.type === 'concept') concepts.add(p.anchor.prompt.trim());
        if (p.anchor?.type === 'point') runs.push(pointRun(clip, samCacheFile(p.anchor, p.id), `SAM stroke ${p.id} point`, Math.round(p.anchor.time * FPS), p.anchor.xy));
      }
    }
  }
  for (const prompt of concepts) {
    const file = samCacheFile({ type: 'concept', prompt }, 0);
    if (!runs.some((r) => r.file === file)) runs.push({ file, label: `SAM ${prompt}`, text: prompt, metadata: SAM_METADATA });
  }
  return runs;
}

function pointRun(clip, file, label, frame, [x, y]) {
  const point = { frame, x: Math.round(x), y: Math.round(y) };
  const text = buildObjectPrompt({ size: { width: clip.info.width, height: clip.info.height }, objects: [{ id: 1, prompts: [{ frame, points: [{ x: point.x, y: point.y }] }] }] });
  return { file, label, text, metadata: { ...SAM_METADATA, propagation_direction: 'both' }, point };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const clip = fixtureClip(root, args.clip);
  const { info } = clip;
  log(`${clip.id}: ${info.width}x${info.height}, ${info.frames} frames at ${info.fps} fps.`);
  if (info.frames > MAX_CLIP_FRAMES) throw new Stop(`${clip.id} is ${info.frames} frames; the app caps clips at ${MAX_CLIP_FRAMES}. Trim it first.`);

  // A cached run counts only for this clip and, for a point, the same point.
  const same = (run) => {
    const c = args.fresh ? null : readCache(clip, run.file);
    return c && (!run.point || (c.point?.frame === run.point.frame && c.point?.x === run.point.x && c.point?.y === run.point.y));
  };
  const pending = wanted(clip, args).filter((run) => !same(run));
  if (pending.length === 0) {
    log('Every SAM run is cached for this clip; nothing to pay for.');
    return;
  }

  const each = samCost(info.frames);
  const worst = each * pending.length;
  log('', 'Paid calls this run (Meta API, prices from dev.meta.ai/docs/pricing-rate-limits):');
  for (const run of pending) log(`  ${run.label.padEnd(20)} ${money(each)}  (${info.frames} frames at $0.20 per 1,000, 50 minimum) -> ${run.file}`);
  log(`Total: at most ${money(worst)}, likely the same (SAM bills by frame).`);
  if (args.dryRun) {
    log('Dry run: nothing spent.');
    return;
  }
  const keys = loadKeys(root);
  const budget = new Budget({ runCap: RUN_CAP_USD, dailyCap: keys.dailyCap, ledger: LEDGER });
  log(`Spent by scripts/live today: ${money(budget.spentToday())} of ${money(keys.dailyCap)} (DAILY_SPEND_CAP_USD). This run's cap: ${money(RUN_CAP_USD)}.`);
  budget.allow('This run', worst);
  if (!(await confirm(`Spend up to ${money(worst)}? Type yes to go: `))) {
    log('Nothing spent.');
    return;
  }
  const client = makeClient(keys.apiKey);
  const fileId = await fileIdFor(client, clip, args.fresh);
  for (const run of pending) writeCache(clip, run.file, await samRun(client, budget, clip, fileId, run));
  log(`Spent this run: ${money(budget.spent)}. Wrote ${pending.map((r) => `fixtures/${clip.id}/${r.file}`).join(', ')}.`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Stop ? err.message : err.stack ?? err}\n`);
  process.exit(1);
});
