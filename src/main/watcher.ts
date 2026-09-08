import type { WindowLike } from './platform'
import { watch, type FSWatcher } from 'chokidar'
import { promises as fs } from 'fs'
import { join, basename, relative, sep } from 'path'
import { enrichLibrary, sourcesDir, syncLibrary } from './library'
import { inquiriesDir } from './inquiries'
import { MANUSCRIPT_FILE } from './quarto'
import { NOTES_FILE } from './notes'

let watcher: FSWatcher | null = null
let inquiryWatcher: FSWatcher | null = null
let docWatcher: FSWatcher | null = null

/**
 * Watch `<root>/sources/` so PDFs pasted in (or deleted) update the library
 * automatically, and `<root>/.lctrn/inquiries/` so an inquiry's `result.md`
 * (written by Claude in the embedded terminal) lights up the UI live. On a
 * sources change we reconcile the registry and notify via `library:changed`; on
 * an inquiry change we notify via `inquiries:changed`.
 */
export async function watchLibrarySources(
  root: string,
  getWindow: () => WindowLike | null
): Promise<void> {
  await stopWatchingLibrary()

  // Catch anything added/removed while the app was closed.
  await syncAndNotify(root, getWindow)

  watcher = watch(sourcesDir(root), {
    ignoreInitial: true,
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 }
  })

  let timer: ReturnType<typeof setTimeout> | null = null
  const schedule = (path: string): void => {
    if (!path.toLowerCase().endsWith('.pdf')) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void syncAndNotify(root, getWindow), 250)
  }

  watcher.on('add', schedule)
  watcher.on('unlink', schedule)

  // Inquiry results land a couple of levels deep (<slug>/result.md). Ensure the
  // dir exists first so chokidar has something to watch from the start.
  await fs.mkdir(inquiriesDir(root), { recursive: true }).catch(() => {})
  inquiryWatcher = watch(inquiriesDir(root), {
    ignoreInitial: true,
    depth: 2,
    awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 }
  })
  let inqTimer: ReturnType<typeof setTimeout> | null = null
  const notifyInquiries = (): void => {
    if (inqTimer) clearTimeout(inqTimer)
    inqTimer = setTimeout(() => getWindow()?.webContents.send('inquiries:changed'), 250)
  }
  inquiryWatcher.on('add', notifyInquiries)
  inquiryWatcher.on('change', notifyInquiries)
  inquiryWatcher.on('unlinkDir', notifyInquiries)
}

export async function stopWatchingLibrary(): Promise<void> {
  if (watcher) {
    await watcher.close()
    watcher = null
  }
  if (inquiryWatcher) {
    await inquiryWatcher.close()
    inquiryWatcher = null
  }
}

/**
 * Watch the open project's `manuscript.qmd` so edits made outside the app — most
 * often Claude addressing notes in the embedded terminal — light up the editor
 * live. Emits `project:doc:changed`; the renderer re-reads and reconciles
 * against its in-editor draft (it ignores the app's own saves and never
 * clobbers unsaved edits). Only one project is watched at a time — calling
 * again retargets; passing null stops.
 *
 * The project root (depth 0) plus the two curated nested config files are also
 * watched so root-level `*.md` edits — Claude updating LEARNED_EDITS.md, the
 * revision plan, etc. — emit `project:files:changed` with the project-relative
 * name for the workspace file pane / side editor.
 */
export async function watchProjectDocs(
  projectPath: string | null,
  getWindow: () => WindowLike | null
): Promise<void> {
  await stopWatchingProjectDocs()
  if (!projectPath) return

  const paths = [join(projectPath, MANUSCRIPT_FILE)]
  // Also watch MANUSCRIPT_NOTES.md so the Notes panel refreshes when Claude (the
  // address-notes skill) marks notes done — done notes then drop out of the panel.
  paths.push(join(projectPath, NOTES_FILE))
  // Root-level markdown config files and PDFs (depth 0 keeps _files dirs etc.
  // out), plus the curated nested ones the file pane lists.
  paths.push(projectPath)
  paths.push(join(projectPath, 'revisions', 'revision-plan.md'))
  paths.push(join(projectPath, '.claude', 'CLAUDE.md'))
  docWatcher = watch(paths, {
    ignoreInitial: true,
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }
  })

  const notify = (path: string): void => {
    const file = basename(path)
    if (file === NOTES_FILE) {
      getWindow()?.webContents.send('project:notes:changed')
      return
    }
    if (file === MANUSCRIPT_FILE) {
      getWindow()?.webContents.send('project:doc:changed')
      return
    }
    const lower = file.toLowerCase()
    if (lower.endsWith('.md') || lower.endsWith('.pdf')) {
      // Project-relative, forward-slashed — matches the config-file names used
      // by project:files:list (e.g. `revisions/revision-plan.md`).
      const name = relative(projectPath, path).split(sep).join('/')
      getWindow()?.webContents.send('project:files:changed', name)
    }
  }
  docWatcher.on('add', notify)
  docWatcher.on('change', notify)
  docWatcher.on('unlink', notify)
}

export async function stopWatchingProjectDocs(): Promise<void> {
  if (docWatcher) {
    await docWatcher.close()
    docWatcher = null
  }
}

async function syncAndNotify(root: string, getWindow: () => WindowLike | null): Promise<void> {
  const changed = await syncLibrary(root)
  const notify = (): void => {
    getWindow()?.webContents.send('library:changed')
  }
  if (changed) notify()
  // Reconcile metadata for any newly-registered PDFs in the background, pushing a
  // refresh after each so titles/authors fill in live without blocking the paste.
  void enrichLibrary(root, notify)
}
