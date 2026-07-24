import type { IpcMain } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileP = promisify(execFile)

/**
 * Mini source control for project folders. Deliberately small: a status read
 * (is Chris up to date?) and a one-click sync (add → commit → pull → push).
 * Anything fancier — branches, diffs, conflict resolution — belongs in the
 * embedded terminal or a real git client, not here.
 */

export interface GitFileChange {
  path: string
  status: string // 'modified' | 'added' | 'deleted' | 'renamed' | 'new' | 'conflict'
}

export interface GitStatus {
  repo: boolean
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  files: GitFileChange[]
}

export interface GitSyncResult {
  ok: boolean
  log: string
  error?: string
}

const NOT_A_REPO: GitStatus = {
  repo: false,
  branch: null,
  upstream: null,
  ahead: 0,
  behind: 0,
  files: []
}

async function git(cwd: string, args: string[], timeout = 60_000): Promise<string> {
  const { stdout, stderr } = await execFileP('git', args, {
    cwd,
    timeout,
    // Never let git block on an interactive credential prompt — fail fast and
    // surface the error in the panel instead.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })
  return stdout + stderr
}

const STATUS_WORDS: Record<string, string> = {
  M: 'modified',
  T: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'added',
  U: 'conflict',
  '?': 'new'
}

function parsePorcelainV2(out: string): GitStatus {
  const st: GitStatus = { repo: true, branch: null, upstream: null, ahead: 0, behind: 0, files: [] }
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      st.branch = line.slice('# branch.head '.length)
    } else if (line.startsWith('# branch.upstream ')) {
      st.upstream = line.slice('# branch.upstream '.length)
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/)
      if (m) {
        st.ahead = Number(m[1])
        st.behind = Number(m[2])
      }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      // `1 XY sub mH mI mW hH hI path` · `2` adds a rename score before the path
      // (and the original path after a tab, which we drop).
      const fields = line.split(' ')
      const xy = fields[1]
      const skip = line.startsWith('1 ') ? 8 : 9
      const path = fields.slice(skip).join(' ').split('\t')[0]
      const code = xy[0] !== '.' ? xy[0] : xy[1]
      st.files.push({ path, status: STATUS_WORDS[code] ?? 'modified' })
    } else if (line.startsWith('? ')) {
      st.files.push({ path: line.slice(2), status: 'new' })
    } else if (line.startsWith('u ')) {
      const fields = line.split(' ')
      st.files.push({ path: fields.slice(10).join(' '), status: 'conflict' })
    }
  }
  return st
}

export async function gitStatus(projectPath: string, fetch = false): Promise<GitStatus> {
  if (fetch) {
    // Best-effort: offline or credential failures just mean ahead/behind counts
    // reflect the last successful fetch.
    try {
      await git(projectPath, ['fetch', '--quiet'], 15_000)
    } catch {
      /* ignore */
    }
  }
  try {
    const out = await git(projectPath, ['status', '--porcelain=v2', '--branch'], 10_000)
    return parsePorcelainV2(out)
  } catch {
    return NOT_A_REPO
  }
}

function commitMessage(files: GitFileChange[]): string {
  const names = [...new Set(files.map((f) => f.path.split('/').pop() ?? f.path))]
  const head = names.slice(0, 3).join(', ')
  const more = names.length > 3 ? ` (+${names.length - 3} more)` : ''
  return `Update ${head}${more}`
}

export async function gitSync(projectPath: string): Promise<GitSyncResult> {
  let log = ''
  const step = (title: string, out: string): void => {
    log += `$ ${title}\n${out.trim() ? out.trim() + '\n' : ''}`
  }
  try {
    const st = await gitStatus(projectPath)
    if (!st.repo) return { ok: false, log, error: 'Not a git repository.' }

    if (st.files.length) {
      step('git add -A', await git(projectPath, ['add', '-A']))
      // Commit runs the repo's hooks (e.g. a bib-sync pre-commit); their output
      // lands in the log so warnings actually get seen.
      step('git commit', await git(projectPath, ['commit', '-m', commitMessage(st.files)]))
    }

    if (st.upstream) {
      step('git pull --rebase', await git(projectPath, ['pull', '--rebase', '--autostash']))
      step('git push', await git(projectPath, ['push']))
    } else {
      const remotes = (await git(projectPath, ['remote'])).trim()
      if (remotes) {
        step('git push -u', await git(projectPath, ['push', '-u', remotes.split('\n')[0], 'HEAD']))
      } else if (st.files.length) {
        log += 'No remote configured — committed locally.\n'
      }
    }
    return { ok: true, log }
  } catch (e) {
    const err = e as Error & { stdout?: string; stderr?: string }
    log += (err.stdout ?? '') + (err.stderr ?? '')
    const first = (err.stderr || err.message || 'git failed').split('\n')[0]
    return { ok: false, log, error: first }
  }
}

export function registerGit(ipcMain: IpcMain): void {
  ipcMain.handle('project:git:status', (_e, args: { projectPath: string; fetch?: boolean }) =>
    gitStatus(args.projectPath, args.fetch ?? false)
  )
  ipcMain.handle('project:git:sync', (_e, projectPath: string) => gitSync(projectPath))
}
