import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PeriscopeService } from '../src/core/service.ts';
import { mountPeriscopeApp } from '../src/tui/app.ts';

// 1x1 transparent PNG
const PNG_1X1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('headless UI three-pane: trace tree folding, subagents, expand/collapse, detail markdown/diff/json/ansi/raw/images', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'periscope-3pane-'));
  try {
    const claudeDir = path.join(tmp, 'claude', 'proj-a');
    fs.mkdirSync(claudeDir, { recursive: true });
    const sessionId = '11111111-1111-1111-1111-111111111111';
    const filePath = path.join(claudeDir, `${sessionId}.jsonl`);

    const longAnsi = Array.from({ length: 50 }, (_, i) => `\x1b[32mline ${i + 1}\x1b[0m`).join('\n');
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        cwd: '/work/proj-a',
        timestamp: '2026-06-01T12:00:00Z',
        message: { role: 'user', content: 'Please edit app.ts and run tests' },
      },
      // Empty thinking noise row (must be hidden)
      {
        type: 'assistant',
        uuid: 'a-noise',
        parentUuid: 'u1',
        timestamp: '2026-06-01T12:00:01Z',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: '   ' }] },
      },
      // Markdown assistant response with table
      {
        type: 'assistant',
        uuid: 'a-md',
        parentUuid: 'u1',
        timestamp: '2026-06-01T12:00:02Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: '# Summary\n\n| File | Status |\n|---|---|\n| app.ts | ok |\n\n```ts\nconst x = 1;\n```',
            },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
      // Edit tool call + folded result
      {
        type: 'assistant',
        uuid: 'a-edit',
        parentUuid: 'u1',
        timestamp: '2026-06-01T12:00:03Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu-edit',
              name: 'Edit',
              input: {
                file_path: 'src/app.ts',
                old_string: 'const val = 1;',
                new_string: 'const val = 2;',
              },
            },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u-edit-res',
        parentUuid: 'a-edit',
        timestamp: '2026-06-01T12:00:04Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu-edit', content: 'Updated src/app.ts' }],
        },
      },
      // Bash tool call + long ANSI output + embedded image
      {
        type: 'assistant',
        uuid: 'a-bash',
        parentUuid: 'u1',
        timestamp: '2026-06-01T12:00:05Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu-bash',
              name: 'Bash',
              input: { command: 'npm test', timeout: 5000 },
            },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u-bash-res',
        parentUuid: 'a-bash',
        timestamp: '2026-06-01T12:00:06Z',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu-bash', content: longAnsi },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1X1_B64 } },
          ],
        },
      },
      // Agent tool call with nested subagent sidechain
      {
        type: 'assistant',
        uuid: 'a-agent',
        parentUuid: 'u1',
        timestamp: '2026-06-01T12:00:07Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu-agent',
              name: 'Agent',
              input: { prompt: 'Check logs', description: 'Subagent check' },
            },
          ],
        },
      },
    ];
    fs.writeFileSync(filePath, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const subDir = path.join(claudeDir, sessionId, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'agent-1.meta.json'), JSON.stringify({ toolUseId: 'tu-agent' }));
    fs.writeFileSync(
      path.join(subDir, 'agent-1.jsonl'),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a-sub',
        isSidechain: true,
        timestamp: '2026-06-01T12:00:08Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Subagent found no errors' }] },
      }) + '\n',
    );

    const service = new PeriscopeService({
      dbPath: ':memory:',
      roots: [{ agent: 'claude', dir: path.join(tmp, 'claude') }],
      agyMetadata: path.join(tmp, 'nonexistent.json'),
      claudeSessionsDir: path.join(tmp, 'no-sessions'),
      sandboxEnabled: false,
      debounceMs: 20,
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

      // Open the first session (down from group header -> Enter)
      await mockInput.pressArrow('down');
      await mockInput.pressEnter();
      await renderOnce();
      // Allow async getEvents to resolve and re-render
      await new Promise((r) => setTimeout(r, 30));
      await renderOnce();

      const frame1 = captureCharFrame();
      // Three panes visible: session list, trace tree, detail pane
      assert.match(frame1, /Please edit app\.ts/);
      assert.match(frame1, /Edit/);
      assert.match(frame1, /Bash/);
      assert.match(frame1, /Subagent check/);
      assert.match(frame1, /Subagent found no errors/);
      // Noise & folded tool_result rows must not appear as separate tree rows
      assert.doesNotMatch(frame1, /Tool result/);

      // Move down to Markdown step (a-md)
      await mockInput.pressArrow('down');
      await renderOnce();
      const mdFrame = captureCharFrame();
      assert.match(mdFrame, /Summary/);
      assert.match(mdFrame, /const x = 1;/);

      // Toggle Raw mode with 'r'
      await mockInput.pressKey('r');
      await renderOnce();
      const rawFrame = captureCharFrame();
      assert.match(rawFrame, /# Summary/);
      assert.match(rawFrame, /\| File \| Status \|/);
      // Toggle back to rendered
      await mockInput.pressKey('r');
      await renderOnce();

      // Move down to Edit tool call (a-edit) -> diff + folded output
      await mockInput.pressArrow('down');
      await renderOnce();
      const editFrame = captureCharFrame();
      assert.match(editFrame, /const val = 1/);
      assert.match(editFrame, /const val = 2/);
      assert.match(editFrame, /Updated src\/app\.ts/);

      // Move down to Bash tool call (a-bash) -> collapsed 40-line ANSI output + image placeholder
      await mockInput.pressArrow('down');
      await new Promise((r) => setTimeout(r, 30));
      await renderOnce();
      const bashTopFrame = captureCharFrame();
      assert.match(bashTopFrame, /npm test/);
      assert.doesNotMatch(bashTopFrame, /line 50/);

      // Focus detail pane with Tab and scroll down to see line 40, [Show all 50 lines], and [Image: ...]
      await mockInput.pressTab();
      for (let i = 0; i < 12; i++) await mockInput.pressKey('j');
      await renderOnce();
      const bashBottomFrame = captureCharFrame();
      assert.match(bashBottomFrame, /line 40/);
      assert.match(bashBottomFrame, /Show all 50 lines/);
      assert.match(bashBottomFrame, /\[Image:/);

      // Expand long output with 'e' and scroll down to see line 50 & Collapse
      await mockInput.pressKey('e');
      for (let i = 0; i < 8; i++) await mockInput.pressKey('j');
      await renderOnce();
      const bashExpanded = captureCharFrame();
      assert.match(bashExpanded, /line 50/);
      assert.match(bashExpanded, /Collapse/);

      // Return focus to trace pane with 'h'
      await mockInput.pressKey('h');
      await renderOnce();

      // Move down to Agent tool call (a-agent), collapse with left arrow, then expand with right arrow
      await mockInput.pressArrow('down');
      await renderOnce();
      await mockInput.pressArrow('left');
      await renderOnce();
      const collapsedTree = captureCharFrame();
      assert.doesNotMatch(collapsedTree, /Subagent found no errors/);

      await mockInput.pressArrow('right');
      await renderOnce();
      const expandedTree = captureCharFrame();
      assert.match(expandedTree, /Subagent found no errors/);
    } finally {
      handle.dispose();
      await service.stop();
      renderer.destroy();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('headless UI three-pane: image renders inline when terminal supports kitty_graphics', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'periscope-img-'));
  try {
    const claudeDir = path.join(tmp, 'claude', 'proj-img');
    fs.mkdirSync(claudeDir, { recursive: true });
    const filePath = path.join(claudeDir, '22222222-2222-2222-2222-222222222222.jsonl');
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        type: 'user',
        uuid: 'u-img',
        cwd: '/work/proj-img',
        timestamp: '2026-06-01T12:00:00Z',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'Look at this screenshot' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1X1_B64 } },
          ],
        },
      }) + '\n',
    );

    const service = new PeriscopeService({
      dbPath: ':memory:',
      roots: [{ agent: 'claude', dir: path.join(tmp, 'claude') }],
      agyMetadata: path.join(tmp, 'nonexistent.json'),
      claudeSessionsDir: path.join(tmp, 'no-sessions'),
      sandboxEnabled: false,
      debounceMs: 20,
    });

    const { createTestRenderer } = await import('@opentui/core/testing');
    const { renderer, mockInput, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 120,
      height: 30,
    });
    // Simulate terminal reporting kitty_graphics support
    (renderer as unknown as { _capabilities: Record<string, unknown> })._capabilities = {
      ...(renderer.capabilities ?? {}),
      kitty_graphics: true,
    };

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

      await mockInput.pressArrow('down');
      await mockInput.pressEnter();
      await new Promise((r) => setTimeout(r, 40));
      await renderOnce();

      const frame = captureCharFrame();
      assert.match(frame, /Look at this screenshot/);
      assert.doesNotMatch(frame, /\[Image:/);
    } finally {
      handle.dispose();
      await service.stop();
      renderer.destroy();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('headless UI three-pane: 5,000+ step session selection and append stay fast (OpenTUI render stats)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'periscope-perf-'));
  try {
    const claudeDir = path.join(tmp, 'claude', 'proj-perf');
    fs.mkdirSync(claudeDir, { recursive: true });
    const filePath = path.join(claudeDir, '33333333-3333-3333-3333-333333333333.jsonl');
    const lines: string[] = [];
    for (let i = 0; i < 5200; i++) {
      lines.push(
        JSON.stringify({
          type: i % 2 === 0 ? 'user' : 'assistant',
          uuid: `ev-${i}`,
          parentUuid: i % 2 === 1 ? `ev-${i - 1}` : undefined,
          cwd: '/work/proj-perf',
          timestamp: new Date(1780000000000 + i * 1000).toISOString(),
          message: {
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: i % 2 === 0 ? `User step ${i}` : [{ type: 'text', text: `Assistant step ${i}` }],
          },
        }),
      );
    }
    fs.writeFileSync(filePath, lines.join('\n') + '\n');

    const service = new PeriscopeService({
      dbPath: ':memory:',
      roots: [{ agent: 'claude', dir: path.join(tmp, 'claude') }],
      agyMetadata: path.join(tmp, 'nonexistent.json'),
      claudeSessionsDir: path.join(tmp, 'no-sessions'),
      sandboxEnabled: false,
      debounceMs: 20,
    });

    const { createTestRenderer } = await import('@opentui/core/testing');
    const { renderer, mockInput, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 120,
      height: 30,
      gatherStats: true,
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

      await mockInput.pressArrow('down');
      await mockInput.pressEnter();
      await new Promise((r) => setTimeout(r, 60));
      await renderOnce();

      assert.match(captureCharFrame(), /User step 0/);

      // Measure 10 selection movements
      renderer.setGatherStats(true);
      renderer.resetStats();
      for (let i = 0; i < 10; i++) {
        await mockInput.pressArrow('down');
        await renderOnce();
      }
      const moveStats = renderer.getStats();
      assert.ok(moveStats.frameCount >= 10);
      assert.ok(
        moveStats.averageFrameTime < 50 && moveStats.maxFrameTime < 250,
        `expected fast selection frame (<50ms avg, <250ms max), got avg=${moveStats.averageFrameTime}ms max=${moveStats.maxFrameTime}ms`,
      );

      // Enable follow mode, append a new step, and wait for it to be ingested & rendered
      await mockInput.pressKey('f');
      await renderOnce();
      renderer.resetStats();
      fs.appendFileSync(
        filePath,
        JSON.stringify({
          type: 'user',
          uuid: 'ev-5200',
          cwd: '/work/proj-perf',
          timestamp: new Date(1780000000000 + 5200 * 1000).toISOString(),
          message: { role: 'user', content: 'Appended step 5200' },
        }) + '\n',
      );
      const deadline = Date.now() + 3000;
      let renderedAppended = false;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
        await renderOnce();
        if (captureCharFrame().includes('Appended step 5200')) {
          renderedAppended = true;
          break;
        }
      }
      assert.ok(renderedAppended, 'expected appended step 5200 to be ingested and rendered in trace tree');
      const appendStats = renderer.getStats();
      assert.ok(appendStats.frameCount >= 1);
      assert.ok(
        appendStats.averageFrameTime < 50,
        `expected fast append frame (<50ms avg), got ${appendStats.averageFrameTime}ms`,
      );
    } finally {
      handle.dispose();
      await service.stop();
      renderer.destroy();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
