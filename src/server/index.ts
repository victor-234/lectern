/**
 * Lectern as a localhost application.
 *
 * `lectern` in a terminal starts this, prints a URL and opens a browser. The
 * backend is the same `src/main` the desktop app runs — same library registry,
 * same PTYs, same Quarto renders, same checkpoint review — reached over a
 * WebSocket instead of Electron IPC (see server/rpc.ts and shared/api.ts).
 *
 * Why this exists alongside the .app: distribution. The desktop build needs
 * signing, notarisation and a per-platform installer; this needs `npx lectern`.
 * And because the process runs wherever you start it, the folder it points at
 * can be on a lab machine you reach over SSH rather than on your laptop.
 *
 * SECURITY. This server spawns login shells (`pty:spawn`) and reads and writes
 * anything the account can reach. It is therefore treated as a credential:
 *
 *   - It binds 127.0.0.1 unless told otherwise, and `--host` prints a warning.
 *   - Every request needs a random per-launch token, supplied once in the URL
 *     and then held in a strict same-site, http-only cookie.
 *   - The WebSocket upgrade additionally checks `Origin`, so a page on another
 *     site can't drive the router with the browser's ambient cookie.
 *
 * That is the same posture as the hook bridge in main/bridge.ts, for the same
 * reason.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { createReadStream, promises as fs } from 'fs'
import { randomBytes, timingSafeEqual } from 'crypto'
import { extname, join, normalize, resolve, sep } from 'path'
import { tmpdir } from 'os'
import { WebSocketServer, type WebSocket } from 'ws'

import { registerCore } from '../main/core'
import { getLibraryRoot, paperAbsPath, setLibraryRoot } from '../main/library'
import { projectPdfPath } from '../main/projectFiles'
import { platform } from '../main/platform'
import { RpcRouter, type Socket } from './rpc'

export interface ServeOptions {
  port: number
  host: string
  /** Absolute path to the built renderer (index.html + assets). */
  webRoot: string
  /** Preset the library root before the first request, from `--library`. */
  library?: string | null
}

const COOKIE = 'lctrn_token'
/** A generous ceiling for one uploaded PDF. */
const MAX_UPLOAD = 200 * 1024 * 1024

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.pdf': 'application/pdf',
  '.map': 'application/json; charset=utf-8'
}

/** Constant-time compare that can't leak the token's length either. */
function tokenMatches(a: string | null | undefined, expected: string): boolean {
  if (!a) return false
  const given = Buffer.from(a)
  const want = Buffer.from(expected)
  if (given.length !== want.length) return false
  return timingSafeEqual(given, want)
}

function cookieToken(req: IncomingMessage): string | null {
  const raw = req.headers.cookie
  if (!raw) return null
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === COOKIE) return decodeURIComponent(v.join('='))
  }
  return null
}

export async function serve(opts: ServeOptions): Promise<{
  url: string
  token: string
  port: number
  close: () => Promise<void>
}> {
  const token = randomBytes(24).toString('hex')
  const router = new RpcRouter()
  const uploadDir = await fs.mkdtemp(join(tmpdir(), 'lectern-upload-'))

  if (opts.library) await setLibraryRoot(resolve(opts.library))

  const core = registerCore(router, () => router.window(), {
    host: { mode: 'server', nativePickers: false, home: process.env.HOME || tmpdir() },
    // The browser can't produce a filesystem path, so its own picker resolves
    // one over `fs:listDir` and passes it here. Nothing to fall back on if it
    // didn't — refusing beats guessing at a library location.
    async pickDirectory(requested) {
      if (!requested) return null
      const path = resolve(requested)
      await fs.mkdir(path, { recursive: true })
      return path
    },
    // Likewise for PDFs: the renderer POSTs them to /upload first and passes the
    // staged paths, which must be inside the upload directory we made.
    async pickPdfs(staged) {
      if (!staged?.length) return []
      return staged.map((p) => resolve(p)).filter((p) => p.startsWith(uploadDir + sep))
    }
  })

  // --- HTTP ------------------------------------------------------------------

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end('Internal error')
    })
  })

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

    // The token arrives once in the URL and is exchanged for a cookie, so the
    // page's own asset requests carry it without it sitting in every link. The
    // redirect also gets the token out of the address bar and the history.
    const fromQuery = url.searchParams.get('token')
    if (fromQuery && tokenMatches(fromQuery, token)) {
      url.searchParams.delete('token')
      res.writeHead(302, {
        'Set-Cookie': `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
        Location: url.pathname + (url.search || '')
      })
      res.end()
      return
    }

    if (!tokenMatches(cookieToken(req), token)) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Unauthorized — open the URL Lectern printed on startup.')
      return
    }

    if (url.pathname === '/upload' && req.method === 'POST') {
      await handleUpload(req, res, url)
      return
    }
    if (url.pathname.startsWith('/pdf/')) {
      await handlePdf(res, url)
      return
    }
    await serveStatic(res, url.pathname)
  }

  /**
   * One PDF per request, raw body, filename in the query. A multipart parser
   * would be a dependency to do what `fetch(file)` already does; the renderer
   * loops over the picked files.
   */
  async function handleUpload(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL
  ): Promise<void> {
    const name = (url.searchParams.get('name') || 'paper.pdf').replace(/[/\\]/g, '_')
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > MAX_UPLOAD) {
        res.writeHead(413).end('Too large')
        return
      }
      chunks.push(chunk as Buffer)
    }
    // Staged under a per-launch temp directory; pickPdfs refuses anything else.
    const dir = await fs.mkdtemp(join(uploadDir, 'f-'))
    const path = join(dir, name)
    await fs.writeFile(path, Buffer.concat(chunks))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ path }))
  }

  /**
   * The HTTP counterpart of the desktop app's `lctrn-pdf://` scheme, with the
   * same two shapes and the same containment rules — a paper is resolved by id
   * through the registry, a project PDF through `projectPdfPath`. Neither takes
   * a caller-supplied absolute path.
   */
  async function handlePdf(res: ServerResponse, url: URL): Promise<void> {
    const parts = url.pathname.split('/').slice(2).map(decodeURIComponent)
    let abs: string | null = null
    if (parts[0] === 'project' && parts.length >= 3) {
      try {
        abs = projectPdfPath(parts[1], parts.slice(2).join('/'))
      } catch {
        abs = null
      }
    } else if (parts[0] === 'paper' && parts[1]) {
      const root = await getLibraryRoot()
      abs = root ? await paperAbsPath(root, parts[1]) : null
    }
    if (!abs) {
      res.writeHead(404).end('Not found')
      return
    }
    try {
      const stat = await fs.stat(abs)
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': String(stat.size),
        'Content-Disposition': 'inline'
      })
      createReadStream(abs).pipe(res)
    } catch {
      res.writeHead(404).end('Not found')
    }
  }

  async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
    const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '')
    let file = join(opts.webRoot, rel)
    // Single-page app: anything that isn't a real file is the shell.
    if (!file.startsWith(opts.webRoot) || rel === '/' || rel === sep) file = join(opts.webRoot, 'index.html')
    try {
      const stat = await fs.stat(file)
      if (stat.isDirectory()) file = join(file, 'index.html')
    } catch {
      file = join(opts.webRoot, 'index.html')
    }
    try {
      const body = await fs.readFile(file)
      res.writeHead(200, {
        'Content-Type': CONTENT_TYPES[extname(file)] || 'application/octet-stream',
        // The bundle is content-hashed; index.html must not be cached or a
        // restarted server would serve a stale shell against fresh assets.
        'Cache-Control': file.endsWith('.html') ? 'no-store' : 'max-age=31536000, immutable'
      })
      res.end(body)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end(`Renderer not built. Run \`npm run build\` — expected ${opts.webRoot}/index.html`)
    }
  }

  // --- WebSocket -------------------------------------------------------------

  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const authed =
      tokenMatches(cookieToken(req), token) || tokenMatches(url.searchParams.get('token'), token)
    // The cookie rides along on a cross-site WebSocket handshake in some
    // browsers, so the token alone isn't enough — pin the Origin to this server.
    const origin = req.headers.origin
    const sameOrigin = !origin || origin === `http://${req.headers.host}`
    if (url.pathname !== '/rpc' || !authed || !sameOrigin) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  wss.on('connection', (ws: WebSocket) => {
    const socket: Socket = {
      send: (data) => ws.send(data),
      get open() {
        return ws.readyState === ws.OPEN
      }
    }
    router.addSocket(socket)
    ws.on('message', (data) => void router.dispatch(socket, data.toString()))
    ws.on('close', () => router.removeSocket(socket))
    ws.on('error', () => router.removeSocket(socket))
  })

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(opts.port, opts.host, () => resolveListen())
  })

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : opts.port
  const shown = opts.host === '0.0.0.0' || opts.host === '::' ? 'localhost' : opts.host

  return {
    url: `http://${shown}:${port}/?token=${token}`,
    token,
    port,
    async close() {
      core.killPtys()
      core.stop()
      for (const client of wss.clients) client.terminate()
      wss.close()
      await new Promise<void>((done) => server.close(() => done()))
      await fs.rm(uploadDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

/** Hand the URL to the user's browser; failure is not fatal. */
export async function openInBrowser(url: string): Promise<void> {
  await platform.openPath(url)
}
