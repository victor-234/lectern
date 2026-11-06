import { promises as fs, createWriteStream, existsSync, type WriteStream } from 'fs'
import { spawn, execFile, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { basename, join } from 'path'
import type { IpcLike, WindowLike } from './platform'
import { platform } from './platform'
import { parseJsonLoose, fetchByDoi } from './metadata'
import { introCheckGuide } from './introCheck'
import { recordCheckpoint } from './checkpoints'
import { listLibraryPapers } from './library'
import { addManualRef, listManualRefs } from './extraRefs'

/**
 * The Factory — an idea → literature → empirics → convene → editor loop run by
 * headless Claude Code agents, with gates where you step in.
 *
 * Same rule as Inquiries: the folder is the record. A run is a folder under the
 * library; every agent works in its own subfolder and writes `output.md` there,
 * which is all the next stage reads. Nothing is held only in memory except the
 * live processes and a short event tail for the UI.
 *
 * Layout: `<root>/.lctrn/factory/<slug>/`
 *   run.json     — config + state (stages, rounds, agents, decisions)
 *   idea.md      — your idea, the only input to the first stage
 *   INTRO_GUIDE.md — the framing guide (from intro-check), copied in per run so
 *                    you can tune it for this paper; read by lit/convene/editor
 *   stages/<stage>/r<round>/
 *     FEEDBACK.md          — what this round must address (send-backs only)
 *     agent-<n>/           — the agent's cwd: prompt.md, log.jsonl, output.md, work files
 *
 * Datasets agents download for reuse go to the library-level `<root>/datasets/`
 * (visible, like `sources/`), indexed by `datasets/INDEX.md`. You can drop your
 * own there too — one folder per dataset with a README.md.
 *
 * With the `intro` deliverable the run ends in an introduction rather than a
 * results memo: convene writes it against INTRO_GUIDE.md and the paragraph-level
 * anatomies in `<root>/anatomy/`, and the editor referees it with the guide's
 * checklist. The writing models are read-only references, never citations.
 *
 * A run can be linked to a paper (`config.paper`): a Lectern project plus the
 * repo its empirics live in. Then the literature stage is reassembled from the
 * project's own files, the empirics stage becomes a read-only evidence brief
 * over the repo's final results, the intro writer revises the manuscript's own
 * introduction, and accepting the editor's gate writes it back into
 * manuscript.qmd (after a dated copy goes to revisions/). Agents can read both
 * folders and write to neither — only that final, explicit accept touches them.
 *
 * Agents are `claude -p --output-format stream-json` processes with a
 * pre-assigned `--session-id`, so any of them can be reopened later as a real
 * interactive session (`claude --resume <id>` in the agent's folder).
 *
 * They run on your Claude Code login (Pro/Max plan), never an API key: the
 * key variables are stripped from their environment (see `agentEnv`), because
 * Claude Code prefers a key whenever it finds one.
 */

const CONFIG_DIR = '.lctrn'
const FACTORY_DIR = 'factory'
const DATASETS_DIR = 'datasets'

// `execute` (repo work) only runs for a run linked to a paper with an empirics
// repo, and only when switched on; otherwise it is skipped like it isn't there.
export const STAGES = ['lit', 'execute', 'empirics', 'convene', 'editor'] as const
export type StageId = (typeof STAGES)[number]

export const STAGE_LABELS: Record<StageId, string> = {
  lit: 'Literature scan',
  execute: 'Repo work',
  empirics: 'Empirics',
  convene: 'Convene',
  editor: 'Editor'
}

// --- Model -------------------------------------------------------------------

export interface StageConfig {
  agents: number
  /** independent: every agent gets the same brief; split: one sub-task each. */
  mode: 'independent' | 'split'
  /** Split-mode sub-tasks. Missing ones are planned by Claude when the stage starts. */
  tasks: string[]
  /** Your extra instructions, appended to the stage's built-in brief. */
  instructions: string
  /** Stop for your review when the stage finishes. Always on for the editor. */
  gate: boolean
  /** standard: edits + a fixed tool allowlist; full: skip all permission checks. */
  autonomy: 'standard' | 'full'
  /** Only for `execute`, which is opt-in. Every other stage always runs. */
  enabled?: boolean
}

/** Revise automatically after a disappointing editor verdict. */
export interface AutoRevise {
  on: boolean
  /** Stop once the verdict is this good or better. */
  target: 'accept' | 'minor'
  /** At most this many automatic send-backs in a row. */
  maxRounds: number
}

/** The paper a run works on: where its writing and its empirics live. */
export interface PaperLink {
  /** The Lectern project folder (holds manuscript.qmd). */
  project: string
  /** The repo with the data, pipeline and reviewed results; null = none. */
  empirics: string | null
  /** Project files that stand in for the literature scan; empty = run a scan. */
  litFiles: string[]
}

export interface PaperDefaults {
  empirics: string | null
  /** Markdown files at the project root, for picking the literature files. */
  mdFiles: string[]
  /** The ones that look like literature/positioning notes. */
  litFiles: string[]
}

export interface FactoryConfig {
  /**
   * What the run produces: an introduction (convene writes it), the paper's
   * whole front end — abstract, introduction, hypotheses (linked papers only) —
   * or a results memo.
   */
  deliverable: 'intro' | 'frontend' | 'memo'
  paper?: PaperLink | null
  autoRevise?: AutoRevise
  stages: Record<StageId, StageConfig>
  /** How many agents of one run may work at once. */
  maxParallel: number
}

export type AgentStatus = 'queued' | 'running' | 'done' | 'failed' | 'stopped'
export type StageStatus = 'pending' | 'running' | 'gate' | 'failed' | 'done'
export type RunStatus = 'draft' | 'running' | 'waiting' | 'done' | 'killed'
export type Verdict = 'accept' | 'minor' | 'major' | 'reject'

export interface AgentState {
  n: number
  sessionId: string
  status: AgentStatus
  task?: string
  startedAt?: string
  endedAt?: string
  costUsd?: number
  error?: string
}

export interface StageState {
  status: StageStatus
  /** 0 = never run. Each (re)run gets a fresh round folder. */
  round: number
  agents: AgentState[]
}

export interface Decision {
  at: string
  stage: StageId
  round: number
  action: 'approve' | 'sendBack' | 'accept' | 'kill' | 'retry' | 'autoRevise'
  to?: StageId
  note?: string
}

export interface FactoryRun {
  slug: string
  title: string
  created: string
  status: RunStatus
  config: FactoryConfig
  stages: Record<StageId, StageState>
  /** The stage running, waiting at its gate, or failed. Null before start / after the end. */
  current: StageId | null
  verdict?: Verdict
  /** Every editor round's verdict, in order — the loop stops when they stop improving. */
  verdicts?: Array<Verdict | null>
  /** Why the automatic revision loop handed back to you, shown at the gate. */
  autoStop?: string
  /** Feedback carried by every stage rerun after a send-back, until the editor runs again. */
  pending?: { note: string; from: StageId; fromRound: number }
  decisions: Decision[]
}

export interface FactorySummary {
  slug: string
  title: string
  created: string
  status: RunStatus
  current: StageId | null
  currentStatus: StageStatus | null
  verdict?: Verdict
}

export interface FactoryDetail {
  run: FactoryRun
  dir: string
  idea: string
}

export interface FactoryEvent {
  kind: 'info' | 'text' | 'tool' | 'error' | 'done'
  text: string
}

export interface AgentRef {
  slug: string
  stage: StageId
  round: number
  n: number
}

export interface DatasetInfo {
  name: string
  dir: string
  summary: string
}

export function defaultConfig(): FactoryConfig {
  const base = { instructions: '', autonomy: 'standard' as const, tasks: [] as string[] }
  return {
    deliverable: 'intro',
    autoRevise: { on: true, target: 'minor', maxRounds: 3 },
    maxParallel: 5,
    stages: {
      lit: {
        ...base,
        agents: 3,
        mode: 'split',
        gate: true,
        tasks: [
          'Theory and mechanisms behind the idea',
          'Closest empirical studies and their identification strategies',
          'Data sources and measures used in prior work'
        ]
      },
      execute: { ...base, agents: 1, mode: 'independent', gate: false, enabled: false },
      empirics: { ...base, agents: 5, mode: 'independent', gate: false },
      convene: { ...base, agents: 1, mode: 'independent', gate: true },
      editor: { ...base, agents: 1, mode: 'independent', gate: true }
    }
  }
}

// --- Paths -------------------------------------------------------------------

export function factoryDir(root: string): string {
  return join(root, CONFIG_DIR, FACTORY_DIR)
}
function runDir(root: string, slug: string): string {
  return join(factoryDir(root), slug)
}
function roundDir(root: string, slug: string, stage: StageId, round: number): string {
  return join(runDir(root, slug), 'stages', stage, `r${round}`)
}
function agentDir(root: string, ref: AgentRef): string {
  return join(roundDir(root, ref.slug, ref.stage, ref.round), `agent-${ref.n}`)
}
export function datasetsDir(root: string): string {
  return join(root, DATASETS_DIR)
}
function keyOf(ref: AgentRef): string {
  return `${ref.slug}/${ref.stage}/${ref.round}/${ref.n}`
}

/** Reject anything a renderer could use to point us outside a run folder. */
function checkRef(ref: AgentRef): AgentRef {
  checkSlug(ref.slug)
  if (!STAGES.includes(ref.stage)) throw new Error('bad stage')
  if (!Number.isInteger(ref.round) || ref.round < 1) throw new Error('bad round')
  if (!Number.isInteger(ref.n) || ref.n < 1) throw new Error('bad agent')
  return ref
}
function checkSlug(slug: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error('bad slug')
  return slug
}

// --- Engine ------------------------------------------------------------------

type Send = (channel: string, ...args: unknown[]) => void

interface LiveAgent {
  proc: ChildProcess
  log: WriteStream
  stopped: boolean
  resultText: string | null
  resultError: boolean
  stderr: string
}

const EVENT_TAIL = 400

class FactoryEngine {
  private runs = new Map<string, FactoryRun>()
  private live = new Map<string, LiveAgent>()
  private tails = new Map<string, FactoryEvent[]>()
  private writes = new Map<string, Promise<void>>()
  private claude: Promise<{ bin: string; path: string } | null> | null = null

  constructor(
    private getRoot: () => Promise<string | null>,
    private send: Send
  ) {}

  // ---- persistence ----

  private async root(): Promise<string> {
    const r = await this.getRoot()
    if (!r) throw new Error('No library configured.')
    return r
  }

  async load(slug: string): Promise<FactoryRun | null> {
    checkSlug(slug)
    const cached = this.runs.get(slug)
    if (cached) return cached
    const root = await this.root()
    let run: FactoryRun
    try {
      run = JSON.parse(await fs.readFile(join(runDir(root, slug), 'run.json'), 'utf8'))
    } catch {
      return null
    }
    // Runs from before repo work existed have no `execute` stage at all.
    run.stages.execute ??= { status: 'pending', round: 0, agents: [] }
    run.config.stages.execute ??= { ...defaultConfig().stages.execute }
    // A run loaded from disk has no live processes: anything that claims to be
    // working was cut off by a quit or a crash.
    let dirty = false
    for (const id of STAGES) {
      const st = run.stages[id]
      for (const a of st.agents) {
        if (a.status === 'running' || a.status === 'queued') {
          a.status = 'failed'
          a.error = 'Interrupted — Lectern was closed while this agent was working.'
          a.endedAt ??= new Date().toISOString()
          dirty = true
        }
      }
      if (st.status === 'running') {
        st.status = 'failed'
        if (run.status === 'running') run.status = 'waiting'
        dirty = true
      }
    }
    this.runs.set(slug, run)
    if (dirty) await this.persist(run)
    return run
  }

  /** Serialised per run so concurrent agent exits can't interleave writes. */
  private persist(run: FactoryRun): Promise<void> {
    const prev = this.writes.get(run.slug) ?? Promise.resolve()
    const next = prev
      .catch(() => {})
      .then(async () => {
        const root = await this.root()
        const file = join(runDir(root, run.slug), 'run.json')
        await fs.writeFile(file + '.tmp', JSON.stringify(run, null, 2) + '\n')
        await fs.rename(file + '.tmp', file)
      })
    this.writes.set(run.slug, next)
    return next
  }

  private async save(run: FactoryRun): Promise<void> {
    await this.persist(run)
    this.send('factory:changed', run.slug)
  }

  async list(): Promise<FactorySummary[]> {
    const root = await this.root()
    let slugs: string[] = []
    try {
      slugs = (await fs.readdir(factoryDir(root), { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    } catch {
      return []
    }
    const out: FactorySummary[] = []
    for (const slug of slugs) {
      try {
        const run = await this.load(slug)
        if (!run) continue
        out.push({
          slug,
          title: run.title,
          created: run.created,
          status: run.status,
          current: run.current,
          currentStatus: run.current ? run.stages[run.current].status : null,
          verdict: run.verdict
        })
      } catch {
        /* not a run folder */
      }
    }
    return out.sort((a, b) => b.created.localeCompare(a.created))
  }

  async read(slug: string): Promise<FactoryDetail | null> {
    const run = await this.load(slug)
    if (!run) return null
    const root = await this.root()
    const dir = runDir(root, slug)
    const idea = await fs.readFile(join(dir, 'idea.md'), 'utf8').catch(() => '')
    return { run, dir, idea }
  }

  // ---- create / edit ----

  async create(title: string, idea: string, config: FactoryConfig): Promise<FactoryRun> {
    const root = await this.root()
    const slug = await uniqueSlug(root, slugify(title || idea))
    const empty = (): StageState => ({ status: 'pending', round: 0, agents: [] })
    const run: FactoryRun = {
      slug,
      title: title.trim() || firstLine(idea) || 'Untitled run',
      created: new Date().toISOString(),
      status: 'draft',
      config: normalizeConfig(config),
      stages: { lit: empty(), execute: empty(), empirics: empty(), convene: empty(), editor: empty() },
      current: null,
      decisions: []
    }
    await fs.mkdir(runDir(root, slug), { recursive: true })
    await fs.writeFile(join(runDir(root, slug), 'idea.md'), idea.trim() + '\n')
    await ensureGuide(runDir(root, slug), run.config.paper)
    await rememberPaper(run.config.paper)
    this.runs.set(slug, run)
    await this.save(run)
    return run
  }

  /** Title, idea and config stay editable; stages already run keep what they produced. */
  async update(slug: string, patch: { title?: string; idea?: string; config?: FactoryConfig }): Promise<FactoryRun | null> {
    const run = await this.load(slug)
    if (!run) return null
    const root = await this.root()
    if (patch.title !== undefined) run.title = patch.title.trim() || run.title
    if (patch.config) {
      run.config = normalizeConfig(patch.config)
      await rememberPaper(run.config.paper)
    }
    if (patch.idea !== undefined) {
      await fs.writeFile(join(runDir(root, slug), 'idea.md'), patch.idea.trim() + '\n')
    }
    await this.save(run)
    return run
  }

  async remove(slug: string): Promise<void> {
    const run = await this.load(slug)
    if (run) this.stopAll(run)
    const root = await this.root()
    this.runs.delete(slug)
    await fs.rm(runDir(root, checkSlug(slug)), { recursive: true, force: true })
    this.send('factory:changed', slug)
  }

  // ---- flow ----

  async start(slug: string): Promise<void> {
    const run = await this.load(slug)
    if (!run || run.status !== 'draft') return
    await this.startStage(run, 'lit')
  }

  /** Gate: carry on to the next stage (also "continue anyway" past failed agents). */
  async approve(slug: string, note?: string): Promise<void> {
    const run = await this.load(slug)
    if (!run || !run.current) return
    const id = run.current
    const st = run.stages[id]
    if (st.status !== 'gate' && st.status !== 'failed') return
    if (st.status === 'failed' && !st.agents.some((a) => a.status === 'done')) return
    run.decisions.push({ at: now(), stage: id, round: st.round, action: 'approve', note: note?.trim() || undefined })
    st.status = 'done'
    if (id === 'editor') return this.finish(run, 'accept')
    await this.startStage(run, nextStage(run.config, id)!, note?.trim() || undefined)
  }

  /** Gate: rerun `to` (this stage or an earlier one) with your note as feedback. */
  async sendBack(slug: string, to: StageId, note: string): Promise<void> {
    const run = await this.load(slug)
    if (!run || !run.current) return
    const from = run.current
    const st = run.stages[from]
    if (st.status !== 'gate' && st.status !== 'failed') return
    if (STAGES.indexOf(to) > STAGES.indexOf(from) || !stageOn(run.config, to)) return
    run.decisions.push({ at: now(), stage: from, round: st.round, action: 'sendBack', to, note: note.trim() || undefined })
    st.status = 'done'
    run.autoStop = undefined
    run.pending = { note: note.trim(), from, fromRound: st.round }
    await this.startStage(run, to)
  }

  /** Editor gate: the run is finished. */
  async accept(slug: string): Promise<void> {
    const run = await this.load(slug)
    if (!run || run.current !== 'editor') return
    const st = run.stages.editor
    if (st.status !== 'gate') return
    // Linked to a paper: the accepted text replaces the manuscript's own.
    // Throws (and leaves the gate open) if it can't be placed exactly.
    const landed = run.config.paper && run.config.deliverable !== 'memo' ? await this.landPaper(run) : null
    run.decisions.push({ at: now(), stage: 'editor', round: st.round, action: 'accept', note: landed ?? undefined })
    st.status = 'done'
    await this.finish(run, 'accept')
  }

  /**
   * Write the accepted text into manuscript.qmd: the Introduction, or for a
   * front-end run every front-end section the writer returned plus the
   * abstract. New sources the writer cited are resolved first, so their keys
   * already point at real entries. Returns what happened, for the decision log.
   */
  private async landPaper(run: FactoryRun): Promise<string> {
    const root = await this.root()
    const paper = run.config.paper!
    const conv = run.stages.convene
    const done = conv.agents.find((a) => a.status === 'done')
    if (!conv.round || !done) throw new Error('There is no finished draft to land.')
    const convDir = agentDir(root, { slug: run.slug, stage: 'convene', round: conv.round, n: done.n })
    const draft = await fs.readFile(join(convDir, 'output.md'), 'utf8')
    const qmdPath = join(paper.project, 'manuscript.qmd')
    const qmd = await fs.readFile(qmdPath, 'utf8')

    let next: string
    const what: string[] = []
    if (run.config.deliverable === 'frontend') {
      const fe = parseFrontEnd(draft)
      if (!fe.sections.length && !fe.abstract) throw new Error('The draft has no manuscript sections to land.')
      next = replaceSections(qmd, fe.sections)
      what.push(...fe.sections.map((x) => x.heading.replace(/^#\s+/, '').replace(/\s*\{[^}]*\}\s*$/, '')))
      if (fe.abstract) {
        const withAbstract = replaceAbstract(next, fe.abstract)
        if (withAbstract === null) throw new Error('manuscript.qmd has no `abstract:` in its front matter to replace.')
        next = withAbstract
        what.unshift('Abstract')
      }
    } else {
      const body = introBody(draft)
      if (!body) throw new Error('The convened output has no “# Introduction” section to land.')
      const replaced = replaceIntro(qmd, body)
      if (replaced === null) throw new Error('manuscript.qmd has no top-level “# Introduction” heading to replace.')
      next = replaced
      what.push('Introduction')
    }

    const sources = await this.resolveSources(root, paper, convDir)
    for (const [from, to] of sources.renames) {
      next = next.replace(new RegExp(`@${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w:-])`, 'g'), `@${to}`)
    }

    // Undo, twice over: a dated copy that survives anything, and a checkpoint so
    // the Review window shows the change with revert (no-op without git).
    const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '')
    const backup = join(paper.project, 'revisions', `${stamp} - manuscript before factory ${run.slug}.qmd`)
    await fs.mkdir(join(paper.project, 'revisions'), { recursive: true })
    await fs.writeFile(backup, qmd)
    await recordCheckpoint(paper.project, `Factory: ${what.join(', ')} from “${run.title}”`, null)
    await fs.writeFile(qmdPath, next)

    const notes = [`${what.join(', ')} written into manuscript.qmd; previous version saved as revisions/${basename(backup)}.`]
    if (sources.added.length) notes.push(`Added to the project's references: ${sources.added.join('; ')}.`)
    if (sources.todo.length) {
      const todo = join(paper.project, 'revisions', `${stamp} - sources to check.md`)
      await fs.writeFile(
        todo,
        `# Sources to check — factory run “${run.title}”\n\nCited in the text but not added automatically (no DOI, or the DOI did not resolve). Add each in References…, or fix the citation.\n\n${sources.todo.map((t) => `- ${t}`).join('\n')}\n`
      )
      notes.push(`${sources.todo.length} source(s) need you: revisions/${basename(todo)}.`)
    }
    return notes.join(' ')
  }

  /**
   * The writer lists every source it cited that isn't in a bibliography yet in
   * its `sources.json`. Keys already in the library or the project win (the
   * writer's key is renamed to theirs); anything with a DOI is fetched from
   * Crossref into the project's references; the rest is handed to you.
   */
  private async resolveSources(
    root: string,
    paper: PaperLink,
    convDir: string
  ): Promise<{ renames: Map<string, string>; added: string[]; todo: string[] }> {
    const out = { renames: new Map<string, string>(), added: [] as string[], todo: [] as string[] }
    let list: Array<{ key?: string; citation?: string; doi?: string; url?: string; verify?: string }> = []
    try {
      const raw = JSON.parse(await fs.readFile(join(convDir, 'sources.json'), 'utf8'))
      list = Array.isArray(raw) ? raw : Array.isArray(raw?.sources) ? raw.sources : []
    } catch {
      return out
    }
    const normDoi = (d?: string): string =>
      (d ?? '').trim().replace(/^\s*(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)/i, '').toLowerCase()
    const library = await listLibraryPapers(root)
    const keys = new Set(library.map((p) => p.citekey))
    const byDoi = new Map(library.filter((p) => p.doi).map((p) => [normDoi(p.doi), p.citekey]))
    for (const r of await listManualRefs(paper.project)) {
      keys.add(r.citekey)
      if (r.doi) byDoi.set(normDoi(r.doi), r.citekey)
    }
    for (const s of list) {
      const key = String(s.key ?? '').replace(/^@/, '').trim()
      if (!key || keys.has(key)) continue
      const doi = normDoi(s.doi)
      const known = doi ? byDoi.get(doi) : undefined
      if (known) {
        out.renames.set(key, known)
        continue
      }
      const meta = doi ? await fetchByDoi(doi).catch(() => null) : null
      if (meta?.title) {
        const refs = await addManualRef(paper.project, {
          citekey: key,
          type: 'article',
          title: meta.title,
          authors: meta.authors ?? [],
          year: meta.year ?? '',
          container: meta.journal ?? '',
          doi: meta.doi ?? doi,
          url: meta.url ?? s.url ?? ''
        })
        const actual = refs[refs.length - 1].citekey
        if (actual !== key) out.renames.set(key, actual)
        keys.add(actual)
        byDoi.set(doi, actual)
        out.added.push(`@${actual}`)
        continue
      }
      out.todo.push(
        `@${key} — ${s.citation ?? '(no citation given)'}${s.url ? ` — ${s.url}` : ''}${doi ? ` — DOI ${doi} did not resolve` : ''}${s.verify ? `\n  - Verify: ${s.verify}` : ''}`
      )
    }
    return out
  }

  async kill(slug: string): Promise<void> {
    const run = await this.load(slug)
    if (!run) return
    this.stopAll(run)
    if (run.current) {
      run.decisions.push({ at: now(), stage: run.current, round: run.stages[run.current].round, action: 'kill' })
    }
    run.status = 'killed'
    await this.save(run)
  }

  /** Rerun the failed or stopped agents of the current stage, same round. */
  async retry(slug: string): Promise<void> {
    const run = await this.load(slug)
    if (!run || !run.current) return
    const id = run.current
    const st = run.stages[id]
    if (st.status !== 'failed') return
    const root = await this.root()
    run.decisions.push({ at: now(), stage: id, round: st.round, action: 'retry' })
    for (const a of st.agents) {
      if (a.status !== 'failed' && a.status !== 'stopped') continue
      a.status = 'queued'
      a.sessionId = randomUUID()
      a.error = undefined
      a.costUsd = undefined
      a.startedAt = a.endedAt = undefined
      const dir = agentDir(root, { slug, stage: id, round: st.round, n: a.n })
      await fs.rm(join(dir, 'output.md'), { force: true })
      this.tails.delete(keyOf({ slug, stage: id, round: st.round, n: a.n }))
    }
    st.status = 'running'
    run.status = 'running'
    await this.save(run)
    this.pump(run, id)
  }

  stopAgent(ref: AgentRef): void {
    const live = this.live.get(keyOf(checkRef(ref)))
    if (!live) return
    live.stopped = true
    live.proc.kill('SIGTERM')
  }

  private stopAll(run: FactoryRun): void {
    for (const [key, live] of this.live) {
      if (!key.startsWith(run.slug + '/')) continue
      live.stopped = true
      live.proc.kill('SIGTERM')
    }
    for (const id of STAGES) {
      for (const a of run.stages[id].agents) {
        if (a.status === 'queued') a.status = 'stopped'
      }
    }
  }

  killAll(): void {
    for (const live of this.live.values()) {
      live.stopped = true
      try {
        live.proc.kill('SIGTERM')
      } catch {
        /* already gone */
      }
    }
  }

  private async finish(run: FactoryRun, _how: 'accept'): Promise<void> {
    run.status = 'done'
    run.current = null
    run.pending = undefined
    await this.save(run)
  }

  private async startStage(run: FactoryRun, id: StageId, carried?: string): Promise<void> {
    if (!stageOn(run.config, id)) return this.startStage(run, nextStage(run.config, id)!, carried)
    const root = await this.root()
    const cfg = run.config.stages[id]
    const st = run.stages[id]
    st.round += 1
    st.status = 'running'
    run.current = id
    run.status = 'running'
    if (id === 'editor') run.verdict = undefined
    const dir = roundDir(root, run.slug, id, st.round)
    await fs.mkdir(dir, { recursive: true })
    await ensureDatasets(root)
    await ensureGuide(runDir(root, run.slug), run.config.paper)

    const feedback = [
      run.pending ? `## Feedback from the ${STAGE_LABELS[run.pending.from].toLowerCase()} gate (round ${run.pending.fromRound})\n\n${run.pending.note || '(no note)'}` : '',
      run.pending?.from === 'editor'
        ? `The editor's report: ${join(roundDir(root, run.slug, 'editor', run.pending.fromRound))}/agent-*/output.md`
        : '',
      carried ? `## Note from the previous gate\n\n${carried}` : ''
    ]
      .filter(Boolean)
      .join('\n\n')
    if (feedback) await fs.writeFile(join(dir, 'FEEDBACK.md'), feedback + '\n')
    if (id === 'editor') run.pending = undefined

    if (id === 'lit' && run.config.paper?.litFiles.length) {
      await this.reuseLit(run, dir)
      return
    }

    const tasks = cfg.mode === 'split' ? await this.planTasks(root, run, id, cfg) : []
    st.agents = Array.from({ length: cfg.agents }, (_, i) => ({
      n: i + 1,
      sessionId: randomUUID(),
      status: 'queued' as const,
      task: tasks[i]
    }))
    await this.save(run)
    this.pump(run, id)
  }

  /**
   * The literature stage for a linked paper: no agent, just the project's own
   * literature notes, re-read each time the stage (re)runs so edits count.
   */
  private async reuseLit(run: FactoryRun, dir: string): Promise<void> {
    const paper = run.config.paper!
    const st = run.stages.lit
    const parts = [
      `# Literature (reused from the project)\n\nNot a new scan: these are the project's own notes from ${paper.project}.`
    ]
    for (const f of paper.litFiles) {
      const text = await fs.readFile(join(paper.project, f), 'utf8').catch(() => null)
      parts.push(text === null ? `## ${f}\n\n(missing)` : `## ${f}\n\n${text.trim()}`)
    }
    const agentPath = join(dir, 'agent-1')
    await fs.mkdir(agentPath, { recursive: true })
    await fs.writeFile(join(agentPath, 'output.md'), parts.join('\n\n') + '\n')
    const t = now()
    st.agents = [{ n: 1, sessionId: randomUUID(), status: 'done', task: `Reused: ${paper.litFiles.join(', ')}`, startedAt: t, endedAt: t }]
    // You wrote these files: there is nothing to review at a gate.
    st.status = 'done'
    await this.startStage(run, nextStage(run.config, 'lit')!)
  }

  /** Fill in split-mode sub-tasks you didn't write yourself. */
  private async planTasks(root: string, run: FactoryRun, id: StageId, cfg: StageConfig): Promise<string[]> {
    const given = cfg.tasks.map((t) => t.trim()).filter(Boolean).slice(0, cfg.agents)
    if (given.length >= cfg.agents) return given
    const missing = cfg.agents - given.length
    const idea = await fs.readFile(join(runDir(root, run.slug), 'idea.md'), 'utf8').catch(() => '')
    const context = (await this.inputFiles(root, run, id))
      .map((f) => f.text.slice(0, 6000))
      .join('\n\n---\n\n')
      .slice(0, 30000)
    const prompt =
      `You are planning the "${STAGE_LABELS[id]}" stage of a research project. ` +
      `${cfg.agents} agents will work in parallel, each on ONE distinct sub-task.\n\n` +
      `Research idea:\n${idea}\n\n` +
      (given.length ? `Sub-tasks already assigned:\n${given.map((t) => `- ${t}`).join('\n')}\n\n` : '') +
      (context ? `Work from earlier stages:\n${context}\n\n` : '') +
      `Propose exactly ${missing} more sub-task(s), non-overlapping with each other and with those assigned, ` +
      `each one sentence. Reply with JSON only: {"tasks": ["..."]}`
    const raw = await this.claudeOnce(prompt, 180_000)
    const parsed = raw ? parseJsonLoose(raw) : null
    const planned = Array.isArray(parsed?.tasks) ? (parsed!.tasks as unknown[]).map(String) : []
    const out = [...given, ...planned].slice(0, cfg.agents)
    while (out.length < cfg.agents) {
      out.push(`Angle ${out.length + 1} of ${cfg.agents}: pick an approach the other agents are unlikely to take and say which in your output.`)
    }
    return out
  }

  /** Start queued agents of `id` up to the run's parallel cap. */
  private pump(run: FactoryRun, id: StageId): void {
    const st = run.stages[id]
    let running = st.agents.filter((a) => a.status === 'running').length
    for (const a of st.agents) {
      if (running >= Math.max(1, run.config.maxParallel)) break
      if (a.status !== 'queued') continue
      a.status = 'running'
      a.startedAt = now()
      running++
      void this.launch(run, id, a).catch(async (e) => {
        a.status = 'failed'
        a.error = e instanceof Error ? e.message : String(e)
        a.endedAt = now()
        await this.settle(run, id)
      })
    }
    void this.save(run)
  }

  private async resolveClaude(): Promise<{ bin: string; path: string } | null> {
    this.claude ??= new Promise((resolve) => {
      const shell = process.env.SHELL || '/bin/zsh'
      execFile(shell, ['-lc', 'command -v claude; printf "%s" "$PATH"'], { timeout: 15_000 }, (err, stdout) => {
        if (err) return resolve(null)
        const [bin, ...rest] = stdout.toString().split('\n')
        resolve(bin?.trim() ? { bin: bin.trim(), path: rest.join('\n').trim() } : null)
      })
    })
    const got = await this.claude
    if (!got) this.claude = null // try again next time — maybe it gets installed
    return got
  }

  /** One-shot `claude -p` on the subscription login, for small planning calls. */
  private async claudeOnce(prompt: string, timeoutMs: number): Promise<string | null> {
    const claude = await this.resolveClaude()
    if (!claude) return null
    return new Promise((resolve) => {
      const child = execFile(
        claude.bin,
        ['-p', '--output-format', 'json'],
        { env: agentEnv(claude.path), timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => {
          if (err || !stdout) return resolve(null)
          try {
            const env = JSON.parse(stdout.toString()) as { result?: string; is_error?: boolean }
            resolve(env.is_error ? null : (env.result ?? null))
          } catch {
            resolve(null)
          }
        }
      )
      child.stdin?.on('error', () => {})
      child.stdin?.end(prompt)
    })
  }

  private async launch(run: FactoryRun, id: StageId, a: AgentState): Promise<void> {
    const root = await this.root()
    const ref: AgentRef = { slug: run.slug, stage: id, round: run.stages[id].round, n: a.n }
    const dir = agentDir(root, ref)
    await fs.mkdir(dir, { recursive: true })
    const claude = await this.resolveClaude()
    if (!claude) throw new Error('Claude Code was not found on your login shell’s PATH.')

    const prompt = await this.buildPrompt(root, run, id, a)
    await fs.writeFile(join(dir, 'prompt.md'), prompt)
    const cfg = run.config.stages[id]
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--session-id',
      a.sessionId,
      ...agentFlags(root, run.slug, cfg, run.config.paper, id)
    ]
    const env = agentEnv(claude.path)

    const key = keyOf(ref)
    // Repo work runs inside the repo, so the repo's own CLAUDE.md, hooks and
    // reviewer govern it exactly as they do your sessions there.
    const proc = spawn(claude.bin, args, { cwd: agentCwd(run, id, dir), env, stdio: ['pipe', 'pipe', 'pipe'] })
    const log = createWriteStream(join(dir, 'log.jsonl'), { flags: 'a' })
    const live: LiveAgent = { proc, log, stopped: false, resultText: null, resultError: false, stderr: '' }
    this.live.set(key, live)
    this.tails.set(key, [])
    this.emit(ref, { kind: 'info', text: a.task ? `Started — ${a.task}` : 'Started' })

    let buf = ''
    proc.stdout!.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        log.write(line + '\n')
        let msg: any
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.type === 'result') {
          live.resultText = typeof msg.result === 'string' ? msg.result : null
          live.resultError = Boolean(msg.is_error)
          if (typeof msg.total_cost_usd === 'number') a.costUsd = msg.total_cost_usd
        }
        for (const ev of summarize(msg)) this.emit(ref, ev)
      }
    })
    proc.stderr!.on('data', (chunk: Buffer) => {
      live.stderr = (live.stderr + chunk.toString('utf8')).slice(-4000)
    })
    proc.stdin!.on('error', () => {})
    proc.stdin!.end(prompt)

    proc.on('error', (e) => {
      live.stderr += `\n${e.message}`
    })
    proc.on('close', (code) => {
      log.end()
      this.live.delete(key)
      void (async () => {
        a.endedAt = now()
        const output = join(dir, 'output.md')
        const hasOutput = await exists(output)
        if (live.stopped) {
          a.status = 'stopped'
          this.emit(ref, { kind: 'info', text: 'Stopped' })
        } else if (code === 0 && !live.resultError) {
          // The brief asks for output.md; if the agent only answered in chat,
          // keep that answer rather than lose it.
          if (!hasOutput && live.resultText) await fs.writeFile(output, live.resultText + '\n')
          a.status = 'done'
        } else {
          a.status = 'failed'
          a.error = (live.resultError ? live.resultText : null) || lastLine(live.stderr) || `claude exited with code ${code}`
          this.emit(ref, { kind: 'error', text: a.error })
        }
        await this.settle(run, id)
      })()
    })
  }

  /** Called whenever an agent ends: launch the next queued one, or close the stage. */
  private async settle(run: FactoryRun, id: StageId): Promise<void> {
    const st = run.stages[id]
    if (run.status === 'killed') {
      await this.save(run)
      return
    }
    if (st.agents.some((a) => a.status === 'queued')) {
      this.pump(run, id)
      return
    }
    if (st.agents.some((a) => a.status === 'running')) {
      await this.save(run)
      return
    }
    if (st.agents.some((a) => a.status !== 'done')) {
      st.status = 'failed'
      run.status = 'waiting'
      await this.save(run)
      return
    }
    if (id === 'editor') {
      run.verdict = await this.readVerdict(run)
      run.verdicts = [...(run.verdicts ?? []), run.verdict ?? null]
      const auto = await this.autoNext(run)
      if (auto.to) {
        run.decisions.push({ at: now(), stage: 'editor', round: st.round, action: 'autoRevise', to: auto.to, note: auto.reason })
        st.status = 'done'
        run.autoStop = undefined
        run.pending = { note: auto.note!, from: 'editor', fromRound: st.round }
        await this.startStage(run, auto.to)
        return
      }
      run.autoStop = auto.reason
    }
    if (run.config.stages[id].gate || id === 'editor') {
      st.status = 'gate'
      run.status = 'waiting'
      await this.save(run)
      return
    }
    st.status = 'done'
    await this.startStage(run, nextStage(run.config, id)!)
  }

  /**
   * After an editor round: revise again automatically, or hand back to you?
   * Goes on while the verdict misses the target, rounds remain, and the last
   * automatic round improved the verdict. Routes to repo work when the editor
   * says the concerns need analysis and repo work is on; else to the writer.
   */
  private async autoNext(run: FactoryRun): Promise<{ to?: StageId; reason?: string; note?: string }> {
    const ar = run.config.autoRevise
    if (!ar?.on) return {}
    const order: Verdict[] = ['accept', 'minor', 'major', 'reject']
    const v = run.verdict
    if (!v) return { reason: 'Automatic revision stopped: the editor gave no verdict.' }
    if (order.indexOf(v) <= order.indexOf(ar.target)) {
      return { reason: `Verdict “${v}” meets the target (${ar.target} or better) — over to you.` }
    }
    // Automatic send-backs since your last decision (retries don't count).
    let auto = 0
    for (let i = run.decisions.length - 1; i >= 0; i--) {
      const a = run.decisions[i].action
      if (a === 'retry') continue
      if (a !== 'autoRevise') break
      auto++
    }
    if (auto >= ar.maxRounds) return { reason: `${ar.maxRounds} automatic revision${ar.maxRounds === 1 ? '' : 's'} used; verdict still “${v}”.` }
    const prev = run.verdicts && run.verdicts.length >= 2 ? run.verdicts[run.verdicts.length - 2] : null
    if (auto >= 1 && prev && order.indexOf(v) >= order.indexOf(prev)) {
      return { reason: `No improvement in the last automatic round (${prev} → ${v}) — over to you.` }
    }
    const to: StageId = (await this.readRoute(run)) === 'analysis' && stageOn(run.config, 'execute') ? 'execute' : 'convene'
    const n = auto + 1
    const note =
      `Automatic revision ${n} of at most ${ar.maxRounds} (editor verdict: ${v}). Address every major concern in the editor's report, and minor ones where it is cheap.` +
      (to === 'execute' ? ' This round starts with repo work, because the editor asked for new or repaired analyses.' : '') +
      ' Where a concern needs the researcher’s judgment (a choice of specification, sample or framing that changes what the paper claims), do not decide it: list it under “Decisions for the researcher”.'
    return { to, reason: `Automatic revision ${n}/${ar.maxRounds} → ${STAGE_LABELS[to]} (verdict ${v})`, note }
  }

  /** The editor's `ROUTE:` line — do the concerns need writing or analysis? */
  private async readRoute(run: FactoryRun): Promise<'writing' | 'analysis'> {
    const root = await this.root()
    const st = run.stages.editor
    for (const a of st.agents) {
      const text = await fs
        .readFile(join(agentDir(root, { slug: run.slug, stage: 'editor', round: st.round, n: a.n }), 'output.md'), 'utf8')
        .catch(() => '')
      const r = [...text.matchAll(/ROUTE:\s*\**\s*(writing|analysis)/gi)].at(-1)?.[1]?.toLowerCase()
      if (r === 'analysis') return 'analysis'
    }
    return 'writing'
  }

  private async readVerdict(run: FactoryRun): Promise<Verdict | undefined> {
    const root = await this.root()
    const order: Verdict[] = ['accept', 'minor', 'major', 'reject']
    let worst = -1
    const st = run.stages.editor
    for (const a of st.agents) {
      const text = await fs
        .readFile(join(agentDir(root, { slug: run.slug, stage: 'editor', round: st.round, n: a.n }), 'output.md'), 'utf8')
        .catch(() => '')
      const all = [...text.matchAll(/VERDICT:\s*\**\s*(accept|minor|major|reject)/gi)]
      const v = all.at(-1)?.[1]?.toLowerCase() as Verdict | undefined
      if (v) worst = Math.max(worst, order.indexOf(v))
    }
    return worst >= 0 ? order[worst] : undefined
  }

  // ---- events ----

  private emit(ref: AgentRef, ev: FactoryEvent): void {
    const key = keyOf(ref)
    const tail = this.tails.get(key) ?? []
    tail.push(ev)
    if (tail.length > EVENT_TAIL) tail.splice(0, tail.length - EVENT_TAIL)
    this.tails.set(key, tail)
    this.send('factory:event', { ...ref, event: ev })
  }

  /** The agent's activity so far — from memory if it ran this session, else its log. */
  async events(ref: AgentRef): Promise<FactoryEvent[]> {
    const key = keyOf(checkRef(ref))
    const tail = this.tails.get(key)
    if (tail) return tail
    const root = await this.root()
    const raw = await fs.readFile(join(agentDir(root, ref), 'log.jsonl'), 'utf8').catch(() => '')
    const out: FactoryEvent[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(...summarize(JSON.parse(line)))
      } catch {
        /* partial line */
      }
    }
    return out.slice(-EVENT_TAIL)
  }

  // ---- outputs ----

  async output(ref: AgentRef): Promise<string | null> {
    const root = await this.root()
    return fs.readFile(join(agentDir(root, checkRef(ref)), 'output.md'), 'utf8').catch(() => null)
  }

  async saveOutput(ref: AgentRef, content: string): Promise<void> {
    const root = await this.root()
    await fs.writeFile(join(agentDir(root, checkRef(ref)), 'output.md'), content)
    this.send('factory:changed', ref.slug)
  }

  async feedback(slug: string, stage: StageId, round: number): Promise<string | null> {
    const root = await this.root()
    checkRef({ slug, stage, round, n: 1 })
    return fs.readFile(join(roundDir(root, slug, stage, round), 'FEEDBACK.md'), 'utf8').catch(() => null)
  }

  /** Where and how to reopen an agent as an interactive Claude session. */
  async resume(ref: AgentRef): Promise<{ cwd: string; cmd: string } | null> {
    const run = await this.load(checkRef(ref).slug)
    const a = run?.stages[ref.stage].agents.find((x) => x.n === ref.n)
    if (!run || !a || run.stages[ref.stage].round !== ref.round) return null
    if (this.live.has(keyOf(ref))) return null
    const root = await this.root()
    const flags = agentFlags(root, run.slug, run.config.stages[ref.stage], run.config.paper, ref.stage).map(shq).join(' ')
    return { cwd: agentCwd(run, ref.stage, agentDir(root, ref)), cmd: `claude --resume ${a.sessionId} ${flags}` }
  }

  async openDir(slug: string): Promise<string> {
    const root = await this.root()
    return platform.openPath(runDir(root, checkSlug(slug)))
  }

  // ---- prompts ----

  /** Outputs of every stage before `id`, latest round of each. */
  private async inputFiles(root: string, run: FactoryRun, id: StageId): Promise<{ stage: StageId; path: string; text: string }[]> {
    const out: { stage: StageId; path: string; text: string }[] = []
    for (const s of STAGES.slice(0, STAGES.indexOf(id))) {
      const st = run.stages[s]
      if (!st.round) continue
      for (const a of st.agents) {
        if (a.status !== 'done') continue
        const path = join(agentDir(root, { slug: run.slug, stage: s, round: st.round, n: a.n }), 'output.md')
        const text = await fs.readFile(path, 'utf8').catch(() => null)
        if (text !== null) out.push({ stage: s, path, text })
      }
    }
    return out
  }

  private async buildPrompt(root: string, run: FactoryRun, id: StageId, a: AgentState): Promise<string> {
    const cfg = run.config.stages[id]
    const st = run.stages[id]
    const dir = runDir(root, run.slug)
    const inputs = await this.inputFiles(root, run, id)
    const list = (s: StageId): string =>
      inputs
        .filter((f) => f.stage === s)
        .map((f) => `- ${f.path}`)
        .join('\n') || '- (none)'
    const prevRound =
      st.round > 1
        ? join(roundDir(root, run.slug, id, st.round - 1), `agent-${a.n}`, 'output.md')
        : null
    const feedbackFile = join(roundDir(root, run.slug, id, st.round), 'FEEDBACK.md')
    const hasFeedback = await exists(feedbackFile)
    const ds = datasetsDir(root)

    const parts: string[] = []
    parts.push(`# ${STAGE_LABELS[id]} — ${run.title}\n`)
    parts.push(`The research idea is in ${join(dir, 'idea.md')}. Read it first.`)

    const frontend = run.config.deliverable === 'frontend'
    const intro = run.config.deliverable === 'intro' || frontend
    const guide = join(dir, 'INTRO_GUIDE.md')
    const paper = run.config.paper ?? null
    const routes = stageOn(run.config, 'execute')
    if (paper) parts.push(await paperContext(paper))
    if (id === 'lit') {
      parts.push(LIT_BRIEF(root))
      if (intro) parts.push(LIT_FRAMING(guide))
    } else if (id === 'execute') {
      parts.push(EXECUTE_BRIEF(paper!.empirics!, agentDir(root, { slug: run.slug, stage: id, round: st.round, n: a.n }), paper!.project))
    } else if (id === 'empirics') {
      parts.push(`Literature scan reports:\n${list('lit')}`)
      if (routes) parts.push(`Repo work done in this run (read it first — it says what changed and what was re-rendered):\n${list('execute')}`)
      parts.push(paper?.empirics ? EVIDENCE_BRIEF(paper.empirics) : EMPIRICS_BRIEF(ds))
    } else if (id === 'convene' && frontend && paper) {
      parts.push(
        `Literature notes:\n${list('lit')}\n\nEvidence briefs (what the reviewed results support, with status):\n${list('empirics')}`
      )
      parts.push(await reviseIntro(paper))
      parts.push(CONVENE_FRONTEND(run.config.stages.empirics.mode, writingModels(root, guide), await frontEndHeadings(paper)))
      parts.push(NEW_SOURCES(paper))
    } else if (id === 'convene') {
      parts.push(
        `Literature scan reports:\n${list('lit')}\n\n${paper?.empirics ? 'Evidence briefs (what the reviewed results support, with status)' : "Analyst reports (each analyst's code and results sit next to their output.md)"}:\n${list('empirics')}`
      )
      if (paper && intro) parts.push(await reviseIntro(paper))
      parts.push(intro ? CONVENE_INTRO(run.config.stages.empirics.mode, writingModels(root, guide)) : CONVENE_BRIEF(run.config.stages.empirics.mode))
      if (paper && intro) parts.push(NEW_SOURCES(paper))
    } else {
      parts.push(
        `Literature scan reports:\n${list('lit')}\n\n${paper?.empirics ? 'Evidence briefs' : 'Analyst reports (code and results next to each)'}:\n${list('empirics')}\n\n${frontend ? 'The submitted front end (abstract, introduction, hypotheses)' : intro ? 'The submitted introduction' : 'The convened draft'}:\n${list('convene')}`
      )
      parts.push(intro ? EDITOR_INTRO(cfg.agents > 1, guide) : EDITOR_BRIEF(cfg.agents > 1))
      if (frontend) parts.push(EDITOR_FRONTEND)
      if (routes) parts.push(EDITOR_ROUTE)
      if (paper?.empirics) {
        parts.push(
          `## The evidence briefs are the authority\n\nThey list what the reviewed results in ${paper.empirics} support and with what status. An introduction claim that rests on a result not in the briefs, on a draft render, on a result under an open REVISE, or that states a Sensitive or Fragile result as if it were Robust, is a major concern.`
        )
      }
    }

    if (cfg.mode === 'split' && a.task) {
      parts.push(`## Your sub-task\n\n${a.task}\n\nOther agents cover the other sub-tasks of this stage in parallel; stay on yours.`)
    } else if (cfg.agents > 1) {
      parts.push(
        `## Working independently\n\nYou are agent ${a.n} of ${cfg.agents} given this same brief. Do not look at or coordinate with the others' folders — independent attempts are the point.`
      )
    }
    if (prevRound && (await exists(prevRound))) {
      parts.push(`## This is a revision\n\nYour previous round's output: ${prevRound}\nBuild on it rather than starting over, unless the feedback says otherwise.`)
    }
    if (hasFeedback) parts.push(`## Feedback you must address\n\nRead ${feedbackFile} and address every point. Say in your output how you addressed each.`)
    if (cfg.instructions.trim()) parts.push(`## Additional instructions from the researcher\n\n${cfg.instructions.trim()}`)
    if (id !== 'execute') parts.push(
      `## Deliverable\n\nWrite your deliverable to ./output.md (in your current directory). Keep every other file you create inside the current directory${id === 'empirics' && !paper?.empirics ? ', except datasets you register for reuse' : ''}.${paper ? ` You cannot write to ${paper.project}${paper.empirics ? ` or ${paper.empirics}` : ''}: they are read-only for you.` : ''}`
    )
    return parts.join('\n\n') + '\n'
  }
}

// --- Briefs ------------------------------------------------------------------

const SYSTEM = `You are one agent in a Lectern research factory run. Nobody will answer questions while you work: make reasonable decisions, record them and the reason in your output, and keep going. Never invent a citation, a dataset, or a number — anything you could not verify, mark as unverified.`

const LIT_BRIEF = (root: string): string => `## Your job: literature scan

1. Start with the researcher's own library: the bibliography at ${join(root, CONFIG_DIR, 'references.bib')} and the PDFs in ${join(root, 'sources')}. Grep the .bib for relevant keywords; open PDFs only where the abstract is not enough.
2. Then search the web (Google Scholar, SSRN, NBER, journal sites) for work the library is missing.
3. Write output.md with:
   - **Key papers** — for each: reference, one-line contribution, method, data.
   - **What is established** and **open questions / gaps**.
   - **Where the idea sits** — how close the nearest papers come, and the risk that it has been done.
   - **Data sources and identification strategies** used by prior work that this project could reuse.
   - **Papers to add to the library** — references found on the web, with DOI or URL.

Cite library papers as [@citekey] using the keys in references.bib. Give everything else as a full reference with DOI or URL.`

const LIT_FRAMING = (guide: string): string => `## Framing material for the introduction

The run ends in an introduction framed as a test of a regulator's own promise — read the sections "The hook" and "The gap" of the framing guide at ${guide}. Add a **Framing material** section to output.md with:
- **The regulator's stated goal, in its own words** — exact quote, document, and page or paragraph. Only quotes you have read in the source itself.
- **One number that shows scale** (frequency, share, effort), with its source.
- **Calls for research** this idea answers, each with a pinpoint (section or page).
- **The gap**, in one sentence, and its type: scope, observability, or linkage.
- **Candidate theories** that predict a hidden cost next to the regulator's intended benefit, and which one fits the setting best.`

/** The writing models that exist in this library, as a bullet list of paths. */
function writingModels(root: string, guide: string): string {
  const anatomy = join(root, 'anatomy')
  const items: Array<[string, string]> = [
    [guide, 'the framing guide — spine, hook, gap types, theory approaches, hypothesis patterns, paragraph table, pitfalls, checklist. Read it in full.'],
    [join(anatomy, 'SYNTHESIS.md'), 'cross-paper comparison of how the model papers build their argument'],
    [join(anatomy, 'papers'), 'one folder per model paper; `anatomy.md` is the readable dissection, `paragraphs.csv` the paragraph-level coding (see CODEBOOK.md). Read the 2–3 closest to this paper.'],
    [join(root, CONFIG_DIR, 'WRITING_RULES.md'), "the researcher's rules for any AI writing — follow them"],
    [join(root, CONFIG_DIR, 'model-papers.md'), 'section-by-section voice and claim-strength patterns — follow them']
  ]
  return items
    .filter(([p]) => p === guide || existsSync(p))
    .map(([p, what]) => `- ${p} — ${what}`)
    .join('\n')
}

const CONVENE_INTRO = (mode: 'independent' | 'split', models: string): string => `## Your job: write the introduction

You are the lead author. The analysts' reports are the evidence, the literature scan is the positioning, and your deliverable is the paper's introduction.

1. **Settle what the paper can claim.** Read every analyst report, and their code and results where you need to check something. ${
  mode === 'independent'
    ? 'They attacked the same question independently: decide where they agree, where they disagree, and why (data, sample, specification). Claim only what survives across analysts, or say how far it holds.'
    : 'Each worked on a different piece: integrate them into one argument and note where the pieces do not yet fit.'
}
2. **Study the writing models** — copy their moves and sentence shapes, never cite them unless they are genuinely relevant and in references.bib:
${models}
3. **Write output.md** with these sections:
   - \`# Introduction\` — 13–17 paragraphs following the guide's spine and paragraph-by-paragraph table: the regulator's promise, one number and the research question in ¶1; the gap as an untested promise of a named type; the theory in one paragraph with its rival; the findings, crediting the regulator before the cost; the identification threat and its answers; cross-sections drawn from the theory; contributions that answer named calls; the main caveat next to the claim it qualifies. No roadmap paragraph.
   - \`## Framing choices\` — the spine in three lines (promise, hidden cost, answer), and which hook, gap type, theory approach and hypothesis pattern (A, B or C) you chose, and why.
   - \`## Evidence base\` — a table mapping every empirical claim in the introduction to the analyst and results file it comes from, plus where analysts disagree.
   - \`## Open items\` — every [SOURCE NEEDED] and every claim the evidence does not yet support.

Cite as [@citekey] only keys that exist in references.bib. Where a sentence needs a source you do not have — a regulator quote, a call for research, a number — write [SOURCE NEEDED: what kind] instead. Never invent a quote, a number or a call.`

const EDITOR_INTRO = (several: boolean, guide: string): string => `## Your job: referee the introduction

You are the editor of a top accounting journal${several ? ', one of several referees reviewing independently' : ''}. The submission is the introduction; behind it sit the analysts' reports with code and results. Your rubric is the framing guide at ${guide} — read it in full first. Number the introduction's paragraphs ¶1, ¶2, … so you can point to them.

Write output.md as a referee report:
1. **Verdict in three lines** — the spine as it stands, the single biggest problem, the fix that would most improve the paper.
2. **Spine test** — read only the first and last sentence of the introduction. Can you name the promise, the hidden cost and the answer? Say what you get.
3. **Checklist** — every item of the guide's "Checklist before submission": ✅ / ⚠️ / ❌, the ¶ where you found it (quote at most one sentence), and for anything not ✅ a concrete fix, ideally a rewritten sentence in the paper's own terms using the guide's templates.
4. **Pitfalls** — only those from the guide's table that actually occur.
5. **Paragraph map** — the job each ¶ does against the guide's table; paragraphs that do no job, jobs with no paragraph, order problems.
6. **Evidence check** — does every empirical claim match the analysts' results? Check the Evidence base table and open results files where it matters. Overclaiming, or causal language the design cannot carry, is a major concern.
7. **Novelty** — against the literature scan: has this been done, and is the contribution stated so that it answers someone?

Be demanding but fair. End the report with exactly one final line of the form
VERDICT: accept | minor | major | reject
(using one of the four words).`

/** Where the paper lives, so every stage knows what it may read. */
async function paperContext(paper: PaperLink): Promise<string> {
  const p = paper.project
  const style = ['.claude/CLAUDE.md', 'WRITING_STYLE.md', 'LEARNED_EDITS.md'].filter((f) => existsSync(join(p, f)))
  const lines = [
    `## The paper\n\nThis run works on an existing paper. Both folders are read-only for you.`,
    `- Writing project: ${p} — manuscript.qmd is the paper${style.length ? `; house style in ${style.join(', ')} (LEARNED_EDITS.md wins over everything)` : ''}.`
  ]
  if (paper.empirics) {
    lines.push(
      `- Empirics repo: ${paper.empirics} — data, pipeline and reviewed results. Its CLAUDE.md and PRINCIPLES.md describe the rules the results were produced under.`
    )
  }
  return lines.join('\n')
}

/** For the intro writer of a linked paper: start from what is already there. */
async function reviseIntro(paper: PaperLink): Promise<string> {
  let drafts: string[] = []
  try {
    drafts = (await fs.readdir(paper.project)).filter((f) => /intro/i.test(f) && f.endsWith('.md')).sort()
  } catch {
    /* unreadable project */
  }
  return `## Revise, don't start over

The paper already has an introduction: the \`# Introduction\` section of ${join(paper.project, 'manuscript.qmd')}${
    drafts.length ? `, and draft versions in the project folder: ${drafts.join(', ')} (their HTML comments record why they were written as they are)` : ''
  }. Read them, and the hypotheses section of manuscript.qmd, before writing. Keep what works; your Introduction will replace the manuscript's when the researcher accepts it, so write it as manuscript-ready Quarto markdown: \`[@citekey]\` citations, \`@sec-…\` cross-references to sections that exist in manuscript.qmd, the manuscript's variable naming.`
}

const EVIDENCE_BRIEF = (repo: string): string => `## Your job: the evidence brief

The analyses for this paper already exist in ${repo}. You do not run or change anything — you establish what the reviewed results support, so the introduction claims exactly that.

1. Read ${join(repo, 'CLAUDE.md')} and ${join(repo, 'PRINCIPLES.md')} for how results are produced and what counts as final. Then docs/analysis-plan.md and the latest entries of docs/decisions.md.
2. Results come from the final renders only: output/tables/ and output/notebooks/*.pdf. **Never** take a number from output/draft/ — draft renders are not results.
3. For each result, find its review in reviews/: the newest review covering that exhibit, its verdict (PASS / PASS-WITH-NOTES / REVISE), its status line (Robust / Sensitive / Fragile / Null) and any open must-fix items or author overrides.

Write output.md with:
- **Headline results** — a table: claim in one plain sentence · exhibit / file · estimate, N and the comparison it is measured against · status · review file and verdict.
- **What the introduction may say** — per result, the strongest sentence the evidence supports, in associational language unless the design earns causal language.
- **Not usable yet** — results under an open REVISE, draft-only, or failed, with the reason.
- **Numbers the introduction will want** — sample size, scale facts and magnitudes, each with its file.

Never estimate, recompute or round a number yourself beyond copying it; if a figure you need is not in a final output, list it under "Not usable yet".`

const EXECUTE_BRIEF = (repo: string, outDir: string, project: string): string => `## Your job: repo work

You are working inside the empirics repo ${repo} — it is your current directory. Its CLAUDE.md and PRINCIPLES.md are binding. Follow the repo's workflow for every empirical change exactly: the decision in docs/decisions.md first, constants in code/config.yml, codebook entries, a draft render, the review checklist, the empirical-reviewer subagent, fixes until the review passes, then one final render. The repo's Stop hook will not let you finish while code changes are unreviewed; that is intended — satisfy it, never work around it.

What to do:
- **No feedback file (first pass):** bring the results the paper relies on to a reviewed, final state. Find the newest review for each analysis in reviews/. Where the newest is REVISE, a render crashed, or the final outputs are older than the code, fix the must-fix items and re-render. Do not start new analyses.
- **With feedback (the editor's report):** implement the analyses it asks for that this repo can answer, through the same workflow. Skip what is pure writing.

Limits:
- Never modify data/raw/. Never commit or push. Never touch the writing project (${project}).
- A choice between specifications, samples or framings that changes what the paper claims is the researcher's call. Do not make it: implement both if cheap, otherwise list it under "Decisions for the researcher".
- You are done when every item you took on has a PASS or PASS-WITH-NOTES review and a final render, or you have written down why it cannot be done.

## Deliverable

Write your report to ${join(outDir, 'output.md')} — that path, not inside the repo. It must say: what you changed (files); the decisions.md entries you added; the reviews you wrote, with verdicts; the final renders you produced, with each result and its status; what is still open; and "Decisions for the researcher".`

const EDITOR_FRONTEND = `## The submission is the whole front end

Besides the introduction, referee the abstract and the hypotheses section:
- Do the abstract, the introduction and the hypotheses tell the same story, with the same predictions, numbering and direction of effects?
- Apply the guide's "From theory to hypotheses" rules to the hypotheses: one pattern kept throughout, a counter-argument for every hypothesis, alternative vs null form stated and justified, each hypothesis translated into a coefficient sign, every moderator traced back to an H1 argument.
- Does the abstract claim only what the evidence briefs support?`

const EDITOR_ROUTE = `## Route

Just before the VERDICT line, add one line saying what the revision mainly needs:
ROUTE: writing — the concerns can be met by rewriting with the evidence that exists
ROUTE: analysis — new or repaired analyses are needed first`

/** For writers on a linked paper: cite new sources properly; Lectern files them on accept. */
const NEW_SOURCES = (paper: PaperLink): string => `## New sources

Existing keys live in the library's references.bib and the project's ${join(paper.project, '.lctrn', 'extra.bib')}. When you need a source that is in neither but you know what it is (say, Stigler 1961), still cite it as [@surnameYEAR] and list it in ./sources.json:

[{"key": "stigler1961", "citation": "Stigler, G. J. (1961). The economics of information. Journal of Political Economy 69(3).", "doi": "10.1086/258464", "url": "", "verify": ""}]

Look the DOI up (doi.org, Crossref) for anything published with one — those are added to the project's references automatically when the researcher accepts. For legal texts, standards and reports give the URL, and in "verify" the exact passage or quote the researcher must check. Use [SOURCE NEEDED: …] only when you cannot identify a source at all. Never invent a DOI.`

const CONVENE_FRONTEND = (mode: 'independent' | 'split', models: string, headings: string[]): string => `## Your job: write the paper's front end

You are the lead author. Rewrite the abstract, the introduction and the theory / hypotheses section so they tell one consistent story that the evidence supports.

1. **Settle what the paper can claim** from the evidence briefs${mode === 'split' ? ' (they cover different parts of the evidence)' : ''}. Claim nothing beyond them; say how far Sensitive results hold.
2. **Study the writing models** — copy their moves and sentence shapes, never cite them unless they are genuinely relevant and in a bibliography:
${models}
3. **Write output.md in exactly this structure:**
   - \`# Abstract\` — one paragraph, as the manuscript's abstract, no citations.
   - Then each front-end section of manuscript.qmd that you rewrite, starting with its heading line copied exactly from the manuscript — these are the front-end sections:
${headings.map((h) => `     - \`${h}\``).join('\n') || '     - (none found — write only `# Introduction`)'}
     A section includes all its subsections; keep the subsections' {#sec-…} anchors so cross-references elsewhere still resolve. Leave out a section you do not change.
   - The introduction follows the guide's spine and paragraph table, as before. The hypotheses follow the guide's "From theory to hypotheses" rules: one pattern (A, B or C) throughout, a counter-argument for every hypothesis, alternative or null form stated and justified, each hypothesis translated into a coefficient sign, moderators only from the H1 arguments. Introduction and hypotheses use the same predictions and numbering.
   - \`# Notes for the researcher\` — with \`## Framing choices\` (the spine in three lines; hook, gap type, theory approach, hypothesis pattern, and why), \`## Evidence base\` (every empirical claim → the brief and results file it rests on), \`## Open items\`, and \`## Decisions for the researcher\`. Nothing from this heading on goes into the manuscript.

Write manuscript-ready Quarto markdown: [@citekey] citations, @sec-… cross-references to sections that exist, the manuscript's variable naming. Never invent a quote, a number or a call for research.`

const EMPIRICS_BRIEF = (ds: string): string => `## Your job: run an empirical analysis of the idea

Data:
- First check the researcher's dataset registry in ${ds}: read INDEX.md, then list the folders — the researcher also adds datasets by hand, so a folder can exist before INDEX.md mentions it. Each folder's README.md says what is in it. Reuse these instead of fetching again; never modify them.
- If you download data that is useful beyond this run, save it to ${ds}/<short-name>/ with a README.md (source URL, retrieval date, licence, coverage, key variables) and add one line to INDEX.md. Run-specific extracts stay in your own folder.
- Credentials (e.g. WRDS) are only available if they are already set up in this environment. If a source needs access you don't have, say so and use the best public alternative.

Work in your current directory: code in code/, intermediate data in data/, tables and figures in results/. Use Python or R.

Write output.md with: research design and hypotheses, data (sources, sample, variable construction), identification, main results (markdown tables), robustness checks, limitations, and the exact commands to reproduce everything. Every number in the report must come from code you ran. A null or contrary result is a result — report it plainly.`

const CONVENE_BRIEF = (mode: 'independent' | 'split'): string =>
  mode === 'independent'
    ? `## Your job: convene the analysts

The analysts attacked the same question independently. Read every report (and their code and results where you need to check something). Then write output.md as a results memo:
- Where the analyses **agree**, where they **disagree**, and why (data, sample, specification, identification).
- How robust the core finding is across analysts — a consolidated table naming which analyst each estimate comes from.
- The research question and contribution relative to the literature scan.
- The design you would put in the paper, threats to validity, and the analyses still missing.`
    : `## Your job: convene the analysts

Each analyst worked on a different piece of the study. Read every report (and their code and results where you need to check something), then write output.md integrating the pieces into one coherent results memo: research question, contribution relative to the literature scan, data, design, consolidated results (naming which analyst each comes from), robustness, threats to validity, and what is still missing.`

const EDITOR_BRIEF = (several: boolean): string => `## Your job: critical editorial review

You are the editor of a top journal in this field${several ? ', one of several referees reviewing independently' : ''}. Review the convened draft as a submission, checking claims against the analysts' reports, code and results where it matters. Write output.md as a referee report:
- Summary of the submission.
- Contribution and novelty, measured against the literature scan.
- **Major concerns** — identification, data, inference, interpretation. For each, what analysis would resolve it.
- Minor concerns.
- Your recommendation and why.

Be demanding but fair. End the report with exactly one final line of the form
VERDICT: accept | minor | major | reject
(using one of the four words).`

// --- Helpers -----------------------------------------------------------------

const STANDARD_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Edit',
  'Write',
  'WebSearch',
  'WebFetch',
  'TodoWrite',
  ...[
    'python', 'python3', 'pip', 'pip3', 'uv', 'Rscript', 'R', 'curl', 'wget', 'unzip', 'gunzip', 'tar',
    'ls', 'head', 'tail', 'wc', 'cat', 'mkdir', 'cp', 'mv', 'find', 'sort', 'jq', 'file', 'du'
  ].map((c) => `Bash(${c} *)`)
]

/**
 * The environment every factory process runs in. Claude Code uses an API key
 * whenever one is present in preference to your plan login, so the key
 * variables are removed: factory runs always bill your Pro/Max subscription.
 */
function agentEnv(loginPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: loginPath || process.env.PATH }
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ELECTRON_RUN_AS_NODE', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']) {
    delete env[k]
  }
  return env
}

/** Shell commands that only look. Used for runs on a linked paper. */
const READ_ONLY_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Edit',
  'Write',
  'WebSearch',
  'WebFetch',
  'TodoWrite',
  ...['ls', 'head', 'tail', 'wc', 'cat', 'find', 'sort', 'du', 'file', 'jq', 'pdftotext', 'git log', 'git status', 'git diff', 'git show'].map(
    (c) => `Bash(${c} *)`
  )
]

/** What repo work may run: the repo's own toolchain, its reviewer subagent, and looking around. */
const EXECUTE_TOOLS = [
  ...READ_ONLY_TOOLS,
  'Task',
  'Agent',
  'NotebookEdit',
  ...['cd', 'make', 'uv', 'Rscript', 'R', 'quarto', 'python', 'python3', 'mkdir', 'cp', 'mv', 'UV_PROJECT_ENVIRONMENT=*'].map((c) => `Bash(${c} *)`)
]

/** Where an agent works: repo work inside the repo, everyone else in their own folder. */
function agentCwd(run: FactoryRun, id: StageId, dir: string): string {
  return id === 'execute' && run.config.paper?.empirics ? run.config.paper.empirics : dir
}

function agentFlags(root: string, slug: string, cfg: StageConfig, paper?: PaperLink | null, stage?: StageId): string[] {
  const dirs = [runDir(root, slug), join(root, CONFIG_DIR), join(root, 'sources'), datasetsDir(root)]
  // The paragraph-level anatomies of model papers, when the library has them.
  if (existsSync(join(root, 'anatomy'))) dirs.push(join(root, 'anatomy'))
  if (stage === 'execute' && paper?.empirics) {
    // Writes go to the repo (its own hooks review them) — but never to its raw
    // data, never to the writing project, and nothing leaves the machine via git.
    const rawData = join(paper.empirics, 'data', 'raw')
    const deny = [
      ...['Edit', 'Write', 'NotebookEdit'].flatMap((t) => [`${t}(/${paper.project}/**)`, `${t}(/${rawData}/**)`]),
      'Bash(git commit *)',
      'Bash(git push *)',
      'Bash(rm -rf *)'
    ]
    return [
      ...[...dirs, paper.project].flatMap((d) => ['--add-dir', d]),
      '--append-system-prompt',
      SYSTEM,
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      EXECUTE_TOOLS.join(','),
      '--disallowedTools',
      deny.join(',')
    ]
  }
  if (paper) {
    // A linked paper's folders are readable, never writable: edits there are
    // denied outright (absolute-path rules are written `//abs/path`), and the
    // shell is cut down to commands that only look. Full autonomy would skip
    // these rules, so it is off for linked runs.
    const locked = [paper.project, ...(paper.empirics ? [paper.empirics] : [])]
    return [
      ...[...dirs, ...locked].flatMap((d) => ['--add-dir', d]),
      '--append-system-prompt',
      SYSTEM,
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      READ_ONLY_TOOLS.join(','),
      '--disallowedTools',
      locked.flatMap((d) => ['Edit', 'Write', 'NotebookEdit'].map((t) => `${t}(/${d}/**)`)).join(',')
    ]
  }
  return [
    ...dirs.flatMap((d) => ['--add-dir', d]),
    '--append-system-prompt',
    SYSTEM,
    ...(cfg.autonomy === 'full'
      ? ['--dangerously-skip-permissions']
      : ['--permission-mode', 'acceptEdits', '--allowedTools', STANDARD_TOOLS.join(',')])
  ]
}

/** Turn one stream-json message into the few lines worth showing. */
function summarize(msg: any): FactoryEvent[] {
  if (msg?.type === 'system' && msg.subtype === 'init') {
    // 'none' means no key was found: the session runs on the plan login.
    const auth = !msg.apiKeySource || msg.apiKeySource === 'none' ? 'Claude plan login' : `API key (${msg.apiKeySource})`
    const ev: FactoryEvent = { kind: 'info', text: `Session ${String(msg.session_id).slice(0, 8)} · ${msg.model ?? ''} · ${auth}` }
    return auth.startsWith('API')
      ? [ev, { kind: 'error', text: 'This agent is billing an API key, not your Claude plan — check the key Claude Code is configured with (apiKeyHelper in its settings).' }]
      : [ev]
  }
  if (msg?.type === 'assistant') {
    const out: FactoryEvent[] = []
    for (const c of msg.message?.content ?? []) {
      if (c.type === 'text' && c.text?.trim()) out.push({ kind: 'text', text: c.text.trim() })
      if (c.type === 'tool_use') out.push({ kind: 'tool', text: `${c.name} ${brief(c.input)}`.trim() })
    }
    return out
  }
  if (msg?.type === 'user') {
    const out: FactoryEvent[] = []
    for (const c of msg.message?.content ?? []) {
      if (c.type === 'tool_result' && c.is_error) {
        const text = typeof c.content === 'string' ? c.content : JSON.stringify(c.content)
        out.push({ kind: 'error', text: text.slice(0, 300) })
      }
    }
    return out
  }
  if (msg?.type === 'result') {
    const cost = typeof msg.total_cost_usd === 'number' ? ` · ≈$${msg.total_cost_usd.toFixed(2)} API-equivalent` : ''
    const turns = msg.num_turns ? ` · ${msg.num_turns} turns` : ''
    return [{ kind: msg.is_error ? 'error' : 'done', text: `${msg.is_error ? 'Failed' : 'Finished'}${cost}${turns}` }]
  }
  return []
}

function brief(input: any): string {
  if (!input || typeof input !== 'object') return ''
  const v = input.command ?? input.file_path ?? input.pattern ?? input.query ?? input.url ?? input.description ?? ''
  const s = String(v).replace(/\s+/g, ' ')
  return s.length > 160 ? s.slice(0, 157) + '…' : s
}

function normalizeConfig(c: FactoryConfig): FactoryConfig {
  const d = defaultConfig()
  const stages = {} as Record<StageId, StageConfig>
  for (const id of STAGES) {
    const s = { ...d.stages[id], ...(c?.stages?.[id] ?? {}) }
    stages[id] = {
      agents: Math.min(10, Math.max(1, Math.round(Number(s.agents) || 1))),
      mode: s.mode === 'split' ? 'split' : 'independent',
      tasks: (Array.isArray(s.tasks) ? s.tasks : []).map(String).map((t) => t.trim()).filter(Boolean),
      instructions: String(s.instructions ?? ''),
      gate: id === 'editor' ? true : Boolean(s.gate),
      autonomy: s.autonomy === 'full' ? 'full' : 'standard',
      ...(id === 'execute' ? { enabled: Boolean(s.enabled) } : {})
    }
  }
  stages.execute.agents = 1
  stages.execute.mode = 'independent'
  stages.convene.agents = 1
  stages.convene.mode = 'independent'
  stages.editor.mode = 'independent'
  const paper = normalizePaper(c?.paper)
  if (paper) {
    for (const id of STAGES) stages[id].autonomy = 'standard'
  }
  // Repo work needs a repo to work in.
  if (!paper?.empirics) stages.execute.enabled = false
  const ar = (c?.autoRevise ?? d.autoRevise)!
  return {
    deliverable: paper ? (c?.deliverable === 'frontend' ? 'frontend' : 'intro') : c?.deliverable === 'memo' ? 'memo' : 'intro',
    autoRevise: {
      on: Boolean(ar.on),
      target: ar.target === 'accept' ? 'accept' : 'minor',
      maxRounds: Math.min(6, Math.max(1, Math.round(Number(ar.maxRounds) || 3)))
    },
    paper,
    stages,
    maxParallel: Math.min(10, Math.max(1, Math.round(Number(c?.maxParallel) || d.maxParallel)))
  }
}

/** Does this stage run in this config? Only repo work can be off. */
export function stageOn(config: FactoryConfig, id: StageId): boolean {
  return id !== 'execute' || Boolean(config.stages.execute?.enabled && config.paper?.empirics)
}

function nextStage(config: FactoryConfig, id: StageId): StageId | null {
  for (let i = STAGES.indexOf(id) + 1; i < STAGES.length; i++) if (stageOn(config, STAGES[i])) return STAGES[i]
  return null
}

async function ensureDatasets(root: string): Promise<void> {
  const dir = datasetsDir(root)
  await fs.mkdir(dir, { recursive: true })
  const index = join(dir, 'INDEX.md')
  if (!(await exists(index))) {
    await fs.writeFile(
      index,
      '# Datasets\n\nOne line per dataset folder: `name/` — what it is, source, coverage.\n\n'
    )
  }
}

/**
 * Copy the framing guide into a run, unless it already has one. A linked
 * paper's own intro-check guide wins — it may have been tuned for that paper.
 */
async function ensureGuide(dir: string, paper?: PaperLink | null): Promise<void> {
  const path = join(dir, 'INTRO_GUIDE.md')
  if (await exists(path)) return
  const own = paper ? await fs.readFile(join(paper.project, '.claude', 'skills', 'intro-check', 'GUIDE.md'), 'utf8').catch(() => null) : null
  await fs.writeFile(path, own ?? introCheckGuide())
}

function normalizePaper(p: unknown): PaperLink | null {
  const x = p as Partial<PaperLink> | null | undefined
  if (!x || typeof x.project !== 'string' || !x.project.trim()) return null
  const project = x.project.trim()
  if (!existsSync(join(project, 'manuscript.qmd'))) return null
  const empirics = typeof x.empirics === 'string' && x.empirics.trim() && existsSync(x.empirics.trim()) ? x.empirics.trim() : null
  const litFiles = (Array.isArray(x.litFiles) ? x.litFiles : [])
    .map(String)
    .map((f) => f.trim())
    // Project-root files only: a name, never a path.
    .filter((f) => f && basename(f) === f && !f.startsWith('.'))
  return { project, empirics, litFiles }
}

/** The project remembers its empirics repo, so the next run is pre-filled. */
async function rememberPaper(paper: PaperLink | null | undefined): Promise<void> {
  if (!paper) return
  const file = join(paper.project, CONFIG_DIR, 'factory.json')
  await fs.mkdir(join(paper.project, CONFIG_DIR), { recursive: true })
  await fs.writeFile(file, JSON.stringify({ empirics: paper.empirics, litFiles: paper.litFiles }, null, 2) + '\n')
}

export async function paperDefaults(projectPath: string): Promise<PaperDefaults> {
  let saved: { empirics?: string | null; litFiles?: string[] } = {}
  try {
    saved = JSON.parse(await fs.readFile(join(projectPath, CONFIG_DIR, 'factory.json'), 'utf8'))
  } catch {
    /* first run on this project */
  }
  let mdFiles: string[] = []
  try {
    mdFiles = (await fs.readdir(projectPath, { withFileTypes: true }))
      .filter((d) => d.isFile() && d.name.endsWith('.md') && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort()
  } catch {
    /* unreadable */
  }
  const guess = mdFiles.filter((f) => /^(literature|positioning|framing)/i.test(f))
  return {
    empirics: saved.empirics ?? null,
    mdFiles,
    litFiles: Array.isArray(saved.litFiles) ? saved.litFiles.filter((f) => mdFiles.includes(f)) : guess
  }
}

/** Split markdown into lines, marking those inside ``` fences (code chunks). */
function fenced(lines: string[]): boolean[] {
  let inside = false
  return lines.map((l) => {
    if (/^\s*(```|~~~)/.test(l)) {
      inside = !inside
      return true
    }
    return inside
  })
}

/** The body of the `# Introduction` section of a convened output. */
export function introBody(md: string): string | null {
  const lines = md.split('\n')
  const code = fenced(lines)
  const start = lines.findIndex((l, i) => !code[i] && /^#{1,2}\s+Introduction\b/i.test(l))
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (code[i]) continue
    if (/^#{1,2}\s+(Framing choices|Evidence base|Open items)\b/i.test(lines[i]) || /^#\s/.test(lines[i])) {
      end = i
      break
    }
  }
  const body = lines.slice(start + 1, end).join('\n').trim()
  return body || null
}

/** Line index where the body starts — after a YAML front matter block, if any. */
function bodyStart(lines: string[]): number {
  if (lines[0]?.trim() !== '---') return 0
  const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l))
  return end < 0 ? 0 : end + 1
}

/** Top-level `# ` headings of a document body, outside code fences. */
function topHeadings(lines: string[]): number[] {
  const code = fenced(lines)
  const from = bodyStart(lines)
  const out: number[] = []
  for (let i = from; i < lines.length; i++) if (!code[i] && /^#\s+\S/.test(lines[i])) out.push(i)
  return out
}

/** `{#sec-intro}` → `sec-intro`; else the lower-cased title without attributes. */
function headingKey(line: string): { id: string | null; title: string } {
  const id = line.match(/\{[^}]*#([\w:.-]+)[^}]*\}\s*$/)?.[1] ?? null
  const title = line
    .replace(/^#+\s+/, '')
    .replace(/\s*\{[^}]*\}\s*$/, '')
    .trim()
    .toLowerCase()
  return { id, title }
}

/**
 * The manuscript's front end: top-level sections from `# Introduction` up to
 * and including the first one about hypotheses / theory / predictions.
 */
function frontEndRange(lines: string[]): number[] {
  const heads = topHeadings(lines)
  const start = heads.findIndex((i) => /^#\s+Introduction\b/i.test(lines[i]))
  if (start < 0) return []
  const end = heads.findIndex((i, k) => k >= start && /hypothes|theor|prediction/i.test(lines[i]))
  return heads.slice(start, (end < 0 ? start : end) + 1)
}

/** Heading lines of the linked manuscript's front-end sections, for the writer's brief. */
async function frontEndHeadings(paper: PaperLink): Promise<string[]> {
  const qmd = await fs.readFile(join(paper.project, 'manuscript.qmd'), 'utf8').catch(() => '')
  const lines = qmd.split('\n')
  return frontEndRange(lines).map((i) => lines[i].trim())
}

/** A front-end draft: its abstract and its top-level sections, up to the notes. */
export function parseFrontEnd(md: string): { abstract: string | null; sections: Array<{ heading: string; body: string }> } {
  const lines = md.split('\n')
  const code = fenced(lines)
  const heads: number[] = []
  for (let i = 0; i < lines.length; i++) if (!code[i] && /^#\s+\S/.test(lines[i])) heads.push(i)
  let abstract: string | null = null
  const sections: Array<{ heading: string; body: string }> = []
  for (let k = 0; k < heads.length; k++) {
    const line = lines[heads[k]].trim()
    if (/^#\s+Notes\b/i.test(line)) break
    const body = lines
      .slice(heads[k] + 1, heads[k + 1] ?? lines.length)
      .join('\n')
      .trim()
    if (/^#\s+Abstract\b/i.test(line)) abstract = body || null
    else if (body) sections.push({ heading: line, body })
  }
  return { abstract, sections }
}

/**
 * Replace whole front-end sections of the manuscript, matched by anchor, else
 * by title. The manuscript keeps its own heading line. Throws, naming the
 * allowed headings, if the draft has a section that isn't one of them.
 */
export function replaceSections(qmd: string, sections: Array<{ heading: string; body: string }>): string {
  const lines = qmd.split('\n')
  const range = frontEndRange(lines)
  const heads = topHeadings(lines)
  const targets: Array<{ start: number; end: number; body: string }> = []
  for (const sec of sections) {
    const want = headingKey(sec.heading)
    const hit =
      range.find((i) => want.id && headingKey(lines[i]).id === want.id) ??
      range.find((i) => headingKey(lines[i]).title === want.title)
    if (hit === undefined) {
      throw new Error(
        `“${sec.heading}” is not a front-end section of manuscript.qmd. Allowed: ${range.map((i) => lines[i].trim()).join(' · ') || '(none found)'}`
      )
    }
    const next = heads.find((i) => i > hit) ?? lines.length
    targets.push({ start: hit, end: next, body: sec.body })
  }
  // Bottom-up, so earlier indices stay valid.
  for (const t of targets.sort((a, b) => b.start - a.start)) {
    lines.splice(t.start + 1, t.end - t.start - 1, '', t.body, '')
  }
  return lines.join('\n')
}

/**
 * Replace the YAML `abstract:` and, if the document keeps a LaTeX copy
 * (`\begin{abstract}…\end{abstract}`, as the anonymized title page does), that
 * copy too. Null when there is no `abstract:` to replace.
 */
export function replaceAbstract(qmd: string, text: string): string | null {
  const lines = qmd.split('\n')
  const fmEnd = bodyStart(lines)
  const i = lines.findIndex((l, k) => k < fmEnd && /^abstract:/.test(l))
  if (i < 0) return null
  let j = i + 1
  while (j < fmEnd - 1 && (lines[j].trim() === '' || /^\s/.test(lines[j]))) j++
  // Don't swallow blank lines that separate the next key.
  while (j > i + 1 && lines[j - 1].trim() === '') j--
  const block = text
    .trim()
    .split('\n')
    .map((l) => (l.trim() ? `  ${l}` : ''))
  lines.splice(i, j - i, 'abstract: |', ...block)
  const out = lines.join('\n')
  const latex = text
    .trim()
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([%&#_$])/g, '\\$1')
  return out.replace(/(\\begin\{abstract\}\s*\n)[\s\S]*?(\n\s*\\end\{abstract\})/, (_m, a: string, b: string) => `${a}${latex}${b}`)
}

/** Replace the body under the manuscript's top-level `# Introduction` heading. */
export function replaceIntro(qmd: string, body: string): string | null {
  const lines = qmd.split('\n')
  const code = fenced(lines)
  const start = lines.findIndex((l, i) => !code[i] && /^#\s+Introduction\b/i.test(l))
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (!code[i] && /^#\s/.test(lines[i])) {
      end = i
      break
    }
  }
  return [...lines.slice(0, start + 1), '', body, '', ...lines.slice(end)].join('\n')
}

/**
 * Register a dataset you collected yourself: a folder with a README.md for you
 * to fill in (agents decide from it whether the data fits), and a line in
 * INDEX.md. Drop the files into the folder afterwards.
 */
export async function createDataset(root: string, name: string, description: string): Promise<string> {
  const slug = slugify(name)
  if (!name.trim() || slug === 'run') throw new Error('Give the dataset a name.')
  await ensureDatasets(root)
  const dir = join(datasetsDir(root), slug)
  if (await exists(dir)) throw new Error(`datasets/${slug}/ already exists.`)
  await fs.mkdir(dir, { recursive: true })
  const today = new Date().toISOString().slice(0, 10)
  await fs.writeFile(
    join(dir, 'README.md'),
    `# ${name.trim()}

${description.trim() || 'What this dataset is, in one or two sentences.'}

- Source: (where it comes from — URL, database, hand-collected from …)
- Collected: ${today}
- Coverage: (unit of observation, sample, years)
- Files: (what each file is)
- Key variables: (name — meaning)
- Merge keys: (e.g. gvkey, CIK, ISIN + fiscal year)
- Access / licence: (anything agents must not share or upload)
- Notes: (known quirks, cleaning already applied)
`
  )
  await fs.appendFile(
    join(datasetsDir(root), 'INDEX.md'),
    `- \`${slug}/\` — ${description.trim() || name.trim()} (added by hand)\n`
  )
  return dir
}

export async function listDatasets(root: string): Promise<DatasetInfo[]> {
  const dir = datasetsDir(root)
  let names: string[] = []
  try {
    names = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
  } catch {
    return []
  }
  const out: DatasetInfo[] = []
  for (const name of names.sort()) {
    const readme = await fs.readFile(join(dir, name, 'README.md'), 'utf8').catch(() => '')
    // The first line of prose under the title — the README's one-line description.
    const summary =
      readme
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('#')) ?? ''
    out.push({ name, dir: join(dir, name), summary: summary.slice(0, 200) })
  }
  return out
}

function shq(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

function now(): string {
  return new Date().toISOString()
}

function lastLine(s: string): string {
  return s.trim().split('\n').filter(Boolean).at(-1)?.slice(0, 400) ?? ''
}

function firstLine(s: string): string {
  return (s.split('\n').find((l) => l.trim()) ?? '').replace(/^#+\s*/, '').trim().slice(0, 80)
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'run'
  )
}

async function uniqueSlug(root: string, base: string): Promise<string> {
  let slug = base
  let n = 2
  while (await exists(runDir(root, slug))) slug = `${base}-${n++}`
  return slug
}

// --- Template ------------------------------------------------------------------

async function readTemplate(root: string): Promise<FactoryConfig> {
  try {
    return normalizeConfig(JSON.parse(await fs.readFile(join(factoryDir(root), 'template.json'), 'utf8')))
  } catch {
    return defaultConfig()
  }
}

async function saveTemplate(root: string, config: FactoryConfig): Promise<void> {
  await fs.mkdir(factoryDir(root), { recursive: true })
  await fs.writeFile(join(factoryDir(root), 'template.json'), JSON.stringify(normalizeConfig(config), null, 2) + '\n')
}

// --- IPC -----------------------------------------------------------------------

export function registerFactory(
  ipc: IpcLike,
  getWindow: () => WindowLike | null,
  getRoot: () => Promise<string | null>
): { killAll: () => void } {
  const send: Send = (channel, ...args) => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    try {
      win.webContents.send(channel, ...args)
    } catch {
      /* host tore down mid-send */
    }
  }
  const engine = new FactoryEngine(getRoot, send)
  const root = async (): Promise<string> => {
    const r = await getRoot()
    if (!r) throw new Error('No library configured.')
    return r
  }

  ipc.handle('factory:list', () => engine.list())
  ipc.handle('factory:read', (_e, slug: string) => engine.read(slug))
  ipc.handle('factory:create', (_e, a: { title: string; idea: string; config: FactoryConfig }) =>
    engine.create(a.title, a.idea, a.config)
  )
  ipc.handle('factory:update', (_e, a: { slug: string; title?: string; idea?: string; config?: FactoryConfig }) =>
    engine.update(a.slug, a)
  )
  ipc.handle('factory:delete', (_e, slug: string) => engine.remove(slug))
  ipc.handle('factory:start', (_e, slug: string) => engine.start(slug))
  ipc.handle('factory:approve', (_e, a: { slug: string; note?: string }) => engine.approve(a.slug, a.note))
  ipc.handle('factory:sendBack', (_e, a: { slug: string; to: StageId; note: string }) =>
    engine.sendBack(a.slug, a.to, a.note)
  )
  ipc.handle('factory:accept', (_e, slug: string) => engine.accept(slug))
  ipc.handle('factory:kill', (_e, slug: string) => engine.kill(slug))
  ipc.handle('factory:retry', (_e, slug: string) => engine.retry(slug))
  ipc.handle('factory:stopAgent', (_e, ref: AgentRef) => engine.stopAgent(ref))
  ipc.handle('factory:events', (_e, ref: AgentRef) => engine.events(ref))
  ipc.handle('factory:output:get', (_e, ref: AgentRef) => engine.output(ref))
  ipc.handle('factory:output:save', (_e, a: { ref: AgentRef; content: string }) => engine.saveOutput(a.ref, a.content))
  ipc.handle('factory:feedback', (_e, a: { slug: string; stage: StageId; round: number }) =>
    engine.feedback(a.slug, a.stage, a.round)
  )
  ipc.handle('factory:resume', (_e, ref: AgentRef) => engine.resume(ref))
  ipc.handle('factory:openDir', (_e, slug: string) => engine.openDir(slug))
  ipc.handle('factory:template:get', async () => readTemplate(await root()))
  ipc.handle('factory:template:save', async (_e, config: FactoryConfig) => saveTemplate(await root(), config))
  ipc.handle('factory:datasets', async () => listDatasets(await root()))
  ipc.handle('factory:paper:defaults', (_e, projectPath: string) => paperDefaults(projectPath))
  ipc.handle('factory:datasets:create', async (_e, a: { name: string; description: string }) => {
    const dir = await createDataset(await root(), a.name, a.description)
    send('factory:changed', '')
    return dir
  })
  // Open a dataset's folder (or the registry itself) in Finder to drop files in.
  ipc.handle('factory:datasets:open', async (_e, name: string | null) => {
    const r = await root()
    await ensureDatasets(r)
    const dir = name ? join(datasetsDir(r), slugify(name)) : datasetsDir(r)
    return platform.openPath(dir)
  })

  return { killAll: () => engine.killAll() }
}
