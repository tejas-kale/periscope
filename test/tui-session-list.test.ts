import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { FIXTURES } from './helpers.ts';
import { PeriscopeService } from '../src/core/service.ts';
import { mountPeriscopeApp } from '../src/tui/app.ts';
import type { SessionRow } from '../src/core/types.ts';

function fixtureRoots() {
  return [
    { agent: 'claude' as const, dir: path.join(FIXTURES, 'claude') },
    { agent: 'codex' as const, dir: path.join(FIXTURES, 'codex') },
    { agent: 'antigravity' as const, dir: path.join(FIXTURES, 'antigravity') },
  ];
}

test('headless UI: displays indexing progress, grouped sessions, and supports keyboard, 1-9 quick-open, and mouse', async () => {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const { renderer, mockInput, mockMouse, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 100,
    height: 24,
  });

  const service = new PeriscopeService({
    dbPath: ':memory:',
    roots: fixtureRoots(),
    agyMetadata: path.join(FIXTURES, 'antigravity', 'nonexistent.json'),
    claudeSessionsDir: path.join(FIXTURES, 'no-sessions'),
    sandboxEnabled: false,
  });

  const seenFrames: string[] = [];
  const selectedSessions: SessionRow[] = [];
  let quitCalled = false;

  const handle = mountPeriscopeApp(renderer, {
    service,
    theme: 'dark',
    initiallyIndexing: true,
    onQuit: () => {
      quitCalled = true;
    },
    onSelectSession: (s) => {
      selectedSessions.push(s);
    },
  });

  const offProgress = service.onProgress(async (p) => {
    if (!p.done && p.indexed === 0) {
      await renderOnce();
      seenFrames.push(captureCharFrame());
    }
  });

  try {
    await renderOnce();
    const initialFrame = captureCharFrame();
    assert.match(initialFrame, /Indexing sessions/i);

    await service.start();
    await handle.refresh();
    await renderOnce();

    assert.ok(seenFrames.some((f) => /Indexing sessions.*0 \/ \d+/.test(f)));

    const listFrame = captureCharFrame();
    assert.match(listFrame, /Claude Code/);
    assert.match(listFrame, /Codex/);
    assert.match(listFrame, /Antigravity/);
    assert.match(listFrame, /Mac/);
    assert.match(listFrame, /\[1\]/);

    // Navigate down from first group header to first session and press Enter
    await mockInput.pressArrow('down');
    await mockInput.pressEnter();
    await renderOnce();
    assert.equal(selectedSessions.length, 1);
    const afterEnterFrame = captureCharFrame();
    assert.match(afterEnterFrame, /Selected:/);

    // Quick-open 2nd visible session with '2'
    await mockInput.pressKey('2');
    await renderOnce();
    assert.equal(selectedSessions.length, 2);
    assert.notEqual(selectedSessions[1]!.id, selectedSessions[0]!.id);

    // Mouse click on the first session row (y=2: header=0, group=1, first session=2)
    await mockMouse.click(4, 2);
    await renderOnce();
    assert.equal(selectedSessions.length, 3);
    assert.equal(selectedSessions[2]!.id, selectedSessions[0]!.id);

    // Mouse wheel scroll
    await mockMouse.scroll(4, 2, 'down');
    await renderOnce();

    // Quit with 'q'
    await mockInput.pressKey('q');
    assert.equal(quitCalled, true);
  } finally {
    offProgress();
    handle.dispose();
    await service.stop();
    renderer.destroy();
  }
});

test('headless UI: shows live badge for active session and collapses projects beyond top 3', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'periscope-ui-'));
  const now = Date.parse('2026-06-01T12:00:00Z');

  try {
    const claudeRoot = path.join(tmp, 'claude');
    const projects = ['proj-1', 'proj-2', 'proj-3', 'proj-4'];
    projects.forEach((proj, idx) => {
      const dir = path.join(claudeRoot, proj);
      fs.mkdirSync(dir, { recursive: true });
      const ts = new Date(now - idx * 60_000).toISOString();
      const id = `00000000-0000-0000-0000-00000000000${idx + 1}`;
      const filePath = path.join(dir, `${id}.jsonl`);
      fs.writeFileSync(
        filePath,
        JSON.stringify({ type: 'user', cwd: `/work/${proj}`, timestamp: ts, message: { role: 'user', content: `Task in ${proj}` } }) + '\n',
      );
      const mtime = new Date(now - idx * 60_000);
      fs.utimesSync(filePath, mtime, mtime);
    });

    const service = new PeriscopeService({
      dbPath: ':memory:',
      roots: [{ agent: 'claude', dir: claudeRoot }],
      agyMetadata: path.join(tmp, 'nonexistent.json'),
      claudeSessionsDir: path.join(tmp, 'no-sessions'),
      sandboxEnabled: false,
      clock: () => now,
    });

    const { createTestRenderer } = await import('@opentui/core/testing');
    const { renderer, mockInput, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 100,
      height: 24,
    });

    const handle = mountPeriscopeApp(renderer, {
      service,
      theme: 'light',
      clock: () => now,
      initiallyIndexing: true,
      onQuit: () => {},
    });

    try {
      await service.start();
      await handle.refresh();
      await renderOnce();

      const frame = captureCharFrame();
      assert.match(frame, /● live/);
      assert.match(frame, /▾ proj-1/);
      assert.match(frame, /▾ proj-2/);
      assert.match(frame, /▾ proj-3/);
      assert.match(frame, /▸ proj-4/);
      assert.doesNotMatch(frame, /Task in proj-4/);

      // Jump to bottom (proj-4) and expand it
      await mockInput.pressKey('G', { shift: true });
      await mockInput.pressEnter();
      await renderOnce();

      const expandedFrame = captureCharFrame();
      assert.match(expandedFrame, /▾ proj-4/);
      assert.match(expandedFrame, /Task in proj-4/);
    } finally {
      handle.dispose();
      await service.stop();
      renderer.destroy();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
