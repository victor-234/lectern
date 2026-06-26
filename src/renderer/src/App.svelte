<script lang="ts">
  import LibrarySetup from './lib/LibrarySetup.svelte'
  import Onboarding from './lib/Onboarding.svelte'
  import Terminal from './lib/Terminal.svelte'
  import Icon from './lib/Icon.svelte'
  import PaperTable from './lib/PaperTable.svelte'
  import Inspector from './lib/Inspector.svelte'
  import QuartoView from './lib/QuartoView.svelte'
  import ConfigFiles from './lib/ConfigFiles.svelte'
  import Inquiries from './lib/Inquiries.svelte'
  import Reader from './lib/Reader.svelte'
  import TagManager from './lib/TagManager.svelte'
  import BulkRename from './lib/BulkRename.svelte'
  import ManualRefs from './lib/ManualRefs.svelte'
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
  let workspaceDoc = $state<'manuscript' | 'slides'>('manuscript')
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
  $effect(() => {
    if (mode === 'reader') readerMounted = true
    else if (mode === 'workspace') workspaceMounted = true
  })
  let termOpen = $state(true)
  let onboarding = $state(false)
  let configOpen = $state(false) // project config-files editor modal
  let inquiriesOpen = $state(false) // library-level "talk to your literature" modal
  let bulkRenameOpen = $state(false) // bulk "rename files to house style" modal
  let manualRefsOpen = $state(false) // project manual-references (extra.bib) modal
  let projectMenuOpen = $state(false) // workspace project switcher

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
  let smartView = $state<'added' | 'interacted' | 'untagged' | null>(null)
  // A paper counts as "recent" if its timestamp falls within this rolling window.
  const RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
  let collapsedGroups = $state<Set<string>>(new Set())
  let tagManagerOpen = $state(false)
  let projectPapers = $state<ProjectPapers>({ selected: [], available: [] })
  let adding = $state(false)

  // ---- reader (tabbed PDF view) ---------------------------------------------
  // Papers the user has explicitly opened, in tab order. ⌘1–9 jumps to a tab.
  let readerTabs = $state<ResolvedPaper[]>([])
  let readerActiveId = $state<string | null>(null)

  // ---- table interaction ----------------------------------------------------
  let activeId = $state<string | null>(null)
  let sort = $state<Sort>({ key: 'added', dir: 'desc' })

  let searchEl = $state<HTMLInputElement | null>(null)
  let query = $state('')
  let termRef = $state<{
    dispatchClaude: (
      kickoff: string,
      opts?: { project?: ProjectSummary | null }
    ) => Promise<void>
  } | null>(null)
  let quartoRef = $state<{
    renderPdf: () => void
    toggleLog: () => void
  } | null>(null)

  const SWATCHES =['var(--data-cyan)', 'var(--data-violet)', 'var(--data-green)', 'var(--data-amber)']

  // ---- boot -----------------------------------------------------------------
  async function boot(): Promise<void> {
    libraryRoot = await window.api.library.get()
    if (libraryRoot) {
      await Promise.all([loadProjects(), loadLibrary()])
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
    if (mode === 'reader' && readerActiveId) closeReaderTab(readerActiveId)
    else window.api.app.closeWindow()
  })

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
  function openSmart(v: 'added' | 'interacted' | 'untagged'): void {
    view = 'library'
    mode = 'papers'
    tagFilter = null
    smartView = v
    if (v !== 'untagged') sort = { key: v, dir: 'desc' }
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
  async function deleteTag(tagId: string): Promise<void> {
    await window.api.library.deleteTag(tagId)
    if (tagFilter === tagId) tagFilter = null
    await loadLibrary()
  }
  // Opening a project is a Workspace action — projects live in the workspace, not
  // the Papers sidebar. Selecting one drops you into the writing view.
  function openProject(p: ProjectSummary): void {
    selected = p
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
  // rotation when it's present as the third button (i.e. some tab is open).
  function toggleMode(): void {
    const order: Array<'papers' | 'workspace' | 'reader'> = readerTabs.length
      ? ['papers', 'workspace', 'reader']
      : ['papers', 'workspace']
    const i = order.indexOf(mode)
    setMode(order[(i + 1) % order.length])
  }

  // ---- reader ----------------------------------------------------------------
  function openInReader(p: ResolvedPaper): void {
    if (!p.exists) return
    if (!readerTabs.some((t) => t.id === p.id)) readerTabs = [...readerTabs, p]
    readerActiveId = p.id
    mode = 'reader'
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
    const added = await window.api.library.addPapers()
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
  function onkeydown(e: KeyboardEvent): void {
    // ⌃Tab cycles forward through the visible app buttons (incl. Reader if open).
    if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault()
      toggleMode()
      return
    }
    const mod = e.metaKey || e.ctrlKey
    // ⌘1–9 jumps straight to a reader tab (entering Reader mode if needed).
    if (mod && readerTabs.length && /^[1-9]$/.test(e.key)) {
      const i = parseInt(e.key, 10) - 1
      if (i < readerTabs.length) {
        e.preventDefault()
        readerActiveId = readerTabs[i].id
        mode = 'reader'
      }
      return
    }
    // ⌘W is handled by the File ▸ Close menu item (see onCloseRequest above);
    // the menu accelerator intercepts it before this handler runs.
    if (mod && e.key.toLowerCase() === 'r') {
      // ⌘R renders the current manuscript/slides to PDF (overrides the default
      // page reload). Only meaningful while writing in the Workspace.
      e.preventDefault()
      if (mode === 'workspace' && selected) quartoRef?.renderPdf()
    } else if (mod && e.key.toLowerCase() === 'l') {
      // ⌘L toggles the render-log panel in the Workspace.
      e.preventDefault()
      if (mode === 'workspace' && selected) quartoRef?.toggleLog()
    } else if (mod && e.key.toLowerCase() === 'j') {
      e.preventDefault()
      termOpen = !termOpen
    } else if (mod && e.key.toLowerCase() === 'k') {
      // ⌘K focuses library search — reveal the Papers sidebar first so the
      // input exists, then focus it once Svelte has rendered.
      e.preventDefault()
      mode = 'papers'
      paperSidebarOn = true
      requestAnimationFrame(() => { searchEl?.focus(); searchEl?.select() })
    } else if (mod && e.altKey && e.key.toLowerCase() === 'b') {
      // ⌘⌥B: outline in Workspace; inspector (right panel) in Papers.
      e.preventDefault()
      if (mode === 'workspace') workspaceOutlineOn = !workspaceOutlineOn
      else inspectorOn = !inspectorOn
    } else if (mod && e.key.toLowerCase() === 'b') {
      // ⌘B: margin notes in Workspace; paper sidebar (left panel) in Papers.
      e.preventDefault()
      if (mode === 'workspace') workspaceNotesOn = !workspaceNotesOn
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
        ? query.trim()
          ? `${filteredPapers.length} of ${currentPapers.length} · “${query.trim()}”`
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
  <div class="lx-app" data-modal={manualRefsOpen}>
    <!-- ---- Top bar (nav + toolbar consolidated into one row) ----
         Zones, left→right, split by hairline dividers like the Slides bar:
         identity · app switcher ‖ contextual context … contextual actions ‖
         global view toggles. The middle zone changes with `mode`. -->
    <div class="topbar" data-mode={mode}>
      <!-- Identity -->
      <div class="tb-brand" title={libraryRoot}>
        <b>lctrn</b>
        {#if libraryName}<span class="tb-lib">{libraryName}</span>{/if}
      </div>

      <span class="tb-div" aria-hidden="true"></span>

      <!-- App switcher (⌃Tab) -->
      <div class="tb-seg tb-seg--text" title="Switch app (⌃Tab)">
        <button data-on={mode === 'papers'} onclick={() => setMode('papers')}>Papers</button>
        <button data-on={mode === 'workspace'} onclick={() => setMode('workspace')}>Workspace</button>
        {#if readerTabs.length}
          <button data-on={mode === 'reader'} title="Read PDFs (⌘1–9)" onclick={() => setMode('reader')}>Reader</button>
        {/if}
      </div>

      <!-- Contextual zone — depends on the active app -->
      {#if mode === 'workspace'}
        <span class="tb-div" aria-hidden="true"></span>
        <div class="proj-switch">
          <button class="btn btn--ghost" onclick={() => (projectMenuOpen = !projectMenuOpen)}>
            <Icon n="folder" />{selected?.title ?? 'Choose project'}<span class="caret"><Icon n="chevron-down" /></span>
          </button>
          {#if projectMenuOpen}
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
            </div>
          {/if}
        </div>
        {#if selected}
          <button class="btn btn--ghost" title="Edit project config files (revision plan, writing style, …)" onclick={() => (configOpen = true)}>
            <Icon n="file" />Config
          </button>
          <button class="btn btn--ghost" title="Add references that live outside the library (policy articles, web pages, …)" onclick={() => (manualRefsOpen = true)}>
            <Icon n="file" />References
          </button>
        {/if}
        <span class="tb-spacer"></span>
        {#if selected}
          <div class="tb-seg tb-seg--text" title="Document">
            <button data-on={workspaceDoc === 'manuscript'} onclick={() => (workspaceDoc = 'manuscript')}>Manuscript</button>
            <button data-on={workspaceDoc === 'slides'} onclick={() => (workspaceDoc = 'slides')}>Slides</button>
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
      {:else}
        <span class="tb-spacer"></span>
      {/if}

      <!-- Global view toggles -->
      <span class="tb-div" aria-hidden="true"></span>
      <div class="tl-actions">
        <button class="iconbtn" data-on={inspectorOn} title="Inspector (⌘⌥B)" onclick={() => (inspectorOn = !inspectorOn)}><Icon n="panel" /></button>
        <button class="iconbtn" data-on={termOpen} title="Terminal (⌘J)" onclick={() => (termOpen = !termOpen)}><Icon n="terminal" /></button>
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
              onkeydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); query = ''; searchEl?.blur() } }}
            />
            {#if query}
              <button class="search-clear" title="Clear" onclick={() => { query = ''; searchEl?.focus() }}><Icon n="x" /></button>
            {:else}
              <span class="kbd">⌘K</span>
            {/if}
          </div>
        </div>
        <div class="sb-scroll">
          <div class="sb-group">
            <div class="sb-group__label"><span>Library</span></div>
            <button class="sb-item" data-active={view === 'library' && !tagFilter && !smartView} onclick={showLibrary}>
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
                    style={row.depth ? 'padding-left: 30px' : ''}
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
        <!-- Views are kept mounted and toggled with display:none (.view.hidden)
             rather than {#if}-swapped, so PDFs / editors / scroll survive a
             mode switch. Reader & Workspace mount lazily on first open. -->
        <div class="view" class:hidden={mode !== 'reader'}>
          {#if readerMounted}
            <Reader
              tabs={readerTabs}
              activeId={readerActiveId}
              onselect={(id) => (readerActiveId = id)}
              onclose={closeReaderTab}
              onPrompt={(text) => void termRef?.dispatchClaude(text)}
            />
          {/if}
        </div>

        <div class="view" class:hidden={mode !== 'workspace'}>
          {#if workspaceMounted}
            {#if selected}
              <QuartoView
                bind:this={quartoRef}
                projectPath={selected.path}
                which={workspaceDoc}
                papers={libraryPapers}
                bind:showOutline={workspaceOutlineOn}
                bind:showNotes={workspaceNotesOn}
                onLearnEdits={(kickoff) => void termRef?.dispatchClaude(kickoff, { project: selected })}
                onAddressNotes={(kickoff) => void termRef?.dispatchClaude(kickoff, { project: selected })}
              />
            {:else}
              <div class="ws-empty">
                <h2>No project open</h2>
                <p>Pick a project from the <strong>project menu</strong> at the top, or create one, to start writing its manuscript and slides.</p>
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
            papers={sortedPapers}
            {activeId}
            {sort}
            emptyText={query.trim()
              ? `No papers match “${query.trim()}”.`
              : view === 'library'
                ? tagFilter
                  ? 'No papers wired into this tag yet.'
                  : 'No papers yet. Use “Add” to register PDFs into the global pile.'
                : 'No papers attached. Use “Attach” to pull from the library.'}
            {onrowclick}
            onrowopen={openInReader}
            {onsort}
          />
        </div>

        <Terminal
          bind:this={termRef}
          {projects}
          {libraryRoot}
          open={termOpen}
          ontoggle={() => (termOpen = !termOpen)}
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
          onsave={savePaper}
          onrefetch={refetchPaper}
          onrename={renamePaper}
          ondelete={deletePaper}
        />
      {/if}
    </div>
  </div>

  {#if onboarding}
    <Onboarding oncreated={onProjectCreated} onclose={() => (onboarding = false)} />
  {/if}

  {#if configOpen && selected}
    <ConfigFiles projectPath={selected.path} onclose={() => (configOpen = false)} />
  {/if}

  {#if manualRefsOpen && selected}
    <ManualRefs projectPath={selected.path} onclose={() => (manualRefsOpen = false)} />
  {/if}

  {#if inquiriesOpen}
    <Inquiries papers={libraryPapers} {tags} onclose={() => (inquiriesOpen = false)} />
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
    border-radius: var(--r-sm);
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
  .proj-switch .caret svg {
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
    border-radius: var(--r-md);
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
    border-radius: var(--r-sm);
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
    border-radius: var(--r-sm);
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
