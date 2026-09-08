<script lang="ts">
  import Icon from './Icon.svelte'
  import type { GitStatus, GitSyncResult } from '../global'

  let { projectPath }: { projectPath: string } = $props()

  let st = $state<GitStatus | null>(null)
  let open = $state(false)
  let busy = $state(false)
  let result = $state<GitSyncResult | null>(null)

  async function refresh(fetch = false): Promise<void> {
    const pp = projectPath
    const s = await window.api.projects.git.status(pp, fetch)
    if (pp === projectPath) st = s
  }

  // On project switch: reset, then a fetching status load so ahead/behind is real.
  $effect(() => {
    projectPath
    st = null
    result = null
    open = false
    void refresh(true)
  })

  // Keep the chip honest while the app sits open (Claude commits in the
  // terminal, the co-author pushes, …). Local status only — no network.
  $effect(() => {
    projectPath
    const t = setInterval(() => {
      if (!busy) void refresh()
    }, 10_000)
    return () => clearInterval(t)
  })

  async function sync(): Promise<void> {
    if (busy) return
    busy = true
    result = null
    try {
      result = await window.api.projects.git.sync(projectPath)
    } finally {
      busy = false
      void refresh()
    }
  }

  const clean = $derived(!!st && st.files.length === 0 && st.ahead === 0 && st.behind === 0)
  const chip = $derived.by(() => {
    if (!st) return ''
    const parts: string[] = []
    if (st.files.length) parts.push(`${st.files.length} changed`)
    if (st.ahead) parts.push(`↑${st.ahead}`)
    if (st.behind) parts.push(`↓${st.behind}`)
    return parts.length ? parts.join(' · ') : 'Synced'
  })
  const syncLabel = $derived.by(() => {
    if (!st) return 'Sync'
    if (st.files.length) return st.upstream ? 'Commit & push' : 'Commit'
    if (st.behind && !st.ahead) return 'Pull'
    if (st.ahead) return 'Push'
    return 'Up to date'
  })
</script>

{#if st?.repo}
  <div class="git-panel">
    <button
      class="btn btn--ghost"
      class:btn--active={open}
      title="Source control — is your co-author up to date?"
      onclick={() => (open = !open)}
    >
      <Icon n="branch" />{chip}
    </button>

    {#if open}
      <button class="git-backdrop" aria-label="Close source control" onclick={() => (open = false)}
      ></button>
      <div class="git-menu">
        <div class="git-head">
          <Icon n="branch" />
          <span class="git-branch">{st.branch ?? '?'}</span>
          <span class="git-remote">{st.upstream ?? 'no remote'}</span>
          <button class="iconbtn" title="Fetch & refresh" disabled={busy} onclick={() => refresh(true)}>
            <Icon n="refresh" />
          </button>
        </div>

        {#if st.files.length}
          <div class="git-files">
            {#each st.files as f (f.path)}
              <div class="git-file" data-status={f.status}>
                <span class="git-file-badge">{f.status[0].toUpperCase()}</span>
                <span class="git-file-path" title={f.path}>{f.path}</span>
              </div>
            {/each}
          </div>
        {:else}
          <div class="git-empty">
            {clean ? 'Everything committed and pushed.' : 'No local changes.'}
          </div>
        {/if}

        <button class="btn btn--primary btn--block git-sync" disabled={busy || clean} onclick={sync}>
          {busy ? 'Syncing…' : syncLabel}
        </button>

        {#if result}
          {#if !result.ok}
            <div class="git-error">⚠ {result.error} — finish up in the terminal (⌘J).</div>
          {/if}
          {#if result.log.trim()}
            <pre class="git-log">{result.log.trim()}</pre>
          {/if}
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .git-panel {
    position: relative;
  }
  .git-backdrop {
    position: fixed;
    inset: 0;
    z-index: 99;
    background: transparent;
    border: none;
    cursor: default;
  }
  .git-menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 100;
    width: 320px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-sm, 8px);
    box-shadow: var(--shadow-lg, 0 8px 24px rgba(0, 0, 0, 0.35));
  }
  .git-head {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text-secondary);
    font-size: 12px;
  }
  .git-head :global(svg) {
    width: 14px;
    height: 14px;
    flex: none;
  }
  .git-branch {
    color: var(--text);
    font-weight: 600;
  }
  .git-remote {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-faint);
  }
  .git-files {
    max-height: 180px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .git-file {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    padding: 2px 4px;
    border-radius: var(--r-xs);
  }
  .git-file-badge {
    flex: none;
    width: 16px;
    text-align: center;
    font-family: var(--font-mono, monospace);
    font-size: 10.5px;
    color: var(--accent);
  }
  .git-file[data-status='deleted'] .git-file-badge,
  .git-file[data-status='conflict'] .git-file-badge {
    color: var(--danger, #e5534b);
  }
  .git-file-path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
  }
  .git-empty {
    font-size: 12px;
    color: var(--text-faint);
    padding: 2px 4px;
  }
  .git-error {
    font-size: 12px;
    color: var(--danger, #e5534b);
  }
  .git-log {
    margin: 0;
    max-height: 140px;
    overflow: auto;
    padding: 8px;
    background: var(--surface-inset);
    border-radius: var(--r-xs);
    font-family: var(--font-mono, monospace);
    font-size: 10.5px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text-secondary);
  }
</style>
