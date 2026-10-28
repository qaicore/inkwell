// npm run plan:record -- <clip> <drawings.json>: Muse Wonder's stroke plan
// for each drawing, recorded once for the tests to replay (W1, G1; SPEC §9).
// COSTS MONEY. Run it only when Qai says go. It prints the cost and waits for
// a typed "yes" before the first paid call.
//
// <drawings.json> is the app's "Save drawings" file: the strokes by the frame
// they were drawn on, drawn on fixtures/<clip>/clip.mp4. Each drawing is one
// call, planned exactly as the app plans it: the same numbered frame
// (src/plan/numbered.ts), prompt and schema, the schema check and one retry
// (src/plan/plan.ts), reasoning 'low'. Calls go into --out in the shape the
// tests read, { model, calls: [{ clip, clipSha256, frame, strokes, attempts }] },
// one write per call. A drawing already recorded for this clip isn't paid
// for again. Stroke ids must be unique across the file (W1 labels them 1-30):
// ids already used by another drawing are renumbered and the new numbers
// printed. The numbered frames go to samples/plan/ (not committed) for
// labeling. Fewer drawings cost less: put several strokes on one frame.
//
//   npm run plan:record -- probe drawings.json --out fixtures/probe/wonder-plan.json   (G1)
//   npm run plan:record -- side-step drawings.json                                      (W1, fixtures/strokes/)
//   npm run plan:record -- side-step drawings.json --dry-run    (prints the quote, spends nothing)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { WONDER_MODEL, wonderCost, wonderMaxCost } from '../../functions/_lib/pricing.ts';
import { fitSize, readFrames } from '../probe/ffmpeg.ts';
import { drawPlanMarks, PLAN_IMAGE_LONG_SIDE } from '../../src/plan/numbered.ts';
import { planPrompt, planStrokes } from '../../src/plan/plan.ts';
import { PLAN_SCHEMA } from '../../src/plan/schema.ts';
import { PLAN_OUTPUT_TOKENS } from '../../src/plan/request.ts';
import { masksFromCache } from '../../src/sam/cache.ts';
import { Budget, LEDGER, confirm, loadKeys, makeClient, wonderJson } from './meta.mjs';
import { Stop, fixtureClip, log, money, readCache } from './clip.mjs';

const RUN_CAP_USD = 2.0; // this run, on top of DAILY_SPEND_CAP_USD across runs
const LIKELY_OUTPUT_TOKENS = 1000; // 'low' reasoning plus the JSON; the bound is PLAN_OUTPUT_TOKENS

const root = process.cwd();

function parseArgs(argv) {
  const args = { clip: '', drawings: '', out: 'fixtures/strokes/wonder-plan.json', dryRun: false };
  const free = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = String(argv[++i] ?? '');
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') {
      const lines = readFileSync(new URL(import.meta.url), 'utf8').split(/\r?\n/);
      log(lines.slice(0, lines.findIndex((l) => !l.startsWith('//'))).map((l) => l.slice(3)).join('\n'));
      process.exit(0);
    } else if (!a.startsWith('-')) free.push(a);
    else throw new Stop(`Unknown option ${a}. Try: npm run plan:record -- --help`);
  }
  [args.clip, args.drawings] = free;
  if (!args.clip || !args.drawings || free.length > 2) throw new Stop('Usage: npm run plan:record -- <clip> <drawings.json> [--out file] [--dry-run]');
  if (!/^fixtures\/[a-z0-9-]+\/wonder-plan\.json$/.test(args.out)) throw new Stop('--out is fixtures/<folder>/wonder-plan.json');
  return args;
}

const sameStrokes = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function readDrawings(path, clip) {
  if (!existsSync(path)) throw new Stop(`${path} is missing. Draw in the app, then Save drawings.`);
  const d = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(d.drawings)) throw new Stop(`${path} isn't the app's drawings.json.`);
  if (d.sourceSha256 && d.sourceSha256 !== clip.sha) throw new Stop(`${path} was drawn on a different file than fixtures/${clip.id}/clip.mp4. Open that file in the app and draw again.`);
  if (d.width !== clip.info.width || d.height !== clip.info.height) throw new Stop(`${path} is for a ${d.width}x${d.height} clip; fixtures/${clip.id} is ${clip.info.width}x${clip.info.height}.`);
  for (const drawing of d.drawings) {
    if (!Number.isInteger(drawing.frame) || drawing.frame < 0 || drawing.frame >= clip.info.frames) throw new Stop(`${path}: frame ${drawing.frame} isn't in the clip.`);
  }
  return d.drawings;
}

// Ids other drawings in the file already use move up past the largest one.
function renumber(drawings, calls) {
  const used = new Set(calls.flatMap((c) => c.strokes.map((s) => s.id)));
  let next = Math.max(0, ...used) + 1;
  for (const drawing of drawings) {
    for (const s of drawing.strokes) {
      if (!used.has(s.id)) {
        used.add(s.id);
        continue;
      }
      log(`  Stroke ${s.id} on frame ${drawing.frame} is now stroke ${next} (the number was taken).`);
      s.id = next++;
      used.add(s.id);
    }
  }
}

// The frame as the app sends it: 1024 px on the long side, strokes numbered.
async function numberedFrame(clip, drawing) {
  const [w, h] = fitSize(clip.info.width, clip.info.height, PLAN_IMAGE_LONG_SIDE);
  const image = readFrames(clip.work, [drawing.frame], w, h).get(drawing.frame);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const rgba = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    rgba.data[i * 4] = image.data[i * 3];
    rgba.data[i * 4 + 1] = image.data[i * 3 + 1];
    rgba.data[i * 4 + 2] = image.data[i * 3 + 2];
    rgba.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(rgba, 0, 0);
  drawPlanMarks(ctx, drawing.strokes, w / clip.info.width);
  return canvas.encode('jpeg', 85);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const clip = fixtureClip(root, args.clip);
  const outPath = join(root, args.out);
  const file = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : { model: WONDER_MODEL, calls: [] };
  const drawings = readDrawings(join(root, args.drawings), clip);
  const done = (d) => file.calls.some((c) => c.clipSha256 === clip.sha && c.frame === d.frame && sameStrokes(c.strokes.map((s) => s.points), d.strokes.map((s) => s.points)));
  const pending = drawings.filter((d) => !done(d));
  if (pending.length === 0) {
    log(`Every drawing in ${args.drawings} is recorded in ${args.out}; nothing to pay for.`);
    return;
  }
  renumber(pending, file.calls);

  // The masks the nearest-mask fallback reads, as in the app.
  const person = readCache(clip, 'sam-person.json');
  const face = readCache(clip, 'sam-face.json');
  if (!person) log(`fixtures/${clip.id}/sam-person.json isn't cached; if Wonder fails twice, the rule falls back to "person" without a mask. Run fixtures:refresh first to avoid that.`);
  const personMasks = person ? await masksFromCache(person, clip.info.frames) : [];
  const faceMasks = face ? await masksFromCache(face, clip.info.frames) : [];
  const inputOf = (d) => ({ frame: d.frame, strokes: d.strokes, masks: { person: personMasks[d.frame] ?? null, face: faceMasks[d.frame] ?? null } });

  const schemaChars = JSON.stringify(PLAN_SCHEMA).length;
  const quotes = pending.map((d) => {
    const chars = planPrompt(inputOf(d)).length + schemaChars;
    return { d, worst: wonderMaxCost(1, chars, PLAN_OUTPUT_TOKENS), likely: wonderMaxCost(1, chars, LIKELY_OUTPUT_TOKENS) };
  });
  const worst = quotes.reduce((sum, q) => sum + 2 * q.worst, 0);
  const likely = quotes.reduce((sum, q) => sum + q.likely, 0);
  log('', 'Paid calls this run (Meta API, prices from dev.meta.ai/docs/pricing-rate-limits):');
  for (const q of quotes) log(`  Wonder plan, frame ${String(q.d.frame).padEnd(4)} ${q.d.strokes.length} stroke(s)  up to ${money(q.worst)} a try, plus one retry if the reply fails the schema check`);
  log(`Total: at most ${money(worst)}, likely about ${money(likely)}.`);
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
  mkdirSync(join(root, 'samples', 'plan'), { recursive: true });
  mkdirSync(dirname(outPath), { recursive: true });

  for (const q of quotes) {
    const { d } = q;
    const jpeg = await numberedFrame(clip, d);
    const picture = join('samples', 'plan', `${clip.id}-f${d.frame}.jpg`);
    writeFileSync(join(root, picture), jpeg);
    const image = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
    const attempts = [];
    let failed = null; // planStrokes retries a failed call; this stops it paying again
    const transport = async (request) => {
      if (failed) throw failed;
      const label = `Wonder plan, frame ${d.frame}, try ${request.attempt}`;
      const held = budget.reserve(label, q.worst);
      log(`${label}...`);
      let reply;
      try {
        reply = await wonderJson(client, {
          content: [{ type: 'input_text', text: request.prompt }, { type: 'input_image', image_url: image }],
          name: 'stroke_plan',
          schema: request.schema,
          maxOutputTokens: PLAN_OUTPUT_TOKENS,
        });
      } catch (err) {
        // The reservation stays counted at the bound. Nothing is recorded for a
        // call that didn't answer, so a rerun asks again.
        failed = new Stop(`${label} failed: ${err.message}. Nothing was recorded for frame ${d.frame}; the frames before it are saved.`);
        throw failed;
      }
      const usd = reply.usage ? wonderCost(reply.usage) : q.worst;
      budget.settle(held, usd);
      attempts.push({ status: reply.status, text: reply.text ?? '', usage: reply.usage, spend: { name: label, usd, detail: reply.usage ? `${reply.usage.input_tokens} in, ${reply.usage.output_tokens} out` : 'no usage reported; counted at the bound' } });
      return reply.text ?? '';
    };
    const result = await planStrokes(inputOf(d), transport);
    if (failed) throw failed;
    file.calls.push({ clip: clip.id, clipSha256: clip.sha, frame: d.frame, strokes: d.strokes, attempts, plan: result.strokes, source: result.source, note: result.note });
    writeFileSync(outPath, `${JSON.stringify(file, null, 1)}\n`);
    log(`  ${result.source === 'wonder' ? 'Planned by Wonder' : `Fell back to the rule: ${result.note}`}. Numbered frame: ${picture}`);
  }
  log(`Spent this run: ${money(budget.spent)}. Wrote ${args.out}.`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Stop ? err.message : err.stack ?? err}\n`);
  process.exit(1);
});
