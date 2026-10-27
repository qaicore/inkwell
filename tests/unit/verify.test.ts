import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { localBin } from '../../scripts/lib/bin.ts';

describe('verify runs its tools from node_modules', () => {
  it("finds tsc and vitest in this repo's node_modules", () => {
    for (const [pkg, command] of [['typescript', 'tsc'], ['vitest', 'vitest']]) {
      const bin = localBin(resolve('.'), pkg, command);
      expect(bin.startsWith(resolve('node_modules', pkg))).toBe(true);
      expect(existsSync(bin)).toBe(true);
    }
  });

  it('stops and says to run npm install when node_modules is missing, before running anything', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inkwell-verify-'));
    cpSync(resolve('scripts'), join(dir, 'scripts'), { recursive: true });
    const env = { ...process.env };
    delete env.CLAUDE_PROJECT_DIR; // tree-hash would hash the real repo instead
    const r = spawnSync(process.execPath, [join(dir, 'scripts', 'verify.mjs')], { cwd: dir, env, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Run npm install first');
    expect(existsSync(join(dir, 'verify', 'out', 'typecheck.txt'))).toBe(false); // tsc never ran
  });
});
