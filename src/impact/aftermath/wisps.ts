// The white wisps (impact design §6, "Wisps"; destruction §4.7, §6.7): light,
// translucent pieces with no ink line, in front of the person, on the strict
// 2s clock: a new drawing on every global drawing k, seeded (seed, 'wisp', k),
// shaped by the reference age of its first frame.
//   - A0: 3–4 tapered spikes along the floor line, both ways, 0.044 U² in all
//     (the biggest 0.028 U²), at r p50 0.28 U.
//   - A1–2: a zigzag slash complex about 1.3 U long over P (0.085 U²) and a
//     few slivers through the burst, 0.097 U² in all.
//   - A3–4: two pieces of a shock ring: an arc over P along the floor line,
//     1.9 U across and 0.16 U², and a tangential cap at r 0.87 U, 0.12 U².
//   - A5–6: nothing here; the white flash is WP9's (washes.ts).
//   - A7–13: torn-paper splashes at r 0.6–0.9 U, both on the floor side and
//     beyond the cluster: 13, 16, 23 and 15 of them, 0.22 U², then ×0.70,
//     ×0.57 and ×0.22 per hold step. None after A13.
// The fill is p1, at an opacity falling from 0.9 at A0 to 0.2 by A12 (the
// reference's translucent warm light, destruction §6.12), × the decay.
// Positions are in U at k0 framing; each piece's own size is × the zoom factor
// (fire.ts), so its area holds on screen. A piece that lands wholly off the
// frame is mirrored back across the floor line through P, else across n̂,
// else both (the hero's P sits on the bottom edge, so the floor side is off
// the frame).
import type { GlowSink } from '../contracts.ts';
import type { BrushTarget } from '../../render/glow.ts';
import { decayAlpha, zoomAt } from '../clock.ts';
import { roles } from '../palette.ts';
import { int, rng, uniform, type Rng } from '../rng.ts';
import { ZOOM_PEAK, drawingAge, ellipsePts, massFrame, massKey, paint, polygonArea, toFrame, type FloorPt, type MassContext, type MassDrawing, type MassFrame, type MassShape } from './fire.ts';

export type WispKind = 'spikes' | 'slashes' | 'arcs' | 'splashes';
const ROLE: Record<WispKind, string> = { spikes: 'spike', slashes: 'slash', arcs: 'arc', splashes: 'splash' };

// The measured areas (U², at the zoom factor 1) and piece counts.
export const SPIKES = { area: 0.044, biggest: 0.028, count: [3, 4] } as const;
export const SLASHES = { area: 0.097, complex: 0.085, slivers: [5, 7], length: 1.3 } as const;
export const ARCS = { arc: 0.16, cap: 0.12, capR: 0.87, half: 0.95 } as const;
export const SPLASHES = {
  area: [0.22, 0.22 * 0.7, 0.22 * 0.7 * 0.57, 0.22 * 0.7 * 0.57 * 0.22], // A7–8, A9–10, A11–12, A13
  count: [13, 16, 23, 15],
  biggest: [0.24, 0.55, 0.38, 0.37], // the biggest piece's share
  r: [0.8, 0.64, 0.88, 0.86], // the pieces' median distance from P
} as const;
const OPACITY = [0.9, 0.2] as const; // at A0, and from A12
const DEG = Math.PI / 180;

// Which wisps a drawing of reference age A shows, and the splash step.
export function wispKind(A: number): { kind: WispKind; step: number } | null {
  if (A < 0) return null;
  if (A === 0) return { kind: 'spikes', step: 0 };
  if (A <= 2) return { kind: 'slashes', step: 0 };
  if (A <= 4) return { kind: 'arcs', step: 0 };
  if (A <= 6) return null;
  if (A <= 13) return { kind: 'splashes', step: Math.min(3, Math.floor((A - 7) / 2)) };
  return null;
}

export const wispOpacity = (A: number) => OPACITY[0] + ((OPACITY[1] - OPACITY[0]) * Math.min(A, 12)) / 12;

// A piece: its polygon in the floor frame (U, at the zoom factor 1) about its
// anchor, which is where it sits.
export interface WispPiece {
  anchor: FloorPt;
  points: FloorPt[];
  round: boolean; // drawn with curves (the spikes and the ring pieces); the splashes keep their torn corners
}

// Scales a piece about its anchor to `area` U².
function toArea(p: WispPiece, area: number): WispPiece {
  const a = polygonArea(p.points);
  if (!(a > 0)) return p;
  const s = Math.sqrt(area / a);
  return { ...p, points: p.points.map(([n, t]): FloorPt => [p.anchor[0] + (n - p.anchor[0]) * s, p.anchor[1] + (t - p.anchor[1]) * s]) };
}

// A ribbon along a centreline, `width(u)` wide at u in 0..1 along it.
function ribbon(axis: readonly FloorPt[], width: (u: number) => number): FloorPt[] {
  const left: FloorPt[] = [];
  const right: FloorPt[] = [];
  for (let i = 0; i < axis.length; i++) {
    const a = axis[Math.max(0, i - 1)];
    const b = axis[Math.min(axis.length - 1, i + 1)];
    const dn = b[0] - a[0];
    const dt = b[1] - a[1];
    const len = Math.hypot(dn, dt) || 1;
    const w = width(i / (axis.length - 1)) / 2;
    left.push([axis[i][0] - (dt / len) * w, axis[i][1] + (dn / len) * w]);
    right.push([axis[i][0] + (dt / len) * w, axis[i][1] - (dn / len) * w]);
  }
  return [...left, ...right.reverse()];
}

const centroid = (pts: readonly FloorPt[]): FloorPt => {
  let n = 0;
  let t = 0;
  for (const p of pts) {
    n += p[0];
    t += p[1];
  }
  return [n / pts.length, t / pts.length];
};

// Shares of the total for `count` pieces, summing to 1. With `big`, the
// first takes that share and stays the biggest: the rest share what is left
// by seeded weights, each capped at it (water-filling).
function shares(r: Rng, count: number, big?: number): number[] {
  const weights = Array.from({ length: big === undefined ? count : count - 1 }, () => 0.35 + r() ** 1.5);
  if (big === undefined) {
    const sum = weights.reduce((acc, v) => acc + v, 0);
    return weights.map((v) => v / sum);
  }
  if (count <= 1) return [1];
  const cap = Math.max(big, (1 - big) / (count - 1));
  const out = new Array<number>(weights.length).fill(0);
  let open = weights.map((_, i) => i);
  let left = 1 - big;
  while (open.length && left > 1e-12) {
    const sum = open.reduce((acc, i) => acc + weights[i], 0);
    const over = open.filter((i) => (left * weights[i]) / sum > cap);
    if (!over.length) {
      for (const i of open) out[i] = (left * weights[i]) / sum;
      break;
    }
    for (const i of over) {
      out[i] = cap;
      left -= cap;
    }
    open = open.filter((i) => !over.includes(i));
  }
  return [big, ...out];
}

// A0: tapered spikes along the floor line, rooted near P, both ways.
function spikes(r: Rng): WispPiece[] {
  const count = int(r, SPIKES.count[0], SPIKES.count[1]);
  const areas = shares(r, count, SPIKES.biggest / SPIKES.area).map((s) => s * SPIKES.area);
  return areas.map((area, i) => {
    const side = i % 2 === 0 ? 1 : -1;
    const root: FloorPt = [uniform(r, 0.03, 0.06), side * uniform(r, 0.06, 0.14)];
    const length = uniform(r, 0.26, 0.46);
    const lift = uniform(r, 5, 25) * DEG; // above the floor line
    const bend = uniform(r, -0.04, 0.04);
    const axis: FloorPt[] = Array.from({ length: 9 }, (_, q) => {
      const u = q / 8;
      return [root[0] + length * u * Math.sin(lift) + bend * Math.sin(Math.PI * u), root[1] + side * length * u * Math.cos(lift)];
    });
    const pts = ribbon(axis, (u) => (u < 0.12 ? 0.4 + 5 * u : 1) * (1 - u) ** 1.1);
    return toArea({ anchor: centroid(pts), points: pts, round: true }, area);
  });
}

// A1–2: the slash complex, a tapered zigzag across the burst over P, and slivers.
function slashes(r: Rng): WispPiece[] {
  const half = SLASHES.length / 2;
  const zigs = int(r, 4, 6);
  const axis: FloorPt[] = [];
  for (let q = 0; q <= zigs; q++) {
    const u = q / zigs;
    const n = q % 2 === 0 ? uniform(r, 0.16, 0.3) : uniform(r, 0.5, 0.72);
    axis.push([n, -half + 2 * half * u + uniform(r, -0.04, 0.04)]);
  }
  const fine: FloorPt[] = [];
  for (let q = 0; q < axis.length - 1; q++) for (let s = 0; s < 4; s++) fine.push([axis[q][0] + ((axis[q + 1][0] - axis[q][0]) * s) / 4, axis[q][1] + ((axis[q + 1][1] - axis[q][1]) * s) / 4]);
  fine.push(axis[axis.length - 1]);
  const complex = ribbon(fine, (u) => 0.15 + Math.sin(Math.PI * u) ** 0.7);
  const out = [toArea({ anchor: centroid(complex), points: complex, round: false }, SLASHES.complex)];
  const count = int(r, SLASHES.slivers[0], SLASHES.slivers[1]);
  const areas = shares(r, count).map((s) => s * (SLASHES.area - SLASHES.complex));
  for (const area of areas) {
    const phi = uniform(r, -45, 45) * DEG;
    const rho = uniform(r, 0.38, 0.62);
    const c: FloorPt = [rho * Math.cos(phi), rho * Math.sin(phi)];
    const dir = phi + uniform(r, 60, 120) * DEG * (r() < 0.5 ? 1 : -1);
    const len = uniform(r, 0.08, 0.16);
    const a: FloorPt = [c[0] - (Math.cos(dir) * len) / 2, c[1] - (Math.sin(dir) * len) / 2];
    const sliver = ribbon(
      Array.from({ length: 5 }, (_, q): FloorPt => [a[0] + (Math.cos(dir) * len * q) / 4, a[1] + (Math.sin(dir) * len * q) / 4]),
      (u) => Math.sin(Math.PI * Math.min(1, 0.1 + u * 0.9)),
    );
    out.push(toArea({ anchor: c, points: sliver, round: false }, area));
  }
  return out;
}

// A3–4: the ring arc over P along the floor line, and the cap at r 0.87.
function arcs(r: Rng): WispPiece[] {
  const rise = uniform(r, 0.58, 0.68);
  const base = uniform(r, 0.14, 0.2);
  const lean = uniform(r, -0.05, 0.05);
  const axis: FloorPt[] = Array.from({ length: 33 }, (_, q) => {
    const th = (Math.PI * q) / 32;
    return [base + rise * Math.sin(th), lean + ARCS.half * Math.cos(th)];
  });
  const wob = [r(), r()].map((v) => v * 2 * Math.PI);
  const arc = ribbon(axis, (u) => (0.12 + Math.sin(Math.PI * u) ** 0.8) * (1 + 0.18 * Math.sin(5 * Math.PI * u + wob[0])));
  const at = uniform(r, -12, 12) * DEG;
  const span = uniform(r, 22, 28) * DEG;
  const cap: FloorPt[] = Array.from({ length: 17 }, (_, q) => {
    const phi = at - span + (2 * span * q) / 16;
    return [ARCS.capR * Math.cos(phi), ARCS.capR * Math.sin(phi)];
  });
  const capPts = ribbon(cap, (u) => (0.1 + Math.sin(Math.PI * u) ** 0.9) * (1 + 0.15 * Math.sin(3 * Math.PI * u + wob[1])));
  return [toArea({ anchor: centroid(arc), points: arc, round: true }, ARCS.arc), toArea({ anchor: centroid(capPts), points: capPts, round: true }, ARCS.cap)];
}

// A7–13: torn-paper splashes, stretched along the ring they broke off.
function splashes(r: Rng, step: number): WispPiece[] {
  const count = SPLASHES.count[step];
  const total = SPLASHES.area[step];
  const areas = shares(r, count, SPLASHES.biggest[step]).map((s) => s * total);
  return areas.map((area) => {
    const phi = uniform(r, -180, 180) * DEG;
    const rho = SPLASHES.r[step] + uniform(r, -0.2, 0.2);
    const anchor: FloorPt = [rho * Math.cos(phi), rho * Math.sin(phi)];
    const stretch = uniform(r, 1.8, 5);
    const m = int(r, 12, 18);
    const ring = ellipsePts(anchor, 0.05, m, stretch, phi + Math.PI / 2);
    // Torn edges: every vertex in or out, the odd ones more.
    const pts = ring.map(([n, t], q): FloorPt => {
      const k = q % 2 ? uniform(r, 0.55, 0.95) : uniform(r, 0.9, 1.25);
      return [anchor[0] + (n - anchor[0]) * k, anchor[1] + (t - anchor[1]) * k];
    });
    return toArea({ anchor, points: pts, round: false }, area);
  });
}

// Mirrors a piece that lands wholly off the frame back into it (see the header).
function intoFrame(fr: MassFrame, unit: number, width: number, height: number, p: WispPiece): WispPiece {
  const shows = (sn: number, st: number) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [n, t] of p.points) {
      const [x, y] = toFrame(fr, unit, [n * sn, t * st]);
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    return x1 > 0 && x0 < width && y1 > 0 && y0 < height;
  };
  if (shows(1, 1)) return p;
  for (const [sn, st] of [[-1, 1], [1, -1], [-1, -1]] as const) {
    if (!shows(sn, st)) continue;
    const flip = (q: FloorPt): FloorPt => [q[0] * sn, q[1] * st];
    return { anchor: flip(p.anchor), points: p.points.map(flip).reverse(), round: p.round };
  }
  return p;
}

// The pieces of global drawing k at reference age A: pure in (seed, k, A).
export function wispPieces(seed: number, k: number, A: number): WispPiece[] {
  const which = wispKind(A);
  if (!which) return [];
  const r = rng(seed, 'wisp', k);
  switch (which.kind) {
    case 'spikes':
      return spikes(r);
    case 'slashes':
      return slashes(r);
    case 'arcs':
      return arcs(r);
    case 'splashes':
      return splashes(r, which.step);
  }
}

export interface WispDrawing extends MassDrawing {
  k: number;
  A: number;
  kind: WispKind;
  zoom: number; // each piece's size × this (positions are not)
  pieces: WispPiece[]; // in the floor frame, at the zoom factor 1, after mirroring
}

// The wisps on frame f, or null (before j 9, on A5–6, after A13, past J_end).
export function shapes(ictx: MassContext, f: number): WispDrawing | null {
  const j = f - ictx.I;
  if (j < 9 || j > ictx.jEnd) return null;
  const { k, start, A } = drawingAge(ictx, f);
  const which = wispKind(A);
  if (!which) return null;
  const fr = massFrame(ictx);
  const zoom = ZOOM_PEAK / zoomAt(start - ictx.I);
  const pieces = wispPieces(ictx.seed, k, A).map((p) => intoFrame(fr, fr.U, ictx.width, ictx.height, p));
  const paper = roles(ictx.palette).paper;
  const out: MassShape[] = pieces.map((p) => ({
    role: ROLE[which.kind],
    points: p.points.map(([n, t]) => toFrame(fr, fr.U, [p.anchor[0] + (n - p.anchor[0]) * zoom, p.anchor[1] + (t - p.anchor[1]) * zoom])),
    color: paper,
    round: p.round,
  }));
  return {
    layer: 'front',
    key: `wisp:${massKey(ictx)}:${k}:${A}:${zoom.toFixed(5)}`,
    alpha: wispOpacity(A) * decayAlpha(j, ictx.jEnd),
    shapes: out,
    k,
    A,
    kind: which.kind,
    zoom,
    pieces,
  };
}

export function draw(_ctxBehind: BrushTarget, ctxFront: BrushTarget, _sink: GlowSink, ictx: MassContext, f: number, opaque = false) {
  paint(ctxFront, shapes(ictx, f), opaque);
}
