import { contextBridge, ipcRenderer } from 'electron'
import { createApi, type Transport } from '../shared/api'

/**
 * The desktop host's half of the renderer API.
 *
 * The API surface itself lives in `src/shared/api.ts` so the localhost server
 * can expose the identical thing over a WebSocket — this file only supplies the
 * Electron transport and hands the result across the context bridge.
 */
const transport: Transport = {
  invoke: (channel, arg) => ipcRenderer.invoke(channel, arg),
  send: (channel, arg) => ipcRenderer.send(channel, arg),
  on: (channel, listener) => {
    // Strip the IpcRendererEvent: the shared API is written against payloads
    // only, because a WebSocket has no equivalent to hand over.
    const wrapped = (_e: unknown, ...args: unknown[]): void => listener(...args)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  }
}

contextBridge.exposeInMainWorld('api', createApi(transport))

export type { Api } from '../shared/api'
