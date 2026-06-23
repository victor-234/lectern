import { shell, type IpcMain, type BrowserWindow } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { promises as fs } from 'fs'
import { basename, dirname, join, resolve, sep } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { ensureExtraBib } from './extraRefs'

/**
 * A project's real work happens in two Quarto documents at the project root:
 * `manuscript.qmd` (→ PDF/HTML) and `slides.qmd` (→ revealjs). You write prose,
 * cite library papers with `@citekey` against the generated `references.bib`,
 * run analyses in code chunks, and `quarto render` to produce real documents.
 * The folder is the source of truth — Claude editing these files shows up here.
 */

export type DocKind = 'manuscript' | 'slides'
export type RenderFormat = 'pdf' | 'html' | 'revealjs'

export interface QuartoDoc {
  which: DocKind
  file: string // project-relative filename
  content: string
  exists: boolean
}

export const FILES: Record<DocKind, string> = {
  manuscript: 'manuscript.qmd',
  slides: 'slides.qmd'
}

// --- Front matter split -------------------------------------------------------

/**
 * Split a Quarto doc into its leading YAML front-matter block and the prose body.
 * `frontMatter` keeps its `---` fences (empty string when the doc has none).
 * The manuscript hides its front matter from the writing editor — it's edited
 * separately in the Config modal — so the paper isn't bloated by metadata.
 */
export function splitFrontMatter(content: string): { frontMatter: string; body: string } {
  const m = content.match(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/)
  if (!m) return { frontMatter: '', body: content }
  return { frontMatter: m[0], body: content.slice(m[0].length) }
}

/** Recombine an (edited) front-matter block with a body into a full Quarto doc. */
export function joinFrontMatter(frontMatter: string, body: string): string {
  const fm = frontMatter.trim()
  const prose = body.replace(/^\n+/, '')
  return fm ? `${fm}\n\n${prose}` : prose
}

// --- Read / save -------------------------------------------------------------

export async function readDoc(projectPath: string, which: DocKind): Promise<QuartoDoc> {
  await ensureQuartoDocs(projectPath)
  const file = FILES[which]
  let raw = ''
  let exists = true
  try {
    raw = await fs.readFile(join(projectPath, file), 'utf8')
  } catch {
    exists = false
  }
  // The manuscript editor only sees the body; its YAML lives in the Config modal.
  const content =
    which === 'manuscript' ? splitFrontMatter(raw).body.replace(/^\n+/, '') : raw
  return { which, file, content, exists }
}

/**
 * Overwrite a project's manuscript/slides .qmd. Path-guarded so a bad `which`
 * can never escape the project folder or touch a non-.qmd file (mirrors the
 * guard `manuscript.ts:saveSection` used). For the manuscript, `content` is the
 * body alone — the on-disk YAML front matter is re-read and preserved, so the
 * body editor and the Config front-matter editor never clobber each other.
 */
export async function saveDoc(projectPath: string, which: DocKind, content: string): Promise<QuartoDoc> {
  const file = FILES[which]
  const abs = resolve(projectPath, file)
  const root = resolve(projectPath)
  if (!abs.startsWith(root + sep) || !abs.toLowerCase().endsWith('.qmd')) {
    throw new Error(`refusing to write outside the project: ${file}`)
  }
  let toWrite = content
  if (which === 'manuscript') {
    let existing = ''
    try {
      existing = await fs.readFile(abs, 'utf8')
    } catch {
      /* new file — no front matter to preserve */
    }
    toWrite = joinFrontMatter(splitFrontMatter(existing).frontMatter, content)
  }
  await fs.writeFile(abs, toWrite, 'utf8')
  return { which, file, content, exists: true }
}

// --- Scaffold / migrate ------------------------------------------------------

/**
 * Ensure `manuscript.qmd` + `slides.qmd` exist for a project. Non-destructive:
 *  - manuscript missing → build it from any legacy `manuscript/sections/*.md`
 *    (concatenated in order) or a starter template, with YAML front matter.
 *  - manuscript present but front-matter-less → prepend front matter, keep body
 *    (covers hand-made qmd files that start with a heading).
 *  - slides missing → write the revealjs starter.
 * Old `manuscript/sections/` is left on disk, just no longer surfaced.
 */
export async function ensureQuartoDocs(projectPath: string): Promise<void> {
  const { title, authors } = await readConfig(projectPath)

  const mPath = join(projectPath, FILES.manuscript)
  let mContent: string | null = null
  try {
    mContent = await fs.readFile(mPath, 'utf8')
  } catch {
    mContent = null
  }
  if (mContent == null) {
    const body = (await legacyBody(projectPath)) ?? defaultManuscriptBody()
    await fs.writeFile(mPath, frontMatter('manuscript', title, authors) + '\n' + body + '\n', 'utf8')
  } else if (!mContent.trimStart().startsWith('---')) {
    await fs.writeFile(
      mPath,
      frontMatter('manuscript', title, authors) + '\n' + mContent.trimStart(),
      'utf8'
    )
  }

  const sPath = join(projectPath, FILES.slides)
  try {
    await fs.access(sPath)
  } catch {
    await fs.writeFile(
      sPath,
      frontMatter('slides', title, authors) + '\n' + defaultSlidesBody() + '\n',
      'utf8'
    )
  }

  // Materialize the project's manual-references bib and wire it into the front
  // matter (upgrades legacy scalar `bibliography:` to a list). Idempotent.
  await ensureExtraBib(projectPath)
}

async function readConfig(projectPath: string): Promise<{ title: string; authors: string[] }> {
  try {
    const j = JSON.parse(await fs.readFile(join(projectPath, '.lctrn', 'config.json'), 'utf8'))
    return {
      title: typeof j.title === 'string' && j.title ? j.title : basename(projectPath),
      authors: Array.isArray(j.authors) ? j.authors : []
    }
  } catch {
    return { title: basename(projectPath), authors: [] }
  }
}

/**
 * Recover a manuscript body from a project's pre-existing layout so migrating to
 * a single root `manuscript.qmd` loses nothing. Prefers, in order:
 *  1. `manuscript/sections/*.{qmd,md}` concatenated in numeric-prefix order
 *     (the per-section model — excludes the `index.qmd` assembly file),
 *  2. a hand-made `manuscript/manuscript.qmd` or `manuscript/index.qmd` body
 *     (YAML front matter and `{{< include >}}`/marker lines stripped).
 * Returns null when there's nothing to migrate.
 */
async function legacyBody(projectPath: string): Promise<string | null> {
  const dir = join(projectPath, 'manuscript', 'sections')
  let files: string[] = []
  try {
    files = (await fs.readdir(dir)).filter(
      (f) => /\.(md|qmd)$/i.test(f) && f.toLowerCase() !== 'index.qmd'
    )
  } catch {
    files = []
  }
  if (files.length) {
    const ordered = files
      .map((f) => ({ f, order: orderOf(f) }))
      .sort((a, b) => a.order - b.order || a.f.localeCompare(b.f))
    const parts: string[] = []
    for (const { f } of ordered) {
      try {
        const c = (await fs.readFile(join(dir, f), 'utf8')).trim()
        if (c) parts.push(c)
      } catch {
        /* skip unreadable section */
      }
    }
    if (parts.length) return parts.join('\n\n')
  }

  // No sections — fall back to a single hand-made manuscript file.
  for (const rel of ['manuscript/manuscript.qmd', 'manuscript/index.qmd']) {
    try {
      const raw = await fs.readFile(join(projectPath, rel), 'utf8')
      const body = stripFrontMatterAndIncludes(raw).trim()
      if (body) return body
    } catch {
      /* not present */
    }
  }
  return null
}

/** Drop a leading YAML `--- … ---` block and any Quarto include/marker lines. */
function stripFrontMatterAndIncludes(s: string): string {
  let body = s
  const m = body.match(/^\s*---\n[\s\S]*?\n---\n?/)
  if (m) body = body.slice(m[0].length)
  return body
    .split('\n')
    .filter((l) => !/\{\{<\s*include/.test(l) && !/lectern:sections:(begin|end)/.test(l))
    .join('\n')
}

function orderOf(name: string): number {
  const m = name.match(/^(\d+)[-_.\s]/)
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER
}

function frontMatter(which: DocKind, title: string, authors: string[]): string {
  const authorLine = authors.length ? `author: "${yamlEsc(authors.join(', '))}"\n` : ''
  if (which === 'slides') {
    return [
      '---',
      `title: "${yamlEsc(title)}"`,
      authorLine.trimEnd(),
      'bibliography:',
      '  - ../../.lctrn/references.bib',
      '  - .lctrn/extra.bib',
      'format:',
      '  revealjs:',
      '    theme: default',
      '    incremental: true',
      '    slide-number: true',
      '---'
    ]
      .filter((l) => l !== '')
      .join('\n') + '\n'
  }
  return [
    '---',
    `title: "${yamlEsc(title)}"`,
    authorLine.trimEnd(),
    'date: today',
    'bibliography:',
    '  - ../../.lctrn/references.bib',
    '  - .lctrn/extra.bib',
    'format:',
    '  pdf:',
    '    number-sections: true',
    '  html:',
    '    toc: true',
    '    number-sections: true',
    '    embed-resources: true',
    'execute:',
    '  echo: false',
    '  warning: false',
    '---'
  ]
    .filter((l) => l !== '')
    .join('\n') + '\n'
}

function yamlEsc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

// Built from line arrays so the ``` code-fence backticks don't fight the JS literal.
function defaultManuscriptBody(): string {
  return [
    '# Introduction',
    '',
    'Write your introduction here. Cite library papers with `@citekey` — the keys',
    'come from the generated `references.bib`, e.g. as shown by @somekey.',
    '',
    '# Methods',
    '',
    '# Results',
    '',
    'Analyses run when you render. This R chunk executes via knitr:',
    '',
    '```{r}',
    '#| label: tbl-summary',
    '#| echo: false',
    'summary(cars)',
    '```',
    '',
    '# Discussion',
    '',
    '# References',
    '',
    '::: {#refs}',
    ':::'
  ].join('\n')
}

function defaultSlidesBody(): string {
  return [
    '## Overview',
    '',
    '- Motivation',
    '- Approach',
    '- Findings',
    '',
    '## Methods',
    '',
    '## Results',
    '',
    '## References',
    '',
    '::: {#refs}',
    ':::'
  ].join('\n')
}

// --- Render ------------------------------------------------------------------

/** Read `project.output-dir` from `_quarto.yml`, if set (e.g. `build`). Returns
 *  '' when there's no project file or no override, so output lands at the root. */
async function projectOutputDir(projectPath: string): Promise<string> {
  try {
    const yml = await fs.readFile(join(projectPath, '_quarto.yml'), 'utf8')
    let inProject = false
    for (const line of yml.split(/\r?\n/)) {
      if (/^\S/.test(line)) inProject = /^project:\s*(#.*)?$/.test(line)
      else if (inProject) {
        const m = line.match(/^\s+output-dir:\s*(.+?)\s*(#.*)?$/)
        if (m) return m[1].replace(/^['"]|['"]$/g, '')
      }
    }
  } catch {
    /* no _quarto.yml or unreadable — output stays at the project root */
  }
  return ''
}

/** Predicted output path, honoring a project `output-dir`. Used as the message
 *  label and as a fallback if Quarto's own "Output created:" line is absent. */
async function outputPath(projectPath: string, file: string, format: RenderFormat): Promise<string> {
  const ext = format === 'pdf' ? '.pdf' : '.html'
  const dir = await projectOutputDir(projectPath)
  return join(projectPath, dir, file.replace(/\.qmd$/i, ext))
}

/** The path from the last `Output created: <path>` line Quarto prints on success
 *  — the authoritative location it wrote, whatever the output-dir/output-file. */
function parseOutputCreated(log: string, projectPath: string): string | null {
  const re = /Output created:\s*(.+?)\s*$/gm
  let m: RegExpExecArray | null
  let last: string | null = null
  while ((m = re.exec(log))) last = m[1]
  return last ? resolve(projectPath, last) : null
}

/** POSIX single-quote a path for `sh -lc`. */
function shq(s: string): string {
  return `'` + s.replace(/'/g, `'\\''`) + `'`
}

export interface RenderResult {
  ok: boolean
  outputPath: string | null
  error?: string
}

// --- Cloud-sync-safe PDF rendering -------------------------------------------
//
// On a cloud-synced path (Dropbox/iCloud File Provider, etc.) the sync daemon
// races with the files LaTeX writes during a compile — the .log/.aux churn
// spawns "conflicted copy" duplicates, the in-place PDF is read half-written,
// and Quarto's output-dir rename intermittently fails with NotFound. None of
// the Quarto-level knobs avoid this reliably (output-dir adds a racy rename;
// latex-output-dir drops the inlined header preamble). So for PDF we render in
// an external shadow copy of the project — nothing is written into the synced
// tree during the compile — and copy only the finished PDF back into the
// project root, where the user wants it (synced, shareable, annotatable).

/** Resources excluded from the shadow copy: VCS, caches, prior build output,
 *  and Dropbox's own conflicted-copy litter. Everything else (the .qmd, .bib,
 *  .Renviron, doc-relative images) is mirrored so the render is faithful.
 *  `_quarto.yml` is excluded deliberately: this app keeps all settings in the
 *  .qmd header, and a stray/misconfigured project file (e.g. an `output-dir`
 *  pointing back into the synced tree) would otherwise break the render or
 *  reintroduce the cloud-sync race. */
const SHADOW_EXCLUDES = [
  '.git',
  '.quarto',
  'build',
  'node_modules',
  '.DS_Store',
  '_quarto.yml',
  '*conflicted copy*'
]

/** Stable external scratch ROOT for a given project (one per project path). The
 *  project is mirrored into `<root>/projects/<name>/` so that manuscript paths
 *  which escape the project — chiefly the shared `../../.lctrn/references.bib` —
 *  resolve to the same place they do under the real library root. */
function shadowDir(projectPath: string): string {
  const h = createHash('sha1').update(projectPath).digest('hex').slice(0, 10)
  return join(tmpdir(), 'lectern-render', `${basename(projectPath)}-${h}`)
}

/** Front-matter values that point OUTSIDE the project (start with `../`): the
 *  `bibliography:` list/scalar and a `csl:` scalar. The cloud-sync-safe PDF
 *  render copies only the project dir, so these shared files (the always-fresh
 *  library `references.bib`, a repo-level CSL) must be staged into the shadow at
 *  their mirrored relative location or Quarto/pandoc errors "not found in
 *  resource path". */
function externalFrontMatterRefs(qmd: string): string[] {
  if (!qmd.trimStart().startsWith('---')) return []
  const lines = qmd.split('\n')
  let start = -1
  let end = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      if (start === -1) start = i
      else {
        end = i
        break
      }
    }
  }
  if (start === -1 || end === -1) return []
  const strip = (s: string): string => s.replace(/^['"]|['"]$/g, '').trim()
  const refs: string[] = []
  for (let i = start + 1; i < end; i++) {
    const bib = lines[i].match(/^bibliography\s*:\s*(.*)$/)
    if (bib) {
      const inline = strip(bib[1].trim())
      if (inline) refs.push(inline)
      else {
        let j = i + 1
        while (j < end && /^\s*-\s+/.test(lines[j])) {
          refs.push(strip(lines[j].replace(/^\s*-\s+/, '').trim()))
          j++
        }
      }
    }
    const csl = lines[i].match(/^csl\s*:\s*(.+)$/)
    if (csl) {
      const v = strip(csl[1].trim())
      if (v) refs.push(v)
    }
  }
  return refs.filter((r) => r.startsWith('../'))
}

/** Copy every project-external bibliography/CSL the manuscript cites into the
 *  shadow tree at the same relative location, so its `../`-relative path resolves
 *  during the render. Guards against escaping the shadow root. */
async function stageExternalRefs(
  projectPath: string,
  renderCwd: string,
  shadowRoot: string,
  manuscriptRel: string,
  send: (s: string) => void
): Promise<void> {
  let qmd: string
  try {
    qmd = await fs.readFile(join(projectPath, manuscriptRel), 'utf8')
  } catch {
    return
  }
  for (const rel of externalFrontMatterRefs(qmd)) {
    const src = resolve(projectPath, rel)
    const dst = resolve(renderCwd, rel)
    if (dst !== shadowRoot && !dst.startsWith(shadowRoot + sep)) continue
    try {
      await fs.mkdir(dirname(dst), { recursive: true })
      await fs.copyFile(src, dst)
    } catch (e) {
      send(`(could not stage ${rel}: ${(e as Error).message})\n`)
    }
  }
}

/** Run a command in `cwd` via the login shell, streaming combined output to
 *  `send` and exposing the child to `setCurrent` (for one-at-a-time gating).
 *  Resolves with the exit code and the full captured log. */
function runStreaming(
  cmdline: string,
  cwd: string,
  send: (s: string) => void,
  setCurrent: (c: ChildProcess | null) => void
): Promise<{ code: number; log: string }> {
  const loginShell = process.env.SHELL || '/bin/zsh'
  send(`$ ${cmdline}\n`)
  return new Promise((res) => {
    let child: ChildProcess
    let log = ''
    try {
      child = spawn(loginShell, ['-lc', cmdline], { cwd, env: { ...process.env } })
    } catch (e) {
      send(`Failed to start: ${(e as Error).message}\n`)
      res({ code: -1, log })
      return
    }
    setCurrent(child)
    const collect = (d: Buffer): void => {
      const s = d.toString()
      log += s
      send(s)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', (err) => {
      setCurrent(null)
      send(`Failed: ${err.message}\n`)
      res({ code: -1, log })
    })
    child.on('close', (code) => {
      setCurrent(null)
      res({ code: code ?? -1, log })
    })
  })
}

// --- Inline cell preview ------------------------------------------------------

/** One executable code chunk's rendered output, keyed by its ordinal position
 *  among the doc's executable fences (0-based, document order). `html` is the
 *  Quarto `<div class="cell">…</div>` fragment for that chunk. */
export interface CellOutput {
  index: number
  html: string
}

export interface CellPreviewResult {
  ok: boolean
  cells: CellOutput[]
  error?: string
}

/**
 * Scan a Quarto body for executable code fences (```` ```{r} ````, ```` ```{python} ````)
 * and inject a raw-HTML anchor `<div id="lctrn-cell-N"></div>` immediately
 * before the Nth one (in document order). Plain fences (```` ``` ````/```` ```python ````)
 * and prose are left untouched. The anchors survive Pandoc verbatim, giving us
 * stable positions to slice each chunk's rendered output back out of the HTML —
 * pure ordinal mapping drifts because no-output chunks emit no `.cell` div.
 */
export function injectCellAnchors(body: string): { text: string; count: number } {
  const lines = body.split('\n')
  const out: string[] = []
  let inFence = false
  let fenceChar = ''
  let fenceLen = 0
  let n = 0
  for (const line of lines) {
    if (!inFence) {
      const open = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/)
      if (open) {
        const info = open[3].trim()
        const isExec = /^\{[^}]*\}/.test(info) // `{r}`, `{python}`, …
        inFence = true
        fenceChar = open[2][0]
        fenceLen = open[2].length
        if (isExec) {
          out.push(`<div id="lctrn-cell-${n}"></div>`, '')
          n++
        }
        out.push(line)
        continue
      }
      out.push(line)
    } else {
      const close = line.match(/^(\s*)(`{3,}|~{3,})\s*$/)
      if (close && close[2][0] === fenceChar && close[2].length >= fenceLen) {
        inFence = false
      }
      out.push(line)
    }
  }
  return { text: out.join('\n'), count: n }
}

/** Walk from the `<div …>` at `openStart`, balancing nested div tags, and return
 *  the index just past its matching `</div>`. */
function divEnd(html: string, openStart: number): number {
  const tagRe = /<\/?div\b[^>]*>/gi
  tagRe.lastIndex = openStart
  let depth = 0
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(html))) {
    if (m[0][1] === '/') {
      depth--
      if (depth === 0) return tagRe.lastIndex
    } else {
      depth++
    }
  }
  return html.length
}

/** Pull each chunk's `<div class="cell">…</div>` fragment out of rendered HTML,
 *  using the injected anchors to bound each chunk's segment. Chunks that produced
 *  no output simply have no `.cell` div in their segment and are omitted. */
export function extractCellOutputs(html: string): CellOutput[] {
  const anchors: { index: number; pos: number }[] = []
  const anchorRe = /id="lctrn-cell-(\d+)"/g
  let a: RegExpExecArray | null
  while ((a = anchorRe.exec(html))) {
    anchors.push({ index: parseInt(a[1], 10), pos: a.index })
  }
  anchors.sort((x, y) => x.pos - y.pos)

  const cells: CellOutput[] = []
  const cellRe = /<div [^>]*class="cell[ "][^>]*>/gi
  for (let i = 0; i < anchors.length; i++) {
    const start = anchors[i].pos
    const end = i + 1 < anchors.length ? anchors[i + 1].pos : html.length
    const seg = html.slice(start, end)
    let frag = ''
    cellRe.lastIndex = 0
    let c: RegExpExecArray | null
    while ((c = cellRe.exec(seg))) {
      const cEnd = divEnd(seg, c.index)
      frag += seg.slice(c.index, cEnd)
      cellRe.lastIndex = cEnd
    }
    if (frag.trim()) cells.push({ index: anchors[i].index, html: frag })
  }
  return cells
}

const PREVIEW_SUFFIX = '.lctrn-preview'

/**
 * Render a doc's code chunks to HTML and return each chunk's output fragment,
 * without disturbing the real document. Writes a temp sibling
 * (`<name>.lctrn-preview.qmd`) with anchors injected, renders it to
 * self-contained HTML (`-M embed-resources:true` forces figures base64-inlined,
 * so there are no relative `_files/` image paths the renderer can't load),
 * slices out the per-chunk output, then cleans up the temp artifacts. One
 * preview at a time.
 */
async function previewCells(projectPath: string, which: DocKind): Promise<CellPreviewResult> {
  const srcFile = FILES[which]
  let raw = ''
  try {
    raw = await fs.readFile(join(projectPath, srcFile), 'utf8')
  } catch {
    return { ok: false, cells: [], error: `${srcFile} not found.` }
  }

  const { frontMatter, body } = splitFrontMatter(raw)
  if (!frontMatter.trim()) {
    return { ok: false, cells: [], error: 'Document has no front matter to render from.' }
  }
  const { text: anchored, count } = injectCellAnchors(body)
  if (count === 0) return { ok: true, cells: [] } // nothing executable to preview

  const tmpName = srcFile.replace(/\.qmd$/i, PREVIEW_SUFFIX + '.qmd')
  const tmpAbs = resolve(projectPath, tmpName)
  const root = resolve(projectPath)
  if (!tmpAbs.startsWith(root + sep)) {
    return { ok: false, cells: [], error: 'refusing to write the preview outside the project' }
  }
  const htmlAbs = tmpAbs.replace(/\.qmd$/i, '.html')
  const filesDir = tmpAbs.replace(/\.qmd$/i, '_files')

  const cleanup = async (): Promise<void> => {
    await Promise.allSettled([
      fs.rm(tmpAbs, { force: true }),
      fs.rm(htmlAbs, { force: true }),
      fs.rm(filesDir, { recursive: true, force: true })
    ])
  }

  try {
    await fs.writeFile(tmpAbs, joinFrontMatter(frontMatter, anchored), 'utf8')
    const loginShell = process.env.SHELL || '/bin/zsh'
    // Force `embed-resources` so figures come back base64-inlined regardless of
    // the doc's own front matter — otherwise Quarto writes them to a sibling
    // `_files/` dir as relative `<img src>`s that the renderer can't load (and
    // that we delete on cleanup anyway).
    const cmd = `quarto render ${shq(tmpName)} --to html -M embed-resources:true`
    await new Promise<void>((res, rej) => {
      const child = spawn(loginShell, ['-lc', cmd], { cwd: projectPath, env: { ...process.env } })
      let err = ''
      child.stderr?.on('data', (d) => (err += d.toString()))
      child.on('error', rej)
      child.on('close', (code) =>
        code === 0 ? res() : rej(new Error(err.trim() || `quarto exited ${code}`))
      )
    })
    const html = await fs.readFile(htmlAbs, 'utf8')
    return { ok: true, cells: extractCellOutputs(html) }
  } catch (e) {
    return { ok: false, cells: [], error: (e as Error).message }
  } finally {
    await cleanup()
  }
}

/**
 * Register the `quarto render` bridge. Runs the user's login shell
 * (`$SHELL -lc 'quarto render …'`) so PATH resolves `quarto`/TinyTeX even when
 * the packaged app is launched from Finder — the same reason `pty.ts` uses a
 * login shell. Streams combined stdout/stderr to the renderer over
 * `project:render:data`, opens the artifact in the OS on success, and emits
 * `project:render:exit`. One render at a time.
 */
export function registerQuarto(ipcMain: IpcMain, getWindow: () => BrowserWindow | null): void {
  let current: ChildProcess | null = null

  // Inline cell preview — one at a time, independent of the main render above.
  let previewing = false
  ipcMain.handle(
    'project:preview:cells',
    async (_e, args: { projectPath: string; which: DocKind }): Promise<CellPreviewResult> => {
      if (previewing) {
        return { ok: false, cells: [], error: 'A preview is already in progress.' }
      }
      previewing = true
      try {
        return await previewCells(args.projectPath, args.which)
      } finally {
        previewing = false
      }
    }
  )

  ipcMain.handle(
    'project:render',
    async (_e, args: { projectPath: string; which: DocKind; format: RenderFormat }): Promise<RenderResult> => {
      if (current) {
        return { ok: false, outputPath: null, error: 'A render is already in progress.' }
      }
      const file = FILES[args.which]
      const send = (s: string): void => {
        getWindow()?.webContents.send('project:render:data', s)
      }
      const setCurrent = (c: ChildProcess | null): void => {
        current = c
      }
      const finish = (r: RenderResult, code: number): RenderResult => {
        getWindow()?.webContents.send('project:render:exit', { code, ok: r.ok, outputPath: r.outputPath })
        return r
      }
      const openBestEffort = async (p: string): Promise<void> => {
        send(`\n✓ Rendered ${basename(p)} — opening…\n`)
        try {
          const err = await shell.openPath(p)
          if (err) send(`(could not open ${p}: ${err})\n`)
        } catch {
          /* opening is best-effort */
        }
      }

      try {
        // PDF: render in an external shadow copy so LaTeX never writes into a
        // cloud-synced tree, then copy the finished PDF back into the project.
        if (args.format === 'pdf') {
          const shadowRoot = shadowDir(args.projectPath)
          // Mirror the project at its real position under the library root
          // (`<root>/projects/<name>`) so a manuscript path that escapes the
          // project (e.g. the shared `../../.lctrn/references.bib`) resolves the
          // same way it does in the synced tree.
          const renderCwd = join(shadowRoot, 'projects', basename(args.projectPath))
          await fs.mkdir(renderCwd, { recursive: true })
          const excludes = SHADOW_EXCLUDES.map((p) => `--exclude=${shq(p)}`).join(' ')
          // --delete-excluded so excluded cruft (a stale _quarto.yml, old
          // build/, caches) can't linger in the shadow and break a later render.
          const sync = await runStreaming(
            `rsync -a --delete --delete-excluded ${excludes} ${shq(args.projectPath + '/')} ${shq(renderCwd + '/')}`,
            args.projectPath,
            send,
            setCurrent
          )
          if (sync.code !== 0) {
            send(`\n✗ Could not stage the render (rsync exit ${sync.code}).\n`)
            return finish({ ok: false, outputPath: null, error: `rsync failed (exit ${sync.code}).` }, sync.code)
          }
          // Stage shared bibs/CSL the manuscript cites from outside the project.
          await stageExternalRefs(args.projectPath, renderCwd, shadowRoot, file, send)
          const r = await runStreaming(`quarto render ${shq(file)} --to pdf`, renderCwd, send, setCurrent)
          if (r.code !== 0) {
            send(`\n✗ Render failed (exit ${r.code}).\n`)
            return finish({ ok: false, outputPath: null, error: `Render failed (exit ${r.code}).` }, r.code)
          }
          const built = parseOutputCreated(r.log, renderCwd) ?? join(renderCwd, file.replace(/\.qmd$/i, '.pdf'))
          const dest = join(args.projectPath, basename(built))
          try {
            await fs.copyFile(built, dest)
          } catch (e) {
            const error = `Rendered, but could not place the PDF in the project: ${(e as Error).message}`
            send(`\n✗ ${error}\n`)
            return finish({ ok: false, outputPath: null, error }, 0)
          }
          await openBestEffort(dest)
          return finish({ ok: true, outputPath: dest }, 0)
        }

        // HTML / revealjs: no LaTeX, no .log churn — render in place.
        const predicted = await outputPath(args.projectPath, file, args.format)
        const r = await runStreaming(
          `quarto render ${shq(file)} --to ${args.format}`,
          args.projectPath,
          send,
          setCurrent
        )
        if (r.code !== 0) {
          send(`\n✗ Render failed (exit ${r.code}).\n`)
          return finish({ ok: false, outputPath: null, error: `Render failed (exit ${r.code}).` }, r.code)
        }
        const out = parseOutputCreated(r.log, args.projectPath) ?? predicted
        await openBestEffort(out)
        return finish({ ok: true, outputPath: out }, 0)
      } finally {
        current = null
      }
    }
  )
}
