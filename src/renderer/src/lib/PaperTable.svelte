<script lang="ts">
  import { untrack } from 'svelte'
  import Icon from './Icon.svelte'
  import { lastName } from '../../../main/houseName'
  import type { ResolvedPaper } from '../global'

  type Sort = { key: string; dir: 'asc' | 'desc' }

  let {
    papers,
    activeId = null,
    sort,
    emptyText = 'No papers.',
    onrowclick,
    onrowopen,
    onrowactive,
    onselectionchange,
    onsort
  }: {
    papers: ResolvedPaper[]
    activeId?: string | null
    sort: Sort
    emptyText?: string
    onrowclick: (p: ResolvedPaper) => void
    /** Double-click / open intent — opens the paper's PDF in the Reader. */
    onrowopen?: (p: ResolvedPaper) => void
    /** Keyboard highlight moved onto a row (arrow keys, or tabbing in). */
    onrowactive?: (p: ResolvedPaper) => void
    /** The multi-selection changed (⌘/⇧-click, ⌘A) — ids in table order. */
    onselectionchange?: (ids: string[]) => void
    onsort: (key: string) => void
  } = $props()

  // ---- Multi-selection ----
  // Plain click selects one row; ⌘/Ctrl-click toggles a row in or out; ⇧-click
  // takes the range from the anchor (the last plainly-clicked row). Dragging a
  // selected row carries the whole selection, so several papers can be filed
  // onto a tag or the reading list in one go.
  let selected = $state(new Set<string>())
  /** Row a ⇧-click ranges from; -1 until something is clicked. */
  let anchor = $state(-1)

  // Switching tag/view (or a paper disappearing) shouldn't leave phantom ids
  // selected — prune to what's on screen whenever the row set changes.
  $effect(() => {
    const ids = new Set(papers.map((p) => p.id))
    untrack(() => {
      const keep = [...selected].filter((id) => ids.has(id))
      if (keep.length !== selected.size) {
        selected = new Set(keep)
        emitSelection()
      }
    })
  })

  function emitSelection(): void {
    const order = new Map(papers.map((p, i) => [p.id, i]))
    onselectionchange?.([...selected].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)))
  }

  /** Replace the selection with a single row (used by plain clicks and ↑/↓). */
  function selectOnly(i: number): void {
    selected = new Set([papers[i].id])
    anchor = i
    emitSelection()
  }

  function selectRange(from: number, to: number): void {
    const [lo, hi] = from <= to ? [from, to] : [to, from]
    selected = new Set(papers.slice(lo, hi + 1).map((p) => p.id))
    emitSelection()
  }

  function onRowClick(i: number, e: MouseEvent): void {
    const p = papers[i]
    if (e.shiftKey && anchor >= 0 && anchor < papers.length) {
      selectRange(anchor, i)
    } else if (e.metaKey || e.ctrlKey) {
      const next = new Set(selected)
      next.has(p.id) ? next.delete(p.id) : next.add(p.id)
      selected = next
      anchor = i
      emitSelection()
    } else {
      selectOnly(i)
    }
    // The inspector always follows the clicked row, whatever the modifier.
    onrowclick(p)
  }

  // ---- Keyboard navigation ----
  // Roving tabindex: exactly one row is tabbable — the active one, or the first
  // row when nothing is selected — so ⇥ from the search field lands in the list
  // and a second ⇥ leaves the table instead of walking every row. Once inside,
  // ↑/↓ move the highlight and ↵ opens the paper in the Reader.
  let rowEls = $state<HTMLTableRowElement[]>([])
  const activeIdx = $derived.by(() => {
    const i = papers.findIndex((p) => p.id === activeId)
    return i >= 0 ? i : 0
  })

  /** Focus the list from the outside (⌘K → ⇥). */
  export function focusList(): void {
    rowEls[activeIdx]?.focus()
  }

  function onRowKey(i: number, e: KeyboardEvent): void {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const j = Math.min(papers.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))
      // ⇧↑/⇧↓ grows the selection from the anchor; a bare arrow moves it.
      if (e.shiftKey) {
        if (anchor < 0) anchor = i
        selectRange(anchor, j)
      } else {
        selectOnly(j)
      }
      onrowactive?.(papers[j])
      rowEls[j]?.focus()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      onrowopen?.(papers[i])
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      selected = new Set(papers.map((p) => p.id))
      emitSelection()
    } else if (e.key === 'Escape' && selected.size > 1) {
      e.preventDefault()
      selectOnly(i)
    }
  }

  // Dragging a row carries paper ids so the sidebar can file them onto a tag or
  // the reading list. Dragging a row that's part of the selection takes the whole
  // selection; dragging an unselected row selects it first, so what you see
  // highlighted is always what you're dragging.
  const PAPER_DND = 'application/x-lctrn-papers'
  function onDragStart(i: number, e: DragEvent): void {
    const p = papers[i]
    if (!selected.has(p.id)) selectOnly(i)
    const ids = selected.has(p.id) ? [...selected] : [p.id]
    if (!e.dataTransfer) return
    e.dataTransfer.setData(PAPER_DND, JSON.stringify(ids))
    e.dataTransfer.effectAllowed = 'copy'
    if (ids.length > 1) setCountDragImage(ids.length, e)
  }

  /** Drag ghost for a multi-row drag: a small "N papers" chip under the cursor. */
  function setCountDragImage(n: number, e: DragEvent): void {
    const chip = document.createElement('div')
    chip.className = 'drag-chip'
    chip.textContent = `${n} papers`
    document.body.appendChild(chip)
    e.dataTransfer?.setDragImage(chip, 12, 12)
    setTimeout(() => chip.remove(), 0)
  }

  const addedLabel = (p: ResolvedPaper): string =>
    p.addedAt
      ? new Date(p.addedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      : '—'
  // Last name(s), joined by "and": "Smith", "Smith and Jones",
  // "Blankespoor, deHaan, and Marinovic". Beyond 5, first author + "et al."
  const joinAnd = (names: string[]): string => {
    if (names.length === 1) return names[0]
    if (names.length === 2) return `${names[0]} and ${names[1]}`
    return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`
  }
  const authorNames = (p: ResolvedPaper): string => {
    if (!p.authors.length) return '—'
    if (p.authors.length > 5) return `${lastName(p.authors[0])} et al.`
    return joinAnd(p.authors.map(lastName))
  }

  // ---- Resizable columns ----
  // One width per column, in table order: title, authors, journal, year,
  // citekey, added, state. Drag a header's right edge to resize; widths
  // persist to localStorage so they survive reloads.
  const DEFAULT_W = [300, 190, 150, 64, 150, 120, 110]
  const MIN_W = 48
  const STORAGE_KEY = 'lctrn.paperColWidths'
  function loadWidths(): number[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const arr = JSON.parse(raw)
        if (Array.isArray(arr) && arr.length === DEFAULT_W.length) return arr.map(Number)
      }
    } catch {
      /* ignore malformed storage */
    }
    return [...DEFAULT_W]
  }
  let colW = $state(loadWidths())

  function startResize(i: number, e: PointerEvent): void {
    e.preventDefault()
    e.stopPropagation() // don't trigger column sort
    const startX = e.clientX
    const startW = colW[i]
    const onMove = (ev: PointerEvent): void => {
      colW[i] = Math.max(MIN_W, startW + (ev.clientX - startX))
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(colW))
      } catch {
        /* ignore quota errors */
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
</script>

{#snippet resizer(i: number)}
  <span
    class="resizer"
    role="separator"
    aria-orientation="vertical"
    onpointerdown={(e) => startResize(i, e)}
    onclick={(e) => e.stopPropagation()}
    ondblclick={(e) => e.stopPropagation()}
  ></span>
{/snippet}

<div class="tablewrap">
  {#if papers.length === 0}
    <div class="tableempty">{emptyText}</div>
  {:else}
    <table class="dt" style="table-layout: fixed; width: {colW.reduce((a, b) => a + b, 0)}px;">
      <colgroup>
        {#each colW as w}<col style="width: {w}px" />{/each}
      </colgroup>
      <thead>
        <tr>
          <th onclick={() => onsort('title')}>Paper{#if sort.key === 'title'}<span class="ar"><Icon n={sort.dir === 'asc' ? 'chevron-up' : 'chevron-down'} /></span>{/if}{@render resizer(0)}</th>
          <th onclick={() => onsort('authors')}>Authors{#if sort.key === 'authors'}<span class="ar"><Icon n={sort.dir === 'asc' ? 'chevron-up' : 'chevron-down'} /></span>{/if}{@render resizer(1)}</th>
          <th onclick={() => onsort('journal')}>Journal{#if sort.key === 'journal'}<span class="ar"><Icon n={sort.dir === 'asc' ? 'chevron-up' : 'chevron-down'} /></span>{/if}{@render resizer(2)}</th>
          <th class="n" onclick={() => onsort('year')}>Year{#if sort.key === 'year'}<span class="ar"><Icon n={sort.dir === 'asc' ? 'chevron-up' : 'chevron-down'} /></span>{/if}{@render resizer(3)}</th>
          <th onclick={() => onsort('citekey')}>Citekey{#if sort.key === 'citekey'}<span class="ar"><Icon n={sort.dir === 'asc' ? 'chevron-up' : 'chevron-down'} /></span>{/if}{@render resizer(4)}</th>
          <th class="n" onclick={() => onsort('added')}>Added{#if sort.key === 'added'}<span class="ar"><Icon n={sort.dir === 'asc' ? 'chevron-up' : 'chevron-down'} /></span>{/if}{@render resizer(5)}</th>
          <th class="no-sort">State{@render resizer(6)}</th>
        </tr>
      </thead>
      <tbody>
        {#each papers as p, i (p.id)}
          <tr
            bind:this={rowEls[i]}
            data-active={activeId === p.id}
            data-selected={selected.has(p.id)}
            data-missing={!p.exists}
            draggable="true"
            tabindex={i === activeIdx ? 0 : -1}
            ondragstart={(e) => onDragStart(i, e)}
            onclick={(e) => onRowClick(i, e)}
            ondblclick={() => onrowopen?.(p)}
            onkeydown={(e) => onRowKey(i, e)}
            onfocus={() => onrowactive?.(p)}
            title={onrowopen && p.exists ? 'Double-click to read the PDF' : undefined}
          >
            <td class="prim">{p.title || p.citekey}</td>
            <td class="sec">{authorNames(p)}</td>
            <td class="sec jrnl" title={p.journal}>{p.journalAbbrev || p.journal || '—'}</td>
            <td class="n">{p.year || '—'}</td>
            <td>
              <span class="celltag"><i style="background: var(--accent)"></i>@{p.citekey}</span>
            </td>
            <td class="n sec">{addedLabel(p)}</td>
            <td>
              {#if p.exists && !p.metaSource}
                <span class="cellstat">
                  <i style="background: var(--accent)"></i>fetching…
                </span>
              {:else}
                <span class="cellstat">
                  <i style="background: {p.exists ? 'var(--success)' : 'var(--danger)'}"></i>{p.exists ? 'on disk' : 'missing'}
                </span>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>
