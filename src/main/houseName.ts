/**
 * Build a PDF filename in the project's house style:
 *   "Wagner et al. 2024 JFE, Corp governance.pdf"
 *
 * Ported from lectern v1 (src/lib/utils/dropboxName.ts). In v1 this renamed the
 * file through the Dropbox API; here the library folder IS the synced folder, so
 * we rename the file on disk and let Dropbox carry the change. Kept dependency-
 * free (pure string work, no node/electron imports) so both the main process
 * (which performs the rename) and the renderer (which previews the result) can
 * import it.
 *
 * Parts and joining:
 *   {authors} {year} {journal}, {keywords}.{ext}
 *   - authors: 1 → "Wagner", 2 → "Wagner and Sellhorn",
 *              3 → "Wagner, Sellhorn and Müller", 4+ → "Wagner et al."
 *   - journal: the abbreviation when the user set one, else the full name.
 *   - keywords: up to 3 non-stopwords from the title, sentence-cased
 *     (first word capitalised, rest lowercase; acronyms preserved).
 *   - missing pieces collapse gracefully.
 */

const STOPWORDS = new Set([
  'a', 'an', 'the',
  'of', 'on', 'in', 'for', 'and', 'or', 'to', 'from', 'with', 'at', 'by',
  'as', 'into', 'about', 'after', 'before', 'during', 'against', 'between',
  'through', 'this', 'that', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'has', 'have', 'had',
  'do', 'does', 'did',
  'it', 'its', 'their', 'his', 'her',
  'but', 'not', 'no', 'also'
])

/** Characters Dropbox / common filesystems disallow in filenames. */
const FORBIDDEN_CHARS_RE = /[\\/?*:|"<>]/g

/**
 * The surname portion of an author name, for citations and house filenames.
 * A comma is taken as an explicit surname boundary ("de Haan, Ed" → "de Haan").
 * Without a comma we read "First Last", but pull in any trailing nobiliary
 * particles so multi-word surnames survive: "Ed de Haan" → "de Haan",
 * "Jan van der Berg" → "van der Berg". Particles are detected as lowercase
 * tokens (the academic convention), so a capitalised given name like "Della"
 * is never mistaken for one.
 */
export function lastName(fullName: string): string {
  const trimmed = fullName.trim()
  if (!trimmed) return ''
  if (trimmed.includes(',')) return trimmed.split(',')[0].trim()
  const parts = trimmed.split(/\s+/)
  let i = parts.length - 1
  // Absorb preceding all-lowercase particles (de, van, der, von, du, la, …).
  // A properly-cased given name is capitalised, so it's never swept in here.
  while (i > 0 && isParticle(parts[i - 1])) i--
  return parts.slice(i).join(' ')
}

/** A lowercase surname particle (van, de, der, von, du, la, …) — not a name. */
function isParticle(tok: string): boolean {
  const letters = tok.replace(/[^\p{L}]/gu, '')
  return letters.length > 0 && letters === letters.toLowerCase()
}

/**
 * House convention for a single author string: a comma means "Last, First", no
 * comma means "First Last". Normalizes to canonical "First Last" so stored names
 * are consistent — but only when the surname can be read back out of that flat
 * form. A surname with a capitalised particle ("De Franco, Gus") would collapse
 * to "Gus De Franco", which `lastName` then reads as surname "Franco"; for those
 * the explicit "Last, First" comma form is preserved instead, so the surname
 * boundary (and the citation "De Franco et al.") survives. BibTeX parses the
 * "Last, First" form natively, and `lastName`/`displayAuthorName` understand it.
 * Only the first comma is the surname separator (handles "van der Berg, Jan A.");
 * extra commas stay in the given-names tail. A bare "Last" is returned as-is.
 */
export function normalizeAuthorName(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, ' ')
  if (!trimmed) return ''
  const comma = trimmed.indexOf(',')
  if (comma < 0) return trimmed
  const last = trimmed.slice(0, comma).trim()
  const first = trimmed.slice(comma + 1).trim()
  if (!first) return last
  if (!last) return first
  // Keep the comma form when flipping would lose the surname boundary.
  if (lastName(`${first} ${last}`) !== last) return `${last}, ${first}`
  return `${first} ${last}`
}

/**
 * Render a stored author name for reading as "First Last", flipping back the
 * explicit "Last, First" comma form the registry keeps for multi-word surnames
 * (e.g. "De Franco, Gus" → "Gus De Franco"). Presentation only — the stored form
 * is what drives citations, the bibliography, and house filenames.
 */
export function displayAuthorName(name: string): string {
  const trimmed = name.trim()
  const comma = trimmed.indexOf(',')
  if (comma < 0) return trimmed
  const last = trimmed.slice(0, comma).trim()
  const first = trimmed.slice(comma + 1).trim()
  return first && last ? `${first} ${last}` : trimmed
}

/**
 * De-shout an author name that arrived in ALL CAPS from a metadata source
 * (Crossref, embedded PDF info, and some publishers love "SMITH, JANE"). Works
 * token by token: a token whose cased letters are all uppercase is title-cased
 * ("SMITH" → "Smith", "JEAN-PIERRE" → "Jean-Pierre", "O'BRIEN" → "O'Brien");
 * any token that is already mixed-case is left untouched, so "McDonald",
 * "van der Berg", and initials like "J. R. R." survive intact. This only fires
 * on the automatic searcher's output, never on names the user typed by hand.
 */
export function fixAuthorCase(raw: string): string {
  return raw.replace(/\S+/g, (tok) => (isAllCaps(tok) ? titleCaseToken(tok) : tok))
}

function isAllCaps(tok: string): boolean {
  const letters = tok.replace(/[^\p{L}]/gu, '')
  // Has at least one cased letter and none of them are lowercase.
  return letters.length > 0 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()
}

function titleCaseToken(tok: string): string {
  // Lowercase, then capitalise the first letter after each non-letter boundary
  // so hyphenated and apostrophed parts each get their own capital.
  return tok.toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase())
}

function formatAuthorsPart(authors: string[]): string {
  const names = authors.map(lastName).filter(Boolean)
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`
  return `${names[0]} et al.`
}

function titleKeywords(title: string, max = 3): string {
  if (!title) return ''
  const tokens = title
    .normalize('NFC')
    .split(/[\s\-–—:;,.!?()[\]{}'"`/\\]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => !STOPWORDS.has(t.toLowerCase()))
  const picked = tokens.slice(0, max)
  if (picked.length === 0) return ''
  return picked
    .map((w, i) => {
      // Preserve acronyms (all-uppercase, 2+ alpha chars) like IFRS, GDP, ESG.
      if (w.length >= 2 && /^[A-Z]+$/.test(w)) return w
      return i === 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()
    })
    .join(' ')
}

function sanitize(s: string): string {
  return s
    .replace(FORBIDDEN_CHARS_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '') // strip trailing dots/spaces so we don't end up with "et al..pdf"
}

export interface RenameablePaper {
  title?: string
  authors: string[]
  year?: string
  /** Journal label to use — the abbreviation when set, else the full name. */
  journal?: string
}

/**
 * Build the filename stem (no extension). Returns '' when metadata is too sparse
 * to produce a useful name (e.g. only an author last name) — the caller should
 * treat that as "skip rename" rather than strip the existing filename.
 */
export function buildHouseStem(paper: RenameablePaper): string {
  const authorsPart = formatAuthorsPart(paper.authors)
  const yearPart = paper.year ? String(paper.year).trim() : ''
  const journalPart = (paper.journal ?? '').trim()
  const kw = titleKeywords(paper.title ?? '', 3)

  // Require at least one signal beyond the author: year, journal, or keywords.
  if (!yearPart && !journalPart && !kw) return ''

  const left = [authorsPart, yearPart, journalPart].filter(Boolean).join(' ')
  const stem = left && kw ? `${left}, ${kw}` : left || kw
  return sanitize(stem)
}

/** Build the full filename including the extension (defaults to `.pdf`). */
export function buildHouseFilename(paper: RenameablePaper, ext = '.pdf'): string {
  const stem = buildHouseStem(paper)
  if (!stem) return ''
  const safeExt = ext.startsWith('.') ? ext : `.${ext}`
  return `${stem}${safeExt}`
}

/** Pull the extension (including leading dot) from a path. Defaults to '.pdf'. */
export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return '.pdf'
  return base.slice(dot)
}
