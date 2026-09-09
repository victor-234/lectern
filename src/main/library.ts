import { platform } from './platform'
import { promises as fs } from 'fs'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { basename, extname, isAbsolute, join, relative } from 'path'
import { scaffoldProject, type ProjectMeta } from './scaffold'
import { ensureQuartoDocs } from './quarto'
import { extractMetadata, type ExtractedMeta } from './metadata'
import { buildHouseFilename, extensionOf, lastName } from './houseName'
import { paperInteractedAt } from './paperNotes'
import { renameCitekeyEverywhere, type CitekeyRewriteResult } from './citekeys'
import { ensureWritingRules } from './writingRules'

/**
 * All paper PDFs live in this folder inside the library root. Deliberately NOT
 * hidden: it has to be visible in Dropbox / the iOS Files app so PDFs can be
 * opened and annotated from an iPad.
 */
const SOURCES_DIR = 'sources'
/** Pre-rename PDF store (was hidden). Migrated to `sources/` on first load. */
const LEGACY_SOURCES_DIR = '.sources'

/** lctrn's own config/registry lives here, kept out of the user-facing drop area. */
const CONFIG_DIR = '.lctrn'
/** Pre-rename config dir (was "Lectern"). Migrated to `.lctrn` on first load. */
const LEGACY_CONFIG_DIR = '.lectern'

export function sourcesDir(root: string): string {
  return join(root, SOURCES_DIR)
}

// --- App settings (which library root the user chose) ------------------------

interface AppSettings {
  libraryRoot?: string
  /** Last project the user opened, restored as the default on the next launch. */
  lastProject?: string
}

function settingsFile(): string {
  return join(platform.userDataDir(), 'lctrn-settings.json')
}

/**
 * One-time migration of the pre-rename settings file ("Lectern"→"lctrn"). The
 * rename also moves the Electron `userData` directory itself (it's keyed off the
 * app name), so the old settings — which hold the user's configured library root
 * — can live in a *different* dir than the new one. Copy the first legacy file we
 * find into the new location. Runs once per process; a no-op once migrated.
 */
let settingsMigrated = false
async function migrateSettingsFile(): Promise<void> {
  if (settingsMigrated) return
  settingsMigrated = true
  try {
    await fs.access(settingsFile())
    return // already on the new name/location
  } catch {
    /* fall through and look for a legacy file */
  }
  const appData = platform.appDataDir()
  // Frozen history, not current naming: these are paths where older builds
  // actually wrote the settings file, so they must keep the names those builds
  // used even after the project is renamed. Renaming a string here doesn't
  // rename anything on disk — it just loses someone's library setting.
  const candidates = [
    join(platform.userDataDir(), 'lectern-settings.json'), // same userData, old filename
    join(appData, 'lectern-2', 'lectern-settings.json'), // dev, when the package was named lectern-2
    join(appData, 'Lectern', 'lectern-settings.json') // packaged (old productName)
  ]
  for (const c of candidates) {
    try {
      const data = await fs.readFile(c, 'utf8')
      await fs.mkdir(platform.userDataDir(), { recursive: true })
      await fs.writeFile(settingsFile(), data)
      return
    } catch {
      /* try the next candidate */
    }
  }
}

async function readSettings(): Promise<AppSettings> {
  await migrateSettingsFile()
  try {
    return JSON.parse(await fs.readFile(settingsFile(), 'utf8'))
  } catch {
    return {}
  }
}

async function writeSettings(s: AppSettings): Promise<void> {
  await fs.mkdir(platform.userDataDir(), { recursive: true })
  await fs.writeFile(settingsFile(), JSON.stringify(s, null, 2) + '\n')
}

export function defaultLibraryRoot(): string {
  return join(homedir(), 'lctrn')
}

// Per-root in-flight migration, so the many handlers that call getLibraryRoot()
// at startup share one migration pass instead of racing each other.
const configDirMigrations = new Map<string, Promise<void>>()

export async function getLibraryRoot(): Promise<string | null> {
  const root = (await readSettings()).libraryRoot ?? null
  if (root) {
    if (!configDirMigrations.has(root)) {
      configDirMigrations.set(root, migrateLibraryLayout(root).catch(() => {}))
    }
    await configDirMigrations.get(root)
  }
  return root
}

/**
 * Bring a library's on-disk layout up to date, in dependency order. Memoized per
 * root inside getLibraryRoot(), so it runs once per launch — which is also why
 * the library-wide files every project expects get seeded here rather than in
 * ensureLibrary(), which only runs when a library is chosen or a project created.
 */
async function migrateLibraryLayout(root: string): Promise<void> {
  await migrateConfigDir(root)
  await migrateSourcesDir(root)
  // Library-wide AI writing rules, shared by every project (see writingRules.ts).
  await ensureWritingRules(root)
}

/**
 * Migrate the PDF store from the hidden `.sources/` to the visible `sources/`
 * (so it shows up in Dropbox / the iOS Files app for iPad annotation). Renames
 * the dir, then rewrites the `.sources/<file>` paths recorded in the registry —
 * without that rewrite, every paper's PDF would fail to resolve. Idempotent.
 */
async function migrateSourcesDir(root: string): Promise<void> {
  await renameIfLegacy(join(root, LEGACY_SOURCES_DIR), join(root, SOURCES_DIR))
  const legacyPrefix = LEGACY_SOURCES_DIR + '/'
  try {
    const reg = await readRegistry(root)
    let changed = false
    for (const p of reg.papers) {
      if (typeof p.path === 'string' && p.path.startsWith(legacyPrefix)) {
        p.path = SOURCES_DIR + '/' + p.path.slice(legacyPrefix.length)
        changed = true
      }
    }
    if (changed) await writeRegistry(root, reg)
  } catch {
    /* registry not readable yet — nothing to rewrite */
  }
}

/**
 * Migrate a library from the pre-rename `.lectern/` config dirs to `.lctrn/`.
 * Renames the root config dir and each project's, then rewrites the baked-in
 * `.lectern` paths (the `bibliography:` front matter in every manuscript, and
 * `.claude/settings.json`'s `additionalDirectories`). Idempotent: each
 * step short-circuits once the target already exists. Must run before anything
 * reads `.lctrn`, so it's awaited inside getLibraryRoot()/ensureLibrary().
 */
async function migrateConfigDir(root: string): Promise<void> {
  await renameIfLegacy(join(root, LEGACY_CONFIG_DIR), join(root, CONFIG_DIR))
  let projects: string[] = []
  try {
    projects = await fs.readdir(join(root, 'projects'))
  } catch {
    return
  }
  for (const name of projects) {
    const pp = join(root, 'projects', name)
    await renameIfLegacy(join(pp, LEGACY_CONFIG_DIR), join(pp, CONFIG_DIR))
    await rewriteLegacyConfigPaths(pp)
  }
}

/** Rename `oldDir`→`newDir` unless the new one already exists or the old is absent. */
async function renameIfLegacy(oldDir: string, newDir: string): Promise<void> {
  try {
    await fs.access(newDir)
    return // already migrated
  } catch {
    /* new dir absent — proceed */
  }
  try {
    await fs.access(oldDir)
  } catch {
    return // nothing legacy to move
  }
  await fs.rename(oldDir, newDir).catch(() => {
    /* best-effort: leave the legacy dir in place if the move fails */
  })
}

/** Rewrite `.lectern` → `.lctrn` in the project files that bake the path in. */
async function rewriteLegacyConfigPaths(projectPath: string): Promise<void> {
  const files = ['manuscript.qmd', join('.claude', 'settings.json')]
  for (const rel of files) {
    const abs = join(projectPath, rel)
    try {
      const c = await fs.readFile(abs, 'utf8')
      if (c.includes(LEGACY_CONFIG_DIR)) {
        await fs.writeFile(abs, c.split(LEGACY_CONFIG_DIR).join(CONFIG_DIR))
      }
    } catch {
      /* file absent — skip */
    }
  }
}

export async function getLastProject(): Promise<string | null> {
  return (await readSettings()).lastProject ?? null
}

export async function setLastProject(path: string | null): Promise<void> {
  const s = await readSettings()
  if (path) s.lastProject = path
  else delete s.lastProject
  await writeSettings(s)
}

export async function setLibraryRoot(root: string): Promise<string> {
  await ensureLibrary(root)
  const prev = await readSettings()
  // `lastProject` is an absolute path INTO the library we're leaving, so it means
  // nothing once the root moves. Keep it only when the root didn't actually change.
  const lastProject = prev.libraryRoot === root ? prev.lastProject : undefined
  await writeSettings({ ...prev, libraryRoot: root, lastProject })
  // The master bib records each PDF's ABSOLUTE path in its `file = {…}` field,
  // which stops being true the moment the library arrives from somewhere else —
  // a Dropbox folder opened on a second machine with a different home directory,
  // or the example library in this repo after someone clones it. Pointing
  // Lectern at a folder is exactly the moment to make those paths true again,
  // and regenerating is cheap and idempotent.
  await regenerateMasterBib(root)
  return root
}

// --- Library registry (global papers, referenced by path, never copied) ------

export interface LibraryPaper {
  id: string
  citekey: string
  title?: string
  authors: string[]
  year?: string
  doi?: string
  journal?: string
  /** Short journal label from the extractor (e.g. Crossref's short-container-title). */
  journalAbbrev?: string
  abstract?: string
  /** Journal volume, e.g. "42". */
  volume?: string
  /** Journal issue number, e.g. "3" (emitted as BibTeX `number`). */
  issue?: string
  /** Page range, e.g. "123-145". */
  pages?: string
  /** Landing page for the paper (emitted as BibTeX `url`). Carries the locator
   *  for working papers and anything else that has no DOI. */
  url?: string
  /** Which extractor filled the metadata; absent means enrichment hasn't run yet. */
  metaSource?: ExtractedMeta['source']
  /** Tags (`.lctrn/tags.json`) this paper is wired into. */
  tagIds?: string[]
  /** Epoch ms when the paper was registered; drives the default "last added" sort. */
  addedAt?: number
  /**
   * Epoch ms when the paper was put on the reading list; absent means it isn't
   * queued. The stamp (rather than a bare flag) keeps the list in the order the
   * papers were added to it.
   */
  readingAt?: number
  path: string // relative to the library root when inside it, else absolute
}

export interface ResolvedPaper extends LibraryPaper {
  absPath: string
  exists: boolean
  /**
   * Epoch ms of the last time the user interacted with this paper (currently the
   * reading-note mtime; annotations fold in later). Drives the "Recently
   * Interacted" view. Undefined when the paper has never been touched.
   */
  interactedAt?: number
}

// --- Tags & groups -----------------------------------------------------------
// Tags are paper groupings (user-editable). Groups are standalone, named buckets
// that organize tags in the sidebar — a group is its own entity, NOT a tag, and a
// tag belongs to at most one group via `groupId`.

const TAGS_FILE = 'tags.json'
/** Pre-rename filename; read as a fallback and migrated to `tags.json` on load. */
const LEGACY_TAGS_FILE = 'themes.json'

export interface Tag {
  id: string
  name: string
  color: string
  description: string
  sortOrder: number
  /** Id of the Group this tag sits under (undefined = ungrouped). */
  groupId?: string
}

/** A standalone sidebar bucket that tags can be filed under. */
export interface Group {
  id: string
  name: string
  sortOrder: number
}

interface TagStore {
  tags: Tag[]
  groups: Group[]
}

function normalizeTag(t: Tag & { groupIds?: unknown }): Tag {
  // Drop the legacy many-to-many `groupIds` (tag-on-tag grouping); the model is
  // now a single `groupId` pointing at a standalone Group.
  const { groupIds: _legacy, ...rest } = t
  return { ...rest, groupId: typeof t.groupId === 'string' ? t.groupId : undefined }
}

function normalizeGroup(g: Group): Group {
  return { id: String(g.id), name: String(g.name ?? ''), sortOrder: Number(g.sortOrder ?? 0) }
}

async function readStore(root: string): Promise<TagStore> {
  // Read the current file, falling back to the pre-rename one. Either may carry a
  // `tags` or legacy `themes` array depending on when it was last written.
  for (const file of [TAGS_FILE, LEGACY_TAGS_FILE]) {
    try {
      const j = JSON.parse(await fs.readFile(join(root, CONFIG_DIR, file), 'utf8'))
      const arr = Array.isArray(j.tags) ? j.tags : Array.isArray(j.themes) ? j.themes : null
      if (arr) {
        return {
          tags: arr.map(normalizeTag),
          groups: (Array.isArray(j.groups) ? j.groups : []).map(normalizeGroup)
        }
      }
    } catch {
      // try the next candidate
    }
  }
  return { tags: [], groups: [] }
}

async function writeStore(root: string, store: TagStore): Promise<void> {
  await fs.mkdir(join(root, CONFIG_DIR), { recursive: true })
  await fs.writeFile(
    join(root, CONFIG_DIR, TAGS_FILE),
    JSON.stringify({ version: 2, tags: store.tags, groups: store.groups }, null, 2) + '\n'
  )
}

export async function listTags(root: string): Promise<Tag[]> {
  return (await readStore(root)).tags
}

export async function listGroups(root: string): Promise<Group[]> {
  return (await readStore(root)).groups
}

/** File a tag under a group (pass null to ungroup). */
export async function setTagGroup(
  root: string,
  tagId: string,
  groupId: string | null
): Promise<void> {
  const store = await readStore(root)
  const t = store.tags.find((x) => x.id === tagId)
  if (!t) return
  t.groupId = groupId && store.groups.some((g) => g.id === groupId) ? groupId : undefined
  await writeStore(root, store)
}

/** Create a new standalone group, appended after any existing ones. */
export async function createGroup(root: string, name: string): Promise<Group> {
  const store = await readStore(root)
  const sortOrder = store.groups.reduce((m, g) => Math.max(m, g.sortOrder), -1) + 1
  const group: Group = { id: randomUUID(), name: name.trim() || 'Group', sortOrder }
  store.groups.push(group)
  await writeStore(root, store)
  return group
}

export async function renameGroup(root: string, groupId: string, name: string): Promise<void> {
  const store = await readStore(root)
  const g = store.groups.find((x) => x.id === groupId)
  if (!g) return
  g.name = name.trim() || g.name
  await writeStore(root, store)
}

/** Delete a group and ungroup any tags that pointed at it. */
export async function deleteGroup(root: string, groupId: string): Promise<void> {
  const store = await readStore(root)
  store.groups = store.groups.filter((g) => g.id !== groupId)
  for (const t of store.tags) if (t.groupId === groupId) t.groupId = undefined
  await writeStore(root, store)
}

/** Palette new tags cycle through (hex, matching the seeded tags). */
const TAG_COLORS = ['#6366f1', '#10b981', '#ef4444', '#f59e0b', '#06b6d4', '#a855f7', '#84cc16']

/** Create a new tag, appended after any existing ones. */
export async function createTag(root: string, name: string): Promise<Tag | null> {
  const trimmed = name.trim()
  if (!trimmed) return null
  const store = await readStore(root)
  const sortOrder = store.tags.reduce((m, t) => Math.max(m, t.sortOrder), 0) + 1
  const tag: Tag = {
    id: randomUUID(),
    name: trimmed,
    color: TAG_COLORS[store.tags.length % TAG_COLORS.length],
    description: '',
    sortOrder
  }
  store.tags.push(tag)
  await writeStore(root, store)
  return tag
}

export async function renameTag(root: string, tagId: string, name: string): Promise<void> {
  const store = await readStore(root)
  const t = store.tags.find((x) => x.id === tagId)
  if (!t) return
  t.name = name.trim() || t.name
  await writeStore(root, store)
}

/**
 * Persist a new tag ordering and group placement in one write. `entries` lists
 * tags in their desired global order; each tag's `sortOrder` becomes its index
 * and its `groupId` is set from the entry (a `null`/unknown group ungroups it).
 * Tags missing from the list keep their relative order — and their group —
 * appended after the listed ones.
 */
export async function reorderTags(
  root: string,
  entries: Array<{ id: string; groupId: string | null }>
): Promise<void> {
  const store = await readStore(root)
  const valid = new Set(store.groups.map((g) => g.id))
  const placement = new Map(entries.map((e, i) => [e.id, { rank: i, groupId: e.groupId }]))
  const fallback = entries.length
  // Stable sort: listed tags by their new rank, the rest after in existing order.
  store.tags = [...store.tags]
    .map((t, i) => ({ t, rank: placement.get(t.id)?.rank ?? fallback + i }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ t }, i) => {
      const p = placement.get(t.id)
      const groupId = p ? (p.groupId && valid.has(p.groupId) ? p.groupId : undefined) : t.groupId
      return { ...t, sortOrder: i, groupId }
    })
  await writeStore(root, store)
}

/** Add a tag to each of the given papers (idempotent; leaves other tags intact). */
export async function addTagToPapers(
  root: string,
  tagId: string,
  paperIds: string[]
): Promise<void> {
  const ids = new Set(paperIds)
  const reg = await readRegistry(root)
  let changed = false
  for (const p of reg.papers) {
    if (!ids.has(p.id)) continue
    const cur = p.tagIds ?? []
    if (cur.includes(tagId)) continue
    p.tagIds = [...cur, tagId]
    changed = true
  }
  if (changed) await writeRegistry(root, reg)
}

/**
 * Put papers on the reading list (`on`) or take them off it. Idempotent: adding
 * a paper that's already queued keeps its original stamp, so re-dropping it
 * doesn't jump it to the front of the queue.
 */
export async function setPapersReading(
  root: string,
  paperIds: string[],
  on: boolean
): Promise<void> {
  const ids = new Set(paperIds)
  const reg = await readRegistry(root)
  let changed = false
  const now = Date.now()
  for (const p of reg.papers) {
    if (!ids.has(p.id)) continue
    if (on) {
      if (p.readingAt) continue
      p.readingAt = now
    } else {
      if (!p.readingAt) continue
      delete p.readingAt
    }
    changed = true
  }
  if (changed) await writeRegistry(root, reg)
}

/** Delete a tag definition and strip it from every paper that carried it. */
export async function deleteTag(root: string, tagId: string): Promise<void> {
  const store = await readStore(root)
  store.tags = store.tags.filter((t) => t.id !== tagId)
  await writeStore(root, store)

  const reg = await readRegistry(root)
  let changed = false
  for (const p of reg.papers) {
    if (!p.tagIds?.includes(tagId)) continue
    p.tagIds = p.tagIds.filter((id) => id !== tagId)
    if (!p.tagIds.length) delete p.tagIds
    changed = true
  }
  if (changed) await writeRegistry(root, reg)
}

/** Loose journal-name key so map lookups survive entity/punctuation drift. */
function journalKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '')
}

/** Journal name (normalized) -> the user's preferred abbreviation. */
async function readJournalAbbrevs(root: string): Promise<Record<string, string>> {
  try {
    const j = JSON.parse(await fs.readFile(join(root, CONFIG_DIR, 'journals.json'), 'utf8'))
    const out: Record<string, string> = {}
    for (const [name, abbrev] of Object.entries(j.abbreviations ?? {})) {
      out[journalKey(name)] = abbrev as string
    }
    return out
  } catch {
    return {}
  }
}

interface Registry {
  version: number
  papers: LibraryPaper[]
}

function registryPath(root: string): string {
  return join(root, CONFIG_DIR, 'library.json')
}

/** Where the registry used to live (library root); migrated into `.lctrn/` on first load. */
function legacyRegistryPath(root: string): string {
  return join(root, 'library.json')
}

export async function ensureLibrary(root: string): Promise<void> {
  // Rename any pre-existing `.lectern/` config + `.sources/` PDF dirs BEFORE we
  // mkdir the new names below — otherwise the fresh empty dirs would orphan the
  // legacy ones' contents.
  await migrateLibraryLayout(root)
  await fs.mkdir(join(root, SOURCES_DIR), { recursive: true })
  await fs.mkdir(join(root, CONFIG_DIR), { recursive: true })
  await fs.mkdir(join(root, 'projects'), { recursive: true })
  // Migrate a pre-existing root-level library.json into .lctrn/ (one time).
  try {
    await fs.access(registryPath(root))
  } catch {
    try {
      const legacy = await fs.readFile(legacyRegistryPath(root), 'utf8')
      await fs.writeFile(registryPath(root), legacy)
      await fs.unlink(legacyRegistryPath(root)).catch(() => {})
    } catch {
      await fs.writeFile(
        registryPath(root),
        JSON.stringify({ version: 1, papers: [] }, null, 2) + '\n'
      )
    }
  }
  // One-time rename of the legacy themes naming (themes.json / paper.themeIds).
  await migrateThemesToTags(root)
  // Keep the library-wide bibliography materialized (also regenerates it if a
  // schema change altered how entries are emitted since it was last written).
  await regenerateMasterBib(root)
}

/**
 * Migrate the pre-rename "themes" naming to "tags": move `.lctrn/themes.json`
 * to `tags.json`, and rename each registry paper's `themeIds` field to `tagIds`.
 * A no-op once migrated, so it's safe to call on every load.
 */
async function migrateThemesToTags(root: string): Promise<void> {
  const tagsPath = join(root, CONFIG_DIR, TAGS_FILE)
  const legacyPath = join(root, CONFIG_DIR, LEGACY_TAGS_FILE)
  try {
    await fs.access(tagsPath)
  } catch {
    try {
      const j = JSON.parse(await fs.readFile(legacyPath, 'utf8'))
      const arr = Array.isArray(j.themes) ? j.themes : Array.isArray(j.tags) ? j.tags : []
      await writeStore(root, { tags: arr.map(normalizeTag), groups: [] })
      await fs.unlink(legacyPath).catch(() => {})
    } catch {
      // nothing to migrate
    }
  }
  // paper.themeIds -> paper.tagIds
  try {
    const reg = await readRegistry(root)
    let changed = false
    for (const p of reg.papers as Array<LibraryPaper & { themeIds?: string[] }>) {
      if (p.themeIds) {
        if (!p.tagIds) p.tagIds = p.themeIds
        delete p.themeIds
        changed = true
      }
    }
    if (changed) await writeRegistry(root, reg)
  } catch {
    // registry not readable yet — nothing to migrate
  }
}

async function readRegistry(root: string): Promise<Registry> {
  try {
    return JSON.parse(await fs.readFile(registryPath(root), 'utf8'))
  } catch {
    // Not migrated yet — read the legacy root-level file if present.
    try {
      return JSON.parse(await fs.readFile(legacyRegistryPath(root), 'utf8'))
    } catch {
      return { version: 1, papers: [] }
    }
  }
}

async function writeRegistry(root: string, reg: Registry): Promise<void> {
  await fs.mkdir(join(root, CONFIG_DIR), { recursive: true })
  await fs.writeFile(registryPath(root), JSON.stringify(reg, null, 2) + '\n')
}

export function resolvePaperPath(root: string, paper: LibraryPaper): string {
  return isAbsolute(paper.path) ? paper.path : join(root, paper.path)
}

function isInsideSources(root: string, absPath: string): boolean {
  const rel = relative(sourcesDir(root), absPath)
  return !rel.startsWith('..') && !isAbsolute(rel)
}

/** Pick a non-colliding filename within `sources/`. */
async function uniqueFilename(dir: string, filename: string): Promise<string> {
  const ext = extname(filename)
  const base = basename(filename, ext)
  let name = filename
  let n = 2
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await fs.access(join(dir, name))
      name = `${base}-${n++}${ext}`
    } catch {
      return name
    }
  }
}

/** Copy a PDF into `sources/` and return its library-relative path. */
async function importIntoSources(root: string, src: string): Promise<string> {
  const dir = sourcesDir(root)
  await fs.mkdir(dir, { recursive: true })
  // If it's already inside .sources (e.g. pasted in manually), register in place.
  if (isInsideSources(root, src)) {
    return join(SOURCES_DIR, relative(dir, src))
  }
  const name = await uniqueFilename(dir, basename(src))
  await fs.copyFile(src, join(dir, name))
  return join(SOURCES_DIR, name)
}

async function resolve(
  root: string,
  p: LibraryPaper,
  abbrevs: Record<string, string> = {}
): Promise<ResolvedPaper> {
  const absPath = resolvePaperPath(root, p)
  let exists = false
  try {
    await fs.access(absPath)
    exists = true
  } catch {
    // file moved or deleted — surfaced in UI
  }
  // The user's journal map wins over whatever the extractor reported.
  const journalAbbrev = (p.journal && abbrevs[journalKey(p.journal)]) || p.journalAbbrev
  // Tolerate registries written before the themeIds -> tagIds rename.
  const tagIds = p.tagIds ?? (p as { themeIds?: string[] }).themeIds
  const interactedAt = await paperInteractedAt(root, p)
  return { ...p, tagIds, absPath, exists, journalAbbrev, interactedAt }
}

export async function listLibraryPapers(root: string): Promise<ResolvedPaper[]> {
  const [reg, abbrevs] = await Promise.all([readRegistry(root), readJournalAbbrevs(root)])
  return Promise.all(reg.papers.map((p) => resolve(root, p, abbrevs)))
}

/**
 * Raw bytes of a registered paper's PDF, for the in-app reader. Resolves by id
 * (never a renderer-supplied path) so a compromised renderer can't read
 * arbitrary files. Returns null if the id is unknown or the file is gone.
 */
export async function readPaperPdf(root: string, id: string): Promise<Uint8Array | null> {
  const reg = await readRegistry(root)
  const p = reg.papers.find((x) => x.id === id)
  if (!p) return null
  try {
    return await fs.readFile(resolvePaperPath(root, p))
  } catch {
    return null
  }
}

/**
 * Absolute on-disk path of a registered paper's PDF, looked up by id (never a
 * renderer-supplied path). Returns null if the id is unknown. Used by the
 * `lctrn-pdf://` protocol that streams PDFs to the in-app reader.
 */
export async function paperAbsPath(root: string, id: string): Promise<string | null> {
  const reg = await readRegistry(root)
  const p = reg.papers.find((x) => x.id === id)
  return p ? resolvePaperPath(root, p) : null
}

/** A registry paper looked up by id (never a renderer-supplied path), or null. */
export async function getLibraryPaper(root: string, id: string): Promise<LibraryPaper | null> {
  const reg = await readRegistry(root)
  return reg.papers.find((x) => x.id === id) ?? null
}

export async function addLibraryPapers(root: string, filePaths: string[]): Promise<ResolvedPaper[]> {
  const reg = await readRegistry(root)
  const added: LibraryPaper[] = []
  for (const fp of filePaths) {
    const rel = await importIntoSources(root, fp)
    // Skip if this exact stored file is already registered.
    if (reg.papers.some((p) => p.path === rel)) continue
    const name = basename(fp).replace(/\.pdf$/i, '')
    const id = uniqueId(reg, slug(name))
    const paper: LibraryPaper = {
      id,
      citekey: id,
      title: titleFromName(name),
      authors: [],
      year: yearFromName(name),
      addedAt: Date.now(),
      path: rel
    }
    reg.papers.push(paper)
    added.push(paper)
  }
  await writeRegistry(root, reg)
  if (added.length) await regenerateMasterBib(root)
  return Promise.all(added.map((p) => resolve(root, p)))
}

/** User-editable subset of a paper's metadata. Empty strings clear a field. */
export interface PaperPatch {
  citekey?: string
  title?: string
  authors?: string[]
  year?: string
  doi?: string
  journal?: string
  journalAbbrev?: string
  abstract?: string
  volume?: string
  issue?: string
  pages?: string
  url?: string
  tagIds?: string[]
}

/**
 * Apply user edits to a registry paper. The journal abbreviation is
 * journal-level, not paper-level: when the paper has a journal name the edit
 * goes into `.lctrn/journals.json` (so every paper of that journal follows);
 * only journal-less papers keep it on the entry itself. Regenerates the
 * library-wide references.bib, since the bib is materialized from this metadata.
 *
 * When the citekey changes, every `@oldkey` already cited in a manuscript or note
 * is rewritten to the new key (see `renameCitekeyEverywhere`); the returned
 * summary reports how much prose was touched so the UI can confirm it.
 */
export interface UpdatePaperResult extends CitekeyRewriteResult {
  citekey?: { from: string; to: string }
}

export async function updateLibraryPaper(
  root: string,
  id: string,
  patch: PaperPatch
): Promise<UpdatePaperResult> {
  const reg = await readRegistry(root)
  const p = reg.papers.find((x) => x.id === id)
  if (!p) return { files: 0, occurrences: 0 }
  const oldKey = p.citekey

  const clean = (v?: string): string | undefined => v?.trim() || undefined
  if (patch.title !== undefined) p.title = clean(patch.title)
  if (patch.authors !== undefined) p.authors = patch.authors.map((a) => a.trim()).filter(Boolean)
  if (patch.year !== undefined) p.year = clean(patch.year)?.match(/\d{4}/)?.[0]
  if (patch.doi !== undefined) p.doi = clean(patch.doi)
  if (patch.journal !== undefined) p.journal = clean(patch.journal)
  if (patch.abstract !== undefined) p.abstract = clean(patch.abstract)
  if (patch.volume !== undefined) p.volume = clean(patch.volume)
  if (patch.issue !== undefined) p.issue = clean(patch.issue)
  if (patch.pages !== undefined) p.pages = clean(patch.pages)
  if (patch.url !== undefined) p.url = clean(patch.url)
  if (patch.tagIds !== undefined) {
    if (patch.tagIds.length) p.tagIds = patch.tagIds
    else delete p.tagIds
  }
  // Someone who has told us the title, the authors AND the year has identified
  // the paper, so stop trying to work it out: stamp the entry as enriched.
  // Without this, `enrichLibrary` still sees an unstamped paper later and runs
  // the whole extraction ladder over it — up to spawning the `claude` CLI — to
  // re-derive metadata a human already supplied. Only ever stamps a paper that
  // has never been enriched, so a real crossref/embedded provenance is kept.
  if (!p.metaSource && p.title && p.authors?.length && p.year) {
    p.metaSource = 'imported'
  }
  if (patch.citekey !== undefined) {
    const base = clean(patch.citekey)?.replace(/^@/, '').replace(/\s+/g, '')
    if (base && base !== p.citekey) p.citekey = uniqueCitekey(reg, p, base)
  }
  if (patch.journalAbbrev !== undefined) {
    const abbrev = clean(patch.journalAbbrev)
    if (p.journal) {
      await setJournalAbbrev(root, p.journal, abbrev)
      delete p.journalAbbrev // the journal map is the source of truth now
    } else if (abbrev) {
      p.journalAbbrev = abbrev
    } else {
      delete p.journalAbbrev
    }
  }

  await writeRegistry(root, reg)

  // The bib entries are materialized from this metadata — refresh the one
  // library-wide bib that every project cites.
  await regenerateMasterBib(root)

  // Follow a citekey rename through to everything that cites the old key.
  if (p.citekey !== oldKey) {
    const rewrite = await renameCitekeyEverywhere(root, oldKey, p.citekey)
    return { ...rewrite, citekey: { from: oldKey, to: p.citekey } }
  }
  return { files: 0, occurrences: 0 }
}

/** Set (or clear, with undefined) the user's abbreviation for a journal name. */
async function setJournalAbbrev(
  root: string,
  journalName: string,
  abbrev: string | undefined
): Promise<void> {
  const file = join(root, CONFIG_DIR, 'journals.json')
  let j: { version: number; abbreviations: Record<string, string> } = {
    version: 1,
    abbreviations: {}
  }
  try {
    j = JSON.parse(await fs.readFile(file, 'utf8'))
    j.abbreviations ??= {}
  } catch {
    // first abbreviation — start a fresh map
  }
  // Drop any existing entry that is the same journal modulo punctuation drift.
  const k = journalKey(journalName)
  for (const existing of Object.keys(j.abbreviations)) {
    if (journalKey(existing) === k) delete j.abbreviations[existing]
  }
  if (abbrev) j.abbreviations[journalName] = abbrev
  await fs.writeFile(file, JSON.stringify(j, null, 2) + '\n')
}

/** Outcome of a house-style rename; `reason` explains a no-op. */
export interface RenameResult {
  renamed: boolean
  reason?: 'sparse' | 'unchanged' | 'external' | 'missing'
  from?: string
  to?: string
}

/** One paper whose on-disk filename would change under the house style. */
export interface RenamePreviewItem {
  id: string
  title: string
  currentName: string
  proposedName: string
}

/**
 * List every `sources/` paper whose metadata would produce a different
 * filename than it currently has — the data behind the bulk-rename dialog.
 * Mirrors `renamePaperToHouseStyle`'s naming exactly (journal map wins), and
 * omits papers already in house style, too sparse to name, or missing on disk.
 */
export async function previewHouseRenames(root: string): Promise<RenamePreviewItem[]> {
  const [reg, abbrevs] = await Promise.all([readRegistry(root), readJournalAbbrevs(root)])
  const out: RenamePreviewItem[] = []
  for (const p of reg.papers) {
    const abs = resolvePaperPath(root, p)
    if (!isInsideSources(root, abs)) continue
    try {
      await fs.access(abs)
    } catch {
      continue
    }
    const journal = (p.journal && abbrevs[journalKey(p.journal)]) || p.journalAbbrev || p.journal
    const currentName = basename(abs)
    const proposedName = buildHouseFilename(
      { title: p.title, authors: p.authors, year: p.year, journal },
      extensionOf(abs)
    )
    if (!proposedName || proposedName === currentName) continue
    out.push({ id: p.id, title: p.title || p.citekey, currentName, proposedName })
  }
  return out
}

/**
 * Rename a paper's PDF on disk to the house style ("Wagner et al. 2024 JFE,
 * Corp governance.pdf"), derived from its metadata. The library folder is the
 * Dropbox-synced folder, so renaming the file here is the v1 "Rename Dropbox"
 * action. Only files lctrn owns inside `sources/` are touched; externally-pathed
 * entries are left alone. The registry path is updated in the same pass, so the
 * folder watcher reconciles to a no-op instead of dropping the entry. Skips
 * (returns renamed:false) when metadata is too sparse or the name is unchanged.
 */
export async function renamePaperToHouseStyle(root: string, id: string): Promise<RenameResult> {
  const [reg, abbrevs] = await Promise.all([readRegistry(root), readJournalAbbrevs(root)])
  const p = reg.papers.find((x) => x.id === id)
  if (!p) return { renamed: false, reason: 'missing' }

  const abs = resolvePaperPath(root, p)
  if (!isInsideSources(root, abs)) return { renamed: false, reason: 'external' }
  try {
    await fs.access(abs)
  } catch {
    return { renamed: false, reason: 'missing' }
  }

  // The user's journal map wins over the extractor's abbreviation, matching display.
  const journal = (p.journal && abbrevs[journalKey(p.journal)]) || p.journalAbbrev || p.journal
  const ext = extensionOf(abs)
  const newName = buildHouseFilename(
    { title: p.title, authors: p.authors, year: p.year, journal },
    ext
  )
  if (!newName) return { renamed: false, reason: 'sparse' }

  const dir = sourcesDir(root)
  const currentName = basename(abs)
  if (newName === currentName) {
    return { renamed: false, reason: 'unchanged', from: currentName, to: currentName }
  }

  // Don't clobber a different file that already owns the target name.
  const finalName = await uniqueFilename(dir, newName)
  await fs.rename(abs, join(dir, finalName))
  p.path = join(SOURCES_DIR, finalName)
  await writeRegistry(root, reg)
  await regenerateMasterBib(root)
  return { renamed: true, from: currentName, to: finalName }
}

export async function removeLibraryPaper(root: string, id: string): Promise<void> {
  const reg = await readRegistry(root)
  const paper = reg.papers.find((p) => p.id === id)
  reg.papers = reg.papers.filter((p) => p.id !== id)
  await writeRegistry(root, reg)
  await regenerateMasterBib(root)
  // lctrn owns the copy in sources/, so delete the file too (never an external path).
  if (paper) {
    const abs = resolvePaperPath(root, paper)
    if (isInsideSources(root, abs)) {
      try {
        await fs.unlink(abs)
      } catch {
        // already gone
      }
    }
  }
}

/**
 * Reconcile the registry with the actual contents of `sources/`. Called by the
 * folder watcher so pasting a PDF in (or deleting one) updates the library:
 *  - new *.pdf files in `sources/` get registered
 *  - registry entries whose `sources/` file vanished get dropped
 * Returns true when anything changed. Externally-pathed entries are left alone.
 */
export async function syncLibrary(root: string): Promise<boolean> {
  await ensureLibrary(root)
  const reg = await readRegistry(root)
  let files: string[] = []
  try {
    files = (await fs.readdir(sourcesDir(root))).filter((f) => f.toLowerCase().endsWith('.pdf'))
  } catch {
    files = []
  }
  const present = new Set(files)
  let changed = false

  // Drop entries whose source file is gone.
  const kept: LibraryPaper[] = []
  for (const p of reg.papers) {
    const abs = resolvePaperPath(root, p)
    if (isInsideSources(root, abs) && !present.has(basename(abs))) {
      changed = true
      continue
    }
    kept.push(p)
  }
  reg.papers = kept

  // Register newly-appeared files.
  const known = new Set(
    reg.papers
      .map((p) => resolvePaperPath(root, p))
      .filter((abs) => isInsideSources(root, abs))
      .map((abs) => basename(abs))
  )
  for (const f of files) {
    if (known.has(f)) continue
    const name = f.replace(/\.pdf$/i, '')
    const id = uniqueId(reg, slug(name))
    reg.papers.push({
      id,
      citekey: id,
      title: titleFromName(name),
      authors: [],
      year: yearFromName(name),
      addedAt: Date.now(),
      path: join(SOURCES_DIR, f)
    })
    changed = true
  }

  if (changed) {
    await writeRegistry(root, reg)
    await regenerateMasterBib(root)
  }
  return changed
}

// --- Metadata enrichment -----------------------------------------------------

/** Roots with an enrichment pass in flight, so concurrent calls don't double-process. */
const enriching = new Set<string>()

function needsEnrichment(p: LibraryPaper): boolean {
  return !p.metaSource
}

/**
 * Fill in real metadata (title/authors/year/doi/journal/abstract) for any papers
 * that haven't been processed yet, one at a time, persisting and calling
 * `onProgress` after each so the UI updates live. Re-reads the registry every
 * iteration, so papers added mid-pass (e.g. a multi-file paste) get picked up.
 * A paper is only attempted once — on failure we still stamp `metaSource` so it
 * isn't retried forever. Safe to call repeatedly; overlapping calls are coalesced.
 */
export async function enrichLibrary(root: string, onProgress?: () => void): Promise<void> {
  if (enriching.has(root)) return
  enriching.add(root)
  try {
    for (;;) {
      const next = (await readRegistry(root)).papers.find(needsEnrichment)
      if (!next) break
      let meta: ExtractedMeta
      try {
        meta = await extractMetadata(resolvePaperPath(root, next))
      } catch {
        meta = { source: 'filename' }
      }
      // Re-read before writing — sync may have changed the registry meanwhile.
      const reg = await readRegistry(root)
      const target = reg.papers.find((p) => p.id === next.id)
      if (!target) continue
      if (!needsEnrichment(target)) continue // someone else enriched it
      applyMeta(reg, target, meta)
      await writeRegistry(root, reg)
      await regenerateMasterBib(root)
      // Now that we have real metadata, put the on-disk file into house style
      // (e.g. "Wagner et al. 2024 JFE, Corp governance.pdf"). Best-effort: a
      // paper too sparse to name, already in style, or outside sources/ just
      // keeps its filename, and a rename hiccup never derails enrichment.
      try {
        await renamePaperToHouseStyle(root, target.id)
      } catch {
        // leave the filename as-is — the metadata itself was saved above
      }
      onProgress?.()
    }
  } finally {
    enriching.delete(root)
  }
}

/**
 * Apply extracted metadata onto a registry entry, keeping a useful citekey. In
 * the default (enrichment) mode, only fields the extractor produced are written,
 * so first-pass enrichment never clears anything. With `overwrite`, the entry is
 * replaced wholesale (a manual re-fetch): fields absent from the fresh fetch are
 * cleared, since the user asked for authoritative metadata. Tags, file path, and
 * timestamps are never touched here.
 */
function applyMeta(reg: Registry, p: LibraryPaper, m: ExtractedMeta, overwrite = false): void {
  // Keep the fresh value when present; on overwrite, clear stale values the
  // fetch no longer carries; otherwise leave the existing value alone.
  const keep = <T>(fresh: T | undefined, cur: T | undefined): T | undefined =>
    fresh !== undefined ? fresh : overwrite ? undefined : cur

  p.title = keep(m.title, p.title)
  p.authors = m.authors && m.authors.length ? m.authors : overwrite ? [] : p.authors
  p.year = keep(m.year, p.year)
  p.doi = keep(m.doi, p.doi)
  p.journal = keep(m.journal, p.journal)
  p.journalAbbrev = keep(m.journalAbbrev, p.journalAbbrev)
  p.abstract = keep(m.abstract, p.abstract)
  p.volume = keep(m.volume, p.volume)
  p.issue = keep(m.issue, p.issue)
  p.pages = keep(m.pages, p.pages)
  p.url = keep(m.url, p.url)
  p.metaSource = m.source
  // Promote the filename-slug citekey to author+year when we learned both.
  const surname = surnameOf(p.authors[0])
  if (surname && p.year) {
    p.citekey = uniqueCitekey(reg, p, `${surname}${p.year}`)
  }
}

/**
 * Re-run extraction for an existing paper (DOI→Crossref, else Claude reads the
 * PDF, else embedded info) and overwrite its bibliographic metadata wholesale.
 * Tags and the on-disk file are preserved. A fully-unreadable PDF (`filename`
 * source) is treated as "found nothing" and left untouched rather than wiping
 * good data. Refreshes the master bib since the entry changed.
 */
export async function refetchLibraryPaper(root: string, id: string): Promise<void> {
  const p0 = (await readRegistry(root)).papers.find((x) => x.id === id)
  if (!p0) return
  let meta: ExtractedMeta
  try {
    meta = await extractMetadata(resolvePaperPath(root, p0))
  } catch {
    meta = { source: 'filename' }
  }
  if (meta.source === 'filename') return // extraction found nothing usable
  // Re-read before writing — the watcher may have changed the registry meanwhile.
  const reg = await readRegistry(root)
  const target = reg.papers.find((x) => x.id === id)
  if (!target) return
  const oldKey = target.citekey
  applyMeta(reg, target, meta, true)
  await writeRegistry(root, reg)
  await regenerateMasterBib(root)
  // A refetch can promote the citekey (e.g. learning author+year) — follow it
  // through to anything already citing the old key.
  if (target.citekey !== oldKey) await renameCitekeyEverywhere(root, oldKey, target.citekey)
}

function surnameOf(author?: string): string | undefined {
  if (!author) return undefined
  // Reuse the citation surname logic so "De Franco, Gus" keys as "defranco",
  // not "gus" — and so multi-word/particle surnames match the bib + filename.
  const s = lastName(author).toLowerCase().replace(/[^a-z]/g, '')
  return s || undefined
}

function uniqueCitekey(reg: Registry, self: LibraryPaper, base: string): string {
  let key = base
  let n = 2
  while (reg.papers.some((p) => p !== self && p.citekey === key)) key = `${base}${String.fromCharCode(96 + n++)}`
  return key
}

/**
 * Suggest a `surnameYear` citekey for a paper from the given (possibly unsaved)
 * authors + year — the data behind the Inspector's "Generate" button. Mirrors the
 * promotion in `applyMeta`, and disambiguates against the rest of the registry
 * (excluding this paper) so the field shows exactly what would be saved. Falls
 * back to the paper's current key when there isn't enough to build one.
 */
export async function suggestCitekey(
  root: string,
  id: string,
  authors: string[],
  year?: string
): Promise<string> {
  const reg = await readRegistry(root)
  const self = reg.papers.find((p) => p.id === id)
  if (!self) return ''
  const surname = surnameOf(authors.find((a) => a.trim()))
  const yr = year?.match(/\d{4}/)?.[0]
  if (!surname || !yr) return self.citekey // too sparse — keep the current key
  return uniqueCitekey(reg, self, `${surname}${yr}`)
}

// --- Projects ----------------------------------------------------------------

export interface ProjectSummary {
  name: string
  path: string
  title: string
  paperCount: number
}

function projectsDir(root: string): string {
  return join(root, 'projects')
}

export async function listProjects(root: string): Promise<ProjectSummary[]> {
  let names: string[] = []
  try {
    names = await fs.readdir(projectsDir(root))
  } catch {
    return []
  }
  const out: ProjectSummary[] = []
  for (const name of names) {
    const path = join(projectsDir(root), name)
    try {
      const cfg = JSON.parse(await fs.readFile(join(path, '.lctrn', 'config.json'), 'utf8'))
      const ids = await readProjectPaperIds(path)
      out.push({ name, path, title: cfg.title ?? name, paperCount: ids.length })
    } catch {
      // not a lctrn project — skip
    }
  }
  return out.sort((a, b) => a.title.localeCompare(b.title))
}

export async function createProject(
  root: string,
  name: string,
  meta: ProjectMeta,
  now: string
): Promise<{ ok: boolean; projectPath?: string; error?: string }> {
  await ensureLibrary(root)
  const projectPath = join(projectsDir(root), name)
  try {
    const existing = await fs.readdir(projectPath)
    if (existing.length) return { ok: false, error: `"${name}" already exists in the library.` }
  } catch {
    // doesn't exist — good
  }
  await scaffoldProject(projectPath, meta, now)
  await ensureQuartoDocs(projectPath)
  return { ok: true, projectPath }
}

// --- Project ↔ library paper references --------------------------------------

async function readProjectPaperIds(projectPath: string): Promise<string[]> {
  try {
    const j = JSON.parse(await fs.readFile(join(projectPath, '.lctrn', 'papers.json'), 'utf8'))
    return Array.isArray(j.paperIds) ? j.paperIds : []
  } catch {
    return []
  }
}

async function writeProjectPaperIds(projectPath: string, ids: string[]): Promise<void> {
  await fs.mkdir(join(projectPath, '.lctrn'), { recursive: true })
  await fs.writeFile(
    join(projectPath, '.lctrn', 'papers.json'),
    JSON.stringify({ paperIds: ids }, null, 2) + '\n'
  )
}

export interface ProjectPapers {
  selected: ResolvedPaper[]
  available: ResolvedPaper[]
}

export async function getProjectPapers(root: string, projectPath: string): Promise<ProjectPapers> {
  const ids = new Set(await readProjectPaperIds(projectPath))
  const all = await listLibraryPapers(root)
  return {
    selected: all.filter((p) => ids.has(p.id)),
    available: all.filter((p) => !ids.has(p.id))
  }
}

// A project's selection is the "desk" view (which papers are foregrounded for
// this project), not a citation gate: every manuscript cites the one
// library-wide references.bib, so changing the desk doesn't touch any bib.
export async function addProjectPaper(_root: string, projectPath: string, id: string): Promise<void> {
  const ids = await readProjectPaperIds(projectPath)
  if (!ids.includes(id)) ids.push(id)
  await writeProjectPaperIds(projectPath, ids)
}

export async function removeProjectPaper(
  _root: string,
  projectPath: string,
  id: string
): Promise<void> {
  const ids = (await readProjectPaperIds(projectPath)).filter((x) => x !== id)
  await writeProjectPaperIds(projectPath, ids)
}

/** Absolute path to the single library-wide bibliography lctrn generates. */
export function masterBibPath(root: string): string {
  return join(root, CONFIG_DIR, 'references.bib')
}

/**
 * Materialize the library-wide `references.bib` from the FULL registry (no PDF
 * copies). There is one bib for the whole library — every project's manuscript
 * points at it by relative path, so every manuscript can cite every paper. A
 * project's `papers.json` selection is now just the "desk" view, not a citation
 * gate. Regenerated whenever the registry changes; unused entries cost nothing
 * at render time (LaTeX/pandoc only emit what's actually cited).
 */
async function regenerateMasterBib(root: string): Promise<void> {
  const papers = await listLibraryPapers(root)
  const body = papers.map((p) => bibEntry(p)).join('\n\n')
  const header = '% Generated by lctrn from the shared library. Do not edit by hand.\n\n'
  await fs.writeFile(masterBibPath(root), header + body + (body ? '\n' : ''))
}

function bibEntry(p: ResolvedPaper): string {
  const fields = [
    p.title && `  title   = {${p.title}}`,
    p.authors.length && `  author  = {${p.authors.join(' and ')}}`,
    p.journal && `  journal = {${p.journal}}`,
    p.year && `  year    = {${p.year}}`,
    p.volume && `  volume  = {${p.volume}}`,
    p.issue && `  number  = {${p.issue}}`,
    p.pages && `  pages   = {${p.pages}}`,
    p.doi && `  doi     = {${p.doi}}`,
    p.url && `  url     = {${p.url}}`,
    `  file    = {${p.absPath}}`
  ]
    .filter(Boolean)
    .join(',\n')
  return `@article{${p.citekey},\n${fields}\n}`
}

// --- Small helpers -----------------------------------------------------------

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'paper'
  )
}

function uniqueId(reg: Registry, base: string): string {
  let id = base
  let n = 2
  while (reg.papers.some((p) => p.id === id)) id = `${base}-${n++}`
  return id
}

function titleFromName(name: string): string {
  return name.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function yearFromName(name: string): string | undefined {
  const m = name.match(/(19|20)\d{2}/)
  return m ? m[0] : undefined
}
