# Spec: Periscope as a terminal app

Status: ready-for-agent

## Problem Statement

I use Periscope to find, read, search and watch live the transcripts of my Claude Code, Codex and Antigravity
sessions, on the Mac and inside the Podman sandbox. Today it is an Electron app. That brings a 200 MB bundle, a
Chromium process per window, and a fragile build (native SQLite module rebuilds, an Electron installer that fails
silently on new Node versions). It is also macOS-only and cannot run where I often am: in a terminal, over SSH, or
inside the sandbox container itself. An agent working in a Linux container cannot launch or check it either.

## Solution

Periscope becomes a full-screen terminal app, started with one command (`periscope`). It keeps everything the
Electron app does for finding, reading, searching and following sessions, with the same index and sources, and
drops Electron entirely. It looks and behaves like a keyboard-first terminal tool (three panes: sessions, trace
tree, detail), uses the mouse where the terminal allows it, and degrades gracefully where the terminal lacks a
capability (images, clipboard, theme detection).

## User Stories

Starting and indexing

1. As a user, I want to start Periscope with a single `periscope` command, so that I can open it from any terminal.
2. As a user, I want Periscope to index every transcript it finds on first launch, so that all past sessions are
   available straight away.
3. As a user, I want later launches to pick up only what changed since last time, so that start-up stays fast.
4. As a user, I want the index kept in the same per-user data location as before on macOS (and an XDG data
   directory on Linux), so that I can delete it to rebuild from scratch.
5. As a user, I want indexing progress shown while the first index builds, so that I know the app has not hung.
6. As a user, I want Periscope to leave the terminal exactly as it found it when I quit or it crashes, so that my
   shell is never left in a broken state.

Finding sessions

7. As a user, I want a session list grouped by project and sorted by most recent activity, so that the session I
   want is usually near the top.
8. As a user, I want each session to show its title, agent (Claude Code, Codex, Antigravity), host (Mac or
   Sandbox) and age, so that I can tell sessions apart at a glance.
9. As a user, I want running and open Claude Code sessions, and recently written Codex and Antigravity sessions,
   marked as live, so that I can see what is active now.
10. As a user, I want to filter the list by agent, host, date range and status, so that I can narrow a long list.
11. As a user, I want the top few projects expanded with their most recent sessions and the rest collapsed, so
    that the list stays short until I ask for more.
12. As a user, I want to open the nth session from the top with a single key chord, so that I can jump to a
    recent session without moving through the list.
13. As a user, I want to type a global search query and see matching sessions with highlighted snippets, so that I
    can find a session by something said in it.
14. As a user, I want opening a search hit to open that session at the matching step, so that I land on the
    relevant part.

Reading a session

15. As a user, I want a trace tree of the session's turns, reasoning, model text, tool calls and results, each
    with an icon, a short hint, its duration and its token counts, so that I can see the shape of the session.
16. As a user, I want subagent work nested under the tool call that started it, so that delegated work reads in
    context.
17. As a user, I want tool results folded into their tool call and noise rows hidden, as the Electron app does, so
    that the tree shows only meaningful steps.
18. As a user, I want to collapse and expand tree nodes with the arrow keys, so that I can skim long sessions.
19. As a user, I want a Show filter (all, errors, reasoning, model text) and a Collapse toggle, so that I can focus
    on one kind of step.
20. As a user, I want a Stats view with the session's totals (duration, tokens, tool calls, errors), so that I can
    judge a session's cost and size.
21. As a user, I want sessions with thousands of steps to scroll smoothly, so that large sessions stay usable.
22. As a user, I want a detail pane showing the selected step in full, so that I can read it without leaving the
    tree.
23. As a user, I want model text rendered as Markdown, including tables, lists and fenced code, so that it reads
    as intended.
24. As a user, I want code blocks syntax-highlighted, so that code is easy to read.
25. As a user, I want edit and patch tool calls shown as unified diffs with added and removed lines coloured, so
    that I can see what changed.
26. As a user, I want shell output shown with its ANSI colours, and long output collapsed with a way to expand it,
    so that big outputs do not swamp the pane.
27. As a user, I want tool arguments and other JSON pretty-printed, so that structured input is readable.
28. As a user, I want a Raw toggle on Markdown output, so that I can see the original text.
29. As a user, I want the injected context of a session (system reminders, attachments) in a separate Context
    view, so that it is available without cluttering the tree.
30. As a user, I want images shown inline in terminals that support an image protocol, and otherwise a labelled
    placeholder with the image's location, so that I know an image was there.
31. As a user, I want the layout to stay usable down to 80×24, with the detail pane able to take the full width,
    so that I can use Periscope in a small terminal or split.
32. As a user, I want to resize the panes, so that I can give the tree or the detail more room.

Searching within a session

33. As a user, I want to press a find key, type a query, and see every match highlighted in the tree and the
    detail pane, so that I can find a passage in a long session.
34. As a user, I want next and previous match keys and a match count, so that I can step through matches.
35. As a user, I want collapsed ancestors of a match to expand automatically, so that no match stays hidden.
36. As a user, I want Escape to close find and clear the highlights, so that I get back to normal reading.

Live sessions

37. As a user, I want new steps in an open live session to appear as they happen, so that I can watch a session
    run.
38. As a user, I want new steps to append without moving my scroll position or selection, so that I can keep
    reading earlier steps while a session runs.
39. As a user, I want a follow mode that keeps the newest step selected and in view, so that I can watch the tail.
40. As a user, I want the session list to update as sessions start, change and finish, so that it always reflects
    what is happening.

Sandbox

41. As a user, I want sessions run in the Podman sandbox captured and shown alongside Mac sessions, so that I see
    everything in one place.
42. As a user, I want a visible sandbox status (online, offline, error), and the error message on request, so
    that I know when sandbox sessions are not being captured and why.
43. As a user, I want Periscope never to start the Podman machine, so that it has no side effects on my system.
44. As a user, I want to turn the sandbox poller off with an environment variable and choose its image, as today,
    so that existing configuration keeps working.

Copying

45. As a user, I want to copy the selected step's text, a code block, or a diff to the system clipboard with a
    key, so that I can paste it elsewhere.
46. As a user, I want a fallback when the terminal does not support clipboard writes (the text written to a
    temporary file and its path shown), so that copying always works.
47. As a user, I want to copy a session's id and source file path, so that I can open the raw transcript.

Terminal and keyboard

48. As a user, I want every action reachable from the keyboard, with a help overlay listing the keys, so that I
    never need the mouse.
49. As a user, I want to click to select and scroll with the wheel or trackpad, so that I can use the mouse when
    it is quicker.
50. As a user, I want the colours to follow my terminal's light or dark background, with a manual override, so
    that the app is readable in either theme.
51. As a user, I want Periscope to work in Ghostty, iTerm2, Kitty, WezTerm and Terminal.app, over SSH, inside tmux,
    and inside a Linux container, so that I can use it wherever I am.

Privacy

52. As a user, I want Periscope to make no network calls, so that my transcripts never leave my machine.

## Implementation Decisions

Platform and runtime

- Periscope is a Node command-line program. It requires Node 26.4 or newer (OpenTUI's minimum on Node). Bun is not
  a target.
- The terminal UI uses OpenTUI (`@opentui/core`), pinned to an exact version (0.8.4 at the time of writing; it is
  pre-1.0 and its API changes between minor versions). Use its Solid bindings (`@opentui/solid`) for the views if
  the first ticket shows they build and run on Node 26 with a plain build step; otherwise use the core imperative
  API. Decide once, in the first ticket, and record the decision.
- OpenTUI calls are reached through a thin, app-owned adapter for the parts most likely to churn (renderer set-up,
  clipboard, capability detection, images), so that an OpenTUI upgrade touches one place.
- SQLite is Node's built-in `node:sqlite` with FTS5, the same driver the tests already use behind the store's
  `SqlDb` interface. `better-sqlite3` is removed.
- Electron, electron-builder, React, React DOM, Vite, Shiki, react-markdown, the dmg packaging and the icon
  tooling are removed. The app ships as an npm package with a `periscope` bin entry.
- The database file and its location on macOS stay as they are, so an existing index keeps working. On Linux it
  lives under `$XDG_DATA_HOME/periscope` (default `~/.local/share/periscope`). The schema does not change.

Modules

- **Core (unchanged in behaviour):** parsers, store, ingestor, native reader, Podman poller and presence stay as
  they are. They already have no Electron imports.
- **Periscope service (new, extracted from the Electron main process):** a single Electron-free module that owns
  everything the main process does today: opening the store, the ingestor, native file watching, the sandbox
  poller and its status, Claude Code presence (native and sandbox), live expiry, and debounced change
  notifications. It implements the existing `PeriscopeApi` interface (list sessions, get events, get raw record,
  search, sandbox status, read image, subscribe to changes, subscribe to sandbox status) and adds start and stop.
  Its time source, process runner (for Podman) and file-system roots are injectable so it can run against
  fixtures. This is the boundary between the back end and the UI; the UI uses nothing else from core.
- **View model (moved, not rewritten):** the pure logic in the renderer's `lib` (trace tree building, Show filter,
  collapse, noise and context detection, flattening to rows, in-session match finding, tree order, hints,
  formatting, event merging, ANSI parsing, line diff, unified diff parsing, Markdown detection) moves to a
  UI-neutral location and keeps its tests. New view-model logic (session list grouping, keyboard state, follow
  mode, selection preservation across appends, match navigation) is written here as pure functions, not inside
  view code.
- **Terminal UI (new):** the three panes (session list, trace tree, detail), the find bar, filters, Stats and
  Context views, the help overlay and the status line. It holds no business logic: it renders view-model output
  and turns keys and mouse events into view-model actions.
- **Rendering inside the detail pane** uses OpenTUI's own components where they exist (Markdown, code with
  tree-sitter highlighting, diff, text table, image, scroll box) rather than porting Shiki or react-markdown.
- **Command-line entry:** parses flags (help, version, database path override, sandbox on or off), starts the
  service, then the UI, and guarantees the terminal is restored on exit, on Ctrl+C and on an uncaught error.

Behaviour

- The tree is windowed: only the rows in view (plus a small margin) are built as UI nodes. Row identity is the
  event id, so selection and scroll position survive appends and re-filtering.
- Appends to the open session use the existing "events since sequence number" query and event merging; they
  never rebuild the view from scratch.
- Follow mode turns off when the user moves the selection or scrolls up, and on again with its key or by
  selecting the last row.
- Images use the terminal's image protocol when OpenTUI reports support, otherwise a one-line placeholder with
  the image's path or "embedded image".
- Copy uses OSC 52 when the terminal reports support. Otherwise, or when the text exceeds a size cap, it writes
  the text to a file in the system temporary directory and shows the path in the status line.
- Light or dark theme follows OpenTUI's theme-mode detection; a flag and a key override it.
- The sandbox poller keeps its current behaviour, interval and environment variables
  (`PERISCOPE_SANDBOX_IMAGE`, `PERISCOPE_SANDBOX=0`).
- Key bindings carry over from the Electron app where the terminal can deliver them. `⌘` shortcuts become
  terminal-safe equivalents (for example `/` for find, `n`/`N` for next and previous match); the help overlay is
  the source of truth.

## Testing Decisions

- A good test drives the app the way a user does and checks what the user sees: it feeds key presses (and mouse
  events where relevant) and asserts on the rendered screen text. It does not reach into component state or
  call view internals.
- **Primary seam: the terminal UI as a whole.** Tests start the real Periscope service against the fixture
  transcript directories with an in-memory database, render the UI with OpenTUI's headless test renderer at a
  fixed size, drive it with its mock keyboard and mouse, and assert on captured frames. Appending lines to a
  fixture file copied to a temporary directory exercises live behaviour. The test renderer's resize lets the same
  test check 120×40 and 80×24. The first ticket must confirm the test renderer runs under `node --test`; if it
  does not, the fallback is to run these tests under Bun's test runner and record that.
- **Secondary seam: the `PeriscopeApi` service**, for behaviour the screen cannot show cheaply: incremental
  ingestion across restarts, change notification debouncing, live expiry, sandbox offline and error states with a
  fake process runner.
- The view-model's pure functions keep their existing unit tests, which move with them.
- The existing core tests (parsers, store, ingestion, native reader, Podman, presence) stay as they are and must
  stay green throughout.
- A performance check, run as a test with a generous threshold, loads a synthetic session of at least 5,000 steps
  and checks that moving the selection and appending steps each finish a frame quickly, using OpenTUI's native
  render statistics rather than wall-clock time where possible.
- Prior art: the fixture-based tests in the test directory, the in-memory store helper, and the fake process
  runner in the Podman tests.

## Out of Scope

- The Electron app, the dmg, code signing, and any GUI.
- Bun as a runtime, single-binary builds, Homebrew packaging.
- Windows.
- Editing, resuming or replaying sessions.
- Semantic search (the schema still leaves room for an embeddings table).
- Side-by-side diffs (unified only).
- Mouse text selection inside the app (copy is by key).
- Network features of any kind.

## Further Notes

- Known terminal limits accepted up front: no images in Terminal.app and often none inside tmux; OSC 52 is plain
  text and size-capped, and needs `set-clipboard on` in tmux; wide Markdown tables and long diff lines wrap or
  truncate below about 100 columns; theme detection often returns nothing over SSH, hence the override.
- OpenTUI's synchronised-output default (`auto`) should be left on; it already avoids the lag it causes over slow
  SSH links through tmux.
- The existing `SPEC.md`, `PROGRESS.md` and `README.md` describe the Electron app and must be rewritten for the
  terminal app as part of this work.
- Development in a Linux container needs Node 26.4 or newer installed there; the Mac already has Node 26.
