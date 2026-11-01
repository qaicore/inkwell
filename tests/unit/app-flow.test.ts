// WP13: the app's two-drawing flow (src/app/flow.ts), the effect the page
// writes from it (src/app/engine.ts's effectOf), the export's flash ladder and
// freeze (src/export/export.ts), and the render-ahead's main-thread side
// (src/app/render-worker.ts). Everything runs on synthetic masks, frames and
// sound, so it's offline and deterministic. Manual X5 (the hero clip on an
// iPhone at 24 fps or more, the export saved to Photos) is Qai's.
import { describe, expect, it } from 'vitest';
import {
  AFTERMATH_SECONDS,
  asSamMask,
  asSamMasks,
  back,
  clearTurn,
  flowMoments,
  forgetStroke,
  impactDone,
  initialFlow,
  limbsDone,
  maskArea,
  moveContact,
  nearestPixel,
  nudgeTurnKey,
  openImpact,
  openLimbs,
  r1Problem,
  REPLAY_FROM,
  setAftermath,
  setFlash,
  setTurnDir,
  snapRoot,
  suggestLimbFrame,
  turnKeyFrames,
  turnTap,
  type DrawnOn,
  type Flow,
  type ImpactCue,
} from '../../src/app/flow.ts';
import { audioEnvelope, effectOf, hasImpact, LIMB_ROOT, limbBrushSize, PALETTE, sceneOwns, type ClipMotion, type Stroke } from '../../src/app/engine.ts';
import { slicedAhead, toTransfer } from '../../src/app/render-worker.ts';
import { audioPlan, exportSize, isIPhone, outputsOf, spliceAudio, walkFlashLadder, type AudioSegment } from '../../src/export/export.ts';
import { checkFlashes, FlashCheckError, flashSummary, type CheckFrame, type FlashReport } from '../../src/export/flash.ts';
import type { DrawingJob, DrawnLayer } from '../../src/impact/contracts.ts';
import { R1_GAP, R1_MESSAGE, SLAM_AFTERMATH, SLAM_FRAMES, suggestImpactFrame } from '../../src/impact/detect.ts';
import { degradeAt, LADDER_STEPS, outputLength, touchedFrames } from '../../src/impact/ladder.ts';
import { fnv1a32 } from '../../src/impact/rng.ts';
import type { ImpactScene } from '../../src/impact/scene.ts';
import { EXAMPLE_TIMING } from '../../src/motion/timing.ts';
import { LIMB_BRUSH } from '../../src/render/brushes.ts';
import type { SamMask } from '../../src/sam/cache.ts';
import type { Mask } from '../../src/track/tracking.ts';
import { parseEffect, serializeEffect, type Effect, type Moment } from '../../src/types/effect.ts';

const S = 1080; // a 1920×1080 clip's short side
const FRAMES = 120;

// ---- Synthetic masks (the detector test's) ----------------------------------------------

type Box = [number, number, number, number]; // x0, y0, x1, y1: frame px, half-open

function boxMask(boxes: readonly Box[], step = 1): SamMask {
  const left = Math.min(...boxes.map((b) => b[0]));
  const top = Math.min(...boxes.map((b) => b[1]));
  const width = Math.ceil((Math.max(...boxes.map((b) => b[2])) - left) / step);
  const height = Math.ceil((Math.max(...boxes.map((b) => b[3])) - top) / step);
  const raster = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) {
    const y = top + (row + 0.5) * step;
    for (let col = 0; col < width; col++) {
      const x = left + (col + 0.5) * step;
      if (boxes.some(([x0, y0, x1, y1]) => x >= x0 && x < x1 && y >= y0 && y < y1)) raster[row * width + col] = 1;
    }
  }
  return { width, height, raster, bounds: { left, top, right: left + width * step, bottom: top + height * step } };
}

// A fist 26 px wide under P (x 930–956) whose bottom is bottoms[f] on frame f.
const fist = (bottoms: readonly number[]) => bottoms.map((b) => boxMask([[930, b - 60, 956, b]]));

// The bottom falls 61, 46, 31, 6, 1 px on frames at, at+1, …, then rests:
// contact is the frame of the 6, at + 3.
function slamBottoms(at: number, frames: number, rest = 880): number[] {
  const falls = [61, 46, 31, 6, 1];
  const out: number[] = [];
  let y = rest;
  for (let f = 0; f < frames; f++) {
    if (f >= at && f < at + falls.length) y += falls[f - at];
    out.push(y);
  }
  return out;
}

// The fist lands on f63 under (943, 1000).
const masks = fist(slamBottoms(60, FRAMES));
const limbsOn = (f: number): DrawnOn[] => [
  { id: 1, frame: f, points: [[900, 500, 0.5], [600, 300, 0.5]] },
  { id: 2, frame: f, points: [[960, 500, 0.5], [1250, 300, 0.5]] },
];
const cracksOn = (f: number): DrawnOn[] => [
  { id: 11, frame: f, points: [[943, 1000, 0.5], [700, 990, 0.5]] },
  { id: 12, frame: f, points: [[943, 1000, 0.5], [1150, 980, 0.5]] },
  { id: 13, frame: f, points: [[943, 1000, 0.5], [990, 900, 0.5]] },
];
const cue = (parked: number | null = null): ImpactCue => ({ parked, masks, S });

// The flow up to the impact sheet, the limbs drawn on f1: Done on the limbs
// opens it on the cue (the parked frame, when given), with no tap between.
const atImpact = (f1 = 40, parked: number | null = null) => limbsDone(openLimbs(initialFlow(), f1), limbsOn(f1), cue(parked));
// Through Done on the impact, drawn on fDrawn.
const atPreview = (fDrawn = 60, f1 = 40) => impactDone(atImpact(f1, fDrawn), { limbs: limbsOn(f1), cracks: cracksOn(fDrawn) }, masks, S);
const slamOf = (flow: Flow) => flowMoments(flow).moments.find((m): m is Moment => m.kind === 'slam');

// ---- The flow ------------------------------------------------------------------------------

describe('the two-drawing flow', () => {
  it('starts idle, with the full impact frames and 1.5 s of aftermath', () => {
    expect(initialFlow()).toMatchObject({ step: 'idle', f1: null, contact: null, flash: 'full', aftermath: 1.5, dir: 1, turn: null });
    expect(SLAM_FRAMES.flash).toBe('full');
    expect(flowMoments(initialFlow())).toEqual({ moments: [], turn: null });
  });

  it('opens Draw limbs on the suggested frame, and Done opens the impact sheet on the cue with no tap between (decision 1)', () => {
    const open = openLimbs(initialFlow(), 22);
    expect(open).toMatchObject({ step: 'limbs', frame: 22 });
    const done = limbsDone(open, limbsOn(22), cue());
    const at = suggestImpactFrame({ parked: null, f1: 22, masks, S }).frame;
    expect(done).toMatchObject({ step: 'impact', frame: at, f1: 22, limbs: [1, 2], turn: null, derived: null, contact: null, message: null });
    expect(flowMoments(done)).toEqual({ moments: [{ kind: 'emerge', at: 22 / 30, strokes: [1, 2] }], turn: null });
    // The frame he parked the scrubber on wins.
    expect(limbsDone(open, limbsOn(22), cue(70))).toMatchObject({ step: 'impact', frame: 70 });
    // Opened again, it opens on the limbs he drew.
    expect(openLimbs(done, 5).frame).toBe(22);
  });

  it('checks the limb drawing: 1 to 6 strokes, all on one frame', () => {
    const open = openLimbs(initialFlow(), 22);
    expect(limbsDone(open, [], cue())).toMatchObject({ step: 'limbs', f1: null, message: 'Draw the limbs first: 1 to 6 strokes, from his body outward.' });
    const seven = Array.from({ length: 7 }, (_, i): DrawnOn => ({ ...limbsOn(22)[0], id: i + 1 }));
    expect(limbsDone(open, seven, cue()).message).toBe("That's 7 limbs; 6 at most.");
    const split = [limbsOn(22)[0], { ...limbsOn(30)[1] }];
    expect(limbsDone(open, split, cue()).message).toBe("The limbs are one drawing: draw them all on one frame (they're on f22, f30).");
  });

  it('needs no turn tap: with none, the pose read decides (decision 4)', () => {
    const impact = atImpact(40, 70);
    expect(impact).toMatchObject({ step: 'impact', frame: 70, turn: null });
    expect(flowMoments(impact).turn).toBeNull();
    expect(flowMoments(atPreview(60)).turn).toBeNull();
    // There is no turn step to pass through.
    for (const flow of [initialFlow(), openLimbs(initialFlow(), 22), impact, atPreview(60)]) expect(['idle', 'limbs', 'impact', 'preview']).toContain(flow.step);
  });

  it('More: This frame keeps his optional tap, with the direction toggle, and leaves the sheet where it is', () => {
    const impact = atImpact();
    const tapped = turnTap(impact, 75);
    expect(tapped).toMatchObject({ step: 'impact', frame: impact.frame, turn: { at: 75 / 30, dir: 1 } });
    const left = turnTap(setTurnDir(impact, -1), 75);
    expect(left.turn).toEqual({ at: 75 / 30, dir: -1 });
    // From any sheet, the preview included.
    expect(turnTap(atPreview(60), 75)).toMatchObject({ step: 'preview', contact: 63, turn: { at: 75 / 30, dir: 1 } });
    expect(turnTap(initialFlow(), 75)).toMatchObject({ step: 'idle', turn: { at: 75 / 30, dir: 1 } });
    // No tap takes it back off.
    expect(clearTurn(tapped)).toMatchObject({ step: 'impact', turn: null });
    expect(clearTurn(impact)).toBe(impact);
  });

  it('needs the limbs before the impact', () => {
    expect(openImpact(initialFlow(), cue())).toMatchObject({ step: 'idle', message: 'Draw the limbs first.' });
    expect(impactDone(initialFlow(), { limbs: [], cracks: cracksOn(60) }, masks, S).message).toBe('Draw the limbs first.');
  });

  it('checks the impact drawing: 2 to 8 strokes, all on one frame', () => {
    const impact = atImpact(40, 60);
    expect(impactDone(impact, { limbs: limbsOn(40), cracks: cracksOn(60).slice(0, 1) }, masks, S)).toMatchObject({
      step: 'impact',
      message: 'Draw 2 to 8 impact strokes, outward from where the hit lands.',
    });
    const split = [cracksOn(60)[0], cracksOn(61)[1]];
    expect(impactDone(impact, { limbs: limbsOn(40), cracks: split }, masks, S).message).toBe("The impact strokes are one drawing: draw them all on one frame (they're on f60, f61).");
  });

  it('Done on the impact snaps the contact and replays from 20 frames before it', () => {
    const done = atPreview(60);
    expect(done).toMatchObject({ step: 'preview', frame: 63 - REPLAY_FROM, fDrawn: 60, cracks: [11, 12, 13], contact: 63, message: null });
    expect(done.derived?.snap).toMatchObject({ frame: 63, found: true, moved: true });
    expect(slamOf(done)?.at).toBeCloseTo(63 / 30, 12);
  });

  it('shows the toast only when the snap moved the contact off the drawn frame', () => {
    expect(atPreview(60).toast).toBe('Contact set to f63, drawn on f60');
    const same = atPreview(63);
    expect(same).toMatchObject({ step: 'preview', contact: 63, toast: null });
    // No contact near the drawn frame: it stays, with no toast.
    expect(atPreview(100)).toMatchObject({ step: 'preview', contact: 100, toast: null });
  });

  it('keeps the impact sheet open with R1 when the contact comes too soon after the limbs', () => {
    // Limbs on f49: the contact needs f64 or later, and it snaps to f63.
    const early = atPreview(60, 49);
    expect(early).toMatchObject({ step: 'impact', fDrawn: 60, cracks: [11, 12, 13], derived: null, contact: null, toast: null });
    expect(early.message).toBe(`${R1_MESSAGE}: they grow out on f49, so the contact needs f64 or later (it is f63)`);
    expect(flowMoments(early).moments.map((m) => m.kind)).toEqual(['emerge']);
    // Opened again, the sheet is where he drew it.
    expect(openImpact(early, cue()).frame).toBe(60);
    expect(r1Problem(49, 49 + R1_GAP)).toBeNull();
    expect(r1Problem(49, 49 + R1_GAP - 1)).toContain(R1_MESSAGE);
  });

  it('Move contact ±1 moves slam.at and nothing else', () => {
    const done = atPreview(60);
    const later = moveContact(done, 1, FRAMES);
    expect(later).toMatchObject({ contact: 64, frame: 64, toast: null, message: null });
    expect(slamOf(later)?.at).toBeCloseTo(64 / 30, 12);
    expect({ ...slamOf(later), at: 0 }).toEqual({ ...slamOf(done), at: 0 });
    const earlier = moveContact(done, -1, FRAMES);
    expect(slamOf(earlier)?.at).toBeCloseTo(62 / 30, 12);
    // Not past the clip's last frame.
    const last = { ...done, contact: FRAMES - 1 };
    expect(moveContact(last, 1, FRAMES)).toBe(last);
    // Nothing to move before the impact's Done.
    expect(moveContact(atImpact(), 1, FRAMES)).toEqual(atImpact());
  });

  it('never moves the contact under R1', () => {
    const tight = atPreview(60, 48); // the contact, f63, is f48 + 15: just allowed
    expect(tight.contact).toBe(63);
    const blocked = moveContact(tight, -1, FRAMES);
    expect(blocked.contact).toBe(63);
    expect(blocked.message).toBe(`${R1_MESSAGE}: they grow out on f48, so the contact needs f63 or later (it is f62)`);
  });

  it('puts the aftermath, 1.5 to 3 s to a tenth, and Reduce flashing on the slam', () => {
    const done = atPreview(60);
    expect(setAftermath(done, 2.26).aftermath).toBe(2.3);
    expect(setAftermath(done, 9).aftermath).toBe(AFTERMATH_SECONDS.max);
    expect(setAftermath(done, 0.2).aftermath).toBe(AFTERMATH_SECONDS.min);
    expect(setAftermath(done, 1.5)).toBe(done);
    expect(slamOf(setAftermath(done, 2.5))?.aftermath).toEqual({ ...SLAM_AFTERMATH, seconds: 2.5 });
    expect(slamOf(done)?.frames).toEqual({ count: 7, flash: 'full' });
    expect(slamOf(setFlash(done, 'safe'))?.frames).toEqual({ count: 7, flash: 'safe' });
    expect(setFlash(done, 'full')).toBe(done);
  });

  it("builds the tap's five keys, mirrors them with the toggle and nudges each a frame", () => {
    const tapped = turnTap(atImpact(), 75);
    expect(turnKeyFrames(tapped.turn!)).toEqual([
      [63, 0],
      [69, 90],
      [75, 180],
      [81, 270],
      [87, 360],
    ]);
    const nudged = nudgeTurnKey(tapped, 2, 1);
    expect(turnKeyFrames(nudged.turn!).map(([f]) => f)).toEqual([63, 69, 76, 81, 87]);
    expect(nudged.turn!.keys![2][0]).toBeCloseTo(76 / 30, 12);
    const mirrored = setTurnDir(nudged, -1);
    expect(mirrored.turn).toMatchObject({ at: 75 / 30, dir: -1 });
    expect(turnKeyFrames(mirrored.turn!)).toEqual([
      [63, 0],
      [69, -90],
      [76, -180],
      [81, -270],
      [87, -360],
    ]);
    // A key can't pass its neighbour or go before f0.
    let squeezed = turnTap(atImpact(), 12);
    for (let i = 0; i < 5; i++) squeezed = nudgeTurnKey(squeezed, 1, -1);
    expect(turnKeyFrames(squeezed.turn!).map(([f]) => f)).toEqual([0, 1, 12, 18, 24]);
    expect(nudgeTurnKey(squeezed, 1, -1)).toBe(squeezed);
    expect(nudgeTurnKey(squeezed, 0, -1)).toBe(squeezed);
    expect(nudgeTurnKey(atImpact(), 0, 1)).toEqual(atImpact()); // no tap, no keys
  });

  it('goes Back without losing anything, and undoing a stroke undoes what its Done read', () => {
    expect(back(openLimbs(initialFlow(), 22))).toMatchObject({ step: 'idle' });
    const done = atPreview(60);
    const reopened = openImpact({ ...done, step: 'idle' }, cue());
    expect(reopened).toMatchObject({ step: 'impact', frame: 60 });
    expect(back(reopened)).toMatchObject({ step: 'preview', contact: 63 });
    expect(back(done)).toBe(done);

    const lessCrack = forgetStroke(done, 12);
    expect(lessCrack).toMatchObject({ step: 'idle', cracks: [11, 13], fDrawn: 60, derived: null, contact: null });
    expect(flowMoments(lessCrack).moments.map((m) => m.kind)).toEqual(['emerge']);
    const lessLimb = forgetStroke(done, 2);
    expect(lessLimb).toMatchObject({ limbs: [1], f1: 40, derived: null, contact: null });
    expect(forgetStroke(lessLimb, 1)).toMatchObject({ limbs: [], f1: null });
    expect(forgetStroke(done, 99)).toBe(done);
  });
});

// ---- The effect the page writes ------------------------------------------------------------------

describe('effectOf with the flow', () => {
  const motion = (flow: Flow): ClipMotion => ({ frameCount: FRAMES, width: 1920, height: S, poses: () => null, units: null, timing: EXAMPLE_TIMING, wobble: true, ...flowMoments(flow) });
  const limb = (l: DrawnOn): Stroke => ({
    id: l.id,
    color: PALETTE[0],
    brush: 'limb',
    size: Math.round(LIMB_ROOT * S),
    frame: l.frame,
    pen: false,
    layer: 'behind',
    kind: 'strand',
    stiffness: 0.1,
    points: l.points.map(([x, y]): [number, number, number] => [x, y, 0.5]),
  });
  const crack = (c: DrawnOn): Stroke => ({
    ...limb(c),
    color: PALETTE[2],
    brush: 'ink',
    size: 17,
    kind: 'rigid',
    stiffness: 1,
    wobble: 0,
    anchor: { type: 'ground', xy: [c.points[0][0], c.points[0][1]] },
  });
  const strokes = [...limbsOn(40).map(limb), ...cracksOn(60).map(crack)];
  const roundTrips = (effect: Effect) => expect(parseEffect(serializeEffect(effect))).toEqual({ effect: JSON.parse(serializeEffect(effect)) });

  it('writes the emerge, the slam with its dir, seed, frames and aftermath, and his tap; and it parses', () => {
    const done = impactDone(turnTap(atImpact(40, 60), 75), { limbs: limbsOn(40), cracks: cracksOn(60) }, masks, S);
    const effect = effectOf(strokes, motion(done));
    expect(effect.moments?.[0]).toEqual({ kind: 'emerge', at: 40 / 30, strokes: [1, 2] });
    const slam = effect.moments?.[1] as Moment;
    expect(slam).toMatchObject({
      kind: 'slam',
      by: 'body',
      strokes: [11, 12, 13],
      limbs: [1, 2],
      seed: fnv1a32(11, 12, 13),
      frames: { count: 7, flash: 'full' },
      aftermath: { seconds: 1.5, scale: 1, scarSeconds: 3 },
    });
    expect(slam.at).toBeCloseTo(63 / 30, 12);
    expect(slam.dir).toHaveLength(2);
    expect(Math.hypot(...slam.dir!)).toBeCloseTo(1, 6);
    expect(effect.turn).toEqual({ at: 75 / 30, dir: 1 });
    roundTrips(effect);
  });

  it('leaves the turn out with no tap, and the slam out until the impact is done', () => {
    const skipped = effectOf(strokes, motion(atPreview(60)));
    expect('turn' in skipped).toBe(false);
    expect(skipped.moments?.map((m) => m.kind)).toEqual(['emerge', 'slam']);
    roundTrips(skipped);
    const limbsOnly = effectOf(strokes, motion(atImpact()));
    expect(limbsOnly.moments).toEqual([{ kind: 'emerge', at: 40 / 30, strokes: [1, 2] }]);
    roundTrips(limbsOnly);
    const none = effectOf(strokes.filter((s) => s.brush !== 'limb'), motion(initialFlow()));
    expect('moments' in none).toBe(false);
    expect(hasImpact(none)).toBe(false);
  });

  it('keeps Move contact and Reduce flashing in the slam it writes', () => {
    const moved = setFlash(moveContact(atPreview(60), 1, FRAMES), 'safe');
    const slam = effectOf(strokes, motion(moved)).moments?.find((m): m is Moment => m.kind === 'slam');
    expect(slam?.at).toBeCloseTo(64 / 30, 12);
    expect(slam?.frames).toEqual({ count: 7, flash: 'safe' });
  });

  it('stores the impact strokes in frame px on the ground, at the size he drew them, and sizes the limb brush from the drawn root', () => {
    const effect = effectOf(strokes, motion(atPreview(60)));
    const ground = effect.strokes.find((s) => s.id === 11)!;
    expect(ground.anchor).toEqual({ type: 'ground', xy: [943, 1000] });
    // Its own size, as px at 1080 wide (the brush's unit), so its crack renders as wide as he drew it.
    expect(ground.size).toBeCloseTo((17 * 1080) / 1920, 2);
    expect(effect.strokes.find((s) => s.id === 1)!.size).toBeUndefined();
    expect(ground.wobble).toBe(0);
    expect(ground.views.front.root).toEqual([943, 1000]);
    expect(ground.views.front.points[0][0]).toBeCloseTo(943, 6);
    expect(ground.views.front.points[31][0]).toBeCloseTo(700, 6);
    // The default size, 0.04 S, is the limb brush's own 28: R0 = 0.020 S.
    expect(limbBrushSize(LIMB_ROOT * S, S)).toBeCloseTo(LIMB_BRUSH.size, 12);
    expect(limbBrushSize(2 * LIMB_ROOT * S, S)).toBeCloseTo(2 * LIMB_BRUSH.size, 12);
    expect(effect.brushes?.limb?.size).toBeCloseTo(limbBrushSize(Math.round(LIMB_ROOT * S), S), 12);
    expect(effect.brushes?.limb?.limb).toBeDefined();
  });

  it('knows which strokes the impact scene draws itself', () => {
    const withSlam = effectOf(strokes, motion(atPreview(60)));
    const before = effectOf(strokes, motion(atImpact()));
    const [l1, , c11] = [strokes[0], strokes[1], strokes[2]];
    const ink: Stroke = { ...l1, id: 30, brush: 'ink' };
    const lateCrack: Stroke = { ...c11, id: 31 }; // drawn after the impact's Done
    expect(hasImpact(withSlam) && hasImpact(before)).toBe(true);
    expect(sceneOwns(l1, before)).toBe(true);
    expect(sceneOwns(c11, before)).toBe(false); // no slam yet: the page draws it
    expect(sceneOwns(c11, withSlam)).toBe(true);
    expect(sceneOwns(lateCrack, withSlam)).toBe(false);
    expect(sceneOwns(ink, withSlam)).toBe(false);
  });
});

// ---- Masks, the root snap and the sound ------------------------------------------------------------

describe('the sheet helpers', () => {
  it('reads a whole-frame mask as a cached one over the whole frame', () => {
    const alpha = new Uint8ClampedArray(4 * 2);
    alpha[1] = 255;
    alpha[6] = 128;
    alpha[7] = 127;
    const m: Mask = { width: 4, height: 2, alpha };
    const sam = asSamMask(m, 400, 200);
    expect(sam.bounds).toEqual({ left: 0, top: 0, right: 400, bottom: 200 });
    expect([...sam.raster]).toEqual([0, 1, 0, 0, 0, 0, 1, 0]);
    expect(maskArea(sam)).toBe(2 * 100 * 100);
    expect(asSamMasks([m, null], 400, 200)[1]).toBeNull();
    expect(nearestPixel(sam, [390, 190])).toEqual([250, 150]);
  });

  it('opens Draw limbs where he is in frame and whole', () => {
    const grow = [null, boxMask([[0, 0, 10, 10]]), boxMask([[0, 0, 100, 100]]), boxMask([[0, 0, 100, 100]]), boxMask([[0, 0, 90, 100]])];
    expect(suggestLimbFrame(grow)).toBe(2);
    expect(suggestLimbFrame([null, null])).toBe(0);
    expect(suggestLimbFrame([])).toBe(0);
  });

  it('snaps a limb root more than 0.05 S off him onto the nearest mask pixel', () => {
    const body = boxMask([[900, 400, 1000, 900]]);
    const off: [number, number, number][] = [[800, 600.5, 0.7], [600, 400, 0.5]]; // 100 px left of him
    const snapped = snapRoot(off, body, S);
    expect(snapped.moved).toEqual([900.5, 600.5]); // the centre of his nearest pixel
    expect(snapped.points).toEqual([[900.5, 600.5, 0.7], [600, 400, 0.5]]);
    const near: [number, number, number][] = [[900 - 0.05 * S + 1, 600.5, 0.5], [600, 400, 0.5]];
    expect(snapRoot(near, body, S)).toEqual({ points: near, moved: null });
    expect(snapRoot(off, null, S)).toEqual({ points: off, moved: null });
  });

  it("reads the clip's sound as the RMS of the mono mix every 10 ms", () => {
    const rate = 8000;
    const loud = Float32Array.from({ length: rate / 10 }, (_, i) => (i < 400 ? 0 : 0.5)); // 100 ms, loud after 50 ms
    const env = audioEnvelope([loud, loud], rate);
    expect(env).toHaveLength(10);
    expect(env.slice(0, 5)).toEqual([0, 0, 0, 0, 0]);
    for (const v of env.slice(5)) expect(v).toBeCloseTo(0.5, 6);
    expect(audioEnvelope([loud, Float32Array.from(loud, (v) => -v)], rate)).toEqual(Array(10).fill(0)); // opposite channels cancel
    expect(audioEnvelope([loud], rate, 0.05)).toHaveLength(5);
    expect(audioEnvelope([], rate)).toEqual([]);
  });
});

// ---- The export ------------------------------------------------------------------------------------

const solid = (v: number): CheckFrame => {
  const data = new Uint8ClampedArray(160 * 90 * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = data[i + 1] = data[i + 2] = v;
    data[i + 3] = 255;
  }
  return { data, width: 160, height: 90 };
};
const GREY = solid(128);
const FAILING = checkFlashes(Array.from({ length: 30 }, (_, i) => solid(i % 2 ? 255 : 0)), 30);
const PASSING = checkFlashes(Array.from({ length: 30 }, () => GREY), 30);

// A checker that fails k times, then passes.
function failing(k: number, lengths: number[] = []) {
  let calls = 0;
  return (frames: readonly CheckFrame[]): FlashReport => {
    lengths.push(frames.length);
    return calls++ < k ? FAILING : PASSING;
  };
}

describe("the export's flash check", () => {
  const I = 84;
  const first = Array.from({ length: FRAMES }, () => GREY);

  it('fails a frame-by-frame black and white clip, and says so plainly', () => {
    expect(FAILING.pass).toBe(false);
    expect(PASSING.pass).toBe(true);
    expect(flashSummary(FAILING)).toContain('flashes more than 3 times a second');
  });

  it('applies steps 1..k, re-rendering only the frames each touches, for a checker failing k times', async () => {
    for (let k = 1; k <= LADDER_STEPS; k++) {
      const steps: number[] = [];
      const renders: { step: number; from: number; to: number }[] = [];
      const lengths: number[] = [];
      const walk = await walkFlashLadder({
        frames: FRAMES,
        I,
        flash: 'safe',
        first,
        render: (step, from, to) => {
          renders.push({ step, from, to });
          return Array.from({ length: to - from }, () => GREY);
        },
        check: failing(k, lengths),
        onStep: (step) => steps.push(step),
      });
      const asked = Array.from({ length: k }, (_, i) => i + 1);
      expect(walk).toMatchObject({ step: k, pass: true });
      expect(walk.reports).toHaveLength(k + 1);
      expect(steps).toEqual(asked);
      expect(renders).toEqual(asked.map((step) => ({ step, ...touchedFrames(step, I, outputLength(FRAMES, I, degradeAt(step, 'safe'))) })));
      // Each check sees the whole video at that step: 26 frames longer from the freeze on.
      expect(lengths).toEqual([0, ...asked].map((step) => outputLength(FRAMES, I, degradeAt(step, 'safe'))));
    }
  });

  it('throws FlashCheckError when step 7 still fails, and saves nothing', async () => {
    const walking = walkFlashLadder({ frames: FRAMES, I, flash: 'safe', first, render: (_, from, to) => Array.from({ length: to - from }, () => GREY), check: failing(8) });
    await expect(walking).rejects.toBeInstanceOf(FlashCheckError);
    await expect(walkFlashLadder({ frames: FRAMES, I, flash: 'safe', first, render: (_, from, to) => Array.from({ length: to - from }, () => GREY), check: failing(8) })).rejects.toThrow(
      /nothing was saved\. This video flashes more than 3 times a second/,
    );
  });

  it('changes nothing under full flashing: one check, and the warning', async () => {
    let rendered = 0;
    const walk = await walkFlashLadder({
      frames: FRAMES,
      I,
      flash: 'full',
      first,
      render: () => {
        rendered++;
        return [];
      },
      check: failing(8),
    });
    expect(walk).toMatchObject({ step: 0, pass: false });
    expect(walk.reports).toHaveLength(1);
    expect(rendered).toBe(0);
    expect(flashSummary(walk.report)).toContain('more than 3 times a second');
  });

  it('renders step 0 itself when the encode made no copies, and passes a clip that never flashes', async () => {
    const walk = await walkFlashLadder({ frames: 30, I: null, flash: 'safe', render: (_, from, to) => Array.from({ length: to - from }, () => GREY) });
    expect(walk).toMatchObject({ step: 0, pass: true });
    expect(walk.report.frames).toBe(30);
  });

  it('throws at once under Reduce flashing when a clip with no slam flashes on its own', async () => {
    await expect(walkFlashLadder({ frames: FRAMES, I: null, flash: 'safe', first, render: () => [], check: failing(1) })).rejects.toBeInstanceOf(FlashCheckError);
  });
});

describe("the freeze's frames and sound (ladder step 4)", () => {
  const I = 84;
  const d4 = degradeAt(4, 'safe');

  it('makes the video 26 frames longer and plans 26 frames of silence after I + 9', () => {
    expect(d4.freeze).toBe(true);
    expect(outputLength(254, I, d4)).toBe(254 + 26);
    expect(audioPlan(I, d4)).toEqual({ at: (I + 9) / 30, gap: 26 / 30 });
    expect(audioPlan(I, degradeAt(3, 'safe'))).toBeNull();
    expect(audioPlan(I, degradeAt(7, 'full'))).toBeNull();
    expect(audioPlan(null, d4)).toBeNull();
  });

  it('shows clip frame I on 35 output frames, I + 1..I + 8 on none, and the rest 26 frames later', () => {
    expect(outputsOf(I - 1, I, d4)).toEqual([I - 1]);
    expect(outputsOf(I, I, d4)).toEqual(Array.from({ length: 35 }, (_, n) => I + n));
    for (let c = I + 1; c <= I + 8; c++) expect(outputsOf(c, I, d4)).toEqual([]);
    expect(outputsOf(I + 9, I, d4)).toEqual([I + 35]);
    expect(outputsOf(100, I, degradeAt(3, 'safe'))).toEqual([100]);
    const all = Array.from({ length: FRAMES }, (_, c) => outputsOf(c, I, d4)).flat();
    expect(all).toEqual(Array.from({ length: outputLength(FRAMES, I, d4) }, (_, o) => o));
  });

  it('inserts the silence once, at I + 9, and moves the sound after it 26 frames later', () => {
    const rate = 48_000;
    const plan = audioPlan(I, d4)!;
    const t0 = 0.02; // the clip's first frame on the sound's timeline
    const segments: AudioSegment[] = [];
    let inserted = false;
    for (let i = 0; i < 200; i++) {
      const out = spliceAudio({ timestamp: t0 + (i * 1024) / rate, numberOfFrames: 1024, sampleRate: rate }, plan, t0, inserted);
      inserted ||= out.some((seg) => seg.kind === 'silence');
      segments.push(...out);
    }
    expect(segments.filter((seg) => seg.kind === 'silence')).toEqual([{ kind: 'silence', frames: 41_600, timestamp: t0 + (I + 9) / 30 }]);
    const kept = segments.reduce((n, seg) => n + (seg.kind === 'audio' ? seg.to - seg.from : 0), 0);
    expect(kept).toBe(200 * 1024);
    // One after the other, with no gap or overlap: the silence sits between.
    let end = t0;
    for (const seg of segments) {
      expect(seg.timestamp).toBeCloseTo(end, 4);
      end = seg.timestamp + (seg.kind === 'audio' ? seg.to - seg.from : seg.frames) / rate;
    }
    expect(end).toBeCloseTo(t0 + (200 * 1024) / rate + 26 / 30, 4);
  });
});

describe('the export size', () => {
  it('is 720p on an iPhone and 1080p elsewhere, never above the clip, with even sides', () => {
    expect(exportSize(1920, 1080, true)).toEqual({ width: 1280, height: 720, long: 1280 });
    expect(exportSize(1920, 1080, false)).toEqual({ width: 1920, height: 1080, long: 1920 });
    expect(exportSize(1080, 1920, true)).toEqual({ width: 720, height: 1280, long: 1280 });
    expect(exportSize(3840, 2160, false)).toEqual({ width: 1920, height: 1080, long: 1920 });
    expect(exportSize(1280, 720, false)).toEqual({ width: 1280, height: 720, long: 1280 });
    expect(exportSize(1001, 563, false)).toEqual({ width: 1000, height: 562, long: 1001 });
  });

  it('tells an iPhone by its user agent', () => {
    expect(isIPhone('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toBe(true);
    expect(isIPhone('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15')).toBe(false);
    expect(isIPhone('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36')).toBe(false);
  });
});

// ---- The render-ahead ------------------------------------------------------------------------------------

describe("the render-ahead's main-thread side", () => {
  // A scene with only what the render-ahead reads.
  function fakeScene(jobsAt: (o: number) => DrawingJob[]) {
    const ran: string[] = [];
    const scene = {
      jobs: jobsAt,
      runJob: (job: DrawingJob | string) => {
        ran.push(typeof job === 'string' ? job : job.key);
        return { key: typeof job === 'string' ? job : job.key, kind: 'limb', parts: [] };
      },
    } as unknown as ImpactScene;
    return { scene, ran };
  }
  const job = (key: string, due: number): DrawingJob => ({ key, kind: 'mass', due, estMs: 12 });

  it('runs one job a task, the soonest due first, and drops the ones whose frame has gone by', () => {
    const tasks: (() => void)[] = [];
    const ahead = slicedAhead((run) => tasks.push(run));
    const { scene, ran } = fakeScene((o) => (o === 10 ? [job('c', 13), job('a', 11), job('b', 12)] : [job('b', 12), job('d', 14)]));
    expect(ahead.mode).toBe('main');
    ahead.scene(scene, null);
    ahead.ahead(10);
    expect(ahead.pending().map((j) => j.key)).toEqual(['a', 'b', 'c']);
    expect(tasks).toHaveLength(1); // one task at a time
    tasks.shift()!();
    expect(ran).toEqual(['a']);
    ahead.ahead(12); // b's frame is on screen: too late for it
    expect(ahead.pending().map((j) => j.key)).toEqual(['b', 'c', 'd']);
    while (tasks.length > 0) tasks.shift()!();
    expect(ran).toEqual(['a', 'c', 'd']);
    ahead.scene(null, null);
    ahead.ahead(13);
    expect(ahead.pending()).toEqual([]);
  });

  it("copies each part's canvas into a bitmap to post, and posts no image for an empty part", async () => {
    const part = (key: string, width: number) => ({ key, slot: 'fire' as const, name: 'fire', image: { canvas: key }, x0: 0, y0: 0, width, height: 10 });
    const layer: DrawnLayer = { key: 'mass:x', kind: 'mass', parts: [part('one', 10), part('empty', 0), part('two', 5)] };
    const made: unknown[] = [];
    const { layer: ready, transfer } = await toTransfer(layer, async (image) => {
      made.push(image);
      return { bitmap: image } as unknown as ImageBitmap;
    });
    expect(made).toEqual([{ canvas: 'one' }, { canvas: 'two' }]);
    expect(transfer).toHaveLength(2);
    expect(ready.parts.map((p) => p.image)).toEqual([{ bitmap: { canvas: 'one' } }, null, { bitmap: { canvas: 'two' } }]);
    expect(layer.parts[0].image).toEqual({ canvas: 'one' }); // the worker's own layer keeps its canvas
  });
});
