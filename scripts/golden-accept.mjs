// npm run golden:accept -- <id>: after Qai says "approved", copies that
// milestone's rendered sheets (every PNG in verify/out/<id>/) into
// tests/golden/<id>/, where L1 re-renders them. Qai commits them himself
// with [qai-approved]; this script never commits.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const id = process.argv[2] ?? '';
if (!/^M\d+$/.test(id)) {
  process.stderr.write('Usage: npm run golden:accept -- M1\n');
  process.exit(1);
}
const from = join(process.cwd(), 'verify', 'out', id);
const sheets = existsSync(from) ? readdirSync(from).filter((name) => name.toLowerCase().endsWith('.png')).sort() : [];
if (sheets.length === 0) {
  process.stderr.write(`No sheets in verify/out/${id}/. Run npm run verify first.\n`);
  process.exit(1);
}
const to = join(process.cwd(), 'tests', 'golden', id);
mkdirSync(to, { recursive: true });
for (const name of sheets) copyFileSync(join(from, name), join(to, name));
process.stdout.write(
  `Copied ${sheets.join(', ')} to tests/golden/${id}/. Qai commits them:\n  git add tests/golden\n  git commit -m "${id} goldens [qai-approved]"\n`,
);
