// Round 3, F1: the rope limbs on the hero clip itself (decisions 15, 17 and
// 18), with the real person masks (fixtures/probe/sam-person.json, cached
// SAM cutouts: no API call) and the stand-in pose (samples/hero/pose.json,
// git-ignored: skipped where it isn't). The lift is built as the scene builds
// it (scene.ts liftOf): the turn read from the pose and checked against the
// hand keys, the stand-in bend, the dummies with their scans, the
// limbs-first strike. The four limb strokes are the stand-in test drawing's
// (impact/test-drawings.json, start.strokes, rounded to 0.1 px), embedded
// here; the cracks are the hero's (helpers/impact-drawings.ts).
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/impact/contracts.ts';
import { limbStroke, readDrawings, skeletonPoints, standInPoints, turnPlan } from '../../scripts/impact-render.ts';
import { frameMasks } from '../../src/app/pipeline.ts';
import { momentsFromDrawings } from '../../src/impact/detect.ts';
import { liftBodies, unproject, type Body3D } from '../../src/lift/body.ts';
import { dummyBodies, insideDepth, type Dummy } from '../../src/lift/collide.ts';
import { animate3d, liftStroke, type Frame3D } from '../../src/lift/lift.ts';
import { bulgeSide, limbsFirst, strikeController } from '../../src/lift/strike.ts';
import { ROOT_FLARE } from '../../src/lift/tube.ts';
import { checkedTurn, turnKeys } from '../../src/lift/turn.ts';
import { EXAMPLE_TIMING, frameAt } from '../../src/motion/timing.ts';
import { masksFromCache, toFrameMask } from '../../src/sam/cache.ts';
import { trackPoses } from '../../src/track/anchor.ts';
import { goodStandIns, torsoBend } from '../../src/track/bend.ts';
import { anchorTransform, toPixels, torsoHeights } from '../../src/track/torso.ts';
import { HERO_CRACKS } from './helpers/impact-drawings.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MASKS = ROOT + 'fixtures/probe/sam-person.json';
const POSE = ROOT + 'samples/hero/pose.json';
const have = existsSync(MASKS) && existsSync(POSE);
const [W, H, FRAMES, FPS, SHOWN] = [1920, 1080, 254, 30, 160];
const R0 = 0.02 * H; // the tube's root radius, clip px

const LIMBS = [
  { id: 1, stiffness: 0.1, layer: 'behind', points: [[778, 300], [773.4, 284.7], [767.9, 269.7], [760.3, 255.6], [751.8, 242], [742.3, 229.1], [731.7, 217.2], [719.8, 206.5], [707.2, 196.7], [694.1, 187.5], [680.8, 178.6], [667.4, 169.9], [654.1, 160.9], [640.8, 152], [627.2, 143.6], [612.9, 136.4], [597.9, 130.9], [582.3, 127.4], [566.5, 125.3], [550.5, 124.4], [534.5, 124.4], [518.5, 125.2], [502.7, 127.6], [487.1, 131.3], [471.8, 135.9], [456.6, 140.7], [441.7, 146.7], [427.1, 153.3], [414.6, 159.1]], pressure: [0.8, 0.88, 0.94, 0.99, 1, 0.98, 0.96, 0.93, 0.9, 0.87, 0.84, 0.8, 0.77, 0.73, 0.69, 0.66, 0.62, 0.58, 0.54, 0.5, 0.45, 0.41, 0.37, 0.32, 0.28, 0.23, 0.19, 0.14, 0.1] },
  { id: 2, stiffness: 0.1, layer: 'behind', points: [[838, 300], [842.5, 284.6], [848.4, 269.8], [857.1, 256.4], [867.3, 244.1], [878.1, 232.3], [889.6, 221.1], [901.7, 210.7], [914.3, 200.9], [927.6, 192], [941.4, 183.9], [955.7, 176.6], [970.2, 170], [985, 163.7], [999.9, 157.9], [1014.9, 152.4], [1030, 147.3], [1045.3, 142.5], [1060.6, 137.9], [1076.2, 134.1], [1092, 131.8], [1108, 132.1], [1123.6, 135.2], [1138.9, 140], [1153.9, 145.7], [1168.8, 151.4], [1183.7, 157.1], [1198.4, 163.6], [1212.2, 170]], pressure: [0.8, 0.88, 0.94, 0.99, 1, 0.98, 0.96, 0.93, 0.9, 0.87, 0.84, 0.81, 0.77, 0.73, 0.7, 0.66, 0.62, 0.58, 0.54, 0.5, 0.46, 0.41, 0.37, 0.33, 0.28, 0.24, 0.19, 0.14, 0.1] },
  { id: 3, stiffness: 0.1, layer: 'behind', points: [[790, 345], [774, 346.1], [758.1, 347.9], [742.6, 351.6], [727.5, 356.8], [712.6, 362.6], [697.7, 368.5], [682.8, 374.3], [667.8, 379.8], [652.9, 385.8], [638.5, 392.7], [624.5, 400.4], [610.6, 408.4], [597.2, 417.1], [584.4, 426.7], [572.6, 437.5], [561.9, 449.4], [552, 462], [543.2, 475.3], [535.5, 489.3], [529.6, 504.2], [525.5, 519.7], [522.8, 535.4], [520.8, 551.3], [519.6, 567.2], [519.5, 583.2], [519.9, 599.2], [520.4, 615.2]], pressure: [0.8, 0.88, 0.95, 0.99, 1, 0.98, 0.95, 0.92, 0.89, 0.86, 0.83, 0.79, 0.75, 0.72, 0.68, 0.64, 0.6, 0.56, 0.51, 0.47, 0.43, 0.38, 0.34, 0.29, 0.24, 0.2, 0.15, 0.1] },
  { id: 4, stiffness: 0.1, layer: 'behind', points: [[828, 345], [844, 346.2], [859.9, 347.9], [875.6, 350.8], [891.2, 354.5], [906.6, 358.7], [921.8, 363.7], [936.6, 369.7], [951, 376.7], [965, 384.5], [978.6, 392.9], [991.8, 401.9], [1004.8, 411.3], [1017.2, 421.3], [1029.1, 432.1], [1040.1, 443.7], [1050.3, 456], [1059.9, 468.8], [1068.8, 482.1], [1077, 495.8], [1084.2, 510.1], [1090.2, 524.9], [1095, 540.2], [1098.5, 555.8], [1100.4, 571.7], [1101.2, 587.7], [1101.5, 603.7], [1101.7, 623.2]], pressure: [0.8, 0.88, 0.95, 0.99, 1, 0.98, 0.95, 0.93, 0.9, 0.86, 0.83, 0.79, 0.76, 0.72, 0.68, 0.64, 0.6, 0.56, 0.52, 0.48, 0.43, 0.39, 0.34, 0.3, 0.25, 0.21, 0.16, 0.1] },
];

interface Hero {
  frames: Frame3D[];
  bodies: Body3D[];
  dummies: Dummy[];
  P: [number, number];
  drawn: Map<number, number>; // limb id → its length as drawn over the torso height then
}

// `step`: the person masks' cell, px: 2 for the half-size preview, 1920/1080 for the 1080 export.
async function buildHero(step = 2): Promise<Hero> {
  const drawings = readDrawings({
    size: [W, H],
    seed: 84,
    start: { frame: 22, body: { hipsMid: [808.1, 452.1] }, strokes: LIMBS.map((l) => ({ ...l, color: 0 })) },
    end: { frame: 84, floor: { smallCircleRatioAtP: 0.763, smallCircleMajorAxisDeg: 2.6 }, strokes: HERO_CRACKS.map((c) => ({ id: c.id, points: c.points, pressure: c.pressure, width: c.width })) },
    moments: [{ kind: 'slam', ease: { cracks: 'out', ring: 'out', bursts: 'out' } }],
  });
  const person = await masksFromCache(JSON.parse(readFileSync(MASKS, 'utf8')), FRAMES);
  const raw = JSON.parse(readFileSync(POSE, 'utf8'));
  const stand = Array.from({ length: FRAMES }, (_, f) => standInPoints(raw[f]));
  const skeleton = Array.from({ length: FRAMES }, (_, f) => skeletonPoints(raw[f]));
  const f1 = drawings.start.frame;
  const moments = momentsFromDrawings({
    limbs: drawings.start.strokes.map((s) => ({ id: s.id, points: s.points })),
    f1,
    cracks: drawings.end.strokes.map((s) => ({ id: s.id, points: s.points })),
    fDrawn: drawings.end.frame,
    masks: person,
    S: Math.min(W, H),
    seed: drawings.seed,
  });
  const masks = person.map((m) => (m ? toFrameMask(m, W, H, step) : null));
  const mask = (f: number) => masks[f] ?? null;
  const units = torsoHeights(frameMasks(person, W, H), W, H);
  const unitNear = (f: number) => {
    for (let d = 0; d < units.length; d++) {
      const v = units[f - d] ?? units[f + d];
      if (v != null) return v;
    }
    return null;
  };
  const tracked = trackPoses(person, { frame: f1, xy: drawings.start.hips ?? [808.1, 452.1] }, 30);
  if (!tracked) throw new Error('the hero is not tracked');
  const poses = Array.from({ length: FRAMES }, (_, f) => tracked[Math.min(f, tracked.length - 1)]);
  const good = goodStandIns(stand, { mask, width: W, height: H });
  const plan = turnPlan(undefined);
  const read = turnKeys(null, stand, FPS, good);
  const keys = read.from === 'pose' && plan.check ? checkedTurn(read.keys, plan.check.known, plan.check.from, plan.check.to, plan.check.maxDeg ?? 45).keys : read.keys;
  const unit0 = unitNear(f1) ?? 0.25 * H;
  const bodies = liftBodies(poses, unit0, f1, keys, torsoBend(stand, f1, FPS, good));
  const at = anchorTransform(tracked[f1], unit0);
  const px = new Map<number, [number, number][]>();
  const drawn = new Map<number, number>();
  const strokes = drawings.start.strokes.map((l) => {
    const st = limbStroke(l, at);
    const points = st.views.front.points.map((p) => toPixels(at, p) as [number, number]);
    px.set(st.id, points);
    const lifted = liftStroke(st.id, points, [...st.views.front.pressure], bodies[f1], 'strand', st.stiffness, 1);
    drawn.set(st.id, lifted.length / bodies[f1].unit);
    return lifted;
  });
  const dummies = dummyBodies({ bodies, joints: skeleton, mask, width: W, height: H });
  const I = moments.snap.frame;
  const P: [number, number] = [moments.point.P[0], moments.point.P[1]];
  const control = strikeController({
    ...limbsFirst(I),
    P,
    d: [moments.strike.dir[0], moments.strike.dir[1]],
    limbs: strokes.map((s) => ({ id: s.id, side: bulgeSide(px.get(s.id)!) })),
    unit: bodies[I].unit,
    seed: drawings.seed ?? 84,
    dps: 12,
    dummies,
    radius: R0,
  });
  const frames = animate3d({ strokes, bodies, frames: SHOWN, dps: 12, boil: EXAMPLE_TIMING.boil, width: W, emerge: new Map(strokes.map((s) => [s.id, frameAt(moments.emerge.at)])), control, slam: { I, posters: true }, dummies, radius: R0 });
  return { frames, bodies, dummies, P, drawn };
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const mix = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const arc = (pts: readonly Vec3[]) => pts.slice(1).reduce((s, p, i) => s + len(sub(p, pts[i])), 0);
// The points of a centreline (eighths of each segment, and the last node)
// past its flared root as the tube draws it: from the arc length
// (1 + ROOT_FLARE)·R0 on, the segment that crosses it split there.
const FLARE = (1 + ROOT_FLARE) * R0;
const pastFlarePoints = (pts: readonly Vec3[]): { p: Vec3; at: string }[] => {
  const out: { p: Vec3; at: string }[] = [];
  let along = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const l = len(sub(pts[i + 1], pts[i]));
    if (along < FLARE && along + l >= FLARE) out.push({ p: mix(pts[i], pts[i + 1], (FLARE - along) / l), at: `${i}+flare` });
    for (let k = 0; k < 8; k++) if (along + (l * k) / 8 >= FLARE) out.push({ p: mix(pts[i], pts[i + 1], k / 8), at: `${i}+${k}/8` });
    along += l;
  }
  if (along >= FLARE) out.push({ p: pts[pts.length - 1], at: `${pts.length - 1}` });
  return out;
};
// The bend at each inner joint, degrees.
const bends = (pts: readonly Vec3[]) =>
  pts.slice(1, -1).map((p, i) => {
    const [u, v] = [sub(p, pts[i]), sub(pts[i + 2], p)];
    return (Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (len(u) * len(v) || 1)))) * 180) / Math.PI;
  });

describe.skipIf(!have)('rope limbs on the hero clip (decisions 15, 17, 18)', () => {
  let hero: Hero;
  beforeAll(async () => {
    hero = await buildHero();
  }, 180_000);
  const simOf = (f: number, id: number) => hero.frames[f].sim.find((s) => s.id === id)!.points;

  // From the flare's own arc length on, the segment that crosses it split
  // there (it went 38 px into him there), at the preview's mask cell and at
  // the export's (1920/1080 px: his scan is finer, and the limbs move with it).
  const insideWorst = (h: Hero) => {
    let worst = { depth: 0, at: '' };
    for (let f = 0; f < SHOWN; f++) {
      for (const pl of h.frames[f].placed) {
        const pts = pl.points.map((xy, i) => unproject(h.bodies[f], xy, pl.z[i]));
        for (const { p, at } of pastFlarePoints(pts)) {
          const depth = insideDepth(h.dummies[f], p);
          if (depth > worst.depth) worst = { depth, at: `f${f} limb ${pl.id} node ${at}` };
        }
      }
    }
    return worst;
  };
  it('draws no point of a limb`s centreline past its flared root inside his scanned body on f0–159, nor through him between its nodes (mask cell 2 px)', () => {
    const worst = insideWorst(hero);
    expect(worst.depth, worst.at).toBeLessThanOrEqual(2);
  });
  it('draws none inside him with the export`s finer mask cell (1920/1080 px) either', async () => {
    const worst = insideWorst(await buildHero(W / 1080));
    expect(worst.depth, worst.at).toBeLessThanOrEqual(2);
  }, 240_000);

  it('keeps the simulated rope itself clear of his scanned body on nearly every frame (it went 195 px through him on 57 frames)', () => {
    let worst = { depth: 0, at: '' };
    let over = 0;
    for (let f = 0; f < SHOWN; f++) {
      let here = 0;
      for (const s of hero.frames[f].sim) {
        for (const { p, at } of pastFlarePoints(s.points)) {
          const depth = insideDepth(hero.dummies[f], p);
          here = Math.max(here, depth);
          if (depth > worst.depth) worst = { depth, at: `f${f} limb ${s.id} node ${at}` };
        }
      }
      if (here > 2) over++;
    }
    expect(over, `worst ${worst.depth.toFixed(1)} px at ${worst.at}`).toBeLessThanOrEqual(8);
    expect(worst.depth, worst.at).toBeLessThan(120);
  });

  it('puts every tip exactly on P from the landing to the release (f77–92)', () => {
    for (let f = 77; f <= 92; f++) {
      for (const pl of hero.frames[f].placed) {
        const tip = pl.points[pl.points.length - 1];
        expect(Math.hypot(tip[0] - hero.P[0], tip[1] - hero.P[1]), `f${f} limb ${pl.id}`).toBeLessThan(0.5);
      }
    }
  });

  it('never swings a limb over his head while he stands still: its tip moves under 60 px in depth a frame on f24–48', () => {
    for (const { id } of hero.frames[24].placed) {
      for (let f = 25; f <= 48; f++) {
        const [a, b] = [simOf(f - 1, id), simOf(f, id)];
        expect(Math.abs(b[b.length - 1][2] - a[a.length - 1][2]), `f${f} limb ${id}`).toBeLessThan(60);
      }
    }
  });

  // Round 3 pass 3: the whip runs over f75–77 now, its bend travelling out
  // (decision 15), so the outer half bends most after the inner half has:
  // what was a crumple on f76 is a fold over 60° there.
  it('whips over the strike frames without crumpling: no joint over 60° on f76, the outer half bending most no sooner than the inner half over f74–77, and every tip still off P on f76', () => {
    const half = (f: number, id: number, outer: boolean) => {
      const b = bends(simOf(f, id));
      return (outer ? b.slice(b.length >> 1) : b.slice(0, b.length >> 1)).reduce((s, v) => s + v, 0);
    };
    const peak = (id: number, outer: boolean) => [74, 75, 76, 77].reduce((best, f) => (half(f, id, outer) > half(best, id, outer) ? f : best), 74);
    for (const { id } of hero.frames[76].placed) {
      expect(Math.max(...bends(simOf(76, id))), `limb ${id}`).toBeLessThanOrEqual(60);
      expect(peak(id, true), `limb ${id}`).toBeGreaterThanOrEqual(peak(id, false));
      const tip = hero.frames[76].placed.find((p) => p.id === id)!.points.at(-1)!;
      expect(Math.hypot(tip[0] - hero.P[0], tip[1] - hero.P[1]), `limb ${id}`).toBeGreaterThan(100);
    }
  });

  // Round 3 pass 3: as drawn on screen (decision 15), never folded, and
  // pinned taut but bowed, a rope and not a rod.
  const turns = (pts: readonly (readonly number[])[]) =>
    pts.slice(1, -1).map((p, i) => {
      const [ax, ay, bx, by] = [p[0] - pts[i][0], p[1] - pts[i][1], pts[i + 2][0] - p[0], pts[i + 2][1] - p[1]];
      return (Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1)))) * 180) / Math.PI;
    });
  it('draws no joint of a limb folded over 60° on screen on f0–159', () => {
    for (let f = 0; f < SHOWN; f++) for (const pl of hero.frames[f].placed) expect(Math.max(...turns(pl.points)), `f${f} limb ${pl.id}`).toBeLessThanOrEqual(60);
  });
  it('draws a pinned limb bowed and evenly stretched on screen (f77–92): sagitta over chord at least 0.06, no segment over 1.5× the median', () => {
    for (let f = 77; f <= 92; f++) {
      for (const pl of hero.frames[f].placed) {
        const [a, b] = [pl.points[0], pl.points[pl.points.length - 1]];
        const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const bow = Math.max(...pl.points.map((p) => Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / chord));
        expect(bow / chord, `f${f} limb ${pl.id}`).toBeGreaterThanOrEqual(0.06);
        const segs = pl.points.slice(1).map((p, i) => Math.hypot(p[0] - pl.points[i][0], p[1] - pl.points[i][1]));
        const median = [...segs].sort((x, y) => x - y)[segs.length >> 1];
        expect(Math.max(...segs) / median, `f${f} limb ${pl.id}`).toBeLessThanOrEqual(1.5);
      }
    }
  });

  it('gives a released limb its drawn length back: over f93–130 its 3D length per torso height never drops under 0.85× as drawn, and is at most 1.15× on most frames', () => {
    for (const [id, drawn] of hero.drawn) {
      const ratios: number[] = [];
      for (let f = 93; f <= 130; f++) ratios.push(arc(simOf(f, id)) / hero.bodies[f].unit / drawn);
      ratios.sort((a, b) => a - b);
      expect(ratios[0], `limb ${id}`).toBeGreaterThanOrEqual(0.85);
      expect(ratios[ratios.length >> 1], `limb ${id}: the median`).toBeLessThanOrEqual(1.15);
    }
  });

  it('is deterministic: the same clip, masks and drawing give the same limbs', async () => {
    const again = await buildHero();
    for (const f of [40, 76, 85, 100, 130]) expect(again.frames[f].placed).toEqual(hero.frames[f].placed);
  }, 180_000);
});
