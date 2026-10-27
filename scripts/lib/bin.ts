// Where an installed package keeps its command-line script, read from its
// package.json, so a check can run it with node directly. Nothing is
// downloaded: a package missing from node_modules is an error.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function localBin(root: string, pkg: string, command = pkg): string {
  const manifest = join(root, 'node_modules', pkg, 'package.json');
  if (!existsSync(manifest)) throw new Error(`${pkg} isn't in node_modules. Run npm install first.`);
  const { bin } = JSON.parse(readFileSync(manifest, 'utf8')) as { bin?: string | Record<string, string> };
  const rel = typeof bin === 'string' ? bin : bin?.[command];
  if (!rel) throw new Error(`${pkg} has no "${command}" command.`);
  return join(root, 'node_modules', pkg, rel);
}
