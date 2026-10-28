import { describe, expect, it } from 'vitest';
import { BRUSH_IDS, FINE_TIP_SIZE, GRAIN, NEON_GLOW, brushSettings, endsOf } from '../../src/render/brushes.ts';
import { renderPng } from '../../src/render/headless.ts';
import type { PlacedStroke } from '../../src/motion/animate.ts';
import type { BrushId, Effect, Vec2 } from '../../src/types/effect.ts';

const INK = { size: 28, thinning: 0.65, smoothing: 0.6, streamline: 0.45 };

function effect(brush: BrushId | undefined, extra: Partial<Effect> = {}): Effect {
  const points: Vec2[] = Array.from({ length: 32 }, (_, i) => [i / 31, 0.2 * Math.sin(i / 5)]);
  return {
    version: 1,
    brush: INK,
    palette: ['#1b1b1f', '#c8323c', '#3fd0ff'],
    timing: { drawingsPerSecond: 12 },
    strokes: [1, 2].map((id) => ({
      id,
      color: 1,
      ...(brush ? { brush } : {}),
      kind: 'strand',
      anchor: { type: 'concept', prompt: 'person' },
      bodyAngle: 0,
      stiffness: 1,
      wobble: 0,
      views: { front: { points, pressure: points.map(() => 0.6), root: points[0], layer: 'front' } },
    })),
    overrides: {},
    ...extra,
  };
}

// A gentle curve on a 300 × 200 canvas; `wide` makes a bigger one that fills it.
function placed(id: number, wide = false): PlacedStroke {
  const points = Array.from({ length: 32 }, (_, i): Vec2 => (wide ? [10 + i * 9, 100 + 70 * Math.sin(i / 3)] : [30 + i * 6, 80 + 25 * Math.sin(i / 6)]));
  return { id, points, pressure: points.map(() => 0.6), layer: 'front' };
}

describe('brushSettings', () => {
  it('builds the §8.8 defaults from the ink brush', () => {
    const e = effect('ink');
    expect(brushSettings(e, 'ink')).toBe(e.brush);
    expect(brushSettings(e, 'fine-ink').size).toBeCloseTo(FINE_TIP_SIZE * INK.size);
    expect(brushSettings(e, 'fine-ink').thinning).toBeGreaterThan(INK.thinning);
    expect(brushSettings(e, 'textured').grain).toBe(GRAIN);
    expect(brushSettings(e, 'fine-textured')).toMatchObject({ size: FINE_TIP_SIZE * INK.size, grain: GRAIN });
    for (const id of ['neon-straight', 'neon-round'] as const) expect(brushSettings(e, id).glow).toEqual(NEON_GLOW);
    expect(brushSettings(e, 'neon-straight').thinning).toBe(0);
  });

  it("uses the effect's own settings over the defaults", () => {
    const e = effect('textured', { brushes: { textured: { ...INK, grain: 0.6 } } });
    expect(brushSettings(e, 'textured').grain).toBe(0.6);
    expect(brushSettings(e, 'fine-textured').grain).toBe(GRAIN);
  });

  it('reads straight vs round as the end shape', () => {
    expect(endsOf('neon-straight')).toBe('flat');
    expect(BRUSH_IDS.filter((id) => endsOf(id) === 'flat')).toEqual(['neon-straight']);
  });
});

describe('drawing the brushes', () => {
  it('a reused scratch buffer never carries one stroke into the next', () => {
    for (const id of ['textured', 'neon-round'] as const) {
      const e = effect(id);
      const alone = renderPng(300, 200, [placed(1)], e);
      renderPng(300, 200, [placed(2, true)], e); // a bigger stroke through the same buffers, so they're left larger and dirty
      expect(renderPng(300, 200, [placed(1)], e).equals(alone), id).toBe(true);
    }
  });

  it('the neon flicker changes with the drawing index and repeats for the same one', () => {
    const e = effect('neon-straight');
    const k3 = renderPng(300, 200, [placed(1)], e, 1, 3);
    expect(renderPng(300, 200, [placed(1)], e, 1, 3).equals(k3)).toBe(true);
    const others = [4, 5, 6].map((k) => renderPng(300, 200, [placed(1)], e, 1, k));
    expect(others.some((png) => !png.equals(k3))).toBe(true);
  });

  it('grain is seeded by the stroke id', () => {
    const e = effect('textured');
    expect(renderPng(300, 200, [placed(1)], e).equals(renderPng(300, 200, [placed(2)], e))).toBe(false);
  });

  it('a stroke with no brush renders as ink', () => {
    expect(renderPng(300, 200, [placed(1)], effect(undefined)).equals(renderPng(300, 200, [placed(1)], effect('ink')))).toBe(true);
  });
});
