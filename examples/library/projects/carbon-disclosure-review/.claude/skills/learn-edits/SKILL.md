---
name: learn-edits
description: Learn durable writing rules from the author's manual corrections to the manuscript
---

You are given a unified diff of the author's **manual corrections** to
`manuscript.qmd` (the path is named in the prompt; the body only, no front
matter). Your job is to learn from it — NOT to re-edit the manuscript.

Steps:

1. Read the named diff file. `-` lines are what the author removed; `+` lines
   are what they wrote instead. `@@ …` marks elided unchanged context.
2. Group the corrections by theme — e.g. wording/word-choice, tone & voice,
   structure, citations, terminology, punctuation/formatting.
3. Infer **durable, generalisable rules** the author is implicitly teaching you
   (e.g. "prefer active voice", "cut hedging like 'arguably'", "use 'firms' not
   'companies'"). Ignore one-off content edits that don't generalise.
4. Merge the rules into `LEARNED_EDITS.md`, organised by theme. **Refine or
   replace** existing rules rather than blindly appending — deduplicate, and
   sharpen a rule if a new correction makes it more precise. Keep each rule a
   short imperative bullet with a brief example where it helps.
5. Briefly summarise to the user what you learned and changed.

Do not modify `manuscript.qmd`. Only update `LEARNED_EDITS.md`.
