import type { BrowserWindow } from 'electron'
import { createServer, type Server } from 'http'
import { promises as fs } from 'fs'
import { homedir } from 'os'
import { randomBytes } from 'crypto'
import { join } from 'path'
import { recordCheckpoint } from './checkpoints'

/**
 * A loopback bridge from Claude Code's hooks back into the running app.
 *
 * Claude Code hooks are shell commands, so the scaffolded hook script (see
 * `hookScript()` in scaffold.ts) simply curls the hook's stdin JSON at this
 * server. That gives Lectern exact turn boundaries — `UserPromptSubmit` fires
 * before Claude can touch a file, `Stop` when the turn is over — which is what
 * checkpoint review needs to attribute changes to a prompt.
 *
 * The port is ephemeral and changes every launch, so the script discovers it from
 * `~/.lctrn/bridge` — one line, `<port> <token>`, mode 0600. Plain text rather
 * than JSON precisely so the hook can read it with a shell builtin and never
 * needs a JSON parser (or node) on PATH. The server binds 127.0.0.1 and rejects
 * anything without the token, so other local processes can't drive it.
 *
 * IMPORTANT: the UserPromptSubmit response is deliberately held until the
 * snapshot is on disk. The hook blocks Claude while it runs, which is the only
 * thing guaranteeing the baseline is captured before the first edit lands.
 * Everything else responds immediately, and the script always exits 0 — if
 * Lectern isn't running, Claude notices nothing.
 */

export interface HookPayload {
  hook_event_name?: string
  session_id?: string
  cwd?: string
  prompt?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
}

let server: Server | null = null

function bridgeFile(): string {
  return join(homedir(), '.lctrn', 'bridge')
}

async function readBody(req: import('http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    // A prompt can be long, a pasted document longer. Cap it so a runaway
    // client can't balloon the main process.
    if (size > 4 * 1024 * 1024) throw new Error('payload too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function handle(payload: HookPayload, getWindow: () => BrowserWindow | null): Promise<void> {
  const projectPath = payload.cwd
  if (!projectPath) return

  const notify = (): void => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    try {
      win.webContents.send('project:review:changed', projectPath)
    } catch {
      /* window tore down mid-send */
    }
  }

  switch (payload.hook_event_name) {
    case 'UserPromptSubmit':
      await recordCheckpoint(projectPath, payload.prompt ?? '', payload.session_id ?? null)
      notify()
      break
    case 'Stop':
    case 'SubagentStop':
      notify()
      break
    default:
      break
  }
}

/**
 * Start the hook bridge and publish its address. Safe to call once at startup;
 * returns a stop function for app teardown.
 */
export async function startBridge(
  getWindow: () => BrowserWindow | null
): Promise<{ stop: () => void }> {
  const token = randomBytes(24).toString('hex')

  server = createServer((req, res) => {
    const done = (code: number, body = '{}'): void => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(body)
    }
    if (req.method !== 'POST' || !req.url?.startsWith('/hook')) return done(404)
    if (req.headers['x-lctrn-token'] !== token) return done(403)

    void (async () => {
      try {
        const payload = JSON.parse(await readBody(req)) as HookPayload
        await handle(payload, getWindow)
        done(200)
      } catch {
        // Never surface an error to the hook — a failed checkpoint must not
        // interrupt the user's turn.
        done(200)
      }
    })()
  })

  await new Promise<void>((resolve) => {
    server!.listen(0, '127.0.0.1', resolve)
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0

  const file = bridgeFile()
  await fs.mkdir(join(homedir(), '.lctrn'), { recursive: true })
  await fs.writeFile(file, `${port} ${token}\n`, { encoding: 'utf8', mode: 0o600 })

  return {
    stop: () => {
      try {
        server?.close()
      } catch {
        /* already down */
      }
      server = null
      // Leave no stale address behind: a hook firing after quit should find
      // nothing and exit silently rather than hitting a recycled port.
      void fs.rm(file, { force: true }).catch(() => {})
    }
  }
}
