/// <reference types="node" />
// P3 (SPEC §10, physics): 10,000 steps of seeded random anchor motion. No NaN; tip speed < 20 torso heights/s;
// once the anchor stops, the strand is settled within 2 s.
//
// Measured on src/physics/strand.ts itself, with SPEC §8.7's parameters read from docs/SPEC.md at runtime (gravity
// on, bend limit on). The physics module's DEFAULT_PHYSICS must equal those values too, because the app runs on it.
// Input is seeded and synthetic: a torso pose moving smoothly on a 1080 x 1920 frame (translation up to about
// 5 torso heights/s, rotation up to about 2 rad/s, scale +-25%) for 10,000 steps, then held still for 5 s.
//   - No NaN: every coordinate of every node is finite after every step.
//   - Tip speed: |tip(step) - tip(step - 1)| / dt / that step's px per torso height, max over every step.
//   - Settled (§10 definitions): the tip moves less than 0.5 px per drawing. Checked over every drawing-long
//     window that starts 2 s or more after the stop, to the end of the 5 s hold, so it must settle and stay settled.
// Stricter readings, flagged for Qai:
//   - "the strand" is every kind: strands at stiffness 0, 0.3 and 1, and a rigid stroke, each on 3 seeds;
//   - "per drawing" uses the longest drawing SPEC allows, 1/8 s (8 dps), and the windows slide one step at a time.
import { afterAll, describe, expect, it } from 'vitest';
import { Evidence } from '../helpers/evidence.ts';
import { dist, need, randomMotion, recorded, specParams, tendril, torsoToPx, type V2 } from '../helpers/engine.ts';

type StrandModule = typeof import('../../src/physics/strand.ts');

const ID = 'P3';
const MOVING_STEPS = 10_000;
const MAX_TIP_SPEED = 20; // torso heights per second
const SETTLE_S = 2;
const SETTLED_PX = 0.5; // per drawing (§10 definitions)
const SLOWEST_DPS = 8; // §7: drawingsPerSecond is 12 | 8; the longer drawing is the stricter window
const HOLD_S = 5;
const ev = new Evidence(ID, [
  'modules load',
  'DEFAULT_PHYSICS matches SPEC §8.7',
  'no NaN',
  'tip speed (max over every step)',
  'settled within 2 s of the anchor stopping',
]);
afterAll(() => ev.write());

const SEEDS = [301, 302, 303];
const CONFIGS: { kind: 'strand' | 'rigid'; stiffness: number }[] = [
  { kind: 'strand', stiffness: 0 },
  { kind: 'strand', stiffness: 0.3 },
  { kind: 'strand', stiffness: 1 },
  { kind: 'rigid', stiffness: 1 },
];

interface Run {
  label: string;
  nonFinite: number;
  firstNonFiniteStep: number | null;
  maxTipSpeed: number;
  maxTipSpeedStep: number;
  worstMoveAfter2s: number;
  settledAtS: number | null;
}

function simulate(strand: StrandModule, seed: number, kind: 'strand' | 'rigid', stiffness: number): Run {
  const params = specParams();
  const motion = randomMotion(seed);
  const shape = tendril(seed * 11 + 3);
  const last = shape.length - 1;
  const stopT = MOVING_STEPS * params.dt;
  const targetAt = (s: number) => {
    const pose = motion(Math.min(s * params.dt, stopT));
    return { pose, px: shape.map((p): V2 => torsoToPx(pose, p)) };
  };
  const chain = strand.createChain(targetAt(0).px, kind, stiffness);
  const run: Run = {
    label: `${kind} stiffness ${stiffness}, seed ${seed}`,
    nonFinite: 0,
    firstNonFiniteStep: null,
    maxTipSpeed: 0,
    maxTipSpeedStep: 0,
    worstMoveAfter2s: 0,
    settledAtS: null,
  };
  const holdSteps = Math.round(HOLD_S / params.dt);
  const window = Math.round(1 / SLOWEST_DPS / params.dt);
  const settleStep = Math.round(SETTLE_S / params.dt);
  const held: V2[] = []; // tip after each hold step; held[0] = tip at the stop
  let prevTip = [...(chain.points[last] as V2)] as V2;
  for (let s = 1; s <= MOVING_STEPS + holdSteps; s++) {
    const { pose, px } = targetAt(s);
    strand.stepChain(chain, px, pose.unit, params);
    const pts = chain.points as V2[];
    let bad = 0;
    for (const p of pts) if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) bad++;
    if (pts.length !== shape.length) bad++;
    if (bad) {
      run.nonFinite += bad;
      run.firstNonFiniteStep ??= s;
    }
    const tip: V2 = [pts[last]![0], pts[last]![1]];
    const speed = dist(tip, prevTip) / params.dt / pose.unit;
    const sp = Number.isFinite(speed) ? speed : Infinity;
    if (sp > run.maxTipSpeed) {
      run.maxTipSpeed = sp;
      run.maxTipSpeedStep = s;
    }
    prevTip = tip;
    if (s >= MOVING_STEPS) held.push(tip);
  }
  // Drawing-long windows [i, i + window] over the hold, i counted in steps since the stop.
  const moves: number[] = [];
  for (let i = 0; i + window < held.length; i++) {
    const m = dist(held[i + window]!, held[i]!);
    moves.push(Number.isFinite(m) ? m : Infinity);
  }
  for (let i = settleStep; i < moves.length; i++) run.worstMoveAfter2s = Math.max(run.worstMoveAfter2s, moves[i]!);
  // Report when it actually settled: the first window after which every window stays under 0.5 px.
  let lastBad = -1;
  for (let i = 0; i < moves.length; i++) if (!(moves[i]! < SETTLED_PX)) lastBad = i;
  run.settledAtS = lastBad < moves.length - 1 ? (lastBad + 1) * params.dt : null;
  return run;
}

describe('P3 10,000 steps of seeded random anchor motion', () => {
  it('P3 no NaN, tip speed < 20 torso heights/s, and settled within 2 s once the anchor stops', async () => {
    const strand = await recorded(ev, 'modules load', 'src/physics/strand.ts exports createChain, stepChain, DEFAULT_PHYSICS', () =>
      need('src/physics/strand.ts', { createChain: 'function', stepChain: 'function', DEFAULT_PHYSICS: 'object' }, () => import('../../src/physics/strand.ts')),
    );

    const spec = specParams();
    const d = strand.DEFAULT_PHYSICS as unknown as Record<string, unknown>;
    const mismatched = (Object.keys(spec) as (keyof typeof spec)[]).filter((k) => {
      const v = d[k];
      return typeof v !== 'number' || Math.abs(v - (spec[k] as number)) > 1e-12;
    });
    ev.record('DEFAULT_PHYSICS matches SPEC §8.7', { DEFAULT_PHYSICS: d }, spec, mismatched.length === 0,
      mismatched.length ? `differs from SPEC §8.7 in: ${mismatched.join(', ')}` : '');

    const runs: Run[] = [];
    for (const seed of SEEDS) for (const c of CONFIGS) runs.push(simulate(strand, seed, c.kind, c.stiffness));

    const nonFinite = runs.filter((r) => r.nonFinite > 0);
    ev.record('no NaN', nonFinite.map((r) => `${r.label}: ${r.nonFinite} bad values, first at step ${r.firstNonFiniteStep}`), [], nonFinite.length === 0);

    const fastest = runs.reduce((a, b) => (b.maxTipSpeed > a.maxTipSpeed ? b : a));
    ev.record('tip speed (max over every step)', { torsoHeightsPerS: fastest.maxTipSpeed, worst: `${fastest.label}, step ${fastest.maxTipSpeedStep}` },
      `< ${MAX_TIP_SPEED} torso heights/s`, fastest.maxTipSpeed < MAX_TIP_SPEED);

    const unsettled = runs.filter((r) => !(r.worstMoveAfter2s < SETTLED_PX));
    const worstSettle = runs.reduce((a, b) => (b.worstMoveAfter2s > a.worstMoveAfter2s ? b : a));
    ev.record(
      'settled within 2 s of the anchor stopping',
      {
        worstTipMovePerDrawingAfter2sPx: worstSettle.worstMoveAfter2s,
        worst: worstSettle.label,
        settledAtS: Object.fromEntries(runs.map((r) => [r.label, r.settledAtS])),
      },
      `tip moves < ${SETTLED_PX} px per drawing (1/${SLOWEST_DPS} s) from ${SETTLE_S} s after the stop on`,
      unsettled.length === 0,
      unsettled.length ? `not settled by ${SETTLE_S} s: ${unsettled.map((r) => `${r.label} (settled at ${r.settledAtS ?? `never in ${HOLD_S} s`})`).join('; ')}` : '',
    );

    expect(mismatched, `P3 DEFAULT_PHYSICS differs from SPEC §8.7 in ${mismatched.join(', ')}`).toEqual([]);
    expect(nonFinite.map((r) => r.label), 'P3 NaN or Infinity in the chain').toEqual([]);
    expect(fastest.maxTipSpeed, `P3 tip speed ${fastest.maxTipSpeed} torso heights/s (${fastest.label})`).toBeLessThan(MAX_TIP_SPEED);
    expect(unsettled.map((r) => r.label), `P3 not settled within ${SETTLE_S} s of the stop`).toEqual([]);
  });
});
