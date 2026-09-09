<script lang="ts">
  import LibrarySetup from './lib/LibrarySetup.svelte'
  import Onboarding from './lib/Onboarding.svelte'
  import Terminal from './lib/Terminal.svelte'
  import Icon from './lib/Icon.svelte'
  import PaperTable from './lib/PaperTable.svelte'
  import Inspector from './lib/Inspector.svelte'
  import QuartoView from './lib/QuartoView.svelte'
  import GitPanel from './lib/GitPanel.svelte'
  import Inquiries from './lib/Inquiries.svelte'
  import Reader from './lib/Reader.svelte'
  import TagManager from './lib/TagManager.svelte'
  import WritingRules from './lib/WritingRules.svelte'
  import ClaudeSetup from './lib/ClaudeSetup.svelte'
  import BulkRename from './lib/BulkRename.svelte'
  import ManualRefs from './lib/ManualRefs.svelte'
  import ReviewPanel from './lib/ReviewPanel.svelte'
  import QuickOpen from './lib/QuickOpen.svelte'
  import { inquiryRun } from './lib/inquiryRun.svelte'
  import FolderPicker from './lib/FolderPicker.svelte'
  import { addPapers as pickPapers, hostInfo } from './lib/pick'
  import { EditorView } from '@codemirror/view'
  import { openSearchPanel } from '@codemirror/search'
  import type { WorkspaceToolbar } from './lib/QuartoView.svelte'
  import type { ReaderToolbar } from './lib/Reader.svelte'
  import type { ProjectSummary, ResolvedPaper, ProjectPapers, Tag, Group, PaperPatch } from './global'

  type Sort = { key: string; dir: 'asc' | 'desc' }

  // ---- shell state ----------------------------------------------------------
  let libraryRoot = $state<string | null>(null)
  let ready = $state(false)
  // Saved choice wins; otherwise follow the OS.
  const savedTheme = localStorage.getItem('lctrn:theme')
  let theme = $state<'dark' | 'light'>(
    savedTheme === 'light' || savedTheme === 'dark'
      ? savedTheme
      : window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
  )
  let view = $state<'library' | 'project'>('library')
  // Top-level modes. ⌃Tab cycles through the visible "apps" (Papers / Workspace,
  // plus Reader once a paper's PDF is open — ⌘1–9 also jumps to a Reader tab).
  let mode = $state<'papers' | 'workspace' | 'reader'>('papers')
  let inspectorOn = $state(true)
  let paperSidebarOn = $state(true)
  // Workspace (QuartoView) panels — left outline, right margin-notes.
  let workspaceOutlineOn = $state(true)
  let workspaceNotesOn = $state(true)
  // Once Reader/Workspace have been opened we keep them mounted and just hide
  // them with display:none on mode switch — this preserves loaded PDFs, scroll
  // and zoom (see .view.hidden) instead of re-rendering from scratch each time.
  let readerMounted = $state(false)
  let workspaceMounted = $state(false)
  // ---- reader dock ----------------------------------------------------------
  // The Reader can sit beside the Workspace/Papers instead of replacing them —
  // a paper open next to what you're writing. It is the SAME component instance
  // either way: docking only changes the width of its slot, so the PDF, its
  // scroll and its zoom survive the switch (same reasoning as .view.hidden).
  const DOCK_KEY = 'lctrn.readerDock'
  const DOCK_W_KEY = 'lctrn.readerDockWidth'
  const DOCK_W_DEFAULT = 460
  const DOCK_W_MIN = 320
  const DOCK_W_MAX = 900
  let dockOn = $state(localStorage.getItem(DOCK_KEY) === '1')
  let dockW = $state(
    (() => {
      const n = Number(localStorage.getItem(DOCK_W_KEY))
      return Number.isFinite(n) && n >= DOCK_W_MIN ? Math.min(n, DOCK_W_MAX) : DOCK_W_DEFAULT
    })()
  )
  let dockResizing = $state(false)
  let readerSlotEl = $state<HTMLDivElement | null>(null)
  function toggleDock(): void {
    dockOn = !dockOn
    localStorage.setItem(DOCK_KEY, dockOn ? '1' : '0')
    // Turning the dock on from the Reader is "put this back beside my work" —
    // there's nowhere for it to appear until we leave Reader mode.
    if (dockOn && mode === 'reader') mode = workspaceMounted ? 'workspace' : 'papers'
    if (dockOn) readerMounted = true
  }
  // The PDF is an iframe and swallows pointer events mid-drag, so the gutter
  // drag runs off a shield over the whole stage (same trick as the Reader's own
  // notes divider).
  function startDockResize(e: PointerEvent): void {
    e.preventDefault()
    const startX = e.clientX
    const startW = dockW
    dockResizing = true
    const onMove = (ev: PointerEvent): void => {
      dockW = Math.min(DOCK_W_MAX, Math.max(DOCK_W_MIN, startW + (startX - ev.clientX)))
    }
    const onUp = (): void => {
      dockResizing = false
      localStorage.setItem(DOCK_W_KEY, String(dockW))
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  /** Is the caret (or the focused PDF iframe) inside the docked Reader? */
  function focusInDock(): boolean {
    const el = document.activeElement
    return !!(docked && readerSlotEl && el && readerSlotEl.contains(el))
  }
  $effect(() => {
    if (mode === 'reader' || docked) readerMounted = true
    if (mode === 'workspace') workspaceMounted = true
  })
  let termOpen = $state(true)
  let onboarding = $state(false)
  let inquiriesOpen = $state(false) // library-level "talk to your literature" modal
  // Which inquiry the modal should land on when reopened (set by the running chip).
  let inquiryOpenSlug = $state<string | null>(null)
  // The inquiry pty outlives the modal, so the exit has to be watched from here
  // — otherwise the "working" chip would stick around after Claude finished.
  $effect(() =>
    window.api.pty.onExit('inquiry', () => {
      inquiryRun.running = false
    })
  )
  let bulkRenameOpen = $state(false) // bulk "rename files to house style" modal
  let manualRefsOpen = $state(false) // project manual-references (extra.bib) modal
  let reviewOpen = $state(false) // checkpoint review of Claude's edits
  // Unreviewed turns, shown on the toolbar chip. Recomputed on project switch
  // and whenever a turn starts or ends — no polling; the hook bridge tells us.
  let reviewCount = $state(0)
  let projectMenuOpen = $state(false) // workspace project switcher
  let quickOpen = $state(false) // ⌘O paper quick-open palette (opens into the Reader)

  // ---- data -----------------------------------------------------------------
  let projects = $state<ProjectSummary[]>([])
  let selected = $state<ProjectSummary | null>(null)
  let libraryPapers = $state<ResolvedPaper[]>([])
  let tags = $state<Tag[]>([])
  let groups = $state<Group[]>([])
  let tagFilter = $state<string | null>(null)
  // "Smart" library views that scope by something other than a single tag —
  // recency ('added'/'interacted') or papers with no tags at all ('untagged').
  // Mutually exclusive with `tagFilter`; null means the plain "All Papers" list.
  let smartView = $state<'added' | 'interacted' | 'untagged' | 'reading' | null>(null)
  // A paper counts as "recent" if its timestamp falls within this rolling window.
  const RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
  let collapsedGroups = $state<Set<string>>(new Set())
  let tagManagerOpen = $state(false)
  let writingRulesOpen = $state(false)
  // Where you point Lectern at your Claude — see ClaudeSetup.svelte. Opened
  // from the menu, and from the terminal when `claude` isn't installed.
  let claudeSetupOpen = $state(false)
  let projectPapers = $state<ProjectPapers>({ selected: [], available: [] })
  let adding = $state(false)

  // ---- checkpoint review ------------------------------------------------------
  async function refreshReviewCount(): Promise<void> {
    const pp = selected?.path
    if (!pp) {
      reviewCount = 0
      return
    }
    const s = await window.api.projects.review.state(pp)
    if (pp === selected?.path) reviewCount = s.checkpoints.length
  }
  $effect(() => {
    selected?.path
    reviewCount = 0
    void refreshReviewCount()
    return window.api.projects.review.onChanged((p) => {
      if (p === selected?.path) void refreshReviewCount()
    })
  })

  // ---- reader (tabbed PDF view) ---------------------------------------------
  // Papers the user has explicitly opened, in tab order. ⌘1–9 jumps to a tab.
  let readerTabs = $state<ResolvedPaper[]>([])
  let readerActiveId = $state<string | null>(null)
  // In Reader mode the Reader owns the window regardless — the dock is what it
  // does while some OTHER app is on screen. No tabs, nothing to dock.
  const docked = $derived(dockOn && mode !== 'reader' && readerTabs.length > 0)

  // ---- table interaction ----------------------------------------------------
  let activeId = $state<string | null>(null)
  let sort = $state<Sort>({ key: 'added', dir: 'desc' })

  let searchEl = $state<HTMLInputElement | null>(null)
  // The results table exposes row focus so ⌘K → tab lands in the list.
  let tableRef = $state<{ focusList: () => void } | null>(null)
  let query = $state('')
  let termRef = $state<{
    dispatchClaude: (
      kickoff: string,
      opts?: { project?: ProjectSummary | null }
    ) => Promise<void>
  } | null>(null)
  // The Reader's find bar and action buttons are driven from here: ⌘F (a menu
  // accelerator) opens find, and the top bar hosts Prompt / Find / Notes so the
  // tabstrip below stays tabs-only.
  let readerRef = $state<{
    openFind: () => void
    toggleFind: () => void
    toggleNotes: () => void
    togglePromptMenu: (anchor?: HTMLElement | null) => void
    promptMultiple: () => void
    reload: () => void
  } | null>(null)
  let promptBtn = $state<HTMLButtonElement | null>(null)
  let readerToolbar = $state<ReaderToolbar>({
    hasTabs: false,
    canReload: false,
    canPrompt: false,
    canMultiPrompt: false,
    promptMenuOpen: false,
    findOpen: false,
    notesOn: true
  })
  let quartoRef = $state<{
    renderShortcut: () => void
    toggleLog: () => void
    exportAs: (format: 'pdf' | 'html') => void
    openPdf: () => Promise<void>
    togglePreviewPane: () => void
    toggleRevisingMode: () => void
    focusPanel: (side: 'left' | 'right') => Promise<void>
  } | null>(null)
  // The workspace's toolbar lives in the single top bar; QuartoView publishes the
  // state it renders from here, and the bar calls back through `quartoRef`.
  let wsToolbar = $state<WorkspaceToolbar>({
    loading: true,
    rendering: false,
    previewOn: false,
    revising: false,
    openNotes: 0
  })
  let exportMenu = $state(false) // PDF / HTML dropdown on the Export button

  const SWATCHES =['var(--data-cyan)', 'var(--data-violet)', 'var(--data-green)', 'var(--data-amber)']

  // ---- boot -----------------------------------------------------------------
  async function boot(): Promise<void> {
    libraryRoot = await window.api.library.get()
    if (libraryRoot) {
      const [, , last] = await Promise.all([
        loadProjects(),
        loadLibrary(),
        window.api.projects.lastOpened()
      ])
      // Reopen whatever project was open when the app last quit, so a relaunch
      // lands where you left off. Falls through silently if it's since been
      // renamed or deleted.
      const p = last ? projects.find((x) => x.path === last) : null
      if (p) selected = p
    }
    ready = true
  }
  boot()

  // Live-refresh when PDFs are pasted into / removed from the library's .sources folder.
  window.api.library.onChanged(() => {
    void Promise.all([loadLibrary(), loadProjects()]).then(loadProjectPapers)
  })

  // ⌘W (File ▸ Close): close the open paper while reading; otherwise close the
  // window. Handled here rather than in onkeydown because the menu accelerator
  // intercepts ⌘W before it reaches the page.
  window.api.app.onCloseRequest(() => {
    if ((mode === 'reader' || focusInDock()) && readerActiveId) closeReaderTab(readerActiveId)
    else window.api.app.closeWindow()
  })

  // Navigation shortcuts arrive from the app menu's accelerators (see buildMenu
  // in main). They fire app-globally — including while the PDF reader has focus,
  // where a page-level keydown never would — so the tab switcher, reader-tab
  // jumps and quick-open all work regardless of what's focused.
  window.api.app.onShortcut(runShortcut)
  function runShortcut(action: string): void {
    if (action === 'app:papers') setMode('papers')
    else if (action === 'app:workspace') setMode('workspace')
    else if (action === 'app:reader') setMode('reader')
    else if (action === 'app:next') toggleMode()
    else if (action === 'open') quickOpen = true
    else if (action === 'library') showLibrary()
    else if (action === 'search') focusSearch()
    else if (action === 'terminal') termOpen = !termOpen
    else if (action === 'find') runFind()
    else if (action === 'dock') toggleDock()
    else if (action.startsWith('tab:')) {
      const i = parseInt(action.slice(4), 10)
      // In the Workspace ⌘1/⌘2 mean the two rails (outline / notes) — there are
      // no reader tabs on screen there to jump to.
      if (mode === 'workspace' && i < 2) {
        void quartoRef?.focusPanel(i === 0 ? 'left' : 'right')
        return
      }
      if (i < readerTabs.length) {
        readerActiveId = readerTabs[i].id
        // Docked, the jump swaps the paper in the side pane and leaves you where
        // you are; undocked it's a mode switch as before.
        if (!docked) mode = 'reader'
      }
    }
  }

  // ⌘F: "find" means different things per surface, and the accelerator (which has
  // to be app-global — see buildMenu) preempts them all, so route it by hand. A
  // focused CodeMirror editor gets its own find panel back; the Reader opens its
  // find bar; the Papers list falls back to the library filter.
  function runFind(): void {
    // In the Reader the paper is what you're searching, always — mounting a tab
    // leaves the caret in its notes editor, so going by focus would hand ⌘F to
    // the note instead of the PDF.
    if (mode === 'reader') {
      readerRef?.openFind()
      return
    }
    // Docked, ⌘F belongs to whichever side you're actually in — the paper if
    // the caret (or the PDF iframe) is over there, your prose otherwise.
    if (focusInDock()) {
      readerRef?.openFind()
      return
    }
    const el = document.activeElement as HTMLElement | null
    const cmDom = el?.closest?.('.cm-editor') as HTMLElement | null
    // Views are hidden with display:none rather than unmounted, so focus can
    // still sit in an editor the user can't see (e.g. an open paper's notes,
    // while they're back in Papers). Only a VISIBLE editor claims ⌘F.
    const view = cmDom?.getClientRects().length ? EditorView.findFromDOM(cmDom) : null
    if (view) {
      openSearchPanel(view)
      return
    }
    if (mode === 'papers') focusSearch()
  }

  // ⌘K: reveal the Papers sidebar (so the input exists) then focus it.
  function focusSearch(): void {
    mode = 'papers'
    paperSidebarOn = true
    requestAnimationFrame(() => {
      searchEl?.focus()
      searchEl?.select()
    })
  }

  // Search field keys: esc clears and drops focus; tab (or ↓) hands off to the
  // results table, where ↑/↓ walk the rows and ↵ opens the paper in the Reader.
  function onSearchKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.stopPropagation()
      query = ''
      searchEl?.blur()
    } else if ((e.key === 'Tab' && !e.shiftKey) || e.key === 'ArrowDown') {
      if (!sortedPapers.length) return
      e.preventDefault()
      tableRef?.focusList()
    }
  }

  async function loadProjects(): Promise<void> {
    projects = await window.api.projects.list()
    if (selected) selected = projects.find((p) => p.path === selected!.path) ?? null
  }
  async function loadLibrary(): Promise<void> {
    ;[libraryPapers, tags, groups] = await Promise.all([
      window.api.library.papers(),
      window.api.library.tags(),
      window.api.library.groups()
    ])
  }
  async function loadProjectPapers(): Promise<void> {
    if (!selected) {
      projectPapers = { selected: [], available: [] }
      return
    }
    projectPapers = await window.api.projects.papers(selected.path)
  }

  // Reload the active project's papers whenever the project changes.
  $effect(() => {
    selected?.path
    loadProjectPapers()
  })

  // Keep the <html data-theme> attribute in sync and remember the choice.
  $effect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('lctrn:theme', theme)
  })

  async function onLibraryReady(root: string): Promise<void> {
    libraryRoot = root
    await Promise.all([loadProjects(), loadLibrary()])
  }

  // ---- switching library folder ---------------------------------------------
  let libMenuOpen = $state(false)
  // Set only on the localhost host, where there's no native dialog to raise and
  // the folder is browsed on the SERVER's disk instead (see pick.ts).
  let libPicking = $state(false)
  let libPickStart = $state('')

  /**
   * Point lctrn at a different library folder.
   *
   * Opening a library that already exists is cheap and non-destructive: papers
   * carry their metadata in `.lctrn/library.json` and are never re-imported or
   * re-enriched (enrichment skips anything already stamped), PDFs are not
   * renamed, and cached text/embeddings are left alone. The one thing rewritten
   * is `.lctrn/references.bib`, whose `file = {…}` fields hold ABSOLUTE paths
   * that stop being true when a library arrives from another machine.
   *
   * Everything on screen — open reader tabs, the selected project, the paper
   * table — belongs to the old library, so reload rather than trying to
   * reconcile it piecemeal.
   */
  async function changeLibrary(): Promise<void> {
    const host = await hostInfo()
    if (!host.nativePickers) {
      libPickStart = libraryRoot ?? host.home
      libPicking = true
      return
    }
    applyLibraryChange(await window.api.library.choose(libraryRoot))
  }

  async function libraryPicked(path: string): Promise<void> {
    libPicking = false
    applyLibraryChange(await window.api.library.choose(path))
  }

  function applyLibraryChange(root: string | null): void {
    // Null means the picker was dismissed; the same folder means nothing moved.
    if (root && root !== libraryRoot) location.reload()
  }

  // ---- navigation -----------------------------------------------------------
  function resetTableState(): void {
    activeId = null
    adding = false
  }
  function showLibrary(): void {
    view = 'library'
    mode = 'papers'
    tagFilter = null
    smartView = null
    resetTableState()
  }
  function openTag(id: string): void {
    view = 'library'
    mode = 'papers'
    tagFilter = id
    smartView = null
    resetTableState()
  }
  // Smart views: recency views scope to the last 30 days and pre-sort by the
  // matching timestamp; "Not tagged" lists papers with no tags (default sort).
  function openSmart(v: 'added' | 'interacted' | 'untagged' | 'reading'): void {
    view = 'library'
    mode = 'papers'
    tagFilter = null
    smartView = v
    if (v === 'added' || v === 'interacted') sort = { key: v, dir: 'desc' }
    if (v === 'reading') sort = { key: 'reading', dir: 'desc' }
    resetTableState()
  }
  async function createGroup(name: string): Promise<void> {
    await window.api.library.createGroup(name)
    await loadLibrary()
  }
  async function renameGroup(groupId: string, name: string): Promise<void> {
    await window.api.library.renameGroup(groupId, name)
    await loadLibrary()
  }
  async function deleteGroup(groupId: string): Promise<void> {
    await window.api.library.deleteGroup(groupId)
    await loadLibrary()
  }
  async function createTag(name: string): Promise<void> {
    await window.api.library.createTag(name)
    await loadLibrary()
  }
  async function renameTag(tagId: string, name: string): Promise<void> {
    await window.api.library.renameTag(tagId, name)
    await loadLibrary()
  }
  async function reorderTags(
    entries: Array<{ id: string; groupId: string | null }>
  ): Promise<void> {
    await window.api.library.reorderTags(entries)
    await loadLibrary()
  }
  // --- Drag papers onto a sidebar tag to file them under it -------------------
  const PAPER_DND = 'application/x-lctrn-papers'
  let dragOverTagId = $state<string | null>(null)
  function onTagDragOver(e: DragEvent, tagId: string): void {
    if (!e.dataTransfer?.types.includes(PAPER_DND)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    dragOverTagId = tagId
  }
  function onTagDragLeave(tagId: string): void {
    if (dragOverTagId === tagId) dragOverTagId = null
  }
  async function onTagDrop(e: DragEvent, tagId: string): Promise<void> {
    e.preventDefault()
    dragOverTagId = null
    const raw = e.dataTransfer?.getData(PAPER_DND)
    if (!raw) return
    let ids: string[]
    try {
      ids = JSON.parse(raw)
    } catch {
      return
    }
    if (!ids.length) return
    await window.api.library.addTagToPapers(tagId, ids)
    await loadLibrary()
  }
  // --- Reading list ----------------------------------------------------------
  // A standalone queue of papers to read, kept in the registry (`readingAt`) and
  // reachable from its own section at the top of the sidebar. Papers join it by
  // drag-drop onto the section, or from the Inspector's bookmark button.
  let dragOverReading = $state(false)
  const readingCount = $derived(libraryPapers.filter((p) => p.readingAt).length)
  function onReadingDragOver(e: DragEvent): void {
    if (!e.dataTransfer?.types.includes(PAPER_DND)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    dragOverReading = true
  }
  async function onReadingDrop(e: DragEvent): Promise<void> {
    e.preventDefault()
    dragOverReading = false
    const raw = e.dataTransfer?.getData(PAPER_DND)
    if (!raw) return
    let ids: string[]
    try {
      ids = JSON.parse(raw)
    } catch {
      return
    }
    if (ids.length) await setReading(ids, true)
  }
  async function setReading(ids: string[], on: boolean): Promise<void> {
    await window.api.library.setReading(ids, on)
    await loadLibrary()
  }
  async function deleteTag(tagId: string): Promise<void> {
    await window.api.library.deleteTag(tagId)
    if (tagFilter === tagId) tagFilter = null
    await loadLibrary()
  }
  // Opening a project is a Workspace action — projects live in the workspace, not
  // the Papers sidebar. Selecting one drops you into the writing view.
  function openProject(p: ProjectSummary): void {
    selected = p
    void window.api.projects.setLastOpened(p.path)
    view = 'project'
    mode = 'workspace'
    projectMenuOpen = false
    resetTableState()
  }

  // ---- mode switching (⌃Tab) -------------------------------------------------
  function setMode(m: 'papers' | 'workspace' | 'reader'): void {
    if (m === 'reader') {
      if (readerTabs.length) mode = 'reader'
    } else if (m === 'workspace') {
      // Workspace is per-project — adopt the first project if none is open.
      if (!selected && projects.length) selected = projects[0]
      mode = 'workspace'
    } else {
      view = 'library' // the Papers app always shows the library
      mode = 'papers'
    }
  }
  // ⌃Tab cycles through the visible app buttons in order. Reader only joins the
  // rotation when it's present as the middle button (i.e. some tab is open).
  function toggleMode(): void {
    const order: Array<'papers' | 'workspace' | 'reader'> = readerTabs.length
      ? ['papers', 'reader', 'workspace']
      : ['papers', 'workspace']
    const i = order.indexOf(mode)
    setMode(order[(i + 1) % order.length])
  }

  // ---- reader ----------------------------------------------------------------
  function openInReader(p: ResolvedPaper): void {
    if (!p.exists) return
    if (!readerTabs.some((t) => t.id === p.id)) readerTabs = [...readerTabs, p]
    readerActiveId = p.id
    // With the dock open, opening a paper fills the pane beside you rather than
    // yanking you out of the manuscript you were writing.
    if (!dockOn || mode === 'reader') mode = 'reader'
    else readerMounted = true
  }
  function closeReaderTab(id: string): void {
    const idx = readerTabs.findIndex((t) => t.id === id)
    readerTabs = readerTabs.filter((t) => t.id !== id)
    if (readerActiveId === id) {
      readerActiveId = readerTabs[Math.min(idx, readerTabs.length - 1)]?.id ?? null
    }
    if (readerTabs.length === 0 && mode === 'reader') mode = 'papers'
  }

  // Keep open tabs pointing at fresh library data (live metadata enrichment),
  // and drop any tab whose paper was removed from the library.
  $effect(() => {
    const byId = new Map(libraryPapers.map((p) => [p.id, p]))
    const next = readerTabs.map((t) => byId.get(t.id) ?? t).filter((p) => byId.has(p.id))
    const changed =
      next.length !== readerTabs.length || next.some((p, i) => p !== readerTabs[i])
    if (changed) {
      readerTabs = next
      if (readerActiveId && !byId.has(readerActiveId)) {
        readerActiveId = next[0]?.id ?? null
      }
      if (next.length === 0 && mode === 'reader') mode = 'papers'
    }
  })

  async function onProjectCreated(path: string): Promise<void> {
    onboarding = false
    await loadProjects()
    const p = projects.find((x) => x.path === path)
    if (p) openProject(p)
  }

  // ---- derived view data -----------------------------------------------------
  const currentPapers = $derived.by(() => {
    if (view !== 'library') return projectPapers.selected
    if (smartView === 'reading') return libraryPapers.filter((p) => p.readingAt)
    if (smartView === 'untagged') return libraryPapers.filter((p) => !p.tagIds?.length)
    if (smartView) {
      const since = Date.now() - RECENT_WINDOW_MS
      const stamp = (p: ResolvedPaper): number =>
        (smartView === 'added' ? p.addedAt : p.interactedAt) ?? 0
      return libraryPapers.filter((p) => stamp(p) >= since)
    }
    if (!tagFilter) return libraryPapers
    return libraryPapers.filter((p) => p.tagIds?.includes(tagFilter!))
  })
  // Sidebar badge counts for the smart views (recency windows + untagged).
  const recentCounts = $derived.by(() => {
    const since = Date.now() - RECENT_WINDOW_MS
    let added = 0
    let interacted = 0
    let untagged = 0
    for (const p of libraryPapers) {
      if ((p.addedAt ?? 0) >= since) added++
      if ((p.interactedAt ?? 0) >= since) interacted++
      if (!p.tagIds?.length) untagged++
    }
    return { added, interacted, untagged }
  })
  // Unique journals across the library, with their preferred abbreviation — feeds
  // the Inspector's journal picker so a known journal (and its abbrev) is one tap.
  const journals = $derived.by(() => {
    const map = new Map<string, { name: string; abbrev: string }>()
    for (const p of libraryPapers) {
      const name = p.journal?.trim()
      if (!name) continue
      const key = name.toLowerCase()
      const abbrev = p.journalAbbrev?.trim() ?? ''
      const existing = map.get(key)
      if (!existing) map.set(key, { name, abbrev })
      else if (!existing.abbrev && abbrev) existing.abbrev = abbrev
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
  })
  // Sidebar rows: each standalone group renders as a collapsible header with its
  // member tags indented beneath; ungrouped tags follow at the root. One level deep.
  // A row is either a group header (`group`, no `tag`) or a tag (`tag`).
  type TagRow =
    | { group: Group; tag?: undefined; depth: 0; collapsed: boolean; count: number; key: string }
    | { group?: undefined; tag: Tag; depth: 0 | 1; key: string }
  const orderedTags = $derived.by(() => {
    const byTagSort = (a: Tag, b: Tag) => a.sortOrder - b.sortOrder
    const out: TagRow[] = []
    for (const g of [...groups].sort((a, b) => a.sortOrder - b.sortOrder)) {
      const members = tags.filter((t) => t.groupId === g.id).sort(byTagSort)
      if (!members.length) continue
      const collapsed = collapsedGroups.has(g.id)
      out.push({ group: g, depth: 0, collapsed, count: members.length, key: `g:${g.id}` })
      if (collapsed) continue
      for (const m of members) out.push({ tag: m, depth: 1, key: `g:${g.id}>${m.id}` })
    }
    const grouped = new Set(groups.map((g) => g.id))
    for (const t of tags.filter((t) => !t.groupId || !grouped.has(t.groupId)).sort(byTagSort)) {
      out.push({ tag: t, depth: 0, key: t.id })
    }
    return out
  })
  function toggleGroup(id: string): void {
    const next = new Set(collapsedGroups)
    next.has(id) ? next.delete(id) : next.add(id)
    collapsedGroups = next
  }
  const tagCounts = $derived.by(() => {
    const m = new Map<string, number>()
    for (const p of libraryPapers) for (const id of p.tagIds ?? []) m.set(id, (m.get(id) ?? 0) + 1)
    return m
  })
  const activeTag = $derived(tags.find((t) => t.id === tagFilter) ?? null)
  // Free-text search across the active paper set. Every whitespace-separated
  // token must match somewhere in a paper's metadata (AND), case-insensitively.
  const filteredPapers = $derived.by(() => {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (!tokens.length) return currentPapers
    const haystack = (p: ResolvedPaper): string =>
      [p.title, p.citekey, p.year, p.journal, p.journalAbbrev, p.abstract, ...p.authors]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
    return currentPapers.filter((p) => {
      const h = haystack(p)
      return tokens.every((t) => h.includes(t))
    })
  })
  const sortedPapers = $derived.by(() => {
    const dir = sort.dir === 'asc' ? 1 : -1
    // Registry order is insertion order, so the array index is a stable fallback
    // for papers imported before `addedAt` existed.
    const order = new Map(filteredPapers.map((p, i) => [p.id, i]))
    const val = (p: ResolvedPaper): string | number => {
      if (sort.key === 'added') return p.addedAt ?? order.get(p.id) ?? 0
      if (sort.key === 'interacted') return p.interactedAt ?? 0
      if (sort.key === 'reading') return p.readingAt ?? 0
      if (sort.key === 'authors') return p.authors[0] ?? ''
      if (sort.key === 'journal') return (p.journalAbbrev || p.journal || '').toLowerCase()
      if (sort.key === 'year') return p.year ? parseInt(p.year, 10) : 0
      if (sort.key === 'citekey') return p.citekey
      return (p.title || p.citekey).toLowerCase()
    }
    return [...filteredPapers].sort((a, b) => {
      const av = val(a)
      const bv = val(b)
      if (typeof av === 'string') return av.localeCompare(bv as string) * dir
      return ((av as number) - (bv as number)) * dir
    })
  })
  const activePaper = $derived(currentPapers.find((p) => p.id === activeId) ?? null)
  // The inspector is paper-specific, so it only opens in Papers mode once a
  // paper is actually selected in the table.
  const showInspector = $derived(inspectorOn && mode === 'papers' && activePaper != null)
  const showSidebar = $derived(paperSidebarOn && mode === 'papers')

  // Papers ⌘/⇧-clicked in the table. Drives the "N selected" toolbar readout;
  // the table itself owns the selection and prunes it when the view changes.
  let selectedIds = $state<string[]>([])

  // ---- table callbacks -------------------------------------------------------
  function onrowclick(p: ResolvedPaper): void {
    activeId = p.id
    inspectorOn = true
  }
  function onsort(key: string): void {
    sort = { key, dir: sort.key === key && sort.dir === 'asc' ? 'desc' : 'asc' }
  }

  // ---- mutations -------------------------------------------------------------
  async function addPapers(): Promise<void> {
    const added = await pickPapers()
    if (added.length) await Promise.all([loadLibrary(), loadProjects()])
  }
  async function attach(p: ResolvedPaper): Promise<void> {
    if (!selected) return
    await window.api.projects.addPaper(selected.path, p.id)
    await Promise.all([loadProjectPapers(), loadProjects()])
  }
  async function detach(id: string): Promise<void> {
    if (!selected) return
    await window.api.projects.removePaper(selected.path, id)
    await Promise.all([loadProjectPapers(), loadProjects()])
  }
  async function savePaper(id: string, patch: PaperPatch): ReturnType<typeof window.api.library.updatePaper> {
    const res = await window.api.library.updatePaper(id, patch)
    await Promise.all([loadLibrary(), loadProjects()])
    await loadProjectPapers()
    return res
  }

  // Re-run extraction (DOI→Crossref, else PDF) and overwrite the entry's metadata.
  async function refetchPaper(p: ResolvedPaper): Promise<void> {
    await window.api.library.refetchPaper(p.id)
    await Promise.all([loadLibrary(), loadProjects()])
    await loadProjectPapers()
  }

  // Remove a paper from the library (deletes the owned PDF copy in sources/).
  async function deletePaper(p: ResolvedPaper): Promise<void> {
    await window.api.library.removePaper(p.id)
    if (activeId === p.id) activeId = null
    await Promise.all([loadLibrary(), loadProjects()])
    await loadProjectPapers()
  }

  // Rename the PDF on disk to the metadata-derived house style (syncs via Dropbox).
  async function renamePaper(
    p: ResolvedPaper
  ): Promise<{ renamed: boolean; reason?: string; from?: string; to?: string }> {
    const res = await window.api.library.renamePaper(p.id)
    if (res.renamed) {
      await Promise.all([loadLibrary(), loadProjects()])
      await loadProjectPapers()
    }
    return res
  }

  // ---- keyboard --------------------------------------------------------------
  // Navigation shortcuts (⌃Tab app cycle, ⌃1–3 app switch, ⌘1–9 reader tabs,
  // ⌘O quick-open, ⇧⌘K all papers, ⌘K search, ⌘J terminal, ⌘W close) live on the app menu's
  // accelerators (see buildMenu in main → runShortcut above) so they keep
  // working while the PDF reader has focus. What's left here are the
  // Workspace-context keys, which only fire while writing (main frame focused).
  function onkeydown(e: KeyboardEvent): void {
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key.toLowerCase() === 'r') {
      // ⌘R renders the manuscript to PDF (and overrides the default page
      // reload). Press it again while the render is still running to dismiss the
      // log it opened. Only meaningful while writing in the Workspace.
      e.preventDefault()
      if (mode === 'workspace' && selected) quartoRef?.renderShortcut()
    } else if (mod && e.key.toLowerCase() === 'p') {
      // ⌘P shows the rendered manuscript.pdf (overrides the browser print dialog).
      e.preventDefault()
      if (mode === 'workspace' && selected) void quartoRef?.openPdf()
    } else if (mod && e.key.toLowerCase() === 'l') {
      // ⌘L toggles the render-log panel in the Workspace.
      e.preventDefault()
      if (mode === 'workspace' && selected) quartoRef?.toggleLog()
    } else if (mod && e.shiftKey && e.key.toLowerCase() === 'b') {
      // ⇧⌘B is the RIGHT panel everywhere: notes in the Workspace, the inspector
      // in Papers. (⌘B is the left one — same handedness in both apps, so the
      // pair reads the same wherever you are.)
      e.preventDefault()
      if (mode === 'workspace') workspaceNotesOn = !workspaceNotesOn
      else inspectorOn = !inspectorOn
    } else if (mod && e.key.toLowerCase() === 'b') {
      // ⌘B is the LEFT panel: outline in the Workspace, paper sidebar in Papers.
      e.preventDefault()
      if (mode === 'workspace') workspaceOutlineOn = !workspaceOutlineOn
      else paperSidebarOn = !paperSidebarOn
    }
  }

  const libraryName = $derived(libraryRoot ? libraryRoot.replace(/^.*\//, '') || libraryRoot : '')
  const smartLabel = $derived(
    smartView === 'added'
      ? 'Recently Added'
      : smartView === 'interacted'
        ? 'Recently Interacted'
        : smartView === 'untagged'
          ? 'Not tagged'
          : smartView === 'reading'
            ? 'Reading List'
            : ''
  )
  const toolbarTitle = $derived(
    mode === 'workspace'
      ? 'Workspace'
      : view === 'library'
        ? (smartLabel || activeTag?.name || 'All Papers')
        : (selected?.title ?? 'Project')
  )
  const toolbarSub = $derived(
    mode === 'workspace'
      ? selected
        ? ''
        : 'no project selected'
      : view === 'library'
        ? selectedIds.length > 1
          ? `${selectedIds.length} selected · drag onto a tag or the reading list`
          : query.trim()
          ? `${filteredPapers.length} of ${currentPapers.length} · “${query.trim()}”`
          : smartView === 'reading'
            ? `${currentPapers.length} · queued to read`
            : smartView === 'untagged'
            ? `${currentPapers.length} · no tags`
            : smartView
              ? `${currentPapers.length} · last 30 days`
              : activeTag
              ? `${currentPapers.length} · ${activeTag.description || 'tag'}`
              : `${libraryPapers.length}`
        : (selected?.path ?? '')
  )
</script>

<svelte:window {onkeydown} />

{#if !ready}
  <div class="boot">…</div>
{:else if !libraryRoot}
  <LibrarySetup onready={onLibraryReady} />
{:else}
  <div class="lx-app" class:modal-open={manualRefsOpen || reviewOpen}>
    <!-- ---- Top bar (nav + toolbar consolidated into one row) ----
         Zones, left→right, split by hairline dividers like the Slides bar:
         identity · app switcher ‖ contextual context … contextual actions ‖
         global view toggles. The middle zone changes with `mode`. -->
    <div class="topbar" data-mode={mode}>
      <!-- Identity -->
      <div class="tb-brand">
        <b>lctrn</b>
        <button
          class="tb-libbtn"
          title={libraryRoot}
          aria-haspopup="menu"
          aria-expanded={libMenuOpen}
          onclick={() => (libMenuOpen = !libMenuOpen)}
        >
          <span class="tb-lib">{libraryName}</span>
          <span class="caret"><Icon n="chevron-down" /></span>
        </button>
        {#if libMenuOpen}
          <button class="proj-backdrop" aria-label="Close menu" onclick={() => (libMenuOpen = false)}></button>
          <div class="proj-menu lib-menu">
            <div class="lib-path">{libraryRoot}</div>
            <div class="proj-sep"></div>
            <button
              class="proj-row"
              title="Open a different library folder. Existing libraries open as they are — nothing is re-imported or renamed."
              onclick={() => { libMenuOpen = false; void changeLibrary() }}
            >
              <Icon n="folder" />
              <span class="proj-name">Change folder…</span>
            </button>
          </div>
        {/if}
      </div>

      <span class="tb-div" aria-hidden="true"></span>

      <!-- App switcher (⌃Tab) -->
      <div class="tb-seg tb-seg--text" title="Switch app (⌃Tab, or ⌃1–3)">
        <button data-on={mode === 'papers'} title="Papers (⌃1)" onclick={() => setMode('papers')}>Papers</button>
        {#if readerTabs.length}
          <button data-on={mode === 'reader'} title="Reader (⌃2) · jump to a tab with ⌘1–9" onclick={() => setMode('reader')}>Reader</button>
        {/if}
        <button data-on={mode === 'workspace'} title="Workspace (⌃3)" onclick={() => setMode('workspace')}>Workspace</button>
      </div>

      <!-- Contextual zone — depends on the active app -->
      {#if mode === 'workspace'}
        <span class="tb-div" aria-hidden="true"></span>
        <!-- Project switcher. The project-scoped actions (References, Review)
             live inside this menu rather than as their own toolbar buttons. -->
        <div class="proj-switch">
          <button class="btn btn--ghost" onclick={() => (projectMenuOpen = !projectMenuOpen)}>
            <Icon n="folder" />{selected?.title ?? 'Choose project'}<span class="caret"><Icon n="chevron-down" /></span>
            {#if reviewCount}<span class="tb-count">{reviewCount}</span>{/if}
          </button>
          {#if projectMenuOpen}
            <button class="proj-backdrop" aria-label="Close menu" onclick={() => (projectMenuOpen = false)}></button>
            <div class="proj-menu">
              {#each projects as p, i (p.path)}
                <button class="proj-row" data-on={selected?.path === p.path} onclick={() => openProject(p)}>
                  <span class="sb-swatch" style="background: {SWATCHES[i % SWATCHES.length]}"></span>
                  <span class="proj-name">{p.title}</span>
                  <span class="proj-count">{p.paperCount}</span>
                </button>
              {:else}
                <div class="proj-empty">No projects yet.</div>
              {/each}
              <button class="proj-row proj-new" onclick={() => { projectMenuOpen = false; onboarding = true }}>
                <Icon n="plus" />New project
              </button>
              {#if selected}
                <div class="proj-sep"></div>
                <button class="proj-row" title="Review what Claude changed, turn by turn — keep or revert per file" onclick={() => { projectMenuOpen = false; reviewOpen = true }}>
                  <Icon n="diff" />
                  <span class="proj-name">Review changes</span>
                  {#if reviewCount}<span class="tb-count">{reviewCount}</span>{/if}
                </button>
                <button class="proj-row" title="Add references that live outside the library (policy articles, web pages, …)" onclick={() => { projectMenuOpen = false; manualRefsOpen = true }}>
                  <Icon n="file" />
                  <span class="proj-name">References…</span>
                </button>
              {/if}
              <!-- Library-wide, not project-scoped: these rules govern AI writing
                   in every project, so they sit outside the `selected` block. -->
              <div class="proj-sep"></div>
              <button class="proj-row" title="How AI writing should sound — applies to every project" onclick={() => { projectMenuOpen = false; writingRulesOpen = true }}>
                <Icon n="sparkle" />
                <span class="proj-name">AI writing rules…</span>
              </button>
              <button class="proj-row" title="Is Claude Code installed and logged in? Plus the optional API key." onclick={() => { projectMenuOpen = false; claudeSetupOpen = true }}>
                <Icon n="terminal" />
                <span class="proj-name">Claude setup…</span>
              </button>
            </div>
          {/if}
        </div>
        {#if selected}
          <GitPanel projectPath={selected.path} />
        {/if}
        <span class="tb-spacer"></span>
        {#if selected}
          <div class="tb-export">
            <button
              class="iconbtn"
              data-on={exportMenu}
              disabled={wsToolbar.rendering}
              aria-haspopup="menu"
              aria-expanded={exportMenu}
              aria-label="Export"
              title={wsToolbar.rendering ? 'Rendering…' : 'Export the manuscript — ⌘R renders PDF, ⌘P shows it'}
              onclick={() => (exportMenu = !exportMenu)}
            >
              <Icon n={wsToolbar.rendering ? 'refresh' : 'pdf'} />
            </button>
            {#if exportMenu}
              <button class="tb-export-backdrop" aria-label="Close export menu" onclick={() => (exportMenu = false)}></button>
              <div class="tb-export-menu" role="menu">
                <button class="tb-export-item" role="menuitem" onclick={() => { exportMenu = false; quartoRef?.exportAs('pdf') }}>
                  <Icon n="pdf" />PDF
                </button>
                <button class="tb-export-item" role="menuitem" onclick={() => { exportMenu = false; quartoRef?.exportAs('html') }}>
                  <Icon n="file" />HTML
                </button>
              </div>
            {/if}
          </div>
        {/if}
      {:else if mode === 'papers'}
        <span class="tb-div" aria-hidden="true"></span>
        <div class="tb-heading">
          <span class="tb-title">{toolbarTitle}</span>
          {#if toolbarSub}<span class="tb-sub">{toolbarSub}</span>{/if}
        </div>
        <span class="tb-spacer"></span>
        <button class="btn btn--ghost" title="Talk to your literature — ask a question across selected papers" onclick={() => (inquiriesOpen = true)}>
          <Icon n="terminal" />Inquiries
        </button>
        <button class="btn btn--ghost" title="Rename PDF files on disk to the house style from their metadata" onclick={() => (bulkRenameOpen = true)}>
          <Icon n="rename" />Rename
        </button>
        {#if view === 'project'}
          <button class="btn btn--ghost" data-on={adding} title="Attach library papers to this project" onclick={() => (adding = !adding)}>
            <Icon n="plus" />Attach
          </button>
        {/if}
        <button class="btn btn--primary" onclick={addPapers}><Icon n="plus" />Add</button>
      {:else if mode === 'reader'}
        <!-- The Reader's actions: the tabstrip underneath is tabs-only. They
             render from the snapshot the Reader publishes and call back into it. -->
        <span class="tb-spacer"></span>
        {#if readerToolbar.hasTabs}
          <button
            bind:this={promptBtn}
            class="btn btn--ghost"
            class:btn--active={readerToolbar.promptMenuOpen}
            disabled={!readerToolbar.canPrompt}
            aria-haspopup="menu"
            aria-expanded={readerToolbar.promptMenuOpen}
            title={readerToolbar.canPrompt
              ? 'Send a prompt about this paper to Claude'
              : 'Open a paper to use prompt templates'}
            onclick={() => readerRef?.togglePromptMenu(promptBtn)}
          >
            <Icon n="sparkle" />Prompt<span class="tb-caret"><Icon n="chevron-down" /></span>
          </button>
          {#if readerToolbar.canMultiPrompt}
            <button
              class="btn btn--ghost"
              title="Ask Claude about several open papers at once"
              onclick={() => readerRef?.promptMultiple()}
            >
              <Icon n="cards" />Prompt multiple
            </button>
          {/if}
          <button
            class="btn btn--ghost"
            class:btn--active={readerToolbar.findOpen}
            title="Find in this paper (⌘F) — text or meaning"
            onclick={() => readerRef?.toggleFind()}
          >
            <Icon n="search" />Find
          </button>
          <button
            class="btn btn--ghost"
            disabled={!readerToolbar.canReload}
            title="Reload this PDF from disk — picks up annotations made elsewhere"
            onclick={() => readerRef?.reload()}
          >
            <Icon n="refresh" />Refresh
          </button>
          <button
            class="btn btn--ghost"
            class:btn--active={readerToolbar.notesOn}
            title={readerToolbar.notesOn ? 'Hide notes' : 'Show notes'}
            onclick={() => readerRef?.toggleNotes()}
          >
            <Icon n="note" />Notes
          </button>
        {/if}
      {:else}
        <span class="tb-spacer"></span>
      {/if}

      <!-- An inquiry left running in the background: Claude keeps working while
           the modal is closed, so the toolbar carries the way back to it. -->
      {#if inquiryRun.running}
        <button
          class="tb-chip tb-chip--run"
          title="An inquiry is running — click to watch it"
          onclick={() => { inquiryOpenSlug = inquiryRun.slug; inquiriesOpen = true }}
        >
          <span class="tb-pulse"></span>{inquiryRun.title || 'Inquiry'}
        </button>
      {/if}

      <!-- View toggles — one icon cluster, scoped to what the active app has.
           The workspace's panel and mode toggles live here instead of in a
           second toolbar of their own. -->
      <span class="tb-div" aria-hidden="true"></span>
      <div class="tl-actions">
        {#if mode === 'papers'}
          <button class="iconbtn" data-on={inspectorOn} title="Inspector — right panel (⇧⌘B)" onclick={() => (inspectorOn = !inspectorOn)}><Icon n="panel" /></button>
        {:else if mode === 'workspace' && selected}
          <button
            class="iconbtn"
            data-on={workspaceOutlineOn}
            disabled={wsToolbar.loading}
            title="Outline — left panel (⌘B to show/hide, ⌘1 to focus)"
            onclick={() => (workspaceOutlineOn = !workspaceOutlineOn)}
          ><Icon n="list" /></button>
          <button
            class="iconbtn"
            data-on={workspaceNotesOn}
            disabled={wsToolbar.loading}
            title={`Notes & files${
              wsToolbar.openNotes ? ` — ${wsToolbar.openNotes} open` : ''
            } — right panel (⇧⌘B to show/hide, ⌘2 to focus)`}
            onclick={() => (workspaceNotesOn = !workspaceNotesOn)}
          >
            <Icon n="note" />
            {#if wsToolbar.openNotes}<span class="tb-dot"></span>{/if}
          </button>
          <button
            class="iconbtn"
            data-on={wsToolbar.previewOn}
            disabled={wsToolbar.loading}
            title="Preview — render code chunks and show tables/figures inline while you write"
            onclick={() => quartoRef?.togglePreviewPane()}
          ><Icon n="table" /></button>
          <button
            class="iconbtn"
            data-on={wsToolbar.revising}
            disabled={wsToolbar.loading}
            title="Revising — track your manual corrections so Claude learns your style. Toggle on, edit, toggle off; Claude distils durable rules into LEARNED_EDITS.md."
            onclick={() => quartoRef?.toggleRevisingMode()}
          ><Icon n="pen" /></button>
        {/if}
        {#if mode !== 'reader' && readerTabs.length}
          <button
            class="iconbtn"
            data-on={dockOn}
            title="Reader beside (⌘⌥R) — keep a paper open next to your work"
            onclick={toggleDock}
          ><Icon n="pdf" /></button>
        {/if}
        <button class="iconbtn" data-on={termOpen} title="Terminal (⌘J)" onclick={() => (termOpen = !termOpen)}><Icon n="terminal" /></button>
        <!-- Always reachable, unlike the project menu — which only exists in the
             Workspace, and so is invisible to someone who has just installed
             Lectern, has no project yet, and is wondering where their Claude
             goes. -->
        <button class="iconbtn" title="Claude setup — is Claude Code installed and logged in?" onclick={() => (claudeSetupOpen = true)}><Icon n="sparkle" /></button>
        <button class="iconbtn" title="Theme" onclick={() => (theme = theme === 'dark' ? 'light' : 'dark')}><Icon n={theme === 'dark' ? 'sun' : 'moon'} /></button>
      </div>
    </div>

    <div class="body" data-inspector={showInspector} data-sidebar={showSidebar} data-mode={mode}>
      <!-- ---- Sidebar (Papers app only — not shown while writing) ---- -->
      {#if mode === 'papers' && paperSidebarOn}
      <aside class="sidebar">
        <div class="sb-search">
          <div class="searchbox">
            <Icon n="search" />
            <input
              bind:this={searchEl}
              bind:value={query}
              placeholder="Search library…"
              onkeydown={onSearchKey}
            />
            {#if query}
              <button class="search-clear" title="Clear" onclick={() => { query = ''; searchEl?.focus() }}><Icon n="x" /></button>
            {:else}
              <span class="kbd">⌘K</span>
            {/if}
          </div>
        </div>
        <div class="sb-scroll">
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="sb-group sb-reading"
            data-droptarget={dragOverReading}
            ondragover={onReadingDragOver}
            ondragleave={() => (dragOverReading = false)}
            ondrop={onReadingDrop}
          >
            <div class="sb-group__label"><span>Reading List</span></div>
            <button
              class="sb-item"
              data-active={view === 'library' && smartView === 'reading'}
              title="Papers you queued to read — drag papers here to add them"
              onclick={() => openSmart('reading')}
            >
              <span class="sb-ic"><Icon n="bookmark" /></span>
              <span class="sb-name">To read</span>
              <span class="sb-count">{readingCount}</span>
            </button>
          </div>
          <div class="sb-group">
            <div class="sb-group__label"><span>Library</span></div>
            <button class="sb-item" data-active={view === 'library' && !tagFilter && !smartView} title="All Papers (⇧⌘K)" onclick={showLibrary}>
              <span class="sb-ic"><Icon n="library" /></span>
              <span class="sb-name">All Papers</span>
              <span class="sb-count">{libraryPapers.length}</span>
            </button>
            <button class="sb-item" data-active={view === 'library' && smartView === 'added'} title="Added in the last 30 days" onclick={() => openSmart('added')}>
              <span class="sb-ic"><Icon n="clock" /></span>
              <span class="sb-name">Recently Added</span>
              <span class="sb-count">{recentCounts.added}</span>
            </button>
            <button class="sb-item" data-active={view === 'library' && smartView === 'interacted'} title="Notes or annotations changed in the last 30 days" onclick={() => openSmart('interacted')}>
              <span class="sb-ic"><Icon n="pen" /></span>
              <span class="sb-name">Recently Interacted</span>
              <span class="sb-count">{recentCounts.interacted}</span>
            </button>
            <button class="sb-item" data-active={view === 'library' && smartView === 'untagged'} title="Papers with no tags" onclick={() => openSmart('untagged')}>
              <span class="sb-ic"><Icon n="filter" /></span>
              <span class="sb-name">Not tagged</span>
              <span class="sb-count">{recentCounts.untagged}</span>
            </button>
          </div>
          {#if tags.length}
            <div class="sb-group">
              <div class="sb-group__label sb-group__label--row">
                <span>Tags</span>
                <button class="sb-edit" title="Manage groups" onclick={() => (tagManagerOpen = true)}>
                  <Icon n="pen" />
                </button>
              </div>
              {#each orderedTags as row (row.key)}
                {#if row.group}
                  <button
                    class="sb-item sb-grouphead"
                    data-group="true"
                    aria-expanded={!row.collapsed}
                    title={row.collapsed ? 'Expand' : 'Collapse'}
                    onclick={() => toggleGroup(row.group.id)}
                  >
                    <span class="sb-chev" data-collapsed={row.collapsed}>
                      <Icon n="chevron-down" />
                    </span>
                    <span class="sb-name">{row.group.name}</span>
                    <span class="sb-count">{row.count}</span>
                  </button>
                {:else}
                  <button
                    class="sb-item"
                    data-active={view === 'library' && tagFilter === row.tag.id}
                    data-droptarget={dragOverTagId === row.tag.id}
                    style={row.depth ? 'padding-left: 28px' : ''}
                    title={row.tag.description}
                    onclick={() => openTag(row.tag.id)}
                    ondragover={(e) => onTagDragOver(e, row.tag.id)}
                    ondragleave={() => onTagDragLeave(row.tag.id)}
                    ondrop={(e) => onTagDrop(e, row.tag.id)}
                  >
                    <span class="sb-name">{row.tag.name}</span>
                    <span class="sb-count">{tagCounts.get(row.tag.id) ?? 0}</span>
                  </button>
                {/if}
              {/each}
            </div>
          {/if}
        </div>
      </aside>
      {/if}

      <!-- ---- Center ---- -->
      <main class="center">
        <!-- The stage is a row: the app views on the left, the Reader on the
             right. Undocked the Reader's slot takes the whole row (and the views
             hide); docked it becomes a fixed-width column beside them. Either
             way it is one instance in one DOM position — the PDF never reloads. -->
        <div class="stage" class:docked>
        <div class="panes" class:hidden={mode === 'reader'}>
        <!-- Views are kept mounted and toggled with display:none (.view.hidden)
             rather than {#if}-swapped, so PDFs / editors / scroll survive a
             mode switch. Reader & Workspace mount lazily on first open. -->

        <div class="view" class:hidden={mode !== 'workspace'}>
          {#if workspaceMounted}
            {#if selected}
              <QuartoView
                bind:this={quartoRef}
                projectPath={selected.path}
                papers={libraryPapers}
                bind:showOutline={workspaceOutlineOn}
                bind:showNotes={workspaceNotesOn}
                bind:toolbar={wsToolbar}
                onLearnEdits={(kickoff) => void termRef?.dispatchClaude(kickoff, { project: selected })}
                onAddressNotes={(kickoff) => void termRef?.dispatchClaude(kickoff, { project: selected })}
              />
            {:else}
              <div class="ws-empty">
                <h2>No project open</h2>
                <p>Pick a project from the <strong>project menu</strong> at the top, or create one, to start writing its manuscript.</p>
                <button class="btn btn--primary" onclick={() => (onboarding = true)}><Icon n="plus" />New project</button>
              </div>
            {/if}
          {/if}
        </div>

        <div class="view" class:hidden={mode !== 'papers'}>
          {#if view === 'project' && adding}
            <div class="attach-band">
              <div class="attach-head">Attach from library</div>
              {#if projectPapers.available.length === 0}
                <div class="attach-empty">Everything in the library is already attached.</div>
              {:else}
                <ul class="attach-list">
                  {#each projectPapers.available as p (p.id)}
                    <li class="attach-row">
                      <span class="ar-title">{p.title || p.citekey}</span>
                      <span class="ar-meta">{p.year || '—'} · <span class="ar-cite">@{p.citekey}</span></span>
                      <button class="iconbtn ar-add" title="Attach" onclick={() => attach(p)}><Icon n="plus" /></button>
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>
          {/if}

          <PaperTable
            bind:this={tableRef}
            papers={sortedPapers}
            {activeId}
            {sort}
            emptyText={query.trim()
              ? `No papers match “${query.trim()}”.`
              : view === 'library'
                ? smartView === 'reading'
                  ? 'Reading list is empty. Drag papers onto it, or bookmark one in the inspector.'
                  : tagFilter
                  ? 'No papers wired into this tag yet.'
                  : 'No papers yet. Use “Add” to register PDFs into the global pile.'
                : 'No papers attached. Use “Attach” to pull from the library.'}
            {onrowclick}
            onrowopen={openInReader}
            onrowactive={(p) => (activeId = p.id)}
            onselectionchange={(ids) => (selectedIds = ids)}
            {onsort}
          />
        </div>
        </div><!-- /.panes -->

        {#if docked}
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <div
            class="dock-grip"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize reader"
            data-on={dockResizing}
            onpointerdown={startDockResize}
            ondblclick={() => {
              dockW = DOCK_W_DEFAULT
              localStorage.setItem(DOCK_W_KEY, String(DOCK_W_DEFAULT))
            }}
          ></div>
        {/if}

        <div
          bind:this={readerSlotEl}
          class="view reader-slot"
          class:hidden={!docked && mode !== 'reader'}
          style={docked ? `width:${dockW}px` : ''}
        >
          {#if readerMounted}
            <Reader
              bind:this={readerRef}
              bind:toolbar={readerToolbar}
              tabs={readerTabs}
              activeId={readerActiveId}
              compact={docked}
              onselect={(id) => (readerActiveId = id)}
              onclose={closeReaderTab}
              onPrompt={(text) => void termRef?.dispatchClaude(text)}
            />
          {/if}
        </div>

        <!-- Catches pointer moves the PDF iframe would otherwise swallow mid-drag. -->
        {#if dockResizing}<div class="dock-shield"></div>{/if}
        </div><!-- /.stage -->

        <Terminal
          bind:this={termRef}
          {projects}
          {libraryRoot}
          open={termOpen}
          ontoggle={() => (termOpen = !termOpen)}
          onsetup={() => (claudeSetupOpen = true)}
        />
      </main>

      <!-- ---- Inspector ---- -->
      {#if showInspector}
        <Inspector
          paper={activePaper}
          {tags}
          {journals}
          writeLabel={view === 'project' ? 'Write with AI' : null}
          onwrite={() => (termOpen = true)}
          onread={openInReader}
          onreading={(p, on) => setReading([p.id], on)}
          onsave={savePaper}
          onrefetch={refetchPaper}
          onrename={renamePaper}
          ondelete={deletePaper}
        />
      {/if}
    </div>
  </div>

  {#if quickOpen}
    <QuickOpen
      papers={libraryPapers}
      onopen={openInReader}
      onclose={() => (quickOpen = false)}
    />
  {/if}

  {#if onboarding}
    <Onboarding oncreated={onProjectCreated} onclose={() => (onboarding = false)} />
  {/if}

  {#if reviewOpen && selected}
    <ReviewPanel projectPath={selected.path} onclose={() => (reviewOpen = false)} />
  {/if}

  {#if manualRefsOpen && selected}
    <ManualRefs projectPath={selected.path} onclose={() => (manualRefsOpen = false)} />
  {/if}

  {#if inquiriesOpen}
    <Inquiries
      papers={libraryPapers}
      {tags}
      initialSlug={inquiryOpenSlug}
      onclose={() => { inquiriesOpen = false; inquiryOpenSlug = null }}
    />
  {/if}

  {#if bulkRenameOpen}
    <BulkRename
      onclose={() => (bulkRenameOpen = false)}
      ondone={async () => {
        await Promise.all([loadLibrary(), loadProjects()])
        await loadProjectPapers()
      }}
    />
  {/if}

  {#if libPicking}
    <FolderPicker
      start={libPickStart}
      onchoose={libraryPicked}
      oncancel={() => (libPicking = false)}
    />
  {/if}
  {#if claudeSetupOpen}
    <ClaudeSetup onclose={() => (claudeSetupOpen = false)} />
  {/if}
  {#if writingRulesOpen}
    <WritingRules onclose={() => (writingRulesOpen = false)} />
  {/if}

  {#if tagManagerOpen}
    <TagManager
      {tags}
      {groups}
      onCreate={createGroup}
      onRename={renameGroup}
      onDelete={deleteGroup}
      onCreateTag={createTag}
      onRenameTag={renameTag}
      onReorderTag={reorderTags}
      onDeleteTag={deleteTag}
      onclose={() => (tagManagerOpen = false)}
    />
  {/if}
{/if}

<style>
  /* Tags sidebar group: header row with an edit affordance, grouped rows. */
  .sb-group__label--row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .sb-edit {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    padding: 2px;
    border-radius: var(--r-xs);
    color: var(--text-faint);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.12s ease;
  }
  .sb-group:hover .sb-edit {
    opacity: 1;
  }
  .sb-edit:hover {
    color: var(--text);
    background: var(--surface-inset);
  }
  .sb-edit :global(svg) {
    width: 12px;
    height: 12px;
  }
  .sb-item[data-group='true'] .sb-name {
    font-weight: 600;
    color: var(--text-secondary);
  }
  /* Group headers collapse/expand their tags; they don't filter papers. */
  .sb-grouphead {
    margin-top: 4px;
  }
  .sb-chev {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--text-faint);
    transition: transform var(--dur-fast, 0.12s) ease;
  }
  .sb-chev[data-collapsed='true'] {
    transform: rotate(-90deg);
  }
  .sb-chev :global(svg) {
    width: 13px;
    height: 13px;
  }

  /* Reading list: its own queue at the top of the sidebar; papers land on it by
     drag-drop, so the whole section highlights as a drop target. */
  .sb-reading {
    margin-top: 4px;
  }
  .sb-reading[data-droptarget='true'] {
    background: var(--accent-weak);
    box-shadow: inset 2px 0 0 var(--accent);
  }
  /* Trailing chevron on a top-bar menu button (Reader ▸ Prompt). */
  .tb-caret {
    margin-left: 2px;
    color: var(--text-faint);
    display: inline-flex;
    align-items: center;
  }
  .tb-caret :global(svg) {
    width: 12px;
    height: 12px;
  }

  /* The library name in the brand zone doubles as the library switcher. */
  .tb-brand {
    position: relative;
  }
  .tb-libbtn {
    display: flex;
    align-items: center;
    gap: 3px;
    background: transparent;
    border: none;
    padding: 2px 4px;
    border-radius: var(--r-xs);
    cursor: pointer;
  }
  .tb-libbtn:hover {
    background: var(--surface-inset);
  }
  .tb-libbtn .caret {
    display: inline-flex;
    align-items: center;
    color: var(--text-faint);
  }
  .tb-libbtn .caret :global(svg) {
    width: 12px;
    height: 12px;
  }
  .lib-menu {
    min-width: 250px;
  }
  /* The full root, since the bar only has room for the folder's last segment. */
  .lib-path {
    padding: 6px 9px 5px;
    font-family: var(--font-mono);
    font-size: 10.5px;
    line-height: 1.45;
    color: var(--text-faint);
    word-break: break-all;
  }

  /* Workspace project switcher (replaces the sidebar's Projects list).
     The top bar already sets overflow:visible so the dropdown can escape it. */
  .proj-switch {
    position: relative;
  }
  .proj-switch .caret {
    margin-left: 6px;
    color: var(--text-faint);
    display: inline-flex;
    align-items: center;
  }
  .proj-switch .caret :global(svg) {
    width: 14px;
    height: 14px;
  }
  .proj-menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 100;
    min-width: 220px;
    max-height: 360px;
    overflow-y: auto;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-sm);
    box-shadow: var(--shadow-pop, var(--shadow-sm));
    padding: 4px;
  }
  .proj-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    padding: 7px 9px;
    border-radius: var(--r-xs);
    cursor: pointer;
    color: var(--text-secondary);
    font-family: var(--font-sans);
    font-size: 12.5px;
  }
  .proj-row:hover {
    background: var(--surface-inset);
    color: var(--text);
  }
  .proj-row[data-on='true'] {
    background: var(--accent-weak);
    color: var(--text);
  }
  .proj-name {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .proj-count {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-faint);
  }
  .proj-new {
    border-top: 1px solid var(--border);
    margin-top: 2px;
    color: var(--accent);
  }
  .proj-new :global(svg) {
    width: 13px;
    height: 13px;
  }
  /* Project-scoped actions (Review, References) sit under the project list. */
  .proj-sep {
    height: 1px;
    margin: 4px 2px;
    background: var(--border);
  }
  .proj-row :global(svg) {
    width: 13px;
    height: 13px;
    flex: none;
    color: var(--text-muted);
  }
  .proj-backdrop {
    position: fixed;
    inset: 0;
    z-index: 99;
    background: transparent;
    border: none;
    cursor: default;
  }

  /* Export button + its PDF/HTML menu, moved up from the old document toolbar. */
  .tb-export {
    position: relative;
    flex: none;
  }
  .tb-export-backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
    background: transparent;
    border: none;
    cursor: default;
  }
  .tb-export-menu {
    position: absolute;
    z-index: 41;
    top: calc(100% + 4px);
    right: 0;
    min-width: 120px;
    display: flex;
    flex-direction: column;
    padding: 4px;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-sm);
    box-shadow: var(--shadow-lg, var(--shadow-sm));
  }
  .tb-export-item {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 8px;
    background: transparent;
    border: none;
    border-radius: var(--r-xs);
    font-family: var(--font-sans);
    font-size: 12.5px;
    color: var(--text);
    text-align: left;
    cursor: pointer;
  }
  .tb-export-item:hover {
    background: var(--accent-weak);
  }
  .tb-export-item :global(svg) {
    width: 14px;
    height: 14px;
    flex: none;
  }
  .proj-empty {
    padding: 10px;
    font-size: 12px;
    color: var(--text-muted);
  }
  /* Each top-level view fills the center column; inactive ones are hidden
     (kept in the DOM so their state/scroll/loaded PDFs survive mode switches). */
  .view {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .view.hidden {
    display: none;
  }
  /* ---- Stage: app views | grip | reader ---- */
  .stage {
    flex: 1;
    min-height: 0;
    display: flex;
    position: relative;
  }
  .panes {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .panes.hidden {
    display: none;
  }
  /* Undocked the slot fills the stage; docked, the inline width wins and it
     stops stretching. */
  .stage.docked .reader-slot {
    flex: none;
    border-left: 1px solid var(--border);
  }
  .dock-grip {
    flex: none;
    width: 5px;
    margin-right: -3px;
    cursor: col-resize;
    z-index: 4;
    background: transparent;
  }
  .dock-grip:hover,
  .dock-grip[data-on='true'] {
    background: var(--accent-weak);
  }
  .dock-shield {
    position: absolute;
    inset: 0;
    z-index: 20;
    cursor: col-resize;
  }
  .ws-empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    text-align: center;
    color: var(--text-muted);
    padding: 40px;
  }
  .ws-empty h2 {
    margin: 0;
    font-family: var(--font-sans);
    font-weight: 600;
    font-size: 16px;
    color: var(--text-secondary);
  }
  .ws-empty p {
    margin: 0;
    max-width: 380px;
    font-size: 13px;
    line-height: 1.6;
  }
  .attach-band {
    flex: none;
    max-height: 200px;
    overflow-y: auto;
    border-bottom: 1px solid var(--border);
    background: var(--surface-inset);
    padding: 10px 14px;
  }
  .attach-head {
    font-family: var(--font-mono);
    font-size: 9px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-faint);
    margin-bottom: 8px;
  }
  .attach-empty {
    font-family: var(--font-sans);
    font-size: 12px;
    color: var(--text-muted);
  }
  .attach-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .attach-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px 8px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-xs);
  }
  .ar-title {
    flex: 1;
    min-width: 0;
    font-family: var(--font-sans);
    font-size: 12.5px;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ar-meta {
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-muted);
    white-space: nowrap;
  }
  .ar-cite {
    color: var(--accent);
  }
  .ar-add {
    width: 24px;
    height: 24px;
    color: var(--success);
  }
</style>
