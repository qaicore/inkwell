// Paid Meta API calls for scripts in scripts/live/, and the guard rails every
// one of them goes through: the key from .env (never printed), a spend cap
// per run and per day, and a typed "yes" before anything is spent. Tests,
// hooks and npm run verify never import this file.
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import OpenAI from 'openai';
import { parseVideoStream } from '@meta-sam/parser';
import { SAM_MODEL, WONDER_MODEL } from '../../functions/_lib/pricing.ts';
import { readEnvFile } from '../lib/env.ts';

export { Budget } from '../lib/budget.ts';

export const API_BASE = 'https://api.meta.ai/v1';

// What each script spent on each local day, so repeated runs can't pass
// DAILY_SPEND_CAP_USD between them. Gitignored.
export const LEDGER = join(import.meta.dirname, '.spend.json');

export function loadKeys(root) {
  const file = readEnvFile(join(root, '.env'));
  if (!file) throw new Error('.env is missing. Make it with: Copy-Item env.example .env, then paste the key into it.');
  if (file.badLines.length > 0) throw new Error(`.env line ${file.badLines.join(', ')} isn't KEY=value. Fix it, or save the file as UTF-8.`);
  const env = file.values;
  if (!env.META_API_KEY) throw new Error('META_API_KEY is empty in .env.');
  const dailyCap = Number(env.DAILY_SPEND_CAP_USD);
  if (!env.DAILY_SPEND_CAP_USD || !Number.isFinite(dailyCap) || dailyCap <= 0) {
    throw new Error('DAILY_SPEND_CAP_USD in .env must be a positive number of dollars.');
  }
  return { apiKey: env.META_API_KEY, dailyCap };
}

// No automatic retries (a retried call could bill twice outside the
// budget) and a long timeout, since a video segmentation streams for a while.
export function makeClient(apiKey) {
  return new OpenAI({ apiKey, baseURL: API_BASE, maxRetries: 0, timeout: 15 * 60 * 1000 });
}

export async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim().toLowerCase() === 'yes';
  } catch {
    return false; // stdin closed without an answer
  } finally {
    rl.close();
  }
}

// Uploading is free; the id is reused for every SAM call on the clip.
export async function uploadVideo(client, path) {
  const file = await client.files.create({ file: createReadStream(path), purpose: 'user_data' });
  return file.id;
}

// One SAM 3.1 video request, streamed through @meta-sam/parser. Returns the
// parsed result and the billing usage from the final event.
export async function samVideo(client, { fileId, text, metadata }) {
  const stream = await client.responses.create({
    model: SAM_MODEL,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }, { type: 'input_video', file_id: fileId }] }],
    stream: true,
    metadata,
  });
  let usage = null;
  async function* tap() {
    for await (const event of stream) {
      if (event.response?.usage) usage = event.response.usage;
      yield event;
    }
  }
  const result = await parseVideoStream(tap()).finalResult;
  return { result, usage };
}

// One Muse Wonder call with structured output: the reply must match `schema`.
export async function wonderJson(client, { content, name, schema, maxOutputTokens }) {
  const response = await client.responses.create({
    model: WONDER_MODEL,
    input: [{ type: 'message', role: 'user', content }],
    text: { format: { type: 'json_schema', name, schema, strict: true } },
    max_output_tokens: maxOutputTokens,
  });
  const text =
    response.output_text ??
    (response.output ?? [])
      .flatMap((item) => item.content ?? [])
      .filter((part) => part.type === 'output_text')
      .map((part) => part.text)
      .join('');
  return { text, usage: response.usage, status: response.status };
}
