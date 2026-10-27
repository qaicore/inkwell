import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Plugin } from 'vite';

// DEV ONLY: for browsers that can't give the page WebGL 2, the page POSTs
// its converted clip to /__standin and this runs the stand-in pose model in
// Python (tools/standin.py) and sends the results back. Set it up once with
// `npm run standin:setup`.
export function standInServer(): Plugin {
  return {
    name: 'inkwell-standin',
    apply: 'serve',
    configureServer(server) {
      const root = server.config.root;
      const python = join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
      const work = join(root, '.standin'); // the model, and clips while they're being tracked
      let running = false;

      server.middlewares.use('/__standin', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        if (!existsSync(python)) {
          res.statusCode = 501;
          res.end('the Python stand-in is not set up yet: run "npm run standin:setup" in the project folder');
          return;
        }
        const query = new URL(req.url ?? '', 'http://localhost').searchParams;
        const sizes = ['width', 'height', 'maskWidth', 'maskHeight'].map((key) => Number(query.get(key)));
        if (sizes.some((size) => !Number.isInteger(size) || size <= 0)) {
          res.statusCode = 400;
          res.end('width, height, maskWidth and maskHeight must be positive whole numbers');
          return;
        }
        // One run at a time: each one takes a full CPU core and a few hundred MB.
        if (running) {
          res.statusCode = 429;
          res.end('the dev server is already tracking a clip; try again when it finishes');
          return;
        }

        running = true;
        await mkdir(work, { recursive: true });
        const clip = join(work, `clip-${randomUUID()}.mp4`);
        try {
          await writeFile(clip, await readBody(req));
          const script = join(root, 'tools', 'standin.py');
          const model = join(work, 'pose_landmarker_full.task');
          const result = await runPython(python, [script, clip, model, ...sizes.map(String)]);
          if (result.code !== 0) {
            res.statusCode = 500;
            res.end(lastLines(result.errors) || `Python exited with code ${result.code}`);
            return;
          }
          res.setHeader('Content-Type', 'application/octet-stream');
          res.end(result.output);
        } catch (err) {
          res.statusCode = err instanceof TooLarge ? 413 : 500;
          res.end(String(err instanceof Error ? err.message : err));
        } finally {
          running = false;
          await rm(clip, { force: true });
        }
      });
    },
  };
}

// The biggest upload the dev endpoints accept. A converted 15 s clip is
// about 15 MB; phone mode opens them to the whole Wi-Fi, so cap them.
const MAX_UPLOAD = 300 * 1024 * 1024;

export class TooLarge extends Error {}

// Reads a request body, refusing it as soon as it passes `max` bytes.
export async function readBody(req: AsyncIterable<unknown>, max = MAX_UPLOAD) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > max) throw new TooLarge(`uploads here are limited to ${+(max / 1024 / 1024).toFixed(2)} MB`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function runPython(python: string, args: string[]) {
  return new Promise<{ code: number | null; output: Buffer; errors: string }>((resolve, reject) => {
    // -I keeps the user's own PYTHONPATH and site-packages out of it.
    const child = spawn(python, ['-I', ...args]);
    const output: Buffer[] = [];
    let errors = '';
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      errors += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output: Buffer.concat(output), errors }));
  });
}

// MediaPipe logs a lot to stderr; the error itself is at the end.
function lastLines(text: string, count = 4) {
  return text.trim().split(/\r?\n/).slice(-count).join('\n');
}
