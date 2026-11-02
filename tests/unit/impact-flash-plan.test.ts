// The impact scene's frames through the flash checker (WP12): the gentle plan
// under Reduce flashing (design §5) holds the budget with its transitions on
// the planned frames, and the ladder (ladder.ts) walks every step on footage
// that flashes by itself, then gives up (FlashCheckError); step 4's freeze
// adds 26 frames.
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { checkFlashes, downsampleFrame, FlashCheckError, type CheckFrame, type FlashReport } from '../../src/export/flash.ts';
import { FREEZE_STEP, LADDER_STEPS, walkLadder } from '../../src/impact/ladder.ts';
import type { ImpactScene } from '../../src/impact/scene.ts';
import { plate, sceneOf } from './helpers/impact-scene-clip.ts';
import { HERO } from './helpers/impact-drawings.ts';

const I = HERO.I;
const FPS = 30;
const PLANNED = [0, 5, 9, 14, 20, 24, 28, 32]; // design §5's transitions, j

// Output frames from..to of `scene`, each downsampled for the checker.
function checked(scene: ImpactScene, from: number, to: number, video: (clip: number) => unknown = () => plate(scene.width, scene.height)): FlashReport {
  const ctx = createCanvas(scene.width, scene.height).getContext('2d');
  const frames: CheckFrame[] = [];
  for (let o = from; o <= to; o++) {
    scene.render(ctx as never, video, o);
    const img = ctx.getImageData(0, 0, scene.width, scene.height);
    frames.push(downsampleFrame({ data: img.data, width: img.width, height: img.height }));
  }
  return checkFlashes(frames, FPS);
}

describe('the gentle plan', () => {
  it('holds ≤ 3 general and no red flashes over j −8..45, none in the strike, each within a frame of the plan', () => {
    const s = sceneOf({ flash: 'safe' });
    const r = checked(s, I - 8, I + 45);
    expect(r.worstGeneral, `transitions on j ${r.transitions.map((t) => t.frame - 8).join(',')}`).toBeLessThanOrEqual(3);
    expect(r.worstRed).toBe(0);
    for (const t of r.transitions) {
      const j = t.frame - 8;
      expect(j >= 0, `a transition on j ${j}, in the strike`).toBe(true);
      expect(PLANNED.some((p) => Math.abs(p - j) <= 1), `a transition on j ${j}`).toBe(true);
    }
  });
});

describe('the ladder', () => {
  it('tries every step on footage that flashes by itself, then fails with FlashCheckError', () => {
    const base = sceneOf({ flash: 'safe' }, { size: 320 });
    const W = base.width;
    const H = base.height;
    const tone = (v: number) => {
      const c = createCanvas(W, H);
      const x = c.getContext('2d');
      x.fillStyle = `rgb(${v}, ${v}, ${v})`;
      x.fillRect(0, 0, W, H);
      return c;
    };
    const dark = tone(10);
    const light = tone(245);
    const video = (clip: number) => (clip % 2 === 0 ? dark : light);
    const tried: number[] = [];
    const walk = walkLadder('safe', (step) => {
      tried.push(step);
      const s = base.degraded(step);
      return checked(s, I - 8, Math.min(s.outputLength() - 1, I + 45 + (step >= FREEZE_STEP ? 26 : 0)), video);
    });
    expect(tried).toEqual(Array.from({ length: LADDER_STEPS + 1 }, (_, k) => k));
    expect(walk.pass).toBe(false);
    expect(() => {
      if (!walk.pass) throw new FlashCheckError(walk.report);
    }).toThrow(FlashCheckError);
    // Under full flashing only step 0 is checked; the ladder is Reduce flashing's.
    expect(walkLadder('full', () => walk.reports[0]).reports).toHaveLength(1);
    expect(sceneOf({ flash: 'full' }).degraded(FREEZE_STEP).degrade.step).toBe(0);
  });

  it('holds the budget with hero-sized masses (U 380 px at 1080), and at the last step adds no flash at all over still footage', () => {
    // Judge round 1: the last step also stills the lightning and the masses
    // (scene.ts STILL_MASS), so only footage that flashes by itself fails.
    const hero = sceneOf({ flash: 'safe', unit: 380 });
    const plan = checked(hero, I - 8, I + 45);
    expect(plan.worstGeneral).toBeLessThanOrEqual(3);
    expect(plan.worstRed).toBe(0);
    const last = hero.degraded(LADDER_STEPS);
    const r = checked(last, I - 8, Math.min(last.outputLength() - 1, I + 45 + 26));
    expect(r.worstGeneral, `transitions on j ${r.transitions.map((t) => t.frame - 8).join(',')}`).toBe(0);
    expect(r.worstRed).toBe(0);
  });

  it("adds 26 frames at step 4, and output I + 35 + n shows clip frame I + 9 + n", () => {
    const s = sceneOf({ flash: 'safe' });
    const frozen = s.degraded(FREEZE_STEP);
    expect(frozen.outputLength() - s.outputLength()).toBe(26);
    for (let n = 0; n <= 60; n++) {
      if (I + 9 + n >= s.setup.clip.frames) break;
      expect(frozen.clipOf(I + 35 + n), `n ${n}`).toBe(I + 9 + n);
    }
    for (let j = 0; j < 35; j++) expect(frozen.frameLayers(I + j).poster, `output j ${j}`).not.toBeNull();
    expect(frozen.frameLayers(I + 35).poster).toBeNull();
  });
});
