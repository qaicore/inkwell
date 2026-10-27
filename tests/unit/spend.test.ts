import { describe, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { handleProxy, spendDay } from '../../functions/_lib/proxy.ts';
import { d1SpendStore, type D1Like } from '../../functions/_lib/spend.ts';
import { MAX_CLIP_FRAMES, samCost } from '../../functions/_lib/pricing.ts';

// D1 is SQLite, so the store's SQL runs here against Node's built-in SQLite.
// Each statement waits a tick first, like a D1 round trip, so calls made at
// the same time interleave the way they would on Cloudflare.
function sqliteD1() {
  const db = new DatabaseSync(':memory:');
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const d1: D1Like = {
    prepare: (sql) => ({
      bind: (...values) => {
        const args = values as SQLInputValue[];
        return {
          first: async () => (await tick(), db.prepare(sql).get(...args) ?? null),
          run: async () => (await tick(), db.prepare(sql).run(...args)),
        };
      },
    }),
  };
  const total = (day: string) => Number(db.prepare('SELECT usd FROM spend WHERE day = ?').get(day)?.usd ?? 0);
  return { d1, total };
}

const NOW = new Date('2026-10-27T15:00:00Z');

describe('spend store (D1)', () => {
  it('adds up to the cap and no further, one total per day', async () => {
    const { d1, total } = sqliteD1();
    const store = d1SpendStore(d1);
    expect(await store.reserve('2026-10-27', 0.09, 0.2)).toBe(true);
    expect(await store.reserve('2026-10-27', 0.09, 0.2)).toBe(true);
    expect(await store.reserve('2026-10-27', 0.09, 0.2)).toBe(false);
    expect(total('2026-10-27')).toBeCloseTo(0.18, 9);
    expect(await store.reserve('2026-10-28', 0.2, 0.2)).toBe(true); // a new day starts at zero; exactly the cap fits
    expect(await store.reserve('2026-10-29', 0.21, 0.2)).toBe(false); // one call over the cap on its own
    expect(total('2026-10-29')).toBe(0);
  });

  it('holds the cap when 20 calls arrive at once', async () => {
    const { d1, total } = sqliteD1();
    const env = { META_API_KEY: 'test-key-123', DAILY_SPEND_CAP_USD: '0.2', SPEND: d1SpendStore(d1) };
    let forwarded = 0;
    const deps = {
      upstream: 'https://upstream.test/v1',
      now: () => NOW,
      fetch: async () => (forwarded++, new Response('data: ok\n\n')),
    };
    const body = JSON.stringify({ model: 'sam-3.1', input: [], stream: true });
    const calls = Array.from({ length: 20 }, () =>
      handleProxy(new Request('https://app.test/api/responses', { method: 'POST', body }), 'responses', env, deps),
    );
    const statuses = (await Promise.all(calls)).map((res) => res.status);
    // $0.20 cap at $0.09 per SAM call: exactly two fit, however the calls interleave.
    expect(statuses.filter((s) => s === 200)).toHaveLength(2);
    expect(statuses.filter((s) => s === 429)).toHaveLength(18);
    expect(forwarded).toBe(2);
    expect(total(spendDay(NOW))).toBeCloseTo(2 * samCost(MAX_CLIP_FRAMES), 9);
  });
});
