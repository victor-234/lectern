<script lang="ts">
  // "Talk to your literature." A library-level modal (mirrors the Config modal):
  // a left list of saved inquiries, a right pane that either composes a new one
  // (pick papers by tag/abstract search or by citation key, ask a question) or
  // shows an inquiry's terminal + saved result.md. Each inquiry is a folder under
  // <root>/.lctrn/inquiries/, run by Claude in an embedded terminal.
  import Icon from './Icon.svelte'
  import InquiryTerminal from './InquiryTerminal.svelte'
  import { renderMarkdown } from './markdown'
  import { inquiryRun } from './inquiryRun.svelte'
  import type { ResolvedPaper, Tag, InquirySummary, InquiryDetail, InquirySelection } from '../global'

  let { papers, tags, initialSlug = null, onclose }: {
    papers: ResolvedPaper[]
    tags: Tag[]
    /** Inquiry to land on when reopened — set when returning to a background run. */
    initialSlug?: string | null
    onclose: () => void
  } = $props()

  let list = $state<InquirySummary[]>([])
  let pane = $state<'compose' | 'detail'>('compose')
  let detail = $state<InquiryDetail | null>(null)
  let termRef = $state<InquiryTerminal | null>(null)
  let running = $state(false)
  let busy = $state(false)
  // Result-only reading mode: the answer takes the whole pane, terminal parked.
  let expanded = $state(false)

  // ---- composer state -------------------------------------------------------
  let title = $state('')
  let question = $state('')
  let selKind = $state<'filter' | 'manual'>('filter')
  let text = $state('')
  let authorQ = $state('')
  let pickedTags = $state<Set<string>>(new Set())
  let yearFrom = $state('')
  let yearTo = $state('')
  let manualKeys = $state<string[]>([])
  let preview = $state<ResolvedPaper[]>([])
  // Set while the composer is editing a saved draft (its folder already exists).
  let draftSlug = $state<string | null>(null)
  // Signature of what's on disk, so "Saved" flips back to "Save draft" the
  // moment the composer diverges from it.
  let savedSig = $state<string | null>(null)

  function buildSelection(): InquirySelection {
    if (selKind === 'manual') return { kind: 'manual', keys: manualKeys }
    return {
      kind: 'filter',
      text: text.trim() || undefined,
      authors: authorQ.trim() || undefined,
      tagIds: pickedTags.size ? [...pickedTags] : undefined,
      yearFrom: yearFrom ? parseInt(yearFrom, 10) : undefined,
      yearTo: yearTo ? parseInt(yearTo, 10) : undefined
    }
  }

  /** Surnames of every author, so an author hit is visible in the hit list. */
  function authorLine(p: ResolvedPaper): string {
    const names = p.authors.map((a) =>
      a.includes(',') ? a.split(',')[0].trim() : a.trim().split(/\s+/).slice(-1)[0]
    )
    return names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ')
  }

  /** "Abbasi, Vance" → each name must match SOME author, at any position. */
  function authorMatch(p: ResolvedPaper, q: string): boolean {
    const wanted = q.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    if (!wanted.length) return true
    const names = p.authors.map((a) => a.toLowerCase())
    return wanted.every((w) => names.some((n) => n.includes(w)))
  }

  // ---- load / refresh -------------------------------------------------------
  async function refreshList(): Promise<void> {
    list = await window.api.inquiries.list()
  }
  $effect(() => {
    void refreshList()
    // Reopened from the running chip: go straight back to that inquiry, whose
    // terminal then re-attaches to the still-running session.
    if (initialSlug) void openInquiry(initialSlug)
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

  /** A saved draft reopens in the composer; anything run opens its detail. */
  async function openRow(q: InquirySummary): Promise<void> {
    if (!q.draft) {
      await openInquiry(q.slug)
      return
    }
    const d = await window.api.inquiries.read(q.slug)
    if (!d) return
    loadDraft(d)
  }

  function loadDraft(d: InquiryDetail): void {
    const sel = d.meta.selection
    draftSlug = d.meta.slug
    title = d.meta.title
    question = d.meta.question
    selKind = sel.kind === 'manual' ? 'manual' : 'filter'
    text = sel.text ?? ''
    authorQ = sel.authors ?? ''
    pickedTags = new Set(sel.tagIds ?? [])
    yearFrom = sel.yearFrom ? String(sel.yearFrom) : ''
    yearTo = sel.yearTo ? String(sel.yearTo) : ''
    manualKeys = sel.keys ?? []
    detail = null
    pane = 'compose'
    savedSig = composerSig
  }

  function newInquiry(): void {
    pane = 'compose'
    detail = null
    draftSlug = null
    savedSig = null
    title = ''
    question = ''
    text = ''
    authorQ = ''
    pickedTags = new Set()
    yearFrom = ''
    yearTo = ''
    manualKeys = []
  }

  // ---- manual picker --------------------------------------------------------
  const pickerHits = $derived.by(() => {
    const tok = text.trim().toLowerCase().split(/\s+/).filter(Boolean)
    return papers.filter((p) => {
      if (!authorMatch(p, authorQ)) return false
      if (!tok.length) return true
      // Every author is searchable here, not only the first one.
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

  // ---- save / create & run --------------------------------------------------
  /** Write the composer to its folder. `draft` decides whether it stays unrun. */
  async function persist(draft: boolean): Promise<{ dir: string; kickoff: string; slug: string } | null> {
    const args = { title: title.trim(), question: question.trim(), selection: buildSelection() }
    const res = draftSlug
      ? await window.api.inquiries.update({ slug: draftSlug, ...args, draft })
      : await window.api.inquiries.create({ ...args, draft })
    if (!res) return null
    draftSlug = res.meta.slug
    await refreshList()
    return { dir: res.dir, kickoff: res.kickoff, slug: res.meta.slug }
  }

  async function saveDraft(): Promise<void> {
    if (busy || !canSave) return
    busy = true
    try {
      const sig = composerSig
      if (await persist(true)) savedSig = sig
    } finally {
      busy = false
    }
  }

  async function createRun(): Promise<void> {
    if (busy || !canCreate) return
    busy = true
    try {
      const created = await persist(false)
      if (!created) return
      await openInquiry(created.slug)
      draftSlug = null
      savedSig = null
      expanded = false
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
    if (detail?.meta.slug === slug || draftSlug === slug) newInquiry()
    await refreshList()
  }

  // Publish the session state so the toolbar can show a "Claude is working"
  // chip once the modal is closed, and lead the user back here.
  $effect(() => {
    inquiryRun.running = running
    if (running) {
      inquiryRun.slug = detail?.meta.slug ?? null
      inquiryRun.title = detail?.meta.title ?? 'Inquiry'
    }
  })

  function close(): void {
    onclose()
  }

  const composerSig = $derived(
    JSON.stringify([title.trim(), question.trim(), buildSelection()])
  )
  const isDirty = $derived(savedSig !== composerSig)
  const canSave = $derived(question.trim().length > 0 && !busy)
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
          data-on={detail?.meta.slug === q.slug || draftSlug === q.slug}
          onclick={() => openRow(q)}
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') openRow(q) }}
        >
          <span class="iq-dot" data-done={q.hasResult} data-draft={q.draft}></span>
          <span class="iq-item-main">
            <span class="iq-item-title">{q.title}</span>
            <span class="iq-item-sub">
              {q.paperCount} paper{q.paperCount === 1 ? '' : 's'}{q.draft
                ? ' · draft'
                : q.hasResult
                  ? ' · answered'
                  : ''}
            </span>
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
          <span class="iq-label">Title <span class="iq-optional">(optional)</span></span>
          <input class="iq-input" bind:value={title} placeholder="Short name for this inquiry" />
        </label>
        <label class="iq-field">
          <span class="iq-label">Question</span>
          <textarea
            class="iq-textarea"
            rows="5"
            bind:value={question}
            placeholder="e.g. How do these papers frame their method?"
          ></textarea>
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
            <input class="iq-input" bind:value={text} placeholder="Search titles, abstracts & authors (e.g. field study)…" />
            <input
              class="iq-input"
              bind:value={authorQ}
              placeholder="Authors — any position, comma-separated (e.g. Vance, Abbasi)"
            />
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
            <input class="iq-input" bind:value={text} placeholder="Filter papers — title, abstract, any author…" />
            <input
              class="iq-input"
              bind:value={authorQ}
              placeholder="Authors — any position, comma-separated (e.g. Vance, Abbasi)"
            />
            <div class="iq-picker-list">
              {#each pickerHits as p (p.id)}
                <button class="iq-pick" data-on={manualKeys.includes(p.citekey)} onclick={() => toggleKey(p.citekey)}>
                  <span class="iq-pick-check">{manualKeys.includes(p.citekey) ? '✓' : ''}</span>
                  <span class="iq-pick-main">
                    <span class="iq-pick-title">{p.title || p.citekey}</span>
                    {#if p.authors.length}
                      <span class="iq-pick-authors">{p.authors.join(', ')}</span>
                    {/if}
                  </span>
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
              <div class="iq-prow">
                <span class="iq-prow-key">@{p.citekey}</span>
                <span class="iq-prow-title">{p.title || p.citekey}</span>
                {#if p.authors.length}<span class="iq-prow-auth">{authorLine(p)}</span>{/if}
                <span class="iq-prow-yr">{p.year ?? ''}</span>
              </div>
            {:else}
              <div class="iq-prow iq-prow--empty">Nothing matches yet.</div>
            {/each}
          </div>
        </div>

        <div class="iq-actions">
          {#if draftSlug && !isDirty}
            <span class="iq-saved">Draft saved</span>
          {/if}
          <button class="btn btn--secondary" disabled={!canSave} onclick={saveDraft}>
            <Icon n="file" />{draftSlug ? 'Update draft' : 'Save draft'}
          </button>
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

        <div class="iq-split" data-expanded={expanded}>
          <div class="iq-result">
            <div class="iq-resultbar">
              <span class="iq-termlabel">answer — result.md</span>
              <span class="iq-spacer"></span>
              <button
                class="iconbtn iq-expand"
                title={expanded ? 'Show the terminal again' : 'Expand the answer to fill the pane'}
                onclick={() => (expanded = !expanded)}
              >
                <Icon n={expanded ? 'chevron-down' : 'chevron-up'} />
              </button>
            </div>
            <div class="iq-resultbody">
              {#if detail.resultMd}
                <div class="iq-md">{@html renderMarkdown(detail.resultMd)}</div>
              {:else}
                <div class="iq-result-empty">
                  No answer saved yet. Run the inquiry below — Claude reads the selection and writes <code>result.md</code> here.
                </div>
              {/if}
            </div>
          </div>
          <div class="iq-termwrap">
            <div class="iq-termbar">
              <span class="iq-termlabel">terminal — {running ? 'claude running' : 'idle'}</span>
              <span class="iq-spacer"></span>
              {#if running}
                <button class="btn btn--ghost iq-mini" onclick={() => termRef?.send(detail!.kickoff)}>Resend prompt</button>
                <!-- Closing leaves Claude working; the toolbar chip leads back. -->
                <button class="btn btn--secondary iq-mini" title="Close this window and let Claude keep working" onclick={close}>
                  <Icon n="panel" />Work elsewhere
                </button>
                <button class="btn btn--ghost iq-mini" title="Kill the Claude session" onclick={() => termRef?.stop()}>Stop</button>
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
    border-radius: var(--r-md);
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
    border-radius: var(--r-sm);
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
  .iq-dot[data-draft='true'] {
    background: transparent;
    border-style: dashed;
    border-color: var(--text-faint);
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
    border-radius: var(--r-xs);
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
    border-radius: var(--r-xs);
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
    border-radius: var(--r-xs);
    padding: 2px;
    width: fit-content;
  }
  .iq-seg button {
    background: transparent;
    border: none;
    padding: 5px 10px;
    border-radius: var(--r-xs);
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
    border-radius: var(--r-xs);
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
  .iq-pick-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .iq-pick-title {
    min-width: 0;
    font-size: 12.5px;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .iq-pick-authors {
    min-width: 0;
    font-size: 11px;
    color: var(--text-faint);
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
    border-radius: var(--r-xs);
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
  .iq-prow-auth {
    flex: none;
    max-width: 34%;
    font-size: 11px;
    color: var(--text-faint);
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
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    padding-top: 4px;
  }
  .iq-saved {
    margin-right: auto;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-faint);
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
  /* Reading mode: the answer takes the pane, the terminal keeps running out of
     sight (its pty is untouched — only the view is hidden). */
  .iq-split[data-expanded='true'] {
    grid-template-rows: 1fr;
  }
  .iq-split[data-expanded='true'] .iq-termwrap {
    display: none;
  }
  .iq-result {
    min-height: 0;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    background: var(--surface);
    overflow: hidden;
  }
  .iq-resultbar {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 8px 5px 12px;
    border-bottom: 1px solid var(--border);
  }
  .iq-expand :global(svg) {
    width: 13px;
    height: 13px;
  }
  .iq-resultbody {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 12px 16px;
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
  /* Tables in the answer — Claude's comparison grids are the whole point of
     asking across papers, so they get real borders, not run-on prose. */
  .iq-md :global(table) {
    display: block;
    max-width: 100%;
    overflow-x: auto;
    border-collapse: collapse;
    margin: 10px 0;
    font-size: 12.5px;
  }
  .iq-md :global(th),
  .iq-md :global(td) {
    border: 1px solid var(--border);
    padding: 5px 9px;
    text-align: left;
    vertical-align: top;
  }
  .iq-md :global(th) {
    background: var(--surface-inset);
    font-weight: 600;
    white-space: nowrap;
  }
  .iq-md :global(tbody tr:nth-child(even)) {
    background: var(--bg-sunken);
  }
  .iq-md :global(h1),
  .iq-md :global(h2),
  .iq-md :global(h3) {
    font-size: 13.5px;
    margin: 14px 0 6px;
  }
  .iq-md :global(p) {
    margin: 0 0 8px;
  }
  .iq-md :global(ul),
  .iq-md :global(ol) {
    margin: 0 0 8px;
    padding-left: 20px;
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
