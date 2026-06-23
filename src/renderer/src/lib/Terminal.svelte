<script lang="ts">
  import TermSession from './TermSession.svelte'
  import Icon from './Icon.svelte'
  import type { ProjectSummary } from '../global'

  let {
    projects,
    libraryRoot,
    open = true,
    ontoggle
  }: {
    projects: ProjectSummary[]
    libraryRoot: string | null
    open?: boolean
    ontoggle: () => void
  } = $props()

  // The dock holds any number of concurrent Claude sessions, shown as tabs. Each
  // is scoped either to a project (cwd = project path) or to "No project" (cwd =
  // library root) — so you can run a project's Claude and a free-form "chat about
  // a paper" Claude at the same time. The Inquiries modal owns its own pty id, so
  // none of these clobber each other.
  type DockSession = {
    id: string
    label: string
    cwd: string
    kind: 'project' | 'none'
    kickoff: string | null
    running: boolean
    ref: { send: (t: string) => void; focus: () => void } | null
  }

  let sessions = $state<DockSession[]>([])
  let activeId = $state<string | null>(null)
  let seq = 0 // monotonic counter → unique pty ids (Math.random/Date are unavailable)
  let launchMenuOpen = $state(false)

  const active = $derived(sessions.find((s) => s.id === activeId) ?? null)

  // Dock height in px when open; the user drags the top edge to resize. Each
  // session's ResizeObserver refits xterm + its pty whenever this changes.
  let height = $state(220)
  const MIN_H = 90
  // True while dragging the resizer — mounts a full-window shield so mouse events
  // keep reaching this document instead of being swallowed by the reader's PDF
  // <iframe> (which would otherwise freeze the drag).
  let resizing = $state(false)

  function startResize(e: MouseEvent): void {
    e.preventDefault()
    e.stopPropagation()
    const startY = e.clientY
    const startH = height
    const maxH = window.innerHeight - 120
    resizing = true
    const onMove = (ev: MouseEvent): void => {
      // Dock is anchored at the bottom, so dragging up (smaller clientY) grows it.
      height = Math.max(MIN_H, Math.min(maxH, startH + (startY - ev.clientY)))
    }
    const onUp = (): void => {
      resizing = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'row-resize'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  function createSession(opts: {
    project: ProjectSummary | null
    kickoff?: string | null
  }): DockSession | null {
    const { project } = opts
    const cwd = project ? project.path : libraryRoot
    if (!cwd) return null // "No project" needs a library root to run in
    const s: DockSession = {
      id: `dock-${++seq}`,
      label: project ? project.title : 'No project',
      cwd,
      kind: project ? 'project' : 'none',
      kickoff: opts.kickoff ?? null,
      running: false,
      ref: null
    }
    sessions = [...sessions, s]
    activeId = s.id
    if (!open) ontoggle()
    return s
  }

  // Launch from the dropdown. One session per project (focus it if it already
  // exists); "No project" always opens a fresh session so you can keep several
  // paper chats going.
  function launch(project: ProjectSummary | null): void {
    launchMenuOpen = false
    if (project) {
      const existing = sessions.find((s) => s.kind === 'project' && s.cwd === project.path)
      if (existing) {
        activeId = existing.id
        if (!open) ontoggle()
        existing.ref?.focus()
        return
      }
    }
    createSession({ project })
  }

  function selectSession(id: string, e: MouseEvent): void {
    e.stopPropagation()
    activeId = id
    if (!open) ontoggle()
    sessions.find((s) => s.id === id)?.ref?.focus()
  }

  function closeSession(id: string, e: MouseEvent): void {
    e.stopPropagation()
    sessions = sessions.filter((s) => s.id !== id)
    if (activeId === id) activeId = sessions.at(-1)?.id ?? null
  }

  /**
   * Route a kickoff prompt to a Claude session, exported for App (reader prompt
   * templates, workspace "learn edits" / "address notes"). Opens the dock first.
   * - With a project: target that project's session, creating it if absent.
   * - Without: target the active session; if none, open a fresh "No project" one.
   * A brand-new session auto-types the kickoff once its TUI is up (via the prop);
   * an already-running one is typed into immediately.
   */
  export async function dispatchClaude(
    kickoff: string,
    opts?: { project?: ProjectSummary | null }
  ): Promise<void> {
    if (!open) ontoggle()
    const project = opts?.project ?? null
    const target = project
      ? (sessions.find((s) => s.kind === 'project' && s.cwd === project.path) ?? null)
      : active
    if (target) {
      activeId = target.id
      target.ref?.send(kickoff)
      target.ref?.focus()
      return
    }
    createSession({ project, kickoff })
  }
</script>

{#if resizing}
  <!-- Transparent shield over the whole window during a drag so the PDF iframe
       in the reader can't capture the mouse and stall the resize. -->
  <div class="term-drag-shield"></div>
{/if}
<div class="termdock {open ? 'open' : 'closed'}">
  <!-- The whole panel floats over the workspace (anchored to the bottom, growing
       upward) so resizing never reflows the manuscript area. The header bar sits
       at the top; session panes stay mounted across open/close so the ptys
       survive. -->
  <div class="term-panel" style={open ? `height: ${height}px` : ''}>
    {#if open}
      <div
        class="term-resizer"
        onmousedown={startResize}
        role="separator"
        aria-label="Resize terminal"
        title="Drag to resize"
      ></div>
    {/if}
    <div
      class="term-bar"
      onclick={ontoggle}
      role="button"
      tabindex="0"
      onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && ontoggle()}
    >
      <span class="dot" data-idle={!active?.running}></span>
      <span class="t">terminal</span>

      <div class="term-tabs">
        {#each sessions as s (s.id)}
          <div class="tt" data-on={activeId === s.id} data-kind={s.kind}>
            <button class="tt-main" title={s.cwd} onclick={(e) => selectSession(s.id, e)}>
              <span class="tt-dot" data-idle={!s.running}></span>
              <Icon n={s.kind === 'project' ? 'folder' : 'sparkle'} />
              <span class="tt-label">{s.label}</span>
            </button>
            <button class="tt-x" title="Close session" onclick={(e) => closeSession(s.id, e)}>
              <Icon n="x" />
            </button>
          </div>
        {/each}
      </div>

      <span class="spacer"></span>

      <div class="term-launcher">
        <button
          class="term-launch"
          onclick={(e) => {
            e.stopPropagation()
            launchMenuOpen = !launchMenuOpen
          }}
        >
          <Icon n="plus" />launch claude<Icon n="chevron-down" />
        </button>
        {#if launchMenuOpen}
          <button
            class="tl-backdrop"
            aria-label="Close menu"
            onclick={(e) => {
              e.stopPropagation()
              launchMenuOpen = false
            }}
          ></button>
          <div
            class="tl-menu"
            role="menu"
            tabindex="-1"
            onclick={(e) => e.stopPropagation()}
            onkeydown={(e) => e.stopPropagation()}
          >
            <div class="tl-head">Start Claude in…</div>
            <button class="tl-item" role="menuitem" disabled={!libraryRoot} onclick={() => launch(null)}>
              <Icon n="sparkle" />
              <span class="tl-name">No project</span>
              <span class="tl-sub">chat about a paper</span>
            </button>
            {#if projects.length}
              <div class="tl-sep"></div>
              <div class="tl-grouphead">Projects</div>
              {#each projects as p (p.path)}
                <button class="tl-item" role="menuitem" onclick={() => launch(p)}>
                  <Icon n="folder" />
                  <span class="tl-name">{p.title}</span>
                </button>
              {/each}
            {/if}
          </div>
        {/if}
      </div>

      <span class="tag">⌘J</span>
    </div>

    <div class="term-stage">
      {#each sessions as s (s.id)}
        <div class="term-pane" data-on={activeId === s.id}>
          <TermSession
            bind:this={s.ref}
            sid={s.id}
            cwd={s.cwd}
            kickoff={s.kickoff}
            visible={open && activeId === s.id}
            onrunning={(r) => (s.running = r)}
          />
        </div>
      {/each}
      {#if sessions.length === 0}
        <div class="term-empty">
          <Icon n="terminal" />
          <p>No Claude session running.</p>
          <small>
            <strong>Launch claude</strong> scoped to a project, or with
            <strong>No project</strong> to just chat about a paper.
          </small>
        </div>
      {/if}
    </div>
  </div>
</div>
