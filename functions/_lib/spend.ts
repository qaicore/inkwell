// The proxy's daily spend total, kept in Cloudflare D1 (SQLite). Each
// reservation is one conditional upsert, and SQLite runs a statement as a
// whole, so the read, the compare and the write can't interleave with
// another call's the way a KV get-then-put can.
import type { SpendStore } from './proxy.ts';

// The subset of a D1 database binding this uses.
export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): { first(): Promise<unknown>; run(): Promise<unknown> };
  };
}

const CREATE = 'CREATE TABLE IF NOT EXISTS spend (day TEXT PRIMARY KEY, usd REAL NOT NULL)';
// Starts the day's total, or adds to it, only while it stays within the cap.
// RETURNING gives a row only when a row was written, so no row means refused.
const RESERVE = `INSERT INTO spend (day, usd) SELECT ?1, ?2 WHERE ?2 <= ?3
  ON CONFLICT (day) DO UPDATE SET usd = usd + excluded.usd WHERE usd + excluded.usd <= ?3
  RETURNING usd`;

export function d1SpendStore(db: D1Like): SpendStore {
  let table: Promise<unknown> | undefined;
  return {
    async reserve(day, usd, cap) {
      table ??= db.prepare(CREATE).bind().run();
      await table;
      return (await db.prepare(RESERVE).bind(day, usd, cap).first()) !== null;
    },
  };
}
