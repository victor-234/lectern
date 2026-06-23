import { promises as fs } from 'fs'
import { join } from 'path'
import { LEARNED_EDITS_FILE, learnedEditsStarter, learnEditsSkill } from './revising'
import { addressNotesSkill } from './notes'

export interface ProjectMeta {
  title: string
  authors: string[]
  manuscriptFile: string
  model: string
}

export interface ProjectInfo {
  isProject: boolean
  config: (ProjectMeta & { created?: string; lctrnVersion?: number }) | null
}

const FOLDERS = [
  'revisions',
  '.lctrn',
  '.claude',
  '.claude/skills/revise-section',
  '.claude/skills/learn-edits',
  '.claude/skills/address-notes'
]

/**
 * Write the canonical project layout into `projectPath`. Non-destructive: only
 * creates files that don't already exist, so it doubles as "initialize in place".
 * Papers are NOT stored here, and neither is the bibliography: papers live in
 * the shared library and `.lctrn/papers.json` records which are foregrounded
 * for this project (the "desk"), but every manuscript cites the one
 * library-wide `references.bib` (`../../.lctrn/references.bib`). The two Quarto
 * documents (`manuscript.qmd`, `slides.qmd`) are created by `ensureQuartoDocs`
 * (quarto.ts), which `createProject` calls right after this.
 */
export async function scaffoldProject(
  projectPath: string,
  meta: ProjectMeta,
  now: string
): Promise<void> {
  for (const f of FOLDERS) {
    await fs.mkdir(join(projectPath, f), { recursive: true })
  }

  const files: Record<string, string> = {
    '.lctrn/config.json': configJson(meta, now),
    '.lctrn/todos.json': todosJson(),
    '.lctrn/papers.json': papersJson(),
    'revisions/revision-plan.md': revisionPlanMd(meta),
    'revisions/README.md': revisionsReadme(),
    '.claude/CLAUDE.md': claudeMd(meta),
    '.claude/settings.json': claudeSettings(meta),
    '.claude/skills/revise-section/SKILL.md': reviseSectionSkill(),
    '.claude/skills/learn-edits/SKILL.md': learnEditsSkill(),
    '.claude/skills/address-notes/SKILL.md': addressNotesSkill(),
    [LEARNED_EDITS_FILE]: learnedEditsStarter()
  }

  for (const [rel, content] of Object.entries(files)) {
    await writeIfAbsent(join(projectPath, rel), content)
  }
}

export async function readProjectInfo(projectPath: string): Promise<ProjectInfo> {
  try {
    const raw = await fs.readFile(join(projectPath, '.lctrn', 'config.json'), 'utf8')
    return { isProject: true, config: JSON.parse(raw) }
  } catch {
    return { isProject: false, config: null }
  }
}

async function writeIfAbsent(path: string, content: string): Promise<void> {
  try {
    await fs.access(path)
  } catch {
    await fs.writeFile(path, content, 'utf8')
  }
}

// --- Templates ---------------------------------------------------------------

function configJson(meta: ProjectMeta, now: string): string {
  return (
    JSON.stringify(
      {
        title: meta.title,
        authors: meta.authors,
        manuscriptFile: meta.manuscriptFile || 'manuscript.qmd',
        slidesFile: 'slides.qmd',
        model: meta.model,
        created: now,
        lctrnVersion: 1
      },
      null,
      2
    ) + '\n'
  )
}

function todosJson(): string {
  return JSON.stringify({ todos: [] }, null, 2) + '\n'
}

function papersJson(): string {
  return JSON.stringify({ paperIds: [] }, null, 2) + '\n'
}

function revisionPlanMd(meta: ProjectMeta): string {
  return `# Revision plan — ${meta.title}

Each step is a scoped Claude Code task. Status: \`[ ]\` to-do · \`[~]\` doing · \`[x]\` done.
When a step is done, snapshot the manuscript into \`revisions/round-NN/\`.

- [ ] **1. Structure pass** — lead with the contribution; cut the related-work dump to one paragraph.
- [ ] **2. Align abstract with results** — every number in the abstract must trace to a table/figure.
- [ ] **3. Methods reproducibility** — make the methods reproducible from text alone; flag gaps.
- [ ] **4. Citation pass** — every empirical claim cites \`references.bib\`; report uncited claims. Never fabricate citations.
- [ ] **5. Final read** — tighten prose; enforce house style from \`.claude/CLAUDE.md\`.
`
}

function revisionsReadme(): string {
  return `# Revisions

- \`revision-plan.md\` — the ordered plan. Keep status markers in sync.
- \`round-NN/\` — snapshots of the manuscript after each revision round, so you can diff progress.

lctrn dispatches each plan step to Claude Code as a scoped task in the project directory.
`
}

function claudeMd(meta: ProjectMeta): string {
  const byline = meta.authors.length ? meta.authors.join(', ') : 'unknown'
  return `# Paper: ${meta.title}

Authors: ${byline}. Managed by lctrn — the folder is the source of truth.

## Layout
- \`manuscript.qmd\` — the paper, a single Quarto document: YAML front matter
  (title, authors, formats, a \`bibliography:\` list of \`../../.lctrn/references.bib\` and
  \`.lctrn/extra.bib\`) then the body.
  Write prose, cite library papers as \`[@citekey]\`, and run analyses in code chunks
  (R/knitr works out of the box; Python needs \`jupyter\`). Render with \`quarto render manuscript.qmd\`.
- \`slides.qmd\` — the talk, a Quarto revealjs document. Same bibliography and \`@citekey\`
  citing. Render with \`quarto render slides.qmd\`.
- \`../../.lctrn/references.bib\` — ONE library-wide bibliography GENERATED by lctrn from the
  shared library; every project cites it, so every library paper is available here. Do not hand-edit.
- \`.lctrn/papers.json\` — the library papers foregrounded for this project (the "desk"). This is
  a focus aid only; you can still cite any key in \`references.bib\`, not just these.
- \`.lctrn/extra.bib\` — project-local manual references (policy articles, news, web pages — things
  with no PDF in the library), GENERATED by lctrn from \`.lctrn/extra-refs.json\`. Do not hand-edit
  the \`.bib\`; the user manages these through the app. Cite them with \`@citekey\` like any other.
- \`revisions/revision-plan.md\` — the ordered revision plan. Keep status markers in sync.
- \`.lctrn/todos.json\` — granular tasks.

PDFs are not stored in this folder; the \`file = {...}\` field in the bibliography points at the
shared library location of each PDF.

## House style
- Prefer plain, direct prose. Cut hedging.
- Every empirical claim must cite a key from \`references.bib\`.
- Never invent citations. If a claim is uncited, flag it — do not fabricate a reference.
- When you complete a revision-plan step, update its checkbox in \`revisions/revision-plan.md\`.
- Follow \`${LEARNED_EDITS_FILE}\` — durable writing rules learned from the author's
  own corrections. They take precedence and encode this author's voice.
`
}

function claudeSettings(meta: ProjectMeta): string {
  return (
    JSON.stringify(
      {
        model: meta.model,
        permissions: {
          allow: ['Read', 'Edit', 'Write', 'Grep', 'Glob'],
          deny: ['Bash(rm *)'],
          // The bibliography lives one level up in the shared library; grant read
          // access so Claude can resolve @citekeys. Relative so it survives a
          // Dropbox-synced library moving between machines.
          additionalDirectories: ['../../.lctrn']
        }
      },
      null,
      2
    ) + '\n'
  )
}

function reviseSectionSkill(): string {
  return `---
name: revise-section
description: Revise one section of the manuscript against the house style and revision plan
---

You are revising a single section of \`manuscript.qmd\`. Steps:

1. Read \`.claude/CLAUDE.md\` for house style and \`revisions/revision-plan.md\` for the active goal.
2. Read \`manuscript.qmd\` and locate the section (heading) the user names.
3. Revise that section in place: tighten prose, ensure every empirical claim cites
   \`references.bib\` as \`[@citekey]\`, and flag (do not fabricate) any claim that lacks a citation.
4. Summarize what you changed and list any uncited claims you flagged.
`
}
