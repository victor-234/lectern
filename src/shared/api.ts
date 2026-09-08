/**
 * The one definition of Lectern's renderer-facing API.
 *
 * It is written against a `Transport` rather than against Electron's
 * `ipcRenderer`, because there are now two ways the renderer reaches the
 * backend and they must not drift:
 *
 *   - **Desktop.** The preload script (src/preload) passes an ipcRenderer-backed
 *     transport and hands the result to `contextBridge`.
 *   - **Localhost server.** The page passes a WebSocket-backed transport (see
 *     renderer/src/lib/rpc.ts) and installs the result on `window.api` itself.
 *
 * Every method below is one of three primitives — request/response, fire and
 * forget, subscribe — which is exactly why the swap is possible at all.
 */

/** The three calls both hosts have to provide. */
export interface Transport {
  /** Request/response. Rejects if the handler threw. */
  invoke(channel: string, arg?: unknown): Promise<any>
  /** Fire and forget — no reply, no backpressure. */
  send(channel: string, arg?: unknown): void
  /** Subscribe to pushes from the backend; returns an unsubscribe. */
  on(channel: string, listener: (...args: any[]) => void): () => void
}

import type { UpdatePaperResult } from '../main/library'
import type { ExtractedMeta } from '../main/metadata'
import type { GitStatus, GitSyncResult } from '../main/git'
import type { PaperText } from '../main/paperText'
import type { SemanticResult } from '../main/paperSearch'
import type { ReviewState } from '../main/checkpoints'
import type { ApiKeyState } from '../main/writingRules'
import type { RewriteRequest, RewriteResult } from '../main/rewrite'
import type { HostInfo } from '../main/core'

/** One level of the backend's filesystem, for the browser folder picker. */
export interface DirListing {
  path: string
  parent: string | null
  entries: { name: string; path: string }[]
}

export function createApi(t: Transport) {
  const api = {
    // App-level window/menu wiring.
    app: {
      // Fires when the user picks File ▸ Close (⌘W). The renderer closes the
      // active reader tab if one is open, otherwise calls window.close().
      onCloseRequest: (cb: () => void): (() => void) => {
        return t.on('menu:close', () => cb())
      },
      // Navigation shortcuts relayed from the app menu's accelerators (they fire
      // app-globally, so they work even while the PDF reader has focus). The
      // payload is an action string, e.g. 'app:papers', 'open', 'tab:2'.
      onShortcut: (cb: (action: string) => void): (() => void) => {
        return t.on('menu:shortcut', (action: string) => cb(action))
      },
      closeWindow: (): void => t.send('window:close')
    },
    // Light up a passage inside the PDF reader. `phrase` must be long enough to be
    // unique to the document (Chromium's find covers our own DOM too, and the first
    // match takes the highlight). Resolves with the number of matches, so 0 means
    // "the PDF's text doesn't contain this" and the caller should fall back.
    reader: {
      highlight: (phrase: string): Promise<number> =>
        t.invoke('reader:highlight', phrase),
      clearHighlight: (): Promise<void> => t.invoke('reader:clear-highlight')
    },
    // Where the backend is running and what it can do — the UI adapts to this
    // instead of sniffing for Electron, so one renderer build serves the desktop
    // app and the localhost server alike.
    host: {
      info: (): Promise<HostInfo> => t.invoke('host:info'),
      // Directory listing on the BACKEND's machine, for the browser's own folder
      // picker (the desktop app raises a native dialog instead).
      listDir: (path: string | null): Promise<DirListing> => t.invoke('fs:listDir', path),
      mkdir: (parent: string, name: string): Promise<string> =>
        t.invoke('fs:mkdir', { parent, name })
    },
    library: {
      get: (): Promise<string | null> => t.invoke('library:get'),
      defaultPath: (): Promise<string> => t.invoke('library:defaultPath'),
      useDefault: (): Promise<string> => t.invoke('library:useDefault'),
      // `path` is honoured only where the renderer can name one (server mode);
      // the desktop app raises its native dialog and ignores it.
      choose: (path: string | null = null): Promise<string | null> =>
        t.invoke('library:choose', path),
      papers: () => t.invoke('library:papers'),
      tags: () => t.invoke('library:tags'),
      groups: () => t.invoke('library:groups'),
      setTagGroup: (tagId: string, groupId: string | null) =>
        t.invoke('library:setTagGroup', { tagId, groupId }),
      createGroup: (name: string) => t.invoke('library:createGroup', name),
      renameGroup: (groupId: string, name: string) =>
        t.invoke('library:renameGroup', { groupId, name }),
      deleteGroup: (groupId: string) => t.invoke('library:deleteGroup', groupId),
      createTag: (name: string) => t.invoke('library:createTag', name),
      renameTag: (tagId: string, name: string) =>
        t.invoke('library:renameTag', { tagId, name }),
      reorderTags: (entries: Array<{ id: string; groupId: string | null }>) =>
        t.invoke('library:reorderTags', entries),
      addTagToPapers: (tagId: string, paperIds: string[]) =>
        t.invoke('library:addTagToPapers', { tagId, paperIds }),
      deleteTag: (tagId: string) => t.invoke('library:deleteTag', tagId),
      setReading: (paperIds: string[], on: boolean) =>
        t.invoke('library:setReading', { paperIds, on }),
      pdf: (id: string): Promise<Uint8Array | null> => t.invoke('library:pdf', id),
      // `staged` is absolute paths the renderer already put on disk (server mode
      // uploads them first); the desktop app raises its native dialog instead.
      addPapers: (staged: string[] | null = null) => t.invoke('library:addPapers', staged),
      updatePaper: (id: string, patch: unknown): Promise<UpdatePaperResult> =>
        t.invoke('library:updatePaper', { id, patch }),
      refetchPaper: (id: string): Promise<void> => t.invoke('library:refetchPaper', id),
      // Suggest a `surnameYear` citekey from (possibly unsaved) authors + year.
      suggestCitekey: (id: string, authors: string[], year?: string): Promise<string> =>
        t.invoke('library:suggestCitekey', { id, authors, year }),
      // Direct DOI→Crossref lookup for the edit form's Fetch button.
      fetchDoi: (doi: string): Promise<ExtractedMeta | null> =>
        t.invoke('library:fetchDoi', doi),
      renamePaper: (
        id: string
      ): Promise<{ renamed: boolean; reason?: string; from?: string; to?: string }> =>
        t.invoke('library:renamePaper', id),
      renamePreview: (): Promise<
        { id: string; title: string; currentName: string; proposedName: string }[]
      > => t.invoke('library:renamePreview'),
      removePaper: (id: string) => t.invoke('library:removePaper', id),
      // Per-paper reading notes (notes/<title>.md), shown beside the PDF reader.
      note: {
        get: (id: string) => t.invoke('library:note:get', id),
        save: (id: string, content: string) =>
          t.invoke('library:note:save', { id, content })
      },
      // Reader search. `text` is the paper's extracted page text (cached in main),
      // which the find bar searches literally; `semantic` asks the local claude CLI
      // for the passages that answer a question.
      search: {
        text: (id: string): Promise<PaperText | null> => t.invoke('library:text:get', id),
        semantic: (id: string, query: string): Promise<SemanticResult> =>
          t.invoke('library:search:semantic', { id, query })
      },
      // Library-wide rules for any AI writing that goes into a paper
      // (`<library>/.lctrn/WRITING_RULES.md`). Every project reads these.
      writingRules: {
        get: (): Promise<string> => t.invoke('library:writingRules:get'),
        save: (content: string): Promise<void> =>
          t.invoke('library:writingRules:save', content)
      },
      onChanged: (cb: () => void): (() => void) => {
        return t.on('library:changed', () => cb())
      }
    },
    // Anthropic API key for the direct-API writing features (Rewrite). The key
    // itself never crosses back into the renderer — only whether one is set.
    ai: {
      keyState: (): Promise<ApiKeyState> => t.invoke('ai:key:state'),
      setKey: (key: string): Promise<void> => t.invoke('ai:key:set', key)
    },
    projects: {
      list: () => t.invoke('projects:list'),
      lastOpened: (): Promise<string | null> => t.invoke('projects:last:get'),
      setLastOpened: (projectPath: string | null): Promise<void> =>
        t.invoke('projects:last:set', projectPath),
      create: (args: { name: string; meta: unknown }) => t.invoke('project:create', args),
      info: (projectPath: string) => t.invoke('project:info', projectPath),
      papers: (projectPath: string) => t.invoke('project:papers', projectPath),
      addPaper: (projectPath: string, id: string) =>
        t.invoke('project:addPaper', { projectPath, id }),
      removePaper: (projectPath: string, id: string) =>
        t.invoke('project:removePaper', { projectPath, id }),
      // The project's Quarto manuscript (`manuscript.qmd`).
      doc: {
        get: (projectPath: string) => t.invoke('project:doc:get', { projectPath }),
        save: (projectPath: string, content: string) =>
          t.invoke('project:doc:save', { projectPath, content }),
        // Watch the open project's manuscript.qmd for external edits; null stops.
        watch: (projectPath: string | null) => t.invoke('project:doc:watch', projectPath),
        onChanged: (cb: () => void): (() => void) => {
          return t.on('project:doc:changed', () => cb())
        }
      },
      // Project config files (REVISION_PLAN.md, WRITING_STYLE.md, .claude/CLAUDE.md, …)
      files: {
        list: (projectPath: string) => t.invoke('project:files:list', projectPath),
        get: (projectPath: string, name: string) =>
          t.invoke('project:file:get', { projectPath, name }),
        save: (projectPath: string, name: string, content: string) =>
          t.invoke('project:file:save', { projectPath, name, content }),
        delete: (projectPath: string, name: string) =>
          t.invoke('project:file:delete', { projectPath, name }),
        // Fires when a project markdown file changes on disk (e.g. Claude editing
        // LEARNED_EDITS.md in the terminal), with the project-relative name.
        onChanged: (cb: (name: string) => void): (() => void) => {
          return t.on('project:files:changed', (name: string) => cb(name))
        }
      },
      // Revising mode (track-changes → LEARNED_EDITS.md). Toggling off returns a
      // kickoff prompt to drop into the embedded terminal for the learn-edits run.
      // Rewrite a manuscript selection against the writing rules (direct API).
      rewrite: (req: RewriteRequest): Promise<RewriteResult> =>
        t.invoke('project:rewrite', req),
      revising: {
        state: (projectPath: string) => t.invoke('project:revising:state', projectPath),
        start: (projectPath: string) => t.invoke('project:revising:start', projectPath),
        finish: (projectPath: string) => t.invoke('project:revising:finish', projectPath)
      },
      // Manuscript margin notes (MANUSCRIPT_NOTES.md)
      notes: {
        list: (projectPath: string) => t.invoke('project:notes:list', projectPath),
        add: (
          projectPath: string,
          note: { line: number; endLine: number; snippet: string; note: string }
        ) => t.invoke('project:notes:add', { projectPath, ...note }),
        update: (projectPath: string, id: string, note: string) =>
          t.invoke('project:notes:update', { projectPath, id, note }),
        delete: (projectPath: string, id: string) =>
          t.invoke('project:notes:delete', { projectPath, id }),
        // Scaffolds the address-notes skill if needed and returns a kickoff prompt
        // for the embedded terminal (absent when nothing is outstanding).
        address: (projectPath: string) =>
          t.invoke('project:notes:address', projectPath),
        // Fires when MANUSCRIPT_NOTES.md changes on disk (e.g. the address-notes
        // skill marking notes done), so the panel can reload and drop done notes.
        onChanged: (cb: () => void): (() => void) => {
          return t.on('project:notes:changed', () => cb())
        }
      },
      // Per-project manual references (policy articles, web pages, …) — a hand-
      // maintained bib (.lctrn/extra-refs.json → extra.bib) outside the library.
      extraRefs: {
        list: (projectPath: string) => t.invoke('project:extraRefs:list', projectPath),
        add: (projectPath: string, ref: unknown) =>
          t.invoke('project:extraRefs:add', { projectPath, ref }),
        update: (projectPath: string, citekey: string, ref: unknown) =>
          t.invoke('project:extraRefs:update', { projectPath, citekey, ref }),
        delete: (projectPath: string, citekey: string) =>
          t.invoke('project:extraRefs:delete', { projectPath, citekey })
      },
      // Mini source control: status chip + one-click sync (commit → pull → push).
      git: {
        status: (projectPath: string, fetch = false): Promise<GitStatus> =>
          t.invoke('project:git:status', { projectPath, fetch }),
        sync: (projectPath: string): Promise<GitSyncResult> =>
          t.invoke('project:git:sync', projectPath)
      },
      // Checkpoint review: what Claude changed, grouped by the prompt that caused
      // it, with keep/revert per file. Snapshots are taken by Claude Code hooks
      // reporting into the app's loopback bridge — see main/checkpoints.ts.
      review: {
        state: (projectPath: string): Promise<ReviewState> =>
          t.invoke('project:review:state', projectPath),
        /** Unified patch for one file in one turn. */
        patch: (projectPath: string, id: string, path: string): Promise<string> =>
          t.invoke('project:review:patch', { projectPath, id, path }),
        /** Accept a turn — the edits stay, it stops showing up for review. */
        keep: (projectPath: string, id: string): Promise<void> =>
          t.invoke('project:review:keep', { projectPath, id }),
        revertFile: (
          projectPath: string,
          id: string,
          path: string
        ): Promise<{ ok: boolean; error?: string }> =>
          t.invoke('project:review:revertFile', { projectPath, id, path }),
        revert: (projectPath: string, id: string): Promise<{ ok: boolean; error?: string }> =>
          t.invoke('project:review:revert', { projectPath, id }),
        init: (projectPath: string): Promise<{ ok: boolean; error?: string }> =>
          t.invoke('project:review:init', projectPath),
        // Fires when a turn starts or ends in any embedded session, so the panel
        // can refresh without polling. Carries the project the turn ran in.
        onChanged: (cb: (projectPath: string) => void): (() => void) => {
          return t.on('project:review:changed', (projectPath: string) => cb(projectPath))
        }
      },
      render: (projectPath: string, format: 'pdf' | 'html', open = true) =>
        t.invoke('project:render', { projectPath, format, open }),
      // Open a rendered artifact in the OS viewer (used when auto-open is off).
      openOutput: (path: string): Promise<{ ok: boolean; error?: string }> =>
        t.invoke('project:open-output', path),
      // Render just the executable code chunks and return each one's output HTML,
      // for inline preview in the editor (does not touch the real document).
      previewCells: (projectPath: string) =>
        t.invoke('project:preview:cells', { projectPath }),
      onRenderData: (cb: (chunk: string) => void): (() => void) => {
        return t.on('project:render:data', (chunk: string) => cb(chunk))
      },
      onRenderExit: (
        cb: (r: { code: number; ok: boolean; outputPath: string | null }) => void
      ): (() => void) => {
        return t.on('project:render:exit', (r: { code: number; ok: boolean; outputPath: string | null }) => cb(r))
      }
    },
    pty: {
      spawn: (opts: { id: string; cwd: string; cmd?: string }): Promise<{ ok: boolean; error?: string }> =>
        t.invoke('pty:spawn', opts),
      write: (id: string, data: string): void => t.send('pty:write', { id, data }),
      resize: (id: string, size: { cols: number; rows: number }): void =>
        t.send('pty:resize', { id, ...size }),
      kill: (id: string): void => t.send('pty:kill', id),
      // Is this session still alive, and what has it printed? Lets a terminal
      // pane that was unmounted (modal closed) re-attach and replay instead of
      // spawning a second Claude.
      attach: (id: string): Promise<{ running: boolean; buffer: string }> =>
        t.invoke('pty:attach', id),
      // Events are tagged with the session id; each terminal subscribes and
      // ignores anything that isn't its own.
      onData: (id: string, cb: (data: string) => void): (() => void) => {
        return t.on('pty:data', (msg: { id: string; data: string }) => {
          if (msg.id === id) cb(msg.data)
        })
      },
      onExit: (id: string, cb: (code: number) => void): (() => void) => {
        return t.on('pty:exit', (msg: { id: string; code: number }) => {
          if (msg.id === id) cb(msg.code)
        })
      }
    },
    // "Talk to your literature": a selection of papers + a question, saved as a
    // folder under the library. Started from an embedded terminal; the answer is
    // written back as result.md.
    inquiries: {
      list: () => t.invoke('inquiries:list'),
      read: (slug: string) => t.invoke('inquiry:read', slug),
      // Live preview of which papers a selection resolves to (composer hit-set).
      resolve: (selection: unknown) => t.invoke('inquiry:resolve', selection),
      create: (args: { title: string; question: string; selection: unknown; draft?: boolean }) =>
        t.invoke('inquiry:create', args),
      // Rewrite an existing inquiry — editing a saved draft, or promoting one to a
      // run (draft: false) just before spawning its terminal.
      update: (args: {
        slug: string
        title: string
        question: string
        selection: unknown
        draft?: boolean
      }) => t.invoke('inquiry:update', args),
      delete: (slug: string) => t.invoke('inquiry:delete', slug),
      onChanged: (cb: () => void): (() => void) => {
        return t.on('inquiries:changed', () => cb())
      }
    }
  }

  return api
}

export type Api = ReturnType<typeof createApi>
