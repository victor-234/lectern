<script lang="ts">
  import Icon from './Icon.svelte'
  import { lastName } from '../../../main/houseName'
  import type { ResolvedPaper } from '../global'

  let {
    papers,
    onopen,
    onclose
  }: {
    papers: ResolvedPaper[]
    onopen: (p: ResolvedPaper) => void
    onclose: () => void
  } = $props()

  let query = $state('')
  let active = $state(0)
  let inputEl = $state<HTMLInputElement | null>(null)

  // Focus the field as soon as the palette mounts.
  $effect(() => {
    inputEl?.focus()
  })

  const label = (p: ResolvedPaper): string => p.title || p.citekey
  // Surnames only, up to 3, then "et al." — e.g. "Leuz & Wysocki", "A, B & C",
  // "A, B, C et al." (never the full given names).
  const authorLabel = (authors: string[]): string => {
    const names = (authors ?? []).map(lastName).filter(Boolean)
    if (!names.length) return ''
    const head = names.slice(0, 3)
    const label =
      head.length === 1
        ? head[0]
        : `${head.slice(0, -1).join(', ')} & ${head[head.length - 1]}`
    return names.length > 3 ? `${head.join(', ')} et al.` : label
  }
  const meta = (p: ResolvedPaper): string =>
    [authorLabel(p.authors), p.year, p.journalAbbrev || p.journal].filter(Boolean).join(' · ')

  // Every whitespace token must match somewhere in the paper's metadata (AND),
  // case-insensitively — same rule as the library search. Capped so the list
  // stays snappy. Papers whose PDF is missing are excluded (can't be read).
  const results = $derived.by(() => {
    const openable = papers.filter((p) => p.exists)
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
    const hay = (p: ResolvedPaper): string =>
      [p.title, p.citekey, p.year, p.journal, p.journalAbbrev, ...(p.authors ?? [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
    const matched = tokens.length
      ? openable.filter((p) => { const h = hay(p); return tokens.every((t) => h.includes(t)) })
      : openable
    return matched.slice(0, 50)
  })

  // Keep the highlighted row in range as the result set shrinks/grows.
  $effect(() => {
    if (active >= results.length) active = Math.max(0, results.length - 1)
  })

  function choose(p: ResolvedPaper | undefined): void {
    if (!p) return
    onopen(p)
    onclose()
  }

  function onkeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onclose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      active = Math.min(active + 1, results.length - 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      active = Math.max(active - 1, 0)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(results[active])
    }
  }
</script>

<div class="qo-backdrop" role="presentation" onclick={onclose}></div>
<div class="qo-layer" role="presentation">
  <div class="qo-panel" role="dialog" aria-label="Open paper">
    <div class="qo-search">
      <Icon n="search" />
      <input
        bind:this={inputEl}
        bind:value={query}
        placeholder="Open paper in reader…"
        {onkeydown}
      />
      <span class="qo-hint">↵ open · esc close</span>
    </div>
    <div class="qo-list">
      {#each results as p, i (p.id)}
        <button
          class="qo-row"
          data-active={i === active}
          onmousemove={() => (active = i)}
          onclick={() => choose(p)}
        >
          <span class="qo-ic"><Icon n="pdf" /></span>
          <span class="qo-text">
            <span class="qo-title">{label(p)}</span>
            {#if meta(p)}<span class="qo-meta">{meta(p)}</span>{/if}
          </span>
          <span class="qo-cite">@{p.citekey}</span>
        </button>
      {:else}
        <div class="qo-empty">
          {query.trim() ? `No papers match “${query.trim()}”.` : 'No readable papers in the library.'}
        </div>
      {/each}
    </div>
  </div>
</div>

<style>
  .qo-backdrop {
    position: fixed;
    inset: 0;
    z-index: 200;
    background: rgba(0, 0, 0, 0.32);
    backdrop-filter: blur(1.5px);
    border: none;
  }
  /* Sits above the backdrop to center the panel; transparent to pointer events
     so clicks on the empty area fall through to the backdrop and dismiss. */
  .qo-layer {
    position: fixed;
    inset: 0;
    z-index: 201;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 12vh;
    pointer-events: none;
  }
  .qo-panel {
    pointer-events: auto;
    width: min(620px, 92vw);
    max-height: 64vh;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--border-strong, var(--border));
    border-radius: var(--r-lg, 12px);
    box-shadow: var(--shadow-pop, 0 16px 48px rgba(0, 0, 0, 0.32));
    overflow: hidden;
  }
  .qo-search {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
  }
  .qo-search :global(svg) {
    width: 15px;
    height: 15px;
    color: var(--text-faint);
    flex: none;
  }
  .qo-search input {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    outline: none;
    color: var(--text);
    font-family: var(--font-sans);
    font-size: 14px;
  }
  .qo-hint {
    flex: none;
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-faint);
    white-space: nowrap;
  }
  .qo-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 6px;
  }
  .qo-row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    text-align: left;
    padding: 8px 10px;
    background: transparent;
    border: none;
    border-radius: var(--r-sm);
    color: var(--text-secondary);
    cursor: pointer;
  }
  .qo-row[data-active='true'] {
    background: var(--accent-weak);
    color: var(--text);
  }
  .qo-ic :global(svg) {
    width: 15px;
    height: 15px;
    color: var(--text-faint);
    flex: none;
  }
  .qo-row[data-active='true'] .qo-ic :global(svg) {
    color: var(--accent);
  }
  .qo-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .qo-title {
    font-family: var(--font-sans);
    font-size: 12.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .qo-meta {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .qo-cite {
    flex: none;
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--accent);
  }
  .qo-empty {
    padding: 24px 12px;
    text-align: center;
    color: var(--text-muted);
    font-size: 12.5px;
  }
</style>
