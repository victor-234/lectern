/**
 * The WebSocket half of the localhost host: a router that looks exactly like
 * Electron's `ipcMain` to the feature modules, and a fan-out that looks exactly
 * like a `BrowserWindow` to anything pushing events at the renderer.
 *
 * Because those two shapes are all `src/main` ever asked for (see
 * platform.ts), nothing under `src/main` knows this exists.
 */

import type { IpcLike, WindowLike } from '../main/platform'

type Handler = (event: unknown, ...args: any[]) => unknown

/** Client → server. */
type Incoming =
  | { t: 'i'; id: number; ch: string; a?: unknown } // invoke, expects a reply
  | { t: 's'; ch: string; a?: unknown } // send, fire and forget

export interface Socket {
  send(data: string): void
  readonly open: boolean
}

// --- Wire codec --------------------------------------------------------------
//
// JSON can't carry the one binary payload we have (`library:pdf` returns the raw
// PDF bytes for the reader's blob: URL), so byte arrays travel base64-tagged and
// are rebuilt on the other side. Everything else is plain JSON — deliberately,
// so the wire stays inspectable in devtools.

const BYTES = '__lctrnBytes'

export function encode(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { [BYTES]: Buffer.from(value).toString('base64') }
  }
  if (Array.isArray(value)) return value.map(encode)
  if (value && typeof value === 'object') {
    // Dates and the like would serialise the same as JSON.stringify does; only
    // plain objects need walking for nested byte arrays.
    if (Object.getPrototypeOf(value) !== Object.prototype) return value
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = encode(v)
    return out
  }
  return value
}

export class RpcRouter implements IpcLike {
  private handlers = new Map<string, Handler>()
  private listeners = new Map<string, Handler[]>()
  private sockets = new Set<Socket>()

  handle(channel: string, listener: Handler): void {
    this.handlers.set(channel, listener)
  }

  on(channel: string, listener: Handler): void {
    const list = this.listeners.get(channel)
    if (list) list.push(listener)
    else this.listeners.set(channel, [listener])
  }

  addSocket(socket: Socket): void {
    this.sockets.add(socket)
  }

  removeSocket(socket: Socket): void {
    this.sockets.delete(socket)
  }

  get connections(): number {
    return this.sockets.size
  }

  /** Route one client frame. Never throws — a bad frame is dropped. */
  async dispatch(socket: Socket, raw: string): Promise<void> {
    let msg: Incoming
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }

    if (msg?.t === 's') {
      for (const fn of this.listeners.get(msg.ch) ?? []) {
        try {
          fn({}, msg.a)
        } catch {
          /* a fire-and-forget handler throwing can't be reported anywhere */
        }
      }
      return
    }

    if (msg?.t !== 'i') return
    const fn = this.handlers.get(msg.ch)
    if (!fn) {
      this.reply(socket, msg.id, false, `no handler for '${msg.ch}'`)
      return
    }
    try {
      const value = await fn({}, msg.a)
      this.reply(socket, msg.id, true, encode(value))
    } catch (e) {
      this.reply(socket, msg.id, false, e instanceof Error ? e.message : String(e))
    }
  }

  private reply(socket: Socket, id: number, ok: boolean, payload: unknown): void {
    if (!socket.open) return
    socket.send(JSON.stringify(ok ? { t: 'r', id, ok, v: payload } : { t: 'r', id, ok, e: payload }))
  }

  /**
   * The `BrowserWindow`-shaped handle the feature modules push events through.
   * Every connected tab gets every event — the desktop app has exactly one
   * renderer, and a second tab here should see the same live library.
   */
  window(): WindowLike {
    const broadcast = (channel: string, ...args: unknown[]): void => {
      const frame = JSON.stringify({ t: 'e', ch: channel, a: args.map(encode) })
      for (const socket of this.sockets) {
        if (!socket.open) continue
        try {
          socket.send(frame)
        } catch {
          /* socket died mid-send; its close handler will drop it */
        }
      }
    }
    return {
      // There is always a "window" here even with no tabs open: the PTYs and
      // watchers keep running, their output buffered, and a tab that connects
      // later re-attaches (see pty:attach). So this is never destroyed.
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: broadcast }
    }
  }
}
