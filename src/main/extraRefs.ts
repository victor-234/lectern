/**
 * Per-project "manual references": citations the user wants to cite from a
 * manuscript but does NOT want in the global library registry (policy articles,
 * news pieces, working papers, web pages — things with no PDF / no DOI to
 * enrich). They live in a project-local STRUCTURED store
 * `.lctrn/extra-refs.json`, and lctrn GENERATES `.lctrn/extra.bib` from it —
 * exactly mirroring how the library registry generates the library-wide
 * `references.bib` (see `regenerateMasterBib` in library.ts). Both bib files are
 * wired into each manuscript's `bibliography:` front matter as a YAML list, so
 * `@citekey` resolves a manual reference the same way it resolves a library
 * paper. The generated `extra.bib` is overwrite-owned by lctrn (header says so);
 * the JSON is the source of truth, edited through the Inspector UI.
 */
import { promises as fs } from 'fs'
import { join, resolve, sep } from 'path'
import type { IpcMain } from 'electron'

const CONFIG_DIR = '.lctrn'
const STORE = 'extra-refs.json' // structured source of truth
const BIB = 'extra.bib' // generated; cited by the manuscript
// Relative to a manuscript at the project root:
const LIB_BIB_REL = '../../.lctrn/references.bib'
const EXTRA_BIB_REL = '.lctrn/extra.bib'
// Legacy projects scaffolded before the library-wide bib moved to `.lctrn/`
// cite a project-local `references.bib` — an old GENERATED copy of the registry
// that nothing refreshes, so it goes stale (missing volume/pages added later).
// `references.bib` is a name lctrn owns (see scaffold docs), so a bare list entry
// is safe to migrate onto the live master path.
const LEGACY_LIB_BIB = 'references.bib'
const MANUSCRIPTS = ['manuscript.qmd', 'slides.qmd']

export type ManualRefType = 'article' | 'misc' | 'report' | 'online' | 'book'

export interface ManualRef {
  citekey: string
  type: ManualRefType
  title: string
  authors: string[]
  year: string
  /** journal / publisher / website / institution — depends on `type`. */
  container: string
  url: string
  doi: string
  note: string
}

const TYPES: readonly ManualRefType[] = ['article', 'misc', 'report', 'online', 'book']

// BibTeX entry type + which field `container` maps to, per ref type.
const TYPE_BIBTEX: Record<ManualRefType, string> = {
  article: 'article',
  misc: 'misc',
  report: 'techreport',
  online: 'online',
  book: 'book'
}
const CONTAINER_FIELD: Record<ManualRefType, string> = {
  article: 'journal',
  misc: 'howpublished',
  report: 'institution',
  online: 'organization',
  book: 'publisher'
}

// --- path guard --------------------------------------------------------------

function safe(projectPath: string, ...names: string[]): string {
  const root = resolve(projectPath)
  const abs = resolve(root, ...names)
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error('refusing to access a path outside the project')
  }
  return abs
}

// --- store I/O ---------------------------------------------------------------

function sanitizeKey(s: string): string {
  return s.replace(/[^A-Za-z0-9:_-]/g, '').replace(/^[-:_]+/, '')
}

function normalize(r: Partial<ManualRef>): ManualRef {
  const type = TYPES.includes(r.type as ManualRefType) ? (r.type as ManualRefType) : 'misc'
  return {
    citekey: sanitizeKey(String(r.citekey ?? '')),
    type,
    title: String(r.title ?? '').trim(),
    authors: Array.isArray(r.authors)
      ? r.authors.map((s) => String(s).trim()).filter(Boolean)
      : [],
    year: String(r.year ?? '').trim(),
    container: String(r.container ?? '').trim(),
    url: String(r.url ?? '').trim(),
    doi: String(r.doi ?? '').trim(),
    note: String(r.note ?? '').trim()
  }
}

function uniqueKey(base: string, taken: string[]): string {
  const root = sanitizeKey(base) || 'ref'
  let key = root
  let n = 2
  while (taken.includes(key)) key = `${root}-${n++}`
  return key
}

export async function listManualRefs(projectPath: string): Promise<ManualRef[]> {
  try {
    const j = JSON.parse(await fs.readFile(safe(projectPath, CONFIG_DIR, STORE), 'utf8'))
    return Array.isArray(j.refs) ? j.refs.map(normalize) : []
  } catch {
    return []
  }
}

async function writeStore(projectPath: string, refs: ManualRef[]): Promise<void> {
  await fs.mkdir(safe(projectPath, CONFIG_DIR), { recursive: true })
  await fs.writeFile(
    safe(projectPath, CONFIG_DIR, STORE),
    JSON.stringify({ refs }, null, 2) + '\n'
  )
}

// --- bib generation ----------------------------------------------------------

/** Strip braces so a stray `{`/`}` can't break the entry; trim whitespace. */
function clean(s: string): string {
  return s.replace(/[{}]/g, '').trim()
}

/**
 * Emit one author for the BibTeX `author` field. A `{…}`-wrapped entry is a
 * corporate/literal author: keep it as a single brace-protected unit (BibTeX
 * sees `{{Alliance for Corporate Transparency}}` and cites the whole name,
 * instead of parsing "for" as a particle and citing "Corporate Transparency").
 * Personal names ("Smith, Jane" / "Jane Smith") are cleaned and left for BibTeX
 * to parse as usual.
 */
function bibAuthor(a: string): string {
  const t = a.trim()
  if (t.startsWith('{') && t.endsWith('}') && t.length > 2) return `{${clean(t.slice(1, -1))}}`
  return clean(t)
}

function bibEntry(r: ManualRef): string {
  const fields = [
    r.title && `  title       = {${clean(r.title)}}`,
    r.authors.length && `  author      = {${r.authors.map(bibAuthor).join(' and ')}}`,
    r.container && `  ${CONTAINER_FIELD[r.type].padEnd(11)} = {${clean(r.container)}}`,
    r.year && `  year        = {${clean(r.year)}}`,
    r.url && `  url         = {${r.url.trim()}}`,
    r.doi && `  doi         = {${clean(r.doi)}}`,
    r.note && `  note        = {${clean(r.note)}}`
  ]
    .filter(Boolean)
    .join(',\n')
  return `@${TYPE_BIBTEX[r.type]}{${r.citekey},\n${fields}\n}`
}

/** Materialize `.lctrn/extra.bib` from the store (created even when empty, so the
 *  manuscript can always cite it without pandoc erroring on a missing file). */
export async function regenerateExtraBib(projectPath: string): Promise<void> {
  const refs = await listManualRefs(projectPath)
  const header =
    '% Generated by lctrn from .lctrn/extra-refs.json (manual references). Do not edit by hand.\n\n'
  const body = refs.map(bibEntry).join('\n\n')
  await fs.mkdir(safe(projectPath, CONFIG_DIR), { recursive: true })
  await fs.writeFile(safe(projectPath, CONFIG_DIR, BIB), header + body + (body ? '\n' : ''))
}

// --- front-matter wiring -----------------------------------------------------

function stripQuotes(s: string): string {
  return s.replace(/^['"]|['"]$/g, '').trim()
}

/**
 * Ensure `.lctrn/extra.bib` is listed in a qmd's `bibliography:` front matter,
 * converting a scalar value into a YAML list if needed. Returns the rewritten
 * document, or null when no change is required (already present, or not a qmd
 * with front matter). Idempotent.
 */
export function withExtraBib(qmd: string): string | null {
  if (!qmd.trimStart().startsWith('---')) return null
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
  if (start === -1 || end === -1) return null

  let bibIdx = -1
  for (let i = start + 1; i < end; i++) {
    if (/^bibliography\s*:/.test(lines[i])) {
      bibIdx = i
      break
    }
  }

  let existing: string[] = []
  let removeFrom: number
  let removeTo: number // inclusive
  if (bibIdx === -1) {
    // No bibliography key — insert one right after the opening `---`.
    removeFrom = start + 1
    removeTo = start
  } else {
    const inline = stripQuotes((lines[bibIdx].match(/^bibliography\s*:\s*(.*)$/)?.[1] ?? '').trim())
    removeFrom = bibIdx
    if (inline) {
      existing = [inline]
      removeTo = bibIdx
    } else {
      // List form: gather the following `  - item` lines.
      let j = bibIdx + 1
      while (j < end && /^\s*-\s+/.test(lines[j])) {
        existing.push(stripQuotes(lines[j].replace(/^\s*-\s+/, '').trim()))
        j++
      }
      removeTo = j - 1
    }
  }

  // Canonical bib list: the always-fresh library master first, any custom user
  // entries kept in place, the project's manual-refs bib last. Migrating a legacy
  // bare `references.bib` onto the master path is what keeps a stale-snapshot
  // project tracking the live registry (so volume/pages backfilled later show up).
  const list: string[] = []
  const seen = new Set<string>()
  for (const v of existing) {
    const m = v === LEGACY_LIB_BIB ? LIB_BIB_REL : v
    if (!seen.has(m)) {
      seen.add(m)
      list.push(m)
    }
  }
  if (!seen.has(LIB_BIB_REL)) list.unshift(LIB_BIB_REL)
  if (!seen.has(EXTRA_BIB_REL)) list.push(EXTRA_BIB_REL)

  // No-op when the front matter already lists exactly the canonical bibs.
  if (bibIdx !== -1 && list.length === existing.length && list.every((v, i) => v === existing[i]))
    return null

  const block = ['bibliography:', ...list.map((v) => `  - ${v}`)]
  const next = [...lines.slice(0, removeFrom), ...block, ...lines.slice(removeTo + 1)]
  return next.join('\n')
}

async function ensureBibInFrontMatter(projectPath: string): Promise<void> {
  for (const name of MANUSCRIPTS) {
    const p = safe(projectPath, name)
    let content: string
    try {
      content = await fs.readFile(p, 'utf8')
    } catch {
      continue
    }
    const updated = withExtraBib(content)
    if (updated && updated !== content) await fs.writeFile(p, updated, 'utf8')
  }
}

/**
 * Make sure the project's `extra.bib` exists and is wired into both manuscripts.
 * Safe to call on every project open (idempotent). Hooked into `ensureQuartoDocs`.
 */
export async function ensureExtraBib(projectPath: string): Promise<void> {
  await regenerateExtraBib(projectPath)
  await ensureBibInFrontMatter(projectPath)
}

// --- mutations ---------------------------------------------------------------

export async function addManualRef(projectPath: string, ref: Partial<ManualRef>): Promise<ManualRef[]> {
  const refs = await listManualRefs(projectPath)
  const r = normalize(ref)
  r.citekey = uniqueKey(r.citekey || 'ref', refs.map((x) => x.citekey))
  refs.push(r)
  await writeStore(projectPath, refs)
  await ensureExtraBib(projectPath)
  return refs
}

export async function updateManualRef(
  projectPath: string,
  citekey: string,
  ref: Partial<ManualRef>
): Promise<ManualRef[]> {
  const refs = await listManualRefs(projectPath)
  const idx = refs.findIndex((r) => r.citekey === citekey)
  if (idx === -1) return refs
  const r = normalize(ref)
  // Keep the key stable unless the user changed it; if they did (or cleared it),
  // re-uniquify against the other entries so we never collide.
  r.citekey =
    r.citekey === citekey
      ? citekey
      : uniqueKey(r.citekey || 'ref', refs.filter((_, i) => i !== idx).map((x) => x.citekey))
  refs[idx] = r
  await writeStore(projectPath, refs)
  await ensureExtraBib(projectPath)
  return refs
}

export async function deleteManualRef(projectPath: string, citekey: string): Promise<ManualRef[]> {
  const refs = (await listManualRefs(projectPath)).filter((r) => r.citekey !== citekey)
  await writeStore(projectPath, refs)
  await regenerateExtraBib(projectPath)
  return refs
}

// --- IPC ---------------------------------------------------------------------

export function registerExtraRefs(ipcMain: IpcMain): void {
  ipcMain.handle('project:extraRefs:list', (_e, projectPath: string) => listManualRefs(projectPath))
  ipcMain.handle('project:extraRefs:add', (_e, args: { projectPath: string; ref: Partial<ManualRef> }) =>
    addManualRef(args.projectPath, args.ref)
  )
  ipcMain.handle(
    'project:extraRefs:update',
    (_e, args: { projectPath: string; citekey: string; ref: Partial<ManualRef> }) =>
      updateManualRef(args.projectPath, args.citekey, args.ref)
  )
  ipcMain.handle(
    'project:extraRefs:delete',
    (_e, args: { projectPath: string; citekey: string }) =>
      deleteManualRef(args.projectPath, args.citekey)
  )
}
