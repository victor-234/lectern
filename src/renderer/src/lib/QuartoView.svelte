<script lang="ts">
  import { tick } from 'svelte'
  import Editor from './Editor.svelte'
  import FilePane from './FilePane.svelte'
  import SideFile from './SideFile.svelte'
  import Icon from './Icon.svelte'
  import type { QuartoDoc, ResolvedPaper, ManuscriptNote, CellOutput } from '../global'

  // The document's toolbar lives in the app's single top bar (see App.svelte), not
  // in a second bar of its own. `toolbar` is the read-only snapshot that bar
  // renders from; the actions it triggers are the exported functions below.
  export type WorkspaceToolbar = {
    loading: boolean
    rendering: boolean
    previewOn: boolean
    revising: boolean
    openNotes: number
  }

  let {
    projectPath,
    papers,
    showOutline = $bindable(true),
    showNotes = $bindable(true),
    toolbar = $bindable(),
    onLearnEdits,
    onAddressNotes
  }: {
    projectPath: string
    papers: ResolvedPaper[]
    showOutline?: boolean
    showNotes?: boolean
    toolbar?: WorkspaceToolbar
    onLearnEdits?: (kickoff: string) => void
    onAddressNotes?: (kickoff: string) => void
  } = $props()

  let doc = $state<QuartoDoc | null>(null)
  let initial = $state('') // passed to <Editor>; only changes on load / doc switch (remounts it)
  let draft = $state('') // live content from the editor
  let lastSaved = $state('')
  let loading = $state(true)
  let saving = $state(false)
  let saveError = $state<string | null>(null)

  let rendering = $state(false)
  let log = $state('')
  let showLog = $state(false)
  let lastExitOk = $state<boolean | null>(null)
  // Whether a finished render is handed to the OS viewer (Preview, the browser).
  // Off means the file is still written into the project — you just open it
  // yourself, from the log head or the file pane. Persisted across sessions.
  const OPEN_KEY = 'lctrn:render-open'
  let openAfterRender = $state(localStorage.getItem(OPEN_KEY) !== 'false')
  let lastOutput = $state<string | null>(null)
  let openError = $state<string | null>(null)
  function toggleOpenAfterRender(): void {
    openAfterRender = !openAfterRender
    localStorage.setItem(OPEN_KEY, String(openAfterRender))
  }
  async function openOutput(): Promise<void> {
    if (!lastOutput) return
    openError = null
    const r = await window.api.projects.openOutput(lastOutput)
    if (!r.ok) openError = r.error ?? 'Could not open the file.'
  }
  // Render-log tail-follow: pin the scroll to the bottom as quarto streams output
  // so the latest line is always visible, unless the user scrolls up to read back.
  let logBody = $state<HTMLPreElement | null>(null)
  let logStick = $state(true)
  function onLogScroll(): void {
    if (!logBody) return
    logStick = logBody.scrollHeight - logBody.scrollTop - logBody.clientHeight < 24
  }
  $effect(() => {
    log // re-run as output streams in
    showLog // ...and when the panel is opened
    if (logStick && logBody) logBody.scrollTop = logBody.scrollHeight
  })

  // --- Inline cell preview ---
  // Renders the executable code chunks in the background and shows each one's
  // output inline beneath it, so tables/figures are visible while writing.
  let previewOn = $state(false)
  let cellOutputs = $state<CellOutput[]>([])
  let previewing = $state(false)
  let previewError = $state<string | null>(null)
  let lastPreviewSig = $state('') // code-cell signature of the last successful preview

  // --- Revising mode (track-changes → LEARNED_EDITS.md) ---
  // ON snapshots the manuscript body as a baseline; OFF diffs against it and
  // hands the corrections to Claude (via onLearnEdits) to update LEARNED_EDITS.md.
  let revising = $state(false)
  let revisingSince = $state<string | null>(null)
  let revisingBusy = $state(false)
  let revisingMsg = $state<string | null>(null) // transient footer note (e.g. "no changes")

  async function loadRevising(pp: string): Promise<void> {
    try {
      const s = await window.api.projects.revising.state(pp)
      revising = s.active
      revisingSince = s.startedAt
    } catch {
      revising = false
      revisingSince = null
    }
  }

  async function toggleRevising(): Promise<void> {
    if (!loadedPath || revisingBusy) return
    const pp = loadedPath
    revisingBusy = true
    revisingMsg = null
    try {
      if (!revising) {
        await save() // baseline the latest bytes
        const s = await window.api.projects.revising.start(pp)
        revising = s.active
        revisingSince = s.startedAt
      } else {
        await save() // capture the latest corrections before diffing
        const res = await window.api.projects.revising.finish(pp)
        revising = false
        revisingSince = null
        if (res.hadChanges && res.kickoff) {
          onLearnEdits?.(res.kickoff)
        } else {
          revisingMsg = 'No changes detected since you started revising.'
          setTimeout(() => (revisingMsg = null), 4000)
        }
      }
    } catch (e) {
      revisingMsg = (e as Error).message
    } finally {
      revisingBusy = false
    }
  }

  function sinceLabel(iso: string | null): string {
    if (!iso) return ''
    const d = new Date(iso)
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  // The signature of just the executable code chunks — prose edits don't change
  // it, so they never trigger a (slow) re-render.
  function codeSignature(src: string): string {
    const lines = src.split('\n')
    const parts: string[] = []
    let inFence = false
    let fenceChar = ''
    let fenceLen = 0
    let exec = false
    for (const line of lines) {
      if (!inFence) {
        const open = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/)
        if (open) {
          inFence = true
          fenceChar = open[2][0]
          fenceLen = open[2].length
          exec = /^\{[^}]*\}/.test(open[3].trim())
          if (exec) parts.push('' + open[3].trim())
        }
      } else {
        const close = line.match(/^(\s*)(`{3,}|~{3,})\s*$/)
        if (close && close[2][0] === fenceChar && close[2].length >= fenceLen) {
          inFence = false
          exec = false
        } else if (exec) {
          parts.push(line)
        }
      }
    }
    return parts.join('\n')
  }

  async function runPreview(): Promise<void> {
    if (!loadedPath || previewing) return
    // Claim the slot synchronously so the save() below — which itself re-triggers
    // runPreview on success — can't kick off a duplicate render.
    previewing = true
    previewError = null
    const pp = loadedPath
    try {
      await save() // preview renders from disk — flush any pending edit first
      const sig = codeSignature(draft)
      if (sig === lastPreviewSig && cellOutputs.length) return // unchanged code → keep outputs
      if (!sig.trim()) {
        cellOutputs = []
        lastPreviewSig = sig
        return
      }
      const res = await window.api.projects.previewCells(pp)
      if (res.ok) {
        cellOutputs = res.cells
        lastPreviewSig = sig
      } else {
        previewError = res.error ?? 'Preview failed.'
      }
    } catch (e) {
      previewError = (e as Error).message
    } finally {
      previewing = false
    }
  }

  async function togglePreview(): Promise<void> {
    previewOn = !previewOn
    if (previewOn) {
      lastPreviewSig = ''
      await runPreview()
    } else {
      cellOutputs = []
      previewError = null
    }
  }

  let editorRef = $state<{
    revealLines: (line: number, endLine: number) => void
    replaceRange: (from: number, to: number, text: string) => boolean
  } | null>(null)

  // --- Side file (split editor) ---
  // A project markdown file (revision plan, LEARNED_EDITS.md, …) opened from the
  // file pane and shown in a second editor beside the manuscript. One at a time;
  // clicking the open file again closes the split.
  let sideFile = $state<string | null>(null)
  function openSideFile(name: string): void {
    sideFile = sideFile === name ? null : name
  }

  // --- Manuscript margin notes (right panel + MANUSCRIPT_NOTES.md) ---
  let notes = $state<ManuscriptNote[]>([])
  // Notes the address-notes skill has applied carry a `✅ DONE` marker; hide them
  // from the panel (they stay in MANUSCRIPT_NOTES.md as a record for Claude).
  const openNotes = $derived(notes.filter((n) => n.done === null))
  // The "add note" popover, anchored where the user right-clicked.
  let popover = $state<{
    x: number
    y: number
    line: number
    endLine: number
    /** Character offsets of the selection, so Rewrite can replace it exactly. */
    from: number
    to: number
    snippet: string
  } | null>(null)
  let noteDraft = $state('')

  async function loadNotes(pp: string): Promise<void> {
    try {
      notes = await window.api.projects.notes.list(pp)
    } catch {
      notes = []
    }
  }

  function onContextNote(sel: {
    text: string
    line: number
    endLine: number
    from: number
    to: number
    x: number
    y: number
  }): void {
    noteDraft = ''
    resetRewrite()
    popover = {
      x: sel.x,
      y: sel.y,
      line: sel.line,
      endLine: sel.endLine,
      from: sel.from,
      to: sel.to,
      snippet: sel.text
    }
    showNotes = true
  }

  async function saveNote(): Promise<void> {
    if (!popover || !loadedPath || !noteDraft.trim()) return
    const pp = loadedPath
    notes = await window.api.projects.notes.add(pp, {
      line: popover.line,
      endLine: popover.endLine,
      snippet: popover.snippet,
      note: noteDraft.trim()
    })
    popover = null
    noteDraft = ''
  }

  // --- Rewrite (direct API) ---------------------------------------------------
  // Rewrite the selection against the writing rules and show the result as a
  // proposal. Nothing touches the draft until the author accepts, and accepting
  // goes through a normal editor dispatch so ⌘Z undoes it.

  let rewriteBusy = $state(false)
  let rewriteText = $state<string | null>(null)
  let rewriteSection = $state<string | null>(null)
  let rewriteError = $state('')

  function resetRewrite(): void {
    rewriteBusy = false
    rewriteText = null
    rewriteSection = null
    rewriteError = ''
  }

  /**
   * The heading chain the given line sits under, outermost first — this is how
   * "the rules of the section" get resolved. Walks the parsed outline backwards
   * from the selection, keeping each heading that encloses it (a level-2 that
   * precedes it, then the level-1 above that, …).
   */
  function sectionFor(line: number): string[] {
    const before = outline.filter((h) => h.line <= line)
    const chain: { level: number; text: string }[] = []
    for (let i = before.length - 1; i >= 0; i--) {
      const h = before[i]
      if (!chain.length || h.level < chain[chain.length - 1].level) {
        chain.push({ level: h.level, text: h.text })
        if (h.level === 1) break
      }
    }
    return chain.reverse().map((h) => h.text)
  }

  async function runRewrite(): Promise<void> {
    if (!popover || !loadedPath || rewriteBusy) return
    rewriteBusy = true
    rewriteError = ''
    try {
      const res = await window.api.projects.rewrite({
        projectPath: loadedPath,
        selection: popover.snippet,
        section: sectionFor(popover.line),
        // The note box doubles as an optional steer ("make it shorter").
        instruction: noteDraft.trim() || undefined
      })
      rewriteText = res.text
      rewriteSection = res.section
    } catch (e) {
      // Electron wraps handler errors as "Error invoking remote method 'x':
      // Error: <real message>" — show only the part we wrote.
      const raw = e instanceof Error ? e.message : String(e)
      rewriteError = raw.replace(/^Error invoking remote method '[^']*':\s*Error:\s*/, '')
    } finally {
      rewriteBusy = false
    }
  }

  function acceptRewrite(): void {
    if (!popover || !rewriteText) return
    const ok = editorRef?.replaceRange(popover.from, popover.to, rewriteText)
    if (!ok) {
      rewriteError = 'The document changed while this was generating — rewrite again.'
      return
    }
    popover = null
    noteDraft = ''
    resetRewrite()
  }

  async function deleteNote(id: string): Promise<void> {
    if (!loadedPath) return
    notes = await window.api.projects.notes.delete(loadedPath, id)
  }

  // Notes the address-notes skill has already applied (hidden by default);
  // the "N done" badge toggles them back into view as a muted, read-only record.
  const doneNotes = $derived(notes.filter((n) => n.done !== null))
  const doneCount = $derived(doneNotes.length)
  let showDone = $state(false)

  // Hand the outstanding notes to Claude: ensure the skill exists and drop its
  // kickoff prompt into the embedded terminal (via onAddressNotes). The skill
  // edits manuscript.qmd and marks each note ✅ DONE; the file watcher then
  // reloads the panel and the done notes drop out.
  let addressingBusy = $state(false)
  async function addressNotes(): Promise<void> {
    if (!loadedPath || addressingBusy || openNotes.length === 0) return
    addressingBusy = true
    try {
      const res = await window.api.projects.notes.address(loadedPath)
      if (res.kickoff) onAddressNotes?.(res.kickoff)
    } finally {
      addressingBusy = false
    }
  }

  // Inline editing of an existing note's body.
  let editingId = $state<string | null>(null)
  let editDraft = $state('')

  function startEdit(n: ManuscriptNote): void {
    editingId = n.id
    editDraft = n.note
  }

  async function saveEdit(): Promise<void> {
    if (!editingId || !loadedPath) return
    const id = editingId
    const text = editDraft.trim()
    if (!text) {
      cancelEdit() // empty edit → leave the note unchanged (use × to delete)
      return
    }
    notes = await window.api.projects.notes.update(loadedPath, id, text)
    editingId = null
    editDraft = ''
  }

  function cancelEdit(): void {
    editingId = null
    editDraft = ''
  }

  function noteRange(n: ManuscriptNote): string {
    return n.line === n.endLine ? `L${n.line}` : `L${n.line}–${n.endLine}`
  }

  // --- Document outline (left panel; jumps the editor to a heading) ---

  interface Heading {
    level: number
    text: string
    line: number // 1-based
  }

  // Parse ATX headings (#/##/###) from the draft, skipping YAML front matter
  // and fenced code blocks so `# comments` inside ```{r}``` don't show up.
  function parseOutline(src: string): Heading[] {
    const out: Heading[] = []
    const lines = src.split('\n')
    let inFence = false
    let fence = '' // the ``` or ~~~ char that opened the current block
    let inYaml = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (i === 0 && line.trim() === '---') {
        inYaml = true
        continue
      }
      if (inYaml) {
        if (line.trim() === '---' || line.trim() === '...') inYaml = false
        continue
      }
      const f = line.match(/^\s*(`{3,}|~{3,})/)
      if (f) {
        const marker = f[1][0]
        if (!inFence) {
          inFence = true
          fence = marker
        } else if (marker === fence) {
          inFence = false
          fence = ''
        }
        continue
      }
      if (inFence) continue
      const h = line.match(/^(#{1,3})\s+(.+?)\s*#*\s*$/)
      if (h) {
        // Drop Quarto/Pandoc attribute blocks, e.g. `{#sec-intro .unnumbered}`.
        const text = h[2].replace(/\{[^}]*\}/g, '').trim()
        if (text) out.push({ level: h[1].length, text, line: i + 1 })
      }
    }
    return out
  }

  const outline = $derived(parseOutline(draft))

  // Where the caret is, and therefore which outline row is the current section:
  // the last heading at or above the caret line.
  let cursorLine = $state(1)
  const activeHeading = $derived.by(() => {
    let idx = -1
    for (let i = 0; i < outline.length; i++) {
      if (outline[i].line <= cursorLine) idx = i
      else break
    }
    return idx
  })

  // Long outlines scroll, so keep the lit row in view as the caret walks the doc
  // ('nearest' → no scrolling at all while it's already visible).
  let outlineListEl = $state<HTMLDivElement | undefined>(undefined)
  $effect(() => {
    void activeHeading
    outlineListEl?.querySelector('.outline-item--active')?.scrollIntoView({ block: 'nearest' })
  })

  // The enclosing headings of the active one (a ### under a ## under a #), so the
  // rail shows the whole path you're in rather than a single lit row.
  const activeAncestors = $derived.by(() => {
    const set = new Set<number>()
    if (activeHeading < 0) return set
    let level = outline[activeHeading].level
    for (let i = activeHeading - 1; i >= 0 && level > 1; i--) {
      if (outline[i].level < level) {
        set.add(i)
        level = outline[i].level
      }
    }
    return set
  })

  let saveTimer: ReturnType<typeof setTimeout> | null = null

  const dirty = $derived(draft !== lastSaved)
  const words = $derived(countWords(draft))
  const label = 'Manuscript'

  function countWords(s: string): number {
    const text = s
      .replace(/^---\n[\s\S]*?\n---/, ' ') // drop YAML front matter
      .replace(/```[\s\S]*?```/g, ' ') // drop code chunks
      .replace(/[#>*_`~:[\]@-]/g, ' ')
      .trim()
    return text ? text.split(/\s+/).length : 0
  }

  // The project currently loaded into the editor. Tracked separately from the
  // `projectPath` prop so that, when the user switches project mid-edit, we
  // flush the pending save to the OUTGOING project (not the one we're switching to).
  let loadedPath = $state<string | null>(null)

  // Reload whenever the project changes.
  $effect(() => {
    const pp = projectPath
    void switchTo(pp)
  })

  // --- Live reload of external edits (Claude in the terminal, etc.) ---
  // When the disk version differs from what we last saved, adopt it if the
  // editor is clean; if there are unsaved edits, surface a banner instead of
  // clobbering them. Our own saves are ignored (disk === lastSaved).
  let diskPending = $state<string | null>(null) // disk body awaiting a dirty-conflict decision
  let reloadedFlash = $state(false)

  // Keep the main-process doc watcher pointed at the open project.
  $effect(() => {
    const pp = projectPath
    void window.api.projects.doc.watch(pp)
    return () => void window.api.projects.doc.watch(null)
  })

  $effect(() => {
    return window.api.projects.doc.onChanged(() => {
      void reconcile()
    })
  })

  // MANUSCRIPT_NOTES.md changed on disk (e.g. address-notes marking notes done).
  // Reloading the notes never touches the editor body, so do it unconditionally.
  $effect(() => {
    return window.api.projects.notes.onChanged(() => {
      if (loadedPath) void loadNotes(loadedPath)
    })
  })

  async function reconcile(): Promise<void> {
    if (!loadedPath) return
    const pp = loadedPath
    const d = await window.api.projects.doc.get(pp)
    if (pp !== loadedPath) return // switched docs while reading
    if (d.content === lastSaved) {
      diskPending = null // our own write, or no real change
      return
    }
    if (draft === lastSaved) {
      adoptDisk(d.content) // clean → take the external version
    } else {
      diskPending = d.content // dirty → let the user choose
    }
  }

  function adoptDisk(content: string): void {
    initial = content // remounts the editor with the new bytes
    draft = content
    lastSaved = content
    diskPending = null
    void loadNotes(loadedPath!)
    if (previewOn) void runPreview()
    reloadedFlash = true
    setTimeout(() => (reloadedFlash = false), 1800)
  }

  function keepMine(): void {
    diskPending = null
    void save() // re-assert the editor's version onto disk
  }

  async function switchTo(pp: string): Promise<void> {
    // Yield first so the state reads below are outside the effect's tracking
    // scope — otherwise typing (which mutates `draft`) would retrigger this.
    await Promise.resolve()
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    // Persist any unsaved edit to the doc that's currently loaded.
    if (loadedPath && draft !== lastSaved) {
      try {
        await window.api.projects.doc.save(loadedPath, draft)
      } catch (e) {
        // Surface it: the outgoing document's edits did NOT make it to disk.
        saveError = (e as Error)?.message || 'Could not save the previous document.'
      }
    }
    loading = true
    const d = await window.api.projects.doc.get(pp)
    doc = d
    initial = d.content
    draft = d.content
    lastSaved = d.content
    loadedPath = pp
    loading = false
    popover = null
    diskPending = null
    editingId = null
    // Reset cell preview for the incoming doc; re-run if it's still enabled.
    cellOutputs = []
    lastPreviewSig = ''
    previewError = null
    revisingMsg = null
    void loadNotes(pp)
    void loadRevising(pp)
    if (previewOn) void runPreview()
  }

  // Stream render output for the lifetime of the view.
  $effect(() => {
    const offData = window.api.projects.onRenderData((c) => {
      log += c
    })
    const offExit = window.api.projects.onRenderExit((r) => {
      rendering = false
      lastExitOk = r.ok
      if (r.ok && r.outputPath) lastOutput = r.outputPath
    })
    return () => {
      offData()
      offExit()
    }
  })

  function onChange(v: string): void {
    draft = v
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => void save(), 800)
  }

  async function save(): Promise<void> {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    if (saving || draft === lastSaved || !loadedPath) return
    saving = true
    const pp = loadedPath
    const snapshot = draft
    try {
      await window.api.projects.doc.save(pp, snapshot)
      lastSaved = snapshot
      saveError = null
      // Auto-refresh the inline preview once the edit lands (no-op if the code
      // chunks are unchanged, so prose-only edits don't re-render).
      if (previewOn) void runPreview()
    } catch (e) {
      // Leave lastSaved untouched so the doc stays "dirty" and the next
      // keystroke (or a retry click) attempts the save again.
      saveError = (e as Error)?.message || 'Could not save to disk.'
    } finally {
      saving = false
    }
  }

  async function render(format: 'pdf' | 'html'): Promise<void> {
    if (rendering) return
    await save() // render the latest bytes
    log = ''
    showLog = true
    logStick = true // follow the fresh output from the bottom
    lastExitOk = null
    openError = null
    rendering = true
    try {
      const res = await window.api.projects.render(projectPath, format, openAfterRender)
      if (!res.ok && res.error) log += `\n${res.error}\n`
    } catch (e) {
      log += `\n${(e as Error).message}\n`
      rendering = false
    }
  }

  // Exposed to App.svelte (via bind:this) so the top bar and the global keyboard
  // shortcuts can drive the workspace. ⌘L toggles the render log.
  //
  // ⌘R renders the manuscript to PDF. Starting a render pops the log open;
  // pressing ⌘R again while it's still running doesn't queue a second render, so
  // it toggles that log back out of the way instead.
  export function renderShortcut(): void {
    if (rendering) {
      showLog = !showLog
      return
    }
    void render('pdf')
  }
  export function toggleLog(): void {
    showLog = !showLog
  }
  // ⌘P — show the rendered manuscript.pdf. The PDF render copies it back to the
  // project root, so open it straight from disk instead of re-rendering; if it
  // isn't there yet, say so in the log bar rather than silently doing nothing.
  export async function openPdf(): Promise<void> {
    openError = null
    const path = `${projectPath}/manuscript.pdf`
    const r = await window.api.projects.openOutput(path)
    if (r.ok) {
      lastOutput = path
      return
    }
    openError = 'No manuscript.pdf yet — press ⌘R to render it.'
    showLog = true
  }
  export function exportAs(format: 'pdf' | 'html'): void {
    void render(format)
  }
  export function togglePreviewPane(): void {
    void togglePreview()
  }
  export function toggleRevisingMode(): void {
    void toggleRevising()
  }

  // ⌘1 / ⌘2 — put the keyboard in the outline or the notes rail (revealing it
  // first if it's hidden). Focus lands on something actionable where there is
  // one — the current heading, the first note — so ↵ works straight away;
  // otherwise on the rail itself, which scrolls with the arrow keys.
  let outlineEl = $state<HTMLElement | null>(null)
  let rrailEl = $state<HTMLElement | null>(null)
  export async function focusPanel(side: 'left' | 'right'): Promise<void> {
    if (side === 'left') showOutline = true
    else showNotes = true
    await tick()
    const rail = side === 'left' ? outlineEl : rrailEl
    if (!rail) return
    const target =
      (rail.querySelector(
        side === 'left' ? '.outline-item--active' : '.note-jump'
      ) as HTMLElement | null) ?? rail
    target.focus()
    if (target !== rail) target.scrollIntoView({ block: 'nearest' })
  }

  const saveState = $derived(saving ? 'saving…' : dirty ? 'unsaved' : 'saved')

  // Publish the toolbar snapshot upward. Plain values only — the top bar just
  // renders from it and calls back through the exports above.
  $effect(() => {
    toolbar = {
      loading,
      rendering,
      previewOn,
      revising,
      openNotes: openNotes.length
    }
  })
</script>

<div class="qv">

  {#if diskPending !== null}
    <div class="qv-conflict">
      <Icon n="terminal" />
      <span
        ><code>{doc?.file ?? 'the document'}</code> changed on disk (likely an edit by Claude), but you
        have unsaved edits here.</span
      >
      <span class="qv-spacer"></span>
      <button class="btn btn--secondary" onclick={() => adoptDisk(diskPending!)}>
        Load disk version
      </button>
      <button class="btn btn--ghost" onclick={keepMine}>Keep mine</button>
    </div>
  {/if}

  <div class="qv-body">
    {#if loading}
      <div class="qv-loading">Loading {label.toLowerCase()}…</div>
    {:else}
      {#if showOutline}
        <div class="rail">
          <aside class="outline" bind:this={outlineEl} tabindex="-1">
            <div class="outline-head">Outline</div>
            {#if outline.length === 0}
              <div class="outline-empty">
                No headings yet. Start a line with <code>#</code>, <code>##</code>, or <code>###</code>.
              </div>
            {:else}
              <div class="outline-list" bind:this={outlineListEl}>
                {#each outline as h, i (h.line + ':' + h.text)}
                  <button
                    class="outline-item"
                    class:outline-item--active={i === activeHeading}
                    class:outline-item--ancestor={activeAncestors.has(i)}
                    data-lvl={h.level}
                    title="Jump to line {h.line}"
                    onclick={() => editorRef?.revealLines(h.line, h.line)}
                  >
                    {h.text}
                  </button>
                {/each}
              </div>
            {/if}
          </aside>
        </div>
      {/if}
      <Editor
        bind:this={editorRef}
        value={initial}
        onchange={onChange}
        onsave={save}
        {papers}
        cellOutputs={previewOn ? cellOutputs : []}
        {onContextNote}
        oncursor={(line) => (cursorLine = line)}
        placeholder={'Write your manuscript in Quarto markdown. Type @ to cite a paper; run analyses in ```{r} chunks. Select text and right-click to add a note for Claude.'}
      />

      {#if sideFile}
        <SideFile {projectPath} name={sideFile} {papers} onclose={() => (sideFile = null)} />
      {/if}

      <!-- Right rail: Notes with the project files listed underneath. -->
      {#if showNotes}
        <aside class="rrail" bind:this={rrailEl} tabindex="-1">
        <section class="notes">
          <div class="notes-head">
            <Icon n="note" />
            <span>Notes</span>
            <span class="notes-count">{openNotes.length}</span>
            {#if doneCount > 0}
              <button
                class="notes-done"
                class:notes-done--on={showDone}
                title={showDone ? 'Hide addressed notes' : 'Show addressed notes'}
                onclick={() => (showDone = !showDone)}
              >
                {doneCount} done
              </button>
            {/if}
            <span class="qv-spacer"></span>
            <button class="notes-x" title="Hide panel (⇧⌘B)" onclick={() => (showNotes = false)}>×</button>
          </div>
          {#if openNotes.length > 0}
            <div class="notes-action">
              <button
                class="notes-address"
                title="Apply outstanding notes to the manuscript with Claude"
                disabled={addressingBusy}
                onclick={addressNotes}
              >
                <Icon n="sparkle" />{addressingBusy ? 'Addressing…' : 'Address notes'}
              </button>
            </div>
          {/if}
          {#if openNotes.length === 0 && !(showDone && doneNotes.length > 0)}
            <div class="notes-empty">
              Select text in the manuscript and right-click to add a note. Notes are saved to
              <code>MANUSCRIPT_NOTES.md</code> for Claude.
            </div>
          {:else}
            <div class="notes-list">
              {#each openNotes as n (n.id)}
                <div class="note">
                  <button class="note-jump" title="Jump to this line" onclick={() => editorRef?.revealLines(n.line, n.endLine)}>
                    {noteRange(n)}
                  </button>
                  <button class="note-del" title="Delete note" onclick={() => deleteNote(n.id)}>×</button>
                  <blockquote class="note-snip">{n.snippet}</blockquote>
                  {#if editingId === n.id}
                    <!-- svelte-ignore a11y_autofocus -->
                    <textarea
                      class="note-edit"
                      autofocus
                      bind:value={editDraft}
                      onkeydown={(e) => {
                        if (e.key === 'Escape') cancelEdit()
                        else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void saveEdit()
                      }}
                      onblur={saveEdit}
                    ></textarea>
                    <div class="note-edit-foot">
                      <span class="note-pop-hint">⌘↵ to save · esc to cancel</span>
                    </div>
                  {:else}
                    <div
                      class="note-text"
                      role="button"
                      tabindex="0"
                      title="Click to edit"
                      onclick={() => startEdit(n)}
                      onkeydown={(e) => (e.key === 'Enter' ? startEdit(n) : undefined)}
                    >
                      {n.note}
                    </div>
                  {/if}
                </div>
              {/each}
              {#if showDone}
                {#each doneNotes as n (n.id)}
                  <div class="note note--done">
                    <button class="note-jump" title="Jump to this line" onclick={() => editorRef?.revealLines(n.line, n.endLine)}>
                      {noteRange(n)}
                    </button>
                    <span class="note-done-tag" title="Applied by Claude">✓ done</span>
                    <blockquote class="note-snip">{n.snippet}</blockquote>
                    <div class="note-text">{n.note}</div>
                  </div>
                {/each}
              {/if}
            </div>
          {/if}
        </section>
          <FilePane
            {projectPath}
            active={sideFile}
            onopen={openSideFile}
            ondeleted={(name) => {
              if (sideFile === name) sideFile = null
            }}
          />
        </aside>
      {/if}
    {/if}
  </div>

  {#if popover}
    <!-- backdrop closes the popover on outside click -->
    <button class="note-backdrop" aria-label="Cancel note" onclick={() => (popover = null)}></button>
    <div class="note-pop" style="left:{popover.x}px; top:{popover.y}px;">
      <div class="note-pop-snip">
        <span class="note-pop-range">{popover.line === popover.endLine ? `Line ${popover.line}` : `Lines ${popover.line}–${popover.endLine}`}</span>
        <blockquote>{popover.snippet}</blockquote>
      </div>
      <!-- svelte-ignore a11y_autofocus -->
      <textarea
        class="note-pop-input"
        autofocus
        bind:value={noteDraft}
        placeholder="Note for Claude about this selection — or how to rewrite it…"
        onkeydown={(e) => {
          if (e.key === 'Escape') popover = null
          else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void saveNote()
        }}
      ></textarea>

      {#if rewriteText}
        <div class="rw-out">
          <div class="rw-out__head">
            <Icon n="sparkle" />
            <span>Rewritten{rewriteSection ? ` · ${rewriteSection}` : ''}</span>
          </div>
          <div class="rw-out__body">{rewriteText}</div>
        </div>
      {/if}
      {#if rewriteError}
        <p class="rw-err">{rewriteError}</p>
      {/if}

      <div class="note-pop-foot">
        <span class="note-pop-hint">{rewriteText ? 'Replaces the selection' : '⌘↵ to save'}</span>
        <span class="qv-spacer"></span>
        {#if rewriteText}
          <button class="btn btn--ghost" disabled={rewriteBusy} onclick={runRewrite}>Again</button>
          <button class="btn btn--ghost" onclick={resetRewrite}>Discard</button>
          <button class="btn btn--primary" onclick={acceptRewrite}>Accept</button>
        {:else}
          <button class="btn btn--ghost" onclick={() => (popover = null)}>Cancel</button>
          <button
            class="btn btn--secondary"
            disabled={rewriteBusy}
            title="Rewrite this selection with AI, following your writing rules for this section"
            onclick={runRewrite}
          >
            <Icon n="sparkle" />{rewriteBusy ? 'Rewriting…' : 'Rewrite'}
          </button>
          <button class="btn btn--secondary" disabled={!noteDraft.trim()} onclick={saveNote}>Add note</button>
        {/if}
      </div>
    </div>
  {/if}

  <div class="qv-log" data-open={showLog}>
    <div class="qv-log-bar">
      <button class="qv-log-head" title="Render log (⌘L)" onclick={() => (showLog = !showLog)}>
        <Icon n="terminal" />
        <span>Render log</span>
        {#if lastExitOk === true}<span class="ok">✓ done</span>{/if}
        {#if lastExitOk === false}<span class="fail">✗ failed</span>{/if}
        {#if rendering}<span class="run">running…</span>{/if}
        {#if openError}<span class="fail" title={openError}>✗ could not open</span>{/if}
        <span class="qv-spacer"></span>
      </button>
      <!-- Auto-open, and a manual escape hatch for when it's off. -->
      {#if lastOutput && !openAfterRender}
        <button class="qv-log-act" onclick={() => void openOutput()} title="Open the last rendered file in your viewer">
          <Icon n="external" />Open
        </button>
      {/if}
      <button
        class="qv-log-act"
        data-on={openAfterRender}
        aria-pressed={openAfterRender}
        onclick={toggleOpenAfterRender}
        title={openAfterRender
          ? 'Rendered files open in your viewer — click to keep them in the project only'
          : 'Rendered files stay in the project — click to open them in your viewer'}
      >
        <Icon n="external" />Open after render
      </button>
      <button class="qv-log-chev" aria-label="Toggle render log" onclick={() => (showLog = !showLog)}>
        <span class="chev" data-open={showLog}><Icon n="chevron-down" /></span>
      </button>
    </div>
    {#if showLog}
      <pre class="qv-log-body" bind:this={logBody} onscroll={onLogScroll}>{log || 'No output yet. Click a Render button to produce a document.'}</pre>
    {/if}
  </div>

  <!-- Status line. The save/render state used to sit in a second toolbar; it
       belongs down here with the other passive readouts. -->
  <div class="qv-foot">
    <code class="qv-foot-file">{doc?.file ?? ''}</code>
    · {words} words
    {#if rendering}
      · <span class="run">rendering…</span>
    {:else if saveError}
      · <button class="qv-foot-err" title={saveError} onclick={() => void save()}>
        ⚠ save failed — retry
      </button>
    {:else if reloadedFlash}
      · <span class="qv-foot-ok">↻ updated</span>
    {:else}
      · {saveState}
    {/if}
    {#if previewOn}
      {#if previewing}
        · <span class="run">rendering cells…</span>
      {:else if previewError}
        · <button class="qv-foot-err" title={previewError} onclick={() => void runPreview()}
          >⚠ cell preview failed — retry</button
        >
      {:else if cellOutputs.length}
        · {cellOutputs.length} cell{cellOutputs.length === 1 ? '' : 's'} previewed
      {/if}
    {/if}
    {#if revising}
      · <span class="qv-revising">● revising since {sinceLabel(revisingSince)}</span>
    {:else if revisingMsg}
      · <span class="qv-revising-msg">{revisingMsg}</span>
    {/if}
  </div>
</div>

<style>
  .qv {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    /* Without this the column flex item takes its content's min-content width and
       overflows `.center` to the right (clipping the outline + editor) — most
       visible when resizing the terminal forces a re-measure. */
    min-width: 0;
  }



  .qv-spacer {
    flex: 1;
  }





  /* External-edit conflict banner */
  .qv-conflict {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: var(--accent-weak);
    border-bottom: 1px solid var(--accent-line, var(--border-strong));
    font-family: var(--font-sans);
    font-size: 12px;
    color: var(--text);
  }
  .qv-conflict :global(svg) {
    width: 14px;
    height: 14px;
    flex: none;
    color: var(--accent);
  }
  .qv-conflict code {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-secondary);
  }
  .qv-body {
    flex: 1;
    min-height: 0;
    min-width: 0;
    display: flex;
  }
  .qv-loading {
    margin: 40px auto;
    color: var(--text-muted);
    font-size: 13px;
  }

  /* --- Left rail: outline on top, project-files pane below --- */
  .rail {
    flex: none;
    width: 220px;
    display: flex;
    flex-direction: column;
    gap: 0;
    min-height: 0;
    background: var(--bg-sunken);
    border-right: 1px solid var(--border);
  }
  .outline {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: transparent;
    border: none;
    overflow: hidden;
  }
  /* ⌘1/⌘2 can land on the rail itself (empty outline, no notes) — say where the
     keyboard went instead of moving focus invisibly. */
  .outline:focus-visible,
  .rrail:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }
  .outline-item:focus-visible,
  .note-jump:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }
  .outline-head {
    flex: none;
    padding: 9px 12px 7px;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .outline-empty {
    padding: 4px 12px 14px;
    font-size: 11.5px;
    line-height: 1.6;
    color: var(--text-muted);
  }
  .outline-empty code {
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-secondary);
  }
  .outline-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 0 8px;
    display: flex;
    flex-direction: column;
    gap: 0;
  }
  .outline-item {
    /* The list is a flex column that can now be squeezed (the terminal takes its
       height out of this pane), so rows must not shrink — otherwise they collapse
       and their text paints outside the row box instead of scrolling. */
    flex: none;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: 0;
    padding: 4px 12px;
    cursor: pointer;
    font-family: var(--font-sans);
    font-size: 12.5px;
    line-height: 1.4;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .outline-item:hover {
    background: var(--accent-weak);
    color: var(--text);
  }
  .outline-item[data-lvl='1'] {
    font-weight: 600;
    color: var(--text);
  }
  .outline-item[data-lvl='2'] {
    padding-left: 24px;
  }
  .outline-item[data-lvl='3'] {
    padding-left: 36px;
    font-size: 12px;
    color: var(--text-muted);
  }
  /* "You are here": the heading the caret sits under, plus its enclosing
     headings so the whole path reads at a glance. After the data-lvl rules so
     it wins over the per-level muting. */
  .outline-item--ancestor {
    color: var(--text);
    box-shadow: inset 2px 0 0 var(--accent-line);
  }
  .outline-item--active {
    color: var(--text);
    background: var(--accent-weak);
    box-shadow: inset 2px 0 0 var(--accent);
  }

  /* --- Right rail: Notes above, project files below --- */
  .rrail {
    flex: none;
    width: 280px;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--bg-sunken);
    border-left: 1px solid var(--border);
    overflow: hidden;
  }
  .notes {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }
  .notes-head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
    height: 38px;
    padding: 0 12px;
    border-bottom: 1px solid var(--border);
    font-family: var(--font-sans);
    font-weight: 600;
    font-size: 12px;
    color: var(--text);
  }
  .notes-head :global(svg) {
    width: 14px;
    height: 14px;
  }
  .notes-count {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-on-accent, #fff);
    background: var(--accent);
    border-radius: var(--r-xs);
    padding: 1px 6px;
  }
  .notes-done {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-muted);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--r-xs);
    padding: 1px 6px;
    cursor: pointer;
  }
  .notes-done:hover {
    color: var(--text);
    border-color: var(--border-strong);
  }
  .notes-done--on {
    color: var(--text-on-accent, #fff);
    background: var(--accent);
    border-color: var(--accent);
  }
  /* Address-notes action lives on its own row so the header never wraps. */
  .notes-action {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
  }
  .notes-address {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    width: 100%;
    white-space: nowrap;
    background: var(--accent);
    color: var(--text-on-accent, #fff);
    border: none;
    border-radius: var(--r-xs);
    cursor: pointer;
    font-family: var(--font-sans);
    font-weight: 600;
    font-size: 11px;
    padding: 5px 8px;
  }
  .notes-address:hover:not(:disabled) {
    filter: brightness(1.05);
  }
  .notes-address:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .notes-address :global(svg) {
    width: 12px;
    height: 12px;
  }
  .notes-x {
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
    padding: 0 2px;
  }
  .notes-x:hover {
    color: var(--text);
  }
  .notes-empty {
    padding: 14px;
    font-size: 11.5px;
    line-height: 1.6;
    color: var(--text-muted);
  }
  .notes-empty code {
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-secondary);
  }
  .notes-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0;
  }
  /* Notes read as a list of rows separated by hairlines, not stacked cards. */
  .note {
    flex: none;
    position: relative;
    padding: 10px 12px;
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--border-subtle);
  }
  .note--done {
    opacity: 0.6;
  }
  .note-done-tag {
    margin-left: 6px;
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-muted);
  }
  .note-jump {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--accent);
    background: var(--accent-weak);
    border: none;
    border-radius: var(--r-xs);
    padding: 1px 6px;
    cursor: pointer;
  }
  .note-jump:hover {
    text-decoration: underline;
  }
  .note-del {
    position: absolute;
    top: 6px;
    right: 6px;
    background: transparent;
    border: none;
    color: var(--text-faint);
    cursor: pointer;
    font-size: 15px;
    line-height: 1;
    padding: 0 2px;
  }
  .note-del:hover {
    color: var(--danger);
  }
  .note-snip {
    margin: 6px 0 4px;
    padding-left: 8px;
    border-left: 2px solid var(--border-strong);
    font-family: var(--font-mono);
    font-size: 10.5px;
    line-height: 1.5;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 64px;
    overflow: hidden;
  }
  .note-text {
    margin: 0;
    font-family: var(--font-sans);
    font-size: 12px;
    line-height: 1.5;
    color: var(--text);
    white-space: pre-wrap;
    word-break: break-word;
    cursor: text;
    border-radius: var(--r-xs);
  }
  .note-text:hover {
    background: var(--accent-weak);
  }
  .note-edit {
    width: 100%;
    box-sizing: border-box;
    min-height: 56px;
    resize: vertical;
    margin-top: 2px;
    background: var(--surface);
    border: 1px solid var(--accent);
    border-radius: var(--r-xs);
    padding: 6px 8px;
    font-family: var(--font-sans);
    font-size: 12px;
    line-height: 1.5;
    color: var(--text);
  }
  .note-edit:focus {
    outline: none;
  }
  .note-edit-foot {
    margin-top: 4px;
  }








  /* --- Add-note popover --- */
  .note-backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
    background: transparent;
    border: none;
    cursor: default;
  }
  .note-pop {
    position: fixed;
    z-index: 41;
    /* Wide enough for the Rewrite footer (Again · Discard · Accept) to sit on
       one row alongside the hint. */
    width: 420px;
    max-width: calc(100vw - 24px);
    transform: translate(-50%, 8px);
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-sm);
    box-shadow: var(--shadow-lg, var(--shadow-sm));
    padding: 10px;
  }
  .note-pop-snip {
    margin-bottom: 8px;
  }
  .note-pop-range {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-faint);
  }
  .note-pop-snip blockquote {
    margin: 4px 0 0;
    padding-left: 8px;
    border-left: 2px solid var(--accent-line, var(--border-strong));
    font-family: var(--font-mono);
    font-size: 10.5px;
    line-height: 1.5;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 72px;
    overflow: auto;
  }
  .note-pop-input {
    width: 100%;
    box-sizing: border-box;
    min-height: 64px;
    resize: vertical;
    background: var(--surface-inset, var(--bg-sunken));
    border: 1px solid var(--border);
    border-radius: var(--r-xs);
    padding: 8px;
    font-family: var(--font-sans);
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--text);
  }
  .note-pop-input:focus {
    outline: none;
    border-color: var(--accent);
  }
  /* Rewrite proposal, shown inside the note popover until accepted/discarded. */
  .rw-out {
    margin: 8px 12px 0;
    border: 1px solid var(--accent-line, var(--border-strong));
    border-radius: var(--r-xs);
    background: var(--accent-weak);
    overflow: hidden;
  }
  .rw-out__head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 600;
    color: var(--accent);
  }
  .rw-out__head :global(svg) {
    width: 12px;
    height: 12px;
  }
  .rw-out__body {
    max-height: 220px;
    overflow-y: auto;
    padding: 0 10px 10px;
    font-size: 12.5px;
    line-height: 1.6;
    color: var(--text);
    white-space: pre-wrap;
  }
  .rw-err {
    margin: 8px 12px 0;
    font-size: 11px;
    line-height: 1.5;
    color: var(--danger, var(--text-muted));
  }
  .note-pop-foot {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 8px;
  }
  .note-pop-hint {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-faint);
    white-space: nowrap;
  }

  /* render log — the header stays in flow above the footer, but when open the
     body floats up over the editor/outline (like the terminal dock) instead of
     shrinking `.qv-body`, so the outline keeps its full height underneath. */
  .qv-log {
    flex: none;
    border-top: 1px solid var(--border);
    background: var(--bg-sunken);
    position: relative;
    z-index: 10;
  }
  .qv-log-bar {
    display: flex;
    align-items: center;
    padding-right: 8px;
  }
  .qv-log-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    padding: 7px 12px;
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .qv-log-head :global(svg) {
    width: 13px;
    height: 13px;
    flex: none;
  }
  .qv-log-head .ok {
    color: var(--success);
    text-transform: none;
  }
  .qv-log-head .fail {
    color: var(--danger);
    text-transform: none;
  }
  .qv-log-head .run {
    color: var(--accent);
    text-transform: none;
  }
  /* Toggle + manual open, sitting to the right of the log header. */
  .qv-log-act {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    flex: none;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--r-xs);
    padding: 3px 7px;
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .qv-log-act :global(svg) {
    width: 12px;
    height: 12px;
    flex: none;
  }
  .qv-log-act:hover {
    color: var(--text-secondary);
    border-color: var(--border);
  }
  .qv-log-act[data-on='true'] {
    color: var(--accent);
  }
  .qv-log-chev {
    display: inline-flex;
    align-items: center;
    flex: none;
    background: transparent;
    border: none;
    padding: 7px 4px 7px 6px;
    cursor: pointer;
    color: var(--text-muted);
  }
  .chev {
    display: inline-flex;
    align-items: center;
    transition: transform var(--dur-fast);
  }
  .chev :global(svg) {
    width: 14px;
    height: 14px;
  }
  .chev[data-open='true'] {
    transform: rotate(180deg);
  }
  .qv-log-body {
    /* Float above the header, anchored to its top edge, growing upward over the
       editor + outline rather than pushing them up. */
    position: absolute;
    left: 0;
    right: 0;
    bottom: 100%;
    height: min(38vh, 420px);
    overflow: auto;
    margin: 0;
    padding: 10px 12px;
    background: var(--surface-inset);
    border-top: 1px solid var(--border);
    font-family: var(--font-mono);
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .qv-foot {
    flex: none;
    padding: 7px 12px;
    border-top: 1px solid var(--border);
    background: var(--bg-sunken);
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-faint);
  }
  .qv-foot .run {
    color: var(--accent);
  }
  .qv-foot-err {
    background: transparent;
    border: none;
    padding: 0;
    cursor: pointer;
    font: inherit;
    color: var(--danger);
  }
  .qv-foot-err:hover {
    text-decoration: underline;
  }
  .qv-revising {
    color: var(--accent);
  }
  .qv-revising-msg {
    color: var(--text-muted);
  }
</style>
