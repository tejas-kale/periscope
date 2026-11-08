# Periscope: progress (2026-11-08)

Branch `agent/claude-20261108-140312`. Spec: [SPEC.md](SPEC.md).

## Done and tested (`npm test`: 27 pass, plain Node, no packages needed)

- `src/core/`: Claude Code, Codex, Antigravity parsers; SQLite store with FTS5; incremental, idempotent ingestor
  (per-file offset + parser state in `files`); native reader; Podman poller (read-only `node -e` container).
- `src/renderer/lib/`: trace tree, Show filter, collapse, in-session search, ANSI parser, line diff.
- Fixtures: redacted real sessions in `test/fixtures/` (`scripts/redact-fixture.mjs`).
- Smoke run over all 146 transcripts in this container (96 MB): ~0.9 s, no orphaned events.

## Built and launched on the Mac (2026-11-08)

- `npm install`, `npm run typecheck` (clean), `npm test` (27 pass), `npm run build` all succeed.
- `npx electron .` starts with no errors; native ingest filled the DB (181 sessions, 17k events).
- Setup gotchas: npm skipped install scripts, so run `npx electron-builder install-app-deps`.
  `node_modules/electron/install.js` exits silently on Node 26 without extracting; unzip the cached zip
  (~/Library/Caches/electron) into `node_modules/electron/dist` and write `path.txt`
  (`Electron.app/Contents/MacOS/Electron`).

## UI pass 1 (2026-11-08, not yet run on the Mac)

Results fold into their tool call; noise rows hidden (empty thinking, injected context, /exit, caveats, bare
system subtypes); injected context moved to a Context panel (`i`); Codex exec shown as its shell command; code
and output wrap; Markdown output rendered (Raw toggle); SVG kind icons and a bigger chevron; keyboard
shortcuts with a `?` modal; sidebar: top 3 projects open, 4 chats each plus "Show 4 more"; sandbox badge
click shows the Podman error.

## Next steps

1. Eyeball the UI (sidebar, trace tree, detail, Cmd+F, live follow, sandbox source) and fix what breaks.
2. Shiki bundles every language; restrict to the languages actually used.
3. `npm run dist` for the dmg; then tick the Slices in SPEC.md.

## Decisions taken (not in the spec)

- `files` has two extra columns, `session_id` and `state` (parser state JSON), so a chunked read resumes exactly.
- Session ids: `n:<uuid>` native, `s:<uuid>` sandbox. Sandbox file paths: `podman:<volume>:<path in volume>`.
- Claude subagent files join the parent session, nested under the Agent tool call (from `agent-*.meta.json`).
- Bookkeeping records (api-request*, file-history*, mode, cost-state, ...) are skipped, not stored as meta.
- Antigravity sample came from this container (`~/.gemini/antigravity-cli/brain/*/.system_generated/logs/transcript_full.jsonl`):
  tool results are the GENERIC steps after a PLANNER_RESPONSE, matched in order.
- Sandbox layout: `claude-home` = `~/.claude` (Codex at `codex/sessions`), `agy-home` = `~/.gemini`.
- Tests use `node:sqlite` behind the `SqlDb` interface; the app uses `better-sqlite3`.
- In-session search is client-side, highlighted with the CSS Custom Highlight API; global search is FTS5.
