import type { IpcLike } from './platform'
import Anthropic from '@anthropic-ai/sdk'
import { promises as fs } from 'fs'
import { join } from 'path'
import { getApiKey, writingRulesForPrompt } from './writingRules'
import { LEARNED_EDITS_FILE } from './revising'

/**
 * "Rewrite" — rewrite a selection of the manuscript against the author's rules.
 *
 * This calls the Anthropic API directly rather than dispatching into the
 * embedded Claude Code terminal, so a selection-level edit comes back as a
 * proposal the author accepts or rejects in place, instead of printing into a
 * terminal and editing the file behind their back. Nothing is written to disk
 * here — the renderer applies the accepted text to the editor buffer.
 *
 * The rules are assembled from the three tiers (see writingRules.ts), weakest
 * first, and inlined into the system prompt. `section` is the manuscript
 * heading chain the selection sits under; if any rules file has a heading with
 * the same name, that block is pulled out and marked as governing this
 * selection — that is what "the rules of the section" resolves to.
 */

const MODEL = 'claude-sonnet-5'

export interface RewriteRequest {
  projectPath: string
  /** The exact text the author selected. */
  selection: string
  /** Enclosing manuscript headings, outermost first (e.g. ["Methods", "Sample"]). */
  section: string[]
  /** Optional extra steer from the author ("make it shorter", …). */
  instruction?: string
}

export interface RewriteResult {
  text: string
  /** The section the rules were resolved against, for display. */
  section: string | null
}

// --- Rule assembly -----------------------------------------------------------

/** Read a project file, or '' when it isn't there. */
async function readIfPresent(projectPath: string, rel: string): Promise<string> {
  try {
    return (await fs.readFile(join(projectPath, rel), 'utf8')).trim()
  } catch {
    return ''
  }
}

function normalizeHeading(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Pull the markdown block under any heading in `doc` whose text matches one of
 * `sections`. Returns '' when the rules say nothing specific about the section,
 * which is the common case — the general rules still apply.
 */
export function sectionSpecificRules(doc: string, sections: string[]): string {
  if (!doc || !sections.length) return ''
  const wanted = new Set(sections.map(normalizeHeading).filter(Boolean))
  const lines = doc.split('\n')
  const out: string[] = []
  let capturing = 0 // heading level being captured, 0 = not capturing
  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (h) {
      const level = h[1].length
      if (capturing && level <= capturing) capturing = 0
      if (!capturing && wanted.has(normalizeHeading(h[2]))) {
        capturing = level
        out.push(line)
        continue
      }
    }
    if (capturing) out.push(line)
  }
  return out.join('\n').trim()
}

function block(title: string, body: string): string {
  return body ? `\n## ${title}\n\n${body}\n` : ''
}

async function buildSystemPrompt(req: RewriteRequest, libraryRoot: string | null): Promise<string> {
  const [library, projectStyle, learned] = await Promise.all([
    writingRulesForPrompt(libraryRoot),
    readIfPresent(req.projectPath, 'WRITING_STYLE.md'),
    readIfPresent(req.projectPath, LEARNED_EDITS_FILE)
  ])

  const sectionPath = req.section.join(' › ')
  const sectionRules = [library, projectStyle, learned]
    .map((d) => sectionSpecificRules(d, req.section))
    .filter(Boolean)
    .join('\n\n')

  return [
    `You are rewriting a passage of an academic manuscript for its author.`,
    ``,
    `Rules are given weakest first: the library-wide rules are the author's`,
    `default voice, the project's writing style is specific to this paper, and`,
    `the learned edits are distilled from the author's own corrections. Where`,
    `they conflict, the later one wins.`,
    block('Library-wide writing rules', library),
    block("This paper's writing style", projectStyle),
    block('Learned from the author’s corrections', learned),
    sectionPath ? block(`Rules governing "${sectionPath}" specifically`, sectionRules) : '',
    ``,
    `## The passage`,
    ``,
    sectionPath
      ? `The selection is in the "${sectionPath}" section of the manuscript. Apply any rules above that govern that section; the general rules still apply on top of them.`
      : `The selection's section could not be determined; apply the general rules.`,
    ``,
    `## Output`,
    ``,
    `Return ONLY the rewritten passage. No preamble, no explanation, no code`,
    `fences, no quotation marks around it. Preserve the author's Quarto`,
    `markdown exactly: [@citekey] citations, @fig-/@tbl- cross-references,`,
    `LaTeX, code chunks, and heading levels pass through untouched. Match the`,
    `leading and trailing whitespace of the input. Rewrite only what you were`,
    `given — do not continue the argument or add a concluding sentence.`,
    `If a claim needs a citation you cannot supply, mark it [CITE?] inline.`
  ].join('\n')
}

// --- The call ----------------------------------------------------------------

export async function rewriteSelection(
  req: RewriteRequest,
  libraryRoot: string | null
): Promise<RewriteResult> {
  const apiKey = await getApiKey()
  if (!apiKey) {
    throw new Error(
      'No Anthropic API key. Add one under Workspace → project menu → AI writing rules.'
    )
  }
  if (!req.selection.trim()) throw new Error('Nothing selected to rewrite.')

  const client = new Anthropic({ apiKey })
  const system = await buildSystemPrompt(req, libraryRoot)
  const steer = req.instruction?.trim()

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    // A selection-level rewrite is a short task, tightly specified by the rules
    // above — low effort keeps it fast (the API default is `high`). Adaptive
    // thinking is left on, which is what omitting `thinking` means on this
    // model; the small latency it costs is worth it for prose we splice
    // straight into the draft.
    output_config: { effort: 'low' },
    system,
    messages: [
      {
        role: 'user',
        content: steer
          ? `${steer}\n\nRewrite this passage:\n\n${req.selection}`
          : `Rewrite this passage:\n\n${req.selection}`
      }
    ]
  })

  if (message.stop_reason === 'refusal') {
    throw new Error('The model declined to rewrite this passage.')
  }
  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
  if (!text) throw new Error('The model returned nothing.')

  return { text, section: req.section.join(' › ') || null }
}

export function registerRewrite(
  ipcMain: IpcLike,
  libraryRoot: () => Promise<string | null>
): void {
  ipcMain.handle('project:rewrite', async (_e, req: RewriteRequest) =>
    rewriteSelection(req, await libraryRoot())
  )
}
