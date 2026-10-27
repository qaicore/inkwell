import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { CLIP_ID, serializeTruth, validateTruth } from '../src/app/truth.ts';
import { readBody } from './standin-server.ts';

// Dev only: the /label page saves what Qai marks into fixtures/<clip>/.
//   POST /__fixtures/<clip>/truth.json   the labels (checked, then rewritten in the §11 layout)
//   POST /__fixtures/<clip>/clip.mp4     the converted clip, so the frames he labeled are SAM's frames
// Only clips listed in fixtures/clips.json are accepted (consent, CLAUDE.md
// rule 7). An existing file is replaced only when the request says so with
// `x-overwrite: 1`, which the page sends after asking him.

export type SaveResult = { status: number; body: Record<string, unknown> };

const FILES = new Set(['truth.json', 'clip.mp4']);

export async function saveFixture(root: string, clip: string, file: string, body: Buffer, overwrite: boolean): Promise<SaveResult> {
  if (!CLIP_ID.test(clip)) return fail(400, `"${clip}" isn't a clip id: use lowercase words joined by hyphens, like side-step`);
  if (!FILES.has(file)) return fail(404, `only truth.json and clip.mp4 can be saved here`);
  const listed = await listedClips(root);
  if (!listed.includes(clip)) {
    return fail(403, `"${clip}" isn't in fixtures/clips.json yet. Add its entry there (who's in it, and their consent) before saving its fixtures.`);
  }

  let data: Buffer = body;
  if (file === 'truth.json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      return fail(400, 'that truth.json is not valid JSON');
    }
    const checked = validateTruth(parsed);
    if ('problems' in checked) return fail(400, checked.problems.join('; '));
    if (checked.truth.clip !== clip) return fail(400, `the labels say "${checked.truth.clip}" but are being saved as "${clip}"`);
    data = Buffer.from(serializeTruth(checked.truth));
  }

  const dir = join(root, 'fixtures', clip);
  const path = join(dir, file);
  if (!overwrite && (await exists(path))) return fail(409, `fixtures/${clip}/${file} already exists`);
  await mkdir(dir, { recursive: true });
  // Written next to the target and renamed over it, so a failed write never
  // leaves half a file where the tests will read it.
  const partial = `${path}.partial`;
  await writeFile(partial, data);
  await rename(partial, path);
  return { status: 200, body: { path: `fixtures/${clip}/${file}`, clipSaved: await exists(join(dir, 'clip.mp4')) } };
}

// What the page needs before it saves: is the clip listed, and what's already there.
export async function fixtureStatus(root: string, clip: string): Promise<SaveResult> {
  if (!CLIP_ID.test(clip)) return fail(400, `"${clip}" isn't a clip id`);
  const dir = join(root, 'fixtures', clip);
  return {
    status: 200,
    body: {
      listed: (await listedClips(root)).includes(clip),
      truth: await exists(join(dir, 'truth.json')),
      clip: await exists(join(dir, 'clip.mp4')),
    },
  };
}

export function fixturesServer(): Plugin {
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
      server.middlewares.use('/__fixtures/', async (req, res) => {
        const [clip = '', file = ''] = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\//, '').split('/');
        try {
          const result =
            req.method === 'GET' && file === ''
              ? await fixtureStatus(root, clip)
              : req.method === 'POST'
                ? await saveFixture(root, clip, file, await readBody(req), req.headers['x-overwrite'] === '1')
                : fail(405, 'GET /__fixtures/<clip>/ or POST /__fixtures/<clip>/<file>');
          res.statusCode = result.status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result.body));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    },
  };
}

async function listedClips(root: string): Promise<string[]> {
  try {
    const list = JSON.parse(await readFile(join(root, 'fixtures', 'clips.json'), 'utf8')) as { clips?: { id?: unknown }[] };
    return (list.clips ?? []).map((c) => c.id).filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

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
