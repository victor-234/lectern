<script lang="ts">
  import Icon from './Icon.svelte'
  import type { ApiKeyState } from '../global'

  // Editor for the library-wide AI writing rules
  // (`<library>/.lctrn/WRITING_RULES.md`) plus the Anthropic key the direct-API
  // writing features use. Both are library/app level, not per project — one
  // place to say how AI writing should sound across every paper.

  let { onclose }: { onclose: () => void } = $props()

  let text = $state('')
  let loaded = $state(false)
  let dirty = $state(false)
  let saving = $state(false)

  // Read-only here: shown so the rules panel can say whether rewriting is
  // available, but edited in ClaudeSetup.svelte.
  let key = $state<ApiKeyState | null>(null)

  $effect(() => {
    window.api.library.writingRules.get().then((c) => {
      text = c
      loaded = true
    })
    window.api.ai.keyState().then((s) => (key = s))
  })

  async function save(): Promise<void> {
    saving = true
    try {
      await window.api.library.writingRules.save(text)
      dirty = false
    } finally {
      saving = false
    }
  }


  // ⌘S saves without closing; Esc closes (prompting only if there's unsaved work).
  function onkeydown(e: KeyboardEvent): void {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault()
      if (dirty) save()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      tryClose()
    }
  }

  function tryClose(): void {
    if (dirty && !confirm('Discard unsaved changes to the writing rules?')) return
    onclose()
  }
</script>

<svelte:window on:keydown={onkeydown} />

<div class="wr-backdrop" role="presentation" onclick={tryClose}></div>
<div class="wr-modal" role="dialog" aria-label="AI writing rules">
  <div class="wr-head">
    <h3>AI writing rules</h3>
    <button class="iconbtn" title="Close" onclick={tryClose}><Icon n="x" /></button>
  </div>
  <p class="wr-sub">
    Library-wide rules for any AI writing that goes into a paper — they apply to every project.
    Stored as <code>.lctrn/WRITING_RULES.md</code> in your library. A project's
    <code>WRITING_STYLE.md</code> adds to these, and its <code>LEARNED_EDITS.md</code> wins over both.
  </p>

  <textarea
    class="wr-text"
    spellcheck="false"
    placeholder={loaded ? 'No rules yet.' : 'Loading…'}
    bind:value={text}
    oninput={() => (dirty = true)}
  ></textarea>

  <!-- The key itself moved to the Claude setup panel, so there is exactly ONE
       place to answer "where does my Claude go". This is the pointer. -->
  <div class="wr-key">
    <div class="wr-key__row">
      <span class="wr-key__label">Anthropic API key</span>
      {#if key?.fromEnv}
        <span class="wr-key__state">from ANTHROPIC_API_KEY</span>
      {:else if key?.present}
        <span class="wr-key__state" data-ok={key.secure ? 'true' : undefined} data-warn={key.secure ? undefined : 'true'}>
          {key.secure ? 'saved' : 'saved (unencrypted file)'}
        </span>
      {:else if key}
        <span class="wr-key__state">not set</span>
      {/if}
    </div>
    <p class="wr-key__hint">
      Rewriting a selection calls the API directly (so you get a diff to accept or
      reject) and needs a key. Set it under <strong>Claude setup</strong> — the
      terminal itself doesn't need one, it uses your Claude Code login.
    </p>
  </div>

  <div class="wr-foot">
    <span class="wr-status">{dirty ? 'Unsaved changes' : loaded ? 'Saved' : ''}</span>
    <button class="btn" onclick={tryClose}>Close</button>
    <button class="btn btn--primary" disabled={!dirty || saving} onclick={save}>
      {saving ? 'Saving…' : 'Save rules'}
    </button>
  </div>
</div>

<style>
  .wr-backdrop {
    position: fixed;
    inset: 0;
    z-index: 59;
    background: rgba(0, 0, 0, 0.45);
  }
  .wr-modal {
    position: fixed;
    z-index: 60;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    display: flex;
    flex-direction: column;
    width: 720px;
    max-width: calc(100vw - 80px);
    height: 80vh;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-sm);
    box-shadow: var(--shadow-pop, var(--shadow-sm));
  }
  .wr-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px 0;
  }
  .wr-head h3 {
    margin: 0;
    font-family: var(--font-sans);
    font-weight: 600;
    font-size: 15px;
    color: var(--text);
  }
  .wr-sub {
    margin: 6px 16px 10px;
    font-size: 12px;
    line-height: 1.5;
    color: var(--text-muted);
  }
  .wr-sub code {
    font-family: var(--font-mono);
    font-size: 11px;
  }
  .wr-text {
    flex: 1;
    min-height: 0;
    margin: 0 16px;
    padding: 10px 12px;
    resize: none;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.6;
    color: var(--text);
    background: var(--surface-inset, var(--surface));
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
  }
  .wr-text:focus {
    outline: none;
    border-color: var(--border-strong);
  }
  .wr-key {
    margin: 12px 16px 0;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
  }
  .wr-key__row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .wr-key__label {
    font-family: var(--font-sans);
    font-size: 12px;
    font-weight: 600;
    color: var(--text);
  }
  .wr-key__state {
    font-size: 11px;
    color: var(--text-muted);
  }
  .wr-key__state[data-ok='true'] {
    color: var(--ok, var(--text-muted));
  }
  .wr-key__state[data-warn='true'] {
    color: var(--warn, var(--text-muted));
  }
  .wr-key__hint {
    margin: 8px 0 0;
    font-size: 11px;
    line-height: 1.5;
    color: var(--text-muted);
  }
  .wr-foot {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 16px 14px;
  }
  .wr-status {
    margin-right: auto;
    font-size: 11px;
    color: var(--text-muted);
  }
</style>
