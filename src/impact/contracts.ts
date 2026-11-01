// The impact engine's shared contracts (impact design §0–§10): the shapes its
// packages hand each other. Types only, plus two tiny glow sinks and a
// straight test tube. Later packages add to this file; they don't change
// what is here.
//
// Units: frame px with y down unless a field says otherwise; "camera px" is
// the 3D lift's camera space (src/lift/body.ts), x and y as on screen and +z
// toward the camera.
import type { BrushSettings, Ease, FloorBlock, Vec2 } from '../types/effect.ts';
import type { Body3D } from '../lift/body.ts';
import type { BrushTarget } from '../render/glow.ts';
import type { Mask } from '../track/tracking.ts';

export type { Vec2 };
export type Vec3 = [number, number, number];
export type Palette = [string, string, string]; // [p0 main, p1 light, p2 ink]
export type Tier = 'full' | 'phone';

// ---- Limbs (design §2, §3) ------------------------------------------------------

// A limb's held drawing: the lifted chain as it was captured for one drawing.
export interface HeldLimb {
  id: number; // the stroke id
  points: Vec2[]; // frame px, root first
  z: number[]; // camera depth per point, px (+ toward the camera)
  pressure: number[]; // per point, 0..1
  front: boolean[]; // per point: over his body (true) or under it
  length: number; // L, px: the limb's length as drawn
}

export interface TubeSection {
  c: Vec3; // centre, camera px
  T: Vec3; // unit tangent, toward the tip
  N: Vec3; // unit normal of the rotation-minimizing frame
  B: Vec3; // T × N
  r: number; // radius, px
  s: number; // arc-length fraction: 0 at the root, 1 at the tip
  front: boolean; // over his body (true) or under it
  screen: Vec2; // c projected, frame px
  normal: Vec2; // the projected centreline's unit normal: its screen tangent (tx, ty) turned to (−ty, tx)
}

export interface Tube {
  id: number; // the stroke id
  sections: TubeSection[]; // root first
  length: number; // the centreline's arc length, px
}

// A cord pulse's bulge (design §3), in the same arc-length fractions as TubeSection.s.
export interface PulseSpan {
  s: number; // centre
  len: number; // length
  scale: number; // radius × inside it
  core: number; // the core band's share of the width inside it, 0..1
}

// ---- The strike (design §0, §4) ---------------------------------------------------

// The strike axes: X(a, b) = P + S·(a·u + b·v).
export interface StrikeFrame {
  P: Vec2; // the impact point
  u: Vec2; // unit strike direction
  v: Vec2; // h·(−u_y, u_x)
  S: number; // the frame's short side, px
  U: number; // σ·S: the physical size unit, px
  sigma: number; // σ = clamp(0.85·h_p/(0.76·S), 0.45, 1), h_p the person box height at I
  h: 1 | -1; // which side v points to; −1 whenever height > width
}

// One limb as the lift sees it on one physics step.
export interface StrikeLimb {
  id: number; // the stroke id
  points: readonly Vec3[]; // the chain now, camera px, root first
  target: readonly Vec3[]; // the lifted drawing's own target for this step, camera px
  stiffness: number; // the stroke's own
}

export interface StrikeStep {
  f: number; // the output frame this step ends in
  sub: number; // 1..steps within that frame
  steps: number; // physics steps per output frame
  body: Body3D; // the body on this step (it projects camera px to the screen)
  limbs: readonly StrikeLimb[];
}

// One limb's orders for one step. A field left out keeps the lift's own behaviour.
export interface LimbControl {
  target?: Vec3[]; // replaces the target: camera px, root first, one per chain node
  stiffness?: number;
  pin?: Vec3 | null; // the tip node is held here, re-applied after every constraint pass; null = free
  restScale?: number; // × every rest length (missing = 1)
  impulse?: Vec3[]; // added once to each node's velocity on this step, camera px/s
}

// What the lift's strike hook calls (WP2) and the strike controller implements (WP2b).
export interface StrikeController {
  land: number; // the output frame the tips land on P
  release: number; // the output frame they let go: it forces a new drawing
  // From land − 1 to release − 1 the lift captures a held pose on every frame.
  step(at: StrikeStep): (LimbControl | null)[]; // per limb, in at.limbs' order; null = leave it alone
}

// ---- The scene (design §1, §5, §6, §7, §10) ----------------------------------------

export type FloorModel = FloorBlock;

// One impact stroke, the way the layers read it.
export interface Crack {
  id: number; // the stroke id: seeds its layer
  points: Vec2[]; // frame px, in drawing order
  pressure: number[]; // per point, 0..1
  brush: BrushSettings; // what it was drawn with, at 1080 wide
  color: 0 | 1 | 2; // palette index
  fromP: 'start' | 'end' | null; // the end within 0.08 S of P, where its draw-on starts; null = drawn whole
}

export interface ImpactContext {
  I: number; // the contact frame
  jEnd: number; // round(30·aftermath.seconds): everything but the scars is gone at I + jEnd
  seed: number;
  frame: StrikeFrame;
  floor: FloorModel;
  width: number; // frame px
  height: number;
  palette: Palette; // roles(palette) gives every tone (palette.ts)
  flash: 'safe' | 'full'; // 'full' by default; 'safe' is Reduce flashing
  posters: boolean; // frames.count is 7
  crackEase: Ease; // ease.cracks, 'out' when missing: the crack draw-on
  aftermath: { seconds: number; scale: number; scarSeconds: number };
  tier: Tier;
  personMask(f: number): Mask | null; // frame-sized alpha, null on frames without one
  faceMask(f: number): Mask | null; // frame-sized alpha, null on frames without one
  cracks: Crack[];
}

// Where the glow goes (design §7): 'core' and 'body' pick the buffer weights.
export type GlowKind = 'core' | 'body';
export interface GlowSink {
  stroke(points: Vec2[], width: number, color: string, kind: GlowKind, gain: number): void; // a polyline, width px
  fill(outline: Vec2[], color: string, kind: GlowKind, gain: number): void; // a closed outline
  disc(c: Vec2, r: number, color: string, gain: number): void; // r px
  wash(outline: Vec2[], color: string, gain: number): void; // into the wide wash buffer
}

export type GlowCall =
  | { op: 'stroke'; points: Vec2[]; width: number; color: string; kind: GlowKind; gain: number }
  | { op: 'fill'; outline: Vec2[]; color: string; kind: GlowKind; gain: number }
  | { op: 'disc'; c: Vec2; r: number; color: string; gain: number }
  | { op: 'wash'; outline: Vec2[]; color: string; gain: number };

export interface RecordingSink extends GlowSink {
  calls: GlowCall[];
}

// A drawing the render-ahead worker can make before it's due (design §10).
export interface DrawingJob {
  key: string; // the cache key: the same key draws the same pixels
  kind: 'limb' | 'mass' | 'poster';
  due: number; // the output frame that first shows it
  estMs: number; // its line in the design §10 budget
}

// Design §7's stack, bottom to top: the plate (graded video), the flame aura,
// cracks, fire and cluster, dust over the cluster's base, floods, limbs behind,
// the person cutout, limbs in front, front FX, the A5–6 flash, then the glow.
export type StackSlot = 'plate' | 'aura' | 'cracks' | 'fire' | 'dust' | 'floods' | 'limbsBehind' | 'person' | 'limbsFront' | 'fx' | 'flash' | 'glow';

export interface LayerDraw {
  key: string | null; // equal keys draw equal pixels, so the stack may reuse a cached copy; null = every frame
  draw(ctx: BrushTarget): void; // in frame px; the stack applies the camera
}

// Everything output frame o draws.
export interface FrameLayers {
  o: number; // the output frame
  clip: number; // the clip frame under it (freezeMap, under ladder step 4)
  j: number | null; // frames since contact; null without a slam
  poster: LayerDraw | null; // set on poster frames: drawn instead of the whole stack, without the camera
  slots: Partial<Record<StackSlot, LayerDraw[]>>; // a missing slot draws nothing
  faceCut: Mask | null; // the fx slot is cut out of this (from j 9); null = no cut
}

// ---- Test doubles -------------------------------------------------------------------

// Records every call, with copies of the points, for tests.
export function recordingSink(): RecordingSink {
  const calls: GlowCall[] = [];
  const copy = (pts: Vec2[]) => pts.map((p): Vec2 => [p[0], p[1]]);
  return {
    calls,
    stroke: (points, width, color, kind, gain) => void calls.push({ op: 'stroke', points: copy(points), width, color, kind, gain }),
    fill: (outline, color, kind, gain) => void calls.push({ op: 'fill', outline: copy(outline), color, kind, gain }),
    disc: (c, r, color, gain) => void calls.push({ op: 'disc', c: [c[0], c[1]], r, color, gain }),
    wash: (outline, color, gain) => void calls.push({ op: 'wash', outline: copy(outline), color, gain }),
  };
}

export const nullSink: GlowSink = { stroke() {}, fill() {}, disc() {}, wash() {} };

// A straight tube of n sections and radius r, lying along +x from `origin` in
// the screen plane (z 0) and facing the camera: N is screen down, B points at
// the camera, every section in front.
export function syntheticTube(n: number, length: number, r: number, origin: Vec2 = [0, 0], id = 1): Tube {
  if (!Number.isInteger(n) || n < 2) throw new Error(`syntheticTube needs 2 or more sections (got ${n})`);
  const sections = Array.from({ length: n }, (_, i): TubeSection => {
    const s = i / (n - 1);
    const x = origin[0] + length * s;
    const y = origin[1];
    return { c: [x, y, 0], T: [1, 0, 0], N: [0, 1, 0], B: [0, 0, 1], r, s, front: true, screen: [x, y], normal: [0, 1] };
  });
  return { id, sections, length };
}

// ---- Render-ahead (design §10) ------------------------------------------------------

// A drawing's glow as recorded calls, replayed into the frame's glow buffers
// when the drawing first shows. `id` null is steady light; a limb id is that
// limb's arcs, which the composite flickers by arcFlicker(id, c1) per kr step.
export interface DrawnGlow {
  id: number | null;
  calls: GlowCall[];
}

// One drawn part of a frame (a limb layer, a mass, a poster), in a canvas the
// size of its box: the stack lays its pixels at (x0, y0), frame px.
export interface DrawnPart {
  key: string; // what it shows: the same key draws the same pixels
  slot: StackSlot | 'poster';
  name: string; // 'fire', 'limbsFront', 'poster', …
  image: unknown; // the canvas (or a worker's bitmap of it); null when it drew nothing
  x0: number;
  y0: number;
  width: number;
  height: number;
  glow?: DrawnGlow[];
}

// What a DrawingJob draws: its parts, each stored by its own key.
export interface DrawnLayer {
  key: string; // the job's key
  kind: DrawingJob['kind'];
  parts: DrawnPart[];
}
