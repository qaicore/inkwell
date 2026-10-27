import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Conversion,
  EncodedPacket,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  VideoSampleSink,
  canEncodeVideo,
  type InputVideoTrack,
} from 'mediabunny';

// Every clip is converted to H.264 at a constant 30 fps before anything else
// touches it, so frame N here will be frame N in SAM's masks later. Long
// clips keep their first 15 s; big ones shrink to 1920 px on the long side.
export const FPS = 30;
const MAX_SECONDS = 15;
const MAX_SIDE = 1920;

export type Clip = {
  name: string;
  file: Blob; // the converted MP4, the file SAM will get
  input: Input; // reads `file`
  track: InputVideoTrack;
  width: number;
  height: number;
  frameCount: number;
  start: number; // timestamp of frame 0, in seconds
};

export async function loadClip(source: Blob, name: string, onProgress: (progress: number) => void): Promise<Clip> {
  const file = await convert(source, onProgress);
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('the converted clip has no video');
  const { packetCount } = await track.computePacketStats();
  return {
    name,
    file,
    input,
    track,
    width: await track.getDisplayWidth(),
    height: await track.getDisplayHeight(),
    frameCount: packetCount,
    start: await track.getFirstTimestamp(),
  };
}

// Frame i is on screen from start + i/30 to start + (i+1)/30. Asking for the
// middle of that window means rounding never lands on the frame before.
export function frameTime(clip: Clip, i: number) {
  return clip.start + (i + 0.5) / FPS;
}

// The time of every frame from `from` to the end, for reading frames in order.
export function* frameTimes(clip: Clip, from = 0) {
  for (let i = from; i < clip.frameCount; i++) yield frameTime(clip, i);
}

// What the converted clip will be: its size, the stretch of the source it
// covers, and the source time each of its frames is taken from.
type Plan = { width: number; height: number; start: number; end: number; times: number[] };

async function convert(source: Blob, onProgress: (progress: number) => void): Promise<Blob> {
  const input = new Input({ source: new BlobSource(source), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('that file has no video');
    if (!(await track.canDecode())) throw new Error(`this browser can't decode ${track.codec ?? 'its'} video`);

    const scale = Math.min(1, MAX_SIDE / Math.max(await track.getDisplayWidth(), await track.getDisplayHeight()));
    const width = even((await track.getDisplayWidth()) * scale);
    const height = even((await track.getDisplayHeight()) * scale);
    const start = Math.max(0, await track.getFirstTimestamp());
    // The video's own length, not the file's: a longer audio track would
    // otherwise add frozen frames at the end.
    const videoEnd = Math.min(await track.computeDuration(), start + MAX_SECONDS);
    const frameCount = Math.max(1, Math.floor((videoEnd - start) * FPS + 1e-6));
    const end = start + frameCount / FPS;
    if (!(await canEncodeVideo('avc', { width, height }))) throw new Error("this browser can't encode H.264");
    // Mediabunny's own frame-rate option rounds some frame times down a slot
    // (8.2 * 30 is 245.99999... in floating point), dropping one frame and
    // doubling the next. Instead, frame i is whatever the source shows at the
    // middle of its 1/30 s slot.
    const times = Array.from({ length: frameCount }, (_, i) => start + (i + 0.5) / FPS);
    const plan: Plan = { width, height, start, end, times };

    // The fast way can't rotate, so clips a phone stored sideways (with a
    // rotation flag) go the slow way, which bakes the rotation into the pixels.
    // Firefox's H.264 encoder needs fixes Mediabunny applies only on the slow
    // way, so it always takes that.
    const upright = (await track.getRotation()) === 0 && !(await track.getFlip());
    if (upright && !navigator.userAgent.includes('Firefox')) {
      try {
        return await retryInSoftware((hardwareAcceleration) =>
          writeMp4(input, plan, straightToEncoder(track, plan, hardwareAcceleration, onProgress)),
        );
      } catch (err) {
        if (err instanceof AudioError) throw err; // the slow way would fail the same way
        console.warn("The fast conversion didn't work in this browser; using the slower one.", err);
      }
    }
    return await retryInSoftware((hardwareAcceleration) =>
      writeMp4(input, plan, throughCanvas(track, plan, hardwareAcceleration, onProgress)),
    );
  } finally {
    input.dispose();
  }
}

// Writes the converted MP4. `addVideo` adds the video track and returns the
// function that fills it. The audio goes through a conversion of its own into
// the same file: copied as it is, or re-encoded if MP4 can't hold it.
async function writeMp4(input: Input, plan: Plan, addVideo: (output: Output) => () => Promise<void>) {
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const writeVideo = addVideo(output);
  const audio = await Conversion.init({
    input,
    output,
    tracks: 'primary',
    composable: true,
    video: { discard: true },
    trim: { start: plan.start, end: plan.end },
    showWarnings: false,
  });
  try {
    await output.start();
    const audioDone = audio.execute().catch((err) => {
      throw new AudioError(`the audio couldn't be converted: ${err instanceof Error ? err.message : err}`, { cause: err });
    });
    audioDone.catch(() => {}); // awaited below; don't report it twice
    // If the audio fails, stop the video work too rather than finish it.
    await Promise.race([writeVideo(), audioDone.then(() => new Promise<never>(() => {}))]);
    await audioDone;
    await output.finalize();
    return new Blob([output.target.buffer!], { type: 'video/mp4' });
  } catch (err) {
    await audio.cancel();
    await output.cancel();
    throw err;
  }
}

// The fast way: decoded frames go straight to the H.264 encoder, which
// shrinks them itself. Without a GPU, drawing a 4K frame onto a canvas to
// shrink it takes about 125 ms; this takes about 20 ms a frame, all in.
function straightToEncoder(
  track: InputVideoTrack,
  plan: Plan,
  hardwareAcceleration: 'no-preference' | 'prefer-software',
  onProgress: (progress: number) => void,
) {
  return (output: Output) => {
    const video = new EncodedVideoPacketSource('avc');
    output.addVideoTrack(video, { frameRate: FPS });
    return async () => {
      // The first error the encoder or the muxer reports. Later errors (say,
      // encode() on the closed encoder) are only its echoes.
      let failure: Error | null = null;
      let fail!: (err: Error) => void;
      const failed = new Promise<never>((_, reject) => {
        fail = (err) => {
          failure ??= err;
          reject(failure);
        };
      });
      failed.catch(() => {}); // raced below
      let written = Promise.resolve();
      const { width, height } = plan;
      const encoder = new VideoEncoder({
        output: (chunk, meta) => {
          // An encoder that won't shrink frames (Safari may not) keeps the
          // source size; then this way can't work, so stop and fall back.
          const config = meta?.decoderConfig;
          if (config?.codedWidth && (Math.abs(config.codedWidth - width) > 16 || Math.abs(config.codedHeight! - height) > 16)) {
            fail(new Error(`the encoder kept the source size (${config.codedWidth}x${config.codedHeight})`));
            return;
          }
          written = written.then(() => video.add(EncodedPacket.fromEncodedChunk(chunk), meta));
          written.catch(fail);
        },
        error: fail,
      });
      encoder.configure({
        codec: avcCodec(width, height),
        width,
        height,
        // About what Mediabunny's 'high' quality picks at 1080p; small clips
        // need more bits per pixel, hence the floor.
        bitrate: Math.max(2e6, Math.round(width * height * FPS * 0.1)),
        framerate: FPS,
        hardwareAcceleration,
        avc: { format: 'avc' },
      });
      // Older Safari has no dequeue event; there, look again every 20 ms.
      const canWait = 'ondequeue' in encoder;
      const roomInQueue = () =>
        Promise.race([
          canWait ? new Promise((resolve) => encoder.addEventListener('dequeue', resolve, { once: true })) : failed,
          new Promise((resolve) => setTimeout(resolve, canWait ? 1000 : 20)),
          failed,
        ]);
      try {
        const frames = new VideoSampleSink(track);
        let i = 0;
        for await (const sample of frames.samplesAtTimestamps(plan.times)) {
          if (!sample) throw new Error(`no frame at ${plan.times[i].toFixed(3)} s`);
          const decoded = sample.toVideoFrame();
          const frame = new VideoFrame(decoded, { timestamp: Math.round((i * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
          decoded.close();
          sample.close();
          try {
            encoder.encode(frame, { keyFrame: i % (2 * FPS) === 0 }); // a key frame every 2 s, for seeking
          } catch (err) {
            throw failure ?? err;
          } finally {
            frame.close();
          }
          i++;
          onProgress(i / plan.times.length);
          while (encoder.encodeQueueSize > 4) await roomInQueue();
        }
        await Promise.race([encoder.flush(), failed]);
        await written;
      } finally {
        if (encoder.state !== 'closed') encoder.close();
      }
    };
  };
}

// The slow way, for clips that need rotating or browsers whose encoder won't
// shrink frames: each frame is drawn onto a canvas at the new size, and the
// canvas sink applies the rotation as it does.
function throughCanvas(
  track: InputVideoTrack,
  plan: Plan,
  hardwareAcceleration: 'no-preference' | 'prefer-software',
  onProgress: (progress: number) => void,
) {
  return (output: Output) => {
    const { width, height } = plan;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    const video = new CanvasSource(canvas, { codec: 'avc', quality: new Quality('high'), hardwareAcceleration });
    output.addVideoTrack(video, { frameRate: FPS });
    return async () => {
      const frames = new CanvasSink(track, { width, height, fit: 'fill', poolSize: 2 });
      let i = 0;
      for await (const wrapped of frames.canvasesAtTimestamps(plan.times)) {
        if (wrapped) ctx.drawImage(wrapped.canvas, 0, 0, width, height);
        await video.add(i / FPS, 1 / FPS);
        i++;
        onProgress(i / plan.times.length);
      }
    };
  };
}

// The H.264 codec string for this size: High profile, at level 4.0 if the
// frame fits (1080p and below) and 5.1 if not.
function avcCodec(width: number, height: number) {
  const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
  return macroblocks <= 8192 ? 'avc1.640028' : 'avc1.640033';
}

// A failure in the audio. Re-encoding the video can't fix it, so it's never
// retried.
class AudioError extends Error {}

// Chromium sometimes fails to start its H.264 encoder the first time a page
// uses it ("Unsupported configuration parameters"). If an encode fails, run
// it once more on the software encoder.
export async function retryInSoftware<T>(
  run: (hardwareAcceleration: 'no-preference' | 'prefer-software') => Promise<T>,
): Promise<T> {
  try {
    return await run('no-preference');
  } catch (err) {
    if (err instanceof AudioError) throw err;
    console.warn('Encoding failed; trying again with the software encoder.', err);
    return await run('prefer-software');
  }
}

// H.264 needs even dimensions.
function even(n: number) {
  return Math.max(2, Math.round(n / 2) * 2);
}
