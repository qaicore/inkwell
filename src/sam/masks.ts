// SAM 3.1 video output -> one mask per frame, and the numbers the probe and
// the app read from each mask. SAM streams one text line per frame; each record
// is an object id, a box and a base85 mask whose raster covers the box (at
// the raster's own resolution). @meta-sam/parser reads the lines and decodes
// the rasters; this file only picks masks and measures them.
import {
  decodeMaskToRaster,
  frameIndexOf,
  parseVideoStream,
  recordsOfKind,
  type ResponsesEvent,
  type SegmentationRecord,
  type VideoSegmentationResult,
} from '@meta-sam/parser';

export interface Bounds {
  left: number;
  top: number;
  right: number; // half-open, source pixels
  bottom: number;
}

export interface FrameMask {
  objectId: string;
  width: number; // raster size, not the frame's
  height: number;
  raster: Uint8Array; // row-major 0/1
  bounds: Bounds; // the source-pixel box the raster covers
  confidence?: number;
}

export interface MaskStats {
  area: number; // source pixels
  cx: number; // centroid, source pixels
  cy: number;
  box: Bounds; // tight box around the set pixels, source pixels
}

// Area, centroid and tight box, in source pixels. Raster pixel (col, row)
// covers a (bw / width) x (bh / height) patch of the source box, so its
// centre sits at left + (col + 0.5) * sx.
export function maskStats(mask: FrameMask): MaskStats | null {
  const { width, height, raster, bounds } = mask;
  const sx = (bounds.right - bounds.left) / width;
  const sy = (bounds.bottom - bounds.top) / height;
  let count = 0;
  let sumCol = 0;
  let sumRow = 0;
  let minCol = Infinity;
  let maxCol = -Infinity;
  let minRow = Infinity;
  let maxRow = -Infinity;
  for (let row = 0, i = 0; row < height; row++) {
    for (let col = 0; col < width; col++, i++) {
      if (raster[i] === 0) continue;
      count++;
      sumCol += col;
      sumRow += row;
      if (col < minCol) minCol = col;
      if (col > maxCol) maxCol = col;
      if (row < minRow) minRow = row;
      if (row > maxRow) maxRow = row;
    }
  }
  if (count === 0) return null;
  return {
    area: count * sx * sy,
    cx: bounds.left + (sumCol / count + 0.5) * sx,
    cy: bounds.top + (sumRow / count + 0.5) * sy,
    box: {
      left: bounds.left + minCol * sx,
      top: bounds.top + minRow * sy,
      right: bounds.left + (maxCol + 1) * sx,
      bottom: bounds.top + (maxRow + 1) * sy,
    },
  };
}

// Whether source pixel (x, y) is inside the mask.
export function maskHas(mask: FrameMask, x: number, y: number): boolean {
  const { bounds } = mask;
  if (x < bounds.left || x >= bounds.right || y < bounds.top || y >= bounds.bottom) return false;
  const col = Math.floor(((x - bounds.left) * mask.width) / (bounds.right - bounds.left));
  const row = Math.floor(((y - bounds.top) * mask.height) / (bounds.bottom - bounds.top));
  return mask.raster[row * mask.width + col] === 1;
}

// One mask per frame: the largest when a concept prompt matches several
// objects (one person in the clip, so extra matches are strays). Frames
// with no match are null. A later record for the same object and frame
// replaces an earlier one; point prompts can arrive out of order.
export function framesFromRecords(records: readonly SegmentationRecord[], frameCount: number): (FrameMask | null)[] {
  const byFrame = new Map<number, Map<string, FrameMask>>();
  for (const record of recordsOfKind(records, 'mask')) {
    const frame = frameIndexOf(record);
    if (frame === undefined || frame < 0 || frame >= frameCount) continue;
    const mask: FrameMask = {
      objectId: record.objectId,
      width: record.mask.width,
      height: record.mask.height,
      raster: decodeMaskToRaster(record.mask),
      bounds: record.bounds,
      confidence: record.confidence,
    };
    if (!byFrame.has(frame)) byFrame.set(frame, new Map());
    byFrame.get(frame)!.set(record.objectId, mask);
  }
  const frames: (FrameMask | null)[] = [];
  for (let f = 0; f < frameCount; f++) {
    let best: FrameMask | null = null;
    let bestArea = 0;
    for (const mask of byFrame.get(f)?.values() ?? []) {
      const area = maskStats(mask)?.area ?? 0;
      if (area > bestArea) {
        best = mask;
        bestArea = area;
      }
    }
    frames.push(best);
  }
  return frames;
}

// Re-reads a cached response's output text through the same parser the live
// call used, as if it were streaming again. No network.
export function parseCachedOutput(rawOutput: string): Promise<VideoSegmentationResult> {
  const lane = { item_id: 'cached', output_index: 0, content_index: 0 };
  async function* events(): AsyncIterable<ResponsesEvent> {
    yield { type: 'response.output_text.delta', delta: rawOutput, ...lane };
    yield { type: 'response.output_text.done', text: rawOutput, ...lane };
    yield { type: 'response.completed' };
  }
  return parseVideoStream(events()).finalResult;
}
