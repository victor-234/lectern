<script lang="ts">
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
    onsort
  }: {
    papers: ResolvedPaper[]
    activeId?: string | null
    sort: Sort
    emptyText?: string
    onrowclick: (p: ResolvedPaper) => void
    /** Double-click / open intent — opens the paper's PDF in the Reader. */
    onrowopen?: (p: ResolvedPaper) => void
    onsort: (key: string) => void
  } = $props()

  // Dragging a row carries the paper id so the sidebar can file it onto a tag.
  const PAPER_DND = 'application/x-lctrn-papers'
  function onDragStart(p: ResolvedPaper, e: DragEvent): void {
    e.dataTransfer?.setData(PAPER_DND, JSON.stringify([p.id]))
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
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
        {#each papers as p (p.id)}
          <tr
            data-active={activeId === p.id}
            data-missing={!p.exists}
            draggable="true"
            ondragstart={(e) => onDragStart(p, e)}
            onclick={() => onrowclick(p)}
            ondblclick={() => onrowopen?.(p)}
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
