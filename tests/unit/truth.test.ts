import { describe, expect, it } from 'vitest';
import {
  addStill,
  emptyTruth,
  markFrames,
  removeStillAt,
  serializeTruth,
  setFacing,
  setRoot,
  stillAt,
  validateTruth,
} from '../../src/app/truth.ts';

describe('truth: building a label file', () => {
  it('lists the frames to mark, from 0 up to the last frame', () => {
    expect(markFrames(31, 10)).toEqual([0, 10, 20, 30]);
    expect(markFrames(30, 10)).toEqual([0, 10, 20]);
    expect(markFrames(13, 6)).toEqual([0, 6, 12]);
  });

  it('keeps one root per frame, in frame order, rounded to whole pixels', () => {
    let t = emptyTruth('side-step');
    t = setRoot(t, 20, [100.4, 200.6]);
    t = setRoot(t, 0, [1, 2]);
    t = setRoot(t, 20, [110, 210]); // a second click on frame 20 replaces the first
    expect(t.roots).toEqual([
      { frame: 0, xy: [1, 2] },
      { frame: 20, xy: [110, 210] },
    ]);
    expect(setRoot(t, 0, null).roots).toEqual([{ frame: 20, xy: [110, 210] }]);
  });

  it('keeps one facing label per frame', () => {
    let t = setFacing(emptyTruth('walk'), 12, 'back');
    t = setFacing(t, 6, 'right');
    t = setFacing(t, 12, 'left');
    expect(t.facing).toEqual([
      { frame: 6, label: 'right' },
      { frame: 12, label: 'left' },
    ]);
    expect(setFacing(t, 6, null).facing).toEqual([{ frame: 12, label: 'left' }]);
  });

  it('merges still stretches that overlap or touch, whichever way they were dragged', () => {
    let t = addStill(emptyTruth('walk'), 165, 120);
    expect(t.still).toEqual([[120, 165]]);
    t = addStill(t, 10, 20);
    t = addStill(t, 166, 170); // touches 120..165
    expect(t.still).toEqual([
      [10, 20],
      [120, 170],
    ]);
    t = addStill(t, 15, 125); // bridges both
    expect(t.still).toEqual([[10, 170]]);
    expect(stillAt(t, 10)).toBe(true);
    expect(stillAt(t, 171)).toBe(false);
    expect(removeStillAt(t, 50).still).toEqual([]);
  });
});

describe('truth: the saved file', () => {
  it('writes the SPEC §11 shape and reads back to the same truth', () => {
    let t = emptyTruth('side-step');
    t = setRoot(t, 0, [512, 840]);
    t = setFacing(t, 0, 'front');
    t = addStill(t, 120, 165);
    const text = serializeTruth(t);
    expect(JSON.parse(text)).toEqual({
      clip: 'side-step',
      fps: 30,
      roots: [{ frame: 0, xy: [512, 840] }],
      facing: [{ frame: 0, label: 'front' }],
      still: [[120, 165]],
    });
    expect(validateTruth(JSON.parse(text))).toEqual({ truth: t });
    expect(text.endsWith('}\n')).toBe(true);
  });

  it('writes empty lists as []', () => {
    expect(JSON.parse(serializeTruth(emptyTruth('walk')))).toEqual(emptyTruth('walk'));
  });

  it('lists every problem in a bad file instead of accepting it', () => {
    const bad = {
      clip: 'Side Step',
      fps: 24,
      roots: [{ frame: 10, xy: [1, 2] }, { frame: 0, xy: [1] }],
      facing: [{ frame: 0, label: 'sideways' }],
      still: [[5, 2], [0, 10], [8, 12]],
    };
    const result = validateTruth(bad);
    expect('problems' in result).toBe(true);
    const problems = 'problems' in result ? result.problems : [];
    expect(problems.some((p) => p.startsWith('"clip"'))).toBe(true);
    expect(problems.some((p) => p.startsWith('"fps"'))).toBe(true);
    expect(problems.some((p) => p.startsWith('roots[1]'))).toBe(true);
    expect(problems.some((p) => p.startsWith('"roots" must be in frame order'))).toBe(true);
    expect(problems.some((p) => p.startsWith('facing[0]'))).toBe(true);
    expect(problems.some((p) => p.startsWith('still[0]'))).toBe(true);
    expect(problems.some((p) => p.startsWith('still[2] overlaps'))).toBe(true);
    expect(validateTruth([])).toEqual({ problems: ['truth.json must be a JSON object'] });
  });
});
