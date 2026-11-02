// The white wisps (impact design §6, "Wisps"; destruction §4.7, §6.7): jagged
// white tongues with no ink line, in front of the person, on the strict 2s
// clock: a new drawing on every global drawing k, seeded (seed, 'wisp', k),
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
// Every piece is a tongue along its motion (judge round 2: not a ghost blob,
// not a paper triangle): a centreline that keeps its measured length, and a
// width profile scaled to the piece's measured area, its flanks torn into
// teeth (in and out by TEAR of the local width, TOOTH apart). It is painted
// white, opaque at the core (Y ≥ 230 whatever the plate), with a FEATHER
// soft edge (the outline grown twice, at SOFT's opacities, under it) and 2–5
// streaks along its centreline: the comp's soft, bright, streaky veils. The
// white is p1 lifted toward white (WHITE_MIX). The drawing's opacity is 1
// through A4, then eases to 0.85 by A13 as the splashes break up.
// Positions are in U at k0 framing; each piece's own size is × the zoom factor
// (fire.ts), so its area holds on screen. A piece that lands wholly off the
// frame is mirrored back across the floor line through P, else across n̂,
// else both (the hero's P sits on the bottom edge, so the floor side is off
// the frame).
import type { GlowSink } from '../contracts.ts';
import type { BrushTarget } from '../../render/glow.ts';
import { decayAlpha, zoomAt } from '../clock.ts';
import { mixHex, roles } from '../palette.ts';
import { int, rng, uniform, type Rng } from '../rng.ts';
import { ZOOM_PEAK, drawingAge, erodeKeeps, fadeAlpha, massFrame, massKey, memo, paint, polygonArea, toFrame, type FloorPt, type MassContext, type MassDrawing, type MassFrame, type MassShape } from './fire.ts';

export type WispKind = 'spikes' | 'slashes' | 'arcs' | 'splashes';
const ROLE: Record<WispKind, string> = { spikes: 'spike', slashes: 'slash', arcs: 'arc', splashes: 'splash' };
export const wispRole = (kind: WispKind) => ROLE[kind];

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
const OPACITY = [1, 0.85] as const; // through A4, and at A13
export const FEATHER = 0.01; // U: the soft edge
const SOFT = [0.3, 0.55] as const; // the soft edge's two rings, outer and inner
export const WHITE_MIX = 0.035; // the white: this much of p1 in #ffffff (#f6f6f6 or whiter even on a black p1)
const STREAK_TONE = '#a9a39d'; // a streak: this grey …
const STREAK_ALPHA = 0.45; // … at this opacity over the white
export const STREAKS = [2, 5] as const; // per piece
export const TEAR = [0.18, 0.4] as const; // a tooth's depth, × the local half-width
const TOOTH = [0.014, 0.036] as const; // U: tip to tip along a flank
const STREAK_EVERY = 3; // a streak's samples: every this many of the centreline's (0.006 U apart)
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

export const wispOpacity = (A: number) => (A <= 4 ? OPACITY[0] : OPACITY[0] + ((OPACITY[1] - OPACITY[0]) * Math.min(A - 4, 9)) / 9);

// A piece in the floor frame (U, at the zoom factor 1) about its anchor,
// which is where it sits: its core outline, the soft edge's two outlines
// (outer first) and its streaks.
export interface WispPiece {
  anchor: FloorPt;
  points: FloorPt[];
  soft: FloorPt[][];
  streaks: FloorPt[][];
}

// A tongue before it is drawn: its centreline along its motion, and its
// half-width at u in 0..1 along it, in U before the fit to its area.
interface Tongue {
  axis: FloorPt[];
  half: (u: number) => number;
  tear: number; // its teeth's depth, × the local half-width
}

// The centreline resampled every `step` U, with the normalised arc length of each sample.
function resample(axis: readonly FloorPt[], step: number): { pts: FloorPt[]; u: number[] } {
  const cum = [0];
  for (let i = 1; i < axis.length; i++) cum.push(cum[i - 1] + Math.hypot(axis[i][0] - axis[i - 1][0], axis[i][1] - axis[i - 1][1]));
  const total = cum[cum.length - 1] || 1;
  const count = Math.max(2, Math.ceil(total / step));
  const pts: FloorPt[] = [];
  const u: number[] = [];
  let seg = 1;
  for (let q = 0; q <= count; q++) {
    const s = (total * q) / count;
    while (seg < axis.length - 1 && cum[seg] < s) seg++;
    const a = axis[seg - 1];
    const b = axis[seg];
    const w = (s - cum[seg - 1]) / (cum[seg] - cum[seg - 1] || 1);
    pts.push([a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w]);
    u.push(s / total);
  }
  return { pts, u };
}

// One flank's teeth: per sample, out (0.55–1) at a tip and in (0.2–0.45 of
// the depth, inward) at a notch, half a tooth apart, linear between; 0 at both ends.
function teeth(r: Rng, u: readonly number[], length: number): number[] {
  const x = [0];
  const o = [0];
  let out = r() < 0.5;
  for (let at = uniform(r, TOOTH[0], TOOTH[1]) / 2 / length; at < 1 - TOOTH[0] / 2 / length; at += uniform(r, TOOTH[0], TOOTH[1]) / 2 / length) {
    x.push(at);
    o.push(out ? uniform(r, 0.55, 1) : -uniform(r, 0.2, 0.45));
    out = !out;
  }
  x.push(1);
  o.push(0);
  let k = 0;
  return u.map((v) => {
    while (k < x.length - 2 && x[k + 1] < v) k++;
    return o[k] + ((o[k + 1] - o[k]) * (v - x[k])) / (x[k + 1] - x[k] || 1);
  });
}

// A tongue as a piece of `area` U²: its half-widths scaled (its length
// kept) until its torn core covers the area, then the soft edge's outlines
// FEATHER and FEATHER/2 wider, and the streaks.
function tongue(r: Rng, spec: Tongue, area: number): WispPiece {
  const { pts, u } = resample(spec.axis, 0.006);
  let length = 0;
  for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const normals = pts.map((_, i): FloorPt => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
  });
  const left = teeth(r, u, length);
  const right = teeth(r, u, length);
  const base = u.map((v) => Math.max(0, spec.half(v)));
  const outline = (k: number, grow: number): FloorPt[] => {
    const l: FloorPt[] = [];
    const rr: FloorPt[] = [];
    pts.forEach((p, i) => {
      const h = k * base[i];
      const hl = h * (1 + spec.tear * left[i]) + grow;
      const hr = h * (1 + spec.tear * right[i]) + grow;
      l.push([p[0] + normals[i][0] * hl, p[1] + normals[i][1] * hl]);
      rr.push([p[0] - normals[i][0] * hr, p[1] - normals[i][1] * hr]);
    });
    return [...l, ...rr.reverse()];
  };
  let k = 1;
  for (let i = 0; i < 3; i++) k *= area / Math.max(1e-9, polygonArea(outline(k, 0)));
  const points = outline(k, 0);
  // Streaks: thin slivers along the centreline, each over 30–80 % of it, at
  // its own place across, 0.12–0.2 of the local half-width wide. They are
  // smooth, so every STREAK_EVERY-th sample draws them.
  const streaks: FloorPt[][] = [];
  for (let s = int(r, STREAKS[0], STREAKS[1]); s > 0; s--) {
    const span = uniform(r, 0.3, 0.8);
    const u0 = uniform(r, 0.05, 0.95 - span);
    const across = uniform(r, -0.55, 0.55);
    const w = uniform(r, 0.12, 0.2);
    const l: FloorPt[] = [];
    const rr: FloorPt[] = [];
    pts.forEach((p, i) => {
      if (u[i] < u0 || u[i] > u0 + span || i % STREAK_EVERY !== 0) return;
      const h = k * base[i];
      const v = Math.sin((Math.PI * (u[i] - u0)) / span);
      const c = across * h;
      l.push([p[0] + normals[i][0] * (c + w * h * v), p[1] + normals[i][1] * (c + w * h * v)]);
      rr.push([p[0] + normals[i][0] * (c - w * h * v), p[1] + normals[i][1] * (c - w * h * v)]);
    });
    if (l.length >= 2) streaks.push([...l, ...rr.reverse()]);
  }
  return { anchor: centroid(points), points, soft: [outline(k, FEATHER), outline(k, FEATHER / 2)], streaks };
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

// A straight centreline from a to b, `count` points.
const line = (a: FloorPt, b: FloorPt, count = 9): FloorPt[] => Array.from({ length: count }, (_, q) => [a[0] + ((b[0] - a[0]) * q) / (count - 1), a[1] + ((b[1] - a[1]) * q) / (count - 1)]);

// A0: tapered spikes along the floor line, rooted near P, both ways.
function spikes(r: Rng): WispPiece[] {
  const count = int(r, SPIKES.count[0], SPIKES.count[1]);
  const areas = shares(r, count, SPIKES.biggest / SPIKES.area).map((s) => s * SPIKES.area);
  return areas.map((area, i) => {
    const side = i % 2 === 0 ? 1 : -1;
    const root: FloorPt = [uniform(r, 0.03, 0.06), side * uniform(r, 0.06, 0.14)];
    const length = uniform(r, 0.3, 0.46);
    const lift = uniform(r, 5, 25) * DEG; // above the floor line
    const bend = uniform(r, -0.04, 0.04);
    const axis: FloorPt[] = Array.from({ length: 9 }, (_, q) => {
      const u = q / 8;
      return [root[0] + length * u * Math.sin(lift) + bend * Math.sin(Math.PI * u), root[1] + side * length * u * Math.cos(lift)];
    });
    return tongue(r, { axis, half: (u) => (u < 0.12 ? 0.4 + 5 * u : 1) * (1 - u) ** 1.1, tear: uniform(r, TEAR[0], TEAR[1]) }, area);
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
  const out = [tongue(r, { axis, half: (u) => 0.15 + Math.sin(Math.PI * u) ** 0.7, tear: uniform(r, TEAR[0], TEAR[1]) }, SLASHES.complex)];
  const count = int(r, SLASHES.slivers[0], SLASHES.slivers[1]);
  const areas = shares(r, count).map((s) => s * (SLASHES.area - SLASHES.complex));
  for (const area of areas) {
    const phi = uniform(r, -45, 45) * DEG;
    const rho = uniform(r, 0.38, 0.62);
    const c: FloorPt = [rho * Math.cos(phi), rho * Math.sin(phi)];
    const dir = phi + uniform(r, 60, 120) * DEG * (r() < 0.5 ? 1 : -1);
    const len = uniform(r, 0.1, 0.18);
    const a: FloorPt = [c[0] - (Math.cos(dir) * len) / 2, c[1] - (Math.sin(dir) * len) / 2];
    const b: FloorPt = [c[0] + (Math.cos(dir) * len) / 2, c[1] + (Math.sin(dir) * len) / 2];
    out.push(tongue(r, { axis: line(a, b), half: (u) => Math.sin(Math.PI * Math.min(1, 0.1 + u * 0.9)), tear: uniform(r, TEAR[0], TEAR[1]) }, area));
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
  const arc = tongue(r, { axis, half: (u) => (0.05 + Math.sin(Math.PI * u) ** 0.8) * (1 + 0.18 * Math.sin(5 * Math.PI * u + wob[0])), tear: uniform(r, TEAR[0], TEAR[1]) }, ARCS.arc);
  const at = uniform(r, -12, 12) * DEG;
  const span = uniform(r, 22, 28) * DEG;
  const cap: FloorPt[] = Array.from({ length: 17 }, (_, q) => {
    const phi = at - span + (2 * span * q) / 16;
    return [ARCS.capR * Math.cos(phi), ARCS.capR * Math.sin(phi)];
  });
  const capPiece = tongue(r, { axis: cap, half: (u) => (0.05 + Math.sin(Math.PI * u) ** 0.9) * (1 + 0.15 * Math.sin(3 * Math.PI * u + wob[1])), tear: uniform(r, TEAR[0], TEAR[1]) }, ARCS.cap);
  return [arc, capPiece];
}

// A7–13: torn-paper splashes, stretched along the ring they broke off: a
// tongue across its ray, as long as its stretch makes it.
function splashes(r: Rng, step: number): WispPiece[] {
  const count = SPLASHES.count[step];
  const total = SPLASHES.area[step];
  const areas = shares(r, count, SPLASHES.biggest[step]).map((s) => s * total);
  return areas.map((area) => {
    const phi = uniform(r, -180, 180) * DEG;
    const rho = SPLASHES.r[step] + uniform(r, -0.2, 0.2);
    const anchor: FloorPt = [rho * Math.cos(phi), rho * Math.sin(phi)];
    const stretch = uniform(r, 1.8, 5);
    // Its length from its area and stretch: an ellipse of semi-axes a, a/stretch.
    const a = Math.sqrt((area * stretch) / Math.PI);
    const dir = phi + Math.PI / 2 + uniform(r, -0.3, 0.3);
    const bend = uniform(r, -0.25, 0.25) * a;
    const axis: FloorPt[] = Array.from({ length: 9 }, (_, q) => {
      const u = q / 8 - 0.5;
      const off = bend * (1 - 4 * u * u);
      return [anchor[0] + 2 * a * u * Math.cos(dir) - off * Math.sin(dir), anchor[1] + 2 * a * u * Math.sin(dir) + off * Math.cos(dir)];
    });
    return tongue(r, { axis, half: (u) => Math.sqrt(Math.max(0, 1 - (2 * u - 1) ** 2)) ** 0.8, tear: uniform(r, 0.3, 0.5) }, area);
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
    const all = (list: FloorPt[][]) => list.map((pts) => pts.map(flip).reverse());
    return { anchor: flip(p.anchor), points: p.points.map(flip).reverse(), soft: all(p.soft), streaks: all(p.streaks) };
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

// The wisps on frame f, or null (before j 9, on A5–6, after A13, past J_end):
// every piece's soft edge (outer ring, then inner), then the white cores,
// then the streaks. A drawing that starts in the decay (a short hold) keeps
// the pieces the seeded erosion order keeps, and fades only on the last
// frames (fire.ts fadeAlpha), as the masses do.
export function shapes(ictx: MassContext, f: number): WispDrawing | null {
  const j = f - ictx.I;
  if (j < 9 || j > ictx.jEnd) return null;
  const { k, start, A } = drawingAge(ictx, f);
  const which = wispKind(A);
  if (!which) return null;
  const zoom = ZOOM_PEAK / zoomAt(start - ictx.I);
  const erode = decayAlpha(start - ictx.I, ictx.jEnd);
  const key = `wisp:${massKey(ictx)}:${k}:${A}:${zoom.toFixed(5)}:${erode.toFixed(4)}:${ictx.flash === 'safe' ? 'p1' : 'white'}`;
  // A drawing holds over its frames: built once (design §10).
  const built = memo(BUILT, key, () => build(ictx, k, A, which.kind, zoom, erode), 8);
  return {
    layer: 'front',
    key,
    alpha: wispOpacity(A) * fadeAlpha(j, ictx.jEnd),
    shapes: built.shapes,
    k,
    A,
    kind: which.kind,
    zoom,
    pieces: built.pieces,
  };
}

const BUILT = new Map<string, { shapes: MassShape[]; pieces: WispPiece[] }>();
function build(ictx: MassContext, k: number, A: number, kind: WispKind, zoom: number, erode: number): { shapes: MassShape[]; pieces: WispPiece[] } {
  const fr = massFrame(ictx);
  const pieces = wispPieces(ictx.seed, k, A)
    .filter((_, i) => erodeKeeps(ictx.seed, 'wisp', 1000 * k + i, erode))
    .map((p) => intoFrame(fr, fr.U, ictx.width, ictx.height, p));
  // Reduce flashing paints p1 itself: the scene's gentle cap on the wisps
  // (washes.ts liftCap) is worked out for p1, and the white would lift past it.
  const paper = roles(ictx.palette).paper;
  const white = ictx.flash === 'safe' ? paper : wispWhite(paper);
  const role = ROLE[kind];
  const px = (p: WispPiece, pts: readonly FloorPt[]) => pts.map(([n, t]) => toFrame(fr, fr.U, [p.anchor[0] + (n - p.anchor[0]) * zoom, p.anchor[1] + (t - p.anchor[1]) * zoom]));
  const out: MassShape[] = [];
  SOFT.forEach((alpha, ring) => {
    for (const p of pieces) out.push({ role: `${role}-soft`, points: px(p, p.soft[ring]), color: white, alpha });
  });
  for (const p of pieces) out.push({ role, points: px(p, p.points), color: white });
  for (const p of pieces) for (const s of p.streaks) out.push({ role: `${role}-streak`, points: px(p, s), color: STREAK_TONE, alpha: STREAK_ALPHA });
  return { shapes: out, pieces };
}

// The wisps' white: p1 lifted toward white, so it reads white (#f6f6f6–#ffffff, Y ≥ 230) on
// any plate whatever the palette's paper.
export const wispWhite = (paper: string): string => mixHex('#ffffff', paper, WHITE_MIX);

export function draw(_ctxBehind: BrushTarget, ctxFront: BrushTarget, _sink: GlowSink, ictx: MassContext, f: number, opaque = false) {
  paint(ctxFront, shapes(ictx, f), opaque);
}
