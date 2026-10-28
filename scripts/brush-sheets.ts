// The brush samples for B3 (src/render/brush-sample.ts): one PNG per brush in
// verify/out/brushes/, which golden:accept -- brushes copies into
// tests/golden/brushes/ once Qai says approved, plus all six stacked and
// labeled in verify/out/brushes-sheet.png for him to look at. Local only.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { BRUSH_IDS } from '../src/types/effect.ts';
import { brushSamplePng, SAMPLE_BACKDROPS, SAMPLE_PANEL } from '../src/render/brush-sample.ts';

const out = join(process.cwd(), 'verify', 'out');
const dir = join(out, 'brushes');
mkdirSync(dir, { recursive: true });

const LABEL = 28;
const sheet = createCanvas(SAMPLE_PANEL.width * SAMPLE_BACKDROPS.length, (SAMPLE_PANEL.height + LABEL) * BRUSH_IDS.length);
const ctx = sheet.getContext('2d');
ctx.fillStyle = '#ffffff';
ctx.fillRect(0, 0, sheet.width, sheet.height);
ctx.font = '16px sans-serif';
ctx.textBaseline = 'middle';
for (const [i, brush] of BRUSH_IDS.entries()) {
  const png = brushSamplePng(brush);
  writeFileSync(join(dir, `${brush}.png`), png);
  const y = i * (SAMPLE_PANEL.height + LABEL);
  ctx.fillStyle = '#000000';
  ctx.fillText(`${brush}  (left: dark footage, right: light footage)`, 10, y + LABEL / 2);
  ctx.drawImage(await loadImage(png), 0, y + LABEL);
}
writeFileSync(join(out, 'brushes-sheet.png'), sheet.toBuffer('image/png'));
process.stdout.write(`brush samples: ${BRUSH_IDS.map((b) => `verify/out/brushes/${b}.png`).join(', ')}; overview verify/out/brushes-sheet.png\n`);
