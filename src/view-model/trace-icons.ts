import type { EventRow } from '../core/types.ts';

// All icons are single-cell, non-emoji glyphs so row width math stays exact.
const KIND_ICON: Record<EventRow['kind'], string> = {
  turn: '◉',
  reasoning: '∴',
  text: '●',
  tool_call: '◈',
  tool_result: '↳',
  error: '✕',
  meta: '·',
};

const TOOL_FAMILIES: Array<[icon: string, names: string[]]> = [
  ['$', ['bash', 'shell', 'exec', 'exec_command', 'run_command', 'run_shell_command', 'local_shell', 'bashoutput', 'killshell']],
  ['✎', ['edit', 'multiedit', 'write', 'notebookedit', 'apply_patch', 'write_file', 'replace', 'edit_file', 'write_to_file', 'replace_file_content']],
  ['≡', ['read', 'read_file', 'view_file', 'read_many_files', 'notebookread']],
  ['⌕', ['grep', 'glob', 'ls', 'list_dir', 'list_directory', 'search_file_content', 'grep_search', 'find_by_name', 'toolsearch']],
  ['◍', ['webfetch', 'websearch', 'web_fetch', 'web_search', 'google_web_search', 'read_url_content', 'search_web']],
  ['⧉', ['agent', 'task', 'sendmessage', 'spawn_agent']],
  ['☐', ['todowrite', 'update_plan', 'write_todos', 'taskcreate', 'taskupdate']],
];

const TOOL_ICON = new Map<string, string>(
  TOOL_FAMILIES.flatMap(([icon, names]) => names.map((n) => [n, icon] as const)),
);

export function traceIcon(kind: EventRow['kind'], toolName: string | null | undefined): string {
  if (kind === 'tool_call' && toolName) {
    const icon = TOOL_ICON.get(toolName.toLowerCase());
    if (icon) return icon;
  }
  return KIND_ICON[kind] ?? '·';
}
