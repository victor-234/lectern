# lctrn

A writing workbench for academic papers, built around a folder you own and a
Claude Code session pointed at it.

Two things it insists on:

1. **The folder is the source of truth.** There is no database. Every paper,
   every manuscript, every note is a file you can open with anything else, back
   up with Dropbox, and put in git. Delete the app and your work is untouched.
2. **One pile of papers, many projects.** PDFs live once in the library's
   `sources/`. Every project cites the same generated `references.bib`, so any
   manuscript can cite any paper without copying files around.

The embedded terminal runs the real `claude` CLI in the project folder, so
Claude edits the same files you are looking at, and the app watches them change.

---

## Try it in one command

```bash
git clone https://github.com/victor-234/lectern.git
cd lectern
npm install
npm run serve -- --demo --library ./lectern-demo
```

That builds both hosts, generates a small worked library, and opens it in your
browser. Or open the copy that is already committed here — point Lectern at
`examples/library/` on first run.

Either way you get three (fictional) papers, and a project whose manuscript
cites two of them. See [the workflow](#the-workflow) for what to do with it.

> The demo papers are synthesised by [`src/main/demo.ts`](src/main/demo.ts), not
> shipped as real PDFs — no redistribution questions, and they have a genuine
> text layer so search and citekey extraction work on them. Regenerate the
> committed copy with `npm run example`.

---

## Two ways to run it

Same backend, same library, same files. Pick whichever suits.

### Desktop app

```bash
npm run dev              # development
npm run package          # → release/mac-arm64/Lectern.app + a .dmg
```

The build is unsigned, so Gatekeeper blocks the first open: right-click → Open,
or `xattr -dr com.apple.quarantine /Applications/Lectern.app`.

### Localhost app

```bash
npm run serve                        # build, start, open a browser
node bin/lectern.js ~/papers         # a folder to open
node bin/lectern.js --help           # all the flags
```

Installed as a package (`npm i -g`, or `npx`) the same entrypoint is just
`lectern`.

Prints a URL with a one-time token. Useful because it needs no signing or
installer to hand to a colleague — and because the process runs wherever you
start it, so the folder can live on a lab machine you reach over SSH:

```bash
ssh -L 4747:localhost:4747 you@server    # then open the printed URL locally
```

**It binds `127.0.0.1` for a reason.** This server starts login shells and reads
and writes everything your account can. `--host` exposes that to your network;
use the tunnel above instead.

---

## What you need

Only one thing is genuinely required, and it isn't a key this repo holds.

**In the app: the ✦ button in the top-right corner — "Claude setup".** It tells
you whether Claude Code is installed, which version and where, and has a *Test
connection* button that proves you're logged in (installed and logged in are not
the same thing). The optional API key below is set in the same panel. If Claude
Code is missing, the terminal says so and links there instead of failing with
`command not found`.

| | What for | Required? |
|---|---|---|
| **`claude` CLI, logged in** | The embedded terminal — the point of the app. Also metadata extraction from PDFs without a DOI, and semantic paper search. | **Yes.** `npm install -g @anthropic-ai/claude-code`, then run `claude` once to log in (a Claude subscription or its own API key). Lectern never sees this credential and deliberately holds no copy: it spawns your **login shell**, so `claude` uses whatever account you authenticated there. Nothing to paste into Lectern, and no restart after logging in. |
| `ANTHROPIC_API_KEY` | Two direct-API features: **Rewrite** (edit a selection against your writing rules and get a diff to accept or reject) and metadata recovery from **scanned PDFs** with no usable text layer. | Optional. Both no-op silently without it. Set it in the environment, or paste it in Writing Rules ▸ Anthropic API key. The environment wins. |
| **Quarto** | Rendering a manuscript to PDF or HTML. | Optional. Everything else works without it; PDF output also needs a TeX install (TinyTeX is easiest). |
| **git** | The source-control chip and one-click commit/pull/push. | Optional, per project. |
| `LCTRN_CONTACT_EMAIL` | Not a key — a contact address sent to Crossref when looking up a DOI. It puts you in their [polite pool](https://api.crossref.org), which is better rate-limited and gets you an email before a block rather than a block. | Recommended if you import a lot. |

Crossref itself needs no account. Nothing else in the app talks to a third party.

Where a pasted key is stored depends on the host: the desktop app puts it in the
OS keychain, the localhost server has no keychain to bind to and writes a `0600`
file instead — the setup panel says which, and prefers `ANTHROPIC_API_KEY`.

Note the asymmetry, because it is the point: the credential that matters most is
the one Lectern never touches. Your Claude Code login stays where you put it.

---

## The workflow

The loop the app is shaped around, using the demo library.

**1 · Fill the pile.** Add PDFs, or just drop them into `sources/` — a watcher
picks them up. Each import tries, in order: metadata embedded in the PDF, then
the DOI via Crossref, then Claude reading the front matter, then (with an API
key) the first pages as images for scans. You get a title, authors, year,
journal and a `surnameYear` citekey. Fix anything wrong in the inspector;
renaming a citekey rewrites every `@oldkey` already sitting in your manuscripts.

**2 · Read.** Open a paper and it renders beside a notes pane, saved as markdown
in `notes/`. `⌘F` searches the text; the search box next to it asks a question
of the paper instead and jumps to the passages that answer it.

**3 · Start a project.** Scaffolds `projects/<name>/` with a `manuscript.qmd`,
a `.claude/` folder (instructions, settings, three skills) and a revision plan.
Attach the papers you're working from — that's a *desk*, not a citation gate;
the bibliography is always the whole library.

**4 · Write.** `@` completes citekeys from the library. Select a passage and
right-click to leave a margin note — those land in `MANUSCRIPT_NOTES.md`, where
Claude can act on them and mark them done.

**5 · Hand work to Claude.** Open the terminal, scoped to the project. Ask for
something concrete: *"tighten the introduction; every empirical claim must cite
something in the bibliography."* Claude edits the files you're looking at and
the editor picks the changes up.

**6 · See what it did.** Every turn is snapshotted, so the review panel shows
what changed, grouped by the prompt that caused it, keep or revert per file.
(Claude Code hooks report turn boundaries to a loopback bridge — see
[`src/main/bridge.ts`](src/main/bridge.ts).)

**7 · Teach it your voice.** Turn on revising mode, edit Claude's prose the way
you'd edit a co-author's, turn it off: the diff is distilled into
`LEARNED_EDITS.md`, which takes precedence over your general writing rules
because it's evidence rather than instruction. Three tiers, most general first:
`.lctrn/WRITING_RULES.md` (all papers) → `WRITING_STYLE.md` (this venue) →
`LEARNED_EDITS.md` (your actual corrections).

**8 · Render.** To PDF or HTML, with the log streaming into the workspace.

Alongside all that, **Inquiries** asks a question of a *selection* of papers
rather than one — it saves the question and the hit-set as a folder under
`.lctrn/inquiries/` and writes the answer back as `result.md`.

---

## On disk

```
my-library/
  sources/                     every PDF, one copy, watched
  notes/                       per-paper reading notes (markdown)
  .lctrn/
    library.json               the paper registry
    references.bib             GENERATED from the registry — the whole library
    tags.json  journals.json   tags and groups; journal abbreviations
    text/  embeddings/         extracted-text and embedding caches
    inquiries/<slug>/          a saved question over a selection + result.md
    WRITING_RULES.md           your durable voice, shared by every project
  projects/<name>/
    manuscript.qmd             the paper (Quarto)
    MANUSCRIPT_NOTES.md        margin notes
    LEARNED_EDITS.md           distilled from your own corrections
    WRITING_STYLE.md           this paper / this venue
    revisions/revision-plan.md
    .lctrn/                    config.json · papers.json (the desk) · todos.json
    .claude/                   CLAUDE.md · settings.json · skills/
```

`references.bib` is generated — never edit it by hand. Its `file = {…}` entries
hold absolute paths, so they're rewritten whenever you point Lectern at the
library, which is what makes a Dropbox library work on a second machine.

Per-project references that aren't papers — a policy document, a web page — live
in `.lctrn/extra-refs.json` and are materialised into `extra.bib`.

---

## Architecture

One backend, two front doors. Everything under `src/main` is host-agnostic; the
four seams that keep it that way are worth knowing before you change anything.

```
                    ┌─ src/main/core.ts ─────────────────────────┐
                    │  every IPC handler, registered once        │
                    │  library · projects · quarto · pty · git   │
                    │  notes · review · inquiries · rewrite      │
                    └────────────────┬───────────────────────────┘
                                     │  IpcLike / WindowLike
              ┌──────────────────────┴───────────────────────┐
     src/main/index.ts                              src/server/index.ts
     Electron: window, menu,                        HTTP + WebSocket,
     native dialogs, lctrn-pdf://                   token auth, /pdf/…
              │                                              │
        preload (ipcRenderer)                        lib/rpc.ts (WebSocket)
              └──────────────────────┬───────────────────────┘
                          src/shared/api.ts
                    createApi(transport) → window.api
                                     │
                       src/renderer (Svelte 5)
```

| Seam | Why |
|---|---|
| [`src/main/platform.ts`](src/main/platform.ts) | `IpcLike`/`WindowLike` structural types, plus an adapter for the only four native calls (`app.getPath`, `safeStorage`, `shell.openPath`). [`platform.electron.ts`](src/main/platform.electron.ts) is the **only** file under `src/main` that imports Electron at runtime — the server build fails if that changes. |
| [`src/main/core.ts`](src/main/core.ts) | Every host-agnostic handler. New features go here, not in either entrypoint. |
| [`src/shared/api.ts`](src/shared/api.ts) | One definition of `window.api`, over a transport. The preload passes `ipcRenderer`; the browser passes a WebSocket. They cannot drift. |
| [`src/renderer/src/lib/pdfUrl.ts`](src/renderer/src/lib/pdfUrl.ts) | `lctrn-pdf://` in the app, `/pdf/…` from the server. |

Two things differ by host and arrive as dependencies rather than as branches
inside handlers: **picking files** (a native dialog vs. a server-side folder
browser and an upload) and **highlighting inside a PDF** (Chromium's
find-in-page reaching into the PDFium plugin, which has no web equivalent — the
reader falls back to a plain page jump).

Native modules: `node-pty` is compiled per ABI, and both live side by side —
`electron-rebuild` replaces `build/Release/`, while plain Node falls through to
the N-API copy in `prebuilds/`.

---

## Development

```bash
npm install              # postinstall rebuilds node-pty for Electron, if present
npm run dev              # desktop, with HMR
npm run serve            # localhost app
npm run example          # regenerate examples/library
npx svelte-check         # npm run build does NOT typecheck — run this
```

Known rough edges:

- Running the desktop app and a server **at the same time** makes them fight over
  `~/.lctrn/bridge`; the loser's checkpoint review stops grouping edits by
  prompt.
- `electron-builder.yml` targets `arm64` only. Add `--x64` or `--universal` to
  the `package` script for Intel.
- If the terminal says node-pty isn't built, `npm run rebuild`.

## License

MIT — see [LICENSE](LICENSE).
