import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PeriscopeService } from '../src/core/service.ts';
import { mountPeriscopeApp } from '../src/tui/app.ts';

function setupFixture(): { tmp: string; service: PeriscopeService } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'periscope-resp-'));
  const claudeDir = path.join(tmp, 'claude', 'proj-alpha');
  fs.mkdirSync(claudeDir, { recursive: true });
  const sessionId = '22222222-2222-2222-2222-222222222222';
  const filePath = path.join(claudeDir, `${sessionId}.jsonl`);

  const records = [
    {
      type: 'user',
      uuid: 'u1',
      cwd: '/work/proj-alpha',
      timestamp: '2026-06-01T12:00:00Z',
      message: {
        role: 'user',
        content: 'Investigate responsive layout and verify long_trace_hint_token_visible_when_wider',
      },
    },
    {
      type: 'assistant',
      uuid: 'a1',
      parentUuid: 'u1',
      timestamp: '2026-06-01T12:00:02Z',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: '# Detail\n\nCOL_MARKER 0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ_END',
          },
        ],
      },
    },
  ];
  fs.writeFileSync(filePath, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const service = new PeriscopeService({
    dbPath: ':memory:',
    roots: [{ agent: 'claude', dir: path.join(tmp, 'claude') }],
    agyMetadata: path.join(tmp, 'nonexistent.json'),
    claudeSessionsDir: path.join(tmp, 'no-sessions'),
    sandboxEnabled: false,
  });

  return { tmp, service };
}

test('headless UI: pane resizing, detail zoom, and 120x40 to 80x24 responsive resize', async () => {
  const { tmp, service } = setupFixture();
  const { createTestRenderer } = await import('@opentui/core/testing');
  const { renderer, mockInput, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 120,
    height: 40,
  });

  const handle = mountPeriscopeApp(renderer, {
    service,
    theme: 'dark',
    initiallyIndexing: true,
    onQuit: () => {},
  });

  try {
    await service.start();
    await handle.refresh();
    await renderOnce();

    // Open session -> focus moves to trace pane, select assistant step (a1), and switch to Raw mode (synchronous TextRenderable)
    await mockInput.pressArrow('down');
    await mockInput.pressEnter();
    await new Promise((r) => setTimeout(r, 40));
    await renderOnce();
    await mockInput.pressArrow('down');
    await mockInput.pressKey('r');
    await renderOnce();

    const frame120 = captureCharFrame();
    assert.match(frame120, /proj-alpha \(1\)/);
    assert.match(frame120, /Investigate responsive/);
    assert.match(frame120, /COL_MARKER 0123456789/);

    // Measure trace pane border position before/after growing trace pane with ']'
    const linesBefore = frame120.split('\n');
    const borderColsBefore = linesBefore[2]!.indexOf('│', linesBefore[2]!.indexOf('│') + 1);
    await mockInput.pressKey(']');
    await mockInput.pressKey(']');
    await renderOnce();
    const linesAfterGrow = captureCharFrame().split('\n');
    const borderColsAfter = linesAfterGrow[2]!.indexOf('│', linesAfterGrow[2]!.indexOf('│') + 1);
    assert.ok(borderColsAfter > borderColsBefore, `expected trace pane to grow (${borderColsBefore} -> ${borderColsAfter})`);

    // Reset with '='
    await mockInput.pressKey('=');
    await renderOnce();
    const linesAfterReset = captureCharFrame().split('\n');
    const borderColsReset = linesAfterReset[2]!.indexOf('│', linesAfterReset[2]!.indexOf('│') + 1);
    assert.equal(borderColsReset, borderColsBefore);

    // Toggle full-width detail zoom with 'Z'
    await mockInput.pressKey('Z');
    await renderOnce();
    const zoomedFrame = captureCharFrame();
    assert.doesNotMatch(zoomedFrame, /proj-alpha \(1\)/);
    assert.match(zoomedFrame, /ABCDEFGHIJKLMNOPQRSTUVWXYZ_END/);

    // Unzoom with 'Z'
    await mockInput.pressKey('Z');
    await renderOnce();
    const unzoomedFrame = captureCharFrame();
    assert.match(unzoomedFrame, /proj-alpha \(1\)/);

    // Resize terminal to 80x24
    renderer.resize(80, 24);
    await renderOnce();
    const frame80 = captureCharFrame();
    const lines80 = (frame80.endsWith('\n') ? frame80.slice(0, -1) : frame80).split('\n');
    assert.equal(lines80.length, 24);
    for (const line of lines80) {
      assert.ok(line.length <= 80, `line exceeds 80 cols: ${line.length}`);
    }
    assert.match(lines80[0]!, /Periscope/);
    assert.match(frame80, /proj-alpha/);
    assert.match(frame80, /Investigate/);

    // Detail zoom also works cleanly at 80x24
    await mockInput.pressKey('Z');
    await renderOnce();
    const zoomed80 = captureCharFrame();
    assert.doesNotMatch(zoomed80, /proj-alpha/);
    assert.match(zoomed80, /ABCDEFGHIJKLMNOPQRSTUVWXYZ_END/);

    // Esc unzooms cleanly (allow OpenTUI escape sequence timeout to flush)
    mockInput.pressEscape();
    await new Promise((r) => setTimeout(r, 60));
    await renderOnce();
    assert.match(captureCharFrame(), /proj-alpha/);
  } finally {
    handle.dispose();
    await service.stop();
    renderer.destroy();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('headless UI: theme follows terminal light/dark detection and supports CLI flag + t keybind override', async () => {
  const { tmp, service } = setupFixture();
  const { createTestRenderer } = await import('@opentui/core/testing');
  const { renderer, mockInput, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 120,
    height: 40,
  });

  const handle = mountPeriscopeApp(renderer, {
    service,
    theme: 'auto',
    initiallyIndexing: true,
    onQuit: () => {},
  });

  try {
    await service.start();
    await handle.refresh();
    await renderOnce();

    // Default fallback when terminal themeMode is null
    assert.match(captureCharFrame(), /theme: dark/);

    // Terminal emits light mode detection -> auto theme follows it
    renderer.emit('theme_mode', 'light');
    await renderOnce();
    assert.match(captureCharFrame(), /theme: light/);

    // Keybind 't' overrides to dark
    await mockInput.pressKey('t');
    await renderOnce();
    assert.match(captureCharFrame(), /theme: dark/);

    // Once manually overridden, terminal theme_mode events do not clobber user choice
    renderer.emit('theme_mode', 'light');
    await renderOnce();
    assert.match(captureCharFrame(), /theme: dark/);

    // Keybind 't' toggles back to light
    await mockInput.pressKey('t');
    await renderOnce();
    assert.match(captureCharFrame(), /theme: light/);
  } finally {
    handle.dispose();
    await service.stop();
    renderer.destroy();
  }

  // CLI flag --theme dark overrides terminal light detection
  const { tmp: tmp2, service: service2 } = setupFixture();
  const { renderer: r2, mockInput: m2, renderOnce: ro2, captureCharFrame: cap2 } = await createTestRenderer({
    width: 120,
    height: 40,
  });
  const handle2 = mountPeriscopeApp(r2, {
    service: service2,
    theme: 'dark',
    initiallyIndexing: true,
    onQuit: () => {},
  });
  try {
    await service2.start();
    await handle2.refresh();
    r2.emit('theme_mode', 'light');
    await ro2();
    assert.match(cap2(), /theme: dark/);

    await m2.pressKey('t');
    await ro2();
    assert.match(cap2(), /theme: light/);
  } finally {
    handle2.dispose();
    await service2.stop();
    r2.destroy();
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(tmp2, { recursive: true, force: true });
  }
});

test('headless UI: help overlay lists shortcuts and opens/closes cleanly at 120x40 and 80x24', async () => {
  const { tmp, service } = setupFixture();
  const { createTestRenderer } = await import('@opentui/core/testing');
  const { renderer, mockInput, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 120,
    height: 40,
  });

  const handle = mountPeriscopeApp(renderer, {
    service,
    theme: 'dark',
    initiallyIndexing: true,
    onQuit: () => {},
  });

  try {
    await service.start();
    await handle.refresh();
    await renderOnce();

    // Open help overlay with '?'
    await mockInput.pressKey('?');
    await renderOnce();
    const helpFrame = captureCharFrame();
    assert.match(helpFrame, /Keyboard Shortcuts/);
    assert.match(helpFrame, /\[ \/ \]/);
    assert.match(helpFrame, /Toggle full-width detail pane zoom/);
    assert.match(helpFrame, /Toggle light \/ dark colour theme/);
    assert.match(helpFrame, /q \/ Ctrl\+C/);

    // Close help overlay with Esc
    mockInput.pressEscape();
    await new Promise((r) => setTimeout(r, 60));
    await renderOnce();
    const afterEsc = captureCharFrame();
    assert.doesNotMatch(afterEsc, /Keyboard Shortcuts/);
    assert.match(afterEsc, /proj-alpha \(1\)/);

    // Resize to 80x24, open with '?', scroll down, and close with '?'
    renderer.resize(80, 24);
    await mockInput.pressKey('?');
    await renderOnce();
    const help80 = captureCharFrame();
    assert.match(help80, /Keyboard Shortcuts/);
    for (let i = 0; i < 30; i++) await mockInput.pressKey('j');
    await renderOnce();
    assert.match(captureCharFrame(), /Detail Pane/);

    await mockInput.pressKey('?');
    await renderOnce();
    assert.doesNotMatch(captureCharFrame(), /Keyboard Shortcuts/);
  } finally {
    handle.dispose();
    await service.stop();
    renderer.destroy();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
