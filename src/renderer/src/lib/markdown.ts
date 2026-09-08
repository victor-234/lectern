/**
 * Clean, zero-dependency markdown renderer for manuscript sections.
 *
 * Block-aware: groups wrapped lines into real paragraphs, and handles fenced
 * code, headings (#–######), blockquotes, ordered/unordered lists, horizontal
 * rules and GFM pipe tables. Inline: **bold**, *em* / _em_, `code`,
 * [text](url), and academic [@citekey] references. Input is HTML-escaped first,
 * so rendering untrusted manuscript text is safe.
 */
export function renderMarkdown(raw: string): string {
  if (!raw) return ''

  const lines = raw.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []

  // Quarto/YAML front matter — metadata, not prose; skip it in the preview.
  let start = 0
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((l, idx) => idx > 0 && /^(---|\.\.\.)\s*$/.test(l.trim()))
    if (close > 0) start = close + 1
  }
  lines.splice(0, start)

  let i = 0
  let para: string[] = []
  let listType: 'ul' | 'ol' | null = null

  const flushPara = (): void => {
    if (para.length) {
      // Single newlines are soft wraps — join with a space, not a hard break.
      out.push('<p>' + para.map(inline).join(' ') + '</p>')
      para = []
    }
  }
  const closeList = (): void => {
    if (listType) {
      out.push(`</${listType}>`)
      listType = null
    }
  }

  while (i < lines.length) {
    const line = lines[i]

    // Fenced code block ``` … ```
    const fence = line.match(/^\s*```(\w*)\s*$/)
    if (fence) {
      flushPara()
      closeList()
      const lang = fence[1]
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i])
        i++
      }
      i++ // skip closing fence
      const cls = lang ? ` class="language-${lang}"` : ''
      out.push(`<pre><code${cls}>${esc(body.join('\n'))}</code></pre>`)
      continue
    }

    // Blank line — paragraph / list boundary
    if (!line.trim()) {
      flushPara()
      closeList()
      i++
      continue
    }

    // Quarto fenced-div delimiters (`::: {...}` / `:::`) and shortcodes
    // (`{{< include … >}}`) are render-time structure — show their contents,
    // not the fences.
    if (/^\s*:{3,}/.test(line) || /^\s*\{\{<.*>\}\}\s*$/.test(line)) {
      flushPara()
      closeList()
      i++
      continue
    }

    // Horizontal rule
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara()
      closeList()
      out.push('<hr>')
      i++
      continue
    }

    // Heading
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      flushPara()
      closeList()
      const level = h[1].length
      out.push(`<h${level}>${inline(h[2].replace(/\s+#+\s*$/, ''))}</h${level}>`)
      i++
      continue
    }

    // GFM pipe table: a header row followed by a `| --- | :--: |` delimiter.
    if (line.includes('|') && isTableDelimiter(lines[i + 1])) {
      flushPara()
      closeList()
      const aligns = tableCells(lines[i + 1]).map(alignOf)
      const head = tableCells(line)
      i += 2
      const body: string[][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        body.push(tableCells(lines[i]))
        i++
      }
      const cell = (tag: 'th' | 'td', text: string, col: number): string =>
        `<${tag}${aligns[col] ? ` style="text-align:${aligns[col]}"` : ''}>${inline(text)}</${tag}>`
      const rows = body
        .map((r) => '<tr>' + head.map((_h, c) => cell('td', r[c] ?? '', c)).join('') + '</tr>')
        .join('')
      out.push(
        '<table><thead><tr>' +
          head.map((h, c) => cell('th', h, c)).join('') +
          '</tr></thead>' +
          (rows ? `<tbody>${rows}</tbody>` : '') +
          '</table>'
      )
      continue
    }

    // Blockquote (consecutive `>` lines)
    if (/^\s*>\s?/.test(line)) {
      flushPara()
      closeList()
      const quote: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ''))
        i++
      }
      out.push('<blockquote>' + renderMarkdown(quote.join('\n')) + '</blockquote>')
      continue
    }

    // Ordered / unordered list item
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/)
    const ul = line.match(/^\s*[-*+]\s+(.*)$/)
    if (ol || ul) {
      flushPara()
      const want: 'ul' | 'ol' = ol ? 'ol' : 'ul'
      if (listType !== want) {
        closeList()
        out.push(`<${want}>`)
        listType = want
      }
      out.push('<li>' + inline((ol ? ol[1] : ul![1])) + '</li>')
      i++
      continue
    }

    // Plain text. With no blank line since the last list item, this is a lazy
    // continuation of that item (a wrapped line); otherwise it's paragraph text.
    if (listType && /<\/li>$/.test(out[out.length - 1] ?? '')) {
      out[out.length - 1] = out[out.length - 1].replace(
        /<\/li>$/,
        ' ' + inline(line.trim()) + '</li>'
      )
      i++
      continue
    }
    closeList()
    para.push(line.trim())
    i++
  }

  flushPara()
  closeList()
  return out.join('\n')
}

/** `| --- | :---: | ---: |` — the row that turns the line above it into a table. */
function isTableDelimiter(line: string | undefined): boolean {
  if (!line || !line.includes('-')) return false
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line)
}

/** Split a table row into cells, dropping the outer pipes. */
function tableCells(line: string): string[] {
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|')
  return cells.map((c) => c.trim())
}

function alignOf(spec: string): '' | 'center' | 'right' | 'left' {
  const left = spec.startsWith(':')
  const right = spec.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  if (left) return 'left'
  return ''
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function inline(t: string): string {
  // Protect inline code spans from further formatting.
  const codes: string[] = []
  let s = esc(t).replace(/`([^`]+)`/g, (_m, c) => {
    codes.push(c)
    return `\x00${codes.length - 1}\x00`
  })

  s = s
    // [@citekey] academic references
    .replace(/\[@([\w:-]+)\]/g, '<span class="cite">[@$1]</span>')
    // [text](url)
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '<a href="$2">$1</a>')
    // **bold**
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // *em* and _em_
    .replace(/(^|[^*])\*(?!\s)([^*]+?)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?!\s)([^_]+?)_/g, '$1<em>$2</em>')

  // Restore code spans.
  return s.replace(/\x00(\d+)\x00/g, (_m, n) => `<code>${codes[Number(n)]}</code>`)
}
