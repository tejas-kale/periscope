import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PeriscopeService } from '../src/core/service.ts';
import { mountPeriscopeApp } from '../src/tui/app.ts';

function hasHighlightedSpan(
  spansResult: { lines: Array<{ spans: Array<{ text: string; bg?: unknown; fg?: unknown }> }> },
  substring: string,
  expectedBgHex: string,
): boolean {
  const needle = substring.toLowerCase();
  const target = expectedBgHex.toLowerCase();
  for (const line of spansResult.lines) {
    for (const span of line.spans) {
      if (!span.text.toLowerCase().includes(needle)) continue;
      const bg = span.bg as { toHex?: () => string; r?: number; g?: number; b?: number } | string | undefined;
      if (!bg) continue;
      if (typeof bg === 'string' && bg.toLowerCase() === target) return true;
      if (typeof bg === 'object') {
        if (typeof bg.toHex === 'function' && bg.toHex().toLowerCase().startsWith(target)) return true;
        if (bg.r != null && bg.g != null && bg.b != null) {
          const toByte = (v: number) => (v <= 1 && (bg.r! <= 1 && bg.g! <= 1 && bg.b! <= 1) ? Math.round(v * 255) : Math.round(v));
          const hex = `#${[toByte(bg.r), toByte(bg.g), toByte(bg.b)].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
          if (hex.toLowerCase() === target) return true;
        }
      }
    }
  }
  return false;
}

test('headless UI find: / opens find bar, expands collapsed ancestors, highlights tree & detail, n/N step, Escape clears', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'periscope-find-'));
  try {
    const claudeDir = path.join(tmp, 'claude', 'proj-a');
    fs.mkdirSync(claudeDir, { recursive: true });
    const sessionId = '22222222-2222-2222-2222-222222222222';
    const filePath = path.join(claudeDir, `${sessionId}.jsonl`);

    const records = [
      {
        type: 'user',
        uuid: 'u1',
        cwd: '/work/proj-a',
        timestamp: '2026-06-01T12:00:00Z',
        message: { role: 'user', content: 'Investigate build failure' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        timestamp: '2026-06-01T12:00:01Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Found the needle in config.ts' }] },
      },
      {
        type: 'assistant',
        uuid: 'a-bash',
        parentUuid: 'u1',
        timestamp: '2026-06-01T12:00:02Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu-bash', name: 'Bash', input: { command: 'npm run build' } }],
        },
      },
      {
        type: 'user',
        uuid: 'u-bash-res',
        parentUuid: 'a-bash',
        timestamp: '2026-06-01T12:00:03Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu-bash', content: 'Error: needle missing in dist' }],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        timestamp: '2026-06-01T12:01:00Z',
        message: { role: 'user', content: 'Fix it' },
      },
      {
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'u2',
        timestamp: '2026-06-01T12:01:01Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Replaced needle and verified' }] },
      },
    ];
    fs.writeFileSync(filePath, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);

    const service = new PeriscopeService({
      dbPath: ':memory:',
      roots: [{ dir: path.join(tmp, 'claude'), agent: 'claude' }],
      agyMetadata: path.join(tmp, 'agy-meta'),
      claudeSessionsDir: path.join(tmp, 'claude-sessions'),
      sandboxEnabled: false,
    });

    const { createTestRenderer } = await import('@opentui/core/testing');
    const { renderer, mockInput, renderOnce, captureCharFrame, captureSpans } = await createTestRenderer({
      width: 120,
      height: 32,
    });

    await service.start();
    const handle = mountPeriscopeApp(renderer, {
      service,
      theme: 'dark',
      onQuit: () => {},
    });

    try {
      await handle.refresh();
      await renderOnce();

      // Open session
      await mockInput.pressArrow('down');
      await mockInput.pressEnter();
      await renderOnce();
      await new Promise((r) => setTimeout(r, 30));
      await renderOnce();

      // Collapse both turns so children a1, Bash, a2 are hidden
      await mockInput.pressKey(' '); // collapse u1
      await mockInput.pressArrow('down'); // move to u2
      await mockInput.pressKey(' '); // collapse u2
      await renderOnce();
      const collapsedFrame = captureCharFrame();
      assert.doesNotMatch(collapsedFrame, /Found the needle/);
      assert.doesNotMatch(collapsedFrame, /Replaced needle/);

      // Press '/' to open find bar
      await mockInput.pressKey('/');
      await renderOnce();
      assert.match(captureCharFrame(), /Find:/);

      // Type query 'needle'
      await mockInput.typeText('needle');
      await renderOnce();

      const afterQueryFrame = captureCharFrame();
      // Find bar shows 1/3
      assert.match(afterQueryFrame, /1\/3/);
      // Collapsed ancestors u1 and u2 expanded automatically
      assert.match(afterQueryFrame, /Found the needle/);
      assert.match(afterQueryFrame, /npm run build/);
      assert.match(afterQueryFrame, /Replaced needle/);

      // Detail pane shows first match (a1) with 'needle' highlighted
      const spans1 = captureSpans();
      assert.equal(
        hasHighlightedSpan(spans1, 'needle', '#facc15'),
        true,
        'Expected "needle" to be highlighted with #facc15',
      );

      // Non-selected matching rows in trace tree have matchRowBg (#422006)
      assert.equal(
        hasHighlightedSpan(spans1, 'npm run build', '#422006'),
        true,
        'Expected non-selected matching Bash trace row to have matchRowBg #422006',
      );
      assert.equal(
        hasHighlightedSpan(spans1, 'Replaced ', '#422006'),
        true,
        'Expected non-selected matching a2 trace row to have matchRowBg #422006',
      );

      // Press Enter to finish typing, then 'n' to step to 2/3 (Bash with folded tool_result)
      await mockInput.pressEnter();
      await mockInput.pressKey('n');
      await renderOnce();
      const frame2 = captureCharFrame();
      assert.match(frame2, /2\/3/);
      assert.match(frame2, /Error: needle missing in dist/);
      assert.equal(hasHighlightedSpan(captureSpans(), 'needle', '#facc15'), true);

      // Press 'n' again -> 3/3 (a2)
      await mockInput.pressKey('n');
      await renderOnce();
      const frame3 = captureCharFrame();
      assert.match(frame3, /3\/3/);
      assert.match(frame3, /Replaced needle and verified/);

      // Press 'N' (Shift+n) -> back to 2/3
      await mockInput.pressKey('n', { shift: true });
      await renderOnce();
      assert.match(captureCharFrame(), /2\/3/);

      // Press Escape -> closes find bar and clears all match highlights
      mockInput.pressEscape();
      await new Promise((r) => setTimeout(r, 60));
      await renderOnce();
      const clearedFrame = captureCharFrame();
      assert.doesNotMatch(clearedFrame, /Find:/);
      assert.doesNotMatch(clearedFrame, /2\/3/);
      const clearedSpans = captureSpans();
      assert.equal(
        hasHighlightedSpan(clearedSpans, 'needle', '#facc15'),
        false,
        'Expected all match highlights to be cleared after Escape',
      );
      assert.equal(
        hasHighlightedSpan(clearedSpans, 'npm run build', '#422006'),
        false,
        'Expected trace row match highlights to be cleared after Escape',
      );

      // Re-open find, type unmatched query -> 0/0, backspace restores, Escape while typing closes
      await mockInput.pressKey('/');
      await mockInput.typeText('needlez');
      await renderOnce();
      assert.match(captureCharFrame(), /0\/0/);
      await mockInput.pressBackspace();
      await renderOnce();
      assert.match(captureCharFrame(), /1\/3/);
      mockInput.pressEscape();
      await new Promise((r) => setTimeout(r, 60));
      await renderOnce();
      assert.doesNotMatch(captureCharFrame(), /Find:/);
    } finally {
      handle.dispose();
      await service.stop();
      renderer.destroy();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
