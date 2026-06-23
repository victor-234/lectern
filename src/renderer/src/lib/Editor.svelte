<script lang="ts">
  // CodeMirror 6 markdown editor, themed with the design tokens.
  import {
    EditorView,
    keymap,
    placeholder as cmPlaceholder,
    Decoration,
    MatchDecorator,
    ViewPlugin,
    WidgetType,
    type DecorationSet,
    type ViewUpdate
  } from '@codemirror/view'
  import { EditorState, StateEffect, StateField } from '@codemirror/state'
  import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
  import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
  import { syntaxHighlighting, HighlightStyle } from '@codemirror/language'
  import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
  import {
    autocompletion,
    completionKeymap,
    type Completion,
    type CompletionContext,
    type CompletionResult
  } from '@codemirror/autocomplete'
  import { tags as t } from '@lezer/highlight'
  import type { ResolvedPaper, CellOutput } from '../global'

  let {
    value,
    onchange,
    onsave,
    onContextNote,
    papers = [],
    cellOutputs = [],
    placeholder = ''
  }: {
    value: string
    onchange: (v: string) => void
    onsave: () => void
    /** Right-click on a non-empty selection — used to open the "add note" popover. */
    onContextNote?: (sel: {
      text: string
      line: number
      endLine: number
      x: number
      y: number
    }) => void
    /** Attached papers offered as `@`-citation completions. */
    papers?: ResolvedPaper[]
    /** Rendered output of each executable code chunk, shown inline below it. */
    cellOutputs?: CellOutput[]
    placeholder?: string
  } = $props()

  // Live handle on the papers list so the completion source sees the latest set
  // without remounting the editor (which would lose cursor/undo state).
  const papersRef: { list: ResolvedPaper[] } = { list: [] }
  $effect(() => {
    papersRef.list = papers
  })

  // Surnames of up to the first three authors, then "et al." if there are more.
  function citeAuthors(authors: string[]): string {
    if (authors.length === 0) return ''
    const names = authors.slice(0, 3).map((a) => a.split(',')[0].trim())
    return authors.length > names.length ? `${names.join(', ')} et al.` : names.join(', ')
  }

  /** Completion source: typing `@` opens a paper picker filtered by citekey,
   *  title, or author. Selecting one inserts `@citekey`. */
  function citeCompletions(context: CompletionContext): CompletionResult | null {
    const token = context.matchBefore(/@[\w:.\-]*/)
    if (!token) return null
    // Only fire when `@` starts a word (avoid email addresses etc.).
    const prev = token.from > 0 ? context.state.sliceDoc(token.from - 1, token.from) : ''
    if (/\w/.test(prev)) return null
    if (token.from === token.to) return null

    const q = token.text.slice(1).toLowerCase()
    const matched = papersRef.list.filter((p) => {
      if (!q) return true
      return (
        p.citekey.toLowerCase().includes(q) ||
        (p.title ?? '').toLowerCase().includes(q) ||
        p.authors.some((a) => a.toLowerCase().includes(q))
      )
    })

    const options: Completion[] = matched.slice(0, 50).map((p) => ({
      label: `@${p.citekey}`,
      displayLabel: p.citekey,
      detail: [citeAuthors(p.authors), p.year, p.journalAbbrev].filter(Boolean).join(' · '),
      info: p.title || undefined,
      apply: `@${p.citekey}`,
      type: 'text'
    }))

    return { from: token.from, options, filter: false }
  }

  // --- `@citekey` syntax highlighting ---
  // The markdown grammar doesn't know about Pandoc citations, so we decorate them
  // ourselves: match `@key` (also inside `[@key; @key2]`), skipping email-style
  // `foo@bar` by requiring the `@` not follow a word character. Only the `@key`
  // token is coloured; surrounding brackets stay plain markdown.
  const citeMark = Decoration.mark({ class: 'cm-cite' })
  const citeMatcher = new MatchDecorator({
    regexp: /(^|[^\w@])(@[\p{L}\d][\w:.#$%&+?<>~/-]*)/gu,
    decorate: (add, from, _to, match) => {
      const start = from + match[1].length
      add(start, start + match[2].length, citeMark)
    }
  })
  const citeHighlighter = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = citeMatcher.createDeco(view)
      }
      update(u: ViewUpdate): void {
        this.decorations = citeMatcher.updateDeco(u, this.decorations)
      }
    },
    { decorations: (v) => v.decorations }
  )

  // --- Inline code-cell output preview ---
  // A block widget rendered just below each executable fence, showing the chunk's
  // rendered output (table/figure/text) as produced by a background `quarto render`.
  // Outputs are keyed by the chunk's ordinal position among executable fences —
  // the same numbering the main process uses when it injects render anchors.
  class CellWidget extends WidgetType {
    html: string
    index: number
    constructor(html: string, index: number) {
      super()
      this.html = html
      this.index = index
    }
    eq(other: CellWidget): boolean {
      return other.index === this.index && other.html === this.html
    }
    toDOM(): HTMLElement {
      const wrap = document.createElement('div')
      wrap.className = 'lctrn-cell-output'
      wrap.setAttribute('contenteditable', 'false')
      wrap.innerHTML = this.html
      return wrap
    }
    ignoreEvent(): boolean {
      return true
    }
  }

  // Walk the doc's lines, count executable fences in order, and drop a block
  // widget at the end of each closing fence line whose ordinal has an output.
  function buildCellDeco(state: EditorState, outs: CellOutput[]): DecorationSet {
    if (!outs.length) return Decoration.none
    const byIndex = new Map(outs.map((o) => [o.index, o.html]))
    const doc = state.doc
    const widgets: ReturnType<typeof Decoration.widget>[] = []
    let inFence = false
    let fenceChar = ''
    let fenceLen = 0
    let n = 0
    let curIndex = -1 // ordinal of the currently-open executable fence, or -1
    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i)
      if (!inFence) {
        const open = line.text.match(/^(\s*)(`{3,}|~{3,})(.*)$/)
        if (open) {
          inFence = true
          fenceChar = open[2][0]
          fenceLen = open[2].length
          curIndex = /^\{[^}]*\}/.test(open[3].trim()) ? n++ : -1
        }
      } else {
        const close = line.text.match(/^(\s*)(`{3,}|~{3,})\s*$/)
        if (close && close[2][0] === fenceChar && close[2].length >= fenceLen) {
          inFence = false
          if (curIndex >= 0) {
            const html = byIndex.get(curIndex)
            if (html != null) {
              widgets.push(
                Decoration.widget({ widget: new CellWidget(html, curIndex), block: true, side: 1 }).range(
                  line.to
                )
              )
            }
          }
          curIndex = -1
        }
      }
    }
    return Decoration.set(widgets, true)
  }

  const setCellOutputs = StateEffect.define<CellOutput[]>()
  const cellOutputField = StateField.define<{ outs: CellOutput[]; deco: DecorationSet }>({
    create() {
      return { outs: [], deco: Decoration.none }
    },
    update(value, tr) {
      let outs = value.outs
      let changed = false
      for (const e of tr.effects) {
        if (e.is(setCellOutputs)) {
          outs = e.value
          changed = true
        }
      }
      if (changed || tr.docChanged) return { outs, deco: buildCellDeco(tr.state, outs) }
      return value
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.deco)
  })

  // Untracked handle on the latest outputs so the view-creation effect can seed a
  // freshly-mounted editor without itself depending on `cellOutputs`.
  const outputsRef: { list: CellOutput[] } = { list: [] }
  $effect(() => {
    outputsRef.list = cellOutputs
    view?.dispatch({ effects: setCellOutputs.of(cellOutputs) })
  })

  let host: HTMLDivElement
  let view: EditorView | undefined

  /** Imperatively insert text at the cursor (used by the citation picker). */
  export function insertText(text: string): void {
    if (!view) return
    const { from, to } = view.state.selection.main
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length }
    })
    view.focus()
  }

  // Toggle an HTML comment (`<!-- … -->`) around each selection — Quarto/markdown
  // has no line-comment token, so we wrap the selected span (or the current
  // line(s) when nothing is selected) as a block comment, and unwrap it if it's
  // already commented. Bound to Mod-/ below.
  function toggleHtmlComment(view: EditorView): boolean {
    const { state } = view
    const changes: { from: number; to: number; insert: string }[] = []
    const seen = new Set<string>()
    for (const range of state.selection.ranges) {
      // Expand each range to whole lines so the toggle works on the line the
      // caret sits in, and comments span cleanly across multi-line selections.
      const from = state.doc.lineAt(range.from).from
      const to = state.doc.lineAt(range.to).to
      const key = `${from}:${to}`
      if (seen.has(key)) continue // overlapping selections share the same line span
      seen.add(key)
      const text = state.sliceDoc(from, to)
      const wrapped = text.match(/^(\s*)<!--\s?([\s\S]*?)\s?-->(\s*)$/)
      if (wrapped) {
        changes.push({ from, to, insert: wrapped[1] + wrapped[2] + wrapped[3] })
      } else {
        const lead = text.match(/^\s*/)![0]
        changes.push({ from, to, insert: `${lead}<!-- ${text.slice(lead.length)} -->` })
      }
    }
    if (!changes.length) return false
    view.dispatch({ changes, scrollIntoView: true })
    return true
  }

  /** Scroll to (and select) a 1-based line range — used when clicking a note. */
  export function revealLines(line: number, endLine: number): void {
    if (!view) return
    const doc = view.state.doc
    if (line < 1 || line > doc.lines) return
    const from = doc.line(line).from
    const to = doc.line(Math.min(endLine, doc.lines)).to
    view.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: 'center' })
    })
    view.focus()
  }

  const theme = EditorView.theme({
    '&': {
      height: '100%',
      backgroundColor: 'var(--surface)',
      color: 'var(--text)',
      fontSize: '13.5px'
    },
    '.cm-scroller': {
      fontFamily: 'var(--font-mono)',
      lineHeight: '1.7',
      padding: '20px 26px'
    },
    '.cm-content': { caretColor: 'var(--accent)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground':
      { backgroundColor: 'var(--selection) !important' },
    '.cm-activeLine': { backgroundColor: 'transparent' },
    '.cm-searchMatch': { backgroundColor: 'var(--accent-weak)', outline: '1px solid var(--accent-line)' },
    '.cm-selectionMatch': { backgroundColor: 'var(--accent-weak)' },
    '.cm-placeholder': { color: 'var(--text-faint)' },
    // Pandoc `@citekey` citations (see citeHighlighter).
    '.cm-cite': { color: 'var(--accent)', fontWeight: '500' },
    // --- Inline code-cell output preview (CellWidget) ---
    '.lctrn-cell-output': {
      margin: '2px 0 12px',
      padding: '10px 12px',
      background: 'var(--surface-inset, var(--bg-sunken))',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-md)',
      fontFamily: 'var(--font-sans)',
      fontSize: '12px',
      lineHeight: '1.5',
      color: 'var(--text-secondary)',
      overflowX: 'auto'
    },
    '.lctrn-cell-output img': { maxWidth: '100%', height: 'auto', display: 'block' },
    '.lctrn-cell-output table': {
      borderCollapse: 'collapse',
      fontFamily: 'var(--font-mono)',
      fontSize: '11px'
    },
    '.lctrn-cell-output th, .lctrn-cell-output td': {
      border: '1px solid var(--border)',
      padding: '2px 8px',
      textAlign: 'right'
    },
    '.lctrn-cell-output figure': { margin: '0' },
    '.lctrn-cell-output figcaption': {
      marginTop: '4px',
      fontSize: '10.5px',
      color: 'var(--text-faint)'
    },
    '.lctrn-cell-output pre': {
      margin: '0',
      whiteSpace: 'pre-wrap',
      fontFamily: 'var(--font-mono)',
      fontSize: '11px',
      color: 'var(--text)'
    },
    '.cm-panels': {
      backgroundColor: 'var(--bg-sunken)',
      color: 'var(--text)'
    },
    // Float the search/find panel in the top-right corner instead of
    // docking it full-width along the top edge.
    '.cm-panels.cm-panels-top': {
      position: 'absolute',
      top: '8px',
      right: '8px',
      left: 'auto',
      width: 'auto',
      maxWidth: 'calc(100% - 16px)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-md)',
      boxShadow: 'var(--shadow-sm)',
      overflow: 'hidden',
      zIndex: '300'
    },
    '.cm-panels input, .cm-panels button': {
      fontFamily: 'var(--font-mono)',
      fontSize: '11px'
    },
    // --- `@`-citation autocomplete popup ---
    '.cm-tooltip.cm-tooltip-autocomplete': {
      background: 'var(--surface)',
      border: '1px solid var(--border-strong)',
      borderRadius: 'var(--r-md)',
      boxShadow: 'var(--shadow-lg, var(--shadow-sm))',
      overflow: 'hidden',
      zIndex: '400'
    },
    '.cm-tooltip-autocomplete > ul': {
      fontFamily: 'var(--font-sans)',
      fontSize: '12.5px',
      maxHeight: '16em'
    },
    '.cm-tooltip-autocomplete > ul > li': {
      padding: '5px 9px',
      display: 'flex',
      alignItems: 'baseline',
      gap: '8px',
      color: 'var(--text)'
    },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      background: 'var(--accent-weak)',
      color: 'var(--text)'
    },
    '.cm-completionLabel': {
      fontFamily: 'var(--font-mono)',
      fontSize: '11.5px',
      color: 'var(--accent)'
    },
    '.cm-completionDetail': {
      marginLeft: 'auto',
      fontStyle: 'normal',
      fontSize: '11px',
      color: 'var(--text-faint)'
    },
    '.cm-completionInfo': {
      background: 'var(--surface)',
      border: '1px solid var(--border-strong)',
      borderRadius: 'var(--r-md)',
      boxShadow: 'var(--shadow-lg, var(--shadow-sm))',
      padding: '8px 10px',
      maxWidth: '320px',
      fontFamily: 'var(--font-sans)',
      fontSize: '12px',
      lineHeight: '1.5',
      color: 'var(--text-secondary)',
      zIndex: '401'
    }
  })

  const mdHighlight = HighlightStyle.define([
    { tag: t.heading1, color: 'var(--text)', fontWeight: '700' },
    { tag: t.heading2, color: 'var(--text)', fontWeight: '700' },
    { tag: t.heading3, color: 'var(--text)', fontWeight: '600' },
    { tag: t.heading, color: 'var(--text)', fontWeight: '600' },
    { tag: t.strong, fontWeight: '700' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.strikethrough, textDecoration: 'line-through' },
    { tag: t.monospace, color: 'var(--data-cyan)' },
    { tag: t.quote, color: 'var(--text-secondary)', fontStyle: 'italic' },
    { tag: t.link, color: 'var(--info)' },
    { tag: t.url, color: 'var(--info)' },
    { tag: t.contentSeparator, color: 'var(--text-faint)' },
    { tag: t.list, color: 'var(--text)' },
    { tag: t.meta, color: 'var(--text-muted)' },
    { tag: t.processingInstruction, color: 'var(--accent)' },
    { tag: t.labelName, color: 'var(--data-violet)' },
    { tag: t.comment, color: 'var(--text-faint)' }
  ])

  $effect(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          EditorView.lineWrapping,
          markdown({ base: markdownLanguage }),
          syntaxHighlighting(mdHighlight),
          highlightSelectionMatches(),
          cmPlaceholder(placeholder),
          autocompletion({ override: [citeCompletions], icons: false }),
          citeHighlighter,
          cellOutputField,
          theme,
          keymap.of([
            {
              key: 'Mod-s',
              run: () => {
                onsave()
                return true
              }
            },
            { key: 'Mod-/', run: toggleHtmlComment },
            ...completionKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            indentWithTab
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onchange(u.state.doc.toString())
          }),
          EditorView.domEventHandlers({
            contextmenu: (event, v) => {
              const { from, to } = v.state.selection.main
              if (from === to || !onContextNote) return false // no selection → native menu
              event.preventDefault()
              const doc = v.state.doc
              onContextNote({
                text: v.state.sliceDoc(from, to),
                line: doc.lineAt(from).number,
                endLine: doc.lineAt(to).number,
                x: event.clientX,
                y: event.clientY
              })
              return true
            }
          })
        ]
      })
    })
    view.focus()
    // Seed the freshly-mounted editor with any outputs already in hand.
    if (outputsRef.list.length) view.dispatch({ effects: setCellOutputs.of(outputsRef.list) })
    const created = view

    // The editor is often mounted into a panel that is still settling its size
    // (e.g. the reader's notes pane appears/remounts on tab switch). If CodeMirror
    // measures at the wrong height, the caret renders the full height of the
    // editor ("giant cursor"). Re-measure once after mount and on every resize so
    // layout always matches the real container size.
    created.requestMeasure()
    const ro = new ResizeObserver(() => created.requestMeasure())
    ro.observe(host)

    return () => {
      ro.disconnect()
      created.destroy()
      if (view === created) view = undefined
    }
  })
</script>

<div class="cm-host" bind:this={host}></div>

<style>
  .cm-host {
    flex: 1;
    min-width: 0;
    height: 100%;
    min-height: 0;
    overflow: hidden;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-sm);
  }
  .cm-host :global(.cm-editor) {
    height: 100%;
  }
</style>
