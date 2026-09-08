import type { IpcLike, WindowLike } from './platform'

/**
 * Bridges embedded PTYs to xterm.js instances in the renderer.
 *
 * Sessions are keyed by a string `id` so independent terminals coexist — the
 * always-present project dock (`id: 'main'`) and the Inquiries modal's own
 * terminal (`id: 'inquiry'`) run side by side without clobbering each other.
 * Every `pty:*` message carries its `id`; `pty:data`/`pty:exit` events sent to
 * the renderer are tagged with the same id so each xterm only consumes its own.
 *
 * The orchestration model is "real terminal": we spawn the user's login shell
 * and run `claude` inside the chosen directory, so the user sees the genuine
 * Claude Code TUI. node-pty is a native addon and must be rebuilt against
 * Electron's ABI (`npm run rebuild`); if it isn't present we degrade gracefully
 * and report it to the UI instead of crashing.
 *
 * Sessions outlive their xterm. Output is mirrored into a per-session ring
 * buffer so a pane that was unmounted (the Inquiries modal closed while Claude
 * kept working) can re-attach later, replay the scrollback and carry on — the
 * process is owned by main, not by whichever view happens to be showing it.
 */
export function registerPty(
  ipcMain: IpcLike,
  getWindow: () => WindowLike | null
): { killAll: () => void } {
  const procs = new Map<string, import('node-pty').IPty>()
  /** Recent output per session, replayed on re-attach. */
  const bufs = new Map<string, string>()
  const MAX_BUFFER = 400_000
  let ptyMod: typeof import('node-pty') | null = null
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ptyMod = require('node-pty')
  } catch {
    ptyMod = null
  }

  function killSession(id: string): void {
    const existing = procs.get(id)
    if (existing) {
      try { existing.kill() } catch { /* ignore */ }
      procs.delete(id)
    }
    bufs.delete(id)
  }

  function remember(id: string, data: string): void {
    const next = (bufs.get(id) ?? '') + data
    bufs.set(id, next.length > MAX_BUFFER ? next.slice(next.length - MAX_BUFFER) : next)
  }

  // node-pty keeps emitting buffered output while the window is closing or
  // reloading. `getWindow()?` only guards a null window — the webContents can
  // still be present-but-destroyed, and calling `.send()` on it throws
  // "Object has been destroyed". Because that throw happens inside node-pty's
  // synchronous event emitter (not a promise), it escapes as an uncaught
  // exception in the main process — one dialog per buffered chunk. Guard the
  // destroyed state and swallow anything else.
  function safeSend(channel: string, payload: unknown): void {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    const wc = win.webContents
    if (!wc || wc.isDestroyed()) return
    try { wc.send(channel, payload) } catch { /* window tore down mid-send */ }
  }

  ipcMain.handle('pty:spawn', (_e, opts: { id: string; cwd: string; cmd?: string }) => {
    if (!ptyMod) {
      return { ok: false, error: 'node-pty not built — run `npm run rebuild`' }
    }
    const { id } = opts
    killSession(id)
    const shell = process.env.SHELL || '/bin/zsh'
    const command = opts.cmd || 'claude'
    const proc = ptyMod.spawn(shell, ['-l', '-i', '-c', command], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: opts.cwd,
      env: { ...process.env, TERM: 'xterm-256color' }
    })
    procs.set(id, proc)
    bufs.set(id, '')
    proc.onData((data) => {
      remember(id, data)
      safeSend('pty:data', { id, data })
    })
    proc.onExit(({ exitCode }) => {
      safeSend('pty:exit', { id, code: exitCode })
      if (procs.get(id) === proc) procs.delete(id)
    })
    return { ok: true }
  })

  // Re-attach a freshly-mounted xterm to a session that is already running:
  // reports whether the process is alive and hands back its recent output so
  // the pane can replay it. (The caller nudges a resize afterwards, which makes
  // the TUI redraw itself over the replayed bytes.)
  ipcMain.handle('pty:attach', (_e, id: string) => ({
    running: procs.has(id),
    buffer: bufs.get(id) ?? ''
  }))

  ipcMain.on('pty:write', (_e, msg: { id: string; data: string }) => procs.get(msg.id)?.write(msg.data))
  ipcMain.on('pty:resize', (_e, msg: { id: string; cols: number; rows: number }) => {
    try { procs.get(msg.id)?.resize(msg.cols, msg.rows) } catch { /* terminal gone */ }
  })
  ipcMain.on('pty:kill', (_e, id: string) => killSession(id))

  function killAll(): void {
    for (const id of [...procs.keys()]) killSession(id)
  }

  return { killAll }
}
