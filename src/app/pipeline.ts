// Gate 1 (SPEC §3, §10 G1): one clip, end to end, from cached answers:
//   clip -> plan -> SAM -> physics -> stepped preview.
//   1. Read SAM's `person` (and `face`) masks for the clip.
//   2. Plan the drawing: Wonder through `transport`, checked, one retry, or
//      the nearest-mask rule (src/plan/plan.ts).
//   3. For each stroke, the masks its planned anchor names (a concept's run,
//      or the stroke's own point run), tracked to a pose on every frame.
//   4. Store the strokes in torso space around their roots, write the plan
//      in (keeping any overrides), and animate: physics underneath, drawings
//      held on 2s with the boil on top.
// The app and the G1 test both run this, so the path tested is the app's.
// SAM answers come from `sam`, which only reads a cache; nothing here calls
// the API.
import type { Effect, Stroke } from '../types/effect.ts';
import { animate, type AnimatedFrame } from '../motion/animate.ts';
import type { BoilParams } from '../motion/boil.ts';
import { resampleStroke } from '../render/brush.ts';
import { planStrokes, type PlanInput, type PlanResult, type PlanStroke, type PlanTransport } from '../plan/plan.ts';
import { masksFromCache, samCacheFile, toFrameMask, type SamMask } from '../sam/cache.ts';
import { samShape, trackPoses } from '../track/anchor.ts';
import { anchorTransform, toTorso, torsoHeights, type TorsoTransform } from '../track/torso.ts';
import { followShapes, type Mask, type Pose, type Tracking } from '../track/tracking.ts';
import { applyPlan } from './overrides.ts';

export interface PipelineClip {
  id: string;
  sha256: string; // the converted clip's; every cache is keyed by it
  frames: number;
  width: number;
  height: number;
  fps: number;
}

// A cached SAM answer by file name (sam-person.json, ...), or null if it
// isn't cached.
export type SamSource = (file: string) => unknown | Promise<unknown>;

export interface PipelineOptions {
  clip: PipelineClip;
  drawing: { frame: number; strokes: PlanStroke[] };
  transport: PlanTransport;
  sam: SamSource;
  boil: BoilParams;
  dps?: 12 | 8;
  palette?: Effect['palette'];
  brush?: Effect['brush'];
  overrides?: Effect['overrides']; // taps from an earlier plan of the same drawing
}

export interface PipelineResult {
  plan: PlanResult;
  effect: Effect;
  frames: AnimatedFrame[];
  notes: string[]; // anything that stood in for a missing cache
}

const DEFAULT_PALETTE: Effect['palette'] = ['#e8203a', '#f4f1ea', '#16141a'];
const DEFAULT_BRUSH: Effect['brush'] = { size: 28, thinning: 0.65, smoothing: 0.6, streamline: 0.45 };
const NO_PERSON_TORSO = 0.25; // of the frame height, when no mask says otherwise

// SAM's person and face masks for the clip, from the cache.
export async function personAndFace(clip: PipelineClip, sam: SamSource): Promise<{ person: (SamMask | null)[]; face: (SamMask | null)[] }> {
  const personJson = await sam('sam-person.json');
  if (!personJson) throw new Error(`no cached SAM person run for ${clip.id}`);
  const faceJson = await sam('sam-face.json');
  return {
    person: await masksFromCache(personJson, clip.frames),
    face: faceJson ? await masksFromCache(faceJson, clip.frames) : Array.from({ length: clip.frames }, () => null),
  };
}

// Whole-frame masks for the cutout and the torso size, from SAM's.
export function frameMasks(masks: (SamMask | null)[], width: number, height: number): (Mask | null)[] {
  return masks.map((m) => (m ? toFrameMask(m, width, height) : null));
}

// The app's tracking from SAM's person masks: the cutout, and strokes that
// follow the person's shape.
export function samTracking(person: (SamMask | null)[], width: number, height: number): Tracking {
  const shapes = person.map((m) => (m ? samShape(m) : null));
  return {
    label: 'SAM 3.1 (cached)',
    masks: frameMasks(person, width, height),
    follow: (root, frame) => followShapes(shapes, root, frame),
  };
}

export async function runPipeline(o: PipelineOptions): Promise<PipelineResult> {
  const { clip, drawing } = o;
  const notes: string[] = [];
  const { person, face } = await personAndFace(clip, o.sam);

  // 2. The plan.
  const input: PlanInput = { frame: drawing.frame, strokes: drawing.strokes, masks: { person: person[drawing.frame] ?? null, face: face[drawing.frame] ?? null } };
  const plan = await planStrokes(input, o.transport);
  if (plan.note) notes.push(plan.note);

  // 3. A track for each stroke's anchor.
  const units = torsoHeights(frameMasks(person, clip.width, clip.height), clip.width, clip.height);
  const unit0 = unitNear(units, drawing.frame) ?? NO_PERSON_TORSO * clip.height;
  const runs = new Map<string, (SamMask | null)[]>([['sam-person.json', person]]);
  if (face.some(Boolean)) runs.set('sam-face.json', face);
  const tracks = new Map<number, (f: number) => TorsoTransform>();
  for (const s of drawing.strokes) {
    const planned = plan.strokes.find((p) => p.id === s.id)!;
    const root: [number, number] = [s.points[0][0], s.points[0][1]];
    const still: TorsoTransform = { x: root[0], y: root[1], angle: 0, unit: unit0 };
    const file = samCacheFile(planned.anchor, s.id);
    if (!file) {
      tracks.set(s.id, () => still); // ground: fixed frame pixels
      continue;
    }
    if (!runs.has(file)) {
      const json = await o.sam(file);
      if (json) runs.set(file, await masksFromCache(json, clip.frames));
    }
    let masks = runs.get(file);
    if (!masks) {
      notes.push(`stroke ${s.id}: ${file} isn't cached, so it follows the person`);
      masks = person;
    }
    const poses: Pose[] | null = trackPoses(masks, { frame: drawing.frame, xy: root }, clip.fps);
    if (!poses) notes.push(`stroke ${s.id}: its mask isn't on frame ${drawing.frame}, so it stays where it was drawn`);
    tracks.set(s.id, poses ? (f) => anchorTransform(poses[f], unit0) : () => still);
  }

  // 4. The effect, then the animation.
  const strokes: Stroke[] = drawing.strokes.map((s) => {
    const at = tracks.get(s.id)!(drawing.frame);
    const { points, pressure } = resampleStroke(s.points);
    const torso = points.map((p) => toTorso(at, p));
    return {
      id: s.id,
      color: (s.id % 3) as 0 | 1 | 2,
      kind: 'strand',
      anchor: { type: 'concept', prompt: 'person' },
      bodyAngle: 0,
      stiffness: 0.5,
      wobble: 1,
      views: { front: { points: torso, pressure, root: torso[0], layer: 'front' } },
    };
  });
  const base: Effect = {
    version: 1,
    brush: o.brush ?? DEFAULT_BRUSH,
    palette: o.palette ?? DEFAULT_PALETTE,
    timing: { drawingsPerSecond: o.dps ?? 12 },
    strokes,
    overrides: { ...o.overrides },
  };
  const effect = applyPlan(base, plan.strokes);
  const frames = animate({ effect, frames: clip.frames, anchor: (id, f) => tracks.get(id)!(f), width: clip.width, boil: o.boil, fps: clip.fps });
  return { plan, effect, frames, notes };
}

// The torso height on frame f, or the nearest frame that has one.
function unitNear(units: (number | null)[], f: number): number | null {
  for (let d = 0; d < units.length; d++) {
    const found = units[f - d] ?? units[f + d];
    if (found != null) return found;
  }
  return null;
}
