# agent-observer: spec

An Electron app (macOS only) to browse, search and watch live the transcripts of Claude Code, Codex and Antigravity CLI sessions, including those run in the Podman sandbox from `tejas-kale/config`.

## Goals

1. Sessions are easy to find.
2. Search works across all sessions and within one session.
3. Code blocks, diffs and tool output render correctly.
4. Live sessions update as they run.
5. Sandbox sessions are captured even though their containers are `--rm`.

Non-goals (v1): Linux or Windows builds, code signing, editing or resuming sessions, network features, semantic search (the design must leave room for it).

## Stack

TypeScript throughout. Electron main process (watching, parsing, indexing), React + Vite renderer, `better-sqlite3` with FTS5, Shiki for highlighting, a virtualised list for long transcripts, electron-builder for an unsigned dmg. Semantic search later: add `sqlite-vec` and an embeddings table keyed by event id; no schema change to existing tables.

## Sources

| Source | Location | Access |
|---|---|---|
| Host-native | `~/.claude`, `~/.codex`, `~/.gemini` on the Mac | chokidar watch, read by byte offset |
| Sandbox | Podman volumes `claude-home` (holds `~/.claude` and `~/.codex`) and `agy-home` (holds `~/.gemini`) | poll via podman, see below |

Each session records `host` (`native` or `sandbox`) alongside `agent`.

### Podman polling

Volumes live inside the Podman VM, so they are not watchable from macOS. Every 1-2 s while the app is open (and on launch), run a short-lived read-only container (`podman run --rm -v <volume>:/h:ro <image> ...`) that prints a manifest of transcript files (path, size, mtime) and, for changed files, bytes from the stored offset. Use the existing `localhost/agent-sandbox` image. Requirements:

- Offsets are stored per file; a file that shrinks is re-read from zero.
- One poll at a time; skip a tick if the previous is running.
- If the Podman machine is stopped, show "sandbox offline" and do not start it.
- Finished sessions are captured because the volumes persist after containers exit.

## Data model

SQLite, local only, in the app's user-data directory.

- `sessions(id, agent, host, project, cwd, title, started_at, updated_at, status, source_path)`; `status` is `live` when the file changed in the last ~30 s.
- `events(id, session_id, seq, parent_id, kind, role, ts, duration_ms, tokens_in, tokens_out, tool_name, text, raw_json)`; `kind` is one of `turn`, `reasoning`, `text`, `tool_call`, `tool_result`, `error`, `meta`.
- `events_fts` (FTS5) over `text` and `tool_name`, with `session_id` unindexed for filtering.
- `files(path, host, offset, mtime)` for incremental ingestion.

Ingestion is append-only and idempotent: re-reading the same bytes produces the same event ids.

## Parsers

One parser per agent, each turning raw lines into the common event model. Unknown record types become `meta` events and never crash ingestion.

- **Claude Code:** JSONL under `~/.claude/projects/<project>/<session>.jsonl`; subagent sidechains nest under their parent tool call.
- **Codex:** JSONL under `~/.codex/sessions/`.
- **Antigravity:** under `~/.gemini`. The format is not yet verified. The parser is tolerant, and Slice 3 requires a real sample session from the user before it is finished.

Each parser has fixture-based tests built from redacted real sessions.

## UI

- **Sidebar:** sessions grouped by project, sorted by recency; a badge for agent, a host marker, and a pulsing dot for live. Filters: agent, host, date range, status. A global search box shows matching sessions with snippets.
- **Session view (trace tree + detail, as in the reference artifact):** left, a collapsible tree of turns with reasoning, tool calls and results, each with icon, hint, duration and tokens; a Show filter (all, errors, reasoning, model text) and Collapse and Stats toggles. Right, the selected step's full content.
- **In-session search:** Cmd+F, highlights matches in the tree and detail, next/previous, count; matching ancestors expand automatically.
- **Rendering:** Markdown for model text; fenced code with Shiki and a copy button; unified diffs for edit/patch tools; shell output monospaced with ANSI colours, long output collapsed with expand; JSON tool args pretty-printed; images shown inline when present.
- **Live:** new events append without losing scroll position or selection; "follow" toggle to stick to the tail.
- Light and dark themes following the system.

## Privacy

Everything is local; no network calls. Transcripts are shown and indexed as-is, including any secrets they contain. The index inherits the sensitivity of the source files.

## Slices

- [ ] **1. Skeleton + Claude Code native:** Electron/Vite/React scaffold, SQLite schema, Claude Code parser, native watcher, sidebar and basic trace tree.
- [ ] **2. Rendering + search:** Shiki, diffs, ANSI output, FTS5 global and in-session search, filters.
- [ ] **3. Codex + Antigravity:** their parsers and native sources (needs the Antigravity sample).
- [ ] **4. Sandbox + packaging:** Podman poller, offline handling, live badges across hosts, dmg build.

Each slice ends with the app running against real sessions and tests green.

## Open items

- Antigravity transcript sample (blocks Slice 3).
- Name of the sandbox image tag to use for polling (default `localhost/agent-sandbox:latest`).
