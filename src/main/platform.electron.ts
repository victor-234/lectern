/**
 * The Electron implementation of the platform seam (see platform.ts).
 *
 * This is the ONLY file under `src/main` that imports Electron at runtime, so
 * the server build can bundle everything else without it. The desktop entry
 * calls `installElectronPlatform()` before any handler can run.
 */

import { app, shell, safeStorage } from 'electron'
import { setPlatform, type Platform } from './platform'

const electronPlatform: Platform = {
  name: 'electron',
  appDataDir: () => app.getPath('appData'),
  userDataDir: () => app.getPath('userData'),
  openPath: (path) => shell.openPath(path),
  secrets: {
    // safeStorage is Keychain on macOS, DPAPI on Windows, libsecret on Linux.
    // Deliberately NOT downgraded to plaintext when it's unavailable — the
    // desktop app has always refused to save rather than silently store a bare
    // key, and a machine that should have a keychain and doesn't is worth a
    // complaint. (The localhost server is plaintext by design and says so.)
    scheme: 'keychain',
    async encrypt(value) {
      if (!safeStorage.isEncryptionAvailable())
        throw new Error('secure storage unavailable — cannot save the API key')
      return safeStorage.encryptString(value)
    },
    async decrypt(buf) {
      return safeStorage.decryptString(buf)
    }
  }
}

export function installElectronPlatform(): void {
  setPlatform(electronPlatform)
}
