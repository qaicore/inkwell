import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheResponse } from '../../tools/cache-server.ts';

const SHA = 'b'.repeat(64);
const SOURCE = 'c'.repeat(64);

function repo(consent: string) {
  const root = mkdtempSync(join(tmpdir(), 'inkwell-cache-'));
  mkdirSync(join(root, 'fixtures', 'walk'), { recursive: true });
  writeFileSync(join(root, 'fixtures', 'clips.json'), JSON.stringify({ clips: [{ id: 'walk', file: 'fixtures/walk/clip.mp4', people: ['Qai'], consent }] }));
  writeFileSync(join(root, 'fixtures', 'walk', 'sam-person.json'), JSON.stringify({ clipSha256: SHA, rawOutput: 'x' }));
  writeFileSync(join(root, 'fixtures', 'walk', 'source.json'), JSON.stringify({ source: { name: 'IMG.MOV', bytes: 1, sha256: SOURCE }, sha256: SHA }));
  writeFileSync(join(root, 'fixtures', 'walk', 'truth.json'), '{}');
  return root;
}

describe('dev cache route', () => {
  it('finds the clip by its own hash or the phone file it came from', async () => {
    const root = repo('self');
    expect(await cacheResponse(root, `/${SHA}/sam-person.json`)).toEqual({ status: 200, body: JSON.stringify({ clipSha256: SHA, rawOutput: 'x' }) });
    expect((await cacheResponse(root, `/${SOURCE}/sam-person.json`)).status).toBe(200);
    expect((await cacheResponse(root, `/${SHA}/sam-face.json`)).status).toBe(404);
  });
  it('serves only cache files, and only for clips with consent', async () => {
    expect((await cacheResponse(repo('self'), `/${SHA}/truth.json`)).status).toBe(404);
    expect((await cacheResponse(repo(''), `/${SHA}/sam-person.json`)).status).toBe(404);
  });
});
