/**
 * Citekey rename propagation. A library paper's `citekey` is the identifier every
 * manuscript and note cites as `@citekey`, so renaming a key (via the Inspector's
 * generator/edit, or a metadata refetch) has to follow through to everything that
 * already cites the old key — otherwise the `@oldkey` tokens silently go stale.
 *
 * This walks the library's writable text surfaces and rewrites `@oldKey`→`@newKey`
 * with pandoc-citation-aware boundaries. It is the citekey analogue of the
 * registry→references.bib regeneration in library.ts: the registry holds the
 * canonical key, this keeps the prose in sync. Folder-native, like the rest of the
 * app — plain text edits Claude can read.
 */
import { promises as fs } from 'fs'
import { join } from 'path'

const CONFIG_DIR = '.lctrn'

export interface CitekeyRewriteResult {
  /** Number of files whose contents changed. */
  files: number
  /** Total `@oldKey` tokens rewritten across all files. */
  occurrences: number
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Build a matcher for a pandoc citation of exactly `key`. A pandoc key continues
 * past our key only if the next char is alphanumeric/`_`, OR is internal
 * punctuation (`:.#$%&+?<>~/-`) that is *itself* followed by an alphanumeric —
 * pandoc strips trailing punctuation, so `@smith2020.` ends at `smith2020` but
 * `@smith2020.foo` does not. Asserting neither continuation holds keeps a rename
 * of `@smith2020` from touching `@smith2020b` or `@smith2020.foo`, while still
 * rewriting `@smith2020` at a sentence end (`@smith2020.`). The leading lookbehind
 * forbids a word char before `@`, so an email address (`foo@old`) is never hit.
 */
function citationMatcher(key: string): RegExp {
  return new RegExp(
    `(?<![A-Za-z0-9_])@${escapeRegExp(key)}(?![A-Za-z0-9_])(?![:.#$%&+?<>~/-][A-Za-z0-9_])`,
    'g'
  )
}

/** Rewrite one file in place; returns how many tokens were replaced (0 = untouched). */
async function rewriteFile(absPath: string, matcher: RegExp, newKey: string): Promise<number> {
  let content: string
  try {
    content = await fs.readFile(absPath, 'utf8')
  } catch {
    return 0 // missing / unreadable — skip
  }
  let count = 0
  const next = content.replace(matcher, () => {
    count++
    return `@${newKey}`
  })
  if (count === 0) return 0
  await fs.writeFile(absPath, next, 'utf8')
  return count
}

/** All files under the library that may cite a paper by `@citekey`. */
async function citingFiles(root: string): Promise<string[]> {
  const files: string[] = []

  // Per-project manuscripts + margin notes.
  let projects: string[] = []
  try {
    projects = await fs.readdir(join(root, 'projects'))
  } catch {
    /* no projects dir yet */
  }
  for (const name of projects) {
    const pp = join(root, 'projects', name)
    files.push(join(pp, 'manuscript.qmd'), join(pp, 'MANUSCRIPT_NOTES.md'))
  }

  // Per-paper reading notes (notes/<title>.md).
  try {
    for (const f of await fs.readdir(join(root, 'notes'))) {
      if (f.toLowerCase().endsWith('.md')) files.push(join(root, 'notes', f))
    }
  } catch {
    /* no notes dir yet */
  }

  // Inquiry manifests + answers (.lctrn/inquiries/<slug>/{selection,result}.md).
  const inqDir = join(root, CONFIG_DIR, 'inquiries')
  try {
    const slugs = await fs.readdir(inqDir, { withFileTypes: true })
    for (const d of slugs) {
      if (!d.isDirectory()) continue
      files.push(join(inqDir, d.name, 'selection.md'), join(inqDir, d.name, 'result.md'))
    }
  } catch {
    /* no inquiries dir yet */
  }

  return files
}

/**
 * Rewrite every `@oldKey` citation to `@newKey` across all manuscripts and notes
 * in the library. No-op when the key is unchanged. Best-effort per file (a missing
 * or unreadable file is skipped). Returns how many files changed and how many
 * tokens were rewritten.
 */
export async function renameCitekeyEverywhere(
  root: string,
  oldKey: string,
  newKey: string
): Promise<CitekeyRewriteResult> {
  if (!oldKey || !newKey || oldKey === newKey) return { files: 0, occurrences: 0 }
  const matcher = citationMatcher(oldKey)
  let files = 0
  let occurrences = 0
  for (const f of await citingFiles(root)) {
    const n = await rewriteFile(f, matcher, newKey)
    if (n > 0) {
      files++
      occurrences += n
    }
  }
  return { files, occurrences }
}
