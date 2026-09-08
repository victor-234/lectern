<script lang="ts">
  import FolderPicker from './FolderPicker.svelte'
  import { hostInfo } from './pick'

  let { onready }: { onready: (root: string) => void } = $props()

  let defaultPath = $state('')
  let busy = $state(false)
  // Only shown where the backend has no native dialog to raise for us — served
  // from localhost, the folder to pick lives on the server, not in this browser.
  let picking = $state(false)
  let home = $state('')

  window.api.library.defaultPath().then((p) => (defaultPath = p))

  async function useDefault(): Promise<void> {
    busy = true
    const root = await window.api.library.useDefault()
    onready(root)
  }
  async function choose(): Promise<void> {
    const host = await hostInfo()
    if (!host.nativePickers) {
      home = host.home
      picking = true
      return
    }
    busy = true
    const root = await window.api.library.choose()
    if (root) onready(root)
    else busy = false
  }
  async function chosen(path: string): Promise<void> {
    picking = false
    busy = true
    const root = await window.api.library.choose(path)
    if (root) onready(root)
    else busy = false
  }
</script>

{#if picking}
  <FolderPicker start={defaultPath || home} onchoose={chosen} oncancel={() => (picking = false)} />
{/if}

<div class="setup">
  <div class="card">
    <div class="brand">
      <!-- lctrn mark (logo kit) -->
      <svg width="22" height="22" viewBox="0 0 32 32" fill="none" role="img" aria-label="lctrn">
        <rect x="0.75" y="0.75" width="30.5" height="30.5" rx="7.25" fill="none" stroke="#8d94a1" stroke-opacity="0.5" stroke-width="1.5" />
        <ellipse cx="16" cy="16" rx="10.5" ry="4.4" transform="rotate(-32 16 16)" fill="none" stroke="#8d94a1" stroke-width="1.5" />
        <circle cx="16" cy="16" r="2.1" fill="#ff7849" />
        <circle cx="24.3" cy="10.8" r="1.9" fill="#ff7849" />
      </svg>
      <span class="word">lctrn</span>
    </div>
    <h1>Welcome</h1>
    <p class="sub">
      lctrn keeps everything in one <strong>library folder</strong>: all your projects, plus a
      single pile of paper PDFs. Papers are referenced by path — never copied — so the same PDF can
      back many projects.
    </p>
    <div class="path-box">
      <span class="label">Default location</span>
      <code>{defaultPath || '…'}</code>
    </div>
    <div class="actions">
      <button class="btn btn--primary" onclick={useDefault} disabled={busy}>Use default folder</button>
      <button class="btn btn--secondary" onclick={choose} disabled={busy}>Choose another…</button>
    </div>
  </div>
</div>

<style>
  .setup {
    height: 100vh;
    display: grid;
    place-items: center;
    background: var(--bg);
  }
  .card {
    max-width: 460px;
    padding: 28px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    box-shadow: var(--shadow-lg);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 18px;
  }
  .word {
    font-family: var(--font-mono);
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.03em;
    color: var(--text);
  }
  h1 {
    margin: 0 0 10px;
    font-family: var(--font-sans);
    font-weight: 600;
    font-size: 22px;
  }
  .sub {
    color: var(--text-secondary);
    line-height: 1.55;
    margin: 0;
  }
  .path-box {
    margin: 18px 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .label {
    font-family: var(--font-mono);
    font-size: 9px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  code {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-secondary);
    background: var(--surface-inset);
    border: 1px solid var(--border);
    border-radius: var(--r-xs);
    padding: 7px 10px;
    word-break: break-all;
  }
  .actions {
    display: flex;
    gap: 10px;
  }
</style>
