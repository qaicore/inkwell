# Inkwell

You draw on one frame of a phone clip, and the drawing lives in the footage. It stays locked to the person, moves like hand-drawn anime, and shows the right view of itself when they turn. A solo build by Qai for the Meta Global AI Developer Hackathon (Indie track), due Wed Nov 4 at 9:00 PM ET; the target is to submit by noon.

**Everything is in `docs/SPEC.md`: read it before any work.** §1–§3 first (what it is, the rules, the order of work), then the sections the milestone needs. It's the contract; if anything disagrees with it, it wins.

Always in force (full text in SPEC §2):
1. **New work only.** Copy nothing written before Oct 26, 2026.
2. **No anime material** anywhere in the repo, the app or the video.
3. **Secrets stay out of git.** Keys only in `.env` and `.dev.vars`; never print, log or commit one.
4. **Paid API calls** only through `functions/` (with its spend cap) and `scripts/live/` (spend cap plus a confirmation prompt). Tests, hooks and `/run-checkers` never touch the network. Run `npm run probe` and `npm run fixtures:refresh` only when Qai says go.
5. **Qai owns the checks.** Don't edit thresholds in `docs/SPEC.md`, `reference/`, `fixtures/*/truth.json`, `fixtures/manual/`, `fixtures/required-clips.json`, `fixtures/strokes/labels.json`, `fixtures/clips.json`, `tests/golden/` or the checking setup in `.claude/`. Never loosen a test to make it pass. Only Qai writes `[qai-approved]`. If a threshold looks wrong, stop and ask him.
6. **Attribution** in the README section "Built Oct 26 – Nov 4", kept current with `package.json`.
7. **Consent.** Only clips listed in `fixtures/clips.json` go in fixtures, the repo, the demo or posts; stock clips are fine for local tests in the gitignored `samples/`.

Qai decides taste (timing, poses, line, colors, thresholds): ask him one question and show the contact sheet. Make engineering calls yourself, keep them simple, and explain each in 2–3 lines in the commit message, naming the technique. Qai is learning from this repo.

Commands are PowerShell-safe, one per line. The milestone loop, setup and commands are in SPEC §4–§5.
