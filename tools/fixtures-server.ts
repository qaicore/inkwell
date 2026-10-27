import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { validateTake, type SavedClip } from '../src/app/take.ts';
import { CLIP_ID, serializeTruth, truthWarnings, validateTruth } from '../src/app/truth.ts';
import { consentProblem, entryFor, parseClips } from './clips.ts';
import { readBody, TooLarge } from './standin-server.ts';

// Dev only: the /label page saves what Qai marks into fixtures/<clip>/.
//   GET  /__fixtures/<clip>/              is the clip listed, and what's saved already
//   POST /__fixtures/<clip>/clip.mp4      the converted clip, so the frames he labeled are SAM's frames
//   POST /__fixtures/<clip>/source.json   which file that clip was converted from (src/app/take.ts)
//   POST /__fixtures/<clip>/truth.json    the labels (checked, then rewritten in the §11 layout)
// Only clips whose fixtures/clips.json entry names fixtures/<clip>/clip.mp4 and
// notes consent are accepted (CLAUDE.md rule 7, the rule R2 checks). An
// existing file is replaced only with `x-overwrite: 1`, which the page sends
// after asking him.
//
// Who may save: the request must come from this dev server's own pages (an
// Origin header naming another site is refused, so no other page in his
// browser can post here), and from this computer or with this run's token.
// Phone mode serves the whole Wi-Fi; the token is only in the /label link
// printed in the terminal, so only someone who can see the terminal can save
// from another device.

export type SaveResult = { status: number; body: Record<string, unknown> };

// The parts of Node's request and response this uses, written out so the
// tests that import this file never reach Node's network modules (R4).
export type Request = AsyncIterable<unknown> & {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  socket: { remoteAddress?: string };
};
export type Response = { statusCode: number; setHeader(name: string, value: string): unknown; end(body: string): unknown };

const JSON_FILES = new Set(['truth.json', 'source.json']);
const JSON_LIMIT = 1024 * 1024; // truth.json for a 15 s clip is about 10 KB
const CLIP_LIMIT = 300 * 1024 * 1024;

export async function saveFixture(root: string, clip: string, file: string, body: Buffer, overwrite: boolean): Promise<SaveResult> {
  if (!CLIP_ID.test(clip)) return fail(400, `"${clip}" isn't a clip id: use lowercase words joined by hyphens, like side-step`);
  if (file !== 'clip.mp4' && !JSON_FILES.has(file)) return fail(404, `only clip.mp4, source.json and truth.json can be saved here`);
  const problem = await entryProblem(root, clip);
  if (problem) return fail(403, `${problem}. Add or fix its entry in fixtures/clips.json first; for a clip of you alone: ${entryFor(clip)}`);

  let data: Buffer = body;
  let warnings: string[] = [];
  if (JSON_FILES.has(file)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      return fail(400, `that ${file} is not valid JSON`);
    }
    if (file === 'truth.json') {
      const checked = validateTruth(parsed);
      if ('problems' in checked) return fail(400, checked.problems.join('; '));
      if (checked.truth.clip !== clip) return fail(400, `the labels say "${checked.truth.clip}" but are being saved as "${clip}"`);
      data = Buffer.from(serializeTruth(checked.truth));
      warnings = truthWarnings(checked.truth);
    } else {
      const take = validateTake(parsed);
      if (!take) return fail(400, 'source.json must say which file the clip was converted from (src/app/take.ts)');
      data = Buffer.from(`${JSON.stringify(take, null, 2)}\n`);
    }
  }

  const dir = join(root, 'fixtures', clip);
  const path = join(dir, file);
  if (!overwrite && (await exists(path))) return fail(409, `fixtures/${clip}/${file} already exists`);
  await mkdir(dir, { recursive: true });
  // Written next to the target and renamed over it, so a failed write never
  // leaves half a file where the tests will read it, nor a stray .partial.
  const partial = `${path}.partial`;
  try {
    await writeFile(partial, data);
    await rename(partial, path);
  } catch (err) {
    await rm(partial, { force: true });
    throw err;
  }
  return { status: 200, body: { path: `fixtures/${clip}/${file}`, clipSaved: await exists(join(dir, 'clip.mp4')), warnings } };
}

// What the page needs before it saves or loads: is the clip listed, and
// what's saved already (the clip's hash and source, so the page can tell
// whether it's the take that's open).
export async function fixtureStatus(root: string, clip: string): Promise<SaveResult> {
  if (!CLIP_ID.test(clip)) return fail(400, `"${clip}" isn't a clip id`);
  const dir = join(root, 'fixtures', clip);
  const problem = await entryProblem(root, clip);
  return {
    status: 200,
    body: {
      listed: problem === '',
      problem,
      entry: entryFor(clip),
      truth: await exists(join(dir, 'truth.json')),
      clip: await savedClip(dir),
    },
  };
}

// '' when this request may save; otherwise why not.
export function refusal(req: Pick<Request, 'headers' | 'socket'>, token: string): string {
  const origin = req.headers.origin;
  if (typeof origin === 'string') {
    let host = '';
    try {
      host = new URL(origin).host;
    } catch {
      // "null" or junk: not one of this server's pages
    }
    if (host !== req.headers.host) return `saves are only accepted from this dev server's own pages, not from ${origin}`;
  }
  if (isLoopback(req.socket.remoteAddress)) return '';
  if (req.headers['x-inkwell-token'] === token) return '';
  return 'saving from another device needs the /label link with ?token= that the dev server printed in its terminal';
}

// The /__fixtures/ handler. Every outcome, malformed addresses and failed
// writes included, is answered here: nothing is left to reject, which would
// take the whole dev server down.
export function fixturesMiddleware(root: string, token: string) {
  return async (req: Request, res: Response) => {
    let result: SaveResult;
    try {
      result = await handle(root, token, req);
    } catch (err) {
      result = err instanceof TooLarge ? fail(413, err.message) : fail(500, String(err));
    }
    res.statusCode = result.status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result.body));
  };
}

async function handle(root: string, token: string, req: Request): Promise<SaveResult> {
  let parts: string[];
  try {
    parts = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\//, '').split('/');
  } catch {
    return fail(400, `${req.url} isn't a valid address`);
  }
  const [clip = '', file = ''] = parts;
  if (req.method === 'GET' && file === '') return fixtureStatus(root, clip);
  if (req.method !== 'POST') return fail(405, 'GET /__fixtures/<clip>/ or POST /__fixtures/<clip>/<file>');
  const denied = refusal(req, token);
  if (denied) return fail(403, denied);
  const body = await readBody(req, file === 'clip.mp4' ? CLIP_LIMIT : JSON_LIMIT);
  return saveFixture(root, clip, file, body, req.headers['x-overwrite'] === '1');
}

export function fixturesServer(): Plugin {
  const token = randomBytes(16).toString('hex');
  return {
    name: 'inkwell-fixtures',
    apply: 'serve',
    configureServer(server) {
      const root = server.config.root;
      // /label is the page in label/index.html.
      server.middlewares.use((req, _res, next) => {
        if (req.url === '/label' || req.url?.startsWith('/label?')) req.url = req.url.replace('/label', '/label/');
        next();
      });
      server.middlewares.use('/__fixtures/', fixturesMiddleware(root, token));
      // Other devices (phone mode) save through this link only.
      const printUrls = server.printUrls.bind(server);
      server.printUrls = () => {
        printUrls();
        for (const url of server.resolvedUrls?.network ?? []) server.config.logger.info(`  ➜  Label:   ${url}label?token=${token}`);
      };
    },
  };
}

// '' when clips.json has an entry for fixtures/<clip>/clip.mp4 with consent noted.
async function entryProblem(root: string, clip: string): Promise<string> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(join(root, 'fixtures', 'clips.json'), 'utf8'));
  } catch {
    return 'fixtures/clips.json is missing or not valid JSON';
  }
  const entry = parseClips(json).get(`fixtures/${clip}/clip.mp4`);
  if (!entry) return `"${clip}" isn't in fixtures/clips.json yet (no entry with "file": "fixtures/${clip}/clip.mp4")`;
  return consentProblem(entry);
}

async function savedClip(dir: string): Promise<SavedClip | null> {
  const path = join(dir, 'clip.mp4');
  if (!(await exists(path))) return null;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  let take = null;
  try {
    take = validateTake(JSON.parse(await readFile(join(dir, 'source.json'), 'utf8')));
  } catch {
    // no source.json: the page can't tell which take this is
  }
  return { bytes: (await stat(path)).size, sha256: hash.digest('hex'), take };
}

const isLoopback = (address: string | undefined) => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function fail(status: number, error: string): SaveResult {
  return { status, body: { error } };
}
