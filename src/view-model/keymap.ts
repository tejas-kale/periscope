export interface KeyBinding {
  section: 'Global' | 'Layout & Theme' | 'Sessions' | 'Trace Tree' | 'Detail Pane';
  keys: string;
  description: string;
}

/** Single source of truth for all terminal-safe keyboard shortcuts. */
export const KEY_BINDINGS: readonly KeyBinding[] = [
  // Global
  { section: 'Global', keys: '?', description: 'Toggle this help overlay' },
  { section: 'Global', keys: 'Tab / Shift+Tab', description: 'Cycle focus between panes' },
  { section: 'Global', keys: '1-9', description: 'Quick-open Nth visible session' },
  { section: 'Global', keys: 'S', description: 'Toggle sandbox status detail' },
  { section: 'Global', keys: 'Esc', description: 'Close overlay / unzoom / return to trace' },
  { section: 'Global', keys: 'q / Ctrl+C', description: 'Quit Periscope' },

  // Layout & Theme
  { section: 'Layout & Theme', keys: '[ / ]', description: 'Shrink / grow focused pane width' },
  { section: 'Layout & Theme', keys: '=', description: 'Reset pane widths to default' },
  { section: 'Layout & Theme', keys: 'z', description: 'Toggle full-width detail pane zoom' },
  { section: 'Layout & Theme', keys: 't', description: 'Toggle light / dark colour theme' },

  // Sessions
  { section: 'Sessions', keys: '↑/↓ or k/j', description: 'Move session list cursor' },
  { section: 'Sessions', keys: '←/→ or h/l', description: 'Collapse / expand project group' },
  { section: 'Sessions', keys: 'Space', description: 'Toggle project group or select session' },
  { section: 'Sessions', keys: 'Enter', description: 'Open selected session' },
  { section: 'Sessions', keys: 'm', description: 'Show more sessions in group' },
  { section: 'Sessions', keys: 'g / G', description: 'Jump to top / bottom of list' },

  // Trace Tree
  { section: 'Trace Tree', keys: '↑/↓ or k/j', description: 'Move step selection' },
  { section: 'Trace Tree', keys: 'PgUp / PgDn', description: 'Page up / down in trace tree' },
  { section: 'Trace Tree', keys: '←/→ or h/l', description: 'Collapse/ascend or expand/descend' },
  { section: 'Trace Tree', keys: 'Space', description: 'Toggle expand / collapse step' },
  { section: 'Trace Tree', keys: 'g / G', description: 'Jump to first / last step' },
  { section: 'Trace Tree', keys: 'Enter', description: 'Focus detail pane' },
  { section: 'Trace Tree', keys: 'r', description: 'Toggle raw / rendered Markdown' },
  { section: 'Trace Tree', keys: 'e', description: 'Expand / collapse long tool output' },

  // Detail Pane
  { section: 'Detail Pane', keys: '↑/↓ or k/j', description: 'Scroll detail content' },
  { section: 'Detail Pane', keys: 'PgUp / PgDn', description: 'Page up / down in detail' },
  { section: 'Detail Pane', keys: 'h / Esc', description: 'Return focus to trace tree' },
  { section: 'Detail Pane', keys: 'r', description: 'Toggle raw / rendered Markdown' },
  { section: 'Detail Pane', keys: 'e', description: 'Expand / collapse long tool output' },
];

function truncateLine(text: string, maxWidth: number): string {
  if (maxWidth <= 1) return text.slice(0, Math.max(0, maxWidth));
  if (text.length <= maxWidth) return text;
  return `${text.slice(0, maxWidth - 1)}…`;
}

/** Format `KEY_BINDINGS` into readable lines constrained to `maxWidth` columns. */
export function formatHelpLines(maxWidth: number): string[] {
  const lines: string[] = [];
  let currentSection: string | null = null;
  const keyColWidth = maxWidth >= 56 ? 18 : 14;

  for (const binding of KEY_BINDINGS) {
    if (binding.section !== currentSection) {
      if (currentSection !== null) lines.push('');
      currentSection = binding.section;
      lines.push(truncateLine(binding.section, maxWidth));
    }
    const paddedKey = binding.keys.padEnd(keyColWidth, ' ');
    lines.push(truncateLine(`  ${paddedKey} ${binding.description}`, maxWidth));
  }

  return lines;
}
