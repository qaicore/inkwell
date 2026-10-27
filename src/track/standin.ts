import { FilesetResolver, PoseLandmarker, type MPMask, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import { CanvasSink } from 'mediabunny';
import { FPS, frameTimes, type Clip } from '../video/clip';
import { followMask, followPoints, maskHasPerson, type Mask, type PointSet, type Tracking } from './tracking';

// DEV ONLY: a stand-in for SAM 3.1, so everything after tracking can be built
// and tested before SAM is connected. MediaPipe's pose model runs in the
// browser and finds a person mask and body landmarks on every frame. main.ts
// only loads this file in dev, so it never ships. Delete it once SAM is in.

const WASM = '/node_modules/@mediapipe/tasks-vision/wasm';
const MODEL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task';
const MASK_SIDE = 384; // long side of the frames the model sees; its masks come back the same size

// The landmarks that move with the body rather than the arms and legs: the
// head (nose, eyes, ears, mouth), the shoulders and the hips.
const CORE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 23, 24];
const TORSO = { shoulders: [11, 12], hips: [13, 14] }; // their places in CORE

export type StandIn = { masks: (Mask | null)[]; bodies: (PointSet | null)[] };
export type FollowMode = 'points' | 'mask';

// Runs the pose model over every frame: in the browser if it can, otherwise
// (no WebGL 2, or the model fails there) on the dev server in Python.
// `report` gets progress messages for the status line.
export async function runStandIn(clip: Clip, report: (message: string) => void): Promise<StandIn> {
  const fit = MASK_SIDE / Math.max(clip.width, clip.height);
  const width = Math.round(clip.width * fit);
  const height = Math.round(clip.height * fit);
  const problem = webgl2Problem();
  if (problem) {
    console.info(`No WebGL 2 for the stand-in (${problem}); tracking on the dev server instead.`);
    return runOnDevServer(clip, width, height, 'No WebGL 2 in this browser', report);
  }
  try {
    return await runInBrowser(clip, width, height, report);
  } catch (err) {
    // Phones are where this is most likely: too little memory, a model the
    // GPU can't run, or masks that can't be read back from it.
    console.warn("The stand-in couldn't run in this browser; tracking on the dev server instead.", err);
    return runOnDevServer(clip, width, height, "The model didn't work in this browser", report);
  }
}

async function runInBrowser(clip: Clip, width: number, height: number, report: (message: string) => void) {
  const landmarker = await createLandmarker();
  try {
    const sink = new CanvasSink(clip.track, { width, height, fit: 'fill', poolSize: 2 });
    const masks: (Mask | null)[] = new Array(clip.frameCount).fill(null);
    const bodies: (PointSet | null)[] = new Array(clip.frameCount).fill(null);
    let i = 0;
    for await (const wrapped of sink.canvasesAtTimestamps(frameTimes(clip))) {
      if (wrapped) {
        // The callback runs before detectForVideo returns, and its masks are
        // only valid inside it, so copy what's needed out right there.
        landmarker.detectForVideo(wrapped.canvas, Math.round((i * 1000) / FPS), (result) => {
          const body = result.landmarks[0];
          const mask = result.segmentationMasks?.[0];
          bodies[i] = body ? toPointSet(body, clip.width, clip.height) : null;
          masks[i] = mask ? toMask(mask) : null;
        });
      }
      i++;
      report(`Tracking with the stand-in… ${Math.round((i / clip.frameCount) * 100)}%`);
    }
    // Some GPUs (phones especially) hand back blank masks while the body
    // points are fine. Without masks nothing can go behind the person, so
    // treat that as a failure and let the dev server do it.
    const found = bodies.filter(Boolean).length;
    const masked = masks.filter((mask) => mask && maskHasPerson(mask)).length;
    if (found > 0 && masked < found / 10) throw new Error(`person masks came back empty (${masked} of ${found} frames)`);
    return { masks, bodies };
  } finally {
    landmarker.close();
  }
}

// The dev server runs the same model in Python (tools/standin.py) on the
// converted clip. `why` says, on the status line, why it's being used.
async function runOnDevServer(
  clip: Clip,
  width: number,
  height: number,
  why: string,
  report: (message: string) => void,
) {
  const startedAt = performance.now();
  const tick = () => {
    const seconds = Math.round((performance.now() - startedAt) / 1000);
    report(`${why}, so the dev server is tracking in Python… ${seconds} s`);
  };
  tick();
  const timer = setInterval(tick, 1000);
  try {
    const sizes = { width: clip.width, height: clip.height, maskWidth: width, maskHeight: height };
    const query = new URLSearchParams(Object.entries(sizes).map(([key, value]) => [key, String(value)]));
    const response = await fetch(`/__standin?${query}`, { method: 'POST', body: clip.file });
    if (!response.ok) throw new Error(`the dev server couldn't run it: ${await response.text()}`);
    return readDevServerReply(new Uint8Array(await response.arrayBuffer()), clip.frameCount, width, height);
  } finally {
    clearInterval(timer);
  }
}

type DevServerHeader = { bodies: ({ x: number[]; y: number[]; c: number[] } | null)[]; hasMask: boolean[] };

// The reply is a 4-byte header length, a JSON header (each frame's body points
// in clip pixels, and whether it has a mask), then every frame's mask.
function readDevServerReply(bytes: Uint8Array, frameCount: number, width: number, height: number): StandIn {
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
  const header: DevServerHeader = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headerLength)));
  const size = width * height;
  const start = 4 + headerLength;
  if (bytes.length !== start + header.hasMask.length * size) throw new Error('the dev server sent back a broken reply');
  // Pad to the clip's length, in case the server decoded a frame fewer.
  const frames = Array.from({ length: frameCount }, (_, i) => i);
  return {
    bodies: frames.map((i) => {
      const body = header.bodies[i];
      if (!body) return null;
      return { x: Float32Array.from(body.x), y: Float32Array.from(body.y), confidence: Float32Array.from(body.c) };
    }),
    masks: frames.map((i) =>
      header.hasMask[i]
        ? { width, height, alpha: new Uint8ClampedArray(bytes.buffer, bytes.byteOffset + start + i * size, size) }
        : null,
    ),
  };
}

// Tracking from the stand-in's results. 'points' follows the body landmarks
// near each stroke's root; 'mask' uses only the person mask, the way SAM's
// "person" prompt would.
export function standInTracking(standIn: StandIn, mode: FollowMode, clip: Clip): Tracking {
  return {
    label: mode === 'points' ? 'stand-in, body points' : 'stand-in, body mask',
    masks: standIn.masks,
    follow: (root, frame) => {
      if (mode === 'mask') return followMask(standIn.masks, root, frame, clip.width, clip.height);
      const start = standIn.bodies[frame];
      const torso = start ? torsoLength(start) : null;
      const reach = 0.35 * (torso ?? clip.height / 4);
      return followPoints(standIn.bodies, root, frame, reach, torsoLength);
    },
  };
}

async function createLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks(WASM);
  const create = (delegate: 'GPU' | 'CPU') =>
    PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL, delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
      outputSegmentationMasks: true,
    });
  try {
    return await create('GPU');
  } catch (err) {
    console.warn('MediaPipe could not use the GPU; using the CPU.', err);
    return create('CPU');
  }
}

// MediaPipe reads every frame in through WebGL, even when it runs the model
// on the CPU. This says why the page can't get WebGL 2 (in the browser's own
// words, from the event it fires while getContext runs), or null if it can.
function webgl2Problem(): string | null {
  const canvas = document.createElement('canvas');
  let reason = 'no reason given';
  canvas.addEventListener('webglcontextcreationerror', (e) => {
    reason = (e as WebGLContextEvent).statusMessage || reason;
  });
  return canvas.getContext('webgl2') ? null : reason;
}

function toPointSet(landmarks: NormalizedLandmark[], width: number, height: number): PointSet {
  const set = {
    x: new Float32Array(CORE.length),
    y: new Float32Array(CORE.length),
    confidence: new Float32Array(CORE.length),
  };
  CORE.forEach((index, i) => {
    set.x[i] = landmarks[index].x * width;
    set.y[i] = landmarks[index].y * height;
    set.confidence[i] = landmarks[index].visibility ?? 1;
  });
  return set;
}

// The model's mask fades out slowly, and scaled up to the clip that fade
// shows strokes through the person's edges as a pink haze. Keep only a
// narrow band around the halfway mark soft.
function toMask(mask: MPMask): Mask {
  const values = mask.getAsFloat32Array();
  const alpha = new Uint8ClampedArray(values.length);
  for (let i = 0; i < values.length; i++) alpha[i] = ((values[i] - 0.45) / 0.1) * 255;
  return { width: mask.width, height: mask.height, alpha };
}

// Shoulder midpoint to hip midpoint: how big the body is on this frame, and
// it doesn't shrink when the person turns side-on the way shoulder width does.
function torsoLength(set: PointSet): number | null {
  const sure = [...TORSO.shoulders, ...TORSO.hips].every((i) => set.confidence[i] > 0.5);
  if (!sure) return null;
  const mid = (pair: number[]) => [(set.x[pair[0]] + set.x[pair[1]]) / 2, (set.y[pair[0]] + set.y[pair[1]]) / 2];
  const [sx, sy] = mid(TORSO.shoulders);
  const [hx, hy] = mid(TORSO.hips);
  return Math.hypot(sx - hx, sy - hy);
}
