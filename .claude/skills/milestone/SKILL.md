---
name: milestone
description: Run one Inkwell milestone end to end. Tests come first, then the build, then independent checkers, and the milestone is claimed only when every check passes. Qai starts it by typing /milestone M<n> followed by any notes.
argument-hint: "M<n> [notes]"
disable-model-invocation: true
---

Milestone: $0
Qai's notes for this run: $ARGUMENTS

1. **Set up.**
   - Write `$0` to `verify/ACTIVE`.
   - If the git tag `milestone-$0-start` doesn't exist, create it with `git tag milestone-$0-start`. If it does exist, keep it.
2. **Brief Qai** in 8 lines or fewer:
   - what you'll build (from the milestone's row in `docs/SPEC.md`)
   - the criterion IDs
   - which reference files or fixtures you need from him

   If a reference file or fixture is missing, ask for it now rather than inventing a stand-in. Ask only questions that are his to answer: taste, thresholds, clips.
3. **Tests first.**
   - At M0 only, first build M0 checklist item 1 (package.json, strict TypeScript, vitest) and commit it.
   - Spawn the `test-author` subagent with the milestone id and its criterion IDs.
   - When the tests fail for the right reason, commit them on their own (`test($0): acceptance tests`) and tag that commit `milestone-$0-tests`.
4. **Build in small steps.** Follow the module boundaries in `docs/SPEC.md` (§6). The PostToolUse hook runs `npm run check:fast` after every code edit; fix what it reports before the next step. For each module:
   - Add unit tests in `tests/unit/`.
   - Explain the idea in 2–3 lines in the commit message.
5. **Verify.**
   - Run `npm run verify`, then `/verify`.
   - Make no edits while the checkers run.
   - Fix the must_fix items, then repeat.
   - After 5 rounds without all PASS, stop and report to Qai: what fails, the evidence files, and your best hypothesis.
6. **Claim.** When every verdict is PASS:
   - Write `$0` to `verify/CLAIM` with the Write tool. That's your last tool call.
   - End your turn with the handoff in step 7.
   - The Stop hook re-checks the verdicts. If it sends you back, do what it says.
7. **Hand off to Qai:**
   - the verdict table
   - the paths `verify/out/$0/sheet.png` and `verify/out/$0/reference-strip.png`
   - one line on what to look at

   When he says "approved":
   - Run `npm run golden:accept -- $0`.
   - Ask him to commit the goldens himself: `git add tests/golden`, then `git commit -m "$0 goldens [qai-approved]"`.
   - Delete `verify/ACTIVE`.
