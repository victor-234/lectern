<script lang="ts">
  // Split pane for a project file, shown beside the manuscript. Markdown opens
  // in the shared editor — same load/autosave/reconcile model as QuartoView:
  // debounced autosave, adopt external edits when clean, slim conflict bar when
  // both sides changed. PDFs (e.g. the rendered manuscript) render read-only in
  // Chromium's viewer via lctrn-pdf://project/…, reloading on disk changes.
  import Editor from './Editor.svelte'
  import Icon from './Icon.svelte'
  import type { ResolvedPaper } from '../global'

  let {
    projectPath,
    name,
    papers = [],
    onclose
  }: {
    projectPath: string
    name: string // project-relative, e.g. `LEARNED_EDITS.md`
    papers?: ResolvedPaper[]
    onclose: () => void
  } = $props()

  const isPdf = $derived(name.toLowerCase().endsWith('.pdf'))
  // Cache-buster: bumped when the PDF changes on disk (a fresh render) so the
  // iframe reloads instead of showing Chromium's cached copy.
  let pdfVersion = $state(0)
  const pdfSrc = $derived(
    `lctrn-pdf://project/${encodeURIComponent(projectPath)}/${encodeURIComponent(name)}?v=${pdfVersion}`
  )

  let initial = $state('') // handed to <Editor>; changes remount it
  let draft = $state('')
  let lastSaved = $state('')
  let exists = $state(false)
  let loading = $state(true)
  let saving = $state(false)
  let saveError = $state<string | null>(null)
  let diskPending = $state<string | null>(null) // disk body awaiting a dirty-conflict decision
  let saveTimer: ReturnType<typeof setTimeout> | null = null

  const dirty = $derived(draft !== lastSaved)

  // The file currently loaded — tracked apart from the props so switching files
  // mid-edit flushes the OUTGOING file, not the incoming one.
  let loadedName = $state<string | null>(null)
  let loadedPath = $state<string | null>(null)

  $effect(() => {
    const pp = projectPath
    const n = name
    void switchTo(pp, n)
  })

  async function switchTo(pp: string, n: string): Promise<void> {
    // Yield so the state reads below sit outside the effect's tracking scope
    // (typing mutates `draft` and must not retrigger this).
    await Promise.resolve()
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    if (loadedName && loadedPath && draft !== lastSaved) {
      try {
        await window.api.projects.files.save(loadedPath, loadedName, draft)
      } catch (e) {
        saveError = (e as Error)?.message || 'Could not save the previous file.'
      }
    }
    loading = true
    if (n.toLowerCase().endsWith('.pdf')) {
      // PDFs render in the iframe straight off pdfSrc — nothing to load here.
      initial = ''
      draft = ''
      lastSaved = ''
      exists = true
    } else {
      const f = await window.api.projects.files.get(pp, n)
      initial = f.content
      draft = f.content
      // A not-yet-created file comes back as a starter template — count it as
      // unsaved so the first keystroke (or ⌘S) writes it to disk.
      lastSaved = f.exists ? f.content : ''
      exists = f.exists
    }
    loadedName = n
    loadedPath = pp
    diskPending = null
    loading = false
  }

  // On unmount, drop any pending debounced save — closing goes through close()
  // (which flushes), and after a delete a late save would resurrect the file.
  $effect(() => {
    return () => {
      if (saveTimer) clearTimeout(saveTimer)
    }
  })

  // External edits (Claude in the terminal, a fresh render): adopt when clean,
  // ask when dirty; PDFs just reload the viewer.
  $effect(() => {
    return window.api.projects.files.onChanged((changed) => {
      if (changed !== loadedName) return
      if (isPdf) pdfVersion++
      else void reconcile()
    })
  })

  async function reconcile(): Promise<void> {
    if (!loadedName || !loadedPath) return
    const n = loadedName
    const f = await window.api.projects.files.get(loadedPath, n)
    if (n !== loadedName) return // switched files while reading
    if (f.content === lastSaved) {
      diskPending = null // our own write, or no real change
      return
    }
    if (draft === lastSaved) adoptDisk(f.content)
    else diskPending = f.content
  }

  function adoptDisk(content: string): void {
    initial = content
    draft = content
    lastSaved = content
    exists = true
    diskPending = null
  }

  function keepMine(): void {
    diskPending = null
    void save()
  }

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
    if (saving || draft === lastSaved || !loadedName || !loadedPath) return
    saving = true
    const n = loadedName
    const pp = loadedPath
    const snapshot = draft
    try {
      await window.api.projects.files.save(pp, n, snapshot)
      lastSaved = snapshot
      exists = true
      saveError = null
    } catch (e) {
      saveError = (e as Error)?.message || 'Could not save to disk.'
    } finally {
      saving = false
    }
  }

  async function close(): Promise<void> {
    await save() // flush pending edits before the pane unmounts
    onclose()
  }

  const saveState = $derived(
    saving ? 'saving…' : !exists ? 'new — unsaved' : dirty ? 'unsaved' : 'saved'
  )
</script>

<section class="sf">
  <header class="sf-bar">
    <code class="sf-name" title={name}>{name}</code>
    <span class="sf-spacer"></span>
    {#if isPdf}
      <span class="sf-state">read-only</span>
    {:else if saveError}
      <button class="sf-state sf-state--err" title={saveError} onclick={() => void save()}>
        ⚠ save failed — retry
      </button>
    {:else}
      <span class="sf-state">{saveState}</span>
    {/if}
    <button class="sf-x" title="Close file" onclick={() => void close()}>×</button>
  </header>

  {#if diskPending !== null}
    <div class="sf-conflict">
      <span>Changed on disk, but you have unsaved edits.</span>
      <span class="sf-spacer"></span>
      <button class="btn btn--secondary" onclick={() => adoptDisk(diskPending!)}>Load disk</button>
      <button class="btn btn--ghost" onclick={keepMine}>Keep mine</button>
    </div>
  {/if}

  <div class="sf-body" class:sf-body--pdf={isPdf}>
    {#if loading}
      <div class="sf-loading">Loading…</div>
    {:else if isPdf}
      <iframe class="sf-frame" src={pdfSrc} title={name}></iframe>
    {:else}
      <Editor
        value={initial}
        onchange={onChange}
        onsave={save}
        {papers}
        placeholder={`Write ${name} in Markdown. Claude reads this file.`}
      />
    {/if}
  </div>
</section>

<style>
  .sf {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    margin-left: 12px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-sm);
    overflow: hidden;
  }
  .sf-bar {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
  }
  .sf-name {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sf-spacer {
    flex: 1;
  }
  .sf-state {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-faint);
    white-space: nowrap;
  }
  .sf-state--err {
    color: var(--danger);
    background: transparent;
    border: none;
    padding: 0;
    cursor: pointer;
    white-space: nowrap;
  }
  .sf-state--err:hover {
    text-decoration: underline;
  }
  .sf-x {
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
    padding: 0 2px;
  }
  .sf-x:hover {
    color: var(--text);
  }
  .sf-conflict {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--accent-line, var(--border-strong));
    background: var(--accent-weak);
    font-family: var(--font-sans);
    font-size: 11.5px;
    color: var(--text);
  }
  .sf-body {
    flex: 1;
    min-height: 0;
    min-width: 0;
    display: flex;
    padding: 10px;
  }
  /* PDFs fill the pane edge-to-edge — the viewer brings its own chrome. */
  .sf-body--pdf {
    padding: 0;
  }
  .sf-frame {
    flex: 1;
    width: 100%;
    border: none;
    background: var(--surface-inset, var(--bg-sunken));
  }
  .sf-loading {
    margin: 40px auto;
    color: var(--text-muted);
    font-size: 13px;
  }
</style>
