// The fixture clip a paid script works on, and SAM calls cached next to it in
// the probe's shape (fixtures/probe/sam-*.json), keyed by the clip's hash.
// Only clips listed in fixtures/clips.json (consent, CLAUDE.md rule 7).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SAM_MODEL, samCost } from '../../functions/_lib/pricing.ts';
import { checkFfmpeg, normalise, probeVideo } from '../probe/ffmpeg.ts';
import { samVideo, uploadVideo } from './meta.mjs';

export class Stop extends Error {}

export const money = (usd) => `$${usd.toFixed(2)}`;
export const log = (line = '') => process.stdout.write(`${line}\n`);
export const SAM_METADATA = { include_confidence: 'true', mask_encoding: 'one_bit' };

// fixtures/<id>/clip.mp4, if fixtures/clips.json lists it; its hash, and a
// copy converted to H.264 at a constant 30 fps (as the app converts it), whose
// frame numbers are the app's.
export function fixtureClip(root, id) {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Stop(`"${id}" isn't a clip id (lowercase letters, digits and dashes).`);
  const listed = JSON.parse(readFileSync(join(root, 'fixtures', 'clips.json'), 'utf8')).clips ?? [];
  const entry = listed.find((c) => c.id === id);
  if (!entry) throw new Stop(`${id} isn't in fixtures/clips.json, so it can't be used (consent first).`);
  const dir = join(root, 'fixtures', id);
  const path = join(dir, 'clip.mp4');
  if (!existsSync(path)) throw new Stop(`fixtures/${id}/clip.mp4 is missing.`);
  checkFfmpeg();
  const sha = createHash('sha256').update(readFileSync(path)).digest('hex');
  const work = join(tmpdir(), `inkwell-${id}-${sha.slice(0, 12)}.mp4`);
  if (!existsSync(work)) {
    log(`Converting ${id} to H.264 at a constant 30 fps...`);
    normalise(path, work);
  }
  return { id, dir, path, sha, work, info: probeVideo(work) };
}

// A cached JSON next to the clip, if it was made from this exact clip.
export function readCache(clip, file) {
  const path = join(clip.dir, file);
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, 'utf8'));
  return data.clipSha256 === clip.sha ? data : null;
}

export function writeCache(clip, file, data) {
  writeFileSync(join(clip.dir, file), `${JSON.stringify(data, null, 2)}\n`);
}

// Uploading is free; the file id is kept in upload.json and reused for every
// SAM call on the clip until the clip changes or --fresh.
export async function fileIdFor(client, clip, fresh) {
  const kept = fresh ? null : readCache(clip, 'upload.json');
  if (kept?.fileId) return kept.fileId;
  log(`Uploading ${clip.id} (free)...`);
  const fileId = await uploadVideo(client, clip.work);
  writeCache(clip, 'upload.json', { clipSha256: clip.sha, fileId });
  return fileId;
}

// One SAM call, held against the budget at its worst case and settled at
// what it billed, in the probe's cache shape.
export async function samRun(client, budget, clip, fileId, { label, text, metadata, point }) {
  const worst = samCost(clip.info.frames);
  const held = budget.reserve(label, worst);
  log(`${label}...`);
  let res;
  try {
    res = await samVideo(client, { fileId, text, metadata });
  } catch (err) {
    // The reservation stays counted: a call that failed partway may still bill.
    throw new Stop(`${label} failed: ${err.message}\nIf the file id expired, run again with --fresh to re-upload.`);
  }
  const frames = res.usage?.video_frames_processed;
  const spend = { name: label, usd: frames === undefined ? worst : samCost(frames), detail: frames === undefined ? 'no usage reported; counted at the estimate' : `${frames} frames` };
  budget.settle(held, spend.usd);
  return {
    clipSha256: clip.sha,
    model: SAM_MODEL,
    text,
    metadata,
    ...(point ? { point } : {}),
    outcome: res.result.outcome,
    usage: res.usage,
    diagnostics: res.result.diagnostics.slice(0, 20),
    spend,
    rawOutput: res.result.rawOutput,
  };
}
