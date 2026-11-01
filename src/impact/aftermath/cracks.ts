// The impact strokes on the floor after contact (impact design §6, "Cracks";
// build plan WP8), behind the person. They are Qai's own strokes, so nothing
// here is random, and only their colour and opacity change after contact.
//   - Hidden before I. On j 0..8 the posters draw them on (WP6). With no
//     posters (frames.count 0) they are drawn on over 4 global drawings from
//     I (SPEC S2): ease.cracks((i + 1)/4) of each stroke from its P end on the
//     i-th, i = k(f) − k(I); on the hero 58 % at f84, 88 % on f85–87, 98 % on
//     f88–89 and full from f90 (at 8 dps, f84–86, f87–89, f90–93, full f94).
//   - Hot from j 9: a light core p1, and a glow of #fb6a04 at σ 0.01 S × (1 −
//     cool), painted in the layer as four stepped halos (the glow buffers'
//     narrowest σ is 0.019 S, too wide for it).
//   - Cooling: the core mixes from p1 toward the stroke's own colour (ink by
//     default) by cool = smoothstep(9, 30, j), per output frame: ink by j 30
//     (f114 on the hero, design §8), where a 2s step would still be at 99 %.
//   - The scar: a light rim of 0.0015 S in p1 on the far side (+n̂, up the
//     floor), painted under the core, so it shows as a sliver once the core is
//     ink (G10: ink alone reads at only 1.6–2.3:1 on his floor).
//   - The fade: 1 → 0 over 0.3 s (9 frames) from the later of
//     I + 30·scarSeconds and I + J_end, the frame it starts at still at 1.
// Each outline is the stroke's own brush at width/1080 (strokeOutline).
import type { Vec2 } from '../../types/effect.ts';
import type { Crack, GlowSink, ImpactContext } from '../contracts.ts';
import { strokeOutline } from '../../render/brush.ts';
import type { BrushTarget } from '../../render/glow.ts';
import { smoothstep } from '../../render/geometry.ts';
import { drawingIndex } from '../../motion/timing.ts';
import { ORANGE, mixHex, roles } from '../palette.ts';
import { MASS_DPS, massFrame, massKey, paint, type MassContext, type MassDrawing, type MassShape } from './fire.ts';

export const COOL = [9, 30] as const; // j: hot at the first, ink by the second
export const GLOW_SIGMA = 0.01; // S
export const RIM_WIDTH = 0.0015; // S
export const FADE_FRAMES = 9; // 0.3 s
// The stepped halos: how far each reaches past the core, in σ, and its opacity.
const HALOS: readonly (readonly [number, number])[] = [[2.4, 0.16], [1.6, 0.2], [0.9, 0.24], [0.35, 0.28]];

const ease = (kind: ImpactContext['crackEase'], t: number): number => {
  const x = Math.min(1, Math.max(0, t));
  switch (kind) {
    case 'linear':
      return x;
    case 'in':
      return x * x * x;
    case 'out':
      return 1 - (1 - x) ** 3;
    case 'hold-snap':
      return x >= 1 ? 1 : 0;
  }
};

// The first `fraction` of a stroke by length, from its P end.
function drawnOn(crack: Crack, fraction: number): { points: Vec2[]; pressure: number[] } {
  const rev = crack.fromP === 'end';
  const pts = rev ? [...crack.points].reverse() : crack.points;
  const pr = rev ? [...crack.pressure].reverse() : crack.pressure;
  const press = (i: number) => pr[Math.min(i, pr.length - 1)] ?? 1;
  if (fraction >= 1 || !crack.fromP) return { points: pts.map((p): Vec2 => [p[0], p[1]]), pressure: pts.map((_, i) => press(i)) };
  const along = [0];
  for (let i = 1; i < pts.length; i++) along.push(along[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const target = Math.max(0, fraction) * along[along.length - 1];
  const points: Vec2[] = [[pts[0][0], pts[0][1]]];
  const pressure = [press(0)];
  for (let i = 1; i < pts.length; i++) {
    if (along[i] < target) {
      points.push([pts[i][0], pts[i][1]]);
      pressure.push(press(i));
      continue;
    }
    const w = (target - along[i - 1]) / (along[i] - along[i - 1] || 1);
    points.push([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * w, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * w]);
    pressure.push(press(i - 1) + (press(i) - press(i - 1)) * w);
    break;
  }
  return { points, pressure };
}

// A closed outline pushed out by `d` px along its vertex normals.
function grown(loop: readonly Vec2[], d: number): Vec2[] {
  let area = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const out = area >= 0 ? 1 : -1; // with a positive shoelace sum, (t_y, −t_x) points out
  return loop.map((p, i): Vec2 => {
    const a = loop[(i + loop.length - 1) % loop.length];
    const b = loop[(i + 1) % loop.length];
    const tx = b[0] - a[0];
    const ty = b[1] - a[1];
    const len = Math.hypot(tx, ty) || 1;
    return [p[0] + (out * d * ty) / len, p[1] - (out * d * tx) / len];
  });
}

const outlines = new WeakMap<Crack, Map<string, Vec2[]>>();
function outlineOf(crack: Crack, fraction: number, scale: number): Vec2[] {
  let m = outlines.get(crack);
  if (!m) outlines.set(crack, (m = new Map()));
  const key = `${fraction.toFixed(4)}:${scale.toFixed(4)}`;
  let o = m.get(key);
  if (!o) {
    const cut = drawnOn(crack, fraction);
    o = fraction > 0 && cut.points.length >= 2 ? strokeOutline(cut.points, cut.pressure, crack.brush, scale) : [];
    if (m.size > 16) m.clear();
    m.set(key, o);
  }
  return o;
}

// The cracks' state on frame f: how much of each shows, how cool they are,
// and the fade; null where they don't show.
export function crackClock(ictx: MassContext, f: number): { fraction: number; cool: number; alpha: number } | null {
  const j = f - ictx.I;
  if (j < 0 || ictx.cracks.length === 0) return null;
  const fadeStart = ictx.I + Math.max(Math.round(30 * ictx.aftermath.scarSeconds), ictx.jEnd);
  const alpha = Math.min(1, Math.max(0, (fadeStart + FADE_FRAMES - f) / FADE_FRAMES));
  if (!(alpha > 0)) return null;
  if (ictx.posters) {
    if (j <= 8) return null; // the posters draw them on
    return { fraction: 1, cool: smoothstep(COOL[0], COOL[1], j), alpha };
  }
  // At 8 dps the 4th drawing from I starts as late as j 10, so this runs past j 8.
  const dps = ictx.dps ?? MASS_DPS;
  const i = drawingIndex(f, dps) - drawingIndex(ictx.I, dps);
  return { fraction: ease(ictx.crackEase, Math.min(1, (i + 1) / 4)), cool: smoothstep(COOL[0], COOL[1], j), alpha };
}

export interface CrackDrawing extends MassDrawing {
  cool: number;
  fraction: number;
  core: string[]; // per crack, the core's colour
}

export function shapes(ictx: MassContext, f: number): CrackDrawing | null {
  const clock = crackClock(ictx, f);
  if (!clock) return null;
  const { cool, fraction } = clock;
  const fr = massFrame(ictx);
  const S = ictx.frame.S;
  const scale = ictx.width / 1080;
  const tones = roles(ictx.palette);
  const sigma = GLOW_SIGMA * S;
  const rim: Vec2 = [fr.n[0] * RIM_WIDTH * S, fr.n[1] * RIM_WIDTH * S];
  const out: MassShape[] = [];
  const core: string[] = [];
  const drawn = ictx.cracks.map((c) => outlineOf(c, c.fromP ? fraction : 1, scale));
  // The glow under everything, then each crack's rim and core.
  if (cool < 1) {
    for (const [reach, a] of HALOS) {
      for (const o of drawn) if (o.length >= 3) out.push({ role: 'glow', points: grown(o, reach * sigma), color: ORANGE, alpha: a * (1 - cool), round: true });
    }
  }
  ictx.cracks.forEach((c, i) => {
    const o = drawn[i];
    const own = ictx.palette[c.color];
    const tone = mixHex(tones.paper, own, cool);
    core.push(tone);
    if (o.length < 3) return;
    out.push({ role: 'rim', points: o.map((p): Vec2 => [p[0] + rim[0], p[1] + rim[1]]), color: tones.paper, round: true });
    out.push({ role: 'core', points: o, color: tone, round: true });
  });
  const ids = ictx.cracks.map((c) => `${c.id}/${c.points.length}/${c.color}`).join(',');
  return {
    layer: 'behind',
    key: `cracks:${massKey(ictx)}:${ids}:${fraction.toFixed(4)}:${cool.toFixed(5)}`,
    alpha: clock.alpha,
    shapes: out,
    cool,
    fraction,
    core,
  };
}

export function draw(ctxBehind: BrushTarget, _ctxFront: BrushTarget, _sink: GlowSink, ictx: MassContext, f: number, opaque = false) {
  paint(ctxBehind, shapes(ictx, f), opaque);
}
