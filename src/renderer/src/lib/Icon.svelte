<script lang="ts" module>
  // Lucide-style line icons — 24px viewBox, 1.8px stroke (from the lectron design).
  // Production: swap in the real Lucide package for pixel parity.
  export const ICONS: Record<string, string> = {
    library: 'M3 4h4v16H3zM10 4h4v16h-4zM17 5l4 1-3 14-4-1z',
    clock: 'M12 7v5l3 2M12 21a9 9 0 100-18 9 9 0 000 18z',
    bookmark: 'M6 3h12v18l-6-4-6 4z',
    pen: 'M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z',
    search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-4.3-4.3',
    plus: 'M12 5v14M5 12h14',
    filter: 'M3 5h18l-7 8v6l-4-2v-4z',
    table: 'M3 4h18v16H3zM3 10h18M3 16h18M9 4v16',
    cards: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
    panel: 'M3 4h18v16H3zM15 4v16',
    terminal: 'M4 5h16v14H4zM7 9l3 3-3 3M13 15h4',
    sun: 'M12 4V2M12 22v-2M5 5L3.5 3.5M20.5 20.5 19 19M4 12H2M22 12h-2M5 19l-1.5 1.5M20.5 3.5 19 5M12 8a4 4 0 100 8 4 4 0 000-8z',
    moon: 'M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z',
    graph: 'M5 19V9M12 19V5M19 19v-7M3 21h18',
    sparkle: 'M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4zM19 14l.9 2.3L22 17l-2.1.7L19 20l-.9-2.3L16 17l2.1-.7z',
    pdf: 'M7 3h7l4 4v14H7zM14 3v4h4M9 13h1.5a1.5 1.5 0 010 3H9zM9 13v6',
    x: 'M6 6l12 12M18 6L6 18',
    link: 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1.5 1.5M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1.5-1.5',
    note: 'M4 4h16v12l-4 4H4zM16 20v-4h4',
    dna: 'M4 4c0 6 16 10 16 16M20 4c0 6-16 10-16 16M7 6h10M7 18h10',
    folder: 'M3 6h6l2 2h10v11H3zM3 6v13',
    file: 'M7 3h7l4 4v14H7zM14 3v4h4',
    list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
    'chevron-down': 'M6 9l6 6 6-6',
    'chevron-up': 'M18 15l-6-6-6 6',
    'chevron-right': 'M9 18l6-6-6-6',
    check: 'M20 6L9 17l-5-5',
    trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3',
    grip: 'M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01',
    refresh: 'M21 12a9 9 0 11-2.6-6.4M21 3v4h-4',
    rename: 'M20.6 13.4l-7.2 7.2a2 2 0 01-2.8 0L2 12V2h10l8.6 8.6a2 2 0 010 2.8zM7 7h.01'
  }
</script>

<script lang="ts">
  let { n }: { n: string } = $props()
</script>

<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <path d={ICONS[n] ?? ''} />
</svg>
