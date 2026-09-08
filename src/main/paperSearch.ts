import type { IpcLike } from './platform'
import { parseJsonLoose, runClaude } from './metadata'
import { getPaperText } from './paperText'

/**
 * Semantic ("what does this paper say about…") search inside one open paper.
 *
 * Literal ⌘F runs in the renderer against the cached page text (see paperText.ts).
 * This is the other half: the paper's text is handed to the local `claude` CLI —
 * the same headless call metadata extraction already uses, so no API key, no
 * embedding index to maintain, no network service — and the model returns the
 * passages that actually answer the question, each with the page it sits on so
 * the Reader can jump there.
 */

export interface SemanticHit {
  /** 1-based PDF page the passage sits on. */
  page: number
  /** The passage itself, quoted from the paper. */
  quote: string
  /** One line on why it answers the question. */
  why: string
  /** True when the quote was found verbatim in the extracted text of `page`. */
  exact: boolean
}

export interface SemanticResult {
  /** Short answer to the question drawn from this paper ('' when it doesn't address it). */
  summary: string
  hits: SemanticHit[]
  /** Set when the search couldn't run at all (no text layer, `claude` missing, …). */
  error?: string
}

/**
 * How much paper text goes into one `claude` call (~60k tokens). A typical
 * journal article is well under this, so it is a single call; a book-length PDF
 * is split and the chunks run concurrently.
 */
const CHUNK_CHARS = 240_000
const MAX_CHUNKS = 4
const MAX_HITS = 8

const PROMPT_HEAD = `You are helping a researcher search INSIDE one academic paper by meaning, not by keyword.

The paper's extracted text follows, split by page markers of the form [[page N]].

Respond with ONLY a single JSON object, no prose and no code fences, in exactly this shape:
{"summary": string, "hits": [{"page": number, "quote": string, "why": string}]}

Rules:
- "summary": one or two sentences answering the question using only this paper. Use "" if the paper does not address it.
- "hits": up to ${MAX_HITS} passages, most relevant first. Judge relevance by meaning — a passage that answers the question without sharing any of its words still counts.
- "quote": one to three sentences copied VERBATIM from the text above. Never paraphrase, never stitch together separate sentences, never invent a quote.
- "page": the number from the [[page N]] marker the quote sits under.
- "why": at most 15 words on how it bears on the question.
- If nothing in the text is relevant, return {"summary": "", "hits": []}. Do not pad with weak matches.

QUESTION: `

export async function semanticSearch(id: string, query: string): Promise<SemanticResult> {
  const q = query.trim()
  if (!q) return { summary: '', hits: [] }

  const text = await getPaperText(id)
  if (!text) return { summary: '', hits: [], error: 'This paper’s PDF is missing on disk.' }
  if (text.empty) {
    return {
      summary: '',
      hits: [],
      error: 'This PDF has no text layer — it looks like a scan, so there is nothing to read.'
    }
  }

  const chunks = buildChunks(text.pages)
  const ask = (chunk: string): Promise<string | null> =>
    runClaude(PROMPT_HEAD + q + '\n\n--- PAPER TEXT ---\n' + chunk, { timeoutMs: 180_000 })
  const raws = await Promise.all(chunks.map(ask))
  if (raws.every((r) => r === null)) {
    return {
      summary: '',
      hits: [],
      error: 'Couldn’t reach the local `claude` CLI. Make sure it is installed and signed in.'
    }
  }

  const summaries: string[] = []
  const hits: SemanticHit[] = []
  for (const raw of raws) {
    if (!raw) continue
    const obj = parseJsonLoose(raw)
    if (!obj) continue
    const s = typeof obj.summary === 'string' ? obj.summary.trim() : ''
    if (s) summaries.push(s)
    for (const h of Array.isArray(obj.hits) ? obj.hits : []) {
      const hit = coerceHit(h, text.pages)
      if (hit) hits.push(hit)
    }
  }

  // Verbatim hits first (they can be highlighted and trusted), then by page.
  hits.sort((a, b) => Number(b.exact) - Number(a.exact) || a.page - b.page)
  return { summary: summaries.join(' '), hits: dedupe(hits).slice(0, MAX_HITS) }
}

/** Page-tagged text, split so each chunk fits comfortably in one call. */
function buildChunks(pages: string[]): string[] {
  const chunks: string[] = []
  let cur = ''
  for (let i = 0; i < pages.length; i++) {
    const block = `[[page ${i + 1}]]\n${pages[i]}\n\n`
    if (cur && cur.length + block.length > CHUNK_CHARS) {
      chunks.push(cur)
      if (chunks.length >= MAX_CHUNKS) return chunks
      cur = ''
    }
    cur += block
  }
  if (cur.trim()) chunks.push(cur)
  return chunks
}

/**
 * Validate one model-reported hit against the text we actually extracted. A
 * quote that isn't on the page the model named is looked up across the paper and
 * re-pointed; one we can't find anywhere is kept but flagged `exact: false`, so
 * the UI can show it as the model's paraphrase rather than as the paper's words.
 */
function coerceHit(h: unknown, pages: string[]): SemanticHit | null {
  if (!h || typeof h !== 'object') return null
  const o = h as Record<string, unknown>
  const quote = typeof o.quote === 'string' ? o.quote.trim() : ''
  if (!quote) return null
  const why = typeof o.why === 'string' ? o.why.trim() : ''
  const claimed = Math.round(Number(o.page))
  const needle = fold(quote)
  const onClaimed =
    Number.isFinite(claimed) &&
    claimed >= 1 &&
    claimed <= pages.length &&
    fold(pages[claimed - 1]).includes(needle)
  if (onClaimed) return { page: claimed, quote, why, exact: true }

  const found = pages.findIndex((p) => fold(p).includes(needle))
  if (found >= 0) return { page: found + 1, quote, why, exact: true }

  const page = Number.isFinite(claimed) ? Math.min(Math.max(claimed, 1), pages.length) : 1
  return { page, quote, why, exact: false }
}

/** Lowercase, strip everything but letters/digits — so quoting quirks don't matter. */
function fold(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function dedupe(hits: SemanticHit[]): SemanticHit[] {
  const seen = new Set<string>()
  return hits.filter((h) => {
    const k = `${h.page}:${fold(h.quote).slice(0, 80)}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

export function registerPaperSearch(ipcMain: IpcLike): void {
  ipcMain.handle('library:text:get', (_e, id: string) => getPaperText(id))
  ipcMain.handle('library:search:semantic', (_e, args: { id: string; query: string }) =>
    semanticSearch(args.id, args.query)
  )
}
