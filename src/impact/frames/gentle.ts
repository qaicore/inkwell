// The posters' flash plan (impact design §5, "Gentle mode"; study impact.md
// §8): which poster shows on each frame after contact, and how it's drawn.
// Full is the default (decision 5: the reference look, in the preview and the
// export); 'safe' is the Reduce flashing toggle, at most 3 flashes in any
// second. Every rule is a pure transform of the plan:
//   - G1, one inversion: IF1–IF4 light, IF5–IF7 dark, so IF6 is drawn on ink
//     with paper marks.
//   - G2, a light split: IF2's disc is a tinted paper disc with an ink edge
//     line and ink tongues, never solid ink.
//   - G3, bright light fields: tints keep relL ≥ 0.80, lowered until they do.
//   - G4, no large saturated red: a colour with linear R/(R+G+B) ≥ 0.8 gets
//     its green raised until G ≥ 0.55 R on 8-bit (#6a2c03 → #6a3b0a). The dark
//     posters' hot ramp is the large red here (#733002, #441003, #260200).
//   - G6, cooldown: a slam whose IF1 lands within 24 drawings (30 frames) of
//     the last one's is a single IF4 glint, held 8 frames.
//   - G7, calm runs (decision 12): no light on the dark fields (no emission),
//     and IF4's star, IF5's cross and IF7's comet at 0.4 of their width, so
//     each run only moves a 10° field once: up on IF1, down on IF5, up on
//     the way out.
// And the poster side of the export's flash ladder, reduced mode only (WP12's
// ladder.ts orders the steps, WP13's export walks them):
//   - step 4, the slow replay: each poster holds 5 frames (WP0's freezeMap);
//   - step 5, polarity lock: every poster light, so IF5 and IF7 are ink
//     figures on paper, and IF2 is G2's;
//   - step 6, glint only: G6's glint, whatever the cooldown says;
//   - step 7, no posters: the same plan as frames.count 0.
import { kr, posterHolds, POSTER_COUNT } from '../clock.ts';
import { HOT, isSaturatedRed, linear } from '../palette.ts';
import { hex, rgb } from '../../render/geometry.ts';

export const LIGHT_FLOOR = 0.8; // G3: the least relative luminance of a light field's tint
export const COOLDOWN = 30; // G6: frames (24 drawings) between one slam's IF1 and the next
export const GLINT_HOLD = 8; // G6: frames
export const GLINT_POSTER = 3; // G6: IF4
const RED_G = 0.55; // G4: G ≥ 0.55 R on 8-bit
const RED_B = 0.1; // G4: and B ≥ 0.1 R, the bend toward brown

export type Field = 'light' | 'dark';

export interface PosterSpec {
  si: number; // 0..6: IF1..IF7
  field: Field; // paper (IF1 tinted) or ink; IF2 is light, with its disc
  disc: 'ink' | 'tint' | null; // IF2's split: the ink disc, or G2's tinted one; null on the others
  minL: number; // G3: the least relative luminance a tint keeps (0: none)
  redSafe: boolean; // G4
  glint: boolean; // G6 and ladder step 6: IF4 standing in for the whole hit
  calm?: boolean; // G7: no emission, and the big light marks thin (Reduce flashing)
}

export interface PosterPlan {
  flash: 'safe' | 'full';
  steps: (PosterSpec | null)[]; // by j = f − I from 0; null (or past the end) shows the scene
}

// The fields as the reference draws them: IF2 split, IF5 and IF7 negative.
const FULL_FIELD: readonly Field[] = ['light', 'light', 'light', 'light', 'dark', 'light', 'dark'];

// Poster si as Full draws it.
export function fullSpec(si: number): PosterSpec {
  if (!Number.isInteger(si) || si < 0 || si >= POSTER_COUNT) throw new Error(`a poster is si 0..6 (got ${si})`);
  return { si, field: FULL_FIELD[si], disc: si === 1 ? 'ink' : null, minL: 0, redSafe: false, glint: false };
}

// G1–G4 and G7 on one poster.
export function gentleSpec(spec: PosterSpec): PosterSpec {
  return { ...spec, field: spec.si >= 4 ? 'dark' : 'light', disc: spec.disc ? 'tint' : null, minL: LIGHT_FLOOR, redSafe: true, calm: true };
}

// Poster si on the plain plan for a flash mode.
export const posterSpec = (si: number, flash: 'safe' | 'full'): PosterSpec => (flash === 'safe' ? gentleSpec(fullSpec(si)) : fullSpec(si));

// The first j of poster si on the normal timing: 0, 2, 3, 4, 5, 7, 8.
export function posterFirstJ(si: number): number {
  for (let j = 0; j <= 8; j++) if (kr(j) - 7 === si) return j;
  throw new Error(`a poster is si 0..6 (got ${si})`);
}

// The reference's plan: si = kr(j) − 7 for j 0..8, holding 2, 1, 1, 1, 2, 1, 1;
// under the slow replay (ladder step 4) each poster holds 5.
export function fullPlan(freeze = false): PosterPlan {
  const steps: PosterSpec[] = [];
  posterHolds(freeze).forEach((hold, si) => {
    for (let i = 0; i < hold; i++) steps.push(fullSpec(si));
  });
  return { flash: 'full', steps };
}

// G1–G4: the Reduce flashing plan.
export const gentle = (plan: PosterPlan): PosterPlan => ({ flash: 'safe', steps: plan.steps.map((s) => (s ? gentleSpec(s) : null)) });

// G6: `since` is the frames from the previous slam's IF1 to this one's (null:
// no previous slam). Under 30, the hit is a glint.
export const cooldown = (plan: PosterPlan, since: number | null): PosterPlan => (since !== null && since < COOLDOWN ? glintOnly(plan) : plan);

// Ladder step 5: every poster light; IF2's disc as G2's.
export const polarityLock = (plan: PosterPlan): PosterPlan => ({
  flash: plan.flash,
  steps: plan.steps.map((s) => (s ? { ...s, field: 'light', disc: s.disc ? 'tint' : null, minL: Math.max(s.minL, LIGHT_FLOOR) } : null)),
});

// Ladder step 6 (and G6): IF4, light, held 8 frames.
export function glintOnly(plan: PosterPlan): PosterPlan {
  const glint: PosterSpec = { si: GLINT_POSTER, field: 'light', disc: null, minL: LIGHT_FLOOR, redSafe: true, glint: true, calm: true };
  return { flash: plan.flash, steps: Array.from({ length: GLINT_HOLD }, () => ({ ...glint })) };
}

// Ladder step 7, and frames.count 0.
export const noPosters = (plan: PosterPlan): PosterPlan => ({ flash: plan.flash, steps: [] });

export interface PlanOptions {
  flash: 'safe' | 'full';
  posters: boolean; // frames.count is 7
  ladder?: number; // 0..7: the export's flash-ladder step, in reduced mode (0: none)
  since?: number | null; // frames since the previous slam's IF1, for G6
}

// The plan for one slam. The ladder only runs in reduced mode, so Full ignores it.
export function posterPlan({ flash, posters, ladder = 0, since = null }: PlanOptions): PosterPlan {
  if (!Number.isInteger(ladder) || ladder < 0 || ladder > 7) throw new Error(`the flash ladder has steps 0..7 (got ${ladder})`);
  const base = fullPlan(flash === 'safe' && ladder >= 4);
  if (!posters) return noPosters(base);
  if (flash === 'full') return base;
  if (ladder >= 7) return noPosters(base);
  if (ladder >= 6) return glintOnly(gentle(base));
  const plan = cooldown(gentle(base), since);
  return ladder >= 5 ? polarityLock(plan) : plan;
}

// The poster on frame j of the plan, or null for the scene.
export const posterAt = (plan: PosterPlan, j: number): PosterSpec | null => (Number.isInteger(j) && j >= 0 ? plan.steps[j] ?? null : null);

// ---- G4 -----------------------------------------------------------------------------

// A saturated red bent toward brown: G raised to 0.55 R and B to 0.1 R on
// 8-bit, then G further until the linear ratio is under 0.8. Anything else
// comes back as it was (in '#rrggbb').
export function redSafe(color: string): string {
  const [r, g0, b0] = rgb(color);
  if (!isSaturatedRed(color)) return hex([r, g0, b0]);
  let g = Math.max(g0, Math.ceil(RED_G * r));
  const b = Math.max(b0, Math.floor(RED_B * r));
  while (isSaturatedRed(hex([r, g, b])) && g < 255) g++;
  return hex([r, g, b]);
}

// A saturated red cooled toward crimson instead: B raised, and R lowered to
// hold the relative luminance, until the linear ratio is under 0.8. A moving
// limb in it then trades no red flash for a general one (Reduce flashing's
// palette, scene.ts). Anything else comes back as it was.
export function redSafeCool(color: string): string {
  const [r0, g, b0] = rgb(color);
  if (!isSaturatedRed(color)) return hex([r0, g, b0]);
  const L = 0.2126 * linear(r0) + 0.7152 * linear(g) + 0.0722 * linear(b0);
  for (let b = b0 + 1; b <= 255; b++) {
    const rl = (L - 0.7152 * linear(g) - 0.0722 * linear(b)) / 0.2126;
    const r = Math.max(0, Math.min(255, Math.round(255 * (rl <= 0.0031308 ? 12.92 * rl : 1.055 * rl ** (1 / 2.4) - 0.055))));
    if (!isSaturatedRed(hex([r, g, b]))) return hex([r, g, b]);
  }
  return hex([r0, g, 255]);
}

// The ramp a dark poster's emission is coloured through (WP10's light.ts takes
// it as `ramp`): HOT, bent by G4 in reduced mode.
export const posterHotRamp = (spec: Pick<PosterSpec, 'redSafe'>): string[] => HOT.map((c) => (spec.redSafe ? redSafe(c) : c));
