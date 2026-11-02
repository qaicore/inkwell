// Round 3, F6 (judge round 2): compositing, layering and Reduce flashing, on
// the synthetic slam (helpers/impact-scene-clip.ts). The burst, the cluster
// and the dust go in the masses slot over him, uncut, in both flash modes;
// the face cut comes from the face mask only, hard-edged, so nothing of him
// or the plate shows inside the cluster; the floods' wide glow goes under
// him; no limb glows within 0.6 U of P while the burst shows; the arcs glow
// at most half the ribbons over j 9–31; a limb part behind him glows off his
// mask only; Reduce flashing lays the masses opaque at the plate's averaged
// luminance, at full opacity until the ladder's last two steps.
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { shapes as clusterShapes } from '../../src/impact/aftermath/cluster.ts';
import { massClock, paint } from '../../src/impact/aftermath/fire.ts';
import type { GlowCall, Vec2 } from '../../src/impact/contracts.ts';
import { LADDER_STEPS, MASS_ALPHA, degradeAt } from '../../src/impact/ladder.ts';
import { createImpactScene, lumaBlit, lumaPart } from '../../src/impact/scene.ts';
import { onMask } from '../../src/lift/tube.ts';
import { nodeScratch } from '../../src/render/headless.ts';
import { STACK_ORDER } from '../../src/render/stack.ts';
import { HERO } from './helpers/impact-drawings.ts';
import { sceneClip, sceneOf } from './helpers/impact-scene-clip.ts';

const I = HERO.I; // 84
const MASSES: readonly string[] = ['fire', 'cluster', 'dust'];

let fullScene: ReturnType<typeof sceneOf> | null = null;
let safeScene: ReturnType<typeof sceneOf> | null = null;
const full = () => (fullScene ??= sceneOf());
const safe = () => (safeScene ??= sceneOf({ flash: 'safe' }));

// WCAG 2's relative luminance and the flash checker's saturated red, on 8 bits.
const lin = (c: number) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
const lum = (p: ArrayLike<number>) => 0.2126 * lin(p[0]) + 0.7152 * lin(p[1]) + 0.0722 * lin(p[2]);
const saturatedRed = (p: ArrayLike<number>) => {
  const [r, g, b] = [lin(p[0]), lin(p[1]), lin(p[2])];
  return r + g + b > 0 && r / (r + g + b) >= 0.8;
};

// Every point a glow call lights from.
const pointsOf = (c: GlowCall): Vec2[] => (c.op === 'stroke' ? c.points : c.op === 'disc' ? [c.c] : c.outline);

describe('the masses slot (judges: he hid the burst, and the face cut holed the smoke)', () => {
  it('sits right over the limbs in front and under the thin fx, the floods below him', () => {
    expect(STACK_ORDER.indexOf('masses')).toBe(STACK_ORDER.indexOf('limbsFront') + 1);
    expect(STACK_ORDER.indexOf('fx')).toBe(STACK_ORDER.indexOf('masses') + 1);
    expect(STACK_ORDER.indexOf('floods')).toBeLessThan(STACK_ORDER.indexOf('person'));
  });

  it('holds the burst or the cluster, then the dust over it, in both flash modes; the fire and dust slots stay empty', () => {
    for (const [flash, s] of [['full', full()], ['safe', safe()]] as const) {
      const seen = new Set<string>();
      for (let o = I + 9; o <= I + 45; o++) {
        const L = s.frameLayers(o);
        expect(L.slots.fire ?? [], `${flash} f${o}`).toHaveLength(0);
        expect(L.slots.dust ?? [], `${flash} f${o}`).toHaveLength(0);
        const masses = L.parts.filter((p) => MASSES.includes(p.name));
        const names = masses.map((p) => p.name);
        for (const p of masses) {
          seen.add(p.name);
          expect(p.slot, `${flash} f${o} ${p.name}`).toBe('masses');
          // Reduce flashing draws them luma-matched, under keys of their own.
          expect(p.key.endsWith(':luma'), `${flash} f${o} ${p.name}`).toBe(flash === 'safe');
          // Opaque in both modes: they erode (fire.ts), and fade only over the last FADE_FRAMES.
          if (o - I <= 45 - 3) expect(p.alpha, `${flash} f${o} ${p.name}`).toBe(1);
        }
        expect(names.includes('fire') && names.includes('cluster'), `${flash} f${o}`).toBe(false);
        if (names.includes('dust')) expect(names[names.length - 1], `${flash} f${o}: the dust over the cluster's base`).toBe('dust');
        // The masses' slot is never face-cut: only fx is (stack.test.ts), and the cut is set from j 9.
        expect(L.faceCut, `${flash} f${o}`).not.toBeNull();
      }
      expect([...seen].sort(), flash).toEqual(['cluster', 'dust', 'fire']);
    }
  });

  it("fades the masses only at the ladder's last two steps (0.6, 0.3), and never under full flashing", () => {
    expect(MASS_ALPHA).toEqual([1, 1, 1, 1, 1, 1, 0.6, 0.3]);
    for (let step = 0; step <= LADDER_STEPS; step++) {
      expect(degradeAt(step, 'safe').masses).toBe(MASS_ALPHA[step]);
      expect(degradeAt(step, 'full').masses).toBe(1);
    }
    for (const step of [5, 6, 7]) {
      const s = safe().degraded(step);
      let n = 0;
      // Under the freeze (step 4 on), output I + 35 + n shows clip frame I + 9 + n.
      for (let o = I + 35; o <= I + 60; o++) {
        for (const p of s.frameLayers(o).parts) {
          if (!MASSES.includes(p.name)) continue;
          n++;
          expect(p.slot, `step ${step} f${o} ${p.name}`).toBe('masses');
          expect(p.alpha, `step ${step} f${o} ${p.name}`).toBeCloseTo(MASS_ALPHA[step], 9);
        }
      }
      expect(n, `step ${step}`).toBeGreaterThan(10);
    }
  });
});

describe('the face cut (judge round 2: the box fallback cut his back and shirt)', () => {
  it('comes from the face mask only, with a hard edge, and is null on a frame without one', () => {
    const cut = full().frameLayers(I + 15).faceCut;
    expect(cut).not.toBeNull();
    expect(new Set(cut!.alpha)).toEqual(new Set([0, 255]));
    const sc = sceneClip();
    const none = createImpactScene(sc.effect, { ...sc.clip, faceMask: () => null }, { tier: 'full', make: nodeScratch });
    for (const o of [I + 9, I + 15, I + 30, I + 44]) expect(none.frameLayers(o).faceCut, `f${o}`).toBeNull();
  });
});

describe('the glow', () => {
  it("lays the floods' wide glow in the floods slot, under him and the masses (judge round 2: over the cluster it went violet)", () => {
    let n = 0;
    for (let o = I + 9; o <= I + 45; o++) {
      const L = full().frameLayers(o);
      const glows = L.parts.filter((p) => p.name === 'floodGlow');
      for (const p of glows) expect(p.slot, `f${o}`).toBe('floods');
      if (L.parts.some((p) => p.name === 'flood')) {
        n++;
        expect(glows, `f${o}`).toHaveLength(1);
      }
    }
    expect(n).toBeGreaterThan(3);
  });

  it('lights nothing within 0.6 U of P from the limbs while the burst shows (judge round 2: a ball of light at P on f93–94)', () => {
    const s = full();
    const ctx = s.context!;
    const P = ctx.frame.P;
    const R = 0.6 * ctx.frame.U;
    let calls = 0;
    let frames = 0;
    for (let o = I + 9; o <= I + 15; o++) {
      const L = s.frameLayers(o);
      const t = L.limbs?.t;
      if (t === undefined || !((massClock(ctx, t)?.g ?? Infinity) <= 1)) continue;
      expect(L.parts.some((p) => p.name === 'fire'), `f${o}`).toBe(true);
      frames++;
      const layer = s.runJob(`limb:${s.sceneId}:${t}`);
      for (const part of layer.parts) {
        for (const g of part.glow ?? []) {
          for (const c of g.calls) {
            calls++;
            for (const q of pointsOf(c)) expect(Math.hypot(q[0] - P[0], q[1] - P[1]), `f${o} t${t} ${g.id === null ? 'steady' : `arc ${g.id}`} ${c.op}`).toBeGreaterThan(R);
          }
        }
      }
    }
    expect(frames).toBeGreaterThanOrEqual(4); // g0 and g1: f93–97
    expect(calls).toBeGreaterThan(0);
  });

  it("holds the limbs' arcs to half the ribbons' glow over j 9–31 (judge round 2: the arcs outshone them)", () => {
    let both = 0;
    for (let o = I + 9; o <= I + 31; o++) {
      const g = full().frameLayers(o).gains;
      for (const [k, v] of Object.entries(g)) {
        if (!k.startsWith('arc:')) continue;
        if (g.ribbons !== undefined) {
          both++;
          expect(v, `f${o} ${k}`).toBeLessThanOrEqual(0.5 * g.ribbons + 1e-12);
        } else expect(v, `f${o} ${k}`).toBeLessThanOrEqual(0.5);
      }
    }
    expect(both).toBeGreaterThan(5);
  });

  it('lights a limb part behind him only off his mask (judge round 2: the arcs behind his head lit a cyan cap on f55–57)', () => {
    const s = full();
    const { clip } = s.setup;
    let checked = 0;
    for (let o = 40; o <= 70; o++) {
      const t = s.frameLayers(o).limbs?.t;
      if (t === undefined) continue;
      const mask = clip.personMask(t);
      if (!mask) continue;
      const scale = mask.width / s.width;
      const behind = s.tubesAt(t).every((tube) => tube.sections.every((sec) => !sec.front));
      if (!behind) continue;
      const front = s.runJob(`limb:${s.sceneId}:${t}`).parts.find((p) => p.slot === 'limbsFront');
      for (const g of front?.glow ?? []) {
        if (g.id === null) continue; // the limb's own glow: render/limb.ts's rule, tested there
        for (const c of g.calls) {
          for (const q of pointsOf(c)) {
            checked++;
            expect(onMask(mask, scale, q[0], q[1]), `f${o} t${t} arc ${g.id}`).toBe(false);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("Reduce flashing's masses at the plate's luminance (judge round 2: faded to 0.3, the destruction was gone)", () => {
  // A plate of grey v with one mass colour laid over its middle by lumaPart and lumaBlit.
  const laid = (v: number, hex: string, alpha = 1) => {
    const c = createCanvas(40, 20);
    const ctx = c.getContext('2d');
    ctx.fillStyle = `rgb(${v}, ${v}, ${v})`;
    ctx.fillRect(0, 0, 40, 20);
    const part = lumaPart(nodeScratch, 'k:luma', 'masses', 'cluster', { x0: 10, y0: 5, x1: 30, y1: 15 }, (x) => {
      x.fillStyle = hex;
      x.fillRect(10, 5, 20, 10);
    });
    lumaBlit(part, alpha).draw(ctx as never);
    return { inside: ctx.getImageData(20, 10, 1, 1).data, outside: ctx.getImageData(3, 3, 1, 1).data };
  };
  // The burst's yellows and orange, the cluster's browns and smoke, the ink, the palette's red, the dust.
  const COLOURS = ['#fffc7c', '#fefc07', '#fefeb1', '#ff8a00', '#e8203a', '#642c13', '#8b4a1f', '#3a2a2a', '#16141a', '#8a8070'];

  it('moves L by under 0.1 on a plate of any grey, the burst yellows on light ones included, and never makes a saturated red', () => {
    // A multiply shade took up to 0.2 off a light plate along the ink, and the
    // 'color' blend lifted a saturated yellow by up to 0.15 at L 0.7.
    for (const v of [12, 40, 80, 128, 170, 200, 220, 235, 250, 255]) {
      for (const hex of [...COLOURS, '#ffff00', '#ffe000']) {
        for (const alpha of [1, 0.6]) {
          const { inside, outside } = laid(v, hex, alpha);
          expect([...outside.slice(0, 3)], `${hex} on ${v}`).toEqual([v, v, v]);
          expect(Math.abs(lum(inside) - lum([v, v, v])), `${hex} on ${v} at ${alpha}`).toBeLessThan(0.1);
          expect(saturatedRed(inside), `${hex} on ${v} at ${alpha}: ${[...inside.slice(0, 3)]}`).toBe(false);
        }
      }
    }
  });

  it('shows their ink by the shade: the darkest ink lands below a mid or light plate', () => {
    for (const v of [128, 170, 200]) {
      for (const hex of ['#16141a', '#3a2a2a']) {
        const { inside } = laid(v, hex);
        expect(lum(inside), `${hex} on ${v}: ${[...inside.slice(0, 3)]}`).toBeLessThan(lum([v, v, v]) - 0.025);
      }
    }
  });

  it('still shows the masses: their hue on the plate', () => {
    for (const v of [80, 128, 170]) {
      for (const hex of ['#fffc7c', '#ff8a00', '#642c13', '#8b4a1f']) {
        const { inside } = laid(v, hex);
        expect(inside[0] - inside[2], `${hex} on ${v}: ${[...inside.slice(0, 3)]}`).toBeGreaterThan(20);
      }
    }
  });

  it("covers the plate, opaque, at its luminance averaged over a cell: none of its detail shows through (judge round 2: his shirt's print read through the smoke)", () => {
    // A plate of 2 px stripes (the print), through the preview's ×2 view.
    const c = createCanvas(160, 80);
    const ctx = c.getContext('2d');
    for (let x = 0; x < 160; x += 2) {
      ctx.fillStyle = (x / 2) % 2 ? '#909090' : '#606060';
      ctx.fillRect(x, 0, 2, 80);
    }
    const plateMean = (lum([0x90, 0x90, 0x90]) + lum([0x60, 0x60, 0x60])) / 2;
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    for (const hex of ['#642c13', '#fffc7c']) {
      const part = lumaPart(nodeScratch, 'k:luma', 'masses', 'cluster', { x0: 10, y0: 5, x1: 70, y1: 35 }, (x) => {
        x.fillStyle = hex;
        x.fillRect(10, 5, 60, 30);
      });
      lumaBlit(part, 1, nodeScratch, 6).draw(ctx as never);
      // Device px 40..120 × 30..50 lie well inside the box (20..140 × 10..70).
      const px = ctx.getImageData(40, 30, 80, 20).data;
      const Ls: number[] = [];
      for (let i = 0; i < px.length; i += 4) Ls.push(lum(px.subarray(i, i + 3)));
      const mean = Ls.reduce((a, b) => a + b, 0) / Ls.length;
      expect(Math.max(...Ls) - Math.min(...Ls), `${hex}: the stripes show through`).toBeLessThan(0.02);
      expect(Math.abs(mean - plateMean), hex).toBeLessThan(0.1);
      expect(px[0] - px[2], `${hex}: its hue`).toBeGreaterThan(20);
      expect(saturatedRed(px), hex).toBe(false);
      // Outside the box the stripes are untouched.
      expect([...ctx.getImageData(4, 4, 1, 1).data.slice(0, 3)]).toEqual([0x60, 0x60, 0x60]);
      expect([...ctx.getImageData(150, 4, 1, 1).data.slice(0, 3)]).toEqual([0x90, 0x90, 0x90]);
    }
  });
});

describe('the cluster over him, uncut (judge round 2: his shirt showed through the smoke on f107–113)', () => {
  it('shows no plate and none of him inside the cluster on j 15–31 under full flashing', () => {
    const s = full();
    const ectx = { ...s.context!, dps: 12 };
    const [W, H] = [s.width, s.height];
    const video = (fill: string) => {
      const c = createCanvas(W, H);
      const x = c.getContext('2d');
      x.fillStyle = fill;
      x.fillRect(0, 0, W, H);
      return c;
    };
    const render = (v: unknown, o: number) => {
      const c = createCanvas(W, H);
      s.render(c.getContext('2d') as never, v, o);
      return c.getContext('2d').getImageData(0, 0, W, H).data;
    };
    const [black, white] = [video('#000000'), video('#ffffff')];
    let inside = 0;
    for (const o of [I + 15, I + 21, I + 27, I + 31]) {
      const cd = clusterShapes(ectx, s.clipOf(o));
      expect(cd, `f${o}`).not.toBeNull();
      const m = createCanvas(W, H);
      paint(m.getContext('2d') as never, cd, true);
      const cover = m.getContext('2d').getImageData(0, 0, W, H).data;
      // Opaque cluster paint 3 px all round, frame px.
      const solid = (x: number, y: number) => {
        for (let dy = -3; dy <= 3; dy++) {
          for (let dx = -3; dx <= 3; dx++) {
            const [u, v] = [Math.round(x) + dx, Math.round(y) + dy];
            if (u < 0 || v < 0 || u >= W || v >= H || cover[(v * W + u) * 4 + 3] < 255) return false;
          }
        }
        return true;
      };
      const cam = s.frameLayers(o).camera ?? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
      expect([cam.b, cam.c]).toEqual([0, 0]);
      const [a, b] = [render(black, o), render(white, o)];
      let differ = 0;
      for (let y = 0; y < H; y += 2) {
        for (let x = 0; x < W; x += 2) {
          if (!solid((x + 0.5 - cam.e) / cam.a - 0.5, (y + 0.5 - cam.f) / cam.d - 0.5)) continue;
          inside++;
          const i = (y * W + x) * 4;
          if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > 2) differ++;
        }
      }
      expect(differ, `f${o}: px inside the cluster that show the video`).toBe(0);
    }
    expect(inside).toBeGreaterThan(2000);
  });
});
