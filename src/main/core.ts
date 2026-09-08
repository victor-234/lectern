/**
 * Every IPC handler that isn't tied to a particular host.
 *
 * This used to live inline in `main/index.ts`, wired straight to Electron's
 * `ipcMain`. It moved out when Lectern grew a second front door: the same
 * handlers now serve the desktop window and a plain localhost server (see
 * `src/server/index.ts`) with one registration, so a feature added here shows up
 * in both without being written twice.
 *
 * Two things genuinely differ between hosts, and only two, so they arrive as
 * `CoreDeps` rather than being branched on inside the handlers:
 *
 *   - **Choosing a folder / picking PDFs.** The desktop app has a native file
 *     dialog. A browser can't hand back a real filesystem path, so the server
 *     resolves a path its own renderer-side picker produced, and takes PDFs as
 *     an upload it has already staged on disk.
 *   - **Highlighting inside the PDF.** That's Chromium's find-in-page reaching
 *     into the PDFium plugin, which only exists in the desktop app. The default
 *     reports zero matches, which the Reader already treats as "fall back to a
 *     plain page jump".
 */

import { promises as fs } from 'fs'
import { homedir } from 'os'
import { join, dirname, resolve as resolvePath } from 'path'
import type { IpcLike, WindowLike } from './platform'
import { registerPty } from './pty'
import { readProjectInfo, type ProjectMeta } from './scaffold'
import {
  addLibraryPapers,
  addProjectPaper,
  createProject,
  defaultLibraryRoot,
  enrichLibrary,
  getLibraryRoot,
  getProjectPapers,
  listLibraryPapers,
  listProjects,
  listTags,
  listGroups,
  setTagGroup,
  createTag,
  renameTag,
  reorderTags,
  addTagToPapers,
  setPapersReading,
  deleteTag,
  createGroup,
  renameGroup,
  deleteGroup,
  readPaperPdf,
  updateLibraryPaper,
  refetchLibraryPaper,
  suggestCitekey,
  renamePaperToHouseStyle,
  previewHouseRenames,
  type PaperPatch,
  removeLibraryPaper,
  removeProjectPaper,
  setLibraryRoot,
  getLastProject,
  setLastProject
} from './library'
import { fetchByDoi } from './metadata'
import {
  listInquiries,
  readInquiry,
  resolveSelection,
  createInquiry,
  updateInquiry,
  deleteInquiry,
  type InquirySelection
} from './inquiries'
import { watchLibrarySources, watchProjectDocs } from './watcher'
import { readDoc, saveDoc, registerQuarto } from './quarto'
import { registerNotes } from './notes'
import { registerPaperNotes } from './paperNotes'
import { registerPaperSearch } from './paperSearch'
import { registerProjectFiles } from './projectFiles'
import { registerRevising } from './revising'
import { registerWritingRules } from './writingRules'
import { registerRewrite } from './rewrite'
import { registerExtraRefs } from './extraRefs'
import { registerGit } from './git'
import { registerCheckpoints, ensureCheckpointHooks } from './checkpoints'
import { startBridge } from './bridge'

export interface CoreDeps {
  /**
   * Settle on a library folder. `requested` is what the renderer asked for —
   * meaningful only where the renderer can name a path (server mode); the
   * desktop app opens its native dialog and ignores it. Null means cancelled.
   */
  pickDirectory(requested: string | null): Promise<string | null>
  /**
   * Absolute paths of PDFs to copy into the library. `staged` is what the
   * renderer already put on disk (server mode: an upload); the desktop app
   * opens its native dialog and ignores it.
   */
  pickPdfs(staged: string[] | null): Promise<string[]>
  /** Light a passage up inside the PDF viewer; resolves with match count. */
  highlight?(text: string): Promise<number>
  clearHighlight?(): void
  /** Identifies the host to the renderer — see the `host:info` handler. */
  host: HostInfo
}

/** What the renderer needs to know about where its backend is running. */
export interface HostInfo {
  mode: 'desktop' | 'server'
  /**
   * The backend can raise a real file dialog. False in the browser, where the
   * renderer draws its own folder picker over `fs:listDir` and uploads PDFs
   * instead of naming them by path.
   */
  nativePickers: boolean
  /** Home directory of the account the backend runs as; the picker starts here. */
  home: string
}

export interface Core {
  /** Kill every embedded PTY — call before tearing the host down. */
  killPtys(): void
  /** Release the hook bridge's published address. */
  stop(): void
}

export function registerCore(
  ipc: IpcLike,
  getWindow: () => WindowLike | null,
  deps: CoreDeps
): Core {
  // --- Host capabilities ------------------------------------------------------
  // The renderer adapts to its backend rather than sniffing for Electron, so
  // that a single build of the UI serves both.
  ipc.handle('host:info', () => deps.host)

  /**
   * Directory listing for the browser's folder picker. Directories only — it
   * exists to choose a library root, not to browse files — and it lists the
   * machine the BACKEND runs on, which is the whole point when that machine is
   * a lab server. No new exposure: anyone who can reach this router can already
   * spawn a shell through `pty:spawn`.
   */
  ipc.handle('fs:listDir', async (_e, target: string | null = null) => {
    // Fall back to the nearest existing ancestor rather than erroring. The
    // picker opens on the suggested library path, which by definition doesn't
    // exist yet on a first run — and it makes a typed path with a typo land
    // somewhere useful instead of on a stack trace.
    let path = resolvePath(target && target.trim() ? target : homedir())
    for (;;) {
      try {
        if ((await fs.stat(path)).isDirectory()) break
      } catch {
        /* keep walking up */
      }
      const up = dirname(path)
      if (up === path) {
        path = homedir()
        break
      }
      path = up
    }
    const dirents = await fs.readdir(path, { withFileTypes: true })
    const entries = dirents
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => ({ name: d.name, path: join(path, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
    const parent = dirname(path)
    return { path, parent: parent === path ? null : parent, entries }
  })

  /** Create a folder from the browser picker (the native dialog can do this). */
  ipc.handle('fs:mkdir', async (_e, args: { parent: string; name: string }) => {
    const path = join(resolvePath(args.parent), args.name)
    await fs.mkdir(path, { recursive: true })
    return path
  })

  // --- Reader highlight (desktop only; see CoreDeps) --------------------------
  ipc.handle('reader:highlight', async (_e, text: string): Promise<number> =>
    deps.highlight && text ? deps.highlight(text) : 0
  )
  ipc.handle('reader:clear-highlight', () => deps.clearHighlight?.())

  // --- Library root ---
  ipc.handle('library:get', () => getLibraryRoot())
  ipc.handle('library:defaultPath', () => defaultLibraryRoot())
  ipc.handle('library:useDefault', async () => {
    const root = await setLibraryRoot(defaultLibraryRoot())
    await watchLibrarySources(root, getWindow)
    return root
  })
  ipc.handle('library:choose', async (_e, requested: string | null = null) => {
    const picked = await deps.pickDirectory(requested)
    if (!picked) return null
    const root = await setLibraryRoot(picked)
    await watchLibrarySources(root, getWindow)
    return root
  })

  // --- Global papers ---
  ipc.handle('library:papers', async () => {
    const root = await getLibraryRoot()
    return root ? listLibraryPapers(root) : []
  })
  ipc.handle('library:addPapers', async (_e, staged: string[] | null = null) => {
    const root = await getLibraryRoot()
    if (!root) return []
    const files = await deps.pickPdfs(staged)
    if (!files.length) return []
    const added = await addLibraryPapers(root, files)
    // Fetch real metadata in the background; refresh the UI as each entry fills in.
    void enrichLibrary(root, () => send(getWindow, 'library:changed'))
    return added
  })
  ipc.handle('library:tags', async () => {
    const root = await getLibraryRoot()
    return root ? listTags(root) : []
  })
  ipc.handle('library:groups', async () => {
    const root = await getLibraryRoot()
    return root ? listGroups(root) : []
  })
  ipc.handle('library:setTagGroup', async (_e, args: { tagId: string; groupId: string | null }) => {
    const root = await getLibraryRoot()
    if (root) await setTagGroup(root, args.tagId, args.groupId)
  })
  ipc.handle('library:createGroup', async (_e, name: string) => {
    const root = await getLibraryRoot()
    return root ? createGroup(root, name) : null
  })
  ipc.handle('library:renameGroup', async (_e, args: { groupId: string; name: string }) => {
    const root = await getLibraryRoot()
    if (root) await renameGroup(root, args.groupId, args.name)
  })
  ipc.handle('library:deleteGroup', async (_e, groupId: string) => {
    const root = await getLibraryRoot()
    if (root) await deleteGroup(root, groupId)
  })
  ipc.handle('library:createTag', async (_e, name: string) => {
    const root = await getLibraryRoot()
    return root ? createTag(root, name) : null
  })
  ipc.handle('library:renameTag', async (_e, args: { tagId: string; name: string }) => {
    const root = await getLibraryRoot()
    if (root) await renameTag(root, args.tagId, args.name)
  })
  ipc.handle(
    'library:reorderTags',
    async (_e, entries: Array<{ id: string; groupId: string | null }>) => {
      const root = await getLibraryRoot()
      if (root) await reorderTags(root, entries)
    }
  )
  ipc.handle('library:addTagToPapers', async (_e, args: { tagId: string; paperIds: string[] }) => {
    const root = await getLibraryRoot()
    if (root) await addTagToPapers(root, args.tagId, args.paperIds)
  })
  ipc.handle('library:setReading', async (_e, args: { paperIds: string[]; on: boolean }) => {
    const root = await getLibraryRoot()
    if (root) await setPapersReading(root, args.paperIds, args.on)
  })
  ipc.handle('library:deleteTag', async (_e, tagId: string) => {
    const root = await getLibraryRoot()
    if (root) await deleteTag(root, tagId)
  })
  // Raw PDF bytes for the in-app reader (renderer wraps them in a blob: URL).
  ipc.handle('library:pdf', async (_e, id: string) => {
    const root = await getLibraryRoot()
    return root ? readPaperPdf(root, id) : null
  })
  ipc.handle('library:updatePaper', async (_e, args: { id: string; patch: PaperPatch }) => {
    const root = await getLibraryRoot()
    return root ? updateLibraryPaper(root, args.id, args.patch) : { files: 0, occurrences: 0 }
  })
  ipc.handle('library:refetchPaper', async (_e, id: string) => {
    const root = await getLibraryRoot()
    if (root) await refetchLibraryPaper(root, id)
  })
  ipc.handle(
    'library:suggestCitekey',
    async (_e, args: { id: string; authors: string[]; year?: string }) => {
      const root = await getLibraryRoot()
      return root ? suggestCitekey(root, args.id, args.authors, args.year) : ''
    }
  )
  // Direct DOI→Crossref lookup for the Inspector's Fetch button (returns metadata
  // for the renderer to drop into the edit form; does not mutate the registry).
  ipc.handle('library:fetchDoi', (_e, doi: string) => fetchByDoi(doi))
  ipc.handle('library:renamePaper', async (_e, id: string) => {
    const root = await getLibraryRoot()
    return root ? renamePaperToHouseStyle(root, id) : { renamed: false, reason: 'missing' }
  })
  ipc.handle('library:renamePreview', async () => {
    const root = await getLibraryRoot()
    return root ? previewHouseRenames(root) : []
  })
  ipc.handle('library:removePaper', async (_e, id: string) => {
    const root = await getLibraryRoot()
    if (root) await removeLibraryPaper(root, id)
  })

  // --- Projects ---
  ipc.handle('projects:list', async () => {
    const root = await getLibraryRoot()
    if (!root) return []
    const projects = await listProjects(root)
    // Backfill checkpoint hooks into every project. This is the install point
    // that actually runs: the renderer loads the project list on boot and after
    // any library change, whereas `project:info` has no caller at all. Claude
    // Code picks up a settings.json change with its own file watcher, so a
    // session already running in the terminal starts checkpointing without
    // being restarted. Idempotent and off the critical path.
    void Promise.all(projects.map((p) => ensureCheckpointHooks(p.path)))
    return projects
  })
  // The project the user last opened, so a relaunch lands back in it.
  ipc.handle('projects:last:get', () => getLastProject())
  ipc.handle('projects:last:set', (_e, projectPath: string | null) => setLastProject(projectPath))
  ipc.handle('project:create', async (_e, args: { name: string; meta: ProjectMeta }) => {
    const root = await getLibraryRoot()
    if (!root) return { ok: false, error: 'No library configured.' }
    const created = await createProject(root, args.name, args.meta, new Date().toISOString())
    if (created.projectPath) await ensureCheckpointHooks(created.projectPath)
    return created
  })
  ipc.handle('project:info', async (_e, projectPath: string) => {
    // Opening a project is also where checkpoint hooks get backfilled into
    // projects scaffolded before checkpoint review existed. Idempotent.
    void ensureCheckpointHooks(projectPath)
    return readProjectInfo(projectPath)
  })
  ipc.handle('project:doc:get', (_e, args: { projectPath: string }) => readDoc(args.projectPath))
  ipc.handle('project:doc:save', (_e, args: { projectPath: string; content: string }) =>
    saveDoc(args.projectPath, args.content)
  )
  // Watch the open project's manuscript.qmd for external edits (e.g. Claude in
  // the terminal). Passing null stops watching.
  ipc.handle('project:doc:watch', (_e, projectPath: string | null) =>
    watchProjectDocs(projectPath, getWindow)
  )

  // --- Project ↔ library paper references ---
  ipc.handle('project:papers', async (_e, projectPath: string) => {
    const root = await getLibraryRoot()
    return root ? getProjectPapers(root, projectPath) : { selected: [], available: [] }
  })
  ipc.handle('project:addPaper', async (_e, args: { projectPath: string; id: string }) => {
    const root = await getLibraryRoot()
    if (root) await addProjectPaper(root, args.projectPath, args.id)
  })
  ipc.handle('project:removePaper', async (_e, args: { projectPath: string; id: string }) => {
    const root = await getLibraryRoot()
    if (root) await removeProjectPaper(root, args.projectPath, args.id)
  })

  // --- Inquiries ("talk to your literature") ---
  ipc.handle('inquiries:list', async () => {
    const root = await getLibraryRoot()
    return root ? listInquiries(root) : []
  })
  ipc.handle('inquiry:read', async (_e, slug: string) => {
    const root = await getLibraryRoot()
    return root ? readInquiry(root, slug) : null
  })
  ipc.handle('inquiry:resolve', async (_e, selection: InquirySelection) => {
    const root = await getLibraryRoot()
    return root ? resolveSelection(root, selection) : []
  })
  ipc.handle(
    'inquiry:create',
    async (
      _e,
      args: { title: string; question: string; selection: InquirySelection; draft?: boolean }
    ) => {
      const root = await getLibraryRoot()
      if (!root) return null
      return createInquiry(
        root,
        args.title,
        args.question,
        args.selection,
        new Date().toISOString(),
        Boolean(args.draft)
      )
    }
  )
  ipc.handle(
    'inquiry:update',
    async (
      _e,
      args: {
        slug: string
        title: string
        question: string
        selection: InquirySelection
        draft?: boolean
      }
    ) => {
      const root = await getLibraryRoot()
      if (!root) return null
      return updateInquiry(root, args.slug, {
        title: args.title,
        question: args.question,
        selection: args.selection,
        draft: Boolean(args.draft)
      })
    }
  )
  ipc.handle('inquiry:delete', async (_e, slug: string) => {
    const root = await getLibraryRoot()
    if (root) await deleteInquiry(root, slug)
  })

  // --- Feature modules ---
  const { killAll } = registerPty(ipc, getWindow)
  registerQuarto(ipc, getWindow)
  registerNotes(ipc)
  registerWritingRules(ipc, getLibraryRoot)
  registerRewrite(ipc, getLibraryRoot)
  registerPaperNotes(ipc)
  registerPaperSearch(ipc)
  registerProjectFiles(ipc)
  registerRevising(ipc)
  registerExtraRefs(ipc)
  registerGit(ipc)
  registerCheckpoints(ipc, getWindow)

  // The loopback endpoint Claude Code's hooks report turn boundaries to. Best
  // effort: without it edits still happen, they just aren't grouped by prompt.
  let stopBridge: () => void = () => {}
  startBridge(getWindow)
    .then(({ stop }) => {
      stopBridge = stop
    })
    .catch(() => {})

  // Start watching .sources/ if a library is already configured.
  void getLibraryRoot().then((root) => {
    if (root) void watchLibrarySources(root, getWindow)
  })

  return { killPtys: killAll, stop: () => stopBridge() }
}

/** Push an event at the renderer, tolerating a host that is tearing down. */
function send(getWindow: () => WindowLike | null, channel: string, ...args: unknown[]): void {
  const win = getWindow()
  if (!win || win.isDestroyed()) return
  try {
    win.webContents.send(channel, ...args)
  } catch {
    /* host tore down mid-send */
  }
}
