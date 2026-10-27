// Drawing for the probe's pictures, straight on RGB buffers (ffmpeg has
// already scaled the frames): tinting a mask over a frame, frame numbers in
// a blocky digit font, a marker for the back point, and tiling cells into
// one strip.
import { createImage, type RgbImage } from './png.ts';
import type { FrameMask } from './masks.ts';

export type Rgb = [number, number, number];

// Blends `color` over every pixel of `image` the mask covers. The image may
// be smaller than the source frame (`sourceWidth` x `sourceHeight`): each
// pixel samples the mask at its centre, mapped back to source pixels.
export function tintMask(image: RgbImage, mask: FrameMask, sourceWidth: number, sourceHeight: number, color: Rgb, alpha: number) {
  const { bounds } = mask;
  const sx = sourceWidth / image.width;
  const sy = sourceHeight / image.height;
  const x0 = Math.max(0, Math.floor(bounds.left / sx));
  const x1 = Math.min(image.width, Math.ceil(bounds.right / sx));
  const y0 = Math.max(0, Math.floor(bounds.top / sy));
  const y1 = Math.min(image.height, Math.ceil(bounds.bottom / sy));
  for (let y = y0; y < y1; y++) {
    const srcY = (y + 0.5) * sy;
    if (srcY < bounds.top || srcY >= bounds.bottom) continue;
    const row = Math.floor(((srcY - bounds.top) * mask.height) / (bounds.bottom - bounds.top));
    for (let x = x0; x < x1; x++) {
      const srcX = (x + 0.5) * sx;
      if (srcX < bounds.left || srcX >= bounds.right) continue;
      const col = Math.floor(((srcX - bounds.left) * mask.width) / (bounds.right - bounds.left));
      if (mask.raster[row * mask.width + col] !== 1) continue;
      const i = (y * image.width + x) * 3;
      for (let c = 0; c < 3; c++) image.data[i + c] = Math.round(image.data[i + c] * (1 - alpha) + color[c] * alpha);
    }
  }
}

export function fillRect(image: RgbImage, left: number, top: number, width: number, height: number, color: Rgb) {
  const x0 = Math.max(0, Math.floor(left));
  const y0 = Math.max(0, Math.floor(top));
  const x1 = Math.min(image.width, Math.floor(left + width));
  const y1 = Math.min(image.height, Math.floor(top + height));
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) image.data.set(color, (y * image.width + x) * 3);
}

// A plus sign with a dark outline, centred on (x, y) in image pixels.
export function drawMarker(image: RgbImage, x: number, y: number, size: number, color: Rgb) {
  const t = Math.max(1, Math.round(size / 5));
  fillRect(image, x - size - 1, y - t - 1, 2 * size + 2, 2 * t + 2, [0, 0, 0]);
  fillRect(image, x - t - 1, y - size - 1, 2 * t + 2, 2 * size + 2, [0, 0, 0]);
  fillRect(image, x - size, y - t, 2 * size, 2 * t, color);
  fillRect(image, x - t, y - size, 2 * t, 2 * size, color);
}

// 3x5 digits, one string per row, '#' = ink.
const DIGITS: Record<string, string[]> = {
  '0': ['###', '#.#', '#.#', '#.#', '###'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['###', '..#', '###', '#..', '###'],
  '3': ['###', '..#', '.##', '..#', '###'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '###', '..#', '###'],
  '6': ['###', '#..', '###', '#.#', '###'],
  '7': ['###', '..#', '.#.', '.#.', '.#.'],
  '8': ['###', '#.#', '###', '#.#', '###'],
  '9': ['###', '#.#', '###', '..#', '###'],
};

// Writes `n` at (left, top) in white on a black box, `scale` image pixels
// per font pixel. Returns the box width.
export function drawNumber(image: RgbImage, n: number, left: number, top: number, scale: number): number {
  const text = String(Math.trunc(n));
  const pad = scale;
  const width = text.length * 4 * scale - scale + 2 * pad;
  fillRect(image, left, top, width, 5 * scale + 2 * pad, [0, 0, 0]);
  [...text].forEach((ch, k) => {
    const glyph = DIGITS[ch];
    if (!glyph) return;
    glyph.forEach((line, row) => {
      [...line].forEach((cell, col) => {
        if (cell === '#') fillRect(image, left + pad + (k * 4 + col) * scale, top + pad + row * scale, scale, scale, [255, 255, 255]);
      });
    });
  });
  return width;
}

// Lays equal-size cells out in rows of `columns`, `gap` pixels apart.
export function tile(cells: RgbImage[], columns: number, gap: number, background: Rgb = [24, 24, 24]): RgbImage {
  if (cells.length === 0) throw new Error('tile: no cells');
  const { width, height } = cells[0];
  const rows = Math.ceil(cells.length / columns);
  const out = createImage(columns * width + (columns + 1) * gap, rows * height + (rows + 1) * gap, background);
  cells.forEach((cell, i) => {
    const left = gap + (i % columns) * (width + gap);
    const top = gap + Math.floor(i / columns) * (height + gap);
    for (let y = 0; y < height; y++) {
      out.data.set(cell.data.subarray(y * width * 3, (y + 1) * width * 3), ((top + y) * out.width + left) * 3);
    }
  });
  return out;
}
