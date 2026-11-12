import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PeriscopeService } from '../src/core/service.ts';
import { mountPeriscopeApp } from '../src/tui/app.ts';

test('headless UI: shows sandbox sessions with Sandbox badge alongside Mac sessions and online status', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'periscope-tui-sbx-'));
  const now = Date.parse('2026-06-01T12:00:00Z');
  try {
    const macRoot = path.join(tmp, 'mac-claude');
    const macId = 'aaaaaaaa-1111-2222-3333-444444444444';
    const macFile = path.join(macRoot, 'proj-a', `${macId}.jsonl`);
    fs.mkdirSync(path.dirname(macFile), { recursive: true });
    fs.writeFileSync(
      macFile,
      JSON.stringify({ type: 'user', cwd: '/work/proj-a', timestamp: '2026-06-01T11:00:00Z', message: { role: 'user', content: 'Mac session prompt' } }) + '\n',
    );

    const volRoot = path.join(tmp, 'vol');
    const sbxId = 'bbbbbbbb-1111-2222-3333-444444444444';
    const sbxFile = path.join(volRoot, 'v/claude-home/projects/proj-b', `${sbxId}.jsonl`);
    fs.mkdirSync(path.dirname(sbxFile), { recursive: true });
    fs.writeFileSync(
      sbxFile,
      JSON.stringify({ type: 'user', cwd: '/work/proj-b', timestamp: '2026-06-01T11:30:00Z', message: { role: 'user', content: 'Sandbox session prompt' } }) + '\n',
    );

    const service = new PeriscopeService({
      dbPath: ':memory:',
      roots: [{ agent: 'claude', dir: macRoot }],
      agyMetadata: path.join(tmp, 'no-agy', 'nonexistent.json'),
      claudeSessionsDir: path.join(tmp, 'no-sessions'),
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
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 120, height: 24 });

    const handle = mountPeriscopeApp(renderer, {
      service,
      theme: 'dark',
      clock: () => now,
      initiallyIndexing: true,
      onQuit: () => {},
    });

    try {
      await service.start();
      await new Promise((r) => setTimeout(r, 80));
      await handle.refresh();
      await renderOnce();

      const frame = captureCharFrame();
      assert.match(frame, /sandbox: online/);
      assert.match(frame, /Mac session prompt/);
      assert.match(frame, /Sandbox session prompt/);
      assert.match(frame, /Claude Code · Mac/);
      assert.match(frame, /Claude Code · Sandbox/);
    } finally {
      handle.dispose();
      await service.stop();
      renderer.destroy();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('headless UI: displays offline and error sandbox status and lets user inspect error message on request', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'periscope-tui-sbx-err-'));
  try {
    let call = 0;
    const service = new PeriscopeService({
      dbPath: ':memory:',
      roots: [],
      agyMetadata: path.join(tmp, 'no-agy', 'nonexistent.json'),
      claudeSessionsDir: path.join(tmp, 'no-sessions'),
      podman: '/usr/bin/podman',
      pollMs: 30,
      exec: async () => {
        call++;
        if (call === 1) {
          return { code: 125, stdout: '', stderr: 'Error: Cannot connect to Podman machine' };
        }
        return { code: 125, stdout: '', stderr: 'Error: invalid reference format' };
      },
    });

    const { createTestRenderer } = await import('@opentui/core/testing');
    const { renderer, mockInput, renderOnce, captureCharFrame } = await createTestRenderer({ width: 120, height: 24 });

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

      const offlineFrame = captureCharFrame();
      assert.match(offlineFrame, /sandbox: offline \[S\]/);

      // Wait for second poll tick to transition to error state
      await new Promise((r) => setTimeout(r, 60));
      await renderOnce();

      const errorFrame = captureCharFrame();
      assert.match(errorFrame, /sandbox: error \[S\]/);
      assert.doesNotMatch(errorFrame, /invalid reference format/);

      // Request to view the error message via 'S'
      await mockInput.pressKey('S', { shift: true });
      await renderOnce();

      const detailFrame = captureCharFrame();
      assert.match(detailFrame, /Podman failed while polling the sandbox volumes:/);
      assert.match(detailFrame, /Error: invalid reference format/);

      // Close detail with Escape (allow OpenTUI escape sequence timeout to flush)
      mockInput.pressEscape();
      await new Promise((r) => setTimeout(r, 60));
      await renderOnce();

      const closedFrame = captureCharFrame();
      assert.doesNotMatch(closedFrame, /invalid reference format/);
    } finally {
      handle.dispose();
      await service.stop();
      renderer.destroy();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
