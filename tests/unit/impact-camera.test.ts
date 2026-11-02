import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SHAKE_LATERAL, SHAKE_REF, SHAKE_SCALE, cameraAt, cameraZoom, capJolt, composeAffine, mapPoint, shakeAt, shakeKeep, zoomCentre, type Affine, type CameraContext } from '../../src/impact/camera.ts';
import { zoomAt } from '../../src/impact/clock.ts';
import type { ImpactContext } from '../../src/impact/contracts.ts';
import { strikeFrame } from '../../src/impact/floor.ts';
import { rng, uniform } from '../../src/impact/rng.ts';
import type { Vec2 } from '../../src/types/effect.ts';
import { HERO } from './helpers/impact-drawings.ts';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
const unit = (v: Vec2): Vec2 => [v[0] / Math.hypot(...v), v[1] / Math.hypot(...v)];
const affine = ({ a, b, c, d, e, f }: Affine): Affine => ({ a, b, c, d, e, f });
const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

// An impact on a w × h frame at P, striking along d.
const impact = (w: number, h: number, P: Vec2, d: Vec2, seed: number): CameraContext => ({ width: w, height: h, seed, frame: strikeFrame(P, d, Math.min(w, h), 0.63, w, h, seed) });
const heroAt = (scale: number) => impact(HERO.width * scale, HERO.height * scale, [HERO.P[0] * scale, HERO.P[1] * scale], HERO.d, HERO.seed);
const HERO_CTX = heroAt(1);
const D = unit(HERO.d); // d̂ on the hero; −d̂ = (0.060, −0.998) points back up toward him
const UP = unit([0.06, -0.998]);

// 100 seeded impacts on a w × h frame: P anywhere on it, any strike direction, any seed.
function randomImpacts(w: number, h: number): CameraContext[] {
  const r = rng(7, 'camera-test', w, h);
  return Array.from({ length: 100 }, () => {
    const a = uniform(r, 0, 2 * Math.PI);
    return impact(w, h, [uniform(r, 0, w), uniform(r, 0, h)], [Math.cos(a), Math.sin(a)], Math.floor(uniform(r, 0, 2 ** 31)));
  });
}
const LANDSCAPE = randomImpacts(1920, 1080);
const PORTRAIT = randomImpacts(1080, 1920);
// P on each corner and in the middle of each edge, striking down and up.
const edges = (w: number, h: number) =>
  ([[0, 0], [w, 0], [0, h], [w, h], [w / 2, h], [w / 2, 0], [0, h / 2], [w, h / 2]] as Vec2[]).flatMap((P, i) => [impact(w, h, P, [0, 1], i), impact(w, h, P, [0.3, -1], i)]);

// Every frame corner lands on or outside the same corner of the canvas, so the
// zoomed, shaken frame covers all of it. The 1e-9 px is rounding, for a cap
// that puts an edge exactly on the canvas edge.
function covers(cam: Affine, w: number, h: number): boolean {
  const eps = 1e-9;
  const [tl, tr, bl, br] = ([[0, 0], [w, 0], [0, h], [w, h]] as Vec2[]).map((p) => mapPoint(cam, p));
  return tl[0] <= eps && tl[1] <= eps && tr[0] >= w - eps && tr[1] <= eps && bl[0] <= eps && bl[1] >= h - eps && br[0] >= w - eps && br[1] >= h - eps;
}

describe('the punch-in', () => {
  it('zooms 1, 1.08, 1.08, 1.02, 1 and 1 on j −1, 0, 9, 24, 39 and 40', () => {
    const want: [number, number][] = [[-1, 1], [0, 1.08], [9, 1.08], [24, 1.02], [39, 1], [40, 1]];
    for (const [j, z] of want) {
      const cam = cameraAt(j, HERO_CTX);
      expect(cam.zoom, `j ${j}`).toBeCloseTo(z, 12);
      expect([cam.a, cam.b, cam.c, cam.d]).toEqual([cam.zoom, 0, 0, cam.zoom]);
    }
    for (let j = 0; j <= 60; j++) expect(cameraAt(j, HERO_CTX).zoom).toBe(zoomAt(j));
    for (let j = -20; j < 0; j++) expect(cameraAt(j, HERO_CTX).zoom).toBe(cameraZoom(j)); // the pull-back (r3-f3-camera)
  });

  it('holds c_z = mix(frame centre, P, 0.5) still and scales about it', () => {
    expect(zoomCentre([942, 1061], 1920, 1080)).toEqual([951, 800.5]);
    expect(zoomCentre([1920, 1080], 1920, 1080)).toEqual([1440, 810]);
    for (let j = 0; j <= 8; j++) {
      const cam = cameraAt(j, HERO_CTX);
      expect(cam.offset).toEqual([0, 0]); // no shake under the posters
      const c = mapPoint(cam, cam.centre);
      expect(c[0]).toBeCloseTo(951, 9);
      expect(c[1]).toBeCloseTo(800.5, 9);
      const p = mapPoint(cam, [1051, 700.5]); // 100 px right of c_z and 100 up
      expect(p[0]).toBeCloseTo(951 + 108, 9);
      expect(p[1]).toBeCloseTo(800.5 - 108, 9);
    }
  });

  it('is exactly the identity before the coil, on S6 and from j 39 on', () => {
    for (const j of [-200, -14, -1, 39, 40, 45, 129]) {
      const cam = cameraAt(j, HERO_CTX);
      expect(affine(cam), `j ${j}`).toEqual(IDENTITY);
      expect(cam.offset).toEqual([0, 0]);
    }
  });

  it('keeps c_z on the canvas when P is far off the frame', () => {
    expect(zoomCentre([-5000, 4000], 1920, 1080)).toEqual([0, 1080]);
    const off = impact(1920, 1080, [-5000, 4000], [0, 1], 3);
    for (let j = 0; j <= 45; j++) expect(covers(cameraAt(j, off), 1920, 1080), `j ${j}`).toBe(true);
  });
});

describe('the shake', () => {
  it('moves on j 9..18 only, with a new jolt on every frame', () => {
    for (let j = -20; j <= 60; j++) {
      const s = shakeAt(j, HERO_CTX);
      if (j >= 9 && j <= 18) expect(Math.hypot(...s), `j ${j}`).toBeGreaterThan(0);
      else expect(s, `j ${j}`).toEqual([0, 0]);
    }
    for (let j = 10; j <= 18; j++) expect(Math.sign(dot(shakeAt(j, HERO_CTX), D)), `j ${j}`).toBe(-Math.sign(dot(shakeAt(j - 1, HERO_CTX), D)));
  });

  it('starts toward the striker (−d), then alternates along the strike axis', () => {
    for (const ctx of [HERO_CTX, ...LANDSCAPE, ...PORTRAIT]) {
      const u = ctx.frame.u;
      for (let n = 0; n < 10; n++) expect(Math.sign(dot(shakeAt(9 + n, ctx), u))).toBe(n % 2 === 0 ? -1 : 1);
      const first = cameraAt(9, ctx).offset; // after the cap, which keeps the direction
      const toward = dot(first, [-u[0], -u[1]]);
      expect(toward).toBeGreaterThan(0);
      expect(Math.abs(dot(first, [-u[1], u[0]])) / toward).toBeLessThanOrEqual(SHAKE_LATERAL + 1e-12); // within atan 0.2 of −d̂
    }
  });

  it('moves the picture, as the reference does: on j 9 every frame point moves toward the striker', () => {
    for (const ctx of [HERO_CTX, ...LANDSCAPE, ...PORTRAIT]) {
      const still = cameraAt(8, ctx); // the same 1.08 about the same c_z, without the shake
      const shaken = cameraAt(9, ctx);
      const u = ctx.frame.u;
      for (const p of [ctx.frame.P, [0, 0], [ctx.width, ctx.height]] as Vec2[]) {
        const a = mapPoint(still, p);
        const b = mapPoint(shaken, p);
        const moved: Vec2 = [b[0] - a[0], b[1] - a[1]];
        expect(dot(moved, [-u[0], -u[1]])).toBeGreaterThan(0);
        expect(moved[0]).toBeCloseTo(shaken.offset[0], 9);
        expect(moved[1]).toBeCloseTo(shaken.offset[1], 9);
      }
    }
    // The hero's P comes up 22.4 px: from 1.8 px below the bottom edge to 20.5 px above it.
    expect(mapPoint(cameraAt(8, HERO_CTX), HERO.P)[1]).toBeCloseTo(1081.84, 9);
    expect(mapPoint(cameraAt(9, HERO_CTX), HERO.P)[1]).toBeCloseTo(1081.84 - 22.36, 9);
  });

  it('has magnitudes 0.4·S·[0.098, 0.066, …] before the cap, plus a seeded lateral within ±20 %', () => {
    const want = [42.336, 28.512, 15.552, 9.936, 7.344, 3.888, 4.752, 6.048, 6.912, 5.184]; // hero px, S 1080
    const side: Vec2 = [-D[1], D[0]];
    want.forEach((m, n) => {
      const s = shakeAt(9 + n, HERO_CTX);
      expect(Math.abs(dot(s, D)), `jolt ${n + 1}`).toBeCloseTo(m, 9);
      expect(Math.abs(dot(s, side))).toBeLessThanOrEqual(0.2 * m + 1e-9);
    });
    for (const ctx of [...PORTRAIT, ...randomImpacts(1080, 608)]) {
      const u = ctx.frame.u;
      SHAKE_REF.forEach((ref, n) => expect(Math.abs(dot(shakeAt(9 + n, ctx), u))).toBeCloseTo(SHAKE_SCALE * ctx.frame.S * ref, 9));
    }
    const laterals = Array.from({ length: 200 }, (_, seed) => {
      const s = shakeAt(9, { ...HERO_CTX, seed });
      return dot(s, side) / Math.abs(dot(s, D));
    });
    expect(Math.min(...laterals)).toBeGreaterThanOrEqual(-SHAKE_LATERAL);
    expect(Math.max(...laterals)).toBeLessThanOrEqual(SHAKE_LATERAL);
    expect(Math.min(...laterals)).toBeLessThan(-0.15); // it uses the whole ±20 %, on both sides
    expect(Math.max(...laterals)).toBeGreaterThan(0.15);
  });

  it('is seeded per frame: the same seed gives the same jolts in any order, another seed other laterals', () => {
    const forward = Array.from({ length: 10 }, (_, n) => shakeAt(9 + n, HERO_CTX));
    const backward = Array.from({ length: 10 }, (_, n) => shakeAt(18 - n, HERO_CTX)).reverse();
    expect(backward).toEqual(forward);
    expect(cameraAt(12, HERO_CTX)).toEqual(cameraAt(12, HERO_CTX));
    const other = Array.from({ length: 10 }, (_, n) => shakeAt(9 + n, { ...HERO_CTX, seed: 85 }));
    other.forEach((s, n) => {
      expect(dot(s, D)).toBeCloseTo(dot(forward[n], D), 9);
      expect(s).not.toEqual(forward[n]);
    });
  });

  it('takes whole frames only', () => {
    expect(() => cameraAt(9.5, HERO_CTX)).toThrow(/whole frames/);
    expect(() => shakeAt(Number.NaN, HERO_CTX)).toThrow();
  });
});

describe('the cap', () => {
  it('cuts a jolt to the room the zoom leaves on the side the scene moves away from', () => {
    // The hero at 1.08: the zoomed frame overhangs each canvas edge by 0.08 × c_z's distance to it.
    const c: Vec2 = [951, 800.5];
    const cap = (o: Vec2) => capJolt(o, 1.08, c, 1920, 1080);
    const near = (got: Vec2, want: Vec2) => {
      expect(got[0]).toBeCloseTo(want[0], 9);
      expect(got[1]).toBeCloseTo(want[1], 9);
    };
    near(cap([0, -100]), [0, -22.36]); // up: as far as it overhangs the bottom edge, 0.08 × 279.5
    near(cap([0, 100]), [0, 64.04]); // down: the top edge, 0.08 × 800.5
    near(cap([100, 0]), [76.08, 0]); // right: the left edge, 0.08 × 951
    near(cap([-100, 0]), [-77.52, 0]); // left: the right edge, 0.08 × 969
    near(cap([30, -40]), [(30 * 22.36) / 40, -22.36]); // a diagonal keeps its direction
    expect(cap([5, -7])).toEqual([5, -7]); // one that fits is left alone
    expect(capJolt([10, 10], 1, c, 1920, 1080)).toEqual([0, 0]); // no zoom, no room
  });

  it('never grows a jolt or turns it', () => {
    for (const ctx of [HERO_CTX, ...LANDSCAPE, ...PORTRAIT]) {
      for (let j = 9; j <= 18; j++) {
        const raw = shakeAt(j, ctx);
        const { offset } = cameraAt(j, ctx);
        expect(Math.hypot(...offset)).toBeLessThanOrEqual(Math.hypot(...raw) + 1e-12);
        expect(Math.abs(offset[0] * raw[1] - offset[1] * raw[0])).toBeLessThan(1e-9); // parallel ...
        expect(dot(offset, raw)).toBeGreaterThan(0); // ... and the same way
      }
    }
  });

  it('stops a capped shake with a frame edge exactly on the canvas edge on its tightest jolt', () => {
    let capped = 0;
    for (const ctx of [HERO_CTX, ...LANDSCAPE, ...PORTRAIT]) {
      if (shakeKeep(ctx) >= 1) continue;
      capped++;
      const room = Array.from({ length: 10 }, (_, n) => {
        const cam = cameraAt(9 + n, ctx);
        const tl = mapPoint(cam, [0, 0]);
        const br = mapPoint(cam, [ctx.width, ctx.height]);
        return Math.min(-tl[0], -tl[1], br[0] - ctx.width, br[1] - ctx.height);
      });
      expect(Math.min(...room)).toBeCloseTo(0, 9); // one jolt meets the edge; the others keep some room
    }
    expect(capped).toBeGreaterThan(20);
  });
});

describe('coverage', () => {
  it('the frame covers the canvas on every frame from j −20 to 45: the hero, and 100 random P in landscape and in portrait', () => {
    const sets: [string, CameraContext[]][] = [
      ['hero', [HERO_CTX, heroAt(0.5)]],
      ['landscape', LANDSCAPE],
      ['portrait', PORTRAIT],
      ['edges', [...edges(1920, 1080), ...edges(1080, 1920)]],
      ['internal', [...randomImpacts(1080, 608), ...randomImpacts(608, 1080)]],
    ];
    for (const [name, ctxs] of sets) {
      for (const ctx of ctxs) {
        for (let j = -20; j <= 45; j++) expect(covers(cameraAt(j, ctx), ctx.width, ctx.height), `${name}: P (${ctx.frame.P}) on ${ctx.width}×${ctx.height}, j ${j}`).toBe(true);
      }
    }
  });
});

describe('the hero', () => {
  it('zooms about c_z (951, 800.5), which leaves P 2 px below the bottom edge under the punch-in', () => {
    const cam = cameraAt(5, HERO_CTX);
    expect(cam.centre).toEqual([951, 800.5]);
    expect(mapPoint(cam, HERO.P)[1]).toBeCloseTo(1081.84, 9); // design §7 accepts this, under its risks
  });

  it('jolt 1 is 42 px toward the striker, along (0.060, −0.998), before the cap', () => {
    const raw = shakeAt(9, HERO_CTX);
    expect(dot(raw, UP)).toBeCloseTo(42.336, 9);
    expect(dot(raw, [-UP[1], UP[0]]) / 42.336).toBeCloseTo(-0.114, 3); // seed 84's lateral: 11 % of it, toward screen left
    expect(raw[0]).toBeLessThan(0);
  });

  it('the zoom leaves 22.4 px below c_z, so jolt 1 is cut to that, and the whole envelope by the same 0.53', () => {
    const one = cameraAt(9, HERO_CTX);
    const raw = shakeAt(9, HERO_CTX);
    expect(one.offset[1]).toBeCloseTo(-22.36, 9);
    expect(one.offset[0]).toBeCloseTo((raw[0] * 22.36) / -raw[1], 9);
    expect(mapPoint(one, [0, 1080])[1]).toBeCloseTo(1080, 9); // the frame's bottom edge sits on the canvas bottom
    expect(dot(one.offset, UP)).toBeCloseTo(22.248, 3);
    const keep = shakeKeep(HERO_CTX);
    expect(keep).toBeCloseTo(22.36 / -raw[1], 9);
    expect(keep).toBeCloseTo(0.5255, 4);
    const two = cameraAt(10, HERO_CTX);
    expect(dot(two.offset, D)).toBeCloseTo(28.512 * keep, 9); // 15.0 px down, not round 2's whole 28.5
    for (let j = 9; j <= 18; j++) {
      const o = shakeAt(j, HERO_CTX);
      const got = cameraAt(j, HERO_CTX).offset;
      expect(got[0], `j ${j}`).toBeCloseTo(o[0] * keep, 9);
      expect(got[1], `j ${j}`).toBeCloseTo(o[1] * keep, 9);
    }
  });

  it("design §7's figures (42 px whole, then 21 px) are what the cap gives a shake that starts away from the striker", () => {
    const flip = (v: Vec2): Vec2 => [-v[0], -v[1]];
    const c = zoomCentre(HERO.P, 1920, 1080);
    const one = flip(shakeAt(9, HERO_CTX));
    expect(capJolt(one, zoomAt(9), c, 1920, 1080)).toEqual(one); // down 42 px: the 64 px above c_z take it whole
    const two = capJolt(flip(shakeAt(10, HERO_CTX)), zoomAt(10), c, 1920, 1080);
    expect(two[1]).toBeCloseTo(-(zoomAt(10) - 1) * 279.5, 9); // up 28.5 px: cut to the 20.9 px below c_z
    expect(Math.hypot(...two)).toBeLessThanOrEqual(21);
  });
});

describe('the affine helpers', () => {
  it('composeAffine applies the inner transform first', () => {
    const view: Affine = { a: 0.5, b: 0, c: 0, d: 0.5, e: 3, f: -2 }; // a frame-to-screen scale
    const turn: Affine = { a: 0.8, b: 0.6, c: -0.6, d: 0.8, e: 10, f: 20 }; // a rotation, to use b and c
    const cam = cameraAt(9, HERO_CTX);
    for (const outer of [view, turn]) {
      const both = composeAffine(outer, cam);
      for (const p of [[0, 0], [942, 1061], [1920, 1080], [-30, 77]] as Vec2[]) {
        const want = mapPoint(outer, mapPoint(cam, p));
        const got = mapPoint(both, p);
        expect(got[0]).toBeCloseTo(want[0], 9);
        expect(got[1]).toBeCloseTo(want[1], 9);
      }
    }
    expect(composeAffine(IDENTITY, cam)).toEqual(affine(cam));
    expect(composeAffine(cam, IDENTITY)).toEqual(affine(cam));
  });

  it('scales with the frame: the hero at half size gets the same camera at half size', () => {
    const half = heroAt(0.5);
    for (let j = -20; j <= 45; j++) {
      const full = cameraAt(j, HERO_CTX);
      const small = cameraAt(j, half);
      expect(small.zoom).toBe(full.zoom);
      expect(small.e).toBeCloseTo(full.e / 2, 9);
      expect(small.f).toBeCloseTo(full.f / 2, 9);
    }
  });

  it('takes a whole ImpactContext', () => {
    const fits = (ictx: ImpactContext): CameraContext => ictx; // tsc fails here if ImpactContext stops fitting
    expect(typeof fits).toBe('function');
  });

  it('reads no Math.random, clock or ctx.filter', () => {
    const code = readFileSync(resolve(REPO, 'src/impact/camera.ts'), 'utf8').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/Math\.random|\bDate\b|performance\.now|\.filter\s*=/);
  });
});
