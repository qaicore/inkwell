// Where the impact sits on screen (impact design §0, §5, §6): the strike axes
// around the impact point P, and the floor as a model of how a circle on it
// looks. n̂ is the floor's up (away from the camera along the floor, on
// screen) and t̂ runs across it; a floor circle of radius R draws as an
// ellipse with semi-axes R along majorDeg and ratio·R along n̂, its far half
// squashed by 1 + persp·R/U.
import type { Vec2 } from '../types/effect.ts';
import type { FloorModel, StrikeFrame } from './contracts.ts';
import { rng } from './rng.ts';

// No measured camera: a floor seen at about 30° from above, level.
export const DEFAULT_FLOOR: Readonly<FloorModel> = { ratio: 0.5, majorDeg: 0, up: [0, -1], persp: 0 };

const unit = (v: Vec2, fallback: Vec2): Vec2 => {
  const len = Math.hypot(v[0], v[1]);
  return len > 0 ? [v[0] / len, v[1] / len] : [fallback[0], fallback[1]];
};

// The floor's directions at P: n̂ (up the floor) and t̂ = n̂ turned a quarter
// clockwise on screen, so (0, −1) gives t̂ = (1, 0). The model is the same
// everywhere; P is where it's read.
export function floorFrame(P: Vec2, floor: Readonly<FloorModel>): { P: Vec2; n: Vec2; t: Vec2 } {
  const n = unit(floor.up, [0, -1]);
  return { P: [P[0], P[1]], n, t: [-n[1], n[0]] };
}

// A floor circle of radius R around P, as a polyline: R along majorDeg,
// ratio·R along n̂ on the near half, divided by 1 + persp·R/U on the far half.
// When P is in the bottom 5 % of the frame (P_y > 0.95 H), only the far half
// is drawn, as an open arc (design §6, G5). `segments` (rounded to a multiple
// of 4, so both axis ends are vertices) covers the whole circle.
export function floorCircle(P: Vec2, R: number, floor: Readonly<FloorModel>, opts: { U: number; height: number; segments?: number }): { points: Vec2[]; closed: boolean } {
  const { n } = floorFrame(P, floor);
  const a = (floor.majorDeg * Math.PI) / 180;
  const m: Vec2 = [Math.cos(a), Math.sin(a)];
  const far = 1 / (1 + (floor.persp * R) / opts.U);
  const farOnly = P[1] > 0.95 * opts.height;
  const segments = Math.max(8, 4 * Math.round((opts.segments ?? 96) / 4));
  const count = farOnly ? segments / 2 + 1 : segments;
  const points: Vec2[] = [];
  for (let i = 0; i < count; i++) {
    const th = (2 * Math.PI * i) / segments;
    const s = i === segments / 2 ? 0 : Math.sin(th); // exactly on the axis at θ = π
    const along = R * Math.cos(th);
    const up = floor.ratio * R * s * (s > 0 ? far : 1);
    points.push([P[0] + along * m[0] + up * n[0], P[1] + along * m[1] + up * n[1]]);
  }
  return { points, closed: !farOnly };
}

// An element whose whole extent is off the w × h frame is mirrored across P:
// `axis` is the direction that flips, so the mirror line runs through P
// perpendicular to it (u for "mirrored across P along u", n̂ for "across the
// floor tangent through P"). Anything on the frame comes back as it was. The
// points are a polyline; repeat the first point to count a closing edge.
export function mirrorIntoFrame(points: readonly Vec2[], P: Vec2, axis: Vec2, w: number, h: number): { points: Vec2[]; mirrored: boolean } {
  if (onFrame(points, w, h)) return { points: points.map((p): Vec2 => [p[0], p[1]]), mirrored: false };
  const [ax, ay] = unit(axis, [0, 1]);
  return {
    points: points.map(([x, y]): Vec2 => {
      const d = 2 * ((x - P[0]) * ax + (y - P[1]) * ay);
      return [x - d * ax, y - d * ay];
    }),
    mirrored: true,
  };
}

function onFrame(points: readonly Vec2[], w: number, h: number): boolean {
  const inside = ([x, y]: Vec2) => x >= 0 && x <= w && y >= 0 && y <= h;
  if (points.some(inside)) return true;
  for (let i = 1; i < points.length; i++) if (crosses(points[i - 1], points[i], w, h)) return true;
  return false;
}

// Whether segment a→b passes through the rectangle [0, w] × [0, h] (Liang–Barsky).
function crosses(a: Vec2, b: Vec2, w: number, h: number): boolean {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [[-dx, a[0]], [dx, w - a[0]], [-dy, a[1]], [dy, h - a[1]]]) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const r = q / p;
      if (p < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
      if (t0 > t1) return false;
    }
  }
  return true;
}

// σ from the person-mask box height at I (design §0): clamp(0.85·h_p/(0.76·S), 0.45, 1).
export function sigmaOf(personHeight: number, S: number): number {
  return Math.min(1, Math.max(0.45, (0.85 * personHeight) / (0.76 * S)));
}

// The strike axes (design §0): u = d̂ (straight down when d is zero) and
// v = h·(−u_y, u_x). In portrait (height > width) h is −1, the reference's own
// slow-motion layout; in landscape the seed picks the side.
export function strikeFrame(P: Vec2, d: Vec2, S: number, sigma: number, width: number, height: number, seed: number): StrikeFrame {
  const u = unit(d, [0, 1]);
  const h: 1 | -1 = height > width ? -1 : rng(seed, 'hud', -1)() < 0.5 ? 1 : -1;
  return { P: [P[0], P[1]], u, v: [-h * u[1], h * u[0]], S, U: sigma * S, sigma, h };
}

// X(a, b) = P + S·(a·u + b·v).
export function strikeAt(frame: StrikeFrame, a: number, b: number): Vec2 {
  const { P, u, v, S } = frame;
  return [P[0] + S * (a * u[0] + b * v[0]), P[1] + S * (a * u[1] + b * v[1])];
}
