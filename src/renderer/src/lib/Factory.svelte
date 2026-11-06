<script lang="ts">
  // The Factory app: runs on the left (plus the library's dataset registry),
  // and on the right either the composer or the selected run's board.
  import Icon from './Icon.svelte'
  import FactoryConfig from './FactoryConfig.svelte'
  import FactoryRun from './FactoryRun.svelte'
  import type { FactorySummary, FactoryConfig as Config, DatasetInfo, StageId } from '../global'

  let { onwaiting }: {
    /** How many runs are waiting at a gate — for the app switcher's badge. */
    onwaiting?: (n: number) => void
  } = $props()

  const LABEL: Record<StageId, string> = {
    lit: 'Literature',
    execute: 'Repo work',
    empirics: 'Empirics',
    convene: 'Convene',
    editor: 'Editor'
  }

  let runs = $state<FactorySummary[]>([])
  let datasets = $state<DatasetInfo[]>([])
  let selected = $state<string | null>(null)
  // The composer: a new run, a draft, or a started run's settings.
  let composer = $state<{
    slug: string | null
    title: string
    idea: string
    config: Config
    started: boolean
  } | null>(null)

  async function refresh(): Promise<void> {
    runs = await window.api.factory.list()
    onwaiting?.(runs.filter((r) => r.status === 'waiting').length)
    if (selected && !runs.some((r) => r.slug === selected)) selected = null
  }

  $effect(() => {
    void refresh()
    void window.api.factory.datasets().then((d) => (datasets = d))
    let t: ReturnType<typeof setTimeout> | null = null
    const off = window.api.factory.onChanged(() => {
      // Agents report in bursts; coalesce list reloads.
      if (t) clearTimeout(t)
      t = setTimeout(() => {
        void refresh()
        void window.api.factory.datasets().then((d) => (datasets = d))
      }, 250)
    })
    return () => {
      off()
      if (t) clearTimeout(t)
    }
  })

  // Registering a hand-collected dataset: name + one line, then Finder opens
  // on its new folder so the files can be dropped in.
  let dsForm = $state(false)
  let dsName = $state('')
  let dsDesc = $state('')
  let dsError = $state<string | null>(null)
  async function addDataset(): Promise<void> {
    dsError = null
    try {
      await window.api.factory.createDataset(dsName, dsDesc)
      await window.api.factory.openDatasets(dsName)
      dsForm = false
      dsName = dsDesc = ''
      datasets = await window.api.factory.datasets()
    } catch (e) {
      dsError = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)
    }
  }

  async function newRun(): Promise<void> {
    composer = { slug: null, title: '', idea: '', config: await window.api.factory.template.get(), started: false }
  }

  async function openRun(r: FactorySummary): Promise<void> {
    if (r.status === 'draft') {
      const d = await window.api.factory.read(r.slug)
      if (!d) return
      composer = { slug: r.slug, title: d.run.title, idea: d.idea, config: d.run.config, started: false }
      selected = r.slug
      return
    }
    composer = null
    selected = r.slug
  }

  async function editSettings(slug: string): Promise<void> {
    const d = await window.api.factory.read(slug)
    if (!d) return
    composer = { slug, title: d.run.title, idea: d.idea, config: d.run.config, started: d.run.status !== 'draft' }
  }

  function sub(r: FactorySummary): string {
    if (r.status === 'draft') return 'draft'
    if (r.status === 'done') return r.verdict ? `done · ${r.verdict}` : 'done'
    if (r.status === 'killed') return 'killed'
    if (!r.current) return r.status
    const what = r.currentStatus === 'gate' ? 'review' : r.currentStatus === 'failed' ? 'needs attention' : 'running'
    return `${LABEL[r.current]} · ${what}`
  }
</script>

<div class="fx">
  <aside class="fx-side">
    <div class="fx-side-head">
      <span>Runs</span>
      <button class="iconbtn" title="New run" onclick={newRun}><Icon n="plus" /></button>
    </div>
    <div class="fx-list">
      {#each runs as r (r.slug)}
        <button class="fx-item" data-on={selected === r.slug} onclick={() => openRun(r)}>
          <span class="fx-dot" data-s={r.status}></span>
          <span class="fx-item-main">
            <span class="fx-item-title">{r.title}</span>
            <span class="fx-item-sub">{sub(r)}</span>
          </span>
        </button>
      {:else}
        <div class="fx-none">No runs yet.</div>
      {/each}
    </div>

    <div class="fx-side-head fx-side-head--ds">
      <span>Datasets</span>
      <span class="fx-head-btns">
        <button class="iconbtn" title="Open the datasets folder" onclick={() => window.api.factory.openDatasets()}><Icon n="folder" /></button>
        <button class="iconbtn" title="Add a dataset you collected yourself" onclick={() => (dsForm = !dsForm)}><Icon n="plus" /></button>
      </span>
    </div>
    {#if dsForm}
      <form class="fx-dsform" onsubmit={(e) => { e.preventDefault(); void addDataset() }}>
        <input class="fx-input" bind:value={dsName} placeholder="Name, e.g. CSRD early adopters" />
        <input class="fx-input" bind:value={dsDesc} placeholder="One line: what it is, coverage" />
        {#if dsError}<span class="fx-err">{dsError}</span>{/if}
        <div class="fx-dsform-btns">
          <button type="button" class="btn btn--ghost" onclick={() => (dsForm = false)}>Cancel</button>
          <button type="submit" class="btn btn--primary" disabled={!dsName.trim()}>Create &amp; open</button>
        </div>
        <span class="fx-none">Creates <code>datasets/&lt;name&gt;/</code> with a README to fill in, then opens it so you can drop the files in.</span>
      </form>
    {/if}
    <div class="fx-list fx-list--ds">
      {#each datasets as d (d.name)}
        <button class="fx-ds" title={d.dir} onclick={() => window.api.factory.openDatasets(d.name)}>
          <span class="fx-ds-name">{d.name}</span>
          {#if d.summary}<span class="fx-ds-sum">{d.summary}</span>{/if}
        </button>
      {:else}
        <div class="fx-none">Datasets live in <code>datasets/</code> in your library — agents add what they download, and you can add your own with +.</div>
      {/each}
    </div>
  </aside>

  <section class="fx-main">
    {#if composer}
      {#key composer.slug ?? 'new'}
        <FactoryConfig
          slug={composer.slug}
          initialTitle={composer.title}
          initialIdea={composer.idea}
          initialConfig={composer.config}
          started={composer.started}
          onsaved={async (s) => { composer = null; await refresh(); selected = s }}
          onstarted={async (s) => { composer = null; await refresh(); selected = s }}
          oncancel={() => (composer = null)}
        />
      {/key}
    {:else if selected}
      <FactoryRun
        slug={selected}
        onedit={() => selected && editSettings(selected)}
        ondeleted={async () => { selected = null; await refresh() }}
      />
    {:else}
      <div class="fx-empty">
        <h2>The Factory</h2>
        <p>
          Give it an idea; a team of Claude agents scans the literature, runs the empirics, convenes, and hands the result
          to a critical editor. It stops at the gates you choose, so you can read, edit, question an agent, or send work back.
        </p>
        <button class="btn btn--primary" onclick={newRun}><Icon n="plus" />New run</button>
      </div>
    {/if}
  </section>
</div>

<style>
  .fx {
    display: flex;
    height: 100%;
    min-height: 0;
  }
  .fx-side {
    flex: none;
    width: 240px;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--border);
    background: var(--bg-sunken);
  }
  .fx-side-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 10px 4px 14px;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .fx-side-head--ds {
    border-top: 1px solid var(--border);
    padding-top: 12px;
  }
  .fx-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 4px 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .fx-list--ds {
    flex: 0 1 34%;
  }
  .fx-item {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    padding: 7px 9px;
    border-radius: var(--r-sm);
    cursor: pointer;
    font: inherit;
  }
  .fx-item:hover {
    background: var(--accent-weak);
  }
  .fx-item[data-on='true'] {
    background: var(--accent-weak);
    box-shadow: inset 0 0 0 1px var(--accent-line, var(--border-strong));
  }
  .fx-dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: var(--border-strong);
  }
  .fx-dot[data-s='draft'] {
    background: transparent;
    border: 1px dashed var(--text-faint);
  }
  .fx-dot[data-s='running'] {
    background: var(--info);
    animation: fx-pulse 1.2s ease-in-out infinite;
  }
  .fx-dot[data-s='waiting'] {
    background: var(--warning);
  }
  .fx-dot[data-s='done'] {
    background: var(--success);
  }
  @keyframes fx-pulse {
    50% {
      opacity: 0.35;
    }
  }
  .fx-item-main {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .fx-item-title {
    font-size: 12.5px;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .fx-item-sub {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-faint);
  }
  .fx-none {
    font-size: var(--fs-11);
    color: var(--text-faint);
    padding: 6px 8px;
    line-height: var(--lh-normal);
  }
  .fx-ds {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 5px 8px;
    text-align: left;
    width: 100%;
    background: transparent;
    border: none;
    border-radius: var(--r-sm);
    cursor: pointer;
    font: inherit;
  }
  .fx-ds:hover {
    background: var(--accent-weak);
  }
  .fx-head-btns {
    display: inline-flex;
    gap: 2px;
  }
  .fx-dsform {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 4px 10px 8px;
  }
  .fx-input {
    font: inherit;
    font-size: var(--fs-12);
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    padding: 5px 7px;
  }
  .fx-input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .fx-dsform-btns {
    display: flex;
    justify-content: flex-end;
    gap: 4px;
  }
  .fx-err {
    font-size: var(--fs-11);
    color: var(--danger);
  }
  .fx-ds-name {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text);
  }
  .fx-ds-sum {
    font-size: var(--fs-11);
    color: var(--text-muted);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .fx-main {
    flex: 1;
    min-width: 0;
    min-height: 0;
    background: var(--surface);
  }
  .fx-empty {
    max-width: 520px;
    margin: 12vh auto 0;
    padding: 0 24px;
    text-align: center;
  }
  .fx-empty h2 {
    font-size: var(--fs-20);
    margin: 0 0 8px;
  }
  .fx-empty p {
    color: var(--text-muted);
    font-size: var(--fs-13);
    line-height: var(--lh-normal);
    margin: 0 0 16px;
  }
</style>
