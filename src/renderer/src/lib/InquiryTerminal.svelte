<script lang="ts">
  // A self-contained xterm pane bound to the 'inquiry' pty session, so it runs
  // alongside the project dock's 'main' session without clobbering it. Used by
  // the Inquiries modal to drive Claude inside an inquiry folder.
  //
  // The pty outlives this component: closing the modal detaches the view and
  // leaves Claude working in the background, and mounting re-attaches to the
  // live session and replays its scrollback. Only an explicit Stop kills it.
  import { Terminal } from '@xterm/xterm'
  import { FitAddon } from '@xterm/addon-fit'
  import '@xterm/xterm/css/xterm.css'

  let { onrunningchange }: { onrunningchange?: (running: boolean) => void } = $props()

  const SID = 'inquiry'

  let host: HTMLDivElement
  let term: Terminal
  let fit: FitAddon
  let running = $state(false)
  let error = $state<string | null>(null)

  // Theme follows the live --term-* tokens (softer charcoal in light mode);
  // xterm 6 parses the oklch tokens directly.
  function readTermTheme(): import('@xterm/xterm').ITheme {
    const cs = getComputedStyle(host)
    const v = (name: string): string => cs.getPropertyValue(name).trim()
    const bg = v('--term-bg')
    return {
      background: bg,
      foreground: v('--term-fg'),
      cursor: v('--accent'),
      cursorAccent: bg,
      selectionBackground: v('--term-selection')
    }
  }

  function setRunning(v: boolean): void {
    running = v
    onrunningchange?.(v)
  }

  $effect(() => {
    term = new Terminal({
      fontSize: 11.5,
      fontFamily: "'JetBrains Mono', ui-monospace, Menlo, monospace",
      cursorBlink: true,
      theme: readTermTheme()
    })
    fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()

    const disposers: Array<() => void> = []
    term.onData((d) => window.api.pty.write(SID, d))
    disposers.push(window.api.pty.onData(SID, (d) => term.write(d)))
    disposers.push(
      window.api.pty.onExit(SID, () => {
        setRunning(false)
        term.write('\r\n\x1b[2m[claude exited]\x1b[0m\r\n')
      })
    )

    const ro = new ResizeObserver(() => {
      // Hidden (the answer is expanded over it) — don't refit to zero rows.
      if (!host.clientWidth || !host.clientHeight) return
      fit.fit()
      if (running) window.api.pty.resize(SID, { cols: term.cols, rows: term.rows })
    })
    ro.observe(host)

    // xterm caches its theme at construction — re-apply on app theme change.
    const applyTheme = (): void => {
      if (term) term.options.theme = readTermTheme()
    }
    const themeObserver = new MutationObserver(applyTheme)
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    })
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', applyTheme)

    // Re-attach to a session left running in the background: replay what we
    // missed, then nudge a resize so the TUI repaints itself over the replay.
    let gone = false
    void (async () => {
      const st = await window.api.pty.attach(SID)
      if (gone || !st.running) return
      if (st.buffer) term.write(st.buffer)
      setRunning(true)
      requestAnimationFrame(() => {
        fit.fit()
        window.api.pty.resize(SID, { cols: term.cols, rows: term.rows })
        // A second, different size forces SIGWINCH even if the fit matched.
        setTimeout(() => window.api.pty.resize(SID, { cols: term.cols, rows: term.rows - 1 }), 30)
        setTimeout(() => window.api.pty.resize(SID, { cols: term.cols, rows: term.rows }), 60)
      })
    })()

    return () => {
      gone = true
      ro.disconnect()
      themeObserver.disconnect()
      mq.removeEventListener('change', applyTheme)
      disposers.forEach((d) => d())
      // Deliberately NOT killing the pty — Claude keeps running in the
      // background while the user works elsewhere in Lectern.
      term.dispose()
    }
  })

  /** Spawn `claude` in `cwd`; optionally auto-type `kickoff` once it's booted. */
  export async function run(cwd: string, kickoff?: string): Promise<boolean> {
    error = null
    const res = await window.api.pty.spawn({ id: SID, cwd, cmd: 'claude' })
    if (!res.ok) {
      error = res.error ?? 'failed to spawn'
      return false
    }
    setRunning(true)
    requestAnimationFrame(() => {
      fit.fit()
      window.api.pty.resize(SID, { cols: term.cols, rows: term.rows })
      term.focus()
    })
    // Claude's TUI needs a moment to come up before it will accept input.
    if (kickoff) setTimeout(() => send(kickoff), 2500)
    return true
  }

  /** Type a line into the running terminal and submit it. */
  export function send(text: string): void {
    if (!running) return
    window.api.pty.write(SID, text + '\r')
    term.focus()
  }

  export function isRunning(): boolean {
    return running
  }

  /** Explicitly end the background session (the only thing that kills it). */
  export function stop(): void {
    window.api.pty.kill(SID)
    setRunning(false)
  }
</script>

<div class="iqt">
  {#if error}<div class="iqt-err">{error}</div>{/if}
  <div class="iqt-host" bind:this={host}></div>
</div>

<style>
  .iqt {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
    background: var(--term-bg);
    border-radius: var(--r-sm);
    overflow: hidden;
  }
  .iqt-host {
    flex: 1;
    min-height: 0;
    padding: 6px 8px;
  }
  .iqt-err {
    flex: none;
    padding: 4px 8px;
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--danger);
    background: rgba(0, 0, 0, 0.3);
  }
</style>
