<script lang="ts">
  import { onDestroy } from 'svelte'
  import Icon from './Icon.svelte'
  import Editor from './Editor.svelte'
  import type { ResolvedPaper } from '../global'
  import { PROMPT_TEMPLATES, type PromptTemplate } from './promptTemplates'

  let {
    tabs,
    activeId,
    onselect,
    onclose,
    onPrompt
  }: {
    tabs: ResolvedPaper[]
    activeId: string | null
    onselect: (id: string) => void
    onclose: (id: string) => void
    // Expand a template against the active paper and dispatch it to Claude in
    // the terminal. Absent => the templates button is hidden.
    onPrompt?: (text: string) => void
  } = $props()

  // Each tab's PDF is served by the main process over the `lctrn-pdf://`
  // scheme and rendered by Chromium's built-in viewer. Every tab's iframe stays
  // mounted (only the active one is visible) so switching papers is instant and
  // preserves the viewer's scroll/zoom position.
  const pdfUrl = (p: ResolvedPaper): string => `lctrn-pdf://paper/${encodeURIComponent(p.id)}`

  function closeTab(id: string, e: MouseEvent): void {
    e.stopPropagation()
    onclose(id)
  }

  const tabTitle = (p: ResolvedPaper): string => p.title || p.citekey

  // --- Per-paper notes (right panel + notes/<title>.md) ----------------------
  // A markdown note sits beside the active PDF. The moment text is typed it is
  // autosaved to a `.md` file named after the paper (created on first keystroke,
  // removed when emptied) — handled entirely in the main process.
  let showNotes = $state(true)
  let noteInitial = $state('') // feeds <Editor>; only changes on paper switch (remounts it)
  let noteDraft = $state('') // live content from the editor
  let noteSaved = $state('') // last value persisted to disk
  let noteLoading = $state(false)
  let saving = $state(false)
  let noteFile = $state('') // absolute path of the note file, from the main process
  // The paper whose note is currently loaded — tracked separately from `activeId`
  // so a mid-edit tab switch flushes the pending save to the OUTGOING paper.
  let loadedNoteId: string | null = null
  let saveTimer: ReturnType<typeof setTimeout> | null = null

  const activePaper = $derived(tabs.find((t) => t.id === activeId) ?? null)

  // --- Prompt templates (tabstrip button → dropdown → terminal) --------------
  // Expand a template against the active paper and hand it to Claude. Only
  // available for a paper whose PDF exists on disk (the prompt references its path).
  let promptMenuOpen = $state(false)
  const canPrompt = $derived(Boolean(onPrompt && activePaper?.exists))
  // The tabstrip clips overflow, so the menu is positioned `fixed` from the
  // button's viewport rect rather than absolutely inside the strip.
  let promptBtn = $state<HTMLButtonElement | null>(null)
  let promptMenuPos = $state<{ top: number; right: number }>({ top: 0, right: 0 })

  function togglePromptMenu(): void {
    if (promptMenuOpen) {
      promptMenuOpen = false
      return
    }
    if (promptBtn) {
      const r = promptBtn.getBoundingClientRect()
      promptMenuPos = { top: r.bottom + 4, right: window.innerWidth - r.right }
    }
    promptMenuOpen = true
  }

  function runTemplate(t: PromptTemplate): void {
    promptMenuOpen = false
    if (!activePaper) return
    onPrompt?.(
      t.build({
        absPath: activePaper.absPath,
        citekey: activePaper.citekey,
        title: tabTitle(activePaper)
      })
    )
  }
  let noteSaveError = $state<string | null>(null)
  const noteDirty = $derived(noteDraft !== noteSaved)
  const noteState = $derived(saving ? 'saving…' : noteDirty ? 'unsaved' : 'saved')
  // The note's filename (e.g. "notes/Calling for transparency….md"), for the caption.
  const noteFileLabel = $derived(noteFile ? 'notes/' + noteFile.split('/').pop() : '')

  // Load the active paper's note whenever the selection changes. Flip the
  // loading gate synchronously so the editor unmounts and then remounts with the
  // freshly-loaded text — otherwise switching between two papers whose notes are
  // identical strings (e.g. both empty) would leave the previous paper's edits on
  // screen, since the editor only refreshes when its `value` prop changes.
  $effect(() => {
    const id = activeId
    if (id && id !== loadedNoteId) noteLoading = true
    void switchNote(id)
  })

  async function switchNote(id: string | null): Promise<void> {
    // Yield first so the state writes below are outside the effect's tracking
    // scope — otherwise typing (which mutates `noteDraft`) would retrigger this.
    await Promise.resolve()
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    // Flush any unsaved edit to the paper whose note is currently loaded.
    if (loadedNoteId && loadedNoteId !== id && noteDraft !== noteSaved) {
      try {
        await window.api.library.note.save(loadedNoteId, noteDraft)
      } catch (e) {
        // Surface it: the outgoing paper's note edits did NOT reach disk.
        noteSaveError = (e as Error)?.message || 'Could not save note.'
      }
    }
    if (!id) {
      loadedNoteId = null
      noteInitial = noteDraft = noteSaved = ''
      return
    }
    if (id === loadedNoteId) return // re-selecting the same paper — keep edits
    noteLoading = true
    let content = ''
    try {
      const res = await window.api.library.note.get(id)
      content = res.content
      noteFile = res.file
    } catch {
      content = ''
      noteFile = ''
    }
    noteInitial = content
    noteDraft = content
    noteSaved = content
    loadedNoteId = id
    noteLoading = false
  }

  function onNoteChange(v: string): void {
    noteDraft = v
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => void saveNote(), 800)
  }

  async function saveNote(): Promise<void> {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    if (saving || noteDraft === noteSaved || !loadedNoteId) return
    saving = true
    const id = loadedNoteId
    const snapshot = noteDraft
    try {
      await window.api.library.note.save(id, snapshot)
      noteSaved = snapshot
      noteSaveError = null
    } catch (e) {
      noteSaveError = (e as Error)?.message || 'Could not save note.'
    } finally {
      saving = false
    }
  }

  // Leaving Reader mode unmounts this component — flush the last (<800ms) edit.
  onDestroy(() => {
    if (loadedNoteId && noteDraft !== noteSaved) {
      void window.api.library.note.save(loadedNoteId, noteDraft)
    }
  })
</script>

<div class="reader">
  <div class="tabstrip" role="tablist">
    {#each tabs as p, i (p.id)}
      <div class="rtab" role="tab" aria-selected={activeId === p.id} data-on={activeId === p.id}>
        <button class="rtab-main" title={tabTitle(p)} onclick={() => onselect(p.id)}>
          {#if i < 9}<span class="rtab-num">⌘{i + 1}</span>{/if}
          <span class="rtab-name">{tabTitle(p)}</span>
        </button>
        <button class="rtab-x" title="Close (⌘W)" onclick={(e) => closeTab(p.id, e)}>
          <Icon n="x" />
        </button>
      </div>
    {/each}
    <span class="tabstrip-spacer"></span>
    {#if tabs.length && onPrompt}
      <button
        bind:this={promptBtn}
        class="rtmpl-btn"
        data-on={promptMenuOpen}
        disabled={!canPrompt}
        title={canPrompt
          ? 'Send a prompt about this paper to Claude'
          : 'Open a paper to use prompt templates'}
        onclick={togglePromptMenu}
      >
        <Icon n="sparkle" />Prompt
        <Icon n="chevron-down" />
      </button>
      {#if promptMenuOpen}
        <button
          class="rtmpl-backdrop"
          aria-label="Close menu"
          onclick={() => (promptMenuOpen = false)}
        ></button>
        <div
          class="rtmpl-menu"
          role="menu"
          style="top:{promptMenuPos.top}px; right:{promptMenuPos.right}px;"
        >
          <div class="rtmpl-head">Ask Claude about this paper</div>
          {#each PROMPT_TEMPLATES as t (t.id)}
            <button class="rtmpl-item" role="menuitem" onclick={() => runTemplate(t)}>
              <Icon n={t.icon} />
              <span>{t.label}</span>
            </button>
          {/each}
        </div>
      {/if}
    {/if}
    {#if tabs.length}
      <button
        class="rnotes-toggle"
        data-on={showNotes}
        title={showNotes ? 'Hide notes' : 'Show notes'}
        onclick={() => (showNotes = !showNotes)}
      >
        <Icon n="note" />Notes
      </button>
    {/if}
  </div>

  <div class="rstage">
    <div class="rpanes">
      {#each tabs as p (p.id)}
        <div class="rpane" data-on={activeId === p.id}>
          {#if p.exists}
            <iframe class="rframe" src={pdfUrl(p)} title={tabTitle(p)}></iframe>
          {:else}
            <div class="rmsg">
              <Icon n="pdf" />
              <p>Couldn’t open this PDF.</p>
              <small>The file is missing on disk.</small>
            </div>
          {/if}
        </div>
      {/each}
      {#if tabs.length === 0}
        <div class="rmsg">
          <Icon n="pdf" />
          <p>No papers open.</p>
          <small>Double-click a paper, or use the PDF button in the inspector, to read it here.</small>
        </div>
      {/if}
    </div>

    {#if showNotes && activePaper}
      <aside class="rnotes">
        <div class="rnotes-head">
          <Icon n="note" />
          <span class="rnotes-title" title={tabTitle(activePaper)}>{tabTitle(activePaper)}</span>
          <span class="rnotes-spacer"></span>
          {#if noteSaveError}
            <button class="rnotes-state rnotes-state--err" title={noteSaveError} onclick={saveNote}>
              ⚠ save failed
            </button>
          {:else}
            <span class="rnotes-state">{noteState}</span>
          {/if}
          <button class="rnotes-x" title="Hide notes" onclick={() => (showNotes = false)}>×</button>
        </div>
        {#if noteLoading}
          <div class="rnotes-loading">Loading note…</div>
        {:else}
          <div class="rnotes-body">
            <!-- Keep the placeholder short and single-line: a long placeholder
                 inflates the empty document's first line, which makes the caret
                 render its full height. -->
            <Editor
              value={noteInitial}
              onchange={onNoteChange}
              onsave={saveNote}
              placeholder="Write your notes…"
            />
          </div>
          {#if noteFileLabel}
            <div class="rnotes-foot" title={noteFile}>{noteFileLabel}</div>
          {/if}
        {/if}
      </aside>
    {/if}
  </div>
</div>

<style>
  .reader {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg, var(--surface));
  }

  /* ---- Tab strip ---- */
  .tabstrip {
    flex: none;
    display: flex;
    align-items: stretch;
    gap: 2px;
    height: 38px;
    padding: 6px 8px 0;
    overflow-x: auto;
    overflow-y: hidden;
    background: var(--surface-inset);
    border-bottom: 1px solid var(--border);
    scrollbar-width: thin;
  }
  .rtab {
    display: flex;
    align-items: center;
    gap: 2px;
    max-width: 240px;
    min-width: 96px;
    padding: 0 6px 0 4px;
    background: transparent;
    border: 1px solid transparent;
    border-bottom: none;
    border-radius: var(--r-sm) var(--r-sm) 0 0;
    color: var(--text-muted);
    white-space: nowrap;
  }
  .rtab:hover {
    background: var(--surface);
    color: var(--text-secondary);
  }
  .rtab[data-on='true'] {
    background: var(--surface);
    border-color: var(--border-strong, var(--border));
    color: var(--text);
  }
  .rtab-main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 4px 0 6px;
    background: transparent;
    border: none;
    color: inherit;
    font-family: var(--font-sans);
    font-size: 12px;
    cursor: pointer;
  }
  .rtab-num {
    font-family: var(--font-mono);
    font-size: 9px;
    color: var(--text-faint);
  }
  .rtab[data-on='true'] .rtab-num {
    color: var(--accent);
  }
  .rtab-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .rtab-x {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    padding: 0;
    border: none;
    background: transparent;
    border-radius: var(--r-xs, 4px);
    color: var(--text-faint);
    flex: none;
    cursor: pointer;
  }
  .rtab-x :global(svg) {
    width: 11px;
    height: 11px;
  }
  .rtab-x:hover {
    background: var(--surface-inset);
    color: var(--text);
  }

  .tabstrip-spacer {
    flex: 1;
  }
  .rnotes-toggle {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    align-self: center;
    margin: 0 2px;
    padding: 0 10px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--r-sm);
    color: var(--text-muted);
    font-family: var(--font-sans);
    font-size: 11.5px;
    cursor: pointer;
  }
  .rnotes-toggle:hover {
    background: var(--surface);
    color: var(--text-secondary);
  }
  .rnotes-toggle[data-on='true'] {
    color: var(--accent);
    background: var(--accent-weak);
  }
  .rnotes-toggle :global(svg) {
    width: 13px;
    height: 13px;
  }

  /* ---- Prompt templates dropdown ---- */
  .rtmpl-btn {
    flex: none;
    align-self: center;
    margin: 0 2px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 8px 0 10px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--r-sm);
    color: var(--text-muted);
    font-family: var(--font-sans);
    font-size: 11.5px;
    cursor: pointer;
  }
  .rtmpl-btn:hover:not(:disabled),
  .rtmpl-btn[data-on='true'] {
    background: var(--surface);
    color: var(--text-secondary);
  }
  .rtmpl-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .rtmpl-btn :global(svg) {
    width: 13px;
    height: 13px;
  }
  /* The trailing chevron is a touch smaller and faint. */
  .rtmpl-btn :global(svg:last-child) {
    width: 11px;
    height: 11px;
    color: var(--text-faint);
  }
  .rtmpl-backdrop {
    position: fixed;
    inset: 0;
    z-index: 30;
    background: transparent;
    border: none;
    cursor: default;
  }
  .rtmpl-menu {
    position: fixed;
    z-index: 31;
    min-width: 220px;
    padding: 4px;
    background: var(--surface);
    border: 1px solid var(--border-strong, var(--border));
    border-radius: var(--r-md, 8px);
    box-shadow: var(--shadow-md, 0 8px 24px rgba(0, 0, 0, 0.18));
  }
  .rtmpl-head {
    padding: 6px 8px 4px;
    font-family: var(--font-sans);
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-faint);
  }
  .rtmpl-item {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    padding: 7px 8px;
    background: transparent;
    border: none;
    border-radius: var(--r-sm);
    color: var(--text);
    font-family: var(--font-sans);
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
  }
  .rtmpl-item:hover {
    background: var(--accent-weak);
    color: var(--accent);
  }
  .rtmpl-item :global(svg) {
    width: 14px;
    height: 14px;
    flex: none;
    color: var(--text-muted);
  }
  .rtmpl-item:hover :global(svg) {
    color: var(--accent);
  }

  /* ---- PDF stage + notes ---- */
  .rstage {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .rpanes {
    position: relative;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }
  .rpane {
    position: absolute;
    inset: 0;
    display: none;
  }
  .rpane[data-on='true'] {
    display: block;
  }
  .rframe {
    width: 100%;
    height: 100%;
    border: 0;
  }
  .rmsg {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    text-align: center;
    color: var(--text-muted);
    padding: 40px;
  }
  .rmsg :global(svg) {
    width: 28px;
    height: 28px;
    color: var(--text-faint);
  }
  .rmsg p {
    margin: 0;
    font-family: var(--font-sans);
    font-size: 14px;
    color: var(--text-secondary);
  }
  .rmsg small {
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 11px;
    max-width: 420px;
    word-break: break-all;
  }

  /* ---- Notes side panel ---- */
  .rnotes {
    flex: none;
    width: 340px;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-left: 1px solid var(--border);
    background: var(--surface-inset);
  }
  .rnotes-head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    color: var(--text);
  }
  .rnotes-head :global(svg) {
    width: 14px;
    height: 14px;
    flex: none;
    color: var(--text-muted);
  }
  .rnotes-title {
    flex: none;
    min-width: 0;
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-sans);
    font-weight: 600;
    font-size: 12px;
  }
  .rnotes-spacer {
    flex: 1;
  }
  .rnotes-state {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-faint);
  }
  .rnotes-state--err {
    color: var(--danger);
    background: transparent;
    border: none;
    padding: 0;
    cursor: pointer;
    white-space: nowrap;
  }
  .rnotes-state--err:hover {
    text-decoration: underline;
  }
  .rnotes-x {
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
    padding: 0 2px;
  }
  .rnotes-x:hover {
    color: var(--text);
  }
  .rnotes-loading {
    margin: 24px auto;
    color: var(--text-muted);
    font-size: 12px;
  }
  /* The Editor is flex:1 inside its parent — give it a flex column to fill. */
  .rnotes-body {
    flex: 1;
    min-height: 0;
    display: flex;
    padding: 10px;
  }
  .rnotes-foot {
    flex: none;
    padding: 0 12px 10px;
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
