import { defineConfig, type Plugin } from 'vite'

/**
 * Fail loudly at build time if anything in the server's import graph reaches for
 * Electron. That graph is most of `src/main`, and the whole reason it can run
 * outside the desktop app is the platform seam in src/main/platform.ts — a stray
 * `import { app } from 'electron'` would only surface as a crash on first
 * launch, so catch it here instead.
 */
const noElectron = (): Plugin => ({
  name: 'lectern:no-electron',
  resolveId(id, importer) {
    if (id === 'electron' || id.startsWith('electron/')) {
      throw new Error(
        `The server bundle must not depend on Electron, but ${importer ?? '?'} imports '${id}'. ` +
          `Route it through src/main/platform.ts instead.`
      )
    }
    return null
  }
})

/**
 * Builds the localhost host (src/server plus the src/main modules it pulls in)
 * into a plain Node bundle. Separate from electron.vite.config.ts because that
 * one targets Electron's main/preload/renderer trio.
 */
export default defineConfig({
  plugins: [noElectron()],
  build: {
    ssr: 'src/server/cli.ts',
    outDir: 'out/server',
    target: 'node20',
    emptyOutDir: true,
    minify: false,
    rollupOptions: { output: { format: 'cjs', entryFileNames: 'cli.js' } }
  }
})
