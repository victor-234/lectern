<script lang="ts">
  import { Terminal } from '@xterm/xterm'
  import { FitAddon } from '@xterm/addon-fit'
  import '@xterm/xterm/css/xterm.css'

  // One embedded Claude session: a single xterm bound to one pty (keyed by `sid`).
  // The dock (Terminal.svelte) mounts one of these per running session, so a
  // project-scoped Claude and a "no project" Claude can run side by side.
  let {
    sid,
    cwd,
    kickoff = null,
    visible = true,
    onrunning
  }: {
    sid: string
    cwd: string
    // Prompt auto-typed once the TUI is up (~2.5s after boot). Null => none.
    kickoff?: string | null
    // Whether this session's pane is the visible one — drives a refit when shown.
    visible?: boolean
    onrunning?: (running: boolean) => void
  } = $props()

  let host: HTMLDivElement
  let term: Terminal
  let fit: FitAddon
  let running = false

  // Build xterm's theme from the live --term-* tokens so the terminal follows
  // the app theme (a softer charcoal in light mode, near-black in dark). xterm 6
  // parses the oklch tokens directly. Only bg/fg/cursor/selection are overridden
  // — the 16 ANSI colors keep xterm's defaults so Claude's TUI palette stays vivid.
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

  /** Type a line into the pty and submit it. No-op until Claude has booted. */
  export function send(text: string): void {
    if (!running) return
    window.api.pty.write(sid, text + '\r')
    term.focus()
  }

  /** Refit + resize the pty and focus — used when this pane becomes active. */
  export function focus(): void {
    requestAnimationFrame(() => {
      fit.fit()
      if (running) window.api.pty.resize(sid, { cols: term.cols, rows: term.rows })
      term.focus()
    })
  }

  $effect(() => {
    term = new Terminal({
      fontSize: 11.5,
      fontFamily: "'JetBrains Mono', ui-monospace, Menlo, monospace",
      cursorBlink: true,
      // Theme is read live from the --term-* CSS tokens (dark, but a softer
      // charcoal in light mode) and re-applied on theme toggle below.
      theme: readTermTheme()
    })
    fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()

    const disposers: Array<() => void> = []
    term.onData((d) => window.api.pty.write(sid, d))
    disposers.push(window.api.pty.onData(sid, (d) => term.write(d)))
    disposers.push(
      window.api.pty.onExit(sid, () => {
        running = false
        onrunning?.(false)
        term.write('\r\n\x1b[2m[claude exited]\x1b[0m\r\n')
      })
    )

    const ro = new ResizeObserver(() => {
      fit.fit()
      if (running) window.api.pty.resize(sid, { cols: term.cols, rows: term.rows })
    })
    ro.observe(host)

    // xterm caches its theme at construction, so re-apply when the app theme
    // changes — either an explicit <html data-theme> toggle or the OS fallback.
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

    // Boot Claude in this session's working directory.
    void (async () => {
      const res = await window.api.pty.spawn({ id: sid, cwd, cmd: 'claude' })
      if (!res.ok) {
        term.write(`\r\n\x1b[31m${res.error ?? 'failed to spawn'}\x1b[0m\r\n`)
        return
      }
      running = true
      onrunning?.(true)
      requestAnimationFrame(() => {
        fit.fit()
        window.api.pty.resize(sid, { cols: term.cols, rows: term.rows })
        term.focus()
      })
      if (kickoff) setTimeout(() => send(kickoff), 2500)
    })()

    return () => {
      ro.disconnect()
      themeObserver.disconnect()
      mq.removeEventListener('change', applyTheme)
      disposers.forEach((d) => d())
      window.api.pty.kill(sid)
      term.dispose()
    }
  })

  // The pane is display:none while another session is active, which sizes xterm
  // to 0 — refit the moment it becomes visible again.
  $effect(() => {
    if (visible && fit) requestAnimationFrame(() => fit.fit())
  })
</script>

<div class="ts-host" bind:this={host}></div>

<style>
  .ts-host {
    width: 100%;
    height: 100%;
    overflow: hidden;
    padding: 6px 10px;
  }
</style>
