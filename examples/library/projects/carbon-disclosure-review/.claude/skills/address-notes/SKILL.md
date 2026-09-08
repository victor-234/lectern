---
name: address-notes
description: Address the outstanding notes in MANUSCRIPT_NOTES.md by editing manuscript.qmd accordingly
---

You are addressing the notes the user left in `MANUSCRIPT_NOTES.md` and applying
them to `manuscript.qmd`.

## Steps

1. Read `.claude/CLAUDE.md` for the house style and `LEARNED_EDITS.md` for the
   author's learned rules — follow both for any text change.
2. Read `MANUSCRIPT_NOTES.md`. Each note block carries an HTML comment with an
   `id=` and a `line=`/`endLine=`, the quoted snippet it refers to (`>` lines),
   and an instruction.
3. Treat any note that is **not** already marked done (no `✅ DONE` line) as
   outstanding. Skip notes already marked done.
4. For each outstanding note, in order:
   - Locate the target text in `manuscript.qmd`. The `line=` number is a snapshot
     and may have drifted — **use the quoted snippet as the anchor**, not the line
     number. If the snippet can't be found, do not guess: flag it and move on.
   - Apply the instruction in place. Match the surrounding prose: existing voice,
     terminology, citation style (keep the `[@key]` citations intact), and the
     house-style rules above.
   - Do not fabricate citations or empirical claims. If a note asks for something
     that would require a source that isn't present, flag it instead.
5. After applying a note's edit, mark it done in `MANUSCRIPT_NOTES.md`: insert a
   line `✅ DONE — <one-line summary of what you changed>` directly under the
   note's HTML comment. Keep the rest of the note block intact.
6. Apply all outstanding notes in one pass, then report:
   - One line per note: the `id`, what you changed, and the location in
     `manuscript.qmd`.
   - A separate list of any notes you could not address (snippet not found, missing
     citation, ambiguous) with the reason.

## Notes

- Edit `manuscript.qmd` only for the manuscript content; edit `MANUSCRIPT_NOTES.md`
  only to add the `✅ DONE` markers.
- Never delete a note. Never touch the generated `manuscript.tex`, `.log`, or
  `.pdf` files.
