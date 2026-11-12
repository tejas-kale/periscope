# Periscope: progress

Spec: [SPEC.md](SPEC.md) · CLI & Terminal UI implementation complete.

## Completed

1. **CLI & Terminal Shell (`src/cli/`, `src/tui/adapter.ts`, `src/tui/shell.ts`):**
   - `periscope` bin entrypoint with `--help`, `--version`, `--db`, `--sandbox`/`--no-sandbox`, and `--theme` (`auto` | `dark` | `light`).
   - OpenTUI (`@opentui/core` `0.8.4`) imperative adapter and terminal lifecycle shell that restores terminal state on quit (`q`, `Ctrl+C`) or uncaught errors.
2. **Core Service (`src/core/service.ts`):**
   - Extracted `PeriscopeService` implementing `PeriscopeApi` with `node:sqlite` (FTS5), `fs.watch(..., { recursive: true })`, `NativeReader`, `PodmanPoller`, Claude Code presence tracking, live-session expiry, and debounced change notifications.
   - Injectable clock, process runner, and filesystem roots for deterministic testing.
3. **Pure View-Model (`src/view-model/`):**
   - Moved and expanded pure logic for trace tree building, tool-result folding, noise filtering, Show filter, collapse/expand, windowed rendering, follow mode, in-session find, session list grouping/filtering, FTS5 snippet parsing, detail formatting (Markdown, diffs, ANSI, images), stats/context views, clipboard fallback, responsive layout, sandbox status, and `KEY_BINDINGS`.
4. **Three-Pane Terminal UI (`src/tui/app.ts`, `src/tui/detail-pane.ts`, `src/tui/highlight.ts`):**
   - Session list grouped by project (top 3 expanded), `1-9` quick-open, agent/host/status/date filters, and global FTS5 search with snippet jump.
   - Windowed trace tree with subagent nesting, Show filter, Collapse-all toggle, Stats (`s`) and Context (`x`) views, and in-session find (`/`, `n`/`N`, `Esc`).
   - Detail pane with Markdown/Raw toggle (`r`), syntax-highlighted code, unified diffs, ANSI shell output with 40-line collapse/expand (`e`), and inline image protocol or placeholder.
   - Live session append without moving scroll/selection, follow mode (`f`), live session list updates, and Podman sandbox status (`S`).
   - Clipboard copy (`y`/`c`/`d`/`i`/`p`) via OSC 52 with temp-file fallback.
   - Responsive layout down to `80x24`, pane resizing (`[`/`]`/`=`), detail zoom (`Z`), light/dark theme toggle (`t`), and `?` help overlay.
5. **Electron Removal & Documentation:**
   - Removed Electron, `electron-builder`, React, Vite, Shiki, `react-markdown`, `better-sqlite3`, `chokidar`, dmg packaging, icon tooling, and `src/main/` + `src/renderer/`.
   - Updated `SPEC.md`, `PROGRESS.md`, and `README.md` for the terminal app.

## Verification

- `npm test`: 107 tests passing via `node --test` (core parsers, store, service, view-model, CLI, and headless OpenTUI integration tests including 5,000+ step performance check).
- `npm run typecheck`: `tsc --noEmit -p tsconfig.json` passing with 0 errors.
