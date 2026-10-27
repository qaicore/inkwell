// Which take a fixture's clip.mp4 is. Labels are frame numbers, so they only
// mean something next to the clip they were made on. Converting isn't
// byte-for-byte repeatable (the same phone file converts to slightly
// different MP4 bytes each time, with the same frames), so a take is known by
// the file it was converted from: that file's SHA-256 is kept next to the
// clip, in fixtures/<clip>/source.json.

export interface Take {
  source: { name: string; bytes: number; sha256: string }; // the file that was opened
  sha256: string; // the converted clip.mp4
  frames: number;
  width: number;
  height: number;
}

// What the dev server knows about a saved clip.mp4: its own hash, and its
// source.json if there is one.
export interface SavedClip {
  bytes: number;
  sha256: string;
  take: Take | null;
}

const SHA256 = /^[0-9a-f]{64}$/;

export function validateTake(value: unknown): Take | null {
  const t = value as Partial<Take> | null;
  const whole = (n: unknown) => Number.isInteger(n) && (n as number) >= 0;
  const s = t?.source;
  if (!t || !s || typeof s.name !== 'string' || !whole(s.bytes) || typeof s.sha256 !== 'string' || !SHA256.test(s.sha256)) return null;
  if (typeof t.sha256 !== 'string' || !SHA256.test(t.sha256) || !whole(t.frames) || !whole(t.width) || !whole(t.height)) return null;
  return { source: { name: s.name, bytes: s.bytes, sha256: s.sha256 }, sha256: t.sha256, frames: t.frames!, width: t.width!, height: t.height! };
}

// 'same' when the saved clip is the open file, or was converted from the same
// source file; 'different' when it was converted from another file; 'unknown'
// when there's no record of what it was converted from.
export function compareTake(open: Take, saved: SavedClip): 'same' | 'different' | 'unknown' {
  if (saved.sha256 === open.sha256) return 'same';
  const take = saved.take;
  if (!take) return 'unknown';
  if (take.sha256 !== saved.sha256) return 'unknown'; // source.json describes another clip.mp4
  if (take.source.sha256 === open.source.sha256) return 'same';
  return 'different';
}

// One line for the page: "IMG_0412.MOV, 300 frames, 1080×1920".
export function describeTake(take: Take | null): string {
  return take ? `${take.source.name}, ${take.frames} frames, ${take.width}×${take.height}` : 'a clip with no record of its source';
}
