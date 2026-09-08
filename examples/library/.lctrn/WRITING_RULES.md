<!--
Rules for any AI writing that goes into a paper. Shared by EVERY lctrn project.

These are injected verbatim into each AI writing request, so keep them short and
concrete. Comment blocks like this one and headings are stripped before sending.

Precedence, weakest to strongest:
  1. this file                     — your durable voice, everywhere
  2. <project>/WRITING_STYLE.md    — this paper, this venue
  3. <project>/LEARNED_EDITS.md    — learned from your own corrections
-->

# Writing rules

## Voice
- Write plain, direct academic prose. Say the thing.
- Prefer the active voice and a named actor ("we estimate", not "it is estimated").
- Vary sentence length. Do not open consecutive sentences the same way.
- No throat-clearing openers: "It is important to note that", "In today's world".

## Cut
- Cut hedges unless the uncertainty is real and quantified: "somewhat", "quite",
  "arguably", "it seems", "may potentially".
- Cut intensifiers: "very", "extremely", "highly", "significantly" (unless
  statistical significance is meant, and then give the number).
- Cut filler transitions: "Moreover", "Furthermore", "Additionally". Start the
  sentence with its own content.
- One idea per sentence. Split anything that needs a semicolon to survive.

## Claims and citations
- Every empirical claim cites a key from the bibliography as [@citekey].
- Never invent a citation, a number, a quotation, or a result. If a claim needs
  a source you cannot find, flag it inline as [CITE?] and move on.
- Do not soften a claim the evidence supports, and do not strengthen one it
  does not.

## Terminology
- Keep the manuscript's existing terms. Do not silently introduce a synonym for
  a term already defined.
- Expand an acronym on first use, then use it consistently.

## Mechanics
- One sentence per line. Every sentence starts on a new line in the source; never
  wrap or join sentences onto a shared line. Blank lines still separate paragraphs,
  and the rendered output is unchanged — this is for clean diffs and line-level review.
- Match the surrounding document: Quarto markdown, existing heading levels,
  `[@citekey]` citations, @fig-/@tbl- cross-references.
- Preserve the author's LaTeX, code chunks, and cross-reference labels verbatim.
- Do not change the structure of a section you were asked to rewrite in place.

## Scope
- Rewrite what was selected. Do not extend the argument, add a new claim, or
  append a concluding sentence that was not there.
- Return only the rewritten prose — no preamble, no explanation, no fences.
