import type { IpcMain } from 'electron'
import { promises as fs } from 'fs'
import { join, resolve, sep } from 'path'
import { getLibraryRoot, getLibraryPaper, type LibraryPaper } from './library'

/**
 * Per-paper reading notes. When you open a PDF in the reader, a markdown note
 * sits next to it; the moment you type, lctrn writes a plain `.md` file named
 * after the paper into a dedicated `notes/` folder in the library root — keeping
 * the folder-as-source-of-truth model (Claude can read the same files).
 *
 * The note is named after the paper's TITLE (sanitized for the filesystem),
 * falling back to its citekey/id, with a `.md` ending. The renderer only ever
 * passes a paper id; we resolve the id to a paper through the registry, so a
 * compromised renderer can't steer writes to an arbitrary path.
 */

const NOTES_DIR = 'notes'

export interface PaperNote {
  /** Markdown body of the note ('' when no note exists yet). */
  content: string
  /** Absolute path of the note file (whether or not it exists yet). */
  file: string
  /** True once the note file is actually on disk. */
  exists: boolean
}

function notesDir(root: string): string {
  return join(root, NOTES_DIR)
}

/** A filesystem-safe filename derived from the paper's title (else citekey/id). */
function noteFilename(paper: LibraryPaper): string {
  const base = sanitize(paper.title) || sanitize(paper.citekey) || sanitize(paper.id) || 'note'
  return `${base}.md`
}

// Characters that are illegal in filenames on common filesystems, including the
// two path separators. Built from a list of code points (no character-class
// ranges) so legitimate punctuation in a title — commas, periods, parentheses —
// is preserved.
const ILLEGAL = new RegExp('[' + ['<', '>', ':', '"', '|', '?', '*', '/', '\\\\'].join('') + ']', 'g')

/** Strip path separators and characters that are illegal in filenames. */
function sanitize(s?: string): string {
  if (!s) return ''
  return s
    .replace(ILLEGAL, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '') // no leading dots (hidden files / traversal)
    .trim()
    .slice(0, 120)
    .replace(/[ .]+$/, '') // no trailing space/dot (Windows-hostile)
    .trim()
}

/** Resolve a paper's note path and re-check it stays inside `notes/`. */
function notePath(root: string, paper: LibraryPaper): string {
  const dir = resolve(notesDir(root))
  const abs = resolve(dir, noteFilename(paper))
  if (abs !== join(dir, noteFilename(paper)) || !abs.startsWith(dir + sep)) {
    throw new Error('refusing to write a note outside the notes folder')
  }
  return abs
}

async function resolvePaper(id: string): Promise<{ root: string; paper: LibraryPaper } | null> {
  const root = await getLibraryRoot()
  if (!root) return null
  const paper = await getLibraryPaper(root, id)
  return paper ? { root, paper } : null
}

/**
 * Epoch-ms of the most recent interaction with a paper. Today the only
 * interaction that touches a file is a reading note, so this is the note's
 * mtime (undefined when no note exists). When highlights/annotations gain their
 * own sidecar files, fold their mtimes into the max returned here so a paper
 * counts as "interacted with" whether the user annotated it or wrote a note.
 */
export async function paperInteractedAt(
  root: string,
  paper: LibraryPaper
): Promise<number | undefined> {
  try {
    return (await fs.stat(notePath(root, paper))).mtimeMs
  } catch {
    return undefined // no note on disk yet
  }
}

export async function readPaperNote(id: string): Promise<PaperNote> {
  const r = await resolvePaper(id)
  if (!r) return { content: '', file: '', exists: false }
  const file = notePath(r.root, r.paper)
  try {
    const content = await fs.readFile(file, 'utf8')
    return { content, file, exists: true }
  } catch {
    return { content: '', file, exists: false }
  }
}

/**
 * Persist a paper note. Writing real text creates `notes/<title>.md`; clearing
 * the note back to empty removes the file rather than leaving an empty stub.
 */
export async function writePaperNote(id: string, content: string): Promise<PaperNote> {
  const r = await resolvePaper(id)
  if (!r) return { content: '', file: '', exists: false }
  const file = notePath(r.root, r.paper)
  if (!content.trim()) {
    try {
      await fs.unlink(file)
    } catch {
      /* already gone */
    }
    return { content: '', file, exists: false }
  }
  await fs.mkdir(notesDir(r.root), { recursive: true })
  await fs.writeFile(file, content, 'utf8')
  return { content, file, exists: true }
}

export function registerPaperNotes(ipcMain: IpcMain): void {
  ipcMain.handle('library:note:get', (_e, id: string) => readPaperNote(id))
  ipcMain.handle('library:note:save', (_e, args: { id: string; content: string }) =>
    writePaperNote(args.id, args.content)
  )
}
