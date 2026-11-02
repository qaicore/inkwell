// Round 3, fixer F5: the aftermath lightning and floods against k21–31
// (motion:5, reference:14, reference:15, asks:5, technical:5). On the hero at
// the app's 1080×608 (P (530, 597), the hero's floor block), as
// aftermath-energy.test.ts: the steady (Reduce flashing) lightning is one draw
// held across every hold group with a flat gain; the ribbons are drawn in the
// measured set with a hot core middle that composites #7efefd–#acfcfd under
// the glow, and lean off their path; the floods' edges are torn along the
// edge's normal with slanted teeth, and A10–11's insides are pale; the A5–6
// flash has no window hole.
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import type { Palette, Vec2 } from '../../src/impact/contracts.ts';
import { kr, zoomAt } from '../../src/impact/clock.ts';
import { strikeFrame } from '../../src/impact/floor.ts';
import { DISCHARGE, hueDelta, mixHex, roles, toOklch } from '../../src/impact/palette.ts';
import { rng } from '../../src/impact/rng.ts';
import type { BrushTarget } from '../../src/render/glow.ts';
import { nodeScratch } from '../../src/render/headless.ts';
import { createGlow } from '../../src/render/light.ts';
import type { Mask } from '../../src/track/tracking.ts';
import * as lightning from '../../src/impact/aftermath/lightning.ts';
import * as washes from '../../src/impact/aftermath/washes.ts';
import { HERO, HERO_CRACKS } from './helpers/impact-drawings.ts';

const TEST: Palette = ['#e8203a', '#f4f1ea', '#16141a']; // the app's default: its red leaves the discharge set unturned
const FLOOR = { ratio: 0.763, majorDeg: 2.6, up: [0.04, -1.0] as [number, number], persp: 0.68 };
const W = 1080;
const H = 608;
const K = W / HERO.width;
const P: Vec2 = [HERO.P[0] * K, HERO.P[1] * K];
const SEEDS = [84, 1, 7, 15, 23, 42];

function scene(o: { seed?: number; seconds?: number; flash?: 'full' | 'safe'; palette?: Palette; mask?: Mask | null } = {}): washes.EnergyContext {
  const seed = o.seed ?? HERO.seed;
  const seconds = o.seconds ?? 1.5;
  return {
    I: HERO.I,
    jEnd: Math.round(30 * seconds),
    seed,
    frame: strikeFrame(P, [HERO.d[0], HERO.d[1]], Math.min(W, H), 0.63, W, H, seed),
    floor: FLOOR,
    width: W,
    height: H,
    palette: o.palette ?? TEST,
    flash: o.flash ?? 'full',
    posters: true,
    crackEase: 'out',
    aftermath: { seconds, scale: 1, scarSeconds: 3 },
    tier: 'full',
    personMask: () => o.mask ?? null,
    faceMask: () => null,
    cracks: [],
  };
}
const cracks = (): Vec2[][] => HERO_CRACKS.map((c) => c.points.map((p): Vec2 => [p[0] * K, p[1] * K]));
// The full-mode sources: a dome over P (the cluster outline), the cracks, and two limbs landing on P.
function sources(ictx: washes.EnergyContext): Vec2[][] {
  const fr = washes.energyFrame(ictx);
  const dome = Array.from({ length: 49 }, (_, i): Vec2 => {
    const th = (Math.PI * i) / 48;
    return washes.onFloor(fr, fr.U, 0.05 + 0.705 * Math.sin(th), -0.5 + 0.97 * ((1 - Math.cos(th)) / 2));
  });
  const limb = (from: Vec2, bend: number) =>
    Array.from({ length: 24 }, (_, i): Vec2 => {
      const s = i / 23;
      return [from[0] + (P[0] - from[0]) * s + bend * Math.sin(Math.PI * s), from[1] + (P[1] - from[1]) * s];
    });
  return [dome, ...cracks(), limb([P[0] + 170, P[1] - 340], 40), limb([P[0] + 110, P[1] - 370], -50)];
}
function canvas(fill?: string): BrushTarget {
  const ctx = createCanvas(W, H).getContext('2d');
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, W, H);
  }
  return ctx as unknown as BrushTarget;
}
const median = (v: readonly number[]) => {
  const s = Float64Array.from(v).sort();
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
// The distance from p to the polyline (closed when `closed`).
function toPolyline(p: Vec2, poly: readonly Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
  }
  return best;
}

// ---- Steady lightning (technical:5) -----------------------------------------------------------

describe('steady lightning (Reduce flashing; technical:5)', () => {
  it('is one draw for the whole of the bolts: the same ribbons and bolts on every frame of every hold group, the lead band, no cores, and one key wherever its gain and boost hold', () => {
    for (const seconds of [1.5, 3]) {
      for (const seed of SEEDS) {
        const ictx = scene({ seed, seconds, flash: 'safe' });
        const src = cracks(); // gentle mode keeps to the still sources
        const first = lightning.ribbons(ictx, 13, src, { steady: true })!;
        const at0 = `${seconds} s seed ${seed}`;
        expect(first, at0).not.toBeNull();
        expect(first.band, at0).toBe('lead');
        const groups = new Map<number, Set<string>>();
        const keys = new Map<string, string>(); // gain:boost → key
        for (let f = ictx.I + 13; f < ictx.I + ictx.jEnd - 5; f++) {
          const j = f - ictx.I;
          const at = `${at0} j${j}`;
          const plan = lightning.ribbons(ictx, j, src, { steady: true })!;
          expect(plan.band, at).toBe('lead');
          expect(plan.ribbons, at).toEqual(first.ribbons);
          expect(plan.bolts, at).toEqual(first.bolts);
          expect(plan.area, at).toBe(first.area);
          expect(plan.ribbons.every((r) => r.core.every((c) => c === 0)), at).toBe(true);
          const look = `${plan.gain}:${plan.boost}`;
          if (!keys.has(look)) keys.set(look, plan.key);
          expect(plan.key, at).toBe(keys.get(look));
          // Every frame of a hold group before the fade shows the same plan, key and all.
          const g = washes.groupClock(ictx, f)!.g;
          if (plan.gain === 1 && plan.boost === 1) {
            if (!groups.has(g)) groups.set(g, new Set());
            groups.get(g)!.add(plan.key);
          }
        }
        expect(groups.size, at0).toBeGreaterThanOrEqual(4);
        for (const [g, set] of groups) expect(set.size, `${at0} g${g}`).toBe(1);
        // A plateau's frames across groups share one key too, so the scene draws one part.
        expect(new Set([...groups.values()].flatMap((s) => [...s])).size, at0).toBe(1);
      }
    }
  });

  it('holds boltGain flat at 1 to the fade, then lets it fall to 0 at J_end − 5 without the flicker back to full', () => {
    for (const seconds of [1.5, 3]) {
      const ictx = scene({ seconds, flash: 'safe' });
      const end = ictx.jEnd;
      let prev = 1;
      let fell = false;
      for (let j = 13; j <= end; j++) {
        const g = lightning.boltGain(ictx, j, true);
        const at = `${seconds} s j${j}`;
        expect(g, at).toBeLessThanOrEqual(prev);
        if (washes.krSpan(j).last <= end - 14) expect(g, at).toBe(1);
        if (g < 1) fell = true;
        if (fell) expect(g, at).toBeLessThan(1); // once it falls it never comes back
        prev = g;
      }
      expect(lightning.boltGain(ictx, end - 5, true)).toBe(0);
      expect(lightning.boltGain(ictx, end - 7, true)).toBeLessThan(0.25);
      expect(lightning.boltGain(ictx, end - 7, false)).toBe(1); // full flashing's last flicker, for contrast
      // The plans carry it: each frame's gain is the steady boltGain.
      for (let j = 13; j < end - 5; j++) expect(lightning.ribbons(ictx, j, cracks(), { steady: true })!.gain, `${seconds} s j${j}`).toBe(lightning.boltGain(ictx, j, true));
    }
  });
});

// ---- Ribbons (reference:14, motion:5) ---------------------------------------------------------

describe('ribbons (reference:14)', () => {
  it("paints k21–31's measured set: edge #00017b, band #2c5cfc, deep #233cfd, core #22fded with a hot middle, pale #abfdf4", () => {
    expect(lightning.LIGHTNING_TONES).toEqual({ edge: '#00017b', band: '#2c5cfc', deep: '#233cfd', core: '#22fded', pale: '#abfdf4' });
    const ictx = scene();
    const plan = lightning.ribbons(ictx, 24, sources(ictx))!;
    expect(plan.tones.hot).toBe(mixHex('#22fded', '#ffffff', 0.45));
    // Painted: the band, the deeper strands, the core and its middle are all on the canvas.
    const ctx = canvas();
    lightning.paintLightning(ctx, nodeScratch, plan, W, H);
    const d = ctx.getImageData(0, 0, W, H).data;
    const seen = new Map<string, number>();
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] !== 255) continue;
      const hex = '#' + [d[i], d[i + 1], d[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('');
      seen.set(hex, (seen.get(hex) ?? 0) + 1);
    }
    for (const tone of [plan.tones.edge, plan.tones.band, plan.tones.core, plan.tones.hot]) expect(seen.get(tone) ?? 0, tone).toBeGreaterThan(200);
  });

  it('composites the core #7efefd–#acfcfd under the glow (the hot middle in the near glow), on a grey and a fire plate, early to late', () => {
    for (const plate of ['#585858', '#c06030']) {
      for (const seed of [84, 1, 7]) {
        const ictx = scene({ seed });
        const src = sources(ictx);
        for (const j of [18, 20, 24, 27, 33]) {
          const at = `${plate} seed ${seed} j${j} A${kr(j) - 14}`;
          const plan = lightning.ribbons(ictx, j, src)!;
          const ctx = canvas(plate);
          lightning.paintLightning(ctx, nodeScratch, plan, W, H);
          const glow = createGlow(nodeScratch, W, H, { main: TEST[0] });
          lightning.emitLightning(glow, plan);
          glow.composite(ctx);
          const d = ctx.getImageData(0, 0, W, H).data;
          const mask = canvas();
          washes.fillUnion(mask, lightning.lightningShapes(plan).core, '#ffffff');
          const m = mask.getImageData(0, 0, W, H).data;
          // Inside the drawn cores, and every bright cyan pixel of the frame
          // (G ≥ 0xe8, B ≥ 0xe0, not white): what a judge reads off the render,
          // the cores' halo spill with them. CORE_GLOW 1.5 read #5b–#5e red here.
          const ch: number[][] = [[], [], []];
          const bright: number[][] = [[], [], []];
          for (let i = 0; i < W * H; i++) {
            if (m[4 * i + 3] === 255) for (let k = 0; k < 3; k++) ch[k].push(d[4 * i + k]);
            if (d[4 * i + 1] >= 0xe8 && d[4 * i + 2] >= 0xe0 && d[4 * i] <= 0xe0) for (let k = 0; k < 3; k++) bright[k].push(d[4 * i + k]);
          }
          expect(ch[0].length, at).toBeGreaterThan(300);
          for (const [name, px] of [['cores', ch], ['bright cyan', bright]] as const) {
            const [r, g, b] = px.map(median);
            expect(r, `${at} ${name}`).toBeGreaterThanOrEqual(0x7e);
            expect(r, `${at} ${name}`).toBeLessThanOrEqual(0xac);
            expect(g, `${at} ${name}`).toBeGreaterThanOrEqual(0xfc);
            expect(b, `${at} ${name}`).toBeGreaterThanOrEqual(0xfc);
          }
        }
      }
    }
  });

  it("lifts the bands toward k21–31's lavender with the glow: of the blue pixels, 40–62 % deep (HSV s ≥ 0.7) on grey, beige and fire plates, against 84–100 % unglowed", () => {
    // Blue: HSV hue 200–260°, s ≥ 0.35, v ≥ 0.45, over the plans of three
    // seeds early to late. k21–31 read 20–49 % deep, round 2's hero 2–19 %.
    // These plates have none of the scene's other glows (fire, limbs) over
    // the ribbons, which take the hero another 15–35 points down: at
    // BAND_GLOW 0.4 these read 45–58 % and the hero 22–41 % on 7 of its 13
    // ribbon frames without a flood (54–60 % on 4, 10–13 % on f117–f118);
    // at 0.6, 26–35 % here and 6–20 % on most of those; glowing as bodies
    // (a saturated azure halo), 36–66 % in the hero.
    const deepShare = (plate: string, glowed: boolean) => {
      let blue = 0;
      let deep = 0;
      for (const seed of [84, 1, 7]) {
        const ictx = scene({ seed });
        const src = sources(ictx);
        for (const j of [18, 20, 24, 27, 29, 33]) {
          const plan = lightning.ribbons(ictx, j, src)!;
          const ctx = canvas(plate);
          lightning.paintLightning(ctx, nodeScratch, plan, W, H);
          if (glowed) {
            const glow = createGlow(nodeScratch, W, H, { main: TEST[0] });
            lightning.emitLightning(glow, plan);
            glow.composite(ctx);
          }
          const d = ctx.getImageData(0, 0, W, H).data;
          for (let i = 0; i < d.length; i += 4) {
            const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
            const mx = Math.max(r, g, b);
            const s = mx > 0 ? (mx - Math.min(r, g, b)) / mx : 0;
            if (mx !== b || s < 0.35 || mx < 0.45 * 255) continue;
            const h = 60 * ((r - g) / (mx - Math.min(r, g, b)) + 4); // b is the largest
            if (h < 200 || h > 260) continue;
            blue++;
            if (s >= 0.7) deep++;
          }
        }
      }
      return { blue, share: deep / blue };
    };
    for (const plate of ['#585858', '#8a7a68', '#c06030']) {
      const lit = deepShare(plate, true);
      const bare = deepShare(plate, false);
      expect(lit.blue, plate).toBeGreaterThan(20000);
      expect(lit.share, plate).toBeGreaterThanOrEqual(0.4);
      expect(lit.share, plate).toBeLessThanOrEqual(0.62);
      expect(bare.share - lit.share, plate).toBeGreaterThanOrEqual(0.2);
    }
  });

  it('leans a cored ribbon off its path, one side wider than the other by 30 % at the most, the total width kept', () => {
    let leaning = 0;
    let all = 0;
    for (const seed of SEEDS.slice(0, 3)) {
      const ictx = scene({ seed });
      const src = sources(ictx);
      for (const j of [18, 22, 27, 33]) {
        for (const r of lightning.ribbons(ictx, j, src)!.ribbons) {
          if (r.pools === 0) continue;
          all++;
          const lean = r.left.map((l, i) => (l - r.right[i]) / (l + r.right[i]));
          // The lumps are each side's own, ± EDGE_WOBBLE; the lean is shared and slow.
          expect(Math.max(...lean.map(Math.abs)), `seed ${seed} j${j}`).toBeLessThanOrEqual(0.3 + lightning.EDGE_WOBBLE + 1e-9);
          if (median(lean.map(Math.abs)) >= 0.08) leaning++;
        }
      }
    }
    expect(all).toBeGreaterThan(10);
    expect(leaning / all).toBeGreaterThan(0.5);
  });

  it('meets the area budget by count and length, never width: the drawn medians stay in the band, early 0.021–0.024 S and from A9 0.042–0.073 S', () => {
    let cut = 0;
    for (const seed of SEEDS) {
      const ictx = scene({ seed });
      const src = sources(ictx);
      for (const j of [18, 19, 20, 24, 27, 33, 37]) {
        const plan = lightning.ribbons(ictx, j, src)!;
        const at = `seed ${seed} j${j} ${plan.band}`;
        const [lo, hi] = lightning.RIBBON_BANDS[plan.band].median;
        for (const r of plan.ribbons) {
          const k = r.main ? 1 : 0.6;
          expect(r.median / ictx.frame.S, at).toBeGreaterThanOrEqual(k * lo - 1e-9);
          expect(r.median / ictx.frame.S, at).toBeLessThanOrEqual(k * hi + 1e-9);
        }
        expect(plan.area, at).toBeLessThanOrEqual(plan.budget + 1e-6);
        if (plan.ribbons.length < plan.planned) cut++;
      }
    }
    expect(cut).toBeGreaterThan(20); // at the hero's U, from A7 on
  });
});

// ---- Floods (reference:15) --------------------------------------------------------------------

describe('floods (reference:15)', () => {
  it('tears the edge along its normal: a tooth every 0.02–0.08 U, its tip 0.01–0.04 U deeper than its base, every piece slanted (no axis-aligned steps)', () => {
    const U = 384;
    let teeth = 0;
    for (const seed of SEEDS) {
      const e = washes.floodEdge(rng(seed, 'test-flood'), -1.5 * U, 1.5 * U, U);
      const at = `seed ${seed}`;
      for (let i = 1; i < e.s.length; i++) {
        const ds = e.s[i] - e.s[i - 1];
        expect(ds, `${at} sample ${i}`).toBeGreaterThan(0); // no step across the edge
        // and no flat run along it: the tear's least slope is a quarter of a 0.007 U fall over 0.036 U
        expect(Math.abs(e.notch[i] - e.notch[i - 1]) / ds, `${at} sample ${i}`).toBeGreaterThan(0.04);
      }
      // Its corners are the knots: the tips (local maxima) and bases (minima).
      const ext: { s: number; v: number; tip: boolean }[] = [];
      for (let i = 1; i < e.s.length - 1; i++) {
        const [a, b, c] = [e.notch[i - 1], e.notch[i], e.notch[i + 1]];
        if (b > a && b > c) ext.push({ s: e.s[i], v: b, tip: true });
        if (b < a && b < c) ext.push({ s: e.s[i], v: b, tip: false });
      }
      const bases = ext.filter((x) => !x.tip);
      for (const b of bases) expect(b.v / U, at).toBeLessThanOrEqual(washes.NOTCH.shallow + 1e-9);
      for (let k = 1; k < bases.length; k++) {
        const gap = (bases[k].s - bases[k - 1].s) / U;
        expect(gap, at).toBeGreaterThanOrEqual(washes.NOTCH.spacing[0] - 1e-9);
        expect(gap, at).toBeLessThanOrEqual(washes.NOTCH.spacing[1] + 1e-9);
      }
      for (let k = 1; k < ext.length; k++) {
        if (!ext[k].tip || ext[k - 1].tip) continue;
        teeth++;
        const depth = (ext[k].v - ext[k - 1].v) / U;
        expect(depth, at).toBeGreaterThanOrEqual(washes.NOTCH.depth[0] - 1e-9);
        expect(depth, at).toBeLessThanOrEqual(washes.NOTCH.depth[1] + 1e-9);
      }
      // The band: never under 0.008 U; between its lobes it waves inside 0.008–0.027 U.
      expect(Math.min(...e.band) / U, at).toBeGreaterThanOrEqual(washes.FLOOD_BAND[0] - 1e-9);
      const inside = e.band.filter((b) => b / U <= washes.FLOOD_BAND[1] + 1e-9).map((b) => b / U);
      expect(inside.length / e.band.length, at).toBeGreaterThan(0.2);
      expect(Math.max(...inside) - Math.min(...inside), at).toBeGreaterThan(0.01);
    }
    expect(teeth).toBeGreaterThan(6 * 40);
  });

  it('keeps A10–11’s saturated core within 0.03 U of the field edge and paints the inside pale, mix(core, white, 0.52–0.58)', () => {
    const ictx = scene();
    const U = washes.energyFrame(ictx).U;
    for (const j of [22, 23]) {
      const d = washes.floodShapes(ictx, j)!;
      expect(d.A).toBe(j === 22 ? 10 : 11);
      const core = d.layers[4];
      const pale = d.layers.at(-1)!;
      expect(core.color).toBe(washes.ENERGY_TONES.core);
      expect(pale.color >= mixHex('#22fded', '#ffffff', washes.RIM_PALE[0]) && pale.color <= mixHex('#22fded', '#ffffff', washes.RIM_PALE[1]), `j${j} ${pale.color}`).toBe(true);
      expect(washes.RIM_PALE[0] >= 0.5 && washes.RIM_PALE[1] <= 0.7).toBe(true); // reference:15: mix 0.5–0.7
      let checked = 0;
      for (const p of pale.points) {
        if (p[0] <= 1 || p[0] >= W - 1 || p[1] <= 1 || p[1] >= H - 1) continue; // the frame's own edge
        checked++;
        expect(toPolyline(p, core.points) / U, `j${j}`).toBeLessThanOrEqual(washes.RIM_CORE[1] + 0.002);
      }
      expect(checked, `j${j}`).toBeGreaterThan(20);
      // Painted, the pale inside outweighs the saturated rim many times over.
      const ctx = canvas();
      washes.paintFlood(ctx, nodeScratch, d, W, H);
      const px = ctx.getImageData(0, 0, W, H).data;
      const count = (hex: string) => {
        const [r, g, b] = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));
        let n = 0;
        for (let i = 0; i < px.length; i += 4) if (px[i] === r && px[i + 1] === g && px[i + 2] === b && px[i + 3] === 255) n++;
        return n;
      };
      expect(count(pale.color), `j${j}`).toBeGreaterThan(5 * count(core.color));
    }
  });

  it("turns the measured set with the palette's discharge hue, and leaves it for the default red", () => {
    expect(washes.energyTones(TEST)).toEqual(washes.ENERGY_TONES);
    const violet: Palette = ['#8a3ad9', '#f4f1ea', '#16141a'];
    const turn = hueDelta(toOklch(DISCHARGE.band).h, toOklch(roles(violet).discharge.band).h);
    expect(Math.abs(turn)).toBeGreaterThan(10);
    const turned = washes.energyTones(violet);
    for (const k of Object.keys(washes.ENERGY_TONES) as (keyof washes.EnergyTones)[]) {
      const a = toOklch(washes.ENERGY_TONES[k]);
      const b = toOklch(turned[k]);
      expect(Math.abs(b.L - a.L), k).toBeLessThan(0.03);
      if (a.C > 0.05) expect(Math.abs(hueDelta(a.h + turn, b.h)), k).toBeLessThan(3);
    }
  });
});

// ---- The A5–6 flash (asks:5, motion:5) ----------------------------------------------------------

describe('the A5–6 flash (asks:5)', () => {
  it("covers round 2's window (t +0.59..+0.75, n 0.34..0.66): no hole there, so no black oval over another room's dark wall", () => {
    let checked = 0;
    for (const seed of SEEDS) {
      const ictx = scene({ seed });
      const fr = washes.energyFrame(ictx);
      for (let f = ictx.I + 9; f < ictx.I + ictx.jEnd; f++) {
        const fl = washes.flashShapes(ictx, f);
        if (!fl) continue;
        const { start } = washes.drawingClock(ictx, f);
        const unit = fr.U * (washes.ZOOM_PEAK / zoomAt(start - ictx.I)); // as flashShapes scales its holes
        const win = washes.onFloor(fr, unit, 0.5, 0.67);
        const at = `seed ${seed} f${f}`;
        if (win[0] < 0 || win[0] >= W || win[1] < 0 || win[1] >= H) continue;
        const ctx = canvas();
        washes.paintFlash(ctx, nodeScratch, fl, null, W, H);
        const a = ctx.getImageData(Math.floor(win[0]), Math.floor(win[1]), 1, 1).data[3] / 255;
        expect(Math.abs(a - fl.alpha), at).toBeLessThan(0.01);
        expect(fl.holes.some((h) => h.length >= 3 && washes.inside(h, win)), at).toBe(false);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(SEEDS.length * 3); // A5–6's frames, on every seed
  });
});
