# Inkwell spec

This is the only spec. It merges the hackathon plan, the build spec, the motion engine, the reference-data guide, the setup steps and the research notes into one file, in the order the work happens. It's the contract: milestones say what to build, acceptance criteria define "done", and only Qai changes their thresholds (a threshold marked *(start)* is a first guess he tunes after the first run). If an older note disagrees with this file, this file wins.

**Read in this order:** §1 what Inkwell is, §2 the rules, §3 the order of work. Look up §4–§16 when a milestone needs them.

## Contents

1. What Inkwell is
2. Rules
3. Order of work
4. The milestone loop
5. One-time setup
6. Architecture and code rules
7. Effect data
8. The engine
9. Meta models, proxy and probe
10. Acceptance criteria
11. Fixtures and reference data
12. Already built
13. Judging, prizes and the demo
14. Risks and fallbacks
15. Not in v1
16. Prior work and sources

---

## 1. What Inkwell is

Qai draws once, on one frame of a phone clip, and the drawing lives in the footage (an impact takes one more drawing, on the floor where he lands the hit, §8.9). From then on, the drawn tendrils, horns or tail:

- stay locked to his body through the whole clip
- move on 2s like hand-drawn anime: each drawing holds, the line boils slightly, and motion overshoots and settles along arcs
- show the view he drew at each angle when he turns, passing behind and in front of his body correctly
- slam down onto the floor where he lands a hit, then recoil (§8.9)
- fire on moments: on the hit, seven impact frames strobe, then the floor cracks and erupts in fire, smoke, dust and electricity (§8.9)

"Exact" has two parts:
- the output matches Qai's reference data in `reference/` on every criterion in §10
- Qai approves the contact sheet

**Who and when.** A build by Qai for the Meta Global AI Developer Hackathon: Indie Developer track, theme "Build for Your World". It's due Wed Nov 4 at 9:00 PM ET.

**Division of labor.** SAM 3.1 gives his body (`person`) and face (`face`) masks, which the app reads from saved answers. Muse Wonder labeled which way he faces on the probe clip (`fixtures/probe/report.md`); the app doesn't read that answer. Everything that moves is code written for Inkwell.

**Hero effect.** Horns, a halo and a tail come first. The hero is a four-tendril kagune in the limb brush (§8.8), with electricity crackling around it, floppy (stiffness about 0.1), slamming into an impact (§8.9). A second look for it: crystal blades in the blade brush, with trails and the flame aura.

**Two drawings make the hero.** Nothing else is required: no taps, no keys, no extra drawings.
1. **The limbs, on a start frame.** One to six strokes out from his body in the limb brush: cel-shaded 3D tubes with electricity crackling around them. They grow out of him on that frame (the emergence) and move with him from then on, on 2s: floppy ropes that drag behind his turns and never pass through his body (§8.5).
2. **The impact, on an end frame.** A few strokes on the floor where he lands the hit. The app finds the contact frame in the person mask under the drawing, plus the impact point and the strike direction. The limbs slam down onto that point, seven impact frames strobe on the contact, and the floor erupts (§8.9).

The turn is read from the pose track where that's reliable. One optional tap, on the frame where his back faces the camera, overrides it; with neither, he doesn't turn (§8.5).

**Hero test** (the demo's first shot, §13). Qai spins a full turn with the kagune whipping around him. Then the kagune slams down onto a point on the floor and stays pinned there while his fist lands on the same point, as the reference short does it (limbs first, §8.9): seven impact frames strobe, then the floor cracks and erupts in fire, smoke, dust and electricity. The camera is on the tripod the whole time.

**Inputs and outputs.**
- **Clip:** MP4 or MOV, under 15 s, one person. The app first converts it in the browser to H.264 at a constant 30 fps, using Mediabunny. After that, frame index `f = round(τ·30)` is the clock.
- **Devices:** desktop Chrome is where the app has been run. iPhone Safari and iPad Safari are the other targets, through phone mode (`npm run dev:phone`, §12); neither has been checked.
- **Drawing:** pointer events. On iPhone it's a finger: no pressure, so perfect-freehand simulates it from speed, with more smoothing for fast finger strokes; the canvas takes `touch-action: none` and ignores a second touch while drawing. Pencil pressure on iPad; mouse or pen in desktop Chrome. Three colors and ten brushes (§8.8): the current ink brush (perfect-freehand), textured, fine-tip ink, fine-tip textured, neon in a straight and a round tip, electric, blade, trail and limb. Plus one effect nobody draws: the flame aura around the person (§8.6).
- **Output:** an MP4 (H.264, original audio), exported at up to 1080p on desktop Chrome and at 720p on a phone.
- **Phone budget.** Everything is sized for an iPhone first: a fixed internal resolution of 1080 px on the long side in video coordinates (not screen pixels), the glow at quarter resolution, reused buffers, one video texture, recovery from a lost WebGL context by rebuilding from the stroke data, and no stroke redraw on frames where nothing changed. The preview holds 24 fps or better on Qai's iPhone *(start)*.

## 2. Rules

Breaking any of these can disqualify the project or make the checks meaningless.

1. **New work only.** Write everything fresh. Copy nothing written before Oct 26, 2026, including the old rope sandbox and the draw-to-component tool. The repo is public, and its first commit comes after the Oct 26 kickoff.
2. **No anime material** in the repo, the app or the video: no footage, frames, screenshots or audio. `reference/` holds only Qai's own drawings and the numbers he measured. The kagune design is original and drawn new during the event (his portfolio kagune is pre-event work); it isn't Kaneki's.
3. **Secrets stay out of git.**
   - Keys live only in `.env`, and in `.dev.vars` for the Pages Function's local dev. Both are gitignored from the first commit.
   - Never print, log or commit a key. To check for leaks, run `node scripts/scan-secrets.mjs`; it never prints values.
4. **Paid API calls happen in two places only:**
   - `scripts/live/`, where every script has a spend cap and a confirmation prompt

   Tests, hooks and `/run-checkers` read cached fixtures and never touch the network. `npm run probe` and `npm run fixtures:refresh` cost money: run them only when Qai says go.
5. **Qai owns the checks.** Don't edit any of these:
   - thresholds in this file
   - `reference/`
   - `fixtures/*/truth.json`, `fixtures/manual/`, `fixtures/required-clips.json`
   - `fixtures/strokes/labels.json` and `fixtures/clips.json` (Qai's labels and consent records)
   - `tests/golden/`
   - the checking setup in `.claude/` (agents, hooks, skills, settings)

   Never loosen a test to make it pass. Only Qai writes `[qai-approved]`. A guard hook enforces all of this; Qai can lift it for setup edits by starting Claude Code with `INKWELL_SETUP_EDITS=1`. If a threshold looks wrong, stop and ask him.
6. **Attribution.** `README.md` has a section "Built Oct 26 – Nov 4". It separates Meta's models (SAM 3.1, Muse Wonder) and the open-source libraries. Keep it current from M0 on, and update the library list whenever `package.json` changes. The demo video shows only features built during the event.
7. **Consent.** Every clip in the repo, the demo or the posts is shot by Qai or by the person in it. Every clip with someone other than Qai is listed in `fixtures/clips.json` with their written consent noted. If a clip isn't listed, don't use it in fixtures, the repo, the demo or the posts. Local testing is the exception: stock clips (for example the Pexels sample) may be used for local test runs, kept only in the gitignored `samples/` folder. No copyrighted music, no downloaded reels.
8. **Submission.** Enter the Indie Developer track only. Submit at https://cerebralvalley.ai/e/meta-ai-developer-hackathon/hackathon/submit with the public repo and the demo video link. Questions go to the Discord forum, where Meta also runs office hours.

## 3. Order of work

### Milestones

From M1 on, every milestone also re-runs the earlier milestones' K, P, A and T criteria on its own clip set (§11, "Clips required at each milestone"). R1–R5 run at every milestone. The last column says what needs a working Meta API key.

M0 and M1 need no key at all: every criterion that needs SAM or Wonder output starts at M2. (The kit put PROBE in M0 and K1–K3 in M1; they moved to M2 on Oct 27 because the credits hadn't arrived, and the checkers count missing evidence as a FAIL.)

| ID | Build | Criteria | Needs the API key |
|---|---|---|---|
| M0 | The M0 checklist below, including the probe script (not run) | R1–R5 | No |
| M1 | Clip conversion; anchors (One Euro filter, torso space), developed on the stand-in tracker (§12); physics engine (2-hour cap); stepped renderer with boil; contact sheets; `/label` page | P1–P5, A1, A2, A6 | No |
| M2 | The probe run; cached SAM fixtures for the required clips; Wonder plan call with schema check and one retry; override UI; nearest-mask baseline; Gate 1 (one full run, clip to playback; ugly is fine); the nine brushes and the brush picker (§8.8); the flame aura (§8.6) | PROBE, K1–K3, W1, W2, W3, G1, B1–B4 | PROBE, K1–K3, W1, G1 (W2 and W3 can use recorded responses; B1–B4 are API-free) |
| M3 | Turn: facing from the pose track where it's reliable, or one optional tap (§8.5); the 3D lift for single-view effects (§8.5), with per-point layering and occlusion; views mode (draw side and back over a faint front) and view blending, which override the lift where Qai draws a view | T2–T5, A3, A4, A7 | T4 and the re-run K criteria; T2, T3, T5 and A3, A4, A7 are API-free |
| M4 | Wonder facing labels and fusion; MP4 export, iPhone first (720p) then desktop (1080p) | T1, W1 (final), X1, X5 | T1, W1 (X1 is API-free) |
| M5 | In priority order: finish M3 if it slipped; then the impact (§8.9) from the two drawings: the limb brush and its electricity (§8.8), rope limbs that collide with his body (§8.5), the emergence, the slam-down, the impact frames with the flash check on export, and the aftermath (cracks, fire, smoke, dust, debris and lightning); | B1–B3 (ten brushes), I1–I9, I10–I11, S1–S6, T6, L1 | No (they read cached masks or synthetic bodies; I9's device gate is Qai's iPhone run) |
| M6 | Every suite on the full clip set | all | yes |

**M0 checklist:**
1. **Commit the skeleton first.** `package.json`, Vite, strict TypeScript and vitest, committed before test-author runs.
2. **`npm run check:fast`.** It typechecks `src/` and `tests/unit/` and runs `tests/unit/` only. The acceptance tests in `tests/M*/` are typechecked and run by `npm run verify`.
3. **`npm run verify`.** It writes `verify/out/tree.txt` (the `node scripts/tree-hash.mjs` value, taken before anything else runs), `verify/out/tests.json` (vitest's JSON reporter) and one `verify/out/<ID>.json` per criterion. From M1 on it also writes `verify/out/<id>/sheet.png`, `timing-strip.png` and `reference-strip.png` (§8.6), which the motion-critic reads.
4. **`npm run golden:accept -- <id>`.** It copies the approved sheets into `tests/golden/<id>/`.
5. **`scripts/scan-secrets.mjs`.** It loads `.env` and `.dev.vars` inside its own process, then scans every tracked file plus `git log -p --all` for the secret values. On a hit it prints only `file:line` and the variable name, never the value, and exits 1.
6. **`fixtures/required-clips.json`.** It ships with the kit and holds the table in §11. Tests read it, along with `verify/ACTIVE`, to know which clips to run. Only Qai edits it.
7. **`README.md`.** It contains the section "Built Oct 26 – Nov 4": SAM 3.1 and Muse Wonder, and the open-source libraries from `package.json`.
8. **The proxy skeleton**, in `functions/`.
9. **`scripts/live/probe.mjs`.**

### Until the API credits arrive

The credits hadn't arrived on Oct 27. Don't wait for them:
- **Build each milestone on its day, claim in order.** M0 and M1 are claimed as soon as they pass. From M2 on, build on schedule, using recorded or stand-in data where the key is missing, and claim each milestone once its SAM and Wonder fixtures are cached. The checkers only run at a claim, and they re-run earlier criteria, so claims go M2, M3, M4 in order even if the building ran ahead.
- **The day the key works:** run the probe (`npm run probe`), refresh the fixtures for the required clips (`npm run fixtures:refresh`), then claim the waiting milestones in order. Both commands cost money, so Qai says go first.
- **Never claim stand-in numbers.** The stand-in is for building and testing what comes after tracking. K1–K3, T1, W1 and every tracking claim in the README or video are measured on SAM 3.1 and Muse Wonder output.

### Cut order

If work falls behind, cut in this order: the impact's floods, then its aftermath lightning, debris chunks and dust wall (the impact frames, the limbs and the cracks are never cut), the flame aura, Wonder's turn labels (the pose track and the tap carry the turn), views mode and view blending (the 3D lift carries every view), rigid presets, the textured and fine-tip brushes (keep ink and neon), the blade and trail brushes, wobble polish, export polish. Never cut the tests, the demo video, or the flash check on export and its Reduce flashing toggle. No switching projects after the probe; from then on, only cuts.

## 4. The milestone loop

1. **Start.** Qai types `/milestone <id>` to begin.
2. **Tests first.** The `test-author` subagent writes failing tests for the milestone's criteria. Commit them alone and tag the commit `milestone-<id>-tests`. Don't write or edit those tests yourself; if one is wrong, send it back to test-author with the reason, and tell Qai.
3. **Build in small steps.** After every code edit, the PostToolUse hook runs `npm run check:fast`. Fix what it reports before the next step. Add unit tests in `tests/unit/` for each module.
4. **Verify.** Run `npm run verify` (it writes `verify/out/` and stamps `verify/out/tree.txt`). Then run `/run-checkers`, which runs the checker subagents in parallel. Make no edits until every checker has returned.
5. **Fix and repeat.** After 5 rounds without all PASS, stop and report to Qai: what fails, the evidence files, and your best hypothesis.
6. **Claim.** When every verdict passes, write the milestone id to `verify/CLAIM` with the Write tool as your last action. Then end the turn with the handoff for Qai. The Stop hook re-checks the verdicts; if it sends you back, do what it says.
7. **Sign-off.** Qai compares `verify/out/<id>/sheet.png` with `verify/out/<id>/reference-strip.png`. He replies "approved", or says what's off in animator terms: "strike lands a drawing late", "overshoot too small", "boil too strong", "side view pops". The checkers can't act on "looks off". Only his "approved" finishes a milestone. Then run `npm run golden:accept -- <id>`, ask him to commit the goldens himself, and delete `verify/ACTIVE`. His commit:
   ```
   git add tests/golden
   git commit -m "M1 goldens [qai-approved]"
   ```

**Taste vs engineering.** Qai decides taste: timing, poses, line, colors, thresholds. When a taste question comes up, ask him one question and show the contact sheet. Make engineering calls yourself and keep them simple. Explain each in 2–3 lines in the commit message: name the technique (Verlet integration, One Euro filter) and say why it fits. Qai is learning from this repo.

**When a checker keeps failing.** After 5 rounds Claude stops and reports. Qai decides: change the threshold (his own `[qai-approved]` commit), or cut that criterion's feature.

**Cost.** `/run-checkers` spawns up to four agents, so run it at milestone gates, not after every edit. The edit hook covers each edit. If usage limits bite, run `/run-checkers` only at the end of each milestone.

**Commands** (PowerShell-safe: one command per line):

```
npm install
npm run dev
npm run dev:phone
npm run check:fast
npm run verify
npm run golden:accept -- M1
node scripts/scan-secrets.mjs
npm run probe
npm run fixtures:refresh -- side-step
```

`probe` and `fixtures:refresh` cost money. `dev:phone` serves the app over HTTPS on the local Wi-Fi (§12).

## 5. One-time setup

PowerShell, in the Inkwell repo. The kit's files are already unzipped into the repo root, next to `.git` (Oct 27).

1. **Commit the kit on its own.** Its `.gitignore` already covers `.env` and `.dev.vars`. Add the kit's paths by name, so the prototype code isn't swept into the commit:
   ```
   git add .claude CLAUDE.md docs fixtures reference scripts env.example .gitignore
   git commit -m "Add Claude Code kit: spec, checkers, hooks [qai-approved]"
   ```
2. **Make the two secrets files,** then paste the Meta API key into both:
   ```
   Copy-Item env.example .env
   Copy-Item env.example .dev.vars
   ```
3. **ffmpeg** (the probe pulls frames with it): `winget install Gyan.FFmpeg`, then reopen PowerShell and run `ffmpeg -version`.
4. **Start Claude Code in the repo root** and confirm the setup: ask it to list its subagents (test-author, acceptance-judge, motion-critic, tracking-auditor, rules-auditor), and run `/hooks` to check that PreToolUse, PostToolUse and Stop each show one hook.
5. **First message,** typed as is (it has to start with /milestone):
   ```
   /milestone M0 Build only M0: the repo skeleton and the probe, no UI. When the probe script is ready, show me the exact command and its estimated cost, and wait for my go before any paid call.
   ```

After that, Qai types `/milestone M1`, then M2 and so on, one at a time, on the days in §3. To let Claude edit the checking setup, restart it with the switch on, then turn it back off:

```
$env:INKWELL_SETUP_EDITS = "1"
claude
Remove-Item Env:INKWELL_SETUP_EDITS
```

## 6. Architecture and code rules

```
src/
  app/       UI: load clip, draw (finger on iPhone first, Pencil on iPad, mouse in desktop Chrome), views mode,
             plan panel with one-tap overrides, timeline, preview, /label page for ground truth
  video/     CFR conversion (Mediabunny -> H.264, constant 30 fps), frame index from timestamps
  sam/       SAM 3.1 client (through the proxy), prompt builders, mask decoding, cache by clip hash
  plan/      Muse Wonder: stroke plan (numbered strokes on the frame) and facing labels
  track/     anchors from masks (centroid, second-moment angle, sqrt-area scale), One Euro filter
  turn/      facing angle from the pose track + Wonder labels + the turn tap or keys; view blending; layers
  lift/      the 3D lift (§8.5): torso ellipsoid and head ball, the 3D rope, the crash-test dummy and the
             pre-scan it collides with, per-point layering, the turn, the strike controller, the limb tube
  physics/   one engine: Verlet chain + pull toward a target shape, fixed timestep, seeded
  motion/    stepped drawings on 2s/3s, line boil, action presets composed with view targets, moments
  impact/    the impact (§8.9): contact detector, clocks and seeds, the floor and its estimate, strike,
             impact frames, aftermath, camera, palette roles, scene driver and render tiers
  render/    perfect-freehand outlines; the limb's bands, arcs and pulses; layer stack, glow and grade;
             compositing around the person mask; contact sheets
  export/    WebCodecs MP4 on iPhone (720p), iPad and desktop Chrome (1080p), original audio; the flash
             check on every export (§8.9)
  bench/     the limb and slam bench behind I9's device gate (bench.html)
  types/     shared types, including effect.ts (the effect JSON in §7)
functions/   Cloudflare Pages Function: a proxy for the Meta API. The app doesn't use it and it has not been deployed
scripts/     verify pipeline, metrics, tree-hash.mjs, scan-secrets.mjs; scripts/live/ = paid calls
tests/       unit/ (fast), M1/ M2/ ... (acceptance, one file per criterion), golden/ (approved looks)
fixtures/    cached SAM and Wonder outputs per clip, truth.json, clips.json, required-clips.json, manual/
reference/   Qai's timing sheet and drawn views
verify/      generated and gitignored: out/, verdicts/, tmp/, ACTIVE, CLAIM
```

**Stack.** Vite and strict TypeScript with one Canvas2D canvas (Canvas2D is the reference path; an optional WebGL canvas is only a preview fast path for the grade, §8.9) and an OffscreenCanvas worker that renders drawings ahead, on Cloudflare Pages with one Pages Function (the setup Qai shipped Suspect on). The OpenAI SDK pointed at `https://api.meta.ai/v1`. perfect-freehand for the brush: the physics moves its input points and the outline is redrawn every drawing, so the line stays his. The project (clip ID plus strokes) moves between iPad Safari (drawing) and desktop Chrome (export) as one JSON file.

**Rules for the code:**
- **Deterministic.** A fixed timestep of 1/120 s and seeded randomness, so the same input gives byte-identical output. The goldens depend on this.
- **One code path.** Physics, motion and rendering run headless in Node for tests (with a Node canvas such as `@napi-rs/canvas`) and on the browser canvas in the app.
- **Storage vs simulation.** Store strokes, views and preset keys in torso space: origin at the anchor, x toward screen right when he's upright, y down, unit = torso height. Run the physics in pixels, converting targets every step with the current torso transform. That's what makes body motion produce follow-through.
- **Hold vs placement.** Hold each drawing in torso space and place it on every video frame with that frame's torso transform. The shape steps on 2s; the placement follows the body.
- **Clock.** After CFR conversion, the frame index `f = round(τ·30)` is the clock. Drawing index `k = floor(f·dps/30)` uses integer math.
- **Boundaries.** Give modules typed boundaries, and don't reach into another module's internals.

## 7. Effect data (`src/types/effect.ts`)

```ts
type Vec2 = [number, number];                 // torso space: origin at anchor, x toward screen right when upright, y down, unit = torso height
interface StrokeView {
  points: Vec2[];                             // resampled by arc length (32 by default, see A6), same count in every view
  pressure: number[];                         // one value per point, 0..1
  root: Vec2;                                 // where the stroke attaches in this view
  layer: 'behind' | 'front';                  // relative to the body in this view
}
type BrushId = 'ink' | 'textured' | 'fine-ink' | 'fine-textured' | 'neon-straight' | 'neon-round' | 'electric' | 'blade' | 'trail' | 'limb';
interface BrushSettings {
  size: number; thinning: number; smoothing: number; streamline: number;   // perfect-freehand
  grain?: number;                             // textured brushes: 0..1, how much of the fill the grain removes
  glow?: { radiusPx: number; intensity: number };  // neon, electric, blade, trail and limb brushes, at 1080 wide
  bolt?: { bendPx: number; ampPx: number; elbows: number; shards: number };  // electric: bend spacing, sideways reach, share of sharp elbows, shards per drawing at most, at 1080 wide
  limb?: { radius: number; taper: number; socket: number; bands: [number, number, number]; linePx: number;
           arcs: number; arcLift: [number, number]; pulseEvery: [number, number] };  // the limb brush (§8.8); radius and linePx are shares of S
}
interface Stroke {
  id: number;                                 // drawing order; the same id in every view
  color: 0 | 1 | 2;
  brush?: BrushId;                            // missing = 'ink'
  accent?: 0 | 1 | 2;                         // blade: the color of the reflected light on its shadow edge; missing = its own color
  kind: 'strand' | 'rigid';                   // rigid = follows its target exactly (horns, halo)
  anchor: { type: 'concept'; prompt: string } | { type: 'point'; time: number; xy: [number, number] }
        | { type: 'ground'; xy: [number, number] };   // fixed frame pixels (tripod): cracks on the floor
  appear?: { at: number; drawOn: number };    // seconds: hidden before `at`, then drawn on from the root over `drawOn`
  bodyAngle: number;                          // degrees around the torso: 0 chest, 90 his right side, 180 center of back, 270 his left side
  stiffness: number;                          // strands only: 0 = rope ... 1 = stiff
  wobble: number;                             // boil scale 0..1
  size?: number;                              // ground strokes: the brush size it was drawn at, px at 1080 wide; missing = the effect's brush size
  views: { front: StrokeView; side?: StrokeView; back?: StrokeView; left?: StrokeView };
}
interface Moment {                            // the impact (§8.9)
  kind: 'slam';
  at: number;                                 // seconds into the clip: the contact frame I, found under the impact drawing
  xy: [number, number];                       // impact point P, frame pixels
  by: 'body' | 'effect';                      // his fist, or the end of the slam preset (parked, §8.9)
  dir?: [number, number];                     // strike direction d, screen, y down; missing = (0, 1)
  seed?: number;                              // missing = fnv1a of the impact stroke ids
  strokes?: number[];                         // the impact strokes; missing = every ground stroke
  limbs?: number[];                           // the limbs that slam down; missing = every limb stroke
  frames?: { count: 0 | 7; flash: 'safe' | 'full' };  // the impact frames; missing = { 7, 'full' }; 'safe' = Reduce flashing
  aftermath?: { seconds: number; scale: number; scarSeconds: number };  // missing = { 1.5, 1, 3 }; seconds 1.5..3
  floor?: { ratio: number; majorDeg: number; up: [number, number]; persp: number };  // how the floor lies around P; the app reads it from him (§8.9); missing = { 0.5, 0, (0, −1), 0 }
  bursts?: { color: 0 | 1 | 2; brush: BrushId; count: number; seed: number };  // kept so older effects parse; not drawn (§8.9)
  ring?: { color: 0 | 1 | 2; seed: number };  // kept so older effects parse; not drawn (§8.9)
  ease?: Partial<Record<'cracks' | 'ring' | 'bursts', 'linear' | 'in' | 'out' | 'hold-snap'>>;  // only cracks is read; missing = 'out'
}
interface EmergeMoment {                      // the limb and electric strokes grow out of his body (§8.9)
  kind: 'emerge';
  at: number;                                 // seconds into the clip: the frame the strokes were drawn on
  strokes?: number[];                         // stroke ids; missing = every electric and limb stroke
}
interface Turn {                              // overrides the turn read from the pose track (§8.5)
  at: number;                                 // seconds into the clip: the tapped frame, his back to the camera
  dir: 1 | -1;                                // direction of travel
  keys?: [number, number][];                  // [seconds, degrees], nudged by hand, in time order; they win over the tap's
}
interface Effect {
  version: 1;
  brush: BrushSettings;                       // the ink brush
  brushes?: Partial<Record<Exclude<BrushId, 'ink'>, BrushSettings>>;  // missing = the §8.8 defaults
  palette: [string, string, string];
  timing: { drawingsPerSecond: 12 | 8 };
  strokes: Stroke[];
  presets?: { name: string; at: number }[];   // seconds into the clip
  moments?: (Moment | EmergeMoment)[];
  turn?: Turn;                                // missing = the turn read from the pose track where it's reliable, else no turn
  aura?: { color: 0 | 1 | 2 };                // the flame aura around the person (§8.6); missing = none
  listing?: { name: string; tags: string[]; by: string };  // optional name, tags and author
  overrides: Record<string, unknown>;         // one-tap overrides, keyed by field path
}
```

Effects saved before the brushes have no `brush` on their strokes and no `brushes`, so they render exactly as before (ink everywhere). Effects saved before the impact have none of its new fields and still parse, `bursts`, `ring` and `ease` included; a slam moment in one renders with the impact's defaults (§8.9). Ground strokes and moments belong to one clip: wear this effect (X3) carries the body-anchored strokes, the limbs included, to a new clip, and the wearer draws their own impact (§8.9).

**Facing angle θ:**
- 0° faces the camera. θ grows as he turns to his left, seen from above.
- 90° puts his right side toward the camera. 180° is his back. 270° puts his left side toward the camera.

**Facing classes,** used by the `/label` page, Wonder's schema, T1 and T4:

| Class | θ range |
|---|---|
| front | within 45° of 0° |
| right | within 45° of 90° (his right side toward the camera) |
| back | within 45° of 180° |
| left | within 45° of 270° |

Wonder's prompt states these meanings word for word.

**Views:**
- `side` is the 90° view.
- `left` (270°) is optional; when it's missing, `side` is mirrored.

## 8. The engine

Four things make motion read as anime. The engine produces each one on purpose instead of leaving it to chance.

| What reads as anime | How Inkwell does it | Where it comes from (§16) |
|---|---|---|
| Deliberate poses, including how a thing looks from each side | Qai draws the front and the key poses. Other angles come from lifting his drawing onto a 3D stand-in of the body and drawing it back with his brush, on 2s; any view he draws (side, back) overrides the lift for that stroke. The engine invents no pose beyond turning his own drawing in 3D | Anime model sheets; 2.5D Cartoon Models; Live2D angle keyforms |
| Timing on 2s or 3s | The simulation runs smoothly, but the drawing changes only 12 (or 8) times a second and holds in between | Limited animation; Guilty Gear Xrd holds frames even though it's 3D |
| Overlap and follow-through | A rope simulation chases the drawn or keyed shape, so it lags, overshoots and settles | Wiggly Splines; Willett et al. 2017; Live2D physics |
| A living line | Qai's brush is regenerated on every drawing, with a small boil that repeats every few drawings | Hand-drawn line boil |

### 8.1 Spaces and the frame loop

**Torso space** is computed per video frame from the SAM `person` mask:
- origin: the mask centroid `c`
- axis: the principal axis angle `φ`, from second moments
- unit: the torso height `h = k·√area`, with `k` chosen once per clip so that `h` equals 0.35 × the median person-mask bounding-box height over the clip

**Tilt comes from the shoulders and hips, not `φ`, when the stand-in's body points are there.** In a wide crouch the person mask's long axis follows the spread legs: on the probe clip it turned +31° while his back rolled −32°, so the kagune tilted the wrong way. The stand-in (MediaPipe pose, free and local) gives, per frame:
- **roll:** the mean direction of the shoulder line and the hip line, taken within half a circle and unwrapped, so the shoulders swapping sides in a turn doesn't flip it. Frames where the shoulders are narrower than 0.35 × his upright length (side-on) are dropped and filled.
- **pitch** (bending forward, toward the camera): `cos(pitch)` = the hips-to-shoulders length along the rolled up direction ÷ his upright length on that frame. The upright length is the larger of the spine and the shoulder width × his spine-to-shoulders ratio around the drawing frame (±15 frames): bending forward shortens the spine but not the shoulders, and a turn narrows the shoulders but not the spine.

A stand-in frame is good when both shoulders and both hips are there and the shoulder midpoint lies inside the person mask dilated by 0.03 S (S is the frame's short side). Any other frame, a phantom body included, is a gap: roll and pitch hold their last good values over the mask-based torso, then blend back over 4 frames (smoothstep) once good frames return. On the hero clip the stand-in has no body on f89–101, so they hold f88's. Both are smoothed like `c`. The anchor turns by the roll (relative to the drawing frame); `φ` is the fallback where the stand-in never has a body. Roll leans and pitch bends the 3D lift's body (§8.5). *Qai decides whether the stand-in ships in the app for this, or stays dev-only and this waits for a SAM shoulders/hips concept.*

`c`, `φ` and `h` are smoothed with a One Euro filter, which smooths hard while the input is still and lightly while it moves fast. Strokes, views and preset keys are stored in torso space. Each stroke's anchor comes from its plan: a concept mask's centroid, or a tracked point.

**The physics runs in pixels.** Every step converts the targets to pixels with the current torso transform, so the body's own motion produces lag and follow-through. A simulation run in torso space would move rigidly with the body and never overshoot.

**The loop, per output frame:**
1. Get the frame index from the timestamp: `f = round(τ·30)`. The clip is constant 30 fps after conversion.
2. Advance the simulation to `f/30` in fixed steps of `dt = 1/120` s, interpolating the targets per step.
3. Compute the drawing index in integer math, `k = floor(f·dps/30)`. Never use `floor(τ·dps)`: timestamps in integer microseconds break the cadence.
4. If `k` changed, capture a new drawing: the simulated points, converted back to torso space, plus `boil(k)`. Otherwise keep the held drawing.
5. Place the held drawing with this frame's torso transform, then composite it (§8.6).

The drawing holds its shape on 2s, but its placement follows the body every frame, so it never slides off between drawings. The simulation never stops, so momentum carries through holds the way it does in hand-drawn work.

### 8.2 Target shape

For each stroke, the target in torso space is:

```
T(t) = V(θ(t)) + P(t)
```

- **`V(θ)`** is the view blend (§8.5), covering points, pressure and root.
- **`P(t)`** is the active preset's offset: key pose minus the front view's rest pose. It steps through the keys by drawing count and is zero when no preset is active.

### 8.3 Physics: one engine, rope to rigid

**Strands.** Each strand is a chain of nodes, one per stored point (32 by default). Every step:
1. **Verlet:** `x' = x + (x − x_prev)·(1 − damping) + g·dt²`
2. **Distance constraints**, 8 passes over neighbor pairs, restoring each pair's rest length. Node 0 is pinned to the root and never moves for a constraint.
3. **Shape pull:** `x_i ← x_i + k·(T_i − x_i)`, where `k = 0.5·stiffness²`.
4. **Optional bend limit** of 35° per joint *(start)*, to prevent kinks.

**Rigid strokes** (`kind: 'rigid'`, for horns and halos) set `x_i = T_i` every step.

Fling on turns isn't a separate force. The root sweeps around the torso (§8.5), and the chain's inertia does the rest.

### 8.4 Timing and boil

**Timing.** At 30 fps and 12 dps, `k = floor(f·12/30)` changes on frames 0, 3, 5, 8, 10, …: a 3-2-3-2 pattern. At 8 dps (on 3s), every drawing holds for 3 or 4 frames. Never hard-code the pattern.

**Boil.**
- For drawing `k`, offset each centerline point `i` by `b = A · n(k mod cycle, i)`.
- `cycle` is `boil.cycle` from `reference/timing.json`.
- `n` is seeded smooth noise along the stroke, 2–3 waves per stroke.
- `A = boil.maxPx · wobble`.
- Apply the offset before perfect-freehand builds the outline, so the outline stays clean.
- Boil runs even at rest.

### 8.5 The turn

**Facing angle θ** (convention and classes in §7) has three sources:

1. **The face track,** every frame. When a face is present, he's on the front half:
   ```
   o     = (face_cx − torso_cx) / o_max
   a     = clamp(face_area / face_area_front, 0, 1)
   θ_face = atan2(o, a)
   ```
   - `o` is signed by the θ convention: a face shifted toward screen right means θ > 0.
   - `o_max` is the 95th percentile of |face_cx − torso_cx| over the clip's face-present frames. If the clip has no turn, use 0.3 × torso width *(start)*.
   - `face_area_front` is the 90th percentile of face area over frames where |o| < 0.2.

   When no face is present, he's on the back half.
2. **Wonder's labels,** at 5 fps, each with a confidence.
3. **Manual keys** on the timeline. These override both.

**Where θ comes from (after the Oct 27 probe, §9).** The face track holds his head through a fast spin, so it can't say when his back turns. Nothing is required of him: no tap and no keys. The first of these that exists drives θ:
1. **His nudged keys** (`turn.keys`): he drags any key that's off.
2. **One optional tap** (`turn`): the frame f_b where his back faces the camera, plus the direction of travel s = ±1. The app adds keys a quarter turn either side, out to where the turn starts and ends: (f_b + n·Δ, (180° + 90°·n)·s) for n = −2..2, with Δ = 6 frames *(start)*. On the hero clip a tap on f60 gives keys on f48, 54, 60, 66 and 72, at most 30° off the hand-measured keys (f50 0°, f54 90°, f60 180°, f68 270°, f74 360°).
3. **The pose track, where it's reliable:** on good stand-in frames (§8.1), the order of his shoulders and hips across his spine, which swaps while his back is to the camera; his shoulder width collapsing where he goes side-on; and his face landmarks, where his nose sits and whether they're visible. Where these read as one clean spin, they place the tap's five keys, with f_b and Δ fitted to the spin; anything else (a spin that doesn't fit, a missing body) gives no reading. It needs the stand-in, so it ships only if the stand-in does (§8.1).
4. **None of these:** θ = 0 on every frame, and he doesn't turn.

Between keys, θ is interpolated in the direction of travel, then the views, blending and layer swap below run as specced. On the hero clip the render uses the pose-track turn if it stays within 45° of the hand-measured keys over f50–74, and the hand-measured keys otherwise; its report says which it used and the pose track's worst error. Wonder's labels (at 5 fps) replace the pose track only if they pass T1. In T1, "Qai's turn keys" means whichever of the keys above drive θ, the pose track's included, and only Wonder's labels count as the app reading the turn by itself. The face track is still run and reported in T1, but it doesn't drive θ. The video says the app reads the turn by itself only on T1's terms, never on stand-in numbers (§3).

**Fusion.**
1. Unwrap θ to a continuous angle.
2. Across the back half (no face), interpolate in the direction of travel. The direction comes from Wonder's labels, or from the sign of `o` as the face left.
3. Smooth with a One Euro filter, and clamp the turn speed.

**Drawn views.**
- Views sit at 0°, 90° and 180°, plus 270° if drawn; otherwise 270° is 90° mirrored (x → −x in torso space).
- **Blending.** For θ between neighboring views a and b, `w = (θ − θ_a)/(θ_b − θ_a)`. Points, pressure and root are lerped by `w`.
- **Layer.** The layer is a's while `w < 0.5` and b's after. It swaps in one drawing, the way layer order pops in hand-drawn turns.
- **Views mode.** The front stroke shows faintly. Qai redraws each stroke in the same order, resampled to the same point count. That's what makes the views correspond point to point.

**The 3D lift (T5),** used for every stroke without drawn side or back views (Blender's Grease Pencil puts 2D strokes on 3D objects the same way):
- **Body stand-in, per frame.** An ellipsoid torso in torso units: center 0.325 above the anchor, half-width 0.33, half-height 0.675, half-depth 0.2 (0.6 × the half-width, as before), plus a head ball of radius 0.2 centered 1.25 above the anchor. It sits at the anchor's pose (position and scale). It turns by θ (above). It leans by the roll and bends toward the camera at the hips by the pitch, both from the stand-in's shoulders and hips (§8.1), held through pose gaps; where the stand-in never has a body, it leans by `φ` and doesn't bend.
- **His body, for collisions** (a crash-test dummy, per frame). One phone camera can't scan him in 3D, so the dummy is built from what there is: the torso ellipsoid, plus a head sphere, a neck, upper arms, forearms (running on 0.08 past the wrist, over the fist), thighs and shins as capsules between the stand-in's joints (MediaPipe's 33; from its 15 core points, the head and neck alone). A joint sits where the pose puts it on screen. The shoulders, hips and head ride the torso; an elbow, wrist, knee or ankle is one bone length from its parent, so a bone that looks short on screen points toward or away from the camera by √(L² − ℓ²), with L its longest look over the clip (95th percentile) and ℓ its length on screen. Of the two depths, the one nearer a standing body's wins; over his torso, a half-hidden joint (visibility 0.3–0.5) goes behind it and a plainly seen one (0.8 and over) in front. Each capsule's radius is the person mask's half-width across it, within 0.6–1.5× a standing body's, median-filtered over ±6 frames. The joints are filled through pose gaps and smoothed over ±3 frames.
- **The pre-scan.** Once per clip, before the physics, each frame's person mask is scanned into a signed distance field (a cell 1/480 of the clip's width, reaching 0.025 of the width round the mask), and each cell gets the depth spans his parts fill on its view ray, overlapping parts merged, so a gap between his head and his back, or his arm and his side, stays a gap. Where there's a mask, the mask is his outline and the dummy only its depth; on a frame without one, the dummy's parts alone.
- **Lifting.** On the drawing frame, the root goes just off the torso surface (0.03 torso heights out, so it's never inside him) on the side its body angle α names (the back for 180°). The other points go on a curved sheet behind that surface: depth = root depth − 0.3·r − 0.08·r² − 0.1·smoothstep(r/0.16), with r the drawn distance from the root in torso heights, so by the root the sheet curls out of his back and a limb grows out of him before it follows his back. Each point is placed so that it projects exactly where Qai drew it, so the drawing frame is unchanged.
- **Physics in 3D: a rope.** §8.3's chain runs with a third axis and its own parameters (§8.7, rope): the 2D engine's dt, passes, damping and shape pull; 1.5× its gravity, so it hangs like something heavy; and a bend limit of 50°, so the drawn bend is a tendency, not a mould. §8.3's own parameters don't change. The bend limit measures each joint against the target's bend, carried onto the chain by the smallest rotation, and turns a joint back at most 0.05 rad a step; no joint folds past 40°; and after the bend limit each joint turns 0.1 of its way back toward the drawn bend, so a bend wave carries down it and a hard swing can't pull it straight. Gravity is straight down the screen. The body turns, leans and bends at every physics step (θ interpolated from its keys), and what stuck out behind him rises as he bends: bent 90°, a stroke drawn behind his back points up and is in front.
- **The drive.** The target the chain is pulled toward drags like a rope instead of turning like a rod: each node follows the body's turn, bend and lean on its own spring, fast at the root (6 Hz) and slow at the tip (0.8 Hz), damped so the tip overshoots a stopped turn by about a sixth and swings back. A seeded bend wave runs down it from root to tip, growing toward the tip, so a standing limb still moves. The target is never straight: it's bowed on screen, the way the drawn limb bends, to a sagitta of at least 0.16 of its chord.
- **Collisions.** In the constraint passes' second half and after the bend limit, each node is pushed out of his body by its own tube radius, except the root, a pinned tip and the nodes within the root's flare (they grow out of his back, so only their centerline is pushed out). With the scan, a node whose screen point, widened by its radius, falls inside his mask and whose depth falls inside a span there goes out across his outline when that's shortest, else in depth, on the side of him the node before it is on (else back the way it came, within 0.4 torso heights); the segments between nodes are sampled too, so no stretch passes through him between two clear nodes. Without the scan, it's pushed out of the dummy's parts. A pushed node loses 0.3 of its sliding velocity, two passes mend the lengths, and the shape pull never stretches a segment past 1.1× its rest length, so a limb caught on him isn't torn across him. A root inside his mask (clothes, hair, an arm across his back) moves out of it the shortest way, smoothed over ±2 frames, 2 px clear, and its whole target moves with it.
- **Back to 2D, on 2s.** When the drawing index changes, the chain is projected through a camera 10 torso heights away and stored in 2D torso space with boil(k), as in §8.1. Each point keeps its camera depth, which the limb brush shades with (§8.8). The brushes then draw it as usual. Shapes and layers change only on drawings, never in between. A free limb that would look straighter than a sagitta of 0.07 of its chord is drawn bowed the way it bends, and its drawn joints are eased on screen to at most 55° (40° next to a foreshortened segment, 58° anywhere), so a segment seen end-on never reads as a fold. From the release (§8.9), a struck limb is turned toward the screen as far as it takes to show 92% of its length. A drawing held over frames he moves on is routed round his body there by depth alone, so it goes behind or in front of him, never through him.
- **Layer, per point.** With his body, a centerline point is `front` where it's nearer than all of him on the view ray through it (with the scan, the spans where his mask is); a run of points over none of him takes `front` when the point next to it over his body is in front, else behind, so every flip falls where his body hides it. Without it, a point is `front` if the view ray through it hits the stand-in only behind it, and, if the ray misses the stand-in, when it's nearer than the spine. A stroke that crosses the body is drawn once, then cut along its length by a mask of its front points: the behind part goes under the person cutout and the front part over it (§8.6).
- Contact sheets label these cells "lift".

### 8.6 Rendering and occlusion

**Compositing order,** per output frame:
1. The video frame.
2. The flame aura, if the effect has one.
3. Strokes whose current layer is `behind`.
4. The person cutout from the SAM mask, feathered 1 px.
5. Strokes whose current layer is `front`.

An impact (§8.9) adds its own layers around the person cutout: the cracks and floods under it, and the strike, fire, smoke, dust, wisps, debris, sparks and lightning over it, in both flash modes. On its impact frames a poster replaces the whole picture.

**Flame aura.** Grown from the person mask, so nobody draws it and it follows him for free. Take the mask's distance field at half resolution and cut it where seeded noise, stretched upward, says the flame ends, so the edge licks up and reaches further toward the head. Inside, it is colored in layers, never a flat fill: a deep band hugging the body, shorter inner tongues with their own lighter edges, rising streaks, a paler outer flame and a thin bright rim; embers drift off the top. The noise is seeded by drawing index `k`, so it changes on 2s and re-renders identically. It sits under the cutout, so it shows only around him.

**Outlines** come from perfect-freehand, rebuilt every drawing from the held centerline and pressure, using the brush settings saved in the effect. The limb brush builds a tube around the same centerline instead (§8.8).

**Contact sheets** (`npm run verify`):
- **Cells:** one per drawing, not per video frame. Each shows the strokes over a gray person silhouette and is labeled with:
  - `k` and `f`
  - θ and the facing class
  - view weights
  - the active preset
  - "lift" when used (§8.5)
- **Timing strip:** a plot of the tip path, with drawing boundaries marked.
- **Reference strip:** Qai's keys, rendered with the same brush, for side-by-side comparison.

### 8.7 Parameters (starting values; Qai tunes them)

| Parameter | Start |
|---|---|
| drawings per second | 12 |
| boil max, cycle | from `reference/timing.json` |
| dt | 1/120 s |
| stored points per stroke | 32 (raise it if A6a fails) |
| constraint passes | 8 |
| damping | 0.04 per step |
| gravity | 2 torso heights/s² |
| shape pull | `k = 0.5·stiffness²` |
| bend limit | 35° per joint |
| One Euro (anchor) | minCutoff 1.0, beta 0.007, dCutoff 1.0 |
| One Euro (θ) | minCutoff 0.5, beta 0.01, dCutoff 1.0 |
| Wonder facing sample rate | 5 fps (every 6th frame) |
| ellipse depth ratio | 0.6 |
| lift: torso ellipsoid (center, half-width, half-height, half-depth) | 0.325 above the anchor; 0.33, 0.675, 0.2 torso heights |
| lift: head ball (center, radius) | 1.25 above the anchor; 0.2 |
| lift: sheet depth | 0.3·r + 0.08·r² + 0.1·smoothstep(r/0.16) behind the root |
| lift: camera distance | 10 torso heights |
| lift: pose gaps | hold the last good roll and pitch; blend back over 4 frames (smoothstep) |
| rope (3D): physics | dt 1/120 s, 8 passes, damping 0.04 per step and shape pull `k = 0.5·stiffness²`, as in 2D; gravity 3 torso heights/s²; bend limit 50°, turned back at most 0.05 rad a step; no fold past 40°; curl 0.1 a step; the pull stretches a segment at most 1.1× *(start)* |
| rope (3D): drive | springs 6 Hz at the root to 0.8 Hz at the tip, on (1 − t)², damping ratio 0.5; bend wave 16° on screen and 9° toward the camera at the tip, growing as t^1.3, at 0.42 and 0.29 Hz, one wave per 1.2 limb lengths, seeded phase *(start)* |
| rope (3D): never straight | the target bowed to sagitta/chord ≥ 0.16; a drawing ≥ 0.07; a released limb's target ≥ 0.1 *(start)* |
| rope (3D): drawn joints | ≤ 55° on screen, ≤ 40° next to a segment under 0.8 × the median, ≤ 58° anywhere; from the release, turned to show ≥ 92% of its length *(start)* |
| body: dummy | capsule radii 0.1 neck, 0.085 upper arm, 0.07 forearm (on 0.08 past the wrist), 0.13 thigh, 0.095 shin torso heights standing, read from the mask within 0.6–1.5× of that, median ±6 frames; joints smoothed ±3 frames (triangle); pose visibility 0.3 used, < 0.5 behind the torso, ≥ 0.8 in front *(start)* |
| body: pre-scan | cell 1/480 of the clip's width; field 0.025 of the width round the mask; mask alpha ≥ 128 *(start)* |
| body: collisions | friction 0.3; depth memory 0.4 torso heights; root out of the mask 2 px clear, smoothed ±2 frames; a held drawing re-routed up to 3 times while any point past the flare is over 0.5 px in him; a routed curve keeps 0.02 torso heights off him, its depth changes eased over 0.25 of it each way *(start)* |
| fine-tip size | 0.35 × the ink brush's size |
| grain (textured brushes) | 0.35 |
| neon glow | radius 12 px, intensity 0.8, at 1080 wide |
| blade | light from the upper left; three soft cel tones; cast shadow 4–13 px down and to the right, 3 layers at 10–14% opacity; glow radius 14 px, intensity 0.3 |
| trail | glow radius 16 px, intensity 0.4; 2 forks at the tip, 1.4–2.6 × its width long; up to 40 sparkles per drawing |
| flame aura | reach 0.1 torso heights at the feet to 0.5 at the head; 26 embers per drawing |
| electric | 19 px at its widest; bends every 38 px, up to 18 px sideways, 55% of them sharp elbows; up to 5 shards per drawing; bloom radius 26 px, intensity 0.55, flickering between 0.6× and 1× per drawing |
| crack draw-on | 4 drawings: the impact frames IF1–IF4, or 4 global drawings when `frames.count` is 0 |
| slam easing | ease-out (cubic) for the cracks; `ease.ring` and `ease.bursts` are not read |
| limb: radius, taper, root flare | R0 = 0.020 S × size/28; (1 − t)^0.55; ×1.22 at the root, gone by t = 0.14 *(start)* |
| limb: sections | 94, from the 32 stored points *(start)* |
| limb: cel bands | body N·L ≥ −0.08, lit N·L ≥ 0.5, core N·H ≥ 0.9 (H halfway between the key light and the view); rim on N·Lb ≥ 0.35, at most 0.0046 S wide *(start)* |
| limb: tones | luma × the body color's: line 0.19, shadow 0.40, lit 1.69, core 1.85, hue kept *(start)* |
| limb: lights | key norm(−0.6, −0.75, 0.3), from the upper left; from j −8 it turns toward P (all the way by j −7), stays there through the aftermath and is back by J_end; back norm(0.55, 0.45, −0.7) *(start)* |
| limb: outline, root | 0.0031 S, ±30% wobble, ×1.35 on the shadow side; a glow burst over the root hides the socket (a socket ring, 1.3 × the root radius, is the plain option) *(start)* |
| limb: outline by contrast | plate Y > 100: the line tone; Y < 60: a p1 rim; between: the rim plus a 1 px core; runs of at least 6 sections, ±5 Y hysteresis *(start)* |
| limb: edge snap | a front/behind flip moves to the person-mask edge if that is within ±6 sections; the front run narrows to nothing over 4 sections at the flip, over the behind run, which reaches 5 sections past it *(start)* |
| limb: emergence | grow over 4 drawings to 0.44, 0.75, 0.94, 1.0 of its length, the last 30% hot; pop over 2 drawings, flash 1.0 then 0.5, 14 sparks *(start)* |
| limb arcs: per limb | idle 3; growing 2; pop 6; j −8..8 6; aftermath 6, plus one tip → P arc from age 3 to j 20; while the flame shows (ages 0–2), nothing of the limbs glows within 0.6 U of P; over j 9–31 their arcs glow at most 0.5 × the lightning's ribbons *(start)* |
| limb arcs: shape | span 0.20–0.38 L, 0.5–1.2 turns, 1.2–2.1 r off the axis, kinks of 40–85°, 55–75% visible *(start)* |
| limb arcs: width, timing | 0.0074 S; reseeded every 2 limb drawings, crawling 15% of their span a drawing; glow flicker 0.6–1.0 on the 1s clock *(start)* |
| cord pulses | every 6–10 limb drawings (3–4 from the coil to the strike), never on consecutive drawings; tip pop p 0.7, random pop p 0.06 a drawing *(start)* |
| slam-down: coil | j −14..−10, up to 30° away from P, root first (the tip 3 frames behind); stiffness 0.1 → 0.5, adding at most 8 torso heights/s to a lagging tip *(start)* |
| slam-down: whip | j −9..−7; node i starts over to the strike curve at 0.75·t_i² of the whip and is on it 0.25 of the whip later; each segment turned at least 0.05 of the way a step; stiffness 1 *(start)* |
| slam-down: strike curve | stem 0.15 torso heights out of his back; bulge 0.12 (round his outline: 0.12, 0.2, 0.3, 0.4, 0.5, 0.65 or 0.8, each costing 0.15 × its bulge × the arc over him, blended at 0.04); depth +0.25 torso heights over smoothstep(0.1, 0.4) of it; ripple 0.05 × the root's distance to P, 2.2 Hz, 1.5 waves *(start)* |
| slam-down: pin, release | tips on P on j −7..8; released on j 9 and eased over 8 drawings: pull-out up −d of 0.12 × the drawn length at the tip over 0.4 of the ease; from 0.15 of it a recoil wave over 0.35, each node on a spring damped 0.45 (about a fifth past its idle curve); bowed ≥ 0.1; a kick of 1.5 torso heights/s along −d, ±0.4 of it sideways *(start)* |
| strike: beam widths | × 0.5, 1.0, 0.71, 0.46, 1.37, 0.98 of max(2 r_max, 0.05 S) on strike steps 0–5; step 6 swells to 0.30–0.38 S; the beams join one bundle over 60–30% of the shortest one's length from P, which widens 1.25–2.7× over its last quarter *(start)* |
| strike: core share | 0.24, 0.15, 0.15, 0.30, 0.15, 0.43 of the width on steps 1–6 *(start)* |
| strike: glow gain | 0.35, 0.6, 0.6, 0.35, 1.0, 0.5, 0.4 on steps 0–6 (step 6 was 0.8: it lit a white ball over the swell) *(start)* |
| strike: splash | 2.0, 3.0, 1.1, 7.1, 15.5, 18.8% of the frame on steps 1–6 (× σ² under Reduce flashing); none within 30° of the strike's source and 6% at 30–60° *(start)* |
| strike: charge glow | 0, 0.11, 0.16, 0.06, 0.38, 0.82, 0.5 on steps 0–6 (step 6 was 1.0, for the same reason) *(start)* |
| strike: contact bursts | 6–10 arcs from P on steps 1, 4 and 5, one frame each, reaching 0.10–0.25 U; a white flare star at P on steps 1 and 4, 8–10 points out to 0.02–0.035 S *(start)* |
| impact frames: holds | 2, 1, 1, 1, 2, 1, 1 frames for IF1–IF7 *(start)* |
| impact frames: HUD slide | Δ = clamp(0.18 − u_max, 0, 0.20) S back up the strike axis *(start)* |
| impact frames: ink on light fields | at most 35% *(start)* |
| impact frames: flashing | full by default; Reduce flashing keeps every second to 3 flashes or fewer |
| Reduce flashing: the calm | the strike's glow 0.08 → 0.2, charge 0 → 0.8 and splash 0.8 → 2.2% of the frame × σ² over steps 0–6, never falling; the limbs' glow × 0.25, with no arc glow, pulses or pops; the fire, smoke and dust opaque at the plate's luminance averaged over 0.03 S cells; debris and sparks 0.3; lightning 0.6, its glow 0.35, no cores; ladder steps 6 and 7 hold the fire, smoke and dust at 0.6 and 0.3, and step 7 drops the lightning and holds the debris and sparks at 0.25 *(start)* |
| aftermath: length | 1.5 s (1.5–3 allowed); scars fade over 0.3 s from the later of I + 30·scarSeconds (3 s) and I + J_end *(start)* |
| aftermath: fire | 0.067 U² at age 0, 0.22 U² at ages 1–2 *(start)* |
| aftermath: smoke area | visible 0.28, 0.11, 0.20, 0.32, 0.37, 0.39, 0.39 U² on g2–g8 *(start)* |
| aftermath: mass centroid | n 0.14, 0.30, 0.39, 0.475, 0.47, 0.38, 0.36, 0.38, 0.38 U on g0–g8; t within ±0.08 U of P *(start)* |
| aftermath: carry-over | from g6, 50–70% of the shapes kept, each moved at most 0.05 U *(start)* |
| aftermath: dust | band half-width 0.45 → 0.6 U; wall 0.16–0.26 U high at P on ages 3–8, 0.3–0.48 U on the flanks *(start)* |
| aftermath: lightning | 2–3 ribbons at ages 3–6, 4–9 at ages 7–11, 2–7 from age 12; ribbons, eyes and bolts within 1% of the frame at ages 3–6, 2.6% at ages 7–11 and 3.5% from age 12 (over it, the shortest ribbons drop out first and the widths stay as planned); gone at J_end − 5 *(start)* |
| aftermath: floods | cyan, at ages 10–11, 15 and 17, as soft bands low along the floor on the floor side of P (direction about ±180°), over 6, 8, 7 and 9% of the frame in the measured layers and tones (the measured 16, 30, 29 and 58% read as half-screen cyan panels); Reduce flashing keeps the first and the last, ramped over 2 frames and at most 25% of the frame, and turns the middle one into a bolt brightening *(start)* |
| aftermath: sparks, embers, chunks | 25, then 52–54 sparks; 35–59 embers; 4 + 1 chunks plus 1–4 in the air, up to 0.18 U *(start)* |
| aftermath: cracks | hot from j 9 (p1 core, #fb6a04 glow at σ 0.01 S), ink by j 30, then a scar with a 0.0015 S rim in p1 *(start)* |
| aftermath: face-safe cut | the face mask dilated 0.03 S, hard-edged, from j 9, on the front effects only; none on a frame without a face mask *(start)* |
| aftermath: hold groups | a measured group holds at most 4 frames *(start)* |
| aftermath: decay | the smoke, dust, debris and wisps erode (shrink to √ of the level and drop out in a seeded order); only the last 3 frames fade *(start)* |
| aftermath: masses' unit | the fire, smoke and dust at U × max(scale, 0.85/σ), at least 0.85 S, under full flashing; U × scale under Reduce flashing *(start)* |
| camera: pull-back | in to 1.04 over j −14..−7, out to 1 by j −2, about the punch-in's center *(start)* |
| camera: punch-in | 8% on j 0..9 about mix(frame center, P, 0.5), eased back by j 39 *(start)* |
| camera: shake | j 9..18 at 0.4 × the reference's envelope, the first jolt toward the striker; the whole envelope cut by one factor to fit the zoom's overflow (0.53 on the hero clip) *(start)* |
| glow buffers | σ 0.019, 0.047 and 0.10 S at quarter resolution, 3 box passes each *(start)* |
| floor | read from him when the stand-in pose is there: the phone at 0.65 of his height, him 1.43 of his height away, at least 8 standing frames; else ratio 0.5, majorDeg 0, up (0, −1), persp 0 *(start)* |
| palette roles | p0 the limb bodies; p1 paper; p2 ink; the electricity in the discharge set, edge #00027c, band #2542fc, core #02fdf5, pale #abfdf4, turned in hue when p0 is within 60° of 262°; the lightning ribbons and floods in k21–31's flat set, edge #00017b, band #2c5cfc (#233cfd on thin strands), core #22fded with its middle 60% mixed 45% toward white, pale #abfdf4, turned with the discharge set *(start)* |
| contact detector | a ±0.10 S column under P: ≥ 2 frames descending ≥ 0.02 S a frame, then < 0.01 S a frame; searched ±10 frames *(start)* |
| impact point snap, root snap | 0.06 S, 0.05 S *(start)* |
| draw gap | the impact at least 15 frames after the limbs *(start)* |
| flash check | frames at 160 px wide; fields 0.78 S across, every 0.1 S; a transition is ΔL ≥ 0.10 with the darker side < 0.80 over ≥ 25% of a field *(start)* |

### 8.8 Brushes

Nine of the ten brushes are perfect-freehand outlines of the same simulated centerline, so the physics, boil and stepping don't change. They differ only in their settings and how the outline is filled. The limb is the one brush that isn't a perfect-freehand outline: its silhouette is a 3D tube built around that same simulated, boiled, stepped centerline, lifted into 3D (§8.5):

| Brush | Outline | Fill |
|---|---|---|
| `ink` | the current brush (`DEFAULT_BRUSH`) | solid |
| `textured` | same as ink | solid, minus a grain mask |
| `fine-ink` | thinner (§8.7) with more thinning, so the line gets fine at fast strokes | solid |
| `fine-textured` | same as fine-ink | grain |
| `neon-straight` | even width, flat ends, no taper | a pale core plus a glow in the stroke color |
| `neon-round` | round ends, tapered | same as neon-straight |
| `electric` | a bent copy of the centerline that changes every drawing; width swells and pinches to pointed ends | flat cel bands, no gradients: a dark rim, the stroke color, a pale band and a white core pushed to one side; a wide bloom behind; angular shards beside it |
| `blade` | flat root, straight sides to a razor tip | shaded as a solid: two faces meeting at a ridge, lit from the upper left in three soft cel tones; long crystal streaks and veins along it; a broad faint sheen and a small broken glint, both tinted toward its color, never white; reflected light in `accent` on the shadow edge; a darker edge line; a soft cast shadow; a faint glow behind |
| `trail` | tapered at both ends | see-through, crisp on the outer edge and soft on the inner one, fading out at both ends; colored all the way through (deeper at the edge, the stroke color in the body, a thin paler streak), never a white core, so it reads on light footage; two sharp forks at the tip; sparkle dust shed along it; the neon glow behind |
| `limb` | not a perfect-freehand outline: a 3D tube around the lifted centerline, as wide as the brush size says, flaring at the root, where a glow burst hides the socket into his body, and tapering to a point | flat cel bands, no gradients: a dark line, a shadow tone, the stroke color, a lit band and a pale core, plus a thin rim of back light; electric arcs coil around it, some in front and some behind, and pulses run down it like a live cord; the glow behind |

- **Grain** is made from a seed (the stroke id), never from an image file: imported brushes stay parked (§15). It's fixed to the stroke, so it rides along with the line instead of swimming. It changes only when the boil changes, on drawings.
- **Glow** is drawn with additive blending ('lighter') under the stroke's core. For an electric look, its intensity flickers between drawings, seeded by stroke id and drawing index `k`, so it changes on 2s like everything else and re-renders identically.
- **Electric** is a cel-shaded bolt. The simulated centerline gets nodes every `bolt.bendPx` along it, each pushed sideways by up to `bolt.ampPx`; most joins are smooth curves and a share (`bolt.elbows`) are sharp corners. The width swells and pinches, and the inner bands pinch on their own, so the white core breaks up. The bloom is the neon glow at a wider radius (quarter resolution; no canvas blur filter, which iPhone Safari lacks). Up to `bolt.shards` small angular chips float beside it. Every offset is seeded by stroke id and drawing index `k`, so the bolt takes a new shape on each drawing, on 2s, and re-renders identically. The root doesn't move, so it stays attached, and the physics underneath is unchanged.
- **Electric emergence** (an `emerge` moment, §8.9). Before it the stroke isn't drawn. From its drawing, the stroke grows out of its root like a live cord over 4 drawings *(start)*, to full length on an ease-out: a hot pulse rides the growing head (its last 30% pale and wide, a stronger glow, a bright bead at the tip). On the next 2 drawings *(start)* it pops like lightning: the whole bolt flashes (wider, paler core, bloom 1.7× wider) and 14 sparks fly off, about two-thirds from the tip and the rest from along it, farther out and thinner on the second drawing. Then it's the normal bolt. All of it is seeded by stroke id and `k`, on 2s.
- **Limb.** The held centerline, with each point's camera depth from the lift (§8.5), is smoothed into 94 sections with a frame that doesn't twist. The radius is `R(t, p) = max(0.8 px, R0·(1 + 0.22·max(0, 1 − t/0.14)²)·(1 − t)^0.55·(0.75 + 0.25p))`, with t the share of the length from the root, p the pressure, and `R0 = limb.radius·S·size/28` (0.020 S by default: 21.6 px on the hero clip, where his drawn widths run 44 → 4.4 px). The cel bands are found per section in closed form from the key light (upper left) and the back light, so there's no per-pixel work; from the strike until the aftermath is over, the key light turns to come from P instead (§8.7). The tones keep the stroke color's hue and scale its luma. The line's color follows the plate just outside it: a dark line over light footage, a p1 rim over dark footage, and both in between, so the limb reads on any floor. Front and behind come from the lift's per-point layers; each flip moves to the person-mask edge when that's within 6 sections, so nothing bleeds over his hair, and the front part narrows to nothing over 4 sections there, so no flat cut end shows where his body doesn't hide it. A glow burst at the root covers the socket where the limb meets his body. Each limb drawing renders once into a behind layer and a front layer in torso space, and the frames in between stamp them, like blade and trail (below).
- **Electricity around the limb.** Thin arcs coil around each tube in the discharge colors (§8.7, palette roles): far pieces are drawn before the tube and near pieces after it. There are 3 per limb at rest, 2 while it grows and 6 on the pop, in the strike and in the aftermath. Their shapes change on the limb's drawings and their glow flickers on the 1s clock (§8.9). Every 6–10 limb drawings a pulse runs down the cord and, most times, pops at the tip into a burst of spikes. Each arc is a stroked polyline, not a perfect-freehand outline, so it stays cheap on a phone. Everything is seeded by stroke id and `k`.
- **Limb emergence** (the `emerge` moment, §8.9). The limbs grow out of their roots on the frame he drew them, over 4 drawings to 0.44, 0.75, 0.94 and 1.0 of their length, the last 30% hot (the core band full width, the glow 1.7×). On the next 2 drawings they pop: a flash of 1.0, then 0.5, and 14 sparks per limb, two-thirds from the tip. On the hero clip (drawn on f22) they grow on f20–29 and pop on f30–34. After the pop a low crackle keeps flickering along them: their glow flickers from drawing to drawing, and now and then a faint flash runs along a limb with a few small sparks.
- **Blade and trail are shaded per pixel**, which is too slow to run on every output frame on a phone. Each stroke is painted once per drawing into a cached bitmap, and the frames in between just stamp it; that's free because a drawing holds for 2 frames and re-renders identically. Their streaks, glints, forks and sparkles are seeded by stroke id and drawing index `k`. Blade's light comes from a fixed direction on screen, not from the footage.
- "Straight and round" is read here as the end shape (flat vs round caps). Qai confirms that reading before M2.

### 8.9 Moments: the emergence and the impact

The hero test (§1) is the limbs growing out of him, a spin, then the impact: the kagune slams down onto a point on the floor and stays pinned there while his fist lands on the same point, seven impact frames strobe, and the floor erupts. The spin is the turn (§8.5). All of it comes from his two drawings; §8.7 holds the starting values.

**Two drawings, nothing else.**
1. **The limbs, on a start frame f1.** One to six strokes in the limb brush (§8.8), drawn from his body outward. A root more than 0.05 S outside the person mask snaps to the nearest mask pixel, with a brief highlight. The frame they're drawn on is their `emerge` moment.
2. **The impact, on an end frame.** Two to eight strokes on the floor where the hit lands, ground-anchored like any crack: these are the impact strokes (`strokes`). **Done** snaps the moment to the contact frame and says so ("Contact set to f84, drawn on f79").

The impact sheet opens on the frame the scrubber is parked on, if that's at least f1 + 15. Otherwise it opens on the strongest audio onset after that, then the frame where the person mask's lowest row slows most, then f1 + 45. It only has to land within 10 frames of the hit, because the snap finds the frame.

**What the app works out by itself,** with S the frame's short side:
- **The impact point P** (`xy`). Take the impact strokes' start points and their end points, and use whichever set is tighter, if its median distance to its own geometric median is ≤ 0.08 S; a tie, a single stroke included, goes to the set nearer the person mask. Snap it to the lowest person-mask pixel within 0.06 S. Failing all that, P is the geometric median of all their points.
- **The contact frame I** (`at`). In a ±0.10 S column around P, take the lowest person-mask row on each frame. Contact is the first frame where it descends less than 0.01 S a frame, after at least 2 frames descending at least 0.02 S a frame, searched ±10 frames around the frame he drew on. It reads only the cached person mask: no Wonder and no new SAM call. Failing that, it's the frame he drew on. **Move contact frame ±1** is the escape hatch for a contact that isn't his lowest point (a kick into a wall) or a person walking off the bottom of the frame.
- **The strike direction d** (`dir`). The motion of his fist region (the mask pixels in that column within 0.04 S above that frame's lowest row) over I−3..I−1, normalized, if it moved at least 0.03 S. Failing that, the mean direction from the limb tips to P; failing that, straight down.
- **The rest.** `seed` defaults to a hash of the impact stroke ids. `floor` is read from him when the stand-in pose is there: a pinhole camera fitted to his standing frames (the horizon where his shoulder and hip lines cross as he walks toward or away from the camera, else the phone at 0.65 of his height; the roll from his hip line; the focal length from a room prior, him standing 1.43 of his height away), read at P. With no pose, fewer than 8 standing frames, a tilt outside −25..50°, P not clearly below the horizon or a ratio outside 0.2..1, it's the flat default (§8.7), and the console says why. On the hero clip it reads ratio 0.755, majorDeg 2.1, up (0.04, −1.00), persp 0.72; the hand-measured camera fit gives 0.763, 2.6, (0.04, −1.00) and 0.68 (0.72 at the scene's U), and the hero renders still pass the fit. The impact must come at least 15 frames after the limbs; if it doesn't, the sheet says "draw the impact later than the limbs".
- **On the hero clip,** with the test drawings (limbs on f22, cracks on f84): drawing the impact on any frame from f74 to f94 snaps to I = f84. P = (942, 1061), and d = (−0.060, 0.998), within 0.1° of his fist's hand-measured track (−0.058, 0.998).

**Units and clocks.**
- j = f − I counts frames from contact. U = σ·S is the size of the destruction, with σ = clamp(0.85·h_p/(0.76·S), 0.45, 1) and h_p the person-mask box height at I; on the hero clip σ ≈ 0.63 and U ≈ 680 px.
- The fire, the smoke and the dust measure in the masses' unit: U × max(scale, 0.85/σ) under full flashing, so at least 0.85 S and a figure who fills the frame doesn't shrink them, and U × scale under Reduce flashing. Their areas, centroid curve and widths in §8.7, S5 and I7 are in it.
- The strike axes are u = d and v perpendicular to it, on the side the seed picks (in portrait, always the side the reference's slow-motion layout uses). The impact frames lay out at X(a, b) = P + S·(a·u + b·v).
- The reference clock kr(j) = 7 + floor(4j/5) runs at real speed, 24 drawings a second, in integer math. The strike is j −8..−1, in seven steps (kr 0–6); the impact frames IF1–IF7 are j 0..8 (kr 7–13, si = kr − 7); and the measured aftermath is j 9..31 (kr 14–31), where its age is kr − 14.
- Things on 1s change on every kr step (k24(f) = floor(4f/5) when there's no slam). Things on 2s take a hold group from kr at their drawing's first frame: {14}, {15, 16}, {17, 18}, {19, 20}, {21, 22}, {23, 24, 25}, {26, 27, 28}, {29, 30} and {31} are g0–g8, and after that each new global drawing takes the next number. j 9 always starts a new drawing, and a measured group that has held 4 frames gives way on the frame kr reaches the next (on the hero clip, g6 f108–111, g7 f112–114, g8 f115–117). Only the camera shake moves every output frame.

**The emergence** (an `emerge` moment). The limbs, and any electric strokes in the moment, aren't there at the start: they grow out of his body on the frame he drew them (§8.8), and their chains start there. The limb sheet opens on a suggested frame, free and local, from the stand-in's wrists: their distance apart ÷ his size (the larger of the spine and the shoulder width, so a crouch or a spin doesn't inflate it). The suggestion is the clip's first opening faster than 0.06 per frame that rises by at least 0.5 in all *(start)*, at the first frame within 10% of where that rise tops out. The first opening, because the slam opens the arms wider later. Without the stand-in's wrists (the app's stand-in has none yet), it's the first frame where the person mask reaches 0.6 of its median area. On the probe clip it's frame 22, where he uncrosses his arms.

**The slam-down: the limbs land first,** the way the reference short does it. The kagune coils back, cracks down like a whip so the tips hit P, and stays nailed there through the strike, his fist's contact and the impact frames, then rebounds and flops back into its idle curve.

| Window | j (hero frames) | Rule |
|---|---|---|
| coil | −14..−10 (f70–74) | each target turns about its root in the screen plane, away from P, by up to 30°, root first: the tip starts 3 frames after the root; stiffness ramps 0.1 → 0.5, but never so fast that the pull adds more than 8 torso heights a second to a lagging tip |
| whip | −9..−7 (f75–77) | a front runs down the limb onto the strike curve, faster as the rope thins: the inner half comes over first, the outer half last, and the tip lands on P last and fastest, on j −7; the whip is laid on the chain, its own tip pinned; stiffness 1 |
| pinned | −7..8 (f77–92) | the tips on P; the chain is laid on the strike curve with a ripple running down it, at the curve's length |
| release | 9 (f93) | unpinned, and handed back to the lift over 8 drawings at its drawn length: it first pulls out of P, back along the curve and up −d; then a recoil wave runs from the tip up to the root, each part swinging about a fifth past its idle curve on a damped spring, never straight; the stiffness falls back to the stroke's, and a recoil kicks the chain back along −d |

- **The strike curve** from limb i's root to P sets off from a stem 0.15 torso heights out of his back, along its outward normal, and runs from the stem's end S_i: C_i(t) = S_i + (P − S_i)·t + b·n_i·sin(πt)·|P − S_i|. Without his body, b = 0.12 toward the side the drawn limb curves; with it, b is the bulge (0.12 to 0.8) that keeps the curve off his outline best, blended so it eases as he moves. The curve comes 0.25 torso heights toward the camera over smoothstep(0.1, 0.4) of its length, so the slammed limbs read in front of him, and it's routed round his body by depth alone (§8.5), on the side of him the limb is on now: the limbs reach P round his side or over a shoulder, never through him.
- **Clock.** The physics captures a pose on every frame from j −9 to 9, so the whip shows on every frame and the pin is exact. The tube is reshaded on j −8, −7, −5, −3 and −1 and stamped in between, and j 9 forces a new drawing.
- **Speed.** On the whip's frames (j −9..−7) and from the release through the 5 frames after it (j 9..14), the tips are exempt from the physics' tip-speed guard (P3's 20 torso heights a second): on the hero clip they cross several hundred px a frame on the whip, and the recoil flicks a tip at up to about 50 torso heights a second, by design. For A7, those drawings are a strike, like a preset strike's.
- **The strike visuals,** steps 0–6. A beam smear runs along each limb toward P, in p0's tones. Near P the beams join one bundle, like the reference's one bolt: each joins the bundle's axis over 60–30% of the shortest one's length from P, and only the lead beam goes on to P, so the bundle is one beam wide there. Its width steps through the multipliers in §8.7, widens over its last quarter into P, and on step 6 swells into a white-hot teardrop, the lead-in to the first impact frame. A splash of blades in the accent fans out across the floor, sideways from the strike. Contact bursts of 6–10 jagged arcs in the discharge colors fire from P on steps 1, 4 and 5, one frame each, with a white flare star at P on steps 1 and 4. A charge glow at P builds to 1.0.

**The slam preset is parked.** Nothing reads `slam.phases` or `slam.keys` while the limbs land first: the slam-down is built from P and the limbs. A5 stays in §10 for a strike Qai keys by hand, and the impact never makes a `by: 'effect'` moment.

**The impact frames** (`frames`; missing = { 7, 'full' }). On j 0..8, seven posters replace the whole picture, on the reference clock, with holds of 2, 1, 1, 1, 2, 1 and 1 frames (f84–92 on the hero clip). They're flat two-tone graphics in p1 (paper) and p2 (ink), built to the reference's measured layouts: IF1 whiteout, IF2 split, IF3 radial lines, IF4 star, IF5 negative cross, IF6 streaks and IF7 negative strike.
- **The figure** in each is his person mask (IF4 always draws him as a contour, never as a solid body: the ink star over a solid one went flat black), each limb's silhouette pinned on P, and every one of his impact strokes, whatever they look like. A stroke that starts within 0.08 S of P draws on from that end as `ease.cracks((si + 1)/4)` of its length on IF1–IF4: 58, 88, 98 and 100% with the default 'out', or 25, 50, 75 and 100% with 'linear'. Any other stroke is drawn whole from IF1. No electricity on any poster.
- **In frame.** The HUD marks (crosshairs, star, rings) slide back up the strike axis by Δ = clamp(0.18 − u_max, 0, 0.20)·S when P is near the frame edge, u_max being how far P is from the edge along u, in S. The physical marks stay on P and mirror back into frame. In portrait, the layout is the reference's own slow-motion one.
- **Measured coverage,** black / white %, Rec.601 luma (black < 40, white ≥ 230), on the reference geometry (a 1080 × 634 panel, P (520, 388), d (−0.80, 0.60)): IF1 8.1 / 91.9 untinted (with its tint toward p0, 8.1 / 66.7 and 25.2% mid), IF2 47.3 / 51.2, IF3 1.9 / 94.4, IF4 11.0 / 86.3, IF5 92.7 / 5.7, IF6 0.9 / 96.5, IF7 87.9 / 8.7.
- **`frames.count` 0** draws no posters: the footage shows on j 0..8, with the charge glow fading over j 0..3, and the cracks draw on over 4 global drawings.

**Flashing.** Full impact frames are the default, in the preview and the export: the reference's 4 inversions and full washes, about 6 flashes a second. **Reduce flashing** is one toggle, on the impact sheet and the export sheet (`frames.flash: 'safe'`). It keeps every second to 3 flashes or fewer (WCAG 2.3.1):
- one inversion: IF1–IF4 light, IF5–IF7 dark (IF6 drawn on ink);
- IF2's split drawn as a tinted paper disc with ink tongues, never solid ink;
- light fields kept at relative luminance ≥ 0.80;
- no large saturated red: a color with linear R/(R+G+B) ≥ 0.8 over more than 10% of the field gets its green raised to ≥ 0.55 R;
- one flash budget for the whole clip: the rise into IF1, the fall into IF5, the return at j 9, the flame leaving at j 14 and the ramps of two cyan washes (up over j 20–21 and 28–29, down over 24–25 and 32–33), with nothing in the strike, and the white flash and the dust veil (ages 5–6) staying under +0.10 L;
- the strike is one rise into IF1: its light, charge and splash never fall, and its beams stay calm with no step-6 swell;
- the effect is calmed where it would otherwise flash: no pulses or pops on the limbs and no arc glow; the fire, smoke and dust at his own size, laid opaque at the luminance of the footage under them (averaged over 0.03 S cells), their color over it with the 'color' blend, so they show the destruction without moving a field's light; the debris and sparks at 0.3 opacity; the lightning one steady drawing from the cracks and the floor line, held to its fade, at 0.6 with no white cores;
- nothing drifts between the planned transitions: the grade holds g8's look from the return at j 9 to the decay, and the two floods have no ink lines or band, so a flood's rise only brightens and its fall only darkens;
- a saturated red limb color is cooled toward crimson at the same luminance (#e8203a becomes #e22075), since the limbs move through the whole strike;
- the export's last guard: every pixel whose linear R/(R+G+B) is 0.78 or more gets its green raised until it is under (G4 on the whole finished frame), so a Reduce flashing export holds no saturated red, whatever the footage under the effect shows;
- a second slam within 1 s becomes an IF4 glint held 8 frames.

**The flash check runs on every export.** Each frame is shrunk to 160 px wide. A field is a circle 0.78 S across, on centers every 0.1 S. A transition is a change in relative luminance of at least 0.10 with the darker side below 0.80, over at least 25% of a field; extremes are tracked, so a ramp counts once. A flash is two opposing transitions, counted in sliding 1 s windows. A red flash is a saturated red change (linear R/(R+G+B) ≥ 0.8, Δ(R − G − B)·320 > 20) over 25% of a field.
- **Full (the default).** The check changes nothing. If a second holds more than 3 flashes, the export sheet says so plainly ("This video flashes more than 3 times a second"), with the Reduce flashing toggle beside it.
- **Reduce flashing.** The check enforces at most 3 general and 0 red flashes in every 1 s window. If that fails, the export steps down a ladder, re-checking after each step:
  1. Wash 3 becomes a bolt brightening.
  2. So does wash 1.
  3. Strike calm: the beams clamped to 0.7–1.0×, the step-6 swell to 1.0×, no plate lift.
  4. A slow replay: each poster holds 5 frames over the frozen clip, which then resumes, with the audio silent across the gap; the export is 26 frames (0.87 s) longer.
  5. Every poster light.
  6. Only the IF4 glint, and the fire, smoke and dust at 0.6 opacity.
  7. No flash elements at all. No lightning either; the fire, smoke and dust at 0.3 opacity, and the debris and sparks at 0.25.

  If step 7 still fails, the footage flashes on its own: the export throws `FlashCheckError` and says so instead of saving. The preview always plays the normal timing.

**The aftermath** (`aftermath`; missing = 1.5 s, and 1.5–3 s is allowed). From j 9 the scene returns and the floor erupts around P, laid on the floor (`floor`):
- **Fire, then smoke.** A cork-pop of flame (0.067, then 0.22 U²), then a smoke cluster that rises and settles over P along the measured areas and centroid curve (§8.7), its hot share cooling with age. Ball counts come out of the area targets; they're never inputs. In both flash modes the flame, the cluster and the dust stand in front of him, uncut (cut round his face, the smoke showed holes). They're sized in the masses' unit (above). The flame is one silhouette with one ink line: a body round P with a flame rising out of it for each tongue, torn into barbs, orange licks at the tips and amber bubbles in its yellow body. The cluster is opaque warm light-brown lumps (the measured browns, 40% of the way to #c9a584, so they do not read as dark dots) inside one ink contour scalloped by its balls, each lump with a shadow crescent away from P, and the fire part showing as veins between them.
- **Dust.** A band running out along the floor, its plumes standing up as a wall over the base of the fire and the cluster, in warm-grey cel steps lighter upward, plus a dust veil at ages 5–6.
- **Wisps.** White spikes at the cork-pop, then jagged tongues splash outward, in front of him on strict 2s. The zigzag crown over the fire (ages 1–2) and the white dome (ages 3–4) are not in the reference and are not drawn. At ages 5–6 they flash white, with a person-shaped hole.
- **Debris.** Specks, shards and big chunks flung up and out. Sparks and embers change on the 2s groups, about half carried over each time.
- **Energy, on 1s.** Lightning ribbons along real edges (the smoke's outline, the floor line, the cracks, and his outline and the limbs where they're within 0.3 U of P), from the lead-in bolt at age 3 (kr 17: f97 on the hero clip), then 4–9 ribbons and later 2–7, plus thin bolts. The drawn electricity without the floods covers at most 1% of the frame at ages 3–6, 2.6% at ages 7–11 and 3.5% from age 12: over that, the shortest ribbons drop out, and the widths stay as planned. The ribbons are drawn in k21–31's flat set (§8.7, palette roles), with a hot middle in the core, so under the glow they composite #7efefd–#acfcfd. Cyan floods at ages 10–11, 15 and 17, as the reference has them; Reduce flashing keeps the first and the last, ramped over 2 frames and at most 25% of the frame, and turns the middle one into a bolt brightening (§8.7).
- **The cracks** are his impact strokes: hidden before I, drawn on during the impact frames, hot from j 9, cooled to ink by j 30, then a scar with a thin p1 rim, which fades over 0.3 s from the later of I + 30·scarSeconds and I + J_end.
- **The limbs.** Released at j 9 with the recoil, with twice the arcs plus one arc from each tip to P from age 3 to j 20, still lit from P; while the flame shows (ages 0–2) nothing of the limbs glows within 0.6 U of P, and over j 9–31 their arcs glow at most half as bright as the lightning's ribbons.
- **Face-safe.** From j 9 the front effects (layer 9 below) are cut out of his face mask, dilated 0.03 S, hard-edged; on a frame without a face mask nothing is cut. The limbs and the fire, smoke and dust aren't cut.
- **Decay.** With J_end = round(30·seconds), a hold on g8's look runs to J_end − 14. Then everything but the scars goes to exactly 0 at J_end: the smoke, dust, debris and wisps erode, shrinking and dropping out piece by piece in a seeded order, and fade only over the last 3 frames (cel smoke breaks up, it doesn't fade); the rest fades linearly, the bolts by J_end − 5. At 1.5 s on the hero clip, everything but the scars is gone by f129.
- **Size.** Masses keep their measured screen size under the camera's zoom (× 1.08/zoom).

**The camera.** Over the charge, the reference's picture pulls back 4%; footage has nothing outside the frame to pull back to, so the camera creeps in to 1.04 over the coil (j −14..−7) and eases back out to 1 by j −2, about the same center as the punch-in. An 8% punch-in on j 0..9 about mix(frame center, P, 0.5), eased back to 1 by j 39. A shake on j 9..18 at 0.4 × the reference's envelope along the strike axis: the first jolt goes toward the striker (back up the axis), and so that no jolt shows the frame's edge, the whole envelope is cut by one factor, the smallest any jolt needs to fit the zoom's overflow, so the first jolt stays the biggest (0.53 on the hero clip: 22.4, 15.1, 8.2 px …). The posters ignore the camera. Criterion S1 is measured in clip pixels, before the camera.

**Layers, glow and grade,** bottom to top:
1. The plate-graded video.
2. The flame aura (§8.6), if the effect has one.
3. The cracks.
4. Floods (their own wide glow goes here too, under him), and at ages 5–6 the dust veil and the white flash, with a person-shaped hole, so the limbs and the masses stay solid over them.
5. The limbs' behind parts, with their far arcs.
6. The person cutout.
7. The limbs' front parts, with their near arcs.
8. The masses, uncut, in both flash modes: the fire, then the smoke cluster, with the dust over its base.
9. The front effects, face-cut from j 9: the strike, the contact bursts, wisps, debris, sparks, embers and lightning.
10. The glow.

The glow is three emission buffers at quarter resolution (σ 0.019, 0.047 and 0.10 S, three box passes each); no `ctx.filter` blur, which iPhone Safari lacks. The plate grade is three Canvas2D compositing ops: the strike's light color, the aftermath's lift and warm pool of light around P, and a cooling white balance. Canvas2D is the reference path for Node, the export and the preview; a WebGL shader of the same grade is an optional preview-only fast path.

**Colors.** The palette roles are p0 main, p1 light and p2 ink. The limb bodies and the strike are p0. The posters are p1 paper and p2 ink, with a warm grade. The electricity (arcs, contact bursts, lightning, floods) uses a cool discharge set: edge #00027c, band #2542fc, core #02fdf5, pale #abfdf4 (the lightning's ribbons and the floods take k21–31's measured flat set instead: edge #00017b, band #2c5cfc, core #22fded, pale #abfdf4), at hue 262°, turned in hue when p0 is within 60° of that, so the sparks never match the limbs. Fire, smoke and dust keep the measured physical colors whatever the palette.

**Seeds and determinism.** One seeded generator: mulberry32 over an FNV-1a hash of (seed, stream, integers), with fixed stream names. Limb randomness is seeded by stroke id and `k`, the posters by (seed, si), 2s layers by (seed, layer, g), 1s layers by (seed, layer, kr) and the shake by (seed, j). A frame is a pure function of the effect, the cached clip data and f. The only state is the physics, stepped at the fixed dt from frame 0, so a frame rendered alone matches the same frame rendered in sequence. Math.random, Date, performance.now and `ctx.filter` are banned in generation code. Node renders are byte-identical, and the goldens are Node-only (L1's tolerance absorbs Safari's rasterizer).

**Rendering ahead, and the budget** (I9). Drawings (limb drawings, mass drawings, posters) render ahead in an OffscreenCanvas worker; the main thread only stamps and composites. The physics (the lift, the rope and its collisions, the strike controller) runs once for the whole clip, and again only when something it reads changes (the strokes, the clip, the pose, the turn, the contact or the physics settings), and is reported per frame against a 1 ms line. In the app it runs in a Web Worker of its own, and no main-thread task during a rebuild runs over 100 ms: until it arrives, the preview shows the last result, or the limbs as drawn, carried by his body, and Reduce flashing, the aftermath's length or a color reuses the result it has. The Node render runs the same code in line. The design's lines on the Node proxy at 1080 × 608 are: main thread ≤ 26 ms a frame, a limb drawing ≤ 42 ms, a poster ≤ 8 ms, a mass drawing ≤ 12 ms, and worker load ≤ 80% in every window. They're estimates of the phone, not the gate; the device gate (below) is. The Node timing tests hold each part to about 1.5 × the time it measured in Node, with its design line beside it, so a slowdown fails a test, and every Node number over its line is reported. Where OffscreenCanvas 2D is missing, the same jobs run on the main thread between frames, at 0.75 preview resolution.
- **On the iPhone,** if the preview misses its budget, it steps down recorded tiers, in this order: lightning on 2s, 4 → 2 ribbons, half the particles, a coarser smoke cluster, 6 → 3 arcs a limb, then 0.75 resolution. Fewer glow buffers is out of the order: the near glow is the limbs' and the lightning's hot edge. The impact frames, the limbs and the cracks are never cut, and the export always uses the full tier. No step fits the lines in Node, so the phone starts with all six cuts until the bench says otherwise.
- **The device gate** is Qai's run of the bench (`bench.html`) on his iPhone: a limb drawing with 24 arcs in ≤ 50 ms in the worker, and stamp, cutout and grade in ≤ 14 ms on the main thread; and on a synthetic slam, a whole strike frame (f76–83) and a whole aftermath frame (j 18–28) in ≤ 26 ms each on the main thread, with the worker ≤ 80% busy over f93–115, at the full tier and the phone's. Until he runs it, the tiers are timed in Node and the gate is pending.

**What this reverses.** This section replaces the slam that c628565 ("Slam: shockwave ring and timing curves", `[qai-approved]`, Oct 27) specified. It reverses three things that commit settled, and Qai approves them by committing this section with `[qai-approved]`:
1. **The shockwave ring is dropped.** No noise-cut WebGL ring is drawn. The dust band and the impact frames' rings take its place, and `ring` only parses. S5 changes with it.
2. **Per-effect easing is cut to the cracks.** Only `ease.cracks` is read; it drives the draw-on, 'out' by default. `ease.ring` and `ease.bursts` parse and do nothing. c628565's `bursts` parse and draw nothing either: the contact bursts and the lightning take their place (S3).
3. **No impact tap.** The contact frame comes from the cached person mask under his impact drawing, and he can move it ±1. That un-parks finding moments automatically, for the contact frame only: Wonder and new SAM calls for moments stay parked (§15). The tap itself dates from c016957; c628565 kept it.

In S4, "the ring" goes with it: the ground strokes (the cracks) and the floods render under the person cutout, and the dust stands over him with the fire and the smoke. "Bursts" means the contact bursts and the lightning, which render over him.

## 9. Meta models, proxy and probe

Read the docs before writing a call.

**SAM 3.1** (`sam-3.1`), through the Responses API at `https://api.meta.ai/v1` with the OpenAI SDK. Docs: https://dev.meta.ai/docs/sam/segmenting.
- **Request setup.** Build prompts with `buildObjectPrompt`, decode masks with `@meta-sam/parser`, and request `one_bit` masks plus `include_confidence`.
- **Uploads.** Upload each clip once through the Files API and reuse the file id.
- **Formats.** MP4 or MOV in H.264, H.265 or MPEG-4. No WebM. Converting every clip to H.264 at a constant 30 fps first also stops a phone clip's shifting frame rate from knocking the masks out of sync with the frames.
- **Cost.** $0.20 per 1,000 frames, minimum 50 frames per request. Results vary slightly between runs, so cache them.
- **Runs per clip:**
  - concept `person` (occlusion, torso, body height)
  - concept `face` (measured as a turn sensor in T1, and the impact's face-safe cut, §8.9; it doesn't drive the turn, §8.5)
  - one run per stroke anchor from the plan: a concept, or a point propagated in both directions

**Muse Wonder.** Model id from https://dev.meta.ai/models/muse-wonder. It uses structured output with a fixed JSON schema and makes two calls:
- **Plan, one per drawing.** Input: the frame, with each stroke in its own color and numbered at its root, plus the stroke geometry as text. Output, per stroke:
  - `kind`
  - `anchor`
  - `bodyAngle`
  - `stiffness`
  - `layer`
  - `wobble`
  - a one-line reason
- **Facing, one per clip.** Input: every 6th frame (5 fps), each with its frame number burned in. Output: a facing class and a confidence for each frame.

Every Wonder call asks for reasoning effort `low`, and the proxy pins it (§9 Oct 27 result). Each Wonder job must beat a dumb rule on the tests, or the video doesn't claim it. Both calls are cached.

**Proxy.** `functions/` holds a Pages Function that would forward calls to Meta's API with the key and a daily spend cap. The app doesn't call it and it has not been deployed. Scripts in `scripts/live/` call the API directly, with the key from `.env`.

**Probe (script built in M0; run and judged in M2, the first milestone with a key).** `npm run probe` runs on `fixtures/probe/clip.mp4`, a 10 s slow turn:
1. SAM three ways: `person`, `face`, and one point on Qai's back. Place the point on a frame where his back shows, and propagate it in both directions.
2. Wonder's facing labels on 8 numbered frames.

It writes `fixtures/probe/report.md` with:
- the median and p95 frame-to-frame centroid jump for each prompt, as % of body height
- the face-present timeline
- Wonder's 8 labels
- `fixtures/probe/strip.png`, every 10th frame with the masks overlaid

The probe is the last point to switch projects; after it, only cuts. Qai reads it against this table:

| Probe result | Then |
|---|---|
| The back point holds through the turn | The turn is in M3 as specced |
| The face track stays when his back turns | The behind/in-front swap becomes a manual key on the timeline |
| Only the person mask holds | Anchor to it; whole-body effects; hero shot at three-quarter view |
| Nothing holds, even in daylight | Stop and tell Qai. This is the one case for switching projects; reshoot in daylight the next day before deciding. The fallback project is the family-paperwork agent: it matters more to the world at 100x, but its 9-day slice demos as a document chatbot in the most crowded lane, which is why it wasn't picked |

**Oct 27 result** (`fixtures/probe/report.md`, $0.44 in all). The clip was the hero itself, a fast spin and a fist slam indoors, not the 10 s slow turn.
- **Person:** held on every frame he's in shot (209 of 254, through the spin blur and the crouch). Median jump 0.94% of body height, p95 4.4%.
- **Face:** stayed on his head while his back was turned; it dropped on 1 frame of the spin.
- **Back point:** placed on his back at frame 60 (`--back-frame 60 --back-xy 900,400`); SAM grew it into the whole person, so it can't tell back from front either.
- **Wonder:** 8 labels for $0.05 at reasoning effort `low`. Left to choose its own level, it spent all 4,000 output tokens reasoning and returned nothing, twice.

Row 2 applies, and Qai chose it: the turn is manual keys (§8.5), and Wonder's labels are tried in M4 as the automatic upgrade. The tap is no longer required: the pose track reads the turn where it's reliable, and one optional tap overrides it (§8.5).

## 10. Acceptance criteria

Each criterion has one test file, `tests/<milestone>/<ID>.test.ts`, which also writes `verify/out/<ID>.json` as `{ id, measured, threshold, pass, notes }`.

**Definitions used below:**
- **Body height:** the height of that frame's person-mask bounding box.
- **Strand length:** the arc length of the stroke's front view.
- **Settled:** the tip moves less than 0.5 px per drawing.
- **Nearest-mask rule** (the W1 and W2 baseline): attach each stroke to the nearest mask, with default physics (default stiffness and layer).
- **The impact's units** (§8.9): S is the frame's short side, I the contact frame, j = f − I, kr the reference clock, U the destruction's size unit and J_end = round(30 · `aftermath.seconds`).

### K: tracking (clips from "Clips required at each milestone")

| ID | Criterion | Threshold |
|---|---|---|
| K1 | Root drift: a point anchor seeded at the clip's first `truth.json` root, compared with every later hand-marked root on every required clip | median < 2% of body height, p95 < 5% |
| K2 | Jitter: RMS frame-to-frame anchor motion after smoothing, in frames marked `still` | < 0.3% of body height *(start)* |
| K3 | Lag of the smoothed anchor behind the raw one, by cross-correlation over the fastest segment | ≤ 2 frames *(start)* |

### P: physics (seeded unit tests)

| ID | Criterion | Threshold |
|---|---|---|
| P1 | Root distance from the anchor, at every step | < 0.5 px at 1080 wide |
| P2 | Segment length error after the constraint passes, at every step | < 2% |
| P3 | 10,000 steps of seeded random anchor motion, on strands at stiffness 0, 0.1, 0.3 and 1 and on a rigid stroke | No NaN; tip speed < 20 torso heights/s; once the anchor stops, the strand is settled within 2 s at stiffness 0.2 and up (rigid included), and within 6 s below 0.2 |
| P4 | Kinds and extremes | A rigid stroke matches its target within 0.5 px at every step. A strand at stiffness 0 with gravity settles with its tip below its root |
| P5 | Determinism | Two runs give byte-identical point arrays and identical PNGs |

### A: anime motion

| ID | Criterion | Threshold |
|---|---|---|
| A1 | Stepped drawings over 3 s, with a seeded synthetic anchor moving the whole time. The held drawing is in torso space, before it's placed on the frame | Changes exactly `drawingsPerSecond` times per second, and is identical between changes. It's placed with each video frame's own torso transform, so it never slides off the body |
| A2 | Boil, measured on the boil offsets themselves | Consecutive offsets differ; they repeat every `boil.cycle` drawings (from `reference/timing.json`); max offset ≤ `boil.maxPx` |
| A3 | Follow-through. Synthetic move: the anchor travels 1 torso height in 0.25 s, then stops; strand stiffness 0.3 *(start)*. Overshoot = max tip travel past its final rest point ÷ strand length | Overshoot = reference `followThrough.overshoot` ± 0.1; settled within reference `settleDrawings` ± 1 drawing |
| A4 | Arcs. Whip = the A3 move, reversed after 0.25 s | The tip path's max distance from its start-to-end chord ≥ 0.15 × strand length *(start)* |
| A5 | Slam preset | Drawings per phase equal reference `slam.phases` exactly; the tip at each key is within 2% of strand length of `slam.keys` |
| A6 | Line fidelity: (a) outline from the stored resampled points vs outline from Qai's raw input points, same brush; (b) each stroke at rest at θ = 0 (gravity 0, wobble 0, stiffness 1 or rigid) vs outline (a) | (a) mean distance < 1 px at 1080 wide; if it fails, raise the stored point count, not the threshold. (b) < 0.5 px |
| A7 | No pops: tip travel between consecutive drawings | ≤ 0.35 × strand length *(start)*, except during a preset strike or a fallback mirror swap |

### B: brushes (§8.8)

| ID | Criterion | Threshold |
|---|---|---|
| B1 | Determinism: each of the ten brushes, same effect and drawing index `k` | Byte-identical pixels across two renders; identical between drawing changes (A1) |
| B2 | Each brush does its job: grain fixed to the stroke; neon and electric glow stay near their line; electric changes shape on drawings and keeps its root; fine tip thinner than ink; the limb keeps its electricity near it and its root attached | Grain pixels move with the stroke (within 0.5 px under a pure translation); no glow pixel farther than 2 × `glow.radiusPx` from the centerline (for electric, 2 × `glow.radiusPx` + `bolt.ampPx` + the farthest shard); electric's pixels differ between consecutive drawings and its root sits within 1 px of the drawn root; blade's cast shadow no farther than 16 px from its outline; trail's sparkles within 1.6 × its width of the centerline, and its core never white (no pixel with all channels ≥ 250); fine-ink's widest point ≤ 0.5 × ink's on the same stroke *(start)*; the limb's glow and arc pixels no farther than 2 × `glow.radiusPx` + 2.1 × R0 from the centerline (R0 from §8.8), its root within 1 px of the drawn root, and its pixels different between consecutive drawings *(start)* |
| B3 | Qai's look | One approved golden per brush in `tests/golden/brushes/` (L1 holds them after that) |
| B4 | The flame aura follows the person and stays near him | On a synthetic mask: byte-identical across two renders of the same `k`; different between consecutive drawings; no aura pixel farther than 0.6 torso heights from the mask; moving the mask moves the aura with it (within 1 px at half resolution) *(start)* |

### S: the slam (§8.9)

| ID | Criterion | Threshold |
|---|---|---|
| S1 | Ground strokes stay put | Root and points within 0.5 px of their drawn frame position on every frame |
| S2 | Cracks start on the impact | Hidden before I; drawn on over the 4 impact frames IF1–IF4 and full from IF4 *(start)*; the drawn length only grows, and on each of them equals `ease.cracks((si + 1)/4)` × full length (within 1%); with `frames.count` 0, the same over 4 global drawings from I |
| S3 | Contact bursts and lightning | Contact bursts on strike steps 1, 4 and 5 only (j −7, −3 and −2), one frame each, 6–10 arcs reaching no farther than 0.25 U from P; lightning from age 3 (kr 17) to J_end − 5, with 2–3 ribbons at ages 3–6, 4–9 at ages 7–11 and 2–7 from age 12, changing only on kr steps *(start)*; same seed → byte-identical pixels |
| S4 | Layers | Ground strokes and the ring render under the person cutout; bursts render over it |
| S5 | Dust band and poster rings, in the ring's place | No shockwave ring is drawn. The dust band runs out along the floor from P, its half-width only growing, 0.45 → 0.6 U *(start)*, and its shape changing only when the 2s group changes; IF5 and IF7 draw their rings at their anchors; same seed → byte-identical pixels |
| S6 | Emergence | Electric and limb strokes in an `emerge` moment draw nothing before its drawing; their drawn length only grows over the 4 grow drawings and is full from the 4th; the pop flash and sparks are on the next 2 drawings only; same seed → byte-identical pixels. The suggested frame on the probe clip is within 3 frames of frame 22, where he uncrosses his arms *(start)* |

### I: the impact (§8.9)

| ID | Criterion | Threshold |
|---|---|---|
| I1 | Two drawings make the moments: on the probe clip with the test drawings (limbs on f22, cracks on f84) and no other input | Contact on f84 when the impact is drawn on any frame in f74–94; P within 0.02 S of (942, 1061); d within 3° of his fist's hand-measured track (−0.058, 0.998); an impact drawn less than 15 frames after the limbs is refused (f2 ≥ f1 + 15) |
| I2 | Limb tube | Per-section radius within 0.5 px of R(t, p); the silhouette contains the centerline; front/behind flips within 2 px of the person-mask edge on probe frames 50–110; outline contrast ≥ 3:1 against the plate under it on f22, f60 and f93 *(start)*; byte-identical across two renders |
| I3 | Electricity on the limbs | Arc counts per phase as §8.7 says; every arc point within λmax·r + w of the tube axis; arc shapes identical within a drawing; no pulse on consecutive drawings of the same limb *(start)* |
| I4 | Slam-down | Tips within 0.5 px of P from the landing to the release (j −7..8); under full flashing, beam widths within 5% of the multipliers in §8.7 *(start)*; released on j 9 |
| I5 | Impact frames | 7 posters on frames I..I+8 with holds 2, 1, 1, 1, 2, 1, 1; IF4's star center = IF5's cross center; every HUD anchor in frame, in landscape and portrait; full-mode coverage of the untinted posters on the reference geometry within ±5 points of the measured black / white % (§8.9; IF1 8.1 / 91.9), and IF1's tint 25.2 ± 5% mid *(start)*; every impact stroke visible in every poster |
| I6 | Flash safety | The check runs on every export. Full mode: it changes no pixel, and the export sheet shows the warning when a 1 s window holds more than 3 flashes. Reduce flashing: on the hero export, ≤ 3 general flashes and 0 red flashes in every 1 s window, one inversion across the posters, and washes ≤ 25% of the frame; a clip that flashes on its own ends in `FlashCheckError`, not a saved file |
| I7 | Aftermath | Masses, sparks and embers identical within a hold group; 1s layers different at every kr step; the mass centroid's t within ±0.08 U of P and its n within ±0.05 U of the measured curve, in the masses' unit (§8.9) *(start)*; nothing but scars at I + 30·seconds, for 1.5 s and 3 s; no front-effect pixel inside the dilated face mask from I+9 |
| I8 | Determinism | Frames I−10..I+45 byte-identical across two renders; a single frame rendered alone equals the sequential render |
| I9 | Budget | The gate is Qai's iPhone (manual): the bench's device gate (a 24-arc limb drawing ≤ 50 ms in the worker; stamp, cutout and grade ≤ 14 ms on the main thread; on the synthetic slam, a whole strike frame and a whole aftermath frame ≤ 26 ms each on the main thread and the worker ≤ 80% busy over f93–115) and the preview at ≥ 24 fps, from the recorded tier the gate picks (§8.9) *(start)*. The Node proxy at 1080×608 is reported against the design's lines, not gated on them: main-thread frame 26 ms with drawings rendered ahead; limb drawing 42 ms, poster 8 ms, mass drawing 12 ms; worker load 80% in every window; physics 1 ms a frame *(start)*. Its timing tests fail a part that runs slower than about 1.5 × its measured Node time. In the app the physics runs in a worker and is kept by exactly what it reads (§8.9): Reduce flashing, the aftermath's length or a color never works it out again, and no main-thread task during a rebuild runs over 100 ms *(start)* |
| I10 | Rope limbs (§8.5): on a synthetic body that spins, bends double for the slam and rises, with four limbs at stiffness 0.1 and the limbs-first strike, and on the hero clip's drawn limbs | The tip lags the root by ≥ 2 frames at the cross-correlation's peak through the turn and through the coil, and the coil winds root first; the median joint-angle change in the root's frame between drawings is ≥ 3° while he moves and ≥ 1° while he stands, without the boil; during the whip the outer half peaks bending no sooner than the inner half; from the release to J_end each limb is 0.85–1.15× its drawn length per torso height, with sagitta/chord ≥ 0.06 on screen; no drawn joint over 60°, on any frame. On the hero clip, the same on the centerline the scene draws, for all four limbs, with no spin pop (over f55–74 relative to its root no node moves over 60% of the limb in a drawing and no tip turns over 140°), at the clip's full size and at half of it, and tighter there: the lag with r ≥ 0.6 through the spin (f50–74) and the coil (f70–76); 1–12° a drawing while he stands (f24–48, f141–159); the whip (f74–77) a bend running from root to tip, the outer half peaking after the inner half, the tip's step onto P on f77 its fastest, no outer quarter turning over 90° in all, and the inner half at sagitta/chord ≥ 0.03; pinned (f77–92), the middle of each limb moving at least 3 px every drawing and at most 60 px a frame, at sagitta/chord 0.06–0.5; released (f93–130), the tips snapped at least 250 px off P on the first drawing and 400 px by f95, then flopping back (each chord turns back at least 5° against the way it was flung), the tips pulling up and out of P, each limb 0.85–1.15× as long as drawn on screen on every frame, no point past the floor line through P or under the frame, and from f96 no tip moving over 80 px a frame *(start)*; byte-identical across two runs |
| I11 | His body (§8.5) | On the hero clip, no point of a limb's centerline past its root's flare is more than 2 px inside his scanned body on f0–159, nor does any stretch between two nodes pass through him; face-on (f124–136) no limb is drawn over his face or chest unless it is in front of him in 3D *(start)*; a 33-point pose gives the egg and ten capsules, the 15 core points the egg, head and neck, no pose the egg alone, and a frame without a mask the parts alone; the same poses and masks give the same dummies and scans |

### T: the turn

| ID | Criterion | Threshold |
|---|---|---|
| T1 | Facing-class accuracy on the hand-labeled frames of the required turning clips. Report face-only, Wonder-only and fused side by side, scored on the same frames | ≥ 80% for the source in use. The source in use is Qai's turn keys (§8.5) unless Wonder-only or fused reaches ≥ 80%; only then does the app read the turn by itself and the video claim Wonder reads it |
| T2 | At θ = 0, 90 and 180 (and 270 if drawn), the blended target vs the drawn view | max point error < 0.5 px |
| T3 | Blend continuity: target point movement per 1° of θ | < 2% of strand length |
| T4 | Layering on labeled frames | In `front` frames, "behind" stroke pixels over person-mask pixels ≤ 0.5% of stroke pixels. In `back` frames, strokes that the back view marks `front` render over the body |
| T5 | The 3D lift (§8.5) | On the drawing frame, the lifted stroke projects onto the drawn one (max point error < 0.5 px). Facing the camera (θ = 0), a back-rooted stroke's root renders under the body, and with his back to the camera (θ = 180) over it. Shape and per-point layer change only on frames where k changes. No stroke vanishes except where occluded |
| T6 | Bend | On a synthetic body pitched 0° → 90° (shoulders sliding down onto the hips at a fixed shoulder width), the measured pitch is within 10° *(start)*; roll follows a rotated shoulder and hip line within 5°; a stroke drawn behind the back points up (its tip above its root) at 90° and is in front; through a pose gap or a phantom body, roll and pitch hold the last good frame's values, then blend back over the next 4 frames, with no NaN |

### W: Wonder

| ID | Criterion | Threshold |
|---|---|---|
| W1 | Attachment accuracy on 30 labeled strokes (`fixtures/strokes/labels.json`) vs the nearest-mask rule; also report stiffness and layer accuracy | ≥ 21/30 and strictly better than the rule |
| W2 | Every response either validates against the schema or falls back cleanly: invalid → one retry → nearest-mask rule with a visible note | 100%, no crash |
| W3 | Every plan field has a one-tap override that persists in the effect JSON | all fields |

### X: product

| ID | Criterion | Threshold |
|---|---|---|
| X1 | A 10 s clip exports to H.264 MP4 with the original audio in desktop Chrome | < 60 s (measured by a browser test) |
| X5 | The whole flow on Qai's iPhone, in Safari: load a clip, draw a stroke with a finger, preview, export | Manual: preview holds ≥ 24 fps *(start)*, nothing crashes or reloads, and a finger stroke follows him like a Pencil stroke does |

### Gates, locked look, probe

| ID | Criterion |
|---|---|
| G1 | One clip runs end to end in the app from cached data: clip → plan → SAM → physics → stepped preview |
| L1 | Every approved golden in `tests/golden/` re-renders within 0.5% pixel difference, unless Qai re-approves it |
| PROBE | `fixtures/probe/report.md` and `strip.png` exist and contain everything listed in the Probe part of §9 |

**Manual evidence.** The manual part of I9, and all of X5, are evidenced by `fixtures/manual/<ID>.json`:

```json
{ "id": "X5", "by": "Qai", "date": "2026-11-01", "result": "pass", "notes": "a finger stroke follows him; the export plays" }
```

Qai commits it himself with `[qai-approved]`. The judge accepts it for those parts only. X1's export time and I9's Node timings still need `verify/out/<ID>.json`.

### R: rules (rules-auditor, every milestone)

| ID | Criterion |
|---|---|
| R1 | `node scripts/scan-secrets.mjs` exits 0. `.env` and `.dev.vars` were never committed (`git log --all -- .env .dev.vars` prints nothing) |
| R2 | No anime material. `reference/` holds only JSON plus the drawings listed in `reference/manifest.json`. `fixtures/` holds only: JSON, including cached SAM and Wonder responses and `manual/`; the clips listed in `fixtures/clips.json` with consent noted; `fixtures/probe/report.md` and `strip.png` |
| R3 | The README section "Built Oct 26 – Nov 4" is present and matches `package.json` |
| R4 | No network outside the allowed folders. In code (`src/`, `functions/`, `scripts/`, `tests/`, `.claude/hooks/`), the API host appears only in `src/sam`, `src/plan`, `functions/` and `scripts/live/`; docs may name it. Tests, hooks and verify import none of those clients. The R4 test builds its search pattern from pieces (`['api','meta','ai'].join('.')`), so it doesn't match itself |
| R5 | No weakened checks. Two diffs: `git log -p milestone-<id>-start..HEAD -- docs/SPEC.md reference tests/golden "fixtures/*/truth.json" fixtures/manual fixtures/required-clips.json .claude`, and `git log -p milestone-<id>-tests..HEAD -- tests/<id>`. Any change to a threshold, reference file, truth file, golden, manual evidence, required-clips list or checker setup must sit in a commit whose message carries `[qai-approved]`. Any loosened assertion in `tests/<id>` fails. Any uncommitted change on those paths (`git status --porcelain`) fails |

## 11. Fixtures and reference data

The tests and the checkers compare the output against these files. If one is missing, "exact" can't be measured, so the agents stop and ask for it instead of inventing a stand-in. Everything in `reference/` is Qai's own work: study scenes outside the repo and bring back only drawings and numbers. Qai commits each file himself, right after making it, with `[qai-approved]` in the message (Claude can't edit these files or write that token), for example:

```
git add fixtures/side-step/truth.json
git commit -m "Add side-step truth [qai-approved]"
```

**`reference/timing.json`** (Tue, campus gap, iPad). Trace one kagune lash from a scene he knows, frame by frame, in Procreate, keeping only his own lines. Count the drawings in each phase and note where the tip is at each key. Start from `reference/timing.example.json` and fill in his numbers:
- `dps`: 12 if the shot is on 2s, 8 if it's on 3s.
- `lash.phases`: the number of drawings in each phase (for example wind-up, strike, overshoot, settle).
- `lash.keys`: the tip position at each key, in torso units relative to the root. Estimate these until M3's views mode can export them.
- `slam.phases` and `slam.keys` (parked: the limbs land first, so the impact doesn't read them, §8.9; they're A5's input only if he keys a strike by hand): the same for the kagune slamming down, ending with the tips on the floor. His own keys, not traced.
- `followThrough.overshoot`: how far past its stopping point the tip swings, as a fraction of strand length.
- `followThrough.settleDrawings`: how many drawings until it's still.
- `boil.maxPx`: how strong the line boil is, at 1080 wide.
- `boil.cycle`: how many drawings before the boil repeats.

Tests must fail while `timing.json` is missing.

**`reference/views/hero.json`** (Fri, during M3). In the app's views mode, draw the hero effect three times: the front; the side, with his right side toward the camera; the back. Redraw every stroke in the same order each time. The app exports the file. A left view is optional; without one, the side view is mirrored.

**`reference/manifest.json`.** Lists every drawing file added to `reference/` (svg or png), with one line saying it's his own work.

**Ground truth: `fixtures/<clip>/truth.json`** (made on the `/label` page from M1), about 10 minutes per clip:
- **Root:** click the same body point every 10th frame, the spot where the hero effect attaches.
- **Facing:** press F, R, B or L every 6th frame (5 per second, the frames Wonder sees), using the classes in §7.
- **Still:** drag across the stretches where he holds still.

```json
{ "clip": "side-step", "fps": 30,
  "roots": [ { "frame": 0, "xy": [512, 840] } ],
  "facing": [ { "frame": 0, "label": "front" } ],
  "still": [ [120, 165] ] }
```

**`fixtures/strokes/labels.json`** (Thu, M2). 30 test strokes drawn in the app: horns, a halo, a tail, tendrils, and a few tricky ones. For each: what it should attach to, its stiffness (0–1) and its layer. Wonder is scored against these labels and against the nearest-mask rule.

**`fixtures/clips.json`.** One entry per clip: who's in it, and the date of their written consent. For his own clips, the consent field says "self".

**`fixtures/manual/<ID>.json`.** What he checked by hand (§10, manual evidence).

**Clips.** Shoot in daylight with a fast shutter (1/250 s or faster), H.264, HDR off: dim light blurs motion, and blur is the main source of jitter.
- **The probe clip:** `fixtures/probe/clip.mp4`, plus `fixtures/probe/truth.json` made on the `/label` page.
- **Six clips,** easiest first: side-step, walk toward the camera, arm swing, hand passing in front, slow turn, spin. Their folder ids are `side-step`, `walk`, `arm-swing`, `hand-in-front`, `slow-turn` and `spin`, and each has a `fixtures/<clip>/` folder with a `truth.json`. Rough indoor takes are fine until M6.
- **Synthetic anchor paths** for A1, A3 and A4, generated by the tests (seeded).

**Clips required at each milestone** (this table also lives in `fixtures/required-clips.json`). A criterion run on fewer clips fails.

| Milestone | Clips with truth.json |
|---|---|
| M1, M2 | side-step, walk |
| M3 | side-step, walk, probe |
| M4, M5 | side-step, walk, probe, slow-turn, spin (T1 on probe, slow-turn, spin) |
| M6 | the 6 daylight clips, probe (T1 on probe, slow-turn, spin) |

## 12. Already built

A working prototype was built on Oct 27, before the kit arrived. It predates the module layout in §6 and has no vitest tests yet: M0 and M1 move its pieces into `src/video`, `src/track`, `src/render`, `src/export` and `src/app`, and add the tests. What it does, and what it taught:

- **Conversion** (`src/clip.ts`). H.264 at a constant 30 fps, first 15 s, long side capped at 1920 px. Frame i is whatever the source shows at the middle of its slot, `(i + 0.5)/30` s. Don't use Mediabunny's `frameRate` option: it floors `t·30` without a tolerance, and floating point puts some exact frame times just below a slot (8.2 × 30 = 245.99999…), which drops a frame and doubles the next about 4 times per 15 s at 30 fps. Unrotated clips go straight from the decoder to the WebCodecs encoder, which shrinks them itself (about 20 ms a 4K frame, 5–6× faster than drawing onto a canvas without a GPU); clips with a rotation flag go through a canvas, which bakes the rotation in.
- **Brush, boil and export** (`src/brush.ts`, `src/export.ts`). perfect-freehand with tapers, a seeded boil at 12 drawings per second, and MP4 export with the original audio. The export doesn't re-time frames, because its input is already constant 30 fps.
- **Tracking and layering** (`src/tracking.ts`, `src/render.ts`). Anchors from mask moments (centroid, axis, √area), zero-phase One Euro smoothing (forward and backward, with mirrored ends), gap filling, and strokes rebased on the frame they were drawn on. Behind strokes go under a person cutout. Strokes are placed rigidly for now; the physics in §8.3 replaces that.
- **Stand-in tracker** (dev only; `src/standin.ts`, `tools/`). MediaPipe's pose model stands in for SAM until the key works: in the browser when the page has WebGL 2, otherwise on the dev server in Python (`npm run standin:setup` once). It's left out of production builds, and nothing it measures is claimed anywhere (§3).
- **Phone mode** (`npm run dev:phone`). Safari only allows WebCodecs on HTTPS pages, so this serves the app over HTTPS on the local Wi-Fi at port 5175, with a self-signed certificate the phone accepts once. The layout fits a phone screen.

## 13. Judging, prizes and the demo

### Judging

Impact carries the most weight, and the final round is judges watching the top 5 videos per track live.

- **Stage 1, pass/fail:** the project fits a theme and really uses Meta's models. The README's first lines say "Build for Your World" and name SAM 3.1 and Muse Wonder, as they are used.
- **Stage 2:** the four scores below, 0 to 10 each.
- **Stage 3:** the top 5 per track; final judges watch the demo videos live and rank them on the same rubric.

| Score | Weight | How Inkwell earns it |
|---|---|---|
| Impact | 30% | Two drawings become a finished impact shot on the person's own clip. |
| Use of Meta AI tooling | 25% | SAM 3.1's person and face masks, read from saved answers, cut him out and drive the tracking and the impact. Muse Wonder labeled which way he faces on the probe clip (`fixtures/probe/report.md`); the app doesn't read that answer. |
| Technical depth | 20% | His own physics (one engine, rope to rigid), smoothing, layering and the turn, checked by the tests. |
| Demo | 25% | The hero shot: two drawings, then the impact on the clip. |

## 14. Risks and fallbacks

Shaky tracking is the biggest risk, because every wobble in the mask shows up in the strands. The biggest judging risk is Wonder's job looking like a dropdown.

| Risk | Fallback |
|---|---|
| SAM's masks shift slightly between frames and runs, so the strands jitter | One Euro smoothing; hold the last good position when SAM's confidence drops; shoot in daylight at 1/250 s or faster |
| The back point or the face track fails in the probe | Happened Oct 27: both missed the turn on the hero spin, so the swap is turn keys (§8.5). Keep the hero move |
| Clips arrive as WebM or with a shifting frame rate | Convert every clip in the browser to H.264 at a constant 30 fps before upload |
| Wonder doesn't beat the dumb rule | Use the rule where it wins and say so in the README; the tooling story leans on SAM's three jobs and whatever Wonder still wins |
| The spin is too fast for the face track or blurs | Spin slower (a full turn in 1.5–2 s), shutter 1/500 s, brightest light; the slam doesn't depend on the turn, so it still lands |
| iPhone export is too slow, or the phone heats up and slows down | 720p on the phone; 1080p from iPad or desktop Chrome; for the demo, screen-record the canvas. Test on the iPhone early (from M2), through Mac Safari's Web Inspector if one is around |
| iPhone Safari runs out of memory and drops the canvas or reloads the tab | Fixed internal resolution, reused buffers, one video texture, and the scene rebuilds from the stroke data |
| Nothing tracks steadily in the probe | Stop and decide before building anything else (§9) |
| The impact frames flash too much for some viewers | Full is the default, and every export runs the flash check: it warns plainly when a second holds more than 3 flashes, with Reduce flashing beside it. Reduce flashing holds WCAG 2.3.1 and refuses with `FlashCheckError` rather than save a clip that still flashes (§8.9) |
| P sits at the frame edge (on the hero clip it's 19 px above the bottom) | The HUD marks slide back up the strike axis and the physical marks mirror into frame (§8.9). Under the shake, P sits about 2 px below the bottom edge on j 9..18; that's accepted |
| His fist isn't in the person mask at contact | The contact detector reads the lowest mask row under P, so the fist must be in the mask: shoot with it in frame and in the light. If SAM drops the hand, contact falls back to the frame he drew on, and Move contact frame ±1 fixes it |
| The stand-in is wrong around contact (no body on f89–101, phantom bodies from f196) | Pose gaps hold the last good roll and pitch, then blend back (§8.1). The slam-down pins the tips on P whatever the bend says |
| The iPhone can't hold the limbs and the impact at 24 fps | Drawings render ahead in a worker; the preview steps down recorded tiers, never the impact frames, the limbs or the cracks, and the export always uses the full tier (§8.9). Qai's bench run on his iPhone is the device gate (I9) |
| The pose track misreads a fast spin | One optional tap overrides it (§8.5). On the hero clip the render falls back to the hand-measured keys when the pose track is more than 45° off them, and says so |
| One phone camera can't scan him in 3D, so the limbs could pass through him | His person mask is his outline on every frame and a crash-test dummy fitted to the stand-in's pose gives it depth; the limbs collide with both, and held drawings are routed round him (§8.5). The app's stand-in has only its 15 core points, so there only his torso, head and neck give depth |

## 15. Not in v1

- **Effects:** speed lines, smears, capes and cloth. (Impact frames are in, §8.9.)
- **Props:** swords and other hand-held props (SAM doesn't guarantee hand masks).
- **Scenes:** multiple people, a moving camera.
- **Export:** 1080p export on the iPhone, if 720p is all that holds up.
- **Models:** SAM 3D Body, Glimmer, Muse Image drafting of missing views (a v2 idea for people who draw only once).
- **Agents:** an agentic self-critique pass.
- **Also parked:** the rest of the "moments" layer (air slash, spin speed lines; the emergence and the impact are in, §8.9), moments found automatically (except the impact's contact frame, read from the cached person mask; Wonder and new SAM calls for moments stay parked), imported brushes, Stand-style fights, voice-to-doodle.

## 16. Prior work and sources

**Short answer:** the exact look comes from drawn poses and drawn views, timed on 2s, with physics only for the in-betweens. Generative models can guess the side of a drawing that was never drawn, but a guess isn't his line, and it drifts from frame to frame. Meta's API has no video-generation model anyway, so a generative turn wouldn't count toward the tooling score.

| Approach | Examples | Gets right | Gets wrong for "exact anime" | Turn: the side never drawn | Fits 8 days + Meta API |
|---|---|---|---|---|---|
| 2D physics on drawn strokes | Willett et al. 2017; Live2D physics; Character Animator's dangle | Secondary motion; keeps the artist's line; real time | Looks floaty and CG at a smooth 30 fps; no deliberate poses | Can't show it; only layer tricks | Yes |
| Animation principles as dials | Motion Amplifiers (Kazi et al. 2016) | Squash and stretch, follow-through and anticipation as controls | Generic until tuned to a specific effect | No | Partly (ideas for parameters) |
| Keys + physics in-betweens | Wiggly Splines (Kass & Anderson 2008); hand-keyed limited animation in Guilty Gear Xrd | Deliberate poses plus natural overlap; anime timing | Needs keys traced or drawn by an artist | Only when views are drawn | Yes (presets) |
| Drawn views by angle (2.5D) | 2.5D Cartoon Models (Rivers, Igarashi & Durand 2010); Live2D angle keyforms; Character Animator Head Turner | The key angles are the artist's drawings; angles between them are blends or swaps, never invented | The artist draws 2–3 views; very different views can look rubbery mid-blend | Yes, drawn rather than guessed | Yes |
| Flat cards in 3D | VideoDoodles (Yu et al. 2023) | Perspective and occlusion | Drawings stay flat, so a turn shows a squashed card, never the other side | No | No (needs 3D scene reconstruction) |
| Drawn on the body, live | Interactive Body-Driven Graphics (Saquib et al. 2019); RealityCanvas (Xia et al. 2023) | Graphics bound to a performer | Preset behaviors; 2D only | No | Partly (validates the idea) |
| Animate a single flat drawing | Meta's Animated Drawings (2023) | Rigs a drawing and retargets motion capture | The drawing stays flat | No | Prior art worth naming to Meta judges |
| Lift to 3D, render as toon | Guilty Gear Xrd (Arc System Works) | Consistent from any angle | Heavy art direction to read as hand-drawn; needs body depth | Yes (geometric) | No (8 GB GPU, time) |
| Generative video | ToonCrafter (2024); PhysAnimator (CVPR 2025: physics guides a generative renderer) | Fills in frames and style automatically | Doesn't keep the exact line; drifts frame to frame; slow | Not these two: ToonCrafter interpolates between frames you give it, and PhysAnimator deforms one image. General video models can invent an unseen side, but it's a guess | No (no Meta video model) |

Production anime-style 2D draws its views and adds pendulum-style physics for sway (Live2D, used for VTuber rigs, blends drawn keyforms by angle; Character Animator swaps drawn views). Anime-look 3D (Guilty Gear Xrd) holds frames and keys poses by hand. Inkwell combines both: views drawn by Qai and blended by facing angle, keyed presets for strikes, a rope simulation for overlap, and output stepped on 2s with a boiling line. PhysAnimator is the closest research to "physics plus anime look"; it reaches the look through a generative renderer, which is exactly the step that gives up the artist's exact line.

**Sources.** The descriptions are summaries; open the link before quoting a detail in the README or the video.
- [Secondary Motion for Performed 2D Animation (Willett et al., UIST 2017)](https://pixl.cs.princeton.edu/pubs/Willett_2017_SMF/index.php)
- [Motion Amplifiers: Sketching Dynamic Illustrations Using the Principles of 2D Animation (Kazi et al., CHI 2016)](https://www.research.autodesk.com/publications/motion-amplifiers-sketching-dynamic-illustrations-using-the-principles-of-2d-animation)
- [Animating Oscillatory Motion With Overlap: Wiggly Splines (Kass & Anderson, SIGGRAPH 2008)](https://graphics.pixar.com/library/WigglySplinesA)
- [GuiltyGearXrd's Art Style: The X Factor Between 2D and 3D (Motomura, GDC 2015)](https://gdcvault.com/play/1022031/GuiltyGearXrd-s-Art-Style-The)
- [Interactive Body-Driven Graphics for Augmented Video Performance (Saquib et al., CHI 2019)](https://research.adobe.com/publication/interactive-body-driven-graphics-for-augmented-video-performance)
- [RealityCanvas (Xia et al., UIST 2023)](https://arxiv.org/abs/2307.16116)
- [VideoDoodles (Yu et al., ACM TOG 2023)](https://api.crossref.org/works/10.1145/3592413)
- [PhysAnimator: Physics-Guided Generative Cartoon Animation (Xie et al., CVPR 2025)](https://arxiv.org/abs/2501.16550)
- [ToonCrafter: Generative Cartoon Interpolation (2024)](https://arxiv.org/abs/2405.17933)
- [Live2D Cubism: physics settings](https://docs.live2d.com/en/cubism-editor-manual/physics-operation/)
- Not looked up yet; find the primary source before citing: 2.5D Cartoon Models (Rivers, Igarashi & Durand, SIGGRAPH 2010); Adobe Character Animator's Head Turner behavior; Meta's Animated Drawings (Smith et al., ACM TOG 2023).
- Event and models: [Meta Global AI Developer Hackathon](https://dev.meta.ai/events/global-hackathon); [Cerebral Valley event page](https://cerebralvalley.ai/e/meta-ai-developer-hackathon); [SAM: segmenting with prompts](https://dev.meta.ai/docs/sam/segmenting); [SAM overview](https://dev.meta.ai/docs/sam/overview); [SAM 3.1 model page](https://dev.meta.ai/models/sam-3-1); [Muse Wonder model page](https://dev.meta.ai/models/muse-wonder).
