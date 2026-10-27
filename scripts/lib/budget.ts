// The spend caps every paid script goes through: one per run, and one per
// local day across runs, kept in a small JSON ledger. No network and no keys
// here, so tests can drive it.
//
// A paid call reserves its worst case in the ledger before it starts, and
// settle() swaps in the real cost once it returns. A crash or Ctrl+C mid-call
// leaves the worst case counted, never nothing.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

type Ledger = Record<string, number>; // local day (YYYY-MM-DD) -> dollars

export interface Reservation {
  name: string;
  worstCase: number;
}

const localDay = (date: Date) => date.toLocaleDateString('en-CA'); // YYYY-MM-DD, local time

// A missing ledger means nothing spent yet. One that can't be read or parsed
// stops the script: reading it as empty would show $0 and let the next write
// wipe the real total.
function readLedger(path: string): Ledger {
  if (!existsSync(path)) return {};
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`The spend ledger ${path} can't be read (${(err as Error).message}). Fix it by hand; deleting it forgets today's spend.`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data) || !Object.values(data).every(Number.isFinite)) {
    throw new Error(`The spend ledger ${path} isn't a { "YYYY-MM-DD": dollars } object. Fix it by hand; deleting it forgets today's spend.`);
  }
  return data as Ledger;
}

// Written whole to a temp file, then renamed over the ledger, so a crash
// mid-write leaves the old ledger rather than half a file.
function writeLedger(path: string, data: Ledger): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(temp, path);
}

export class Budget {
  readonly runCap: number;
  readonly dailyCap: number;
  readonly ledger: string;
  readonly now: () => Date;
  spent = 0; // this run, reservations included

  constructor({ runCap, dailyCap, ledger, now = () => new Date() }: { runCap: number; dailyCap: number; ledger: string; now?: () => Date }) {
    this.runCap = runCap;
    this.dailyCap = dailyCap;
    this.ledger = ledger;
    this.now = now;
  }

  spentToday(): number {
    return readLedger(this.ledger)[localDay(this.now())] ?? 0;
  }

  // Throws if `worstCase` would pass either cap.
  allow(name: string, worstCase: number): void {
    if (this.spent + worstCase > this.runCap + 1e-9) {
      throw new Error(`${name} could cost $${worstCase.toFixed(2)}, which would pass this run's cap of $${this.runCap.toFixed(2)}. Stopped.`);
    }
    if (this.spentToday() + worstCase > this.dailyCap + 1e-9) {
      throw new Error(`${name} could cost $${worstCase.toFixed(2)}, which would pass today's cap of $${this.dailyCap.toFixed(2)} (DAILY_SPEND_CAP_USD). Stopped.`);
    }
  }

  // Checks both caps, then counts the worst case before the call starts.
  reserve(name: string, worstCase: number): Reservation {
    this.allow(name, worstCase);
    this.add(worstCase);
    return { name, worstCase };
  }

  // After the call returns: replaces the reservation with what it really cost.
  settle(reservation: Reservation, usd: number): void {
    this.add(usd - reservation.worstCase);
  }

  private add(usd: number): void {
    const ledger = readLedger(this.ledger);
    const day = localDay(this.now());
    ledger[day] = (ledger[day] ?? 0) + usd;
    writeLedger(this.ledger, ledger);
    this.spent += usd;
  }
}
