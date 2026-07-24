<script lang="ts">
  // Workspace file pane: the project's markdown config files (revision plan,
  // writing style, LEARNED_EDITS.md, …) listed below the outline. Clicking a
  // file opens it in a split editor beside the manuscript; clicking the open
  // one again closes the split. Same files.list backend as the old Config modal.
  import Icon from './Icon.svelte'
  import type { ConfigFileInfo } from '../global'

  let {
    projectPath,
    active,
    onopen,
    ondeleted
  }: {
    projectPath: string
    /** Name of the file currently open in the split pane (null = none). */
    active: string | null
    onopen: (name: string) => void
    /** A file was deleted from disk — lets the parent close its split pane. */
    ondeleted?: (name: string) => void
  } = $props()

  let files = $state<ConfigFileInfo[]>([])
  let newName = $state('')

  async function refresh(pp: string): Promise<void> {
    const list = await window.api.projects.files.list(pp)
    if (pp === projectPath) files = list
  }

  $effect(() => {
    void refresh(projectPath)
  })

  // Files created/deleted on disk (Claude, Finder, first save of a new file)
  // update the list live.
  $effect(() => {
    return window.api.projects.files.onChanged(() => void refresh(projectPath))
  })

  function sanitize(raw: string): string {
    const base = raw.trim().replace(/[/\\]+/g, '-').replace(/[^A-Za-z0-9._-]/g, '')
    if (!base) return ''
    return base.toLowerCase().endsWith('.md') ? base : `${base}.md`
  }

  function createFile(): void {
    const name = sanitize(newName)
    if (!name) return
    newName = ''
    if (!files.some((f) => f.name === name)) {
      // Surface it immediately; it becomes "real" on the split editor's first save.
      files = [
        ...files,
        { name, label: name.replace(/\.md$/i, ''), exists: false, curated: false, kind: 'md' }
      ]
    }
    onopen(name)
  }

  async function deleteFile(f: ConfigFileInfo): Promise<void> {
    if (!confirm(`Delete ${f.name} from the project?\n\n(removes the file on disk — syncs through Dropbox)`)) return
    try {
      await window.api.projects.files.delete(projectPath, f.name)
    } catch (e) {
      alert((e as Error)?.message || 'Could not delete the file.')
      return
    }
    ondeleted?.(f.name)
    await refresh(projectPath)
  }
</script>

<aside class="files">
  <div class="files-head">Files</div>
  <div class="files-list">
    {#each files as f (f.name)}
      <div class="files-item" data-on={active === f.name}>
        <button class="files-open" title={f.name} onclick={() => onopen(f.name)}>
          <span class="files-dot" data-exists={f.exists}></span>
          <span class="files-name">{f.name.replace(/^.*\//, '')}</span>
        </button>
        <!-- Only real files on disk are deletable: the front-matter entry is
             virtual (its name is neither .md nor .pdf), and not-yet-created
             curated files have nothing to delete. -->
        {#if f.exists && /\.(md|pdf)$/i.test(f.name)}
          <button class="files-del" title="Delete {f.name}" onclick={() => deleteFile(f)}>×</button>
        {/if}
      </div>
    {/each}
  </div>
  <div class="files-new">
    <input
      class="files-new-input"
      placeholder="NEW_FILE.md"
      bind:value={newName}
      onkeydown={(e) => {
        if (e.key === 'Enter') createFile()
      }}
    />
    <button class="iconbtn" title="Create file" disabled={!sanitize(newName)} onclick={createFile}>
      <Icon n="plus" />
    </button>
  </div>
</aside>

<style>
  .files {
    flex: none;
    max-height: 45%;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-sm);
    overflow: hidden;
  }
  .files-head {
    flex: none;
    padding: 12px 14px 8px;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .files-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 2px 6px 6px;
    display: flex;
    flex-direction: column;
    gap: 0;
  }
  .files-item {
    display: flex;
    align-items: center;
    border-radius: var(--r-sm);
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1.5;
    color: var(--text-secondary);
  }
  .files-item:hover {
    background: var(--accent-weak);
    color: var(--text);
  }
  .files-item[data-on='true'] {
    background: var(--accent-weak);
    color: var(--text);
    box-shadow: inset 0 0 0 1px var(--accent-line, var(--border-strong));
  }
  .files-open {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 7px;
    text-align: left;
    background: transparent;
    border: none;
    padding: 2px 8px;
    cursor: pointer;
    font: inherit;
    color: inherit;
  }
  .files-del {
    flex: none;
    background: transparent;
    border: none;
    padding: 0 6px 0 2px;
    color: var(--text-faint);
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
    opacity: 0;
  }
  .files-item:hover .files-del {
    opacity: 1;
  }
  .files-del:hover {
    color: var(--danger);
  }
  .files-dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 999px;
    border: 1px solid var(--border-strong);
    background: transparent;
  }
  .files-dot[data-exists='true'] {
    background: var(--accent);
    border-color: var(--accent);
  }
  .files-name {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .files-new {
    flex: none;
    display: flex;
    gap: 6px;
    padding: 6px;
    border-top: 1px solid var(--border);
  }
  .files-new-input {
    flex: 1;
    min-width: 0;
    background: var(--surface-inset, var(--bg-sunken));
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    padding: 4px 8px;
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text);
  }
  .files-new-input:focus {
    outline: none;
    border-color: var(--accent);
  }
</style>
