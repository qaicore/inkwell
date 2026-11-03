// The impact scene (WP12) on the synthetic slam (helpers/impact-scene-clip.ts):
// the phases and what each one draws, the posters over the stack, the limbs'
// tube, stamp and grid drawings, the 2s and 1s clocks, the scars at J_end,
// portrait, no turn without a tap, and the render-ahead jobs.
import { createHash } from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { GROUP_HOLD, drawingStart, jEnd, kr, limbDrawingAt, massGroup } from '../../src/impact/clock.ts';
import { posterLayout } from '../../src/impact/frames/layout.ts';
import type { Matrix } from '../../src/render/limb.ts';
import { limbsFirst } from '../../src/lift/strike.ts';
import { drawingIndex } from '../../src/motion/timing.ts';
import type { ImpactScene, SceneLayers } from '../../src/impact/scene.ts';
import { LIMB_IDS, PLATE, plate, renderAt, sceneOf } from './helpers/impact-scene-clip.ts';
import { HERO, HERO_CRACKS } from './helpers/impact-drawings.ts';
import { strokeOutline } from '../../src/render/brush.ts';
import type { Vec2 } from '../../src/types/effect.ts';

const I = HERO.I; // 84
const DPS = 12;
const STRIKE = limbsFirst(I);

const hash = (data: Uint8ClampedArray) => createHash('sha1').update(data).digest('hex');
const names = (L: SceneLayers) => L.parts.map((p) => p.name);
const part = (L: SceneLayers, name: string) => L.parts.find((p) => p.name === name);
const apply = (T: Matrix, p: readonly number[]): [number, number] => [T[0] * p[0] + T[2] * p[1] + T[4], T[1] * p[0] + T[3] * p[1] + T[5]];
const LIMB_LAYERS = new Set(['limbsBehind', 'limbsFront', 'limbGlow', 'glow']);

let full: ReturnType<typeof sceneOf> | null = null;
const scene = () => (full ??= sceneOf());

describe('the phases', () => {
  it('runs coil, strike, posters, aftermath, decay and after on f70, 76, 77, 84, 86, 93, 97, 106, 116, 129 and 130', () => {
    const s = scene();
    const expected: Record<number, unknown> = {
      70: { kind: 'coil' },
      76: { kind: 'strike', s: 0 },
      77: { kind: 'strike', s: 1 },
      84: { kind: 'poster', si: 0 },
      86: { kind: 'poster', si: 1 },
      93: { kind: 'aftermath', A: 0 },
      97: { kind: 'aftermath', A: 3 },
      106: { kind: 'aftermath', A: 10 },
      116: { kind: 'decay' },
      129: { kind: 'decay' },
      130: { kind: 'after' },
    };
    for (const [o, phase] of Object.entries(expected)) {
      const L = s.frameLayers(Number(o));
      expect(L.phase, `f${o}`).toMatchObject(phase as object);
      const drawn = new Set(names(L));
      const j = Number(o) - I;
      if (j <= -9) expect([...drawn].every((n) => LIMB_LAYERS.has(n)), `f${o}: ${[...drawn]}`).toBe(true);
      if (j >= -8 && j <= -1) expect(drawn.has('strike'), `f${o}`).toBe(true);
      if (j >= 0 && j <= 8) expect([...drawn], `f${o}`).toEqual(['poster']);
      if (j === 9) for (const n of ['cracks', 'fire', 'debris']) expect(drawn.has(n), `f${o} ${n}`).toBe(true);
      if (j >= 13 && j <= 31) expect(drawn.has('lightning') && (drawn.has('fire') || drawn.has('cluster')), `f${o}`).toBe(true);
      if (j > 45) expect([...drawn].filter((n) => !LIMB_LAYERS.has(n)), `f${o}`).toEqual(['cracks']);
    }
  });
});

describe('the posters', () => {
  it('replace the stack on j 0..8: no slots, camera, grade or face cut, and none of the plate shows', () => {
    const s = scene();
    for (let j = 0; j <= 8; j++) {
      const L = s.frameLayers(I + j);
      expect(L.poster, `j${j}`).not.toBeNull();
      expect(L.slots, `j${j}`).toEqual({});
      expect([L.camera, L.grade, L.faceCut, L.limbs]).toEqual([null, null, null, null]);
      expect(L.phase).toEqual({ kind: 'poster', si: kr(j) - 7 });
    }
    const W = s.width;
    const H = s.height;
    const black = createCanvas(W, H);
    const draw = (video: unknown) => {
      const ctx = createCanvas(W, H).getContext('2d');
      s.render(ctx as never, video, I + 2);
      return hash(ctx.getImageData(0, 0, W, H).data);
    };
    expect(draw(black)).toBe(draw(plate(W, H)));
  });
});

describe('the limbs', () => {
  it('show a tube, a stamp or the grid where limbDrawingAt says, and the stamps keep the pinned tips on P', () => {
    const s = scene();
    const P = s.context!.frame.P;
    const kinds = new Set<string>();
    for (let o = I - 12; o <= I + 30; o++) {
      if (o - I >= 0 && o - I <= 8) continue; // the posters draw the silhouettes
      const view = s.frameLayers(o).limbs!;
      expect(view.kind, `f${o}`).toBe(limbDrawingAt(o, I, STRIKE, true));
      kinds.add(view.kind);
      if (view.kind === 'tube') expect([view.t, view.T], `f${o}`).toEqual([o, [1, 0, 0, 1, 0, 0]]);
      if (view.kind === 'stamp') {
        expect(view.t, `f${o}`).toBe(o - 1);
        for (const tube of s.tubesAt(view.t)) {
          const tip = apply(view.T, tube.sections[tube.sections.length - 1].screen);
          expect(Math.hypot(tip[0] - P[0], tip[1] - P[1]), `f${o} limb ${tube.id}`).toBeLessThanOrEqual(0.5);
        }
      }
      if (view.kind === 'grid') {
        expect(view.t, `f${o}`).toBeLessThanOrEqual(o);
        expect(o - view.t, `f${o}`).toBeLessThanOrEqual(2);
        expect(view.T.join() === '1,0,0,1,0,0', `f${o}`).toBe(view.t === o);
      }
    }
    expect([...kinds].sort()).toEqual(['grid', 'stamp', 'tube']);
  });
});

describe('the clocks', () => {
  it('changes the mass layers only on 2s drawings, on j 9, and where a group has held its 4 frames', () => {
    const s = scene();
    const start = (c: number) => drawingStart(drawingIndex(c, DPS), DPS) === c;
    // The hold cap (clock.ts GROUP_HOLD): a group that has held 4 frames gives way mid-drawing.
    const capped = (c: number) => massGroup(c, I, DPS) !== massGroup(c - 1, I, DPS) && massGroup(c - GROUP_HOLD, I, DPS) === massGroup(c - 1, I, DPS);
    const changed: number[] = [];
    let prev = s.frameLayers(I + 9);
    for (let o = I + 10; o <= I + 45; o++) {
      const L = s.frameLayers(o);
      for (const name of ['fire', 'cluster', 'dust', 'wisps', 'debris']) {
        const a = part(prev, name);
        const b = part(L, name);
        if (!a || !b || a.key === b.key) continue;
        changed.push(o);
        // Debris chunks swap on the frame after a drawing starts (chunkDrawing).
        const ok = start(o) || capped(o) || (name === 'debris' && (start(o - 1) || capped(o - 1)));
        expect(ok, `${name} changed on f${o}`).toBe(true);
      }
      prev = L;
    }
    expect(changed.length).toBeGreaterThan(5);
  });

  it('holds the 1s layers on both frames of each 2-frame kr step', () => {
    const s = scene();
    let pairs = 0;
    for (let j = -7; j <= 45; j++) {
      if (j >= 0 && j <= 9) continue;
      if (kr(j) !== kr(j - 1)) continue;
      const a = s.frameLayers(I + j - 1);
      const b = s.frameLayers(I + j);
      for (const name of ['strike', 'lightning']) {
        const pa = part(a, name);
        const pb = part(b, name);
        if (!pa && !pb) continue;
        pairs++;
        expect(pb?.key, `${name} j${j - 1}/${j}`).toBe(pa?.key);
        if (j < 32) expect(pb?.alpha, `${name} j${j}`).toBe(pa?.alpha);
      }
    }
    expect(pairs).toBeGreaterThanOrEqual(5);
  });
});

describe('the scars', () => {
  for (const seconds of [1.5, 3]) {
    it(`leaves only the scars at I + J_end, after ${seconds} s`, () => {
      const s = seconds === 1.5 ? scene() : sceneOf({ seconds });
      const end = jEnd(seconds);
      const L = s.frameLayers(I + end);
      expect(names(L).filter((n) => !LIMB_LAYERS.has(n))).toEqual(['cracks']);
      expect(L.phase?.kind).toBe('decay');
      expect(s.frameLayers(I + end + 1).phase).toEqual({ kind: 'after' });
      expect(names(s.frameLayers(I + end - 20))).toContain('lightning');
    });
  }
});

describe('the cracks', () => {
  // The outline's width across the stroke at each of its points: the filled
  // run along the local normal, on a raster of the outline.
  function widest(outline: readonly Vec2[], points: readonly Vec2[], W: number, H: number): number {
    const c = createCanvas(W, H);
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.beginPath();
    outline.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
    g.closePath();
    g.fill();
    const px = g.getImageData(0, 0, W, H).data;
    const on = (x: number, y: number) => {
      const xi = Math.round(x);
      const yi = Math.round(y);
      return xi >= 0 && yi >= 0 && xi < W && yi < H && px[(yi * W + xi) * 4] > 127;
    };
    let most = 0;
    for (let i = 1; i < points.length - 1; i++) {
      const t = [points[i + 1][0] - points[i - 1][0], points[i + 1][1] - points[i - 1][1]];
      const len = Math.hypot(t[0], t[1]) || 1;
      const n = [-t[1] / len, t[0] / len];
      let run = 0;
      for (const side of [1, -1]) for (let k = 0.25; k < 60 && on(points[i][0] + side * n[0] * k, points[i][1] + side * n[1] * k); k += 0.25) run += 0.25;
      most = Math.max(most, run);
    }
    return most;
  }

  it('render each hero crack as wide as he drew it: its widest within 1.5× of the drawn widest (judge 2)', () => {
    const s = scene();
    const cracks = s.context!.cracks;
    expect(cracks.map((c) => c.id)).toEqual(HERO_CRACKS.map((c) => c.id));
    for (const c of cracks) {
      const drawn = Math.max(...HERO_CRACKS.find((h) => h.id === c.id)!.width) * s.scale;
      const outline = strokeOutline([...c.points], [...c.pressure], c.brush, s.width / 1080);
      const ratio = widest(outline, c.points, s.width, s.height) / drawn;
      expect(ratio, `crack ${c.id}`).toBeGreaterThan(1 / 1.5);
      expect(ratio, `crack ${c.id}`).toBeLessThan(1.5);
    }
  });
});

describe('portrait', () => {
  it('runs the phases at 608×1080 with the HUD anchors on the frame and h = −1', () => {
    const s = sceneOf({ portrait: true });
    expect([s.width, s.height]).toEqual([608, 1080]);
    expect(s.context!.frame.h).toBe(-1);
    const hud = posterLayout(s.context!).hud;
    for (const [name, [x, y]] of Object.entries(hud)) {
      expect(x >= 0 && x <= s.width && y >= 0 && y <= s.height, `${name} (${x.toFixed(1)}, ${y.toFixed(1)})`).toBe(true);
    }
    const kinds = [70, 77, 86, 97, 116, 130].map((o) => s.frameLayers(o).phase?.kind);
    expect(kinds).toEqual(['coil', 'strike', 'poster', 'aftermath', 'decay', 'after']);
    const frame = renderAt(s, I + 13);
    expect(frame.width).toBe(608);
    let lit = 0;
    for (let i = 0; i < frame.data.length; i += 4) if (frame.data[i] !== PLATE || frame.data[i + 1] !== PLATE) lit++;
    expect(lit).toBeGreaterThan(1000);
  });

  // Round 4's integration: the released limbs are kept above the floor and
  // the clip's bottom edge (lift.ts animate3d), which took a 16:9 clip's
  // height when the scene gave none, so on a 1080×1920 clip every point but
  // the roots went flat on y 606, two thirds of the way up the frame.
  it('keeps the released limbs by P and on the clip`s own frame (f93–130)', () => {
    const s = sceneOf({ portrait: true });
    const { clip, P } = s.setup;
    const frames = s.frames3d();
    for (let f = 93; f <= 130; f++) {
      for (const p of frames[f].placed) for (const q of p.points) expect(q[1], `f${f} limb ${p.id}`).toBeLessThanOrEqual(clip.height);
    }
    // Just let go (f93), every tip is still low by P, under the frame's middle.
    for (const p of frames[93].placed) expect(p.points.at(-1)![1], `limb ${p.id} (P ${P[0]}, ${P[1]})`).toBeGreaterThan(clip.height / 2);
  });
});

describe('the turn', () => {
  it('keeps θ at 0 on every frame without a tap or a stand-in', () => {
    const s = sceneOf({ tap: false });
    expect(s.turn().from).not.toBe('tap');
    expect(s.bodies().length).toBeGreaterThan(0);
    for (const body of s.bodies()) expect(body.yaw).toBe(0);
    const tapped = scene();
    expect(tapped.turn().from).toBe('tap');
    expect(tapped.bodies().some((b) => Math.abs(b.yaw) > 1)).toBe(true);
  });
});

describe('render-ahead', () => {
  const frameOf = (s: ImpactScene, o: number) => hash(renderAt(s, o).data);

  it('lists the drawings due in the next frames that are not drawn yet, and nothing once they are', () => {
    const s = sceneOf();
    const jobs = s.jobs(I + 11);
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      expect(job.due).toBeGreaterThan(I + 11);
      expect(job.due).toBeLessThanOrEqual(I + 14);
      expect(job.key.split(':')[1]).toBe(s.sceneId);
      expect(job.estMs).toBe({ limb: 42, mass: 12, poster: 8 }[job.kind]);
      s.runJob(job);
    }
    expect(s.jobs(I + 11)).toEqual([]);
    // While the posters show, j 9's limb and mass drawings are listed too.
    const during = sceneOf().jobs(I + 3).map((job) => job.kind);
    expect(during).toContain('poster');
    expect(during).toContain('limb');
    expect(during).toContain('mass');
  });

  it("draws the same frame whether its drawings ran ahead, came from another scene's worker or were drawn by the frame", () => {
    const o = I + 16;
    const own = frameOf(sceneOf(), o);
    const ahead = sceneOf();
    for (let f = o - 3; f < o; f++) for (const job of ahead.jobs(f)) ahead.runJob(job);
    expect(frameOf(ahead, o)).toBe(own);
    const worker = sceneOf();
    const main = sceneOf();
    for (const job of main.jobs(o - 1)) main.put(worker.runJob(job.key));
    expect(frameOf(main, o)).toBe(own);
  });

  it("refuses another scene's job and a kind it doesn't know", () => {
    const s = sceneOf();
    expect(() => s.runJob('limb:00000000:93')).toThrow(/not this scene's/);
    expect(() => s.runJob(`smoke:${s.sceneId}:1`)).toThrow(/no job kind/);
  });

  it('draws one limb drawing for all four limbs', () => {
    const s = sceneOf();
    const layer = s.runJob(`limb:${s.sceneId}:100`);
    expect(layer.parts.map((p) => p.name)).toEqual(['limbsBehind', 'limbsFront']);
    // The steady light first, then each limb's arcs once, in the tubes' depth order (far first).
    const ids = layer.parts[1].glow!.map((g) => g.id);
    expect(ids[0]).toBeNull();
    expect([...ids.slice(1)].sort()).toEqual(LIMB_IDS.filter((id) => ids.includes(id)));
    expect(ids.slice(1)).toEqual(s.tubesAt(100).map((t) => t.id).filter((id) => ids.includes(id)));
  });
});
