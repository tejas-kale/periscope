import {
  createCliRenderer,
  TextRenderable,
  type CliRenderer,
  type CliRendererConfig,
  type WidthMethod,
} from '@opentui/core';
import type { EventEmitter } from 'node:events';

export interface TerminalSupport {
  themeMode: 'dark' | 'light' | null;
  osc52: boolean;
  images: boolean;
  unicode: WidthMethod;
  remote: boolean;
  terminalName: string;
}

export interface KeyEventLike {
  name?: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  sequence?: string;
}

export interface RendererCapabilitiesLike {
  osc52?: boolean;
  kitty_graphics?: boolean;
  sixel?: boolean;
  unicode?: WidthMethod;
  remote?: boolean;
  terminal?: { name?: string };
}

export interface RendererLike {
  readonly keyInput: Pick<EventEmitter, 'on' | 'off'>;
  readonly root: { add(node: unknown): void };
  readonly capabilities: RendererCapabilitiesLike | null;
  readonly themeMode: 'dark' | 'light' | null;
  readonly terminalWidth: number;
  readonly terminalHeight: number;
  start(): void;
  destroy(): void;
}

export interface TuiAdapter<R extends RendererLike = RendererLike> {
  createRenderer(config?: CliRendererConfig): Promise<R>;
  destroyRenderer(renderer: R): void;
  detectCapabilities(renderer: R): TerminalSupport;
  createTextNode(renderer: R, content: string): unknown;
  copyToClipboard(renderer: R, text: string): boolean;
}

/** Extract normalized terminal capability flags from an OpenTUI renderer. */
export function detectCapabilities(renderer: Pick<RendererLike, 'capabilities' | 'themeMode'>): TerminalSupport {
  const caps = renderer.capabilities;
  return {
    themeMode: renderer.themeMode ?? null,
    osc52: Boolean(caps?.osc52),
    images: Boolean(caps?.kitty_graphics || caps?.sixel),
    unicode: caps?.unicode ?? 'wcwidth',
    remote: Boolean(caps?.remote),
    terminalName: caps?.terminal?.name || 'unknown',
  };
}

/** Create the production OpenTUI adapter backed by `@opentui/core`. */
export function createOpenTuiAdapter(): TuiAdapter<CliRenderer> {
  return {
    createRenderer(config?: CliRendererConfig) {
      return createCliRenderer({
        exitOnCtrlC: false,
        screenMode: 'alternate-screen',
        synchronizedOutput: 'auto',
        ...config,
      });
    },
    destroyRenderer(renderer: CliRenderer) {
      renderer.destroy();
    },
    detectCapabilities(renderer: CliRenderer) {
      return detectCapabilities(renderer);
    },
    createTextNode(renderer: CliRenderer, content: string) {
      return new TextRenderable(renderer, { content });
    },
    copyToClipboard(renderer: CliRenderer, text: string) {
      try {
        return renderer.copyToClipboardOSC52(text);
      } catch {
        return false;
      }
    },
  };
}

/**
 * Run a TUI session with guaranteed terminal restoration on normal quit,
 * Ctrl+C / SIGINT / SIGTERM, or any uncaught error.
 */
export async function runTuiLifecycle<R extends RendererLike>(
  adapter: TuiAdapter<R>,
  onMount: (renderer: R, requestQuit: () => void) => Promise<void> | void,
  config?: CliRendererConfig,
): Promise<void> {
  const renderer = await adapter.createRenderer(config);
  let destroyed = false;
  const destroyOnce = () => {
    if (destroyed) return;
    destroyed = true;
    adapter.destroyRenderer(renderer);
  };

  let resolveQuit!: () => void;
  let rejectQuit!: (err: unknown) => void;
  const quitPromise = new Promise<void>((resolve, reject) => {
    resolveQuit = resolve;
    rejectQuit = reject;
  });

  const requestQuit = () => resolveQuit();
  const onSignal = () => resolveQuit();
  const onFatalError = (err: unknown) => {
    destroyOnce();
    rejectQuit(err);
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('uncaughtException', onFatalError);
  process.on('unhandledRejection', onFatalError);

  try {
    renderer.start();
    await onMount(renderer, requestQuit);
    await quitPromise;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('uncaughtException', onFatalError);
    process.off('unhandledRejection', onFatalError);
    destroyOnce();
    // Yield a microtask so OpenTUI can flush any pending shutdown sequences.
    await Promise.resolve();
  }
}
