<script lang="ts">
  // A self-contained xterm pane bound to the 'inquiry' pty session, so it runs
  // alongside the project dock's 'main' session without clobbering it. Used by
  // the Inquiries modal to drive Claude inside an inquiry folder.
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

  function setRunning(v: boolean): void {
    running = v
    onrunningchange?.(v)
  }

  $effect(() => {
    term = new Terminal({
      fontSize: 11.5,
      fontFamily: "'JetBrains Mono', ui-monospace, Menlo, monospace",
      cursorBlink: true,
      theme: { background: '#101117', foreground: '#e9e9ee', cursor: '#56b1ff' }
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
      fit.fit()
      if (running) window.api.pty.resize(SID, { cols: term.cols, rows: term.rows })
    })
    ro.observe(host)

    return () => {
      ro.disconnect()
      disposers.forEach((d) => d())
      window.api.pty.kill(SID)
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
    background: #101117;
    border-radius: var(--r-md);
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
