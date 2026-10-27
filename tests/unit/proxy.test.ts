import { describe, expect, it } from 'vitest';
import { PASSCODE_HEADER, WONDER_MAX_OUTPUT_TOKENS, handleProxy, spendKey, type ProxyEnv, type SpendStore } from '../../functions/_lib/proxy.ts';
import { MAX_CLIP_FRAMES, samCost } from '../../functions/_lib/pricing.ts';

// Offline: a fake upstream that records what it was sent, and an in-memory KV.
const UPSTREAM = 'https://upstream.test/v1';
const NOW = new Date('2026-10-27T15:00:00Z');

function memoryStore(): SpendStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (key) => data.get(key) ?? null,
    put: async (key, value) => void data.set(key, value),
  };
}

function setup(overrides: Partial<ProxyEnv> = {}) {
  const sent: Request[] = [];
  const env: ProxyEnv = { META_API_KEY: 'test-key-123', PROXY_PASSCODE: 'open-sesame', DAILY_SPEND_CAP_USD: '0.2', SPEND: memoryStore(), ...overrides };
  const call = (path: string, init: RequestInit = {}) =>
    handleProxy(new Request(`https://app.test/api/${path}`, { method: 'POST', ...init }), path, env, {
      upstream: UPSTREAM,
      now: () => NOW,
      fetch: async (request) => {
        sent.push(request);
        return new Response('data: ok\n\n', { status: 200, headers: { 'content-type': 'text/event-stream', 'set-cookie': 'x=1' } });
      },
    });
  return { env, sent, call };
}

const sam = JSON.stringify({ model: 'sam-3.1', input: [], stream: true });

describe('proxy: uploads', () => {
  it('refuses an upload without the right passcode', async () => {
    const { sent, call } = setup();
    expect((await call('files', { body: 'clip' })).status).toBe(401);
    expect((await call('files', { body: 'clip', headers: { [PASSCODE_HEADER]: 'open-sesamE' } })).status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it('forwards an upload with the passcode, swapping it for the key', async () => {
    const { sent, call } = setup();
    const res = await call('files', { body: 'clip-bytes', headers: { [PASSCODE_HEADER]: 'open-sesame', 'content-type': 'multipart/form-data; boundary=b' } });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(`${UPSTREAM}/files`);
    expect(sent[0].headers.get('authorization')).toBe('Bearer test-key-123');
    expect(sent[0].headers.get(PASSCODE_HEADER)).toBeNull();
    expect(sent[0].headers.get('content-type')).toBe('multipart/form-data; boundary=b');
    expect(await sent[0].text()).toBe('clip-bytes');
  });
});

describe('proxy: spend cap', () => {
  it('reserves the worst case per call and blocks calls past the daily cap', async () => {
    const { env, sent, call } = setup();
    // $0.20 cap at $0.09 per SAM call: two fit, the third is refused.
    expect((await call('responses', { body: sam })).status).toBe(200);
    expect((await call('responses', { body: sam })).status).toBe(200);
    const third = await call('responses', { body: sam });
    expect(third.status).toBe(429);
    expect(sent).toHaveLength(2);
    expect(Number((env.SPEND as ReturnType<typeof memoryStore>).data.get(spendKey(NOW)))).toBeCloseTo(2 * samCost(MAX_CLIP_FRAMES), 9);
  });

  it('caps Wonder output tokens and counts its images', async () => {
    const { sent, call } = setup({ DAILY_SPEND_CAP_USD: '5' });
    const body = JSON.stringify({ model: 'muse-wonder-1.0', max_output_tokens: 100_000, input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:' }] }] });
    expect((await call('responses', { body })).status).toBe(200);
    expect(JSON.parse(await sent[0].text()).max_output_tokens).toBe(WONDER_MAX_OUTPUT_TOKENS);
  });

  it('fails closed when the cap or the store is missing', async () => {
    expect((await setup({ DAILY_SPEND_CAP_USD: undefined }).call('responses', { body: sam })).status).toBe(503);
    expect((await setup({ SPEND: undefined }).call('responses', { body: sam })).status).toBe(503);
    expect((await setup({ META_API_KEY: undefined }).call('responses', { body: sam })).status).toBe(503);
  });
});

describe('proxy: what it lets through', () => {
  it('only proxies the two models, and only POST to known routes', async () => {
    const { sent, call } = setup();
    expect((await call('responses', { body: JSON.stringify({ model: 'other-model' }) })).status).toBe(400);
    expect((await call('responses', { body: 'not json' })).status).toBe(400);
    expect((await call('models', { body: '{}' })).status).toBe(404);
    expect((await call('responses', { method: 'GET' })).status).toBe(405);
    expect(sent).toHaveLength(0);
  });

  it('passes the upstream body through without its cookies or the key', async () => {
    const { call } = setup();
    const res = await call('responses', { body: sam });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('set-cookie')).toBeNull();
    const text = await res.text();
    expect(text).toBe('data: ok\n\n');
    expect(text).not.toContain('test-key-123');
  });
});
