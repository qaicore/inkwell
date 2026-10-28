// npm run probe: does SAM 3.1 hold Qai through a slow turn? (docs/SPEC.md §9)
// COSTS MONEY. Run it only when Qai says go. It prints the cost and waits for
// a typed "yes" before the first paid call.
//
// On fixtures/probe/clip.mp4 (a 10 s slow turn) it runs:
//   1. SAM three ways: concept "person", concept "face", and one point on his
//      back, placed on a frame where his back shows and propagated both ways.
//   2. Muse Wonder's facing labels on 8 numbered frames.
// and writes fixtures/probe/report.md and strip.png.
//
// Every response is cached in fixtures/probe/*.json with the clip's hash, so
// a second run only pays for what's missing, and --report-only rebuilds the
// report and strip from the cache for free.
//
//   npm run probe
//   npm run probe -- --report-only
//   npm run probe -- --back-frame 150 --back-xy 960,520   (place the back point by hand)
//   npm run probe -- --fresh                              (re-upload and redo every call)
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildObjectPrompt } from '@meta-sam/parser';
import { SAM_MODEL, WONDER_MODEL, samCost, wonderCost, wonderMaxCost } from '../../functions/_lib/pricing.ts';
import { checkFfmpeg, fitSize, normalise, probeVideo, readFrames } from '../probe/ffmpeg.ts';
import { FACING_SCHEMA, checkFacing, facingPrompt, spreadFrames } from '../probe/facing.ts';
import { drawMarker, drawNumber, tile, tintMask } from '../probe/image.ts';
import { framesFromRecords, parseCachedOutput } from '../probe/masks.ts';
import { encodePng } from '../probe/png.ts';
import { bodyHeights, chooseBackPoint, jumpStats, percentile, renderReport } from '../probe/report.ts';
import { Budget, LEDGER, confirm, loadKeys, makeClient, samVideo, uploadVideo, wonderJson } from './meta.mjs';

const RUN_CAP_USD = 1.0; // this run, on top of DAILY_SPEND_CAP_USD across runs
const WONDER_FRAMES = 8;
const WONDER_LONG_SIDE = 768; // px; under the ~1280 px the image-token bound assumes
const WONDER_MAX_OUTPUT_TOKENS = 4000;
const STRIP_EVERY = 10;
const STRIP_LONG_SIDE = 320;
const STRIP_COLUMNS = 6;
const COLORS = { person: [70, 140, 255], face: [255, 210, 40], back: [235, 60, 200] };
const SAM_METADATA = { include_confidence: 'true', mask_encoding: 'one_bit' };

const root = process.cwd();
const dir = join(root, 'fixtures', 'probe');
const clipPath = join(dir, 'clip.mp4');
const log = (line = '') => process.stdout.write(`${line}\n`);

class Stop extends Error {}

function parseArgs(argv) {
  const args = { reportOnly: false, fresh: false, backFrame: undefined, backXy: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--report-only') args.reportOnly = true;
    else if (a === '--fresh') args.fresh = true;
    else if (a === '--back-frame') args.backFrame = Number(argv[++i]);
    else if (a === '--back-xy') args.backXy = String(argv[++i]).split(',').map(Number);
    else if (a === '--help' || a === '-h') {
      const lines = readFileSync(new URL(import.meta.url), 'utf8').split(/\r?\n/);
      log(lines.slice(0, lines.findIndex((l) => !l.startsWith('//'))).map((l) => l.slice(3)).join('\n'));
      process.exit(0);
    } else throw new Stop(`Unknown option ${a}. Try: npm run probe -- --help`);
  }
  const half = (args.backFrame === undefined) !== (args.backXy === undefined);
  if (half) throw new Stop('--back-frame and --back-xy go together.');
  if (args.backXy && (args.backXy.length !== 2 || !args.backXy.every(Number.isInteger) || !Number.isInteger(args.backFrame))) {
    throw new Stop('Use whole numbers: --back-frame 150 --back-xy 960,520');
  }
  return args;
}

function cachePath(name) {
  return join(dir, `${name}.json`);
}

// A cached response counts only if it was made from this exact clip.
function readCache(name, sha) {
  if (!existsSync(cachePath(name))) return null;
  const data = JSON.parse(readFileSync(cachePath(name), 'utf8'));
  return data.clipSha256 === sha ? data : null;
}

function writeCache(name, data) {
  writeFileSync(cachePath(name), `${JSON.stringify(data, null, 2)}\n`);
}

const money = (usd) => `$${usd.toFixed(2)}`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  checkFfmpeg();
  if (!existsSync(clipPath)) {
    throw new Stop('fixtures/probe/clip.mp4 is missing. Film it first: a 10 s slow full turn on the tripod, brightest light, H.264, HDR off, 1080p30 (docs/SPEC.md §3, Tue night).');
  }
  const sha = createHash('sha256').update(readFileSync(clipPath)).digest('hex');
  const work = join(tmpdir(), `inkwell-probe-${sha.slice(0, 12)}.mp4`);
  if (!existsSync(work)) {
    log('Converting the clip to H.264 at a constant 30 fps...');
    normalise(clipPath, work);
  }
  const info = probeVideo(work);
  log(`Clip: ${info.width}x${info.height}, ${info.frames} frames at ${info.fps} fps.`);

  const cached = (name) => (args.fresh ? null : readCache(name, sha));
  let person = cached('sam-person');
  let face = cached('sam-face');
  let back = cached('sam-back');
  let wonder = cached('wonder-facing');
  if (wonder && !wonder.labels) wonder = null; // both tries failed last time: offer it again
  const meta = (!args.fresh && readCache('probe', sha)) || { clipSha256: sha };
  if (back && args.backFrame !== undefined) {
    const p = back.point;
    if (p.frame !== args.backFrame || p.x !== args.backXy[0] || p.y !== args.backXy[1]) back = null; // a new point is a new call
  }
  const wonderFrames = spreadFrames(info.frames, WONDER_FRAMES);
  const promptText = facingPrompt(wonderFrames);
  const wonderWorst = wonderMaxCost(wonderFrames.length, promptText.length, WONDER_MAX_OUTPUT_TOKENS);
  const samEach = samCost(info.frames);

  const pending = [
    !person && { name: 'SAM person', worst: samEach, line: `${money(samEach)}  (${info.frames} frames at $0.20 per 1,000)` },
    !face && { name: 'SAM face', worst: samEach, line: money(samEach) },
    !back && { name: 'SAM back point', worst: samEach, line: `${money(samEach)}  (both directions cover each frame once)` },
    !wonder && { name: 'Wonder facing', worst: 2 * wonderWorst, line: `up to ${money(wonderWorst)} a try, plus one retry if the reply fails the schema check` },
  ].filter(Boolean);

  if (pending.length > 0) {
    if (args.reportOnly) throw new Stop(`--report-only needs every response cached. Missing: ${pending.map((p) => p.name).join(', ')}.`);
    const keys = loadKeys(root);
    const budget = new Budget({ runCap: RUN_CAP_USD, dailyCap: keys.dailyCap, ledger: LEDGER });
    const worst = pending.reduce((sum, p) => sum + p.worst, 0);
    const likely = pending.reduce((sum, p) => sum + (p.name === 'Wonder facing' ? wonderMaxCost(wonderFrames.length, promptText.length, 1000) : p.worst), 0);
    log('', 'Paid calls this run (Meta API, prices from dev.meta.ai/docs/pricing-rate-limits):');
    for (const p of pending) log(`  ${p.name.padEnd(16)} ${p.line}`);
    log(`Total: at most ${money(worst)}, likely about ${money(likely)}.`);
    log(`Spent by scripts/live today: ${money(budget.spentToday())} of ${money(keys.dailyCap)} (DAILY_SPEND_CAP_USD). This run's cap: ${money(RUN_CAP_USD)}.`);
    budget.allow('This run', worst);
    if (!(await confirm(`Spend up to ${money(worst)}? Type yes to go: `))) {
      log('Nothing spent.');
      return;
    }
    const client = makeClient(keys.apiKey);

    if (!meta.fileId && (!person || !face || !back)) {
      log('Uploading the clip (free)...');
      meta.fileId = await uploadVideo(client, work);
      writeCache('probe', meta);
    }

    const sam = async (name, text, metadata) => {
      const label = `SAM ${name}`;
      const held = budget.reserve(label, samEach);
      log(`${label}...`);
      let res;
      try {
        res = await samVideo(client, { fileId: meta.fileId, text, metadata });
      } catch (err) {
        // The reservation stays counted: a call that failed partway may still bill.
        throw new Stop(`${label} failed: ${err.message}\nIf the file id expired, run again with --fresh to re-upload.`);
      }
      const frames = res.usage?.video_frames_processed;
      const spend = { name: label, usd: frames === undefined ? samEach : samCost(frames), detail: frames === undefined ? 'no usage reported; counted at the estimate' : `${frames} frames` };
      budget.settle(held, spend.usd);
      return {
        clipSha256: sha,
        model: SAM_MODEL,
        text,
        metadata,
        outcome: res.result.outcome,
        usage: res.usage,
        diagnostics: res.result.diagnostics.slice(0, 20),
        spend,
        rawOutput: res.result.rawOutput,
      };
    };

    if (!person) writeCache('sam-person', (person = await sam('person', 'person', SAM_METADATA)));
    if (!face) writeCache('sam-face', (face = await sam('face', 'face', SAM_METADATA)));
    if (!back) {
      const point = args.backFrame !== undefined
        ? { frame: args.backFrame, x: args.backXy[0], y: args.backXy[1], how: 'placed by hand (--back-frame, --back-xy)' }
        : chooseBackPoint(await framesOf(person, info), (await framesOf(face, info)).map(Boolean));
      if (!point) throw new Stop('No frame has a person mask, so there is nowhere to put the back point. Look at the person track, or place it by hand with --back-frame and --back-xy.');
      const text = buildObjectPrompt({
        size: { width: info.width, height: info.height },
        objects: [{ id: 1, prompts: [{ frame: point.frame, points: [{ x: point.x, y: point.y }] }] }],
      });
      back = await sam('back point', text, { ...SAM_METADATA, propagation_direction: 'both' });
      back.point = point;
      writeCache('sam-back', back);
    }

    if (!wonder) {
      const [w, h] = fitSize(info.width, info.height, WONDER_LONG_SIDE);
      const frames = readFrames(work, wonderFrames, w, h);
      const scale = Math.max(2, Math.round(h / 60));
      const content = [{ type: 'input_text', text: promptText }];
      for (const f of wonderFrames) {
        const image = frames.get(f);
        drawNumber(image, f, scale, scale, scale);
        content.push({ type: 'input_image', image_url: `data:image/png;base64,${encodePng(image).toString('base64')}` });
      }
      const attempts = [];
      let labels = null;
      for (let attempt = 1; attempt <= 2 && !labels; attempt++) {
        const label = `Wonder facing, try ${attempt}`;
        const held = budget.reserve(label, wonderWorst);
        log(`${label}...`);
        let reply;
        try {
          reply = await wonderJson(client, { content, name: 'facing_labels', schema: FACING_SCHEMA, maxOutputTokens: WONDER_MAX_OUTPUT_TOKENS });
        } catch (err) {
          // The reservation stays counted at the bound.
          throw new Stop(`${label} failed: ${err.message}\nThe SAM results are cached; running again only redoes Wonder.`);
        }
        const usd = reply.usage ? wonderCost(reply.usage) : wonderWorst;
        const detail = reply.usage ? `${reply.usage.input_tokens} in, ${reply.usage.output_tokens} out` : 'no usage reported; counted at the bound';
        budget.settle(held, usd);
        const check = checkFacing(reply.text ?? '', wonderFrames);
        attempts.push({ status: reply.status, usage: reply.usage, text: reply.text, problems: check.ok ? [] : check.problems, spend: { name: label, usd, detail } });
        if (check.ok) labels = check.labels;
        else log(`  The reply failed the check: ${check.problems.slice(0, 3).join('; ')}`);
        // Out of tokens: the same request would run out again, so don't pay twice.
        if (!labels && reply.status === 'incomplete') {
          log(`  It ran out of output tokens (${reply.usage?.output_tokens_details?.reasoning_tokens ?? '?'} spent reasoning), so no retry.`);
          break;
        }
      }
      wonder = { clipSha256: sha, model: WONDER_MODEL, frames: wonderFrames, imageSize: [w, h], prompt: promptText, attempts, labels };
      writeCache('wonder-facing', wonder);
    }
    log(`Spent this run: ${money(budget.spent)}.`);
  } else {
    log('Every response is cached for this clip; nothing to pay for.');
  }

  await writeOutputs({ info, work, sha, person, face, back, wonder });
}

async function framesOf(cache, info) {
  return framesFromRecords((await parseCachedOutput(cache.rawOutput)).records, info.frames);
}

async function writeOutputs({ info, work, sha, person, face, back, wonder }) {
  const personFrames = await framesOf(person, info);
  const faceFrames = await framesOf(face, info);
  const backFrames = await framesOf(back, info);
  const facePresent = faceFrames.map(Boolean);
  const heights = bodyHeights(personFrames);
  const point = back.point;

  const stripFrames = [];
  for (let f = 0; f < info.frames; f += STRIP_EVERY) stripFrames.push(f);
  if (!stripFrames.includes(point.frame)) stripFrames.push(point.frame);
  stripFrames.sort((a, b) => a - b);
  const [tw, th] = fitSize(info.width, info.height, STRIP_LONG_SIDE);
  const thumbs = readFrames(work, stripFrames, tw, th);
  const cells = stripFrames.map((f) => {
    const image = thumbs.get(f);
    if (personFrames[f]) tintMask(image, personFrames[f], info.width, info.height, COLORS.person, 0.35);
    if (faceFrames[f]) tintMask(image, faceFrames[f], info.width, info.height, COLORS.face, 0.5);
    if (backFrames[f]) tintMask(image, backFrames[f], info.width, info.height, COLORS.back, 0.5);
    if (f === point.frame) drawMarker(image, (point.x * tw) / info.width, (point.y * th) / info.height, 7, [255, 255, 255]);
    drawNumber(image, f, 3, 3, 3);
    return image;
  });
  writeFileSync(join(dir, 'strip.png'), encodePng(tile(cells, STRIP_COLUMNS, 4)));

  const outcome = (c) => (c.outcome.status === 'completed' ? 'completed' : `incomplete (${c.outcome.reason})`);
  const confidence = (frames) => percentile(frames.flatMap((m) => (m && m.confidence !== undefined ? [m.confidence] : [])), 0.5);
  const failed = wonder.attempts.flatMap((a) => a.problems);
  const report = renderReport({
    clip: { file: 'fixtures/probe/clip.mp4', sha256: sha, frames: info.frames, width: info.width, height: info.height, fps: info.fps },
    prompts: [
      { name: '`person`', stats: jumpStats(personFrames, heights), medianConfidence: confidence(personFrames), outcome: outcome(person) },
      { name: '`face`', stats: jumpStats(faceFrames, heights), medianConfidence: confidence(faceFrames), outcome: outcome(face) },
      { name: 'back point', stats: jumpStats(backFrames, heights), medianConfidence: confidence(backFrames), outcome: outcome(back) },
    ],
    facePresent,
    backPoint: point,
    backHeld: { noFaceFrames: facePresent.filter((p) => !p).length, withMask: backFrames.filter((m, f) => m && !facePresent[f]).length },
    wonder: wonder.labels
      ? { labels: wonder.labels, note: wonder.attempts.length > 1 ? 'The first reply failed the schema check; these labels are from the one retry.' : '' }
      : { labels: [], note: `Both replies failed the schema check: ${failed.slice(0, 5).join('; ')}.` },
    spend: [person.spend, face.spend, back.spend, ...wonder.attempts.map((a) => a.spend)],
    stripEvery: STRIP_EVERY,
    generatedAt: new Date().toISOString(),
  });
  writeFileSync(join(dir, 'report.md'), report);
  log('Wrote fixtures/probe/report.md and fixtures/probe/strip.png.');
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Stop ? err.message : err.stack ?? err}\n`);
  process.exit(1);
});
