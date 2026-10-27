import { BufferTarget, Conversion, Mp4OutputFormat, Output, Quality } from 'mediabunny';
import { FPS, retryInSoftware, type Clip } from './clip';

export type DrawFrame = (ctx: CanvasRenderingContext2D, image: CanvasImageSource, frame: number) => void;

// Re-encodes the clip with `drawFrame` making every frame: H.264 at a
// constant 30 fps, same size as the clip. The audio is copied across as is.
export async function exportClip(clip: Clip, drawFrame: DrawFrame, onProgress: (progress: number) => void): Promise<Blob> {
  const frameCanvas = document.createElement('canvas'); // the untouched video frame
  const out = document.createElement('canvas'); // the finished frame
  for (const canvas of [frameCanvas, out]) {
    canvas.width = clip.width;
    canvas.height = clip.height;
  }
  const frameCtx = frameCanvas.getContext('2d')!;
  const outCtx = out.getContext('2d')!;

  return retryInSoftware(async (hardwareAcceleration) => {
    let firstTimestamp: number | null = null;
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
        // Called once per frame, in order. Mediabunny copies the canvas as
        // soon as this returns, so the same canvas is reused every frame.
        process: (sample) => {
          firstTimestamp ??= sample.timestamp;
          const frame = Math.round((sample.timestamp - firstTimestamp) * FPS);
          sample.draw(frameCtx, 0, 0, clip.width, clip.height);
          drawFrame(outCtx, frameCanvas, frame);
          return out;
        },
        processedWidth: clip.width,
        processedHeight: clip.height,
      },
      showWarnings: false,
    });
    if (!conversion.utilizedTracks.some((t) => t.type === 'video')) {
      const why = conversion.discardedTracks.map((d) => `${d.track.type}: ${d.reason}`).join(', ');
      throw new Error(`can't encode H.264 in this browser (${why})`);
    }
    conversion.onProgress = onProgress;
    await conversion.execute();
    return new Blob([output.target.buffer!], { type: 'video/mp4' });
  });
}
