import { promises as fs } from 'fs'
import { join } from 'path'
import { listLibraryPapers, type ResolvedPaper } from './library'

/**
 * Inquiries — "talking to your literature". An inquiry is a saved folder under
 * the library holding a SELECTION of papers + a QUESTION; you run Claude over it
 * from an embedded terminal and it writes the answer back as `result.md` (in
 * `[@citekey]` form, so it drops straight into a manuscript). Folder-native, like
 * everything else in lctrn: the folder is the record, no database.
 *
 * Layout: `<root>/.lctrn/inquiries/<slug>/`
 *   inquiry.json   — question + selection + frozen paperIds + provenance
 *   selection.md   — the manifest Claude reads (per paper: citekey, meta, abstract, PDF path)
 *   result.md      — Claude's answer (written by the run, not by us)
 *   .claude/       — skills/inquiry/SKILL.md + settings.json (read access to bib + .sources)
 */

const CONFIG_DIR = '.lctrn'
const INQUIRIES_DIR = 'inquiries'

export function inquiriesDir(root: string): string {
  return join(root, CONFIG_DIR, INQUIRIES_DIR)
}

function inquiryDir(root: string, slug: string): string {
  return join(inquiriesDir(root), slug)
}

// --- Selection ---------------------------------------------------------------

/**
 * How an inquiry chooses its papers. `manual` is an explicit list of citation
 * keys; `filter` is a predicate over the registry — free text matched against
 * title/abstract/authors/journal (AND across tokens), narrowed by author names,
 * tags (ANY of the chosen tags) and an optional year range. Resolved to concrete
 * paperIds at create time and frozen into the folder.
 */
export interface InquirySelection {
  kind: 'manual' | 'filter'
  keys?: string[]
  text?: string
  /**
   * Comma-separated author names. Each name is matched against EVERY author of
   * a paper, not just the first one, so "Vance" finds papers where they are
   * fourth author; several names AND together ("Abbasi, Vance" = papers both
   * worked on).
   */
  authors?: string
  tagIds?: string[]
  yearFrom?: number
  yearTo?: number
}

export interface InquiryMeta {
  slug: string
  title: string
  question: string
  selection: InquirySelection
  paperIds: string[]
  created: string
  /** A saved-but-not-yet-run inquiry: editable in the composer, no terminal. */
  draft?: boolean
}

export interface InquirySummary {
  slug: string
  title: string
  question: string
  paperCount: number
  created: string
  hasResult: boolean
  draft: boolean
}

/** Resolve a selection against the live registry, preserving a sensible order. */
export async function resolveSelection(
  root: string,
  sel: InquirySelection
): Promise<ResolvedPaper[]> {
  const all = await listLibraryPapers(root)
  if (sel.kind === 'manual') {
    const want = (sel.keys ?? []).map((k) => k.replace(/^@/, '').trim().toLowerCase()).filter(Boolean)
    const byKey = new Map(all.map((p) => [p.citekey.toLowerCase(), p]))
    // Preserve the order the keys were given in; drop unknown keys silently.
    return want.map((k) => byKey.get(k)).filter((p): p is ResolvedPaper => Boolean(p))
  }
  const tokens = (sel.text ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const tags = sel.tagIds ?? []
  // Free text sees the whole author list (every position, not just the first).
  const haystack = (p: ResolvedPaper): string =>
    [p.title, p.citekey, p.abstract, p.journal, p.journalAbbrev, ...p.authors]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
  const wantedAuthors = splitAuthorQuery(sel.authors)
  return all.filter((p) => {
    if (tokens.length) {
      const h = haystack(p)
      if (!tokens.every((t) => h.includes(t))) return false
    }
    if (wantedAuthors.length && !matchesAuthors(p, wantedAuthors)) return false
    if (tags.length && !tags.some((t) => p.tagIds?.includes(t))) return false
    const yr = p.year ? parseInt(p.year, 10) : NaN
    if (sel.yearFrom && (!yr || yr < sel.yearFrom)) return false
    if (sel.yearTo && (!yr || yr > sel.yearTo)) return false
    return true
  })
}

/** "Abbasi, Vance" → ['abbasi', 'vance'] (empty for a blank query). */
export function splitAuthorQuery(q: string | undefined): string[] {
  return (q ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

/** Every queried name must match SOME author of the paper, at any position. */
export function matchesAuthors(p: { authors: string[] }, wanted: string[]): boolean {
  const names = p.authors.map((a) => a.toLowerCase())
  return wanted.every((w) => names.some((n) => n.includes(w)))
}

// --- Read --------------------------------------------------------------------

export async function listInquiries(root: string): Promise<InquirySummary[]> {
  let slugs: string[] = []
  try {
    slugs = (await fs.readdir(inquiriesDir(root), { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
  const out: InquirySummary[] = []
  for (const slug of slugs) {
    try {
      const meta: InquiryMeta = JSON.parse(
        await fs.readFile(join(inquiryDir(root, slug), 'inquiry.json'), 'utf8')
      )
      out.push({
        slug,
        title: meta.title,
        question: meta.question,
        paperCount: meta.paperIds?.length ?? 0,
        created: meta.created,
        hasResult: await exists(join(inquiryDir(root, slug), 'result.md')),
        draft: Boolean(meta.draft)
      })
    } catch {
      // not a well-formed inquiry — skip
    }
  }
  // Newest first.
  return out.sort((a, b) => b.created.localeCompare(a.created))
}

export interface InquiryDetail {
  meta: InquiryMeta
  dir: string
  selectionMd: string
  resultMd: string | null
  /** The line to type into the spawned `claude` to (re-)run this inquiry. */
  kickoff: string
}

export async function readInquiry(root: string, slug: string): Promise<InquiryDetail | null> {
  const dir = inquiryDir(root, slug)
  try {
    const meta: InquiryMeta = JSON.parse(await fs.readFile(join(dir, 'inquiry.json'), 'utf8'))
    const selectionMd = await fs.readFile(join(dir, 'selection.md'), 'utf8').catch(() => '')
    const resultMd = await fs.readFile(join(dir, 'result.md'), 'utf8').catch(() => null)
    return { meta, dir, selectionMd, resultMd, kickoff: kickoffPrompt() }
  } catch {
    return null
  }
}

// --- Create ------------------------------------------------------------------

export interface CreatedInquiry {
  meta: InquiryMeta
  dir: string
  kickoff: string
}

/**
 * Materialize a new inquiry folder from a selection + question. Resolves the
 * selection NOW and freezes the resulting paperIds + manifest, so the inquiry is
 * a stable record even as the library changes later. Scaffolds the `inquiry`
 * skill and a settings.json granting Claude read access to the bibliography and
 * the PDF store. Returns the folder so the renderer can launch a terminal in it.
 *
 * `draft: true` writes exactly the same folder but marks it unrun — the composer
 * can reopen it later (see `updateInquiry`). A draft is a real folder, not a
 * side-table: same folder-is-the-record rule as everything else.
 */
export async function createInquiry(
  root: string,
  title: string,
  question: string,
  selection: InquirySelection,
  now: string,
  draft = false
): Promise<CreatedInquiry> {
  const papers = await resolveSelection(root, selection)
  const slug = await uniqueSlug(root, slugify(title || question))
  const dir = inquiryDir(root, slug)

  const meta: InquiryMeta = {
    slug,
    title: title.trim() || question.trim().slice(0, 60) || 'Untitled inquiry',
    question: question.trim(),
    selection,
    paperIds: papers.map((p) => p.id),
    created: now,
    ...(draft ? { draft: true } : {})
  }
  await writeInquiryFolder(dir, meta, papers)
  return { meta, dir, kickoff: kickoffPrompt() }
}

/**
 * Rewrite an existing inquiry in place — used to edit a draft and to promote one
 * to a real run (`draft: false`). The selection is re-resolved against the live
 * registry, so a draft picks up papers added since it was saved. Keeps the slug
 * (and therefore the folder, and any result.md already in it).
 */
export async function updateInquiry(
  root: string,
  slug: string,
  patch: { title: string; question: string; selection: InquirySelection; draft: boolean }
): Promise<CreatedInquiry | null> {
  const dir = inquiryDir(root, slug)
  let prev: InquiryMeta
  try {
    prev = JSON.parse(await fs.readFile(join(dir, 'inquiry.json'), 'utf8'))
  } catch {
    return null
  }
  const papers = await resolveSelection(root, patch.selection)
  const meta: InquiryMeta = {
    ...prev,
    slug,
    title: patch.title.trim() || patch.question.trim().slice(0, 60) || prev.title,
    question: patch.question.trim(),
    selection: patch.selection,
    paperIds: papers.map((p) => p.id),
    ...(patch.draft ? { draft: true } : { draft: undefined })
  }
  if (!patch.draft) delete meta.draft
  await writeInquiryFolder(dir, meta, papers)
  return { meta, dir, kickoff: kickoffPrompt() }
}

/** Write (or rewrite) the folder: metadata, manifest and Claude scaffolding. */
async function writeInquiryFolder(
  dir: string,
  meta: InquiryMeta,
  papers: ResolvedPaper[]
): Promise<void> {
  await fs.mkdir(join(dir, '.claude', 'skills', 'inquiry'), { recursive: true })
  await fs.writeFile(join(dir, 'inquiry.json'), JSON.stringify(meta, null, 2) + '\n')
  await fs.writeFile(join(dir, 'selection.md'), selectionMd(meta, papers))
  await fs.writeFile(join(dir, '.claude', 'settings.json'), inquirySettings())
  await fs.writeFile(join(dir, '.claude', 'skills', 'inquiry', 'SKILL.md'), inquirySkill())
}

export async function deleteInquiry(root: string, slug: string): Promise<void> {
  await fs.rm(inquiryDir(root, slug), { recursive: true, force: true })
}

/**
 * The line we type into the freshly-spawned `claude` to kick the inquiry off.
 * Self-contained (doesn't depend on the skill being discovered) but aligned with
 * what the skill describes, so it works either way.
 */
export function kickoffPrompt(): string {
  return (
    'Read ./selection.md and ./inquiry.json, then answer the question for the ' +
    'listed papers. Cite papers as [@citekey]; open the linked PDFs only if the ' +
    'abstracts are not enough. Write your answer to ./result.md.'
  )
}

// --- Templates ---------------------------------------------------------------

function selectionMd(meta: InquiryMeta, papers: ResolvedPaper[]): string {
  const head = `# Inquiry — ${meta.title}\n\n**Question:** ${meta.question}\n\n` +
    `## Papers (${papers.length})\n\n`
  const body = papers
    .map((p) => {
      const meta2 = [p.year, p.journalAbbrev || p.journal].filter(Boolean).join(' · ')
      const lines = [
        `### [@${p.citekey}] ${p.title || '(untitled)'}`,
        p.authors.length ? `- Authors: ${p.authors.join(', ')}` : null,
        meta2 ? `- ${meta2}` : null,
        `- PDF: ${p.absPath}`,
        p.abstract ? `- Abstract: ${p.abstract}` : '- Abstract: (none on file)'
      ]
      return lines.filter(Boolean).join('\n')
    })
    .join('\n\n')
  return head + body + '\n'
}

function inquirySettings(): string {
  return (
    JSON.stringify(
      {
        permissions: {
          allow: ['Read', 'Edit', 'Write', 'Grep', 'Glob'],
          deny: ['Bash(rm *)'],
          // The folder sits at <root>/.lctrn/inquiries/<slug>/. Grant read of
          // the .lctrn dir (references.bib lives there) and the PDF store, by
          // relative path so a Dropbox-synced library survives moving machines.
          additionalDirectories: ['../..', '../../../sources']
        }
      },
      null,
      2
    ) + '\n'
  )
}

function inquirySkill(): string {
  return `---
name: inquiry
description: Answer a question across a fixed set of library papers and save the result
---

You are answering one question about a curated set of papers. The folder is the
record — everything you need is here.

1. Read \`inquiry.json\` for the question and \`selection.md\` for the papers (each
   has a citekey, metadata, an abstract, and an absolute path to its PDF).
2. Work from the abstracts first; open a PDF (its \`PDF:\` path) only when the
   question needs detail the abstract doesn't carry.
3. Write your answer to \`result.md\`. Cite every paper you draw on as
   \`[@citekey]\` so the answer can be pasted into a manuscript that shares the
   library bibliography. Never invent a citation or a finding.
4. If a paper can't support a claim the question asks for, say so explicitly
   rather than guessing.
`
}

// --- Helpers -----------------------------------------------------------------

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'inquiry'
  )
}

async function uniqueSlug(root: string, base: string): Promise<string> {
  let slug = base
  let n = 2
  while (await exists(inquiryDir(root, slug))) slug = `${base}-${n++}`
  return slug
}
