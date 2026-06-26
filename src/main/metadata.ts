import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { extractText, getDocumentProxy, getMeta } from 'unpdf'
import { fixAuthorCase, normalizeAuthorName } from './houseName'

/**
 * Metadata extracted from a PDF, plus which strategy produced it. The registry
 * stores `source` so the UI can show provenance and so we never re-enrich a
 * paper we've already attempted (see `metaSource` in library.ts).
 */
export interface ExtractedMeta {
  title?: string
  authors?: string[]
  year?: string
  doi?: string
  journal?: string
  /** Short journal label (Crossref short-container-title) when available. */
  journalAbbrev?: string
  abstract?: string
  /** Journal volume, e.g. "42". */
  volume?: string
  /** Journal issue number, e.g. "3" (mapped to BibTeX `number`). */
  issue?: string
  /** Page range, e.g. "123-145". */
  pages?: string
  source: 'crossref' | 'claude' | 'embedded' | 'filename' | 'imported'
}

/** How much of the PDF text we hand to the DOI scan / Claude — the front matter is enough. */
const TEXT_BUDGET = 6000

/**
 * Resolve a PDF's metadata. Order of preference:
 *  1. DOI found in the text  → Crossref (canonical, free, no key)
 *  2. no DOI                 → Claude reads the first page (uses the local `claude` CLI)
 * Embedded PDF info backfills anything still missing. On a fully unreadable PDF
 * we return `source: 'filename'` so the caller marks it attempted and moves on.
 */
export async function extractMetadata(absPdfPath: string): Promise<ExtractedMeta> {
  const { text, info } = await readPdf(absPdfPath)
  const embedded = fromEmbedded(info)

  // 1. DOI → Crossref
  const doi = findDoi(text)
  if (doi) {
    const cr = await fromCrossref(doi).catch(() => null)
    if (cr) return backfill({ ...cr, source: 'crossref' }, embedded)
  }

  // 2. No usable DOI → ask the local Claude CLI to read the front matter.
  if (text.trim()) {
    const cl = await fromClaude(text).catch(() => null)
    if (cl && (cl.title || (cl.authors && cl.authors.length))) {
      return backfill({ ...cl, doi: cl.doi ?? doi, source: 'claude' }, embedded)
    }
  }

  // 3. Fall back to whatever the file embedded, else signal "filename only".
  if (embedded.title || (embedded.authors && embedded.authors.length) || doi) {
    return backfill({ ...embedded, doi: embedded.doi ?? doi, source: 'embedded' }, {})
  }
  return { source: 'filename' }
}

// --- PDF reading -------------------------------------------------------------

async function readPdf(absPath: string): Promise<{ text: string; info: Record<string, unknown> }> {
  try {
    const buf = await fs.readFile(absPath)
    if (!buf.length) return { text: '', info: {} }
    const pdf = await getDocumentProxy(new Uint8Array(buf))
    const [{ text }, meta] = await Promise.all([
      extractText(pdf, { mergePages: true }),
      getMeta(pdf).catch(() => ({ info: {} as Record<string, unknown> }))
    ])
    return { text: (text || '').slice(0, TEXT_BUDGET), info: meta.info ?? {} }
  } catch {
    // Encrypted, empty, or malformed PDF — nothing to read.
    return { text: '', info: {} }
  }
}

function fromEmbedded(info: Record<string, unknown>): Partial<ExtractedMeta> {
  const title = str(info.Title)
  const author = str(info.Author)
  return {
    title: title || undefined,
    authors: author ? splitAuthors(author) : undefined
  }
}

/**
 * Split a free-form author field into individual authors, then normalize each to
 * "First Last". Splits only on ";" / " and " / "&" / newlines — NOT bare commas,
 * since a comma inside a name means "Last, First" (house convention) rather than
 * an author boundary.
 */
function splitAuthors(raw: string): string[] {
  return raw
    .split(/\s*(?:;|\band\b|&|\n)\s*/)
    .map((a) => normalizeAuthorName(a))
    .filter(Boolean)
}

// --- DOI + Crossref ----------------------------------------------------------

/**
 * Fetch canonical metadata for a user-supplied DOI from Crossref. Unlike
 * `extractMetadata` (which only reaches Crossref via a DOI scraped from the PDF),
 * this is the direct "I'll give you the DOI" path used by the Inspector's Fetch
 * button. Accepts a raw DOI, a `doi:` prefix, or a `https://doi.org/…` URL.
 * Returns null on no match / network error so the caller can report "not found".
 */
export async function fetchByDoi(rawDoi: string): Promise<ExtractedMeta | null> {
  // Normalize: drop a URL/scheme prefix, then reuse the body-text DOI matcher to
  // pull out the bare `10.…` token and trim trailing punctuation.
  const stripped = rawDoi.trim().replace(/^\s*(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)/i, '')
  const doi = findDoi(stripped)
  if (!doi) return null
  const cr = await fromCrossref(doi).catch(() => null)
  if (!cr) return null
  return backfill({ ...cr, source: 'crossref' }, {})
}

/** Match a DOI in body text, trimming trailing punctuation that often clings to it. */
export function findDoi(text: string): string | undefined {
  const m = text.match(/\b10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/)
  if (!m) return undefined
  return m[0].replace(/[.,;:)\]]+$/, '')
}

async function fromCrossref(doi: string): Promise<Partial<ExtractedMeta> | null> {
  const res = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
    headers: { 'User-Agent': 'lctrn/0.1 (https://github.com/; academic reference manager)' },
    signal: AbortSignal.timeout(12_000)
  })
  if (!res.ok) return null
  const body = (await res.json()) as { message?: CrossrefWork }
  const w = body.message
  if (!w) return null
  return {
    title: decodeEntities(w.title?.[0]),
    authors: (w.author ?? []).map((a) => crossrefAuthor(a.given, a.family)).filter(Boolean),
    year: crossrefYear(w),
    doi: w.DOI ?? doi,
    journal: decodeEntities(w['container-title']?.[0]),
    journalAbbrev: decodeEntities(w['short-container-title']?.[0]),
    abstract: w.abstract ? decodeEntities(stripJats(w.abstract)) : undefined,
    volume: clean(w.volume),
    issue: clean(w.issue),
    pages: clean(w.page)
  }
}

/** Crossref strings sometimes carry XML entities ("Auditing &amp; Accountability"). */
function decodeEntities(s: string | undefined): string | undefined {
  if (!s) return s
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

interface CrossrefWork {
  title?: string[]
  author?: { given?: string; family?: string }[]
  'container-title'?: string[]
  'short-container-title'?: string[]
  DOI?: string
  abstract?: string
  volume?: string
  issue?: string
  page?: string
  issued?: { 'date-parts'?: number[][] }
  'published-print'?: { 'date-parts'?: number[][] }
  'published-online'?: { 'date-parts'?: number[][] }
}

function crossrefYear(w: CrossrefWork): string | undefined {
  const parts =
    w.issued?.['date-parts']?.[0] ??
    w['published-print']?.['date-parts']?.[0] ??
    w['published-online']?.['date-parts']?.[0]
  const y = parts?.[0]
  return y ? String(y) : undefined
}

/**
 * Build an author name from Crossref's structured given/family parts. Crossref
 * knows the surname boundary, so route both-present names through
 * `normalizeAuthorName` in "Family, Given" form: it flips to "First Last" for an
 * ordinary surname but keeps the explicit comma form when the family is
 * multi-word (e.g. "De Franco"), so the citation renders "De Franco et al."
 */
function crossrefAuthor(given?: string, family?: string): string {
  const g = (given ?? '').trim()
  const f = (family ?? '').trim()
  if (g && f) return normalizeAuthorName(`${f}, ${g}`)
  return [g, f].filter(Boolean).join(' ').trim()
}

function stripJats(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// --- Claude fallback (local `claude` CLI, headless) --------------------------

const CLAUDE_PROMPT = `You are given the raw text of the first page(s) of an academic paper PDF.
Extract its bibliographic metadata. Respond with ONLY a single JSON object, no prose, no code fences, in exactly this shape:
{"title": string, "authors": string[], "year": string, "doi": string|null, "journal": string|null}
"authors" is an ordered list of full author names in "First Last" order (e.g. "Jane Smith"). Exception: when a surname has multiple words or a capitalized particle (e.g. "De Franco", "Van Order"), give that author as "Last, First" (e.g. "De Franco, Gus") so the full surname is preserved. "year" is the 4-digit publication year as a string.
If a field is unknown use null (or [] for authors). Do not invent values.

--- PAPER TEXT ---
`

async function fromClaude(text: string): Promise<Partial<ExtractedMeta> | null> {
  const raw = await runClaude(CLAUDE_PROMPT + text)
  if (!raw) return null
  const obj = parseJsonLoose(raw)
  if (!obj) return null
  const authors = Array.isArray(obj.authors)
    ? obj.authors.map((a) => normalizeAuthorName(String(a))).filter(Boolean)
    : undefined
  return {
    title: clean(obj.title),
    authors,
    year: clean(obj.year)?.match(/\d{4}/)?.[0],
    doi: clean(obj.doi),
    journal: clean(obj.journal)
  }
}

/** Run `claude -p --output-format json`, feeding the prompt on stdin; return the model's text. */
function runClaude(prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(
      'claude',
      ['-p', '--output-format', 'json'],
      { timeout: 90_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) return resolve(null)
        try {
          const env = JSON.parse(stdout) as { result?: string; is_error?: boolean }
          resolve(env.is_error ? null : (env.result ?? null))
        } catch {
          resolve(null)
        }
      }
    )
    child.stdin?.end(prompt)
  })
}

/** Pull the first {...} block out of a model reply and JSON-parse it. */
function parseJsonLoose(s: string): Record<string, unknown> | null {
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(s.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
}

// --- small helpers -----------------------------------------------------------

/** Merge a primary result with embedded fallbacks, keeping the primary where present. */
function backfill(primary: ExtractedMeta, embedded: Partial<ExtractedMeta>): ExtractedMeta {
  const authors = primary.authors?.length ? primary.authors : embedded.authors
  return {
    ...primary,
    title: primary.title ?? embedded.title,
    // De-shout ALL-CAPS names from any source before they reach the registry.
    authors: authors?.map(fixAuthorCase),
    year: primary.year ?? embedded.year
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function clean(v: unknown): string | undefined {
  if (v == null) return undefined
  const s = String(v).trim()
  return s && s.toLowerCase() !== 'null' ? s : undefined
}
