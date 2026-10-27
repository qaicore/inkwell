import { join } from 'node:path';
import { resolveConfig } from 'vite';
import { describe, expect, it } from 'vitest';

// The dev server must never serve secrets: phone mode serves the whole Wi-Fi.
// fsDenyGlob is the matcher Vite builds from server.fs.deny and checks before
// serving any file.
describe('vite.config.ts: files the dev server refuses to serve', () => {
  const root = process.cwd();
  const denied = [
    '.env',
    '.env.local',
    '.dev.vars',
    '.dev.vars.production',
    'functions/.dev.vars',
    '.wrangler/state/v3/d1/db.sqlite',
    'node_modules/.vite-phone/basic-ssl/_cert.pem',
    'server.key',
    '.npmrc',
    '.yarnrc.yml',
    '.git/config',
  ];

  for (const mode of ['development', 'phone']) {
    it(`denies every secret in ${mode} mode, and still serves source`, async () => {
      const config = await resolveConfig({ configFile: join(root, 'vite.config.ts'), mode, logLevel: 'silent' }, 'serve');
      const deny = (config as unknown as { fsDenyGlob: (path: string) => boolean }).fsDenyGlob;
      for (const file of denied) expect(deny(join(root, file).replace(/\\/g, '/')), file).toBe(true);
      for (const file of ['src/app/main.ts', 'reference/timing.json', 'fixtures/side-step/clip.mp4', 'label/index.html']) {
        expect(deny(join(root, file).replace(/\\/g, '/')), file).toBe(false);
      }
    });
  }
});
