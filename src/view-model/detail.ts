import type { EventRow } from '../core/types.ts';
import { hasAnsi, parseAnsi, type AnsiSpan } from './ansi.ts';
import { lineDiff, looksLikeDiff, parseUnified, type DiffLine } from './diff.ts';
import { looksLikeMarkdown } from './markdown.ts';
import { cleanUserText, execCommand, fmtDuration, fmtTokens, type TreeNode } from './tree.ts';

export const COLLAPSE_LINES = 40;

const ALIASES: Record<string, string> = {
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  yml: 'yaml',
  md: 'markdown',
  rs: 'rust',
  rb: 'ruby',
};

const EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  py: 'python',
  rs: 'rust',
  go: 'go',
  rb: 'ruby',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  json: 'json',
  md: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  html: 'html',
  css: 'css',
  sql: 'sql',
  lua: 'lua',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  nix: 'nix',
  dockerfile: 'docker',
};

export function resolveLang(lang?: string | null): string | null {
  if (!lang) return null;
  const l = lang.toLowerCase();
  return ALIASES[l] ?? l;
}

export function langForPath(p?: string | null): string | null {
  if (!p) return null;
  const base = p.split('/').pop() ?? '';
  if (/^Dockerfile|Containerfile/.test(base)) return 'docker';
  const ext = base.split('.').pop() ?? '';
  return resolveLang(EXT[ext] ?? null);
}

/** Format DiffLine[] as a standard unified diff string for DiffRenderable. */
export function lineDiffToUnifiedString(lines: DiffLine[], title?: string): string {
  const out: string[] = [];
  if (title) {
    out.push(`--- a/${title}`);
    out.push(`+++ b/${title}`);
  } else {
    out.push('--- a/file');
    out.push('+++ b/file');
  }
  for (const l of lines) {
    if (l.type === 'file') continue;
    if (l.type === 'hunk') out.push(l.text);
    else if (l.type === 'add') out.push(`+${l.text}`);
    else if (l.type === 'del') out.push(`-${l.text}`);
    else out.push(` ${l.text}`);
  }
  return out.join('\n');
}

export type DetailBlock =
  | { kind: 'heading'; text: string; tone?: 'normal' | 'error' }
  | { kind: 'markdown'; text: string; raw: boolean }
  | { kind: 'code'; code: string; lang: string | null; title?: string }
  | { kind: 'diff'; diffText: string; lines: DiffLine[]; title?: string }
  | { kind: 'ansi'; text: string; spans: AnsiSpan[] }
  | { kind: 'text'; text: string }
  | { kind: 'empty'; text: string };

export interface DetailModel {
  title: string;
  kind: EventRow['kind'];
  ts: number | null;
  durationText: string;
  tokensText: string;
  failed: boolean;
  canToggleRaw: boolean;
  rawMode: boolean;
  hasCollapsibleOutput: boolean;
  totalOutputLines: number;
  outputExpanded: boolean;
  imageEventIds: string[];
  blocks: DetailBlock[];
}

export type ImageRef =
  | { kind: 'base64'; mimeType: string; data: string; alt: string; location: string }
  | { kind: 'uri'; mimeType: string; uri: string; alt: string; location: string };

function parseArgs(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stepLabel(ev: EventRow): string {
  if (ev.kind === 'tool_call') return ev.tool_name ?? 'tool call';
  if (ev.kind === 'turn') {
    const t = ev.text.trim();
    if (/^<(command-name|command-message)>/.test(t)) return 'Slash command';
    if (t.startsWith('<bash-')) return 'Shell (!)';
    return 'User prompt';
  }
  if (ev.kind === 'tool_result') return 'Tool result';
  return (
    {
      reasoning: 'Reasoning',
      text: 'Model text',
      error: 'Error',
      meta: ev.role ? `Meta · ${ev.role}` : 'Meta',
    }[ev.kind] ?? ev.kind
  );
}

function buildToolArgBlocks(ev: EventRow): DetailBlock[] {
  const a = parseArgs(ev.text);
  const tool = ev.tool_name ?? '';
  if (a) {
    const file = (a.file_path ?? a.path ?? a.AbsolutePath ?? a.TargetFile) as string | undefined;
    if (typeof a.old_string === 'string' && typeof a.new_string === 'string') {
      const lines = lineDiff(a.old_string, a.new_string);
      return [
        {
          kind: 'diff',
          title: file,
          lines,
          diffText: lineDiffToUnifiedString(lines, file),
        },
      ];
    }
    if (Array.isArray(a.edits) && a.edits.every((e: unknown) => typeof (e as { old_string?: unknown })?.old_string === 'string')) {
      return a.edits.map((e: { old_string: string; new_string?: string }, i: number) => {
        const title = `${file ?? ''} · edit ${i + 1}`;
        const lines = lineDiff(e.old_string, e.new_string ?? '');
        return {
          kind: 'diff' as const,
          title,
          lines,
          diffText: lineDiffToUnifiedString(lines, file),
        };
      });
    }
    if (typeof a.content === 'string' && file) {
      return [{ kind: 'code', code: a.content, lang: langForPath(file), title: file }];
    }
    const cmd = a.command ?? a.CommandLine ?? a.cmd;
    if (typeof cmd === 'string' || Array.isArray(cmd)) {
      const rest = Object.fromEntries(
        Object.entries(a).filter(([k]) => !['command', 'CommandLine', 'cmd'].includes(k)),
      );
      const blocks: DetailBlock[] = [
        { kind: 'code', code: Array.isArray(cmd) ? cmd.join(' ') : cmd, lang: 'bash' },
      ];
      if (Object.keys(rest).length > 0) {
        blocks.push({ kind: 'code', code: JSON.stringify(rest, null, 2), lang: 'json' });
      }
      return blocks;
    }
    const patch = a.patch ?? a.input;
    if (typeof patch === 'string' && looksLikeDiff(patch)) {
      return [{ kind: 'diff', lines: parseUnified(patch), diffText: patch }];
    }
    if (typeof a.prompt === 'string' && Object.keys(a).length <= 4) {
      return [
        { kind: 'code', code: JSON.stringify({ ...a, prompt: undefined }, null, 2), lang: 'json' },
        { kind: 'markdown', text: a.prompt, raw: false },
      ];
    }
    return [{ kind: 'code', code: JSON.stringify(a, null, 2), lang: 'json' }];
  }

  if (looksLikeDiff(ev.text)) {
    return [{ kind: 'diff', lines: parseUnified(ev.text), diffText: ev.text }];
  }
  const cmd = execCommand(ev.text);
  if (cmd != null) return [{ kind: 'code', code: cmd, lang: 'bash' }];
  if (tool === 'exec' || tool === 'js') return [{ kind: 'code', code: ev.text, lang: 'javascript' }];
  return [{ kind: 'code', code: ev.text, lang: tool === 'shell' ? 'bash' : null }];
}

function buildOutputBlocks(
  text: string,
  opts: { rawMode: boolean; outputExpanded: boolean; findQuery?: string },
): {
  blocks: DetailBlock[];
  canToggleRaw: boolean;
  hasCollapsibleOutput: boolean;
  totalOutputLines: number;
  outputExpanded: boolean;
} {
  if (!text) {
    return {
      blocks: [{ kind: 'empty', text: '(no output)' }],
      canToggleRaw: false,
      hasCollapsibleOutput: false,
      totalOutputLines: 0,
      outputExpanded: opts.outputExpanded,
    };
  }
  const trimmed = text.trim();
  let json: string | null = null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      json = JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      json = null;
    }
  }

  const sourceText = json ?? text;
  const lines = sourceText.split('\n');
  const totalOutputLines = lines.length;
  const hasCollapsibleOutput = totalOutputLines > COLLAPSE_LINES;
  const q = opts.findQuery?.trim();
  const matchInHiddenTail = Boolean(
    q &&
      hasCollapsibleOutput &&
      !opts.outputExpanded &&
      lines.slice(COLLAPSE_LINES).join('\n').toLowerCase().includes(q.toLowerCase()),
  );
  const effectiveExpanded = opts.outputExpanded || matchInHiddenTail;
  const collapsed = hasCollapsibleOutput && !effectiveExpanded;
  const shown = collapsed ? lines.slice(0, COLLAPSE_LINES).join('\n') : sourceText;
  const md = !json && looksLikeMarkdown(text);

  if (json) {
    return {
      blocks: [{ kind: 'code', code: shown, lang: 'json' }],
      canToggleRaw: false,
      hasCollapsibleOutput,
      totalOutputLines,
      outputExpanded: effectiveExpanded,
    };
  }
  if (looksLikeDiff(text)) {
    return {
      blocks: [{ kind: 'diff', lines: parseUnified(shown), diffText: shown }],
      canToggleRaw: false,
      hasCollapsibleOutput,
      totalOutputLines,
      outputExpanded: effectiveExpanded,
    };
  }
  if (md) {
    return {
      blocks: [{ kind: 'markdown', text: shown, raw: opts.rawMode }],
      canToggleRaw: true,
      hasCollapsibleOutput,
      totalOutputLines,
      outputExpanded: effectiveExpanded,
    };
  }
  if (hasAnsi(text)) {
    return {
      blocks: [{ kind: 'ansi', text: shown, spans: parseAnsi(shown) }],
      canToggleRaw: false,
      hasCollapsibleOutput,
      totalOutputLines,
      outputExpanded: effectiveExpanded,
    };
  }
  return {
    blocks: [{ kind: 'text', text: shown }],
    canToggleRaw: false,
    hasCollapsibleOutput,
    totalOutputLines,
    outputExpanded: effectiveExpanded,
  };
}

/** Build the pure detail-pane view model for a selected TreeNode. */
export function buildDetailModel(
  node: TreeNode | null,
  opts: { rawMode: boolean; outputExpanded: boolean; findQuery?: string },
): DetailModel {
  if (!node) {
    return {
      title: 'No step selected',
      kind: 'meta',
      ts: null,
      durationText: '',
      tokensText: '',
      failed: false,
      canToggleRaw: false,
      rawMode: opts.rawMode,
      hasCollapsibleOutput: false,
      totalOutputLines: 0,
      outputExpanded: opts.outputExpanded,
      imageEventIds: [],
      blocks: [{ kind: 'empty', text: 'Select a step in the trace.' }],
    };
  }

  const ev = node.ev;
  const totalTokens = node.tokensIn + node.tokensOut;
  const base: Omit<DetailModel, 'blocks' | 'canToggleRaw' | 'hasCollapsibleOutput' | 'totalOutputLines' | 'imageEventIds'> = {
    title: stepLabel(ev),
    kind: ev.kind,
    ts: ev.ts,
    durationText: fmtDuration(node.duration),
    tokensText: totalTokens > 0 ? `${fmtTokens(totalTokens)} tok` : '',
    failed: node.failed,
    rawMode: opts.rawMode,
    outputExpanded: opts.outputExpanded,
  };

  if (ev.kind === 'text' || ev.kind === 'reasoning') {
    return {
      ...base,
      canToggleRaw: true,
      hasCollapsibleOutput: false,
      totalOutputLines: 0,
      imageEventIds: [ev.id],
      blocks: [{ kind: 'markdown', text: ev.text, raw: opts.rawMode }],
    };
  }

  if (ev.kind === 'turn') {
    const cleaned = cleanUserText(ev.text);
    if (cleaned.text === ev.text) {
      return {
        ...base,
        canToggleRaw: true,
        hasCollapsibleOutput: false,
        totalOutputLines: 0,
        imageEventIds: [ev.id],
        blocks: [{ kind: 'markdown', text: ev.text, raw: opts.rawMode }],
      };
    }
    const out = buildOutputBlocks(cleaned.text, opts);
    return { ...base, ...out, imageEventIds: [ev.id] };
  }

  if (ev.kind === 'tool_call') {
    const results = node.children.filter((c) => c.ev.kind === 'tool_result' || c.ev.kind === 'error');
    const blocks: DetailBlock[] = [{ kind: 'heading', text: 'Input' }, ...buildToolArgBlocks(ev)];
    let canToggleRaw = false;
    let hasCollapsibleOutput = false;
    let totalOutputLines = 0;
    let outputExpanded = opts.outputExpanded;

    for (const r of results) {
      blocks.push({
        kind: 'heading',
        text: r.ev.kind === 'error' ? 'Error' : 'Output',
        tone: r.ev.kind === 'error' ? 'error' : 'normal',
      });
      const out = buildOutputBlocks(r.ev.text, opts);
      blocks.push(...out.blocks);
      if (out.canToggleRaw) canToggleRaw = true;
      if (out.hasCollapsibleOutput) {
        hasCollapsibleOutput = true;
        totalOutputLines = Math.max(totalOutputLines, out.totalOutputLines);
      }
      if (out.outputExpanded) outputExpanded = true;
    }

    return {
      ...base,
      outputExpanded,
      canToggleRaw,
      hasCollapsibleOutput,
      totalOutputLines,
      imageEventIds: [ev.id, ...results.map((r) => r.ev.id)],
      blocks,
    };
  }

  const text = ev.kind === 'tool_result' || ev.kind === 'error' ? ev.text : cleanUserText(ev.text).text;
  const out = buildOutputBlocks(text, opts);
  return { ...base, ...out, imageEventIds: [ev.id] };
}

/** Extract Claude base64 images and Antigravity media URIs from a raw transcript JSON record. */
export function extractImageRefs(rawJson: string | null): ImageRef[] {
  if (!rawJson || (!rawJson.includes('"image') && !rawJson.includes('"media"'))) return [];
  try {
    const d = JSON.parse(rawJson) as Record<string, unknown>;
    const out: ImageRef[] = [];
    const visit = (v: unknown) => {
      if (!v || typeof v !== 'object') return;
      if (Array.isArray(v)) {
        v.forEach(visit);
        return;
      }
      const rec = v as Record<string, unknown>;
      const src = rec.source as Record<string, unknown> | undefined;
      if (
        rec.type === 'image' &&
        src?.type === 'base64' &&
        typeof src.data === 'string' &&
        typeof src.media_type === 'string'
      ) {
        out.push({
          kind: 'base64',
          mimeType: src.media_type,
          data: src.data,
          alt: 'embedded image',
          location: 'embedded image',
        });
      }
      for (const k of Object.keys(rec)) {
        if (k !== 'toolUseResult') visit(rec[k]);
      }
    };
    const msg = d.message as Record<string, unknown> | undefined;
    visit(msg?.content ?? d);

    if (Array.isArray(d.media)) {
      for (const m of d.media as Array<Record<string, unknown>>) {
        if (
          typeof m?.uri === 'string' &&
          typeof m?.mime_type === 'string' &&
          m.mime_type.startsWith('image/')
        ) {
          out.push({
            kind: 'uri',
            mimeType: m.mime_type,
            uri: m.uri,
            alt: m.uri.split('/').pop() || m.uri,
            location: m.uri,
          });
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}
