# Periscope: spec

A full-screen terminal app (macOS and Linux, including over SSH, inside tmux, and inside containers) to browse, search, and watch live the transcripts of Claude Code, Codex, and Antigravity CLI sessions, including those run in the Podman sandbox.

## Goals

1. Sessions are easy to find, filter, and quick-open from the keyboard.
2. Search works across all sessions (FTS5) and within a session.
3. Model Markdown, fenced code, unified diffs, ANSI shell output, and images render cleanly in the terminal.
4. Live sessions update as they run without disrupting reading position, with an optional follow mode.
5. Sandbox sessions are captured even though their containers are `--rm`.
6. Terminal state is always restored cleanly on exit, Ctrl+C, or uncaught errors.

Non-goals: Windows, GUI/Electron packaging, editing or resuming sessions, network features, semantic search (the schema leaves room for a future embeddings table).

## Stack

- **Runtime:** Node.js `>=26.4.0` with native TypeScript type stripping (`"type": "module"`).
- **Terminal UI:** `@opentui/core` (`0.8.4`) imperative API behind a thin app-owned adapter (`src/tui/adapter.ts`).
- **Storage & Search:** Node's built-in `node:sqlite` with FTS5 (`events_fts`).
- **Watching:** Node's built-in `fs.watch(..., { recursive: true })` for native transcripts and Podman CLI polling for sandbox volumes.

## Sources

| Source | Location | Access |
|---|---|---|
| Host-native | `~/.claude`, `~/.codex`, `~/.gemini` | Recursive `fs.watch`, read by byte offset |
| Sandbox | Podman volumes `claude-home` (`~/.claude`, `~/.codex`) and `agy-home` (`~/.gemini`) | Poll via `podman run --rm` |

Each session records `host` (`native` or `sandbox`) alongside `agent` (`claude`, `codex`, `antigravity`).

### Podman polling

Volumes live inside the Podman VM on macOS, so they are not watchable from the host. Every 1.5 s while the app is open, Periscope runs a short-lived read-only container (`podman run --rm -i --network none --user 0:0 -v <volume>:/v/<volume>:ro --entrypoint node <image> -e <script>`) that prints a manifest of transcript files (path, size, mtime) and bytes from the stored offset for changed files:

- Offsets are stored per file; a file that shrinks is re-read from zero.
- One poll at a time; ticks are skipped if the previous poll is still running.
- If the Podman machine is stopped, the status bar shows `sandbox offline` and Periscope never starts it.
- Finished sessions are captured because the volumes persist after containers exit.

## Data model

SQLite, local only (`~/Library/Application Support/Periscope/periscope.db` on macOS, `$XDG_DATA_HOME/periscope/periscope.db` on Linux):

- `sessions(id, agent, host, project, cwd, title, started_at, updated_at, status, source_path)`
- `events(id, session_id, seq, parent_id, kind, role, ts, duration_ms, tokens_in, tokens_out, tool_name, text, raw_json)`
- `events_fts` (FTS5) over `text` and `tool_name`, with `session_id` unindexed for filtering
- `files(path, host, offset, mtime, session_id, state)` for incremental, resumable ingestion

Ingestion is append-only and idempotent: re-reading the same bytes produces the same event IDs.

## Architecture

- **`src/cli/`:** Parses `--help`, `--version`, `--db`, `--sandbox`/`--no-sandbox`, and `--theme`, starts `PeriscopeService`, and runs the OpenTUI lifecycle shell.
- **`src/core/`:** Parsers (`claude.ts`, `codex.ts`, `antigravity.ts`), `Store`, `Ingestor`, `NativeReader`, `PodmanPoller`, `presence`, and `PeriscopeService` (implementing `PeriscopeApi` with injectable clock, process runner, and filesystem roots).
- **`src/view-model/`:** Pure, UI-neutral functions for session grouping/filtering, trace tree construction, windowing, follow mode, in-session find, detail formatting, stats/context views, clipboard OSC 52 / temp-file fallback, responsive layout (`>=120` down to `80x24`), sandbox status formatting, and `KEY_BINDINGS`.
- **`src/tui/`:** Thin OpenTUI adapter, terminal lifecycle shell, 3-pane layout (Sessions, Trace Tree, Detail), overlays (Help, Stats, Context, Sandbox status), and find/filter bars.

## Privacy

Everything is local; no network calls. Transcripts are shown and indexed as-is.
