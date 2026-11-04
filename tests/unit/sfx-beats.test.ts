import { describe, expect, it } from 'vitest';
import { BeatClock, type Beats } from '../../src/app/sfx';

const beats: Beats = {
  list: [
    { frame: 76, kind: 'whoosh' },
    { frame: 84, kind: 'slam' },
    { frame: 84, kind: 'rumble' },
  ],
  aliveFrom: 60,
  aliveTo: 130,
};

const run = (frames: number[], from = frames[0]) => {
  const c = new BeatClock();
  c.start(from);
  return frames.flatMap((f) => c.step(f, beats).beats.map((b) => `${f}:${b.kind}`));
};

describe('beat crossing', () => {
  it('fires each beat once on a steady play', () => {
    const fired = run(Array.from({ length: 100 }, (_, i) => 50 + i));
    expect(fired).toEqual(['76:whoosh', '84:slam', '84:rumble']);
  });
  it('still fires when the beat frame was dropped', () => {
    expect(run([70, 75, 79, 86, 90])).toEqual(['79:whoosh', '86:slam', '86:rumble']);
  });
  it('does not fire for a beat before the start frame, and fires one on it', () => {
    expect(run([80, 81, 90])).toEqual(['90:slam', '90:rumble']);
    expect(run([84, 85])).toEqual(['84:slam', '84:rumble']);
  });
  it('fires again on a replay (the clock goes back), but not twice in one pass', () => {
    const c = new BeatClock();
    c.start(70);
    const seq = [70, 76, 76, 84, 85, 3, 40, 76, 84];
    const fired = seq.flatMap((f) => c.step(f, beats).beats.map((b) => `${f}:${b.kind}`));
    expect(fired).toEqual(['76:whoosh', '84:slam', '84:rumble', '76:whoosh', '84:slam', '84:rumble']);
  });
  it('counts alive frames only inside the window', () => {
    const c = new BeatClock();
    c.start(0);
    expect(c.step(10, beats).alive).toBe(0);
    expect(c.step(62, beats).alive).toBe(3);
    expect(c.step(200, beats).alive).toBe(130 - 63 + 1);
  });
});
