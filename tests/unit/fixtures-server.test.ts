import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyTruth, serializeTruth, setRoot } from '../../src/app/truth.ts';
import { fixtureStatus, saveFixture } from '../../tools/fixtures-server.ts';

let root = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inkwell-fixtures-'));
  await mkdir(join(root, 'fixtures'));
  const clips = { clips: [{ id: 'side-step', file: 'fixtures/side-step/clip.mp4', people: ['Qai'], consent: 'self' }] };
  await writeFile(join(root, 'fixtures', 'clips.json'), JSON.stringify(clips));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const truthBody = (clip: string) => Buffer.from(JSON.stringify(setRoot(emptyTruth(clip), 0, [512, 840])));

describe('fixtures server: saving /label output', () => {
  it('writes a listed clip\'s truth.json in the §11 layout, and says whether its clip is there', async () => {
    const saved = await saveFixture(root, 'side-step', 'truth.json', truthBody('side-step'), false);
    expect(saved).toEqual({ status: 200, body: { path: 'fixtures/side-step/truth.json', clipSaved: false } });
    const text = await readFile(join(root, 'fixtures', 'side-step', 'truth.json'), 'utf8');
    expect(text).toBe(serializeTruth(setRoot(emptyTruth('side-step'), 0, [512, 840])));
    expect((await fixtureStatus(root, 'side-step')).body).toEqual({ listed: true, truth: true, clip: false });
  });

  it('refuses a clip that has no entry in fixtures/clips.json', async () => {
    const saved = await saveFixture(root, 'walk', 'truth.json', truthBody('walk'), false);
    expect(saved.status).toBe(403);
    expect(String(saved.body.error)).toContain('fixtures/clips.json');
    expect((await fixtureStatus(root, 'walk')).body).toEqual({ listed: false, truth: false, clip: false });
  });

  it('replaces an existing file only when asked to', async () => {
    await saveFixture(root, 'side-step', 'clip.mp4', Buffer.from('first'), false);
    expect((await saveFixture(root, 'side-step', 'clip.mp4', Buffer.from('second'), false)).status).toBe(409);
    expect(await readFile(join(root, 'fixtures', 'side-step', 'clip.mp4'), 'utf8')).toBe('first');
    expect((await saveFixture(root, 'side-step', 'clip.mp4', Buffer.from('second'), true)).status).toBe(200);
    expect(await readFile(join(root, 'fixtures', 'side-step', 'clip.mp4'), 'utf8')).toBe('second');
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
});
