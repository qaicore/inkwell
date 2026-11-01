// The hero's impact drawing, and five messy ones made from it with a seed, for
// the tests of the impact detector (WP1) and the posters (WP6). Real drawings
// won't be six clean cracks from one point (impact design §5): they'll be
// jittered, drawn inward, a single line, scattered marks or a starburst.
// Everything is built here, in the test; nothing lives under fixtures/.
//
// Clip px, 1920×1080, y down. A finger stops at the frame edge, so whatever a
// drawing would put off the frame is clamped (jittered) or cut (starburst),
// the way the hero's crack 16 runs off the bottom.
import type { Stroke, Vec2 } from '../../../src/types/effect.ts';
import { rng, uniform } from '../../../src/impact/rng.ts';
import { brushSizeForWidth } from '../../../src/impact/frames/figure.ts';

// The hero's impact (Qai, Oct 29): contact on f84 at P, striking along d.
export const HERO = { width: 1920, height: 1080, S: 1080, I: 84, P: [942, 1061] as Vec2, d: [-0.06, 0.998] as Vec2, seed: 84 } as const;

export interface ImpactStroke {
  id: number;
  points: Vec2[]; // clip px, in drawing order
  pressure: number[]; // per point, 0..1
  width: number[]; // the full stroke width at each point, px
}

const crack = (id: number, points: Vec2[], pressure: number[], width: number[]): ImpactStroke => ({ id, points, pressure, width });

// The six cracks Qai drew on f84 (impact/test-drawings.json, end.strokes), all from P.
export const HERO_CRACKS: readonly ImpactStroke[] = [
  crack(
    11,
    [[942, 1061], [913.1, 1061.9], [889.7, 1056.8], [870.1, 1056.9], [847.7, 1054.4], [826.7, 1053.7], [804.6, 1050.5], [777.5, 1050], [760.9, 1050], [745.4, 1049], [728.7, 1045.6], [712.8, 1049.8], [688.3, 1055.7], [659.1, 1061.3], [644.3, 1058.8], [619.9, 1061.4], [591.7, 1062.2], [571.3, 1062], [555, 1061.4], [535.1, 1061.3], [513.3, 1060.5], [510.1, 1060]],
    [1, 0.921, 0.868, 0.827, 0.782, 0.742, 0.699, 0.65, 0.621, 0.594, 0.563, 0.536, 0.496, 0.45, 0.425, 0.388, 0.345, 0.313, 0.288, 0.258, 0.225, 0.22],
    [6.4, 5.9, 5.7, 5.2, 5.1, 4.7, 4.6, 4.2, 4, 3.9, 4, 3.2, 3, 2.8, 3.2, 2.5, 2.4, 2.3, 2.2, 1.9, 1.7, 1.8],
  ),
  crack(
    12,
    [[942, 1061], [935.1, 1040.8], [925.3, 1029.2], [925.1, 1017.4], [918.1, 1002.9], [893.1, 996.6], [881.9, 982.9], [868.2, 976.5], [857.3, 965.2], [851.1, 955.5], [837.2, 944.1], [833.4, 940.9]],
    [1, 0.874, 0.803, 0.744, 0.667, 0.576, 0.498, 0.441, 0.373, 0.319, 0.242, 0.22],
    [7.6, 7, 6, 5.8, 5, 3.3, 3.5, 2.7, 2.5, 2.2, 1.6, 1.4],
  ),
  crack(
    13,
    [[942, 1061], [947.9, 1045.9], [955.5, 1031], [958.8, 1014.7], [962.6, 1001.7], [975.2, 988.4], [982.7, 976.2], [994.4, 968.8], [987.6, 955.2], [992.6, 947.9], [1001.3, 937.9], [1007.4, 926.4], [1011.3, 917.6], [1015.6, 911], [1022.9, 901.9], [1027.4, 894], [1033, 888.3], [1035.5, 881.9], [1041.3, 874.7], [1042.7, 868.5], [1042.8, 860.3], [1041.2, 852.5], [1042.3, 845.7], [1043.3, 835.9], [1042.7, 834.8]],
    [1, 0.944, 0.898, 0.851, 0.814, 0.768, 0.73, 0.698, 0.658, 0.633, 0.598, 0.56, 0.531, 0.507, 0.473, 0.445, 0.422, 0.399, 0.37, 0.347, 0.317, 0.289, 0.263, 0.224, 0.22],
    [8.2, 7.6, 7, 6.6, 6.2, 5.4, 5.2, 4.4, 4.5, 4.3, 3.9, 3.7, 3.5, 3.3, 2.9, 2.8, 2.5, 2.5, 2.2, 2.1, 1.9, 1.7, 1.5, 1.3, 1.2],
  ),
  crack(
    14,
    [[942, 1061], [962.8, 1047.2], [979.2, 1039.8], [994.1, 1031], [1003.6, 1012.9], [1013.5, 998], [1018.9, 987.9], [1027.2, 981.2], [1040.1, 972.1], [1050.1, 958], [1057.7, 948.6], [1068.8, 939.6], [1070.9, 936.2]],
    [1, 0.882, 0.814, 0.748, 0.66, 0.584, 0.533, 0.491, 0.43, 0.353, 0.299, 0.239, 0.22],
    [7.5, 6.4, 5.6, 5.3, 5.1, 4.3, 3.9, 3.4, 2.9, 2.5, 2, 1.5, 1.5],
  ),
  crack(
    15,
    [[942, 1061], [967.6, 1055.5], [981.6, 1050.8], [997.9, 1048.9], [1018.5, 1052.4], [1039.8, 1056.2], [1063.1, 1055.9], [1080.7, 1055.7], [1106, 1050.4], [1133.7, 1050.1], [1148.6, 1046.8], [1175.6, 1046.9], [1192.7, 1045], [1200.2, 1044.8]],
    [1, 0.891, 0.839, 0.786, 0.723, 0.661, 0.595, 0.547, 0.473, 0.399, 0.355, 0.285, 0.239, 0.22],
    [6.8, 5.9, 5.7, 5, 4.4, 4.1, 3.8, 3.5, 3.3, 2.6, 2.5, 1.8, 1.6, 1.4],
  ),
  crack(16, [[942, 1061], [963.8, 1067.8], [978.2, 1073.6], [989.4, 1079]], [1, 0.806, 0.699, 0.618], [6.6, 5.3, 4.7, 4.3]),
];

export type MessyKind = 'jittered' | 'inward' | 'single' | 'scattered' | 'starburst';
export const MESSY_KINDS: readonly MessyKind[] = ['jittered', 'inward', 'single', 'scattered', 'starburst'];

const { width: W, height: H, S, P } = HERO;
const copy = (s: ImpactStroke): ImpactStroke => ({ id: s.id, points: s.points.map((p): Vec2 => [p[0], p[1]]), pressure: [...s.pressure], width: [...s.width] });
const clamp = (v: number, hi: number) => Math.min(hi, Math.max(0, v));
const inFrame = ([x, y]: Vec2) => x >= 0 && x <= W - 1 && y >= 0 && y <= H - 1;
const taper = (n: number, from: number, to: number) => Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));
const widthOf = (pressure: number[]) => pressure.map((p) => Math.round((1 + 6.5 * p) * 10) / 10);

// Every point moved by up to ±0.01 S on each axis.
function jittered(seed: number): ImpactStroke[] {
  const r = rng(seed, 'messy', 0);
  return HERO_CRACKS.map((c) => ({
    ...copy(c),
    points: c.points.map(([x, y]): Vec2 => [clamp(x + uniform(r, -0.01, 0.01) * S, W - 1), clamp(y + uniform(r, -0.01, 0.01) * S, H - 1)]),
  }));
}

// Every crack drawn toward P instead of away from it.
function inward(): ImpactStroke[] {
  return HERO_CRACKS.map((c) => ({ id: c.id, points: [...c.points].reverse().map((p): Vec2 => [p[0], p[1]]), pressure: [...c.pressure].reverse(), width: [...c.width].reverse() }));
}

// Six short marks, each centred 0.15–0.35 S from P, wholly on the frame, with
// no end within 0.05 S of another mark's ends. None comes within 0.1 S of P.
function scattered(seed: number): ImpactStroke[] {
  const r = rng(seed, 'messy', 3);
  const out: ImpactStroke[] = [];
  const ends: Vec2[] = [];
  const n = 8;
  for (let tries = 0; out.length < 6; tries++) {
    if (tries > 10_000) throw new Error('scattered: no room for six marks');
    const at = uniform(r, 0.15, 0.35) * S;
    const bearing = uniform(r, 0, 2 * Math.PI);
    const c: Vec2 = [P[0] + at * Math.cos(bearing), P[1] + at * Math.sin(bearing)];
    const len = uniform(r, 0.05, 0.1) * S;
    const turn = uniform(r, 0, 2 * Math.PI);
    const bow = uniform(r, -0.15, 0.15) * len;
    const [dx, dy] = [Math.cos(turn), Math.sin(turn)];
    const points = Array.from({ length: n }, (_, i): Vec2 => {
      const t = i / (n - 1);
      const along = (t - 0.5) * len;
      const side = bow * Math.sin(Math.PI * t);
      return [c[0] + along * dx - side * dy, c[1] + along * dy + side * dx];
    });
    const mine = [points[0], points[n - 1]];
    if (!points.every(inFrame)) continue;
    if (mine.some((e) => ends.some((o) => Math.hypot(e[0] - o[0], e[1] - o[1]) < 0.05 * S))) continue;
    ends.push(...mine);
    const pressure = taper(n, 1, 0.3);
    out.push({ id: 11 + out.length, points, pressure, width: widthOf(pressure) });
  }
  return out;
}

// Eight rays through P. Each starts 0.05 S past P on the far side, runs back
// through P and out 0.18–0.32 S, and is cut where it leaves the frame.
function starburst(seed: number): ImpactStroke[] {
  const r = rng(seed, 'messy', 4);
  const n = 16;
  return Array.from({ length: 8 }, (_, i): ImpactStroke => {
    const bearing = (2 * Math.PI * i) / 8 + uniform(r, -0.15, 0.15);
    const d: Vec2 = [Math.cos(bearing), Math.sin(bearing)];
    const [lo, hi] = rayInFrame(d);
    const t0 = Math.max(-0.05 * S, lo);
    const t1 = Math.min(uniform(r, 0.18, 0.32) * S, hi);
    const points = Array.from({ length: n }, (_, k): Vec2 => {
      const t = t0 + ((t1 - t0) * k) / (n - 1);
      return [clamp(P[0] + t * d[0], W - 1), clamp(P[1] + t * d[1], H - 1)]; // the clamp only trims rounding at the edge
    });
    const pressure = taper(n, 1, 0.22);
    return { id: 11 + i, points, pressure, width: widthOf(pressure) };
  });
}

// The span of t for which P + t·d stays on the frame.
function rayInFrame(d: Vec2): [number, number] {
  let lo = -Infinity;
  let hi = Infinity;
  for (const [p, size, dir] of [[P[0], W - 1, d[0]], [P[1], H - 1, d[1]]]) {
    if (Math.abs(dir) < 1e-12) continue;
    const a = (0 - p) / dir;
    const b = (size - p) / dir;
    lo = Math.max(lo, Math.min(a, b));
    hi = Math.min(hi, Math.max(a, b));
  }
  return [lo, hi];
}

export function messyDrawing(kind: MessyKind, seed: number = HERO.seed): ImpactStroke[] {
  switch (kind) {
    case 'jittered':
      return jittered(seed);
    case 'inward':
      return inward();
    case 'single':
      return [copy(HERO_CRACKS.find((c) => c.id === 13)!)];
    case 'scattered':
      return scattered(seed);
    case 'starburst':
      return starburst(seed);
  }
}

export function messyDrawings(seed: number = HERO.seed): Record<MessyKind, ImpactStroke[]> {
  return Object.fromEntries(MESSY_KINDS.map((k) => [k, messyDrawing(k, seed)])) as Record<MessyKind, ImpactStroke[]>;
}

// As effect strokes: ground-anchored and kept in frame px, rooted at their
// first point (as the brush samples store ground strokes).
export function asGroundStrokes(strokes: readonly ImpactStroke[], color: 0 | 1 | 2 = 2, frameWidth: number | null = null): Stroke[] {
  return strokes.map((s): Stroke => ({
    id: s.id,
    color,
    // With the frame's width, at the size its widths give (the app keeps each impact stroke's own).
    ...(frameWidth ? { size: brushSizeForWidth(s.width, frameWidth) } : {}),
    kind: 'rigid',
    anchor: { type: 'ground', xy: [s.points[0][0], s.points[0][1]] },
    bodyAngle: 0,
    stiffness: 1,
    wobble: 0,
    views: { front: { points: s.points.map((p): Vec2 => [p[0], p[1]]), pressure: [...s.pressure], root: [s.points[0][0], s.points[0][1]], layer: 'behind' } },
  }));
}
