<script lang="ts">
  // "Talk to your literature." A library-level modal (mirrors the Config modal):
  // a left list of saved inquiries, a right pane that either composes a new one
  // (pick papers by tag/abstract search or by citation key, ask a question) or
  // shows an inquiry's terminal + saved result.md. Each inquiry is a folder under
  // <root>/.lctrn/inquiries/, run by Claude in an embedded terminal.
  import Icon from './Icon.svelte'
  import InquiryTerminal from './InquiryTerminal.svelte'
  import { renderMarkdown } from './markdown'
  import type { ResolvedPaper, Tag, InquirySummary, InquiryDetail, InquirySelection } from '../global'

  let { papers, tags, onclose }: {
    papers: ResolvedPaper[]
    tags: Tag[]
    onclose: () => void
  } = $props()

  let list = $state<InquirySummary[]>([])
  let pane = $state<'compose' | 'detail'>('compose')
  let detail = $state<InquiryDetail | null>(null)
  let termRef = $state<InquiryTerminal | null>(null)
  let running = $state(false)
  let busy = $state(false)

  // ---- composer state -------------------------------------------------------
  let title = $state('')
  let question = $state('')
  let selKind = $state<'filter' | 'manual'>('filter')
  let text = $state('')
  let pickedTags = $state<Set<string>>(new Set())
  let yearFrom = $state('')
  let yearTo = $state('')
  let manualKeys = $state<string[]>([])
  let preview = $state<ResolvedPaper[]>([])

  function buildSelection(): InquirySelection {
    if (selKind === 'manual') return { kind: 'manual', keys: manualKeys }
    return {
      kind: 'filter',
      text: text.trim() || undefined,
      tagIds: pickedTags.size ? [...pickedTags] : undefined,
      yearFrom: yearFrom ? parseInt(yearFrom, 10) : undefined,
      yearTo: yearTo ? parseInt(yearTo, 10) : undefined
    }
  }

  // ---- load / refresh -------------------------------------------------------
  async function refreshList(): Promise<void> {
    list = await window.api.inquiries.list()
  }
  $effect(() => {
    void refreshList()
    const off = window.api.inquiries.onChanged(() => {
      void refreshList()
      // Reload the open inquiry so its result.md lights up live as Claude writes it.
      if (pane === 'detail' && detail) void openInquiry(detail.meta.slug, false)
    })
    return off
  })

  // Live preview of the resolved hit-set as the composer changes (debounced).
  $effect(() => {
    const sel = buildSelection()
    const key = JSON.stringify(sel)
    let cancelled = false
    const t = setTimeout(async () => {
      const res = await window.api.inquiries.resolve(JSON.parse(key))
      if (!cancelled) preview = res
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  })

  async function openInquiry(slug: string, switchPane = true): Promise<void> {
    const d = await window.api.inquiries.read(slug)
    if (!d) return
    detail = d
    if (switchPane) pane = 'detail'
  }

  function newInquiry(): void {
    pane = 'compose'
    detail = null
  }

  // ---- manual picker --------------------------------------------------------
  const pickerHits = $derived.by(() => {
    const q = text.trim().toLowerCase()
    const tok = q.split(/\s+/).filter(Boolean)
    if (!tok.length) return papers
    return papers.filter((p) => {
      const h = [p.title, p.citekey, p.abstract, ...p.authors].filter(Boolean).join(' ').toLowerCase()
      return tok.every((t) => h.includes(t))
    })
  })
  function toggleKey(citekey: string): void {
    manualKeys = manualKeys.includes(citekey)
      ? manualKeys.filter((k) => k !== citekey)
      : [...manualKeys, citekey]
  }
  function toggleTag(id: string): void {
    const n = new Set(pickedTags)
    n.has(id) ? n.delete(id) : n.add(id)
    pickedTags = n
  }

  // ---- create & run ---------------------------------------------------------
  async function createRun(): Promise<void> {
    if (busy || !question.trim() || preview.length === 0) return
    busy = true
    try {
      const created = await window.api.inquiries.create({
        title: title.trim(),
        question: question.trim(),
        selection: buildSelection()
      })
      if (!created) return
      await refreshList()
      await openInquiry(created.meta.slug)
      // Let the detail pane mount its terminal, then spawn + kick off.
      requestAnimationFrame(() => void termRef?.run(created.dir, created.kickoff))
    } finally {
      busy = false
    }
  }

  async function rerun(): Promise<void> {
    if (!detail) return
    await termRef?.run(detail.dir, detail.kickoff)
  }

  async function del(slug: string, e: MouseEvent): Promise<void> {
    e.stopPropagation()
    await window.api.inquiries.delete(slug)
    if (detail?.meta.slug === slug) newInquiry()
    await refreshList()
  }

  function close(): void {
    onclose()
  }

  const canCreate = $derived(question.trim().length > 0 && preview.length > 0 && !busy)
  const tagName = (id: string): string => tags.find((t) => t.id === id)?.name ?? id
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close() } }} />
<div class="iq-backdrop" role="presentation" onclick={close}></div>
<div class="iq" role="dialog" aria-label="Inquiries">
  <!-- Left: saved inquiries -->
  <aside class="iq-side">
    <div class="iq-side-head">Inquiries</div>
    <div class="iq-list">
      {#each list as q (q.slug)}
        <div
          class="iq-item"
          role="button"
          tabindex="0"
          data-on={detail?.meta.slug === q.slug}
          onclick={() => openInquiry(q.slug)}
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') openInquiry(q.slug) }}
        >
          <span class="iq-dot" data-done={q.hasResult}></span>
          <span class="iq-item-main">
            <span class="iq-item-title">{q.title}</span>
            <span class="iq-item-sub">{q.paperCount} paper{q.paperCount === 1 ? '' : 's'}{q.hasResult ? ' · answered' : ''}</span>
          </span>
          <button class="iq-del" title="Delete inquiry" onclick={(e) => del(q.slug, e)}><Icon n="x" /></button>
        </div>
      {:else}
        <div class="iq-empty-list">No inquiries yet.</div>
      {/each}
    </div>
    <div class="iq-newrow">
      <button class="btn btn--secondary iq-new" onclick={newInquiry}><Icon n="plus" />New inquiry</button>
    </div>
  </aside>

  <!-- Right -->
  <section class="iq-main">
    <header class="iq-bar">
      <span class="iq-title">{pane === 'detail' && detail ? detail.meta.title : 'New inquiry'}</span>
      <span class="iq-spacer"></span>
      <button class="iconbtn iq-close" title="Close" onclick={close}><Icon n="x" /></button>
    </header>

    {#if pane === 'compose'}
      <div class="iq-compose">
        <label class="iq-field">
          <span class="iq-label">Question</span>
          <textarea
            class="iq-textarea"
            rows="2"
            bind:value={question}
            placeholder="e.g. How do these papers frame their method?"
          ></textarea>
        </label>
        <label class="iq-field">
          <span class="iq-label">Title <span class="iq-optional">(optional)</span></span>
          <input class="iq-input" bind:value={title} placeholder="Short name for this inquiry" />
        </label>

        <div class="iq-field">
          <span class="iq-label">Papers</span>
          <div class="iq-seg">
            <button data-on={selKind === 'filter'} onclick={() => (selKind = 'filter')}>By tag / abstract</button>
            <button data-on={selKind === 'manual'} onclick={() => (selKind = 'manual')}>By citation key</button>
          </div>
        </div>

        {#if selKind === 'filter'}
          <div class="iq-filter">
            <input class="iq-input" bind:value={text} placeholder="Search titles & abstracts (e.g. field study)…" />
            {#if tags.length}
              <div class="iq-tags">
                {#each tags as t (t.id)}
                  <button class="iq-tag" data-on={pickedTags.has(t.id)} onclick={() => toggleTag(t.id)}>{t.name}</button>
                {/each}
              </div>
            {/if}
            <div class="iq-years">
              <input class="iq-input iq-year" bind:value={yearFrom} placeholder="from yr" inputmode="numeric" />
              <input class="iq-input iq-year" bind:value={yearTo} placeholder="to yr" inputmode="numeric" />
            </div>
          </div>
        {:else}
          <div class="iq-picker">
            <input class="iq-input" bind:value={text} placeholder="Filter papers to add…" />
            <div class="iq-picker-list">
              {#each pickerHits as p (p.id)}
                <button class="iq-pick" data-on={manualKeys.includes(p.citekey)} onclick={() => toggleKey(p.citekey)}>
                  <span class="iq-pick-check">{manualKeys.includes(p.citekey) ? '✓' : ''}</span>
                  <span class="iq-pick-title">{p.title || p.citekey}</span>
                  <span class="iq-pick-key">@{p.citekey}</span>
                </button>
              {/each}
            </div>
          </div>
        {/if}

        <div class="iq-preview">
          <div class="iq-preview-head">{preview.length} paper{preview.length === 1 ? '' : 's'} selected</div>
          <div class="iq-preview-list">
            {#each preview as p (p.id)}
              <div class="iq-prow"><span class="iq-prow-key">@{p.citekey}</span> <span class="iq-prow-title">{p.title || p.citekey}</span> <span class="iq-prow-yr">{p.year ?? ''}</span></div>
            {:else}
              <div class="iq-prow iq-prow--empty">Nothing matches yet.</div>
            {/each}
          </div>
        </div>

        <div class="iq-actions">
          <button class="btn btn--primary" disabled={!canCreate} onclick={createRun}>
            <Icon n="terminal" />{busy ? 'Creating…' : 'Create & run in terminal'}
          </button>
        </div>
      </div>
    {:else if detail}
      <div class="iq-detail">
        <div class="iq-question">{detail.meta.question}</div>
        <div class="iq-paperline">
          {detail.meta.paperIds.length} paper{detail.meta.paperIds.length === 1 ? '' : 's'}
          {#if detail.meta.selection.kind === 'filter' && detail.meta.selection.tagIds?.length}
            · {detail.meta.selection.tagIds.map(tagName).join(', ')}
          {/if}
        </div>

        <div class="iq-split">
          <div class="iq-result">
            {#if detail.resultMd}
              <div class="iq-md">{@html renderMarkdown(detail.resultMd)}</div>
            {:else}
              <div class="iq-result-empty">
                No answer saved yet. Run the inquiry below — Claude reads the selection and writes <code>result.md</code> here.
              </div>
            {/if}
          </div>
          <div class="iq-termwrap">
            <div class="iq-termbar">
              <span class="iq-termlabel">terminal — {running ? 'claude running' : 'idle'}</span>
              <span class="iq-spacer"></span>
              {#if running}
                <button class="btn btn--ghost iq-mini" onclick={() => termRef?.send(detail!.kickoff)}>Resend prompt</button>
              {:else}
                <button class="btn btn--secondary iq-mini" onclick={rerun}><Icon n="terminal" />Run</button>
              {/if}
            </div>
            <InquiryTerminal bind:this={termRef} onrunningchange={(r) => (running = r)} />
          </div>
        </div>
      </div>
    {/if}
  </section>
</div>

<style>
  .iq-backdrop {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: rgba(0, 0, 0, 0.42);
  }
  .iq {
    position: fixed;
    z-index: 61;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(1080px, 94vw);
    height: min(740px, 90vh);
    display: flex;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-lg, var(--shadow-sm));
    overflow: hidden;
  }

  /* sidebar */
  .iq-side {
    flex: none;
    width: 256px;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--border);
    background: var(--bg-sunken);
  }
  .iq-side-head {
    padding: 14px 14px 8px;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .iq-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 4px 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .iq-item {
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
  .iq-item:hover {
    background: var(--accent-weak);
  }
  .iq-item:hover .iq-del {
    opacity: 1;
  }
  .iq-item[data-on='true'] {
    background: var(--accent-weak);
    box-shadow: inset 0 0 0 1px var(--accent-line, var(--border-strong));
  }
  .iq-dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 999px;
    border: 1px solid var(--border-strong);
    background: transparent;
  }
  .iq-dot[data-done='true'] {
    background: var(--success, var(--accent));
    border-color: var(--success, var(--accent));
  }
  .iq-item-main {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
    flex: 1;
  }
  .iq-item-title {
    font-family: var(--font-sans);
    font-size: 12.5px;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .iq-item-sub {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-faint);
  }
  .iq-del {
    flex: none;
    opacity: 0;
    background: transparent;
    border: none;
    color: var(--text-faint);
    cursor: pointer;
    padding: 2px;
    border-radius: var(--r-sm);
  }
  .iq-del:hover {
    color: var(--danger);
  }
  .iq-del :global(svg) {
    width: 12px;
    height: 12px;
  }
  .iq-empty-list {
    padding: 16px 12px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .iq-newrow {
    flex: none;
    padding: 8px;
    border-top: 1px solid var(--border);
  }
  .iq-new {
    width: 100%;
    justify-content: center;
  }

  /* main pane */
  .iq-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .iq-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
  }
  .iq-title {
    font-family: var(--font-sans);
    font-weight: 600;
    font-size: 14px;
    color: var(--text);
  }
  .iq-spacer {
    flex: 1;
  }

  /* composer */
  .iq-compose {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .iq-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .iq-label {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .iq-optional {
    text-transform: none;
    letter-spacing: 0;
    color: var(--text-faint);
  }
  .iq-input,
  .iq-textarea {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    padding: 7px 9px;
    font-family: var(--font-sans);
    font-size: 13px;
    color: var(--text);
    width: 100%;
    box-sizing: border-box;
  }
  .iq-textarea {
    resize: vertical;
  }
  .iq-input:focus,
  .iq-textarea:focus {
    outline: none;
    border-color: var(--accent);
  }
  .iq-seg {
    display: inline-flex;
    gap: 2px;
    background: var(--surface-inset);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    padding: 2px;
    width: fit-content;
  }
  .iq-seg button {
    background: transparent;
    border: none;
    padding: 5px 10px;
    border-radius: var(--r-sm);
    font-size: 12px;
    color: var(--text-muted);
    cursor: pointer;
  }
  .iq-seg button[data-on='true'] {
    background: var(--surface);
    color: var(--text);
    box-shadow: inset 0 0 0 1px var(--border-strong);
  }
  .iq-filter {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .iq-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }
  .iq-tag {
    background: var(--surface-inset);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 3px 10px;
    font-size: 11.5px;
    color: var(--text-secondary);
    cursor: pointer;
  }
  .iq-tag[data-on='true'] {
    background: var(--accent-weak);
    border-color: var(--accent);
    color: var(--text);
  }
  .iq-years {
    display: flex;
    gap: 8px;
  }
  .iq-year {
    width: 100px;
  }
  .iq-picker {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .iq-picker-list {
    max-height: 220px;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
  }
  .iq-pick {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--border);
    padding: 6px 9px;
    cursor: pointer;
  }
  .iq-pick:hover {
    background: var(--accent-weak);
  }
  .iq-pick[data-on='true'] {
    background: var(--accent-weak);
  }
  .iq-pick-check {
    flex: none;
    width: 14px;
    color: var(--accent);
    font-size: 12px;
  }
  .iq-pick-title {
    flex: 1;
    min-width: 0;
    font-size: 12.5px;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .iq-pick-key {
    flex: none;
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--accent);
  }
  .iq-preview {
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    background: var(--surface-inset);
  }
  .iq-preview-head {
    padding: 7px 10px;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border);
  }
  .iq-preview-list {
    max-height: 160px;
    overflow-y: auto;
    padding: 4px 0;
  }
  .iq-prow {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 3px 10px;
    font-size: 12px;
    color: var(--text-secondary);
  }
  .iq-prow-key {
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--accent);
    flex: none;
  }
  .iq-prow-title {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .iq-prow-yr {
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-faint);
  }
  .iq-prow--empty {
    color: var(--text-muted);
  }
  .iq-actions {
    display: flex;
    justify-content: flex-end;
    padding-top: 4px;
  }

  /* detail */
  .iq-detail {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 14px 16px;
    gap: 8px;
  }
  .iq-question {
    font-family: var(--font-sans);
    font-size: 14px;
    color: var(--text);
    line-height: 1.5;
  }
  .iq-paperline {
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-muted);
  }
  .iq-split {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-rows: 1fr 1fr;
    gap: 10px;
  }
  .iq-result {
    min-height: 0;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    padding: 12px 16px;
    background: var(--surface);
  }
  .iq-result-empty {
    color: var(--text-muted);
    font-size: 13px;
    line-height: 1.6;
  }
  .iq-md {
    font-size: 13px;
    line-height: 1.6;
    color: var(--text);
  }
  .iq-md :global(.cite) {
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 0.92em;
  }
  .iq-termwrap {
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .iq-termbar {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .iq-termlabel {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .iq-mini {
    height: 24px;
  }
</style>
