---
name: run-checkers
description: Independent verification for Inkwell. Runs the checker subagents in parallel on fresh verify output and prints one verdict table. Use before claiming any milestone done, and whenever Qai types /run-checkers.
---

1. **Run `npm run verify`.** It stamps `verify/out/tree.txt`. If the pipeline itself breaks, as opposed to criteria failing, fix the pipeline and run it again.
2. **Pick the checkers** for the milestone in `verify/ACTIVE`:
   - M0: acceptance-judge, rules-auditor
   - M1: acceptance-judge, motion-critic, rules-auditor (M1 has no K, T or W criteria)
   - M2: acceptance-judge, tracking-auditor, rules-auditor
   - Every other milestone: acceptance-judge, motion-critic, tracking-auditor, rules-auditor. These also re-run the earlier K, P, A and T criteria on this milestone's clip set.
3. **Spawn all chosen checkers in one message**, so they run in parallel. Give each only the milestone id; they find and read the evidence themselves. Make no edits of any kind until every checker has returned. An edit changes the tree hash and makes their verdicts stale.
4. **Print the results:**
   - a table: checker, verdict, must_fix count
   - every must_fix item, deduplicated, ordered by how many criteria it blocks
5. **Never touch the verdicts.** Don't edit `verify/verdicts/*`; the guard hook blocks it anyway. Don't re-run a checker to get a different answer. Fix the code, then run `npm run verify` and `/run-checkers` again.
