/**
 * Choosing files, on either host.
 *
 * The desktop app raises a native dialog in the main process and gets real
 * filesystem paths back. A browser can't: `<input type=file>` hands over file
 * *contents* with the path deliberately withheld, and the File System Access API
 * gives a handle, not a path. So served from localhost the two flows differ:
 *
 *   - **A library folder** is browsed on the SERVER's filesystem, through
 *     `host.listDir`, by FolderPicker.svelte — which is the right semantics
 *     anyway, since the folder that matters is the one the backend can see.
 *   - **Adding PDFs** uploads them and hands back the staged paths, which the
 *     server copies into the library exactly as it copies dialog-picked files.
 *
 * Both end at the same `library:choose` / `library:addPapers` handlers.
 */

import type { HostInfo } from '../../../main/core'

let cached: Promise<HostInfo> | null = null

/** Where the backend runs and what it can do. Asked once, reused after. */
export function hostInfo(): Promise<HostInfo> {
  cached ??= window.api.host.info()
  return cached
}

/**
 * Put PDFs on the server's disk and return where they landed. Resolves to null
 * if the user dismissed the file chooser, which is distinct from picking none.
 */
async function uploadPdfs(): Promise<string[] | null> {
  const files = await promptForFiles()
  if (!files) return null

  const staged: string[] = []
  for (const file of files) {
    const res = await fetch(`/upload?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      body: file
    })
    if (!res.ok) throw new Error(`Upload failed for ${file.name} (${res.status})`)
    staged.push((await res.json()).path)
  }
  return staged
}

function promptForFiles(): Promise<File[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.accept = 'application/pdf,.pdf'
    input.style.display = 'none'
    document.body.appendChild(input)
    const done = (value: File[] | null): void => {
      input.remove()
      resolve(value)
    }
    input.addEventListener('change', () => done(Array.from(input.files ?? [])))
    // Fired when the chooser is dismissed; without it the promise would hang.
    input.addEventListener('cancel', () => done(null))
    input.click()
  })
}

/**
 * Add papers to the library, whichever host we're on. Returns what was added,
 * or an empty list if the user backed out.
 */
export async function addPapers(): Promise<unknown[]> {
  const { nativePickers } = await hostInfo()
  if (nativePickers) return window.api.library.addPapers()
  const staged = await uploadPdfs()
  if (!staged?.length) return []
  return window.api.library.addPapers(staged)
}
