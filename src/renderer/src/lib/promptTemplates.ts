// Prompt templates surfaced by the Reader pane's "Prompt templates" button.
// Each one expands into a prompt that is dispatched to Claude in the embedded
// terminal, with a reference to the active paper's PDF path so Claude can read
// it directly. Folder-as-source-of-truth: we hand Claude the absolute path, not
// the bytes. Add entries here to grow the menu.

export interface PromptPaper {
  absPath: string // absolute path to the paper's PDF
  citekey: string // BibTeX key, for citing in the manuscript
  title: string
}

export interface PromptTemplate {
  id: string
  label: string
  icon: string // Icon.svelte name
  build: (p: PromptPaper) => string
}

// A reference clause every template opens with, so Claude always knows which
// file to read and how to cite it.
function ref(p: PromptPaper): string {
  return `the paper at \`${p.absPath}\` (cite as [@${p.citekey}])`
}

// Context lead-in for a free-form ("custom") prompt: names the paper, its path
// and citekey up front so the user only has to fill in the actual instruction.
// The result is `<context>\n\n<their words>`.
export function buildCustomPrompt(p: PromptPaper, instruction: string): string {
  const context =
    `Regarding "${p.title}" — ${ref(p)}. Read it first if you need to, then:\n\n`
  return context + instruction.trim()
}

// Free-form prompt across several papers at once: lists each paper (title, path,
// citekey) as a numbered reference, then the user's instruction. Used by the
// Reader's "Prompt multiple papers" composer.
export function buildMultiPrompt(papers: PromptPaper[], instruction: string): string {
  const list = papers
    .map((p, i) => `${i + 1}. "${p.title}" at \`${p.absPath}\` (cite as [@${p.citekey}])`)
    .join('\n')
  const context = `Regarding these papers:\n${list}\n\nRead any you need to, then:\n\n`
  return context + instruction.trim()
}

export const PROMPT_TEMPLATES: PromptTemplate[] = [
  {
    id: 'summarize',
    label: 'Summarize paper',
    icon: 'note',
    build: (p) =>
      `Read ${ref(p)} and give me a concise summary: the research question, ` +
      `method and data, key findings, and the paper's contribution. Keep it tight — ` +
      `a short paragraph per point.`
  },
  {
    id: 'outline',
    label: 'Create outline',
    icon: 'list',
    build: (p) =>
      `Read ${ref(p)} and produce a structured outline of it — its sections and ` +
      `the main argument under each — as nested bullets I can skim.`
  },
  {
    id: 'contributions',
    label: 'Key contributions',
    icon: 'sparkle',
    build: (p) =>
      `Read ${ref(p)} and list its key contributions as bullets, each in one ` +
      `sentence. Separate genuine novel claims from incremental ones.`
  },
  {
    id: 'methods',
    label: 'Methods & data',
    icon: 'search',
    build: (p) =>
      `Read ${ref(p)} and explain its methodology and data: the design, sample, ` +
      `identification/estimation strategy, and any key assumptions or limitations.`
  },
  {
    id: 'critique',
    label: 'Limitations & critique',
    icon: 'pen',
    build: (p) =>
      `Read ${ref(p)} and give me a critical appraisal: its main limitations, ` +
      `threats to validity, and open questions a referee would raise. Be specific, ` +
      `not generic.`
  },
  {
    id: 'relevance',
    label: 'Relevance to manuscript',
    icon: 'link',
    build: (p) =>
      `Read ${ref(p)} and tell me how it relates to my manuscript (\`manuscript.qmd\`): ` +
      `where it could be cited, what it supports or contradicts, and a one-line ` +
      `[@${p.citekey}] citation sentence I could drop in.`
  }
]
