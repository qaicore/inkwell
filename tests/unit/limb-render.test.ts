import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { nullSink, recordingSink, type HeldLimb, type Palette, type PulseSpan, type Vec2 } from '../../src/impact/contracts.ts';
import { contrast, deltaE } from '../../src/impact/palette.ts';
import { buildTube, chunks, onMask, sectionAt } from '../../src/lift/tube.ts';
import { LIMB } from '../../src/render/brushes.ts';
import {
  drawLimb,
  keySwing,
  limbGrown,
  limbR0,
  limbTones,
  outlineClasses,
  outlineContrast,
  outlineLuma,
  pinnedSimilarity,
  plateLuma,
  stampPinned,
  type LimbOptions,
  type LimbTarget,
  type OutlineClass,
  type StampTarget,
} from '../../src/render/limb.ts';
import { celTones, luma709 } from '../../src/render/tones.ts';
import type { Mask } from '../../src/track/tracking.ts';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PALETTE: Palette = ['#e8203a', '#f4f1ea', '#16141a'];
const TONES = limbTones(PALETTE);
const target = (ctx: SKRSContext2D) => ctx as unknown as LimbTarget;
const pixels = (ctx: SKRSContext2D) => Buffer.from(ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height).data.buffer);
const sha = (...bufs: Buffer[]) => bufs.reduce((h, b) => h.update(b), createHash('sha256')).digest('hex');
const grey = (y: number) => `#${Math.round(y).toString(16).padStart(2, '0').repeat(3)}`;

// A held limb of `count` points along a curve (frame px, and an optional
// depth). The pressure is the drawn shape unless given: 0.8 at the root, full
// by the fifth point, 0.1 at the tip.
function held(id: number, curve: (t: number) => [number, number, number?], count = 32, front: (i: number) => boolean = () => true, pressure?: (i: number) => number): HeldLimb {
  const pts = Array.from({ length: count }, (_, i) => curve(i / (count - 1)));
  const shape = pressure ?? ((i: number) => (i <= 4 ? 0.8 + 0.05 * i : 1 - (0.9 * (i - 4)) / (count - 5)));
  let length = 0;
  for (let i = 1; i < count; i++) length += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return { id, points: pts.map((p): Vec2 => [p[0], p[1]]), z: pts.map((p) => p[2] ?? 0), pressure: pts.map((_, i) => shape(i)), front: pts.map((_, i) => front(i)), length };
}

// A straight limb along +x at height y, from x0 to x1.
const straight = (id: number, x0: number, x1: number, y: number, front?: (i: number) => boolean, pressure?: (i: number) => number) =>
  held(id, (t) => [x0 + (x1 - x0) * t, y], 32, front, pressure);

// The hero's four test limbs (impact/test-drawings.json, start.strokes): the
// root, the heading out of it, how far it turns and its length, clip px at
// 1920×1080. Each is a constant-curvature arc close to the drawn stroke, and
// dips away from the camera like the lift's dish.
const HERO_LIMBS = [
  { id: 1, root: [778, 300], heading: -114, turn: -88, length: 446 },
  { id: 2, root: [838, 300], heading: -62, turn: 85, length: 447 },
  { id: 3, root: [790, 345], heading: 169, turn: -80, length: 432 },
  { id: 4, root: [828, 345], heading: 8.5, turn: 80, length: 435 },
] as const;

function heroLimb(l: (typeof HERO_LIMBS)[number], scale: number): HeldLimb {
  const n = 32;
  const step = (l.length * scale) / (n - 1);
  const pts: [number, number, number][] = [];
  let [x, y] = [l.root[0] * scale, l.root[1] * scale];
  for (let i = 0; i < n; i++) {
    const d = i * step;
    pts.push([x, y, -0.3 * d - (0.08 * d * d) / (182 * scale)]);
    const a = ((l.heading + (l.turn * (i + 0.5)) / (n - 1)) * Math.PI) / 180;
    x += Math.cos(a) * step;
    y += Math.sin(a) * step;
  }
  return held(l.id, (t) => pts[Math.round(t * (n - 1))], n, (i) => i > 4); // the root inside him
}

// A drawing surface that records each fill: its colour, its subpaths (the
// points of each moveTo/lineTo run) and how many discs (arc calls) it holds.
interface Fill {
  color: string;
  paths: Vec2[][];
  discs: number;
}
function recorder(): { ctx: LimbTarget; fills: Fill[] } {
  const fills: Fill[] = [];
  let paths: Vec2[][] = [];
  let discs = 0;
  const ctx = {
    fillStyle: '' as unknown,
    globalCompositeOperation: 'source-over',
    globalAlpha: 1,
    imageSmoothingEnabled: true,
    beginPath: () => {
      paths = [];
      discs = 0;
    },
    moveTo: (x: number, y: number) => void paths.push([[x, y]]),
    lineTo: (x: number, y: number) => void paths[paths.length - 1].push([x, y]),
    arc: () => void discs++,
    closePath: () => {},
    quadraticCurveTo: () => {},
    fill: () => void fills.push({ color: String(ctx.fillStyle), paths, discs }),
    setTransform: () => {},
    clearRect: () => {},
    fillRect: () => {},
    getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    putImageData: () => {},
    drawImage: () => {},
  };
  return { ctx: ctx as unknown as LimbTarget, fills };
}

// A strip subpath's two edges per section: the − edge was drawn forward, the + edge back.
function edges(path: Vec2[]): { lo: Vec2[]; hi: Vec2[] } {
  const n = path.length / 2;
  return { lo: path.slice(0, n), hi: path.slice(n).reverse() };
}
const strips = (fill: Fill) => fill.paths.filter((p) => p.length > 2 && p.length % 2 === 0);
const stripOf = (fills: Fill[], color: string) => edges(strips(fills.find((f) => f.color === color)!)[0]);
const area = (poly: Vec2[]) => poly.reduce((a, p, i) => a + p[0] * poly[(i + 1) % poly.length][1] - poly[(i + 1) % poly.length][0] * p[1], 0) / 2;

const OPTS: LimbOptions = { S: 1080, k: 12, palette: PALETTE, root: 'none', crackle: 0 };
const LINE_PX = LIMB.linePx * 1080;

describe('celTones', () => {
  it('gives the hero red the table tones of design §2, within ΔE 6', () => {
    const t = celTones('#e8203a');
    expect(t.body).toBe('#e8203a');
    const want = { line: '#27010e', shadow: '#680627', lit: '#ff8577', core: '#ffe3db' } as const;
    for (const [tone, hex] of Object.entries(want) as [keyof typeof want, string][]) expect(deltaE(t[tone], hex), tone).toBeLessThan(6);
  });

  it('keeps the ladder in luma order and every tone a valid colour', () => {
    for (const c of ['#e8203a', '#3a6cff', '#fb6a04', '#22cc44', '#7a3cff', '#808080', '#16141a', '#f4f1ea', '#000000', '#ffffff']) {
      const t = celTones(c);
      const ladder = [t.line, t.shadow, t.body, t.lit, t.core];
      for (const tone of ladder) expect(tone).toMatch(/^#[0-9a-f]{6}$/);
      for (let i = 1; i < ladder.length; i++) expect(luma709(ladder[i]), `${c} step ${i}`).toBeGreaterThanOrEqual(luma709(ladder[i - 1]) - 0.5);
    }
    // A mid colour gets a real step each way.
    const blue = celTones('#3a6cff');
    expect(luma709(blue.line)).toBeLessThan(0.2 * luma709(blue.body));
    expect(luma709(blue.core)).toBeGreaterThan(luma709(blue.lit) + 20);
  });

  it('keeps a grey body grey', () => {
    for (const tone of Object.values(celTones('#808080'))) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(tone.slice(i, i + 2), 16));
      expect(r).toBe(g);
      expect(g).toBe(b);
    }
  });
});

describe('limbR0', () => {
  it('sets the root radius from the brush size: 0.020 S at size 28', () => {
    expect(limbR0(1080)).toBeCloseTo(21.6, 12);
    expect(limbR0(608)).toBeCloseTo(12.16, 12);
    expect(limbR0(1080, 56)).toBeCloseTo(43.2, 12);
    expect(limbR0(1080, 28, { ...LIMB, radius: 0.03 })).toBeCloseTo(32.4, 12);
  });
});

describe('drawLimb', () => {
  it('draws six fills, one path each, in order: line, shadow, body, lit, core, rim', () => {
    const { ctx, fills } = recorder();
    const tube = buildTube(straight(1, 100, 700, 300), limbR0(1080));
    drawLimb(recorder().ctx, ctx, tube, { ...OPTS, flash: 0.5 }); // the flash keeps the core whole
    expect(fills.map((f) => f.color)).toEqual([TONES.line, TONES.shadow, TONES.body, TONES.lit, TONES.core, TONES.rim]);
    // Every strip winds the same way as the discs, so overlaps add under nonzero.
    for (const fill of fills) for (const s of strips(fill)) expect(area(s)).toBeGreaterThan(0);
    // The line and the shadow round off both ends with a disc each.
    expect(fills[0].discs).toBe(2);
    expect(fills[1].discs).toBe(2);
  });

  it('keeps the shadow on the radius, and the outline ±30 % wide, ×1.35 on the side away from the key light', () => {
    const { ctx, fills } = recorder();
    const tube = buildTube(straight(1, 100, 700, 300), limbR0(1080));
    drawLimb(recorder().ctx, ctx, tube, OPTS);
    const shadow = edges(strips(fills[1])[0]);
    const outline = edges(strips(fills[0])[0]);
    expect(shadow.lo).toHaveLength(94);
    const minus: number[] = [];
    const plus: number[] = [];
    tube.sections.forEach((sec, i) => {
      expect(shadow.lo[i][1]).toBeCloseTo(300 - sec.r, 9);
      expect(shadow.hi[i][1]).toBeCloseTo(300 + sec.r, 9);
      minus.push(300 - outline.lo[i][1] - sec.r);
      plus.push(outline.hi[i][1] - 300 - sec.r);
    });
    // Lit from the upper left, the + side (screen down) is the shadow side.
    for (const w of minus) {
      expect(w).toBeGreaterThanOrEqual(0.7 * LINE_PX - 1e-9);
      expect(w).toBeLessThanOrEqual(1.3 * LINE_PX + 1e-9);
    }
    for (const w of plus) {
      expect(w).toBeGreaterThanOrEqual(0.7 * 1.35 * LINE_PX - 1e-9);
      expect(w).toBeLessThanOrEqual(1.3 * 1.35 * LINE_PX + 1e-9);
    }
    // It wobbles, each side on its own.
    expect(Math.max(...minus) / Math.min(...minus)).toBeGreaterThan(1.2);
    expect(plus.some((w, i) => Math.abs(w / 1.35 - minus[i]) > 0.2 * LINE_PX)).toBe(true);
  });

  it('draws the p1 rim under the line tone where the class asks for it, with a 1 px line-tone core on rim+core', () => {
    const tube = buildTube(straight(15, 100, 700, 300), limbR0(1080));
    const cls: OutlineClass[] = tube.sections.map((_, i) => (i < 30 ? 'rim' : i < 60 ? 'rim+core' : 'line'));
    const { ctx, fills } = recorder();
    drawLimb(recorder().ctx, ctx, tube, { ...OPTS, outline: cls });
    expect(fills.slice(0, 3).map((f) => f.color)).toEqual([TONES.light, TONES.line, TONES.shadow]);
    const light = edges(strips(fills[0])[0]);
    const line = edges(strips(fills[1])[0]);
    tube.sections.forEach((sec, i) => {
      const lightOut = 300 - light.lo[i][1] - sec.r; // how far past the silhouette each colour reaches, on the − side
      const lineOut = 300 - line.lo[i][1] - sec.r;
      if (cls[i] === 'line') {
        expect(lightOut).toBeCloseTo(0, 9);
        expect(lineOut).toBeGreaterThanOrEqual(0.7 * LINE_PX - 1e-9);
      } else {
        expect(lightOut).toBeGreaterThanOrEqual(0.7 * LINE_PX - 1e-9);
        expect(lineOut).toBeCloseTo(cls[i] === 'rim' ? 0 : 1, 9); // rim+core: its 1 px core, at 1080
      }
    });
  });

  it('renders the same pixels twice, and wobbles with k on the boil’s 3-drawing cycle', () => {
    const tube = buildTube(heroLimb(HERO_LIMBS[0], 608 / 1080), limbR0(608));
    const render = (k: number, crackle?: number) => {
      const behind = createCanvas(1080, 608).getContext('2d');
      const front = createCanvas(1080, 608).getContext('2d');
      drawLimb(target(behind), target(front), tube, { S: 608, k, palette: PALETTE, crackle });
      return sha(pixels(behind), pixels(front));
    };
    expect(render(6)).toBe(render(6));
    // The wobble, the core breaks and the root burst reseed on k mod 3, like the boil.
    const steady = [6, 7, 8, 9].map((k) => render(k, 0));
    expect(new Set(steady.slice(0, 3)).size).toBe(3);
    expect(steady[3]).toBe(steady[0]);
    // The crackle comes on its own seeded drawings, off that cycle.
    const crackling = Array.from({ length: 24 }, (_, i) => render(6 + i));
    expect(crackling.filter((h, i) => h !== steady[i % 3]).length).toBeGreaterThan(0);
  });

  it('draws the behind runs into the behind layer and the front runs into the front one', () => {
    const behind = recorder();
    const front = recorder();
    const tube = buildTube(straight(2, 100, 500, 300, (i) => i >= 16), 18);
    const runs = chunks(tube);
    expect(runs.map((r) => r.front)).toEqual([false, true]);
    drawLimb(behind.ctx, front.ctx, tube, OPTS);
    const xs = (fills: Fill[]) => strips(fills[1]).flatMap((s) => s.map((p) => p[0]));
    const flipX = sectionAt(tube, runs[1].from).screen[0];
    expect(Math.min(...xs(behind.fills))).toBeCloseTo(100, 6);
    expect(Math.max(...xs(behind.fills))).toBeCloseTo(sectionAt(tube, runs[0].to).screen[0], 6);
    expect(Math.min(...xs(front.fills))).toBeCloseTo(flipX, 6);
    expect(Math.max(...xs(front.fills))).toBeCloseTo(500, 6);
    // The behind run reaches one section under the front one, so no seam shows.
    expect(Math.max(...xs(behind.fills))).toBeGreaterThan(flipX);
  });

  it('emits glow only where it can be seen: front sections, and behind ones off the person', () => {
    // The flip is 17 sections past the mask's edge, too far to snap to it.
    const tube = buildTube(straight(3, 100, 600, 300, (i) => i > 19), 18);
    const mask: Mask = { width: 800, height: 600, alpha: new Uint8ClampedArray(800 * 600) };
    for (let y = 0; y < 600; y++) for (let x = 0; x < 800; x++) if (Math.hypot(x + 0.5 - 200, y + 0.5 - 300) < 120) mask.alpha[y * 800 + x] = 255;
    const runs = chunks(tube, mask);
    expect(runs.map((r) => r.front)).toEqual([false, true]);
    const flipX = sectionAt(tube, runs[1].from).screen[0];
    expect(flipX).toBeGreaterThan(400);
    const sink = recordingSink();
    drawLimb(recorder().ctx, recorder().ctx, tube, { ...OPTS, root: 'burst', mask, glow: sink });
    const strokes = sink.calls.filter((c) => c.op === 'stroke');
    expect(strokes.length).toBeGreaterThan(0);
    for (const c of strokes) for (const [x, y] of c.points) expect(x >= flipX - 1e-6 || !onMask(mask, 1, x, y)).toBe(true);
    // Behind him but off the mask (x 320 up to the flip), it still glows.
    expect(strokes.some((c) => c.points.some(([x]) => x > 325 && x < flipX - 5))).toBe(true);
    // The root is behind him and on him: its burst emits nothing.
    expect(sink.calls.filter((c) => c.op === 'disc')).toHaveLength(0);
  });

  it('draws nothing before it emerges, then grows to 0.44, 0.75, 0.94 and 1.0 L with a hot head', () => {
    expect([0, 1, 2, 3, 4].map(limbGrown)).toEqual([0.4375, 0.75, 0.9375, 1, 1]);
    const tube = buildTube(straight(4, 100, 700, 300), limbR0(1080));
    const before = recorder();
    drawLimb(before.ctx, before.ctx, tube, { ...OPTS, age: -1 });
    expect(before.fills).toHaveLength(0);
    for (const age of [0, 1, 2]) {
      const { ctx, fills } = recorder();
      drawLimb(recorder().ctx, ctx, tube, { ...OPTS, age });
      const shadow = edges(strips(fills[1])[0]);
      const visible = 600 * limbGrown(age);
      expect(Math.max(...shadow.hi.map((p) => p[0]))).toBeCloseTo(100 + visible, 6);
      // The head rounds off to a point at the visible end.
      const n = shadow.lo.length;
      expect(shadow.hi[n - 1][1] - shadow.lo[n - 1][1]).toBeLessThan(1e-6);
      // From 0.8 of the visible length on, the core spans the whole width: the hot head.
      const core = stripOf(fills, TONES.core);
      let hot = 0;
      shadow.lo.forEach((p, i) => {
        if (p[0] < 100 + 0.8 * visible) return;
        expect(core.hi[i][1] - core.lo[i][1]).toBeCloseTo(shadow.hi[i][1] - shadow.lo[i][1], 6);
        hot++;
      });
      expect(hot).toBeGreaterThan(3);
      // ... and before 0.7 it is the plain core band.
      const i = shadow.lo.findIndex((p) => p[0] > 100 + 0.5 * visible);
      expect(core.hi[i][1] - core.lo[i][1]).toBeLessThan(0.6 * (shadow.hi[i][1] - shadow.lo[i][1]));
    }
  });

  it('pops on ages 4 and 5 with 14 sparks, two thirds off the tip, farther out and thinner on the second', () => {
    const tube = buildTube(straight(5, 100, 700, 300), limbR0(1080));
    const tip = tube.sections[tube.sections.length - 1].screen;
    const sparks = (age: number) => {
      const { ctx, fills } = recorder();
      drawLimb(recorder().ctx, ctx, tube, { ...OPTS, age });
      const rim = fills.findIndex((f) => f.color === TONES.rim);
      return fills.slice(rim + 1).flatMap((f) => f.paths);
    };
    const [first, second] = [sparks(4), sparks(5)];
    for (const darts of [first, second]) {
      expect(darts).toHaveLength(14);
      for (const d of darts) expect(d).toHaveLength(4); // tip, left, tail, right
      // The side sparks leave from 0.3–0.9 of the length (x ≤ 640); the tip ones from the tip.
      expect(darts.filter((d) => d.every((p) => p[0] > 660))).toHaveLength(9);
    }
    const reach = (darts: Vec2[][]) => darts.reduce((s, d) => s + Math.hypot(d[0][0] - tip[0], d[0][1] - tip[1]), 0) / darts.length;
    const width = (darts: Vec2[][]) => darts.reduce((s, d) => s + Math.hypot(d[1][0] - d[3][0], d[1][1] - d[3][1]), 0) / darts.length;
    expect(reach(second)).toBeGreaterThan(reach(first));
    expect(width(second)).toBeCloseTo(0.6 * width(first), 9);
    // The pop lowers the band thresholds: the lit band is widest on the flash.
    const lit = (age?: number) => {
      const { ctx, fills } = recorder();
      drawLimb(recorder().ctx, ctx, tube, { ...OPTS, age });
      const { lo, hi } = stripOf(fills, TONES.lit);
      return hi[40][1] - lo[40][1];
    };
    expect(lit(4)).toBeGreaterThan(lit(5));
    expect(lit(5)).toBeGreaterThan(lit());
  });

  it('bulges under a cord pulse and widens the core there', () => {
    const tube = buildTube(straight(6, 100, 700, 300, undefined, () => 1), limbR0(1080));
    const pulse: PulseSpan = { s: 0.5, len: 0.2, scale: 1.3, core: 0.55 };
    const { ctx, fills } = recorder();
    drawLimb(recorder().ctx, ctx, tube, { ...OPTS, flash: 0.5, pulses: [pulse] });
    const shadow = edges(strips(fills[1])[0]);
    const core = stripOf(fills, TONES.core);
    const i = tube.sections.reduce((best, s, j) => (Math.abs(s.s - 0.5) < Math.abs(tube.sections[best].s - 0.5) ? j : best), 0);
    const r = tube.sections[i].r;
    expect((shadow.hi[i][1] - shadow.lo[i][1]) / (2 * r)).toBeCloseTo(1.3, 2);
    // The core spans 55 % of the width each side of its centre (clipped at the edge).
    const share = (core.hi[i][1] - core.lo[i][1]) / (1.3 * r);
    expect(share).toBeGreaterThan(0.99);
    expect(share).toBeLessThanOrEqual(1.1 + 1e-9);
    // Outside the pulse the radius is the tube's own.
    const j = tube.sections.findIndex((s) => s.s > 0.75);
    expect(shadow.hi[j][1] - shadow.lo[j][1]).toBeCloseTo(2 * tube.sections[j].r, 9);
  });

  it('swings the key light toward P', () => {
    const tube = buildTube(straight(7, 100, 700, 300, undefined, () => 1), limbR0(1080));
    const litCentre = (swing: LimbOptions['swing']) => {
      const { ctx, fills } = recorder();
      drawLimb(recorder().ctx, ctx, tube, { ...OPTS, swing });
      const { lo, hi } = stripOf(fills, TONES.lit);
      return (lo[30][1] + hi[30][1]) / 2 - 300; // + is screen down
    };
    const P: Vec2 = [sectionAt(tube, 30).screen[0], 900];
    expect(litCentre(null)).toBeLessThan(0); // lit from the upper left
    expect(litCentre({ P, w: 1 })).toBeGreaterThan(0); // lit from P, below
    expect(litCentre({ P, w: 0.5 })).toBeGreaterThan(litCentre(null));
    expect(litCentre({ P, w: 0 })).toBe(litCentre(null));
  });

  it('schedules the swing: off until S1, held through the fire and the hold, decayed to 0 at J_end', () => {
    // 1.5 s (J_end 45): no hold span, the decay is j 32..45.
    expect([null, -20, -9, -8].map((j) => keySwing(j, 45))).toEqual([0, 0, 0, 0]);
    for (const j of [-7, -1, 0, 8, 9, 20, 31]) expect(keySwing(j, 45)).toBe(1);
    expect(keySwing(32, 45)).toBeCloseTo(13 / 14, 12);
    expect(keySwing(38, 45)).toBeCloseTo(0.5, 12);
    expect(keySwing(45, 45)).toBe(0);
    expect(keySwing(60, 45)).toBe(0);
    // 3 s (J_end 90): held through the hold span j 32..76.
    for (const j of [32, 50, 76]) expect(keySwing(j, 90)).toBe(1);
    expect(keySwing(83, 90)).toBeCloseTo(0.5, 12);
    expect(keySwing(90, 90)).toBe(0);
    // Never rising again once it falls.
    for (let j = -10; j < 95; j++) if (j >= 31) expect(keySwing(j + 1, 90)).toBeLessThanOrEqual(keySwing(j, 90));
  });

  it('draws the socket ring first in the root’s layer, or the burst over the root', () => {
    const tube = buildTube(straight(8, 100, 700, 300, (i) => i > 10), limbR0(1080));
    const r0 = tube.sections[0].r;
    const ring = recorder();
    drawLimb(ring.ctx, recorder().ctx, tube, { ...OPTS, root: 'ring' });
    expect(ring.fills.slice(0, 2).map((f) => [f.color, f.discs])).toEqual([
      [TONES.line, 1],
      [TONES.shadow, 1],
    ]);
    expect(ring.fills[0].paths[0][0][0] - 100).toBeCloseTo(LIMB.socket * r0, 9); // moveTo(x + R, y)
    const burst = recorder();
    drawLimb(burst.ctx, recorder().ctx, tube, { ...OPTS, root: 'burst' });
    const stars = burst.fills.slice(-3);
    expect(stars.map((f) => f.color)).toEqual([TONES.body, TONES.lit, TONES.core]);
    const reach = stars[0].paths[0].map(([x, y]) => Math.hypot(x - 100, y - 300) / (r0 + LINE_PX));
    expect(reach).toHaveLength(18);
    expect(Math.min(...reach)).toBeGreaterThanOrEqual(1.15 - 1e-9);
    expect(Math.max(...reach)).toBeLessThanOrEqual(2.4 + 1e-9);
    expect(Math.max(...reach)).toBeGreaterThanOrEqual(1.8);
    // With the root in front (his back to the camera), the burst moves to the front layer.
    const back = buildTube(straight(8, 100, 700, 300), limbR0(1080));
    const [b, f] = [recorder(), recorder()];
    drawLimb(b.ctx, f.ctx, back, { ...OPTS, root: 'burst' });
    expect(b.fills).toHaveLength(0);
    expect(f.fills.slice(-3).map((x) => x.color)).toEqual([TONES.body, TONES.lit, TONES.core]);
  });

  it('draws 4 hero-length limbs at 1080×608 in ≤ 25 ms (median of 10)', () => {
    const behind = createCanvas(1080, 608).getContext('2d');
    const front = createCanvas(1080, 608).getContext('2d');
    const limbs = HERO_LIMBS.map((l) => heroLimb(l, 608 / 1080));
    const R0 = limbR0(608);
    const time = (k: number) => {
      behind.clearRect(0, 0, 1080, 608);
      front.clearRect(0, 0, 1080, 608);
      const t0 = performance.now();
      for (const h of limbs) drawLimb(target(behind), target(front), buildTube(h, R0), { S: 608, k, palette: PALETTE, glow: nullSink });
      behind.getImageData(0, 0, 1, 1); // make sure the raster work is done
      front.getImageData(0, 0, 1, 1);
      return performance.now() - t0;
    };
    for (let i = 0; i < 3; i++) time(100 + i); // warm up
    const ms = Array.from({ length: 10 }, (_, i) => time(40 + i)).sort((a, b) => a - b);
    expect((ms[4] + ms[5]) / 2).toBeLessThanOrEqual(25);
  });
});

describe('outlineClasses', () => {
  // A plate of three bands across x: Y 20 (dark footage), 80 (the floor) and 140 (a wall).
  const BANDS = [
    { to: 360, Y: 20 },
    { to: 720, Y: 80 },
    { to: 1080, Y: 140 },
  ];
  const bandY = (x: number) => BANDS.find((b) => x < b.to)?.Y ?? 140;
  function bandPlate() {
    const ctx = createCanvas(1080, 608).getContext('2d');
    let x0 = 0;
    for (const b of BANDS) {
      ctx.fillStyle = grey(b.Y);
      ctx.fillRect(x0, 0, b.to - x0, 608);
      x0 = b.to;
    }
    return ctx;
  }
  const runsOf = (cls: OutlineClass[]) => cls.reduce<{ cls: OutlineClass; n: number }[]>((out, c, i) => (i > 0 && c === cls[i - 1] ? (out[out.length - 1].n++, out) : [...out, { cls: c, n: 1 }]), []);
  const S = 1080;

  it('gives rim, rim+core and line over Y 20, 80 and 140, in runs of 6 or more, at 3:1 or better in every section', () => {
    const luma = plateLuma(bandPlate().getImageData(0, 0, 1080, 608));
    const curves = [(t: number): [number, number] => [40 + 1000 * t, 300], (t: number): [number, number] => [40 + 1000 * t, 300 + 90 * Math.sin(5 * t)]];
    for (const curve of curves) {
      const tube = buildTube(held(9, curve), limbR0(S));
      const cls = outlineClasses(tube, luma, { S, palette: PALETTE });
      expect(cls).toHaveLength(94);
      expect(runsOf(cls).map((r) => r.cls)).toEqual(['rim', 'rim+core', 'line']);
      for (const r of runsOf(cls)) expect(r.n).toBeGreaterThanOrEqual(6);
      // Against the plate the classifier reads (the median just outside the silhouette) ...
      const Y = outlineLuma(tube, luma, LINE_PX);
      cls.forEach((c, i) => expect(outlineContrast(c, Y[i], PALETTE), `section ${i}`).toBeGreaterThanOrEqual(3));
      // ... and against the band under every section clear of a band's edge.
      tube.sections.forEach((sec, i) => {
        const x = sec.screen[0];
        if (BANDS.some((b) => Math.abs(b.to - x) < 40)) return;
        expect(outlineContrast(cls[i], bandY(x), PALETTE), `section ${i}`).toBeGreaterThanOrEqual(3);
      });
    }
  });

  it('paints the outline it picks: the p1 rim over dark footage and the floor, the line tone over the wall', () => {
    const S2 = 1620; // a wider outline, so each of its colours covers whole pixels
    const plate = bandPlate();
    const luma = plateLuma(plate.getImageData(0, 0, 1080, 608));
    const tube = buildTube(held(10, (t) => [40 + 1000 * t, 300], 32, () => true, () => 1), limbR0(S2));
    const cls = outlineClasses(tube, luma, { S: S2, palette: PALETTE });
    drawLimb(target(plate), target(plate), tube, { S: S2, k: 3, palette: PALETTE, outline: cls, root: 'none', crackle: 0 });
    const img = plate.getImageData(0, 0, 1080, 608);
    const hexAt = (x: number, y: number) => {
      const i = (y * 1080 + x) * 4;
      return `#${[0, 1, 2].map((c) => img.data[i + c].toString(16).padStart(2, '0')).join('')}`;
    };
    const widest = 1.3 * LIMB.linePx * S2;
    for (const [x, want] of [[200, 'rim'], [540, 'rim+core'], [880, 'line']] as const) {
      const i = tube.sections.findIndex((s) => s.screen[0] >= x);
      expect(cls[i]).toBe(want);
      // The pixels just above the silhouette, on its lit side: its outer colour is the darkest
      // there (the line tone) or the brightest (the p1 rim).
      const col = Math.floor(tube.sections[i].screen[0]);
      const top = 300 - tube.sections[i].r;
      const column: string[] = [];
      for (let y = Math.floor(top - widest) - 1; y + 1 <= top; y++) column.push(hexAt(col, y));
      const sorted = [...column].sort((a, b) => luma709(a) - luma709(b));
      const outer = want === 'line' ? sorted[0] : sorted[sorted.length - 1];
      expect(deltaE(outer, want === 'line' ? TONES.line : TONES.light), `${want} at x ${x}: ${column.join(' ')}`).toBeLessThan(6);
      expect(contrast(outer, grey(bandY(x))), `${want} at x ${x}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('holds its class through ±5 Y of noise round a threshold', () => {
    // Y 97 and 103 by turns, every 20 px: both the line and the rim+core are free there.
    const flicker = (x: number) => (Math.floor(x / 20) % 2 === 0 ? 97 : 103);
    const tube = buildTube(held(11, (t) => [40 + 1000 * t, 300]), limbR0(S));
    expect(new Set(outlineClasses(tube, flicker, { S, palette: PALETTE })).size).toBe(1);
    // A ramp from a wall down to the dark: line, rim+core, rim, each switching once.
    const ramp = (x: number) => 150 - (130 * x) / 1080;
    expect(runsOf(outlineClasses(tube, ramp, { S, palette: PALETTE })).map((r) => r.cls)).toEqual(['line', 'rim+core', 'rim']);
  });

  it('keeps a short tube to one class, and reads the plate just outside the silhouette', () => {
    const short = buildTube(held(12, (t) => [100 + 30 * t, 300], 2), 10); // 4 sections
    expect(short.sections).toHaveLength(4);
    expect(new Set(outlineClasses(short, (x) => (x < 115 ? 20 : 140), { S, palette: PALETTE })).size).toBe(1);
    // Bright inside the tube, Y 50 outside it: the tube's own pixels don't count.
    const tube = buildTube(held(13, (t) => [100 + 600 * t, 300], 32, () => true, () => 1), 20);
    const inside = (x: number, y: number) => {
      const sec = tube.sections[Math.max(0, tube.sections.findIndex((s) => s.screen[0] >= x))];
      return Math.abs(y - 300) <= sec.r ? 250 : 50;
    };
    for (const Y of outlineLuma(tube, inside, LINE_PX).slice(1, -1)) expect(Y).toBe(50);
  });
});

describe('pinned stamps', () => {
  const apply = ([a, b, c, d, e, f]: number[], [x, y]: Vec2): Vec2 => [a * x + c * y + e, b * x + d * y + f];

  it('keeps P fixed and carries the old root onto the new one, as a similarity', () => {
    const P: Vec2 = [942, 1061];
    for (const [from, to] of [
      [[778, 300], [818, 300]],
      [[778, 300], [778, 340]],
      [[600, 500], [700, 420]],
    ] as [Vec2, Vec2][]) {
      const m = pinnedSimilarity(from, to, P);
      expect(m[0]).toBeCloseTo(m[3], 12); // a = d and b = −c: a rotation and a uniform scale
      expect(m[1]).toBeCloseTo(-m[2], 12);
      const p = apply(m, P);
      expect(Math.hypot(p[0] - P[0], p[1] - P[1])).toBeLessThan(1e-9);
      const r = apply(m, from);
      expect(Math.hypot(r[0] - to[0], r[1] - to[1])).toBeLessThan(1e-9);
    }
    expect(pinnedSimilarity([1, 1], [5, 5], [1, 1])).toEqual([1, 0, 0, 1, 0, 0]); // a root on P: nothing to carry
  });

  it('keeps the stamped tip within 0.5 px of P after a 40 px root move', () => {
    // The pinned limb of j −7, its tip on P, with a marker on the tip to find it by.
    const W = 1080;
    const H = 608;
    const P: Vec2 = [530.25, 560.75];
    const root: Vec2 = [440.5, 170.25];
    const tube = buildTube(held(14, (t) => [root[0] + (P[0] - root[0]) * t + 240 * t * (1 - t), root[1] + (P[1] - root[1]) * t]), limbR0(H));
    expect(tube.sections[tube.sections.length - 1].screen).toEqual(P);
    for (const [x0, y0] of [
      [0, 0],
      [300, 100],
    ]) {
      const layer = createCanvas(W - x0, H - y0); // the cached layer: its top-left at (x0, y0) in frame px
      const lctx = layer.getContext('2d');
      lctx.translate(-x0, -y0);
      drawLimb(target(lctx), target(lctx), tube, { S: H, k: 2, palette: PALETTE });
      lctx.fillStyle = '#00ff00';
      lctx.beginPath();
      lctx.arc(P[0], P[1], 2.5, 0, 2 * Math.PI);
      lctx.fill();
      for (const move of [[40, 0], [0, 40], [-28.28, 28.28]] as Vec2[]) {
        const out = createCanvas(W, H).getContext('2d');
        const rootNew: Vec2 = [root[0] + move[0], root[1] + move[1]];
        stampPinned(out as unknown as StampTarget, { image: layer, width: layer.width, height: layer.height, x0, y0 }, root, rootNew, P);
        const img = out.getImageData(0, 0, W, H);
        let [sx, sy, sw] = [0, 0, 0];
        for (let y = Math.floor(P[1]) - 8; y <= P[1] + 8; y++) {
          for (let x = Math.floor(P[0]) - 8; x <= P[0] + 8; x++) {
            const i = (y * W + x) * 4;
            const w = (Math.max(0, img.data[i + 1] - Math.max(img.data[i], img.data[i + 2])) * img.data[i + 3]) / 255; // how green
            sx += w * (x + 0.5);
            sy += w * (y + 0.5);
            sw += w;
          }
        }
        expect(sw).toBeGreaterThan(5);
        expect(Math.hypot(sx / sw - P[0], sy / sw - P[1]), `layer at ${x0},${y0}, root moved ${move}`).toBeLessThan(0.5);
        // The root went where it was sent.
        const r = apply(pinnedSimilarity(root, rootNew, P), tube.sections[0].screen);
        expect(Math.hypot(r[0] - rootNew[0], r[1] - rootNew[1])).toBeLessThan(1e-9);
      }
    }
  });
});

describe('tube, limb and tones source', () => {
  it('uses no Math.random, Date, performance.now or ctx.filter', () => {
    for (const f of ['src/lift/tube.ts', 'src/render/limb.ts', 'src/render/tones.ts']) {
      const code = readFileSync(resolve(REPO, f), 'utf8').replace(/\/\/.*$/gm, '');
      expect(code, f).not.toMatch(/Math\.random|\bDate\b|performance\.now|\.filter\s*=/);
    }
  });
});
