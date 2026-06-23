import { promises as fs } from 'fs'
import { join } from 'path'

export interface BibEntry {
  key: string
  type: string
  title?: string
  author?: string
  year?: string
  fields: Record<string, string>
}

export interface PileResult {
  papersDir: string
  hasPapersDir: boolean
  pdfs: string[]
  bib: BibEntry[]
  matched: { entry: BibEntry; pdf?: string }[]
}

/**
 * Scans `<project>/papers/` for a references.bib and PDF files, then makes a
 * best-effort link between each bib entry and a PDF on disk. This is the
 * "paper pile" — the filesystem is the source of truth; we only read it.
 */
export async function scanPile(projectPath: string): Promise<PileResult> {
  const papersDir = join(projectPath, 'papers')

  let hasPapersDir = false
  let pdfs: string[] = []
  try {
    const files = await fs.readdir(papersDir)
    hasPapersDir = true
    pdfs = files.filter((f) => f.toLowerCase().endsWith('.pdf')).sort()
  } catch {
    hasPapersDir = false
  }

  let bib: BibEntry[] = []
  try {
    const raw = await fs.readFile(join(papersDir, 'references.bib'), 'utf8')
    bib = parseBib(raw)
  } catch {
    bib = []
  }

  const matched = bib.map((entry) => ({ entry, pdf: pdfs.find((p) => matchPdf(p, entry)) }))
  return { papersDir, hasPapersDir, pdfs, bib, matched }
}

/** Heuristic link: filename contains first-author surname and the year. */
function matchPdf(pdf: string, e: BibEntry): boolean {
  const name = pdf.toLowerCase()
  const author = (e.author || '').split(/\s+and\s+|,/)[0].trim().toLowerCase()
  if (author && e.year) return name.includes(author) && name.includes(e.year)
  if (e.year) return name.includes(e.year)
  return false
}

/** Minimal BibTeX parser — good enough for the spike, no external dependency. */
export function parseBib(raw: string): BibEntry[] {
  const entries: BibEntry[] = []
  const header = /@(\w+)\s*\{\s*([^,\s]+)\s*,/g
  let m: RegExpExecArray | null
  while ((m = header.exec(raw))) {
    const type = m[1].toLowerCase()
    if (type === 'comment' || type === 'preamble' || type === 'string') continue
    const key = m[2].trim()

    // Walk to the matching closing brace of the entry body.
    let depth = 1
    let i = header.lastIndex
    for (; i < raw.length && depth > 0; i++) {
      if (raw[i] === '{') depth++
      else if (raw[i] === '}') depth--
    }
    const body = raw.slice(header.lastIndex, i - 1)
    header.lastIndex = i

    const fields = parseFields(body)
    entries.push({
      key,
      type,
      title: fields.title,
      author: fields.author,
      year: fields.year,
      fields
    })
  }
  return entries
}

function parseFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {}
  const field = /(\w+)\s*=\s*(\{(?:[^{}]|\{[^{}]*\})*\}|"[^"]*"|[^,\s]+)/g
  let m: RegExpExecArray | null
  while ((m = field.exec(body))) {
    let val = m[2]
    if ((val.startsWith('{') && val.endsWith('}')) || (val.startsWith('"') && val.endsWith('"'))) {
      val = val.slice(1, -1)
    }
    fields[m[1].toLowerCase()] = val.replace(/\s+/g, ' ').trim()
  }
  return fields
}
