# Periscope

A full-screen terminal app to browse, search, and watch live the transcripts of Claude Code, Codex, and Antigravity CLI sessions, locally and inside a Podman sandbox. See [SPEC.md](SPEC.md).

## Requirements

- Node.js `>=26.4.0` (uses built-in `node:sqlite`, recursive `fs.watch`, and native TypeScript type stripping)

## Run

```sh
npm install          # installs @opentui/core and builds dist/ via prepare
node src/cli/index.ts [options]
# or install globally from a local clone or GitHub:
npm link
npm install -g github:tejas-kale/periscope
# or from a tagged GitHub Release tarball:
npm install -g https://github.com/tejas-kale/periscope/releases/latest/download/periscope-0.1.0.tgz
periscope [options]
```

Run tests and typecheck:

```sh
npm test             # runs unit, service, and headless OpenTUI tests via node --test
npm run typecheck    # tsc --noEmit -p tsconfig.json
```

### CLI Options

```text
Usage: periscope [options]

Options:
  -h, --help            Show this help message
  -v, --version         Show version number
      --db <path>       Override SQLite database path
      --sandbox         Enable Podman sandbox polling
      --no-sandbox      Disable Podman sandbox polling
      --theme <mode>    Set colour theme: auto, dark, or light (default: auto)
```

First launch indexes every transcript it finds and displays indexing progress. Subsequent launches ingest only appended or changed bytes.

Database location:
- **macOS:** `~/Library/Application Support/Periscope/periscope.db`
- **Linux:** `$XDG_DATA_HOME/periscope/periscope.db` (defaults to `~/.local/share/periscope/periscope.db`)

Delete the database file to rebuild the index from scratch.

## Sources

| Agent | Host-native | In the sandbox (Podman volume) |
|---|---|---|
| Claude Code | `~/.claude/projects/<project>/<session>.jsonl` (+ `<session>/subagents/agent-*.jsonl`) | `claude-home:/projects/...` |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` | `claude-home:/codex/sessions/...` |
| Antigravity | `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript_full.jsonl` | `agy-home:/antigravity-cli/brain/...` |

The sandbox is polled every 1.5 s with a throwaway read-only container
(`podman run --rm -i --network none --user 0:0 -v <volume>:/v/<volume>:ro --entrypoint node <image> -e <script>`).
It runs as container root because, in rootless Podman, that is the user who owns the volume files (transcripts are mode 600).
If the Podman machine is stopped, the status bar shows `sandbox offline`; Periscope never starts it.

Environment variables:

- `PERISCOPE_SANDBOX_IMAGE`: image for polling (default `localhost/agent-sandbox:latest`).
- `PERISCOPE_SANDBOX=0`: turn the sandbox poller off.

## Architecture

- `src/cli/`: CLI entrypoint (`index.ts`) and flag parser (`args.ts`).
- `src/core/`: parsers (`claude.ts`, `codex.ts`, `antigravity.ts`), SQLite store with FTS5 (`store.ts`), incremental ingestor (`ingest.ts`), native reader (`native.ts`), Podman poller (`podman.ts`), presence detector (`presence.ts`), and `PeriscopeService` (`service.ts`).
- `src/view-model/`: UI-neutral pure logic for session grouping/filtering, trace tree building, windowing, follow mode, in-session find, detail formatting (Markdown, diffs, ANSI, images), stats/context views, clipboard fallback, responsive layout, sandbox status, and keymap.
- `src/tui/`: OpenTUI adapter (`adapter.ts`), terminal lifecycle shell (`shell.ts`), 3-pane app (`app.ts`), detail pane (`detail-pane.ts`), and search highlighting (`highlight.ts`).
- `test/`: unit, service, and headless OpenTUI integration tests (`createTestRenderer`), plus redacted fixtures in `test/fixtures/`.

## Keys

Press `?` inside Periscope to open the full help overlay (source of truth: `src/view-model/keymap.ts`):

- **Global:** `?` help overlay · `Tab` / `Shift+Tab` cycle panes · `1-9` quick-open Nth visible session · `S` toggle sandbox status detail · `Esc` close overlay / unzoom / return to trace · `q` / `Ctrl+C` quit
- **Layout & Theme:** `[` / `]` resize focused pane · `=` reset pane widths · `Z` zoom detail pane · `t` toggle light / dark theme
- **Sessions:** `↑/↓` or `k/j` move cursor · `←/→` or `h/l` collapse / expand project · `Space` toggle / select · `Enter` open session · `m` show more · `g` / `G` top / bottom · `/` or `Ctrl+K` global search · `a` / `o` / `s` cycle agent / host / status filter · `d` / `D` cycle / enter date filter · `c` clear filters
- **Trace Tree:** `↑/↓` or `k/j` move step · `PgUp` / `PgDn` page · `←/→` or `h/l` collapse/ascend or expand/descend · `Space` toggle expand · `g` / `G` first / last · `Enter` focus detail · `/` in-session find (`n` / `N` next/prev match) · `r` raw Markdown · `e` expand tool output · `f` live follow · `v` / `z` cycle step filter / collapse-all · `s` / `x` stats / context view
- **Detail Pane:** `↑/↓` or `k/j` scroll · `PgUp` / `PgDn` page · `h` / `Esc` return to trace · `r` raw Markdown · `e` expand tool output · `y` / `c` / `d` copy step / code block / diff · `i` / `p` copy session ID / source path
