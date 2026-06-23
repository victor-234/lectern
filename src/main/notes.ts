import type { IpcMain } from 'electron'
import { promises as fs } from 'fs'
import { join, resolve, sep } from 'path'

/**
 * Margin notes for the manuscript. When the user selects text in the editor and
 * right-clicks "Add note", we pin the selection (snippet + line range at the
 * time of writing) together with their note and persist it to a single
 * `MANUSCRIPT_NOTES.md` at the project root — a plain, Claude-readable file so
 * the same folder-as-source-of-truth model holds: Claude edits the manuscript
 * by reading these notes.
 *
 * Line numbers are a SNAPSHOT from when the note was created; they may drift as
 * the manuscript is edited, but the saved snippet keeps the anchor meaningful.
 */

export const NOTES_FILE = 'MANUSCRIPT_NOTES.md'
const FILE = NOTES_FILE

const HEADER = [
  '# Manuscript Notes',
  '',
  'Notes for Claude on `manuscript.qmd`. Each note pins a line range and the',
  'selected text it refers to. Line numbers are a snapshot from when the note',
  'was written and may have drifted — use the quoted snippet as the anchor.',
  ''
].join('\n')

export interface ManuscriptNote {
  id: string
  line: number // 1-based start line at time of writing
  endLine: number // 1-based end line at time of writing
  snippet: string // the selected text
  note: string // the user's note
  created: string // ISO timestamp
  // Set when the `address-notes` skill has applied this note: the `✅ DONE — …`
  // marker it writes under the note. `null` = still outstanding. Done notes stay
  // in the file (as a record for Claude) but are hidden from the Notes panel.
  done: string | null
}

// Matches the `✅ DONE — <summary>` line the address-notes skill inserts under a
// note's HTML comment. The em-dash/dash and summary are optional.
const DONE_MARKER = /^✅\s*DONE\b\s*[—–-]*\s*(.*)$/

// --- Paths -------------------------------------------------------------------

function notesPath(projectPath: string): string {
  const abs = resolve(projectPath, FILE)
  const root = resolve(projectPath)
  if (abs !== resolve(root, FILE) || !abs.startsWith(root + sep)) {
    throw new Error('refusing to write notes outside the project')
  }
  return abs
}

// --- Serialize / parse -------------------------------------------------------

/** Prefix every line of `s` with `> ` so multi-line snippets stay a block quote. */
function quote(s: string): string {
  return s
    .split('\n')
    .map((l) => (l.length ? `> ${l}` : '>'))
    .join('\n')
}

function lineLabel(n: ManuscriptNote): string {
  return n.line === n.endLine ? `Line ${n.line}` : `Lines ${n.line}–${n.endLine}`
}

function serialize(notes: ManuscriptNote[]): string {
  const blocks = notes.map((n) => {
    return [
      `<!-- lctrn-note id=${n.id} line=${n.line} endLine=${n.endLine} created=${n.created} -->`,
      // Preserve the address-notes "done" marker so it round-trips when another
      // note is added/edited/deleted (which rewrites the whole file).
      ...(n.done !== null ? [n.done ? `✅ DONE — ${n.done}` : '✅ DONE'] : []),
      `### ${lineLabel(n)}`,
      '',
      quote(n.snippet),
      '',
      n.note.trim(),
      ''
    ].join('\n')
  })
  return HEADER + '\n' + blocks.join('\n---\n\n')
}

/**
 * Parse notes back out of `MANUSCRIPT_NOTES.md`. The `<!-- lctrn-note … -->`
 * markers delimit notes; within a block, `> `-prefixed lines are the snippet and
 * everything after the blank line is the note body. Hand-edits that keep the
 * markers round-trip; free-form prose between markers is ignored.
 */
function parse(text: string): ManuscriptNote[] {
  // Accept the legacy `lectern-note` marker too; files self-migrate to `lctrn-note` on next save.
  const marker =
    /<!--\s*(?:lctrn|lectern)-note\s+id=(\S+)\s+line=(\d+)\s+endLine=(\d+)\s+created=(\S+?)\s*-->/g
  const notes: ManuscriptNote[] = []
  const matches = [...text.matchAll(marker)]
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]
    const start = m.index! + m[0].length
    const end = i + 1 < matches.length ? matches[i + 1].index! : text.length
    const body = text.slice(start, end)
    const snippetLines: string[] = []
    const noteLines: string[] = []
    let inNote = false
    let done: string | null = null
    for (const raw of body.split('\n')) {
      const line = raw
      const dm = line.match(DONE_MARKER)
      if (dm) {
        // The address-notes skill marked this note applied. Capture the summary
        // and drop the line so it never leaks into the snippet or note body.
        done = dm[1].trim()
        continue
      }
      if (line.startsWith('### ')) continue // generated label heading
      if (line === '---') continue // separator
      if (!inNote && (line.startsWith('> ') || line === '>')) {
        snippetLines.push(line === '>' ? '' : line.slice(2))
        continue
      }
      // first non-quote, non-empty line after the snippet starts the note body
      if (snippetLines.length && line.trim()) inNote = true
      if (inNote) noteLines.push(line)
    }
    notes.push({
      id: m[1],
      line: parseInt(m[2], 10),
      endLine: parseInt(m[3], 10),
      created: m[4],
      snippet: snippetLines.join('\n').replace(/\s+$/, ''),
      note: noteLines.join('\n').trim(),
      done
    })
  }
  return notes
}

// --- Read / mutate -----------------------------------------------------------

export async function readNotes(projectPath: string): Promise<ManuscriptNote[]> {
  try {
    const text = await fs.readFile(notesPath(projectPath), 'utf8')
    return parse(text)
  } catch {
    return []
  }
}

async function writeNotes(projectPath: string, notes: ManuscriptNote[]): Promise<void> {
  const abs = notesPath(projectPath)
  if (notes.length === 0) {
    // Nothing left — remove the file rather than leave an empty stub behind.
    try {
      await fs.unlink(abs)
    } catch {
      /* already gone */
    }
    return
  }
  await fs.writeFile(abs, serialize(notes), 'utf8')
}

export async function addNote(
  projectPath: string,
  input: { line: number; endLine: number; snippet: string; note: string },
  now: string
): Promise<ManuscriptNote[]> {
  const notes = await readNotes(projectPath)
  const note: ManuscriptNote = {
    id: 'n' + now.replace(/\D/g, '').slice(-12),
    line: input.line,
    endLine: input.endLine,
    snippet: input.snippet,
    note: input.note,
    created: now,
    done: null
  }
  // Keep the file ordered by manuscript position so it reads top-to-bottom.
  const next = [...notes, note].sort((a, b) => a.line - b.line || a.endLine - b.endLine)
  await writeNotes(projectPath, next)
  return next
}

export async function editNote(
  projectPath: string,
  id: string,
  note: string
): Promise<ManuscriptNote[]> {
  const notes = await readNotes(projectPath)
  const next = notes.map((n) => (n.id === id ? { ...n, note: note.trim() } : n))
  await writeNotes(projectPath, next)
  return next
}

export async function deleteNote(projectPath: string, id: string): Promise<ManuscriptNote[]> {
  const notes = await readNotes(projectPath)
  const next = notes.filter((n) => n.id !== id)
  await writeNotes(projectPath, next)
  return next
}

// --- address-notes skill (UI-linked) -----------------------------------------

const SKILL_REL = join('.claude', 'skills', 'address-notes', 'SKILL.md')

/**
 * The `address-notes` skill: applies the outstanding notes in
 * `MANUSCRIPT_NOTES.md` to `manuscript.qmd` and marks each `✅ DONE`. Pairs with
 * the Notes panel's "Address notes" button (see `addressNotesKickoff`). Adapted
 * to lctrn's house-style sources (`.claude/CLAUDE.md` + `LEARNED_EDITS.md`),
 * unlike a per-project hand-written copy that may point elsewhere.
 */
export function addressNotesSkill(): string {
  return `---
name: address-notes
description: Address the outstanding notes in MANUSCRIPT_NOTES.md by editing manuscript.qmd accordingly
---

You are addressing the notes the user left in \`MANUSCRIPT_NOTES.md\` and applying
them to \`manuscript.qmd\`.

## Steps

1. Read \`.claude/CLAUDE.md\` for the house style and \`LEARNED_EDITS.md\` for the
   author's learned rules — follow both for any text change.
2. Read \`MANUSCRIPT_NOTES.md\`. Each note block carries an HTML comment with an
   \`id=\` and a \`line=\`/\`endLine=\`, the quoted snippet it refers to (\`>\` lines),
   and an instruction.
3. Treat any note that is **not** already marked done (no \`✅ DONE\` line) as
   outstanding. Skip notes already marked done.
4. For each outstanding note, in order:
   - Locate the target text in \`manuscript.qmd\`. The \`line=\` number is a snapshot
     and may have drifted — **use the quoted snippet as the anchor**, not the line
     number. If the snippet can't be found, do not guess: flag it and move on.
   - Apply the instruction in place. Match the surrounding prose: existing voice,
     terminology, citation style (keep the \`[@key]\` citations intact), and the
     house-style rules above.
   - Do not fabricate citations or empirical claims. If a note asks for something
     that would require a source that isn't present, flag it instead.
5. After applying a note's edit, mark it done in \`MANUSCRIPT_NOTES.md\`: insert a
   line \`✅ DONE — <one-line summary of what you changed>\` directly under the
   note's HTML comment. Keep the rest of the note block intact.
6. Apply all outstanding notes in one pass, then report:
   - One line per note: the \`id\`, what you changed, and the location in
     \`manuscript.qmd\`.
   - A separate list of any notes you could not address (snippet not found, missing
     citation, ambiguous) with the reason.

## Notes

- Edit \`manuscript.qmd\` only for the manuscript content; edit \`MANUSCRIPT_NOTES.md\`
  only to add the \`✅ DONE\` markers.
- Never delete a note. Never touch the generated \`manuscript.tex\`, \`.log\`, or
  \`.pdf\` files.
`
}

/**
 * Write-if-absent the address-notes skill, so projects created before this
 * feature pick it up the first time the user clicks "Address notes". New
 * projects get the same template from `scaffold.ts`.
 */
export async function ensureAddressNotes(projectPath: string): Promise<void> {
  const abs = join(projectPath, SKILL_REL)
  try {
    await fs.access(abs)
    return // already present — never clobber a hand-edited skill
  } catch {
    /* absent — write it */
  }
  await fs.mkdir(resolve(abs, '..'), { recursive: true })
  await fs.writeFile(abs, addressNotesSkill(), 'utf8')
}

export interface AddressResult {
  outstanding: number // notes still to address at launch time
  kickoff?: string // prompt to drop into the terminal (absent when nothing to do)
}

/**
 * Ensure the skill exists and build the kickoff prompt for the embedded
 * terminal. Returns `outstanding: 0` with no kickoff when every note is already
 * done, so the UI can no-op instead of launching Claude on nothing.
 */
export async function addressNotes(projectPath: string): Promise<AddressResult> {
  const notes = await readNotes(projectPath)
  const outstanding = notes.filter((n) => n.done === null).length
  if (outstanding === 0) return { outstanding: 0 }
  await ensureAddressNotes(projectPath)
  const kickoff =
    `Run the address-notes skill — apply my ${outstanding} outstanding ` +
    `note${outstanding === 1 ? '' : 's'} in \`${NOTES_FILE}\` to \`manuscript.qmd\`, ` +
    `following the house style, and mark each one ✅ DONE.`
  return { outstanding, kickoff }
}

export function registerNotes(ipcMain: IpcMain): void {
  ipcMain.handle('project:notes:list', (_e, projectPath: string) => readNotes(projectPath))
  ipcMain.handle('project:notes:address', (_e, projectPath: string) => addressNotes(projectPath))
  ipcMain.handle(
    'project:notes:add',
    (_e, args: { projectPath: string; line: number; endLine: number; snippet: string; note: string }) =>
      addNote(
        args.projectPath,
        { line: args.line, endLine: args.endLine, snippet: args.snippet, note: args.note },
        new Date().toISOString()
      )
  )
  ipcMain.handle(
    'project:notes:update',
    (_e, args: { projectPath: string; id: string; note: string }) =>
      editNote(args.projectPath, args.id, args.note)
  )
  ipcMain.handle('project:notes:delete', (_e, args: { projectPath: string; id: string }) =>
    deleteNote(args.projectPath, args.id)
  )
}
