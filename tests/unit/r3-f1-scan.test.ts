// Round 3, F1: the pre-scan of his body (decision 18), the strike curve
// routed round it (decision 17) and the drawing never straight (decision 15).
// Synthetic masks and bodies only: a disc of person mask on an upright egg,
// at half the clip's resolution, as the cached SAM cutouts are.
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/impact/contracts.ts';
import { project, toCamera, unproject, type Body3D } from '../../src/lift/body.ts';
import { insideDepth, routeAround, SCAN_CELL, scanOf, scanPush, type Capsule, type Dummy } from '../../src/lift/collide.ts';
import { bowedOnScreen, bulgeSide, sagittaRatio } from '../../src/lift/strike.ts';
import type { Mask } from '../../src/track/tracking.ts';
import type { Vec2 } from '../../src/types/effect.ts';

const W = 1920;
const H = 1080;
const CELL = SCAN_CELL * W; // 4 px
const b: Body3D = { x: 960, y: 600, unit: 200, yaw: 0, pitch: 0, roll: 0 };
const centre = toCamera(b, [0, -0.325, 0]); // the egg's middle: (960, 535, 0), 66 px wide each way and 40 deep
const C: Vec2 = [centre[0], centre[1]];

// A disc of person mask round C, `r` frame px, at `scale` mask px per frame px.
function discMask(r: number, scale = 0.5): Mask {
  const [w, h] = [Math.round(W * scale), Math.round(H * scale)];
  const alpha = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (Math.hypot((x + 0.5) / scale - C[0], (y + 0.5) / scale - C[1]) < r) alpha[y * w + x] = 255;
  return { width: w, height: h, alpha };
}

const at = (radius: number, angle: number, z = 0): Vec3 => unproject(b, [C[0] + radius * Math.cos(angle), C[1] + radius * Math.sin(angle)], z);
const fromC = (p: Vec3) => {
  const xy = project(b, p).xy;
  return Math.hypot(xy[0] - C[0], xy[1] - C[1]);
};
const ANGLES = Array.from({ length: 12 }, (_, k) => (2 * Math.PI * k) / 12 + 0.1);

describe('the pre-scan (decision 18)', () => {
  const egg: Dummy = { body: b, capsules: [] };
  const scan = scanOf(discMask(50), W, H, egg)!;

  it('scans the mask into a signed distance field: the way out across the outline within a cell of the true distance', () => {
    // The outline is found between cell centres on a mask of 2 px pixels: about 3 px at worst.
    expect(CELL).toBe(4);
    for (const angle of ANGLES) {
      for (const inset of [2, 5, 10, 20]) {
        // At the egg's middle depth the slab is 70 px deep or more: sideways is the shorter way.
        const hit = scanPush(scan, at(50 - inset, angle), 4)!;
        expect(Math.abs(hit.depth - (inset + 4)), `${angle} ${inset}`).toBeLessThan(CELL);
        expect(Math.abs(fromC(hit.out) - 54)).toBeLessThan(CELL);
        expect(hit.out[2]).toBe(0);
      }
      // Off the mask, the limb's radius clear of it: out.
      expect(scanPush(scan, at(57, angle), 4)).toBeNull();
    }
  });

  it('pushes a node out the shorter way: in depth near his middle, behind his back or in front of his chest', () => {
    for (const angle of ANGLES) {
      const p = at(5, angle, -28); // 45 px from the outline, 12 behind his middle: 16 px from his back with the limb's 4
      const hit = scanPush(scan, p, 4)!;
      const back = -40 * Math.sqrt(1 - (5 / 66) ** 2); // the egg's back surface there, within a cell
      expect(Math.abs(hit.out[2] - (back - 4))).toBeLessThan(1);
      expect(fromC(hit.out)).toBeCloseTo(5, 6); // in depth only: the same place on screen
      const front = scanPush(scan, at(5, angle, 28), 4)!;
      expect(Math.abs(front.out[2] + back - 4)).toBeLessThan(1);
    }
    // In front of his chest or behind his back by more than the limb's radius: out.
    expect(scanPush(scan, at(5, 0, 46), 4)).toBeNull();
    expect(scanPush(scan, at(5, 0, -46), 4)).toBeNull();
  });

  it('counts his whole outline, loose clothes and hair, not just the parts: the mask is the outline and the parts its depth', () => {
    const coat = scanOf(discMask(100), W, H, egg)!; // 34 px past the egg's side all round
    for (const angle of [0, Math.PI]) {
      const p = at(85, angle); // beside the egg on screen, inside the mask
      expect(insideDepth({ ...egg, scan: null }, p, 4)).toBeLessThanOrEqual(0); // the parts alone: clear
      const hit = scanPush(coat, p, 4)!;
      expect(Math.abs(hit.depth - 19)).toBeLessThan(2); // the scan: 15 px inside his outline, plus the limb's 4
      expect(insideDepth({ ...egg, scan: coat }, p, 4)).toBeCloseTo(hit.depth, 9);
    }
  });

  it('falls back on the parts on a frame without a mask, and scans nothing from an empty one', () => {
    expect(scanOf({ width: 960, height: 540, alpha: new Uint8ClampedArray(960 * 540) }, W, H, egg)).toBeNull();
    const p = at(20, 0);
    expect(insideDepth(egg, p, 4)).toBeGreaterThan(0);
    expect(insideDepth({ ...egg, scan: null }, p, 4)).toBe(insideDepth(egg, p, 4));
  });

  it('is a pure function of the mask and the dummy: the same pushes from two scans', () => {
    const again = scanOf(discMask(50), W, H, egg)!;
    for (const angle of ANGLES) expect(scanPush(again, at(40, angle), 4)).toEqual(scanPush(scan, at(40, angle), 4));
  });
});

describe('routing round him (decision 17)', () => {
  // His forearm across his chest, well in front of it: two spans on the rays through it, with room between.
  const arm: Capsule = { part: 'forearm', a: toCamera(b, [-0.45, -0.45, 0.6]), b: toCamera(b, [0.45, -0.45, 0.6]), r: 14 };
  const d: Dummy = { body: b, capsules: [arm] };
  const across = (z: (k: number) => number): Vec3[] => Array.from({ length: 32 }, (_, k) => toCamera(b, [-1 + (2 * k) / 31, -0.45, z(k)]));
  const over = (p: Vec3) => Math.abs(project(b, p).xy[0] - b.x) < 0.3 * b.unit; // over his chest on screen
  const radii = Array.from({ length: 32 }, () => 4);

  it('leaves a curve in the gap between his chest and his arm where it is', () => {
    const between = across(() => 0.4); // 80 px out: 40 clear of his chest, 40 short of the arm
    expect(routeAround(d, between, radii, 1)).toEqual(between);
  });

  it('takes a run through him round one side only, keeping every node`s place on screen', () => {
    const through = across(() => 0.05);
    const routed = routeAround(d, through, radii, 1);
    const sides = routed.flatMap((q, k) => (over(through[k]) ? [Math.sign(q[2] - through[k][2])] : []));
    expect(new Set(sides).size).toBe(1);
    routed.forEach((q, k) => {
      expect(insideDepth(d, q)).toBeLessThanOrEqual(1e-6);
      const [u, v] = [project(b, q).xy, project(b, through[k]).xy];
      expect(Math.hypot(u[0] - v[0], u[1] - v[1])).toBeLessThan(1e-6);
    });
  });

  it('goes round the side that moves it least, out of him at every point along it, and never steps through him', () => {
    // Behind his back, then over him and into him nearer his back than his chest: behind.
    const fromBehind = across((k) => (over(across(() => 0)[k]) ? -0.12 : -0.5));
    const routed = routeAround(d, fromBehind, radii, 1);
    for (let k = 0; k < 32; k++) if (over(fromBehind[k])) expect(routed[k][2], `node ${k}`).toBeLessThan(fromBehind[k][2]);
    for (let k = 0; k < 31; k++) {
      for (let t = 0; t < 1; t += 0.125) {
        const q: Vec3 = [0, 1, 2].map((c) => routed[k][c] + (routed[k + 1][c] - routed[k][c]) * t) as Vec3;
        expect(insideDepth(d, q), `node ${k} + ${t}`).toBeLessThanOrEqual(1e-6);
      }
    }
    // Its depth changes no faster than the curve's own, but where it has to go round him.
    const step = (pts: Vec3[], k: number) => Math.abs(pts[k + 1][2] - pts[k][2]);
    for (let k = 1; k < 31; k++) expect(step(routed, k), `node ${k}`).toBeLessThan(step(fromBehind, k) + 0.5 * b.unit);
  });

  it('takes the side the limb is on now where either side will do', () => {
    // Over his arm only before the run, room both ways there: the side it's on now wins.
    const through = across(() => 0.05);
    for (const [now, sign] of [[-100, -1], [60, 1]] as const) {
      const routed = routeAround(d, through, radii, 1, () => now);
      for (let k = 0; k < 32; k++) if (over(through[k])) expect(Math.sign(routed[k][2] - through[k][2]), `node ${k}`).toBe(sign);
    }
  });
});

describe('never straight (decision 15)', () => {
  const fr = Array.from({ length: 32 }, (_, i) => i / 31);
  const line = Array.from({ length: 32 }, (_, i): Vec3 => [800 + 10 * i, 400 + 3 * i, -60 + 2 * i]);
  const seen = (pts: readonly Vec3[]) => pts.map((p) => project(b, p).xy);
  const length = (pts: readonly Vec3[]) => pts.slice(1).reduce((s, q, i) => s + Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1], q[2] - pts[i][2]), 0);

  it('bows a limb that looks straight to at least the least sagitta, its way, at its length, from its root', () => {
    for (const side of [1, -1] as const) {
      for (const least of [0.07, 0.1, 0.16]) {
        const bowed = bowedOnScreen(b, line, side, fr, least);
        expect(sagittaRatio(seen(bowed))).toBeGreaterThanOrEqual(least - 0.005);
        expect(bulgeSide(seen(bowed))).toBe(side);
        expect(length(bowed)).toBeCloseTo(length(line), 6);
        expect(bowed[0]).toEqual(line[0]);
      }
    }
  });

  it('leaves a limb that bows enough as it is', () => {
    const arc = fr.map((t): Vec3 => [800 + 300 * t, 400 + 90 * Math.sin(Math.PI * t), -60]);
    expect(sagittaRatio(seen(arc))).toBeGreaterThan(0.2);
    expect(bowedOnScreen(b, arc, 1, fr, 0.16)).toEqual(arc);
  });
});
