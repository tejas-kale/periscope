import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import {
  detectCapabilities,
  runTuiLifecycle,
  type RendererLike,
  type TuiAdapter,
} from '../src/tui/adapter.ts';
import { mountShell, type ShellViewHandle } from '../src/tui/shell.ts';

function hasNodeFfi(): boolean {
  try {
    const req = createRequire(import.meta.url);
    req('node:ffi');
    return true;
  } catch {
    return false;
  }
}

class FakeRenderer implements RendererLike {
  readonly keyInput = new EventEmitter();
  readonly root = {
    children: [] as unknown[],
    add(node: unknown) {
      this.children.push(node);
    },
  };
  capabilities = {
    osc52: true,
    kitty_graphics: false,
    sixel: false,
    unicode: 'wcwidth' as const,
    remote: false,
    terminal: { name: 'xterm-256color', version: '1.0', from_xtversion: false },
  };
  themeMode: 'dark' | 'light' | null = 'dark';
  terminalWidth = 100;
  terminalHeight = 30;
  started = false;
  destroyCount = 0;

  start(): void {
    this.started = true;
  }

  destroy(): void {
    this.destroyCount += 1;
  }
}

function createFakeAdapter(renderer: FakeRenderer): TuiAdapter<FakeRenderer> {
  return {
    async createRenderer() {
      return renderer;
    },
    destroyRenderer(r: FakeRenderer) {
      r.destroy();
    },
    detectCapabilities(r: FakeRenderer) {
      return detectCapabilities(r);
    },
    createTextNode(_r: FakeRenderer, text: string) {
      return { kind: 'text', text };
    },
    copyToClipboard(_r: FakeRenderer, _text: string) {
      return true;
    },
  };
}

test('adapter: detectCapabilities maps renderer capabilities and handles null', () => {
  const full = new FakeRenderer();
  assert.deepEqual(detectCapabilities(full), {
    themeMode: 'dark',
    osc52: true,
    images: false,
    unicode: 'wcwidth',
    remote: false,
    terminalName: 'xterm-256color',
  });

  const empty = new FakeRenderer();
  empty.capabilities = null as unknown as FakeRenderer['capabilities'];
  empty.themeMode = null;
  assert.deepEqual(detectCapabilities(empty), {
    themeMode: null,
    osc52: false,
    images: false,
    unicode: 'wcwidth',
    remote: false,
    terminalName: 'unknown',
  });
});

test('shell: quits cleanly on "q" and restores terminal once', async () => {
  const renderer = new FakeRenderer();
  const adapter = createFakeAdapter(renderer);
  let handle: ShellViewHandle | undefined;

  const exitPromise = runTuiLifecycle(adapter, async (r, requestQuit) => {
    handle = mountShell(adapter, r, { theme: 'auto', onQuit: requestQuit });
    queueMicrotask(() => {
      r.keyInput.emit('keypress', { name: 'q', ctrl: false, shift: false, meta: false, sequence: 'q' });
    });
  });

  await exitPromise;
  assert.equal(renderer.started, true);
  assert.equal(renderer.destroyCount, 1);
  assert.ok(handle);
  assert.match(handle.summaryText, /Periscope/);
});

test('shell: quits cleanly on Ctrl+C and restores terminal once', async () => {
  const renderer = new FakeRenderer();
  const adapter = createFakeAdapter(renderer);

  await runTuiLifecycle(adapter, async (r, requestQuit) => {
    mountShell(adapter, r, { theme: 'dark', onQuit: requestQuit });
    queueMicrotask(() => {
      r.keyInput.emit('keypress', { name: 'c', ctrl: true, shift: false, meta: false, sequence: '\x03' });
    });
  });

  assert.equal(renderer.destroyCount, 1);
});

test('shell: restores terminal when app throws an uncaught error', async () => {
  const renderer = new FakeRenderer();
  const adapter = createFakeAdapter(renderer);

  await assert.rejects(
    runTuiLifecycle(adapter, async () => {
      throw new Error('boom');
    }),
    /boom/,
  );

  assert.equal(renderer.destroyCount, 1);
});

test('headless test renderer: renders minimal shell and quits on "q"', async (t) => {
  if (!hasNodeFfi()) {
    t.skip(`@opentui/core native FFI requires Node >= 26.4.0 (running ${process.version})`);
    return;
  }

  const { createTestRenderer } = await import('@opentui/core/testing');
  const { createOpenTuiAdapter } = await import('../src/tui/adapter.ts');
  const { renderer, mockInput, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 80,
    height: 24,
  });

  const adapter = createOpenTuiAdapter();
  let quitCalled = false;
  try {
    mountShell(adapter, renderer, {
      theme: 'auto',
      onQuit: () => {
        quitCalled = true;
      },
    });
    await renderOnce();
    const frame = captureCharFrame();
    assert.match(frame, /Periscope/);
    await mockInput.pressKey('q');
    assert.equal(quitCalled, true);
  } finally {
    renderer.destroy();
  }
});
