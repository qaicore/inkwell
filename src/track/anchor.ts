// Anchors from SAM 3.1 masks (SPEC §8.2): for each frame, the mask's centre,
// its long axis from second moments, and its size as the square root of its
// area; a root keeps its place relative to those. Gaps are filled, then the
// track is smoothed with a One Euro filter run forwards and backwards (no
// lag), and re-based so the root sits exactly where it was placed on its own
// frame.
import type { SamMask } from '../sam/cache.ts';
import { followShapes, smoothTrack, type Pose, type Shape, type Vec } from './tracking.ts';

export interface AnchorSeed {
  frame: number;
  xy: Vec; // frame px
}

// A SAM mask's shape, in frame px. The raster covers `bounds`, so raster
// pixel (col, row) is centred at left + (col + 0.5) × the cell width.
export function samShape(m: SamMask): Shape | null {
  const sx = (m.bounds.right - m.bounds.left) / m.width;
  const sy = (m.bounds.bottom - m.bounds.top) / m.height;
  let n = 0;
  let cx = 0;
  let cy = 0;
  for (let row = 0, i = 0; row < m.height; row++) {
    for (let col = 0; col < m.width; col++, i++) {
      if (!m.raster[i]) continue;
      n++;
      cx += m.bounds.left + (col + 0.5) * sx;
      cy += m.bounds.top + (row + 0.5) * sy;
    }
  }
  if (n === 0) return null;
  cx /= n;
  cy /= n;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (let row = 0, i = 0; row < m.height; row++) {
    for (let col = 0; col < m.width; col++, i++) {
      if (!m.raster[i]) continue;
      const dx = m.bounds.left + (col + 0.5) * sx - cx;
      const dy = m.bounds.top + (row + 0.5) * sy - cy;
      xx += dx * dx;
      yy += dy * dy;
      xy += dx * dy;
    }
  }
  const spread = xx + yy;
  return {
    x: cx,
    y: cy,
    axis: 0.5 * Math.atan2(2 * xy, xx - yy),
    stretch: spread > 0 ? Math.hypot(xx - yy, 2 * xy) / spread : 0,
    size: Math.sqrt(n * sx * sy),
  };
}

// Where a root placed at `seed` goes on every frame: the full pose (turn
// and scale too), smoothed. Null when its mask is never found.
export function trackPoses(masks: (SamMask | null)[], seed: AnchorSeed, fps: number): Pose[] | null {
  const raw = followShapes(masks.map((m) => (m ? samShape(m) : null)), seed.xy, seed.frame);
  return smoothTrack(raw, seed.xy, seed.frame, fps);
}

// The anchor point itself, raw (null where SAM lost it) and smoothed (what
// the app uses), one per frame.
export function trackAnchor(masks: (SamMask | null)[], seed: AnchorSeed, fps: number): { raw: (Vec | null)[]; smoothed: (Vec | null)[] } {
  const raw = followShapes(masks.map((m) => (m ? samShape(m) : null)), seed.xy, seed.frame);
  const smoothed = smoothTrack(raw, seed.xy, seed.frame, fps);
  return {
    raw: raw.map((p) => (p ? [p.x, p.y] : null)),
    smoothed: smoothed ? smoothed.map((p): Vec => [p.x, p.y]) : masks.map(() => null),
  };
}
