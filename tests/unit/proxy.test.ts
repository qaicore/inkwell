import { describe, expect, it } from 'vitest';
import { PASSCODE_HEADER, WONDER_MAX_OUTPUT_TOKENS, handleProxy, spendKey, type ProxyEnv, type SpendStore } from '../../functions/_lib/proxy.ts';
import { MAX_CLIP_FRAMES, samCost, wonderMaxCost } from '../../functions/_lib/pricing.ts';

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

describe('proxy: pricing what it forwards', () => {
  const wonder = (fields: object) => JSON.stringify({ model: 'muse-wonder-1.0', ...fields });

  it('refuses keys it cannot price, so nothing rides along unpriced', async () => {
    const { sent, call } = setup({ DAILY_SPEND_CAP_USD: '5' });
    const extras = [{ instructions: 'x'.repeat(900_000) }, { previous_response_id: 'resp_1' }, { conversation: 'conv_1' }, { tools: [{ type: 'web_search' }] }];
    for (const extra of extras) expect((await call('responses', { body: wonder({ input: 'hi', ...extra }) })).status).toBe(400);
    expect((await call('responses', { body: JSON.stringify({ model: 'sam-3.1', input: [], instructions: 'x' }) })).status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it('refuses Wonder input it cannot price: files, video, references to earlier items', async () => {
    const { sent, call } = setup({ DAILY_SPEND_CAP_USD: '5' });
    for (const part of [{ type: 'input_file', file_id: 'file_1' }, { type: 'input_video', file_id: 'file_1' }]) {
      expect((await call('responses', { body: wonder({ input: [{ role: 'user', content: [part] }] }) })).status).toBe(400);
    }
    expect((await call('responses', { body: wonder({ input: [{ type: 'item_reference', id: 'msg_1' }] }) })).status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it('prices every forwarded character, wherever it sits', async () => {
    // 900k characters at a token per 3 characters is $1.20 of input, past a $1 cap.
    const { sent, call } = setup({ DAILY_SPEND_CAP_USD: '1' });
    const big = 'x'.repeat(900_000);
    const bodies = [
      wonder({ input: big }),
      wonder({ input: [{ role: 'user', content: [{ type: 'input_text', text: big }] }] }),
      wonder({ input: 'hi', text: { format: { type: 'text' }, note: big } }),
      wonder({ input: 'hi', metadata: { note: big } }),
    ];
    for (const body of bodies) expect((await call('responses', { body })).status).toBe(429);
    expect(sent).toHaveLength(0);
  });

  it('counts an inline image once, not its base64 as text', async () => {
    // The probe's call: 8 PNG frames at 768 px, roughly 700 KB of base64 each.
    // Priced as text that's about $7.50, past the $5 cap; priced as images, cents.
    const { env, sent, call } = setup({ DAILY_SPEND_CAP_USD: '5' });
    const image = { type: 'input_image', image_url: `data:image/png;base64,${'A'.repeat(700_000)}` };
    const prompt = 'Label each numbered frame. '.repeat(40);
    const content = [{ type: 'input_text', text: prompt }, ...Array.from({ length: 8 }, () => image)];
    const body = wonder({ input: [{ type: 'message', role: 'user', content }], max_output_tokens: 4000 });
    expect((await call('responses', { body })).status).toBe(200);
    expect(sent).toHaveLength(1);
    const reserved = Number((env.SPEND as ReturnType<typeof memoryStore>).data.get(spendKey(NOW)));
    expect(reserved).toBeGreaterThan(wonderMaxCost(8, prompt.length, 4000));
    expect(reserved).toBeLessThan(wonderMaxCost(8, prompt.length + 1000, 4000));
  });

  it('still prices a data: string outside an image part', async () => {
    const { sent, call } = setup({ DAILY_SPEND_CAP_USD: '1' });
    const body = wonder({ input: 'hi', metadata: { image_url: `data:${'x'.repeat(900_000)}` } });
    expect((await call('responses', { body })).status).toBe(429);
    expect(sent).toHaveLength(0);
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

  it('refuses a body that is JSON but not an object', async () => {
    const { sent, call } = setup();
    for (const body of ['null', '[]', '42', '"sam-3.1"']) expect((await call('responses', { body })).status).toBe(400);
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
