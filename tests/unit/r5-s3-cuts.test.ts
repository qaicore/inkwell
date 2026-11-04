// Round 5, S3: what the judges said does not belong on screen is cut: the A1-2 zigzag crown and the
// A3-4 white dome (wisps), the half-screen cyan panels (floods), and IF4's flat black star over his
// solid body. Offline and deterministic.
import { describe, expect, it } from 'vitest';
import { CUT_KINDS, wispKind, wispTable } from '../../src/impact/aftermath/wisps.ts';
import { FLOODS } from '../../src/impact/aftermath/washes.ts';
import { brown, lifted } from '../../src/impact/aftermath/cluster.ts';

describe('round 5 cuts', () => {
  it('lays no zigzag crown (A1-2) and no white dome (A3-4), but keeps the spikes and the splashes', () => {
    for (let A = 1; A <= 4; A++) {
      expect(wispKind(A), `A${A}`).toBeNull();
      expect(wispTable(A), `A${A} geometry`).not.toBeNull(); // the measured geometry stays testable
    }
    expect(CUT_KINDS).toEqual(['slashes', 'arcs']);
    expect(wispKind(0)?.kind).toBe('spikes');
    for (let A = 7; A <= 13; A++) expect(wispKind(A)?.kind, `A${A}`).toBe('splashes');
    expect(wispKind(5)).toBeNull();
    expect(wispKind(14)).toBeNull();
  });

  it('keeps every flood a low band: at most a tenth of the frame, on the floor side', () => {
    for (const f of FLOODS) {
      expect(f.area, `A${f.A}`).toBeLessThanOrEqual(0.1);
      expect(Math.abs(f.dir), `A${f.A}`).toBeGreaterThanOrEqual(165);
    }
  });

  it('lifts the smoke lumps toward a warm light grey, never darker', () => {
    const sum = (hex: string) => [1, 3, 5].reduce((n, k) => n + parseInt(hex.slice(k, k + 2), 16), 0);
    for (let at = 0; at <= 4; at += 0.5) {
      const base = brown(at);
      expect(lifted(base), `at ${at}`).toMatch(/^#[0-9a-f]{6}$/);
      expect(sum(lifted(base)), `at ${at}`).toBeGreaterThan(sum(base) + 60);
    }
  });
});
