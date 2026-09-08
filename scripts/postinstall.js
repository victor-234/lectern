#!/usr/bin/env node
/**
 * node-pty compiles for Node on install, which is exactly what the `lectern`
 * CLI needs. A checkout that also has Electron needs the other ABI as well, so
 * rebuild there — and never fail an install over it.
 *
 * The two builds coexist rather than fighting: electron-rebuild replaces
 * `build/Release/pty.node`, which Electron loads, while plain Node falls through
 * to the N-API copy in `prebuilds/<platform>-<arch>/`. So the desktop app and
 * the localhost server can both run out of one node_modules.
 */
const { execFileSync } = require('child_process')

try {
  require.resolve('electron')
} catch {
  process.exit(0) // installed as a plain package; the Node build is correct
}

try {
  execFileSync('npx', ['electron-rebuild', '-f', '-w', 'node-pty'], { stdio: 'inherit' })
} catch {
  console.warn('node-pty was not rebuilt for Electron — run `npm run rebuild` before `npm run dev`.')
}
