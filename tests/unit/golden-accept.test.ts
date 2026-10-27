import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve('scripts/golden-accept.mjs');
const run = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });

describe('golden:accept', () => {
  it('copies the sheets for one milestone into tests/golden/<id>/', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inkwell-golden-'));
    mkdirSync(join(dir, 'verify', 'out', 'M1'), { recursive: true });
    writeFileSync(join(dir, 'verify', 'out', 'M1', 'sheet.png'), 'sheet');
    writeFileSync(join(dir, 'verify', 'out', 'M1', 'timing-strip.png'), 'strip');
    writeFileSync(join(dir, 'verify', 'out', 'M1', 'notes.json'), '{}');
    const result = run(dir, 'M1');
    expect(result.status).toBe(0);
    expect(readFileSync(join(dir, 'tests', 'golden', 'M1', 'sheet.png'), 'utf8')).toBe('sheet');
    expect(readFileSync(join(dir, 'tests', 'golden', 'M1', 'timing-strip.png'), 'utf8')).toBe('strip');
    expect(existsSync(join(dir, 'tests', 'golden', 'M1', 'notes.json'))).toBe(false);
  });

  it('refuses a bad id or a milestone with no sheets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inkwell-golden-'));
    expect(run(dir, '../M1').status).toBe(1);
    expect(run(dir, 'M2').status).toBe(1);
    expect(existsSync(join(dir, 'tests'))).toBe(false);
  });
});
