import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Each case is a throwaway git repo with its own .env; the script runs with
// that repo as its working directory. The fake key is made up for the test.
const script = resolve('scripts/scan-secrets.mjs');
const FAKE_KEY = 'fake-key-0123456789abcdef';
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

function repo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'inkwell-scan-'));
  const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, env: gitEnv, encoding: 'utf8' });
  git('init', '-q');
  writeFileSync(join(dir, '.gitignore'), '.env\n.dev.vars\n');
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const scan = () => spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
  const commit = (message: string) => {
    git('add', '-A');
    git('commit', '-q', '-m', message);
  };
  return { dir, scan, commit };
}

describe('scan-secrets', () => {
  it('passes a repo where no secret appears', () => {
    const r = repo({ '.env': `META_API_KEY="${FAKE_KEY}"\nDAILY_SPEND_CAP_USD=5\n`, 'a.txt': 'nothing here\n' });
    r.commit('clean');
    const out = r.scan();
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('META_API_KEY');
  });

  it('finds a leak in a file and in history, naming the variable but never the value', () => {
    const r = repo({ '.dev.vars': `META_API_KEY=${FAKE_KEY}\n`, 'a.txt': `one\nkey ${FAKE_KEY}\n` });
    r.commit('leak');
    let out = r.scan();
    expect(out.status).toBe(1);
    expect(out.stdout).toMatch(/a\.txt:2 META_API_KEY/);
    expect(out.stdout).toMatch(/history [0-9a-f]{7} a\.txt:2 META_API_KEY/);
    expect(out.stdout + out.stderr).not.toContain(FAKE_KEY);

    writeFileSync(join(r.dir, 'a.txt'), 'one\n');
    r.commit('remove it');
    out = r.scan();
    expect(out.status).toBe(1); // still in history
    expect(out.stdout).not.toMatch(/^ {2}a\.txt:/m);
    expect(out.stdout + out.stderr).not.toContain(FAKE_KEY);
  });

  it('catches a leak before it is committed', () => {
    const r = repo({ '.env': `PROXY_PASSCODE=long-enough-passcode\n` });
    r.commit('start');
    writeFileSync(join(r.dir, 'notes.md'), 'passcode: long-enough-passcode\n');
    const out = r.scan();
    expect(out.status).toBe(1);
    expect(out.stdout).toContain('notes.md:1 PROXY_PASSCODE');
  });

  it('fails on a secret too short to scan for', () => {
    const r = repo({ '.env': 'PROXY_PASSCODE=1234\n' });
    r.commit('start');
    const out = r.scan();
    expect(out.status).toBe(1);
    expect(out.stdout).toContain('PROXY_PASSCODE');
  });

  it('has nothing to do without .env or .dev.vars', () => {
    const r = repo({ 'a.txt': 'x\n' });
    r.commit('start');
    expect(r.scan().status).toBe(0);
  });
});
