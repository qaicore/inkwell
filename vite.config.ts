import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig, type Plugin } from 'vite';
import { cacheServer } from './tools/cache-server.ts';
import { fixturesServer } from './tools/fixtures-server.ts';
import { readBody, standInServer } from './tools/standin-server.ts';

// Dev only: the app POSTs each finished export to /__renders/<name>, and this
// writes it to renders/ (gitignored), so testing never needs a download.
function saveRenders(): Plugin {
  return {
    name: 'inkwell-save-renders',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__renders/', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        try {
          const name = basename(decodeURIComponent(req.url ?? '')).replace(/[^\w.-]/g, '_') || 'render.mp4';
          const body = await readBody(req);
          const dir = join(server.config.root, 'renders');
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, name), body);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ path: `renders/${name}` }));
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // `npm run dev:phone` serves the app to phones on the same Wi-Fi. Safari
  // only allows video encoding on secure (HTTPS) pages, so phone mode uses a
  // self-signed certificate; the phone asks once whether to trust it. It runs
  // on its own port and cache, so it can run alongside `npm run dev`.
  const phone = mode === 'phone';
  return {
    // fixturesServer also serves the dev-only /label page (label/index.html).
    plugins: [saveRenders(), standInServer(), fixturesServer(), cacheServer(), ...(phone ? [basicSsl()] : [])],
    cacheDir: phone ? 'node_modules/.vite-phone' : undefined,
    server: {
      port: phone ? 5175 : 5174,
      strictPort: true,
      host: phone ? true : undefined,
      // The Python stand-in's environment and work files aren't source.
      watch: { ignored: ['**/.venv/**', '**/.standin/**'] },
      // Files the dev server never serves, even on request; phone mode serves
      // the whole Wi-Fi. Setting this replaces Vite's defaults, so they're
      // listed again first; then .dev.vars, where the Meta key lives, and
      // Wrangler's local state.
      fs: {
        deny: [
          '.env',
          '.env.*',
          '*.{crt,pem,key,p12,pfx,cer,der}',
          '.npmrc',
          '.yarnrc.yml',
          '**/.git/**',
          '.dev.vars',
          '.dev.vars.*',
          '**/.wrangler/**',
        ],
      },
    },
    // The stand-in tracker is only imported when you press Track. Bundle it
    // up front, or Vite finds it then and reloads the page mid-run.
    optimizeDeps: { include: ['@mediapipe/tasks-vision'] },
  };
});
