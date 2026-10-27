import { describe, expect, it } from 'vitest';
import { compareTake, validateTake, type Take } from '../../src/app/take.ts';

const hex = (c: string) => c.repeat(64);
const take = (source: string, converted: string): Take => ({
  source: { name: 'IMG_0412.MOV', bytes: 1000, sha256: hex(source) },
  sha256: hex(converted),
  frames: 300,
  width: 1080,
  height: 1920,
});

describe('which take a saved clip.mp4 is', () => {
  const open = take('a', '1');

  it('is the same take when the bytes match, or when it was converted from the same file', () => {
    expect(compareTake(open, { bytes: 1, sha256: hex('1'), take: null })).toBe('same');
    // Converting again gives other bytes from the same phone file: still the same take.
    expect(compareTake(open, { bytes: 1, sha256: hex('2'), take: take('a', '2') })).toBe('same');
  });

  it('is another take when it was converted from another file', () => {
    expect(compareTake(open, { bytes: 1, sha256: hex('3'), take: take('b', '3') })).toBe('different');
  });

  it("can't tell without a source.json, or with one that describes other bytes", () => {
    expect(compareTake(open, { bytes: 1, sha256: hex('2'), take: null })).toBe('unknown');
    expect(compareTake(open, { bytes: 1, sha256: hex('4'), take: take('a', '2') })).toBe('unknown');
  });

  it('reads only a complete source.json', () => {
    expect(validateTake(JSON.parse(JSON.stringify(open)))).toEqual(open);
    expect(validateTake({ ...open, sha256: 'not a hash' })).toBeNull();
    expect(validateTake({ ...open, source: { name: 'x', bytes: -1, sha256: hex('a') } })).toBeNull();
    expect(validateTake(null)).toBeNull();
  });
});
