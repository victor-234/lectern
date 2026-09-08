<script lang="ts">
  // Directory browser for the localhost host, where there is no native file
  // dialog to raise. It walks the filesystem of the machine the BACKEND runs on
  // (through `host.listDir`), which is the one that matters — point Lectern at a
  // folder on a lab server and that's where the library lives.
  //
  // Folders only: this exists to name a library root, not to browse files.
  import Icon from './Icon.svelte'
  import type { DirListing } from '../../../shared/api'

  let {
    start,
    onchoose,
    oncancel
  }: {
    start: string
    onchoose: (path: string) => void
    oncancel: () => void
  } = $props()

  let listing = $state<DirListing | null>(null)
  let error = $state('')
  let loading = $state(true)
  // Typing a path beats clicking down to it when you already know where you're
  // going — and it's the only way to reach a hidden folder, which the listing
  // deliberately omits.
  // The picker is mounted fresh for each use, so `start` is fixed for its
  // lifetime and reading it once is what we want.
  // svelte-ignore state_referenced_locally
  let typed = $state(start)
  let creating = $state(false)
  let newName = $state('')

  async function go(path: string | null): Promise<void> {
    loading = true
    error = ''
    try {
      const next = await window.api.host.listDir(path)
      listing = next
      typed = next.path
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      loading = false
    }
  }

  async function createFolder(): Promise<void> {
    const name = newName.trim()
    if (!name || !listing) return
    try {
      const path = await window.api.host.mkdir(listing.path, name)
      newName = ''
      creating = false
      await go(path)
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  // svelte-ignore state_referenced_locally
  void go(start)
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && oncancel()} />

<!-- The scrim is decoration: it dismisses on click, but it must not show up in
     the accessibility tree as a control of its own. Escape is bound globally. -->
<div class="scrim" role="presentation" onclick={(e) => e.target === e.currentTarget && oncancel()}>
  <div class="picker" role="dialog" aria-modal="true" aria-label="Choose a library folder">
    <header>
      <Icon n="folder" />
      <span class="title">Choose a library folder</span>
      <span class="on">on {location.host}</span>
    </header>

    <form
      class="path"
      onsubmit={(e) => {
        e.preventDefault()
        void go(typed)
      }}
    >
      <input bind:value={typed} spellcheck="false" aria-label="Folder path" />
      <button class="btn btn--secondary" type="submit">Go</button>
    </form>

    <div class="list">
      {#if error}
        <p class="msg err">{error}</p>
      {:else if loading}
        <p class="msg">Loading…</p>
      {:else if listing}
        {#if listing.parent}
          <button class="row" onclick={() => go(listing!.parent)}>
            <Icon n="folder" /><span class="up">..</span>
          </button>
        {/if}
        {#each listing.entries as entry (entry.path)}
          <button class="row" onclick={() => go(entry.path)}>
            <Icon n="folder" /><span>{entry.name}</span>
          </button>
        {:else}
          <p class="msg">No sub-folders here.</p>
        {/each}
      {/if}
    </div>

    <footer>
      {#if creating}
        <form
          class="new"
          onsubmit={(e) => {
            e.preventDefault()
            void createFolder()
          }}
        >
          <!-- svelte-ignore a11y_autofocus -->
          <input bind:value={newName} placeholder="New folder name" autofocus spellcheck="false" />
          <button class="btn btn--secondary" type="submit" disabled={!newName.trim()}>Create</button>
          <button class="btn btn--ghost" type="button" onclick={() => (creating = false)}>Cancel</button>
        </form>
      {:else}
        <button class="btn btn--ghost" onclick={() => (creating = true)}>
          <Icon n="plus" />New folder
        </button>
        <div class="spacer"></div>
        <button class="btn btn--ghost" onclick={oncancel}>Cancel</button>
        <button
          class="btn btn--primary"
          disabled={!listing}
          onclick={() => listing && onchoose(listing.path)}
        >
          Use this folder
        </button>
      {/if}
    </footer>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: grid;
    place-items: center;
    background: rgba(0, 0, 0, 0.45);
  }
  .picker {
    width: min(560px, 92vw);
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    box-shadow: var(--shadow-lg);
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
  }
  header :global(svg) {
    width: 15px;
    height: 15px;
    flex: none;
    color: var(--text-faint);
  }
  .title {
    font-weight: 600;
    font-size: 13px;
    white-space: nowrap;
  }
  .on {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-faint);
  }
  .path,
  .new {
    display: flex;
    gap: 8px;
    padding: 10px 14px;
  }
  .path {
    border-bottom: 1px solid var(--border);
  }
  input {
    flex: 1;
    min-width: 0;
    height: var(--h-md);
    padding: 0 9px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text);
    background: var(--surface-inset);
    border: 1px solid var(--border);
    border-radius: var(--r-xs);
  }
  .list {
    height: 300px;
    overflow-y: auto;
    padding: 6px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 8px;
    font-size: 12.5px;
    color: var(--text);
    text-align: left;
    background: none;
    border: 0;
    border-radius: var(--r-xs);
    cursor: pointer;
  }
  .row:hover {
    background: var(--accent-weak);
  }
  .row :global(svg) {
    width: 14px;
    height: 14px;
    color: var(--text-faint);
    flex: none;
  }
  .up {
    font-family: var(--font-mono);
  }
  .msg {
    margin: 0;
    padding: 12px 8px;
    font-size: 12px;
    color: var(--text-secondary);
  }
  .err {
    color: var(--danger, #e5484d);
  }
  footer {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    border-top: 1px solid var(--border);
  }
  .spacer {
    flex: 1;
  }
</style>
