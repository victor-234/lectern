<script lang="ts">
  // The Factory composer: the idea plus the fixed template's knobs per stage
  // (agent count, independent vs split, sub-tasks, your instructions, gate,
  // autonomy). Used for a new run, a saved draft, and — with `started` — editing
  // a running run's config, which only affects stages that haven't run yet.
  import Icon from './Icon.svelte'
  import type { FactoryConfig, StageId, ProjectSummary } from '../global'

  let {
    slug = null,
    initialTitle = '',
    initialIdea = '',
    initialConfig,
    started = false,
    onsaved,
    onstarted,
    oncancel
  }: {
    slug?: string | null
    initialTitle?: string
    initialIdea?: string
    initialConfig: FactoryConfig
    /** The run is already under way: no Start, the idea is read-only. */
    started?: boolean
    onsaved: (slug: string) => void
    onstarted: (slug: string) => void
    oncancel: () => void
  } = $props()

  const STAGE_HINTS: Record<'intro' | 'memo', Array<{ id: StageId; label: string; hint: string }>> = {
    intro: [
      { id: 'lit', label: 'Literature scan', hint: 'Your library first, then the web: key papers, gaps, data — plus the framing material an intro needs (the regulator’s promise in its own words, one scale number, calls for research with pinpoints, the gap type).' },
      { id: 'execute', label: 'Repo work', hint: '' },
      { id: 'empirics', label: 'Empirics', hint: 'Downloads data (reusing your dataset registry), runs analyses in Python or R, reports results.' },
      { id: 'convene', label: 'Introduction', hint: 'The lead author reconciles the analysts, then writes the introduction against the framing guide and your model-paper anatomies, with an evidence table and open [SOURCE NEEDED] items.' },
      { id: 'editor', label: 'Editor', hint: 'Referees the introduction with the intro-check rubric — spine test, checklist, pitfalls, paragraph map, evidence check — and ends with a verdict. Always stops for you.' }
    ],
    memo: [
      { id: 'lit', label: 'Literature scan', hint: 'Searches your library first, then the web. Writes key papers, gaps, data sources.' },
      { id: 'execute', label: 'Repo work', hint: '' },
      { id: 'empirics', label: 'Empirics', hint: 'Downloads data (reusing your dataset registry), runs analyses in Python or R, reports results.' },
      { id: 'convene', label: 'Convene', hint: 'One lead author reads every analyst report and writes the consolidated results memo.' },
      { id: 'editor', label: 'Editor', hint: 'A critical journal editor reviews the memo and ends with a verdict. Always stops for you.' }
    ]
  }

  let title = $state(initialTitle)
  let idea = $state(initialIdea)
  let config = $state<FactoryConfig>($state.snapshot(initialConfig) as FactoryConfig)
  // Runs made before deliverables existed produced a memo.
  config.deliverable ??= 'memo'
  // …and before repo work and the revision loop existed, they had neither.
  config.stages.execute ??= { agents: 1, mode: 'independent', tasks: [], instructions: '', gate: false, autonomy: 'standard', enabled: false }
  config.autoRevise ??= { on: false, target: 'minor', maxRounds: 3 }

  // ---- linked paper -----------------------------------------------------------
  // A run can work on one of your projects: its literature notes stand in for
  // the scan, its empirics repo is read for an evidence brief, and the accepted
  // introduction replaces the manuscript's.
  let projects = $state<ProjectSummary[]>([])
  let paperProject = $state(initialConfig.paper?.project ?? '')
  let paperRepo = $state(initialConfig.paper?.empirics ?? '')
  let litFiles = $state<string[]>(initialConfig.paper?.litFiles ?? [])
  let mdFiles = $state<string[]>([])
  $effect(() => {
    void window.api.projects.list().then((p: ProjectSummary[]) => (projects = p))
  })
  // Pre-fill from what the project remembers (its repo, its literature files).
  let loadedFor = initialConfig.paper?.project ?? ''
  $effect(() => {
    const p = paperProject
    if (!p) return
    void window.api.factory.paperDefaults(p).then((d) => {
      mdFiles = d.mdFiles
      if (p === loadedFor) return // keep what this run already had
      loadedFor = p
      paperRepo = d.empirics ?? ''
      litFiles = d.litFiles
    })
  })
  const linked = $derived(Boolean(paperProject))
  const reuseLit = $derived(linked && litFiles.length > 0)
  const evidence = $derived(linked && Boolean(paperRepo.trim()))
  function toggleLit(f: string): void {
    litFiles = litFiles.includes(f) ? litFiles.filter((x) => x !== f) : [...litFiles, f]
  }

  const frontend = $derived(linked && config.deliverable === 'frontend')
  const STAGE_META = $derived(
    STAGE_HINTS[linked || config.deliverable !== 'memo' ? 'intro' : 'memo']
      // Repo work needs a repo; without one the stage doesn't exist.
      .filter((m) => m.id !== 'execute' || evidence)
      .map((m) =>
      m.id === 'execute'
        ? { ...m, hint: 'One agent works inside the empirics repo under its own CLAUDE.md, PRINCIPLES.md, review gate and reviewer — first bringing stale or REVISE results to a reviewed final render, later running the analyses the editor asks for. Never touches data/raw/ or the writing project; never commits. Takes hours.' }
        : m.id === 'convene' && frontend
          ? { ...m, label: 'Front end', hint: 'Rewrites the abstract, the introduction and the hypotheses section together, against the framing guide and your anatomies, so they tell one story the evidence supports. New sources go into sources.json. On accept the manuscript’s sections are replaced (a dated copy goes to revisions/) and DOIs are added to the project’s references.' }
          : m.id === 'editor' && frontend
            ? { ...m, hint: 'Referees the whole front end — the intro-check rubric plus the hypothesis rules and abstract–intro–hypotheses consistency — and ends with a verdict.' }
            : m.id === 'empirics' && evidence
        ? { ...m, label: 'Evidence brief', hint: 'Reads the empirics repo — final tables, notebooks and the latest reviews — and lists what each result supports, with its Robust / Sensitive / Fragile / Null status. Changes nothing in the repo; never uses draft renders.' }
        : m.id === 'convene' && linked
          ? { ...m, hint: m.hint + ' Starts from the manuscript’s current introduction and your INTRO drafts; on accept it replaces the manuscript’s Introduction (a dated copy goes to revisions/).' }
          : m
      )
  )
  // Sub-tasks are edited as one-per-line text.
  let tasksText = $state<Record<StageId, string>>({
    lit: initialConfig.stages.lit.tasks.join('\n'),
    empirics: initialConfig.stages.empirics.tasks.join('\n'),
    execute: '',
    convene: '',
    editor: ''
  })
  let busy = $state(false)
  let error = $state<string | null>(null)
  let templateSaved = $state(false)

  function snapshot(): FactoryConfig {
    const c = $state.snapshot(config) as FactoryConfig
    for (const id of ['lit', 'empirics'] as StageId[]) {
      c.stages[id].tasks = tasksText[id].split('\n').map((t) => t.trim()).filter(Boolean)
    }
    c.paper = paperProject
      ? { project: paperProject, empirics: paperRepo.trim() || null, litFiles: $state.snapshot(litFiles) as string[] }
      : null
    if (c.paper && c.deliverable !== 'frontend') c.deliverable = 'intro'
    if (!c.paper && c.deliverable === 'frontend') c.deliverable = 'intro'
    return c
  }

  async function save(): Promise<string | null> {
    error = null
    if (!idea.trim()) {
      error = 'Write the idea first — it is the only input to the first stage.'
      return null
    }
    busy = true
    try {
      if (slug) {
        await window.api.factory.update({ slug, title, idea: started ? undefined : idea, config: snapshot() })
        return slug
      }
      const run = await window.api.factory.create({ title, idea, config: snapshot() })
      return run.slug
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      return null
    } finally {
      busy = false
    }
  }

  async function saveDraft(): Promise<void> {
    const s = await save()
    if (s) onsaved(s)
  }

  async function start(): Promise<void> {
    const s = await save()
    if (!s) return
    await window.api.factory.start(s)
    onstarted(s)
  }

  async function saveTemplate(): Promise<void> {
    await window.api.factory.template.save(snapshot())
    templateSaved = true
    setTimeout(() => (templateSaved = false), 1800)
  }

  const totalAgents = $derived(
    STAGE_META.reduce(
      (n, s) =>
        n +
        (s.id === 'lit' && reuseLit
          ? 0
          : s.id === 'execute'
            ? config.stages.execute.enabled ? 1 : 0
            : s.id === 'convene'
              ? 1
              : config.stages[s.id].agents),
      0
    )
  )
</script>

<div class="fc">
  <div class="fc-scroll">
    <div class="fc-head">
      <h2>{slug ? (started ? 'Run settings' : 'Edit draft') : 'New factory run'}</h2>
      <p class="fc-sub">
        Idea → literature → empirics → convene → editor. Each agent is a headless Claude Code session in its own folder;
        you can open any of them as a terminal later.
      </p>
    </div>

    <label class="fc-field">
      <span class="fc-label">Title</span>
      <input class="input" bind:value={title} placeholder="Short name for this run" />
    </label>

    <label class="fc-field">
      <span class="fc-label">Idea</span>
      <textarea
        class="input fc-idea"
        bind:value={idea}
        readonly={started}
        placeholder="The research idea, as you'd pitch it to a coauthor: question, why it matters, hunches about data or identification, what would surprise you."
      ></textarea>
      {#if started}<span class="fc-note">The idea is fixed once a run has started — stages already ran on it.</span>{/if}
    </label>

    <div class="fc-field">
      <span class="fc-label">Paper <span class="fc-faint">· optional · work on one of your projects instead of from scratch</span></span>
      <select class="input" bind:value={paperProject} disabled={started}>
        <option value="">None — a new idea</option>
        {#each projects as p (p.path)}<option value={p.path}>{p.title}</option>{/each}
      </select>
      {#if linked}
        <div class="fc-paper">
          <label class="fc-field">
            <span class="fc-label">Empirics repo <span class="fc-faint">· read-only for agents · remembered for this project</span></span>
            <input class="input fc-path" bind:value={paperRepo} placeholder="/Users/…/paper/my-empirics-repo — leave empty to run fresh analyses" />
          </label>
          <div class="fc-field">
            <span class="fc-label">Literature from the project <span class="fc-faint">· replaces the scan; none ticked = run a scan</span></span>
            <div class="fc-files">
              {#each mdFiles as f (f)}
                <label class="fc-check"><input type="checkbox" checked={litFiles.includes(f)} onchange={() => toggleLit(f)} />{f}</label>
              {:else}
                <span class="fc-faint">No markdown files at the project root.</span>
              {/each}
            </div>
          </div>
          <span class="fc-note">Agents can read the project and the repo but not write to them — except Repo work, if you switch it on below, which works inside the repo. Only accepting the editor’s gate writes into manuscript.qmd.</span>
        </div>
      {/if}
    </div>

    {#if linked}
    <div class="fc-field">
      <span class="fc-label">Deliverable</span>
      <div class="fc-row">
        <div class="seg">
          <button data-on={config.deliverable !== 'frontend'} onclick={() => (config.deliverable = 'intro')}>Introduction</button>
          <button data-on={config.deliverable === 'frontend'} onclick={() => (config.deliverable = 'frontend')}>Front end</button>
        </div>
        <span class="fc-hint">
          {config.deliverable === 'frontend'
            ? 'Abstract, introduction and hypotheses, written and refereed together; accept replaces all of them in manuscript.qmd.'
            : 'Only the introduction; accept replaces the manuscript’s Introduction.'}
        </span>
      </div>
    </div>
    {/if}

    {#if !linked}
    <div class="fc-field">
      <span class="fc-label">Deliverable</span>
      <div class="fc-row">
        <div class="seg">
          <button data-on={config.deliverable === 'intro'} onclick={() => (config.deliverable = 'intro')}>Introduction</button>
          <button data-on={config.deliverable === 'memo'} onclick={() => (config.deliverable = 'memo')}>Results memo</button>
        </div>
        <span class="fc-hint">
          {config.deliverable === 'intro'
            ? 'Ends in a draft introduction, written against INTRO_GUIDE.md (copied into the run — edit it there per paper) and the anatomies in your library’s anatomy/ folder.'
            : 'Ends in a consolidated results memo, refereed as a submission.'}
        </span>
      </div>
    </div>
    {/if}

    <div class="fc-stages">
      {#each STAGE_META as s, i (s.id)}
        {@const st = config.stages[s.id]}
        <section class="fc-stage">
          <header class="fc-stage-head">
            <span class="fc-step">{i + 1}</span>
            <div class="fc-stage-title">
              <span>{s.label}{s.id === 'lit' && reuseLit ? ' — reused' : ''}</span>
              <span class="fc-hint">{s.id === 'lit' && reuseLit ? `No agents: the stage hands on ${litFiles.join(', ')} from the project, re-read each time it runs.` : s.hint}</span>
            </div>
          </header>
          {#if s.id === 'execute'}
            <label class="fc-check fc-enable">
              <input type="checkbox" bind:checked={st.enabled} />
              Run repo work in this run
            </label>
            {#if st.enabled}
              <span class="fc-warn">This agent writes code, decisions and renders in {paperRepo}. Don’t run your own Claude session in the repo at the same time — the two would collide on output/draft/, decisions.md and the review gate.</span>
              <label class="fc-check" title="Stop for your review when the repo work finishes">
                <input type="checkbox" bind:checked={st.gate} />
                Review gate
              </label>
              <label class="fc-field">
                <span class="fc-label">Your instructions <span class="fc-faint">· e.g. which analyses matter, what to leave alone</span></span>
                <textarea class="input fc-instr" bind:value={st.instructions} placeholder="e.g. Fix editor-rounds r2b first; leave the DiD appendix alone."></textarea>
              </label>
            {/if}
          {:else if !(s.id === 'lit' && reuseLit)}

          <div class="fc-row">
            {#if s.id !== 'convene'}
              <label class="fc-mini">
                <span>{s.id === 'editor' ? 'Referees' : 'Agents'}</span>
                <input class="input fc-num" type="number" min="1" max="10" bind:value={st.agents} />
              </label>
            {/if}
            {#if s.id === 'lit' || s.id === 'empirics'}
              <div class="fc-mini">
                <span>Mode</span>
                <div class="seg">
                  <button data-on={st.mode === 'independent'} onclick={() => (st.mode = 'independent')} title="Every agent gets the same brief — compare independent attempts">Independent</button>
                  <button data-on={st.mode === 'split'} onclick={() => (st.mode = 'split')} title="Each agent gets its own sub-task">Split work</button>
                </div>
              </div>
            {/if}
            {#if !linked}
            <div class="fc-mini">
              <span>Autonomy</span>
              <div class="seg">
                <button data-on={st.autonomy === 'standard'} onclick={() => (st.autonomy = 'standard')} title="File edits, web, and an allowlist of shell commands (python, R, curl, unzip, …). Anything else is refused.">Standard</button>
                <button data-on={st.autonomy === 'full'} onclick={() => (st.autonomy = 'full')} title="Skips every permission check. The agent can run any command on this machine.">Full</button>
              </div>
            </div>
            {/if}
            <label class="fc-check" title={s.id === 'editor' ? 'The editor always stops for your decision' : 'Stop for your review when this stage finishes'}>
              <input type="checkbox" bind:checked={st.gate} disabled={s.id === 'editor'} />
              Review gate
            </label>
          </div>

          {#if (s.id === 'lit' || s.id === 'empirics') && st.mode === 'split'}
            <label class="fc-field">
              <span class="fc-label">Sub-tasks <span class="fc-faint">· one per line · missing ones are planned by Claude when the stage starts</span></span>
              <textarea class="input fc-tasks" bind:value={tasksText[s.id]} placeholder="One sub-task per agent"></textarea>
            </label>
          {/if}

          <label class="fc-field">
            <span class="fc-label">Your instructions <span class="fc-faint">· appended to the built-in brief</span></span>
            <textarea
              class="input fc-instr"
              bind:value={st.instructions}
              placeholder={s.id === 'empirics'
                ? 'e.g. Use Compustat via WRDS if available; cluster SEs by firm; sample 2000–2023.'
                : s.id === 'editor'
                  ? 'e.g. Referee as for The Accounting Review; be harsh on identification.'
                  : 'Optional'}
            ></textarea>
          </label>
          {/if}
        </section>
      {/each}
    </div>

    {#if config.autoRevise}
    <div class="fc-field">
      <span class="fc-label">After the editor</span>
      <div class="fc-row">
        <label class="fc-check">
          <input type="checkbox" bind:checked={config.autoRevise.on} />
          Revise automatically until the verdict is
        </label>
        <select class="input fc-sel" bind:value={config.autoRevise.target} disabled={!config.autoRevise.on}>
          <option value="minor">minor or better</option>
          <option value="accept">accept</option>
        </select>
        <label class="fc-mini fc-inline">
          <span>max rounds</span>
          <input class="input fc-num" type="number" min="1" max="6" bind:value={config.autoRevise.maxRounds} disabled={!config.autoRevise.on} />
        </label>
      </div>
      <span class="fc-note">
        {config.autoRevise.on
          ? `The editor's report goes back automatically${evidence && config.stages.execute.enabled ? ' — to Repo work when the editor says analyses are needed, otherwise to the writer —' : ' to the writer'} until the verdict is good enough, the rounds are used up, or a round brings no improvement. Then it stops for you, with the decisions only you can make listed.`
          : 'The run stops at the editor gate every time.'}
      </span>
    </div>
    {/if}

    <label class="fc-field fc-par">
      <span class="fc-label">Max agents at once</span>
      <input class="input fc-num" type="number" min="1" max="10" bind:value={config.maxParallel} />
    </label>
  </div>

  <footer class="fc-foot">
    {#if error}<span class="fc-err">{error}</span>{/if}
    <span class="fc-faint">{totalAgents} agents in one pass</span>
    <span class="fc-spacer"></span>
    <button class="btn btn--ghost" onclick={saveTemplate} title="Use these stage settings for every new run">
      {#if templateSaved}<Icon n="check" />Saved as default{:else}Save as default{/if}
    </button>
    <button class="btn btn--ghost" onclick={oncancel}>Cancel</button>
    {#if started}
      <button class="btn btn--primary" disabled={busy} onclick={saveDraft}>Save settings</button>
    {:else}
      <button class="btn btn--secondary" disabled={busy} onclick={saveDraft}>Save draft</button>
      <button class="btn btn--primary" disabled={busy} onclick={start}><Icon n="sparkle" />Start run</button>
    {/if}
  </footer>
</div>

<style>
  .fc {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .fc-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 22px 28px 28px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    max-width: 920px;
  }
  .fc-head h2 {
    margin: 0 0 4px;
    font-size: var(--fs-17);
    font-weight: var(--fw-semibold);
  }
  .fc-sub {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--fs-12);
    line-height: var(--lh-normal);
  }
  .fc-field {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .fc-label {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .fc-faint {
    color: var(--text-faint);
    text-transform: none;
    letter-spacing: 0;
    font-size: var(--fs-11);
  }
  .fc-note {
    font-size: var(--fs-11);
    color: var(--text-faint);
  }
  .input {
    font: inherit;
    font-size: var(--fs-13);
    color: var(--text);
    background: var(--surface-inset, var(--bg-sunken));
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    padding: 7px 9px;
  }
  .input:focus {
    outline: none;
    border-color: var(--accent);
  }
  textarea.input {
    resize: vertical;
    line-height: var(--lh-normal);
  }
  .fc-idea {
    min-height: 130px;
  }
  .fc-tasks {
    min-height: 76px;
    font-size: var(--fs-12);
  }
  .fc-instr {
    min-height: 54px;
    font-size: var(--fs-12);
  }
  .fc-num {
    width: 64px;
  }
  .fc-stages {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .fc-stage {
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    background: var(--surface-raised, var(--surface));
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .fc-stage-head {
    display: flex;
    gap: 10px;
    align-items: flex-start;
  }
  .fc-step {
    flex: none;
    width: 20px;
    height: 20px;
    border-radius: 999px;
    display: grid;
    place-items: center;
    font-family: var(--font-mono);
    font-size: 10px;
    background: var(--accent-weak);
    color: var(--accent);
  }
  .fc-stage-title {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-weight: var(--fw-semibold);
    font-size: var(--fs-13);
  }
  .fc-hint {
    font-weight: var(--fw-regular);
    font-size: var(--fs-12);
    color: var(--text-muted);
  }
  .fc-row {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    align-items: flex-end;
  }
  .fc-row > .fc-hint {
    flex: 1;
    min-width: 260px;
    align-self: center;
  }
  .fc-mini {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: var(--fs-11);
    color: var(--text-muted);
  }
  .seg {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    overflow: hidden;
  }
  .seg button {
    font: inherit;
    font-size: var(--fs-12);
    padding: 5px 10px;
    background: transparent;
    border: none;
    color: var(--text-secondary, var(--text));
    cursor: pointer;
  }
  .seg button + button {
    border-left: 1px solid var(--border);
  }
  .seg button[data-on='true'] {
    background: var(--accent-weak);
    color: var(--accent);
  }
  .fc-check {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-12);
    color: var(--text-secondary, var(--text));
    padding-bottom: 5px;
  }
  .fc-paper {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    background: var(--surface-raised, var(--surface));
  }
  .fc-path {
    font-family: var(--font-mono);
    font-size: var(--fs-12);
  }
  .fc-files {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
  }
  .fc-files .fc-check {
    padding-bottom: 0;
    font-family: var(--font-mono);
    font-size: var(--fs-11);
  }
  .fc-warn {
    font-size: var(--fs-12);
    color: var(--warning);
    line-height: var(--lh-normal);
  }
  .fc-enable {
    font-weight: var(--fw-medium);
  }
  .fc-sel {
    padding: 4px 6px;
    font-size: var(--fs-12);
  }
  .fc-inline {
    flex-direction: row;
    align-items: center;
    gap: 6px;
  }
  .fc-par {
    flex-direction: row;
    align-items: center;
    gap: 10px;
  }
  .fc-foot {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 28px;
    border-top: 1px solid var(--border);
    background: var(--surface);
  }
  .fc-spacer {
    flex: 1;
  }
  .fc-err {
    color: var(--danger);
    font-size: var(--fs-12);
  }
</style>
