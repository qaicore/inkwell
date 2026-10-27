// The probe's video plumbing, through ffmpeg and ffprobe on PATH (SPEC §5):
// normalise the clip, read its size and frame count, and pull chosen frames
// out as raw RGB at a chosen size. Local only, nothing paid.
import { spawnSync } from 'node:child_process';
import type { RgbImage } from './png.ts';

function run(cmd: string, args: string[]) {
  const result = spawnSync(cmd, args, { maxBuffer: 1 << 30 });
  if (result.error) throw new Error(`${cmd} didn't start (${result.error.message}). Install it: winget install Gyan.FFmpeg`);
  if (result.status !== 0) throw new Error(`${cmd} failed:\n${result.stderr.toString().trim().split('\n').slice(-8).join('\n')}`);
  return result.stdout;
}

export function checkFfmpeg() {
  run('ffmpeg', ['-hide_banner', '-version']);
  run('ffprobe', ['-hide_banner', '-version']);
}

// H.264 at a constant 30 fps, at most 15 s, upright (ffmpeg applies the
// rotation flag when it re-encodes), no audio, with the index at the front
// (faststart) so SAM reads it without a remux. Same frames the app's own
// conversion targets (SPEC §1), so frame N here is frame N in SAM's output.
export function normalise(input: string, output: string) {
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-t', '15', '-vf', 'fps=30',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', output,
  ]);
}

export interface VideoInfo {
  width: number;
  height: number;
  frames: number;
  fps: number;
}

export function probeVideo(file: string): VideoInfo {
  const out = run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-count_packets',
    '-show_entries', 'stream=width,height,nb_read_packets,r_frame_rate', '-of', 'json', file,
  ]);
  const s = JSON.parse(out.toString()).streams?.[0];
  if (!s) throw new Error(`${file} has no video stream`);
  const [num, den] = String(s.r_frame_rate).split('/').map(Number);
  return { width: s.width, height: s.height, frames: Number(s.nb_read_packets), fps: den ? num / den : num };
}

// The given frames (by index), scaled to width x height, in ascending order.
export function readFrames(file: string, frames: readonly number[], width: number, height: number): Map<number, RgbImage> {
  const wanted = [...new Set(frames)].sort((a, b) => a - b);
  const select = wanted.map((f) => `eq(n\\,${f})`).join('+');
  const raw = run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', file,
    '-vf', `select=${select},scale=${width}:${height}:flags=area`, '-fps_mode', 'passthrough',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ]);
  const size = width * height * 3;
  if (raw.length !== size * wanted.length) {
    throw new Error(`ffmpeg returned ${raw.length / size} of the ${wanted.length} frames asked for`);
  }
  const out = new Map<number, RgbImage>();
  wanted.forEach((f, i) => out.set(f, { width, height, data: new Uint8Array(raw.buffer, raw.byteOffset + i * size, size) }));
  return out;
}

// Fits width x height inside a box `longSide` on its long side, even sizes.
export function fitSize(width: number, height: number, longSide: number): [number, number] {
  const k = longSide / Math.max(width, height);
  const even = (v: number) => Math.max(2, 2 * Math.round((v * k) / 2));
  return [even(width), even(height)];
}
