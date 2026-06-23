import { app, BrowserWindow, ipcMain, dialog, nativeImage, protocol, net, Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
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
  deleteTag,
  createGroup,
  renameGroup,
  deleteGroup,
  paperAbsPath,
  readPaperPdf,
  updateLibraryPaper,
  refetchLibraryPaper,
  renamePaperToHouseStyle,
  previewHouseRenames,
  type PaperPatch,
  removeLibraryPaper,
  removeProjectPaper,
  setLibraryRoot
} from './library'
import {
  listInquiries,
  readInquiry,
  resolveSelection,
  createInquiry,
  deleteInquiry,
  type InquirySelection
} from './inquiries'
import { watchLibrarySources, watchProjectDocs } from './watcher'
import { readDoc, saveDoc, registerQuarto, type DocKind } from './quarto'
import { registerNotes } from './notes'
import { registerPaperNotes } from './paperNotes'
import { registerProjectFiles } from './projectFiles'
import { registerRevising } from './revising'
import { registerExtraRefs } from './extraRefs'

let mainWindow: BrowserWindow | null = null

// Kills all embedded PTYs; wired to registerPty in app.whenReady. Called when the
// window closes so buffered shell output can't fire into a destroyed webContents.
let killPtys: () => void = () => {}

// Custom scheme that streams library PDFs to the in-app reader. Registered as a
// standard, secure scheme (before app-ready) so Chromium's PDFium viewer treats
// it like http(s) and renders it inside an <iframe>. URL shape: lctrn-pdf://paper/<id>
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'lctrn-pdf',
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true }
  }
])

// Brand mark lives at <projectRoot>/resources; __dirname is out/main in both dev and build.
const RESOURCES = join(__dirname, '../../resources')
const appIcon = nativeImage.createFromPath(join(RESOURCES, 'icon.png'))

// Application menu. Without one, macOS uses Electron's default menu where ⌘W is
// the native "Close Window" role — that accelerator fires before the renderer's
// keydown handler, so reading a paper and pressing ⌘W quit the app. Here ⌘W is a
// custom item that asks the renderer to close the active reader tab; the renderer
// only falls back to closing the window when no paper is open.
function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const sendClose = (): void => mainWindow?.webContents.send('menu:close')

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{ role: 'appMenu' as const }]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'Close', accelerator: 'CmdOrCtrl+W', click: sendClose },
        { type: 'separator' as const },
        { role: 'quit' as const }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    title: 'Lectern',
    icon: appIcon,
    backgroundColor: '#15171d',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // Chromium's built-in PDFium viewer (used by the in-app paper reader).
      plugins: true
    }
  })

  mainWindow.on('closed', () => {
    killPtys()
    mainWindow = null
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// The macOS app menu (top-left, bold) and About panel use app.name. Packaged
// builds get this from CFBundleName (productName), but set it explicitly so dev
// runs match. Must be called before the app is ready.
app.setName('Lectern')

app.whenReady().then(() => {
  // Dock icon (macOS dev — packaged builds use resources/icon.icns).
  if (process.platform === 'darwin' && !appIcon.isEmpty()) app.dock?.setIcon(appIcon)

  buildMenu()

  // Renderer's fallback for ⌘W (the File ▸ Close menu item) when no paper is open.
  ipcMain.on('window:close', () => mainWindow?.close())

  // Serve library PDFs for the reader. Resolves by paper id through the registry
  // (never a renderer-supplied path), then streams the file via net.fetch.
  protocol.handle('lctrn-pdf', async (request) => {
    const id = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, ''))
    const root = await getLibraryRoot()
    const abs = root ? await paperAbsPath(root, id) : null
    if (!abs) return new Response('Not found', { status: 404 })
    return net.fetch(pathToFileURL(abs).toString())
  })

  // --- Library root ---
  ipcMain.handle('library:get', () => getLibraryRoot())
  ipcMain.handle('library:defaultPath', () => defaultLibraryRoot())
  ipcMain.handle('library:useDefault', async () => {
    const root = await setLibraryRoot(defaultLibraryRoot())
    await watchLibrarySources(root, () => mainWindow)
    return root
  })
  ipcMain.handle('library:choose', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      message: 'Choose or create your lctrn library folder'
    })
    if (res.canceled || !res.filePaths[0]) return null
    const root = await setLibraryRoot(res.filePaths[0])
    await watchLibrarySources(root, () => mainWindow)
    return root
  })

  // --- Global papers ---
  ipcMain.handle('library:papers', async () => {
    const root = await getLibraryRoot()
    return root ? listLibraryPapers(root) : []
  })
  ipcMain.handle('library:addPapers', async () => {
    const root = await getLibraryRoot()
    if (!root) return []
    const res = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      message: 'Add PDFs to your library (copied into sources/)'
    })
    if (res.canceled || !res.filePaths.length) return []
    const added = await addLibraryPapers(root, res.filePaths)
    // Fetch real metadata in the background; refresh the UI as each entry fills in.
    void enrichLibrary(root, () => mainWindow?.webContents.send('library:changed'))
    return added
  })
  ipcMain.handle('library:tags', async () => {
    const root = await getLibraryRoot()
    return root ? listTags(root) : []
  })
  ipcMain.handle('library:groups', async () => {
    const root = await getLibraryRoot()
    return root ? listGroups(root) : []
  })
  ipcMain.handle(
    'library:setTagGroup',
    async (_e, args: { tagId: string; groupId: string | null }) => {
      const root = await getLibraryRoot()
      if (root) await setTagGroup(root, args.tagId, args.groupId)
    }
  )
  ipcMain.handle('library:createGroup', async (_e, name: string) => {
    const root = await getLibraryRoot()
    return root ? createGroup(root, name) : null
  })
  ipcMain.handle('library:renameGroup', async (_e, args: { groupId: string; name: string }) => {
    const root = await getLibraryRoot()
    if (root) await renameGroup(root, args.groupId, args.name)
  })
  ipcMain.handle('library:deleteGroup', async (_e, groupId: string) => {
    const root = await getLibraryRoot()
    if (root) await deleteGroup(root, groupId)
  })
  ipcMain.handle('library:createTag', async (_e, name: string) => {
    const root = await getLibraryRoot()
    return root ? createTag(root, name) : null
  })
  ipcMain.handle('library:renameTag', async (_e, args: { tagId: string; name: string }) => {
    const root = await getLibraryRoot()
    if (root) await renameTag(root, args.tagId, args.name)
  })
  ipcMain.handle(
    'library:reorderTags',
    async (_e, entries: Array<{ id: string; groupId: string | null }>) => {
      const root = await getLibraryRoot()
      if (root) await reorderTags(root, entries)
    }
  )
  ipcMain.handle(
    'library:addTagToPapers',
    async (_e, args: { tagId: string; paperIds: string[] }) => {
      const root = await getLibraryRoot()
      if (root) await addTagToPapers(root, args.tagId, args.paperIds)
    }
  )
  ipcMain.handle('library:deleteTag', async (_e, tagId: string) => {
    const root = await getLibraryRoot()
    if (root) await deleteTag(root, tagId)
  })
  // Raw PDF bytes for the in-app reader (renderer wraps them in a blob: URL).
  ipcMain.handle('library:pdf', async (_e, id: string) => {
    const root = await getLibraryRoot()
    return root ? readPaperPdf(root, id) : null
  })
  ipcMain.handle('library:updatePaper', async (_e, args: { id: string; patch: PaperPatch }) => {
    const root = await getLibraryRoot()
    if (root) await updateLibraryPaper(root, args.id, args.patch)
  })
  ipcMain.handle('library:refetchPaper', async (_e, id: string) => {
    const root = await getLibraryRoot()
    if (root) await refetchLibraryPaper(root, id)
  })
  ipcMain.handle('library:renamePaper', async (_e, id: string) => {
    const root = await getLibraryRoot()
    return root ? renamePaperToHouseStyle(root, id) : { renamed: false, reason: 'missing' }
  })
  ipcMain.handle('library:renamePreview', async () => {
    const root = await getLibraryRoot()
    return root ? previewHouseRenames(root) : []
  })
  ipcMain.handle('library:removePaper', async (_e, id: string) => {
    const root = await getLibraryRoot()
    if (root) await removeLibraryPaper(root, id)
  })

  // --- Projects ---
  ipcMain.handle('projects:list', async () => {
    const root = await getLibraryRoot()
    return root ? listProjects(root) : []
  })
  ipcMain.handle('project:create', async (_e, args: { name: string; meta: ProjectMeta }) => {
    const root = await getLibraryRoot()
    if (!root) return { ok: false, error: 'No library configured.' }
    return createProject(root, args.name, args.meta, new Date().toISOString())
  })
  ipcMain.handle('project:info', (_e, projectPath: string) => readProjectInfo(projectPath))
  ipcMain.handle('project:doc:get', (_e, args: { projectPath: string; which: DocKind }) =>
    readDoc(args.projectPath, args.which)
  )
  ipcMain.handle(
    'project:doc:save',
    (_e, args: { projectPath: string; which: DocKind; content: string }) =>
      saveDoc(args.projectPath, args.which, args.content)
  )
  // Watch the open project's .qmd files for external edits (e.g. Claude in the
  // terminal). Passing null stops watching.
  ipcMain.handle('project:doc:watch', (_e, projectPath: string | null) =>
    watchProjectDocs(projectPath, () => mainWindow)
  )

  // --- Project ↔ library paper references ---
  ipcMain.handle('project:papers', async (_e, projectPath: string) => {
    const root = await getLibraryRoot()
    return root ? getProjectPapers(root, projectPath) : { selected: [], available: [] }
  })
  ipcMain.handle('project:addPaper', async (_e, args: { projectPath: string; id: string }) => {
    const root = await getLibraryRoot()
    if (root) await addProjectPaper(root, args.projectPath, args.id)
  })
  ipcMain.handle('project:removePaper', async (_e, args: { projectPath: string; id: string }) => {
    const root = await getLibraryRoot()
    if (root) await removeProjectPaper(root, args.projectPath, args.id)
  })

  // --- Inquiries ("talk to your literature") ---
  ipcMain.handle('inquiries:list', async () => {
    const root = await getLibraryRoot()
    return root ? listInquiries(root) : []
  })
  ipcMain.handle('inquiry:read', async (_e, slug: string) => {
    const root = await getLibraryRoot()
    return root ? readInquiry(root, slug) : null
  })
  ipcMain.handle('inquiry:resolve', async (_e, selection: InquirySelection) => {
    const root = await getLibraryRoot()
    return root ? resolveSelection(root, selection) : []
  })
  ipcMain.handle(
    'inquiry:create',
    async (_e, args: { title: string; question: string; selection: InquirySelection }) => {
      const root = await getLibraryRoot()
      if (!root) return null
      return createInquiry(root, args.title, args.question, args.selection, new Date().toISOString())
    }
  )
  ipcMain.handle('inquiry:delete', async (_e, slug: string) => {
    const root = await getLibraryRoot()
    if (root) await deleteInquiry(root, slug)
  })

  // --- Embedded Claude Code terminal ---
  killPtys = registerPty(ipcMain, () => mainWindow).killAll

  // --- Quarto render (manuscript.qmd / slides.qmd) ---
  registerQuarto(ipcMain, () => mainWindow)

  // --- Manuscript margin notes (MANUSCRIPT_NOTES.md) ---
  registerNotes(ipcMain)

  // --- Per-paper reading notes (notes/<title>.md, shown beside the PDF reader) ---
  registerPaperNotes(ipcMain)

  // --- Project config files (REVISION_PLAN.md, WRITING_STYLE.md, …) ---
  registerProjectFiles(ipcMain)

  // --- Revising mode (track-changes → LEARNED_EDITS.md) ---
  registerRevising(ipcMain)

  // --- Per-project manual references (.lctrn/extra-refs.json → extra.bib) ---
  registerExtraRefs(ipcMain)

  createWindow()

  // Start watching .sources/ if a library is already configured.
  getLibraryRoot().then((root) => {
    if (root) void watchLibrarySources(root, () => mainWindow)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
