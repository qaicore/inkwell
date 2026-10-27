import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Take } from '../../src/app/take.ts';
import { emptyTruth, serializeTruth, setRoot } from '../../src/app/truth.ts';
import { fixtureStatus, fixturesMiddleware, refusal, saveFixture, type Request, type Response } from '../../tools/fixtures-server.ts';

let root = '';
const entries = [
  { id: 'side-step', file: 'fixtures/side-step/clip.mp4', people: ['Qai'], consent: 'self' },
  { id: 'walk', file: 'fixtures/walking/clip.mp4', people: ['Qai'], consent: 'self' }, // names another folder
  { id: 'friend', file: 'fixtures/friend/clip.mp4', people: ['Qai', 'Sam'], consent: 'self' }, // Sam needs a dated consent
];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inkwell-fixtures-'));
  await mkdir(join(root, 'fixtures'));
  await writeFile(join(root, 'fixtures', 'clips.json'), JSON.stringify({ clips: entries }));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const truthBody = (clip: string) => Buffer.from(JSON.stringify(setRoot(emptyTruth(clip), 0, [512, 840])));
const sha = (data: string) => createHash('sha256').update(data).digest('hex');
const take = (clipBytes: string, source = 'phone file'): Take => ({
  source: { name: 'IMG_0412.MOV', bytes: source.length, sha256: sha(source) },
  sha256: sha(clipBytes),
  frames: 300,
  width: 1080,
  height: 1920,
});

describe('fixtures server: saving /label output', () => {
  it('writes a listed clip\'s truth.json in the §11 layout, and says whether its clip is there', async () => {
    const saved = await saveFixture(root, 'side-step', 'truth.json', truthBody('side-step'), false);
    expect(saved).toEqual({ status: 200, body: { path: 'fixtures/side-step/truth.json', clipSaved: false, warnings: [] } });
    const text = await readFile(join(root, 'fixtures', 'side-step', 'truth.json'), 'utf8');
    expect(text).toBe(serializeTruth(setRoot(emptyTruth('side-step'), 0, [512, 840])));
    expect((await fixtureStatus(root, 'side-step')).body).toMatchObject({ listed: true, problem: '', truth: true, clip: null });
  });

  it('refuses a clip with no clips.json entry for fixtures/<clip>/clip.mp4, and shows the entry to add', async () => {
    const entry = '{ "id": "probe", "file": "fixtures/probe/clip.mp4", "people": ["Qai"], "consent": "self" }';
    const missing = await saveFixture(root, 'probe', 'truth.json', truthBody('probe'), false);
    expect(missing.status).toBe(403);
    expect(String(missing.body.error)).toContain(entry);
    // "walk" is listed by id, but its entry names another file: R2 indexes clips by file.
    expect((await saveFixture(root, 'walk', 'truth.json', truthBody('walk'), false)).status).toBe(403);
    expect((await fixtureStatus(root, 'probe')).body).toMatchObject({ listed: false, entry, truth: false, clip: null });
  });

  it('refuses a listed clip whose consent R2 would reject', async () => {
    const saved = await saveFixture(root, 'friend', 'truth.json', truthBody('friend'), false);
    expect(saved.status).toBe(403);
    expect(String(saved.body.error)).toContain('consent says "self"');
  });

  it('replaces an existing file only when asked to', async () => {
    await saveFixture(root, 'side-step', 'clip.mp4', Buffer.from('first'), false);
    expect((await saveFixture(root, 'side-step', 'clip.mp4', Buffer.from('second'), false)).status).toBe(409);
    expect(await readFile(join(root, 'fixtures', 'side-step', 'clip.mp4'), 'utf8')).toBe('first');
    expect((await saveFixture(root, 'side-step', 'clip.mp4', Buffer.from('second'), true)).status).toBe(200);
    expect(await readFile(join(root, 'fixtures', 'side-step', 'clip.mp4'), 'utf8')).toBe('second');
  });

  it('reports the saved clip\'s hash and source, so the page can tell whether it is the open take', async () => {
    await saveFixture(root, 'side-step', 'clip.mp4', Buffer.from('converted'), false);
    expect((await fixtureStatus(root, 'side-step')).body.clip).toEqual({ bytes: 9, sha256: sha('converted'), take: null });
    expect((await saveFixture(root, 'side-step', 'source.json', Buffer.from(JSON.stringify(take('converted'))), false)).status).toBe(200);
    expect((await fixtureStatus(root, 'side-step')).body.clip).toEqual({ bytes: 9, sha256: sha('converted'), take: take('converted') });
    expect((await saveFixture(root, 'side-step', 'source.json', Buffer.from('{"source": {}}'), true)).status).toBe(400);
  });

  it('warns about marks off the §11 cadence without refusing them', async () => {
    const offCadence = Buffer.from(JSON.stringify(setRoot(emptyTruth('side-step'), 7, [1, 2])));
    const saved = await saveFixture(root, 'side-step', 'truth.json', offCadence, false);
    expect(saved.status).toBe(200);
    expect(saved.body.warnings).toEqual(['roots off every 10th frame: 7']);
  });

  it('refuses bad ids, other file names, bad labels and labels for another clip', async () => {
    expect((await saveFixture(root, '../side-step', 'truth.json', truthBody('side-step'), false)).status).toBe(400);
    expect((await saveFixture(root, 'side-step', 'notes.txt', Buffer.from('x'), false)).status).toBe(404);
    expect((await saveFixture(root, 'side-step', 'truth.json', Buffer.from('{'), false)).status).toBe(400);
    const wrongFps = Buffer.from(JSON.stringify({ ...emptyTruth('side-step'), fps: 24 }));
    expect((await saveFixture(root, 'side-step', 'truth.json', wrongFps, false)).body.error).toContain('"fps"');
    const other = await saveFixture(root, 'side-step', 'truth.json', truthBody('probe'), false);
    expect(other.status).toBe(400);
    expect(String(other.body.error)).toContain('"probe"');
  });

  it('leaves no .partial file behind when a write fails', async () => {
    // A folder where truth.json should be makes the rename fail.
    await mkdir(join(root, 'fixtures', 'side-step', 'truth.json'), { recursive: true });
    await expect(saveFixture(root, 'side-step', 'truth.json', truthBody('side-step'), true)).rejects.toThrow();
    expect(await readdir(join(root, 'fixtures', 'side-step'))).toEqual(['truth.json']);
  });
});

describe('fixtures server: who may save', () => {
  const request = (headers: Record<string, string>, remoteAddress: string) => ({ headers, socket: { remoteAddress } }) as unknown as Request;

  it('takes saves from this computer, and from other devices only with the run\'s token', () => {
    expect(refusal(request({ host: 'localhost:5174', origin: 'http://localhost:5174' }, '127.0.0.1'), 't0k')).toBe('');
    expect(refusal(request({ host: 'localhost:5174' }, '::1'), 't0k')).toBe('');
    expect(refusal(request({ host: '192.168.1.74:5175', origin: 'https://192.168.1.74:5175' }, '192.168.1.80'), 't0k')).toContain('?token=');
    expect(refusal(request({ host: '192.168.1.74:5175', 'x-inkwell-token': 't0k' }, '192.168.1.80'), 't0k')).toBe('');
  });

  it('refuses a post from another site\'s page, even on this computer', () => {
    expect(refusal(request({ host: 'localhost:5174', origin: 'https://example.com' }, '127.0.0.1'), 't0k')).toContain('example.com');
    expect(refusal(request({ host: 'localhost:5174', origin: 'null' }, '127.0.0.1'), 't0k')).not.toBe('');
  });
});

describe('fixtures server: the middleware answers everything', () => {
  // A request as connect hands it over: the /__fixtures/ prefix already stripped.
  function call(method: string, url: string, body = '', headers: Record<string, string> = {}) {
    const req = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), {
      method,
      url,
      headers: { host: 'localhost:5174', ...headers },
      socket: { remoteAddress: '127.0.0.1' },
    }) as unknown as Request;
    let status = 0;
    let text = '';
    const res = {
      set statusCode(code: number) {
        status = code;
      },
      setHeader() {},
      end(chunk: string) {
        text = chunk;
      },
    } as unknown as Response;
    return fixturesMiddleware(root, 't0k')(req, res).then(() => ({ status, body: JSON.parse(text) as Record<string, unknown> }));
  }

  it('answers a malformed address with 400 instead of throwing', async () => {
    expect((await call('GET', '/%E0/')).status).toBe(400);
    expect((await call('POST', '/%E0/truth.json', '{}')).status).toBe(400);
  });

  it('refuses a truth.json over 1 MB with 413', async () => {
    const big = JSON.stringify({ ...emptyTruth('side-step'), pad: 'x'.repeat(1024 * 1024) });
    expect((await call('POST', '/side-step/truth.json', big)).status).toBe(413);
  });

  it('saves through the middleware, and refuses a foreign origin there too', async () => {
    expect((await call('POST', '/side-step/truth.json', truthBody('side-step').toString())).status).toBe(200);
    expect((await call('POST', '/side-step/truth.json', '{}', { origin: 'https://example.com' })).status).toBe(403);
    expect((await call('GET', '/side-step/')).body).toMatchObject({ listed: true, truth: true });
  });
});
