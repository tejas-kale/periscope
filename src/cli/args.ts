export type ThemeOption = 'auto' | 'dark' | 'light';

export interface CliRunOptions {
  dbPath: string | undefined;
  sandbox: boolean | undefined;
  theme: ThemeOption;
}

export type CliParseResult =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'run'; options: CliRunOptions }
  | { kind: 'error'; message: string };

const VALID_THEMES = new Set<string>(['auto', 'dark', 'light']);

/** Parse CLI arguments for the `periscope` command. */
export function parseCliArgs(argv: readonly string[]): CliParseResult {
  const options: CliRunOptions = {
    dbPath: undefined,
    sandbox: undefined,
    theme: 'auto',
  };

  const readValue = (flag: string, inline: string | undefined, index: number): { value: string; nextIndex: number } | { error: string } => {
    if (inline !== undefined) {
      if (inline.length === 0) return { error: `${flag} requires a non-empty value` };
      return { value: inline, nextIndex: index };
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('-')) {
      return { error: `${flag} requires a value` };
    }
    return { value: next, nextIndex: index + 1 };
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') return { kind: 'help' };
    if (arg === '--version' || arg === '-v') return { kind: 'version' };
    if (arg === '--sandbox') {
      options.sandbox = true;
      continue;
    }
    if (arg === '--no-sandbox') {
      options.sandbox = false;
      continue;
    }

    const eqIdx = arg.indexOf('=');
    const flag = eqIdx >= 0 ? arg.slice(0, eqIdx) : arg;
    const inline = eqIdx >= 0 ? arg.slice(eqIdx + 1) : undefined;

    if (flag === '--db') {
      const res = readValue('--db', inline, i);
      if ('error' in res) return { kind: 'error', message: res.error };
      options.dbPath = res.value;
      i = res.nextIndex;
      continue;
    }

    if (flag === '--theme') {
      const res = readValue('--theme', inline, i);
      if ('error' in res) return { kind: 'error', message: res.error };
      if (!VALID_THEMES.has(res.value)) {
        return { kind: 'error', message: `Invalid --theme "${res.value}". Expected auto, dark, or light.` };
      }
      options.theme = res.value as ThemeOption;
      i = res.nextIndex;
      continue;
    }

    return { kind: 'error', message: `Unknown option: ${arg}` };
  }

  return { kind: 'run', options };
}

/** Return the CLI usage text for `--help`. */
export function formatHelp(): string {
  return [
    'Usage: periscope [options]',
    '',
    'Browse, search and watch Claude Code, Codex and Antigravity CLI transcripts.',
    '',
    'Options:',
    '  -h, --help            Show this help message',
    '  -v, --version         Show version number',
    '      --db <path>       Override SQLite database path',
    '      --sandbox         Enable Podman sandbox polling',
    '      --no-sandbox      Disable Podman sandbox polling',
    '      --theme <mode>    Set colour theme: auto, dark, or light (default: auto)',
  ].join('\n');
}
