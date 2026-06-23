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
      // The terminal stays dark in both themes (per the lectron design).
      theme: { background: '#101117', foreground: '#e9e9ee', cursor: '#56b1ff' }
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
