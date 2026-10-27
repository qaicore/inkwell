/// <reference types="node" />
// A1 (SPEC §10, anime motion): stepped drawings over 3 s, with a seeded synthetic anchor moving the whole time. The held
// drawing is in torso space, before it's placed on the frame. Threshold: it changes exactly drawingsPerSecond times per
// second, and is identical between changes. It's placed with each video frame's own torso transform, so it never slides
// off the body.
//
// Measured on src/motion/animate.ts animate() output, never on a config value: the test compares the held torso-space
// drawing (points, pressure, layer) of every frame with the previous frame's and counts the changes. dps is read from
// Qai's reference/timing.json at runtime (missing = FAIL) and put in the effect; the boil passed to animate is the one
// in timing.json too. 90 frames at 30 fps = 3 s. Each stroke has its own seeded anchor that moves on every frame (x
// always moves right, plus wobble, lean, scale), and the test checks that before trusting the counts.
// Strokes: a strand (stiffness 0.3, wobble 1), a strand (stiffness 0.7, wobble 0: only physics can change it) and a
// rigid stroke (wobble 1: only boil can change it, so it's expected to change only when boil.maxPx > 0).
//   - Changes per second: frames f in [30s, 30s + 30) where the held drawing differs from frame f - 1 (frame 0 is the
//     first drawing). Must equal dps in each of the 3 seconds, for the whole drawing and for each stroke that must change.
//   - Identical between changes: no change on a frame where k = floor(f·dps/30) (SPEC §6, §8.1) stays the same.
//   - Placement: every placed point equals toPixels(anchor(strokeId, f), held point) within 1e-6 px, on every frame.
//     Pressure and layer are carried over unchanged.
//   - src/track/torso.ts is checked first, so placement can't pass on a wrong transform: toTorso inverts toPixels, the
//     origin maps to (x, y), one torso unit maps to `unit` px, the rotation is by `angle`, and upright torso x/y are
//     screen right/down (SPEC §6).
// Stricter readings, flagged for Qai:
//   - the changes must land on exactly the frames where floor(f·dps/30) changes, not just add up to dps per second;
//   - the same checks also run at the other allowed rate (12 <-> 8), since SPEC §8.4 says never hard-code the pattern;
//   - each stroke's own anchor must be used (the anchors differ per stroke);
//   - the held drawing must really be in torso space: its root stays within 0.05 torso heights of the stroke's root.
import { afterAll, describe, expect, it } from 'vitest';
import type { Effect, Stroke } from '../../src/types/effect.ts';
import { Evidence } from '../helpers/evidence.ts';
import { dist, need, recorded, rng, tendril, timingBoil, timingDps, type Pose, type V2 } from '../helpers/engine.ts';

type TorsoModule = typeof import('../../src/track/torso.ts');
type AnimateModule = typeof import('../../src/motion/animate.ts');
type Frame = ReturnType<AnimateModule['animate']>[number];

const ID = 'A1';
const FPS = 30;
const FRAMES = 90; // 3 s
const PLACE_TOL_PX = 1e-6;
const TORSO_ROOT_TOL = 0.05; // torso heights: a sanity bound, px coordinates would be hundreds
const ev = new Evidence(ID, [
  'modules load',
  'reference/timing.json dps and boil',
  'torso transform: toTorso inverts toPixels and maps torso units to px',
  'precondition: every anchor moves on every frame',
  'held drawing is in torso space',
  'held drawing changes exactly dps times per second (dps from reference/timing.json)',
  'held drawing changes only where floor(f·dps/30) changes, identical between changes',
  'placed with each frame\'s own torso transform',
  'same cadence at the other allowed rate',
]);
afterAll(() => ev.write());

// ---------- synthetic input ----------

function anchorFor(seed: number): (frame: number) => Pose {
  const r = rng(seed);
  const ph = Array.from({ length: 4 }, () => 2 * Math.PI * r());
  return (frame: number): Pose => {
    const t = frame / FPS;
    // dx/dt = 180 + 30·2π·0.9·cos(...) >= 180 - 170 > 0: always moving right.
    return {
      x: 250 + 180 * t + 30 * Math.sin(2 * Math.PI * 0.9 * t + ph[0]!),
      y: 900 - 15 * t + 25 * Math.sin(2 * Math.PI * 0.6 * t + ph[1]!),
      angle: 0.05 * t + 0.12 * Math.sin(2 * Math.PI * 0.5 * t + ph[2]!),
      unit: 420 * (1 + 0.06 * Math.sin(2 * Math.PI * 0.4 * t + ph[3]!)),
    };
  };
}

function makeStroke(id: number, kind: 'strand' | 'rigid', stiffness: number, wobble: number, layer: 'front' | 'behind'): Stroke {
  const points = tendril(1000 + id);
  return {
    id,
    color: (id % 3) as 0 | 1 | 2,
    kind,
    anchor: { type: 'point', time: 0, xy: [540, 900] },
    bodyAngle: 0,
    stiffness,
    wobble,
    views: {
      front: {
        points,
        pressure: points.map((_, i) => 0.35 + 0.6 * Math.sin((Math.PI * i) / (points.length - 1))),
        root: points[0]!,
        layer,
      },
    },
  };
}

function makeEffect(dps: 12 | 8): Effect {
  return {
    version: 1,
    brush: { size: 10, thinning: 0.6, smoothing: 0.5, streamline: 0.4 },
    palette: ['#1b1b1f', '#c8323c', '#f2efe6'],
    timing: { drawingsPerSecond: dps },
    strokes: [makeStroke(1, 'strand', 0.3, 1, 'front'), makeStroke(2, 'strand', 0.7, 0, 'behind'), makeStroke(3, 'rigid', 1, 1, 'front')],
    overrides: {},
  };
}

// ---------- measurement ----------

type Held = { points: V2[]; pressure: number[]; layer: string };

function sameHeld(a: Held | undefined, b: Held | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.layer === b.layer &&
    a.points.length === b.points.length &&
    a.pressure.length === b.pressure.length &&
    a.points.every((p, i) => p[0] === b.points[i]![0] && p[1] === b.points[i]![1]) &&
    a.pressure.every((v, i) => v === b.pressure[i])
  );
}

interface Cadence {
  dps: number;
  frameProblems: string[];
  perSecond: number[];
  perStrokePerSecond: Record<string, number[]>;
  extraChanges: string[];
  missingChanges: string[];
  reportedKMismatches: number[];
  placementMaxPx: number;
  placementProblems: string[];
  torsoRootMax: number;
}

function measure(animate: AnimateModule['animate'], toPixels: TorsoModule['toPixels'], dps: 12 | 8, boil: { maxPx: number; cycle: number }): Cadence {
  const effect = makeEffect(dps);
  const anchors = new Map(effect.strokes.map((s) => [s.id, anchorFor(7000 + s.id * 31)]));
  const frames: Frame[] = animate({ effect, frames: FRAMES, anchor: (id: number, f: number) => anchors.get(id)!(f), width: 1080, boil, fps: FPS });
  const out: Cadence = {
    dps,
    frameProblems: [],
    perSecond: [0, 0, 0],
    perStrokePerSecond: {},
    extraChanges: [],
    missingChanges: [],
    reportedKMismatches: [],
    placementMaxPx: 0,
    placementProblems: [],
    torsoRootMax: 0,
  };
  if (frames.length !== FRAMES) out.frameProblems.push(`animate returned ${frames.length} frames for frames: ${FRAMES}`);
  frames.forEach((fr, i) => {
    if (fr.f !== i) out.frameProblems.push(`frame ${i} is labeled f = ${fr.f}`);
  });
  const mustChange = (s: Stroke) => s.kind === 'strand' || (s.wobble > 0 && boil.maxPx > 0);
  const heldAt = (f: number, id: number): Held | undefined => {
    const h = frames[f]?.held.find((x) => x.id === id);
    return h ? { points: h.points as V2[], pressure: h.pressure, layer: h.layer } : undefined;
  };
  const kOf = (f: number) => Math.floor((f * dps) / FPS);
  for (const s of effect.strokes) out.perStrokePerSecond[`stroke ${s.id}`] = [0, 0, 0];
  for (let f = 0; f < Math.min(FRAMES, frames.length); f++) {
    const fr = frames[f]!;
    if (fr.k !== kOf(f)) out.reportedKMismatches.push(f);
    const newK = f === 0 || kOf(f) !== kOf(f - 1);
    const sec = Math.floor(f / FPS);
    let any = false;
    for (const s of effect.strokes) {
      const h = heldAt(f, s.id);
      if (!h) {
        out.frameProblems.push(`frame ${f}: no held drawing for stroke ${s.id}`);
        continue;
      }
      out.torsoRootMax = Math.max(out.torsoRootMax, dist(h.points[0]!, s.views.front.root));
      const changed = f === 0 || !sameHeld(h, heldAt(f - 1, s.id));
      if (changed) {
        any = true;
        out.perStrokePerSecond[`stroke ${s.id}`]![sec]!++;
        if (!newK) out.extraChanges.push(`f ${f} stroke ${s.id}`);
      } else if (newK && mustChange(s)) {
        out.missingChanges.push(`f ${f} stroke ${s.id}`);
      }
      // Placement with this frame's own transform.
      const p = fr.placed.find((x) => x.id === s.id);
      if (!p) {
        out.placementProblems.push(`frame ${f}: stroke ${s.id} not placed`);
        continue;
      }
      if (p.points.length !== h.points.length) out.placementProblems.push(`frame ${f} stroke ${s.id}: ${p.points.length} placed points vs ${h.points.length} held`);
      if (p.layer !== h.layer || p.pressure.length !== h.pressure.length || p.pressure.some((v, i) => v !== h.pressure[i])) {
        out.placementProblems.push(`frame ${f} stroke ${s.id}: pressure or layer changed in placement`);
      }
      const t = anchors.get(s.id)!(f);
      h.points.forEach((q, i) => {
        const e = dist(p.points[i] as V2, toPixels(t, q) as V2);
        out.placementMaxPx = Math.max(out.placementMaxPx, Number.isFinite(e) ? e : Infinity);
      });
    }
    if (any) out.perSecond[sec]!++;
  }
  // Per-stroke counts only bind strokes that must change; report the others.
  for (const s of effect.strokes) if (!mustChange(s)) delete out.perStrokePerSecond[`stroke ${s.id}`];
  return out;
}

function cadenceOk(c: Cadence): { counts: boolean; frames: boolean; placement: boolean } {
  const counts = c.perSecond.every((n) => n === c.dps) && Object.values(c.perStrokePerSecond).every((xs) => xs.every((n) => n === c.dps));
  const framesOk = c.extraChanges.length === 0 && c.missingChanges.length === 0 && c.reportedKMismatches.length === 0 && c.frameProblems.length === 0;
  const placement = c.placementMaxPx <= PLACE_TOL_PX && c.placementProblems.length === 0;
  return { counts, frames: framesOk, placement };
}

const head = (xs: (string | number)[]) => (xs.length > 8 ? [...xs.slice(0, 8), `... ${xs.length - 8} more`] : xs);

// ---------- torso transform check ----------

function checkTorso(m: TorsoModule): { ok: boolean; measured: Record<string, unknown> } {
  const r = rng(424242);
  let invTorso = 0;
  let invPx = 0;
  let origin = 0;
  let scale = 0;
  let upright = 0;
  let rotPlus = 0;
  let rotMinus = 0;
  let mirrored = 0;
  const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  for (let i = 0; i < 60; i++) {
    const t = { x: r() * 1080, y: r() * 1920, angle: i === 0 ? 0 : (r() * 2 - 1) * Math.PI, unit: 100 + r() * 700 };
    const o = m.toPixels(t, [0, 0]) as V2;
    origin = Math.max(origin, dist(o, [t.x, t.y]));
    const ex = m.toPixels(t, [1, 0]) as V2;
    const ey = m.toPixels(t, [0, 1]) as V2;
    const vx: V2 = [ex[0] - o[0], ex[1] - o[1]];
    const vy: V2 = [ey[0] - o[0], ey[1] - o[1]];
    scale = Math.max(scale, Math.abs(Math.hypot(...vx) - t.unit) / t.unit, Math.abs(Math.hypot(...vy) - t.unit) / t.unit);
    const a = Math.atan2(vx[1], vx[0]);
    rotPlus = Math.max(rotPlus, Math.abs(wrap(a - t.angle)));
    rotMinus = Math.max(rotMinus, Math.abs(wrap(a + t.angle)));
    if (vx[0] * vy[1] - vx[1] * vy[0] <= 0) mirrored++;
    if (t.angle === 0) upright = Math.max(upright, dist(ex, [t.x + t.unit, t.y]), dist(ey, [t.x, t.y + t.unit]));
    for (let j = 0; j < 20; j++) {
      const p: V2 = [(r() * 2 - 1) * 2, (r() * 2 - 1) * 2];
      invTorso = Math.max(invTorso, dist(m.toTorso(t, m.toPixels(t, p)) as V2, p));
      const q: V2 = [r() * 1080, r() * 1920];
      invPx = Math.max(invPx, dist(m.toPixels(t, m.toTorso(t, q)) as V2, q));
    }
  }
  const rotation = Math.min(rotPlus, rotMinus);
  const measured = {
    toTorsoOfToPixelsErrTorsoUnits: invTorso,
    toPixelsOfToTorsoErrPx: invPx,
    originErrPx: origin,
    unitScaleRelErr: scale,
    uprightAxesErrPx: upright,
    rotationErrRad: rotation,
    rotationSign: rotPlus <= rotMinus ? '+angle (clockwise on screen, y down)' : '-angle (counterclockwise on screen, y down)',
    mirroredSamples: mirrored,
  };
  const ok = invTorso <= 1e-9 && invPx <= 1e-6 && origin <= 1e-9 && scale <= 1e-9 && upright <= 1e-6 && rotation <= 1e-9 && mirrored === 0;
  return { ok, measured };
}

// ---------- the test ----------

describe('A1 stepped drawings over 3 s with a moving synthetic anchor', () => {
  it('A1 the held torso-space drawing changes exactly dps times per second, holds between changes, and is placed with each frame\'s own transform', async () => {
    const mods = await recorded(ev, 'modules load', 'src/track/torso.ts (toPixels, toTorso) and src/motion/animate.ts (animate)', async () => ({
      torso: await need('src/track/torso.ts', { toPixels: 'function', toTorso: 'function' }, () => import('../../src/track/torso.ts')),
      anim: await need('src/motion/animate.ts', { animate: 'function' }, () => import('../../src/motion/animate.ts')),
    }));
    const { dps, boil } = await recorded(ev, 'reference/timing.json dps and boil', 'dps 12 or 8; boil present', () => ({ dps: timingDps(), boil: timingBoil() }), (v) => v);

    const torsoCheck = checkTorso(mods.torso);
    ev.record('torso transform: toTorso inverts toPixels and maps torso units to px', torsoCheck.measured,
      'inverse within 1e-9 torso units / 1e-6 px; origin, unit scale and rotation exact to 1e-9; upright x right, y down; never mirrored', torsoCheck.ok);

    // The anchors move on every frame.
    let minMovePx = Infinity;
    for (const id of [1, 2, 3]) {
      const a = anchorFor(7000 + id * 31);
      for (let f = 1; f < FRAMES; f++) minMovePx = Math.min(minMovePx, dist([a(f).x, a(f).y], [a(f - 1).x, a(f - 1).y]));
    }
    ev.record('precondition: every anchor moves on every frame', { minOriginMovePerFramePx: minMovePx }, '> 0 px on every frame', minMovePx > 0);

    const main = measure(mods.anim.animate, mods.torso.toPixels, dps, boil);
    const ok = cadenceOk(main);

    ev.record('held drawing is in torso space', { maxRootDistanceTorsoUnits: main.torsoRootMax }, `< ${TORSO_ROOT_TOL} torso heights from the stroke's root`,
      main.torsoRootMax < TORSO_ROOT_TOL);
    ev.record('held drawing changes exactly dps times per second (dps from reference/timing.json)',
      { dps, wholeDrawingPerSecond: main.perSecond, perStrokePerSecond: main.perStrokePerSecond }, `${dps} changes in each of the 3 seconds`, ok.counts);
    ev.record('held drawing changes only where floor(f·dps/30) changes, identical between changes',
      { changesBetweenDrawings: head(main.extraChanges), missedNewDrawings: head(main.missingChanges), framesWhereReportedKIsWrong: head(main.reportedKMismatches), frameProblems: head(main.frameProblems) },
      'no changes inside a drawing, a change at every new drawing, k = floor(f·dps/30)', ok.frames);
    ev.record('placed with each frame\'s own torso transform', { maxPx: main.placementMaxPx, problems: head(main.placementProblems) },
      `<= ${PLACE_TOL_PX} px from toPixels(anchor(strokeId, f), held point) on every frame`, ok.placement);

    const otherDps: 12 | 8 = dps === 12 ? 8 : 12;
    const other = measure(mods.anim.animate, mods.torso.toPixels, otherDps, boil);
    const o = cadenceOk(other);
    const otherOk = o.counts && o.frames && o.placement;
    ev.record('same cadence at the other allowed rate', {
      dps: otherDps,
      wholeDrawingPerSecond: other.perSecond,
      perStrokePerSecond: other.perStrokePerSecond,
      changesBetweenDrawings: head(other.extraChanges),
      missedNewDrawings: head(other.missingChanges),
      placementMaxPx: other.placementMaxPx,
    }, `${otherDps} changes per second on the floor(f·${otherDps}/30) frames, placed exactly`, otherOk);

    expect(torsoCheck.ok, `A1 torso transform is wrong: ${JSON.stringify(torsoCheck.measured)}`).toBe(true);
    expect(minMovePx, 'A1 precondition: a synthetic anchor stood still on some frame').toBeGreaterThan(0);
    expect(main.torsoRootMax, `A1 held drawing isn't in torso space (root ${main.torsoRootMax} torso units from the stroke root)`).toBeLessThan(TORSO_ROOT_TOL);
    expect(ok.counts, `A1 held drawing changes per second ${JSON.stringify(main.perSecond)} / per stroke ${JSON.stringify(main.perStrokePerSecond)}, expected ${dps}`).toBe(true);
    expect(ok.frames, `A1 cadence: extra ${JSON.stringify(head(main.extraChanges))}, missing ${JSON.stringify(head(main.missingChanges))}, k ${JSON.stringify(head(main.reportedKMismatches))}, ${main.frameProblems.join('; ')}`).toBe(true);
    expect(ok.placement, `A1 placement off by ${main.placementMaxPx} px: ${main.placementProblems.join('; ')}`).toBe(true);
    expect(otherOk, `A1 at ${otherDps} dps: ${JSON.stringify(other.perSecond)}, extra ${other.extraChanges.length}, missing ${other.missingChanges.length}, placement ${other.placementMaxPx} px`).toBe(true);
  });
});
