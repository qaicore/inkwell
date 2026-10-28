// Dev only: the proxy's cache route, GET /api/cache/<clip sha256>/<file>,
// answered from fixtures/. A clip's folder is found by hash: the sha256 that
// its cached SAM runs and probe.json carry, or the phone file source.json
// says it was converted from. Only clips with consent in fixtures/clips.json
// are served (CLAUDE.md rule 7), and only sam-*.json and wonder-*.json.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { CACHE_FILE } from '../functions/_lib/proxy.ts';
import { consentProblem, parseClips } from './clips.ts';
import type { Request, Response } from './fixtures-server.ts';

const KEYED = ['probe.json', 'sam-person.json', 'source.json'];

// The fixtures folder for a clip hash, or null.
export async function clipDirFor(root: string, sha256: string): Promise<string | null> {
  const fixtures = join(root, 'fixtures');
  const clips = parseClips(await readFile(join(fixtures, 'clips.json'), 'utf8').then((t) => JSON.parse(t) as unknown, () => null));
  let names: string[];
  try {
    names = (await readdir(fixtures, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return null;
  }
  for (const name of names.sort()) {
    const entry = clips.get(`fixtures/${name}/clip.mp4`);
    if (!entry || consentProblem(entry)) continue;
    for (const file of KEYED) {
      const j = await readFile(join(fixtures, name, file), 'utf8').then((t) => JSON.parse(t) as Record<string, unknown>, () => null);
      const source = j?.source as { sha256?: unknown } | undefined;
      if (j && (j.clipSha256 === sha256 || j.sha256 === sha256 || source?.sha256 === sha256)) return join(fixtures, name);
    }
  }
  return null;
}

export async function cacheResponse(root: string, url: string): Promise<{ status: number; body: string }> {
  const m = /^\/?([0-9a-f]{64})\/([^/?]+)$/.exec(url.split('?')[0]);
  if (!m || !CACHE_FILE.test(m[2])) return { status: 404, body: '{"error":{"message":"Not a cache file."}}' };
  const dir = await clipDirFor(root, m[1]);
  const body = dir ? await readFile(join(dir, m[2]), 'utf8').catch(() => null) : null;
  return body === null ? { status: 404, body: '{"error":{"message":"Not cached."}}' } : { status: 200, body };
}

export function cacheServer(): Plugin {
  return {
    name: 'inkwell-cache',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/cache/', (req: Request, res: Response) => {
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.end('');
          return;
        }
        cacheResponse(server.config.root, req.url ?? '').then(
          ({ status, body }) => {
            res.statusCode = status;
            res.setHeader('Content-Type', 'application/json');
            res.end(body);
          },
          (err: unknown) => {
            res.statusCode = 500;
            res.end(String(err));
          },
        );
      });
    },
  };
}
