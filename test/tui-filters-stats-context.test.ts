import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PeriscopeService } from '../src/core/service.ts';
import { mountPeriscopeApp } from '../src/tui/app.ts';

test('headless UI: Show filter, Collapse-all toggle, Stats view, and Context view', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'periscope-fsc-'));
  try {
    const claudeDir = path.join(tmp, 'claude', 'proj-fsc');
    fs.mkdirSync(claudeDir, { recursive: true });
    const sessionId = '22222222-2222-2222-2222-222222222222';
    const filePath = path.join(claudeDir, `${sessionId}.jsonl`);

    const records = [
      {
        type: 'user',
        uuid: 'u1',
        cwd: '/work/proj-fsc',
        timestamp: '2026-06-01T12:00:00Z',
        message: { role: 'user', content: 'Inspect the build failure' },
      },
      {
        type: 'attachment',
        uuid: 'att-env',
        parentUuid: 'u1',
        timestamp: '2026-06-01T12:00:00.500Z',
        attachment: {
          type: 'environment',
          platform: 'linux',
          shell: 'bash',
        },
      },
      {
        type: 'attachment',
        uuid: 'att-date-1',
        parentUuid: 'u1',
        timestamp: '2026-06-01T12:00:00.600Z',
        attachment: { type: 'date', date: '2026-06-01' },
      },
      {
        type: 'attachment',
        uuid: 'att-date-2',
        parentUuid: 'u1',
        timestamp: '2026-06-01T12:00:00.700Z',
        attachment: { type: 'date', date: '2026-06-02' },
      },
      {
        type: 'system',
        uuid: 'sys-rem',
        parentUuid: 'u1',
        timestamp: '2026-06-01T12:00:00.800Z',
        content: '<system-reminder>Always verify with npm test</system-reminder>',
      },
      {
        type: 'assistant',
        uuid: 'a-think',
        parentUuid: 'u1',
        timestamp: '2026-06-01T12:00:01Z',
        message: {
          id: 'msg-1',
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'Checking why build failed' }],
          usage: { input_tokens: 1500, output_tokens: 200 },
        },
      },
      {
        type: 'assistant',
        uuid: 'a-text',
        parentUuid: 'u1',
        timestamp: '2026-06-01T12:00:02Z',
        message: {
          id: 'msg-2',
          role: 'assistant',
          content: [{ type: 'text', text: 'Here is my analysis of the failure' }],
          usage: { input_tokens: 500, output_tokens: 300 },
        },
      },
      {
        type: 'assistant',
        uuid: 'a-bash',
        parentUuid: 'u1',
        timestamp: '2026-06-01T12:00:03Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu-bash', name: 'Bash', input: { command: 'npm run build' } }],
        },
      },
      {
        type: 'user',
        uuid: 'u-bash-err',
        parentUuid: 'a-bash',
        timestamp: '2026-06-01T12:00:05Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu-bash', is_error: true, content: 'Build failed: exit 1' }],
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

    const { createTestRenderer } = await import('@opentui/core/testing');
    const { renderer, mockInput, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 140,
      height: 36,
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

      // Open session
      await mockInput.pressArrow('down');
      await mockInput.pressEnter();
      await renderOnce();
      await new Promise((r) => setTimeout(r, 30));
      await renderOnce();

      const allFrame = captureCharFrame();
      assert.match(allFrame, /Show: all/);
      assert.match(allFrame, /Inspect the build failure/);
      assert.match(allFrame, /Checking why build failed/);
      assert.match(allFrame, /Here is my analysis/);
      assert.match(allFrame, /Bash/);
      // Injected context must not clutter the trace tree
      assert.doesNotMatch(allFrame, /environment/i);
      assert.doesNotMatch(allFrame, /Always verify with npm test/);

      // 1. Show filter: 'v' -> errors
      await mockInput.pressKey('v');
      await renderOnce();
      const errFrame = captureCharFrame();
      assert.match(errFrame, /Show: errors/);
      assert.match(errFrame, /Bash/);
      assert.doesNotMatch(errFrame, /Checking why build failed/);
      assert.doesNotMatch(errFrame, /Here is my analysis/);

      // 'v' -> reasoning
      await mockInput.pressKey('v');
      await renderOnce();
      const reasonFrame = captureCharFrame();
      assert.match(reasonFrame, /Show: reasoning/);
      assert.match(reasonFrame, /Checking why build failed/);
      assert.doesNotMatch(reasonFrame, /Here is my analysis/);

      // 'v' -> model text
      await mockInput.pressKey('v');
      await renderOnce();
      const textFrame = captureCharFrame();
      assert.match(textFrame, /Show: model text/);
      assert.match(textFrame, /Here is my analysis/);
      assert.doesNotMatch(textFrame, /Checking why build failed/);

      // 'v' -> all
      await mockInput.pressKey('v');
      await renderOnce();
      const backAllFrame = captureCharFrame();
      assert.match(backAllFrame, /Show: all/);
      assert.match(backAllFrame, /Checking why build failed/);
      assert.match(backAllFrame, /Here is my analysis/);

      // 2. Collapse-all toggle: 'z'
      await mockInput.pressKey('z');
      await renderOnce();
      const collapsedFrame = captureCharFrame();
      assert.match(collapsedFrame, /Inspect the build failure/);
      assert.doesNotMatch(collapsedFrame, /Checking why build failed/);
      assert.doesNotMatch(collapsedFrame, /Here is my analysis/);

      // 'z' again -> expand all
      await mockInput.pressKey('z');
      await renderOnce();
      const expandedFrame = captureCharFrame();
      assert.match(expandedFrame, /Checking why build failed/);
      assert.match(expandedFrame, /Here is my analysis/);

      // 3. Stats view: 's'
      await mockInput.pressKey('s');
      await renderOnce();
      const statsFrame = captureCharFrame();
      assert.match(statsFrame, /Session Stats/);
      assert.match(statsFrame, /5\.0s/); // 12:00:00Z -> 12:00:05Z = 5.0s
      assert.match(statsFrame, /Turns:\s*1/);
      assert.match(statsFrame, /Tool calls:\s*1/);
      assert.match(statsFrame, /Errors:\s*1/);
      assert.match(statsFrame, /Tokens in:\s*2\.0k/);
      assert.match(statsFrame, /Tokens out:\s*500/);
      assert.match(statsFrame, /Bash/);

      // 4. Context view: 'x'
      await mockInput.pressKey('x');
      await renderOnce();
      await new Promise((r) => setTimeout(r, 30));
      await renderOnce();
      const ctxFrame = captureCharFrame();
      assert.match(ctxFrame, /Injected Context/);
      assert.match(ctxFrame, /Environment/);
      assert.match(ctxFrame, /linux/);
      assert.match(ctxFrame, /Date/);
      assert.match(ctxFrame, /×2/);
      assert.match(ctxFrame, /2026-06-02/);
      assert.match(ctxFrame, /System reminder/);
      assert.match(ctxFrame, /Always verify with npm test/);

      // 'x' again -> back to step detail
      await mockInput.pressKey('x');
      await renderOnce();
      const detailFrame = captureCharFrame();
      assert.doesNotMatch(detailFrame, /Injected Context/);
      assert.match(detailFrame, /User prompt|Inspect the build failure/);
    } finally {
      handle.dispose();
      renderer.destroy();
      await service.stop();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
