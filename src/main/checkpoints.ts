import type { IpcLike, WindowLike } from './platform'
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { join, relative, sep } from 'path'
import { promisify } from 'util'

const execFileP = promisify(execFile)

/**
 * Review-after-the-fact for Claude's edits ("checkpoint review").
 *
 * Claude works freely in the embedded terminal — nothing is gated — but every
 * time the user submits a prompt we snapshot the project into a git tree first.
 * A turn's changes are then simply `diff(tree taken before this turn, tree taken
 * before the next turn)`, and the last turn diffs against the live working tree.
 * The user reviews each turn in a GUI and keeps or reverts per file.
 *
 * Snapshots deliberately do NOT touch the user's branch, HEAD, index or working
 * tree. We build a tree with a private index file (`.lctrn/checkpoint.index`)
 * and hand it to `commit-tree`, then anchor the result under `refs/lctrn/` so it
 * survives gc. `git log` on the user's branch stays clean, and GitPanel's
 * commit → pull → push flow is unaffected: "keep" means "leave it in the working
 * tree", which is exactly what Sync then commits.
 *
 * Turn boundaries arrive from Claude Code's own hooks via bridge.ts —
 * `UserPromptSubmit` takes the snapshot and carries the prompt text (which
 * becomes the label you see in the review window), `Stop` just says "turn over,
 * refresh". Hooks are fire-and-forget; if Lectern isn't running, nothing
 * happens and Claude is never delayed.
 */

export interface CheckpointFile {
  /** Project-relative path, as displayed. */
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed'
  added: number
  removed: number
  binary: boolean
}

export interface Checkpoint {
  id: string
  /** Commit sha holding the pre-turn tree. */
  commit: string
  /** The prompt that started the turn, trimmed for display. */
  label: string
  at: string
  sessionId: string | null
  files: CheckpointFile[]
}

export interface ReviewState {
  repo: boolean
  /** Set when the folder is a repo but has no commits yet — snapshots still work. */
  empty: boolean
  checkpoints: Checkpoint[]
  /**
   * Why the last snapshot failed, if it did. Without this a broken checkpoint
   * looks exactly like a quiet one — the panel says "nothing to review" whether
   * Claude changed nothing or the snapshot never ran.
   */
  error?: string
}

interface StoredCheckpoint {
  id: string
  commit: string
  label: string
  at: string
  sessionId: string | null
  reviewed: boolean
}

const NOT_A_REPO: ReviewState = { repo: false, empty: false, checkpoints: [] }

/** Turns older than this drop off the review list (and lose their ref). */
const MAX_CHECKPOINTS = 40

async function git(cwd: string, args: string[], timeout = 30_000): Promise<string> {
  const { stdout } = await execFileP('git', args, {
    cwd,
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })
  return stdout
}

/** Byte-exact read, for restoring files that may be binary or non-UTF8. */
async function gitBytes(cwd: string, args: string[]): Promise<Buffer> {
  const { stdout } = await execFileP('git', args, {
    cwd,
    timeout: 30_000,
    maxBuffer: 128 * 1024 * 1024,
    encoding: 'buffer',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })
  return stdout as unknown as Buffer
}

/**
 * Where git commands run (the repo root) and how the project sits inside it.
 * A Lectern library is often one repo containing every project, so all diffs are
 * scoped by `prefix` — reviewing one project never surfaces another's edits.
 */
interface RepoContext {
  root: string
  /** Repo-relative project dir with trailing slash, or '' when the project *is* the root. */
  prefix: string
}

/**
 * Pathspec limiting a *diff* to the project — minus `.lctrn/`, which is
 * Lectern's own state. The checkpoint log lives in there and rewrites itself on
 * every turn, so without this exclusion each review would list
 * `.lctrn/checkpoints.json` as one of Claude's edits, no turn would ever look
 * empty, and "Revert all" would roll back the review log itself.
 *
 * Note this is deliberately NOT used for `git add` — see dropLctrnFromIndex.
 */
function scope(ctx: RepoContext): string[] {
  return ['--', ctx.prefix || '.', `:(exclude)${ctx.prefix}.lctrn/`]
}

async function repoContext(projectPath: string): Promise<RepoContext | null> {
  try {
    const root = (await git(projectPath, ['rev-parse', '--show-toplevel'], 10_000)).trim()
    if (!root) return null
    const rel = relative(root, projectPath)
    return { root, prefix: rel && rel !== '.' ? rel.split(sep).join('/') + '/' : '' }
  } catch {
    return null
  }
}

async function hasCommits(root: string): Promise<boolean> {
  try {
    await git(root, ['rev-parse', '--verify', 'HEAD'], 10_000)
    return true
  } catch {
    return false
  }
}

// --- Snapshotting ------------------------------------------------------------

/**
 * Build a tree object from the project's current working state and wrap it in a
 * commit. Uses a private index kept at `.lctrn/checkpoint.index`: reusing the
 * same file across snapshots keeps git's stat cache warm, so the second and
 * later snapshots don't re-hash the project. `add -A` is scoped to the project
 * prefix, so a library-wide repo doesn't get hashed on every prompt.
 */
async function writeSnapshot(projectPath: string, ctx: RepoContext): Promise<string> {
  const indexFile = join(projectPath, '.lctrn', 'checkpoint.index')
  await fs.mkdir(join(projectPath, '.lctrn'), { recursive: true })

  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_INDEX_FILE: indexFile,
    // commit-tree refuses to run without an identity, and the repo may not have
    // one configured yet. Never write these into the user's git config.
    GIT_AUTHOR_NAME: 'Lectern',
    GIT_AUTHOR_EMAIL: 'lectern@localhost',
    GIT_COMMITTER_NAME: 'Lectern',
    GIT_COMMITTER_EMAIL: 'lectern@localhost'
  }
  const run = async (args: string[]): Promise<string> => {
    const { stdout } = await execFileP('git', args, {
      cwd: ctx.root,
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
      env
    })
    return stdout
  }

  // Seed the index from HEAD so paths outside the project keep their committed
  // state, then overlay the project's live working tree on top.
  if (await hasCommits(ctx.root)) {
    await run(['read-tree', 'HEAD'])
  } else {
    await run(['read-tree', '--empty'])
  }
  // Stage the project, then drop Lectern's own state from the index.
  //
  // This deliberately does *not* use an `:(exclude).lctrn/` pathspec on `add`.
  // Most projects gitignore `.lctrn`, and naming an ignored path in a pathspec —
  // even an excluding one — makes `git add` abort with "The following paths are
  // ignored by one of your .gitignore files". That killed every snapshot in a
  // real project while working fine in a scratch repo without the ignore rule.
  // Staging broadly and unstaging after is layout- and gitignore-independent.
  await run(['add', '-A', '--', ctx.prefix || '.'])
  // `-f` because the index we are writing lives in `.lctrn` itself, so git sees
  // staged content differing from both the file and HEAD and refuses without it.
  // `--cached` means this only ever unstages — the working tree is never touched.
  await run(['rm', '--cached', '-r', '-f', '-q', '--ignore-unmatch', '--', `${ctx.prefix}.lctrn`])

  const tree = (await run(['write-tree'])).trim()
  const commit = (await run(['commit-tree', tree, '-m', 'lctrn checkpoint'])).trim()
  return commit
}

// --- Checkpoint store --------------------------------------------------------

function storePath(projectPath: string): string {
  return join(projectPath, '.lctrn', 'checkpoints.json')
}

async function readStore(projectPath: string): Promise<StoredCheckpoint[]> {
  try {
    const raw = await fs.readFile(storePath(projectPath), 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed?.checkpoints) ? parsed.checkpoints : []
  } catch {
    return []
  }
}

async function writeStore(projectPath: string, checkpoints: StoredCheckpoint[]): Promise<void> {
  await fs.mkdir(join(projectPath, '.lctrn'), { recursive: true })
  await fs.writeFile(
    storePath(projectPath),
    JSON.stringify({ checkpoints }, null, 2) + '\n',
    'utf8'
  )
}

/**
 * Serialize read-modify-write of the store per project. Two terminal sessions
 * can be working in the same folder, and their hooks fire independently.
 */
const queues = new Map<string, Promise<unknown>>()
function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  queues.set(
    key,
    next.catch(() => {})
  )
  return next
}

/**
 * Record a pre-turn checkpoint. Called from the UserPromptSubmit hook, so it
 * runs on every prompt — including ones that change nothing. Empty turns are
 * filtered out at read time rather than guessed at here.
 */
export async function recordCheckpoint(
  projectPath: string,
  label: string,
  sessionId: string | null
): Promise<void> {
  const ctx = await repoContext(projectPath)
  if (!ctx) {
    lastError.set(projectPath, 'Not a git repository — checkpoints need one to store snapshots.')
    return
  }

  try {
    await snapshotTurn(projectPath, ctx, label, sessionId)
    lastError.delete(projectPath)
  } catch (e) {
    // Never rethrow: the hook is waiting on this and must not stall the turn.
    // Recording why lets the panel say so instead of showing an empty list.
    lastError.set(projectPath, (e as Error).message.split('\n')[0].slice(0, 300))
  }
}

/** Per-project reason the last snapshot failed. Cleared by the next success. */
const lastError = new Map<string, string>()

async function snapshotTurn(
  projectPath: string,
  ctx: RepoContext,
  label: string,
  sessionId: string | null
): Promise<void> {
  await serialize(projectPath, async () => {
    const commit = await writeSnapshot(projectPath, ctx)
    const id = `${Date.now().toString(36)}-${commit.slice(0, 8)}`

    // Anchor the commit so gc can't collect it while it's still reviewable.
    await git(ctx.root, ['update-ref', `refs/lctrn/${id}`, commit]).catch(() => {})

    const store = await readStore(projectPath)
    store.push({
      id,
      commit,
      label: label.trim().slice(0, 400),
      at: new Date().toISOString(),
      sessionId,
      reviewed: false
    })

    for (const old of store.splice(0, Math.max(0, store.length - MAX_CHECKPOINTS))) {
      await git(ctx.root, ['update-ref', '-d', `refs/lctrn/${old.id}`]).catch(() => {})
    }
    await writeStore(projectPath, store)
  })
}

// --- Reading the review state ------------------------------------------------

const STATUS_WORDS: Record<string, CheckpointFile['status']> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'added',
  T: 'modified'
}

/**
 * Files changed between two trees, scoped to the project. `--numstat` carries
 * the +/- counts (and marks binaries with `-`), `--name-status` the letter.
 */
async function diffFiles(ctx: RepoContext, from: string, to: string): Promise<CheckpointFile[]> {
  const [names, nums] = await Promise.all([
    git(ctx.root, ['diff', '--name-status', '-M', from, to, ...scope(ctx)]),
    git(ctx.root, ['diff', '--numstat', '-M', from, to, ...scope(ctx)])
  ])

  const counts = new Map<string, { added: number; removed: number; binary: boolean }>()
  for (const line of nums.split('\n')) {
    if (!line.trim()) continue
    const [a, r, ...rest] = line.split('\t')
    // Renames appear as `old => new`; the last field is the path we display.
    const path = rest[rest.length - 1]
    if (!path) continue
    counts.set(path, {
      added: a === '-' ? 0 : Number(a) || 0,
      removed: r === '-' ? 0 : Number(r) || 0,
      binary: a === '-' && r === '-'
    })
  }

  const out: CheckpointFile[] = []
  for (const line of names.split('\n')) {
    if (!line.trim()) continue
    const fields = line.split('\t')
    const code = fields[0][0]
    const path = fields[fields.length - 1]
    if (!path) continue
    const n = counts.get(path) ?? { added: 0, removed: 0, binary: false }
    out.push({
      path: ctx.prefix && path.startsWith(ctx.prefix) ? path.slice(ctx.prefix.length) : path,
      status: STATUS_WORDS[code] ?? 'modified',
      ...n
    })
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * The review list: every unreviewed turn that still has something outstanding,
 * newest first.
 *
 * Two diffs go into each entry, and the distinction matters:
 *
 *  - *which files this turn touched* comes from `tree(N) → tree(N+1)` (or the
 *    live tree for the newest turn). That's the attribution — it's what ties a
 *    change to the prompt that caused it.
 *  - *what is shown and what Revert undoes* is `tree(N) → live`, restricted to
 *    those files. Reverting restores `tree(N)`, so this is exactly the change
 *    the button will undo — including, deliberately, later edits to the same
 *    file, which go with it.
 *
 * Diffing against the frozen next snapshot instead would mean a reverted turn
 * kept showing its original diff forever, since nothing you do to the working
 * tree can change a diff between two committed trees.
 */
export async function reviewState(projectPath: string): Promise<ReviewState> {
  const ctx = await repoContext(projectPath)
  if (!ctx) return NOT_A_REPO

  return serialize(projectPath, async () => {
    const err = lastError.get(projectPath)
    const store = await readStore(projectPath)
    if (!store.length) {
      return { repo: true, empty: !(await hasCommits(ctx.root)), checkpoints: [], error: err }
    }

    const live = await writeSnapshot(projectPath, ctx)
    const out: Checkpoint[] = []

    for (let i = 0; i < store.length; i++) {
      const cp = store[i]
      if (cp.reviewed) continue
      const next = store[i + 1]?.commit ?? live
      let files: CheckpointFile[] = []
      try {
        const outstanding = await diffFiles(ctx, cp.commit, live)
        if (next === live) {
          files = outstanding
        } else {
          const touched = new Set((await diffFiles(ctx, cp.commit, next)).map((f) => f.path))
          files = outstanding.filter((f) => touched.has(f.path))
        }
      } catch {
        // Snapshot object is gone (repo re-cloned, aggressive gc) — skip it
        // rather than failing the whole panel.
        continue
      }
      // Nothing outstanding: the turn changed nothing, or it has since been
      // reverted or overwritten back to where it started.
      if (!files.length) continue
      out.push({
        id: cp.id,
        commit: cp.commit,
        label: cp.label,
        at: cp.at,
        sessionId: cp.sessionId,
        files
      })
    }

    out.reverse()
    return { repo: true, empty: false, checkpoints: out, error: err }
  })
}

/**
 * The unified patch for one file in one turn. Diffed against the live tree for
 * the same reason reviewState is — what you read here is what Revert undoes.
 */
export async function checkpointPatch(
  projectPath: string,
  checkpointId: string,
  path: string
): Promise<string> {
  const ctx = await repoContext(projectPath)
  if (!ctx) return ''
  const store = await readStore(projectPath)
  const cp = store.find((c) => c.id === checkpointId)
  if (!cp) return ''

  const live = await serialize(projectPath, () => writeSnapshot(projectPath, ctx))
  try {
    return await git(ctx.root, [
      'diff',
      '-M',
      '--no-color',
      '-U3',
      cp.commit,
      live,
      '--',
      ctx.prefix + path
    ])
  } catch {
    return ''
  }
}

// --- Acting on a review ------------------------------------------------------

/**
 * Put one file back the way it was before this turn. Writes the blob straight
 * from the snapshot tree rather than using `git checkout`, so the user's index
 * is never touched — the working tree is the only thing that moves.
 *
 * Note this restores the *pre-turn* state: if a later turn also touched the
 * file, those changes go too. The UI says so.
 */
async function restoreOne(
  projectPath: string,
  ctx: RepoContext,
  commit: string,
  path: string
): Promise<{ ok: boolean; error?: string }> {
  const abs = join(projectPath, path)
  try {
    let blob: Buffer | null = null
    try {
      blob = await gitBytes(ctx.root, ['cat-file', 'blob', `${commit}:${ctx.prefix}${path}`])
    } catch {
      blob = null // didn't exist before the turn — Claude created it
    }
    if (blob === null) {
      await fs.rm(abs, { force: true })
    } else {
      await fs.mkdir(join(abs, '..'), { recursive: true })
      await fs.writeFile(abs, blob)
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export async function revertFile(
  projectPath: string,
  checkpointId: string,
  path: string
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await repoContext(projectPath)
  if (!ctx) return { ok: false, error: 'Not a git repository.' }
  const cp = (await readStore(projectPath)).find((c) => c.id === checkpointId)
  if (!cp) return { ok: false, error: 'That checkpoint is gone.' }

  const r = await restoreOne(projectPath, ctx, cp.commit, path)
  if (!r.ok) return r

  // If that was the turn's last outstanding file it has now been decided, so
  // record it as reviewed. Letting it drop off merely because its diff is empty
  // would mean editing the same file again later resurrects a turn the user
  // already dealt with.
  const still = await reviewState(projectPath)
  if (!still.checkpoints.some((c) => c.id === checkpointId)) {
    await keepCheckpoint(projectPath, checkpointId)
  }
  return { ok: true }
}

export async function revertCheckpoint(
  projectPath: string,
  checkpointId: string
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await repoContext(projectPath)
  if (!ctx) return { ok: false, error: 'Not a git repository.' }
  const cp = (await reviewState(projectPath)).checkpoints.find((c) => c.id === checkpointId)
  if (!cp) return { ok: false, error: 'That checkpoint is gone.' }

  for (const f of cp.files) {
    const r = await restoreOne(projectPath, ctx, cp.commit, f.path)
    if (!r.ok) return r
  }
  await keepCheckpoint(projectPath, checkpointId)
  return { ok: true }
}

/** Accept a turn: it just stops showing up. The edits stay in the working tree. */
export async function keepCheckpoint(projectPath: string, checkpointId: string): Promise<void> {
  await serialize(projectPath, async () => {
    const store = await readStore(projectPath)
    const cp = store.find((c) => c.id === checkpointId)
    if (!cp) return
    cp.reviewed = true
    await writeStore(projectPath, store)
  })
}

/** Turn a plain folder into a repo so checkpoints have somewhere to live. */
export async function initRepo(projectPath: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await git(projectPath, ['init'])
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

// --- Hook installation -------------------------------------------------------

const HOOK_REL = join('.claude', 'hooks', 'lctrn-checkpoint.sh')
/** Invoked via `sh <path>`, not the exec bit — Dropbox sync drops exec bits. */
const HOOK_COMMAND = 'sh "$CLAUDE_PROJECT_DIR/.claude/hooks/lctrn-checkpoint.sh"'

function hookScript(): string {
  return `#!/bin/sh
# Lectern turn checkpoints — hands Claude Code's hook payload to the running app
# so it can snapshot the project before a turn and show you the diff afterwards.
#
# Fire-and-forget by design: this exits 0 on every path, so a closed, restarting
# or uninstalled Lectern can never block, slow or break your Claude session.
# Managed by Lectern; edits here are overwritten.
f="$HOME/.lctrn/bridge"
[ -r "$f" ] || exit 0
read -r port token < "$f" || exit 0
[ -n "$port" ] && [ -n "$token" ] || exit 0
curl -sS -m 20 -X POST "http://127.0.0.1:$port/hook" \\
  -H 'content-type: application/json' \\
  -H "x-lctrn-token: $token" \\
  --data-binary @- >/dev/null 2>&1
exit 0
`
}

interface HookEntry {
  type?: string
  command?: string
  timeout?: number
}
interface HookMatcher {
  matcher?: string
  hooks?: HookEntry[]
}

/** Add our hook to one event's list if it isn't already there. Returns true if changed. */
function mergeHook(settings: Record<string, unknown>, event: string, timeout: number): boolean {
  const hooks = (settings.hooks ??= {}) as Record<string, HookMatcher[]>
  const list = (hooks[event] ??= [])
  if (!Array.isArray(hooks[event])) return false
  const already = list.some((m) => m?.hooks?.some((h) => h?.command === HOOK_COMMAND))
  if (already) return false
  list.push({ hooks: [{ type: 'command', command: HOOK_COMMAND, timeout }] })
  return true
}

/**
 * Install the checkpoint hooks into a project, preserving whatever else is in
 * its `.claude/settings.json` — and clear any legacy pinned `model` while we're
 * in there, so sessions always start on Claude Code's default. Idempotent, so it
 * can run on every project open — which is what backfills projects scaffolded
 * before these existed.
 *
 * `UserPromptSubmit` is the one that matters: it blocks until Lectern has the
 * snapshot, guaranteeing a baseline exists before Claude's first edit. 60s is
 * far more headroom than a snapshot needs, and the hook self-limits to 20s.
 */
export async function ensureCheckpointHooks(projectPath: string): Promise<void> {
  try {
    const scriptPath = join(projectPath, HOOK_REL)
    await fs.mkdir(join(projectPath, '.claude', 'hooks'), { recursive: true })
    const script = hookScript()
    const current = await fs.readFile(scriptPath, 'utf8').catch(() => null)
    if (current !== script) await fs.writeFile(scriptPath, script, { encoding: 'utf8', mode: 0o755 })

    const settingsPath = join(projectPath, '.claude', 'settings.json')
    let settings: Record<string, unknown> = {}
    const raw = await fs.readFile(settingsPath, 'utf8').catch(() => null)
    if (raw) {
      try {
        settings = JSON.parse(raw)
      } catch {
        // Hand-edited into invalid JSON — leave it alone rather than clobbering
        // the user's permissions block.
        return
      }
    }

    let changed = mergeHook(settings, 'UserPromptSubmit', 60)
    changed = mergeHook(settings, 'Stop', 20) || changed
    // Projects scaffolded before this pinned a `model` here, freezing their
    // sessions on whatever was current the day they were created. Sessions run
    // on Claude Code's own default now, so drop the pin wherever it survives.
    if ('model' in settings) {
      delete settings.model
      changed = true
    }
    if (changed) await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8')
  } catch {
    // Checkpoints are a convenience; never fail opening a project over them.
  }
}

// --- IPC ---------------------------------------------------------------------

export function registerCheckpoints(ipcMain: IpcLike, getWindow: () => WindowLike | null): void {
  /**
   * Announce that a project's review state moved. Deciding a turn has to emit
   * this too, not just the hook feed in bridge.ts — the toolbar's pending count
   * lives outside the review window and would otherwise go stale the moment you
   * kept or reverted something.
   */
  const notify = (projectPath: string): void => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    try {
      win.webContents.send('project:review:changed', projectPath)
    } catch {
      /* window tore down mid-send */
    }
  }

  ipcMain.handle('project:review:state', (_e, projectPath: string) => reviewState(projectPath))
  ipcMain.handle('project:review:patch', (_e, a: { projectPath: string; id: string; path: string }) =>
    checkpointPatch(a.projectPath, a.id, a.path)
  )
  ipcMain.handle('project:review:keep', async (_e, a: { projectPath: string; id: string }) => {
    await keepCheckpoint(a.projectPath, a.id)
    notify(a.projectPath)
  })
  ipcMain.handle(
    'project:review:revertFile',
    async (_e, a: { projectPath: string; id: string; path: string }) => {
      const r = await revertFile(a.projectPath, a.id, a.path)
      notify(a.projectPath)
      return r
    }
  )
  ipcMain.handle('project:review:revert', async (_e, a: { projectPath: string; id: string }) => {
    const r = await revertCheckpoint(a.projectPath, a.id)
    notify(a.projectPath)
    return r
  })
  ipcMain.handle('project:review:init', async (_e, projectPath: string) => {
    const r = await initRepo(projectPath)
    notify(projectPath)
    return r
  })
}
