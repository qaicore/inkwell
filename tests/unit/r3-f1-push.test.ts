// Round 3, F1 (pass 2): which way a node inside his scanned body goes out
// (collide.ts scanNode, scanSegments and scanPush). The rope comes from his
// back: a node goes out on the side of him the node before it is on, so no
// segment hangs through him; else the way it came, its depth memory, but only
// within MEMORY_REACH (0.4 torso units), since a node deep inside a thick
// block of him came round him on screen, not through him in a step.
// Synthetic only: a disc of person mask over an upright egg with his arm
// behind it, so the egg and the arm make one block 148 px deep on the ray
// through the egg's middle.
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/impact/contracts.ts';
import { toCamera, unproject, type Body3D } from '../../src/lift/body.ts';
import { collideChain, insideDepth, scanOf, scanPush, type Capsule, type Dummy } from '../../src/lift/collide.ts';
import type { Mask } from '../../src/track/tracking.ts';
import type { Vec2 } from '../../src/types/effect.ts';

const W = 1920;
const H = 1080;
const b: Body3D = { x: 960, y: 600, unit: 200, yaw: 0, pitch: 0, roll: 0 };
const centre = toCamera(b, [0, -0.325, 0]); // the egg's middle: 40 px deep each way
const C: Vec2 = [centre[0], centre[1]];

// A disc of person mask round C, `r` frame px, at half the clip's resolution.
function discMask(r: number): Mask {
  const [w, h] = [W / 2, H / 2];
  const alpha = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (Math.hypot((x + 0.5) * 2 - C[0], (y + 0.5) * 2 - C[1]) < r) alpha[y * w + x] = 255;
  return { width: w, height: h, alpha };
}

// His arm across his back, touching it: 30 px round, its axis 70 px behind his middle.
const arm: Capsule = { part: 'upperArm', a: toCamera(b, [-0.1, -0.325, -0.35]), b: toCamera(b, [0.1, -0.325, -0.35]), r: 30 };
const dummy: Dummy = { body: b, capsules: [arm] };
// 150 px of mask round C: out sideways is further than out in depth near the middle.
const scan = scanOf(discMask(150), W, H, dummy)!;
const d: Dummy = { ...dummy, scan };
const at = (dx: number, dy: number, z: number): Vec3 => unproject(b, [C[0] + dx, C[1] + dy], z);
const R = 4; // the limb's radius, px
const REACH = 0.4 * b.unit; // MEMORY_REACH

describe('which way a node inside him goes out', () => {
  it('sees the egg and the arm behind it as one block, 148 px deep with the limb`s radius, on the ray through his middle', () => {
    // In front of it, between, and behind it by the limb's radius: out.
    expect(scanPush(scan, at(0, 0, 45), R)).toBeNull();
    expect(scanPush(scan, at(0, 0, -105), R)).toBeNull();
    // Inside, its faces at 44 and -104.
    expect(scanPush(scan, at(0, 0, 40), R)!.out[2]).toBeCloseTo(44, 0);
    expect(scanPush(scan, at(0, 0, -100), R)!.out[2]).toBeCloseTo(-104, 0);
  });

  it('keeps to the side it was last clear on when that face is within MEMORY_REACH, though the other is nearer', () => {
    // 72 px from the back face and 76 from the front, last clear in front of him: the front.
    const p = at(0, 0, -32);
    const hit = scanPush(scan, p, R, 150)!;
    expect(44 - p[2]).toBeLessThanOrEqual(REACH);
    expect(hit.way).toBe(1);
    expect(hit.out[2]).toBeCloseTo(44, 0);
    // Without a memory, the nearer: behind.
    expect(scanPush(scan, p, R)!.way).toBe(-1);
  });

  it('goes the nearer way when the face on its memory`s side is further than MEMORY_REACH: it came round him, not through him', () => {
    // 14 px from the front face and 134 from the back, last clear behind him: the front all the same.
    const p = at(0, 0, 30);
    expect(p[2] + 104).toBeGreaterThan(REACH);
    const hit = scanPush(scan, p, R, -150)!;
    expect(hit.way).toBe(1);
    expect(hit.out[2]).toBeCloseTo(44, 0);
    // Given as far as it likes (the rope's own way, below), the back.
    expect(scanPush(scan, p, R, -150, Infinity)!.way).toBe(-1);
  });

  it('puts a node out on the side of him the node before it is on, whatever its memory says, so no segment hangs through him', () => {
    // The root and the node after it behind him; the next inside him, near his
    // front, and last clear in front of him: it goes out behind, with them.
    const points: Vec3[] = [at(0, -20, -130), at(0, -10, -120), at(0, 0, 20)];
    const prev = points.map((p): Vec3 => [p[0], p[1], p[2]]);
    const clear = [NaN, NaN, 100];
    collideChain(d, points, prev, [R, R, R], 1, 3, 0, clear, false, true, false);
    expect(points[2][2]).toBeCloseTo(-104, 0);
    expect(clear[2]).toBeCloseTo(points[2][2], 9);
    for (let i = 0; i < 2; i++) {
      for (let k = 0; k <= 16; k++) {
        const t = k / 16;
        const q: Vec3 = [points[i][0] + (points[i + 1][0] - points[i][0]) * t, points[i][1] + (points[i + 1][1] - points[i][1]) * t, points[i][2] + (points[i + 1][2] - points[i][2]) * t];
        expect(insideDepth(d, q, R), `segment ${i} at ${t}`).toBeLessThanOrEqual(1e-6);
      }
    }
    // The node before it in front of him: out in front.
    const front: Vec3[] = [at(0, -20, 90), at(0, -10, 80), at(0, 0, -60)];
    collideChain(d, front, front.map((p): Vec3 => [p[0], p[1], p[2]]), [R, R, R], 1, 3, 0, [NaN, NaN, -200], false, true, false);
    expect(front[2][2]).toBeCloseTo(44, 0);
  });
});
