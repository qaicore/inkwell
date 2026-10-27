// The Pages Function's logic, kept free of the real API host and the real
// fetch so tests can drive it offline. It holds the key (the browser never
// sees it), requires the passcode for uploads, and holds a daily spend cap.
//
// The cap works by reservation: before forwarding a paid call, it adds that
// call's worst-case cost to today's total and refuses the call if that would
// pass the cap. It never refunds the difference, so the real spend can only
// come in under the recorded one. Today's total lives in a KV namespace, which
// is eventually consistent: two calls in the same instant could both pass, so
// the cap can be exceeded by at most one call's worth. Exact counting would
// need a Durable Object, which this doesn't need yet.
import { MAX_CLIP_FRAMES, SAM_MODEL, WONDER_MODEL, samCost, wonderMaxCost } from './pricing.ts';

// The subset of a Cloudflare KV namespace this uses.
export interface SpendStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface ProxyEnv {
  META_API_KEY?: string;
  PROXY_PASSCODE?: string;
  DAILY_SPEND_CAP_USD?: string;
  SPEND?: SpendStore;
}

export interface ProxyDeps {
  upstream: string; // API base URL, ending in /v1
  fetch: (request: Request) => Promise<Response>;
  now?: () => Date;
}

export const PASSCODE_HEADER = 'x-inkwell-passcode';
export const WONDER_MAX_OUTPUT_TOKENS = 4000;

const json = (status: number, message: string) =>
  new Response(JSON.stringify({ error: { message } }), { status, headers: { 'content-type': 'application/json' } });

// Compares every character even after a mismatch, so response time doesn't
// reveal how much of a guess was right.
function sameSecret(given: string, expected: string): boolean {
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export function spendKey(now: Date): string {
  return `spend:${now.toISOString().slice(0, 10)}`; // one total per UTC day
}

// `path` is what follows /api/ in the request URL, e.g. "files" or "responses".
export async function handleProxy(request: Request, path: string, env: ProxyEnv, deps: ProxyDeps): Promise<Response> {
  const cap = Number(env.DAILY_SPEND_CAP_USD);
  if (!env.META_API_KEY || !env.SPEND || !env.DAILY_SPEND_CAP_USD || !Number.isFinite(cap) || cap < 0) {
    return json(503, 'The proxy is not configured: it needs META_API_KEY, DAILY_SPEND_CAP_USD and the SPEND KV binding.');
  }
  if (request.method !== 'POST') return json(405, 'Only POST is proxied.');

  let body: ArrayBuffer | string;
  let cost: number;
  if (path === 'files') {
    if (!env.PROXY_PASSCODE || !sameSecret(request.headers.get(PASSCODE_HEADER) ?? '', env.PROXY_PASSCODE)) {
      return json(401, 'Uploads need the passcode.');
    }
    body = await request.arrayBuffer();
    cost = 0; // uploading isn't billed; the SAM calls that read the file are
  } else if (path === 'responses') {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(await request.text());
    } catch {
      return json(400, 'The request body is not JSON.');
    }
    if (payload.model === SAM_MODEL) {
      cost = samCost(MAX_CLIP_FRAMES);
    } else if (payload.model === WONDER_MODEL) {
      const asked = Number(payload.max_output_tokens);
      payload.max_output_tokens = asked > 0 ? Math.min(asked, WONDER_MAX_OUTPUT_TOKENS) : WONDER_MAX_OUTPUT_TOKENS;
      const text = JSON.stringify(payload.input ?? '');
      const images = text.split('"input_image"').length - 1;
      cost = wonderMaxCost(images, text.length, payload.max_output_tokens as number);
    } else {
      return json(400, `Only ${SAM_MODEL} and ${WONDER_MODEL} are proxied.`);
    }
    body = JSON.stringify(payload);
  } else {
    return json(404, 'Unknown route.');
  }

  if (cost > 0) {
    const key = spendKey((deps.now ?? (() => new Date()))());
    const spent = Number((await env.SPEND.get(key)) ?? 0) || 0;
    if (spent + cost > cap) return json(429, `Today's spend cap of $${cap.toFixed(2)} is reached.`);
    await env.SPEND.put(key, String(spent + cost), { expirationTtl: 2 * 24 * 3600 });
  }

  const headers = new Headers({ authorization: `Bearer ${env.META_API_KEY}` });
  for (const name of ['content-type', 'accept']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const upstream = await deps.fetch(new Request(`${deps.upstream}/${path}`, { method: 'POST', headers, body }));
  // Pass the body through as it streams (SAM answers as server-sent events),
  // keeping only the content type: no upstream cookies or rate-limit details.
  const out = new Headers({ 'cache-control': 'no-store' });
  const type = upstream.headers.get('content-type');
  if (type) out.set('content-type', type);
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
