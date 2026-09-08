<script lang="ts">
  import { onDestroy, untrack } from 'svelte'
  import Icon from './Icon.svelte'
  import Editor from './Editor.svelte'
  import { lastName } from '../../../main/houseName'
  import { paperPdfUrl } from './pdfUrl'
  import type { PaperText, ResolvedPaper, SemanticResult } from '../global'
  import {
    PROMPT_TEMPLATES,
    buildCustomPrompt,
    buildMultiPrompt,
    type PromptTemplate
  } from './promptTemplates'

  // The Reader's actions (Prompt / Find / Notes) live in the app's single top
  // bar, not in the tabstrip — the strip below is reserved for tabs. `toolbar`
  // is the read-only snapshot that bar renders from; it calls back through the
  // exported functions below.
  export type ReaderToolbar = {
    hasTabs: boolean
    canReload: boolean
    canPrompt: boolean
    canMultiPrompt: boolean
    promptMenuOpen: boolean
    findOpen: boolean
    notesOn: boolean
  }

  let {
    tabs,
    activeId,
    onselect,
    onclose,
    onPrompt,
    compact = false,
    toolbar = $bindable()
  }: {
    tabs: ResolvedPaper[]
    activeId: string | null
    onselect: (id: string) => void
    onclose: (id: string) => void
    // Expand a template against the active paper and dispatch it to Claude in
    // the terminal. Absent => the templates button is hidden.
    onPrompt?: (text: string) => void
    // Docked beside the Workspace/Papers instead of filling the window. The top
    // bar belongs to the app we're docked next to, so the actions it normally
    // hosts (Prompt / Find / Refresh / Notes) move into the tabstrip as icons.
    compact?: boolean
    toolbar?: ReaderToolbar
  } = $props()

  // Each tab's PDF is served by the backend — over the `lctrn-pdf://` scheme in
  // the desktop app, over `/pdf/…` from the localhost server (see lib/pdfUrl.ts)
  // — and rendered by the browser's built-in viewer. Every tab's iframe stays
  // mounted (only the active one is visible) so switching papers is instant and
  // preserves the viewer's scroll/zoom position.
  //
  // Jumping to a search hit appends `#page=N` (an open parameter the viewer reads
  // on load) plus a `?j=` nonce. The nonce is what makes the jump reliable: a
  // fragment-only change wouldn't re-navigate the already-loaded document, so the
  // viewer would sit where it is. The query is ignored by both PDF handlers,
  // which resolve the paper from the path alone.
  //
  // Refresh works the same way: bumping `reloads[id]` changes the query, so the
  // iframe re-navigates and the handler re-reads the file from disk —
  // which is what picks up annotations made elsewhere (e.g. on an iPad, synced
  // back into the library folder).
  const pdfUrl = (p: ResolvedPaper): string => {
    const base = paperPdfUrl(p.id)
    const j = jumps[p.id]
    const r = reloads[p.id]
    const q = [j ? `j=${j.n}` : '', r ? `r=${r}` : ''].filter(Boolean).join('&')
    // zoom=page-width puts the viewer in fit-to-width mode, which it then keeps
    // across container resizes — without it a PDF opened full-screen stays at
    // that zoom when the Reader is docked and gets cropped to its left margin.
    const frag = `#${j ? `page=${j.page}&` : ''}zoom=page-width`
    return `${base}${q ? `?${q}` : ''}${frag}`
  }

  let jumps = $state<Record<string, { page: number; n: number }>>({})
  let jumpSeq = 0
  let reloads = $state<Record<string, number>>({})
  let reloadSeq = 0

  /** Top bar's Refresh button — re-read the active paper's PDF from disk. */
  export function reload(): void {
    if (!activeId) return
    reloads = { ...reloads, [activeId]: ++reloadSeq }
  }

  // --- Keeping the PDF fitted to its pane -------------------------------------
  // The plugin picks its zoom from `zoom=page-width` at load and never re-fits
  // when the container resizes — so a paper opened full-screen overflows once
  // the Reader is docked, and one opened docked looks like a stamp full-screen.
  // Re-navigating the pane is the only lever we have, so watch its width and do
  // it when the width a tab is fitted to has really changed. A hidden pane is
  // display:none (zero width) — hence per-tab, and skipped at zero: fitting an
  // off-screen pane would fit it to nothing.
  let panesEl = $state<HTMLDivElement | null>(null)
  const fittedAt: Record<string, number> = {}
  /** Re-fit the active tab if the pane's width has drifted from its last fit. */
  function fitActive(): void {
    const id = activeId
    const w = panesEl?.clientWidth ?? 0
    if (!id || w < 50) return
    const prev = fittedAt[id]
    if (prev && Math.abs(w - prev) / prev < 0.15) return
    fittedAt[id] = w
    // No reload on a tab's first fit — it's loading at this width already.
    if (prev) reloads = { ...reloads, [id]: ++reloadSeq }
  }
  // One observer covers every way the width can move: docking, undocking, the
  // pane being revealed again, the notes folding away, the gutter drag, the
  // window resizing. Debounced so a drag re-fits once, when it settles, rather
  // than flickering the whole way across.
  $effect(() => {
    const el = panesEl
    if (!el) return
    let t: ReturnType<typeof setTimeout>
    const ro = new ResizeObserver(() => {
      clearTimeout(t)
      t = setTimeout(fitActive, 250)
    })
    ro.observe(el)
    return () => {
      clearTimeout(t)
      ro.disconnect()
    }
  })
  // Switching tabs moves no pixels, so the observer never fires — but the tab
  // you're arriving at may have been fitted at a very different width.
  $effect(() => {
    void activeId
    untrack(fitActive)
  })

  function jumpToPage(page: number): void {
    if (!activeId) return
    jumps = { ...jumps, [activeId]: { page, n: ++jumpSeq } }
  }

  function closeTab(id: string, e: MouseEvent): void {
    e.stopPropagation()
    onclose(id)
  }

  const tabTitle = (p: ResolvedPaper): string => p.title || p.citekey
  // Surnames only, up to three, then "et al." — the same shorthand the quick-open
  // palette uses. Shown under the note title so the pane says whose paper it is.
  const authorLabel = (authors: string[]): string => {
    const names = (authors ?? []).map(lastName).filter(Boolean)
    if (!names.length) return ''
    const head = names.slice(0, 3)
    if (names.length > 3) return `${head.join(', ')} et al.`
    return head.length === 1
      ? head[0]
      : `${head.slice(0, -1).join(', ')} & ${head[head.length - 1]}`
  }

  // --- Per-paper notes (right panel + notes/<title>.md) ----------------------
  // A markdown note sits beside the active PDF. The moment text is typed it is
  // autosaved to a `.md` file named after the paper (created on first keystroke,
  // removed when emptied) — handled entirely in the main process.
  let showNotes = $state(true)
  // Drag the divider between the PDF and the notes to resize; the width
  // persists to localStorage so it survives reloads.
  const NOTES_W_KEY = 'lctrn.readerNotesWidth'
  const NOTES_W_DEFAULT = 340
  const NOTES_W_MIN = 220
  const NOTES_W_MAX = 900
  function loadNotesWidth(): number {
    const n = Number(localStorage.getItem(NOTES_W_KEY))
    return Number.isFinite(n) && n >= NOTES_W_MIN ? Math.min(n, NOTES_W_MAX) : NOTES_W_DEFAULT
  }
  let notesW = $state(loadNotesWidth())
  let resizing = $state(false)
  let compactPromptBtn = $state<HTMLButtonElement | null>(null)
  // Docking makes the whole Reader about as wide as the notes pane used to be,
  // so the notes fold away on the way in and come back on the way out. Toggling
  // them by hand while docked still works — this only drives the transition.
  // Only the dock/undock transition drives this — hence untrack: the effect
  // writes `showNotes`, so reading it tracked would re-run itself forever.
  let notesBeforeDock = true
  let wasCompact = false
  $effect(() => {
    const c = compact
    untrack(() => {
      if (c === wasCompact) return
      wasCompact = c
      if (c) {
        notesBeforeDock = showNotes
        showNotes = false
      } else if (notesBeforeDock) {
        showNotes = true
      }
    })
  })

  // The PDF sits in an iframe, which swallows pointer events mid-drag — a
  // shield over the stage keeps every move coming back to this document.
  function startNotesResize(e: PointerEvent): void {
    e.preventDefault()
    const startX = e.clientX
    const startW = notesW
    resizing = true
    const onMove = (ev: PointerEvent): void => {
      notesW = Math.min(NOTES_W_MAX, Math.max(NOTES_W_MIN, startW + (startX - ev.clientX)))
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      resizing = false
      try {
        localStorage.setItem(NOTES_W_KEY, String(Math.round(notesW)))
      } catch {
        /* ignore quota errors */
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  let noteInitial = $state('') // feeds <Editor>; only changes on paper switch (remounts it)
  let noteDraft = $state('') // live content from the editor
  let noteSaved = $state('') // last value persisted to disk
  let noteLoading = $state(false)
  let saving = $state(false)
  let noteFile = $state('') // absolute path of the note file, from the main process
  // The paper whose note is currently loaded — tracked separately from `activeId`
  // so a mid-edit tab switch flushes the pending save to the OUTGOING paper.
  let loadedNoteId: string | null = null
  let saveTimer: ReturnType<typeof setTimeout> | null = null

  const activePaper = $derived(tabs.find((t) => t.id === activeId) ?? null)
  // "Blankespoor, Croom & Grant (2025)" — the year reads as part of the citation,
  // so it's appended here rather than shown as its own field.
  const noteAuthors = $derived.by(() => {
    if (!activePaper) return ''
    const names = authorLabel(activePaper.authors)
    const year = activePaper.year
    if (!year) return names
    return names ? `${names} (${year})` : `(${year})`
  })

  // Opening or switching a tab puts the keyboard on the PAPER (the PDF frame),
  // so ↑/↓/space scroll what you came to read. Without this the caret lands
  // wherever the DOM put it — historically the notes editor beside it.
  let panes = $state<Record<string, HTMLDivElement | null>>({})
  $effect(() => {
    const id = activeId
    if (!id) return
    clearHighlight() // a hit lit up in the paper we're leaving
    requestAnimationFrame(() => {
      if (activeId !== id) return
      panes[id]?.querySelector('iframe')?.focus()
    })
  })

  // --- Find in paper (⌘F) + semantic search -----------------------------------
  // Chromium's PDF viewer is a plugin we can't reach into: no find bar of our
  // own inside it, no highlighting. So lctrn searches its OWN text layer (the
  // per-page text pdf.js extracted in main) and shows the hits as a result list;
  // picking one re-opens the PDF at that page.
  //
  // Two modes share the box. "Text" is literal substring matching, live as you
  // type. "Meaning" hands the paper and the question to Claude and gets back the
  // passages that actually answer it — the thing ⌘F can't do.
  type FindMode = 'text' | 'meaning'

  interface TextMatch {
    page: number
    /** Offset of the hit in that page's extracted text — the anchor for `probeFor`. */
    at: number
    before: string
    match: string
    after: string
  }

  const MAX_MATCHES = 400
  /** Context shown either side of a literal hit. */
  const LEAD = 55
  const TRAIL = 95

  let findOpen = $state(false)
  let findMode = $state<FindMode>('text')
  let findQuery = $state('')
  let findInput = $state<HTMLInputElement | null>(null)
  let cursor = $state(0) // index of the highlighted literal match

  // Extracted text of the active paper. Main caches it on disk, so this is a
  // one-off cost per paper per session.
  const textCache = new Map<string, PaperText | null>()
  let activeText = $state<PaperText | null>(null)
  let indexing = $state(false)

  let semRunning = $state(false)
  let semCursor = $state(0) // index of the highlighted passage in "meaning" mode
  let semResult = $state<SemanticResult | null>(null)
  let semAsked = $state('') // the question the current results answer
  let semSeq = 0

  /** Open the find bar (called from the tabstrip button and App's ⌘F relay). */
  export function openFind(): void {
    if (!tabs.length) return
    findOpen = true
    requestAnimationFrame(() => {
      findInput?.focus()
      findInput?.select()
    })
  }

  // Closing the bar deliberately LEAVES the highlight in the paper: the panel
  // floats over the page, so dismissing it is how you get a clear look at the
  // passage you just picked. It goes when the query changes or the paper does.
  function closeFind(): void {
    findOpen = false
  }

  // Load the active paper's text layer. Kept keyed on `activeId` alone (the
  // cache is a plain Map, not $state) so filling it can't retrigger this.
  $effect(() => {
    void loadText(activeId)
  })

  async function loadText(id: string | null): Promise<void> {
    // Results belong to the paper they came from.
    semResult = null
    semAsked = ''
    cursor = 0
    if (!id) {
      activeText = null
      indexing = false
      return
    }
    if (textCache.has(id)) {
      activeText = textCache.get(id) ?? null
      indexing = false
      return
    }
    activeText = null
    indexing = true
    let text: PaperText | null = null
    try {
      text = await window.api.library.search.text(id)
    } catch {
      text = null
    }
    textCache.set(id, text)
    if (id !== activeId) return // switched papers mid-extract
    activeText = text
    indexing = false
  }

  const matches = $derived.by((): TextMatch[] => {
    const t = activeText
    const q = findQuery.trim()
    if (!t || findMode !== 'text' || q.length < 2) return []
    const needle = q.toLowerCase()
    const out: TextMatch[] = []
    for (let i = 0; i < t.pages.length && out.length < MAX_MATCHES; i++) {
      const page = t.pages[i]
      const hay = page.toLowerCase()
      let from = 0
      while (out.length < MAX_MATCHES) {
        const at = hay.indexOf(needle, from)
        if (at < 0) break
        const end = at + q.length
        out.push({
          page: i + 1,
          at,
          before: (at > LEAD ? '…' : '') + page.slice(Math.max(0, at - LEAD), at),
          match: page.slice(at, end),
          after: page.slice(end, end + TRAIL) + (page.length > end + TRAIL ? '…' : '')
        })
        from = at + needle.length
      }
    }
    return out
  })

  // A fresh query starts at its first hit — and drops the previous one's
  // highlight, which would otherwise sit in the PDF pointing at nothing.
  $effect(() => {
    findQuery
    findMode
    cursor = 0
    semCursor = 0
    clearHighlight()
  })

  // --- Lighting up the passage in the PDF -------------------------------------
  // The viewer is a plugin, so the only way in is Chromium's find-in-page (main
  // relays it — see reader:highlight). That search sees this window's whole DOM,
  // and the FIRST match takes the highlight, so the phrase we send has to be one
  // our own hit list can't contain: a list row shows LEAD chars before the hit and
  // TRAIL after it, so reaching further than that in either direction is enough.
  const PROBE = 220
  const seenSince = { seq: 0 } // last-wins guard for rapid ↑/↓

  /** A phrase anchored at `at` on `page` (1-based), long enough to be unique. */
  function probeFor(page: number, at: number, hitLen: number): string {
    const text = activeText?.pages[page - 1]
    if (!text) return ''
    // Prefer reaching forward past TRAIL; near the end of a page there may be
    // nothing left to reach into, so reach backwards past LEAD instead.
    const tail = text.slice(at, at + Math.max(hitLen + PROBE, PROBE))
    const phrase =
      tail.length > hitLen + TRAIL ? tail : text.slice(Math.max(0, at - PROBE), at + hitLen + TRAIL)
    // The extracted text keeps the PDF's line breaks; the viewer matches across
    // them, but only against a single-spaced needle.
    return phrase.replace(/\s+/g, ' ').trim()
  }

  // Whether a find is currently painting in the window. Chromium's
  // stopFindInPage pulls focus out of whatever holds it — which, mid-typing, is
  // the query box — so we only ever call it when there IS something to clear.
  let highlighted = false

  /** Highlight the passage in the PDF; fall back to a plain page jump. */
  async function reveal(page: number, phrase: string): Promise<void> {
    const seq = ++seenSince.seq
    const paper = activeId
    if (phrase) {
      highlighted = true
      const matched = await window.api.reader.highlight(phrase)
      // Chromium's find hands focus to the frame holding the match — here, the
      // PDF plugin — which would swallow the next ↑/↓/esc. Take it back.
      findInput?.focus()
      // A newer hit was picked while this was in flight, or the user moved on.
      if (seq !== seenSince.seq || paper !== activeId) return
      if (matched > 0) return
    }
    jumpToPage(page)
  }

  function clearHighlight(): void {
    seenSince.seq++
    if (!highlighted) return
    highlighted = false
    void window.api.reader.clearHighlight().then(() => {
      // Clearing hands focus back to the frame that had the match; the caret
      // belongs in the query box while the bar is open.
      if (findOpen) findInput?.focus()
    })
  }

  /** Move through the literal hits and take the PDF along. */
  function step(delta: number): void {
    if (!matches.length) return
    cursor = (cursor + delta + matches.length) % matches.length
    revealMatch(cursor)
  }

  function pickMatch(i: number): void {
    cursor = i
    revealMatch(i)
  }

  function revealMatch(i: number): void {
    const m = matches[i]
    if (!m) return
    void reveal(m.page, probeFor(m.page, m.at, m.match.length))
  }

  /** Same, for the passages Claude found in "meaning" mode. */
  function stepSem(delta: number): void {
    const hits = semResult?.hits ?? []
    if (!hits.length) return
    semCursor = (semCursor + delta + hits.length) % hits.length
    revealSem(semCursor)
  }

  function pickSem(i: number): void {
    semCursor = i
    revealSem(i)
  }

  // A semantic hit carries Claude's quote rather than an offset, so locate the
  // quote in the page text first. Loose quotes (h.exact === false) are Claude's
  // paraphrase — nothing to match on, so those just jump to the page.
  function revealSem(i: number): void {
    const h = semResult?.hits[i]
    if (!h) return
    const text = activeText?.pages[h.page - 1]
    const at = h.exact && text ? text.indexOf(h.quote) : -1
    void reveal(h.page, at >= 0 ? probeFor(h.page, at, h.quote.length) : '')
  }

  // The hit list scrolls, so the highlighted row has to be brought into view as
  // ↑/↓ walk past its edge — the caret stays in the query box the whole time.
  let hitEls = $state<HTMLButtonElement[]>([])
  $effect(() => {
    const i = findMode === 'text' ? cursor : semCursor
    hitEls[i]?.scrollIntoView({ block: 'nearest' })
  })

  async function runSemantic(): Promise<void> {
    const id = activeId
    const q = findQuery.trim()
    if (!id || !q || semRunning) return
    const seq = ++semSeq
    semRunning = true
    semResult = null
    semAsked = q
    try {
      const res = await window.api.library.search.semantic(id, q)
      if (seq === semSeq) semResult = res
    } catch (e) {
      if (seq === semSeq) {
        semResult = { summary: '', hits: [], error: (e as Error)?.message || 'Search failed.' }
      }
    } finally {
      if (seq === semSeq) semRunning = false
    }
  }

  function setMode(m: FindMode): void {
    findMode = m
    requestAnimationFrame(() => findInput?.focus())
  }

  // ↑/↓ walk the results without leaving the query box (the input's own caret
  // movement is suppressed — it's a single line, so nothing is lost).
  function onFindKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      closeFind()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const delta = e.key === 'ArrowDown' ? 1 : -1
      findMode === 'meaning' ? stepSem(delta) : step(delta)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (findMode === 'meaning') void runSemantic()
      else step(e.shiftKey ? -1 : 1)
    }
  }

  // --- Prompt templates (tabstrip button → dropdown → terminal) --------------
  // Expand a template against the active paper and hand it to Claude. Only
  // available for a paper whose PDF exists on disk (the prompt references its path).
  let promptMenuOpen = $state(false)
  const canPrompt = $derived(Boolean(onPrompt && activePaper?.exists))
  // The button lives in the top bar (outside this component), so the menu is
  // positioned `fixed` from the anchor's viewport rect that the bar hands us.
  let promptMenuPos = $state<{ top: number; right: number }>({ top: 0, right: 0 })

  /** Open/close the templates menu under `anchor` (the top bar's Prompt button). */
  export function togglePromptMenu(anchor?: HTMLElement | null): void {
    if (promptMenuOpen) {
      promptMenuOpen = false
      return
    }
    if (!canPrompt) return
    if (anchor) {
      const r = anchor.getBoundingClientRect()
      promptMenuPos = { top: r.bottom + 4, right: window.innerWidth - r.right }
    }
    promptMenuOpen = true
  }

  /** ⌘F / the top bar's Find button — toggles the paper's find panel. */
  export function toggleFind(): void {
    findOpen ? closeFind() : openFind()
  }

  /** The top bar's Notes button. */
  export function toggleNotes(): void {
    showNotes = !showNotes
  }

  /** The top bar's "Prompt multiple" row (also reachable from the menu). */
  export function promptMultiple(): void {
    openMultiPrompt()
  }

  function runTemplate(t: PromptTemplate): void {
    promptMenuOpen = false
    if (!activePaper) return
    onPrompt?.(
      t.build({
        absPath: activePaper.absPath,
        citekey: activePaper.citekey,
        title: tabTitle(activePaper)
      })
    )
  }

  // --- Custom prompt composer -------------------------------------------------
  // A free-form prompt that ships with the active paper's context baked in (its
  // title, path and citekey), so the user just fills in the instruction. Opened
  // from the "Custom prompt…" row in the templates menu.
  let customOpen = $state(false)
  let customText = $state('')
  let customArea = $state<HTMLTextAreaElement | null>(null)

  function openCustomPrompt(): void {
    promptMenuOpen = false
    if (!activePaper) return
    customText = ''
    customOpen = true
    // Focus once the textarea is in the DOM.
    requestAnimationFrame(() => customArea?.focus())
  }

  function sendCustomPrompt(): void {
    if (!activePaper || !customText.trim()) return
    onPrompt?.(
      buildCustomPrompt(
        {
          absPath: activePaper.absPath,
          citekey: activePaper.citekey,
          title: tabTitle(activePaper)
        },
        customText
      )
    )
    customOpen = false
    customText = ''
  }

  function onCustomKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      customOpen = false
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      sendCustomPrompt()
    }
  }

  // --- Multi-paper prompt composer --------------------------------------------
  // Ask Claude about several open papers at once. Only offered when >1 tab is
  // open. The composer lists the open tabs (whose PDF exists) as a checklist —
  // all pre-selected — plus a free-form instruction; on send it bakes each
  // selected paper's reference into the prompt.
  let multiOpen = $state(false)
  let multiSelected = $state<Set<string>>(new Set())
  let multiText = $state('')
  let multiArea = $state<HTMLTextAreaElement | null>(null)
  // Only papers whose file exists can be referenced by path.
  const promptableTabs = $derived(tabs.filter((t) => t.exists))
  const canMultiPrompt = $derived(Boolean(onPrompt) && promptableTabs.length > 1)

  function openMultiPrompt(): void {
    promptMenuOpen = false
    if (!canMultiPrompt) return
    multiSelected = new Set(promptableTabs.map((t) => t.id))
    multiText = ''
    multiOpen = true
    requestAnimationFrame(() => multiArea?.focus())
  }

  function toggleMulti(id: string): void {
    const next = new Set(multiSelected)
    next.has(id) ? next.delete(id) : next.add(id)
    multiSelected = next
  }

  function sendMultiPrompt(): void {
    const chosen = promptableTabs.filter((t) => multiSelected.has(t.id))
    if (chosen.length < 1 || !multiText.trim()) return
    onPrompt?.(
      buildMultiPrompt(
        chosen.map((p) => ({ absPath: p.absPath, citekey: p.citekey, title: tabTitle(p) })),
        multiText
      )
    )
    multiOpen = false
    multiText = ''
  }

  function onMultiKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      multiOpen = false
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      sendMultiPrompt()
    }
  }
  let noteSaveError = $state<string | null>(null)
  const noteDirty = $derived(noteDraft !== noteSaved)
  const noteState = $derived(saving ? 'saving…' : noteDirty ? 'unsaved' : 'saved')
  // The note's filename (e.g. "notes/Calling for transparency….md"), for the caption.
  const noteFileLabel = $derived(noteFile ? 'notes/' + noteFile.split('/').pop() : '')

  // Load the active paper's note whenever the selection changes. Flip the
  // loading gate synchronously so the editor unmounts and then remounts with the
  // freshly-loaded text — otherwise switching between two papers whose notes are
  // identical strings (e.g. both empty) would leave the previous paper's edits on
  // screen, since the editor only refreshes when its `value` prop changes.
  $effect(() => {
    const id = activeId
    if (id && id !== loadedNoteId) noteLoading = true
    void switchNote(id)
  })

  async function switchNote(id: string | null): Promise<void> {
    // Yield first so the state writes below are outside the effect's tracking
    // scope — otherwise typing (which mutates `noteDraft`) would retrigger this.
    await Promise.resolve()
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    // Flush any unsaved edit to the paper whose note is currently loaded.
    if (loadedNoteId && loadedNoteId !== id && noteDraft !== noteSaved) {
      try {
        await window.api.library.note.save(loadedNoteId, noteDraft)
      } catch (e) {
        // Surface it: the outgoing paper's note edits did NOT reach disk.
        noteSaveError = (e as Error)?.message || 'Could not save note.'
      }
    }
    if (!id) {
      loadedNoteId = null
      noteInitial = noteDraft = noteSaved = ''
      return
    }
    if (id === loadedNoteId) return // re-selecting the same paper — keep edits
    noteLoading = true
    let content = ''
    try {
      const res = await window.api.library.note.get(id)
      content = res.content
      noteFile = res.file
    } catch {
      content = ''
      noteFile = ''
    }
    noteInitial = content
    noteDraft = content
    noteSaved = content
    loadedNoteId = id
    noteLoading = false
  }

  function onNoteChange(v: string): void {
    noteDraft = v
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => void saveNote(), 800)
  }

  async function saveNote(): Promise<void> {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    if (saving || noteDraft === noteSaved || !loadedNoteId) return
    saving = true
    const id = loadedNoteId
    const snapshot = noteDraft
    try {
      await window.api.library.note.save(id, snapshot)
      noteSaved = snapshot
      noteSaveError = null
    } catch (e) {
      noteSaveError = (e as Error)?.message || 'Could not save note.'
    } finally {
      saving = false
    }
  }

  // Publish the toolbar snapshot upward. Plain values only — the top bar just
  // renders from it and calls back through the exports above.
  $effect(() => {
    toolbar = {
      hasTabs: tabs.length > 0,
      canReload: !!activeId,
      canPrompt,
      canMultiPrompt,
      promptMenuOpen,
      findOpen,
      notesOn: showNotes
    }
  })

  // Leaving Reader mode unmounts this component — flush the last (<800ms) edit.
  onDestroy(() => {
    clearHighlight()
    if (loadedNoteId && noteDraft !== noteSaved) {
      void window.api.library.note.save(loadedNoteId, noteDraft)
    }
  })
</script>

<div class="reader">
  <div class="tabstrip" role="tablist">
    {#each tabs as p, i (p.id)}
      <div class="rtab" role="tab" aria-selected={activeId === p.id} data-on={activeId === p.id}>
        <button class="rtab-main" title={tabTitle(p)} onclick={() => onselect(p.id)}>
          {#if i < 9}<span class="rtab-num">⌘{i + 1}</span>{/if}
          <span class="rtab-name">{tabTitle(p)}</span>
        </button>
        <button class="rtab-x" title="Close (⌘W)" onclick={(e) => closeTab(p.id, e)}>
          <Icon n="x" />
        </button>
      </div>
    {/each}
    <span class="tabstrip-spacer"></span>
    <!-- Docked: the same actions as the top bar's, as icons, since the bar
         itself belongs to the Workspace/Papers we're sitting next to. -->
    {#if compact && tabs.length}
      <div class="rcompact">
        {#if onPrompt}
          <button
            bind:this={compactPromptBtn}
            class="rc-btn"
            data-on={promptMenuOpen}
            disabled={!canPrompt}
            aria-haspopup="menu"
            aria-expanded={promptMenuOpen}
            title="Send a prompt about this paper to Claude"
            onclick={() => togglePromptMenu(compactPromptBtn)}
          ><Icon n="sparkle" /></button>
        {/if}
        <button
          class="rc-btn"
          data-on={findOpen}
          title="Find in this paper (⌘F) — text or meaning"
          onclick={toggleFind}
        ><Icon n="search" /></button>
        <button
          class="rc-btn"
          disabled={!activeId}
          title="Reload this PDF from disk"
          onclick={reload}
        ><Icon n="refresh" /></button>
        <button
          class="rc-btn"
          data-on={showNotes}
          title={showNotes ? 'Hide notes' : 'Show notes'}
          onclick={toggleNotes}
        ><Icon n="note" /></button>
      </div>
    {/if}
    <!-- Prompt / Find / Notes live in the top bar; only the menu they open is
         rendered here, positioned `fixed` from the bar button's rect. -->
    {#if tabs.length && onPrompt}
      {#if promptMenuOpen}
        <button
          class="rtmpl-backdrop"
          aria-label="Close menu"
          onclick={() => (promptMenuOpen = false)}
        ></button>
        <div
          class="rtmpl-menu"
          role="menu"
          style="top:{promptMenuPos.top}px; right:{promptMenuPos.right}px;"
        >
          <div class="rtmpl-head">Ask Claude about this paper</div>
          {#each PROMPT_TEMPLATES as t (t.id)}
            <button class="rtmpl-item" role="menuitem" onclick={() => runTemplate(t)}>
              <Icon n={t.icon} />
              <span>{t.label}</span>
            </button>
          {/each}
          <div class="rtmpl-sep"></div>
          <button class="rtmpl-item" role="menuitem" onclick={openCustomPrompt}>
            <Icon n="pen" />
            <span>Custom prompt…</span>
          </button>
          {#if canMultiPrompt}
            <button class="rtmpl-item" role="menuitem" onclick={openMultiPrompt}>
              <Icon n="cards" />
              <span>Prompt multiple papers…</span>
            </button>
          {/if}
        </div>
      {/if}
    {/if}
  </div>

  <div class="rstage" data-resizing={resizing}>
    <div class="rpanes" bind:this={panesEl}>
      {#each tabs as p (p.id)}
        <div class="rpane" bind:this={panes[p.id]} data-on={activeId === p.id}>
          {#if p.exists}
            <iframe class="rframe" src={pdfUrl(p)} title={tabTitle(p)}></iframe>
          {:else}
            <div class="rmsg">
              <Icon n="pdf" />
              <p>Couldn’t open this PDF.</p>
              <small>The file is missing on disk.</small>
            </div>
          {/if}
        </div>
      {/each}
      {#if tabs.length === 0}
        <div class="rmsg">
          <Icon n="pdf" />
          <p>No papers open.</p>
          <small>Double-click a paper, or use the PDF button in the inspector, to read it here.</small>
        </div>
      {/if}

      <!-- Find panel: floats over the PDF (the viewer is a plugin we can't draw
           into, so hits are listed here and clicking one re-opens at that page). -->
      {#if findOpen && tabs.length}
        <div class="rfind">
          <div class="rfind-bar">
            <div class="rfind-modes">
              <button data-on={findMode === 'text'} onclick={() => setMode('text')} title="Literal text search">
                Text
              </button>
              <button
                data-on={findMode === 'meaning'}
                onclick={() => setMode('meaning')}
                title="Ask by meaning — Claude reads the paper and points at the passages"
              >
                <Icon n="sparkle" />Meaning
              </button>
            </div>
            <div class="rfind-input">
              <Icon n="search" />
              <input
                bind:this={findInput}
                bind:value={findQuery}
                spellcheck="false"
                placeholder={findMode === 'text'
                  ? 'Find in this paper…'
                  : 'Ask this paper a question…'}
                onkeydown={onFindKeydown}
              />
            </div>
            {#if findMode === 'text'}
              <span class="rfind-count">
                {matches.length
                  ? `${cursor + 1}/${matches.length}${matches.length === MAX_MATCHES ? '+' : ''}`
                  : findQuery.trim().length > 1 && activeText
                    ? 'none'
                    : ''}
              </span>
              <button
                class="rfind-nav"
                title="Previous (↑ or ⇧↵)"
                disabled={!matches.length}
                onclick={() => step(-1)}
              >
                <Icon n="chevron-up" />
              </button>
              <button
                class="rfind-nav"
                title="Next (↓ or ↵)"
                disabled={!matches.length}
                onclick={() => step(1)}
              >
                <Icon n="chevron-down" />
              </button>
            {:else}
              <button
                class="rfind-ask"
                disabled={semRunning || !findQuery.trim()}
                onclick={runSemantic}
              >
                {semRunning ? 'Reading…' : 'Ask'}
              </button>
            {/if}
            <button class="rfind-x" title="Close (esc)" onclick={closeFind}>×</button>
          </div>

          <div class="rfind-body">
            {#if indexing}
              <div class="rfind-note">Reading this PDF’s text…</div>
            {:else if activeText?.empty}
              <div class="rfind-note">
                No text layer in this PDF — it looks like a scan, so there’s nothing to search.
              </div>
            {:else if !activeText}
              <div class="rfind-note">Couldn’t read this paper’s text.</div>
            {:else if findMode === 'text'}
              {#if findQuery.trim().length < 2}
                <div class="rfind-note">
                  Type at least two characters. {activeText.pages.length} pages indexed · ↓/↵ next · ↑/⇧↵ previous
                </div>
              {:else if !matches.length}
                <div class="rfind-note">No matches in this paper.</div>
              {:else}
                <ul class="rfind-list">
                  {#each matches as m, i (i)}
                    <li>
                      <button
                        bind:this={hitEls[i]}
                        class="rfind-hit"
                        data-on={i === cursor}
                        onclick={() => pickMatch(i)}
                      >
                        <span class="rfind-page">p.{m.page}</span>
                        <span class="rfind-snippet">
                          {m.before}<mark>{m.match}</mark>{m.after}
                        </span>
                      </button>
                    </li>
                  {/each}
                </ul>
              {/if}
            {:else if semRunning}
              <div class="rfind-note">Claude is reading the paper…</div>
            {:else if semResult?.error}
              <div class="rfind-note rfind-note--err">{semResult.error}</div>
            {:else if semResult}
              {#if semResult.summary}
                <div class="rfind-summary">
                  <Icon n="sparkle" />
                  <p>{semResult.summary}</p>
                </div>
              {/if}
              {#if semResult.hits.length}
                <ul class="rfind-list">
                  {#each semResult.hits as h, i (i)}
                    <li>
                      <button
                        bind:this={hitEls[i]}
                        class="rfind-hit"
                        data-on={i === semCursor}
                        onclick={() => pickSem(i)}
                      >
                        <span class="rfind-page">p.{h.page}</span>
                        <span class="rfind-snippet">
                          <span class="rfind-quote" class:loose={!h.exact}>“{h.quote}”</span>
                          {#if h.why}<span class="rfind-why">{h.why}</span>{/if}
                        </span>
                      </button>
                    </li>
                  {/each}
                </ul>
              {:else if !semResult.summary}
                <div class="rfind-note">Nothing in this paper speaks to “{semAsked}”.</div>
              {/if}
            {:else}
              <div class="rfind-note">
                Ask in your own words — e.g. “how do they handle endogeneity?”. Claude reads the
                whole paper and points at the passages. ↵ to ask, then ↑/↓ to walk them.
              </div>
            {/if}
          </div>
        </div>
      {/if}
    </div>

    {#if showNotes && activePaper}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        class="rnotes-grip"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize notes"
        data-on={resizing}
        onpointerdown={startNotesResize}
        ondblclick={() => {
          notesW = NOTES_W_DEFAULT
          localStorage.setItem(NOTES_W_KEY, String(NOTES_W_DEFAULT))
        }}
      ></div>
      <!-- min(): docked, the saved width can exceed the whole pane — never let
           the notes crowd the paper out past half. -->
      <aside class="rnotes" style="width:min({notesW}px, 55%)">
        <div class="rnotes-head">
          <Icon n="note" />
          <span class="rnotes-id">
            <span class="rnotes-title" title={tabTitle(activePaper)}>{tabTitle(activePaper)}</span>
            {#if noteAuthors}
              <span class="rnotes-authors" title={activePaper.authors.join('; ')}>
                {noteAuthors}
              </span>
            {/if}
          </span>
          <span class="rnotes-spacer"></span>
          {#if noteSaveError}
            <button class="rnotes-state rnotes-state--err" title={noteSaveError} onclick={saveNote}>
              ⚠ save failed
            </button>
          {:else}
            <span class="rnotes-state">{noteState}</span>
          {/if}
          <button class="rnotes-x" title="Hide notes" onclick={() => (showNotes = false)}>×</button>
        </div>
        {#if noteLoading}
          <div class="rnotes-loading">Loading note…</div>
        {:else}
          <div class="rnotes-body">
            <!-- Keep the placeholder short and single-line: a long placeholder
                 inflates the empty document's first line, which makes the caret
                 render its full height. -->
            <!-- The notes pane never takes the caret on mount, and never claims
                 ⌘F: in the Reader the paper is what you came to read and search. -->
            <Editor
              value={noteInitial}
              onchange={onNoteChange}
              onsave={saveNote}
              placeholder="Write your notes…"
              autofocus={false}
              ownFind={false}
            />
          </div>
          {#if noteFileLabel}
            <div class="rnotes-foot" title={noteFile}>{noteFileLabel}</div>
          {/if}
        {/if}
      </aside>
    {/if}
  </div>

  {#if customOpen && activePaper}
    <div class="cprompt-backdrop" role="presentation" onclick={() => (customOpen = false)}></div>
    <div class="cprompt-layer" role="presentation">
      <div class="cprompt" role="dialog" aria-label="Custom prompt">
        <div class="cprompt-head">
          <Icon n="sparkle" />
          <span>Ask Claude about this paper</span>
          <span class="cprompt-spacer"></span>
          <button class="cprompt-x" title="Close (Esc)" onclick={() => (customOpen = false)}>×</button>
        </div>
        <!-- The paper's context (title / path / citekey) is baked into the prompt
             automatically — this box just makes it visible. The user fills in the
             instruction below. -->
        <div class="cprompt-context" title={activePaper.absPath}>
          <span class="cprompt-ctx-label">Context</span>
          <span class="cprompt-ctx-title">{tabTitle(activePaper)}</span>
          <span class="cprompt-ctx-cite">@{activePaper.citekey}</span>
        </div>
        <textarea
          bind:this={customArea}
          bind:value={customText}
          class="cprompt-area"
          placeholder="…what do you want to do with it? e.g. “compare its identification strategy to my methods section”"
          onkeydown={onCustomKeydown}
        ></textarea>
        <div class="cprompt-foot">
          <span class="cprompt-hint">⌘↵ to send · esc to cancel</span>
          <button class="cprompt-send" disabled={!customText.trim()} onclick={sendCustomPrompt}>
            <Icon n="sparkle" />Send to Claude
          </button>
        </div>
      </div>
    </div>
  {/if}

  {#if multiOpen}
    <div class="cprompt-backdrop" role="presentation" onclick={() => (multiOpen = false)}></div>
    <div class="cprompt-layer" role="presentation">
      <div class="cprompt" role="dialog" aria-label="Prompt multiple papers">
        <div class="cprompt-head">
          <Icon n="cards" />
          <span>Ask Claude about several papers</span>
          <span class="cprompt-spacer"></span>
          <button class="cprompt-x" title="Close (Esc)" onclick={() => (multiOpen = false)}>×</button>
        </div>
        <!-- Pick which of the open papers to include; each selected paper's
             reference (title / path / citekey) is baked into the prompt. -->
        <div class="mprompt-list">
          {#each promptableTabs as p (p.id)}
            <label class="mprompt-row" title={p.absPath}>
              <input
                type="checkbox"
                checked={multiSelected.has(p.id)}
                onchange={() => toggleMulti(p.id)}
              />
              <span class="mprompt-title">{tabTitle(p)}</span>
              <span class="mprompt-cite">@{p.citekey}</span>
            </label>
          {/each}
        </div>
        <textarea
          bind:this={multiArea}
          bind:value={multiText}
          class="cprompt-area"
          placeholder="…what do you want to do across them? e.g. “compare their identification strategies and where they disagree”"
          onkeydown={onMultiKeydown}
        ></textarea>
        <div class="cprompt-foot">
          <span class="cprompt-hint">{multiSelected.size} selected · ⌘↵ to send · esc to cancel</span>
          <button
            class="cprompt-send"
            disabled={!multiText.trim() || multiSelected.size < 1}
            onclick={sendMultiPrompt}
          >
            <Icon n="sparkle" />Send to Claude
          </button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .reader {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg, var(--surface));
  }

  /* ---- Tab strip ---- */
  /* Square, contiguous tabs separated by hairlines — the active one is marked by
     an accent rule along its top edge (no rounded "folder" tabs). */
  .tabstrip {
    flex: none;
    display: flex;
    align-items: stretch;
    gap: 0;
    height: 38px;
    padding: 0;
    overflow-x: auto;
    overflow-y: hidden;
    background: var(--surface-inset);
    border-bottom: 1px solid var(--border);
    scrollbar-width: thin;
  }
  .rtab {
    display: flex;
    align-items: center;
    gap: 2px;
    max-width: 240px;
    min-width: 96px;
    padding: 0 8px 0 6px;
    background: transparent;
    border: none;
    border-right: 1px solid var(--border);
    border-radius: 0;
    box-shadow: inset 0 2px 0 transparent;
    color: var(--text-muted);
    white-space: nowrap;
  }
  .rtab:hover {
    background: var(--surface);
    color: var(--text-secondary);
  }
  .rtab[data-on='true'] {
    background: var(--surface);
    box-shadow: inset 0 2px 0 var(--accent);
    color: var(--text);
  }
  .rtab-main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 4px 0 6px;
    background: transparent;
    border: none;
    color: inherit;
    font-family: var(--font-sans);
    font-size: 12px;
    cursor: pointer;
  }
  .rtab-num {
    font-family: var(--font-mono);
    font-size: 9px;
    color: var(--text-faint);
  }
  .rtab[data-on='true'] .rtab-num {
    color: var(--accent);
  }
  .rtab-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .rtab-x {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    padding: 0;
    border: none;
    background: transparent;
    border-radius: var(--r-xs, 4px);
    color: var(--text-faint);
    flex: none;
    cursor: pointer;
  }
  .rtab-x :global(svg) {
    width: 11px;
    height: 11px;
  }
  .rtab-x:hover {
    background: var(--surface-inset);
    color: var(--text);
  }

  .tabstrip-spacer {
    flex: 1;
  }
  /* ---- Docked action icons (stand in for the top bar's buttons) ---- */
  .rcompact {
    display: flex;
    align-items: center;
    gap: 1px;
    padding-right: 4px;
    flex: none;
  }
  .rc-btn {
    display: grid;
    place-items: center;
    width: 24px;
    height: 22px;
    padding: 0;
    border: none;
    border-radius: var(--r-xs);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
  }
  .rc-btn :global(svg) {
    width: 13px;
    height: 13px;
  }
  .rc-btn:hover:not(:disabled) {
    background: var(--accent-weak);
    color: var(--text);
  }
  .rc-btn[data-on='true'] {
    background: var(--accent-weak);
    color: var(--accent);
  }
  .rc-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }
  /* ---- Prompt templates dropdown ---- */
  .rtmpl-backdrop {
    position: fixed;
    inset: 0;
    z-index: 30;
    background: transparent;
    border: none;
    cursor: default;
  }
  .rtmpl-menu {
    position: fixed;
    z-index: 31;
    min-width: 220px;
    padding: 4px;
    background: var(--surface);
    border: 1px solid var(--border-strong, var(--border));
    border-radius: var(--r-sm, 8px);
    box-shadow: var(--shadow-md, 0 8px 24px rgba(0, 0, 0, 0.18));
  }
  .rtmpl-head {
    padding: 6px 8px 4px;
    font-family: var(--font-sans);
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-faint);
  }
  .rtmpl-item {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    padding: 7px 8px;
    background: transparent;
    border: none;
    border-radius: var(--r-xs);
    color: var(--text);
    font-family: var(--font-sans);
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
  }
  .rtmpl-item:hover {
    background: var(--accent-weak);
    color: var(--accent);
  }
  .rtmpl-item :global(svg) {
    width: 14px;
    height: 14px;
    flex: none;
    color: var(--text-muted);
  }
  .rtmpl-item:hover :global(svg) {
    color: var(--accent);
  }
  .rtmpl-sep {
    height: 1px;
    margin: 4px 6px;
    background: var(--border);
  }

  /* ---- Custom prompt composer ---- */
  .cprompt-backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
    background: rgba(0, 0, 0, 0.32);
    backdrop-filter: blur(1.5px);
    border: none;
  }
  .cprompt-layer {
    position: fixed;
    inset: 0;
    z-index: 41;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 16vh;
    pointer-events: none;
  }
  .cprompt {
    pointer-events: auto;
    width: min(560px, 92vw);
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--border-strong, var(--border));
    border-radius: var(--r-md, 12px);
    box-shadow: var(--shadow-pop, 0 16px 48px rgba(0, 0, 0, 0.32));
    overflow: hidden;
  }
  .cprompt-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
    font-family: var(--font-sans);
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text);
  }
  .cprompt-head :global(svg) {
    width: 14px;
    height: 14px;
    color: var(--accent);
    flex: none;
  }
  .cprompt-spacer {
    flex: 1;
  }
  .cprompt-x {
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 17px;
    line-height: 1;
    padding: 0 2px;
  }
  .cprompt-x:hover {
    color: var(--text);
  }
  .cprompt-context {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 14px;
    background: var(--surface-inset);
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
    overflow: hidden;
  }
  .cprompt-ctx-label {
    flex: none;
    font-family: var(--font-mono);
    font-size: 9px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .cprompt-ctx-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: var(--font-sans);
    font-size: 12px;
    color: var(--text-secondary);
  }
  .cprompt-ctx-cite {
    flex: none;
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--accent);
  }
  /* Multi-paper checklist (shares the composer chrome). */
  .mprompt-list {
    max-height: 190px;
    overflow-y: auto;
    padding: 6px;
    background: var(--surface-inset);
    border-bottom: 1px solid var(--border);
  }
  .mprompt-row {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 6px 8px;
    border-radius: var(--r-xs);
    cursor: pointer;
  }
  .mprompt-row:hover {
    background: var(--surface);
  }
  .mprompt-row input {
    flex: none;
    accent-color: var(--accent);
    cursor: pointer;
  }
  .mprompt-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-sans);
    font-size: 12px;
    color: var(--text);
  }
  .mprompt-cite {
    flex: none;
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--accent);
  }

  .cprompt-area {
    resize: none;
    min-height: 120px;
    padding: 12px 14px;
    background: transparent;
    border: none;
    outline: none;
    color: var(--text);
    font-family: var(--font-sans);
    font-size: 13px;
    line-height: 1.5;
  }
  .cprompt-foot {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-top: 1px solid var(--border);
  }
  .cprompt-hint {
    flex: 1;
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-faint);
  }
  .cprompt-send {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 12px;
    background: var(--accent);
    border: none;
    border-radius: var(--r-xs);
    color: var(--accent-fg, #fff);
    font-family: var(--font-sans);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .cprompt-send:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .cprompt-send :global(svg) {
    width: 13px;
    height: 13px;
  }

  /* ---- PDF stage + notes ---- */
  .rstage {
    flex: 1;
    min-height: 0;
    display: flex;
    position: relative;
  }
  /* Covers the PDF iframe while dragging so pointermove keeps firing here. */
  .rstage[data-resizing='true']::after {
    content: '';
    position: absolute;
    inset: 0;
    z-index: 5;
    cursor: col-resize;
  }
  .rpanes {
    position: relative;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }
  .rpane {
    position: absolute;
    inset: 0;
    display: none;
  }
  .rpane[data-on='true'] {
    display: block;
  }
  .rframe {
    width: 100%;
    height: 100%;
    border: 0;
  }
  .rmsg {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    text-align: center;
    color: var(--text-muted);
    padding: 40px;
  }
  .rmsg :global(svg) {
    width: 28px;
    height: 28px;
    color: var(--text-faint);
  }
  .rmsg p {
    margin: 0;
    font-family: var(--font-sans);
    font-size: 14px;
    color: var(--text-secondary);
  }
  .rmsg small {
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 11px;
    max-width: 420px;
    word-break: break-all;
  }

  /* ---- Find panel (⌘F / semantic) ---- */
  /* Floats over the top-right of the PDF: the viewer is an opaque plugin, so the
     result list is the only place hits can be shown. */
  .rfind {
    position: absolute;
    top: 10px;
    right: 14px;
    z-index: 12;
    width: min(480px, calc(100% - 28px));
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--border-strong, var(--border));
    border-radius: var(--r-sm, 8px);
    box-shadow: var(--shadow-md, 0 8px 24px rgba(0, 0, 0, 0.22));
    overflow: hidden;
  }
  .rfind-bar {
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 8px;
  }
  .rfind-modes {
    flex: none;
    display: flex;
    padding: 2px;
    background: var(--surface-inset);
    border-radius: var(--r-xs);
  }
  .rfind-modes button {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    background: transparent;
    border: none;
    border-radius: var(--r-xs);
    color: var(--text-muted);
    font-family: var(--font-sans);
    font-size: 11px;
    cursor: pointer;
  }
  .rfind-modes button:hover {
    color: var(--text-secondary);
  }
  .rfind-modes button[data-on='true'] {
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow-xs, 0 1px 2px rgba(0, 0, 0, 0.18));
  }
  .rfind-modes :global(svg) {
    width: 11px;
    height: 11px;
  }
  .rfind-input {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 8px;
    height: 26px;
    background: var(--surface-inset);
    border: 1px solid var(--border);
    border-radius: var(--r-xs);
  }
  .rfind-input:focus-within {
    border-color: var(--accent);
  }
  .rfind-input :global(svg) {
    width: 12px;
    height: 12px;
    flex: none;
    color: var(--text-faint);
  }
  .rfind-input input {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    outline: none;
    color: var(--text);
    font-family: var(--font-sans);
    font-size: 12.5px;
  }
  .rfind-count {
    flex: none;
    min-width: 34px;
    text-align: right;
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-faint);
  }
  .rfind-nav {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: var(--r-xs);
    color: var(--text-muted);
    cursor: pointer;
  }
  .rfind-nav:hover:not(:disabled) {
    background: var(--surface-inset);
    color: var(--text);
  }
  .rfind-nav:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .rfind-nav :global(svg) {
    width: 12px;
    height: 12px;
  }
  .rfind-ask {
    flex: none;
    padding: 5px 10px;
    background: var(--accent);
    border: none;
    border-radius: var(--r-xs);
    color: var(--accent-fg, #fff);
    font-family: var(--font-sans);
    font-size: 11.5px;
    font-weight: 600;
    cursor: pointer;
  }
  .rfind-ask:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .rfind-x {
    flex: none;
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-size: 16px;
    line-height: 1;
    padding: 0 2px;
    cursor: pointer;
  }
  .rfind-x:hover {
    color: var(--text);
  }
  .rfind-body {
    flex: none;
    max-height: min(46vh, 420px);
    overflow-y: auto;
    border-top: 1px solid var(--border);
    scrollbar-width: thin;
  }
  .rfind-note {
    padding: 12px 14px;
    font-family: var(--font-sans);
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--text-muted);
  }
  .rfind-note--err {
    color: var(--danger);
  }
  .rfind-summary {
    display: flex;
    gap: 8px;
    padding: 11px 12px;
    background: var(--accent-weak);
    border-bottom: 1px solid var(--border);
  }
  .rfind-summary :global(svg) {
    width: 13px;
    height: 13px;
    flex: none;
    color: var(--accent);
    margin-top: 1px;
  }
  .rfind-summary p {
    margin: 0;
    font-family: var(--font-sans);
    font-size: 12px;
    line-height: 1.5;
    color: var(--text);
  }
  .rfind-list {
    list-style: none;
    margin: 0;
    padding: 4px;
  }
  .rfind-hit {
    display: flex;
    gap: 8px;
    width: 100%;
    padding: 7px 8px;
    background: transparent;
    border: none;
    border-radius: var(--r-xs);
    text-align: left;
    cursor: pointer;
  }
  .rfind-hit:hover,
  .rfind-hit[data-on='true'] {
    background: var(--surface-inset);
  }
  .rfind-page {
    flex: none;
    padding-top: 1px;
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--accent);
  }
  .rfind-snippet {
    flex: 1;
    min-width: 0;
    font-family: var(--font-sans);
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--text-secondary);
  }
  .rfind-snippet :global(mark) {
    background: var(--accent-weak);
    color: var(--accent);
    border-radius: 2px;
  }
  .rfind-quote {
    display: block;
    color: var(--text);
  }
  /* The model couldn't be matched back to the extracted text — show it as its
     own wording rather than as the paper's. */
  .rfind-quote.loose {
    color: var(--text-muted);
    font-style: italic;
  }
  .rfind-why {
    display: block;
    margin-top: 3px;
    font-size: 10.5px;
    color: var(--text-faint);
  }

  /* ---- Notes side panel ---- */
  /* A hairline divider with a wider invisible grab zone straddling it. */
  .rnotes-grip {
    flex: none;
    width: 7px;
    margin-right: -3px;
    z-index: 6;
    cursor: col-resize;
    background: transparent;
    transition: background 90ms ease;
  }
  .rnotes-grip:hover,
  .rnotes-grip[data-on='true'] {
    background: var(--accent);
  }
  .rnotes {
    flex: none;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-left: 1px solid var(--border);
    background: var(--surface-inset);
  }
  .rnotes-head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    color: var(--text);
  }
  .rnotes-head :global(svg) {
    width: 14px;
    height: 14px;
    flex: none;
    color: var(--text-muted);
  }
  /* Title over authors, so the pane says whose paper you're annotating. */
  .rnotes-id {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .rnotes-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-sans);
    font-weight: 600;
    font-size: 12px;
  }
  .rnotes-authors {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-faint);
  }
  .rnotes-spacer {
    flex: none;
  }
  .rnotes-state {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-faint);
  }
  .rnotes-state--err {
    color: var(--danger);
    background: transparent;
    border: none;
    padding: 0;
    cursor: pointer;
    white-space: nowrap;
  }
  .rnotes-state--err:hover {
    text-decoration: underline;
  }
  .rnotes-x {
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
    padding: 0 2px;
  }
  .rnotes-x:hover {
    color: var(--text);
  }
  .rnotes-loading {
    margin: 24px auto;
    color: var(--text-muted);
    font-size: 12px;
  }
  /* The Editor is flex:1 inside its parent — give it a flex column to fill. */
  .rnotes-body {
    flex: 1;
    min-height: 0;
    display: flex;
    /* No gutter — the editor's own surface tone separates it from the panel. */
    padding: 0;
  }
  .rnotes-foot {
    flex: none;
    padding: 7px 12px;
    border-top: 1px solid var(--border);
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
