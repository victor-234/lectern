/**
 * Regenerate the worked example committed under `examples/library`.
 *
 * Run with `npm run example`. The example is generated rather than hand-written
 * so it can never describe a layout the code doesn't produce — see
 * src/main/demo.ts for why that matters.
 */

import { promises as fs } from 'fs'
import { join, resolve } from 'path'
import { createDemoLibrary } from '../main/demo'

async function main(): Promise<void> {
  const target = resolve(process.argv[2] || join(__dirname, '..', '..', 'examples', 'library'))
  // Start clean: this is a build artefact, not somewhere anyone should be
  // keeping work, and a stale entry left behind would defeat the point.
  await fs.rm(target, { recursive: true, force: true })
  const { projectPath } = await createDemoLibrary(target)
  console.log(`example library written to ${target}`)
  console.log(`  sample project: ${projectPath}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
