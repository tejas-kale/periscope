import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PeriscopeService } from '../src/core/service.ts';
import { createOpenTuiAdapter } from '../src/tui/adapter.ts';
import { mountPeriscopeApp } from '../src/tui/app.ts';
import { OSC52_MAX_BYTES } from '../src/view-model/clipboard.ts';

function extractTempPathFromFrame(frame: string): string | null {
  const m = frame.match(/(\S*periscope-copy-[^\s]+)/);
  return m ? m[1]! : null;
}

test('headless UI clipboard: copies step text, code block, diff, session ID, and source path via OSC 52 when supported', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'periscope-tui-clip-'));
  try {
    const claudeDir = path.join(tmp, 'claude', 'proj-clip');
    fs.mkdirSync(claudeDir, { recursive: true });
    const sessionId = '44444444-4444-4444-4444-444444444444';
    const filePath = path.join(claudeDir, `${sessionId}.jsonl`);

    const records = [
      {
        type: 'user',
        uuid: 'u1',
        cwd: '/work/proj-clip',
        timestamp: '2026-06-01T12:00:00Z',
        message: { role: 'user', content: 'Show code and edit file' },
      },
      {
        type: 'assistant',
        uuid: 'a-md',
        parentUuid: 'u1',
        timestamp: '2026-06-01T12:00:01Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '# Answer\n\n```ts\nconst answer = 42;\n```' }],
        },
      },
      {
        type: 'assistant',
        uuid: 'a-edit',
        parentUuid: 'u1',
        timestamp: '2026-06-01T12:00:02Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu-edit',
              name: 'Edit',
              input: {
                file_path: 'src/val.ts',
                old_string: 'const v = 1;',
                new_string: 'const v = 2;',
              },
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

    const { createTestRenderer } = await import('@opentui/core/testing');
    const { renderer, mockInput, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 140,
      height: 30,
    });
    (renderer as unknown as { _capabilities: Record<string, unknown> })._capabilities = {
      ...(renderer.capabilities ?? {}),
      osc52: true,
    };

    const baseAdapter = createOpenTuiAdapter();
    const oscCalls: string[] = [];
    const adapter = {
      ...baseAdapter,
      copyToClipboard(_r: typeof renderer, text: string): boolean {
        oscCalls.push(text);
        return true;
      },
    };

    const handle = mountPeriscopeApp(renderer, {
      service,
      adapter,
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
      await new Promise((r) => setTimeout(r, 30));
      await renderOnce();

      // Copy session ID ('i') and source path ('p')
      await mockInput.pressKey('i');
      await renderOnce();
      assert.equal(oscCalls.at(-1), `n:${sessionId}`);
      assert.match(captureCharFrame(), /Copied session ID to clipboard/);

      await mockInput.pressKey('p');
      await renderOnce();
      assert.equal(oscCalls.at(-1), filePath);
      assert.match(captureCharFrame(), /Copied source path to clipboard/);

      // Move down to Markdown step
      await mockInput.pressArrow('down');
      await renderOnce();

      await mockInput.pressKey('y');
      await renderOnce();
      assert.match(oscCalls.at(-1) ?? '', /# Answer/);
      assert.match(captureCharFrame(), /Copied step text to clipboard/);

      await mockInput.pressKey('c');
      await renderOnce();
      assert.equal(oscCalls.at(-1), 'const answer = 42;');
      assert.match(captureCharFrame(), /Copied code block to clipboard/);

      // No diff on markdown step
      const countBeforeNoDiff = oscCalls.length;
      await mockInput.pressKey('d');
      await renderOnce();
      assert.equal(oscCalls.length, countBeforeNoDiff);
      assert.match(captureCharFrame(), /No diff in selected step/);

      // Move down to Edit step and copy diff ('d')
      await mockInput.pressArrow('down');
      await renderOnce();
      await mockInput.pressKey('d');
      await renderOnce();
      assert.match(oscCalls.at(-1) ?? '', /-const v = 1;/);
      assert.match(oscCalls.at(-1) ?? '', /\+const v = 2;/);
      assert.match(captureCharFrame(), /Copied diff to clipboard/);
    } finally {
      handle.dispose();
      await service.stop();
      renderer.destroy();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('headless UI clipboard: falls back to temp file in os.tmpdir() when OSC 52 unsupported or over size cap', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'periscope-tui-clip-fb-'));
  const createdTempFiles: string[] = [];
  try {
    const claudeDir = path.join(tmp, 'claude', 'proj-fb');
    fs.mkdirSync(claudeDir, { recursive: true });
    const sessionId = '55555555-5555-5555-5555-555555555555';
    const filePath = path.join(claudeDir, `${sessionId}.jsonl`);
    const hugeText = 'A'.repeat(OSC52_MAX_BYTES + 256);

    const records = [
      {
        type: 'user',
        uuid: 'u1',
        cwd: '/work/proj-fb',
        timestamp: '2026-06-01T12:00:00Z',
        message: { role: 'user', content: 'Short prompt' },
      },
      {
        type: 'assistant',
        uuid: 'a-huge',
        parentUuid: 'u1',
        timestamp: '2026-06-01T12:00:01Z',
        message: { role: 'assistant', content: [{ type: 'text', text: hugeText }] },
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

    // Case 1: OSC 52 unsupported
    {
      const { renderer, mockInput, renderOnce, captureCharFrame } = await createTestRenderer({
        width: 160,
        height: 30,
      });
      (renderer as unknown as { _capabilities: Record<string, unknown> })._capabilities = {
        ...(renderer.capabilities ?? {}),
        osc52: false,
      };
      const baseAdapter = createOpenTuiAdapter();
      const oscCalls: string[] = [];
      const adapter = {
        ...baseAdapter,
        copyToClipboard(r: typeof renderer, text: string): boolean {
          oscCalls.push(text);
          return true;
        },
      };

      const handle = mountPeriscopeApp(renderer, {
        service,
        adapter,
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
        await new Promise((r) => setTimeout(r, 30));
        await renderOnce();

        await mockInput.pressKey('y');
        await renderOnce();

        assert.equal(oscCalls.length, 0);
        const frame = captureCharFrame();
        assert.match(frame, /OSC 52 unsupported/);
        const writtenPath = extractTempPathFromFrame(frame);
        assert.ok(writtenPath, `expected temp file path in status line, got:\n${frame}`);
        createdTempFiles.push(writtenPath);
        assert.ok(writtenPath.startsWith(os.tmpdir()));
        assert.equal(fs.readFileSync(writtenPath, 'utf8'), 'Short prompt');
      } finally {
        handle.dispose();
        renderer.destroy();
      }
    }

    // Case 2: OSC 52 supported, but text exceeds size cap
    {
      const { renderer, mockInput, renderOnce, captureCharFrame } = await createTestRenderer({
        width: 160,
        height: 30,
      });
      (renderer as unknown as { _capabilities: Record<string, unknown> })._capabilities = {
        ...(renderer.capabilities ?? {}),
        osc52: true,
      };
      const baseAdapter = createOpenTuiAdapter();
      const oscCalls: string[] = [];
      const adapter = {
        ...baseAdapter,
        copyToClipboard(r: typeof renderer, text: string): boolean {
          oscCalls.push(text);
          return true;
        },
      };

      const handle = mountPeriscopeApp(renderer, {
        service,
        adapter,
        theme: 'dark',
        initiallyIndexing: false,
        onQuit: () => {},
      });

      try {
        await handle.refresh();
        await renderOnce();

        await mockInput.pressArrow('down');
        await mockInput.pressEnter();
        await new Promise((r) => setTimeout(r, 30));
        await renderOnce();

        // Move down to huge assistant step
        await mockInput.pressArrow('down');
        await renderOnce();

        await mockInput.pressKey('y');
        await renderOnce();

        assert.equal(oscCalls.length, 0);
        const frame = captureCharFrame();
        assert.match(frame, /Too large for OSC 52/);
        const writtenPath = extractTempPathFromFrame(frame);
        assert.ok(writtenPath, `expected temp file path in status line, got:\n${frame}`);
        createdTempFiles.push(writtenPath);
        assert.equal(fs.readFileSync(writtenPath, 'utf8'), hugeText);
      } finally {
        handle.dispose();
        renderer.destroy();
      }
    }

    await service.stop();
  } finally {
    for (const f of createdTempFiles) {
      fs.rmSync(f, { force: true });
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
