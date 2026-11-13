import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FIXTURES } from './helpers.ts';
import { defaultDbPath, PeriscopeService, type IndexProgress } from '../src/core/service.ts';
import { LIVE_WINDOW_MS } from '../src/core/store.ts';
import type { ChangeNotice, PeriscopeApi, SandboxState } from '../src/core/types.ts';

function fixtureRoots() {
  return [
    { agent: 'claude' as const, dir: path.join(FIXTURES, 'claude') },
    { agent: 'codex' as const, dir: path.join(FIXTURES, 'codex') },
    { agent: 'antigravity' as const, dir: path.join(FIXTURES, 'antigravity') },
  ];
}

test('defaultDbPath preserves macOS location and uses XDG_DATA_HOME on Linux', () => {
  assert.equal(
    defaultDbPath({ platform: 'darwin', home: '/Users/alice', env: {} }),
    path.join('/Users/alice', 'Library', 'Application Support', 'Periscope', 'periscope.db'),
  );
  assert.equal(
    defaultDbPath({ platform: 'linux', home: '/home/alice', env: {} }),
    path.join('/home/alice', '.local', 'share', 'periscope', 'periscope.db'),
  );
  assert.equal(
    defaultDbPath({ platform: 'linux', home: '/home/alice', env: { XDG_DATA_HOME: '/data/xdg' } }),
    path.join('/data/xdg', 'periscope', 'periscope.db'),
  );
});

test('first-launch indexing emits progress and exposes PeriscopeApi queries on in-memory DB', async () => {
  const service = new PeriscopeService({
    dbPath: ':memory:',
    roots: fixtureRoots(),
    agyMetadata: path.join(FIXTURES, 'antigravity', 'nonexistent.json'),
    claudeSessionsDir: path.join(FIXTURES, 'no-sessions'),
    sandboxEnabled: false,
  });
  const api: PeriscopeApi = service;
  const progress: IndexProgress[] = [];
  const off = service.onProgress((p) => progress.push(p));

  await service.start();
  try {
    assert.ok(progress.length >= 2, 'expected multiple progress updates during first-launch indexing');
    assert.equal(progress[0].indexed, 0);
    assert.ok(progress[0].total >= 3);
    const last = progress[progress.length - 1];
    assert.equal(last.done, true);
    assert.equal(last.indexed, last.total);

    const sessions = await api.listSessions({});
    assert.ok(sessions.length >= 3);
    const claude = sessions.find((s) => s.agent === 'claude');
    assert.ok(claude);

    const events = await api.getEvents(claude.id);
    assert.ok(events.length > 0);
    const raw = await api.getRaw(events[0].id);
    assert.ok(raw !== null);

    const hits = await api.search('review', {});
    assert.ok(hits.length >= 1);
  } finally {
    off();
    await service.stop();
  }
});

test('subsequent launch performs incremental ingestion on persistent node:sqlite DB', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'periscope-svc-'));
  try {
    const dbPath = path.join(tmp, 'data', 'periscope.db');
    const claudeRoot = path.join(tmp, 'claude');
    const sessionFile = path.join(claudeRoot, 'proj', '11111111-2222-3333-4444-555555555555.jsonl');
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    const line = (text: string) =>
      JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: text } }) + '\n';
    fs.writeFileSync(sessionFile, line('first message'));

    const opts = {
      dbPath,
      roots: [{ agent: 'claude' as const, dir: claudeRoot }],
      agyMetadata: path.join(tmp, 'nonexistent.json'),
      claudeSessionsDir: path.join(tmp, 'no-sessions'),
      sandboxEnabled: false,
      debounceMs: 10,
    };

    const s1 = new PeriscopeService(opts);
    await s1.start();
    const initialEvents = await s1.getEvents('n:11111111-2222-3333-4444-555555555555');
    assert.deepEqual(
      initialEvents.map((e) => e.text),
      ['first message'],
    );
    await s1.stop();

    // Relaunch with no changes: nothing new ingested, no change notice fired.
    const s2 = new PeriscopeService(opts);
    const changes2: ChangeNotice[] = [];
    s2.onChange((n) => changes2.push(n));
    await s2.start();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(changes2.length, 0);
    assert.equal((await s2.getEvents('n:11111111-2222-3333-4444-555555555555')).length, 1);
    await s2.stop();

    // Append one line while stopped, then relaunch: only the appended line is ingested.
    fs.appendFileSync(sessionFile, line('second message'));
    const s3 = new PeriscopeService(opts);
    await s3.start();
    const afterEvents = await s3.getEvents('n:11111111-2222-3333-4444-555555555555');
    assert.deepEqual(
      afterEvents.map((e) => e.text),
      ['first message', 'second message'],
    );
    await s3.stop();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('native file watching ingests new writes and debounces onChange notifications', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'periscope-watch-'));
  try {
    const claudeRoot = path.join(tmp, 'claude');
    fs.mkdirSync(path.join(claudeRoot, 'proj'), { recursive: true });
    const service = new PeriscopeService({
      dbPath: ':memory:',
      roots: [{ agent: 'claude' as const, dir: claudeRoot }],
      agyMetadata: path.join(tmp, 'nonexistent.json'),
      claudeSessionsDir: path.join(tmp, 'no-sessions'),
      sandboxEnabled: false,
      debounceMs: 60,
    });
    const notices: ChangeNotice[] = [];
    const seen = new Promise<void>((resolve) => {
      service.onChange((n) => {
        notices.push(n);
        resolve();
      });
    });

    await service.start();
    try {
      const sessionFile = path.join(claudeRoot, 'proj', '22222222-3333-4444-5555-666666666666.jsonl');
      const line = (text: string) =>
        JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: text } }) + '\n';
      fs.writeFileSync(sessionFile, line('alpha'));
      await new Promise((r) => setTimeout(r, 15));
      fs.appendFileSync(sessionFile, line('beta'));

      await Promise.race([
        seen,
        new Promise((_, rej) => setTimeout(() => rej(new Error('timed out waiting for onChange')), 3000)),
      ]);
      // Allow any trailing debounce window to settle.
      await new Promise((r) => setTimeout(r, 80));

      assert.equal(notices.length, 1);
      assert.deepEqual(notices[0].sessionIds, ['n:22222222-3333-4444-5555-666666666666']);
      const events = await service.getEvents('n:22222222-3333-4444-5555-666666666666');
      assert.deepEqual(
        events.map((e) => e.text),
        ['alpha', 'beta'],
      );
    } finally {
      await service.stop();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('live-session expiry transitions live sessions to idle and emits onChange when clock advances', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'periscope-exp-'));
  try {
    const claudeRoot = path.join(tmp, 'claude');
    const sessionFile = path.join(claudeRoot, 'proj', '33333333-4444-5555-6666-777777777777.jsonl');
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'live prompt' } }) + '\n',
    );
    let now = fs.statSync(sessionFile).mtimeMs + 1000;

    const service = new PeriscopeService({
      dbPath: ':memory:',
      roots: [{ agent: 'claude' as const, dir: claudeRoot }],
      agyMetadata: path.join(tmp, 'nonexistent.json'),
      claudeSessionsDir: path.join(tmp, 'no-sessions'),
      sandboxEnabled: false,
      clock: () => now,
      expireMs: 15,
      debounceMs: 5,
    });

    await service.start();
    try {
      assert.equal((await service.listSessions({ status: 'live' })).length, 1);

      const expired = new Promise<ChangeNotice>((resolve) => {
        const off = service.onChange((n) => {
          off();
          resolve(n);
        });
      });
      now += LIVE_WINDOW_MS;

      const notice = await Promise.race([
        expired,
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timed out waiting for expiry')), 2000)),
      ]);
      assert.deepEqual(notice.sessionIds, ['n:33333333-4444-5555-6666-777777777777']);
      assert.equal((await service.listSessions({ status: 'live' })).length, 0);
      assert.equal((await service.listSessions({ status: 'idle' })).length, 1);
    } finally {
      await service.stop();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('sandbox poller with injectable exec, native presence, and readImage work at service seam', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'periscope-sbx-'));
  try {
    const claudeRoot = path.join(tmp, 'claude');
    const sessionsDir = path.join(tmp, 'claude-sessions');
    fs.mkdirSync(path.join(claudeRoot, 'proj'), { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });

    const sessionId = '44444444-5555-6666-7777-888888888888';
    const sessionFile = path.join(claudeRoot, 'proj', `${sessionId}.jsonl`);
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({ type: 'user', timestamp: '2025-01-01T00:00:00Z', message: { role: 'user', content: 'old prompt' } }) + '\n',
    );
    // Make file mtime old so it would be idle without presence.
    const past = new Date(Date.now() - LIVE_WINDOW_MS * 10);
    fs.utimesSync(sessionFile, past, past);

    // Write a native Claude presence file for a live pid.
    fs.writeFileSync(path.join(sessionsDir, '99999.json'), JSON.stringify({ pid: 99999, sessionId, cwd: '/tmp', startedAt: 1 }));

    // Write an image inside claudeRoot and one outside.
    const insideImg = path.join(claudeRoot, 'proj', 'shot.png');
    const outsideImg = path.join(tmp, 'outside.png');
    fs.writeFileSync(insideImg, Buffer.from('pngbytes'));
    fs.writeFileSync(outsideImg, Buffer.from('secret'));

    let execCall = 0;
    const states: SandboxState[] = [];
    const service = new PeriscopeService({
      dbPath: ':memory:',
      roots: [{ agent: 'claude' as const, dir: claudeRoot }],
      agyMetadata: path.join(tmp, 'nonexistent.json'),
      claudeSessionsDir: sessionsDir,
      isAlive: (pid) => pid === 99999,
      podman: '/usr/bin/podman',
      pollMs: 25,
      exec: async () => {
        execCall++;
        if (execCall === 1) return { code: 125, stdout: '', stderr: 'Cannot connect to Podman machine' };
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    service.onSandbox((s) => states.push(s));

    await service.start();
    try {
      await new Promise((r) => setTimeout(r, 60));
      assert.ok(states.some((s) => s.state === 'offline'));
      assert.ok(states.some((s) => s.state === 'online'));
      assert.equal((await service.sandboxStatus()).state, 'online');

      const sessions = await service.listSessions({});
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].status, 'open');

      const dataUrl = await service.readImage(`file://${insideImg}`);
      assert.equal(dataUrl, `data:image/png;base64,${Buffer.from('pngbytes').toString('base64')}`);
      assert.equal(await service.readImage(outsideImg), null);

      const claudeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-test-'));
      try {
        const claudeTmpImg = path.join(claudeTmpDir, '1.png');
        fs.writeFileSync(claudeTmpImg, 'claudepng');
        assert.equal(
          await service.readImage(claudeTmpImg),
          `data:image/png;base64,${Buffer.from('claudepng').toString('base64')}`,
        );
      } finally {
        fs.rmSync(claudeTmpDir, { recursive: true, force: true });
      }
    } finally {
      await service.stop();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('sandbox respects PERISCOPE_SANDBOX=0, --no-sandbox, and PERISCOPE_SANDBOX_IMAGE at service seam', async () => {
  const prevSandbox = process.env.PERISCOPE_SANDBOX;
  const prevImage = process.env.PERISCOPE_SANDBOX_IMAGE;
  const noAgy = path.join(os.tmpdir(), 'periscope-no-agy', 'nonexistent.json');
  try {
    // 1. PERISCOPE_SANDBOX=0 disables poller without calling exec
    process.env.PERISCOPE_SANDBOX = '0';
    let calls = 0;
    const svcEnvOff = new PeriscopeService({
      dbPath: ':memory:',
      roots: [],
      agyMetadata: noAgy,
      claudeSessionsDir: '/nonexistent',
      podman: '/usr/bin/podman',
      exec: async () => {
        calls++;
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    await svcEnvOff.start();
    try {
      const st = await svcEnvOff.sandboxStatus();
      assert.equal(st.state, 'disabled');
      assert.match(st.message ?? '', /PERISCOPE_SANDBOX=0/);
      assert.equal(calls, 0);
    } finally {
      await svcEnvOff.stop();
    }

    // 2. sandboxEnabled: false (--no-sandbox) disables poller even when env is not 0
    delete process.env.PERISCOPE_SANDBOX;
    const svcFlagOff = new PeriscopeService({
      dbPath: ':memory:',
      roots: [],
      agyMetadata: noAgy,
      claudeSessionsDir: '/nonexistent',
      sandboxEnabled: false,
      podman: '/usr/bin/podman',
      exec: async () => {
        calls++;
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    await svcFlagOff.start();
    try {
      const st = await svcFlagOff.sandboxStatus();
      assert.equal(st.state, 'disabled');
      assert.match(st.message ?? '', /--no-sandbox/);
      assert.equal(calls, 0);
    } finally {
      await svcFlagOff.stop();
    }

    // 3. PERISCOPE_SANDBOX_IMAGE is used in podman ps/run and never starts podman machine
    process.env.PERISCOPE_SANDBOX_IMAGE = 'localhost/custom-sandbox:v2';
    const seenArgs: string[][] = [];
    const svcCustomImg = new PeriscopeService({
      dbPath: ':memory:',
      roots: [],
      agyMetadata: noAgy,
      claudeSessionsDir: '/nonexistent',
      podman: '/usr/bin/podman',
      pollMs: 5000,
      exec: async (_cmd, args) => {
        seenArgs.push(args);
        if (args[0] === 'volume') return { code: 0, stdout: 'claude-home\n', stderr: '' };
        if (args[0] === 'ps') return { code: 0, stdout: '[]', stderr: '' };
        return { code: 0, stdout: JSON.stringify({ files: [], metas: {}, sidecars: {}, errors: [], presence: [] }), stderr: '' };
      },
    });
    await svcCustomImg.start();
    try {
      await new Promise((r) => setTimeout(r, 30));
      const runArgs = seenArgs.find((a) => a[0] === 'run');
      assert.ok(runArgs, 'expected podman run call');
      assert.ok(runArgs.includes('localhost/custom-sandbox:v2'));
      assert.ok(!seenArgs.some((a) => a.includes('machine') || a.includes('start')));
    } finally {
      await svcCustomImg.stop();
    }
  } finally {
    if (prevSandbox === undefined) delete process.env.PERISCOPE_SANDBOX;
    else process.env.PERISCOPE_SANDBOX = prevSandbox;
    if (prevImage === undefined) delete process.env.PERISCOPE_SANDBOX_IMAGE;
    else process.env.PERISCOPE_SANDBOX_IMAGE = prevImage;
  }
});

test('sandbox ingests sandbox sessions alongside Mac sessions and reports error state', async () => {
  const { spawnSync } = await import('node:child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'periscope-sbx-mix-'));
  try {
    const macClaudeRoot = path.join(tmp, 'mac-claude');
    const macId = '11111111-1111-1111-1111-111111111111';
    const macFile = path.join(macClaudeRoot, 'proj-mac', `${macId}.jsonl`);
    fs.mkdirSync(path.dirname(macFile), { recursive: true });
    fs.writeFileSync(
      macFile,
      JSON.stringify({ type: 'user', cwd: '/work/mac', timestamp: '2026-06-01T10:00:00Z', message: { role: 'user', content: 'Mac prompt' } }) + '\n',
    );

    const volRoot = path.join(tmp, 'vol');
    const sbxId = '22222222-2222-2222-2222-222222222222';
    const sbxFile = path.join(volRoot, 'v/claude-home/projects/proj-sbx', `${sbxId}.jsonl`);
    fs.mkdirSync(path.dirname(sbxFile), { recursive: true });
    fs.writeFileSync(
      sbxFile,
      JSON.stringify({ type: 'user', cwd: '/work/sbx', timestamp: '2026-06-01T11:00:00Z', message: { role: 'user', content: 'Sandbox prompt' } }) + '\n',
    );

    let tick = 0;
    const states: SandboxState[] = [];
    const service = new PeriscopeService({
      dbPath: ':memory:',
      roots: [{ agent: 'claude' as const, dir: macClaudeRoot }],
      agyMetadata: path.join(tmp, 'nonexistent.json'),
      claudeSessionsDir: path.join(tmp, 'no-sessions'),
      podman: '/usr/bin/podman',
      pollMs: 25,
      exec: async (_cmd, args, input) => {
        if (args[0] === 'volume') {
          tick++;
          if (tick === 1) return { code: 125, stdout: '', stderr: 'Error: invalid reference format' };
          return { code: 0, stdout: 'claude-home\n', stderr: '' };
        }
        if (args[0] === 'ps') return { code: 0, stdout: '[]', stderr: '' };
        const script = args[args.indexOf('-e') + 1]!;
        const req = input!.replaceAll('"/v/', JSON.stringify(volRoot + '/v/').slice(0, -1));
        const r = spawnSync(process.execPath, ['-e', script], { input: req, encoding: 'utf8' });
        return { code: r.status ?? 1, stdout: r.stdout.replaceAll(volRoot + '/v/', '/v/'), stderr: r.stderr };
      },
    });
    service.onSandbox((s) => states.push(s));

    await service.start();
    try {
      await new Promise((r) => setTimeout(r, 80));
      const errState = states.find((s) => s.state === 'error');
      assert.ok(errState, 'expected error state');
      assert.match(errState.message ?? '', /invalid reference format/);
      assert.equal((await service.sandboxStatus()).state, 'online');

      const sessions = await service.listSessions({});
      assert.equal(sessions.length, 2);
      assert.ok(sessions.some((s) => s.host === 'native' && s.id === `n:${macId}`));
      assert.ok(sessions.some((s) => s.host === 'sandbox' && s.id === `s:${sbxId}`));
    } finally {
      await service.stop();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('watcher error or removed watched directory does not crash service', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'periscope-watch-err-'));
  try {
    const claudeRoot = path.join(tmp, 'claude');
    fs.mkdirSync(path.join(claudeRoot, 'proj'), { recursive: true });
    const service = new PeriscopeService({
      dbPath: ':memory:',
      roots: [{ agent: 'claude' as const, dir: claudeRoot }],
      agyMetadata: path.join(tmp, 'nonexistent.json'),
      claudeSessionsDir: path.join(tmp, 'no-sessions'),
      sandboxEnabled: false,
      watchEnsureMs: 20,
    });
    await service.start();
    try {
      fs.rmSync(claudeRoot, { recursive: true, force: true });
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      await service.stop();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
