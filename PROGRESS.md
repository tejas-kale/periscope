# Periscope: progress (2026-11-08)

Branch `agent/claude-20261108-140312`. Spec: [SPEC.md](SPEC.md).

## Done and tested (`npm test`: 27 pass, plain Node, no packages needed)

- `src/core/`: Claude Code, Codex, Antigravity parsers; SQLite store with FTS5; incremental, idempotent ingestor
  (per-file offset + parser state in `files`); native reader; Podman poller (read-only `node -e` container).
- `src/renderer/lib/`: trace tree, Show filter, collapse, in-session search, ANSI parser, line diff.
- Fixtures: redacted real sessions in `test/fixtures/` (`scripts/redact-fixture.mjs`).
- Smoke run over all 146 transcripts in this container (96 MB): ~0.9 s, no orphaned events.

## Written, never compiled or run

- `src/main/main.ts`, `src/main/preload.ts`, all of `src/renderer/` (React components), `vite.config.ts`,
  `scripts/build-main.mjs`, `electron-builder.yml`.

## Next steps

1. User runs `claude-pkg npm install` (container) or `npm install` (Mac). Nothing is installed yet.
2. `npm run typecheck`; fix errors (known: `role?: string` vs `null` in `src/core/parsers/codex.ts` `mk`).
3. `npm run build`; check `import.meta.dirname` -> `__dirname` define and the shiki JS regex engine import.
4. User launches `npm start` on the Mac (no display in the container) and reports what breaks.
5. `npm run dist` for the dmg; then tick the Slices in SPEC.md.

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
