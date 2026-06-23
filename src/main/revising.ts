import type { IpcMain } from 'electron'
import { promises as fs } from 'fs'
import { join, resolve, sep } from 'path'
import { readDoc } from './quarto'

/**
 * "Revising" mode — track-changes for the manuscript so Claude can LEARN from
 * the user's manual corrections.
 *
 * Toggle ON snapshots the current `manuscript.qmd` body as a baseline. Toggle
 * OFF snapshots the revised body, diffs the two, writes a readable unified diff,
 * and hands it to Claude in the embedded terminal (see `dispatchClaude` in the
 * renderer). The `learn-edits` skill then distills DURABLE STYLE RULES from
 * those corrections into a tracked `LEARNED_EDITS.md`, referenced from
 * `.claude/CLAUDE.md`, so future drafts honour them.
 *
 * Folder-as-source-of-truth, like the rest of lctrn: snapshots, the diff, and
 * the rules file are all plain files. Scope is the manuscript BODY only — we
 * read it through `readDoc(projectPath, 'manuscript')`, which strips the YAML
 * front matter, so metadata churn never shows up as a "correction".
 */

const REVISING_DIR = join('.lctrn', 'revising')
const BASELINE_FILE = 'baseline.qmd'
const SESSION_FILE = 'session.json'
export const LEARNED_EDITS_FILE = 'LEARNED_EDITS.md'
const SKILL_REL = join('.claude', 'skills', 'learn-edits', 'SKILL.md')

export interface RevisingState {
  active: boolean
  startedAt: string | null
}

interface SessionFile {
  active: boolean
  startedAt: string
  baseline: string
}

export interface FinishResult {
  hadChanges: boolean
  diffPath?: string // project-relative path of the written diff
  kickoff?: string // prompt to drop into the terminal
}

// --- Paths -------------------------------------------------------------------

function revisingDir(projectPath: string): string {
  const abs = resolve(projectPath, REVISING_DIR)
  const root = resolve(projectPath)
  if (!abs.startsWith(root + sep)) {
    throw new Error('refusing to write revising state outside the project')
  }
  return abs
}

// --- Session state -----------------------------------------------------------

export async function getRevisingState(projectPath: string): Promise<RevisingState> {
  try {
    const raw = await fs.readFile(join(revisingDir(projectPath), SESSION_FILE), 'utf8')
    const s = JSON.parse(raw) as Partial<SessionFile>
    if (s.active) return { active: true, startedAt: s.startedAt ?? null }
  } catch {
    /* no session, or unreadable — treat as inactive */
  }
  return { active: false, startedAt: null }
}

export async function startRevising(projectPath: string, now: string): Promise<RevisingState> {
  await ensureLearnEdits(projectPath)
  const dir = revisingDir(projectPath)
  await fs.mkdir(dir, { recursive: true })
  const { content } = await readDoc(projectPath, 'manuscript')
  await fs.writeFile(join(dir, BASELINE_FILE), content, 'utf8')
  const session: SessionFile = { active: true, startedAt: now, baseline: BASELINE_FILE }
  await fs.writeFile(join(dir, SESSION_FILE), JSON.stringify(session, null, 2) + '\n', 'utf8')
  return { active: true, startedAt: now }
}

export async function finishRevising(projectPath: string, now: string): Promise<FinishResult> {
  const dir = revisingDir(projectPath)
  let baseline = ''
  try {
    baseline = await fs.readFile(join(dir, BASELINE_FILE), 'utf8')
  } catch {
    /* no baseline (shouldn't happen) — treat as empty so everything reads as added */
  }
  const { content: after } = await readDoc(projectPath, 'manuscript')

  await clearSession(dir)

  const diff = unifiedDiff(baseline, after)
  if (!diff) return { hadChanges: false }

  const stamp = now.replace(/[:.]/g, '-')
  const diffName = `changes-${stamp}.diff`
  await fs.writeFile(join(dir, diffName), diff, 'utf8')

  const diffRel = join(REVISING_DIR, diffName)
  const kickoff =
    `Run the learn-edits skill on \`${diffRel}\` — these are my manual ` +
    `corrections to the manuscript. Distil durable style rules from them and ` +
    `update \`${LEARNED_EDITS_FILE}\`.`
  return { hadChanges: true, diffPath: diffRel, kickoff }
}

async function clearSession(dir: string): Promise<void> {
  try {
    await fs.unlink(join(dir, SESSION_FILE))
  } catch {
    /* already gone */
  }
}

// --- Line diff (pure TS, no dependency) --------------------------------------

/**
 * Produce a readable unified-style diff of two texts, line by line, using an
 * LCS backtrace. Returns '' when the texts are identical. Context is trimmed to
 * `CONTEXT` lines around each change so a small edit in a long manuscript yields
 * a small diff. Good enough for Claude to read; not byte-for-byte `diff(1)`.
 */
const CONTEXT = 3

export function unifiedDiff(before: string, after: string): string {
  if (before === after) return ''
  const a = before.split('\n')
  const b = after.split('\n')
  const ops = lcsDiff(a, b)
  if (!ops.some((o) => o.tag !== ' ')) return ''

  // Collapse long unchanged runs, keeping CONTEXT lines of margin around edits.
  const keep = new Array<boolean>(ops.length).fill(false)
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].tag === ' ') continue
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(ops.length - 1, i + CONTEXT); j++) {
      keep[j] = true
    }
  }

  const out: string[] = []
  let elided = false
  for (let i = 0; i < ops.length; i++) {
    if (keep[i]) {
      const { tag, line } = ops[i]
      out.push(`${tag}${line}`)
      elided = false
    } else if (!elided) {
      out.push('@@ …')
      elided = true
    }
  }
  return out.join('\n') + '\n'
}

interface Op {
  tag: ' ' | '-' | '+'
  line: string
}

/** Classic LCS dynamic-programming diff over arrays of lines. */
function lcsDiff(a: string[], b: string[]): Op[] {
  const n = a.length
  const m = b.length
  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ tag: ' ', line: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ tag: '-', line: a[i] })
      i++
    } else {
      ops.push({ tag: '+', line: b[j] })
      j++
    }
  }
  while (i < n) ops.push({ tag: '-', line: a[i++] })
  while (j < m) ops.push({ tag: '+', line: b[j++] })
  return ops
}

// --- Scaffolding the learn-edits skill + rules file --------------------------

/**
 * Write-if-absent the `LEARNED_EDITS.md` rules file and the `learn-edits` skill,
 * so projects created before this feature pick them up on first revising
 * toggle. New projects get the same content from `scaffold.ts`, which imports
 * these templates.
 */
export async function ensureLearnEdits(projectPath: string): Promise<void> {
  await writeIfAbsent(join(projectPath, LEARNED_EDITS_FILE), learnedEditsStarter())
  const skillAbs = join(projectPath, SKILL_REL)
  await fs.mkdir(resolve(skillAbs, '..'), { recursive: true })
  await writeIfAbsent(skillAbs, learnEditsSkill())
}

async function writeIfAbsent(path: string, content: string): Promise<void> {
  try {
    await fs.access(path)
  } catch {
    await fs.writeFile(path, content, 'utf8')
  }
}

export function learnedEditsStarter(): string {
  return `# Learned edits

Durable writing rules **inferred from the author's manual corrections** to
\`manuscript.qmd\`. lctrn captures each revising pass as a diff and the
\`learn-edits\` skill distils generalisable rules into this file. Follow these
rules when drafting or revising — they encode the author's voice and preferences.

_No rules learned yet. Toggle **Revising** in the manuscript editor, make your
corrections, then toggle it off to teach Claude what you changed._
`
}

export function learnEditsSkill(): string {
  return `---
name: learn-edits
description: Learn durable writing rules from the author's manual corrections to the manuscript
---

You are given a unified diff of the author's **manual corrections** to
\`manuscript.qmd\` (the path is named in the prompt; the body only, no front
matter). Your job is to learn from it — NOT to re-edit the manuscript.

Steps:

1. Read the named diff file. \`-\` lines are what the author removed; \`+\` lines
   are what they wrote instead. \`@@ …\` marks elided unchanged context.
2. Group the corrections by theme — e.g. wording/word-choice, tone & voice,
   structure, citations, terminology, punctuation/formatting.
3. Infer **durable, generalisable rules** the author is implicitly teaching you
   (e.g. "prefer active voice", "cut hedging like 'arguably'", "use 'firms' not
   'companies'"). Ignore one-off content edits that don't generalise.
4. Merge the rules into \`LEARNED_EDITS.md\`, organised by theme. **Refine or
   replace** existing rules rather than blindly appending — deduplicate, and
   sharpen a rule if a new correction makes it more precise. Keep each rule a
   short imperative bullet with a brief example where it helps.
5. Briefly summarise to the user what you learned and changed.

Do not modify \`manuscript.qmd\`. Only update \`LEARNED_EDITS.md\`.
`
}

// --- IPC ---------------------------------------------------------------------

export function registerRevising(ipcMain: IpcMain): void {
  ipcMain.handle('project:revising:state', (_e, projectPath: string) =>
    getRevisingState(projectPath)
  )
  ipcMain.handle('project:revising:start', (_e, projectPath: string) =>
    startRevising(projectPath, new Date().toISOString())
  )
  ipcMain.handle('project:revising:finish', (_e, projectPath: string) =>
    finishRevising(projectPath, new Date().toISOString())
  )
}
