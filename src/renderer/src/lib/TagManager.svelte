<script lang="ts">
  import Icon from './Icon.svelte'
  import type { Tag, Group } from '../global'

  let {
    tags,
    groups,
    onCreate,
    onRename,
    onDelete,
    onCreateTag,
    onRenameTag,
    onReorderTag,
    onDeleteTag,
    onclose
  }: {
    tags: Tag[]
    groups: Group[]
    onCreate: (name: string) => Promise<void>
    onRename: (groupId: string, name: string) => Promise<void>
    onDelete: (groupId: string) => Promise<void>
    /** Create a new tag definition. */
    onCreateTag: (name: string) => Promise<void>
    /** Rename a tag definition. */
    onRenameTag: (tagId: string, name: string) => Promise<void>
    /** Persist a new tag order + group placement (tags in their desired order). */
    onReorderTag: (entries: Array<{ id: string; groupId: string | null }>) => Promise<void>
    /** Delete a tag definition entirely (also strips it from every paper). */
    onDeleteTag: (tagId: string) => Promise<void>
    onclose: () => void
  } = $props()

  const UNGROUPED = '__ungrouped__'

  const sortedGroups = $derived([...groups].sort((a, b) => a.sortOrder - b.sortOrder))
  const sortedTags = $derived([...tags].sort((a, b) => a.sortOrder - b.sortOrder))
  const byId = $derived(new Map(tags.map((t) => [t.id, t] as const)))

  // --- Live drag model --------------------------------------------------------
  // A tag's position AND its group are decided by one drag. `work` holds the live
  // ordering (id + groupId) while a drag is in flight and until it commits, so the
  // tree previews the drop. Empty `work` ⇒ fall back to the persisted state.
  type Entry = { id: string; groupId: string | null }

  let dragId = $state<string | null>(null)
  let work = $state<Entry[]>([])
  let dropHint = $state<string | null>(null) // group id (or UNGROUPED) being targeted
  let dropped = false

  // Persisted order as entries: each group's members in sort order, then ungrouped.
  function persistedEntries(): Entry[] {
    const valid = new Set(sortedGroups.map((g) => g.id))
    const out: Entry[] = []
    for (const g of sortedGroups)
      for (const t of sortedTags.filter((t) => t.groupId === g.id)) out.push({ id: t.id, groupId: g.id })
    for (const t of sortedTags.filter((t) => !t.groupId || !valid.has(t.groupId)))
      out.push({ id: t.id, groupId: null })
    return out
  }

  const entries = $derived(work.length ? work : persistedEntries())
  const membersOf = $derived((groupId: string | null) =>
    entries.filter((e) => e.groupId === groupId).map((e) => byId.get(e.id)).filter((t): t is Tag => !!t)
  )

  // Move the dragged tag to `groupId`, inserting before `beforeId` (or appending
  // to the end of that group's run when beforeId is null).
  function moveTo(groupId: string | null, beforeId: string | null): void {
    if (!dragId) return
    const cur = work.length ? work : persistedEntries()
    const next = cur.filter((e) => e.id !== dragId)
    const entry: Entry = { id: dragId, groupId }
    if (beforeId) {
      const idx = next.findIndex((e) => e.id === beforeId)
      if (idx === -1) next.push(entry)
      else next.splice(idx, 0, entry)
    } else {
      let at = next.length
      for (let i = 0; i < next.length; i++) if (next[i].groupId === groupId) at = i + 1
      next.splice(at, 0, entry)
    }
    work = next
  }

  function startDrag(e: DragEvent, id: string): void {
    dragId = id
    dropped = false
    work = persistedEntries()
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', id) // Firefox needs a payload to start
    }
  }

  function overTag(e: DragEvent, tag: Tag): void {
    if (!dragId) return
    e.preventDefault()
    e.stopPropagation() // don't let the group container also claim this hover
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    dropHint = tag.groupId ?? UNGROUPED
    if (tag.id !== dragId) moveTo(tag.groupId ?? null, tag.id)
  }

  function overGroup(e: DragEvent, groupId: string | null): void {
    if (!dragId) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    dropHint = groupId ?? UNGROUPED
    moveTo(groupId, null)
  }

  function onDrop(e: DragEvent): void {
    if (!dragId) return
    e.preventDefault()
    dropped = true
  }

  async function endDrag(): Promise<void> {
    const id = dragId
    const final = work
    const committed = dropped
    dragId = null
    dropHint = null
    dropped = false
    if (committed && id && final.length) {
      const before = persistedEntries()
      const changed =
        final.length !== before.length ||
        final.some((e, i) => e.id !== before[i].id || e.groupId !== before[i].groupId)
      // loadLibrary refreshes `tags` after this, so we drop the local override last.
      if (changed) await onReorderTag(final.map((e) => ({ id: e.id, groupId: e.groupId })))
    }
    work = []
  }

  // --- Collapse ---------------------------------------------------------------
  let collapsed = $state<Set<string>>(new Set())
  function toggle(id: string): void {
    const next = new Set(collapsed)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    collapsed = next
  }

  // --- Create / rename --------------------------------------------------------
  let newGroupName = $state('')
  let newTagName = $state('')

  async function addGroup(): Promise<void> {
    const name = newGroupName.trim()
    if (!name) return
    newGroupName = ''
    await onCreate(name)
  }

  async function addTag(): Promise<void> {
    const name = newTagName.trim()
    if (!name) return
    newTagName = ''
    await onCreateTag(name)
  }

  async function rename(group: Group, value: string): Promise<void> {
    const name = value.trim()
    if (name && name !== group.name) await onRename(group.id, name)
  }

  async function renameTagTo(tag: Tag, value: string): Promise<void> {
    const name = value.trim()
    if (name && name !== tag.name) await onRenameTag(tag.id, name)
  }

  async function removeTag(tag: Tag): Promise<void> {
    if (!confirm(`Delete the tag “${tag.name}”? It will be removed from every paper.`)) return
    await onDeleteTag(tag.id)
  }

  function onkeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onclose()
    }
  }
</script>

<svelte:window {onkeydown} />

{#snippet tagRow(tag: Tag)}
  <div class="tm-tag" role="listitem" data-dragging={dragId === tag.id} ondrop={onDrop} ondragover={(e) => overTag(e, tag)}>
    <span
      class="tm-grip"
      role="button"
      tabindex="-1"
      title="Drag to reorder or move between groups"
      aria-label="Drag tag"
      draggable="true"
      ondragstart={(e) => startDrag(e, tag.id)}
      ondragend={endDrag}
    >
      <Icon n="grip" />
    </span>
    <input
      class="tm-grow__name"
      value={tag.name}
      onblur={(e) => renameTagTo(tag, (e.currentTarget as HTMLInputElement).value)}
      onkeydown={(e) => {
        if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
      }}
    />
    <button class="iconbtn tm-del" title="Delete tag" onclick={() => removeTag(tag)}>
      <Icon n="trash" />
    </button>
  </div>
{/snippet}

<div class="tm-backdrop" role="presentation" onclick={onclose}></div>
<div class="tm-modal" role="dialog" aria-label="Tags & groups">
  <div class="tm-head">
    <h3>Tags &amp; groups</h3>
    <button class="iconbtn" title="Close" onclick={onclose}><Icon n="x" /></button>
  </div>
  <p class="tm-sub">
    Each tag lives in one group. Drag a tag by its handle to reorder it, or drop it on another
    group to move it there. Collapse a group to tuck its tags away.
  </p>

  <div class="tm-scroll">
    {#each sortedGroups as g (g.id)}
      {@const members = membersOf(g.id)}
      <div
        class="tm-group"
        role="listitem"
        data-drop={dropHint === g.id}
        ondrop={onDrop}
        ondragover={(e) => overGroup(e, g.id)}
      >
        <div class="tm-group__head">
          <button
            class="tm-caret"
            title={collapsed.has(g.id) ? 'Expand' : 'Collapse'}
            aria-expanded={!collapsed.has(g.id)}
            onclick={() => toggle(g.id)}
          >
            <span class="tm-chev" data-collapsed={collapsed.has(g.id)}><Icon n="chevron-down" /></span>
          </button>
          <input
            class="tm-grow__name tm-group__name"
            value={g.name}
            onblur={(e) => rename(g, (e.currentTarget as HTMLInputElement).value)}
            onkeydown={(e) => {
              if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
            }}
          />
          <span class="tm-count">{members.length}</span>
          <button class="iconbtn tm-del" title="Delete group" onclick={() => onDelete(g.id)}>
            <Icon n="trash" />
          </button>
        </div>
        {#if !collapsed.has(g.id)}
          <div class="tm-group__body">
            {#each members as tag (tag.id)}
              {@render tagRow(tag)}
            {:else}
              <div class="tm-dropzone">Drop tags here</div>
            {/each}
          </div>
        {/if}
      </div>
    {/each}

    <!-- Ungrouped tags -->
    <div
      class="tm-group tm-group--ungrouped"
      role="listitem"
      data-drop={dropHint === UNGROUPED}
      ondrop={onDrop}
      ondragover={(e) => overGroup(e, null)}
    >
      <div class="tm-group__head tm-group__head--plain">
        <span class="tm-section__label">Ungrouped</span>
        <span class="tm-count">{membersOf(null).length}</span>
      </div>
      <div class="tm-group__body">
        {#each membersOf(null) as tag (tag.id)}
          {@render tagRow(tag)}
        {:else}
          <div class="tm-dropzone">Drop tags here to remove them from any group</div>
        {/each}
      </div>
    </div>

    <!-- Create -->
    <div class="tm-new">
      <input
        class="tm-grow__name"
        placeholder="New group name (e.g. Meta)"
        bind:value={newGroupName}
        onkeydown={(e) => {
          if (e.key === 'Enter') addGroup()
        }}
      />
      <button class="tm-add" onclick={addGroup} disabled={!newGroupName.trim()}>Add group</button>
    </div>
    <div class="tm-new">
      <input
        class="tm-grow__name"
        placeholder="New tag name"
        bind:value={newTagName}
        onkeydown={(e) => {
          if (e.key === 'Enter') addTag()
        }}
      />
      <button class="tm-add" onclick={addTag} disabled={!newTagName.trim()}>Add tag</button>
    </div>
  </div>
</div>

<style>
  .tm-backdrop {
    position: fixed;
    inset: 0;
    z-index: 59;
    background: rgba(0, 0, 0, 0.45);
  }
  .tm-modal {
    position: fixed;
    z-index: 60;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    display: flex;
    flex-direction: column;
    width: 560px;
    max-width: calc(100vw - 80px);
    max-height: 80vh;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-md);
    box-shadow: var(--shadow-pop, var(--shadow-sm));
  }
  .tm-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px 0;
  }
  .tm-head h3 {
    margin: 0;
    font-family: var(--font-sans);
    font-weight: 600;
    font-size: 15px;
    color: var(--text);
  }
  .tm-sub {
    margin: 6px 16px 10px;
    font-size: 12px;
    line-height: 1.5;
    color: var(--text-muted);
  }
  .tm-scroll {
    overflow-y: auto;
    padding: 4px 16px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .tm-section__label {
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }

  /* Group container */
  .tm-group {
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    background: var(--surface);
  }
  .tm-group[data-drop='true'] {
    border-color: var(--accent-line);
    box-shadow: inset 0 0 0 1px var(--accent-line);
  }
  .tm-group--ungrouped {
    background: transparent;
    border-style: dashed;
  }
  .tm-group__head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
  }
  .tm-group__head--plain {
    padding: 8px 10px 4px;
  }
  .tm-caret {
    display: inline-flex;
    align-items: center;
    flex: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 2px;
  }
  .tm-chev {
    display: inline-flex;
    transition: transform 0.12s ease;
  }
  .tm-chev[data-collapsed='true'] {
    transform: rotate(-90deg);
  }
  .tm-caret :global(svg) {
    width: 15px;
    height: 15px;
  }
  .tm-group__name {
    font-weight: 600;
  }
  .tm-count {
    flex: none;
    min-width: 18px;
    text-align: center;
    font-family: var(--font-sans);
    font-size: 11px;
    color: var(--text-muted);
    background: var(--surface-inset);
    border-radius: 999px;
    padding: 1px 6px;
  }
  .tm-group__body {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 2px 8px 8px 8px;
  }

  /* Tag row */
  .tm-tag {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 0 2px 18px;
  }
  .tm-tag[data-dragging='true'] {
    opacity: 0.45;
  }
  .tm-grip {
    display: inline-flex;
    align-items: center;
    flex: none;
    color: var(--text-faint);
    cursor: grab;
    padding: 2px;
  }
  .tm-grip:hover {
    color: var(--text-secondary);
  }
  .tm-grip:active {
    cursor: grabbing;
  }
  .tm-grip :global(svg) {
    width: 16px;
    height: 16px;
  }
  .tm-dropzone {
    font-size: 12px;
    color: var(--text-faint);
    padding: 8px 4px 8px 18px;
    border: 1px dashed var(--border);
    border-radius: var(--r-sm);
  }

  .tm-grow__name {
    flex: 1;
    min-width: 0;
    font-family: var(--font-sans);
    font-size: 13px;
    color: var(--text);
    background: var(--surface-inset);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    padding: 6px 9px;
  }
  .tm-grow__name:focus {
    outline: none;
    border-color: var(--accent-line);
  }
  .tm-del {
    flex: none;
    color: var(--text-faint);
  }
  .tm-del:hover {
    color: var(--danger, #e5484d);
  }
  .tm-new {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .tm-add {
    flex: none;
    font-family: var(--font-sans);
    font-size: 12.5px;
    color: var(--text);
    background: var(--accent-weak);
    border: 1px solid var(--accent-line);
    border-radius: var(--r-sm);
    padding: 6px 12px;
    cursor: pointer;
  }
  .tm-add:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
