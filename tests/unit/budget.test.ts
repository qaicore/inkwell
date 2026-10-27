import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Budget } from '../../scripts/lib/budget.ts';

const NOW = new Date(2026, 9, 27, 15); // local time, so the ledger day is 2026-10-27
const DAY = '2026-10-27';

function ledgerIn() {
  const dir = mkdtempSync(join(tmpdir(), 'inkwell-budget-'));
  return { dir, ledger: join(dir, '.spend.json') };
}
const budget = (ledger: string, caps: { runCap?: number; dailyCap?: number } = {}) =>
  new Budget({ runCap: 1, dailyCap: 5, ...caps, ledger, now: () => NOW });
const onDisk = (ledger: string) => JSON.parse(readFileSync(ledger, 'utf8'))[DAY];

describe('spend budget', () => {
  it('counts the worst case before a call starts, and the real cost once it settles', () => {
    const { ledger } = ledgerIn();
    const b = budget(ledger);
    expect(b.spentToday()).toBe(0); // no ledger yet
    const held = b.reserve('SAM person', 0.09);
    expect(onDisk(ledger)).toBeCloseTo(0.09, 9); // written before the call runs
    b.settle(held, 0.06);
    expect(onDisk(ledger)).toBeCloseTo(0.06, 9);
    expect(b.spent).toBeCloseTo(0.06, 9);
  });

  it('keeps a reservation that never settled, as when Ctrl+C stops a run mid-call', () => {
    const { ledger } = ledgerIn();
    budget(ledger).reserve('SAM person', 0.09); // the run dies here
    const next = budget(ledger, { dailyCap: 0.15 });
    expect(next.spentToday()).toBeCloseTo(0.09, 9);
    expect(() => next.reserve('SAM face', 0.09)).toThrow(/today's cap/);
    expect(onDisk(ledger)).toBeCloseTo(0.09, 9);
  });

  it('refuses a reservation past the run cap', () => {
    const { ledger } = ledgerIn();
    const b = budget(ledger, { runCap: 0.1 });
    b.reserve('SAM person', 0.09);
    expect(() => b.reserve('SAM face', 0.09)).toThrow(/this run's cap/);
    expect(onDisk(ledger)).toBeCloseTo(0.09, 9);
  });

  it('stops on a ledger it cannot read, and leaves the file as it was', () => {
    const { ledger } = ledgerIn();
    for (const text of ['{"2026-10-27": 0.4', '[]', 'null', '{"2026-10-27": "0.4"}']) {
      writeFileSync(ledger, text);
      const b = budget(ledger);
      expect(() => b.spentToday()).toThrow(/spend ledger/);
      expect(() => b.reserve('SAM person', 0.09)).toThrow(/spend ledger/);
      expect(readFileSync(ledger, 'utf8')).toBe(text);
    }
  });

  it('writes through a temp file and leaves none behind', () => {
    const { dir, ledger } = ledgerIn();
    const b = budget(ledger);
    b.settle(b.reserve('SAM person', 0.09), 0.05);
    expect(readdirSync(dir)).toEqual(['.spend.json']);
    expect(onDisk(ledger)).toBeCloseTo(0.05, 9);
  });
});
