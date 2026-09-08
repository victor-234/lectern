import { promises as fs } from 'fs'
import { join } from 'path'
import { extractText, getDocumentProxy } from 'unpdf'
import { getLibraryRoot, paperAbsPath } from './library'

/**
 * Page-by-page text of a library PDF, for the Reader's find bar (literal ⌘F)
 * and its semantic search.
 *
 * The reader renders PDFs through Chromium's PDFium viewer inside an iframe —
 * a black box we can't search into or highlight inside. So lctrn keeps its own
 * text layer: unpdf/pdf.js extracts each page once, and the result is cached in
 * `.lctrn/text/<id>.json` (invalidated by the PDF's mtime+size) so re-opening a
 * paper is instant and survives restarts.
 */

const CONFIG_DIR = '.lctrn'
const TEXT_DIR = 'text'

export interface PaperText {
  id: string
  /** Page text, index 0 = page 1. A page with no text layer is ''. */
  pages: string[]
  /** True when NO page had extractable text (a scanned/image-only PDF). */
  empty: boolean
}

interface TextCache {
  mtimeMs: number
  size: number
  pages: string[]
}

/** Per-process cache so repeated ⌘F / semantic queries don't re-read the file. */
const memory = new Map<string, { mtimeMs: number; size: number; text: PaperText }>()
/** In-flight extractions, so two callers on the same paper share one pdf.js pass. */
const inflight = new Map<string, Promise<PaperText | null>>()

function cachePath(root: string, id: string): string {
  // Ids are UUIDs, but a legacy/hand-edited registry could hold anything —
  // reduce to a filename-safe token before it reaches the filesystem.
  const safe = id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120) || 'paper'
  return join(root, CONFIG_DIR, TEXT_DIR, `${safe}.json`)
}

/**
 * PDF text arrives line-wrapped mid-sentence, with hyphenated word breaks. Both
 * defeat a plain substring search ("identifi-\ncation" never matches
 * "identification"), so each page is flattened to running prose before it is
 * cached — snippets read better too.
 */
function normalize(s: string): string {
  return s
    .replace(/­/g, '') // soft hyphens
    .replace(/-\n\s*(?=\p{Ll})/gu, '') // de-hyphenate a break before a lowercase word
    .replace(/\s*\n\s*/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/**
 * Extracted text of a registered paper, resolved by id (never a
 * renderer-supplied path). Returns null when the id is unknown or the file is
 * gone; a PDF with no text layer comes back with `empty: true`.
 */
export async function getPaperText(id: string): Promise<PaperText | null> {
  const pending = inflight.get(id)
  if (pending) return pending
  const p = load(id).finally(() => inflight.delete(id))
  inflight.set(id, p)
  return p
}

async function load(id: string): Promise<PaperText | null> {
  const root = await getLibraryRoot()
  if (!root) return null
  const abs = await paperAbsPath(root, id)
  if (!abs) return null

  let stat: { mtimeMs: number; size: number }
  try {
    stat = await fs.stat(abs)
  } catch {
    return null // file moved or deleted
  }

  const mem = memory.get(id)
  if (mem && mem.mtimeMs === stat.mtimeMs && mem.size === stat.size) return mem.text

  const file = cachePath(root, id)
  try {
    const cached = JSON.parse(await fs.readFile(file, 'utf8')) as TextCache
    const fresh = cached.mtimeMs === stat.mtimeMs && cached.size === stat.size
    if (fresh && Array.isArray(cached.pages)) {
      const text = toPaperText(id, cached.pages)
      memory.set(id, { mtimeMs: stat.mtimeMs, size: stat.size, text })
      return text
    }
  } catch {
    /* no usable cache — extract below */
  }

  let pages: string[]
  try {
    const buf = await fs.readFile(abs)
    if (!buf.length) return toPaperText(id, [])
    const pdf = await getDocumentProxy(new Uint8Array(buf))
    const res = await extractText(pdf)
    pages = (Array.isArray(res.text) ? res.text : [res.text]).map(normalize)
  } catch {
    // Encrypted, malformed, or otherwise unreadable — searchable as "empty".
    return toPaperText(id, [])
  }

  const text = toPaperText(id, pages)
  memory.set(id, { mtimeMs: stat.mtimeMs, size: stat.size, text })
  // Best-effort write-through; a read-only / syncing library just re-extracts.
  void (async (): Promise<void> => {
    try {
      await fs.mkdir(join(root, CONFIG_DIR, TEXT_DIR), { recursive: true })
      const payload: TextCache = { mtimeMs: stat.mtimeMs, size: stat.size, pages }
      await fs.writeFile(file, JSON.stringify(payload))
    } catch {
      /* cache is an optimization, never a requirement */
    }
  })()
  return text
}

function toPaperText(id: string, pages: string[]): PaperText {
  return { id, pages, empty: !pages.some((p) => p.trim().length > 0) }
}
