/// <reference types="node" />
// P2 (SPEC §10, physics): segment length error after the constraint passes, at every step: < 2%.
//
// Measured on src/physics/strand.ts itself, with SPEC §8.7's parameters read from docs/SPEC.md at runtime.
// Input is seeded and synthetic: a torso pose moving smoothly on a 1080 x 1920 frame, with gravity on.
// Error per segment = |length - rest length| / rest length, where the rest length is the target's own segment
// length on that step (the contract: rest lengths = the target's segment lengths).
//
// stepChain runs the whole §8.3 step (Verlet, constraint passes, shape pull, bend limit), so the test recovers
// the state right after the constraint passes exactly:
//   (a) bend limit off. The shape pull is x <- x + k(T - x), with k = 0.5·stiffness² read from §8.7, so the
//       post-constraint position is x_c = (x - k·T) / (1 - k). Strands at stiffness 0, 0.3, 0.6 and 1.
//   (b) the §8.7 bend limit on, at stiffness 0 (k = 0, so the pull is a no-op). After the full step this is the
//       constraint passes plus the bend limit, which runs after them and must not stretch segments either.
// Stricter readings, flagged for Qai: (b) counts the bend limit as part of "after the constraint passes", and the
// max over every step, segment, stiffness and seed is what's compared. The state after the full step at
// stiffness > 0 (where the shape pull can shorten segments) is reported in the notes but not judged: SPEC
// measures after the constraint passes.
// Precondition: the strands are simulated, not copied from their target.
import { afterAll, describe, expect, it } from 'vitest';
import { Evidence } from '../helpers/evidence.ts';
import { dist, need, randomMotion, recorded, specParams, specPhysics, tendril, torsoToPx, type V2 } from '../helpers/engine.ts';

type StrandModule = typeof import('../../src/physics/strand.ts');

const ID = 'P2';
const THRESHOLD = 0.02;
const ev = new Evidence(ID, [
  'modules load',
  'SPEC §8.7 parameters',
  'precondition: strands are simulated, not copied',
  '(a) segment length error right after the constraint passes, bend limit off (max over every step)',
  '(b) segment length error after the constraint passes and the bend limit, stiffness 0 (max over every step)',
]);
afterAll(() => ev.write());

const SEEDS = [201, 202, 203];
const STEPS = 3000; // 25 s at dt = 1/120

interface Run {
  label: string;
  maxErr: number;
  worstStep: number;
  worstSegment: number;
  afterFullStepErr: number;
  tipLeavesTargetPx: number;
}

function simulate(strand: StrandModule, seed: number, stiffness: number, bendLimitDeg: number | null, pullCoeff: number, invertPull: boolean): Run {
  const params = specParams({ bendLimitDeg });
  const k = invertPull ? pullCoeff * stiffness * stiffness : 0;
  const motion = randomMotion(seed);
  const shape = tendril(seed * 13 + 5);
  const last = shape.length - 1;
  const targetAt = (s: number) => {
    const pose = motion(s * params.dt);
    return { pose, px: shape.map((p): V2 => torsoToPx(pose, p)) };
  };
  const chain = strand.createChain(targetAt(0).px, 'strand', stiffness);
  const run: Run = {
    label: `stiffness ${stiffness}, bend limit ${bendLimitDeg ?? 'off'}, seed ${seed}`,
    maxErr: 0,
    worstStep: 0,
    worstSegment: 0,
    afterFullStepErr: 0,
    tipLeavesTargetPx: 0,
  };
  for (let s = 1; s <= STEPS; s++) {
    const { pose, px } = targetAt(s);
    strand.stepChain(chain, px, pose.unit, params);
    const pts = chain.points as V2[];
    const postConstraint = pts.map((x, i): V2 => [(x[0] - k * px[i]![0]) / (1 - k), (x[1] - k * px[i]![1]) / (1 - k)]);
    for (let i = 0; i < last; i++) {
      const rest = dist(px[i]!, px[i + 1]!);
      const e = Math.abs(dist(postConstraint[i]!, postConstraint[i + 1]!) - rest) / rest;
      const ee = Number.isFinite(e) ? e : Infinity;
      if (ee > run.maxErr) {
        run.maxErr = ee;
        run.worstStep = s;
        run.worstSegment = i;
      }
      const full = Math.abs(dist(pts[i]!, pts[i + 1]!) - rest) / rest;
      run.afterFullStepErr = Math.max(run.afterFullStepErr, Number.isFinite(full) ? full : Infinity);
    }
    const tip = dist(pts[last]!, px[last]!);
    run.tipLeavesTargetPx = Math.max(run.tipLeavesTargetPx, Number.isFinite(tip) ? tip : 0);
  }
  return run;
}

const pct = (x: number) => `${(x * 100).toFixed(3)}%`;

describe('P2 segment length error after the constraint passes, at every step', () => {
  it('P2 every segment is within 2% of its rest length right after the constraint passes, at every step', async () => {
    const strand = await recorded(ev, 'modules load', 'src/physics/strand.ts exports createChain, stepChain', () =>
      need('src/physics/strand.ts', { createChain: 'function', stepChain: 'function' }, () => import('../../src/physics/strand.ts')),
    );
    const spec = await recorded(ev, 'SPEC §8.7 parameters', 'read from docs/SPEC.md', () => specPhysics(), (p) => p);

    const a: Run[] = [];
    for (const seed of SEEDS) for (const st of [0, 0.3, 0.6, 1]) a.push(simulate(strand, seed, st, null, spec.pullCoeff, true));
    const b: Run[] = SEEDS.map((seed) => simulate(strand, seed, 0, spec.bendLimitDeg, spec.pullCoeff, false));

    const simulated = Math.max(...a.filter((r) => r.label.startsWith('stiffness 0.3,')).map((r) => r.tipLeavesTargetPx));
    ev.record('precondition: strands are simulated, not copied', `${simulated.toFixed(3)} px max tip distance from its target (stiffness 0.3)`, '> 0 px', simulated > 0,
      simulated > 0 ? '' : 'the stiffness-0.3 strand never left its target: stepChain copies the target instead of simulating');

    const worstA = a.reduce((x, y) => (y.maxErr > x.maxErr ? y : x));
    const fullStep = a.filter((r) => !r.label.startsWith('stiffness 0,')).map((r) => `${r.label}: ${pct(r.afterFullStepErr)}`);
    const passA = worstA.maxErr < THRESHOLD;
    ev.record(
      '(a) segment length error right after the constraint passes, bend limit off (max over every step)',
      { maxError: pct(worstA.maxErr), worst: `${worstA.label}, step ${worstA.worstStep}, segment ${worstA.worstSegment}`, runs: a.length, stepsEach: STEPS },
      `< ${pct(THRESHOLD)}`,
      passA,
      `not judged, after the full step (shape pull included): ${fullStep.join('; ')}`,
    );

    const worstB = b.reduce((x, y) => (y.maxErr > x.maxErr ? y : x));
    const passB = worstB.maxErr < THRESHOLD;
    ev.record(
      '(b) segment length error after the constraint passes and the bend limit, stiffness 0 (max over every step)',
      { maxError: pct(worstB.maxErr), worst: `${worstB.label}, step ${worstB.worstStep}, segment ${worstB.worstSegment}`, runs: b.length, stepsEach: STEPS },
      `< ${pct(THRESHOLD)}`,
      passB,
    );

    expect(simulated, 'P2 precondition: the stiffness-0.3 strand never left its target, so nothing was simulated').toBeGreaterThan(0);
    expect(worstA.maxErr, `P2 (a) segment error ${pct(worstA.maxErr)} (${worstA.label}, step ${worstA.worstStep}) must be < 2%`).toBeLessThan(THRESHOLD);
    expect(worstB.maxErr, `P2 (b) segment error ${pct(worstB.maxErr)} with the bend limit (${worstB.label}, step ${worstB.worstStep}) must be < 2%`).toBeLessThan(THRESHOLD);
  });
});
