// Cached SAM 3.1 runs (SPEC §9, §6 "cache by clip hash"). Every run is saved
// once, next to its clip, as the response SAM sent: the clip's sha256, the
// prompt, the usage and the raw streamed output. The app, the tests and the
// probe all decode that raw output again with the same parser, so a cached
// run reads exactly like a live one, and nothing is paid for twice.
import type { Anchor } from '../types/effect.ts';
import { framesFromRecords, parseCachedOutput, readFrames, type Bounds, type FrameMask, type Part } from './masks.ts';
import type { Mask } from '../track/tracking.ts';
import type { SegmentationRecord } from '@meta-sam/parser';

// One frame's mask: a 0/1 raster covering `bounds` (source pixels).
export interface SamMask {
  width: number; // raster size, not the frame's
  height: number;
  raster: Uint8Array;
  bounds: Bounds;
  confidence?: number;
}

// A cached response, as saved by scripts/live/ and the proxy.
export interface SamCache {
  clipSha256: string;
  model: string;
  text?: string;
  usage?: { video_frames_processed?: number };
  rawOutput: string;
}

export function readSamCache(json: unknown): SamCache {
  const c = json as Partial<SamCache> | null;
  if (!c || typeof c !== 'object') throw new Error('a SAM cache is a JSON object');
  if (typeof c.rawOutput !== 'string') throw new Error('the SAM cache has no rawOutput');
  if (typeof c.clipSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(c.clipSha256)) throw new Error('the SAM cache has no clipSha256');
  return c as SamCache;
}

// How many frames SAM processed for this run.
export function cachedFrames(json: unknown): number {
  const n = readSamCache(json).usage?.video_frames_processed;
  if (!Number.isInteger(n)) throw new Error('the SAM cache has no usage.video_frames_processed');
  return n!;
}

// One mask per frame (null where SAM found nothing), from a cached run.
export async function masksFromCache(json: unknown, frames: number): Promise<(SamMask | null)[]> {
  const cache = readSamCache(json);
  const records = (await parseCachedOutput(cache.rawOutput)).records;
  return framesFromRecords(records, frames).map(samMaskOf);
}

const FRAME_LINE = /^<(\d+)f>/;
const PARSE_LINES = 1; // lines the parser reads at a time: about 15 ms on a PC

const samMaskOf = (m: FrameMask | null): SamMask | null => (m ? { width: m.width, height: m.height, raster: m.raster, bounds: m.bounds, confidence: m.confidence } : null);

// The same, a piece at a time, for a thread that has a page to keep alive
// (R5, S2: reading the hero's cache is 13 s, half the parser's own pass over
// the text, which decodes every mask to check it, half decoding each again).
// The text is one line a frame (`<12f>0<|box...|><|mask...|>`), so it's parsed
// a few lines at a time, then each raster decoded, with `pause` awaited
// between; `progress` hears how far it is (0 to 1). Without a `pause` it runs
// straight through, as the workers do. `part` reads only some of the frames
// (masks.ts), the rest null, and parses only their lines.
export async function masksFromCacheSliced(
  json: unknown,
  frames: number,
  { pause, progress, part }: { pause?: () => Promise<void>; progress?: (fraction: number) => void; part?: Part } = {},
): Promise<(SamMask | null)[]> {
  const cache = readSamCache(json);
  const lines = cache.rawOutput.split('\n').filter((line) => {
    const mark = FRAME_LINE.exec(line);
    if (!mark) return true; // no frame mark: it stays for every share
    const frame = Number(mark[1]);
    return frame < frames && (!part || frame % part.count === part.index);
  });
  const records: SegmentationRecord[] = [];
  for (let at = 0; at < lines.length; at += PARSE_LINES) {
    records.push(...(await parseCachedOutput(lines.slice(at, at + PARSE_LINES).join('\n'))).records);
    progress?.((0.5 * Math.min(at + PARSE_LINES, lines.length)) / lines.length);
    if (pause) await pause();
  }
  const steps = readFrames(records, frames, part);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value.map(samMaskOf);
    progress?.(0.5 + (0.5 * step.value.done) / step.value.total);
    if (pause) await pause();
  }
}

// The file a stroke's anchor is cached in, next to the clip. A concept is
// shared by every stroke on it (one `person` run serves them all); a point
// is the stroke's own run. Ground strokes don't track, so they have none.
export function samCacheFile(anchor: Anchor, strokeId: number): string | null {
  if (anchor.type === 'concept') return `sam-${slug(anchor.prompt)}.json`;
  if (anchor.type === 'point') return `sam-stroke-${strokeId}.json`;
  return null;
}

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'concept';

// A SAM mask as the tracker's whole-frame mask, at 1/`step` of the frame's
// size: what the person cutout and the torso measures read.
export function toFrameMask(m: SamMask, frameWidth: number, frameHeight: number, step = 4): Mask {
  const width = Math.ceil(frameWidth / step);
  const height = Math.ceil(frameHeight / step);
  const alpha = new Uint8ClampedArray(width * height);
  const { left, top, right, bottom } = m.bounds;
  const sx = m.width / (right - left);
  const sy = m.height / (bottom - top);
  for (let row = 0; row < height; row++) {
    const y = (row + 0.5) * step;
    if (y < top || y >= bottom) continue;
    const r = Math.floor((y - top) * sy);
    for (let col = 0; col < width; col++) {
      const x = (col + 0.5) * step;
      if (x < left || x >= right) continue;
      if (m.raster[r * m.width + Math.floor((x - left) * sx)]) alpha[row * width + col] = 255;
    }
  }
  return { width, height, alpha };
}
