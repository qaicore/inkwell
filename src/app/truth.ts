// Ground truth for one clip, as the /label page makes it and the K and T
// criteria read it (SPEC §11): a root clicked every 10th frame, a facing
// class every 6th, and the stretches where he holds still. Frame numbers are
// the converted clip's (constant 30 fps), so they match SAM's masks.
import type { Facing } from '../types/effect.ts';

export type Px = [number, number]; // video pixels of the converted clip

export interface Truth {
  clip: string;
  fps: 30;
  roots: { frame: number; xy: Px }[];
  facing: { frame: number; label: Facing }[];
  still: [number, number][]; // inclusive frame ranges, sorted, not overlapping
}

export const ROOT_EVERY = 10;
export const FACING_EVERY = 6; // 5 a second: the frames Wonder sees
export const FACINGS: readonly Facing[] = ['front', 'right', 'back', 'left'];
export const FACING_KEYS: Record<string, Facing> = { f: 'front', r: 'right', b: 'back', l: 'left' };
// Folder ids under fixtures/: lowercase words joined by hyphens.
export const CLIP_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function emptyTruth(clip: string): Truth {
  return { clip, fps: 30, roots: [], facing: [], still: [] };
}

// The frames that need a mark, from 0 to the last frame.
export function markFrames(frameCount: number, every: number): number[] {
  return Array.from({ length: Math.ceil(frameCount / every) }, (_, i) => i * every);
}

// Sets (or, with null, clears) the root on one frame.
export function setRoot(truth: Truth, frame: number, xy: Px | null): Truth {
  const roots = truth.roots.filter((r) => r.frame !== frame);
  if (xy) roots.push({ frame, xy: [Math.round(xy[0]), Math.round(xy[1])] });
  return { ...truth, roots: roots.sort((a, b) => a.frame - b.frame) };
}

export function setFacing(truth: Truth, frame: number, label: Facing | null): Truth {
  const facing = truth.facing.filter((f) => f.frame !== frame);
  if (label) facing.push({ frame, label });
  return { ...truth, facing: facing.sort((a, b) => a.frame - b.frame) };
}

// Adds a still stretch, merged with any it overlaps or touches.
export function addStill(truth: Truth, from: number, to: number): Truth {
  let [a, b] = from <= to ? [from, to] : [to, from];
  const kept: [number, number][] = [];
  for (const [s, e] of truth.still) {
    if (e < a - 1 || s > b + 1) kept.push([s, e]);
    else [a, b] = [Math.min(a, s), Math.max(b, e)];
  }
  kept.push([a, b]);
  return { ...truth, still: kept.sort((x, y) => x[0] - y[0]) };
}

// Removes the still stretch that covers `frame`, if any.
export function removeStillAt(truth: Truth, frame: number): Truth {
  return { ...truth, still: truth.still.filter(([s, e]) => frame < s || frame > e) };
}

export function stillAt(truth: Truth, frame: number): boolean {
  return truth.still.some(([s, e]) => frame >= s && frame <= e);
}

// Checks a parsed truth.json. Every problem is listed, so the page (or the
// dev server) can say exactly what's wrong instead of saving a bad file.
export function validateTruth(value: unknown): { truth: Truth } | { problems: string[] } {
  const problems: string[] = [];
  const isFrame = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { problems: ['truth.json must be a JSON object'] };
  const t = value as Record<string, unknown>;
  if (typeof t.clip !== 'string' || !CLIP_ID.test(t.clip)) problems.push('"clip" must be a folder id like "side-step"');
  if (t.fps !== 30) problems.push('"fps" must be 30 (frames of the converted clip)');
  const ascending = (frames: number[]) => frames.every((f, i) => i === 0 || f > frames[i - 1]);

  // The order checks look only at marks whose frame is valid; the rest are
  // already listed as problems.
  const frames = (marks: unknown[]) => marks.filter((m): m is { frame: number } => isObject(m) && isFrame(m.frame)).map((m) => m.frame);

  if (!Array.isArray(t.roots)) problems.push('"roots" must be a list');
  else {
    t.roots.forEach((r, i) => {
      const ok = isObject(r) && isFrame(r.frame) && Array.isArray(r.xy) && r.xy.length === 2 && r.xy.every(Number.isFinite);
      if (!ok) problems.push(`roots[${i}] must be { "frame": <whole number>, "xy": [x, y] }`);
    });
    if (!ascending(frames(t.roots))) problems.push('"roots" must be in frame order, one per frame');
  }
  if (!Array.isArray(t.facing)) problems.push('"facing" must be a list');
  else {
    t.facing.forEach((f, i) => {
      if (!isObject(f) || !isFrame(f.frame) || !FACINGS.includes(f.label as Facing)) {
        problems.push(`facing[${i}] must be { "frame": <whole number>, "label": ${FACINGS.map((l) => `"${l}"`).join(' | ')} }`);
      }
    });
    if (!ascending(frames(t.facing))) problems.push('"facing" must be in frame order, one per frame');
  }
  if (!Array.isArray(t.still)) problems.push('"still" must be a list');
  else {
    t.still.forEach((s, i) => {
      if (!Array.isArray(s) || s.length !== 2 || !isFrame(s[0]) || !isFrame(s[1]) || s[0] > s[1]) {
        problems.push(`still[${i}] must be [first frame, last frame]`);
      } else if (i > 0 && (t.still as [number, number][])[i - 1][1] >= s[0]) {
        problems.push(`still[${i}] overlaps the stretch before it`);
      }
    });
  }
  return problems.length > 0 ? { problems } : { truth: value as Truth };
}

// Marks off the §11 cadence: a valid file, but not one the page makes, so
// worth a look before it's saved or used.
export function truthWarnings(truth: Truth): string[] {
  const warnings: string[] = [];
  const offRoots = truth.roots.filter((r) => r.frame % ROOT_EVERY !== 0).map((r) => r.frame);
  const offFacing = truth.facing.filter((f) => f.frame % FACING_EVERY !== 0).map((f) => f.frame);
  if (offRoots.length > 0) warnings.push(`roots off every ${ROOT_EVERY}th frame: ${listFrames(offRoots)}`);
  if (offFacing.length > 0) warnings.push(`facing marks off every ${FACING_EVERY}th frame: ${listFrames(offFacing)}`);
  return warnings;
}

const listFrames = (frames: number[]) => (frames.length > 6 ? `${frames.slice(0, 6).join(', ')} and ${frames.length - 6} more` : frames.join(', '));

// The file as saved: the key order of SPEC §11, one mark per line, so a diff
// of two labeling passes reads frame by frame.
export function serializeTruth(truth: Truth): string {
  const list = (items: string[]) => (items.length === 0 ? '[]' : `[\n    ${items.join(',\n    ')}\n  ]`);
  return [
    '{',
    `  "clip": ${JSON.stringify(truth.clip)},`,
    `  "fps": ${truth.fps},`,
    `  "roots": ${list(truth.roots.map((r) => `{ "frame": ${r.frame}, "xy": [${r.xy[0]}, ${r.xy[1]}] }`))},`,
    `  "facing": ${list(truth.facing.map((f) => `{ "frame": ${f.frame}, "label": "${f.label}" }`))},`,
    `  "still": ${list(truth.still.map(([s, e]) => `[${s}, ${e}]`))}`,
    '}',
    '',
  ].join('\n');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
