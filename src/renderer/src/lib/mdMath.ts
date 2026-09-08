// TeX math support for the CodeMirror markdown grammar.
//
// Without this, the markdown parser treats the `*` in `$Q^{*}$` as an emphasis
// delimiter, so a later `*` anywhere in the paragraph closes it and everything
// in between turns italic. Registering an inline parser *before* `Emphasis`
// makes `$…$` (and `$$…$$`) a single opaque node, so its contents never reach
// the emphasis/strong/strikethrough machinery.
//
// Delimiter rules follow Pandoc's `tex_math_dollars`: the opening `$` must not
// be followed by whitespace, and the closing `$` must not be preceded by
// whitespace nor followed by a digit — which keeps prose like "$5 and $10"
// from being mistaken for math.
import type { InlineContext, MarkdownConfig } from "@lezer/markdown";
import { Tag, tags as t } from "@lezer/highlight";

/** Highlight tag for math contents; style it in the editor's HighlightStyle. */
export const mathTag = Tag.define();

const DOLLAR = 36;
const BACKSLASH = 92;

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === -1;
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

/** True when the character at `pos` is escaped by an odd number of backslashes. */
function escaped(cx: InlineContext, pos: number): boolean {
  let n = 0;
  while (cx.char(pos - 1 - n) === BACKSLASH) n++;
  return n % 2 === 1;
}

function mathElt(
  cx: InlineContext,
  from: number,
  to: number,
  markLen: number,
): number {
  return cx.addElement(
    cx.elt("InlineMath", from, to, [
      cx.elt("MathMark", from, from + markLen),
      cx.elt("MathMark", to - markLen, to),
    ]),
  );
}

export const Math: MarkdownConfig = {
  defineNodes: [
    { name: "InlineMath", style: mathTag },
    { name: "MathMark", style: t.processingInstruction },
  ],
  parseInline: [
    {
      name: "InlineMath",
      before: "Emphasis",
      parse(cx, next, pos) {
        if (next !== DOLLAR || escaped(cx, pos)) return -1;

        // `$$…$$` — display math, no whitespace rules.
        if (cx.char(pos + 1) === DOLLAR) {
          for (let i = pos + 2; i < cx.end - 1; i++) {
            if (
              cx.char(i) === DOLLAR &&
              cx.char(i + 1) === DOLLAR &&
              !escaped(cx, i)
            )
              return mathElt(cx, pos, i + 2, 2);
          }
          return -1;
        }

        // `$…$` — inline math.
        if (isSpace(cx.char(pos + 1))) return -1;
        for (let i = pos + 1; i < cx.end; i++) {
          if (cx.char(i) !== DOLLAR || escaped(cx, i)) continue;
          if (isSpace(cx.char(i - 1)) || isDigit(cx.char(i + 1))) continue;
          return mathElt(cx, pos, i + 1, 1);
        }
        return -1;
      },
    },
  ],
};
