/**
 * Is Claude Code actually available, and does it work?
 *
 * Lectern doesn't hold a Claude credential and doesn't want one: the embedded
 * terminal spawns your login shell and runs the real `claude`, so authentication
 * is whatever you already did in a terminal. That's the right design — but it
 * used to be invisible. Someone who installed Lectern without Claude Code hit
 * `zsh: command not found: claude` inside a terminal pane that then exited, with
 * nothing anywhere explaining what was missing. This module is what the setup
 * panel asks so it can say so instead.
 *
 * Two checks, deliberately separated by cost:
 *
 *  - `probeClaudeCli` is free. It resolves the binary through a LOGIN shell —
 *    the same way pty.ts launches it — because that's the only PATH that
 *    matters here: a GUI app started from Finder inherits almost nothing, so
 *    `claude` being on the PATH of the shell you develop in proves nothing.
 *  - `testClaudeCli` costs one tiny request, so it only ever runs when someone
 *    presses the button. Being installed is not the same as being logged in,
 *    and this is the honest way to tell the difference — we deliberately do not
 *    sniff `~/.claude.json` or the keychain, which are Claude Code's private
 *    business and would rot the moment it reorganised them.
 */

import { execFile } from 'child_process'
import type { IpcLike } from './platform'
import { runClaude } from './metadata'

export interface ClaudeCliStatus {
  /** `claude` resolves on the login shell's PATH. */
  found: boolean
  /** Absolute path it resolved to. */
  path?: string
  /** As reported by `claude --version`, e.g. "2.1.263 (Claude Code)". */
  version?: string
}

export interface ClaudeCliTest {
  ok: boolean
  /** Why it failed, in terms a user can act on. */
  error?: string
}

/** Run a command in a login shell, resolving to null on any failure. */
function loginShell(command: string, timeoutMs = 10_000): Promise<string | null> {
  const shell = process.env.SHELL || '/bin/zsh'
  return new Promise((resolve) => {
    // `-l` (login) but NOT `-i` (interactive): an interactive shell can block on
    // prompts or job control with no tty attached.
    execFile(shell, ['-lc', command], { timeout: timeoutMs }, (err, stdout) => {
      if (err) return resolve(null)
      const out = stdout.toString().trim()
      resolve(out || null)
    })
  })
}

export async function probeClaudeCli(): Promise<ClaudeCliStatus> {
  const path = await loginShell('command -v claude')
  if (!path) return { found: false }
  const version = await loginShell('claude --version')
  return { found: true, path, version: version ?? undefined }
}

/**
 * Ask Claude Code for one word. Distinguishes "installed" from "installed and
 * logged in", which is the distinction that actually matters — and the one no
 * amount of file-sniffing can establish honestly.
 */
export async function testClaudeCli(): Promise<ClaudeCliTest> {
  const status = await probeClaudeCli()
  if (!status.found) {
    return { ok: false, error: 'Claude Code is not installed, or not on your login shell’s PATH.' }
  }
  const reply = await runClaude('Reply with the single word: OK', { timeoutMs: 60_000 })
  if (reply === null) {
    return {
      ok: false,
      error:
        'Claude Code is installed but did not answer. Run `claude` once in a terminal — it will prompt you to log in.'
    }
  }
  return { ok: true }
}

export function registerClaudeCli(ipc: IpcLike): void {
  ipc.handle('claude:status', () => probeClaudeCli())
  ipc.handle('claude:test', () => testClaudeCli())
}
