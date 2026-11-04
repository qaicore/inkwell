// A prop: something Qai draws that rides rigidly on the tip of one limb. The
// data is plain (Effect.props: the strokes as drawn, in clip px, on one frame,
// and the limb they ride), so it reaches the render worker and the export in
// the effect like everything else. The scene rasterizes it once, to a small
// canvas relative to the tip as the limb stood on the draw frame, and draws
// that canvas each frame through one rigid transform: move with the tip,
// turn by how far the tip's direction has turned, scale by the tip radius's
// ratio. No physics: the prop goes where the tip goes. It draws into the
// limb's own layer (the tip's side of the person cutout), after the limb.
import type { Palette, Tube, Vec2 } from './contracts.ts';
import type { MakeScratch } from '../render/glow.ts';

export interface TipPropStroke {
  points: Vec2[]; // clip px on the draw frame
  pressure: number[];
}
export interface TipProp {
  id: number;
  limb: number; // the limb stroke's id
  frame: number; // the clip frame the prop was drawn on
  color: 0 | 1 | 2;
  size: number; // brush size, clip px
  strokes: TipPropStroke[];
}

export const MAX_PROPS = 4;
export const MAX_PROP_POINTS = 1200; // per prop, all strokes: the memory bound on a phone
export const PROP_REACH = 0.12; // × S: how far from the tip the raster goes (inside the limb layers' box)
const SCALE = [0.5, 2] as const;

export interface TipPose {
  tip: Vec2;
  dir: number; // radians, screen
  r: number; // the tip's radius, px
}

// Where the tip is and which way it points: from the section 85 % along to the last.
export function tipPose(tube: Tube): TipPose | null {
  const secs = tube.sections;
  const last = secs.length - 1;
  if (last < 1) return null;
  const from = secs[Math.min(last - 1, Math.floor(last * 0.85))].screen;
  const to = secs[last].screen;
  return { tip: [to[0], to[1]], dir: Math.atan2(to[1] - from[1], to[0] - from[0]), r: secs[last].r };
}

// The one rigid transform, as a canvas matrix [a b c d e f], taking a point
// relative to the draw frame's tip to the frame now.
export function rigid(ref: TipPose, now: TipPose): [number, number, number, number, number, number] {
  const k = ref.r > 1e-6 ? Math.min(SCALE[1], Math.max(SCALE[0], now.r / ref.r)) : 1;
  const a = now.dir - ref.dir;
  const c = Math.cos(a) * k;
  const s = Math.sin(a) * k;
  return [c, s, -s, c, now.tip[0], now.tip[1]];
}

export interface PropRaster {
  canvas: unknown;
  x0: number; // the canvas's top left, relative to the tip, px
  y0: number;
  ref: TipPose;
}

// The strokes onto a small canvas, in px relative to the draw frame's tip.
export function rasterize(make: MakeScratch, prop: TipProp, ref: TipPose, s: number, S: number, palette: Palette): PropRaster | null {
  const reach = PROP_REACH * S;
  const pad = prop.size * s;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const rel = prop.strokes.map((st) =>
    st.points.map(([x, y]): Vec2 => {
      const p: Vec2 = [Math.min(reach, Math.max(-reach, x * s - ref.tip[0])), Math.min(reach, Math.max(-reach, y * s - ref.tip[1]))];
      x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
      return p;
    }),
  );
  if (!(x1 >= x0)) return null;
  x0 = Math.floor(x0 - pad); y0 = Math.floor(y0 - pad); x1 = Math.ceil(x1 + pad); y1 = Math.ceil(y1 + pad);
  const sc = make(Math.max(1, x1 - x0), Math.max(1, y1 - y0));
  const ctx = sc.ctx as unknown as CanvasRenderingContext2D;
  ctx.setTransform(1, 0, 0, 1, -x0, -y0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = palette[prop.color];
  ctx.fillStyle = palette[prop.color];
  rel.forEach((pts, i) => {
    const pr = prop.strokes[i].pressure;
    for (let j = 1; j < pts.length; j++) {
      ctx.lineWidth = Math.max(1, pad * (0.4 + 0.6 * (pr[j] ?? 0.5)));
      ctx.beginPath();
      ctx.moveTo(pts[j - 1][0], pts[j - 1][1]);
      ctx.lineTo(pts[j][0], pts[j][1]);
      ctx.stroke();
    }
  });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return { canvas: sc.canvas, x0, y0, ref };
}

const rasters = new WeakMap<object, Map<string, PropRaster | null>>();

export interface PropScene {
  props: readonly TipProp[] | undefined;
  tubeAt(frame: number, id: number): Tube | undefined; // a limb's tube on a clip frame
  make: MakeScratch;
  s: number;
  S: number;
  palette: Palette;
}

// Draws the props riding `tube` into the target on the tip's side. Does
// nothing at all when the effect has no props.
export function drawTipProps(sc: PropScene, tube: Tube, behind: CanvasRenderingContext2D | null, front: CanvasRenderingContext2D | null): void {
  const props = sc.props;
  if (!props || props.length === 0) return;
  const now = tipPose(tube);
  if (!now) return;
  const target = tube.sections[tube.sections.length - 1].front ? front : behind;
  if (!target) return;
  let cache = rasters.get(props);
  if (!cache) rasters.set(props, (cache = new Map()));
  for (const prop of props.slice(0, MAX_PROPS)) {
    if (prop.limb !== tube.id) continue;
    const key = `${prop.id}:${sc.s}:${sc.S}`;
    let r = cache.get(key);
    if (r === undefined) {
      const t0 = sc.tubeAt(prop.frame, prop.limb);
      const ref = t0 ? tipPose(t0) : null;
      r = ref ? rasterize(sc.make, prop, ref, sc.s, sc.S, sc.palette) : null;
      cache.set(key, r);
    }
    if (!r) continue;
    const m = rigid(r.ref, now);
    target.save();
    target.transform(...m);
    target.drawImage(r.canvas as CanvasImageSource, r.x0, r.y0);
    target.restore();
  }
}

// ---- The page's side: collecting a prop from strokes ----------------------------------------

export interface PropState {
  props: TipProp[];
  stack: { prop: number; id: number }[]; // the prop strokes in drawing order, for undo
  open: number | null; // the prop the next stroke joins, until Prop is turned off
}
export const newPropState = (): PropState => ({ props: [], stack: [], open: null });

export interface LimbDraw {
  id: number;
  frame: number;
  points: readonly (readonly number[])[];
}
export interface PropInput {
  id: number;
  frame: number;
  color: 0 | 1 | 2;
  size: number;
  points: readonly (readonly number[])[];
}

// Adds a stroke to the open prop, starting one on the limb whose tip is
// nearest the stroke's first point. Returns a note for the status line when
// nothing was drawn.
export function addPropStroke(st: PropState, input: PropInput, limbs: readonly LimbDraw[]): string | null {
  const first = input.points[0];
  const pts = input.points.slice(0, MAX_PROP_POINTS);
  let prop = st.props.find((p) => p.id === st.open);
  if (!prop) {
    const onFrame = limbs.filter((l) => l.frame === input.frame && l.points.length > 0);
    if (limbs.length === 0) return 'Draw a limb first: a prop rides on a limb tip.';
    if (onFrame.length === 0) return "Draw the prop on the frame the limbs were drawn on.";
    if (st.props.length >= MAX_PROPS) return `${MAX_PROPS} props at most: undo one to draw another.`;
    const tipDist = (l: LimbDraw) => Math.hypot(l.points[l.points.length - 1][0] - first[0], l.points[l.points.length - 1][1] - first[1]);
    const limb = onFrame.reduce((a, b) => (tipDist(b) < tipDist(a) ? b : a));
    prop = { id: input.id, limb: limb.id, frame: limb.frame, color: input.color, size: input.size, strokes: [] };
    st.props.push(prop);
    st.open = prop.id;
  }
  if (input.frame !== prop.frame) return "Draw the prop on the frame the limbs were drawn on.";
  const used = prop.strokes.reduce((n, s) => n + s.points.length, 0);
  if (used + pts.length > MAX_PROP_POINTS) return 'That prop is full: undo a stroke or start another.';
  prop.strokes.push({ points: pts.map((p): Vec2 => [p[0], p[1]]), pressure: pts.map((p) => p[2] ?? 0.5) });
  st.stack.push({ prop: prop.id, id: input.id });
  return null;
}

// Takes the newest prop stroke back when it's newer than `lastStrokeId`.
export function undoPropStroke(st: PropState, lastStrokeId: number): boolean {
  const top = st.stack[st.stack.length - 1];
  if (!top || top.id < lastStrokeId) return false;
  st.stack.pop();
  const prop = st.props.find((p) => p.id === top.prop);
  prop?.strokes.pop();
  if (prop && prop.strokes.length === 0) st.props = st.props.filter((p) => p !== prop);
  if (st.open === top.prop && !st.props.some((p) => p.id === top.prop)) st.open = null;
  return true;
}

// The props whose limb still exists, or undefined when there are none, so an
// effect without props stays exactly as it was.
export function livePropsOf(props: readonly TipProp[], limbIds: ReadonlySet<number>): TipProp[] | undefined {
  const live = props.filter((p) => limbIds.has(p.limb));
  return live.length > 0 ? live : undefined;
}
