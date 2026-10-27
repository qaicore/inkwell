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

Qai draws once, on one frame of a phone clip, and the drawing lives in the footage. From then on, the drawn tendrils, horns or tail:

- stay locked to his body through the whole clip
- move on 2s like hand-drawn anime: each drawing holds, the line boils slightly, and motion overshoots and settles along arcs
- show the view he drew at each angle when he turns, passing behind and in front of his body correctly
- strike with keyed poses, if the Sunday slot goes to the lash preset

"Exact" has two parts:
- the output matches Qai's reference data in `reference/` on every criterion in §10
- Qai approves the contact sheet

**Who and when.** A solo build by Qai for the Meta Global AI Developer Hackathon: Indie Developer track, theme "Build for Your World". It's due Wed Nov 4 at 9:00 PM ET; submit by noon, 3 PM at the latest, because the real deadline lands in his 5–11 PM shift.

**Division of labor.** Muse Wonder plans each stroke and reads which way he faces. SAM 3.1 tracks the anchors Wonder picks, plus his body (`person`) and face (`face`). Everything that moves is code written for Inkwell. Meta's own SAM docs recommend this split: a Muse model to understand the scene, SAM to segment it.

**Hero effect.** Horns, a halo and a tail come first. The kagune is the hero only if it's clean by Sunday. Call them tendrils for judges and kagune on X.

**Inputs and outputs.**
- **Clip:** MP4 or MOV, under 15 s, one person. The app first converts it in the browser to H.264 at a constant 30 fps, using Mediabunny. After that, frame index `f = round(τ·30)` is the clock.
- **Drawing:** pointer events with pressure (Pencil in iPad Safari; mouse or pen in desktop Chrome). One brush (perfect-freehand) and three colors.
- **Output:** a vertical MP4 (H.264, original audio) exported in desktop Chrome, plus a live link with cached sample clips.

## 2. Rules

Breaking any of these can disqualify the project or make the checks meaningless.

1. **New work only.** Write everything fresh. Copy nothing written before Oct 26, 2026, including the old rope sandbox and the draw-to-component tool. The repo is public, and its first commit comes after the Oct 26 kickoff.
2. **No anime material** in the repo, the app or the video: no footage, frames, screenshots or audio. `reference/` holds only Qai's own drawings and the numbers he measured. The kagune design is original and drawn new during the event (his portfolio kagune is pre-event work); it isn't Kaneki's.
3. **Secrets stay out of git.**
   - Keys live only in `.env`, and in `.dev.vars` for the Pages Function's local dev. Both are gitignored from the first commit.
   - Never print, log or commit a key. To check for leaks, run `node scripts/scan-secrets.mjs`; it never prints values.
4. **Paid API calls happen in two places only:**
   - the running app, through `functions/` with its spend cap
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
6. **Attribution.** `README.md` has a section "Built Oct 26 – Nov 4". It separates Meta's models (SAM 3.1, Muse Wonder), the open-source libraries, and code written with Claude Code under Qai's direction. Keep it current from M0 on, and update the library list whenever `package.json` changes. The demo video shows only features built during the event and says which parts are Qai's.
7. **Consent.** Every clip in the repo, the demo or the posts is shot by Qai or by the person in it (testers' own clips). Every clip with someone other than Qai is listed in `fixtures/clips.json` with their written consent noted. If a clip isn't listed, don't use it in fixtures, the repo, the demo or the posts. Local testing is the exception: stock clips (for example the Pexels sample) may be used for local test runs, kept only in the gitignored `samples/` folder. No copyrighted music, no downloaded reels.
8. **Submission.** Enter the Indie Developer track only. Submit at https://cerebralvalley.ai/e/meta-ai-developer-hackathon/hackathon/submit with the public repo and the demo video link. Questions go to the Discord forum, where Meta also runs office hours; confirm there that bonus prizes stack with the track prize, and which X post counts for Most Viral.

## 3. Order of work

### Milestones

From M1 on, every milestone also re-runs the earlier milestones' K, P, A and T criteria on its own clip set (§11, "Clips required at each milestone"). R1–R5 run at every milestone. The last column says what needs a working Meta API key.

M0 and M1 need no key at all: every criterion that needs SAM or Wonder output starts at M2. (The kit put PROBE in M0 and K1–K3 in M1; they moved to M2 on Oct 27 because the credits hadn't arrived, and the checkers count missing evidence as a FAIL.)

| ID | Day | Build | Criteria | Needs the API key |
|---|---|---|---|---|
| M0 | Tue Oct 27 | The M0 checklist below, including the probe script (not run) | R1–R5 | No |
| M1 | Wed Oct 28 | Clip conversion; anchors (One Euro filter, torso space), developed on the stand-in tracker (§12); physics engine (2-hour cap); stepped renderer with boil; contact sheets; `/label` page | P1–P5, A1, A2, A6 | No |
| M2 | Thu Oct 29 | The probe run; cached SAM fixtures for the required clips; Wonder plan call with schema check and one retry; override UI; nearest-mask baseline; Gate 1 (one full run, clip to playback; ugly is fine) | PROBE, K1–K3, W1, W2, W3, G1 | PROBE, K1–K3, W1, G1 (W2 and W3 can use recorded responses) |
| M3 | Fri Oct 30 | Turn: facing from the face track; views mode (draw side and back over a faint front); view blending; layering and occlusion; single-view fallback | T2–T5, A3, A4, A7 | T4 and the re-run K criteria; T2, T3, T5 and A3, A4, A7 are API-free |
| M4 | Sat Oct 31 | Wonder facing labels and fusion; MP4 export; deploy with cached samples; Gate 2 | T1, W1 (final), X1, X2, G2 | T1, W1, G2 (X1 and X2's server test are API-free) |
| M5 | Sun Nov 1 | One slot, in priority order: finish M3 if it slipped, then Qai's Friday-night pick of wear this effect (X3) or the lash preset (A5). X3 only if Gate 2 passed on Saturday, with a 5-hour cap. Feature freeze at 11 PM | X3 or A5, L1 | X3 |
| M6 | Mon Nov 2 | Every suite on the full clip set; README scoreboards | all | yes |

**M0 checklist:**
1. **Commit the skeleton first.** `package.json`, Vite, strict TypeScript and vitest, committed before test-author runs.
2. **`npm run check:fast`.** It typechecks `src/` and `tests/unit/` and runs `tests/unit/` only. The acceptance tests in `tests/M*/` are typechecked and run by `npm run verify`.
3. **`npm run verify`.** It writes `verify/out/tree.txt` (the `node scripts/tree-hash.mjs` value, taken before anything else runs), `verify/out/tests.json` (vitest's JSON reporter) and one `verify/out/<ID>.json` per criterion. From M1 on it also writes `verify/out/<id>/sheet.png`, `timing-strip.png` and `reference-strip.png` (§8.6), which the motion-critic reads.
4. **`npm run golden:accept -- <id>`.** It copies the approved sheets into `tests/golden/<id>/`.
5. **`scripts/scan-secrets.mjs`.** It loads `.env` and `.dev.vars` inside its own process, then scans every tracked file plus `git log -p --all` for the secret values. On a hit it prints only `file:line` and the variable name, never the value, and exits 1.
6. **`fixtures/required-clips.json`.** It ships with the kit and holds the table in §11. Tests read it, along with `verify/ACTIVE`, to know which clips to run. Only Qai edits it.
7. **`README.md`.** It contains the section "Built Oct 26 – Nov 4": SAM 3.1 and Muse Wonder; the open-source libraries from `package.json`; and the fact that the code was written with Claude Code under Qai's direction.
8. **The proxy skeleton**, in `functions/`.
9. **`scripts/live/probe.mjs`.**

### Until the API credits arrive

The credits hadn't arrived on Oct 27. Don't wait for them:
- **Build each milestone on its day, claim in order.** M0 and M1 are claimed as soon as they pass. From M2 on, build on schedule, using recorded or stand-in data where the key is missing, and claim each milestone once its SAM and Wonder fixtures are cached. The checkers only run at a claim, and they re-run earlier criteria, so claims go M2, M3, M4 in order even if the building ran ahead.
- **The day the key works:** run the probe (`npm run probe`), refresh the fixtures for the required clips (`npm run fixtures:refresh`), then claim the waiting milestones in order. Both commands cost money, so Qai says go first.
- **Never claim stand-in numbers.** The stand-in is for building and testing what comes after tracking. K1–K3, T1, W1 and every tracking claim in the README or video are measured on SAM 3.1 and Muse Wonder output.
- **Ask in the Discord** (where Meta runs office hours) if the credits are late. The plan assumed $150 of credits.

### Day by day

Times are ET. Qai's accounting exam is Thu Oct 29, so Wednesday night and Thursday's gap go to studying. If a day's "done when" slips, the next session starts by finishing it, not by opening the next row.

| Day | Qai's free time | Claude builds | Qai makes or does | Done when |
|---|---|---|---|---|
| Tue Oct 27 | Campus gap (iPad); 7 PM–2 AM | M0 | Noon live session. Read the submission form and note its fields. Five minutes in Edits checking whether Scribble takes his own drawing. Design the kagune in Procreate. `reference/timing.json` from one traced lash; lock the brush and the 3 colors. One hour of accounting. Night: film `fixtures/probe/clip.mp4`: a 10 s slow full turn on the tripod, brightest light, H.264, HDR off, 1080p30, shutter 1/250 s or faster | M0 verified (R1–R5) |
| Wed Oct 28 | 11 AM–4 PM; 11 PM–2 AM | M1 | Wednesday's live session. Rough side-step and walk takes, labeled on the `/label` page once M1 builds it. Night: accounting review | M1 verified; a tail and horns follow him on the side-step clip (on the stand-in until SAM) |
| Thu Oct 29 | Campus gap (iPad); evening | M2 | Gap: final accounting review. Evening: 30 test strokes in the app plus `fixtures/strokes/labels.json`. Label the probe clip (needed Fri). Rough indoor slow-turn and spin takes, labeled (needed Sat). Say go for the probe and the fixtures once the key works | M2 built; claimed with Gate 1 once the key works |
| Fri Oct 30 | 8:30 PM–2 AM | M3 | The side and back views of the hero effect in views mode, saved as `reference/views/hero.json`. Pick the Sunday slot: X3 or A5 | Strands sit behind him and swap sides on the turn |
| Sat Oct 31 | 10 AM–2:30 PM | M4 | Halloween teaser post if it renders (horns and a tail on him). Between Saturday and Monday: `fixtures/manual/X1.json`, `X2.json` and `G2.json` once he's checked export and the live link by hand | Gate 2 (G2): the full pipeline works on the live link |
| Sun Nov 1 | All day | M5; feature freeze at 11 PM | Before 3 PM (clocks fall back; sunset is about 4:50): hero footage and the 6 test clips in daylight, plus one friend's turn with written consent in `fixtures/clips.json`. Time hand-animating 1 second (12 drawings), then do it in Inkwell | Hero footage shot; wear this effect only if Gate 2 passed (5-hour cap); features frozen |
| Mon Nov 2 | 10 AM–3:30 PM | M6 | Render testers' clips (3+ people, written consent). Record the unedited live take with a clock on screen. Lock the script; collect quotes | Live take, script, README and quotes done |
| Tue Nov 3 | Campus gap (iPad); 7 PM–2 AM | Final fixes only | Gap: edit the demo video (5-hour cap). Night: cut the X clip, make the repo public, fill in the submission form | Everything submittable by 2 AM |
| Wed Nov 4 | Until 4 PM | — | Submit by noon, 3 PM at the latest; post the X clip right after | Submitted before his shift |

Pause other projects (Furr, the Suspect rebuild) until Nov 5. The live final is Mon Nov 9, a shift day: check its start time.

### Cut order

If work falls behind, cut in this order: wear this effect (X3), Wonder's turn labels (SAM's face track carries the turn), rigid presets, wobble polish, export polish. Never cut the tests or the demo video. No switching projects after the probe; from then on, only cuts.

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
  app/       UI: load clip, draw (pointer pressure; iPad Safari and desktop Chrome), views mode,
             plan panel with one-tap overrides, timeline, preview, /label page for ground truth
  video/     CFR conversion (Mediabunny -> H.264, constant 30 fps), frame index from timestamps
  sam/       SAM 3.1 client (through the proxy), prompt builders, mask decoding, cache by clip hash
  plan/      Muse Wonder: stroke plan (numbered strokes on the frame) and facing labels
  track/     anchors from masks (centroid, second-moment angle, sqrt-area scale), One Euro filter
  turn/      facing angle from the face track + Wonder labels + manual keys; view blending; layers
  physics/   one engine: Verlet chain + pull toward a target shape, fixed timestep, seeded
  motion/    stepped drawings on 2s/3s, line boil, action presets composed with view targets
  render/    perfect-freehand outlines; compositing around the person mask; contact sheets
  export/    WebCodecs MP4 in desktop Chrome, original audio
  types/     shared types, including effect.ts (the effect JSON in §7)
functions/   Cloudflare Pages Function: holds keys, proxies Meta API, passcode, daily spend cap
scripts/     verify pipeline, metrics, tree-hash.mjs, scan-secrets.mjs; scripts/live/ = paid calls
tests/       unit/ (fast), M1/ M2/ ... (acceptance, one file per criterion), golden/ (approved looks)
fixtures/    cached SAM and Wonder outputs per clip, truth.json, clips.json, required-clips.json, manual/
reference/   Qai's timing sheet and drawn views
verify/      generated and gitignored: out/, verdicts/, tmp/, ACTIVE, CLAIM
```

**Stack.** Vite and strict TypeScript with one canvas, on Cloudflare Pages with one Pages Function (the setup Qai shipped Suspect on). The OpenAI SDK pointed at `https://api.meta.ai/v1`. perfect-freehand for the brush: the physics moves its input points and the outline is redrawn every drawing, so the line stays his. The project (clip ID plus strokes) moves between iPad Safari (drawing) and desktop Chrome (export) as one JSON file.

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
interface Stroke {
  id: number;                                 // drawing order; the same id in every view
  color: 0 | 1 | 2;
  kind: 'strand' | 'rigid';                   // rigid = follows its target exactly (horns, halo)
  anchor: { type: 'concept'; prompt: string } | { type: 'point'; time: number; xy: [number, number] };
  bodyAngle: number;                          // degrees around the torso: 0 chest, 90 his right side, 180 center of back, 270 his left side
  stiffness: number;                          // strands only: 0 = rope ... 1 = stiff
  wobble: number;                             // boil scale 0..1
  views: { front: StrokeView; side?: StrokeView; back?: StrokeView; left?: StrokeView };
}
interface Effect {
  version: 1;
  brush: { size: number; thinning: number; smoothing: number; streamline: number };
  palette: [string, string, string];
  timing: { drawingsPerSecond: 12 | 8 };
  strokes: Stroke[];
  presets?: { name: string; at: number }[];   // seconds into the clip
  overrides: Record<string, unknown>;         // one-tap overrides, keyed by field path
}
```

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
| Deliberate poses, including how a thing looks from each side | Qai draws the views (front, side, back) and the key poses. Angles between views are blends of his drawings. The engine never invents a pose | Anime model sheets; 2.5D Cartoon Models; Live2D angle keyforms |
| Timing on 2s or 3s | The simulation runs smoothly, but the drawing changes only 12 (or 8) times a second and holds in between | Limited animation; Guilty Gear Xrd holds frames even though it's 3D |
| Overlap and follow-through | A rope simulation chases the drawn or keyed shape, so it lags, overshoots and settles | Wiggly Splines; Willett et al. 2017; Live2D physics |
| A living line | Qai's brush is regenerated on every drawing, with a small boil that repeats every few drawings | Hand-drawn line boil |

### 8.1 Spaces and the frame loop

**Torso space** is computed per video frame from the SAM `person` mask:
- origin: the mask centroid `c`
- axis: the principal axis angle `φ`, from second moments
- unit: the torso height `h = k·√area`, with `k` chosen once per clip so that `h` equals 0.35 × the median person-mask bounding-box height over the clip

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

**Fusion.**
1. Unwrap θ to a continuous angle.
2. Across the back half (no face), interpolate in the direction of travel. The direction comes from Wonder's labels, or from the sign of `o` as the face left.
3. Smooth with a One Euro filter, and clamp the turn speed.

**Drawn views.**
- Views sit at 0°, 90° and 180°, plus 270° if drawn; otherwise 270° is 90° mirrored (x → −x in torso space).
- **Blending.** For θ between neighboring views a and b, `w = (θ − θ_a)/(θ_b − θ_a)`. Points, pressure and root are lerped by `w`.
- **Layer.** The layer is a's while `w < 0.5` and b's after. It swaps in one drawing, the way layer order pops in hand-drawn turns.
- **Views mode.** The front stroke shows faintly. Qai redraws each stroke in the same order, resampled to the same point count. That's what makes the views correspond point to point.

**Single-view fallback (T5),** used only when just the front view exists:
- **Torso model.** An ellipse with half-width `w` and half-depth `d = 0.6·w`.
- **Body angle α.** Fixed per root: 0° chest, 90° his right side, 180° center of the back, 270° his left side.
- **Root position.** At facing θ, the root sits at screen offset `x = −w·sin(α − θ)` (screen right is +x) and depth `z = d·cos(α − θ)`. z > 0 is toward the camera, in front of the body. Check: facing the camera, his right side shows on screen left (x = −w). At θ = 90°, his right side faces the camera (x = 0, z = +d), and the center of his back is at screen left.
- **Stroke shape.** Points are foreshortened and mirrored about the root: x is scaled by `s·max(|cos θ|, 0.25)`, where `s = +1` while cos θ ≥ 0 and `−1` after. That's a one-drawing swap at 90° and 270°, like the layer swap. At θ = 180°, a tendril that pointed out from his right side now points toward screen right, where his right side is.
- **Layer.** Follows the sign of z at the root, so it flips at θ = α ± 90°.
- Contact sheets label these cells "fallback". It's an approximation.

### 8.6 Rendering and occlusion

**Compositing order,** per output frame:
1. The video frame.
2. Strokes whose current layer is `behind`.
3. The person cutout from the SAM mask, feathered 1 px.
4. Strokes whose current layer is `front`.

**Outlines** come from perfect-freehand, rebuilt every drawing from the held centerline and pressure, using the brush settings saved in the effect.

**Contact sheets** (`npm run verify`):
- **Cells:** one per drawing, not per video frame. Each shows the strokes over a gray person silhouette and is labeled with:
  - `k` and `f`
  - θ and the facing class
  - view weights
  - the active preset
  - "fallback" when used
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
| foreshortening floor | 0.25 |

## 9. Meta models, proxy and probe

Read the docs before writing a call.

**SAM 3.1** (`sam-3.1`), through the Responses API at `https://api.meta.ai/v1` with the OpenAI SDK. Docs: https://dev.meta.ai/docs/sam/segmenting.
- **Request setup.** Build prompts with `buildObjectPrompt`, decode masks with `@meta-sam/parser`, and request `one_bit` masks plus `include_confidence`.
- **Uploads.** Upload each clip once through the Files API and reuse the file id.
- **Formats.** MP4 or MOV in H.264, H.265 or MPEG-4. No WebM. Converting every clip to H.264 at a constant 30 fps first also stops a phone clip's shifting frame rate from knocking the masks out of sync with the frames.
- **Cost.** $0.20 per 1,000 frames, minimum 50 frames per request. Results vary slightly between runs, so cache them.
- **Runs per clip:**
  - concept `person` (occlusion, torso, body height)
  - concept `face` (turn sensor)
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

Each Wonder job must beat a dumb rule on the tests, or the video doesn't claim it. While Wonder is working, the app shows "reading your drawing"; both calls are cached.

**Proxy.** In the app, every call goes through the Pages Function. It holds the keys, requires a passcode for uploads, and enforces a daily spend cap. Scripts in `scripts/live/` may call the API directly, with the key from `.env`.

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

## 10. Acceptance criteria

Each criterion has one test file, `tests/<milestone>/<ID>.test.ts`, which also writes `verify/out/<ID>.json` as `{ id, measured, threshold, pass, notes }`.

**Definitions used below:**
- **Body height:** the height of that frame's person-mask bounding box.
- **Strand length:** the arc length of the stroke's front view.
- **Settled:** the tip moves less than 0.5 px per drawing.
- **Nearest-mask rule** (the W1 and W2 baseline): attach each stroke to the nearest mask, with default physics (default stiffness and layer).

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
| P3 | 10,000 steps of seeded random anchor motion | No NaN; tip speed < 20 torso heights/s; once the anchor stops, the strand is settled within 2 s |
| P4 | Kinds and extremes | A rigid stroke matches its target within 0.5 px at every step. A strand at stiffness 0 with gravity settles with its tip below its root |
| P5 | Determinism | Two runs give byte-identical point arrays and identical PNGs |

### A: anime motion

| ID | Criterion | Threshold |
|---|---|---|
| A1 | Stepped drawings over 3 s, with a seeded synthetic anchor moving the whole time. The held drawing is in torso space, before it's placed on the frame | Changes exactly `drawingsPerSecond` times per second, and is identical between changes. It's placed with each video frame's own torso transform, so it never slides off the body |
| A2 | Boil, measured on the boil offsets themselves | Consecutive offsets differ; they repeat every `boil.cycle` drawings (from `reference/timing.json`); max offset ≤ `boil.maxPx` |
| A3 | Follow-through. Synthetic move: the anchor travels 1 torso height in 0.25 s, then stops; strand stiffness 0.3 *(start)*. Overshoot = max tip travel past its final rest point ÷ strand length | Overshoot = reference `followThrough.overshoot` ± 0.1; settled within reference `settleDrawings` ± 1 drawing |
| A4 | Arcs. Whip = the A3 move, reversed after 0.25 s | The tip path's max distance from its start-to-end chord ≥ 0.15 × strand length *(start)* |
| A5 | Lash preset (if built) | Drawings per phase equal reference `lash.phases` exactly; the tip at each key is within 2% of strand length of `lash.keys` |
| A6 | Line fidelity: (a) outline from the stored resampled points vs outline from Qai's raw input points, same brush; (b) each stroke at rest at θ = 0 (gravity 0, wobble 0, stiffness 1 or rigid) vs outline (a) | (a) mean distance < 1 px at 1080 wide; if it fails, raise the stored point count, not the threshold. (b) < 0.5 px |
| A7 | No pops: tip travel between consecutive drawings | ≤ 0.35 × strand length *(start)*, except during a preset strike or a fallback mirror swap |

### T: the turn

| ID | Criterion | Threshold |
|---|---|---|
| T1 | Facing-class accuracy on the hand-labeled frames of the required turning clips. Report face-only, Wonder-only and fused side by side, scored on the same frames | ≥ 80% for the source in use. Fused must be ≥ face-only; otherwise use face-only, and the video doesn't claim Wonder reads the turn |
| T2 | At θ = 0, 90 and 180 (and 270 if drawn), the blended target vs the drawn view | max point error < 0.5 px |
| T3 | Blend continuity: target point movement per 1° of θ | < 2% of strand length |
| T4 | Layering on labeled frames | In `front` frames, "behind" stroke pixels over person-mask pixels ≤ 0.5% of stroke pixels. In `back` frames, strokes that the back view marks `front` render over the body |
| T5 | Single-view fallback | Roots move around the torso ellipse, and stroke x is foreshortened and mirrored (§8.5). The layer flips where the root's depth z changes sign (θ = α ± 90°). No stroke vanishes except where occluded |

### W: Wonder

| ID | Criterion | Threshold |
|---|---|---|
| W1 | Attachment accuracy on 30 labeled strokes (`fixtures/strokes/labels.json`) vs the nearest-mask rule; also report stiffness and layer accuracy | ≥ 21/30 and strictly better than the rule |
| W2 | Every response either validates against the schema or falls back cleanly: invalid → one retry → nearest-mask rule with a visible note | 100%, no crash |
| W3 | Every plan field has a one-tap override that persists in the effect JSON | all fields |

### X: product

| ID | Criterion | Threshold |
|---|---|---|
| X1 | A 10 s clip exports in desktop Chrome to H.264 MP4 with the original audio | < 60 s (measured by a browser test). Manual part: Qai confirms it plays in QuickTime and uploads to Instagram |
| X2 | Live link | A server test shows the daily spend cap blocks calls past the limit, and uploads need the passcode. Manual part: Qai confirms the 3 cached samples work on the live link |
| X3 | Wear this effect (if built): a saved effect on a new person's clip, no redraw | K1 and T1 hold on that clip |

### Gates, locked look, probe

| ID | Criterion |
|---|---|
| G1 | One clip runs end to end in the app from cached data: clip → plan → SAM → physics → stepped preview |
| G2 | Manual: on the deployed link, the full pipeline runs on a cached sample and export gives a playable MP4 |
| L1 | Every approved golden in `tests/golden/` re-renders within 0.5% pixel difference, unless Qai re-approves it |
| PROBE | `fixtures/probe/report.md` and `strip.png` exist and contain everything listed in the Probe part of §9 |

**Manual evidence.** The manual parts of X1 and X2, and all of G2, are evidenced by `fixtures/manual/<ID>.json`:

```json
{ "id": "X1", "by": "Qai", "date": "2026-11-01", "result": "pass", "notes": "plays in QuickTime, uploaded to IG" }
```

Qai commits it himself with `[qai-approved]`. The judge accepts it for those parts only. X1's export time and X2's server test still need `verify/out/<ID>.json`.

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
- **Six clips,** easiest first: side-step, walk toward the camera, arm swing, hand passing in front, slow turn, spin. Their folder ids are `side-step`, `walk`, `arm-swing`, `hand-in-front`, `slow-turn` and `spin`, and each has a `fixtures/<clip>/` folder with a `truth.json`. Rough indoor takes are fine until M6; the daylight versions are shot on Sunday.
- **A friend's turn,** filmed Sunday, with consent recorded in `fixtures/clips.json`.
- **Synthetic anchor paths** for A1, A3 and A4, generated by the tests (seeded).

**Clips required at each milestone** (this table also lives in `fixtures/required-clips.json`). A criterion run on fewer clips fails.

| Milestone | Clips with truth.json |
|---|---|
| M1, M2 | side-step, walk |
| M3 | side-step, walk, probe |
| M4, M5 | side-step, walk, probe, slow-turn, spin (T1 on probe, slow-turn, spin) |
| M6 | the 6 daylight clips, probe, friend-turn (T1 on probe, slow-turn, spin, friend-turn) |

## 12. Already built

A working prototype was built on Oct 27, before the kit arrived. It predates the module layout in §6 and has no vitest tests yet: M0 and M1 move its pieces into `src/video`, `src/track`, `src/render`, `src/export` and `src/app`, and add the tests. What it does, and what it taught:

- **Conversion** (`src/clip.ts`). H.264 at a constant 30 fps, first 15 s, long side capped at 1920 px. Frame i is whatever the source shows at the middle of its slot, `(i + 0.5)/30` s. Don't use Mediabunny's `frameRate` option: it floors `t·30` without a tolerance, and floating point puts some exact frame times just below a slot (8.2 × 30 = 245.99999…), which drops a frame and doubles the next about 4 times per 15 s at 30 fps. Unrotated clips go straight from the decoder to the WebCodecs encoder, which shrinks them itself (about 20 ms a 4K frame, 5–6× faster than drawing onto a canvas without a GPU); clips with a rotation flag go through a canvas, which bakes the rotation in.
- **Brush, boil and export** (`src/brush.ts`, `src/export.ts`). perfect-freehand with tapers, a seeded boil at 12 drawings per second, and MP4 export with the original audio. The export doesn't re-time frames, because its input is already constant 30 fps.
- **Tracking and layering** (`src/tracking.ts`, `src/render.ts`). Anchors from mask moments (centroid, axis, √area), zero-phase One Euro smoothing (forward and backward, with mirrored ends), gap filling, and strokes rebased on the frame they were drawn on. Behind strokes go under a person cutout. Strokes are placed rigidly for now; the physics in §8.3 replaces that.
- **Stand-in tracker** (dev only; `src/standin.ts`, `tools/`). MediaPipe's pose model stands in for SAM until the key works: in the browser when the page has WebGL 2, otherwise on the dev server in Python (`npm run standin:setup` once). It's left out of production builds, and nothing it measures is claimed anywhere (§3).
- **Phone mode** (`npm run dev:phone`). Safari only allows WebCodecs on HTTPS pages, so this serves the app over HTTPS on the local Wi-Fi at port 5175, with a self-signed certificate the phone accepts once. The layout fits a phone screen.

## 13. Judging, prizes and the demo

### Judging

Impact carries the most weight, and the final round is judges watching the top 5 videos per track live, so the video has to prove all four scores on its own.

- **Stage 1, pass/fail:** the project fits a theme and really uses Meta's models. Say "Build for Your World" and name SAM 3.1 and Muse Wonder in the README's first lines and the video's first 30 seconds.
- **Stage 2:** the four scores below, 0 to 10 each.
- **Stage 3:** the top 5 per track; final judges watch the demo videos live and rank them on the same rubric.

| Score | Weight | How Inkwell earns it |
|---|---|---|
| Impact | 30% | A doodle animator spends 24–30 hours on one video by hand ([Adobe](https://makeitcenter.adobe.com/blog/doodle-tiktok.html)). Time hand-animating 1 second (12 drawings), then do it in Inkwell. Show 3+ people in their own clips with written consent, ideally wearing the same drawing. Pitch the draw-your-own layer: [Edits](https://about.fb.com/news/2025/04/introducing-edits-streamlined-video-creation-app/) applies preset effects like Scribble to a person, and Meta's apps have had no custom-effects tool since [Spark AR shut down](https://www.tubefilter.com/2024/08/27/meta-shutting-down-spark-ar-augmented-reality-platform/) in Jan 2025. Call them tendrils for judges, kagune on X |
| Use of Meta AI tooling | 25% | Wonder plans each stroke and labels which way he faces. SAM 3.1 runs those prompts, plus `person` for occlusion and `face` as a turn sensor. The video shows each Wonder job beating a dumb rule, side by side |
| Technical depth | 20% | His own physics (one engine, rope to rigid), smoothing, layering and the turn, proven by the scoreboards; a README that shows which parts are his |
| Demo | 25% | The hero turn in the first 5 seconds, shot in daylight; one unedited take with a visible clock; the turn with and without the turn signal; a deployed link with cached sample clips so judges can draw without uploading |

### Prizes

| Prize | Amount | What Inkwell needs |
|---|---|---|
| Indie track | Share of $1M | Creative, ambitious, and visibly working in the demo |
| Most Viral | $20K | A short X post of the demo; engagement counts through Nov 8 |
| Community Vote | $10K | Votes in the public gallery; winner announced Nov 16 |
| Best Creative Build | $5K | Muse Wonder plans each effect and reads the turn |

Skipped: Best Agentic Use-Case (Inkwell isn't an agent) and Best Open Weight Build (Glimmer is 30B and won't fit the 8 GB GPU). Best Creative Build is the realistic prize; chasing every bonus is scope creep.

**Odds and how the pick was made.** On a guessed field size: top 5 about 3–8%, winning Indie about 1%, Best Creative Build about 10%. A five-member LLM council (all Claude, all having read the plan first) unanimously kept Inkwell, so treat "keep Inkwell" as a lead, not proof: the probe and the scoreboards are the real tests.

### Demo video, 3 minutes, one beat per score

1. 0:00 to 0:05 (Demo): the hero turn, the effect whipping around him as he turns.
2. 0:05 to 0:30 (Impact): who it's for: a doodle animator's 24–30 hours per video, his timed second by hand vs Inkwell, and Edits' preset effects vs drawing your own. Name SAM 3.1 and Muse Wonder here, for Stage 1.
3. 0:30 to 1:30 (Meta tooling, technical depth): one unedited take with a clock on screen: draw on the iPad, Wonder's plan appears, SAM's masks stream in, the physics takes over, export.
4. 1:30 to 2:00 (Technical depth): the turn with and without the turn signal, side by side; without it, the strands stay on the wrong side when his back turns.
5. 2:00 to 2:30 (Impact): one drawing worn by 3+ people, or testers' clips if wear this effect didn't make it.
6. 2:30 to 3:00 (Technical depth, Impact): the scoreboards, including Wonder vs the dumb rule, then the closing line: "Draw it once. Anyone can wear it."

Cut it 16:9 for judges and vertical for X, with licensed or royalty-free audio only.

### Posting

One set of footage feeds the judge video, the X clip and the gallery entry.
- **X clip:** 15 to 30 seconds, vertical, the draw-then-whip moment in the first 2 seconds. Post right after submitting on Nov 4 and tag @AIatMeta and @cerebral_valley. Upload it natively with the link in a reply. The ask is "send me a clip and I'll put the kagune on you": answer with renders through Nov 8, under the spend cap. DM it first to about 15 doodle, anime-edit and cosplay creators.
- **Build in public,** on TikTok and X: Wed Oct 28, the rope whipping behind the mouse; Sat Oct 31 (Halloween), horns and a tail tracked to him, "drew my costume onto myself", asking friends for clips (save the kagune for Nov 4); Mon Nov 2, the scoreboards, pass and fail.
- **Community Vote:** from Nov 4, send the gallery link to friends; one vote per verified account.

## 14. Risks and fallbacks

Shaky tracking is the biggest risk, because every wobble in the mask shows up in the strands. The biggest judging risk is Wonder's job looking like a dropdown.

| Risk | Fallback |
|---|---|
| The API credits are late | Build API-free work first and apply the swap rule (§3); ask in the Discord |
| SAM's masks shift slightly between frames and runs, so the strands jitter | One Euro smoothing; hold the last good position when SAM's confidence drops; shoot in daylight at 1/250 s or faster |
| The back point or the face track fails in the probe | Change the hero move, not the project: a manual key for the behind/in-front swap, or anchor to the person mask and shoot the hero at three-quarter view (§9) |
| Clips arrive as WebM or with a shifting frame rate | Convert every clip in the browser to H.264 at a constant 30 fps before upload |
| Wonder doesn't beat the dumb rule | Use the rule where it wins and say so in the README; the tooling story leans on SAM's three jobs and whatever Wonder still wins |
| Edits' Scribble already takes his own drawing | The pitch narrows to the physics, the turn and wear this effect |
| Judges read it as a toy | Lead Impact with the 24–30 hour number, the timed second, and 3+ outside people in their own clips |
| Wonder is slow to answer | One plan call per drawing and one facing call per clip, both cached, with "reading your drawing" on screen |
| MP4 export fails in iPad Safari | Export from desktop Chrome; for the demo, screen-record the canvas |
| The $150 of credits runs low, or the X post brings a traffic spike | Upload each clip once and reuse its file id (SAM bills per frame, minimum 50 frames per request); cached samples, a passcode and a daily spend cap before posting |
| Nothing tracks steadily in the probe | Stop and decide before building anything else (§9) |

## 15. Not in v1

- **Effects:** impact frames, speed lines, smears, capes and cloth.
- **Props:** swords and other hand-held props (SAM doesn't guarantee hand masks).
- **Scenes:** multiple people, a moving camera.
- **Export:** iPad export.
- **Models:** SAM 3D Body, Glimmer, Muse Image drafting of missing views (a v2 idea for people who draw only once).
- **Agents:** an agentic self-critique pass.
- **Also parked:** air slash, spin speed lines and hammer-slam impact frames (the "moments" layer), imported brushes, Stand-style fights, voice-to-doodle.

**Where this goes (the 10–100x version).** Spark AR's successor, drawn with a pencil: an artist draws an effect once and anyone can wear it.
- **What it does:** effects that know the body in 3D (turns, occlusion, touching the floor), act like their material (cloth, fire, strands), and fire on moments (a punch sets off an impact frame, a beat drop a flare). First on people's own clips in Edits, later live in the Instagram camera and on Meta's glasses.
- **Who it serves:** Reels creators who can't draw but can tap "use", doodle animators and anime editors, music-video and ad makers, and the effect artists Spark AR left behind, paid per use the way Snap and TikTok pay the makers of their most-used effects.
- **Models:** SAM 3.1 tracks many body parts at once; SAM 3D Body adds pose and depth; Wonder rigs each effect, times it to the motion and the music, and critiques its own render; Muse Image makes style-matched variants; Glimmer runs on-device for the live camera.

**The Nov 4 slice is wear this effect (X3):** save an effect relative to the body (anchor, position against the torso, physics, layer), then apply it to a new person's clip in one tap. A 10-second remix costs about $0.12 in SAM calls (person and face) plus one Wonder call to read the wearer's turns. It's the right slice for two reasons: judges score the slice, so it should be the best trailer for the big version; and wearers won't mark their own turns, which makes automatic turn reading necessary rather than decorative. The video ends on one line, not a mockup: "Draw it once. Anyone can wear it."

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
- Pitch facts: [Meta: the Edits update of Dec 17, 2025, on SAM 3 effects](https://about.fb.com/news/2025/04/introducing-edits-streamlined-video-creation-app/); [Tubefilter: Meta shuts down Spark AR on Jan 14, 2025](https://www.tubefilter.com/2024/08/27/meta-shutting-down-spark-ar-augmented-reality-platform/); [Adobe: doodle TikToks and Maddi Winter's 24–30 hour videos](https://makeitcenter.adobe.com/blog/doodle-tiktok.html).
- Event and models: [Meta Global AI Developer Hackathon](https://dev.meta.ai/events/global-hackathon); [Cerebral Valley event page](https://cerebralvalley.ai/e/meta-ai-developer-hackathon); [SAM: segmenting with prompts](https://dev.meta.ai/docs/sam/segmenting); [SAM overview](https://dev.meta.ai/docs/sam/overview); [SAM 3.1 model page](https://dev.meta.ai/models/sam-3-1); [Muse Wonder model page](https://dev.meta.ai/models/muse-wonder).
