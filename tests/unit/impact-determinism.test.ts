// The impact scene is a pure function of the effect, the clip and the frame
// (WP12): I − 10..I + 45 rendered twice hash the same, a frame drawn on a
// fresh scene equals the same frame drawn in sequence, and the scene's own
// files read no clock and no Math.random.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import type { ImpactScene } from '../../src/impact/scene.ts';
import { plate, sceneOf } from './helpers/impact-scene-clip.ts';
import { HERO } from './helpers/impact-drawings.ts';

const I = HERO.I;
const FROM = I - 10;
const TO = I + 45;

// Every output frame from..to, in order on one canvas, as the preview draws them.
function hashes(scene: ImpactScene, from: number, to: number): string[] {
  const canvas = createCanvas(scene.width, scene.height);
  const ctx = canvas.getContext('2d');
  const out: string[] = [];
  for (let o = from; o <= to; o++) {
    scene.render(ctx as never, plate(scene.width, scene.height), o);
    out.push(createHash('sha1').update(ctx.getImageData(0, 0, scene.width, scene.height).data).digest('hex'));
  }
  return out;
}

describe('determinism', () => {
  // Eight fresh scenes, each with its own physics and body scan: about 47 s
  // alone and 60–67 s under the whole unit suite (Nov 2), past the default
  // 60 s. Its own timeout is a hang guard, nearly twice that, not a budget.
  it('renders I − 10..I + 45 to the same hashes twice, and each sampled frame alone as it was in sequence', { timeout: 120_000 }, () => {
    const first = hashes(sceneOf(), FROM, TO);
    const second = hashes(sceneOf(), FROM, TO);
    expect(second).toEqual(first);
    expect(new Set(first).size).toBeGreaterThan(30); // it moves
    for (const o of [I - 7, I + 3, I + 9, I + 16, I + 22, I + 37]) {
      expect(hashes(sceneOf(), o, o)[0], `f${o} alone`).toBe(first[o - FROM]);
    }
  });

  it('draws the same frames under Reduce flashing, run twice', () => {
    const a = hashes(sceneOf({ flash: 'safe' }), I - 2, I + 12);
    const b = hashes(sceneOf({ flash: 'safe' }), I - 2, I + 12);
    expect(b).toEqual(a);
  });

  it('reads no clock and no Math.random in the scene, the tiers or the ladder', () => {
    for (const file of ['scene', 'tiers', 'ladder']) {
      const src = readFileSync(new URL(`../../src/impact/${file}.ts`, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
      expect(src, file).not.toMatch(/Math\.random|Date\.now|new Date|performance\.now|\.filter\s*=/);
    }
  });
});
