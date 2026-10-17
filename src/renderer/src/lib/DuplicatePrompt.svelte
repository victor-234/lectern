<script lang="ts">
  // "Add this duplicate?" — shown after Add when some picked PDFs share a
  // filename or citekey with a paper already in the library. The backend has
  // added everything else and is holding these back; we answer with the ones
  // the user still wants (an empty answer drops them all).
  import Icon from './Icon.svelte'
  import type { DuplicateMatch } from '../../../main/library'

  let {
    matches,
    onanswer
  }: { matches: DuplicateMatch[]; onanswer: (accept: number[]) => Promise<void> | void } = $props()

  // Opt-in: a duplicate is only added if the user ticks it. The prompt is
  // mounted fresh for each Add, so seeding from the initial `matches` is right.
  // svelte-ignore state_referenced_locally
  let picked = $state<boolean[]>(matches.map(() => matches.length === 1))
  let busy = $state(false)
  const count = $derived(picked.filter(Boolean).length)
  const single = $derived(matches.length === 1)

  function reasonText(m: DuplicateMatch): string {
    const f = m.reasons.includes('filename')
    const c = m.reasons.includes('citekey')
    return f && c ? 'Same filename and citekey' : f ? 'Same filename' : 'Same citekey'
  }

  async function answer(accept: number[]): Promise<void> {
    if (busy) return
    busy = true
    try {
      await onanswer(accept)
    } finally {
      busy = false
    }
  }
  const skip = (): Promise<void> => answer([])
  const add = (): Promise<void> =>
    answer(picked.flatMap((on, i) => (on ? [i] : [])))

  function onkeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      void skip()
    }
  }
</script>

<svelte:window {onkeydown} />

<div class="dp-backdrop" role="presentation" onclick={skip}></div>
<div class="dp" role="dialog" aria-modal="true" aria-label="Possible duplicates">
  <header class="dp-head">
    <span class="dp-title">
      {single ? 'Add this duplicate?' : `${matches.length} possible duplicates`}
    </span>
    <span class="dp-spacer"></span>
    <button class="iconbtn" title="Skip" disabled={busy} onclick={skip}><Icon n="x" /></button>
  </header>

  <div class="dp-body">
    <p class="dp-lede">
      {single
        ? 'This PDF looks like a paper that is already in your library.'
        : 'These PDFs look like papers already in your library. Tick the ones to add anyway.'}
    </p>
    <ul class="dp-list">
      {#each matches as m, i (i)}
        <li class="dp-row">
          {#if !single}
            <input
              type="checkbox"
              bind:checked={picked[i]}
              disabled={busy}
              aria-label="Add {m.fileName} anyway"
            />
          {/if}
          <div class="dp-info">
            <code class="fname">{m.fileName}</code>
            <div class="dp-match">
              <span class="dp-reason">{reasonText(m)}</span> as
              <span class="dp-existing" title={m.existing.title}>{m.existing.title}</span>
              <span class="dp-key">@{m.existing.citekey}</span>
            </div>
          </div>
        </li>
      {/each}
    </ul>
  </div>

  <footer class="dp-foot">
    <button class="btn btn--secondary" disabled={busy} onclick={skip}>
      {single ? 'Skip' : 'Skip all'}
    </button>
    <button class="btn btn--primary" disabled={busy || count === 0} onclick={add}>
      {single ? 'Add anyway' : count === 0 ? 'Add selected' : `Add ${count} anyway`}
    </button>
  </footer>
</div>

<style>
  .dp-backdrop {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: rgba(0, 0, 0, 0.42);
  }
  .dp {
    position: fixed;
    z-index: 61;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(520px, 92vw);
    max-height: min(560px, 86vh);
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-md);
    box-shadow: var(--shadow-lg, var(--shadow-sm));
    overflow: hidden;
  }
  .dp-head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 13px 14px;
    border-bottom: 1px solid var(--border);
  }
  .dp-title {
    font-family: var(--font-sans);
    font-weight: 600;
    font-size: 14px;
    color: var(--text);
  }
  .dp-spacer {
    flex: 1;
  }
  .dp-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 12px 14px;
  }
  .dp-lede {
    margin: 0 0 10px;
    font-size: 12.5px;
    color: var(--text-muted);
  }
  .dp-list {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
  }
  .dp-row {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--border);
  }
  .dp-row:last-child {
    border-bottom: none;
  }
  .dp-row input {
    margin-top: 3px;
  }
  .dp-info {
    min-width: 0;
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
  .dp-match {
    margin-top: 4px;
    font-size: 11.5px;
    color: var(--text-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dp-reason {
    color: var(--warning, var(--text-muted));
  }
  .dp-existing {
    color: var(--text-muted);
  }
  .dp-key {
    font-family: var(--font-mono);
    font-size: 10.5px;
  }
  .dp-foot {
    flex: none;
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 14px;
    border-top: 1px solid var(--border);
  }
</style>
