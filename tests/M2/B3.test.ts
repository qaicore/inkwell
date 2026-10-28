/// <reference types="node" />
// B3 (SPEC §10, brushes): Qai's look. One approved golden per brush in tests/golden/brushes/ (L1 holds them after
// that).
//
// Brush ids are read from docs/SPEC.md §7 (`type BrushId = ...`) at runtime, not from the implementation.
// For each id: tests/golden/brushes/<id>.png exists and is a PNG; it's tracked by git with no uncommitted changes;
// and the last commit that touched it carries [qai-approved] (only Qai writes that token, §2), which is what makes it
// approved. Nothing else sits in tests/golden/brushes/ (one golden per brush, none for brushes that don't exist).
// Stricter readings, flagged for Qai:
//   - the file name is the brush id (<id>.png); golden:accept takes milestone ids today, so the builder extends it;
//   - "approved" is checked on the latest commit touching each file, so a later unapproved edit fails.
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Evidence, ROOT, git, readText } from '../helpers/evidence.ts';
import { pngSize } from '../helpers/engine.ts';

const ID = 'B3';
const DIR = 'tests/golden/brushes';
const TOKEN = '[qai-approved]';

function specBrushIds(): string[] {
  const spec = readText(join(ROOT, 'docs', 'SPEC.md'));
  const m = spec.match(/type\s+BrushId\s*=\s*([^;]+);/);
  if (!m) throw new Error('docs/SPEC.md §7 has no "type BrushId = ..." line');
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}
const BRUSHES = specBrushIds();

const ev = new Evidence(ID, [...BRUSHES.map((b) => `golden: ${b}`), 'one golden per brush, nothing else']);
afterAll(() => ev.write());

describe('B3 one approved golden per brush', () => {
  for (const brush of BRUSHES) {
    it(`B3 ${brush}: an approved golden in ${DIR}/`, () => {
      const rel = `${DIR}/${brush}.png`;
      const problems: string[] = [];
      let size: { width: number; height: number } | null = null;
      if (!existsSync(join(ROOT, rel))) {
        problems.push(`${rel} missing: Qai approves the ${brush} brush's look and commits its golden himself with ${TOKEN} (SPEC §3 Thu, §4 step 7)`);
      } else {
        size = pngSize(readFileSync(join(ROOT, rel)));
        if (!size) problems.push(`${rel} is not a PNG`);
        const tracked = git(['ls-files', '--error-unmatch', '--', rel]);
        if (tracked.status !== 0) problems.push(`${rel} is not committed`);
        const dirty = git(['status', '--porcelain', '--', rel]).stdout.trim();
        if (dirty) problems.push(`${rel} has uncommitted changes (${dirty})`);
        const msg = git(['log', '-1', '--format=%H%n%B', '--', rel]).stdout;
        if (tracked.status === 0 && !msg.includes(TOKEN)) problems.push(`the last commit touching ${rel} (${msg.split('\n')[0]?.slice(0, 10)}) has no ${TOKEN}`);
      }
      ev.record(`golden: ${brush}`, problems.length ? problems : { file: rel, size }, `${rel}: a PNG, committed with ${TOKEN}, unchanged since`, problems.length === 0);
      expect(problems, `B3 ${brush}`).toEqual([]);
    });
  }

  it('B3 nothing but one golden per brush', () => {
    const files = existsSync(join(ROOT, DIR)) ? readdirSync(join(ROOT, DIR)) : [];
    const extra = files.filter((f) => !BRUSHES.some((b) => f === `${b}.png`));
    const missing = BRUSHES.filter((b) => !files.includes(`${b}.png`));
    const ok = BRUSHES.length > 0 && extra.length === 0 && missing.length === 0;
    ev.record('one golden per brush, nothing else', { files, missing, extra }, `exactly ${BRUSHES.map((b) => `${b}.png`).join(', ')}`, ok,
      missing.length ? `missing: ${missing.join(', ')}` : extra.length ? `not a brush golden: ${extra.join(', ')}` : '');
    expect(ok, `B3 ${DIR}: missing ${JSON.stringify(missing)}, extra ${JSON.stringify(extra)}`).toBe(true);
  });
});
