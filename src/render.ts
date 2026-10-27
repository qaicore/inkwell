import { drawStroke, wobbleTick, type Stroke } from './brush';
import type { Mask, Pose } from './tracking';

// What to draw over the video, and where tracking puts it on each frame.
export type Scene = {
  strokes: Stroke[];
  wobble: boolean;
  personMask(frame: number): Mask | null; // null when there's no tracking
  pose(stroke: Stroke, frame: number): Pose | null; // null leaves a stroke where it was drawn
};

// Draws one finished frame at clip size. The preview and the export both
// draw through here, so they always match. Strokes set to "behind" go under
// the person: they're drawn on the frame first, then the person is cut out
// of the frame and laid back on top of them.
export function renderFrame(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  frame: number,
  width: number,
  height: number,
  scene: Scene,
) {
  ctx.drawImage(image, 0, 0, width, height);
  const tick = scene.wobble ? wobbleTick(frame) : null;
  const behind = scene.strokes.filter((stroke) => stroke.layer === 'behind');
  for (const stroke of behind) drawStroke(ctx, stroke, tick, scene.pose(stroke, frame));
  const mask = behind.length > 0 ? scene.personMask(frame) : null;
  if (mask) ctx.drawImage(cutOut(image, mask, width, height), 0, 0, width, height);
  for (const stroke of scene.strokes) {
    if (stroke.layer !== 'behind') drawStroke(ctx, stroke, tick, scene.pose(stroke, frame));
  }
}

// Tints the person mask, to check the tracking by eye.
export function drawMaskTint(ctx: CanvasRenderingContext2D, mask: Mask, width: number, height: number) {
  paintMask(mask);
  tint.width = mask.width;
  tint.height = mask.height;
  tintCtx.drawImage(maskCanvas, 0, 0);
  tintCtx.globalCompositeOperation = 'source-in';
  tintCtx.fillStyle = '#38e1ff';
  tintCtx.fillRect(0, 0, mask.width, mask.height);
  tintCtx.globalCompositeOperation = 'source-over';
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.drawImage(tint, 0, 0, width, height);
  ctx.restore();
}

// Scratch canvases: the mask as an image, and the person cut out of the frame.
const maskCanvas = document.createElement('canvas');
const maskCtx = maskCanvas.getContext('2d')!;
const person = document.createElement('canvas');
const personCtx = person.getContext('2d')!;
const tint = document.createElement('canvas');
const tintCtx = tint.getContext('2d')!;
let paintedMask: Mask | null = null;

// The frame's pixels wherever the mask says person, clear everywhere else.
// Made fresh every time: the preview reuses one canvas for every frame, so
// there's nothing safe to cache it on.
function cutOut(image: CanvasImageSource, mask: Mask, width: number, height: number) {
  paintMask(mask);
  if (person.width !== width || person.height !== height) {
    person.width = width;
    person.height = height;
  }
  personCtx.globalCompositeOperation = 'copy';
  personCtx.drawImage(image, 0, 0, width, height);
  personCtx.globalCompositeOperation = 'destination-in';
  personCtx.imageSmoothingQuality = 'high';
  personCtx.drawImage(maskCanvas, 0, 0, width, height);
  personCtx.globalCompositeOperation = 'source-over';
  return person;
}

// Puts the mask into maskCanvas as transparency: opaque where the person is.
function paintMask(mask: Mask) {
  if (paintedMask === mask) return;
  if (maskCanvas.width !== mask.width || maskCanvas.height !== mask.height) {
    maskCanvas.width = mask.width;
    maskCanvas.height = mask.height;
  }
  const pixels = maskCtx.createImageData(mask.width, mask.height);
  for (let i = 0; i < mask.alpha.length; i++) pixels.data[i * 4 + 3] = mask.alpha[i];
  maskCtx.putImageData(pixels, 0, 0);
  paintedMask = mask;
}
