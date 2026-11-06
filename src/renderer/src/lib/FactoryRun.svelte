<script lang="ts">
  // One factory run: a board of stages (columns) and their agents (cards), the
  // gate panel when the run is waiting on you, and a detail pane for whatever
  // you clicked — an agent's output (editable), its live activity, or its
  // session reopened as a real Claude terminal.
  import Icon from './Icon.svelte'
  import TermSession from './TermSession.svelte'
  import { renderMarkdown } from './markdown'
  import type { FactoryDetail, FactoryEvent, AgentRef, AgentState, StageId } from '../global'

  let { slug, onedit, ondeleted }: {
    slug: string
    onedit: () => void
    ondeleted: () => void
  } = $props()

  const ALL_STAGES: StageId[] = ['lit', 'execute', 'empirics', 'convene', 'editor']
  const LABEL: Record<StageId, string> = {
    lit: 'Literature scan',
    execute: 'Repo work',
    empirics: 'Empirics',
    convene: 'Convene',
    editor: 'Editor'
  }
  const VERDICT_LABEL = { accept: 'Accept', minor: 'Minor revision', major: 'Major revision', reject: 'Reject' }

  let detail = $state<FactoryDetail | null>(null)
  // What the detail pane shows: the idea, or one agent of one round.
  let sel = $state<{ kind: 'idea' } | { kind: 'agent'; stage: StageId; n: number }>({ kind: 'idea' })
  let tab = $state<'output' | 'activity' | 'chat'>('output')
  let output = $state<string | null>(null)
  let editing = $state(false)
  let draft = $state('')
  let events = $state<FactoryEvent[]>([])
  let feedback = $state<string | null>(null)
  let chat = $state<{ sid: string; cwd: string; cmd: string } | null>(null)
  let note = $state('')
  let backTo = $state<StageId>('empirics')
  let busy = $state(false)
  let tick = $state(Date.now())
  let activityEl = $state<HTMLDivElement | null>(null)

  const run = $derived(detail?.run ?? null)
  // Repo work only shows when it is on for this run (or ran before).
  const STAGES = $derived(
    ALL_STAGES.filter(
      (id) => id !== 'execute' || (run && ((run.config.stages.execute?.enabled && run.config.paper?.empirics) || run.stages.execute?.round))
    )
  )
  // In an intro run the convene stage's job is writing the introduction.
  const label = (id: StageId): string =>
    id === 'convene' && run?.config.deliverable === 'frontend'
      ? 'Front end'
      : id === 'convene' && run?.config.deliverable === 'intro'
      ? 'Introduction'
      : id === 'empirics' && run?.config.paper?.empirics
        ? 'Evidence brief'
        : id === 'lit' && run?.config.paper?.litFiles?.length
          ? 'Literature (reused)'
          : LABEL[id]
  const paperName = $derived(run?.config.paper?.project.split('/').filter(Boolean).at(-1) ?? null)

  /** The agent the detail pane points at, against the stage's current round. */
  const selRef = $derived.by((): AgentRef | null => {
    if (!run || sel.kind !== 'agent') return null
    const st = run.stages[sel.stage]
    if (!st.round) return null
    return { slug, stage: sel.stage, round: st.round, n: sel.n }
  })
  const selAgent = $derived.by((): AgentState | null => {
    if (!run || sel.kind !== 'agent') return null
    const n = sel.n
    return run.stages[sel.stage].agents.find((a) => a.n === n) ?? null
  })

  const totalCost = $derived(
    run
      ? STAGES.reduce((s, id) => s + run.stages[id].agents.reduce((t, a) => t + (a.costUsd ?? 0), 0), 0)
      : 0
  )

  async function load(): Promise<void> {
    detail = await window.api.factory.read(slug)
  }

  $effect(() => {
    void slug
    sel = { kind: 'idea' }
    chat = null
    editing = false
    void load()
    const offChanged = window.api.factory.onChanged((s) => {
      if (s === slug) void load()
    })
    const offEvent = window.api.factory.onEvent((m) => {
      const r = selRef
      if (!r || m.slug !== r.slug || m.stage !== r.stage || m.round !== r.round || m.n !== r.n) return
      events = [...events, m.event]
    })
    const timer = setInterval(() => (tick = Date.now()), 1000)
    return () => {
      offChanged()
      offEvent()
      clearInterval(timer)
    }
  })

  // Default the "send back to" choice to something sensible for the gate.
  $effect(() => {
    if (!run?.current) return
    backTo = run.current === 'editor' ? 'empirics' : run.current
  })

  // Reload the selected agent's output, activity and round feedback when the
  // selection changes, and its output whenever the run changes (unless you're
  // editing it).
  const selKey = $derived(selRef ? `${selRef.stage}/${selRef.round}/${selRef.n}` : 'idea')
  $effect(() => {
    void selKey
    const r = selRef
    chat = null
    editing = false
    events = []
    feedback = null
    if (!r) return
    void window.api.factory.events(r).then((e) => (events = e))
    void window.api.factory.feedback(r.slug, r.stage, r.round).then((f) => (feedback = f))
  })
  $effect(() => {
    void run
    const r = selRef
    if (!r || editing) return
    void window.api.factory.output.get(r).then((o) => {
      if (!editing) output = o
    })
  })

  $effect(() => {
    void events.length
    if (tab === 'activity' && activityEl) {
      const el = activityEl
      requestAnimationFrame(() => (el.scrollTop = el.scrollHeight))
    }
  })

  function pick(stage: StageId, n: number): void {
    sel = { kind: 'agent', stage, n }
    const a = run?.stages[stage].agents.find((x) => x.n === n)
    tab = a?.status === 'running' || a?.status === 'queued' ? 'activity' : 'output'
  }

  function elapsed(a: AgentState): string {
    if (!a.startedAt) return ''
    const end = a.endedAt ? Date.parse(a.endedAt) : tick
    const s = Math.max(0, Math.round((end - Date.parse(a.startedAt)) / 1000))
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  }

  async function act(fn: () => Promise<unknown>): Promise<void> {
    busy = true
    try {
      await fn()
      note = ''
    } catch (e) {
      alert((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      busy = false
      await load()
    }
  }

  async function saveOutput(): Promise<void> {
    if (!selRef) return
    await window.api.factory.output.save(selRef, draft)
    output = draft
    editing = false
  }

  async function openChat(): Promise<void> {
    if (!selRef) return
    const r = await window.api.factory.resume(selRef)
    if (!r) return
    chat = { sid: `factory:${slug}:${selRef.stage}:${selRef.round}:${selRef.n}`, ...r }
    tab = 'chat'
  }

  async function remove(): Promise<void> {
    if (!confirm(`Delete “${run?.title}” and everything its agents produced?`)) return
    await window.api.factory.delete(slug)
    ondeleted()
  }

  const gate = $derived.by(() => {
    if (!run || run.status !== 'waiting' || !run.current) return null
    const st = run.stages[run.current]
    return {
      stage: run.current,
      failed: st.status === 'failed',
      done: st.agents.filter((a) => a.status === 'done').length,
      total: st.agents.length
    }
  })
  const backOptions = $derived(gate ? STAGES.slice(0, STAGES.indexOf(gate.stage) + 1) : [])
</script>

{#if run && detail}
  <div class="fr">
    <header class="fr-head">
      <div class="fr-title">
        <h2>{run.title}</h2>
        <span class="fr-status" data-s={run.status}>
          {run.status === 'waiting' ? 'Waiting for you' : run.status === 'draft' ? 'Draft' : run.status === 'running' ? 'Running' : run.status === 'done' ? 'Done' : 'Killed'}
        </span>
        {#if paperName}<span class="fr-cost" title={run.config.paper?.project}>{paperName}</span>{/if}
        {#if run.verdict}<span class="fr-verdict" data-v={run.verdict}>{VERDICT_LABEL[run.verdict]}</span>{/if}
        {#if totalCost > 0}<span class="fr-cost" title="What this would have cost at API prices, as Claude Code reports it. Runs use your Claude plan login, so nothing is billed — it counts against your plan's usage limits.">≈${totalCost.toFixed(2)} API-eq.</span>{/if}
      </div>
      <div class="fr-actions">
        {#if run.status === 'draft'}
          <button class="btn btn--primary" disabled={busy} onclick={() => act(() => window.api.factory.start(slug))}><Icon n="sparkle" />Start</button>
        {/if}
        <button class="btn btn--ghost" onclick={onedit} title="Stage settings — changes apply to stages that haven't run yet"><Icon n="pen" />Settings</button>
        <button class="btn btn--ghost" onclick={() => window.api.factory.openDir(slug)} title={detail.dir}><Icon n="folder" />Folder</button>
        {#if run.status === 'running' || run.status === 'waiting'}
          <button class="btn btn--ghost" disabled={busy} onclick={() => { if (confirm('Stop every agent and end this run?')) void act(() => window.api.factory.kill(slug)) }}><Icon n="x" />Kill</button>
        {/if}
        <button class="iconbtn" title="Delete run" onclick={remove}><Icon n="trash" /></button>
      </div>
    </header>

    <!-- ---- Board ---- -->
    <div class="fr-board">
      <div class="fr-col">
        <div class="fr-col-head"><span>Idea</span></div>
        <button class="fr-card" data-on={sel.kind === 'idea'} onclick={() => (sel = { kind: 'idea' })}>
          <span class="fr-card-line">{detail.idea.trim().split('\n')[0] || '(empty)'}</span>
        </button>
      </div>
      {#each STAGES as id (id)}
        {@const st = run.stages[id]}
        {@const cfg = run.config.stages[id]}
        <div class="fr-arrow" aria-hidden="true"><Icon n="chevron-right" /></div>
        <div class="fr-col" data-current={run.current === id}>
          <div class="fr-col-head">
            <span>{label(id)}</span>
            {#if st.round > 1}<span class="fr-round" title="Round {st.round}">r{st.round}</span>{/if}
            <span class="fr-pill" data-s={st.status}>{st.status === 'gate' ? 'review' : st.status}</span>
          </div>
          {#if st.agents.length}
            {#each st.agents as a (a.n)}
              <button
                class="fr-card"
                data-on={sel.kind === 'agent' && sel.stage === id && sel.n === a.n}
                onclick={() => pick(id, a.n)}
              >
                <span class="fr-card-top">
                  <span class="fr-dot" data-s={a.status}></span>
                  <span class="fr-card-name">{id === 'editor' ? (st.agents.length > 1 ? `Referee ${a.n}` : 'Editor') : id === 'convene' ? 'Lead author' : `Agent ${a.n}`}</span>
                  <span class="fr-card-meta">{elapsed(a)}</span>
                </span>
                {#if a.task}<span class="fr-card-line">{a.task}</span>{/if}
                {#if a.error}<span class="fr-card-line fr-card-err">{a.error}</span>{/if}
              </button>
            {/each}
          {:else}
            <div class="fr-plan">
              {id === 'convene' ? '1 lead author' : `${cfg.agents} ${id === 'editor' ? (cfg.agents > 1 ? 'referees' : 'editor') : 'agents'}`}
              {#if id === 'lit' || id === 'empirics'}· {cfg.mode === 'split' ? 'split work' : 'independent'}{/if}
              {#if cfg.gate}· gate{/if}
              {#if cfg.autonomy === 'full'}· full autonomy{/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>

    <!-- ---- Gate ---- -->
    {#if gate}
      <div class="fr-gate" data-failed={gate.failed}>
        <div class="fr-gate-msg">
          {#if gate.failed}
            <strong>{label(gate.stage)}: {gate.total - gate.done} of {gate.total} agents didn't finish.</strong>
            Retry them, continue with the {gate.done} that did, or send the stage back with a note.
          {:else if gate.stage === 'editor'}
            <strong>The editor has reported{run.verdict ? ` — ${VERDICT_LABEL[run.verdict].toLowerCase()}` : ''}.</strong>
            {#if run.autoStop}<span class="fr-autostop">{run.autoStop}</span>{/if}
            Accept to close the run, or send it back with the report as feedback.
          {:else}
            <strong>{label(gate.stage)} is ready for your review.</strong>
            Read and edit the outputs, ask an agent questions in its session, then continue or send it back.
          {/if}
        </div>
        <textarea class="fr-note" bind:value={note} placeholder={gate.stage === 'editor' ? 'What should the revision prioritise? (the editor report is passed along automatically)' : 'Note for the agents — sent with a send-back, or to the next stage on continue'}></textarea>
        <div class="fr-gate-actions">
          {#if gate.failed}
            <button class="btn btn--primary" disabled={busy} onclick={() => act(() => window.api.factory.retry(slug))}><Icon n="refresh" />Retry failed</button>
            {#if gate.done}
              <button class="btn btn--secondary" disabled={busy} onclick={() => act(() => window.api.factory.approve(slug, note))}>Continue with {gate.done}</button>
            {/if}
          {:else if gate.stage === 'editor'}
            <button class="btn btn--primary" disabled={busy} onclick={() => act(() => window.api.factory.accept(slug))}><Icon n="check" />{run.config.paper ? (run.config.deliverable === 'frontend' ? 'Accept & replace front end' : 'Accept & replace manuscript intro') : 'Accept & finish'}</button>
          {:else}
            <button class="btn btn--primary" disabled={busy} onclick={() => act(() => window.api.factory.approve(slug, note))}><Icon n="check" />Continue to {label(STAGES[STAGES.indexOf(gate.stage) + 1])}</button>
          {/if}
          <span class="fr-gate-sep"></span>
          <span class="fr-gate-lbl">Send back to</span>
          <select class="fr-select" bind:value={backTo}>
            {#each backOptions as o (o)}<option value={o}>{label(o)}{o === gate.stage ? ' (redo)' : ''}</option>{/each}
          </select>
          <button class="btn btn--secondary" disabled={busy || (!note.trim() && gate.stage !== 'editor')} title={!note.trim() && gate.stage !== 'editor' ? 'Write what should change first' : ''} onclick={() => act(() => window.api.factory.sendBack(slug, backTo, note))}><Icon n="refresh" />Send back</button>
        </div>
      </div>
    {/if}

    <!-- ---- Detail ---- -->
    <div class="fr-detail">
      {#if sel.kind === 'idea'}
        <div class="fr-detail-head"><span class="fr-detail-title">Idea</span></div>
        <div class="fr-md md">{@html renderMarkdown(detail.idea)}</div>
      {:else if selAgent && selRef}
        <div class="fr-detail-head">
          <span class="fr-detail-title">{label(selRef.stage)}{selRef.stage === 'editor' && run.stages.editor.agents.length < 2 ? '' : ` · ${selRef.stage === 'convene' ? 'Lead author' : selRef.stage === 'editor' ? `Referee ${selRef.n}` : `Agent ${selRef.n}`}`}{selRef.round > 1 ? ` · round ${selRef.round}` : ''}</span>
          <span class="fr-dot" data-s={selAgent.status}></span><span class="fr-faint">{selAgent.status}{selAgent.costUsd ? ` · ≈$${selAgent.costUsd.toFixed(2)} API-eq.` : ''}</span>
          <div class="fr-tabs">
            <button data-on={tab === 'output'} onclick={() => (tab = 'output')}>Output</button>
            <button data-on={tab === 'activity'} onclick={() => (tab = 'activity')}>Activity</button>
            <button data-on={tab === 'chat'} onclick={() => (chat ? (tab = 'chat') : void openChat())} disabled={selAgent.status === 'running' || selAgent.status === 'queued'} title={selAgent.status === 'running' ? 'Available once the agent has finished' : 'Reopen this agent’s session as a Claude terminal'}>Session</button>
          </div>
          {#if selAgent.status === 'running'}
            <button class="btn btn--ghost" onclick={() => selRef && window.api.factory.stopAgent(selRef)}><Icon n="x" />Stop</button>
          {/if}
        </div>
        {#if selAgent.task}<div class="fr-task"><span class="fr-faint">Sub-task</span> {selAgent.task}</div>{/if}
        {#if feedback && tab !== 'chat'}
          <details class="fr-feedback"><summary>Feedback given to this round</summary><div class="md">{@html renderMarkdown(feedback)}</div></details>
        {/if}

        {#if tab === 'output'}
          {#if editing}
            <textarea class="fr-edit" bind:value={draft}></textarea>
            <div class="fr-edit-bar">
              <span class="fr-faint">The next stage reads this file as it is when it starts.</span>
              <span class="fr-spacer"></span>
              <button class="btn btn--ghost" onclick={() => (editing = false)}>Cancel</button>
              <button class="btn btn--primary" onclick={saveOutput}>Save</button>
            </div>
          {:else if output !== null}
            <div class="fr-out-bar">
              <button class="btn btn--ghost" disabled={selAgent.status === 'running'} onclick={() => { draft = output ?? ''; editing = true }}><Icon n="pen" />Edit</button>
            </div>
            <div class="fr-md md">{@html renderMarkdown(output)}</div>
          {:else}
            <div class="fr-empty">{selAgent.status === 'running' || selAgent.status === 'queued' ? 'No output yet — follow along under Activity.' : 'This agent left no output.md.'}</div>
          {/if}
        {:else if tab === 'activity'}
          <div class="fr-activity" bind:this={activityEl}>
            {#each events as ev, i (i)}
              <div class="fr-ev" data-k={ev.kind}>
                {#if ev.kind === 'text'}<div class="md">{@html renderMarkdown(ev.text)}</div>{:else}{ev.text}{/if}
              </div>
            {:else}
              <div class="fr-empty">Nothing yet.</div>
            {/each}
          </div>
        {:else if chat}
          <div class="fr-term">
            {#key chat.sid}
              <TermSession sid={chat.sid} cwd={chat.cwd} cmd={chat.cmd} />
            {/key}
          </div>
        {/if}
      {:else}
        <div class="fr-empty">Pick a card.</div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .fr {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .fr-head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 20px 10px;
  }
  .fr-title {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    flex: 1;
  }
  .fr-title h2 {
    margin: 0;
    font-size: var(--fs-17);
    font-weight: var(--fw-semibold);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .fr-status,
  .fr-verdict,
  .fr-cost,
  .fr-pill,
  .fr-round {
    flex: none;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.04em;
    padding: 2px 7px;
    border-radius: var(--r-pill);
    background: var(--bg-sunken);
    color: var(--text-muted);
    text-transform: uppercase;
  }
  .fr-status[data-s='running'],
  .fr-pill[data-s='running'] {
    background: var(--info-bg);
    color: var(--info);
  }
  .fr-status[data-s='waiting'],
  .fr-pill[data-s='gate'] {
    background: var(--warning-bg);
    color: var(--warning);
  }
  .fr-status[data-s='done'],
  .fr-pill[data-s='done'] {
    background: var(--success-bg);
    color: var(--success);
  }
  .fr-pill[data-s='failed'],
  .fr-status[data-s='killed'] {
    background: var(--danger-bg);
    color: var(--danger);
  }
  .fr-verdict[data-v='accept'],
  .fr-verdict[data-v='minor'] {
    background: var(--success-bg);
    color: var(--success);
  }
  .fr-verdict[data-v='major'] {
    background: var(--warning-bg);
    color: var(--warning);
  }
  .fr-verdict[data-v='reject'] {
    background: var(--danger-bg);
    color: var(--danger);
  }
  .fr-cost {
    text-transform: none;
  }
  .fr-actions {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  /* board */
  .fr-board {
    flex: none;
    display: flex;
    align-items: flex-start;
    gap: 4px;
    padding: 4px 20px 14px;
    overflow-x: auto;
    border-bottom: 1px solid var(--border);
  }
  .fr-col {
    flex: 1 1 0;
    min-width: 150px;
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 8px;
    border-radius: var(--r-md);
    border: 1px solid var(--border-subtle, var(--border));
    background: var(--bg-sunken);
  }
  .fr-col[data-current='true'] {
    border-color: var(--accent-line, var(--accent));
  }
  .fr-col-head {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-12);
    font-weight: var(--fw-semibold);
    padding: 0 2px 2px;
  }
  .fr-col-head > span:first-child {
    flex: 1;
  }
  .fr-arrow {
    flex: none;
    align-self: center;
    width: 14px;
    color: var(--text-faint);
  }
  .fr-arrow :global(svg) {
    width: 14px;
    height: 14px;
  }
  .fr-card {
    display: flex;
    flex-direction: column;
    gap: 3px;
    text-align: left;
    width: 100%;
    padding: 7px 8px;
    border-radius: var(--r-sm);
    border: 1px solid var(--border);
    background: var(--surface);
    cursor: pointer;
    font: inherit;
    color: var(--text);
  }
  .fr-card:hover {
    border-color: var(--border-strong);
  }
  .fr-card[data-on='true'] {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }
  .fr-card-top {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-12);
  }
  .fr-card-name {
    flex: 1;
  }
  .fr-card-meta {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-faint);
  }
  .fr-card-line {
    font-size: var(--fs-11);
    color: var(--text-muted);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .fr-card-err {
    color: var(--danger);
  }
  .fr-plan {
    font-size: var(--fs-11);
    color: var(--text-faint);
    padding: 4px 2px;
  }
  .fr-dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: var(--border-strong);
  }
  .fr-dot[data-s='running'] {
    background: var(--info);
    animation: fr-pulse 1.2s ease-in-out infinite;
  }
  .fr-dot[data-s='done'] {
    background: var(--success);
  }
  .fr-dot[data-s='failed'] {
    background: var(--danger);
  }
  .fr-dot[data-s='stopped'] {
    background: var(--warning);
  }
  @keyframes fr-pulse {
    50% {
      opacity: 0.35;
    }
  }

  /* gate */
  .fr-gate {
    flex: none;
    margin: 12px 20px 0;
    padding: 12px 14px;
    border-radius: var(--r-md);
    border: 1px solid var(--warning);
    background: var(--warning-bg);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .fr-gate[data-failed='true'] {
    border-color: var(--danger);
    background: var(--danger-bg);
  }
  .fr-autostop {
    display: block;
    margin-top: 4px;
    font-size: var(--fs-12);
    color: var(--text-muted);
  }
  .fr-gate-msg {
    font-size: var(--fs-13);
    line-height: var(--lh-normal);
  }
  .fr-note {
    font: inherit;
    font-size: var(--fs-12);
    min-height: 48px;
    resize: vertical;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    padding: 7px 9px;
  }
  .fr-gate-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .fr-gate-sep {
    flex: 1;
  }
  .fr-gate-lbl {
    font-size: var(--fs-12);
    color: var(--text-muted);
  }
  .fr-select {
    font: inherit;
    font-size: var(--fs-12);
    height: var(--h-md);
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-xs);
    padding: 0 6px;
  }

  /* detail */
  .fr-detail {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 10px 20px 14px;
  }
  .fr-detail-head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    padding-bottom: 8px;
  }
  .fr-detail-title {
    font-weight: var(--fw-semibold);
    font-size: var(--fs-13);
  }
  .fr-faint {
    font-size: var(--fs-11);
    color: var(--text-faint);
  }
  .fr-tabs {
    margin-left: auto;
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    overflow: hidden;
  }
  .fr-tabs button {
    font: inherit;
    font-size: var(--fs-12);
    padding: 4px 10px;
    background: transparent;
    border: none;
    color: var(--text-secondary, var(--text));
    cursor: pointer;
  }
  .fr-tabs button + button {
    border-left: 1px solid var(--border);
  }
  .fr-tabs button[data-on='true'] {
    background: var(--accent-weak);
    color: var(--accent);
  }
  .fr-tabs button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .fr-task {
    flex: none;
    font-size: var(--fs-12);
    padding-bottom: 8px;
  }
  .fr-feedback {
    flex: none;
    font-size: var(--fs-12);
    margin-bottom: 8px;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    max-height: 180px;
    overflow-y: auto;
  }
  .fr-feedback summary {
    cursor: pointer;
    color: var(--text-muted);
  }
  .fr-md {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    font-size: var(--fs-13);
    line-height: var(--lh-reading, 1.6);
    max-width: 860px;
  }
  .fr-out-bar {
    flex: none;
    display: flex;
    justify-content: flex-end;
    max-width: 860px;
  }
  .fr-edit {
    flex: 1;
    min-height: 0;
    font-family: var(--font-mono);
    font-size: var(--fs-12);
    line-height: 1.55;
    color: var(--text);
    background: var(--surface-inset, var(--bg-sunken));
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    padding: 10px 12px;
    resize: none;
  }
  .fr-edit-bar {
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
    padding-top: 8px;
  }
  .fr-spacer {
    flex: 1;
  }
  .fr-activity {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: var(--fs-12);
  }
  .fr-ev {
    padding: 3px 0;
    border-bottom: 1px solid var(--border-subtle, var(--border));
    overflow-wrap: anywhere;
  }
  .fr-ev[data-k='tool'] {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
  }
  .fr-ev[data-k='info'],
  .fr-ev[data-k='done'] {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-faint);
  }
  .fr-ev[data-k='done'] {
    color: var(--success);
  }
  .fr-ev[data-k='error'] {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--danger);
  }
  .fr-term {
    flex: 1;
    min-height: 0;
    background: var(--term-bg);
    border-radius: var(--r-sm);
    overflow: hidden;
  }
  .fr-empty {
    color: var(--text-faint);
    font-size: var(--fs-12);
    padding: 16px 0;
  }
  .md {
    color: var(--text);
  }
  .md :global(.cite) {
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 0.92em;
  }
  .md :global(table) {
    display: block;
    max-width: 100%;
    overflow-x: auto;
    border-collapse: collapse;
    margin: 10px 0;
    font-size: 12.5px;
  }
  .md :global(th),
  .md :global(td) {
    border: 1px solid var(--border);
    padding: 5px 9px;
    text-align: left;
    vertical-align: top;
  }
  .md :global(th) {
    background: var(--surface-inset);
    font-weight: 600;
  }
  .md :global(tbody tr:nth-child(even)) {
    background: var(--bg-sunken);
  }
  .md :global(h1),
  .md :global(h2),
  .md :global(h3) {
    font-size: 14px;
    margin: 16px 0 6px;
  }
  .md :global(p) {
    margin: 0 0 8px;
  }
  .md :global(ul),
  .md :global(ol) {
    margin: 0 0 8px;
    padding-left: 20px;
  }
  .md :global(pre) {
    font-size: 11.5px;
    overflow-x: auto;
    background: var(--bg-sunken);
    padding: 8px 10px;
    border-radius: var(--r-sm);
  }
</style>
