# lctrn — spike

A local-filesystem orchestration layer for Claude Code, shaped as an
academic-writing workbench.

## Model

Everything lives in one **library folder** (default `~/lctrn`, configurable on
first run):

```
~/lctrn/                    ← library root
  .lctrn/
    library.json              ← global paper registry (path + metadata)
    references.bib            ← ONE GENERATED bib for the whole library
  .sources/                   ← every PDF lives here (lctrn-owned, auto-watched)
  projects/
    my-paper/
      .lctrn/  config.json · todos.json · papers.json (the "desk" — foregrounded ids)
      manuscript/
        index.qmd            ← the paper: Quarto YAML + GENERATED include block
        sections/ *.qmd      ← one Quarto-markdown file per section (01-intro.qmd …)
      revisions/  revision-plan.md · round-NN/ snapshots
      .claude/   CLAUDE.md · settings.json · skills/
```

Two ideas drive it:

1. **One global pile, owned by the library.** All PDFs live in `.sources/` and
   are registered in `library.json`. Importing through the app copies the file in;
   you can also just **paste PDFs straight into `.sources/`** — a folder watcher
   (chokidar) reconciles the registry and the UI updates live. lctrn
   materializes **one** library-wide `references.bib` (in `.lctrn/`, with
   `file = {…}` pointing at the `.sources/` PDF) from the whole registry, and
   every project's manuscript cites it by relative path — so every manuscript can
   cite every paper. A project's `.lctrn/papers.json` is just a *desk*: which
   papers are foregrounded for that project, not a citation gate.

2. **The folder is the source of truth.** No database of record. The app is a GUI
   over files; `claude` is pointed at the same project folder via an embedded
   terminal (xterm.js + node-pty), so it reads/writes the same state.

## Onboarding flow

- **First run** → choose/confirm the library folder (`LibrarySetup`).
- **Global papers** → add PDFs to the shared pile (`LibraryPanel`).
- **New project** → `Onboarding` modal scaffolds the layout under
  `projects/<name>/`; attach papers from the library in the project view.

## Architecture

```
Electron main                         Renderer (Svelte 5)
├── library.ts   registry, projects,   ├── LibrarySetup    first-run root
│                 project↔paper refs,   ├── LibraryPanel    global pile
│                 references.bib gen     ├── ProjectView     attached papers + terminal
├── scaffold.ts  project templates      ├── Onboarding      new-project modal
└── pty.ts       node-pty bridge        └── Terminal        xterm.js
        │  contextBridge (preload → window.api)
```

## Run

```bash
npm install        # postinstall rebuilds node-pty for Electron
npm run dev
```

To test against bundled data, point the library at `examples/library/` (Choose
another… on first run). It already contains 3 registered papers and a
`sample-paper` project with 2 attached.

If the terminal reports "node-pty not built", run `npm run rebuild`.
If Electron fails with "Electron uninstall", run `node node_modules/electron/install.js`.

## Package (standalone Mac app)

To use lctrn without a dev server, build a real `.app`:

```bash
npm run package      # build + rebuild node-pty + electron-builder --mac
```

Output lands in `release/`:
- `release/mac-arm64/lctrn.app` — drag into `/Applications`
- `release/lctrn-<version>-arm64.dmg` — the installer image

The build is **unsigned** (no Apple Developer cert), so Gatekeeper blocks the
first open. Either right-click → Open the first time, or clear the quarantine
flag:

```bash
xattr -dr com.apple.quarantine /Applications/lctrn.app
```

Notes:
- The embedded terminal spawns your **login shell** (`zsh -l -i`), so `claude`
  resolves from your normal PATH even when launched from Finder.
- `node-pty` is a native addon; `electron-builder.yml` unpacks it from the asar
  (`asarUnpack`) and `npm run rebuild` compiles it against Electron's ABI before
  packaging.
- Config (`electron-builder.yml`) targets `arm64` only. For an Intel/universal
  build, add `--x64`/`--universal` to the `package` script.

## Next

- Extend watching to `.lctrn/` and projects so todos/plan refresh on disk changes too.
- Render `revisions/revision-plan.md` as an interactive checklist.
- Dispatch a revision-plan step into the terminal as a scoped prompt.
- PDF metadata extraction (title/authors/year/DOI) to enrich the registry.

## License

MIT — see [LICENSE](LICENSE).
