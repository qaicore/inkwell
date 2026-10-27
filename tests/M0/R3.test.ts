/// <reference types="node" />
// R3 (SPEC §10, rules): the README section "Built Oct 26 – Nov 4" is present and matches package.json.
// What the section must hold (SPEC §2.6 and M0 checklist item 7): Meta's models (SAM 3.1 and Muse Wonder);
// the open-source libraries from package.json, kept current whenever package.json changes; and the fact
// that the code was written with Claude Code under Qai's direction. It separates the three.
//
// Measured, reading README.md and package.json at runtime:
//   1. a heading with exactly that title (en dash, as SPEC writes it);
//   2. the section has an open-source libraries part (a list item or sub-heading containing
//      "open-source libraries"), and every package in dependencies, devDependencies, optionalDependencies
//      and peerDependencies is named in it, in visible text (link targets and URLs don't count);
//   3. "matches" both ways: every library the part names (link texts and @scope/name tokens) is in
//      package.json, so a removed package can't linger;
//   4. outside the libraries part, the section names SAM 3.1 and Muse Wonder, and says the code was
//      "written with Claude Code under Qai's direction".
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Evidence, ROOT } from '../helpers/evidence.ts';

const ID = 'R3';
const TITLE = 'Built Oct 26 – Nov 4';
const ev = new Evidence(ID, [
  'parser self-check',
  'section present',
  'libraries part present',
  'package.json packages missing from the README',
  'README libraries not in package.json',
  'models and Claude Code credit',
]);
afterAll(() => ev.write());

// ---------- parsing ----------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function section(readme: string): string[] | null {
  const lines = readme.split(/\r?\n/);
  const head = new RegExp(`^(#{1,6})\\s+${escapeRe(TITLE)}\\s*#*\\s*$`);
  const i = lines.findIndex((l) => head.test(l));
  if (i < 0) return null;
  const level = (lines[i]?.match(/^#+/)?.[0] ?? '#').length;
  const out: string[] = [];
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j] ?? '';
    const h = l.match(/^(#{1,6})\s/);
    if (h && (h[1] ?? '').length <= level) break;
    out.push(l);
  }
  return out;
}

const indent = (s: string) => (s.match(/^\s*/)?.[0] ?? '').replace(/\t/g, '    ').length;

/** The lines of the open-source libraries part, and the rest of the section. */
function librariesPart(lines: string[]): { libs: string[]; rest: string[] } | null {
  const i = lines.findIndex((l) => /open[- ]source librar/i.test(l));
  if (i < 0) return null;
  const head = lines[i] ?? '';
  const isHeading = /^#{1,6}\s/.test(head);
  const libs = [head];
  let j = i + 1;
  for (; j < lines.length; j++) {
    const l = lines[j] ?? '';
    if (isHeading) {
      if (/^#{1,6}\s/.test(l)) break;
    } else if (l.trim() !== '' && indent(l) <= indent(head)) {
      break;
    }
    libs.push(l);
  }
  return { libs, rest: [...lines.slice(0, i), ...lines.slice(j)] };
}

/** Visible text: link targets, autolinks and bare URLs removed. */
function visible(text: string): string {
  return text
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/<https?:\/\/[^>]*>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ');
}

/** Regex naming a package: its words in order, with flexible separators, whole-word. */
function nameRe(pkg: string): RegExp {
  const words = pkg.replace(/^@/, '').split(/[/\-_.]+/).filter(Boolean).map(escapeRe);
  return new RegExp(`(?<![\\w@/.-])@?${words.join('[\\s\\-_/.]*')}(?![\\w/-])`, 'i');
}

function packages(pkgJson: Record<string, unknown>): string[] {
  const names = new Set<string>();
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const deps = pkgJson[field];
    if (deps && typeof deps === 'object') for (const n of Object.keys(deps)) names.add(n);
  }
  return [...names].sort();
}

/** Libraries the part names: markdown link texts and @scope/name tokens. */
function namedLibraries(libText: string): string[] {
  const links = [...libText.matchAll(/\[([^\]]+)\]\([^)]*\)/g)].map((m) => (m[1] ?? '').trim());
  const scoped = [...visible(libText).matchAll(/(?<![\w])@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*/gi)].map((m) => m[0]);
  return [...new Set([...links, ...scoped])];
}

interface Result {
  hasSection: boolean;
  hasLibs: boolean;
  missing: string[];
  extra: string[];
  credit: string[];
}

function check(readme: string, pkgJson: Record<string, unknown>): Result {
  const sec = section(readme);
  if (!sec) return { hasSection: false, hasLibs: false, missing: packages(pkgJson), extra: [], credit: ['no section'] };
  const parts = librariesPart(sec);
  if (!parts) return { hasSection: true, hasLibs: false, missing: packages(pkgJson), extra: [], credit: ['no libraries part'] };
  const libText = parts.libs.join('\n');
  const libVisible = visible(libText);
  const pkgs = packages(pkgJson);
  const missing = pkgs.filter((p) => !nameRe(p).test(libVisible));
  const extra = namedLibraries(libText).filter((n) => !pkgs.some((p) => nameRe(p).test(n)));
  const rest = visible(parts.rest.join('\n'));
  const credit: string[] = [];
  if (!/SAM 3\.1/.test(rest)) credit.push('SAM 3.1 not named outside the libraries part');
  if (!/Muse Wonder/.test(rest)) credit.push('Muse Wonder not named outside the libraries part');
  if (!/written with Claude Code under Qai['’]s direction/i.test(rest.replace(/\s+/g, ' '))) {
    credit.push(`no "written with Claude Code under Qai's direction"`);
  }
  return { hasSection: true, hasLibs: true, missing, extra, credit };
}

function readOrFail(rel: string): string {
  const p = join(ROOT, rel);
  if (!existsSync(p)) throw new Error(`${rel} missing`);
  return readFileSync(p, 'utf8');
}

// ---------- the tests ----------

describe(`R3 README "${TITLE}" matches package.json`, () => {
  it('R3 the parser catches a missing package, a stale library and a missing credit', () => {
    const pkg = { dependencies: { 'perfect-freehand': '1', mediabunny: '1' }, devDependencies: { vite: '1', '@types/node': '1' } };
    const good = [
      '# X', '', `## ${TITLE}`, '',
      '- **Meta models:** SAM 3.1 and Muse Wonder.',
      '- **Open-source libraries** (from `package.json`):',
      '  - [perfect-freehand](https://x.test/pf) (MIT), [Mediabunny](https://mediabunny.dev)',
      '  - Dev: [Vite](https://vite.dev), @types/node',
      "- **Code:** written with Claude Code under Qai's direction.",
      '', '## Next',
    ].join('\n');
    const noVite = good.replace('[Vite](https://vite.dev), ', '').replace('Dev: ', 'Dev: [Vitest](https://vite.dev), ');
    const stale = good.replace('@types/node', '@types/node, [Lodash](https://lodash.com)');
    const urlOnly = good.replace('[Mediabunny](https://mediabunny.dev)', '[the codec](https://mediabunny.dev)');
    const noCredit = good.replace("under Qai's direction", 'by a team');
    const enDash = good.replace(TITLE, 'Built Oct 26 - Nov 4');
    const r = {
      good: check(good, pkg),
      noVite: check(noVite, pkg),
      stale: check(stale, pkg),
      urlOnly: check(urlOnly, pkg),
      noCredit: check(noCredit, pkg),
      enDash: check(enDash, pkg),
    };
    const ok =
      r.good.hasSection && r.good.hasLibs && r.good.missing.length === 0 && r.good.extra.length === 0 && r.good.credit.length === 0 &&
      r.noVite.missing.join() === 'vite' && r.noVite.extra.join() === 'Vitest' &&
      r.stale.extra.join() === 'Lodash' &&
      r.urlOnly.missing.join() === 'mediabunny' &&
      r.noCredit.credit.length === 1 &&
      !r.enDash.hasSection;
    ev.record('parser self-check', ok ? 'all planted cases caught' : r, 'all planted cases caught', ok);
    expect(ok, `R3 parser self-check failed: ${JSON.stringify(r)}`).toBe(true);
  });

  it(`R3 README.md has the "${TITLE}" section, its library list matches package.json both ways, and it credits the models and Claude Code`, () => {
    const readme = readOrFail('README.md');
    const pkgJson = JSON.parse(readOrFail('package.json')) as Record<string, unknown>;
    const r = check(readme, pkgJson);
    ev.record('section present', r.hasSection, `a heading "${TITLE}" in README.md`, r.hasSection);
    ev.record('libraries part present', r.hasLibs, 'a list item or sub-heading "Open-source libraries" in the section', r.hasLibs);
    ev.record('package.json packages missing from the README', r.missing, [], r.missing.length === 0,
      r.missing.length ? `add to the libraries list: ${r.missing.join(', ')}` : '');
    ev.record('README libraries not in package.json', r.extra, [], r.extra.length === 0,
      r.extra.length ? `listed but not in package.json: ${r.extra.join(', ')}` : '');
    ev.record('models and Claude Code credit', r.credit, [], r.credit.length === 0);
    expect(r.hasSection, `README.md has no "## ${TITLE}" heading`).toBe(true);
    expect(r.hasLibs, `the "${TITLE}" section has no open-source libraries part`).toBe(true);
    expect(r.missing, `package.json packages not named in the README libraries list: ${r.missing.join(', ')}`).toEqual([]);
    expect(r.extra, `README lists libraries that aren't in package.json: ${r.extra.join(', ')}`).toEqual([]);
    expect(r.credit, r.credit.join('; ')).toEqual([]);
  });
});
