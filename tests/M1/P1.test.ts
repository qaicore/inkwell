/// <reference types="node" />
// P1 (SPEC §10, physics): root distance from the anchor, at every step: < 0.5 px at 1080 wide.
//
// Measured on src/physics/strand.ts itself (createChain, then stepChain once per fixed step), with SPEC §8.7's
// parameters read from docs/SPEC.md at runtime, not from DEFAULT_PHYSICS. Input is seeded and synthetic: a
// torso pose moving on a 1080 x 1920 frame (about 420 px per torso height) that also jumps up to 0.5 torso
// heights every 2 s, the way a tracking glitch would. The anchor is the stroke's root: target point 0, which is
// the torso-space root converted to px with that step's pose. After every step, |node 0 - target point 0| is
// measured for strands at stiffness 0, 0.3, 0.6 and 1 and for a rigid stroke, with the §8.7 bend limit on and off.
//
// Stricter readings, flagged for Qai: "every step" includes the jump steps, and the max over every step, node
// configuration and seed is what's compared.
// Precondition: the strands are simulated, not copied from their target (some tip leaves its target tip).
import { afterAll, describe, expect, it } from 'vitest';
import { Evidence } from '../helpers/evidence.ts';
import { dist, need, randomMotion, recorded, specParams, tendril, torsoToPx, type V2 } from '../helpers/engine.ts';

type StrandModule = typeof import('../../src/physics/strand.ts');

const ID = 'P1';
const THRESHOLD_PX = 0.5;
const ev = new Evidence(ID, [
  'modules load',
  'SPEC §8.7 parameters',
  'precondition: strands are simulated, not copied',
  'root distance from the anchor (max over every step)',
]);
afterAll(() => ev.write());

const SEEDS = [101, 102, 103];
const STEPS = 2400; // 20 s at dt = 1/120
const CONFIGS: { kind: 'strand' | 'rigid'; stiffness: number }[] = [
  { kind: 'strand', stiffness: 0 },
  { kind: 'strand', stiffness: 0.3 },
  { kind: 'strand', stiffness: 0.6 },
  { kind: 'strand', stiffness: 1 },
  { kind: 'rigid', stiffness: 1 },
];

interface Run {
  label: string;
  rootMaxPx: number;
  worstStep: number;
  tipLeavesTargetPx: number;
}

function simulate(strand: StrandModule, seed: number, kind: 'strand' | 'rigid', stiffness: number, bendLimitDeg: number | null): Run {
  const params = specParams({ bendLimitDeg });
  const motion = randomMotion(seed, { jumps: { every: 2, size: 0.5 } });
  const shape = tendril(seed * 7 + 1);
  const last = shape.length - 1;
  const targetAt = (s: number) => {
    const pose = motion(s * params.dt);
    return { pose, px: shape.map((p): V2 => torsoToPx(pose, p)) };
  };
  const chain = strand.createChain(targetAt(0).px, kind, stiffness);
  let rootMaxPx = dist(chain.points[0] as V2, targetAt(0).px[0]!);
  let worstStep = 0;
  let tipLeavesTargetPx = 0;
  for (let s = 1; s <= STEPS; s++) {
    const { pose, px } = targetAt(s);
    strand.stepChain(chain, px, pose.unit, params);
    const d = dist(chain.points[0] as V2, px[0]!);
    const dd = Number.isFinite(d) ? d : Infinity;
    if (dd > rootMaxPx) {
      rootMaxPx = dd;
      worstStep = s;
    }
    const tip = dist(chain.points[last] as V2, px[last]!);
    tipLeavesTargetPx = Math.max(tipLeavesTargetPx, Number.isFinite(tip) ? tip : 0);
  }
  return { label: `${kind} stiffness ${stiffness}, bend limit ${bendLimitDeg ?? 'off'}, seed ${seed}`, rootMaxPx, worstStep, tipLeavesTargetPx };
}

describe('P1 root distance from the anchor, at every step', () => {
  it('P1 node 0 stays within 0.5 px of the anchor at every step (strands at stiffness 0..1 and rigid; bend limit on and off)', async () => {
    const strand = await recorded(ev, 'modules load', 'src/physics/strand.ts exports createChain, stepChain', () =>
      need('src/physics/strand.ts', { createChain: 'function', stepChain: 'function' }, () => import('../../src/physics/strand.ts')),
    );
    const spec = await recorded(ev, 'SPEC §8.7 parameters', 'read from docs/SPEC.md', () => specParams(), (p) => p);

    const runs: Run[] = [];
    for (const seed of SEEDS) {
      for (const c of CONFIGS) {
        for (const bend of [spec.bendLimitDeg, null]) runs.push(simulate(strand, seed, c.kind, c.stiffness, bend));
      }
    }

    const simulated = Math.max(...runs.filter((r) => r.label.startsWith('strand stiffness 0.3')).map((r) => r.tipLeavesTargetPx));
    ev.record('precondition: strands are simulated, not copied', `${simulated.toFixed(3)} px max tip distance from its target (stiffness 0.3)`, '> 0 px', simulated > 0,
      simulated > 0 ? '' : 'the stiffness-0.3 strand never left its target: stepChain copies the target instead of simulating');

    const worst = runs.reduce((a, b) => (b.rootMaxPx > a.rootMaxPx ? b : a));
    const pass = worst.rootMaxPx < THRESHOLD_PX;
    ev.record(
      'root distance from the anchor (max over every step)',
      { maxPx: worst.rootMaxPx, worst: `${worst.label}, step ${worst.worstStep}`, runs: runs.length, stepsEach: STEPS },
      `< ${THRESHOLD_PX} px at 1080 wide`,
      pass,
      pass ? '' : `node 0 drifted ${worst.rootMaxPx.toFixed(4)} px from the anchor (${worst.label}, step ${worst.worstStep})`,
    );

    expect(simulated, 'P1 precondition: the stiffness-0.3 strand never left its target, so nothing was simulated').toBeGreaterThan(0);
    expect(worst.rootMaxPx, `P1 root distance ${worst.rootMaxPx} px (${worst.label}, step ${worst.worstStep}) must be < ${THRESHOLD_PX} px`).toBeLessThan(THRESHOLD_PX);
  });
});
