/**
 * `lectern` — start the localhost app and open it.
 *
 * The whole point of this entrypoint is that getting Lectern onto a colleague's
 * machine shouldn't require a signed, notarised, per-platform installer. This is
 * `npx lectern`, and it runs the same backend the desktop app does.
 */

import { join, resolve } from 'path'
import { serve, openInBrowser } from './index'

interface Args {
  port: number
  host: string
  library: string | null
  open: boolean
  help: boolean
}

function parse(argv: string[]): Args {
  const args: Args = { port: 4747, host: '127.0.0.1', library: null, open: true, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = (): string => argv[++i] ?? ''
    if (a === '--help' || a === '-h') args.help = true
    else if (a === '--port' || a === '-p') args.port = Number(next()) || 0
    else if (a === '--host') args.host = next()
    else if (a === '--library' || a === '-l') args.library = next()
    else if (a === '--no-open') args.open = false
    // A bare path is the library folder: `cd ~/papers && lectern .` reads the
    // way the equivalent Jupyter or dev-server invocation does.
    else if (!a.startsWith('-')) args.library = a
  }
  return args
}

const HELP = `
  lectern — your paper pile and your Quarto projects, in a browser tab.

  Usage
    lectern [folder] [options]

  Options
    -l, --library <path>   Library folder to open (default: whatever you used last)
    -p, --port <n>         Port to listen on (default 4747; 0 picks a free one)
        --host <addr>      Address to bind (default 127.0.0.1 — see the warning below)
        --no-open          Don't launch a browser
    -h, --help             Show this

  This process can read and write everything your account can, and starts real
  shells running Claude Code. It binds loopback and requires the token in the URL
  it prints. Binding --host to anything else exposes that to your whole network:
  put it behind an SSH tunnel instead ( ssh -L 4747:localhost:4747 you@host ).
`

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2))
  if (args.help) {
    console.log(HELP)
    return
  }

  // out/server/cli.js sits beside out/renderer/, in the source tree and in the
  // published package alike.
  const webRoot = resolve(join(__dirname, '..', 'renderer'))

  const { url, port, close } = await serve({
    port: args.port,
    host: args.host,
    webRoot,
    library: args.library
  })

  const loopback = args.host === '127.0.0.1' || args.host === 'localhost' || args.host === '::1'
  console.log(`\n  Lectern is running on port ${port}.\n`)
  if (!loopback) {
    console.log(`  ⚠ Bound to ${args.host} — anyone who can reach this host and`)
    console.log(`    guess nothing (the token is in the URL) can run shells as you.\n`)
  }
  console.log(`  Open:  ${url}\n`)
  console.log('  Press Ctrl-C to stop.\n')

  if (args.open) await openInBrowser(url)

  let stopping = false
  const shutdown = (): void => {
    if (stopping) return
    stopping = true
    console.log('\n  Stopping…')
    void close().then(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((e) => {
  console.error(`\n  Could not start Lectern: ${e instanceof Error ? e.message : e}\n`)
  process.exit(1)
})
