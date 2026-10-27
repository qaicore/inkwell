/// <reference types="node" />
// P4 (SPEC §10, physics): kinds and extremes. A rigid stroke matches its target within 0.5 px at every step.
// A strand at stiffness 0 with gravity settles with its tip below its root.
//
// Measured on src/physics/strand.ts itself, with SPEC §8.7's parameters read from docs/SPEC.md at runtime.
//   - Rigid: seeded synthetic torso motion on a 1080 x 1920 frame (with a jump of up to 0.5 torso heights every
//     2 s) and gravity on. Max over every step and every node of |node - target node|.
//   - Rope: stiffness 0, §8.7 gravity, the anchor held still, upright and tilted 0.5 rad. It starts at rest on four
//     shapes: pointing right, pointing left, 30 degrees off straight up, and curled. It runs for 30 s.
//     "Settles" uses §10's definition, the tip moving less than 0.5 px per drawing, checked over every drawing-long
//     window from the settle time to the end, which must leave at least 2 s settled. "Below its root" means
//     tip y > root y on screen, where y grows downward, at the end of the run.
// Stricter readings, flagged for Qai: the windows are the longest drawing SPEC allows (1/8 s at 8 dps) and slide one
// step at a time. SPEC gives no settle-time limit for P4, so the 30 s cap is generous; the settle time is reported.
import { afterAll, describe, expect, it } from 'vitest';
import { Evidence } from '../helpers/evidence.ts';
import { dist, need, polylineLength, randomMotion, recorded, specParams, tendril, torsoToPx, type Pose, type V2 } from '../helpers/engine.ts';

type StrandModule = typeof import('../../src/physics/strand.ts');

const ID = 'P4';
const RIGID_PX = 0.5;
const SETTLED_PX = 0.5;
const SLOWEST_DPS = 8;
const ROPE_S = 30;
const SETTLED_TAIL_S = 2;
const ev = new Evidence(ID, [
  'modules load',
  'rigid stroke vs its target (max over every step and node)',
  'rope (stiffness 0, gravity) settles',
  'rope tip below its root once settled',
]);
afterAll(() => ev.write());

function rigidRun(strand: StrandModule, seed: number): { label: string; maxPx: number; step: number; node: number } {
  const params = specParams();
  const motion = randomMotion(seed, { jumps: { every: 2, size: 0.5 } });
  const shape = tendril(seed * 17 + 2);
  const targetAt = (s: number) => {
    const pose = motion(s * params.dt);
    return { pose, px: shape.map((p): V2 => torsoToPx(pose, p)) };
  };
  const chain = strand.createChain(targetAt(0).px, 'rigid', 1);
  let worst = { label: `rigid, seed ${seed}`, maxPx: 0, step: 0, node: 0 };
  for (let s = 1; s <= 2400; s++) {
    const { pose, px } = targetAt(s);
    strand.stepChain(chain, px, pose.unit, params);
    const pts = chain.points as V2[];
    if (pts.length !== px.length) return { ...worst, maxPx: Infinity, step: s };
    for (let i = 0; i < px.length; i++) {
      const d = dist(pts[i]!, px[i]!);
      const dd = Number.isFinite(d) ? d : Infinity;
      if (dd > worst.maxPx) worst = { ...worst, maxPx: dd, step: s, node: i };
    }
  }
  return worst;
}

function line(dirRad: number, n = 32, length = 0.8, bend = 0): V2[] {
  const pts: V2[] = [[0.1, -0.25]];
  let a = dirRad;
  for (let i = 1; i < n; i++) {
    a += bend / (n - 1);
    const q = pts[i - 1]!;
    pts.push([q[0] + (length / (n - 1)) * Math.cos(a), q[1] + (length / (n - 1)) * Math.sin(a)]);
  }
  return pts;
}

interface RopeRun {
  label: string;
  settledAtS: number | null;
  settledLongEnough: boolean;
  tipBelowRootPx: number;
  hangDegFromVertical: number;
}

function ropeRun(strand: StrandModule, pose: Pose, shapeName: string, shape: V2[]): RopeRun {
  const params = specParams();
  const px = shape.map((p): V2 => torsoToPx(pose, p));
  const chain = strand.createChain(px, 'strand', 0);
  const steps = Math.round(ROPE_S / params.dt);
  const window = Math.round(1 / SLOWEST_DPS / params.dt);
  const last = shape.length - 1;
  const tips: V2[] = [[px[last]![0], px[last]![1]]];
  for (let s = 1; s <= steps; s++) {
    strand.stepChain(chain, px, pose.unit, params);
    const t = (chain.points as V2[])[last]!;
    tips.push([t[0], t[1]]);
  }
  let lastBad = -1;
  for (let i = 0; i + window < tips.length; i++) {
    const m = dist(tips[i + window]!, tips[i]!);
    if (!(m < SETTLED_PX)) lastBad = i;
  }
  const settleIndex = lastBad + 1;
  const settledAtS = settleIndex + window < tips.length ? settleIndex * params.dt : null;
  const settledLongEnough = settledAtS !== null && settleIndex * params.dt <= ROPE_S - SETTLED_TAIL_S - window * params.dt;
  const root = (chain.points as V2[])[0]!;
  const tip = tips[tips.length - 1]!;
  return {
    label: `${shapeName}, anchor angle ${pose.angle}`,
    settledAtS,
    settledLongEnough,
    tipBelowRootPx: tip[1] - root[1],
    hangDegFromVertical: (Math.atan2(Math.abs(tip[0] - root[0]), tip[1] - root[1]) * 180) / Math.PI,
  };
}

describe('P4 kinds and extremes', () => {
  it('P4 a rigid stroke matches its target within 0.5 px at every step', async () => {
    const strand = await recorded(ev, 'modules load', 'src/physics/strand.ts exports createChain, stepChain', () =>
      need('src/physics/strand.ts', { createChain: 'function', stepChain: 'function' }, () => import('../../src/physics/strand.ts')),
    );
    const runs = [401, 402, 403].map((seed) => rigidRun(strand, seed));
    const worst = runs.reduce((a, b) => (b.maxPx > a.maxPx ? b : a));
    const pass = worst.maxPx < RIGID_PX;
    ev.record('rigid stroke vs its target (max over every step and node)', { maxPx: worst.maxPx, worst: `${worst.label}, step ${worst.step}, node ${worst.node}` },
      `< ${RIGID_PX} px`, pass);
    expect(worst.maxPx, `P4 rigid stroke ${worst.maxPx} px off its target (${worst.label}, step ${worst.step}, node ${worst.node})`).toBeLessThan(RIGID_PX);
  });

  it('P4 a strand at stiffness 0 with gravity settles with its tip below its root', async () => {
    const strand = await need('src/physics/strand.ts', { createChain: 'function', stepChain: 'function' }, () => import('../../src/physics/strand.ts'));
    const poses: Pose[] = [
      { x: 540, y: 700, angle: 0, unit: 420 },
      { x: 520, y: 760, angle: 0.5, unit: 380 },
    ];
    const shapes: [string, V2[]][] = [
      ['pointing right', line(0)],
      ['pointing left', line(Math.PI)],
      ['30 deg off straight up', line(-Math.PI / 2 + Math.PI / 6)],
      ['curled', line(0.3, 32, 0.8, -2.4)],
    ];
    const runs: RopeRun[] = [];
    for (const pose of poses) for (const [name, shape] of shapes) runs.push(ropeRun(strand, pose, name, shape));

    const unsettled = runs.filter((r) => !r.settledLongEnough);
    ev.record(
      'rope (stiffness 0, gravity) settles',
      Object.fromEntries(runs.map((r) => [r.label, r.settledAtS === null ? 'never' : `${r.settledAtS.toFixed(2)} s`])),
      `tip moves < ${SETTLED_PX} px per drawing (1/${SLOWEST_DPS} s), for at least the last ${SETTLED_TAIL_S} s of ${ROPE_S} s`,
      unsettled.length === 0,
      unsettled.length ? `not settled: ${unsettled.map((r) => r.label).join('; ')}` : '',
    );

    const notBelow = runs.filter((r) => !(r.tipBelowRootPx > 0));
    const strandLen = polylineLength(shapes[0]![1]) * poses[0]!.unit;
    ev.record(
      'rope tip below its root once settled',
      Object.fromEntries(runs.map((r) => [r.label, `tip ${r.tipBelowRootPx.toFixed(1)} px below the root, ${r.hangDegFromVertical.toFixed(2)} deg from vertical`])),
      'tip y > root y (screen, y down)',
      notBelow.length === 0,
      `strand length about ${strandLen.toFixed(0)} px${notBelow.length ? `; tip not below the root: ${notBelow.map((r) => r.label).join('; ')}` : ''}`,
    );

    expect(unsettled.map((r) => r.label), 'P4 rope did not settle').toEqual([]);
    expect(notBelow.map((r) => r.label), 'P4 rope tip not below its root').toEqual([]);
  });
});
