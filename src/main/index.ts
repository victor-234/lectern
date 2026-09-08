import { app, BrowserWindow, ipcMain, dialog, nativeImage, protocol, net, Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { installElectronPlatform } from './platform.electron'
import { registerCore } from './core'
import { getLibraryRoot, paperAbsPath } from './library'
import { projectPdfPath } from './projectFiles'

// Bind the host seam before anything can read a path or a stored secret. Every
// consumer is lazy, so this is early enough — see platform.ts.
installElectronPlatform()

let mainWindow: BrowserWindow | null = null

// Kills all embedded PTYs; wired to registerCore in app.whenReady. Called when
// the window closes so buffered shell output can't fire into a destroyed
// webContents.
let killPtys: () => void = () => {}
// Shuts down the Claude Code hook bridge; also from registerCore.
let stopCore: () => void = () => {}

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
//
// The navigation shortcuts (app switching, reader-tab jumps, quick-open, …) also
// live here as menu accelerators rather than renderer keydown handlers. The
// in-app PDF reader is a Chromium PDFium plugin that swallows key events before
// they reach the page, so a `<svelte:window onkeydown>` never sees ⌘/⌃ combos
// while a PDF is focused. Menu accelerators fire app-globally regardless of what
// has focus (that's why ⌘W works), so routing navigation through them makes the
// tab switcher etc. work in the Reader too. Each item just relays an action
// string to the renderer over `menu:shortcut`.
function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const sendClose = (): void => mainWindow?.webContents.send('menu:close')
  const go = (action: string): void => mainWindow?.webContents.send('menu:shortcut', action)
  // Reader tabs jump on ⌘1–9 (mac) / ⌥1–9 (win/linux) so they don't collide with
  // the ⌃1–3 app switcher below. The renderer routes these per app: in the
  // Workspace 1 and 2 focus the outline / notes rails instead.
  const tabAccel = (n: number): string => (isMac ? `Command+${n}` : `Alt+${n}`)

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
    {
      label: 'Go',
      submenu: [
        { label: 'Papers', accelerator: 'Control+1', click: () => go('app:papers') },
        { label: 'Reader', accelerator: 'Control+2', click: () => go('app:reader') },
        { label: 'Workspace', accelerator: 'Control+3', click: () => go('app:workspace') },
        { label: 'Next App', accelerator: 'Control+Tab', click: () => go('app:next') },
        { type: 'separator' as const },
        { label: 'Open Paper…', accelerator: 'CmdOrCtrl+O', click: () => go('open') },
        { label: 'All Papers', accelerator: 'CmdOrCtrl+Shift+K', click: () => go('library') },
        { label: 'Search Library', accelerator: 'CmdOrCtrl+K', click: () => go('search') },
        // ⌘F has to be an accelerator too: while a PDF is focused the PDFium
        // plugin eats the keystroke, so a page-level handler never sees it. The
        // renderer routes it — to a focused CodeMirror editor's own find panel
        // when there is one, otherwise to the Reader's find bar.
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () => go('find') },
        { label: 'Toggle Terminal', accelerator: 'CmdOrCtrl+J', click: () => go('terminal') },
        // Dock the Reader beside whatever you're doing instead of switching to
        // it. An accelerator for the same reason as ⌘F — the docked PDF has
        // focus more often than not, and the plugin eats page-level keys.
        { label: 'Reader Beside', accelerator: 'CmdOrCtrl+Alt+R', click: () => go('dock') },
        { type: 'separator' as const },
        {
          label: 'Reader Tab / Workspace Panel',
          submenu: Array.from({ length: 9 }, (_, i) => ({
            label: i === 0 ? 'Tab 1 · Outline' : i === 1 ? 'Tab 2 · Notes' : `Tab ${i + 1}`,
            accelerator: tabAccel(i + 1),
            click: () => go(`tab:${i}`)
          }))
        }
      ]
    },
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

  // Serve PDFs to in-app iframes. Two shapes:
  //   lctrn-pdf://paper/<id>                          — library paper, resolved
  //     by id through the registry (never a renderer-supplied path)
  //   lctrn-pdf://project/<projectPath>/<name>        — a PDF inside a project
  //     (e.g. the rendered manuscript), path-contained via projectPdfPath
  // The localhost server serves the same two shapes over /pdf/… instead; the
  // renderer picks between them in lib/pdfUrl.ts.
  protocol.handle('lctrn-pdf', async (request) => {
    const url = new URL(request.url)
    if (url.hostname === 'project') {
      const [pp, name] = url.pathname.replace(/^\//, '').split('/').map(decodeURIComponent)
      try {
        return await net.fetch(pathToFileURL(projectPdfPath(pp, name)).toString())
      } catch {
        return new Response('Not found', { status: 404 })
      }
    }
    const id = decodeURIComponent(url.pathname.replace(/^\//, ''))
    const root = await getLibraryRoot()
    const abs = root ? await paperAbsPath(root, id) : null
    if (!abs) return new Response('Not found', { status: 404 })
    return net.fetch(pathToFileURL(abs).toString())
  })

  // Everything else — library, projects, inquiries, terminal, render, review —
  // is host-agnostic and lives in core.ts, shared with the localhost server.
  // Only the native file dialogs and the PDF find-in-page are supplied here.
  const core = registerCore(ipcMain, () => mainWindow, {
    host: { mode: 'desktop', nativePickers: true, home: app.getPath('home') },
    async pickDirectory() {
      const res = await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
        message: 'Choose or create your lctrn library folder'
      })
      return res.canceled ? null : (res.filePaths[0] ?? null)
    },
    async pickPdfs() {
      const res = await dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
        message: 'Add PDFs to your library (copied into sources/)'
      })
      return res.canceled ? [] : res.filePaths
    },
    // --- Highlighting a passage inside the PDF -------------------------------
    // The reader's PDF is Chromium's PDFium plugin: the page can't draw into it
    // and has no handle on its text. Chromium's own find-in-page, though, DOES
    // reach inside the plugin — it paints the match and scrolls the viewer to
    // it. So the renderer hands us the passage it wants lit up and we run a find
    // for it.
    //
    // The search covers the whole window, our own DOM included, and the first
    // match wins the highlight — which is why the renderer sends a phrase long
    // enough that only the PDF can contain it (see probeFor in Reader.svelte).
    // `matches` comes back so the renderer can fall back to a plain page jump
    // when the PDF's text doesn't line up with ours (scans, odd hyphenation).
    // A browser has no equivalent, so in server mode this is absent and the
    // fallback is always what runs.
    highlight(text) {
      const wc = mainWindow?.webContents
      if (!wc) return Promise.resolve(0)
      return new Promise<number>((resolve) => {
        const done = setTimeout(() => resolve(0), 4000)
        wc.once('found-in-page', (_ev, result) => {
          clearTimeout(done)
          resolve(result.matches)
        })
        wc.findInPage(text)
      })
    },
    clearHighlight() {
      mainWindow?.webContents.stopFindInPage('clearSelection')
    }
  })
  killPtys = core.killPtys
  stopCore = core.stop

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Take the published bridge address down with the app, so a hook firing after
// quit finds nothing and exits silently instead of reaching a recycled port.
app.on('will-quit', () => stopCore())
