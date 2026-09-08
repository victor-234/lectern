<script lang="ts">
  import Icon from './Icon.svelte'
  import {
    buildHouseFilename,
    displayAuthorName,
    extensionOf,
    normalizeAuthorName
  } from '../../../main/houseName'
  import type { ResolvedPaper, Tag, PaperPatch } from '../global'
  import type { UpdatePaperResult } from '../../../main/library'

  let {
    paper,
    tags = [],
    journals = [],
    projectCount = null,
    writeLabel = null,
    onwrite,
    onread,
    onreading,
    onsave,
    onrefetch,
    onrename,
    ondelete
  }: {
    paper: ResolvedPaper | null
    tags?: Tag[]
    /** Existing journals (name + preferred abbrev) for the journal picker. */
    journals?: { name: string; abbrev: string }[]
    projectCount?: number | null
    /** Footer action label; null hides the footer entirely. */
    writeLabel?: string | null
    onwrite: () => void
    /** Open this paper's PDF in the Reader. */
    onread?: (p: ResolvedPaper) => void
    /** Put this paper on the sidebar reading list, or take it off. */
    onreading?: (p: ResolvedPaper, on: boolean) => Promise<void>
    onsave?: (id: string, patch: PaperPatch) => Promise<UpdatePaperResult | void>
    /** Re-run extraction and overwrite this paper's metadata from its PDF. */
    onrefetch?: (p: ResolvedPaper) => Promise<void>
    /** Rename the PDF on disk to the metadata-derived house style. */
    onrename?: (
      p: ResolvedPaper
    ) => Promise<{ renamed: boolean; reason?: string; from?: string; to?: string }>
    /** Remove this paper from the library (deletes the owned PDF copy too). */
    ondelete?: (p: ResolvedPaper) => Promise<void>
  } = $props()

  const authorList = $derived(
    paper && paper.authors.length
      ? paper.authors.map(displayAuthorName).join(', ')
      : 'Authors not extracted'
  )
  const paperTags = $derived(
    paper?.tagIds ? tags.filter((t) => paper!.tagIds!.includes(t.id)) : []
  )
  const pending = $derived(paper != null && !paper.metaSource)
  const sourceLabel: Record<string, string> = {
    crossref: 'Crossref',
    claude: 'Claude',
    pages: 'Claude (first pages)',
    embedded: 'PDF metadata',
    filename: 'filename',
    imported: 'Imported'
  }

  // ---- edit mode --------------------------------------------------------------
  let editing = $state(false)
  let saving = $state(false)
  let refetching = $state(false)
  let renaming = $state(false)
  let removing = $state(false)
  let generating = $state(false)
  let fetching = $state(false)
  // One-line confirmation after a save propagated a citekey rename ('' = hidden).
  let rewriteMsg = $state('')

  // House-style filename this paper's metadata would produce ('' = too sparse).
  const proposedName = $derived(
    paper
      ? buildHouseFilename(
          {
            title: paper.title,
            authors: paper.authors,
            year: paper.year,
            journal: paper.journalAbbrev || paper.journal
          },
          extensionOf(paper.path)
        )
      : ''
  )
  const currentFileName = $derived(paper ? paper.path.slice(paper.path.lastIndexOf('/') + 1) : '')
  const canRename = $derived(
    !!paper && paper.exists && !!proposedName && proposedName !== currentFileName
  )
  let draft = $state({
    citekey: '',
    title: '',
    authors: '',
    year: '',
    journal: '',
    journalAbbrev: '',
    volume: '',
    issue: '',
    pages: '',
    doi: '',
    url: '',
    abstract: '',
    tagIds: [] as string[]
  })

  // Selecting a different paper drops any in-progress edit + stale confirmation.
  $effect(() => {
    paper?.id
    editing = false
    rewriteMsg = ''
  })

  function startEdit(): void {
    if (!paper) return
    rewriteMsg = ''
    draft = {
      citekey: paper.citekey,
      title: paper.title ?? '',
      authors: paper.authors.join('\n'),
      year: paper.year ?? '',
      journal: paper.journal ?? '',
      journalAbbrev: paper.journalAbbrev ?? '',
      volume: paper.volume ?? '',
      issue: paper.issue ?? '',
      pages: paper.pages ?? '',
      doi: paper.doi ?? '',
      url: paper.url ?? '',
      abstract: paper.abstract ?? '',
      tagIds: [...(paper.tagIds ?? [])]
    }
    editing = true
  }

  // Picking (or typing) a known journal name pulls in its saved abbreviation.
  function onJournalPick(): void {
    const name = draft.journal.trim().toLowerCase()
    const match = journals.find((j) => j.name.trim().toLowerCase() === name)
    if (match?.abbrev) draft.journalAbbrev = match.abbrev
  }

  function toggleDraftTag(id: string): void {
    draft.tagIds = draft.tagIds.includes(id)
      ? draft.tagIds.filter((x) => x !== id)
      : [...draft.tagIds, id]
  }

  // Parse the textarea (one author per line) into normalized "First Last" names.
  // House rule: "Last, First" (has a comma) → "First Last"; bare names kept as-is.
  function draftAuthors(): string[] {
    return draft.authors.split('\n').map(normalizeAuthorName).filter(Boolean)
  }

  async function save(): Promise<void> {
    if (!paper || !onsave) return
    saving = true
    try {
      // $state.snapshot strips the Svelte reactive Proxy — a raw proxy can't
      // cross Electron IPC (structured clone throws DataCloneError).
      const d = $state.snapshot(draft)
      const res = await onsave(paper.id, {
        citekey: d.citekey,
        title: d.title,
        authors: draftAuthors(),
        year: d.year,
        journal: d.journal,
        journalAbbrev: d.journalAbbrev,
        volume: d.volume,
        issue: d.issue,
        pages: d.pages,
        doi: d.doi,
        url: d.url,
        abstract: d.abstract,
        tagIds: [...d.tagIds]
      })
      editing = false
      // Confirm a citekey rename that rippled out into manuscripts/notes.
      rewriteMsg =
        res && res.citekey && res.occurrences > 0
          ? `Renamed @${res.citekey.from} → @${res.citekey.to} in ${res.occurrences} ` +
            `place${res.occurrences === 1 ? '' : 's'} across ${res.files} ` +
            `file${res.files === 1 ? '' : 's'}.`
          : ''
    } catch (err) {
      console.error('Failed to save paper metadata', err)
      alert('Could not save: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      saving = false
    }
  }

  // Fill the Citekey field with a generated `surnameYear` key from the current
  // (possibly unsaved) authors + year. The main process disambiguates against the
  // rest of the library, so the value shown is exactly what a save would store.
  async function generateKey(): Promise<void> {
    if (!paper || generating) return
    generating = true
    try {
      const key = await window.api.library.suggestCitekey(paper.id, draftAuthors(), draft.year)
      if (key) draft.citekey = key
    } catch (err) {
      console.error('Failed to generate citekey', err)
    } finally {
      generating = false
    }
  }

  // Pull canonical metadata for the typed DOI from Crossref into the edit form.
  async function fetchFromDoi(): Promise<void> {
    const doi = draft.doi.trim()
    if (!doi || fetching) return
    fetching = true
    try {
      const m = await window.api.library.fetchDoi(doi)
      if (!m) {
        alert('No Crossref match for that DOI.')
        return
      }
      if (m.title) draft.title = m.title
      if (m.authors && m.authors.length) draft.authors = m.authors.join('\n')
      if (m.year) draft.year = m.year
      if (m.journal) draft.journal = m.journal
      if (m.journalAbbrev) draft.journalAbbrev = m.journalAbbrev
      if (m.volume) draft.volume = m.volume
      if (m.issue) draft.issue = m.issue
      if (m.pages) draft.pages = m.pages
      if (m.abstract) draft.abstract = m.abstract
      if (m.doi) draft.doi = m.doi
      if (m.url) draft.url = m.url
    } catch (err) {
      console.error('Failed to fetch metadata from DOI', err)
      alert('Could not fetch from Crossref: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      fetching = false
    }
  }

  async function refetch(): Promise<void> {
    if (!paper || !onrefetch || refetching) return
    if (
      !confirm(
        'Re-fetch metadata from the DOI/Crossref and PDF? This overwrites the title, authors, year, journal, volume, issue, pages, DOI, URL, and abstract for this entry.'
      )
    )
      return
    refetching = true
    try {
      await onrefetch(paper)
    } catch (err) {
      console.error('Failed to re-fetch paper metadata', err)
      alert('Could not re-fetch: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      refetching = false
    }
  }

  async function rename(): Promise<void> {
    if (!paper || !onrename || renaming || !canRename) return
    if (!confirm(`Rename this PDF on disk to:\n\n${proposedName}\n\n(syncs through Dropbox)`)) return
    renaming = true
    try {
      const res = await onrename(paper)
      if (!res.renamed && res.reason === 'sparse') {
        alert('Not enough metadata to build a filename — add a year, journal, or title first.')
      }
    } catch (err) {
      console.error('Failed to rename paper file', err)
      alert('Could not rename: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      renaming = false
    }
  }

  async function remove(): Promise<void> {
    if (!paper || !ondelete || removing) return
    const owned = paper.path.startsWith('sources/')
    if (
      !confirm(
        `Remove “${paper.title || paper.citekey}” from the library?` +
          (owned
            ? '\n\nThis also deletes the PDF copy in sources/ (syncs through Dropbox).'
            : '\n\nThe registry entry is removed; the external file on disk is left in place.')
      )
    )
      return
    removing = true
    try {
      await ondelete(paper)
    } catch (err) {
      console.error('Failed to remove paper', err)
      alert('Could not remove: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      removing = false
    }
  }

  // ⌘S / Ctrl+S commits the edit while the form is open.
  function onkeydown(e: KeyboardEvent): void {
    if (editing && !saving && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      void save()
    }
  }
</script>

<svelte:window {onkeydown} />

<aside class="inspector">
  {#if !paper}
    <div class="insp-empty">Select a paper to inspect its metadata, abstract, and analyses.</div>
  {:else}
    <div class="insp-head">
      <div class="insp-titlerow">
        <h3 class="insp-title">{paper.title || paper.citekey}</h3>
        {#if onread && paper.exists && !editing}
          <button class="iconbtn" title="Open PDF in Reader" onclick={() => onread(paper)}><Icon n="pdf" /></button>
        {/if}
        {#if onreading && !editing}
          <button
            class="iconbtn"
            class:iconbtn--on={!!paper.readingAt}
            title={paper.readingAt ? 'Remove from reading list' : 'Add to reading list'}
            onclick={() => onreading(paper, !paper.readingAt)}
          ><Icon n="bookmark" /></button>
        {/if}
        {#if onrefetch && paper.exists && !editing}
          <button
            class="iconbtn"
            class:spin={refetching}
            title="Re-fetch metadata from DOI/Crossref + PDF (overwrites all fields)"
            disabled={refetching}
            onclick={refetch}
          ><Icon n="refresh" /></button>
        {/if}
        {#if onrename && paper.exists && !editing}
          <button
            class="iconbtn"
            disabled={!canRename || renaming}
            title={canRename
              ? `Rename file to house style:\n${proposedName}`
              : proposedName
                ? 'Filename already matches the house style'
                : 'Not enough metadata to build a filename'}
            onclick={rename}
          ><Icon n="rename" /></button>
        {/if}
        {#if onsave && !editing}
          <button class="iconbtn" title="Edit metadata" onclick={startEdit}><Icon n="pen" /></button>
        {/if}
        {#if ondelete && !editing}
          <button
            class="iconbtn iconbtn--danger"
            disabled={removing}
            title="Remove from library"
            onclick={remove}
          ><Icon n="trash" /></button>
        {/if}
      </div>
      <div class="insp-authors">{authorList}</div>
    </div>

    {#if rewriteMsg && !editing}
      <div class="insp-rewrite" role="status">{rewriteMsg}</div>
    {/if}

    {#if editing}
      <div class="insp-scroll">
        <div class="insp-sec">
          <h5>Edit metadata</h5>
          <div class="frm">
            <label>Title<textarea rows="2" bind:value={draft.title}></textarea></label>
            <label>Authors <small>one per line · “First Last”, or “Last, First” for multi-word surnames (e.g. “De Franco, Gus” → cites as “De Franco”)</small><textarea rows="4" bind:value={draft.authors}></textarea></label>
            <div class="frm-row">
              <label>Year<input bind:value={draft.year} placeholder="2026" /></label>
              <label>Citekey
                <span class="frm-inline">
                  <input bind:value={draft.citekey} />
                  <button
                    type="button"
                    class="btn btn--secondary frm-inline-btn"
                    title="Generate a surnameYear key from the authors + year"
                    disabled={generating}
                    onclick={generateKey}
                  >{generating ? '…' : 'Generate'}</button>
                </span>
              </label>
            </div>
            <label>Journal<input bind:value={draft.journal} list="journal-list" oninput={onJournalPick} /></label>
            <datalist id="journal-list">
              {#each journals as j (j.name)}
                <option value={j.name} label={j.abbrev || undefined}></option>
              {/each}
            </datalist>
            <label>Abbreviation <small>applies to every paper of this journal</small><input bind:value={draft.journalAbbrev} placeholder="e.g. AOS" /></label>
            <div class="frm-row frm-row--3">
              <label>Volume<input bind:value={draft.volume} placeholder="42" /></label>
              <label>Issue<input bind:value={draft.issue} placeholder="3" /></label>
              <label>Pages<input bind:value={draft.pages} placeholder="123–145" /></label>
            </div>
            <label>DOI <small>fetch fills the fields above from Crossref</small>
              <span class="frm-inline">
                <input bind:value={draft.doi} placeholder="10.…" />
                <button
                  type="button"
                  class="btn btn--secondary frm-inline-btn"
                  title="Look up this DOI on Crossref and fill the form"
                  disabled={fetching || !draft.doi.trim()}
                  onclick={fetchFromDoi}
                >{fetching ? 'Fetching…' : 'Fetch'}</button>
              </span>
            </label>
            <label>URL <small>landing page — the locator for papers with no DOI</small><input bind:value={draft.url} placeholder="https://…" /></label>
            <label>Abstract<textarea rows="6" bind:value={draft.abstract}></textarea></label>
          </div>
        </div>

        <div class="insp-sec">
          <h5>Tags</h5>
          <div class="insp-tags">
            {#each tags as t (t.id)}
              <button
                class="celltag tagbtn"
                data-on={draft.tagIds.includes(t.id)}
                title={t.description}
                onclick={() => toggleDraftTag(t.id)}
              >
                {t.name}
              </button>
            {/each}
          </div>
        </div>
      </div>

      <div class="insp-foot">
        <button class="btn btn--secondary" disabled={saving} onclick={() => (editing = false)}>Cancel</button>
        <button class="btn btn--primary btn--block" title="Save (⌘S)" disabled={saving} onclick={save}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    {:else}
    <div class="insp-scroll">
      <div class="insp-sec">
        <h5>Metadata {#if pending}<span style="color: var(--text-muted); font-weight: 400; text-transform: none; letter-spacing: 0">· fetching…</span>{/if}</h5>
        <dl class="insp-meta">
          <dt>Journal</dt><dd title={paper.journal}>{paper.journal || '—'}</dd>
          <dt>Year</dt><dd>{paper.year || '—'}</dd>
          <dt>Abbrev</dt><dd>{paper.journalAbbrev || '—'}</dd>
          <dt>Citekey</dt><dd style="color: var(--accent)">@{paper.citekey}</dd>
          {#if paper.volume || paper.issue || paper.pages}
            <dt>Vol / Iss</dt>
            <dd>
              {paper.volume || '—'}{#if paper.issue}&nbsp;({paper.issue}){/if}
            </dd>
            <dt>Pages</dt><dd>{paper.pages || '—'}</dd>
          {/if}
          <dt>DOI</dt>
          <dd>
            {#if paper.doi}
              <a href="https://doi.org/{paper.doi}" target="_blank" rel="noreferrer" style="color: var(--accent)">{paper.doi}</a>
            {:else}—{/if}
          </dd>
          <dt>URL</dt>
          <dd>
            {#if paper.url}
              <a href={paper.url} target="_blank" rel="noreferrer" title={paper.url} style="color: var(--accent)">{paper.url}</a>
            {:else}—{/if}
          </dd>
          <dt>Source</dt><dd>{paper.metaSource ? sourceLabel[paper.metaSource] : 'pending'}</dd>
          <dt>File</dt>
          <dd title={paper.absPath}>
            <span class="cellstat">
              <i style="background: {paper.exists ? 'var(--success)' : 'var(--danger)'}"></i>{paper.exists ? paper.path : 'missing on disk'}
            </span>
          </dd>
        </dl>
      </div>

      <div class="insp-sec">
        <h5>Tags</h5>
        {#if paperTags.length}
          <div class="insp-tags">
            {#each paperTags as t (t.id)}
              <span class="celltag" title={t.description}>{t.name}</span>
            {/each}
          </div>
        {:else}
          <p class="insp-abstract empty">Not wired into any tag.</p>
        {/if}
      </div>

      <div class="insp-sec">
        <h5>Abstract</h5>
        {#if paper.abstract}
          <p class="insp-abstract">{paper.abstract}</p>
        {:else}
          <p class="insp-abstract empty">
            {pending ? 'Fetching metadata…' : 'No abstract found for this entry.'}
          </p>
        {/if}
      </div>

      <div class="insp-sec">
        <h5>Analyses</h5>
        <div class="analysis">
          <span class="ic"><Icon n="bookmark" /></span>
          <span class="lbl">In projects<small>references this paper</small></span>
          <span class="val">{projectCount ?? '—'}</span>
        </div>
      </div>
    </div>

    {#if writeLabel}
      <div class="insp-foot">
        <button class="btn btn--primary btn--block" onclick={onwrite}><Icon n="sparkle" />{writeLabel}</button>
      </div>
    {/if}
    {/if}
  {/if}
</aside>

<style>
  .insp-titlerow {
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }
  .insp-titlerow .insp-title {
    flex: 1;
    min-width: 0;
  }
  .insp-titlerow .iconbtn {
    flex: none;
    margin-top: 6px;
  }
  .frm {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .frm-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .frm-row--3 {
    grid-template-columns: 1fr 1fr 1fr;
  }
  .iconbtn.spin :global(svg) {
    animation: insp-spin 0.9s linear infinite;
  }
  @keyframes insp-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .frm label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    /* Grid/flex item: allow it to shrink so its input doesn't force overflow. */
    min-width: 0;
    font-family: var(--font-mono);
    font-size: 9px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .frm label small {
    text-transform: none;
    letter-spacing: 0;
    color: var(--text-faint);
  }
  .frm input,
  .frm textarea {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text);
    background: var(--surface-inset);
    border: 1px solid var(--border);
    border-radius: var(--r-xs);
    padding: 5px 8px;
    outline: none;
    resize: vertical;
    /* Without border-box the intrinsic input width + padding/border overflows the
       column; min-width:0 lets grid/flex children shrink below their content size. */
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    max-width: 100%;
  }
  .frm textarea {
    font-family: var(--font-sans);
    font-size: 12px;
    line-height: 1.45;
  }
  .frm input:focus,
  .frm textarea:focus {
    border-color: var(--accent-line);
  }
  /* Input + inline action button (Generate citekey / Fetch DOI). */
  .frm-inline {
    display: flex;
    gap: 6px;
    align-items: stretch;
  }
  .frm-inline input {
    flex: 1;
  }
  .frm-inline-btn {
    flex: 0 0 auto;
    white-space: nowrap;
  }
  /* Confirmation that a citekey rename rippled into manuscripts/notes. */
  .insp-rewrite {
    margin: 8px 14px 0;
    padding: 7px 10px;
    font-size: 11px;
    line-height: 1.4;
    color: var(--text-muted);
    background: var(--surface-inset);
    border: 1px solid var(--border);
    border-radius: var(--r-xs);
  }
  /* Bookmark toggle reads "on" while the paper sits on the reading list. */
  .iconbtn--on {
    color: var(--accent);
    border-color: var(--accent-line);
  }
  .iconbtn--danger:hover:not(:disabled) {
    color: var(--danger);
    border-color: var(--danger);
  }
  .tagbtn {
    cursor: pointer;
    opacity: 0.5;
  }
  .tagbtn[data-on='true'] {
    opacity: 1;
    border-color: var(--accent-line);
  }
</style>
