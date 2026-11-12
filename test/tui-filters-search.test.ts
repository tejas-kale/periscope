import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PeriscopeService } from '../src/core/service.ts';
import { mountPeriscopeApp } from '../src/tui/app.ts';

async function flushUi(renderOnce: () => Promise<void>, ticks = 3) {
  for (let i = 0; i < ticks; i++) {
    await new Promise((r) => setTimeout(r, 15));
    await renderOnce();
  }
}

async function typeText(mockInput: { pressKey: (k: string) => void | Promise<void> }, text: string) {
  for (const ch of text) {
    await mockInput.pressKey(ch);
  }
}

test('headless UI: filters sessions by agent, host, status, and date range via keyboard', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'periscope-filter-ui-'));
  const now = Date.parse('2026-06-15T12:00:00Z');

  try {
    const claudeDir = path.join(tmp, 'claude', 'proj-a');
    const codexDir = path.join(tmp, 'codex', '2026', '06', '05');
    const agyDir = path.join(tmp, 'antigravity');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.mkdirSync(codexDir, { recursive: true });
    fs.mkdirSync(agyDir, { recursive: true });

    // 1. Claude Code Mac live session (now - 5s)
    const claudeFile = path.join(claudeDir, '11111111-1111-1111-1111-111111111111.jsonl');
    const claudeTs = new Date(now - 5_000).toISOString();
    fs.writeFileSync(
      claudeFile,
      JSON.stringify({
        type: 'user',
        cwd: '/work/proj-a',
        timestamp: claudeTs,
        message: { role: 'user', content: 'Claude live task' },
      }) + '\n',
    );
    fs.utimesSync(claudeFile, new Date(now - 5_000), new Date(now - 5_000));

    // 2. Codex Mac idle session (10 days ago: 2026-06-05)
    const codexFile = path.join(codexDir, 'rollout-2026-06-05T12-00-00-22222222-2222-2222-2222-222222222222.jsonl');
    const codexTsMs = now - 10 * 86_400_000;
    const codexTs = new Date(codexTsMs).toISOString();
    fs.writeFileSync(
      codexFile,
      [
        JSON.stringify({
          type: 'session_meta',
          timestamp: codexTs,
          payload: { id: '22222222-2222-2222-2222-222222222222', cwd: '/work/proj-b' },
        }),
        JSON.stringify({
          type: 'response_item',
          timestamp: codexTs,
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Codex ten days ago' }],
          },
        }),
      ].join('\n') + '\n',
    );
    fs.utimesSync(codexFile, new Date(codexTsMs), new Date(codexTsMs));

    // 3. Antigravity Mac idle session (40 days ago: 2026-05-06)
    const agyFile = path.join(agyDir, '33333333-3333-3333-3333-333333333333', '.system_generated', 'logs', 'transcript_full.jsonl');
    fs.mkdirSync(path.dirname(agyFile), { recursive: true });
    const agyTsMs = now - 40 * 86_400_000;
    fs.writeFileSync(
      agyFile,
      JSON.stringify({
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: new Date(agyTsMs).toISOString(),
        content: 'Antigravity forty days ago',
      }) + '\n',
    );
    fs.utimesSync(agyFile, new Date(agyTsMs), new Date(agyTsMs));

    // 4. Sandbox Claude session via fake podman exec
    const volRoot = path.join(tmp, 'vol');
    const sbxFile = path.join(volRoot, 'v/claude-home/projects/sb-proj/44444444-4444-4444-4444-444444444444.jsonl');
    fs.mkdirSync(path.dirname(sbxFile), { recursive: true });
    fs.writeFileSync(
      sbxFile,
      JSON.stringify({
        type: 'user',
        cwd: '/work/sb-proj',
        timestamp: new Date(now - 120_000).toISOString(),
        message: { role: 'user', content: 'Sandbox remote task' },
      }) + '\n',
    );
    fs.utimesSync(sbxFile, new Date(now - 120_000), new Date(now - 120_000));

    const service = new PeriscopeService({
      dbPath: ':memory:',
      roots: [
        { agent: 'claude', dir: path.join(tmp, 'claude') },
        { agent: 'codex', dir: path.join(tmp, 'codex') },
        { agent: 'antigravity', dir: agyDir },
      ],
      agyMetadata: path.join(tmp, 'nonexistent.json'),
      claudeSessionsDir: path.join(tmp, 'no-sessions'),
      sandboxEnabled: true,
      clock: () => now,
      podman: '/usr/bin/podman',
      pollMs: 5000,
      debounceMs: 5,
      exec: async (_cmd, args, input) => {
        if (args[0] === 'volume') return { code: 0, stdout: 'claude-home\n', stderr: '' };
        if (args[0] === 'ps') return { code: 0, stdout: '[]', stderr: '' };
        const script = args[args.indexOf('-e') + 1]!;
        const req = input!.replaceAll('"/v/', JSON.stringify(volRoot + '/v/').slice(0, -1));
        const r = spawnSync(process.execPath, ['-e', script], { input: req, encoding: 'utf8' });
        return { code: r.status ?? 1, stdout: r.stdout.replaceAll(volRoot + '/v/', '/v/'), stderr: r.stderr };
      },
    });

    const { createTestRenderer } = await import('@opentui/core/testing');
    const { renderer, mockInput, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 120,
      height: 30,
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
      await handle.refresh();
      await flushUi(renderOnce);

      const allFrame = captureCharFrame();
      assert.match(allFrame, /Claude live task/);
      assert.match(allFrame, /Codex ten days ago/);
      assert.match(allFrame, /▸ \(no project\) \(1\)/);
      assert.match(allFrame, /Sandbox remote task/);

      // Agent filter: 'a' -> Claude Code
      await mockInput.pressKey('a');
      await flushUi(renderOnce);
      let frame = captureCharFrame();
      assert.match(frame, /Agent:Claude Code/);
      assert.match(frame, /Claude live task/);
      assert.doesNotMatch(frame, /Codex ten days ago/);
      assert.doesNotMatch(frame, /Antigravity forty days ago/);

      // 'a' -> Codex
      await mockInput.pressKey('a');
      await flushUi(renderOnce);
      frame = captureCharFrame();
      assert.match(frame, /Agent:Codex/);
      assert.match(frame, /Codex ten days ago/);
      assert.doesNotMatch(frame, /Claude live task/);

      // 'c' -> Clear filters
      await mockInput.pressKey('c');
      await flushUi(renderOnce);
      frame = captureCharFrame();
      assert.match(frame, /Agent:All/);
      assert.match(frame, /Claude live task/);
      assert.match(frame, /Codex ten days ago/);

      // Host filter: 'o' -> Mac, 'o' -> Sandbox
      await mockInput.pressKey('o');
      await flushUi(renderOnce);
      frame = captureCharFrame();
      assert.match(frame, /Host:Mac/);
      assert.doesNotMatch(frame, /Sandbox remote task/);

      await mockInput.pressKey('o');
      await flushUi(renderOnce);
      frame = captureCharFrame();
      assert.match(frame, /Host:Sandbox/);
      assert.match(frame, /Sandbox remote task/);
      assert.doesNotMatch(frame, /Claude live task/);

      await mockInput.pressKey('c');
      await flushUi(renderOnce);

      // Status filter: 's' -> Live
      await mockInput.pressKey('s');
      await flushUi(renderOnce);
      frame = captureCharFrame();
      assert.match(frame, /Status:Live/);
      assert.match(frame, /Claude live task/);
      assert.doesNotMatch(frame, /Codex ten days ago/);

      await mockInput.pressKey('c');
      await flushUi(renderOnce);

      // Date preset: 'd' -> 24h (only recent), 'd' -> 7d, 'd' -> 30d (includes 10d Codex, excludes 40d Antigravity)
      await mockInput.pressKey('d');
      await flushUi(renderOnce);
      frame = captureCharFrame();
      assert.match(frame, /Date:24h/);
      assert.match(frame, /Claude live task/);
      assert.doesNotMatch(frame, /Codex ten days ago/);

      await mockInput.pressKey('d');
      await mockInput.pressKey('d');
      await flushUi(renderOnce);
      frame = captureCharFrame();
      assert.match(frame, /Date:30d/);
      assert.match(frame, /Codex ten days ago/);
      assert.doesNotMatch(frame, /Antigravity forty days ago/);

      // Custom date range: 'D' -> type '2026-05-01..2026-05-10' + Enter -> only 40d Antigravity
      await mockInput.pressKey('D', { shift: true });
      await flushUi(renderOnce);
      await typeText(mockInput, '2026-05-01..2026-05-10');
      await mockInput.pressEnter();
      await flushUi(renderOnce);
      frame = captureCharFrame();
      assert.match(frame, /Antigravity forty days ago/);
      assert.doesNotMatch(frame, /Claude live task/);
      assert.doesNotMatch(frame, /Codex ten days ago/);
    } finally {
      handle.dispose();
      await service.stop();
      renderer.destroy();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('headless UI: global FTS5 search shows highlighted snippets and jumps to matching step (expanding collapsed ancestors)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'periscope-search-ui-'));
  const now = Date.parse('2026-06-15T12:00:00Z');

  try {
    const claudeDir = path.join(tmp, 'claude', 'proj-search');
    fs.mkdirSync(claudeDir, { recursive: true });

    const s1File = path.join(claudeDir, 'aaaa1111-1111-1111-1111-111111111111.jsonl');
    const t0 = new Date(now - 60_000).toISOString();
    const t1 = new Date(now - 50_000).toISOString();
    const t2 = new Date(now - 40_000).toISOString();
    const t3 = new Date(now - 30_000).toISOString();
    fs.writeFileSync(
      s1File,
      [
        JSON.stringify({
          type: 'user',
          cwd: '/work/proj-search',
          timestamp: t0,
          message: { role: 'user', content: 'First turn unrelated' },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: t1,
          message: { role: 'assistant', content: [{ type: 'text', text: 'Checking files now' }] },
        }),
        JSON.stringify({
          type: 'user',
          timestamp: t2,
          message: { role: 'user', content: 'Second turn question' },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: t3,
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tool-xyz',
                name: 'Bash',
                input: { command: 'grep quantum_flux src/app.ts' },
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          timestamp: t3,
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-xyz',
                content: 'Result contains quantum_flux capacitor calibration',
              },
            ],
          },
        }),
      ].join('\n') + '\n',
    );

    const service = new PeriscopeService({
      dbPath: ':memory:',
      roots: [{ agent: 'claude', dir: path.join(tmp, 'claude') }],
      agyMetadata: path.join(tmp, 'nonexistent.json'),
      claudeSessionsDir: path.join(tmp, 'no-sessions'),
      sandboxEnabled: false,
      clock: () => now,
    });

    const { createTestRenderer } = await import('@opentui/core/testing');
    const { renderer, mockInput, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 120,
      height: 30,
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
      await handle.refresh();
      await flushUi(renderOnce);

      // Open session first and collapse the second turn so we also verify collapsed ancestors expand on jump
      await mockInput.pressArrow('down');
      await mockInput.pressEnter();
      await flushUi(renderOnce);

      // Move to Second turn and collapse it with 'h'
      await mockInput.pressKey('j');
      await mockInput.pressKey('j');
      await mockInput.pressKey('h');
      await flushUi(renderOnce);
      assert.doesNotMatch(captureCharFrame(), /grep quantum_flux/);

      // Switch focus back to sessions pane (Shift+Tab)
      await mockInput.pressTab({ shift: true });
      await flushUi(renderOnce);

      // Press '/' to enter global search, type 'quantum_flux'
      await mockInput.pressKey('/');
      await typeText(mockInput, 'quantum_flux');
      await flushUi(renderOnce);

      const searchFrame = captureCharFrame();
      assert.match(searchFrame, /Search: quantum_flux/);
      assert.match(searchFrame, /First turn unrelated/);
      assert.match(searchFrame, /quantum_flux/);

      // Press Enter to open the matching hit and jump directly to the matching step
      await mockInput.pressEnter();
      await flushUi(renderOnce);

      const jumpedFrame = captureCharFrame();
      // Collapsed ancestor expanded, Bash tool call selected, detail pane shows tool output with quantum_flux
      assert.match(jumpedFrame, /grep quantum_flux/);
      assert.match(jumpedFrame, /Result contains quantum_flux capacitor/);
      assert.match(jumpedFrame, /calibration/);

      // Escape in sessions pane clears search and restores grouped list
      await mockInput.pressTab({ shift: true });
      await mockInput.pressEscape();
      await flushUi(renderOnce);
      const clearedFrame = captureCharFrame();
      assert.match(clearedFrame, /▾ proj-search/);
    } finally {
      handle.dispose();
      await service.stop();
      renderer.destroy();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
