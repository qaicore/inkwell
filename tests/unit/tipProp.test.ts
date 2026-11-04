import { describe, expect, it } from 'vitest';
import type { Tube } from '../../src/impact/contracts.ts';
import { addPropStroke, drawTipProps, livePropsOf, newPropState, rigid, tipPose, undoPropStroke } from '../../src/impact/tipProp.ts';

const tube = (pts: [number, number][], r = 4): Tube =>
  ({ id: 7, sections: pts.map((screen) => ({ screen, r, front: true })) }) as unknown as Tube;

describe('tipProp rigid transform', () => {
  it('moves with the tip and turns with its direction', () => {
    const ref = tipPose(tube([[0, 0], [10, 0], [20, 0], [30, 0]]))!;
    const now = tipPose(tube([[100, 50], [100, 60], [100, 70], [100, 80]]))!; // now pointing down (+90 deg)
    const [a, b, c, d, e, f] = rigid(ref, now);
    // a point 10 px ahead of the old tip lands 10 px below the new tip
    const x = 10;
    expect(a * x + e).toBeCloseTo(100, 6);
    expect(b * x + f).toBeCloseTo(90, 6);
    expect(c * 0 + d * 0 + e).toBeCloseTo(100, 6);
  });
  it('is the identity-at-the-tip on the draw frame', () => {
    const ref = tipPose(tube([[0, 0], [5, 5], [10, 10]]))!;
    expect(rigid(ref, ref)).toEqual([1, 0, -0, 1, 10, 10].map((v, i) => (i === 4 || i === 5 ? 10 : v)));
  });
  it('scales with the tip radius, clamped', () => {
    const ref = tipPose(tube([[0, 0], [10, 0]], 4))!;
    expect(rigid(ref, tipPose(tube([[0, 0], [10, 0]], 6))!)[0]).toBeCloseTo(1.5, 6);
    expect(rigid(ref, tipPose(tube([[0, 0], [10, 0]], 100))!)[0]).toBe(2);
  });
});

describe('tipProp without props', () => {
  it('draws nothing and touches no canvas', () => {
    const calls: string[] = [];
    const ctx = new Proxy({}, { get: (_t, k) => () => calls.push(String(k)) }) as unknown as CanvasRenderingContext2D;
    const sc = { props: undefined, tubeAt: () => undefined, make: () => { throw new Error('no raster'); }, s: 1, S: 1000, palette: ['#000', '#111', '#222'] as never };
    drawTipProps(sc, tube([[0, 0], [10, 0]]), ctx, ctx);
    drawTipProps({ ...sc, props: [] }, tube([[0, 0], [10, 0]]), ctx, ctx);
    expect(calls).toEqual([]);
    expect(livePropsOf([], new Set([1]))).toBeUndefined();
  });
});

describe('tipProp collecting', () => {
  const limbs = [{ id: 1, frame: 3, points: [[0, 0, 1], [100, 0, 1]] }, { id: 2, frame: 3, points: [[0, 0, 1], [0, 200, 1]] }];
  const stroke = (id: number, x: number, y: number) => ({ id, frame: 3, color: 0 as const, size: 10, points: [[x, y, 0.5], [x + 5, y + 5, 0.5]] });
  it('refuses with a note when there is no limb', () => {
    const st = newPropState();
    expect(addPropStroke(st, stroke(5, 0, 0), [])).toMatch(/limb/);
    expect(st.props).toEqual([]);
  });
  it('joins the nearest tip, then undoes by stroke', () => {
    const st = newPropState();
    expect(addPropStroke(st, stroke(5, 0, 190), limbs)).toBeNull();
    expect(addPropStroke(st, stroke(6, 10, 190), limbs)).toBeNull();
    expect(st.props).toHaveLength(1);
    expect(st.props[0].limb).toBe(2);
    expect(st.props[0].strokes).toHaveLength(2);
    expect(undoPropStroke(st, 4)).toBe(true);
    expect(undoPropStroke(st, 4)).toBe(true);
    expect(st.props).toEqual([]);
    expect(undoPropStroke(st, 4)).toBe(false);
  });
  it('keeps at most 4 props', () => {
    const st = newPropState();
    for (let i = 0; i < 4; i++) { st.open = null; expect(addPropStroke(st, stroke(10 + i, 99, 0), limbs)).toBeNull(); }
    st.open = null;
    expect(addPropStroke(st, stroke(20, 99, 0), limbs)).toMatch(/at most/);
  });
});
