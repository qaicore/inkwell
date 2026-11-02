// Round 3, F2: the seven impact frames against k7–k13, the judges' findings
// reference:1, 2, 9, 10, 11, 17, 18, 19 and motion:3. Offline and
// deterministic: the synthetic crouch, the helper's copy of the hero's cracks,
// @napi-rs/canvas.
import { createHash } from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { nullSink, type Crack, type Palette, type Vec2 } from '../../src/impact/contracts.ts';
import { strikeFrame } from '../../src/impact/floor.ts';
import { mixHex } from '../../src/impact/palette.ts';
import { clippedArea, drawPoster, EDGE, HAIR, openPaper, posterShapes, posterTones, Z, type PosterContext, type PosterShape } from '../../src/impact/frames/draw.ts';
import { crackFromStroke, NO_FIGURE, posterFigure, signedArea, syntheticCrouch, type PosterFigure, type PosterTarget } from '../../src/impact/frames/figure.ts';
import { posterSpec } from '../../src/impact/frames/gentle.ts';
import { clippedEdges, cornersIn, discCover, posterLayout, SPLIT_COVER, SPLIT_SHORT, splitDisc, withSide } from '../../src/impact/frames/layout.ts';
import { nodeScratch } from '../../src/render/headless.ts';
import { HERO, HERO_CRACKS } from './helpers/impact-drawings.ts';

const TEST: Palette = ['#e8203a', '#f4f1ea', '#16141a']; // the app's default and the test drawings'
const K = 1080 / HERO.width;

interface Geo {
  width: number;
  height: number;
  P: Vec2;
  d: Vec2;
  h?: 1 | -1;
}
const REF: Geo = { width: 1080, height: 634, P: [520, 388], d: [-0.8, 0.6], h: 1 };
const HERO608: Geo = { width: 1080, height: 608, P: [HERO.P[0] * K, HERO.P[1] * K], d: [HERO.d[0], HERO.d[1]] };
const PORTRAIT: Geo = { width: 608, height: 1080, P: [300, 1040], d: [0, 1] };

function context(g: Geo, flash: 'full' | 'safe' = 'full', seed: number = HERO.seed): PosterContext {
  const S = Math.min(g.width, g.height);
  const base = strikeFrame(g.P, g.d, S, 1, g.width, g.height, seed);
  return { frame: g.h ? withSide(base, g.h) : base, width: g.width, height: g.height, seed, palette: TEST, flash };
}

// The synthetic crouch with the hero's cracks, moved to the context's P.
function figure(ictx: PosterContext, si: number): PosterFigure {
  const { P, S, u } = ictx.frame;
  const k = S / HERO.S;
  const cracks: Crack[] = HERO_CRACKS.map((s) =>
    crackFromStroke({ id: s.id, points: s.points.map(([x, y]): Vec2 => [P[0] + (x - HERO.P[0]) * k, P[1] + (y - HERO.P[1]) * k]), pressure: s.pressure, width: s.width.map((w) => w * k) }, P, S, ictx.width),
  );
  const crouch = syntheticCrouch(ictx.width, ictx.height, P, u, S);
  return posterFigure({ I: HERO.I, frame: ictx.frame, width: ictx.width, height: ictx.height, cracks, crackEase: 'out', personMask: () => crouch.mask }, si, { person: crouch.mask, limbs: crouch.limbs });
}

function render(ictx: PosterContext, si: number, fig: PosterFigure = NO_FIGURE, flat = false): Uint8ClampedArray {
  const canvas = createCanvas(ictx.width, ictx.height);
  const ctx = canvas.getContext('2d');
  drawPoster(ctx as unknown as PosterTarget, nullSink, ictx, si, fig, { flat, scratch: nodeScratch });
  return ctx.getImageData(0, 0, ictx.width, ictx.height).data;
}

const luma = (d: Uint8ClampedArray, i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
const rgbOf = (hex: string) => [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));
const near = (d: Uint8ClampedArray, i: number, hex: string, tol: number) => rgbOf(hex).every((c, k) => Math.abs(d[i + k] - c) <= tol);
const at = (w: number, [x, y]: Vec2) => 4 * (Math.floor(y) * w + Math.floor(x));

// Black and white shares, Rec.601 luma < 40 and ≥ 230.
function shares(d: Uint8ClampedArray): { black: number; white: number } {
  let black = 0;
  let white = 0;
  for (let i = 0; i < d.length; i += 4) {
    const y = luma(d, i);
    if (y < 40) black++;
    else if (y >= 230) white++;
  }
  return { black: (4 * black) / d.length, white: (4 * white) / d.length };
}

const median = (xs: number[]) => {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];

// The widest two vertices apart: a thin shape's length.
function diameter(poly: readonly Vec2[]): number {
  let m = 0;
  for (let i = 0; i < poly.length; i++) for (let j = i + 1; j < poly.length; j++) m = Math.max(m, dist(poly[i], poly[j]));
  return m;
}

// The polygon's width across the line {p : (p − o)·e = x}.
function crossSection(poly: readonly Vec2[], o: Vec2, e: Vec2, x: number): number {
  const n: Vec2 = [-e[1], e[0]];
  const hits: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const sa = dot(sub(a, o), e) - x;
    const sb = dot(sub(b, o), e) - x;
    if (sa === sb || sa * sb > 0) continue;
    const t = sa / (sa - sb);
    const p: Vec2 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    hits.push(dot(sub(p, o), n));
  }
  return hits.length < 2 ? 0 : Math.max(...hits) - Math.min(...hits);
}

function pointIn(poly: readonly Vec2[], [x, y]: Vec2): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Inside his body (even-odd over his loops, holes out) and `margin` px from its edge.
function inBody(fig: PosterFigure, p: Vec2, margin: number): boolean {
  const loops = [...fig.person, ...fig.limbs];
  if (!loops.some((l) => pointIn(l, p))) return false;
  for (const l of loops) {
    for (let i = 0; i < l.length; i++) {
      const a = l[i];
      const b = l[(i + 1) % l.length];
      const ab = sub(b, a);
      const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / Math.max(1e-9, dot(ab, ab))));
      if (dist(p, [a[0] + ab[0] * t, a[1] + ab[1] * t]) < margin) return false;
    }
  }
  return true;
}

const centroid = (poly: readonly Vec2[]): Vec2 => [poly.reduce((s, p) => s + p[0], 0) / poly.length, poly.reduce((s, p) => s + p[1], 0) / poly.length];
const batch = (shapes: readonly PosterShape[], z: number, role: string, hair = false) => shapes.filter((s) => s.z === z && s.role === role && !!s.of === hair && s.polys);

describe('IF2 split (reference:2)', () => {
  it("swings the hero's disc so it splits the frame: clipped by two edges or more, holding a corner, over 42–52 % of it", () => {
    for (const seed of [HERO.seed, 1, 2, 3]) {
      const ictx = context(HERO608, 'full', seed);
      const L = posterLayout(ictx);
      const c = L.physical.disc2;
      const r = dist(c, L.P) - SPLIT_SHORT * L.S;
      expect(clippedEdges(c, r, L.width, L.height), `seed ${seed}`).toBeGreaterThanOrEqual(2);
      expect(cornersIn(c, r, L.width, L.height), `seed ${seed}`).toBeGreaterThanOrEqual(1);
      const cover = discCover(c, r, L.width, L.height);
      expect(cover, `seed ${seed}`).toBeGreaterThanOrEqual(SPLIT_COVER[0]);
      expect(cover, `seed ${seed}`).toBeLessThanOrEqual(SPLIT_COVER[1]);
    }
    // The hero's, as the judges placed it: about X(−0.35, −0.55), cover 50 %.
    const L = posterLayout(context(HERO608));
    const ab = [dot(sub(L.physical.disc2, L.P), L.u) / L.S, dot(sub(L.physical.disc2, L.P), L.v) / L.S];
    expect(Math.abs(ab[0] + 0.35)).toBeLessThan(0.08);
    expect(Math.abs(ab[1] + 0.55)).toBeLessThan(0.08);
  });

  it("keeps a disc that already splits the frame, as the reference geometry's and a portrait's do", () => {
    for (const g of [REF, PORTRAIT]) {
      const L = posterLayout(context(g));
      const again = splitDisc(L.P, L.u, L.v, L.S, L.width, L.height, L.physical.disc2);
      expect(again.c).toEqual(L.physical.disc2);
      expect(again.edges).toBeGreaterThanOrEqual(2);
      expect(again.corners).toBeGreaterThanOrEqual(1);
    }
  });

  it('fills it with p2, its 0.006 S edge band in the warm thin ink, the edge feathered by 12–20 hairy tongues', () => {
    const ictx = context(HERO608);
    const L = posterLayout(ictx);
    const draft = posterShapes(ictx, 1);
    const [disc] = draft.shapes.filter((s) => s.z === Z.element && s.role === 'fg' && s.core);
    expect(disc?.polys?.length).toBe(1);
    expect(draft.counts.tongues).toBeGreaterThanOrEqual(12);
    expect(draft.counts.tongues).toBeLessThanOrEqual(20);
    const tongues = draft.shapes.find((s) => s.z === Z.element && s.role === 'bg' && !s.of && (s.polys?.length ?? 0) > draft.counts.tongues);
    expect(tongues, 'the tongues with their hairs').toBeDefined();
    const data = render(ictx, 1);
    const T = posterTones(TEST, posterSpec(1, 'full'));
    expect(T.fg).toBe(TEST[2]);
    expect(T.edge).toBe(mixHex(TEST[2], '#5e2710', 0.85));
    // Deep inside: p2.
    const R = dist(L.physical.disc2, L.P) - SPLIT_SHORT * L.S;
    let deep = 0;
    let ink = 0;
    for (let y = 2; y < L.height; y += 7) {
      for (let x = 2; x < L.width; x += 7) {
        if (dist([x, y], L.physical.disc2) > R - 0.1 * L.S) continue;
        deep++;
        if (near(data, at(L.width, [x, y]), TEST[2], 0)) ink++;
      }
    }
    expect(deep).toBeGreaterThan(1000);
    expect(ink / deep).toBeGreaterThan(0.99);
    // Half an EDGE in from the edge: the warm band, where no tongue, comb
    // spike or paper hair lies over it; never p2.
    const poly = (disc.polys as Vec2[][])[0];
    const paper = draft.shapes.filter((s) => s.z === Z.element && s.role === 'bg').flatMap((s) => (s.polys ?? []) as Vec2[][]);
    const covered = (m: Vec2) => paper.some((p) => pointIn(p, m));
    let band = 0;
    let warm = 0;
    let black = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const t = sub(q, p);
      const l = Math.hypot(t[0], t[1]);
      const m: Vec2 = [(p[0] + q[0]) / 2 + (t[1] / l) * -0.5 * EDGE * L.S, (p[1] + q[1]) / 2 - (t[0] / l) * -0.5 * EDGE * L.S];
      if (m[0] < 2 || m[1] < 2 || m[0] > L.width - 2 || m[1] > L.height - 2 || covered(m)) continue;
      band++;
      if (near(data, at(L.width, m), T.edge as string, 12)) warm++;
      if (near(data, at(L.width, m), TEST[2], 4)) black++;
    }
    expect(band).toBeGreaterThan(40);
    expect(warm / band).toBeGreaterThan(0.35);
    expect(black / band).toBeLessThan(0.1);
  });

  it("combs the comp's visible edge with fine paper spikes biting 0.01–0.055 S in, 10–16 to each 0.1 S of it, clear of him", () => {
    const draft = posterShapes(context(HERO608), 1);
    const { L } = draft;
    const S = L.S;
    const D = L.physical.disc2;
    const R = dist(D, L.P) - SPLIT_SHORT * S;
    const [disc] = draft.shapes.filter((s) => s.z === Z.element && s.role === 'fg' && s.core);
    const edge = (disc.polys as Vec2[][])[0];
    const papers = draft.shapes.filter((s) => s.z === Z.element && s.role === 'bg' && !s.of);
    const comb = papers.find((s) => s.polys?.length === draft.counts.comb);
    expect(comb, 'the comb, after the tongues').toBeDefined();
    const spikes = comb!.polys as Vec2[][];
    // The visible edge, 0.01 S inside the frame and over 0.2 S from P, in
    // steps of the disc's own (unrippled) arc, as the spikes are spread.
    let visible = 0;
    for (let k = 0; k < 3600; k++) {
      const th = (2 * Math.PI * k) / 3600;
      const E: Vec2 = [D[0] + R * Math.cos(th), D[1] + R * Math.sin(th)];
      const m = 0.01 * S;
      if (E[0] >= m && E[1] >= m && E[0] <= L.width - m && E[1] <= L.height - m && dist(E, L.P) > 0.2 * S) visible += (2 * Math.PI * R) / 3600;
    }
    const per = spikes.length / (visible / (0.1 * S));
    expect(per).toBeGreaterThanOrEqual(9);
    expect(per).toBeLessThanOrEqual(17);
    let rooted = 0;
    let biting = 0;
    for (const p of spikes) {
      const root: Vec2 = [(p[0][0] + p[p.length - 1][0]) / 2, (p[0][1] + p[p.length - 1][1]) / 2];
      const tip = p.reduce((m, q) => (dist(q, root) > dist(m, root) ? q : m), p[0]);
      const l = dist(tip, root) / S;
      expect(l).toBeGreaterThanOrEqual(0.013 - 1e-3);
      expect(l).toBeLessThanOrEqual(0.058 + 1e-3);
      expect(dist(root, L.P) / S).toBeGreaterThan(0.2);
      if (!pointIn(edge, root)) rooted++;
      if (pointIn(edge, tip)) biting++;
    }
    expect(rooted / spikes.length, 'rooted just outside the edge').toBeGreaterThan(0.95);
    expect(biting / spikes.length, 'tips inside the disc').toBeGreaterThan(0.95);
    // The flat poster and gentle mode's tinted disc keep their own edges.
    expect(posterShapes(context(HERO608), 1, { flat: true }).counts.comb ?? 0).toBe(0);
    expect(posterShapes(context(HERO608, 'safe'), 1).counts.comb ?? 0).toBe(0);
  });
});

describe('IF6 streaks (reference:1)', () => {
  it('slides V6 onto the frame and throws 21 wedges or more, each at least half on it, 0.04–0.2 S up −u from V6', () => {
    for (const g of [HERO608, REF, PORTRAIT]) {
      const draft = posterShapes(context(g), 5);
      const { L } = draft;
      const V6 = L.physical.V6;
      expect(V6[0] >= 0 && V6[0] <= L.width && V6[1] >= 0 && V6[1] <= L.height, `V6 ${V6.map((c) => c.toFixed(0))}`).toBe(true);
      const [fan] = batch(draft.shapes, Z.over, 'accent');
      const wedges = fan.polys as Vec2[][];
      expect(wedges.length).toBeGreaterThanOrEqual(21);
      for (const w of wedges) {
        expect(clippedArea(w, L.width, L.height)).toBeGreaterThanOrEqual(0.5 * Math.abs(signedArea(w)) - 1e-6);
        const A: Vec2 = [(w[0][0] + w[w.length - 1][0]) / 2, (w[0][1] + w[w.length - 1][1]) / 2]; // the base's middle
        const from = dist(A, V6) / L.S;
        expect(from).toBeGreaterThanOrEqual(0.04 - 1e-6);
        expect(from).toBeLessThanOrEqual(0.2 + 1e-6);
        expect(dot(sub(A, V6), L.u)).toBeLessThan(0); // up −u
      }
    }
    // The hero's V6, slid as the HUD is: about (548, 603).
    const V6 = posterLayout(context(HERO608)).physical.V6;
    expect(dist(V6, [548, 603])).toBeLessThan(12);
  });

  it('lays the fan and the recoil copies on his paper fill', () => {
    const ictx = context(HERO608);
    const fig = figure(ictx, 5);
    const data = render(ictx, 5, fig);
    const paper = posterTones(TEST, posterSpec(5, 'full')).bg;
    let inside = 0;
    let marked = 0;
    for (let y = 1; y < ictx.height; y += 3) {
      for (let x = 1; x < ictx.width; x += 3) {
        if (!inBody(fig, [x, y], 4)) continue;
        inside++;
        if (!near(data, at(ictx.width, [x, y]), paper, 6)) marked++;
      }
    }
    expect(inside).toBeGreaterThan(500);
    expect(marked / inside).toBeGreaterThan(0.1);
  });
});

describe('IF3 radial (reference:11, motion:3)', () => {
  it('draws 16 ± 3 inner lines and 61 ± 6 in all, each broken into 2–4 dashes, over his paper fill', () => {
    for (const g of [HERO608, REF, PORTRAIT]) {
      const draft = posterShapes(context(g), 2);
      expect(draft.counts.inner).toBeGreaterThanOrEqual(13);
      expect(draft.counts.inner).toBeLessThanOrEqual(19);
      expect(draft.counts.lines).toBeGreaterThanOrEqual(55);
      expect(draft.counts.lines).toBeLessThanOrEqual(67);
      const [lines] = batch(draft.shapes, Z.over, 'fg');
      const dashes = (lines.polys as Vec2[][]).length;
      expect(dashes).toBeGreaterThanOrEqual(2 * draft.counts.lines);
      expect(dashes).toBeLessThanOrEqual(4 * draft.counts.lines);
      expect(draft.shapes.some((s) => s.z === Z.line)).toBe(false);
    }
  });

  it("keeps the dashes k9's brush width: 0.006 S at the median, 0.012 S at the 90th percentile", () => {
    // The lines' widths are held to those exactly; a dash's 2–4 share its
    // line's, so the dashes' own percentiles stray a little round them.
    for (const g of [HERO608, REF, PORTRAIT]) {
      const all: number[] = [];
      for (const seed of [HERO.seed, 1, 2, 3]) {
        const draft = posterShapes(context(g, 'full', seed), 2);
        const S = draft.L.S;
        // A spindle's area is 0.59 of its length times its widest width.
        const widths = (batch(draft.shapes, Z.over, 'fg')[0].polys as Vec2[][]).map((p) => Math.abs(signedArea(p)) / (0.59 * diameter(p)) / S).sort((a, b) => a - b);
        expect(median(widths)).toBeGreaterThanOrEqual(0.0055);
        expect(median(widths)).toBeLessThanOrEqual(0.0065);
        expect(widths[Math.floor(0.9 * widths.length)]).toBeGreaterThanOrEqual(0.0095);
        expect(widths[Math.floor(0.9 * widths.length)]).toBeLessThanOrEqual(0.0135);
        all.push(...widths);
      }
      all.sort((a, b) => a - b);
      expect(all[Math.floor(0.9 * all.length)]).toBeGreaterThanOrEqual(0.0105);
      expect(all[Math.floor(0.9 * all.length)]).toBeLessThanOrEqual(0.013);
    }
  });

  it('shows the lines across his body', () => {
    const ictx = context(HERO608);
    const fig = figure(ictx, 2);
    const data = render(ictx, 2, fig);
    const draft = posterShapes(ictx, 2);
    const paper = luma(new Uint8ClampedArray([...rgbOf(posterTones(TEST, posterSpec(2, 'full')).bg), 255]), 0);
    let over = 0;
    let shown = 0;
    for (const dash of batch(draft.shapes, Z.over, 'fg')[0].polys as Vec2[][]) {
      // The dash's widest point: its spindle's 0.4 mark, between its ends.
      const c = centroid(dash);
      if (!inBody(fig, c, 3)) continue;
      over++;
      if (luma(data, at(ictx.width, c)) < paper - 15) shown++;
    }
    expect(over).toBeGreaterThanOrEqual(3);
    expect(shown / over).toBeGreaterThanOrEqual(0.6);
  });
});

describe('IF1 whiteout (reference:10)', () => {
  it("tints toward the beam's fill with its ink plum, and keeps 55 % of the frame at luma 230 or more", () => {
    const T = posterTones(TEST, posterSpec(0, 'full'));
    expect(T.fg).toBe(mixHex(TEST[2], TEST[0], 0.3));
    expect(T.edge).toBe(T.fg); // no thickness grade on the plum
    const ictx = context(HERO608);
    expect(shares(render(ictx, 0, figure(ictx, 0))).white).toBeGreaterThanOrEqual(0.55);
  });

  it('throws 46 ± 6 spray spindles, median 0.054 S long and 0.008 S wide, none over 0.29 S', () => {
    for (const g of [HERO608, REF]) {
      const draft = posterShapes(context(g), 0);
      const [spray] = batch(draft.shapes, Z.line, 'accent');
      const polys = spray.polys as Vec2[][];
      expect(polys.length).toBeGreaterThanOrEqual(40);
      expect(polys.length).toBeLessThanOrEqual(52);
      expect(draft.counts.spray).toBe(polys.length);
      const S = draft.L.S;
      const lengths = polys.map((p) => diameter(p) / S);
      const widths = polys.map((p, i) => Math.abs(signedArea(p)) / (0.59 * lengths[i] * S) / S); // a spindle's area is 0.59 of length × width
      expect(median(lengths)).toBeGreaterThan(0.045);
      expect(median(lengths)).toBeLessThan(0.065);
      expect(Math.max(...lengths)).toBeLessThanOrEqual(0.29 + 1e-6);
      expect(median(widths)).toBeGreaterThan(0.0065);
      expect(median(widths)).toBeLessThan(0.0095);
    }
  });
});

describe('IF4 star (reference:17)', () => {
  it("strokes the small stars' rings whole, 0.003 S wide, in ink", () => {
    const draft = posterShapes(context(HERO608), 3);
    const rings = draft.shapes.filter((s) => s.z === Z.hud && s.arcs?.length);
    expect(rings).toHaveLength(1);
    expect(rings[0].role).toBe('fg');
    expect(rings[0].width).toBeCloseTo(0.003 * draft.L.S, 6);
    for (const a of rings[0].arcs ?? []) expect(a.a1 - a.a0).toBeCloseTo(2 * Math.PI, 9);
  });

  it('puts dry-brush hair on the spikes and the arms (the comp only), 0.01–0.04 S long and 1–2 px wide', () => {
    const draft = posterShapes(context(HERO608), 3);
    const S = draft.L.S;
    const hair = draft.shapes.filter((s) => s.of || (s.z === Z.star && s.role === 'bg'));
    expect(batch(draft.shapes, Z.element, 'fg', true)[0]?.polys?.length).toBeGreaterThan(20);
    expect(draft.shapes.filter((s) => s.z === Z.star && (s.role === 'bg' || (s.role === 'fg' && !s.core))).reduce((n, s) => n + (s.polys?.length ?? 0), 0)).toBeGreaterThan(20);
    for (const s of hair) {
      for (const p of s.polys ?? []) {
        const l = diameter(p);
        expect(l / S).toBeGreaterThanOrEqual(HAIR.length[0] - 1e-6);
        expect(l / S).toBeLessThanOrEqual(HAIR.length[1] + 1e-6);
        expect(Math.abs(signedArea(p)) / l).toBeLessThanOrEqual(HAIR.width[1]); // mean width, under the widest
      }
    }
    expect(posterShapes(context(HERO608), 3, { flat: true }).shapes.some((s) => s.of)).toBe(false);
  });

  it('keeps 5 % of the frame black on the hero: thick ink stays p2', () => {
    const ictx = context(HERO608);
    expect(shares(render(ictx, 3, figure(ictx, 3))).black).toBeGreaterThanOrEqual(0.05);
  });
});

describe('IF5 negative cross (reference:18)', () => {
  it('keeps its arms 0.025–0.038 S wide from 0.5 to 0.8 S out', () => {
    for (const g of [HERO608, REF]) {
      const draft = posterShapes(context(g), 4);
      const G = draft.centre as Vec2;
      const S = draft.L.S;
      const arms = draft.shapes.filter((s) => s.z === Z.star && s.role === 'fg').flatMap((s) => s.polys ?? []);
      expect(arms).toHaveLength(4);
      let measured = 0;
      for (const arm of arms) {
        const far = arm.reduce((m, p) => (dist(p, G) > dist(m, G) ? p : m), arm[0]);
        const e: Vec2 = [(far[0] - G[0]) / dist(far, G), (far[1] - G[1]) / dist(far, G)];
        for (const x of [0.5, 0.65, 0.8]) {
          if (x * S > dist(far, G) - 0.05 * S) continue;
          const w = crossSection(arm, G, e, x * S) / S;
          expect(w, `${x} S out`).toBeGreaterThanOrEqual(0.025 * 0.92);
          expect(w, `${x} S out`).toBeLessThanOrEqual(0.038);
          measured++;
        }
      }
      expect(measured).toBeGreaterThanOrEqual(4);
    }
  });
});

describe('IF7 negative strike (reference:19)', () => {
  it("tears the comet's edges with irregular teeth, 0.01–0.05 S apart and 0.005–0.03 S deep", () => {
    const draft = posterShapes(context(HERO608), 6);
    const { L } = draft;
    const S = L.S;
    const comet = draft.shapes.filter((s) => s.z === Z.element && s.role === 'fg' && s.glow).flatMap((s) => s.polys ?? [])[0];
    // Its axis is −u tilted up to 2°: the tilt at which a tooth's notch and
    // its tip line up across it (projections equal along it).
    const score = (deg: number) => {
      const th = Math.atan2(-L.u[1], -L.u[0]) + (deg * Math.PI) / 180;
      let sum = 0;
      for (let i = 0; i < comet.length; i++) {
        const a = comet[i];
        const b = comet[(i + 1) % comet.length];
        sum += Math.min(0.002 * S, Math.abs((b[0] - a[0]) * Math.cos(th) + (b[1] - a[1]) * Math.sin(th)));
      }
      return sum;
    };
    let tilt = 0;
    for (let deg = -3; deg <= 3; deg += 0.02) if (score(deg) < score(tilt)) tilt = deg;
    for (let deg = tilt - 0.03; deg <= tilt + 0.03; deg += 0.0002) if (score(deg) < score(tilt)) tilt = deg;
    const th = Math.atan2(-L.u[1], -L.u[0]) + (tilt * Math.PI) / 180;
    const ax: Vec2 = [Math.cos(th), Math.sin(th)];
    const n: Vec2 = [-ax[1], ax[0]];
    const end: Vec2 = comet.reduce((m, p) => (dot(sub(p, L.P), ax) > dot(sub(m, L.P), ax) ? p : m), comet[0]);
    for (const side of [1, -1]) {
      // Past the head: each s holds a notch and a tooth's tip, the tip further out.
      const bySide = comet.map((p): [number, number] => [dot(sub(p, L.P), ax) / S, (side * dot(sub(p, L.P), n)) / S]).filter(([s, h]) => s > 1e-4 && h > 0 && s < dot(sub(end, L.P), ax) / S - 0.06);
      // Vertices 1e-4 S apart or less along the axis share an s.
      const groups: { s: number; hs: number[] }[] = [];
      for (const [s, h] of bySide.sort((a, b) => a[0] - b[0])) {
        const last = groups[groups.length - 1];
        if (last && s - last.s < 1e-4) last.hs.push(h);
        else groups.push({ s, hs: [h] });
      }
      const keys = groups.map((g) => g.s);
      const gaps = keys.slice(1).map((s, i) => s - keys[i]);
      expect(gaps.length).toBeGreaterThan(10);
      for (const g of gaps) {
        expect(g).toBeGreaterThanOrEqual(0.01 - 1e-6);
        expect(g).toBeLessThanOrEqual(0.05 + 1e-6);
      }
      const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length);
      expect(sd / mean, 'irregular').toBeGreaterThan(0.2);
      const depths = groups.filter((g) => g.hs.length === 2).map((g) => Math.abs(g.hs[0] - g.hs[1]));
      expect(depths.length).toBeGreaterThan(10);
      for (const dpt of depths) {
        expect(dpt).toBeGreaterThanOrEqual(0.005 - 1e-6);
        expect(dpt).toBeLessThanOrEqual(0.03 + 1e-6);
      }
    }
  });

  it('bursts 6–12 ragged blades 0.05–0.2 S long out of the comet at P, each with a hairline, over him', () => {
    for (const g of [HERO608, REF]) {
      const draft = posterShapes(context(g), 6);
      const S = draft.L.S;
      const [blades] = batch(draft.shapes, Z.over, 'fg');
      const [hairs] = batch(draft.shapes, Z.over, 'orange');
      const polys = blades.polys as Vec2[][];
      expect(polys.length).toBeGreaterThanOrEqual(6);
      expect(polys.length).toBeLessThanOrEqual(12);
      expect(hairs.polys).toHaveLength(polys.length);
      expect(draft.counts.splash).toBe(polys.length);
      for (const b of polys) {
        expect(b.length).toBeGreaterThanOrEqual(9); // two notches a side or more
        const l = diameter(b) / S;
        expect(l).toBeGreaterThanOrEqual(0.05 * 0.95);
        expect(l).toBeLessThanOrEqual(0.2 * 1.05);
        expect(Math.min(...b.map((p) => dist(p, draft.L.P))) / S).toBeLessThan(0.25); // rooted at the head, round P
      }
    }
  });

  it("covers about 60 / 45 / 14 % of the circles 0.05 / 0.08–0.11 / 0.25 S round P with paper, as k13's burst does", () => {
    // impact.md §4.7, on the reference geometry (P well inside the frame),
    // averaged over seven seeds: luma 200 or more at 1440 points a circle.
    const radii = [0.05, 0.08, 0.11, 0.25];
    const sums = radii.map(() => 0);
    const seeds = [HERO.seed, 1, 2, 3, 4, 5, 6];
    for (const seed of seeds) {
      const ictx = context(REF, 'full', seed);
      const data = render(ictx, 6, NO_FIGURE, true);
      const { P, S } = ictx.frame;
      radii.forEach((r, k) => {
        let paper = 0;
        for (let j = 0; j < 1440; j++) {
          const a = (2 * Math.PI * j) / 1440;
          if (luma(data, at(REF.width, [P[0] + r * S * Math.cos(a), P[1] + r * S * Math.sin(a)])) >= 200) paper++;
        }
        sums[k] += paper / 1440 / seeds.length;
      });
    }
    const [c05, c08, c11, c25] = sums.map((s) => 100 * s);
    expect(c05).toBeGreaterThanOrEqual(52);
    expect(c05).toBeLessThanOrEqual(68);
    expect((c08 + c11) / 2).toBeGreaterThanOrEqual(40);
    expect((c08 + c11) / 2).toBeLessThanOrEqual(50);
    for (const c of [c08, c11]) {
      expect(c).toBeGreaterThanOrEqual(35);
      expect(c).toBeLessThanOrEqual(55);
    }
    expect(c25).toBeGreaterThanOrEqual(10);
    expect(c25).toBeLessThanOrEqual(18);
  });
});

describe('the comp grade (reference:9)', () => {
  it('paints open paper near white, at least #fbfaf5, and keeps cream to the fringe', () => {
    const paper = openPaper(TEST[1]);
    const y = (hex: string) => luma(new Uint8ClampedArray([...rgbOf(hex), 255]), 0);
    expect(y(paper)).toBeGreaterThanOrEqual(y('#fbfaf5'));
    expect(y(paper)).toBeGreaterThanOrEqual(y(mixHex(TEST[1], '#ffffff', 0.6))); // p1 at least 60 % of the way to white
    for (const si of [2, 3, 5]) {
      const T = posterTones(TEST, posterSpec(si, 'full'));
      expect(T.field).toBe(paper);
      const ictx = context(HERO608);
      const data = render(ictx, si, figure(ictx, si));
      let cream = 0;
      for (let i = 0; i < data.length; i += 4) if (near(data, i, '#fefcd6', 3)) cream++;
      expect((4 * cream) / data.length, `IF${si + 1}`).toBeLessThan(0.05);
    }
  });

  it("meets round 3's coverage targets on the hero: IF2 black ≥ 40 %, IF4 black ≥ 5 %, IF3 and IF6 white ≥ 90 %", () => {
    const ictx = context(HERO608);
    const s = (si: number) => shares(render(ictx, si, figure(ictx, si)));
    expect(s(1).black).toBeGreaterThanOrEqual(0.4);
    expect(s(3).black).toBeGreaterThanOrEqual(0.05);
    expect(s(2).white).toBeGreaterThanOrEqual(0.9);
    expect(s(5).white).toBeGreaterThanOrEqual(0.9);
  });

  it('grades only the light comp: the flat poster and the dark fields keep one ink', () => {
    for (let si = 0; si < 7; si++) {
      expect(posterTones(TEST, posterSpec(si, 'full'), true).edge).toBeNull();
      expect(posterTones(TEST, posterSpec(si, 'safe'), true).edge).toBeNull();
    }
    expect(posterTones(TEST, posterSpec(4, 'full')).edge).toBeNull();
    expect(posterTones(TEST, posterSpec(6, 'full')).edge).toBeNull();
    expect(posterShapes(context(HERO608), 3, { flat: true }).shapes.some((s) => s.core)).toBe(false);
  });
});

describe('determinism', () => {
  it('draws the same shapes and pixels twice', () => {
    const ictx = context(HERO608);
    for (let si = 0; si < 7; si++) {
      expect(JSON.stringify(posterShapes(ictx, si).shapes)).toBe(JSON.stringify(posterShapes(ictx, si).shapes));
      const fig = figure(ictx, si);
      const hash = () => createHash('sha1').update(render(ictx, si, fig)).digest('hex');
      expect(hash(), `IF${si + 1}`).toBe(hash());
    }
  });
});
