<script lang="ts">
  let { oncreated, onclose }: { oncreated: (path: string) => void; onclose: () => void } = $props()

  let title = $state('')
  let authors = $state('')
  let folder = $state('')
  let model = $state('claude-opus-4-8')
  let busy = $state(false)
  let error = $state<string | null>(null)
  let folderEdited = $state(false)

  const models = [
    { id: 'claude-opus-4-8', label: 'Opus 4.8 — most capable' },
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 — balanced' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 — fast' }
  ]

  function slug(s: string): string {
    return s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
  }

  // Keep folder synced to title until the user edits it directly.
  $effect(() => {
    if (!folderEdited) folder = slug(title)
  })

  const valid = $derived(title.trim().length > 0 && folder.trim().length > 0)

  async function create(): Promise<void> {
    if (!valid) return
    busy = true
    error = null
    const meta = {
      title: title.trim(),
      authors: authors
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean),
      manuscriptFile: 'manuscript.qmd',
      model
    }
    const res = await window.api.projects.create({ name: folder.trim(), meta })
    if (res.ok && res.projectPath) {
      oncreated(res.projectPath)
    } else {
      error = res.error ?? 'Could not create project.'
      busy = false
    }
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />
<div class="overlay">
  <button class="backdrop" aria-label="Close" onclick={onclose}></button>
  <div class="modal" role="dialog" aria-modal="true" aria-label="New project">
    <h1>New project</h1>
    <p class="sub">Created inside your library. Attach papers from the global pile afterward.</p>

    <label>
      Title
      <input bind:value={title} placeholder="An Empirical Study of…" />
    </label>
    <label>
      Authors <span class="hint">comma-separated</span>
      <input bind:value={authors} placeholder="Ada Lovelace, Alan Turing" />
    </label>
    <label>
      Folder name
      <input bind:value={folder} oninput={() => (folderEdited = true)} placeholder="my-paper" />
    </label>
    <label>
      Default model
      <select bind:value={model}>
        {#each models as m (m.id)}
          <option value={m.id}>{m.label}</option>
        {/each}
      </select>
    </label>

    {#if error}<p class="err">{error}</p>{/if}

    <div class="actions">
      <button class="btn btn--ghost" onclick={onclose} disabled={busy}>Cancel</button>
      <button class="btn btn--primary" onclick={create} disabled={!valid || busy}>
        {busy ? 'Creating…' : 'Create project'}
      </button>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    z-index: 50;
  }
  .backdrop {
    position: fixed;
    inset: 0;
    background: oklch(0 0 0 / 0.55);
    border: none;
    padding: 0;
    cursor: default;
  }
  .modal {
    position: relative;
    width: 480px;
    max-width: 92vw;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-xl);
    padding: 24px;
    box-shadow: var(--shadow-pop);
  }
  h1 {
    margin: 0 0 4px;
    font-family: var(--font-sans);
    font-weight: 600;
    font-size: 18px;
  }
  .sub {
    color: var(--text-secondary);
    margin: 0;
    font-size: 12.5px;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 14px;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .hint {
    text-transform: none;
    letter-spacing: 0;
    opacity: 0.7;
  }
  input,
  select {
    background: var(--surface-inset);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-sm);
    padding: 8px 10px;
    color: var(--text);
    font-family: var(--font-sans);
    font-size: 13px;
    text-transform: none;
    letter-spacing: 0;
  }
  input:focus,
  select:focus {
    outline: none;
    border-color: var(--accent);
  }
  input::placeholder {
    color: var(--text-faint);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 22px;
  }
  .err {
    color: var(--danger);
    font-size: 12px;
    margin: 12px 0 0;
  }
</style>
