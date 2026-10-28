// The stroke plan (SPEC §9): one Muse Wonder call per drawing says, for each
// stroke, what it attaches to and how it moves. The call itself is a
// transport the caller passes in (the app's goes through the proxy; tests
// replay recorded answers), so this module never touches the network.
//   1. Ask, with the plan schema as the structured output format.
//   2. If the answer doesn't validate (or the call fails), ask once more,
//      saying what was wrong.
//   3. If that fails too, use the nearest-mask rule, with a note the app
//      shows, so a bad answer never stops anyone drawing.
import type { Anchor } from '../types/effect.ts';
import type { SamMask } from '../sam/cache.ts';
import { nearestMaskPlan } from './baseline.ts';
import { PLAN_SCHEMA, validatePlan } from './schema.ts';

export interface PlanStroke {
  id: number;
  points: [number, number, number][]; // as drawn: frame px and pressure, root first
}

export interface PlanInput {
  frame: number; // the frame the strokes were drawn on
  strokes: PlanStroke[];
  masks: Record<string, SamMask | null>; // SAM's masks on that frame, by concept prompt
}

export interface StrokePlan {
  id: number;
  kind: 'strand' | 'rigid';
  anchor: Anchor;
  bodyAngle: number;
  stiffness: number;
  layer: 'behind' | 'front';
  wobble: number;
  reason: string;
}

export interface PlanRequest {
  attempt: 1 | 2;
  prompt: string; // the text part; the caller adds the frame with the strokes numbered on it
  schema: typeof PLAN_SCHEMA;
  input: PlanInput;
}

// One attempt: Wonder's output text, or a throw if the call failed.
export type PlanTransport = (request: PlanRequest) => Promise<string>;

export interface PlanResult {
  source: 'wonder' | 'rule';
  attempts: number; // calls made
  strokes: StrokePlan[];
  note: string | null; // shown in the plan panel when the rule stood in
}

export const MAX_ATTEMPTS = 2;

export async function planStrokes(input: PlanInput, transport: PlanTransport): Promise<PlanResult> {
  const ids = input.strokes.map((s) => s.id);
  let problems: string[] = [];
  for (let attempt = 1 as 1 | 2; attempt <= MAX_ATTEMPTS; attempt++) {
    let text: string;
    try {
      text = await transport({ attempt, prompt: planPrompt(input, problems), schema: PLAN_SCHEMA, input });
    } catch (err) {
      problems = [`the call failed: ${err instanceof Error ? err.message : String(err)}`];
      continue;
    }
    const check = validatePlan(typeof text === 'string' ? text : '', ids);
    if (check.ok) return { source: 'wonder', attempts: attempt, strokes: check.strokes, note: null };
    problems = check.problems;
  }
  return {
    source: 'rule',
    attempts: MAX_ATTEMPTS,
    strokes: nearestMaskPlan(input),
    note: `Wonder couldn't read this drawing (${problems.slice(0, 3).join('; ')}), so each stroke attaches to the nearest body mask with default settings. Tap any field to change it.`,
  };
}

// The text half of the request: what the numbers on the frame are, the
// stroke geometry, and, on a retry, what was wrong last time.
export function planPrompt(input: PlanInput, problems: readonly string[] = []): string {
  const lines = [
    'Someone drew these strokes on one frame of a video of a person. Each stroke is drawn in its own color and numbered at its root, the end that attaches to the body.',
    'For each stroke, say what its root attaches to, how it moves and where it sits:',
    '- kind: "rigid" follows the body exactly (horns, a halo); "strand" swings and trails (a tail, tendrils, hair).',
    '- anchor: a body part as a concept prompt ("person", "head", "hand", ...), a point on the body {type "point", time in seconds, xy in frame pixels}, or a fixed spot on the ground {type "ground", xy}.',
    '- bodyAngle: degrees around the torso where the root sits: 0 his chest, 90 his right side, 180 the center of his back, 270 his left side.',
    '- stiffness: 0 hangs like a rope, 1 keeps the drawn shape.',
    '- layer: "behind" or "front" of the body, as seen in this frame.',
    '- wobble: 0 to 1, how much the line boils.',
    '- reason: one line on why.',
    `Frame ${input.frame}. Strokes (frame pixels, root first, every 4th point):`,
    ...input.strokes.map((s) => `${s.id}: ${s.points.filter((_, i) => i % 4 === 0 || i === s.points.length - 1).map(([x, y]) => `${Math.round(x)},${Math.round(y)}`).join(' ')}`),
  ];
  if (problems.length) lines.push(`Your last answer couldn't be used: ${problems.slice(0, 5).join('; ')}. Answer with every numbered stroke, once each, in the schema.`);
  return lines.join('\n');
}
