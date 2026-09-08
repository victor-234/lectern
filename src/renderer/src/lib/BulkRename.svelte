<script lang="ts">
  // Bulk "Rename files to house style" dialog — the lectern-2 port of v1's
  // BulkRenameModal. Lists every .sources/ PDF whose metadata would yield a
  // different filename, lets the user pick which to apply, and renames them one
  // by one (each rename also updates the registry + master bib). Since the
  // library folder is the Dropbox-synced folder, this is the old "Rename
  // Dropbox" action.
  import Icon from './Icon.svelte'

  let { onclose, ondone }: { onclose: () => void; ondone: () => Promise<void> | void } = $props()

  type Status = 'idle' | 'pending' | 'done' | 'error' | 'skipped'
  type Row = {
    id: string
    title: string
    currentName: string
    proposedName: string
    selected: boolean
    status: Status
    error: string
  }

  let rows = $state<Row[]>([])
  let loading = $state(true)
  let loadError = $state('')
  let running = $state(false)

  const selectedCount = $derived(rows.filter((r) => r.selected && r.status !== 'done').length)
  const allSelected = $derived(
    rows.some((r) => r.status !== 'done') &&
      rows.filter((r) => r.status !== 'done').every((r) => r.selected)
  )
  const doneCount = $derived(rows.filter((r) => r.status === 'done').length)
  const errorCount = $derived(rows.filter((r) => r.status === 'error').length)

  $effect(() => {
    void load()
  })

  async function load(): Promise<void> {
    loading = true
    loadError = ''
    try {
      const proposals = await window.api.library.renamePreview()
      rows = proposals.map((p) => ({
        id: p.id,
        title: p.title,
        currentName: p.currentName,
        proposedName: p.proposedName,
        selected: true,
        status: 'idle' as Status,
        error: ''
      }))
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e)
    } finally {
      loading = false
    }
  }

  function toggleAll(): void {
    const next = !allSelected
    for (const r of rows) if (r.status !== 'done') r.selected = next
  }

  function toggleRow(r: Row): void {
    if (r.status === 'done' || running) return
    r.selected = !r.selected
  }

  async function run(): Promise<void> {
    if (running || selectedCount === 0) return
    running = true
    try {
      for (const r of rows) {
        if (!r.selected || r.status === 'done') continue
        r.status = 'pending'
        r.error = ''
        try {
          const res = await window.api.library.renamePaper(r.id)
          if (res.renamed && res.to) {
            r.currentName = res.to
            r.status = 'done'
            r.selected = false
          } else {
            r.status = 'skipped'
            r.error = res.reason ?? 'unchanged'
          }
        } catch (e) {
          r.status = 'error'
          r.error = e instanceof Error ? e.message : String(e)
        }
      }
      if (doneCount > 0) await ondone()
    } finally {
      running = false
    }
  }

  function close(): void {
    if (!running) onclose()
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      close()
    }
  }}
/>
<div class="br-backdrop" role="presentation" onclick={close}></div>
<div class="br" role="dialog" aria-label="Rename files to house style">
  <header class="br-head">
    <div class="br-titles">
      <span class="br-title">Rename files to house style</span>
      <span class="br-sub">e.g. “Wagner et al. 2024 JFE, Corp governance.pdf”</span>
    </div>
    <span class="br-spacer"></span>
    <button class="iconbtn" title="Close" disabled={running} onclick={close}><Icon n="x" /></button>
  </header>

  <div class="br-body">
    {#if loading}
      <div class="br-empty">Scanning library…</div>
    {:else if loadError}
      <div class="br-error">{loadError}</div>
    {:else if rows.length === 0}
      <div class="br-empty">
        Every PDF already matches the house style, or lacks the metadata (year,
        journal, or title) needed to build a name.
      </div>
    {:else}
      <div class="br-summary">
        <span>{rows.length} file{rows.length === 1 ? '' : 's'} would change</span>
        <span class="dot">·</span>
        <span>{selectedCount} selected</span>
        {#if doneCount > 0}<span class="dot">·</span><span class="ok">{doneCount} renamed</span>{/if}
        {#if errorCount > 0}<span class="dot">·</span><span class="err">{errorCount} failed</span>{/if}
      </div>

      <div class="br-table-wrap">
        <table class="br-table">
          <thead>
            <tr>
              <th class="col-check">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onchange={toggleAll}
                  disabled={running}
                  aria-label="Select all"
                />
              </th>
              <th>Current</th>
              <th>Proposed</th>
              <th class="col-status">Status</th>
            </tr>
          </thead>
          <tbody>
            {#each rows as r (r.id)}
              <tr class:is-done={r.status === 'done'} class:is-error={r.status === 'error'}>
                <td class="col-check">
                  <input
                    type="checkbox"
                    checked={r.selected}
                    onchange={() => toggleRow(r)}
                    disabled={running || r.status === 'done'}
                    aria-label="Select {r.title}"
                  />
                </td>
                <td>
                  <code class="fname">{r.currentName}</code>
                  <div class="br-papertitle" title={r.title}>{r.title}</div>
                </td>
                <td><code class="fname fname--new">{r.proposedName}</code></td>
                <td class="col-status">
                  {#if r.status === 'pending'}
                    <span class="st st--pending">Renaming…</span>
                  {:else if r.status === 'done'}
                    <span class="st st--ok">✓ Renamed</span>
                  {:else if r.status === 'error'}
                    <span class="st st--err" title={r.error}>✗ {r.error}</span>
                  {:else if r.status === 'skipped'}
                    <span class="st st--skip" title={r.error}>Skipped</span>
                  {:else}
                    <span class="st st--idle">—</span>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>

  <footer class="br-foot">
    <button class="btn btn--secondary" disabled={running} onclick={close}>
      {doneCount > 0 ? 'Done' : 'Cancel'}
    </button>
    {#if !loading && !loadError && rows.length > 0}
      <button class="btn btn--primary" disabled={running || selectedCount === 0} onclick={run}>
        {running
          ? 'Renaming…'
          : selectedCount === 0
            ? 'Rename selected'
            : `Rename ${selectedCount} file${selectedCount === 1 ? '' : 's'}`}
      </button>
    {/if}
  </footer>
</div>

<style>
  .br-backdrop {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: rgba(0, 0, 0, 0.42);
  }
  .br {
    position: fixed;
    z-index: 61;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(860px, 92vw);
    height: min(620px, 86vh);
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-md);
    box-shadow: var(--shadow-lg, var(--shadow-sm));
    overflow: hidden;
  }
  .br-head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 13px 14px;
    border-bottom: 1px solid var(--border);
  }
  .br-titles {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .br-title {
    font-family: var(--font-sans);
    font-weight: 600;
    font-size: 14px;
    color: var(--text);
  }
  .br-sub {
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-faint);
  }
  .br-spacer {
    flex: 1;
  }
  .br-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 12px 14px;
  }
  .br-empty {
    margin: 36px auto;
    max-width: 380px;
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
    line-height: 1.5;
  }
  .br-error {
    padding: 12px;
    color: var(--danger);
    font-size: 12px;
    font-family: var(--font-mono);
  }
  .br-summary {
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    font-size: 11.5px;
    color: var(--text-muted);
    margin-bottom: 8px;
  }
  .br-summary .dot {
    opacity: 0.4;
  }
  .br-summary .ok {
    color: var(--success);
  }
  .br-summary .err {
    color: var(--danger);
  }
  .br-table-wrap {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
  }
  .br-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  .br-table thead {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--bg-sunken);
  }
  .br-table th {
    text-align: left;
    padding: 7px 9px;
    font-family: var(--font-mono);
    font-size: 9.5px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border);
  }
  .br-table td {
    padding: 7px 9px;
    vertical-align: top;
    border-bottom: 1px solid var(--border);
  }
  .br-table tr:last-child td {
    border-bottom: none;
  }
  .br-table tr.is-done {
    opacity: 0.55;
  }
  .br-table tr.is-error td {
    background: color-mix(in oklab, var(--danger) 7%, transparent);
  }
  .col-check {
    width: 30px;
    text-align: center;
  }
  .col-status {
    width: 150px;
    white-space: nowrap;
  }
  .fname {
    display: inline-block;
    max-width: 100%;
    padding: 1px 6px;
    background: var(--bg-sunken);
    border: 1px solid var(--border);
    border-radius: var(--r-xs);
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text);
    overflow-wrap: anywhere;
  }
  .fname--new {
    border-color: var(--accent-line, var(--accent));
    color: var(--accent);
  }
  .br-papertitle {
    margin-top: 3px;
    font-size: 11px;
    color: var(--text-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 300px;
  }
  .st {
    font-family: var(--font-mono);
    font-size: 11px;
  }
  .st--pending {
    color: var(--warning, var(--text-muted));
  }
  .st--ok {
    color: var(--success);
  }
  .st--err {
    color: var(--danger);
    display: inline-block;
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: bottom;
  }
  .st--skip {
    color: var(--text-faint);
  }
  .st--idle {
    color: var(--text-faint);
  }
  .br-foot {
    flex: none;
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 14px;
    border-top: 1px solid var(--border);
  }
</style>
