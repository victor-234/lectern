import type { IpcMain } from 'electron'
import { promises as fs } from 'fs'
import { dirname, resolve, sep } from 'path'
import { FILES as QUARTO_FILES, splitFrontMatter, joinFrontMatter } from './quarto'

/**
 * Virtual config entry mapping to the YAML front-matter slice of
 * `manuscript.qmd`. It isn't a real file on disk — get/save below translate it
 * to a read-modify-write of the manuscript's front matter, so the metadata can
 * be edited here without bloating the paper in the writing editor.
 */
export const FRONTMATTER_NAME = 'manuscript.qmd · front matter'

/**
 * Project config files — plain Markdown that lives at the project root (or in
 * `.claude/`) and *programs* how Claude works on the manuscript: a revision
 * plan, a writing-style guide, an outline, the Claude instructions, etc. Same
 * folder-as-source-of-truth model: the app is just a nice editor over these
 * files; Claude reads the same bytes.
 *
 * The UI offers a curated list (created from a starter template on first save)
 * plus any other root-level `*.md` the user has dropped in.
 */

export interface ConfigFileSpec {
  name: string // path relative to the project root
  label: string
}

export interface ConfigFileInfo extends ConfigFileSpec {
  exists: boolean
  curated: boolean
  /** Markdown files open in the split editor; PDFs in an embedded viewer. */
  kind: 'md' | 'pdf'
}

export interface ConfigFile {
  name: string
  content: string
  exists: boolean
}

// Files we suggest out of the box. `name` is project-relative so we can point at
// `.claude/CLAUDE.md` as well as root files.
export const CONFIG_FILES: ConfigFileSpec[] = [
  {
    // Canonical revision plan: the same file the workspace Plan panel reads and
    // the scaffolded CLAUDE.md tells Claude to keep in sync. (Older projects may
    // have a root-level REVISION_PLAN.md; the Plan panel still falls back to it.)
    name: 'revisions/revision-plan.md',
    label: 'Revision plan'
  },
  { name: 'WRITING_STYLE.md', label: 'Writing style' },
  // Durable writing rules learned from the author's manual corrections, written
  // by the `learn-edits` skill when a revising pass is finished.
  { name: 'LEARNED_EDITS.md', label: 'Learned edits' },
  { name: 'OUTLINE.md', label: 'Outline' },
  { name: '.claude/CLAUDE.md', label: 'Claude instructions' }
]

const STARTERS: Record<string, string> = {
  'revisions/revision-plan.md': [
    '# Revision plan',
    '',
    'Each item is a scoped task. Status: `[ ]` to-do · `[~]` doing · `[x]` done.',
    'You and Claude tick the same boxes — the workspace Plan panel writes to this file.',
    '',
    '- [ ] ',
    ''
  ].join('\n'),
  'WRITING_STYLE.md': [
    '# Writing Style',
    '',
    'How Claude should write in this manuscript.',
    '',
    '## Voice & tone',
    '',
    '- ',
    '',
    '## Conventions',
    '',
    '- Cite with `@citekey`.',
    '- ',
    ''
  ].join('\n'),
  'OUTLINE.md': [
    '# Outline',
    '',
    '- Introduction',
    '- Methods',
    '- Results',
    '- Discussion',
    ''
  ].join('\n'),
  '.claude/CLAUDE.md': [
    '# Project instructions',
    '',
    'Standing guidance for Claude Code working in this project.',
    '',
    '- The manuscript is `manuscript.qmd`; cite library papers with `@citekey`.',
    '- Follow `WRITING_STYLE.md` and work through `revisions/revision-plan.md`; tick a box when a step lands.',
    '- Margin notes from the editor are in `MANUSCRIPT_NOTES.md`.',
    ''
  ].join('\n')
}

function starterFor(name: string): string {
  return STARTERS[name] ?? `# ${name.replace(/\.md$/i, '')}\n\n`
}

// --- Manuscript front matter (virtual entry) ---------------------------------

const FRONTMATTER_STARTER = [
  '---',
  'title: "Untitled"',
  'date: today',
  'bibliography:',
  '  - ../../.lctrn/references.bib',
  '  - .lctrn/extra.bib',
  'format:',
  '  pdf:',
  '    number-sections: true',
  '---',
  ''
].join('\n')

function manuscriptPath(projectPath: string): string {
  return resolve(projectPath, QUARTO_FILES.manuscript)
}

async function readFrontMatter(projectPath: string): Promise<ConfigFile> {
  let raw = ''
  try {
    raw = await fs.readFile(manuscriptPath(projectPath), 'utf8')
  } catch {
    /* manuscript not created yet */
  }
  const fm = splitFrontMatter(raw).frontMatter
  return { name: FRONTMATTER_NAME, content: fm || FRONTMATTER_STARTER, exists: fm !== '' }
}

async function saveFrontMatter(projectPath: string, content: string): Promise<ConfigFile> {
  const abs = manuscriptPath(projectPath)
  let body = ''
  try {
    body = splitFrontMatter(await fs.readFile(abs, 'utf8')).body
  } catch {
    /* no manuscript yet — front matter becomes the whole file */
  }
  await fs.mkdir(dirname(abs), { recursive: true })
  await fs.writeFile(abs, joinFrontMatter(content, body), 'utf8')
  return { name: FRONTMATTER_NAME, content, exists: true }
}

// --- Path guard --------------------------------------------------------------

/** Resolve a project-relative config path, refusing anything outside the project or non-`.md`. */
function safePath(projectPath: string, name: string): string {
  const root = resolve(projectPath)
  const abs = resolve(root, name)
  if ((abs !== root && !abs.startsWith(root + sep)) || !abs.toLowerCase().endsWith('.md')) {
    throw new Error(`refusing to access config file outside the project: ${name}`)
  }
  return abs
}

/**
 * Resolve a project-relative PDF path for the `lctrn-pdf://project/…` protocol,
 * with the same containment guard as `safePath` but for `.pdf`.
 */
export function projectPdfPath(projectPath: string, name: string): string {
  const root = resolve(projectPath)
  const abs = resolve(root, name)
  if (!abs.startsWith(root + sep) || !abs.toLowerCase().endsWith('.pdf')) {
    throw new Error(`refusing to serve PDF outside the project: ${name}`)
  }
  return abs
}

// --- Read / write ------------------------------------------------------------

export async function readProjectFile(projectPath: string, name: string): Promise<ConfigFile> {
  if (name === FRONTMATTER_NAME) return readFrontMatter(projectPath)
  const abs = safePath(projectPath, name)
  try {
    const content = await fs.readFile(abs, 'utf8')
    return { name, content, exists: true }
  } catch {
    // Not on disk yet — hand back a starter so saving creates something useful.
    return { name, content: starterFor(name), exists: false }
  }
}

export async function saveProjectFile(
  projectPath: string,
  name: string,
  content: string
): Promise<ConfigFile> {
  if (name === FRONTMATTER_NAME) return saveFrontMatter(projectPath, content)
  const abs = safePath(projectPath, name)
  await fs.mkdir(dirname(abs), { recursive: true })
  await fs.writeFile(abs, content, 'utf8')
  return { name, content, exists: true }
}

/**
 * Delete a project file (markdown or PDF) from disk. The front-matter entry is
 * virtual — a slice of manuscript.qmd — and cannot be deleted.
 */
export async function deleteProjectFile(projectPath: string, name: string): Promise<void> {
  if (name === FRONTMATTER_NAME) {
    throw new Error('The manuscript front matter is part of manuscript.qmd and cannot be deleted.')
  }
  const abs = name.toLowerCase().endsWith('.pdf')
    ? projectPdfPath(projectPath, name)
    : safePath(projectPath, name)
  await fs.rm(abs)
}

/**
 * The curated config files (flagged by existence) plus any other root-level
 * `*.md` the user has added, so ad-hoc config files surface here too — and any
 * root-level `*.pdf` (most usefully the rendered manuscript), shown in an
 * embedded viewer rather than the editor.
 */
export async function listConfigFiles(projectPath: string): Promise<ConfigFileInfo[]> {
  const root = resolve(projectPath)
  const out: ConfigFileInfo[] = []
  const known = new Set<string>()

  for (const spec of CONFIG_FILES) {
    known.add(spec.name)
    let exists = false
    try {
      await fs.access(safePath(projectPath, spec.name))
      exists = true
    } catch {
      exists = false
    }
    out.push({ ...spec, exists, curated: true, kind: 'md' })
  }

  // Virtual entry: the manuscript's YAML front matter (a slice of manuscript.qmd).
  out.push({
    name: FRONTMATTER_NAME,
    label: 'Manuscript front matter',
    exists: (await readFrontMatter(projectPath)).exists,
    curated: true,
    kind: 'md'
  })

  // Discover extra root-level markdown files not already covered, then PDFs.
  let entries: string[] = []
  try {
    entries = await fs.readdir(root)
  } catch {
    entries = []
  }
  for (const f of entries.sort()) {
    if (!f.toLowerCase().endsWith('.md')) continue
    if (known.has(f)) continue
    // Auto-managed by the margin-notes panel — not a hand-editable config file.
    if (f === 'MANUSCRIPT_NOTES.md') continue
    out.push({
      name: f,
      label: f.replace(/\.md$/i, ''),
      exists: true,
      curated: false,
      kind: 'md'
    })
  }
  for (const f of entries.sort()) {
    if (!f.toLowerCase().endsWith('.pdf')) continue
    out.push({ name: f, label: f, exists: true, curated: false, kind: 'pdf' })
  }
  return out
}

export function registerProjectFiles(ipcMain: IpcMain): void {
  ipcMain.handle('project:files:list', (_e, projectPath: string) => listConfigFiles(projectPath))
  ipcMain.handle('project:file:get', (_e, args: { projectPath: string; name: string }) =>
    readProjectFile(args.projectPath, args.name)
  )
  ipcMain.handle(
    'project:file:save',
    (_e, args: { projectPath: string; name: string; content: string }) =>
      saveProjectFile(args.projectPath, args.name, args.content)
  )
  ipcMain.handle('project:file:delete', (_e, args: { projectPath: string; name: string }) =>
    deleteProjectFile(args.projectPath, args.name)
  )
}
