<script lang="ts">
  // Modal editor for a project's config Markdown files (REVISION_PLAN.md,
  // WRITING_STYLE.md, .claude/CLAUDE.md, …). A left list picks the file; the
  // right pane is the shared CodeMirror editor. Files are created from a starter
  // template on first save. Edits autosave when switching files or closing.
  import Editor from './Editor.svelte'
  import Icon from './Icon.svelte'
  import type { ConfigFileInfo } from '../global'

  let { projectPath, onclose }: { projectPath: string; onclose: () => void } = $props()

  let files = $state<ConfigFileInfo[]>([])
  let current = $state<string | null>(null) // name of the open file
  let initial = $state('') // value handed to <Editor>; changes remount it
  let draft = $state('')
  let lastSaved = $state('')
  let exists = $state(false)
  let loading = $state(true)
  let saving = $state(false)
  let saveError = $state<string | null>(null)
  let newName = $state('')

  const dirty = $derived(draft !== lastSaved)
  const meta = $derived(files.find((f) => f.name === current) ?? null)

  async function refreshList(): Promise<void> {
    files = await window.api.projects.files.list(projectPath)
  }

  // Initial load: list files and open the first one.
  $effect(() => {
    void (async () => {
      await refreshList()
      const first = files[0]?.name ?? null
      if (first) await open(first)
      loading = false
    })()
  })

  async function open(name: string): Promise<void> {
    if (name === current) return
    await flush() // persist edits to the outgoing file
    const f = await window.api.projects.files.get(projectPath, name)
    current = name
    initial = f.content
    draft = f.content
    lastSaved = f.exists ? f.content : '' // not-yet-created → starter counts as unsaved
    exists = f.exists
  }

  async function save(): Promise<void> {
    if (saving || !current || draft === lastSaved) return
    saving = true
    const name = current
    const snapshot = draft
    try {
      await window.api.projects.files.save(projectPath, name, snapshot)
      lastSaved = snapshot
      exists = true
      saveError = null
      await refreshList()
    } catch (e) {
      saveError = (e as Error)?.message || 'Could not save to disk.'
    } finally {
      saving = false
    }
  }

  // Save without flipping the saving flag (used on switch/close). Still surfaces
  // a failure so edits aren't lost silently when leaving a file.
  async function flush(): Promise<void> {
    if (!current || draft === lastSaved) return
    try {
      await window.api.projects.files.save(projectPath, current, draft)
      lastSaved = draft
      saveError = null
    } catch (e) {
      saveError = (e as Error)?.message || 'Could not save to disk.'
    }
  }

  function onChange(v: string): void {
    draft = v
  }

  function sanitize(raw: string): string {
    const base = raw.trim().replace(/[/\\]+/g, '-').replace(/[^A-Za-z0-9._-]/g, '')
    if (!base) return ''
    return base.toLowerCase().endsWith('.md') ? base : `${base}.md`
  }

  async function createFile(): Promise<void> {
    const name = sanitize(newName)
    if (!name) return
    newName = ''
    if (!files.some((f) => f.name === name)) {
      // Surface it immediately; it becomes "real" on first save.
      files = [...files, { name, label: name.replace(/\.md$/i, ''), description: 'Project markdown file.', exists: false, curated: false }]
    }
    await open(name)
  }

  async function close(): Promise<void> {
    await flush()
    onclose()
  }

  const saveState = $derived(saving ? 'saving…' : !exists ? 'new — unsaved' : dirty ? 'unsaved' : 'saved')
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); void close() } }} />
<div class="cf-backdrop" role="presentation" onclick={close}></div>
<div class="cf" role="dialog" aria-label="Project config files">
  <aside class="cf-side">
    <div class="cf-side-head">Config files</div>
    <div class="cf-list">
      {#each files as f (f.name)}
        <button class="cf-item" data-on={current === f.name} onclick={() => open(f.name)}>
          <span class="cf-dot" data-exists={f.exists}></span>
          <span class="cf-item-main">
            <span class="cf-item-label">{f.label}</span>
            <span class="cf-item-name">{f.name}</span>
          </span>
        </button>
      {/each}
    </div>
    <div class="cf-new">
      <input
        class="cf-new-input"
        placeholder="NEW_FILE.md"
        bind:value={newName}
        onkeydown={(e) => { if (e.key === 'Enter') void createFile() }}
      />
      <button class="iconbtn" title="Create file" disabled={!sanitize(newName)} onclick={createFile}>
        <Icon n="plus" />
      </button>
    </div>
  </aside>

  <section class="cf-main">
    <header class="cf-bar">
      <div class="cf-bar-titles">
        <span class="cf-title">{meta?.label ?? current ?? ''}</span>
        <code class="cf-file">{current ?? ''}</code>
      </div>
      <span class="cf-spacer"></span>
      {#if saveError}
        <button class="cf-state cf-state--err" title={saveError} onclick={save}>
          ⚠ save failed — retry
        </button>
      {:else}
        <span class="cf-state">{saveState}</span>
      {/if}
      <button class="btn btn--secondary" disabled={!dirty || saving} onclick={save}>
        <Icon n="file" />Save
      </button>
      <button class="iconbtn cf-close" title="Close" onclick={close}><Icon n="x" /></button>
    </header>
    <div class="cf-body">
      {#if loading}
        <div class="cf-loading">Loading config files…</div>
      {:else if current}
        {#key current}
          <Editor
            value={initial}
            onchange={onChange}
            onsave={save}
            placeholder={`Write ${current} in Markdown. Claude reads this file.`}
          />
        {/key}
      {:else}
        <div class="cf-loading">No file selected.</div>
      {/if}
    </div>
  </section>
</div>

<style>
  .cf-backdrop {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: rgba(0, 0, 0, 0.42);
  }
  .cf {
    position: fixed;
    z-index: 61;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(980px, 92vw);
    height: min(680px, 86vh);
    display: flex;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-lg, var(--shadow-sm));
    overflow: hidden;
  }

  /* sidebar */
  .cf-side {
    flex: none;
    width: 244px;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--border);
    background: var(--bg-sunken);
  }
  .cf-side-head {
    padding: 14px 14px 8px;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .cf-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 4px 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .cf-item {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    padding: 8px 9px;
    border-radius: var(--r-md);
    cursor: pointer;
  }
  .cf-item:hover {
    background: var(--accent-weak);
  }
  .cf-item[data-on='true'] {
    background: var(--accent-weak);
    box-shadow: inset 0 0 0 1px var(--accent-line, var(--border-strong));
  }
  .cf-dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 999px;
    border: 1px solid var(--border-strong);
    background: transparent;
  }
  .cf-dot[data-exists='true'] {
    background: var(--accent);
    border-color: var(--accent);
  }
  .cf-item-main {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .cf-item-label {
    font-family: var(--font-sans);
    font-size: 12.5px;
    color: var(--text);
  }
  .cf-item-name {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .cf-new {
    flex: none;
    display: flex;
    gap: 6px;
    padding: 8px;
    border-top: 1px solid var(--border);
  }
  .cf-new-input {
    flex: 1;
    min-width: 0;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    padding: 5px 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text);
  }
  .cf-new-input:focus {
    outline: none;
    border-color: var(--accent);
  }

  /* main pane */
  .cf-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .cf-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
  }
  .cf-bar-titles {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }
  .cf-title {
    font-family: var(--font-sans);
    font-weight: 600;
    font-size: 14px;
    color: var(--text);
  }
  .cf-file {
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-faint);
  }
  .cf-spacer {
    flex: 1;
  }
  .cf-state {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-faint);
    min-width: 64px;
    text-align: right;
  }
  .cf-state--err {
    color: var(--danger);
    background: transparent;
    border: none;
    padding: 0;
    cursor: pointer;
    white-space: nowrap;
  }
  .cf-state--err:hover {
    text-decoration: underline;
  }
  .cf-close {
    margin-left: 2px;
  }
  .cf-body {
    flex: 1;
    min-height: 0;
    display: flex;
    padding: 14px;
  }
  .cf-loading {
    margin: 40px auto;
    color: var(--text-muted);
    font-size: 13px;
  }
</style>
