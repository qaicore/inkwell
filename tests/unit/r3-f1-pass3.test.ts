// Round 3, F1, pass 3: the drawn line's joints eased on screen, a released
// limb turned to face the camera, and the root's own segment routed clear of
// him past the flare (decisions 15, 17 and 18). Synthetic points only.
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/impact/contracts.ts';
import { project, toCamera, type Body3D } from '../../src/lift/body.ts';
import { insideDepth, routeAround, type Dummy } from '../../src/lift/collide.ts';
import { easeJoints, faceCamera, screenShare } from '../../src/lift/lift.ts';
import type { Vec2 } from '../../src/types/effect.ts';

const deg = (r: number) => (r * 180) / Math.PI;
const rad = (d: number) => (d * Math.PI) / 180;
const turns = (p: readonly Vec2[]) =>
  p.slice(1, -1).map((q, i) => {
    const [ax, ay, bx, by] = [q[0] - p[i][0], q[1] - p[i][1], p[i + 2][0] - q[0], p[i + 2][1] - q[1]];
    return deg(Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by))))));
  });
// A line of segments of the given lengths, segment i heading `heading(i)` (radians).
const line = (lengths: readonly number[], heading: (i: number) => number): Vec2[] => {
  const out: Vec2[] = [[0, 0]];
  lengths.forEach((l, i) => out.push([out[i][0] + l * Math.cos(heading(i)), out[i][1] + l * Math.sin(heading(i))]));
  return out;
};
const even = (n: number) => Array.from({ length: n }, () => 20);

describe('the drawn joints eased on screen (decision 15: no fold over 60°)', () => {
  it('eases a hairpin by a segment seen end on to the sharpest allowed, the root and the tip staying', () => {
    // 20 segments of 20 px but the third, seen end on (4 px), and a turn back of 150° after it.
    const p = line(even(20).map((l, i) => (i === 2 ? 4 : l)), (i) => (i < 3 ? 0 : rad(150)));
    expect(Math.max(...turns(p))).toBeGreaterThan(140);
    const q = easeJoints(p, rad(55));
    expect(Math.max(...turns(q))).toBeLessThanOrEqual(56);
    expect(q[0]).toEqual(p[0]);
    expect(q[q.length - 1]).toEqual(p[p.length - 1]);
  });

  it('leaves a sharp joint mid-limb between full-length segments as drawn, unless told to ease every joint', () => {
    const p = line(even(20), (i) => (i < 8 ? 0 : rad(80)));
    expect(easeJoints(p, rad(55))).toEqual(p);
    expect(Math.max(...turns(easeJoints(p, rad(55), true)))).toBeLessThanOrEqual(56);
  });

  it('eases a sharp joint by the tip, which whips about free of him, whatever its segments', () => {
    const p = line(even(20), (i) => (i < 18 ? 0 : rad(100)));
    const q = easeJoints(p, rad(55));
    expect(Math.max(...turns(q))).toBeLessThanOrEqual(56);
    expect(q.slice(0, 15)).toEqual(p.slice(0, 15));
  });
});

describe('a released limb turned toward the camera', () => {
  // A limb leaving the screen plane at `tilt` (radians), gently curved.
  const limb = (tilt: number): Vec3[] =>
    Array.from({ length: 24 }, (_, i) => {
      const s = i * 20;
      return [900 + s * Math.cos(tilt), 500 + 0.002 * s * s, 100 - s * Math.sin(tilt)];
    });
  const lengths = (p: readonly Vec3[]) => p.slice(1).map((q, i) => Math.hypot(q[0] - p[i][0], q[1] - p[i][1], q[2] - p[i][2]));

  it('measures the share of its length on screen', () => {
    expect(screenShare(limb(0))).toBeCloseTo(1, 6);
    const straight = Array.from({ length: 10 }, (_, i): Vec3 => [10 * i * Math.cos(rad(60)), 0, 10 * i * Math.sin(rad(60))]);
    expect(screenShare(straight)).toBeCloseTo(0.5, 6);
  });

  it('leaves one that shows enough of its length as it is', () => {
    const p = limb(rad(10));
    expect(faceCamera(p, 0.92)).toBe(p);
  });

  it('turns one seen edge on rigidly about its root until it shows the least share asked, and no further', () => {
    for (const tilt of [35, 50, 70].map(rad)) {
      const p = limb(tilt);
      const q = faceCamera(p, 0.92);
      expect(q[0]).toEqual(p[0]);
      expect(screenShare(q)).toBeGreaterThanOrEqual(0.92 - 1e-3);
      expect(screenShare(q)).toBeLessThan(0.93);
      lengths(q).forEach((l, i) => expect(l).toBeCloseTo(lengths(p)[i], 6));
    }
  });

  it('turns it more the more it tips, with no jump', () => {
    let last = faceCamera(limb(rad(20)), 0.92);
    for (let d = 21; d <= 80; d++) {
      const q = faceCamera(limb(rad(d)), 0.92);
      const [a, b] = [q[q.length - 1], last[last.length - 1]];
      expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]), `${d}°`).toBeLessThan(15);
      last = q;
    }
  });
});

describe('the root`s own segment routed clear of him past the flare (decision 18)', () => {
  const b: Body3D = { x: 960, y: 600, unit: 200, yaw: 0, pitch: 0, roll: 0 };
  const d: Dummy = { body: b, capsules: [] }; // the egg alone: 66 px wide each way and 40 deep about (960, 535, 0)
  // The root just behind his back, its first segment cutting into him on its way out round his side.
  const root = toCamera(b, [0, -0.325, -0.22]);
  const nodes: Vec3[] = [root, ...Array.from({ length: 6 }, (_, k): Vec3 => [root[0] + 90 + 30 * k, root[1], k === 0 ? 10 : 0])];
  const free = 26;
  // The points of the root's segment from `free` along it to its far end.
  const past = (pts: readonly Vec3[]) => {
    const l = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1], pts[1][2] - pts[0][2]);
    return Array.from({ length: 33 }, (_, k) => free / l + ((1 - free / l) * k) / 32).map((t): Vec3 => [0, 1, 2].map((c) => pts[0][c] + (pts[1][c] - pts[0][c]) * t) as Vec3);
  };
  const radii = nodes.map(() => 4);

  it('goes into him as drawn', () => {
    expect(Math.max(...past(nodes).map((q) => insideDepth(d, q)))).toBeGreaterThan(5);
  });

  it('is left as it is when not asked for: its far end can`t clear its near end', () => {
    expect(routeAround(d, nodes, radii, 1, undefined, free)).toEqual(nodes);
  });

  it('keeps it out of him past the flare when asked, in depth only, its far end moving and never the root', () => {
    const routed = routeAround(d, nodes, radii, 1, undefined, free, 2);
    expect(routed[0]).toEqual(nodes[0]);
    expect(routed[1][2]).toBeLessThan(nodes[1][2]);
    routed.forEach((q, k) => {
      const [u, v] = [project(b, q).xy, project(b, nodes[k]).xy];
      expect(Math.hypot(u[0] - v[0], u[1] - v[1]), `node ${k} on screen`).toBeLessThan(1e-6);
    });
    for (const q of past(routed)) expect(insideDepth(d, q)).toBeLessThanOrEqual(0.5);
  });
});
