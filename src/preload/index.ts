import { contextBridge, ipcRenderer } from 'electron'
import type { UpdatePaperResult } from '../main/library'
import type { ExtractedMeta } from '../main/metadata'

const api = {
  // App-level window/menu wiring.
  app: {
    // Fires when the user picks File ▸ Close (⌘W). The renderer closes the
    // active reader tab if one is open, otherwise calls window.close().
    onCloseRequest: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on('menu:close', listener)
      return () => ipcRenderer.removeListener('menu:close', listener)
    },
    closeWindow: (): void => ipcRenderer.send('window:close')
  },
  library: {
    get: (): Promise<string | null> => ipcRenderer.invoke('library:get'),
    defaultPath: (): Promise<string> => ipcRenderer.invoke('library:defaultPath'),
    useDefault: (): Promise<string> => ipcRenderer.invoke('library:useDefault'),
    choose: (): Promise<string | null> => ipcRenderer.invoke('library:choose'),
    papers: () => ipcRenderer.invoke('library:papers'),
    tags: () => ipcRenderer.invoke('library:tags'),
    groups: () => ipcRenderer.invoke('library:groups'),
    setTagGroup: (tagId: string, groupId: string | null) =>
      ipcRenderer.invoke('library:setTagGroup', { tagId, groupId }),
    createGroup: (name: string) => ipcRenderer.invoke('library:createGroup', name),
    renameGroup: (groupId: string, name: string) =>
      ipcRenderer.invoke('library:renameGroup', { groupId, name }),
    deleteGroup: (groupId: string) => ipcRenderer.invoke('library:deleteGroup', groupId),
    createTag: (name: string) => ipcRenderer.invoke('library:createTag', name),
    renameTag: (tagId: string, name: string) =>
      ipcRenderer.invoke('library:renameTag', { tagId, name }),
    reorderTags: (entries: Array<{ id: string; groupId: string | null }>) =>
      ipcRenderer.invoke('library:reorderTags', entries),
    addTagToPapers: (tagId: string, paperIds: string[]) =>
      ipcRenderer.invoke('library:addTagToPapers', { tagId, paperIds }),
    deleteTag: (tagId: string) => ipcRenderer.invoke('library:deleteTag', tagId),
    pdf: (id: string): Promise<Uint8Array | null> => ipcRenderer.invoke('library:pdf', id),
    addPapers: () => ipcRenderer.invoke('library:addPapers'),
    updatePaper: (id: string, patch: unknown): Promise<UpdatePaperResult> =>
      ipcRenderer.invoke('library:updatePaper', { id, patch }),
    refetchPaper: (id: string): Promise<void> => ipcRenderer.invoke('library:refetchPaper', id),
    // Suggest a `surnameYear` citekey from (possibly unsaved) authors + year.
    suggestCitekey: (id: string, authors: string[], year?: string): Promise<string> =>
      ipcRenderer.invoke('library:suggestCitekey', { id, authors, year }),
    // Direct DOI→Crossref lookup for the edit form's Fetch button.
    fetchDoi: (doi: string): Promise<ExtractedMeta | null> =>
      ipcRenderer.invoke('library:fetchDoi', doi),
    renamePaper: (
      id: string
    ): Promise<{ renamed: boolean; reason?: string; from?: string; to?: string }> =>
      ipcRenderer.invoke('library:renamePaper', id),
    renamePreview: (): Promise<
      { id: string; title: string; currentName: string; proposedName: string }[]
    > => ipcRenderer.invoke('library:renamePreview'),
    removePaper: (id: string) => ipcRenderer.invoke('library:removePaper', id),
    // Per-paper reading notes (notes/<title>.md), shown beside the PDF reader.
    note: {
      get: (id: string) => ipcRenderer.invoke('library:note:get', id),
      save: (id: string, content: string) =>
        ipcRenderer.invoke('library:note:save', { id, content })
    },
    onChanged: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on('library:changed', listener)
      return () => ipcRenderer.removeListener('library:changed', listener)
    }
  },
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    create: (args: { name: string; meta: unknown }) => ipcRenderer.invoke('project:create', args),
    info: (projectPath: string) => ipcRenderer.invoke('project:info', projectPath),
    papers: (projectPath: string) => ipcRenderer.invoke('project:papers', projectPath),
    addPaper: (projectPath: string, id: string) =>
      ipcRenderer.invoke('project:addPaper', { projectPath, id }),
    removePaper: (projectPath: string, id: string) =>
      ipcRenderer.invoke('project:removePaper', { projectPath, id }),
    // Quarto documents: which is 'manuscript' | 'slides'
    doc: {
      get: (projectPath: string, which: 'manuscript' | 'slides') =>
        ipcRenderer.invoke('project:doc:get', { projectPath, which }),
      save: (projectPath: string, which: 'manuscript' | 'slides', content: string) =>
        ipcRenderer.invoke('project:doc:save', { projectPath, which, content }),
      // Watch the open project's .qmd files for external edits; null stops.
      watch: (projectPath: string | null) => ipcRenderer.invoke('project:doc:watch', projectPath),
      onChanged: (cb: (which: 'manuscript' | 'slides') => void): (() => void) => {
        const listener = (_e: unknown, which: 'manuscript' | 'slides'): void => cb(which)
        ipcRenderer.on('project:doc:changed', listener)
        return () => ipcRenderer.removeListener('project:doc:changed', listener)
      }
    },
    // Project config files (REVISION_PLAN.md, WRITING_STYLE.md, .claude/CLAUDE.md, …)
    files: {
      list: (projectPath: string) => ipcRenderer.invoke('project:files:list', projectPath),
      get: (projectPath: string, name: string) =>
        ipcRenderer.invoke('project:file:get', { projectPath, name }),
      save: (projectPath: string, name: string, content: string) =>
        ipcRenderer.invoke('project:file:save', { projectPath, name, content })
    },
    // Revising mode (track-changes → LEARNED_EDITS.md). Toggling off returns a
    // kickoff prompt to drop into the embedded terminal for the learn-edits run.
    revising: {
      state: (projectPath: string) => ipcRenderer.invoke('project:revising:state', projectPath),
      start: (projectPath: string) => ipcRenderer.invoke('project:revising:start', projectPath),
      finish: (projectPath: string) => ipcRenderer.invoke('project:revising:finish', projectPath)
    },
    // Manuscript margin notes (MANUSCRIPT_NOTES.md)
    notes: {
      list: (projectPath: string) => ipcRenderer.invoke('project:notes:list', projectPath),
      add: (
        projectPath: string,
        note: { line: number; endLine: number; snippet: string; note: string }
      ) => ipcRenderer.invoke('project:notes:add', { projectPath, ...note }),
      update: (projectPath: string, id: string, note: string) =>
        ipcRenderer.invoke('project:notes:update', { projectPath, id, note }),
      delete: (projectPath: string, id: string) =>
        ipcRenderer.invoke('project:notes:delete', { projectPath, id }),
      // Scaffolds the address-notes skill if needed and returns a kickoff prompt
      // for the embedded terminal (absent when nothing is outstanding).
      address: (projectPath: string) =>
        ipcRenderer.invoke('project:notes:address', projectPath),
      // Fires when MANUSCRIPT_NOTES.md changes on disk (e.g. the address-notes
      // skill marking notes done), so the panel can reload and drop done notes.
      onChanged: (cb: () => void): (() => void) => {
        const listener = (): void => cb()
        ipcRenderer.on('project:notes:changed', listener)
        return () => ipcRenderer.removeListener('project:notes:changed', listener)
      }
    },
    // Per-project manual references (policy articles, web pages, …) — a hand-
    // maintained bib (.lctrn/extra-refs.json → extra.bib) outside the library.
    extraRefs: {
      list: (projectPath: string) => ipcRenderer.invoke('project:extraRefs:list', projectPath),
      add: (projectPath: string, ref: unknown) =>
        ipcRenderer.invoke('project:extraRefs:add', { projectPath, ref }),
      update: (projectPath: string, citekey: string, ref: unknown) =>
        ipcRenderer.invoke('project:extraRefs:update', { projectPath, citekey, ref }),
      delete: (projectPath: string, citekey: string) =>
        ipcRenderer.invoke('project:extraRefs:delete', { projectPath, citekey })
    },
    render: (projectPath: string, which: 'manuscript' | 'slides', format: 'pdf' | 'html' | 'revealjs') =>
      ipcRenderer.invoke('project:render', { projectPath, which, format }),
    // Render just the executable code chunks and return each one's output HTML,
    // for inline preview in the editor (does not touch the real document).
    previewCells: (projectPath: string, which: 'manuscript' | 'slides') =>
      ipcRenderer.invoke('project:preview:cells', { projectPath, which }),
    onRenderData: (cb: (chunk: string) => void): (() => void) => {
      const listener = (_e: unknown, chunk: string): void => cb(chunk)
      ipcRenderer.on('project:render:data', listener)
      return () => ipcRenderer.removeListener('project:render:data', listener)
    },
    onRenderExit: (
      cb: (r: { code: number; ok: boolean; outputPath: string | null }) => void
    ): (() => void) => {
      const listener = (_e: unknown, r: { code: number; ok: boolean; outputPath: string | null }): void =>
        cb(r)
      ipcRenderer.on('project:render:exit', listener)
      return () => ipcRenderer.removeListener('project:render:exit', listener)
    }
  },
  pty: {
    spawn: (opts: { id: string; cwd: string; cmd?: string }): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('pty:spawn', opts),
    write: (id: string, data: string): void => ipcRenderer.send('pty:write', { id, data }),
    resize: (id: string, size: { cols: number; rows: number }): void =>
      ipcRenderer.send('pty:resize', { id, ...size }),
    kill: (id: string): void => ipcRenderer.send('pty:kill', id),
    // Events are tagged with the session id; each terminal subscribes and
    // ignores anything that isn't its own.
    onData: (id: string, cb: (data: string) => void): (() => void) => {
      const listener = (_e: unknown, msg: { id: string; data: string }): void => {
        if (msg.id === id) cb(msg.data)
      }
      ipcRenderer.on('pty:data', listener)
      return () => ipcRenderer.removeListener('pty:data', listener)
    },
    onExit: (id: string, cb: (code: number) => void): (() => void) => {
      const listener = (_e: unknown, msg: { id: string; code: number }): void => {
        if (msg.id === id) cb(msg.code)
      }
      ipcRenderer.on('pty:exit', listener)
      return () => ipcRenderer.removeListener('pty:exit', listener)
    }
  },
  // "Talk to your literature": a selection of papers + a question, saved as a
  // folder under the library. Started from an embedded terminal; the answer is
  // written back as result.md.
  inquiries: {
    list: () => ipcRenderer.invoke('inquiries:list'),
    read: (slug: string) => ipcRenderer.invoke('inquiry:read', slug),
    // Live preview of which papers a selection resolves to (composer hit-set).
    resolve: (selection: unknown) => ipcRenderer.invoke('inquiry:resolve', selection),
    create: (args: { title: string; question: string; selection: unknown }) =>
      ipcRenderer.invoke('inquiry:create', args),
    delete: (slug: string) => ipcRenderer.invoke('inquiry:delete', slug),
    onChanged: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on('inquiries:changed', listener)
      return () => ipcRenderer.removeListener('inquiries:changed', listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
