// WP1: the limbs grow out on the frame they were drawn on (impact design §1),
// through the existing emerge moment, so emergeAges counts 'limb' strokes as
// well as 'electric' ones.
import { describe, expect, it } from 'vitest';
import { emergeAges } from '../../src/motion/moments.ts';
import { momentsFromDrawings } from '../../src/impact/detect.ts';
import { drawingIndex } from '../../src/motion/timing.ts';
import type { BrushId, Effect, EmergeMoment, Stroke } from '../../src/types/effect.ts';

const stroke = (id: number, brush?: BrushId): Stroke => ({
  id,
  color: 0,
  ...(brush ? { brush } : {}),
  kind: 'strand',
  anchor: { type: 'concept', prompt: 'person' },
  bodyAngle: 180,
  stiffness: 0.1,
  wobble: 0,
  views: { front: { points: [[0, 0], [0, -1]], pressure: [1, 1], root: [0, 0], layer: 'behind' } },
});

const effectWith = (strokes: Stroke[], moments: EmergeMoment[]): Effect => ({
  version: 1,
  brush: { size: 10, thinning: 0.6, smoothing: 0.5, streamline: 0.5 },
  palette: ['#e8203a', '#f4f1ea', '#16141a'],
  timing: { drawingsPerSecond: 12 },
  strokes,
  moments,
  overrides: {},
});

// Limbs 1–2, an electric bolt 3, ink 4 and an unset brush 5 (ink).
const STROKES = [stroke(1, 'limb'), stroke(2, 'limb'), stroke(3, 'electric'), stroke(4, 'ink'), stroke(5)];
const K22 = drawingIndex(22, 12); // the hero's limbs, drawn on f22: drawing 8

describe('emergeAges counts limb strokes', () => {
  it('covers every limb and electric stroke when the moment lists none', () => {
    const ages = emergeAges(effectWith(STROKES, [{ kind: 'emerge', at: 22 / 30 }]), K22 + 3);
    expect([...ages.keys()].sort()).toEqual([1, 2, 3]);
    expect(ages.get(1)).toBe(3);
    expect(ages.get(2)).toBe(3);
  });

  it('counts back from the emerge drawing: negative before, 0 on it', () => {
    const effect = effectWith(STROKES, [{ kind: 'emerge', at: 22 / 30 }]);
    expect(K22).toBe(8);
    expect(emergeAges(effect, 5).get(1)).toBe(-3);
    expect(emergeAges(effect, K22).get(1)).toBe(0);
  });

  it('keeps to the listed strokes when the moment names them', () => {
    const ages = emergeAges(effectWith(STROKES, [{ kind: 'emerge', at: 1, strokes: [2] }]), 20);
    expect([...ages.entries()]).toEqual([[2, 20 - drawingIndex(30, 12)]]);
  });

  it('a clip with only limbs, no electric strokes, still emerges', () => {
    const ages = emergeAges(effectWith([stroke(7, 'limb'), stroke(8, 'ink')], [{ kind: 'emerge', at: 0 }]), 4);
    expect([...ages.entries()]).toEqual([[7, 4]]);
  });

  it('takes the emerge momentsFromDrawings writes: the limbs, on the frame they were drawn', () => {
    const limbs = [{ id: 1, points: [[778, 300], [414.6, 159.1]] }, { id: 2, points: [[838, 300], [1200, 160]] }];
    const cracks = [{ id: 11, points: [[942, 1061], [510, 1060]] }];
    const { emerge } = momentsFromDrawings({ limbs, f1: 22, cracks, fDrawn: 84, masks: [], S: 1080 });
    const ages = emergeAges(effectWith(STROKES, [emerge]), K22 + 1);
    expect([...ages.entries()]).toEqual([[1, 1], [2, 1]]); // the electric stroke 3 isn't in this moment
  });
});
