/// <reference types="node" />
// Shared plumbing for the acceptance tests in tests/M*/.
// - Evidence: each criterion file records its checks, prints "measured vs threshold" for each one,
//   and writes verify/out/<ID>.json as { id, measured, threshold, pass, notes } in afterAll.
//   A check that never ran (the test crashed first) counts as a FAIL.
// - run/git: child processes with captured output, never a shell, never the network.
// - readText: UTF-8 or UTF-16 (PowerShell's ">" writes UTF-16), BOM stripped.
// Only local files are read here. Nothing in this module may loosen a check.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root, from this file's location (tests/helpers/ is two levels down). */
export const ROOT: string = fileURLToPath(new URL('../../', import.meta.url));

export interface Check {
  name: string;
  measured: unknown;
  threshold: unknown;
  pass: boolean;
  notes: string;
}

function show(v: unknown): string {
  if (typeof v === 'string') return v;
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 400 ? `${s.slice(0, 400)}...` : s;
}

export class Evidence {
  readonly id: string;
  readonly expected: string[];
  readonly checks: Check[] = [];

  /** `expected` names every check this criterion must record; a missing one is a FAIL. */
  constructor(id: string, expected: string[]) {
    this.id = id;
    this.expected = expected;
  }

  record(name: string, measured: unknown, threshold: unknown, pass: boolean, notes = ''): boolean {
    this.checks.push({ name, measured, threshold, pass, notes });
    process.stdout.write(
      `[${this.id}] ${name}: measured ${show(measured)} | threshold ${show(threshold)} | ${pass ? 'PASS' : 'FAIL'}${notes ? ` | ${notes}` : ''}\n`,
    );
    return pass;
  }

  get pass(): boolean {
    return this.missing().length === 0 && this.checks.every((c) => c.pass);
  }

  missing(): string[] {
    return this.expected.filter((n) => !this.checks.some((c) => c.name === n));
  }

  write(): void {
    const measured: Record<string, unknown> = {};
    const threshold: Record<string, unknown> = {};
    const notes: string[] = [];
    for (const c of this.checks) {
      measured[c.name] = c.measured;
      threshold[c.name] = c.threshold;
      if (!c.pass) notes.push(`FAIL ${c.name}${c.notes ? `: ${c.notes}` : ''}`);
      else if (c.notes) notes.push(`${c.name}: ${c.notes}`);
    }
    for (const m of this.missing()) notes.push(`FAIL ${m}: check did not run (the test crashed before recording it)`);
    const out = join(ROOT, 'verify', 'out');
    mkdirSync(out, { recursive: true });
    const body = { id: this.id, measured, threshold, pass: this.pass, notes: notes.join('\n') };
    writeFileSync(join(out, `${this.id}.json`), `${JSON.stringify(body, null, 2)}\n`);
  }
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error: string;
}

export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): RunResult {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    env: opts.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    timeout: opts.timeout ?? 60_000,
    windowsHide: true,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ? r.error.message : '' };
}

/** git in the real repo (or `cwd`), with stable, unquoted path output. */
export function git(args: string[], cwd: string = ROOT, env?: NodeJS.ProcessEnv): RunResult {
  return run('git', ['-c', 'core.quotepath=off', '--no-pager', ...args], { cwd, env });
}

/** Reads UTF-8 or UTF-16LE text and strips a BOM. */
export function readText(path: string): string {
  const b = readFileSync(path);
  const s = b[0] === 0xff && b[1] === 0xfe ? b.toString('utf16le') : b.toString('utf8');
  return s.replace(/^﻿/, '');
}

/** The milestone id in verify/ACTIVE, or an error message saying why it can't be read. */
export function activeMilestone(): { id: string } | { error: string } {
  const p = join(ROOT, 'verify', 'ACTIVE');
  if (!existsSync(p)) return { error: 'verify/ACTIVE missing: /milestone writes the active milestone id there (SPEC §4)' };
  const id = readText(p).trim();
  if (!/^M\d+$/.test(id)) return { error: `verify/ACTIVE holds "${id}", not a milestone id like M0` };
  return { id };
}

/** Repo-relative path with forward slashes. */
export function slash(p: string): string {
  return p.replaceAll('\\', '/').replace(/^\.\//, '');
}
