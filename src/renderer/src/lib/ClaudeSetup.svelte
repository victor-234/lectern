<script lang="ts">
  import Icon from './Icon.svelte'
  import type { ApiKeyState, ClaudeCliStatus } from '../global'

  /**
   * The one place that answers "where do I put my Claude?".
   *
   * Two different credentials live here, and the distinction is the whole point
   * of the panel:
   *
   *  1. **Claude Code** — the CLI the embedded terminal runs. Lectern never sees
   *     this credential and doesn't want to: it spawns your login shell, so you
   *     authenticate once with `claude` in a terminal and every project inherits
   *     it. All this panel can do is tell you whether it's there and working.
   *  2. **An Anthropic API key** — genuinely optional, and only for the two
   *     features that call the API directly rather than going through the
   *     terminal.
   */

  let { onclose }: { onclose: () => void } = $props()

  let cli = $state<ClaudeCliStatus | null>(null)
  let testing = $state(false)
  let testResult = $state<{ ok: boolean; error?: string } | null>(null)

  let key = $state<ApiKeyState | null>(null)
  let keyInput = $state('')
  let keySaving = $state(false)
  let keyError = $state('')

  const INSTALL = 'npm install -g @anthropic-ai/claude-code'

  async function refresh(): Promise<void> {
    cli = null
    testResult = null
    cli = await window.api.ai.claude.status()
  }

  async function test(): Promise<void> {
    testing = true
    testResult = null
    try {
      testResult = await window.api.ai.claude.test()
      cli = await window.api.ai.claude.status()
    } finally {
      testing = false
    }
  }

  async function saveKey(): Promise<void> {
    keySaving = true
    keyError = ''
    try {
      await window.api.ai.setKey(keyInput)
      keyInput = ''
      key = await window.api.ai.keyState()
    } catch (e) {
      keyError = e instanceof Error ? e.message : String(e)
    } finally {
      keySaving = false
    }
  }

  let copied = $state(false)
  async function copyInstall(): Promise<void> {
    try {
      await navigator.clipboard.writeText(INSTALL)
      copied = true
      setTimeout(() => (copied = false), 1500)
    } catch {
      /* clipboard blocked — the command is on screen to copy by hand */
    }
  }

  $effect(() => {
    void refresh()
    window.api.ai.keyState().then((s) => (key = s))
  })
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onclose()} />

<div class="cs-backdrop" role="presentation" onclick={onclose}></div>

<div class="cs" role="dialog" aria-modal="true" aria-label="Claude setup">
  <header>
    <Icon n="sparkle" />
    <span class="cs__title">Claude setup</span>
    <button class="iconbtn" onclick={onclose} aria-label="Close"><Icon n="x" /></button>
  </header>

  <div class="cs__body">
    <!-- 1 · Claude Code ---------------------------------------------------- -->
    <section>
      <div class="cs__row">
        <h3>Claude Code</h3>
        {#if cli === null}
          <span class="cs__state">checking…</span>
        {:else if cli.found}
          <span class="cs__state" data-ok="true">installed</span>
        {:else}
          <span class="cs__state" data-warn="true">not found</span>
        {/if}
      </div>

      <p class="cs__hint">
        This is what the terminal runs. Lectern never stores this credential — it
        starts your login shell, so <code>claude</code> uses whatever account you
        logged in with there.
      </p>

      {#if cli?.found}
        <dl class="cs__facts">
          <dt>Version</dt>
          <dd>{cli.version ?? 'unknown'}</dd>
          <dt>Path</dt>
          <dd class="cs__path">{cli.path}</dd>
        </dl>
        <p class="cs__hint">
          Installed isn't the same as logged in. Testing sends one very short
          message to check.
        </p>
      {:else if cli}
        <p class="cs__hint">
          Install it, then run <code>claude</code> once in a terminal to log in —
          with a Claude subscription or an API key. Lectern picks it up from
          there; no restart needed.
        </p>
        <div class="cs__cmd">
          <code>{INSTALL}</code>
          <button class="btn btn--secondary" onclick={copyInstall}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
      {/if}

      <div class="cs__actions">
        <button class="btn btn--secondary" onclick={refresh} disabled={cli === null}>
          <Icon n="refresh" />Re-check
        </button>
        <button class="btn btn--primary" onclick={test} disabled={testing || !cli?.found}>
          {testing ? 'Testing…' : 'Test connection'}
        </button>
      </div>

      {#if testResult}
        <p class="cs__result" data-ok={testResult.ok ? 'true' : undefined}>
          {testResult.ok ? 'Claude answered — you’re set up.' : testResult.error}
        </p>
      {/if}
    </section>

    <!-- 2 · Optional API key ----------------------------------------------- -->
    <section>
      <div class="cs__row">
        <h3>Anthropic API key</h3>
        {#if key?.fromEnv}
          <span class="cs__state">from ANTHROPIC_API_KEY</span>
        {:else if key?.present}
          <span class="cs__state" data-ok={key.secure ? 'true' : undefined} data-warn={key.secure ? undefined : 'true'}>
            {key.secure ? 'saved' : 'saved (unencrypted)'}
          </span>
        {:else if key}
          <span class="cs__state">optional</span>
        {/if}
      </div>

      <p class="cs__hint">
        Not needed for the terminal. Two features call the API directly instead
        of going through Claude Code, and only they use this: <strong>Rewrite</strong>
        (edit a selection, get a diff to accept or reject) and reading metadata
        off <strong>scanned PDFs</strong> with no text layer. Both are simply
        unavailable without it.
      </p>

      {#if !key?.fromEnv}
        <div class="cs__cmd">
          <input
            type="password"
            autocomplete="off"
            placeholder={key?.present ? 'Replace key…' : 'sk-ant-…'}
            bind:value={keyInput}
          />
          <button class="btn btn--secondary" disabled={!keyInput.trim() || keySaving} onclick={saveKey}>
            {keySaving ? 'Saving…' : 'Save'}
          </button>
        </div>
        {#if key && !key.secure}
          <p class="cs__hint">
            There's no OS keychain here, so a saved key is written to a
            <code>0600</code> file readable by your account. Exporting
            <code>ANTHROPIC_API_KEY</code> before starting Lectern avoids storing
            it at all.
          </p>
        {/if}
        {#if keyError}<p class="cs__result">{keyError}</p>{/if}
      {/if}
    </section>
  </div>
</div>

<style>
  .cs-backdrop {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: rgba(0, 0, 0, 0.45);
  }
  .cs {
    position: fixed;
    z-index: 61;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(560px, 92vw);
    max-height: 86vh;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    box-shadow: var(--shadow-lg);
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
  }
  header :global(svg) {
    width: 15px;
    height: 15px;
    flex: none;
    color: var(--text-faint);
  }
  .cs__title {
    font-weight: 600;
    font-size: 13px;
  }
  header .iconbtn {
    margin-left: auto;
  }
  .cs__body {
    overflow-y: auto;
    padding: 4px 14px 14px;
  }
  section {
    padding: 14px 0;
  }
  section + section {
    border-top: 1px solid var(--border);
  }
  .cs__row {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }
  h3 {
    margin: 0;
    font-size: 12.5px;
    font-weight: 600;
  }
  .cs__state {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .cs__state[data-ok='true'] {
    color: var(--ok, #30a46c);
  }
  .cs__state[data-warn='true'] {
    color: var(--warn, #d97706);
  }
  .cs__hint {
    margin: 8px 0 0;
    font-size: 12px;
    line-height: 1.55;
    color: var(--text-secondary);
  }
  .cs__facts {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 3px 12px;
    margin: 10px 0 0;
    font-size: 11.5px;
  }
  .cs__facts dt {
    font-family: var(--font-mono);
    font-size: 9.5px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-faint);
    align-self: center;
  }
  .cs__facts dd {
    margin: 0;
    font-family: var(--font-mono);
    color: var(--text-secondary);
  }
  .cs__path {
    word-break: break-all;
  }
  .cs__cmd {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-top: 10px;
  }
  .cs__cmd code,
  .cs__cmd input {
    flex: 1;
    min-width: 0;
    height: var(--h-md);
    display: flex;
    align-items: center;
    padding: 0 9px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text);
    background: var(--surface-inset);
    border: 1px solid var(--border);
    border-radius: var(--r-xs);
  }
  .cs__actions {
    display: flex;
    gap: 8px;
    margin-top: 12px;
  }
  .cs__result {
    margin: 10px 0 0;
    font-size: 12px;
    line-height: 1.5;
    color: var(--danger, #e5484d);
  }
  .cs__result[data-ok='true'] {
    color: var(--ok, #30a46c);
  }
  code {
    font-family: var(--font-mono);
    font-size: 11.5px;
  }
</style>
