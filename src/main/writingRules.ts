import { platform, ensureUserDataDir, type IpcLike } from './platform'
import { promises as fs } from 'fs'
import { join } from 'path'

/**
 * Library-wide rules for any AI writing that goes into a paper.
 *
 * Lives at `<library>/.lctrn/WRITING_RULES.md` — one file, shared by every
 * project, in the one directory each scaffolded project already grants Claude
 * read access to (`additionalDirectories: ['../../.lctrn']`, see scaffold.ts).
 * So Claude Code can read it by path in the terminal, AND the direct-API
 * features (Rewrite) can inline it into a system prompt.
 *
 * Three tiers of style guidance, most general to most specific:
 *   1. this file                      — the author's durable voice, all papers
 *   2. `<project>/WRITING_STYLE.md`   — this paper / this venue (see
 *                                       projectFiles.ts)
 *   3. `<project>/LEARNED_EDITS.md`   — distilled from the author's own
 *                                       corrections (see revising.ts); wins on
 *                                       conflict, because it's evidence
 *
 * Written as a flat bulleted list on purpose: it is injected verbatim into
 * every direct-API request, so it has to stay short and cheap to send.
 */

const CONFIG_DIR = '.lctrn'
export const WRITING_RULES_FILE = 'WRITING_RULES.md'

export function writingRulesPath(root: string): string {
  return join(root, CONFIG_DIR, WRITING_RULES_FILE)
}

/** Create the starter rules file if the library doesn't have one yet. */
export async function ensureWritingRules(root: string): Promise<void> {
  const path = writingRulesPath(root)
  try {
    await fs.access(path)
  } catch {
    await fs.mkdir(join(root, CONFIG_DIR), { recursive: true })
    await fs.writeFile(path, starterRules(), 'utf8')
  }
}

export async function readWritingRules(root: string | null): Promise<string> {
  if (!root) return ''
  try {
    return await fs.readFile(writingRulesPath(root), 'utf8')
  } catch {
    return ''
  }
}

export async function writeWritingRules(root: string | null, content: string): Promise<void> {
  if (!root) throw new Error('no library configured')
  await fs.mkdir(join(root, CONFIG_DIR), { recursive: true })
  await fs.writeFile(writingRulesPath(root), content, 'utf8')
}

/**
 * The rules as they should appear in a system prompt: comment lines stripped so
 * the file can carry guidance for the human editing it without spending tokens
 * on every API call. Returns '' when there's nothing but scaffolding, so callers
 * can skip the section entirely rather than injecting an empty heading.
 */
export async function writingRulesForPrompt(root: string | null): Promise<string> {
  const raw = await readWritingRules(root)
  const body = raw
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('<!--') && !l.trimStart().startsWith('#'))
    .join('\n')
    .trim()
  return body ? raw.trim() : ''
}

// --- Anthropic API key -------------------------------------------------------

/**
 * The Rewrite feature calls the Anthropic API directly (rather than dispatching
 * into the embedded Claude Code terminal) so a selection-level edit returns a
 * diff to accept or reject instead of printing into a terminal. That needs a key
 * of our own. Never sent to the renderer — the renderer only ever learns whether
 * one is set, and how well it is protected. `ANTHROPIC_API_KEY` in the
 * environment wins if present, so a user who already exports one doesn't have to
 * paste it again.
 *
 * At rest it goes through `platform.secrets`: the OS keychain in the desktop app
 * (Electron's safeStorage), a 0600 file when Lectern runs as a plain localhost
 * server with no keychain to bind to. `apiKeyState().secure` reports which, so
 * the settings UI can say so rather than implying protection it isn't getting —
 * in server mode, exporting `ANTHROPIC_API_KEY` is the better answer.
 */

function keyFile(): string {
  // `.bin` is the historical name for the keychain-encrypted blob, so desktop
  // installs keep reading the key they already have.
  const name = platform.secrets.scheme === 'keychain' ? 'anthropic-key.bin' : 'anthropic-key.plain'
  return join(platform.userDataDir(), name)
}

export async function getApiKey(): Promise<string | null> {
  const fromEnv = process.env.ANTHROPIC_API_KEY?.trim()
  if (fromEnv) return fromEnv
  try {
    const buf = await fs.readFile(keyFile())
    return (await platform.secrets.decrypt(buf)).trim() || null
  } catch {
    return null
  }
}

export async function setApiKey(key: string): Promise<void> {
  const trimmed = key.trim()
  if (!trimmed) {
    await fs.unlink(keyFile()).catch(() => {})
    return
  }
  const blob = await platform.secrets.encrypt(trimmed)
  await ensureUserDataDir()
  // 0600 matters in the no-keychain case, where the bytes are the key itself.
  await fs.writeFile(keyFile(), blob, { mode: 0o600 })
}

/** What the renderer is allowed to know about the key. */
export interface ApiKeyState {
  /** A key is available (stored or from the environment). */
  present: boolean
  /** It came from `ANTHROPIC_API_KEY`, so the stored one is irrelevant. */
  fromEnv: boolean
  /** A stored key is keychain-backed. False when it's a 0600 plaintext file. */
  secure: boolean
}

export async function apiKeyState(): Promise<ApiKeyState> {
  const fromEnv = !!process.env.ANTHROPIC_API_KEY?.trim()
  return {
    present: fromEnv || !!(await getApiKey()),
    fromEnv,
    secure: platform.secrets.scheme === 'keychain'
  }
}

// --- IPC ---------------------------------------------------------------------

export function registerWritingRules(
  ipcMain: IpcLike,
  libraryRoot: () => Promise<string | null>
): void {
  ipcMain.handle('library:writingRules:get', async () => readWritingRules(await libraryRoot()))
  ipcMain.handle('library:writingRules:save', async (_e, content: string) =>
    writeWritingRules(await libraryRoot(), content)
  )
  ipcMain.handle('ai:key:state', () => apiKeyState())
  ipcMain.handle('ai:key:set', (_e, key: string) => setApiKey(key))
}

// --- Starter content ---------------------------------------------------------

function starterRules(): string {
  return `<!--
Rules for any AI writing that goes into a paper. Shared by EVERY lctrn project.

These are injected verbatim into each AI writing request, so keep them short and
concrete. Comment blocks like this one and headings are stripped before sending.

Precedence, weakest to strongest:
  1. this file                     — your durable voice, everywhere
  2. <project>/WRITING_STYLE.md    — this paper, this venue
  3. <project>/LEARNED_EDITS.md    — learned from your own corrections
-->

# Writing rules

## Voice
- Write plain, direct academic prose. Say the thing.
- Prefer the active voice and a named actor ("we estimate", not "it is estimated").
- Vary sentence length. Do not open consecutive sentences the same way.
- No throat-clearing openers: "It is important to note that", "In today's world".

## Cut
- Cut hedges unless the uncertainty is real and quantified: "somewhat", "quite",
  "arguably", "it seems", "may potentially".
- Cut intensifiers: "very", "extremely", "highly", "significantly" (unless
  statistical significance is meant, and then give the number).
- Cut filler transitions: "Moreover", "Furthermore", "Additionally". Start the
  sentence with its own content.
- One idea per sentence. Split anything that needs a semicolon to survive.

## Claims and citations
- Every empirical claim cites a key from the bibliography as [@citekey].
- Never invent a citation, a number, a quotation, or a result. If a claim needs
  a source you cannot find, flag it inline as [CITE?] and move on.
- Do not soften a claim the evidence supports, and do not strengthen one it
  does not.

## Terminology
- Keep the manuscript's existing terms. Do not silently introduce a synonym for
  a term already defined.
- Expand an acronym on first use, then use it consistently.

## Mechanics
- One sentence per line. Every sentence starts on a new line in the source; never
  wrap or join sentences onto a shared line. Blank lines still separate paragraphs,
  and the rendered output is unchanged — this is for clean diffs and line-level review.
- Match the surrounding document: Quarto markdown, existing heading levels,
  \`[@citekey]\` citations, @fig-/@tbl- cross-references.
- Preserve the author's LaTeX, code chunks, and cross-reference labels verbatim.
- Do not change the structure of a section you were asked to rewrite in place.

## Scope
- Rewrite what was selected. Do not extend the argument, add a new claim, or
  append a concluding sentence that was not there.
- Return only the rewritten prose — no preamble, no explanation, no fences.
`
}
