<script lang="ts">
  // Checkpoint review — "what did Claude just do to my manuscript?"
  //
  // Claude edits freely in the terminal; this is where you read the result and
  // decide. Turns come from main/checkpoints.ts, each labelled with the prompt
  // that caused it, and each file diffs against the project as it stood before
  // that turn started. Keep leaves the edits in the working tree (GitPanel's
  // Sync then commits them as usual); revert restores the pre-turn file.
  import Icon from './Icon.svelte'
  import type { ReviewState, Checkpoint, CheckpointFile } from '../global'

  let { projectPath, onclose }: { projectPath: string; onclose: () => void } = $props()

  let state = $state<ReviewState | null>(null)
  let selectedTurn = $state<string | null>(null)
  let selectedFile = $state<string | null>(null)
  let patch = $state<string>('')
  let loadingPatch = $state(false)
  let busy = $state(false)
  let error = $state<string | null>(null)
  // Destructive actions are two-step; this holds the key of the armed one.
  let confirming = $state<string | null>(null)

  const turn = $derived(state?.checkpoints.find((c) => c.id === selectedTurn) ?? null)

  async function load(keepSelection = true): Promise<void> {
    const pp = projectPath
    const s = await window.api.projects.review.state(pp)
    if (pp !== projectPath) return
    state = s
    const stillThere =
      keepSelection && s.checkpoints.some((c) => c.id === selectedTurn)
    if (!stillThere) {
      selectedTurn = s.checkpoints[0]?.id ?? null
      selectedFile = s.checkpoints[0]?.files[0]?.path ?? null
    } else if (!turn?.files.some((f) => f.path === selectedFile)) {
      selectedFile = turn?.files[0]?.path ?? null
    }
  }

  // Reload when the project changes, and whenever a turn starts or ends in any
  // embedded session working in this project.
  $effect(() => {
    projectPath
    state = null
    selectedTurn = null
    selectedFile = null
    void load(false)
  })

  $effect(() => {
    return window.api.projects.review.onChanged((p) => {
      if (p === projectPath) void load()
    })
  })

  // Fetch the patch whenever the selected file changes.
  $effect(() => {
    const id = selectedTurn
    const path = selectedFile
    if (!id || !path) {
      patch = ''
      return
    }
    let cancelled = false
    loadingPatch = true
    void window.api.projects.review.patch(projectPath, id, path).then((p) => {
      if (cancelled) return
      patch = p
      loadingPatch = false
    })
    return () => {
      cancelled = true
    }
  })

  async function act<T>(fn: () => Promise<T>): Promise<void> {
    if (busy) return
    busy = true
    error = null
    confirming = null
    try {
      const r = (await fn()) as { ok?: boolean; error?: string } | void
      if (r && r.ok === false) error = r.error ?? 'Failed.'
    } finally {
      busy = false
      await load()
    }
  }

  const keepTurn = (id: string): Promise<void> =>
    act(() => window.api.projects.review.keep(projectPath, id))
  const revertTurn = (id: string): Promise<void> =>
    act(() => window.api.projects.review.revert(projectPath, id))
  const revertFile = (id: string, path: string): Promise<void> =>
    act(() => window.api.projects.review.revertFile(projectPath, id, path))

  async function initRepo(): Promise<void> {
    await act(() => window.api.projects.review.init(projectPath))
  }

  function arm(key: string): void {
    confirming = confirming === key ? null : key
  }

  function ago(iso: string): string {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
    if (s < 60) return 'just now'
    if (s < 3600) return `${Math.round(s / 60)}m ago`
    if (s < 86400) return `${Math.round(s / 3600)}h ago`
    return `${Math.round(s / 86400)}d ago`
  }

  function fileTotals(files: CheckpointFile[]): { added: number; removed: number } {
    return files.reduce(
      (acc, f) => ({ added: acc.added + f.added, removed: acc.removed + f.removed }),
      { added: 0, removed: 0 }
    )
  }

  function label(c: Checkpoint): string {
    const first = c.label.split('\n').find((l) => l.trim()) ?? ''
    return first.trim() || 'Untitled turn'
  }

  // --- Diff rendering --------------------------------------------------------

  type Row = {
    kind: 'add' | 'del' | 'ctx' | 'hunk'
    text: string
    oldNo: number | null
    newNo: number | null
    /** Word-level segments, set only where a −/+ pair could be aligned. */
    parts?: { text: string; changed: boolean }[]
  }

  /**
   * Word-level diff for one −/+ pair. Manuscript lines are whole paragraphs, so
   * a plain line diff would paint an entire paragraph red-then-green for a
   * two-word change — useless for reviewing prose. Standard LCS over
   * whitespace-delimited tokens; bailed out on very long lines so a pasted data
   * blob can't stall the panel.
   */
  function wordParts(
    before: string,
    after: string
  ): { del: { text: string; changed: boolean }[]; add: { text: string; changed: boolean }[] } | null {
    const a = before.split(/(\s+)/)
    const b = after.split(/(\s+)/)
    if (a.length > 1500 || b.length > 1500) return null

    const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
      }
    }
    // Too little in common to be "the same sentence edited" — show it as a
    // wholesale replacement instead of confetti.
    if (dp[0][0] * 2 < Math.min(a.length, b.length)) return null

    const del: { text: string; changed: boolean }[] = []
    const add: { text: string; changed: boolean }[] = []
    const push = (arr: typeof del, text: string, changed: boolean): void => {
      const last = arr[arr.length - 1]
      if (last && last.changed === changed) last.text += text
      else arr.push({ text, changed })
    }
    let i = 0
    let j = 0
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        push(del, a[i], false)
        push(add, b[j], false)
        i++
        j++
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        push(del, a[i++], true)
      } else {
        push(add, b[j++], true)
      }
    }
    while (i < a.length) push(del, a[i++], true)
    while (j < b.length) push(add, b[j++], true)
    return { del, add }
  }

  /** Parse a unified patch into display rows, pairing −/+ runs for word diffing. */
  function parsePatch(text: string): { rows: Row[]; binary: boolean } {
    const lines = text.split('\n')
    const rows: Row[] = []
    let oldNo = 0
    let newNo = 0
    let started = false
    let binary = false

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.startsWith('Binary files')) {
        binary = true
        continue
      }
      if (line.startsWith('@@')) {
        const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
        if (m) {
          oldNo = Number(m[1])
          newNo = Number(m[2])
        }
        rows.push({
          kind: 'hunk',
          text: line.replace(/^@@.*?@@ ?/, '') || '…',
          oldNo: null,
          newNo: null
        })
        started = true
        continue
      }
      if (!started) continue // diff/index/---/+++ preamble
      if (!line) continue // trailing split artefact; real blank lines arrive as ' '
      if (line.startsWith('\\')) continue // "\ No newline at end of file"

      if (line.startsWith('-')) {
        // A run of removals followed by an equal-length run of additions is
        // almost always "these lines were rewritten" — align them one-to-one so
        // the word diff has something meaningful to compare.
        const dels: Row[] = []
        while (i < lines.length && lines[i].startsWith('-')) {
          dels.push({ kind: 'del', text: lines[i].slice(1), oldNo: oldNo++, newNo: null })
          i++
        }
        const adds: Row[] = []
        while (i < lines.length && lines[i].startsWith('+')) {
          adds.push({ kind: 'add', text: lines[i].slice(1), oldNo: null, newNo: newNo++ })
          i++
        }
        i-- // the for-loop's i++ takes us to the line that ended the run
        if (dels.length === adds.length) {
          for (let k = 0; k < adds.length; k++) {
            const wp = wordParts(dels[k].text, adds[k].text)
            if (wp) {
              dels[k].parts = wp.del
              adds[k].parts = wp.add
            }
          }
        }
        rows.push(...dels, ...adds)
      } else if (line.startsWith('+')) {
        rows.push({ kind: 'add', text: line.slice(1), oldNo: null, newNo: newNo++ })
      } else {
        rows.push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ })
      }
    }
    return { rows, binary }
  }

  const parsed = $derived(parsePatch(patch))
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onclose()
    }
  }}
/>

<div class="rv-backdrop" role="presentation" onclick={onclose}></div>
<div class="rv" role="dialog" aria-label="Review Claude's changes">
  <div class="rv-head">
    <div class="rv-title">
      <h3>Review changes</h3>
      <p>
        Grouped by the prompt that caused them. Keeping leaves the edits in place — commit them
        with Sync as usual.
      </p>
    </div>
    <button class="iconbtn" title="Refresh" disabled={busy} onclick={() => load()}>
      <Icon n="refresh" />
    </button>
    <button class="iconbtn" title="Close" onclick={onclose}><Icon n="x" /></button>
  </div>

  {#if error}
    <div class="rv-error">⚠ {error}</div>
  {/if}

  <div class="rv-body">
    {#if !state}
      <div class="rv-blank">Loading…</div>
    {:else if !state.repo}
      <div class="rv-blank rv-blank--action">
        <p>
          Checkpoint review keeps its snapshots in git, and this project isn't a repository yet.
        </p>
        <button class="btn btn--primary" disabled={busy} onclick={initRepo}>
          Initialize repository
        </button>
      </div>
    {:else if !state.checkpoints.length}
      <div class="rv-blank">
        <p>Nothing to review.</p>
        <p class="rv-blank-sub">
          Changes show up here after Claude works on a prompt in the terminal.
        </p>
      </div>
    {:else}
      <div class="rv-turns">
        {#each state.checkpoints as c (c.id)}
          {@const totals = fileTotals(c.files)}
          <div class="rv-turn" class:rv-turn--on={c.id === selectedTurn}>
            <button
              class="rv-turn-head"
              onclick={() => {
                selectedTurn = c.id
                if (!c.files.some((f) => f.path === selectedFile)) selectedFile = c.files[0]?.path ?? null
              }}
            >
              <span class="rv-turn-label" title={c.label}>{label(c)}</span>
              <span class="rv-turn-meta">
                {ago(c.at)} · {c.files.length}
                {c.files.length === 1 ? 'file' : 'files'}
                <span class="rv-plus">+{totals.added}</span>
                <span class="rv-minus">−{totals.removed}</span>
              </span>
            </button>

            {#if c.id === selectedTurn}
              <div class="rv-files">
                {#each c.files as f (f.path)}
                  <div class="rv-file" class:rv-file--on={f.path === selectedFile}>
                    <button class="rv-file-open" onclick={() => (selectedFile = f.path)}>
                      <span class="rv-file-badge" data-status={f.status}>
                        {f.status[0].toUpperCase()}
                      </span>
                      <span class="rv-file-path" title={f.path}>{f.path}</span>
                      {#if f.binary}
                        <span class="rv-file-num">bin</span>
                      {:else}
                        <span class="rv-file-num rv-plus">+{f.added}</span>
                        <span class="rv-file-num rv-minus">−{f.removed}</span>
                      {/if}
                    </button>
                    <button
                      class="rv-revert"
                      class:rv-revert--armed={confirming === `f:${c.id}:${f.path}`}
                      disabled={busy}
                      title="Restore this file to its state before this turn"
                      onclick={() =>
                        confirming === `f:${c.id}:${f.path}`
                          ? revertFile(c.id, f.path)
                          : arm(`f:${c.id}:${f.path}`)}
                    >
                      {confirming === `f:${c.id}:${f.path}` ? 'Sure?' : 'Revert'}
                    </button>
                  </div>
                {/each}
              </div>

              <div class="rv-turn-actions">
                <button class="btn btn--primary" disabled={busy} onclick={() => keepTurn(c.id)}>
                  <Icon n="check" />Keep all
                </button>
                <button
                  class="btn btn--secondary"
                  class:rv-danger={confirming === `t:${c.id}`}
                  disabled={busy}
                  onclick={() => (confirming === `t:${c.id}` ? revertTurn(c.id) : arm(`t:${c.id}`))}
                >
                  {confirming === `t:${c.id}` ? 'Revert everything?' : 'Revert all'}
                </button>
              </div>
            {/if}
          </div>
        {/each}
      </div>

      <div class="rv-diff">
        {#if !selectedFile}
          <div class="rv-blank">Select a file.</div>
        {:else}
          <div class="rv-diff-head">
            <Icon n="file" />
            <span class="rv-diff-path">{selectedFile}</span>
          </div>
          {#if loadingPatch}
            <div class="rv-blank">Loading diff…</div>
          {:else if parsed.binary}
            <div class="rv-blank">Binary file — no text diff.</div>
          {:else if !parsed.rows.length}
            <div class="rv-blank">No textual changes.</div>
          {:else}
            <div class="rv-rows">
              {#each parsed.rows as row, i (i)}
                {#if row.kind === 'hunk'}
                  <div class="rv-row rv-row--hunk"><span class="rv-gutter"></span><span class="rv-text">{row.text}</span></div>
                {:else}
                  <div class="rv-row rv-row--{row.kind}">
                    <span class="rv-gutter">{row.oldNo ?? ''}</span>
                    <span class="rv-gutter">{row.newNo ?? ''}</span>
                    <span class="rv-sign">{row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ''}</span>
                    <span class="rv-text"
                      >{#if row.parts}{#each row.parts as p, k (k)}<span
                            class:rv-word={p.changed}>{p.text}</span
                          >{/each}{:else}{row.text}{/if}</span
                    >
                  </div>
                {/if}
              {/each}
            </div>
          {/if}
        {/if}
      </div>
    {/if}
  </div>

  {#if turn}
    <div class="rv-foot">
      Reverting restores the file as it was <em>before</em> this turn — later changes to the same
      file go with it.
    </div>
  {/if}
</div>

<style>
  .rv-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 40;
  }
  .rv {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(1120px, 94vw);
    height: min(760px, 88vh);
    display: flex;
    flex-direction: column;
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 18px 60px rgba(0, 0, 0, 0.3);
    z-index: 41;
    overflow: hidden;
  }
  .rv-head {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
  }
  .rv-title {
    flex: 1;
    min-width: 0;
  }
  .rv-title h3 {
    margin: 0 0 2px;
    font-size: 15px;
  }
  .rv-title p {
    margin: 0;
    font-size: 11.5px;
    color: var(--text-muted);
  }
  .rv-error {
    padding: 8px 16px;
    font-size: 12px;
    color: var(--danger);
    background: var(--danger-bg);
  }
  .rv-body {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .rv-turns {
    width: 320px;
    flex: none;
    overflow-y: auto;
    border-right: 1px solid var(--border);
    background: var(--bg-sunken);
  }
  .rv-turn {
    border-bottom: 1px solid var(--border-subtle);
  }
  .rv-turn--on {
    background: var(--surface);
  }
  .rv-turn-head {
    display: block;
    width: 100%;
    text-align: left;
    padding: 10px 12px;
    background: none;
    border: none;
    cursor: pointer;
    color: inherit;
  }
  .rv-turn-head:hover {
    background: var(--surface-inset);
  }
  .rv-turn-label {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    font-size: 12.5px;
    line-height: 1.35;
    color: var(--text);
  }
  .rv-turn-meta {
    display: block;
    margin-top: 3px;
    font-size: 10.5px;
    color: var(--text-faint);
  }
  .rv-plus {
    color: var(--success);
  }
  .rv-minus {
    color: var(--danger);
  }
  .rv-files {
    padding: 0 6px 4px;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .rv-file {
    display: flex;
    align-items: center;
    border-radius: var(--r-sm);
  }
  .rv-file--on {
    background: var(--accent-weak);
  }
  .rv-file-open {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px;
    background: none;
    border: none;
    cursor: pointer;
    color: inherit;
    font-size: 11.5px;
    text-align: left;
  }
  .rv-file-badge {
    flex: none;
    width: 14px;
    text-align: center;
    font-family: var(--font-mono, monospace);
    font-size: 10px;
    color: var(--accent);
  }
  .rv-file-badge[data-status='deleted'] {
    color: var(--danger);
  }
  .rv-file-path {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
  }
  .rv-file-num {
    flex: none;
    font-size: 10px;
    font-family: var(--font-mono, monospace);
  }
  .rv-revert {
    flex: none;
    margin-right: 4px;
    padding: 2px 6px;
    font-size: 10px;
    background: none;
    border: 1px solid transparent;
    border-radius: var(--r-sm);
    color: var(--text-faint);
    cursor: pointer;
  }
  .rv-file:hover .rv-revert {
    border-color: var(--border);
    color: var(--text-secondary);
  }
  .rv-revert--armed {
    border-color: var(--danger) !important;
    color: var(--danger) !important;
  }
  .rv-turn-actions {
    display: flex;
    gap: 6px;
    padding: 6px 10px 12px;
  }
  .rv-turn-actions .btn {
    flex: 1;
  }
  .rv-danger {
    border-color: var(--danger);
    color: var(--danger);
  }
  .rv-diff {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .rv-diff-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    font-size: 11.5px;
    color: var(--text-secondary);
  }
  .rv-diff-head :global(svg) {
    width: 13px;
    height: 13px;
    flex: none;
  }
  .rv-diff-path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rv-rows {
    flex: 1;
    overflow: auto;
    font-family: var(--font-mono, monospace);
    font-size: 11.5px;
    line-height: 1.55;
  }
  .rv-row {
    display: flex;
    align-items: baseline;
    padding-right: 12px;
  }
  .rv-row--add {
    background: var(--success-bg);
  }
  .rv-row--del {
    background: var(--danger-bg);
  }
  .rv-row--hunk {
    background: var(--surface-inset);
    color: var(--text-faint);
    padding: 2px 0;
    border-top: 1px solid var(--border-subtle);
    border-bottom: 1px solid var(--border-subtle);
  }
  .rv-gutter {
    flex: none;
    width: 40px;
    padding-right: 8px;
    text-align: right;
    color: var(--text-faint);
    font-size: 10px;
    user-select: none;
  }
  .rv-sign {
    flex: none;
    width: 14px;
    text-align: center;
    color: var(--text-muted);
    user-select: none;
  }
  .rv-text {
    flex: 1;
    min-width: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .rv-word {
    border-radius: 2px;
    padding: 0 1px;
  }
  .rv-row--add .rv-word {
    background: color-mix(in oklch, var(--success) 32%, transparent);
  }
  .rv-row--del .rv-word {
    background: color-mix(in oklch, var(--danger) 28%, transparent);
  }
  .rv-blank {
    margin: auto;
    padding: 40px 24px;
    text-align: center;
    font-size: 12.5px;
    color: var(--text-muted);
  }
  .rv-blank--action {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    max-width: 380px;
  }
  .rv-blank-sub {
    color: var(--text-faint);
    font-size: 11.5px;
  }
  .rv-foot {
    padding: 8px 16px;
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--text-faint);
  }
</style>
