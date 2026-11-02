// The export: the clip re-encoded with every frame drawn by the app, H.264 at
// a constant 30 fps, 720p on an iPhone and up to 1080p elsewhere (impact design
// §10), and the flash check on every export (impact design §5, decision 5):
//   - Each finished frame is copied down to 160 px wide as it's encoded
//     (flash.ts's downsampleFrame), and checkFlashes reads the copies.
//   - Full flashing, the default: a fail changes nothing. The export sheet
//     shows the plain warning beside the Reduce flashing toggle.
//   - Reduce flashing: on a fail, the ladder's steps 1..7 in order
//     (impact/ladder.ts), each re-rendering only the frames it touches, until
//     the check passes; then the clip is encoded again at that step. Step 4 is
//     the freeze: the clip held at I under the posters, the video 26 frames
//     longer, and 26 frames (0.867 s) of silence spliced into the audio after
//     I + 9. If step 7 still fails, or a clip with no slam fails at all, what
//     flashes is beyond the ladder (the footage, or what the ladder doesn't
//     touch): the export throws FlashCheckError and saves nothing.
// The audio is copied across as is, except under the freeze, where it's
// re-encoded with the silence in.
import { AudioSample, BufferTarget, CanvasSink, Conversion, Mp4OutputFormat, Output, Quality, VideoSample } from 'mediabunny';
import { FPS, frameTime, retryInSoftware, type Clip } from '../video/clip';
import { checkFlashes, downsampleFrame, FlashCheckError, flashSummary, guardRed, type CheckFrame, type FlashReport } from './flash';
import { FREEZE_EXTRA, FREEZE_HOLD, POSTER_COUNT } from '../impact/clock';
import { clipOf, degradeAt, LADDER_STEPS, outputLength, touchedFrames, type Degrade, type LadderWalk } from '../impact/ladder';

export type DrawFrame = (ctx: CanvasRenderingContext2D, image: CanvasImageSource, frame: number) => void;

// What the export draws: output frame o at ladder step `step`, into a canvas
// the export's size, over `image`, the clip frame under it (ladder.ts's clipOf).
export interface ExportPlan {
  width: number; // the export's size, even (exportSize)
  height: number;
  I: number | null; // the contact frame; null without a slam
  flash: 'safe' | 'full'; // the Reduce flashing toggle ('safe'), slam or not: the slam's frames.flash when there is one
  draw(ctx: CanvasRenderingContext2D, image: CanvasImageSource, o: number, step: number): void;
}

export interface ExportResult {
  video: Blob;
  frames: number; // output frames
  step: number; // the ladder step it was encoded at; 0 under full flashing
  report: FlashReport; // that step's check
  warning: string | null; // full flashing's plain warning, when the check failed
  notes: string[]; // what didn't go as asked: the sound dropped, say
}

// 720p on an iPhone, 1080p elsewhere, never above the clip's own size.
export const EXPORT_LONG_SIDE = { iphone: 1280, other: 1920 } as const;
export const isIPhone = (userAgent: string) => /\biPhone\b/.test(userAgent);

export function exportSize(width: number, height: number, iphone: boolean): { width: number; height: number; long: number } {
  const long = Math.min(Math.max(width, height), iphone ? EXPORT_LONG_SIDE.iphone : EXPORT_LONG_SIDE.other);
  const s = long / Math.max(width, height);
  const even = (v: number) => Math.max(2, 2 * Math.floor(v / 2 + 1e-9)); // H.264 needs even sides
  return { width: even(width * s), height: even(height * s), long };
}

// Encodes the clip once at step 0, checking it on the way. Under Reduce
// flashing a fail walks the ladder, and the clip is encoded again at the step
// that passed.
export async function exportClip(clip: Clip, plan: ExportPlan, onProgress: (progress: number, what: string) => void): Promise<ExportResult> {
  const first = await encode(clip, plan, 0, true, (p) => onProgress(p, 'Exporting'));
  const walk = await walkFlashLadder({
    frames: clip.frameCount,
    I: plan.I,
    flash: plan.flash,
    first: first.copies,
    render: (step, from, to) => renderCopies(clip, plan, step, from, to),
    onStep: (step) => onProgress((step - 1) / LADDER_STEPS, `Reducing flashing, step ${step} of ${LADDER_STEPS}`),
  });
  if (walk.step === 0) return { video: first.video, frames: first.frames, step: 0, report: walk.report, warning: walk.pass ? null : flashSummary(walk.report), notes: first.notes };
  const last = await encode(clip, plan, walk.step, false, (p) => onProgress(p, `Exporting with reduced flashing (step ${walk.step})`));
  return { video: last.video, frames: last.frames, step: walk.step, report: walk.report, warning: null, notes: last.notes };
}

// ---- The ladder ------------------------------------------------------------------------------

export interface LadderIO {
  frames: number; // the clip's
  I: number | null;
  flash: 'safe' | 'full';
  first?: readonly CheckFrame[]; // step 0's copies, when the encode made them
  render(step: number, from: number, to: number): Promise<CheckFrame[]> | CheckFrame[]; // output frames [from, to) at `step`, as check copies
  check?: (frames: readonly CheckFrame[], fps: number) => FlashReport; // missing = checkFlashes
  onStep?(step: number): void;
}

// The ladder walk, as ladder.ts's walkLadder, with each step re-rendering only
// the frames touchedFrames lists and keeping the rest from the step before.
// Under full flashing only step 0 is checked. Under Reduce flashing a walk
// that ends without a pass throws FlashCheckError; without a slam there's no
// ladder to walk, so a fail throws at once.
export async function walkFlashLadder(io: LadderIO): Promise<LadderWalk> {
  const check = io.check ?? checkFlashes;
  const lengthAt = (step: number) => outputLength(io.frames, io.I, degradeAt(step, io.flash));
  const flashesAnyway = (report: FlashReport) => new FlashCheckError(report, `Reduce flashing can't bring this video under 3 flashes a second, so nothing was saved. ${flashSummary(report)}`);
  let copies: CheckFrame[] = io.first ? [...io.first] : await io.render(0, 0, lengthAt(0));
  let report = check(copies, FPS);
  const reports = [report];
  if (report.pass || io.flash === 'full') return { step: 0, pass: report.pass, report, reports };
  if (io.I === null) throw flashesAnyway(report);
  for (let step = 1; step <= LADDER_STEPS; step++) {
    io.onStep?.(step);
    const length = lengthAt(step);
    const { from, to } = touchedFrames(step, io.I, length);
    const fresh = from < to ? await io.render(step, from, to) : [];
    copies = [...copies.slice(0, from), ...fresh, ...copies.slice(to, length)];
    report = check(copies, FPS);
    reports.push(report);
    if (report.pass) return { step, pass: true, report, reports };
  }
  throw flashesAnyway(report);
}

// ---- The freeze's frames and sound --------------------------------------------------------------

// The output frames that show clip frame c, in order: c itself, or under the
// freeze 35 frames for I, none for I + 1..I + 8, and c + 26 from I + 9 on.
export function outputsOf(c: number, I: number | null, d: Degrade): number[] {
  if (!d.freeze || I === null || c < I) return [c];
  if (c === I) return Array.from({ length: POSTER_COUNT * FREEZE_HOLD }, (_, n) => I + n);
  return clipOf(c + FREEZE_EXTRA, I, d) === c ? [c + FREEZE_EXTRA] : [];
}

// The freeze's silence: the sound plays to I + 9, stops for 26 frames, then
// resumes from I + 9. Null without the freeze.
export interface AudioPlan {
  at: number; // seconds after the clip's first frame where the silence goes in: (I + 9)/30
  gap: number; // seconds of silence: 26/30
}

export function audioPlan(I: number | null, d: Degrade): AudioPlan | null {
  if (!d.freeze || I === null) return null;
  return { at: (I + POSTER_COUNT * FREEZE_HOLD - FREEZE_EXTRA) / FPS, gap: FREEZE_EXTRA / FPS };
}

export type AudioSegment =
  | { kind: 'audio'; from: number; to: number; timestamp: number } // the input sample's frames [from, to), at a new timestamp
  | { kind: 'silence'; frames: number; timestamp: number };

// What one decoded audio sample becomes under the plan: kept as it is before
// the cut, 26 frames later after it, split where it straddles it, with the
// silence put in once, at the cut. `t0` is the clip's first frame on the
// sound's timeline; `inserted` says the silence is in already.
export function spliceAudio(sample: { timestamp: number; numberOfFrames: number; sampleRate: number }, plan: AudioPlan, t0: number, inserted: boolean): AudioSegment[] {
  const cut = t0 + plan.at;
  const n = sample.numberOfFrames;
  const rate = sample.sampleRate;
  if (sample.timestamp + n / rate <= cut) return [{ kind: 'audio', from: 0, to: n, timestamp: sample.timestamp }];
  const k = Math.min(n, Math.max(0, Math.round((cut - sample.timestamp) * rate)));
  const out: AudioSegment[] = [];
  if (k > 0) out.push({ kind: 'audio', from: 0, to: k, timestamp: sample.timestamp });
  if (!inserted) out.push({ kind: 'silence', frames: Math.round(plan.gap * rate), timestamp: cut });
  if (k < n) out.push({ kind: 'audio', from: k, to: n, timestamp: sample.timestamp + k / rate + plan.gap });
  return out;
}

// ---- Encoding ----------------------------------------------------------------------------------

function canvasOf(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return { canvas, ctx: canvas.getContext('2d')! };
}

const checkCopy = (ctx: CanvasRenderingContext2D, width: number, height: number): CheckFrame => downsampleFrame(ctx.getImageData(0, 0, width, height));

// A drawn frame made final: under Reduce flashing the red guard (flash.ts) on
// its pixels, then, with `collect`, its check copy, from the same read.
// Exported for the unit tests (app-flow.test.ts), which stub the canvas.
export function finish(ctx: CanvasRenderingContext2D, width: number, height: number, flash: 'safe' | 'full', collect: boolean): CheckFrame | null {
  if (flash !== 'safe') return collect ? checkCopy(ctx, width, height) : null;
  const img = ctx.getImageData(0, 0, width, height);
  if (guardRed(img.data) > 0) ctx.putImageData(img, 0, 0);
  return collect ? downsampleFrame(img) : null;
}

// One encode at `step`, every output frame drawn by the plan, and with
// `collect` each one's check copy.
async function encode(clip: Clip, plan: ExportPlan, step: number, collect: boolean, onProgress: (progress: number) => void): Promise<{ video: Blob; frames: number; copies: CheckFrame[]; notes: string[] }> {
  const d = degradeAt(step, plan.flash);
  const frames = outputLength(clip.frameCount, plan.I, d);
  const silence = audioPlan(plan.I, d);
  const { width, height } = plan;
  const frameBuffer = canvasOf(width, height); // the untouched video frame, at the export's size
  const out = canvasOf(width, height); // the finished frame

  return retryInSoftware(async (hardwareAcceleration) => {
    const copies: CheckFrame[] = [];
    let firstTimestamp: number | null = null;
    let inserted = false;
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
    const conversion = await Conversion.init({
      input: clip.input,
      output,
      tracks: 'primary',
      video: {
        codec: 'avc',
        // No frameRate option: the clip is already exactly 30 fps, and that
        // option's rounding would drop a frame here and there.
        quality: new Quality('high'),
        hardwareAcceleration,
        // Called once per clip frame, in order. Mediabunny copies a canvas
        // returned as soon as this returns, so the same one is reused every
        // frame; the freeze's frames are each copied into a sample of its own.
        process: (sample) => {
          firstTimestamp ??= sample.timestamp;
          const c = Math.round((sample.timestamp - firstTimestamp) * FPS);
          const outputs = outputsOf(c, plan.I, d);
          if (outputs.length === 0) return null;
          sample.draw(frameBuffer.ctx, 0, 0, width, height);
          const made: VideoSample[] = [];
          for (const o of outputs) {
            plan.draw(out.ctx, frameBuffer.canvas, o, step);
            const copy = finish(out.ctx, width, height, plan.flash, collect);
            if (copy) copies[o] = copy;
            if (outputs.length === 1 && o === c) return out.canvas;
            made.push(new VideoSample(out.canvas, { timestamp: firstTimestamp + o / FPS, duration: 1 / FPS }));
          }
          return made;
        },
        processedWidth: width,
        processedHeight: height,
      },
      audio: silence
        ? {
            process: (sample) =>
              spliceAudio(sample, silence, firstTimestamp ?? 0, inserted).map((seg) => {
                if (seg.kind === 'silence') {
                  inserted = true;
                  const data = new Float32Array(seg.frames * sample.numberOfChannels);
                  return new AudioSample({ data, format: 'f32-planar', numberOfChannels: sample.numberOfChannels, sampleRate: sample.sampleRate, timestamp: seg.timestamp });
                }
                const piece = seg.from === 0 && seg.to === sample.numberOfFrames ? sample.clone() : sample.trim(seg.from, seg.to);
                piece.setTimestamp(seg.timestamp);
                return piece;
              }),
          }
        : undefined,
      showWarnings: false,
    });
    if (!conversion.utilizedTracks.some((t) => t.type === 'video')) {
      const why = conversion.discardedTracks.map((dt) => `${dt.track.type}: ${dt.reason}`).join(', ');
      throw new Error(`can't encode H.264 in this browser (${why})`);
    }
    const notes = conversion.discardedTracks
      .filter((dt) => dt.track.type === 'audio' && (dt.reason === 'undecodable_source_codec' || dt.reason === 'no_encodable_target_codec'))
      .map((dt) => `no sound: this browser can't ${silence ? 're-encode it for the freeze' : 'copy it'} (${dt.reason})`);
    conversion.onProgress = onProgress;
    await conversion.execute();
    // A frame the decoder skipped keeps the one before it, so the check still
    // sees every output frame.
    for (let o = 0; collect && o < frames; o++) copies[o] ??= copies[o - 1] ?? checkCopy(out.ctx, width, height);
    return { video: new Blob([output.target.buffer!], { type: 'video/mp4' }), frames, copies, notes };
  });
}

// The check copies of output frames [from, to) at `step`, for the ladder: the
// clip frames under them decoded again, at the export's size.
async function renderCopies(clip: Clip, plan: ExportPlan, step: number, from: number, to: number): Promise<CheckFrame[]> {
  const d = degradeAt(step, plan.flash);
  const { width, height } = plan;
  const out = canvasOf(width, height);
  const sink = new CanvasSink(clip.track, { width, height, fit: 'fill', poolSize: 1 });
  const outputs = Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);
  const times = outputs.map((o) => frameTime(clip, Math.min(clip.frameCount - 1, clipOf(o, plan.I, d))));
  const copies: CheckFrame[] = [];
  let i = 0;
  for await (const wrapped of sink.canvasesAtTimestamps(times)) {
    const o = outputs[i++];
    if (wrapped) {
      plan.draw(out.ctx, wrapped.canvas, o, step);
      copies.push(finish(out.ctx, width, height, plan.flash, true)!);
    } else copies.push(checkCopy(out.ctx, width, height));
  }
  return copies;
}
