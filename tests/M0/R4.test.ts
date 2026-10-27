/// <reference types="node" />
// R4 (SPEC §10, rules): no network outside the allowed folders.
//   In code (src/, functions/, scripts/, tests/, .claude/hooks/), the API host appears only in src/sam,
//   src/plan, functions/ and the paid scripts folder under scripts/ (SPEC §6); docs may name it. Tests,
//   hooks and verify import none of those clients. Every search pattern here is built from pieces, so
//   this file doesn't match itself (and this comment avoids spelling the paid folder's path).
//
// Measured on every text file on disk in those folders (node_modules skipped), plus, as a stricter reading,
// tools/ and the repo-root code files (vite.config.ts, vitest.config.ts, index.html, package.json ...):
//   1. Host: the API host (also regex-escaped, any case) and the deployed proxy hosts (Cloudflare Pages
//      and Workers subdomains) appear only under src/sam/, src/plan/, functions/ and the paid folder.
//   2. Imports: starting from every code file in tests/ (golden excluded), .claude/hooks/, scripts/ outside
//      the paid folder (the verify pipeline, §6) and vitest.config.ts, follow relative imports transitively
//      (type-only imports included). Nothing reached may be in the paid folder; nothing reached under
//      src/sam/, src/plan/ or functions/ may name a host, use the global fetch or load a network library;
//      nothing reached anywhere may import the OpenAI SDK or a Node/npm network module.
//      (SPEC's X2 server test has to import the proxy, so a pure, injected-fetch module in functions/ is
//      allowed; the wiring file that passes the real fetch is not.)
//   3. Those entry files themselves make no network call (global fetch, XHR, sockets, command-line
//      downloaders, git network commands), never name the paid folder's path, and never spawn the paid
//      npm scripts.
//   4. package.json's verify, check:fast, test and golden:accept scripts never start the paid scripts.
// Each rule is first run on a planted mini-repo under verify/tmp/ to show it catches violations.
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Evidence, ROOT, slash } from '../helpers/evidence.ts';

const ID = 'R4';
const ev = new Evidence(ID, [
  'self-check on a planted repo',
  'this file does not match its own patterns',
  'host outside allowed folders',
  'tests/hooks/verify reach a network client',
  'network calls in tests/hooks/verify',
  'package.json scripts start paid calls',
]);
afterAll(() => ev.write());

// ---------- patterns, built from pieces ----------

const j = (...p: string[]) => p.join('');
const HOST = ['api', 'meta', 'ai'].join('.');
const dotted = (host: string) => host.split('.').map((w) => w.replace(/[-]/g, '\\-')).join(String.raw`\\?\.`);
const HOST_RE = new RegExp(dotted(HOST), 'i');
const PROXY_HOST_RE = new RegExp(String.raw`[\w-]\\?\.(?:${dotted(['pages', 'dev'].join('.'))}|${dotted(['workers', 'dev'].join('.'))})\b`, 'i');

const ALLOWED_PREFIXES = ['src/sam/', 'src/plan/', 'functions/', j('scripts', '/', 'live', '/')];
const PAID_PREFIX = j('scripts', '/', 'live', '/');
const CLIENT_PREFIXES = ['src/sam/', 'src/plan/', 'functions/'];

const FE = j('fe', 'tch');
const GLOBAL_CALL = new RegExp(String.raw`(?<![\w$.])${FE}\s*\(`);
const GLOBAL_REF = new RegExp(String.raw`\b(?:globalThis|window|self)\s*\.\s*${FE}\b`);
const VALUE_USE = new RegExp(String.raw`(?:[=:,(?]|\?\?|\|\|)\s*${FE}\s*[,;)}\n]|[{,]\s*${FE}\s*[,}]`);
const BROWSER_NET = new RegExp(String.raw`\b(?:${j('XMLHttp', 'Request')}|${j('Web', 'Socket')}|${j('Event', 'Source')}|${j('send', 'Beacon')})\b`);
const SHELL_NET = new RegExp(
  String.raw`\b(?:${j('cu', 'rl')}|${j('wg', 'et')}|${j('Invoke-Web', 'Request')}|${j('Invoke-Rest', 'Method')})\b|\b${j('gi', 't')}\s+(?:-c\s+\S+\s+)*(?:${j('fe', 'tch')}|${j('pu', 'll')}|${j('pu', 'sh')}|${j('clo', 'ne')}|${j('ls-', 'remote')})\b`,
  'i',
);
// The paid folder's path, anywhere in an entry file (an import or a spawn needs it).
const PAID_PATH = new RegExp(String.raw`${j('scripts', '[\\\\/]+', 'live')}\b`, 'i');
// The two paid npm scripts, by name (SPEC §4).
const PAID_NPM_NAME = String.raw`(?:${j('pro', 'be')}|${j('fixtures', ':', 'refresh')})`;
// Started from code: a child-process call followed within 300 characters by npm's "run" and a paid name,
// as one string or as array items. Report text that merely names the command doesn't count.
const PAID_SPAWN = new RegExp(
  String.raw`\b(?:${j('spa', 'wn')}|${j('spa', 'wnSync')}|${j('ex', 'ec')}|${j('ex', 'ecSync')}|${j('ex', 'ecFile')}|${j('ex', 'ecFileSync')}|${j('fo', 'rk')}|${j('Start-', 'Process')})\b[\s\S]{0,300}?\brun['"\x60,\s]+${PAID_NPM_NAME}(?![\w-])`,
  'i',
);
// Started from a package.json script: npm's "run" followed by a paid name.
const PAID_NPM_CMD = new RegExp(String.raw`\brun(?:\s+-\S+)*\s+${PAID_NPM_NAME}(?![\w-])`, 'i');
const NET_MODULES = [
  j('open', 'ai'), 'http', 'https', 'http2', 'net', 'tls', 'dgram', j('und', 'ici'), j('ax', 'ios'), j('node-', FE),
  'ws', 'got', j('super', 'agent'), j('cross-', FE), j('isomorphic-', FE),
];
const isNetModule = (spec: string) => {
  const s = spec.replace(/^node:/, '');
  return NET_MODULES.some((m) => s === m || s.startsWith(`${m}/`));
};

// Import specifiers. Each pattern needs the keyword right before the quote, so the strings in this file
// that only name modules don't count as imports.
const IMPORT_RES = [
  /\bimport\s+(?:type\s+)?[\w*${}\s,]*?\bfrom\s*['"]([^'"\n]+)['"]/g,
  /\bimport\s*['"]([^'"\n]+)['"]/g,
  /\bexport\s+(?:type\s+)?[\w*${}\s,]*?\bfrom\s*['"]([^'"\n]+)['"]/g,
  /\bimport\s*\(\s*['"`]([^'"`\n]+)['"`]/g,
  /\brequire\s*\(\s*['"`]([^'"`\n]+)['"`]\s*\)/g,
  /\b(?:vi|jest)\s*\.\s*(?:mock|doMock|importActual|importMock)\s*\(\s*['"`]([^'"`\n]+)['"`]/g,
];

const CODE_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const ROOT_CODE_EXTS = new Set([...CODE_EXTS, '.html', '.json']);
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.mp4', '.mov', '.webm', '.wav', '.mp3', '.woff', '.woff2',
  '.ttf', '.pdf', '.zip', '.gz', '.bin', '.tflite', '.task', '.onnx', '.wasm',
]);

// ---------- repo walking ----------

function walk(root: string, rel: string): string[] {
  const abs = join(root, rel);
  if (!existsSync(abs)) return [];
  const st = statSync(abs);
  if (!st.isDirectory()) return [rel];
  return readdirSync(abs)
    .filter((n) => n !== 'node_modules' && n !== '.git')
    .flatMap((n) => walk(root, rel ? `${rel}/${n}` : n));
}

function readTextFile(root: string, rel: string): string | null {
  if (BINARY_EXTS.has(extname(rel).toLowerCase())) return null;
  const buf = readFileSync(join(root, rel));
  if (buf.subarray(0, 8192).includes(0)) return null;
  return buf.toString('utf8');
}

interface Scope {
  scanned: string[]; // every code-ish file checked for hosts
  entries: string[]; // tests, hooks, verify scripts
}

function scope(root: string): Scope {
  const roots = ['src', 'functions', 'scripts', 'tests', '.claude/hooks', 'tools'];
  const inRoots = roots.flatMap((r) => walk(root, r)).filter((f) => !f.startsWith('tests/golden/'));
  const top = existsSync(root)
    ? readdirSync(root).filter((n) => {
        const st = statSync(join(root, n));
        return st.isFile() && ROOT_CODE_EXTS.has(extname(n).toLowerCase()) && n !== 'package-lock.json';
      })
    : [];
  const scanned = [...new Set([...inRoots, ...top])].sort();
  const isCode = (f: string) => CODE_EXTS.has(extname(f).toLowerCase());
  const entries = scanned.filter(
    (f) =>
      isCode(f) &&
      (f.startsWith('tests/') ||
        f.startsWith('.claude/hooks/') ||
        (f.startsWith('scripts/') && !f.startsWith(PAID_PREFIX)) ||
        f === 'vitest.config.ts'),
  );
  return { scanned, entries };
}

const allowedForHost = (rel: string) => ALLOWED_PREFIXES.some((p) => rel.startsWith(p));

function specifiers(text: string): string[] {
  const out: string[] = [];
  for (const re of IMPORT_RES) for (const m of text.matchAll(re)) if (m[1]) out.push(m[1]);
  return out;
}

function resolveLocal(root: string, fromRel: string, spec: string): string | null {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null;
  const base = spec.startsWith('/') ? join(root, spec) : resolve(dirname(join(root, fromRel)), spec);
  const cands = [
    base,
    ...[...CODE_EXTS].map((e) => base + e),
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.mjs$/, '.mts'),
    base.replace(/\.jsx$/, '.tsx'),
    ...[...CODE_EXTS].map((e) => join(base, `index${e}`)),
  ];
  const hit = cands.find((c) => existsSync(c) && statSync(c).isFile()) ?? base;
  return slash(relative(root, hit));
}

function networkMarkers(text: string): string[] {
  const m: string[] = [];
  if (HOST_RE.test(text) || PROXY_HOST_RE.test(text)) m.push('names an API or proxy host');
  if (GLOBAL_CALL.test(text) || GLOBAL_REF.test(text) || VALUE_USE.test(text)) m.push(`uses the global ${FE}`);
  if (BROWSER_NET.test(text)) m.push('uses a browser network API');
  if (specifiers(text).some(isNetModule)) m.push('imports a network library');
  return m;
}

// ---------- the four rules ----------

function hostViolations(root: string, s: Scope): string[] {
  const out: string[] = [];
  for (const f of s.scanned) {
    if (allowedForHost(f)) continue;
    const text = readTextFile(root, f);
    if (text === null) continue;
    text.split(/\r?\n/).forEach((line, i) => {
      if (HOST_RE.test(line)) out.push(`${f}:${i + 1} names the API host`);
      if (PROXY_HOST_RE.test(line)) out.push(`${f}:${i + 1} names a deployed proxy host`);
    });
  }
  return out;
}

function closureViolations(root: string, s: Scope): string[] {
  const out = new Set<string>();
  for (const entry of s.entries) {
    const seen = new Set<string>();
    const stack: [string, string[]][] = [[entry, [entry]]];
    while (stack.length) {
      const [file, chain] = stack.pop() as [string, string[]];
      if (seen.has(file)) continue;
      seen.add(file);
      const via = chain.join(' -> ');
      if (file !== entry && file.startsWith(PAID_PREFIX)) {
        out.add(`${via}: reaches a paid script`);
        continue;
      }
      const abs = join(root, file);
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        if (CLIENT_PREFIXES.some((p) => file.startsWith(p))) out.add(`${via}: imports a client path that doesn't exist yet`);
        continue;
      }
      const text = readTextFile(root, file);
      if (text === null) continue;
      if (file !== entry && CLIENT_PREFIXES.some((p) => file.startsWith(p))) {
        const marks = networkMarkers(text);
        if (marks.length) out.add(`${via}: reaches a network client (${marks.join(', ')})`);
      }
      for (const spec of specifiers(text)) {
        if (isNetModule(spec)) {
          out.add(`${via}: imports network library "${spec}"`);
          continue;
        }
        const next = resolveLocal(root, file, spec);
        if (next && !next.startsWith('..') && !next.includes('node_modules/')) stack.push([next, [...chain, next]]);
      }
    }
  }
  return [...out].sort();
}

function entryCallViolations(root: string, s: Scope): string[] {
  const out: string[] = [];
  for (const f of s.entries) {
    const text = readTextFile(root, f);
    if (text === null) continue;
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      const at = `${f}:${i + 1}`;
      if (GLOBAL_CALL.test(line) || GLOBAL_REF.test(line)) out.push(`${at} uses the global ${FE}`);
      if (BROWSER_NET.test(line)) out.push(`${at} uses a browser network API`);
      if (SHELL_NET.test(line)) out.push(`${at} runs a network command`);
      if (PAID_PATH.test(line)) out.push(`${at} names the paid scripts folder`);
    });
    const spawn = text.match(PAID_SPAWN);
    if (spawn && spawn.index !== undefined) {
      out.push(`${f}:${text.slice(0, spawn.index).split('\n').length} spawns a paid npm script`);
    }
  }
  return out;
}

function packageScriptViolations(root: string): string[] {
  const p = join(root, 'package.json');
  if (!existsSync(p)) return ['package.json missing'];
  const scripts = ((JSON.parse(readFileSync(p, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {});
  const out: string[] = [];
  for (const name of ['verify', 'check:fast', 'test', 'golden:accept', 'pretest', 'posttest', 'preverify', 'postverify']) {
    const cmd = scripts[name];
    if (typeof cmd === 'string' && (PAID_PATH.test(cmd) || PAID_NPM_CMD.test(cmd) || SHELL_NET.test(cmd))) {
      out.push(`package.json "${name}" starts a paid or network call`);
    }
  }
  return out;
}

// ---------- the tests ----------

describe('R4 no network outside the allowed folders', () => {
  it('R4 the rules catch planted violations in a mini-repo and pass its clean files', () => {
    mkdirSync(join(ROOT, 'verify', 'tmp'), { recursive: true });
    const dir = mkdtempSync(join(ROOT, 'verify', 'tmp', 'r4-'));
    const put = (rel: string, text: string) => {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    };
    const imp = j('im', 'port');
    const url = `https://${HOST}/v1`;
    try {
      put('package.json', JSON.stringify({ scripts: { verify: `node ${PAID_PREFIX}probe.mjs` } }));
      put('src/sam/client.ts', `export const base = '${url}';\nexport const call = () => ${FE}(base);\n`);
      put('src/sam/decode.ts', 'export const decode = (b: number[]) => b.map((x) => x > 0);\n');
      put('src/app/panel.ts', `${imp} { call } from '../sam/client.ts';\nexport const go = call;\n`);
      put('src/track/leak.ts', `export const u = '${url}';\n`);
      put('functions/_lib/pure.ts', `export const handle = (deps: { ${FE}: (r: Request) => Promise<Response> }) => deps.${FE};\n`);
      put('functions/api/wire.ts', `${imp} { handle } from '../_lib/pure.ts';\nexport const h = handle({ ${FE}: (r) => ${FE}(r) });\n`);
      put(`${PAID_PREFIX}probe.mjs`, `console.log('${url}');\n`);
      put('tests/A.test.ts', `${imp} { go } from '../src/app/panel.ts';\n`);
      put('tests/B.test.ts', `${imp} { decode } from '../src/sam/decode.ts';\n${imp} { handle } from '../functions/_lib/pure.ts';\n`);
      put('tests/C.test.ts', `${imp} OpenAI from '${j('open', 'ai')}';\nawait ${FE}('http://localhost/x');\n`);
      put('tests/D.test.ts', `${imp} { h } from '../functions/api/wire.ts';\n`);
      put('scripts/verify.mjs', `${imp} '../${PAID_PREFIX}probe.mjs';\n`);
      put('.claude/hooks/h.mjs', `spawnSync('${j('cu', 'rl')}', ['x']);\n`);
      put('.claude/hooks/g.mjs', `${j('spa', 'wnSync')}('npm', [\n  'run',\n  '${j('pro', 'be')}',\n]);\n`);
      put('scripts/report.mjs', `lines.push('Generated by \x60npm run ${j('pro', 'be')}\x60.');\n`);

      const s = scope(dir);
      const host = hostViolations(dir, s);
      const clos = closureViolations(dir, s);
      const calls = entryCallViolations(dir, s);
      const pkg = packageScriptViolations(dir);
      const has = (list: string[], frag: string) => list.some((l) => l.includes(frag));
      const expectations: [string, boolean][] = [
        ['host in src/track flagged', has(host, 'src/track/leak.ts:1')],
        ['host in src/sam allowed', !has(host, 'src/sam/client.ts')],
        ['host in paid script allowed', !has(host, `${PAID_PREFIX}probe.mjs`)],
        ['test reaching src/sam client through src/app flagged', has(clos, 'tests/A.test.ts -> src/app/panel.ts -> src/sam/client.ts')],
        ['test importing pure src/sam and injected-fetch functions module allowed', !clos.some((l) => l.startsWith('tests/B.test.ts'))],
        ['test importing the OpenAI SDK flagged', has(clos, 'tests/C.test.ts: imports network library')],
        ['test reaching the fetch-wiring functions file flagged', has(clos, 'tests/D.test.ts -> functions/api/wire.ts')],
        ['verify script importing a paid script flagged', has(clos, 'scripts/verify.mjs -> ')],
        [`global ${FE} in a test flagged`, has(calls, 'tests/C.test.ts:2')],
        ['shell network command in a hook flagged', has(calls, '.claude/hooks/h.mjs:1')],
        ['paid path in a verify script flagged', has(calls, 'scripts/verify.mjs:1')],
        ['hook spawning a paid npm script (array form, over lines) flagged', has(calls, '.claude/hooks/g.mjs:1 spawns')],
        ['report text naming the paid npm script allowed', !has(calls, 'scripts/report.mjs')],
        ['package.json verify starting a paid script flagged', pkg.length === 1],
      ];
      const failed = expectations.filter(([, ok]) => !ok).map(([n]) => n);
      ev.record('self-check on a planted repo', { failed }, [], failed.length === 0,
        failed.length ? `host=${JSON.stringify(host)} closure=${JSON.stringify(clos)} calls=${JSON.stringify(calls)}` : '');
      expect(failed, 'R4 self-check: a planted case was misjudged').toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('R4 this test file does not match its own host patterns', () => {
    const own = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const ok = !HOST_RE.test(own) && !PROXY_HOST_RE.test(own) && HOST_RE.test(`https://${HOST}/v1`);
    ev.record('this file does not match its own patterns', ok, true, ok);
    expect(ok, 'the R4 test file matches its own host pattern, or the pattern misses the host').toBe(true);
  });

  it('R4 the API host and proxy hosts appear in code only under src/sam, src/plan, functions/ and the paid scripts folder', () => {
    const s = scope(ROOT);
    const bad = hostViolations(ROOT, s);
    ev.record('host outside allowed folders', { filesScanned: s.scanned.length, violations: bad }, [], bad.length === 0);
    expect(bad, `host named outside the allowed folders:\n${bad.join('\n')}`).toEqual([]);
  });

  it('R4 tests, hooks and verify scripts reach no network client through their imports', () => {
    const s = scope(ROOT);
    const bad = closureViolations(ROOT, s);
    ev.record('tests/hooks/verify reach a network client', { entries: s.entries.length, violations: bad }, [], bad.length === 0);
    expect(bad, `network clients reachable from tests, hooks or verify:\n${bad.join('\n')}`).toEqual([]);
  });

  it('R4 tests, hooks and verify scripts make no network call and never start the paid scripts', () => {
    const s = scope(ROOT);
    const bad = entryCallViolations(ROOT, s);
    ev.record('network calls in tests/hooks/verify', { entries: s.entries.length, violations: bad }, [], bad.length === 0);
    expect(bad, `network calls in tests, hooks or verify:\n${bad.join('\n')}`).toEqual([]);
    const pkg = packageScriptViolations(ROOT);
    ev.record('package.json scripts start paid calls', pkg, [], pkg.length === 0);
    expect(pkg, pkg.join('\n')).toEqual([]);
  });
});
