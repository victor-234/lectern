/**
 * The browser's transport to a Lectern server (see src/server).
 *
 * In the desktop app the preload script has already installed `window.api`
 * before any of this runs, and none of this is used. Served from localhost there
 * is no preload, so the page opens a WebSocket to `/rpc` and installs the very
 * same API object over it — `createApi` is shared, so the two hosts cannot drift
 * apart (src/shared/api.ts).
 */

import { createApi, type Transport } from '../../../shared/api'

const BYTES = '__lctrnBytes'

/** Undo the server's byte tagging — see `encode` in server/rpc.ts. */
function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode)
  if (value && typeof value === 'object') {
    const b64 = (value as Record<string, unknown>)[BYTES]
    if (typeof b64 === 'string') {
      const bin = atob(b64)
      const out = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
      return out
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = decode(v)
    return out
  }
  return value
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

class SocketTransport implements Transport {
  private ws: WebSocket | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private listeners = new Map<string, Set<(...args: any[]) => void>>()
  /** Frames written while the socket was down, flushed on reconnect. */
  private queue: string[] = []
  private closed = false
  private retry = 0

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(`${proto}//${location.host}/rpc`)
      this.ws = ws
      let settled = false

      ws.onopen = () => {
        this.retry = 0
        for (const frame of this.queue.splice(0)) ws.send(frame)
        if (!settled) {
          settled = true
          resolve()
        }
      }
      ws.onmessage = (ev) => this.receive(String(ev.data))
      ws.onerror = () => {
        if (!settled) {
          settled = true
          reject(new Error('Could not reach the Lectern server.'))
        }
      }
      ws.onclose = () => {
        this.ws = null
        // In-flight calls can never be answered now; let their callers fail
        // rather than hang forever.
        for (const p of this.pending.values()) p.reject(new Error('Connection lost'))
        this.pending.clear()
        if (!settled) {
          settled = true
          reject(new Error('Could not reach the Lectern server.'))
          return
        }
        if (!this.closed) this.reconnect()
      }
    })
  }

  /**
   * Server restarts and laptop sleeps shouldn't mean a reload. Subscriptions
   * live entirely on this side — the server broadcasts every event to whoever is
   * attached — so reconnecting is enough to make them live again, and the
   * terminals re-attach through `pty:attach` as they always did.
   */
  private reconnect(): void {
    const delay = Math.min(500 * 2 ** this.retry++, 10_000)
    setTimeout(() => {
      if (!this.closed) void this.connect().catch(() => {})
    }, delay)
  }

  private receive(raw: string): void {
    let msg: any
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (msg.t === 'r') {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.ok) p.resolve(decode(msg.v))
      else p.reject(new Error(String(msg.e)))
      return
    }
    if (msg.t === 'e') {
      const args = (msg.a as unknown[]).map(decode)
      for (const fn of this.listeners.get(msg.ch) ?? []) fn(...args)
    }
  }

  private write(frame: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(frame)
    else this.queue.push(frame)
  }

  invoke(channel: string, arg?: unknown): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write(JSON.stringify({ t: 'i', id, ch: channel, a: arg }))
    })
  }

  send(channel: string, arg?: unknown): void {
    this.write(JSON.stringify({ t: 's', ch: channel, a: arg }))
  }

  on(channel: string, listener: (...args: any[]) => void): () => void {
    const set = this.listeners.get(channel) ?? new Set()
    set.add(listener)
    this.listeners.set(channel, set)
    return () => set.delete(listener)
  }
}

/**
 * Make sure `window.api` exists, whichever host we're in. Awaited by main.ts
 * before the app mounts, so no component ever has to wonder.
 */
export async function ensureApi(): Promise<void> {
  if (window.api) return
  const transport = new SocketTransport()
  await transport.connect()
  window.api = createApi(transport)
}

/** True when the page is talking to a Lectern server rather than a preload. */
export const isBrowserHost = typeof window !== 'undefined' && !window.api
