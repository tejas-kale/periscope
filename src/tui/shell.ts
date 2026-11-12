import type { ThemeOption } from '../cli/args.ts';
import type { KeyEventLike, RendererLike, TuiAdapter } from './adapter.ts';

export interface ShellMountOptions {
  theme: ThemeOption;
  onQuit: () => void;
}

export interface ShellViewHandle {
  summaryText: string;
  dispose(): void;
}

/** Mount the minimal Periscope terminal shell and wire `q` / `Ctrl+C` quit keys. */
export function mountShell<R extends RendererLike>(
  adapter: TuiAdapter<R>,
  renderer: R,
  options: ShellMountOptions,
): ShellViewHandle {
  const support = adapter.detectCapabilities(renderer);
  const resolvedTheme = options.theme === 'auto' ? (support.themeMode ?? 'dark') : options.theme;
  const summaryText = [
    `Periscope CLI (theme: ${resolvedTheme}, terminal: ${support.terminalName})`,
    `Capabilities: osc52=${support.osc52 ? 'yes' : 'no'} images=${support.images ? 'yes' : 'no'} unicode=${support.unicode}`,
    `Press q or Ctrl+C to quit.`,
  ].join('\n');

  const node = adapter.createTextNode(renderer, summaryText);
  renderer.root.add(node);

  const onKeypress = (key: KeyEventLike) => {
    if (key.ctrl && key.name === 'c') {
      options.onQuit();
      return;
    }
    if (!key.ctrl && !key.meta && key.name === 'q') {
      options.onQuit();
    }
  };

  renderer.keyInput.on('keypress', onKeypress);

  return {
    summaryText,
    dispose() {
      renderer.keyInput.off('keypress', onKeypress);
    },
  };
}
