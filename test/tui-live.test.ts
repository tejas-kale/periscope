import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PeriscopeService } from '../src/core/service.ts';
import { mountPeriscopeApp } from '../src/tui/app.ts';

const FIXTURE_CLAUDE = path.resolve('test/fixtures/claude/proj/9fde03bf-efa5-480b-8289-14c5e1d865da.jsonl');

async function waitFor(
  check: () => Promise<boolean> | boolean,
  timeoutMs = 3000,
  stepMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

test('headless UI live: append preserves scroll/selection when follow is off, tracks newest when follow is on, and updates session list live', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'periscope-live-'));
  try {
    const claudeDir = path.join(tmp, 'claude', 'proj-live');
    fs.mkdirSync(claudeDir, { recursive: true });
    const sessionId = '9fde03bf-efa5-480b-8289-14c5e1d865da';
    const filePath = path.join(claudeDir, `${sessionId}.jsonl`);
    fs.copyFileSync(FIXTURE_CLAUDE, filePath);

    let now = fs.statSync(filePath).mtimeMs + 1_000;
    const service = new PeriscopeService({
      dbPath: ':memory:',
      roots: [{ agent: 'claude', dir: path.join(tmp, 'claude') }],
      agyMetadata: path.join(tmp, 'nonexistent.json'),
      claudeSessionsDir: path.join(tmp, 'no-sessions'),
      sandboxEnabled: false,
      clock: () => now,
      debounceMs: 25,
      expireMs: 30,
    });

    const { createTestRenderer } = await import('@opentui/core/testing');
    const { renderer, mockInput, mockMouse, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 140,
      height: 25,
    });

    const handle = mountPeriscopeApp(renderer, {
      service,
      theme: 'dark',
      clock: () => now,
      initiallyIndexing: true,
      onQuit: () => {},
    });

    try {
      await service.start();
      await waitFor(async () => {
        await renderOnce();
        return captureCharFrame().includes('● live');
      });

      // Open the live session
      await mockInput.pressArrow('down');
      await mockInput.pressEnter();
      await waitFor(async () => {
        await renderOnce();
        return captureCharFrame().includes('follow: off (f)');
      });

      // Move down to step 3 (not the first, not the last) so selection and scroll are anchored
      await mockInput.pressArrow('down');
      await mockInput.pressArrow('down');
      await renderOnce();
      const beforeAppendFrame = captureCharFrame();
      assert.match(beforeAppendFrame, /follow: off \(f\)/);

      // Append a new user turn to the copied fixture transcript (becomes the last row)
      const appendLine = (uuid: string, text: string, ts: string) => {
        fs.appendFileSync(
          filePath,
          JSON.stringify({
            type: 'user',
            uuid,
            timestamp: ts,
            message: { role: 'user', content: text },
          }) + '\n',
        );
      };

      // Wait for chokidar watcher to be ready before appending
      await new Promise((r) => setTimeout(r, 200));
      appendLine('live-step-1', 'LIVE_APPEND_MARKER_1', '2026-11-12T10:00:01Z');

      // Wait for chokidar -> ingest -> onChange -> UI update
      await waitFor(async () => {
        await renderOnce();
        return captureCharFrame().includes('LIVE_APPEND_MARKER_1');
      });

      // With follow OFF, new step appeared in trace, but selection (Bash · 303ms) and scroll (delegate at top) stayed put
      const afterOffAppend = captureCharFrame();
      assert.match(afterOffAppend, /follow: off \(f\)/);
      assert.match(afterOffAppend, /Bash\s+·\s+303ms/);
      assert.match(afterOffAppend, /delegate: delegate:/);

      // Enable follow mode with 'f' -> jumps to newest step and shows [FOLLOW]
      await mockInput.pressKey('f');
      let lastFrame = '';
      try {
        await waitFor(async () => {
          await renderOnce();
          lastFrame = captureCharFrame();
          return lastFrame.includes('[FOLLOW] (f)') && !lastFrame.includes('Bash  ·  303ms') && lastFrame.includes('LIVE_APPEND_MARKER_1');
        });
      } catch (e) {
        throw new Error(`${(e as Error).message}\nFrame:\n${lastFrame}`);
      }

      // Append another step while follow is ON -> automatically selects & scrolls to it
      appendLine('live-step-2', 'LIVE_APPEND_MARKER_2', '2026-11-12T10:00:02Z');
      await waitFor(async () => {
        await renderOnce();
        const f = captureCharFrame();
        // Detail pane shows LIVE_APPEND_MARKER_2 (User prompt header)
        return f.includes('LIVE_APPEND_MARKER_2') && f.includes('User prompt');
      });

      // Manual upward move disables follow mode
      await mockInput.pressArrow('up');
      await renderOnce();
      assert.match(captureCharFrame(), /follow: off \(f\)/);

      // Appending while follow is off again does NOT jump or scroll to new step
      appendLine('live-step-3', 'LIVE_APPEND_MARKER_3', '2026-11-12T10:00:03Z');
      await new Promise((r) => setTimeout(r, 150));
      await renderOnce();
      // Selection and scroll stayed put: LIVE_APPEND_MARKER_3 is below the viewport
      const beforeReenable = captureCharFrame();
      assert.match(beforeReenable, /follow: off \(f\)/);
      assert.match(beforeReenable, /LIVE_APPEND_MARKER_2/);
      assert.doesNotMatch(beforeReenable, /LIVE_APPEND_MARKER_3/);

      // Re-enable follow by moving down to the last row (MARKER_1 -> MARKER_2 -> MARKER_3)
      await mockInput.pressArrow('down');
      await mockInput.pressArrow('down');
      await waitFor(async () => {
        await renderOnce();
        const f = captureCharFrame();
        return f.includes('[FOLLOW] (f)') && f.includes('LIVE_APPEND_MARKER_3');
      });

      // Manual upward mouse scroll in trace pane disables follow mode
      await mockMouse.scroll(50, 10, 'up');
      await renderOnce();
      assert.match(captureCharFrame(), /follow: off \(f\)/);

      // Re-enable follow via 'f'
      await mockInput.pressKey('f');
      await renderOnce();
      assert.match(captureCharFrame(), /\[FOLLOW\] \(f\)/);

      // Session list updates live when a new session starts
      const secondId = '22222222-2222-2222-2222-222222222222';
      const secondPath = path.join(claudeDir, `${secondId}.jsonl`);
      fs.writeFileSync(
        secondPath,
        JSON.stringify({
          type: 'user',
          uuid: 'u-second',
          cwd: '/work/proj-live',
          timestamp: '2026-11-12T10:00:05Z',
          message: { role: 'user', content: 'SECOND_LIVE_SESSION' },
        }) + '\n',
      );
      await waitFor(async () => {
        await renderOnce();
        const f = captureCharFrame();
        return f.includes('[2] ● live') && f.includes('SECOND');
      });

      // Session list updates live when sessions expire (live -> idle)
      now += 10 * 60_000;
      await waitFor(async () => {
        await renderOnce();
        return !captureCharFrame().includes('● live');
      });
    } finally {
      handle.dispose();
      await service.stop();
      renderer.destroy();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
