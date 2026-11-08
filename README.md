# Periscope

A macOS Electron app to browse, search and watch live the transcripts of Claude Code, Codex and Antigravity CLI
sessions, on the Mac and inside the Podman sandbox. See [SPEC.md](SPEC.md).

## Run

```sh
npm install          # also rebuilds better-sqlite3 for Electron
npm start            # build and launch
npm run dev          # Vite dev server with reload for the renderer
npm run dist         # unsigned dmg in release/
npm test             # core tests, plain Node (no Electron needed)
```

First launch indexes every transcript it finds; ~100 MB of transcripts takes about a second.
The index is `~/Library/Application Support/Periscope/periscope.db`. Delete it to rebuild from scratch.

## Sources

| Agent | On the Mac | In the sandbox (Podman volume) |
|---|---|---|
| Claude Code | `~/.claude/projects/<project>/<session>.jsonl` (+ `<session>/subagents/agent-*.jsonl`) | `claude-home:/projects/...` |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` | `claude-home:/codex/sessions/...` |
| Antigravity | `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript_full.jsonl` | `agy-home:/antigravity-cli/brain/...` |

The sandbox is polled every 1.5 s with a throwaway read-only container
(`podman run --rm -i --network none -v <volume>:/v/<volume>:ro --entrypoint node <image> -e <script>`).
If the Podman machine is stopped the sidebar shows "sandbox offline"; Periscope never starts it.

Environment:

- `PERISCOPE_SANDBOX_IMAGE`: image for polling (default `localhost/agent-sandbox:latest`).
- `PERISCOPE_SANDBOX=0`: turn the sandbox poller off.

## Layout

- `src/core/`: parsers, SQLite store (FTS5), ingestor, native reader, Podman poller. No Electron imports, so the
  tests run on plain Node with type stripping and `node:sqlite`; the app uses `better-sqlite3`.
- `src/main/`: Electron main process and preload.
- `src/renderer/`: React UI. `lib/` holds the pure tree, ANSI and diff logic (tested).
- `test/fixtures/`: redacted real transcripts, made with `scripts/redact-fixture.mjs`.

## Keys

`⌘F` find in session · `Enter` / `⇧Enter` next / previous match · `⌘G` next match · `↑↓` move in the trace ·
`←→` collapse / expand · `Esc` close find.
