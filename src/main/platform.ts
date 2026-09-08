/**
 * The seam between Lectern's guts and whatever is hosting them.
 *
 * Everything under `src/main` used to talk to Electron directly. It barely
 * needed to: across ~7.8k lines the entire native surface was four calls
 * (`app.getPath`, `safeStorage`, `shell.openPath`) plus two structural types.
 * Pulling those behind this adapter is what lets the same modules run either
 * inside the desktop app or inside a plain Node process serving localhost —
 * see `src/server/index.ts`.
 *
 * The defaults here are the Node ones, so a bundle of `src/main` never has to
 * resolve `electron` at all. The desktop entry overrides them on boot via
 * `setPlatform` (see platform.electron.ts). Every call site is lazy — nothing
 * below runs at module load — so that injection is guaranteed to win.
 */

import { promises as fs } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'

/**
 * The slice of Electron's `IpcMain` the feature modules actually use. Declaring
 * it structurally means `registerGit(ipcMain, …)` accepts the real thing in the
 * desktop app and the WebSocket router in the server, with no changes at the
 * call sites and no `any`.
 */
export interface IpcLike {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void
  on(channel: string, listener: (event: unknown, ...args: any[]) => void): void
}

/**
 * Likewise for `BrowserWindow` — the modules only ever push events at it and
 * check whether it died mid-send. In server mode this is a fan-out to every
 * connected browser tab.
 */
export interface WindowLike {
  isDestroyed(): boolean
  webContents: {
    isDestroyed(): boolean
    send(channel: string, ...args: any[]): void
  }
}

/** How a secret sits on disk, so the UI can be honest about it. */
export interface SecretStore {
  /**
   * Names the storage format. It is part of the FILENAME, which is what keeps
   * the two hosts from corrupting each other: a keychain-encrypted blob is
   * meaningless bytes to a process with no keychain, and reading it as a key
   * would quietly send garbage to the Anthropic API. Separate files mean each
   * host only ever finds something it can actually read, and neither overwrites
   * the other's.
   */
  scheme: 'keychain' | 'plain'
  encrypt(value: string): Promise<Buffer>
  decrypt(buf: Buffer): Promise<string>
}

export interface Platform {
  /** Human-facing name of the host, for log lines and the About panel. */
  name: string
  /** Per-user config directory. MUST agree between hosts — the desktop app and
   *  `npx lectern` share one library registration and one saved key. */
  userDataDir(): string
  appDataDir(): string
  /** Hand a file to the OS viewer. Resolves to '' on success, else the error. */
  openPath(path: string): Promise<string>
  secrets: SecretStore
}

// --- Node defaults -----------------------------------------------------------

/** Mirrors Electron's `app.getPath('appData')` exactly, per platform. */
function nodeAppDataDir(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support')
  if (process.platform === 'win32')
    return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  return process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
}

/**
 * Without Electron there is no keychain binding, so the key sits in a 0600 file
 * and `secure` is false — the settings UI says so rather than implying Keychain
 * protection it isn't getting. `ANTHROPIC_API_KEY` in the environment is the
 * better answer in server mode and already wins over the stored key.
 */
const nodeSecrets: SecretStore = {
  scheme: 'plain',
  async encrypt(value) {
    return Buffer.from(value, 'utf8')
  },
  async decrypt(buf) {
    return buf.toString('utf8')
  }
}

const nodePlatform: Platform = {
  name: 'node',
  appDataDir: nodeAppDataDir,
  userDataDir: () => join(nodeAppDataDir(), 'Lectern'),
  async openPath(path) {
    const [cmd, args] =
      process.platform === 'darwin'
        ? ['open', [path]]
        : process.platform === 'win32'
          ? ['cmd', ['/c', 'start', '', path]]
          : ['xdg-open', [path]]
    return await new Promise<string>((resolve) => {
      try {
        const child = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true })
        child.on('error', (e) => resolve(e.message))
        child.on('spawn', () => {
          child.unref()
          resolve('')
        })
      } catch (e) {
        resolve(e instanceof Error ? e.message : String(e))
      }
    })
  },
  secrets: nodeSecrets
}

let current: Platform = nodePlatform

/** Called once, before anything else, by a host that isn't plain Node. */
export function setPlatform(p: Platform): void {
  current = p
}

export const platform = {
  get name(): string {
    return current.name
  },
  userDataDir: () => current.userDataDir(),
  appDataDir: () => current.appDataDir(),
  openPath: (p: string) => current.openPath(p),
  get secrets(): SecretStore {
    return current.secrets
  }
}

/** userDataDir(), guaranteed to exist. */
export async function ensureUserDataDir(): Promise<string> {
  const dir = platform.userDataDir()
  await fs.mkdir(dir, { recursive: true })
  return dir
}
