import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { syntheticTube, type HeldLimb, type Tube, type Vec2, type Vec3 } from '../../src/impact/contracts.ts';
import { bandInterval, buildTube, chunks, flatHeld, indexAt, onMask, radiusAt, sectionAt, sectionVectors, silhouette, SNAP_REACH } from '../../src/lift/tube.ts';
import type { Mask } from '../../src/track/tracking.ts';

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};

// Design §2's radius, written out again here so the test doesn't lean on radiusAt.
const R = (t: number, p: number, R0: number) => Math.max(0.8, R0 * (1 + 0.22 * Math.max(0, 1 - t / 0.14) ** 2) * (1 - t) ** 0.55 * (0.75 + 0.25 * p));

// A held limb along a 3D curve, 32 points, with the hero's pressure shape:
// 0.8 at the root, full by the fifth point, 0.1 at the tip.
function heldAlong(curve: (t: number) => Vec3, id = 1, count = 32, front: (i: number) => boolean = () => true): HeldLimb {
  const pts = Array.from({ length: count }, (_, i) => curve(i / (count - 1)));
  const pressure = pts.map((_, i) => (i <= 4 ? 0.8 + 0.05 * i : 1 - (0.9 * (i - 4)) / (count - 5)));
  let length = 0;
  for (let i = 1; i < count; i++) length += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return { id, points: pts.map((p): Vec2 => [p[0], p[1]]), z: pts.map((p) => p[2]), pressure, front: pts.map((_, i) => front(i)), length };
}

// An arc of a circle in the screen plane, tipped out of it by `tilt` about the x axis.
const planar = (tilt: number) => (t: number): Vec3 => {
  const a = -0.3 + 2.2 * t;
  const [x, y] = [500 + 260 * Math.cos(a), 400 + 260 * Math.sin(a)];
  return [x, 400 + (y - 400) * Math.cos(tilt), (y - 400) * Math.sin(tilt)];
};
const helix = (t: number): Vec3 => [400 + 120 * Math.cos(5 * t), 300 + 120 * Math.sin(5 * t), 200 * t - 100];

describe('buildTube', () => {
  it('densifies 32 points into 94 sections, root first, arc fractions 0 to 1', () => {
    const tube = buildTube(heldAlong(planar(0.4)), 21.6);
    expect(tube.sections).toHaveLength(94);
    expect(tube.sections[0].s).toBe(0);
    expect(tube.sections[93].s).toBe(1);
    for (let i = 1; i < 94; i++) expect(tube.sections[i].s).toBeGreaterThan(tube.sections[i - 1].s);
    expect(tube.sections[0].c).toEqual([...heldAlong(planar(0.4)).points[0], heldAlong(planar(0.4)).z[0]]);
  });

  it('gives each section the radius R(t, p), root flare and 0.8 px floor included', () => {
    const R0 = 21.6;
    const held = heldAlong(planar(0.4));
    const tube = buildTube(held, R0);
    tube.sections.forEach((sec, i) => {
      const seg = Math.min(30, Math.floor(i / 3));
      const u = i === 93 ? 1 : (i % 3) / 3;
      const p = held.pressure[seg] + (held.pressure[seg + 1] - held.pressure[seg]) * u;
      expect(Math.abs(sec.r - R(sec.s, p, R0))).toBeLessThan(0.5);
      expect(Math.abs(sec.r - radiusAt(sec.s, p, R0))).toBeLessThan(1e-9);
    });
    expect(tube.sections[0].r).toBeCloseTo(R0 * 1.22 * (0.75 + 0.25 * 0.8), 9);
    expect(tube.sections[93].r).toBe(0.8);
  });

  it('draws the radius it gives: the silhouette is 2R across, within 0.5 px', () => {
    // A straight limb across a canvas, its silhouette filled with anti-aliasing,
    // measured by the coverage summed down a column at each sampled section.
    const R0 = 20;
    const held = heldAlong((t) => [60 + 600 * t, 100, 0]);
    const tube = buildTube(held, R0);
    const canvas = createCanvas(720, 200);
    const ctx = canvas.getContext('2d');
    const outline = silhouette(tube);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(outline[0][0], outline[0][1]);
    for (const [x, y] of outline.slice(1)) ctx.lineTo(x, y);
    ctx.closePath();
    ctx.fill();
    const img = ctx.getImageData(0, 0, 720, 200);
    for (const i of [3, 15, 30, 47, 60, 75, 88]) {
      const sec = tube.sections[i];
      const col = Math.round(sec.screen[0]);
      const at = sectionAt(tube, indexAtX(tube, col + 0.5));
      let covered = 0;
      for (let row = 0; row < 200; row++) covered += img.data[(row * 720 + col) * 4 + 3] / 255; // alpha: the colour channels are unpremultiplied
      expect(Math.abs(covered / 2 - at.r)).toBeLessThan(0.5);
    }
  });

  it('keeps the frame orthonormal, on a planar curve, a tilted one and a helix', () => {
    for (const curve of [planar(0), planar(0.7), helix]) {
      const tube = buildTube(heldAlong(curve), 21.6);
      for (const sec of tube.sections) {
        expect(Math.abs(Math.hypot(...sec.T) - 1)).toBeLessThan(1e-9);
        expect(Math.abs(Math.hypot(...sec.N) - 1)).toBeLessThan(1e-9);
        expect(Math.abs(dot(sec.N, sec.T))).toBeLessThan(1e-9);
        expect(Math.abs(dot(sec.B, sec.T))).toBeLessThan(1e-9);
        expect(Math.abs(dot(sec.B, sec.N))).toBeLessThan(1e-9);
        const b = cross(sec.T, sec.N);
        expect(Math.hypot(b[0] - sec.B[0], b[1] - sec.B[1], b[2] - sec.B[2])).toBeLessThan(1e-9);
      }
    }
  });

  it('starts the frame on the screen normal and twists it less than 1° in all along a planar curve', () => {
    for (const tilt of [0, 0.7]) {
      const tube = buildTube(heldAlong(planar(tilt)), 21.6);
      const first = tube.sections[0];
      expect(first.N[0]).toBeCloseTo(first.normal[0], 12);
      expect(first.N[1]).toBeCloseTo(first.normal[1], 12);
      expect(first.N[2]).toBe(0);
      // The curve's plane normal m: N = cos θ·(m × T) + sin θ·m, and θ must not drift.
      const m = unit([0, -Math.sin(tilt), Math.cos(tilt)]);
      const angle = (N: Vec3, T: Vec3) => Math.atan2(dot(N, m), dot(N, cross(m, T)));
      const theta0 = angle(first.N, first.T);
      let worst = 0;
      for (const sec of tube.sections) worst = Math.max(worst, Math.abs(angle(sec.N, sec.T) - theta0));
      expect((worst * 180) / Math.PI).toBeLessThan(1);
    }
  });

  it('takes its screen normals from the screen tangent, turned to (−ty, tx)', () => {
    const tube = buildTube(heldAlong(helix), 21.6);
    for (const sec of tube.sections) {
      const l = Math.hypot(sec.T[0], sec.T[1]);
      expect(sec.normal[0]).toBeCloseTo(-sec.T[1] / l, 9);
      expect(sec.normal[1]).toBeCloseTo(sec.T[0] / l, 9);
      expect(sec.screen).toEqual([sec.c[0], sec.c[1]]);
    }
  });

  it('builds the same tube twice', () => {
    const held = heldAlong(helix, 7, 32, (i) => i > 12);
    expect(buildTube(held, 18)).toEqual(buildTube(held, 18));
  });

  it('refuses mismatched inputs', () => {
    const held = heldAlong(helix);
    expect(() => buildTube({ ...held, z: held.z.slice(1) }, 18)).toThrow(/z has 31 values/);
    expect(() => buildTube({ ...held, points: [held.points[0]], z: [0], pressure: [1], front: [true] }, 18)).toThrow(/2 or more points/);
  });

  it('lays a never-lifted drawing flat in the screen plane', () => {
    const tube = buildTube(flatHeld(3, heldAlong(planar(0)).points, heldAlong(planar(0)).pressure), 18);
    for (const sec of tube.sections) {
      expect(sec.c[2]).toBe(0);
      expect(Math.abs(sec.T[2])).toBeLessThan(1e-12);
      expect(sec.front).toBe(true);
    }
  });
});

describe('section vectors and bands', () => {
  it('makes S and Q a unit basis of the cross-section, Q facing the camera', () => {
    for (const curve of [planar(0.7), helix]) {
      for (const sec of buildTube(heldAlong(curve), 21.6).sections) {
        const { S, Q } = sectionVectors(sec);
        expect(Math.abs(Math.hypot(...Q) - 1)).toBeLessThan(1e-12);
        expect(Math.abs(dot(S, sec.T))).toBeLessThan(1e-12);
        expect(Math.abs(dot(Q, sec.T))).toBeLessThan(1e-12);
        expect(Math.abs(dot(Q, S))).toBeLessThan(1e-12);
        expect(Q[2]).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('gives centred, symmetric bands on a straight camera-facing tube lit along Q', () => {
    const tube = syntheticTube(20, 400, 20);
    for (const sec of tube.sections) {
      const { Q } = sectionVectors(sec);
      expect(Q).toEqual([-0, 0, 1]);
      for (const tau of [-0.08, 0.2, 0.5, 0.6, 0.9]) {
        const band = bandInterval(sec, Q, tau)!;
        const half = tau <= 0 ? 1 : Math.sqrt(1 - tau * tau);
        expect(band[0]).toBeCloseTo(-half, 12);
        expect(band[1]).toBeCloseTo(half, 12);
      }
    }
  });

  it('stays centred under Q on a tube that leans toward the camera', () => {
    const tube = buildTube(heldAlong((t) => [100 + 300 * t, 200 + 50 * t, 250 * t]), 20);
    for (const sec of tube.sections) {
      const band = bandInterval(sec, sectionVectors(sec).Q, 0.5)!;
      expect(band[0] + band[1]).toBeCloseTo(0, 9);
    }
  });

  it('moves the band to the side the light comes from, and none when it comes from behind', () => {
    const sec = syntheticTube(4, 100, 10).sections[1];
    const fromSide = bandInterval(sec, [0, 1, 0], 0.5)!; // along +S, the + side
    expect(fromSide[0]).toBeCloseTo(Math.sin(Math.PI / 2 - Math.acos(0.5)), 9);
    expect(fromSide[1]).toBe(1);
    expect(bandInterval(sec, [0, -1, 0], 0.5)![0]).toBe(-1);
    expect(bandInterval(sec, [0, 0, -1], 0.2)).toBeNull();
    // From straight behind, N·X ≥ −0.5 holds 60° and more off the axis: a
    // sliver at each edge, the first one kept when they tie.
    const back = bandInterval(sec, [0, 0, -1], -0.5)!;
    expect(back[0]).toBe(-1);
    expect(back[1]).toBeCloseTo(-Math.sin(Math.PI / 3), 12);
    expect(bandInterval(sec, [1, 0, 0], 0.1)).toBeNull(); // along the tube: every point at N·X = 0
    expect(bandInterval(sec, [1, 0, 0], -0.1)).toEqual([-1, 1]);
    // Lit from behind and to the side, the band can split in two; the wider piece is kept.
    const split = bandInterval(sec, unit([0, 0.3, -1]), -0.2)!;
    expect(split[1]).toBe(1);
    expect(split[0]).toBeGreaterThan(-1);
  });

  it('matches N·X ≥ τ sampled round the visible half', () => {
    const tube = buildTube(heldAlong(helix), 21.6);
    const X = unit([-0.6, -0.75, 0.3]);
    for (const sec of tube.sections.filter((_, i) => i % 7 === 0)) {
      const { S, Q } = sectionVectors(sec);
      for (const tau of [-0.08, 0.5]) {
        const band = bandInterval(sec, X, tau);
        for (let q = 1; q < 200; q++) {
          const psi = -Math.PI / 2 + (Math.PI * q) / 200;
          const N: Vec3 = [Math.cos(psi) * Q[0] + Math.sin(psi) * S[0], Math.cos(psi) * Q[1] + Math.sin(psi) * S[1], Math.cos(psi) * Q[2] + Math.sin(psi) * S[2]];
          const lit = dot(N, X) >= tau;
          const u = Math.sin(psi);
          const inside = band !== null && u >= band[0] - 1e-9 && u <= band[1] + 1e-9;
          if (Math.abs(dot(N, X) - tau) > 1e-6) expect(inside).toBe(lit);
        }
      }
    }
  });
});

describe('silhouette', () => {
  const inside = (poly: Vec2[], [x, y]: Vec2) => {
    let winding = 0;
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i];
      const [bx, by] = poly[(i + 1) % poly.length];
      const side = (bx - ax) * (y - ay) - (x - ax) * (by - ay);
      if (ay <= y && by > y && side > 0) winding++;
      else if (ay > y && by <= y && side < 0) winding--;
    }
    return winding !== 0;
  };

  it('contains the centreline, and the sections out to nearly their radius', () => {
    for (const curve of [planar(0), planar(0.7), helix]) {
      const tube = buildTube(heldAlong(curve), 21.6);
      const poly = silhouette(tube);
      for (const sec of tube.sections) {
        expect(inside(poly, sec.screen)).toBe(true);
        for (const side of [0.9, -0.9]) expect(inside(poly, [sec.screen[0] + sec.normal[0] * sec.r * side, sec.screen[1] + sec.normal[1] * sec.r * side])).toBe(true);
      }
      for (let x = 0; x < 93; x += 0.25) expect(inside(poly, sectionAt(tube, x).screen)).toBe(true);
      // ... and nothing far outside it.
      const sec = tube.sections[40];
      expect(inside(poly, [sec.screen[0] + sec.normal[0] * sec.r * 1.2, sec.screen[1] + sec.normal[1] * sec.r * 1.2])).toBe(false);
    }
  });

  it('rounds off both ends and grows with the pad', () => {
    const tube = syntheticTube(10, 200, 10, [100, 100]);
    const poly = silhouette(tube);
    const xs = poly.map((p) => p[0]);
    expect(Math.min(...xs)).toBeCloseTo(90, 0);
    expect(Math.max(...xs)).toBeCloseTo(310, 0);
    const padded = silhouette(tube, 4).map((p) => p[1]);
    expect(Math.max(...padded)).toBeCloseTo(114, 9);
    expect(Math.min(...padded)).toBeCloseTo(86, 9);
  });
});

describe('chunks', () => {
  // A person-sized disc: alpha 255 inside, 0 outside, at `scale` mask px per frame px.
  function discMask(cx: number, cy: number, r: number, width: number, height: number, scale = 1): Mask {
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    const alpha = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) if (Math.hypot((x + 0.5) / scale - cx, (y + 0.5) / scale - cy) < r) alpha[y * w + x] = 255;
    }
    return { width: w, height: h, alpha };
  }

  // A straight limb from the disc's centre out past its edge at x = 650, its
  // front flags flipping on a held point a few sections from the edge.
  const crossing = (flipAt: number) => heldAlong((t) => [500 + 400 * t, 400, 0], 2, 32, (i) => i >= flipAt);

  it('splits the tube on its front flags, halfway between sections, without a mask', () => {
    const tube = buildTube(crossing(14), 18);
    const runs = chunks(tube);
    expect(runs.map((c) => c.front)).toEqual([false, true]);
    const flip = runs[1].from;
    expect(tube.sections[Math.floor(flip)].front).toBe(false);
    expect(tube.sections[Math.ceil(flip)].front).toBe(true);
    expect(flip % 1).toBe(0.5);
    // The behind run reaches one section past the flip, under the front run.
    expect(runs[0]).toEqual({ front: false, from: 0, to: flip + 1 });
    expect(runs[1].to).toBe(93);
  });

  it('snaps the flip to the mask edge, within 2 px, from either side', () => {
    for (const scale of [1, 0.5]) {
      const mask = discMask(500, 400, 150, 1000, 800, scale);
      for (const flipAt of [11, 12, 13, 14]) { // the edge is at section 34.9; these flip at 31.5 to 40.5
        const tube = buildTube(crossing(flipAt), 18);
        const raw = chunks(tube)[1].from;
        const runs = chunks(tube, mask, scale);
        expect(runs.map((c) => c.front)).toEqual([false, true]);
        const snapped = runs[1].from;
        if (Math.abs(raw - snapped) > SNAP_REACH) throw new Error(`moved ${raw} → ${snapped}`);
        const at = sectionAt(tube, snapped).screen;
        expect(Math.abs(at[0] - 650)).toBeLessThan(2);
        expect(runs[0].to).toBeCloseTo(snapped + 1, 9);
        // The front run starts outside him, the behind run is inside him up to there.
        expect(onMask(mask, scale, sectionAt(tube, snapped + 0.5).screen[0], 400)).toBe(false);
        expect(onMask(mask, scale, sectionAt(tube, snapped - 0.5).screen[0], 400)).toBe(true);
      }
    }
  });

  it('leaves a flip alone when the edge is more than 6 sections away', () => {
    const mask = discMask(500, 400, 150, 1000, 800);
    const tube = buildTube(crossing(24), 18);
    const edge = indexAtX(tube, 650);
    const raw = chunks(tube)[1].from;
    expect(raw - edge).toBeGreaterThan(SNAP_REACH);
    expect(chunks(tube, mask)).toEqual(chunks(tube));
  });

  it('gives one run when nothing flips, mask or not', () => {
    const tube = buildTube(heldAlong((t) => [100 + 400 * t, 400, 0]), 18);
    expect(chunks(tube)).toEqual([{ front: true, from: 0, to: 93 }]);
    expect(chunks(tube, discMask(300, 400, 100, 1000, 800))).toEqual([{ front: true, from: 0, to: 93 }]);
  });

  it('snaps every flip of a limb that goes behind him and comes back out', () => {
    // In front, behind across the disc, in front again: the flips sit about 4
    // sections inside the disc (his hair, past the stand-in's head). The
    // edges are at sections 18.6 and 74.4; the flags flip at 22.5 and 70.5.
    const held = heldAlong((t) => [300 + 400 * t, 400, 0], 4, 32, (i) => i < 8 || i >= 24);
    const tube = buildTube(held, 18);
    const mask = discMask(500, 400, 120, 1000, 800);
    const runs = chunks(tube, mask);
    expect(runs.map((c) => c.front)).toEqual([true, false, true]);
    expect(Math.abs(sectionAt(tube, runs[0].to).screen[0] - 380)).toBeLessThan(2);
    expect(Math.abs(sectionAt(tube, runs[2].from).screen[0] - 620)).toBeLessThan(2);
    expect(runs[1].from).toBeCloseTo(runs[0].to - 1, 9);
    expect(runs[1].to).toBeCloseTo(runs[2].from + 1, 9);
  });

  it('finds fractional sections and arc fractions both ways', () => {
    const tube = buildTube(heldAlong(planar(0.3)), 18);
    for (const s of [0, 0.1, 0.37, 0.5, 0.99, 1]) expect(sectionAt(tube, indexAt(tube, s)).s).toBeCloseTo(s, 9);
    const mid = sectionAt(tube, 10.5);
    expect(Math.hypot(...mid.T)).toBeCloseTo(1, 12);
    expect(Math.abs(dot(mid.N, mid.T))).toBeLessThan(1e-12);
  });
});

// The fractional section whose centre is at screen x, on a limb along +x.
function indexAtX(tube: Tube, x: number): number {
  const secs = tube.sections;
  let i = 1;
  while (i < secs.length - 1 && secs[i].screen[0] < x) i++;
  const a = secs[i - 1].screen[0];
  const b = secs[i].screen[0];
  return i - 1 + Math.min(1, Math.max(0, (x - a) / (b - a)));
}
