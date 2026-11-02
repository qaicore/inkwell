// Round 3, F3: the camera's pull-back over the charge and the shake's one cap
// factor (judge findings reference:16 and reference:21).
import { describe, expect, it } from 'vitest';
import { PULL, PULL_J, SHAKE_REF, cameraAt, cameraZoom, mapPoint, shakeAt, shakeKeep, type Affine, type CameraContext } from '../../src/impact/camera.ts';
import { strikeFrame } from '../../src/impact/floor.ts';
import { rng, uniform } from '../../src/impact/rng.ts';
import type { Vec2 } from '../../src/types/effect.ts';
import { HERO } from './helpers/impact-drawings.ts';

const impact = (w: number, h: number, P: Vec2, d: Vec2, seed: number): CameraContext => ({ width: w, height: h, seed, frame: strikeFrame(P, d, Math.min(w, h), 0.63, w, h, seed) });
const HERO_CTX = impact(HERO.width, HERO.height, HERO.P, HERO.d, HERO.seed);
function randomImpacts(w: number, h: number): CameraContext[] {
  const r = rng(11, 'r3-f3-camera', w, h);
  return Array.from({ length: 100 }, () => {
    const a = uniform(r, 0, 2 * Math.PI);
    return impact(w, h, [uniform(r, 0, w), uniform(r, 0, h)], [Math.cos(a), Math.sin(a)], Math.floor(uniform(r, 0, 2 ** 31)));
  });
}
const ALL = [HERO_CTX, ...randomImpacts(1920, 1080), ...randomImpacts(1080, 1920), ...randomImpacts(1080, 608)];
const covers = (cam: Affine, w: number, h: number) => {
  const [tl, br] = ([[0, 0], [w, h]] as Vec2[]).map((p) => mapPoint(cam, p));
  return tl[0] <= 1e-9 && tl[1] <= 1e-9 && br[0] >= w - 1e-9 && br[1] >= h - 1e-9;
};
const len = (v: Vec2) => Math.hypot(v[0], v[1]);

describe('the shake after the cap (reference:16)', () => {
  it('cuts every jolt by one factor, c = min_k(room_k / |o_k|), so the first jolt stays the biggest', () => {
    for (const ctx of ALL) {
      const keep = shakeKeep(ctx);
      expect(keep).toBeGreaterThan(0);
      expect(keep).toBeLessThanOrEqual(1);
      const got = SHAKE_REF.map((_, n) => cameraAt(9 + n, ctx).offset);
      got.forEach((o, n) => {
        const raw = shakeAt(9 + n, ctx);
        expect(o[0]).toBeCloseTo(raw[0] * keep, 9);
        expect(o[1]).toBeCloseTo(raw[1] * keep, 9);
      });
      const sizes = got.map(len);
      expect(sizes[0]).toBeGreaterThan(sizes[1]); // round 2's per-jolt cut left jolt 2 bigger on the hero
      expect(sizes[1]).toBeGreaterThan(sizes[2]);
      expect(Math.max(...sizes)).toBe(sizes[0]);
    }
  });

  it('the hero: 22.4, 15.0, 8.2 px …, its first jolt still toward the striker', () => {
    const sizes = SHAKE_REF.map((_, n) => len(cameraAt(9 + n, HERO_CTX).offset));
    expect(sizes[0]).toBeCloseTo(22.39, 1);
    expect(sizes[1]).toBeCloseTo(15.1, 1);
    expect(sizes[2]).toBeCloseTo(8.19, 1);
    expect(cameraAt(9, HERO_CTX).offset[1]).toBeLessThan(0); // up the frame, toward him
  });
});

describe('the pull-back over the charge (reference:21)', () => {
  it('creeps in to 1 + PULL over the coil and eases out to 1 by S5; S6 and the coil start are unzoomed', () => {
    expect(PULL).toBe(0.04);
    expect(cameraZoom(PULL_J.from)).toBe(1);
    expect(cameraZoom(PULL_J.peak)).toBeCloseTo(1.04, 12); // S1 (j −7)
    expect(cameraZoom(PULL_J.out)).toBe(1); // S5 (j −2)
    expect(cameraZoom(-1)).toBe(1); // S6: the swell unzoomed
    expect(cameraZoom(0)).toBeCloseTo(1.08, 12); // contact punches in
    for (let j = PULL_J.from + 1; j <= PULL_J.peak; j++) expect(cameraZoom(j), `j ${j}`).toBeGreaterThan(cameraZoom(j - 1));
    for (let j = PULL_J.peak + 1; j <= PULL_J.out; j++) expect(cameraZoom(j), `j ${j}`).toBeLessThan(cameraZoom(j - 1));
    for (let j = -60; j < 0; j++) {
      expect(cameraZoom(j)).toBeGreaterThanOrEqual(1);
      expect(cameraZoom(j)).toBeLessThanOrEqual(1 + PULL + 1e-12);
    }
  });

  it('shrinks the content 4 % from S1 to S5, the reference’s k1 0.995 → k5 0.957', () => {
    expect(cameraZoom(-7) / cameraZoom(-2)).toBeCloseTo(1.04, 12);
    const shrink = cameraZoom(-3) / cameraZoom(-7); // S4 against S1
    expect(shrink).toBeGreaterThan(0.95);
    expect(shrink).toBeLessThan(0.975);
  });

  it('never shows a frame edge: it zooms in about c_z, so the frame covers the canvas on every charge frame', () => {
    for (const ctx of ALL) {
      for (let j = -20; j < 0; j++) {
        const cam = cameraAt(j, ctx);
        expect(cam.offset).toEqual([0, 0]);
        expect(covers(cam, ctx.width, ctx.height), `j ${j}`).toBe(true);
      }
    }
  });
});
