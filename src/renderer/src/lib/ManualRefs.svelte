<script lang="ts">
  // Per-project manual references: a hand-maintained bibliography for sources the
  // user wants to cite but NOT register in the global library (policy articles,
  // news, web pages, working papers — things with no PDF/DOI to enrich). Backed
  // by `.lctrn/extra-refs.json`, which lctrn compiles into `.lctrn/extra.bib`;
  // both bibs are wired into the manuscript front matter, so `@citekey` resolves
  // a manual reference just like a library paper.
  import Icon from './Icon.svelte'
  import type { ManualRef, ManualRefType } from '../global'

  let { projectPath, onclose }: { projectPath: string; onclose: () => void } = $props()

  let refs = $state<ManualRef[]>([])
  let busy = $state(false)

  const TYPES: { value: ManualRefType; label: string; container: string }[] = [
    { value: 'article', label: 'Article', container: 'Journal' },
    { value: 'online', label: 'Web page', container: 'Website / organization' },
    { value: 'report', label: 'Report', container: 'Institution' },
    { value: 'book', label: 'Book', container: 'Publisher' },
    { value: 'misc', label: 'Other', container: 'Published in' }
  ]

  const blank = (): {
    type: ManualRefType
    citekey: string
    title: string
    authors: string
    year: string
    container: string
    url: string
    doi: string
    note: string
  } => ({
    type: 'online',
    citekey: '',
    title: '',
    authors: '',
    year: '',
    container: '',
    url: '',
    doi: '',
    note: ''
  })
  let draft = $state(blank())
  // citekey of the reference currently being edited, or null when adding a new one.
  let editingKey = $state<string | null>(null)

  const containerLabel = $derived(
    TYPES.find((t) => t.value === draft.type)?.container ?? 'Published in'
  )
  const canSave = $derived(draft.title.trim().length > 0 && !busy)

  async function refresh(): Promise<void> {
    refs = await window.api.projects.extraRefs.list(projectPath)
  }
  $effect(() => {
    void refresh()
  })

  function startEdit(r: ManualRef): void {
    editingKey = r.citekey
    draft = {
      type: r.type,
      citekey: r.citekey,
      title: r.title,
      authors: r.authors.join('\n'),
      year: r.year,
      container: r.container,
      url: r.url,
      doi: r.doi,
      note: r.note
    }
  }

  function cancelEdit(): void {
    editingKey = null
    draft = blank()
  }

  async function save(): Promise<void> {
    if (!canSave) return
    busy = true
    try {
      const d = $state.snapshot(draft)
      const ref = {
        type: d.type,
        citekey: d.citekey,
        title: d.title,
        authors: d.authors
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        year: d.year,
        container: d.container,
        url: d.url,
        doi: d.doi,
        note: d.note
      }
      refs = editingKey
        ? await window.api.projects.extraRefs.update(projectPath, editingKey, ref)
        : await window.api.projects.extraRefs.add(projectPath, ref)
      editingKey = null
      draft = blank()
    } catch (err) {
      console.error('Failed to save manual reference', err)
      alert('Could not save reference: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      busy = false
    }
  }

  async function del(citekey: string): Promise<void> {
    busy = true
    try {
      refs = await window.api.projects.extraRefs.delete(projectPath, citekey)
      if (editingKey === citekey) cancelEdit()
    } finally {
      busy = false
    }
  }

  // Show a corporate author ({…}-wrapped, kept literal in the bib) without its braces.
  function displayAuthor(a: string): string {
    const t = a.trim()
    return t.startsWith('{') && t.endsWith('}') ? t.slice(1, -1).trim() : t
  }

  function meta(r: ManualRef): string {
    const authors = r.authors.map(displayAuthor).join(', ')
    return [authors, r.year, r.container].filter(Boolean).join(' · ')
  }
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onclose() } }} />
<div class="mr-backdrop" role="presentation" onclick={onclose}></div>
<div class="mr" role="dialog" aria-label="Manual references">
  <header class="mr-head">
    <div>
      <h3>Manual references</h3>
      <p class="mr-sub">
        Sources cited from this project but kept out of the library — policy articles, news,
        web pages. Saved to <code>.lctrn/extra.bib</code> and cited as <code>@citekey</code>.
      </p>
    </div>
    <button class="iconbtn" title="Close" onclick={onclose}><Icon n="x" /></button>
  </header>

  <div class="mr-body">
    <!-- Existing refs -->
    <ul class="mr-list">
      {#each refs as r (r.citekey)}
        <li class="mr-row" data-editing={editingKey === r.citekey}>
          <span class="mr-row-main">
            <span class="mr-row-title">{r.title || r.citekey}</span>
            <span class="mr-row-meta">@{r.citekey}{meta(r) ? ' · ' + meta(r) : ''}</span>
          </span>
          <button class="iconbtn mr-act" title="Edit reference" disabled={busy} onclick={() => startEdit(r)}>
            <Icon n="pen" />
          </button>
          <button class="iconbtn mr-act" title="Delete reference" disabled={busy} onclick={() => del(r.citekey)}>
            <Icon n="x" />
          </button>
        </li>
      {:else}
        <li class="mr-empty">No manual references yet.</li>
      {/each}
    </ul>

    <!-- Add / edit form -->
    <div class="mr-form">
      <h4>{editingKey ? 'Edit reference' : 'Add a reference'}</h4>
      <div class="frm">
        <div class="frm-row">
          <label class="frm-type">Type
            <select bind:value={draft.type}>
              {#each TYPES as t (t.value)}<option value={t.value}>{t.label}</option>{/each}
            </select>
          </label>
          <label>Citekey <small>optional</small>
            <input bind:value={draft.citekey} placeholder="auto from title/author/year" />
          </label>
        </div>
        <label>Title
          <textarea rows="2" bind:value={draft.title} placeholder="Title of the source"></textarea>
        </label>
        <label>Authors <small>one per line · person: “Lastname, First” · organization: wrap in {'{ }'} e.g. {'{Alliance for Corporate Transparency}'}</small>
          <textarea rows="2" bind:value={draft.authors} placeholder={'Lastname, First\n{Organization name}'}></textarea>
        </label>
        <div class="frm-row">
          <label class="frm-year">Year<input bind:value={draft.year} placeholder="2026" /></label>
          <label>{containerLabel}<input bind:value={draft.container} /></label>
        </div>
        <label>URL<input bind:value={draft.url} placeholder="https://…" /></label>
        <div class="frm-row">
          <label>DOI <small>optional</small><input bind:value={draft.doi} /></label>
          <label>Note <small>optional</small><input bind:value={draft.note} placeholder="e.g. accessed 2026-06-18" /></label>
        </div>
      </div>
      <div class="mr-foot">
        {#if editingKey}
          <button class="btn" disabled={busy} onclick={cancelEdit}>Cancel</button>
        {/if}
        <button class="btn btn--primary" disabled={!canSave} onclick={save}>
          <Icon n={editingKey ? 'check' : 'plus'} />{editingKey ? 'Save changes' : 'Add reference'}
        </button>
      </div>
    </div>
  </div>
</div>

<style>
  .mr-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 40;
  }
  .mr {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(640px, 92vw);
    max-height: 86vh;
    display: flex;
    flex-direction: column;
    background: var(--panel, #fff);
    color: var(--ink, #111);
    border: 1px solid var(--border, #d9d9d9);
    border-radius: 10px;
    box-shadow: 0 18px 60px rgba(0, 0, 0, 0.3);
    z-index: 41;
    overflow: hidden;
  }
  .mr-head {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border, #e5e5e5);
  }
  .mr-head h3 {
    margin: 0 0 2px;
    font-size: 15px;
  }
  .mr-sub {
    margin: 0;
    font-size: 12px;
    color: var(--muted, #6b6b6b);
    line-height: 1.45;
  }
  .mr-sub code,
  .mr-row-meta {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .mr-head .iconbtn {
    margin-left: auto;
  }
  .mr-body {
    padding: 12px 16px 16px;
    overflow: auto;
  }
  .mr-list {
    list-style: none;
    margin: 0 0 14px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .mr-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 8px;
    border-radius: 6px;
  }
  .mr-row:hover {
    background: var(--hover, #f3f3f3);
  }
  .mr-row-main {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }
  .mr-row-title {
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mr-row-meta {
    font-size: 11px;
    color: var(--muted, #6b6b6b);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mr-act {
    opacity: 0.5;
  }
  .mr-row:hover .mr-act {
    opacity: 1;
  }
  .mr-row[data-editing='true'] {
    background: var(--accent-weak, #eef3ff);
    box-shadow: inset 2px 0 0 var(--accent, #3b6fff);
  }
  .mr-row[data-editing='true'] .mr-act {
    opacity: 1;
  }
  .mr-empty {
    list-style: none;
    padding: 16px 8px;
    font-size: 13px;
    color: var(--muted, #6b6b6b);
    text-align: center;
  }
  .mr-form {
    border-top: 1px solid var(--border, #e5e5e5);
    padding-top: 12px;
  }
  .mr-form h4 {
    margin: 0 0 8px;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted, #6b6b6b);
  }
  .frm {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .frm label {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 11px;
    color: var(--muted, #6b6b6b);
    flex: 1;
  }
  .frm small {
    color: var(--muted, #999);
    font-weight: 400;
  }
  .frm input,
  .frm select,
  .frm textarea {
    font-size: 13px;
    color: var(--ink, #111);
    padding: 5px 7px;
    border: 1px solid var(--border, #d0d0d0);
    border-radius: 5px;
    background: var(--field, #fff);
    font-family: inherit;
  }
  .frm textarea {
    resize: vertical;
  }
  .frm-row {
    display: flex;
    gap: 8px;
  }
  .frm-type,
  .frm-year {
    flex: 0 0 38%;
  }
  .mr-foot {
    display: flex;
    justify-content: flex-end;
    margin-top: 12px;
  }
</style>
