// The probe's numbers and its report.md. Everything here is plain math on
// masks already decoded, so it runs the same on a fresh API response and on
// the cached one in fixtures/probe/.
import { maskHas, maskStats, type FrameMask } from './masks.ts';

// Linear interpolation between closest ranks (the usual "type 7"), p in 0..1.
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = p * (sorted.length - 1);
  const lo = Math.floor(at);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

// SPEC's body height: the height of that frame's person-mask bounding box.
export function bodyHeights(person: readonly (FrameMask | null)[]): (number | null)[] {
  return person.map((mask) => {
    const stats = mask ? maskStats(mask) : null;
    return stats ? stats.box.bottom - stats.box.top : null;
  });
}

export interface JumpStats {
  framesWithMask: number;
  pairs: number; // consecutive frame pairs that both have a mask and a body height
  median: number | null; // % of body height
  p95: number | null;
  longestGap: number; // most consecutive frames with no mask
}

// How far the mask centroid moves from one frame to the next, as % of that
// frame's body height. Jitter and lost tracks both show up here.
export function jumpStats(masks: readonly (FrameMask | null)[], heights: readonly (number | null)[]): JumpStats {
  const centroids = masks.map((mask) => (mask ? maskStats(mask) : null));
  const jumps: number[] = [];
  for (let f = 1; f < centroids.length; f++) {
    const a = centroids[f - 1];
    const b = centroids[f];
    const h = heights[f];
    if (!a || !b || !h) continue;
    jumps.push((100 * Math.hypot(b.cx - a.cx, b.cy - a.cy)) / h);
  }
  let longestGap = 0;
  let gap = 0;
  for (const c of centroids) {
    gap = c ? 0 : gap + 1;
    longestGap = Math.max(longestGap, gap);
  }
  return {
    framesWithMask: centroids.filter(Boolean).length,
    pairs: jumps.length,
    median: percentile(jumps, 0.5),
    p95: percentile(jumps, 0.95),
    longestGap,
  };
}

export interface Run {
  start: number; // inclusive frame range
  end: number;
  present: boolean;
}

export function runs(present: readonly boolean[]): Run[] {
  const out: Run[] = [];
  present.forEach((p, f) => {
    const last = out[out.length - 1];
    if (last && last.present === p) last.end = f;
    else out.push({ start: f, end: f, present: p });
  });
  return out;
}

// One character per `step` frames: '#' if the face shows on most of them.
export function timelineBar(present: readonly boolean[], step: number): string {
  let bar = '';
  for (let f = 0; f < present.length; f += step) {
    const slice = present.slice(f, f + step);
    bar += slice.filter(Boolean).length * 2 >= slice.length ? '#' : '.';
  }
  return bar;
}

export interface BackPoint {
  frame: number;
  x: number; // integer source pixels, inside the person mask
  y: number;
  how: string;
}

// Where to put the one point on his back: the middle of the longest stretch
// with no face (his back is to the camera), at 35% of the way down his body
// (mid-back, below the shoulders), centred on the widest run of body pixels
// in that row so an arm out to one side doesn't pull it off his back.
export function chooseBackPoint(person: readonly (FrameMask | null)[], facePresent: readonly boolean[]): BackPoint | null {
  const noFace = runs(facePresent).filter((r) => !r.present);
  noFace.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  let how: string;
  let candidates: number[];
  if (noFace.length > 0) {
    const r = noFace[0];
    const mid = Math.floor((r.start + r.end) / 2);
    candidates = nearestFirst(mid, r.start, r.end);
    how = `middle of the longest no-face stretch (frames ${r.start}-${r.end})`;
  } else {
    const mid = Math.floor((person.length - 1) / 2);
    candidates = nearestFirst(mid, 0, person.length - 1);
    how = 'the face never left the frame, so his back may never show; used the frame nearest the middle';
  }
  for (const frame of candidates) {
    const mask = person[frame];
    const stats = mask ? maskStats(mask) : null;
    if (!mask || !stats) continue;
    const y = Math.floor(stats.box.top + 0.35 * (stats.box.bottom - stats.box.top));
    let best = { start: 0, length: 0 };
    let start = -1;
    for (let x = Math.floor(stats.box.left); x <= Math.ceil(stats.box.right); x++) {
      const inside = maskHas(mask, x + 0.5, y + 0.5);
      if (inside && start < 0) start = x;
      if ((!inside || x === Math.ceil(stats.box.right)) && start >= 0) {
        const end = inside ? x + 1 : x;
        if (end - start > best.length) best = { start, length: end - start };
        start = -1;
      }
    }
    if (best.length === 0) continue;
    return { frame, x: Math.floor(best.start + best.length / 2), y, how };
  }
  return null;
}

function nearestFirst(mid: number, lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let d = 0; out.length < hi - lo + 1; d++) {
    if (mid - d >= lo) out.push(mid - d);
    if (d > 0 && mid + d <= hi) out.push(mid + d);
  }
  return out;
}

export interface FacingLabel {
  frame: number;
  facing: 'front' | 'right' | 'back' | 'left';
  confidence: number;
}

export interface ReportInput {
  clip: { file: string; sha256: string; frames: number; width: number; height: number; fps: number };
  prompts: { name: string; stats: JumpStats; medianConfidence: number | null; outcome: string }[];
  facePresent: boolean[];
  backPoint: BackPoint | null;
  backHeld: { noFaceFrames: number; withMask: number } | null;
  wonder: { labels: FacingLabel[]; note: string } | null;
  spend: { name: string; usd: number; detail: string }[];
  stripEvery: number;
  generatedAt: string;
}

const pct = (v: number | null) => (v === null ? 'n/a' : `${v.toFixed(2)}%`);

export function renderReport(input: ReportInput): string {
  const { clip } = input;
  const lines: string[] = [];
  lines.push('# Probe report', '');
  lines.push(`Clip: \`${clip.file}\` (sha256 ${clip.sha256.slice(0, 12)}), ${clip.width}x${clip.height}, ${clip.frames} frames at ${clip.fps} fps after conversion to H.264 CFR.`);
  lines.push(`Generated ${input.generatedAt} by \`npm run probe\`. Read it against the table in docs/SPEC.md §9.`, '');

  lines.push('## Centroid jump, frame to frame', '');
  lines.push('As % of that frame\'s body height (person-mask bounding box). Only pairs of consecutive frames that both have a mask count.', '');
  lines.push('| Prompt | Frames with a mask | Median | p95 | Pairs | Longest gap (frames) | Median confidence | Stream |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const p of input.prompts) {
    const conf = p.medianConfidence === null ? 'n/a' : p.medianConfidence.toFixed(2);
    lines.push(`| ${p.name} | ${p.stats.framesWithMask}/${clip.frames} | ${pct(p.stats.median)} | ${pct(p.stats.p95)} | ${p.stats.pairs} | ${p.stats.longestGap} | ${conf} | ${p.outcome} |`);
  }
  lines.push('');

  lines.push('## Face-present timeline', '');
  const step = Math.max(1, Math.round(clip.fps / 6));
  lines.push(`One character per ${step} frames: \`#\` face present, \`.\` no face. Each \`|\` marks one second.`, '');
  const bar = timelineBar(input.facePresent, step);
  const perSecond = Math.round(clip.fps / step);
  lines.push('```', bar.replace(new RegExp(`(.{${perSecond}})`, 'g'), '$1|'), '```', '');
  for (const r of runs(input.facePresent)) {
    lines.push(`- frames ${r.start}-${r.end} (${((r.end - r.start + 1) / clip.fps).toFixed(1)} s): ${r.present ? 'face' : 'no face'}`);
  }
  lines.push('');

  lines.push('## Back point', '');
  if (input.backPoint) {
    const b = input.backPoint;
    lines.push(`Placed at (${b.x}, ${b.y}) on frame ${b.frame}: ${b.how}. Propagated in both directions.`);
    if (input.backHeld) {
      lines.push(`While his back was turned, the back point had a mask on ${input.backHeld.withMask} of ${input.backHeld.noFaceFrames} no-face frames.`);
    }
  } else {
    lines.push('No back point: no frame had a person mask to place it on.');
  }
  lines.push('');

  lines.push("## Wonder's facing labels", '');
  if (input.wonder) {
    if (input.wonder.note) lines.push(input.wonder.note, '');
    lines.push('| Frame | Wonder says | Confidence | Face track at that frame |', '|---|---|---|---|');
    for (const l of input.wonder.labels) {
      lines.push(`| ${l.frame} | ${l.facing} | ${l.confidence.toFixed(2)} | ${input.facePresent[l.frame] ? 'face' : 'no face'} |`);
    }
  } else {
    lines.push('Not run.');
  }
  lines.push('');

  lines.push('## Strip', '');
  lines.push(`\`fixtures/probe/strip.png\`: every ${input.stripEvery}th frame, numbered. Blue is \`person\`, yellow is \`face\`, magenta is the back point's track; the white cross is where the back point was placed.`, '');

  lines.push('## Spend', '');
  lines.push('| Call | USD | Billed |', '|---|---|---|');
  let total = 0;
  for (const s of input.spend) {
    total += s.usd;
    lines.push(`| ${s.name} | $${s.usd.toFixed(4)} | ${s.detail} |`);
  }
  lines.push(`| **Total** | **$${total.toFixed(4)}** | |`, '');
  return lines.join('\n');
}
