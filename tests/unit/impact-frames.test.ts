// WP6: the impact frames (impact design §5; study impact.md §3, §7–§8): the
// layout's slide and anchors, the seven posters' flat coverage against the
// panel's, the tint, gentle mode's single inversion and bright fields, the
// ink guard, his marks in every poster (the five messy drawings), the
// draw-on, IF3's clear centre, determinism and the 8 ms budget.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createCanvas, type Canvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { nullSink, recordingSink, type Crack, type GlowSink, type Palette, type Vec2 } from '../../src/impact/contracts.ts';
import { posterHolds } from '../../src/impact/clock.ts';
import { strikeFrame } from '../../src/impact/floor.ts';
import { HOT, isSaturatedRed, luminance } from '../../src/impact/palette.ts';
import { drawPoster, INK_CAP, posterShapes, posterTones, Z, type PosterContext, type PosterOptions } from '../../src/impact/frames/draw.ts';
import { crackFraction, crackFromStroke, drawOn, markOutlines, NO_FIGURE, posterFigure, signedArea, syntheticCrouch, traceMask, type PosterFigure, type PosterTarget } from '../../src/impact/frames/figure.ts';
import { cooldown, fullPlan, gentle, GLINT_HOLD, LIGHT_FLOOR, posterFirstJ, posterHotRamp, posterPlan, posterSpec, redSafe } from '../../src/impact/frames/gentle.ts';
import { HUD, hudSlide, posterLayout, withSide } from '../../src/impact/frames/layout.ts';
import { hex } from '../../src/render/geometry.ts';
import { nodeScratch } from '../../src/render/headless.ts';
import type { Mask } from '../../src/track/tracking.ts';
import { HERO, HERO_CRACKS, MESSY_KINDS, messyDrawing, type ImpactStroke } from './helpers/impact-drawings.ts';

const TEST: Palette = ['#e8203a', '#f4f1ea', '#16141a']; // the app's default and the test drawings'
const REF_HUE: Palette = ['#f902b8', '#fefcfe', '#030001']; // the panel's measured pink, paper and ink (impact.md §4)
const PANEL = [[8.1, 91.9], [47.3, 51.2], [1.9, 94.4], [11.0, 86.3], [92.7, 5.7], [0.9, 96.5], [87.9, 8.7]]; // flat black / white %, IF1 untinted
const K = 1080 / HERO.width;

interface Geo {
  width: number;
  height: number;
  P: Vec2;
  d: Vec2;
  h?: 1 | -1;
}
const REF: Geo = { width: 1080, height: 634, P: [520, 388], d: [-0.8, 0.6], h: 1 }; // the reference panel's geometry
const HERO608: Geo = { width: 1080, height: 608, P: [HERO.P[0] * K, HERO.P[1] * K], d: [HERO.d[0], HERO.d[1]] };
const HERO1080: Geo = { width: HERO.width, height: HERO.height, P: [HERO.P[0], HERO.P[1]], d: [HERO.d[0], HERO.d[1]] };
const PORTRAIT: Geo = { width: 608, height: 1080, P: [300, 1040], d: [0, 1] };

interface ContextOptions {
  seed?: number;
  palette?: Palette;
  flash?: 'safe' | 'full';
  h?: 1 | -1;
}

function context(g: Geo, o: ContextOptions = {}): PosterContext {
  const S = Math.min(g.width, g.height);
  const seed = o.seed ?? HERO.seed;
  const base = strikeFrame(g.P, g.d, S, 1, g.width, g.height, seed);
  const h = o.h ?? g.h;
  return { frame: h ? withSide(base, h) : base, width: g.width, height: g.height, seed, palette: o.palette ?? TEST, flash: o.flash ?? 'full' };
}

// Strokes drawn on the hero's clip, moved to g's P and scaled to its frame.
function cracksFor(g: Geo, strokes: readonly ImpactStroke[] = HERO_CRACKS): Crack[] {
  const S = Math.min(g.width, g.height);
  const k = S / HERO.S;
  return strokes.map((s) =>
    crackFromStroke({ id: s.id, points: s.points.map(([x, y]): Vec2 => [g.P[0] + (x - HERO.P[0]) * k, g.P[1] + (y - HERO.P[1]) * k]), pressure: s.pressure, width: s.width.map((w) => w * k) }, g.P, S, g.width),
  );
}

function figureFor(ictx: PosterContext, si: number, cracks: Crack[], person: { mask: Mask; limbs: Vec2[][] } | null = null): PosterFigure {
  return posterFigure(
    { I: HERO.I, frame: ictx.frame, width: ictx.width, height: ictx.height, cracks, crackEase: 'out', personMask: () => person?.mask ?? null },
    si,
    { person: person?.mask ?? null, limbs: person?.limbs ?? [] },
  );
}

const crouchFor = (ictx: PosterContext) => syntheticCrouch(ictx.width, ictx.height, ictx.frame.P, ictx.frame.u, ictx.frame.S);

interface Rendered {
  canvas: Canvas;
  data: Uint8ClampedArray;
  ink: number;
  contour: boolean;
  centre: Vec2 | null;
}

function render(ictx: PosterContext, si: number, figure: PosterFigure = NO_FIGURE, opts: PosterOptions = {}, sink: GlowSink = nullSink): Rendered {
  const canvas = createCanvas(ictx.width, ictx.height);
  const report = drawPoster(canvas.getContext('2d') as unknown as PosterTarget, sink, ictx, si, figure, opts);
  const data = canvas.getContext('2d').getImageData(0, 0, ictx.width, ictx.height).data;
  return { canvas, data, ink: report.ink, contour: report.contour, centre: report.centre };
}

const luma = (d: Uint8ClampedArray, i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

// Black / white / mid, % of the frame (impact.md: Rec.601 luma, < 40 and ≥ 230).
function classes(d: Uint8ClampedArray): { black: number; white: number; mid: number } {
  let black = 0;
  let white = 0;
  for (let i = 0; i < d.length; i += 4) {
    const y = luma(d, i);
    if (y < 40) black++;
    else if (y >= 230) white++;
  }
  const n = d.length / 4;
  return { black: (100 * black) / n, white: (100 * white) / n, mid: (100 * (n - black - white)) / n };
}

// The share of pixels darker than luma 128: the posters' ink, comp graded or not.
function darkShare(d: Uint8ClampedArray): number {
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (luma(d, i) < 128) n++;
  return n / (d.length / 4);
}

const pixel = (r: Rendered, w: number, [x, y]: Vec2) => {
  const i = 4 * (Math.round(y) * w + Math.round(x));
  return [r.data[i], r.data[i + 1], r.data[i + 2]];
};
const relL = (rgb: number[]) => luminance(hex(rgb));
const meanRelL = (d: Uint8ClampedArray, step = 7) => {
  let s = 0;
  let n = 0;
  for (let i = 0; i < d.length; i += 4 * step) {
    s += relL([d[i], d[i + 1], d[i + 2]]);
    n++;
  }
  return s / n;
};
const sha = (...parts: (Uint8ClampedArray | string)[]) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest('hex');
};
const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function pointInPolygon([x, y]: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

// The nearest any edge of a polygon (or polyline) comes to p.
function nearest(p: Vec2, pts: readonly Vec2[], closed: boolean): number {
  let best = Infinity;
  const n = pts.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) best = Math.min(best, segmentDistance(p, pts[i], pts[(i + 1) % n]));
  return pointInPolygon(p, pts) && closed ? 0 : best;
}

// The marks alone, white on black: the pixels he drew that this poster shows.
function markMask(fig: PosterFigure, w: number, h: number): Uint8ClampedArray {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#ffffff';
  for (const m of fig.marks) {
    ctx.beginPath();
    ctx.moveTo(m[0][0], m[0][1]);
    for (let i = 1; i < m.length; i++) ctx.lineTo(m[i][0], m[i][1]);
    ctx.closePath();
    ctx.fill();
  }
  return ctx.getImageData(0, 0, w, h).data;
}

// ---- The plan ----------------------------------------------------------------------------

describe('the posters on the clock', () => {
  it('holds 2, 1, 1, 1, 2, 1, 1 over j 0..8, first on j 0, 2, 3, 4, 5, 7, 8', () => {
    expect(posterHolds(false)).toEqual([2, 1, 1, 1, 2, 1, 1]);
    expect(fullPlan().steps.map((s) => s?.si)).toEqual([0, 0, 1, 2, 3, 4, 4, 5, 6]);
    expect([0, 1, 2, 3, 4, 5, 6].map(posterFirstJ)).toEqual([0, 2, 3, 4, 5, 7, 8]);
    expect(posterHolds(true)).toEqual([5, 5, 5, 5, 5, 5, 5]);
  });

  it('is Full by default; Reduce flashing is gentle mode, and the ladder only runs there', () => {
    const full = posterPlan({ flash: 'full', posters: true });
    expect(full.steps.map((s) => s?.field)).toEqual(['light', 'light', 'light', 'light', 'light', 'dark', 'dark', 'light', 'dark']);
    expect(full.steps[2]?.disc).toBe('ink');
    expect(posterPlan({ flash: 'full', posters: true, ladder: 7 }).steps).toHaveLength(9);
    const safe = posterPlan({ flash: 'safe', posters: true });
    expect(safe.steps.map((s) => s?.field)).toEqual(['light', 'light', 'light', 'light', 'light', 'dark', 'dark', 'dark', 'dark']);
    expect(safe.steps[2]?.disc).toBe('tint');
    expect(safe.steps.every((s) => s?.redSafe && s.minL === LIGHT_FLOOR)).toBe(true);
    expect(posterPlan({ flash: 'safe', posters: true, ladder: 4 }).steps).toHaveLength(35);
    expect(posterPlan({ flash: 'safe', posters: true, ladder: 5 }).steps.every((s) => s?.field === 'light')).toBe(true);
    const glint = posterPlan({ flash: 'safe', posters: true, ladder: 6 }).steps;
    expect(glint).toHaveLength(GLINT_HOLD);
    expect(glint.every((s) => s?.si === 3 && s.glint && s.field === 'light')).toBe(true);
    expect(posterPlan({ flash: 'safe', posters: true, ladder: 7 }).steps).toHaveLength(0);
    expect(posterPlan({ flash: 'full', posters: false }).steps).toHaveLength(0);
    expect(cooldown(gentle(fullPlan()), 29).steps).toHaveLength(GLINT_HOLD);
    expect(cooldown(gentle(fullPlan()), 30).steps).toHaveLength(9);
    expect(() => posterPlan({ flash: 'safe', posters: true, ladder: 8 })).toThrow(/0\.\.7/);
  });

  it('bends large saturated reds toward brown (G4) and leaves the rest', () => {
    expect(redSafe('#6a2c03')).toBe('#6a3b0a');
    expect(redSafe('#f4f1ea')).toBe('#f4f1ea');
    expect(posterHotRamp({ redSafe: false })).toEqual([...HOT]);
    expect(posterHotRamp({ redSafe: true }).some(isSaturatedRed)).toBe(false);
    for (const si of [0, 1, 2, 3, 4, 5, 6]) {
      const T = posterTones(TEST, posterSpec(si, 'safe'));
      for (const c of [T.field, T.fg, T.bg, T.accent, T.ring, T.tan, T.orange, T.tint(0.1), T.tint(1)]) expect(isSaturatedRed(c), `IF${si + 1} ${c}`).toBe(false);
    }
  });
});

// ---- The layout --------------------------------------------------------------------------

describe('the layout', () => {
  it('slides the HUD 0.1624 S on the hero and not at all on the reference', () => {
    for (const g of [HERO1080, HERO608]) {
      const { frame, width, height } = context(g);
      const { slide } = hudSlide(frame.P, frame.u, frame.S, width, height);
      expect(Math.abs(slide / frame.S - 0.1624)).toBeLessThanOrEqual(0.002);
    }
    const ref = context(REF);
    expect(hudSlide(ref.frame.P, ref.frame.u, ref.frame.S, ref.width, ref.height).slide).toBe(0);
    expect(posterLayout(ref).O).toEqual(posterLayout(ref).P);
  });

  it('puts the hero anchors where design §5 says, jittered at most 0.02 S an axis', () => {
    const table = {
      [1]: { G: [947, 799], S1: [908, 548], S2: [933, 1025], ring5: [956, 821] },
      [-1]: { G: [969, 800], S1: [1037, 556], S2: [955, 1027], ring5: [956, 821] },
    } as const;
    for (const h of [1, -1] as const) {
      for (const seed of [HERO.seed, 1, 2, 3]) {
        const L = posterLayout(context(HERO1080, { h, seed }));
        // Off the slid origin, in (a, b): the HUD constants plus the jitter.
        const ab = (p: Vec2): Vec2 => {
          const q: Vec2 = [p[0] - L.O[0], p[1] - L.O[1]];
          return [(q[0] * L.u[0] + q[1] * L.u[1]) / L.S, (q[0] * L.v[0] + q[1] * L.v[1]) / L.S];
        };
        const [ga, gb] = ab(L.hud.G);
        expect(Math.abs(ga - HUD.G[0])).toBeLessThanOrEqual(0.02 + 1e-9);
        expect(Math.abs(gb - HUD.G[1])).toBeLessThanOrEqual(0.02 + 1e-9);
        const [sa, sb] = ab(L.hud.S1);
        expect(Math.abs(sa - ga - HUD.S1[0])).toBeLessThanOrEqual(0.02 + 1e-9); // S1 rides on G
        expect(Math.abs(sb - gb - HUD.S1[1])).toBeLessThanOrEqual(0.02 + 1e-9);
        for (const name of ['G', 'S1', 'S2', 'ring5'] as const) {
          const tol = (name === 'S1' || name === 'S2' ? 0.04 : 0.02) * Math.SQRT2 * L.S + 1;
          expect(dist(L.hud[name], table[h][name] as unknown as Vec2), `${name} h ${h} seed ${seed}`).toBeLessThanOrEqual(tol);
        }
      }
    }
  });

  it('keeps every HUD anchor on the frame: the hero (both h), the reference and portrait', () => {
    const cases: [Geo, ContextOptions][] = [
      [HERO1080, { h: 1 }],
      [HERO1080, { h: -1 }],
      [HERO608, { h: 1 }],
      [HERO608, { h: -1 }],
      [REF, {}],
      [PORTRAIT, {}],
    ];
    for (const [g, o] of cases) {
      for (let seed = 1; seed <= 12; seed++) {
        const L = posterLayout(context(g, { ...o, seed }));
        for (const [name, p] of Object.entries(L.hud)) {
          expect(p[0], `${name} x, ${g.width}×${g.height} seed ${seed}`).toBeGreaterThanOrEqual(0);
          expect(p[0]).toBeLessThanOrEqual(g.width);
          expect(p[1], `${name} y, ${g.width}×${g.height} seed ${seed}`).toBeGreaterThanOrEqual(0);
          expect(p[1]).toBeLessThanOrEqual(g.height);
        }
      }
    }
  });

  it('runs portrait with h = −1 and S the width, its HUD lines along the short side', () => {
    const ictx = context(PORTRAIT);
    expect(ictx.frame.h).toBe(-1);
    expect(ictx.frame.S).toBe(608);
    const L = posterLayout(ictx);
    expect(L.short).toEqual([1, 0]);
    const landscape = posterLayout(context(HERO608));
    expect(landscape.short).toEqual([0, 1]);
    // IF3's long crosshair line (0.65 S) runs along the short side, ±4°.
    for (const [lay, ctx] of [[L, ictx], [landscape, context(HERO608)]] as const) {
      const hud = posterShapes(ctx, 2).shapes.filter((s) => s.z === Z.hud);
      const lines = hud.flatMap((s) => s.lines ?? []);
      const longest = lines.reduce((m, l) => (dist(l[0], l[1]) > dist(m[0], m[1]) ? l : m));
      const dir: Vec2 = [(longest[1][0] - longest[0][0]) / dist(longest[0], longest[1]), (longest[1][1] - longest[0][1]) / dist(longest[0], longest[1])];
      expect(Math.abs(dir[0] * lay.short[0] + dir[1] * lay.short[1])).toBeGreaterThanOrEqual(Math.cos(4.01 * (Math.PI / 180)));
      expect(dist(longest[0], longest[1]) / lay.S).toBeCloseTo(0.65, 5);
    }
  });
});

// ---- The posters ---------------------------------------------------------------------------

describe('the seven posters, flat, on the reference geometry', () => {
  it('cover within 5 points of the panel (untinted, no figure)', () => {
    for (const seed of [HERO.seed, 1, 2]) {
      for (const palette of [TEST, REF_HUE]) {
        const ictx = context(REF, { seed, palette });
        for (let si = 0; si < 7; si++) {
          const { black, white } = classes(render(ictx, si, NO_FIGURE, { flat: true, tint: false }).data);
          expect(Math.abs(black - PANEL[si][0]), `IF${si + 1} black ${black.toFixed(1)} seed ${seed}`).toBeLessThanOrEqual(5);
          expect(Math.abs(white - PANEL[si][1]), `IF${si + 1} white ${white.toFixed(1)} seed ${seed}`).toBeLessThanOrEqual(5);
        }
      }
    }
  });

  it("tints IF1 toward p0: the tint on its own is 25.2 ± 5 % mid in the panel's pink", () => {
    for (const seed of [HERO.seed, 1, 2]) {
      const ictx = context(REF, { seed, palette: REF_HUE });
      const tinted = classes(render(ictx, 0, NO_FIGURE, { flat: true }).data);
      const plain = classes(render(ictx, 0, NO_FIGURE, { flat: true, tint: false }).data);
      expect(Math.abs(tinted.mid - plain.mid - 25.2), `seed ${seed}: ${(tinted.mid - plain.mid).toFixed(1)}`).toBeLessThanOrEqual(5);
    }
    // The tint at 0.2 is the panel's #fdcaf0.
    expect(posterTones(REF_HUE, posterSpec(0, 'full'), true).tint(0.2)).toBe('#fdcaf0');
  });

  it('centres IF4 and IF5 on the same G: an ink star there, then a paper cross', () => {
    for (const g of [HERO608, REF, PORTRAIT]) {
      const ictx = context(g);
      const star = render(ictx, 3, NO_FIGURE, { flat: true });
      const cross = render(ictx, 4, NO_FIGURE, { flat: true });
      expect(star.centre).not.toBeNull();
      expect(cross.centre).toEqual(star.centre);
      const G = star.centre as Vec2;
      const L = posterLayout(ictx);
      const probes: Vec2[] = [G];
      for (const e of [L.short, L.long]) {
        for (const k of [-0.15, 0.15]) {
          const p: Vec2 = [G[0] + k * L.S * e[0], G[1] + k * L.S * e[1]];
          if (p[0] >= 2 && p[0] <= g.width - 3 && p[1] >= 2 && p[1] <= g.height - 3) probes.push(p);
        }
      }
      expect(probes.length).toBeGreaterThanOrEqual(3);
      for (const p of probes) {
        expect(luma(new Uint8ClampedArray(pixel(star, g.width, p)), 0), `star at ${p}`).toBeLessThan(60);
        expect(luma(new Uint8ClampedArray(pixel(cross, g.width, p)), 0), `cross at ${p}`).toBeGreaterThan(200);
      }
    }
  });

  it('keeps IF3 clear within 0.07 S of F, its inner lines inside 0.32 S and the rest past 0.47 S', () => {
    for (const g of [REF, HERO608, PORTRAIT]) {
      for (const seed of [HERO.seed, 1, 2, 3, 4]) {
        const draft = posterShapes(context(g, { seed }), 2);
        const F = draft.centre as Vec2;
        const S = draft.L.S;
        let lines = 0;
        for (const shape of draft.shapes) {
          if (shape.z === Z.hud) continue; // the crosshair is on F by design
          for (const poly of shape.polys ?? []) {
            const near = nearest(F, poly, true) / S;
            expect(near, `seed ${seed}`).toBeGreaterThanOrEqual(0.07);
            if (shape.z === Z.line) {
              lines++;
              expect(near <= 0.325 || near >= 0.465, `a line ends ${near.toFixed(3)} S from F`).toBe(true);
            }
          }
        }
        expect(lines).toBeGreaterThanOrEqual(55 - 6);
      }
    }
  });
});

// ---- Gentle mode ------------------------------------------------------------------------------

describe('gentle mode (Reduce flashing)', () => {
  it('inverts once: light IF1–IF4, then dark IF5–IF7 (Full flips at least three times)', () => {
    const flips = (flash: 'safe' | 'full') => {
      const ictx = context(HERO608, { flash });
      const crouch = crouchFor(ictx);
      const cracks = cracksFor(HERO608);
      const lit = new Map<number, boolean>();
      const steps = posterPlan({ flash, posters: true }).steps;
      const seq = steps.map((spec) => {
        const si = spec?.si as number;
        if (!lit.has(si)) lit.set(si, meanRelL(render(ictx, si, figureFor(ictx, si, cracks, crouch), { spec: spec ?? undefined }).data) > 0.5);
        return lit.get(si) as boolean;
      });
      let n = 0;
      for (let j = 1; j < seq.length; j++) if (seq[j] !== seq[j - 1]) n++;
      return { n, first: seq[0] };
    };
    expect(flips('safe')).toEqual({ n: 1, first: true });
    // Full: IF5 and IF7 dark between light IF4 and IF6, and IF2's ink split
    // reads dark with him in it: five flips in pixels.
    const full = flips('full');
    expect(full.first).toBe(true);
    expect(full.n).toBeGreaterThanOrEqual(3);
  });

  it('keeps every light field at relL ≥ 0.80 (G3), in tones and in pixels', () => {
    for (const palette of [TEST, REF_HUE, ['#2d6cdf', '#efe9dc', '#101418'] as Palette]) {
      for (const si of [0, 1, 2, 3]) {
        const spec = posterSpec(si, 'safe');
        for (const flat of [false, true]) {
          const T = posterTones(palette, spec, flat);
          expect(luminance(T.field)).toBeGreaterThanOrEqual(LIGHT_FLOOR);
          for (let s = 0; s <= 1.0001; s += 0.05) expect(luminance(T.tint(s)), `${palette[0]} IF${si + 1} s ${s.toFixed(2)}`).toBeGreaterThanOrEqual(LIGHT_FLOOR);
        }
      }
      // In pixels: IF1's corners (its strongest tint) and the middle of IF2's tinted disc.
      const ictx = context(HERO608, { palette, flash: 'safe' });
      const if1 = render(ictx, 0);
      for (const p of [[2, 2], [1077, 2], [2, 605], [1077, 605]] as Vec2[]) expect(relL(pixel(if1, 1080, p))).toBeGreaterThanOrEqual(LIGHT_FLOOR - 0.005);
      const if2 = render(ictx, 1);
      const D = posterLayout(ictx).physical.disc2;
      const inFrame: Vec2 = [Math.min(1070, Math.max(10, D[0])), Math.min(598, Math.max(10, D[1]))];
      expect(relL(pixel(if2, 1080, inFrame))).toBeGreaterThanOrEqual(LIGHT_FLOOR - 0.005);
    }
  });

  it('splits IF2 with a tinted disc: at most 20 % ink with him in it', () => {
    for (const g of [HERO608, PORTRAIT]) {
      const ictx = context(g, { flash: 'safe' });
      const r = render(ictx, 1, figureFor(ictx, 1, cracksFor(g), crouchFor(ictx)));
      expect(darkShare(r.data)).toBeLessThanOrEqual(0.2);
    }
  });
});

// ---- The ink guard -------------------------------------------------------------------------------

describe('the ink guard', () => {
  it('holds light fields to 35 % ink with him in them (IF2’s Full split aside)', () => {
    for (const flash of ['full', 'safe'] as const) {
      for (const g of [HERO608, PORTRAIT]) {
        const ictx = context(g, { flash });
        const crouch = crouchFor(ictx);
        const cracks = cracksFor(g);
        for (let si = 0; si < 7; si++) {
          const spec = posterSpec(si, flash);
          if (spec.field !== 'light' || spec.disc === 'ink') continue;
          const r = render(ictx, si, figureFor(ictx, si, cracks, crouch));
          expect(r.ink, `IF${si + 1} ${flash} estimate`).toBeLessThanOrEqual(INK_CAP);
          expect(darkShare(r.data), `IF${si + 1} ${flash} pixels`).toBeLessThanOrEqual(INK_CAP);
        }
      }
    }
  });

  it('draws a huge figure as a contour and trims, largest first, to hold 35 %', () => {
    const ictx = context(HERO608);
    const { width: w, height: h } = ictx;
    const alpha = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (((x - 540) / 430) ** 2 + ((y - 330) / 250) ** 2 <= 1) alpha[y * w + x] = 255;
    const mask: Mask = { width: w, height: h, alpha };
    for (const si of [0, 3]) {
      const fig = figureFor(ictx, si, cracksFor(HERO608), { mask, limbs: [] });
      expect(fig.personArea / (w * h)).toBeGreaterThan(0.5);
      const r = render(ictx, si, fig);
      expect(r.contour).toBe(true);
      expect(r.ink).toBeLessThanOrEqual(INK_CAP);
      expect(darkShare(r.data)).toBeLessThanOrEqual(INK_CAP);
    }
  });
});

// ---- His marks --------------------------------------------------------------------------------

describe('his impact strokes', () => {
  it('draw on from their P end by ease.cracks((si + 1)/4): 58/88/98/100 % out, 25/50/75/100 % linear', () => {
    const out = [0, 1, 2, 3].map((si) => crackFraction('out', si));
    [0.58, 0.88, 0.98, 1].forEach((f, i) => expect(Math.abs(out[i] - f)).toBeLessThanOrEqual(0.01));
    const linear = [0, 1, 2, 3].map((si) => crackFraction('linear', si));
    [0.25, 0.5, 0.75, 1].forEach((f, i) => expect(Math.abs(linear[i] - f)).toBeLessThanOrEqual(0.01));
    for (const si of [4, 5, 6]) expect(crackFraction('out', si)).toBe(1);
    // The cut is by length along the stroke.
    const crack = cracksFor(HERO608)[0];
    const length = (pts: readonly Vec2[]) => pts.slice(1).reduce((s, p, i) => s + dist(p, pts[i]), 0);
    for (const si of [0, 1, 2, 3]) {
      const cut = drawOn(crack.points, crack.pressure, crackFraction('out', si));
      expect(length(cut.points) / length(crack.points)).toBeCloseTo(crackFraction('out', si), 6);
      expect(cut.pressure).toHaveLength(cut.points.length);
    }
  });

  it('draws a stroke on from whichever end is at P, and a stroke away from P whole from IF1', () => {
    const cracks = cracksFor(HERO608);
    expect(cracks.every((c) => c.fromP === 'start')).toBe(true);
    const ictx = { ...context(HERO608), crackEase: 'out' as const };
    const reversed: Crack[] = cracks.map((c) => ({ ...c, points: [...c.points].reverse(), pressure: [...c.pressure].reverse(), fromP: 'end' }));
    const area = (marks: Vec2[][]) => marks.reduce((s, m) => s + signedArea(m), 0);
    for (const si of [0, 1]) expect(area(markOutlines({ ...ictx, cracks: reversed }, si)) / area(markOutlines({ ...ictx, cracks }, si))).toBeCloseTo(1, 1);
    const away: Crack[] = cracks.map((c) => ({ ...c, fromP: null }));
    expect(area(markOutlines({ ...ictx, cracks: away }, 0))).toBeCloseTo(area(markOutlines({ ...ictx, cracks: away }, 6)), 6);
    expect(area(markOutlines({ ...ictx, cracks }, 0))).toBeLessThan(0.8 * area(markOutlines({ ...ictx, cracks }, 6)));
    // 1.5× as drawn.
    const one = cracksFor(HERO608).slice(0, 1);
    const wide = markOutlines({ ...ictx, cracks: one }, 6);
    const drawn = markOutlines({ ...ictx, cracks: one.map((c) => ({ ...c, brush: { ...c.brush, size: c.brush.size / 1.5 } })) }, 6);
    expect(area(wide) / area(drawn)).toBeGreaterThan(1.3);
  });

  // A pixel of his mark shows when it has the mark's tone, or when the mark
  // moved it a quarter of the way from where it was without him toward that
  // tone (under IF3's 60 % crosshair, say): only what's above him (the star,
  // the cross, the HUD) can hide it.
  it('shows at least 90 % of what he drew in every poster, for all five messy drawings', () => {
    for (const kind of MESSY_KINDS) {
      const cracks = cracksFor(HERO608, messyDrawing(kind, HERO.seed));
      for (const flash of ['full', 'safe'] as const) {
        const ictx = context(HERO608, { flash });
        for (let si = 0; si < 7; si++) {
          const fig = figureFor(ictx, si, cracks);
          expect(fig.marks.length, `${kind} IF${si + 1}`).toBeGreaterThan(0);
          const r = render(ictx, si, fig, { flat: true });
          const bare = render(ictx, si, NO_FIGURE, { flat: true });
          const mask = markMask(fig, ictx.width, ictx.height);
          const spec = posterSpec(si, flash);
          const T = posterTones(TEST, spec, true);
          const disc = spec.disc === 'ink' ? posterShapes(ictx, si, { flat: true }).disc : null;
          const [ink, paper] = [T.fg, T.bg].map((c) => [1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16)));
          let expected = 0;
          let shown = 0;
          for (let y = 0; y < ictx.height; y++) {
            for (let x = 0; x < ictx.width; x++) {
              const i = 4 * (y * ictx.width + x);
              if (mask[i] < 250) continue;
              expected++;
              const want = disc && pointInPolygon([x + 0.5, y + 0.5], disc) ? paper : ink; // T.fg is the mark on either field
              if (Math.abs(r.data[i] - want[0]) <= 24 && Math.abs(r.data[i + 1] - want[1]) <= 24 && Math.abs(r.data[i + 2] - want[2]) <= 24) shown++;
              else {
                // Moved toward the mark's tone by a quarter of the way there.
                let num = 0;
                let den = 0;
                for (let c = 0; c < 3; c++) {
                  const gap = want[c] - bare.data[i + c];
                  num += (r.data[i + c] - bare.data[i + c]) * gap;
                  den += gap * gap;
                }
                if (den > 24 * 24 && num / den >= 0.25) shown++;
              }
            }
          }
          expect(expected, `${kind} IF${si + 1} ${flash}`).toBeGreaterThan(50);
          expect(shown / expected, `${kind} IF${si + 1} ${flash}`).toBeGreaterThanOrEqual(0.9);
        }
      }
    }
  });
});

// ---- The figure --------------------------------------------------------------------------------

describe('tracing the person', () => {
  it('traces a disc and a ring: outlines positive, holes negative, the area by pixel count', () => {
    const w = 160;
    const h = 120;
    const alpha = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const r = Math.hypot(x + 0.5 - 50, y + 0.5 - 60);
        const r2 = Math.hypot(x + 0.5 - 120, y + 0.5 - 60);
        if (r <= 30 || (r2 <= 30 && r2 >= 15)) alpha[y * w + x] = 255;
      }
    }
    const { loops, area } = traceMask({ width: w, height: h, alpha });
    expect(loops).toHaveLength(3);
    const areas = loops.map(signedArea).sort((a, b) => a - b);
    expect(areas[0]).toBeLessThan(0); // the ring's hole
    expect(Math.abs(areas[0])).toBeCloseTo(Math.PI * 15 * 15, -1.5);
    expect(areas[1]).toBeGreaterThan(0);
    expect(areas[2]).toBeGreaterThan(0);
    const net = areas.reduce((s, a) => s + a, 0);
    expect(Math.abs(net - area) / area).toBeLessThan(0.02);
    expect(Math.abs(area - Math.PI * (30 * 30 + 30 * 30 - 15 * 15)) / area).toBeLessThan(0.02);
  });
});

// ---- Determinism and budget -------------------------------------------------------------------

describe('determinism and the budget', () => {
  const heroAll = (seed: number, flash: 'safe' | 'full') => {
    const ictx = context(HERO608, { seed, flash });
    const crouch = crouchFor(ictx);
    const cracks = cracksFor(HERO608);
    return [0, 1, 2, 3, 4, 5, 6].map((si) => {
      const sink = recordingSink();
      const r = render(ictx, si, figureFor(ictx, si, cracks, crouch), {}, sink);
      return sha(r.data, JSON.stringify(sink.calls));
    });
  };

  it('hashes the same twice, and differently on another seed', () => {
    for (const flash of ['full', 'safe'] as const) {
      const a = heroAll(HERO.seed, flash);
      expect(heroAll(HERO.seed, flash)).toEqual(a);
      const b = heroAll(HERO.seed + 1, flash);
      expect(b.filter((x, i) => x !== a[i]).length).toBeGreaterThanOrEqual(5);
    }
  });

  it('draws IF6’s recoil copies the same from a scratch canvas as straight on the frame', () => {
    for (const flash of ['full', 'safe'] as const) {
      const ictx = context(HERO608, { flash });
      const fig = figureFor(ictx, 5, cracksFor(HERO608), crouchFor(ictx));
      expect(fig.limbs.length).toBeGreaterThan(0);
      const a = render(ictx, 5, fig).data;
      const b = render(ictx, 5, fig, { scratch: nodeScratch }).data;
      let off = 0;
      for (let i = 0; i < a.length; i += 4) if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > 8) off++;
      expect(off, flash).toBeLessThanOrEqual(20);
      // And the copies are there: accent pixels the poster without limbs lacks.
      const bare = render(ictx, 5, { ...fig, limbs: [], limbArea: 0 }).data;
      let changed = 0;
      for (let i = 0; i < a.length; i += 4) if (a[i] !== bare[i] || a[i + 1] !== bare[i + 1] || a[i + 2] !== bare[i + 2]) changed++;
      expect(changed).toBeGreaterThan(1000);
    }
  });

  it('draws no randomness, clock or ctx.filter', () => {
    for (const file of ['layout', 'draw', 'figure', 'gentle']) {
      const src = readFileSync(new URL(`../../src/impact/frames/${file}.ts`, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
      expect(src, file).not.toMatch(/Math\.random|Date\.now|new Date|performance\.now|\.filter\s*=/);
    }
  });

  // The median of 10, best of up to five runs of ten: other work on the machine
  // only ever slows a run down. His figure for the poster (the mark outlines;
  // the person is traced once per mask) is part of the poster's time.
  it('paints each poster at 1080×608 in 8 ms or less (median of 10), him and his marks included', () => {
    const report: string[] = [];
    const over: string[] = [];
    for (const flash of ['full', 'safe'] as const) {
      const ictx = context(HERO608, { flash });
      const crouch = crouchFor(ictx);
      const cracks = cracksFor(HERO608);
      const layout = posterLayout(ictx);
      const canvas = createCanvas(ictx.width, ictx.height);
      const ctx = canvas.getContext('2d');
      const once = (si: number) => {
        const fig = figureFor(ictx, si, cracks, crouch);
        drawPoster(ctx as unknown as PosterTarget, nullSink, ictx, si, fig, { layout, scratch: nodeScratch });
        ctx.getImageData(0, 0, 1, 1); // the raster is done
      };
      for (let k = 0; k < 5; k++) for (let si = 0; si < 7; si++) once(si); // warm up (and trace him once)
      for (let si = 0; si < 7; si++) {
        let best = Infinity;
        for (let run = 0; run < 5 && best > 8; run++) {
          const times: number[] = [];
          for (let k = 0; k < 10; k++) {
            const t0 = process.hrtime.bigint();
            once(si);
            times.push(Number(process.hrtime.bigint() - t0) / 1e6);
          }
          best = Math.min(best, median(times));
        }
        report.push(`IF${si + 1} ${flash} ${best.toFixed(2)}`);
        if (best > 8) over.push(`IF${si + 1} ${flash}`);
      }
    }
    expect(over, report.join(', ')).toEqual([]);
  });
});
