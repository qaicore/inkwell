// Muse Wonder's facing call, as the probe makes it: numbered frames in, a
// facing class and a confidence per frame out, through a fixed JSON schema.
// The class meanings are docs/SPEC.md §7's, word for word.
import type { FacingLabel } from './report.ts';

export const FACING_CLASSES = ['front', 'right', 'back', 'left'] as const;

export function facingPrompt(frames: readonly number[]): string {
  return [
    'Each image is one frame of a phone video of one person, with its frame number written in white on black in the top-left corner.',
    `The frames, in order, are: ${frames.join(', ')}.`,
    'For each frame, say which way the person faces, using the facing angle θ and these classes:',
    '',
    '0° faces the camera. θ grows as he turns to his left, seen from above.',
    '90° puts his right side toward the camera. 180° is his back. 270° puts his left side toward the camera.',
    '',
    '| Class | θ range |',
    '|---|---|',
    '| front | within 45° of 0° |',
    '| right | within 45° of 90° (his right side toward the camera) |',
    '| back | within 45° of 180° |',
    '| left | within 45° of 270° |',
    '',
    'Return exactly one entry per frame, using the frame numbers above, with a confidence from 0 to 1.',
  ].join('\n');
}

export const FACING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['frames'],
  properties: {
    frames: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['frame', 'facing', 'confidence'],
        properties: {
          frame: { type: 'integer' },
          facing: { type: 'string', enum: [...FACING_CLASSES] },
          confidence: { type: 'number' },
        },
      },
    },
  },
} as const;

export type FacingCheck = { ok: true; labels: FacingLabel[] } | { ok: false; problems: string[] };

// The schema constrains the shape; this also checks what it can't say: one
// entry for each frame asked about, and confidence inside 0..1.
export function checkFacing(text: string, frames: readonly number[]): FacingCheck {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, problems: ['output is not JSON'] };
  }
  const entries = (json as { frames?: unknown })?.frames;
  if (!Array.isArray(entries)) return { ok: false, problems: ['no "frames" array'] };
  const problems: string[] = [];
  const byFrame = new Map<number, FacingLabel>();
  for (const e of entries as Record<string, unknown>[]) {
    const { frame, facing, confidence } = e ?? {};
    if (typeof frame !== 'number' || !frames.includes(frame)) problems.push(`unexpected frame ${String(frame)}`);
    else if (byFrame.has(frame)) problems.push(`frame ${frame} given twice`);
    else if (typeof facing !== 'string' || !(FACING_CLASSES as readonly string[]).includes(facing)) problems.push(`frame ${frame}: bad class ${String(facing)}`);
    else if (typeof confidence !== 'number' || !(confidence >= 0 && confidence <= 1)) problems.push(`frame ${frame}: confidence ${String(confidence)} outside 0..1`);
    else byFrame.set(frame, { frame, facing: facing as FacingLabel['facing'], confidence });
  }
  for (const f of frames) if (!byFrame.has(f) && !problems.some((p) => p.startsWith(`frame ${f}:`))) problems.push(`frame ${f} missing`);
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, labels: frames.map((f) => byFrame.get(f)!) };
}

// n frames spread evenly from the first to the last.
export function spreadFrames(frameCount: number, n: number): number[] {
  if (frameCount <= n) return Array.from({ length: frameCount }, (_, i) => i);
  return Array.from({ length: n }, (_, i) => Math.round((i * (frameCount - 1)) / (n - 1)));
}
