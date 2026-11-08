import type { EventKind, EventRow } from '../../core/types.ts';

export interface TreeNode {
  ev: EventRow;
  parent: TreeNode | null;
  children: TreeNode[];
  /** Duration: the event's own, or for a turn the span to its last descendant. */
  duration: number | null;
  /** Tokens summed over the node and its descendants. */
  tokensIn: number;
  tokensOut: number;
  /** A tool call with an error result. */
  failed: boolean;
}

export interface Tree {
  roots: TreeNode[];
  byId: Map<string, TreeNode>;
}

export function buildTree(events: EventRow[]): Tree {
  const byId = new Map<string, TreeNode>();
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  for (const ev of sorted) byId.set(ev.id, { ev, parent: null, children: [], duration: ev.duration_ms, tokensIn: 0, tokensOut: 0, failed: false });
  const roots: TreeNode[] = [];
  for (const ev of sorted) {
    const n = byId.get(ev.id)!;
    const p = ev.parent_id ? byId.get(ev.parent_id) : undefined;
    // A parent seen later than the child (or missing) would hide it; attach such events at the root.
    if (p && p !== n) ((n.parent = p), p.children.push(n));
    else roots.push(n);
  }
  const agg = (n: TreeNode): number | null => {
    n.tokensIn = n.ev.tokens_in ?? 0;
    n.tokensOut = n.ev.tokens_out ?? 0;
    let lastTs = n.ev.ts;
    for (const c of n.children) {
      const t = agg(c);
      n.tokensIn += c.tokensIn;
      n.tokensOut += c.tokensOut;
      if (t != null && (lastTs == null || t > lastTs)) lastTs = t;
    }
    if (n.duration == null && n.children.length && n.ev.ts != null && lastTs != null) n.duration = lastTs - n.ev.ts || null;
    const end = n.ev.ts != null && n.ev.duration_ms != null ? n.ev.ts + n.ev.duration_ms : lastTs;
    return end != null && lastTs != null ? Math.max(end, lastTs) : (end ?? lastTs);
  };
  roots.forEach(agg);
  for (const n of byId.values()) if (n.ev.kind === 'tool_call') n.failed = n.children.some((c) => c.ev.kind === 'error');
  return { roots, byId };
}

export type ShowFilter = 'all' | 'errors' | 'reasoning' | 'text';

export const SHOW_KINDS: Record<Exclude<ShowFilter, 'all'>, EventKind[]> = {
  errors: ['error'],
  reasoning: ['reasoning'],
  text: ['text'],
};

export interface Row {
  node: TreeNode;
  depth: number;
  expanded: boolean;
  /** Has children that are shown in the tree (hidden ones do not count). */
  hasChildren: boolean;
}

// ---- noise: rows the tree leaves out ----

const KEEP_ATTACHMENTS = new Set(['queued_command']);

/** Attachment type of a Claude attachment meta event (the first line of its text). */
export const attachmentType = (ev: EventRow) => (ev.kind === 'meta' && ev.role === 'attachment' ? ev.text.split('\n')[0] : null);

/** Context Claude Code injected for the model (environment, date, hooks, listings): shown in the Context panel, not the trace. */
export function isContext(ev: EventRow): boolean {
  const t = attachmentType(ev);
  return t != null && !KEEP_ATTACHMENTS.has(t) && !/error|block|denied/.test(t);
}

const tag = (text: string, name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1];
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
const QUIT = new Set(['/exit', '/quit']);
const BYE = /^(goodbye|bye|see ya|catch you later)[!.]*$/i;

/** Claude Code wraps slash commands, `!` shell input and local output in XML tags; return readable text, or hidden. */
export function cleanUserText(text: string): { text: string; hidden: boolean } {
  const t = text.trim();
  if (!t.startsWith('<')) return { text, hidden: false };
  if (t.includes('<local-command-caveat>')) return { text: '', hidden: true };
  const name = tag(t, 'command-name');
  if (name != null) {
    const out = `${name.trim()} ${(tag(t, 'command-args') ?? '').trim()}`.trim();
    return { text: out, hidden: QUIT.has(name.trim()) };
  }
  const stdout = tag(t, 'local-command-stdout');
  if (stdout != null) {
    const out = stripAnsi(stdout).trim();
    return { text: out, hidden: !out || BYE.test(out) };
  }
  const bash = tag(t, 'bash-input');
  if (bash != null) return { text: `! ${bash.trim()}`, hidden: false };
  const bout = tag(t, 'bash-stdout');
  const berr = tag(t, 'bash-stderr');
  if (bout != null || berr != null) {
    const out = [bout, berr].map((x) => stripAnsi(x ?? '').trim()).filter(Boolean).join('\n');
    return { text: out, hidden: !out };
  }
  const summary = tag(t, 'summary');
  if (t.startsWith('<task-notification>') && summary != null) return { text: `Background task: ${summary.trim()}`, hidden: false };
  return { text, hidden: false };
}

/** A row the trace leaves out: results (shown with their tool call), empty thinking, injected context, bookkeeping. */
export function isNoise(n: TreeNode): boolean {
  const ev = n.ev;
  if ((ev.kind === 'tool_result' || ev.kind === 'error') && n.parent?.ev.kind === 'tool_call') return true;
  if (ev.kind === 'reasoning' && !ev.text.trim()) return true;
  if (isContext(ev)) return true;
  if (ev.kind === 'meta' && ev.role === 'system' && /^[a-z_]+$/.test(ev.text.trim())) return true; // bare subtype: turn_duration, stop_hook_summary
  if ((ev.kind === 'turn' || ev.kind === 'meta') && cleanUserText(ev.text).hidden) return true;
  return false;
}

/** The nearest node at or above `id` that the trace shows. */
export function visibleId(tree: Tree, id: string): string {
  let n = tree.byId.get(id);
  while (n && n.parent && isNoise(n)) n = n.parent;
  return n?.ev.id ?? id;
}

export interface FlattenOptions {
  show: ShowFilter;
  /** Explicit expand/collapse choices; others follow `collapseAll`. */
  expanded: Map<string, boolean>;
  collapseAll: boolean;
  /** Nodes whose ancestors must be open (search matches, selection). */
  reveal?: Iterable<string>;
}

export function flatten(tree: Tree, o: FlattenOptions): Row[] {
  const forced = new Set<string>();
  for (const id of o.reveal ?? []) for (let p = tree.byId.get(visibleId(tree, id))?.parent; p; p = p.parent) forced.add(p.ev.id);
  // A node is shown unless it is noise with nothing shown beneath it.
  const shown = new Map<TreeNode, boolean>();
  const isShown = (n: TreeNode): boolean => {
    let v = shown.get(n);
    if (v === undefined) shown.set(n, (v = !isNoise(n) || n.children.some(isShown)));
    return v;
  };
  let keep: Set<string> | null = null;
  if (o.show !== 'all') {
    const kinds = SHOW_KINDS[o.show];
    const k = new Set<string>();
    for (const n of tree.byId.values()) {
      if (!kinds.includes(n.ev.kind)) continue;
      for (let p: TreeNode | null = n; p && !k.has(p.ev.id); p = p.parent) k.add(p.ev.id);
    }
    keep = k;
  }
  const rows: Row[] = [];
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const n of nodes) {
      if ((keep && !keep.has(n.ev.id)) || !isShown(n)) continue;
      const hasChildren = n.children.some((c) => isShown(c) && (!keep || keep.has(c.ev.id)));
      const explicit = o.expanded.get(n.ev.id);
      const expanded = hasChildren && (forced.has(n.ev.id) || (explicit ?? (!o.collapseAll || keep !== null)));
      rows.push({ node: n, depth, expanded, hasChildren });
      if (expanded) walk(n.children, depth + 1);
    }
  };
  walk(tree.roots, 0);
  return rows;
}

/** Event ids whose text or tool name contains `q` (case-insensitive), in tree order, and the total occurrence count. */
export function findMatches(events: EventRow[], q: string): { ids: string[]; count: number } {
  const needle = q.trim().toLowerCase();
  if (!needle) return { ids: [], count: 0 };
  const ids: string[] = [];
  let count = 0;
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    const hay = `${e.tool_name ?? ''}\n${e.text}`.toLowerCase();
    let c = 0;
    for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) c++;
    if (c) (ids.push(e.id), (count += c));
  }
  return { ids, count };
}

/** Order match ids as they appear in the full (unfiltered, fully expanded) tree. */
export function treeOrder(tree: Tree, ids: string[]): string[] {
  const want = new Set(ids);
  const out: string[] = [];
  const walk = (ns: TreeNode[]) => ns.forEach((n) => (want.has(n.ev.id) && out.push(n.ev.id), walk(n.children)));
  walk(tree.roots);
  return out;
}

const firstLine = (s: string, max = 140) => {
  const l = s.split('\n').find((x) => x.trim()) ?? '';
  return l.length > max ? l.slice(0, max - 1) + '…' : l.trim();
};

/** One-line summary of an event for the tree. */
/** The shell command inside a Codex `exec` call (`text(await tools.exec_command({cmd:"..."}))`), unescaped. */
export function execCommand(text: string): string | null {
  const m = /exec_command\(\s*\{\s*"?cmd"?\s*:\s*("(?:[^"\\]|\\.)*")/.exec(text);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

export function hint(ev: EventRow): string {
  if (ev.kind === 'tool_call') {
    const cmd = execCommand(ev.text);
    if (cmd != null) return firstLine(cmd);
    try {
      const a = JSON.parse(ev.text);
      if (a && typeof a === 'object') {
        const v = a.description ?? a.command ?? a.CommandLine ?? a.cmd ?? a.file_path ?? a.Path ?? a.AbsolutePath ?? a.path ?? a.pattern ?? a.query ?? a.url ?? a.prompt ?? a.skill ?? Object.values(a).find((x) => typeof x === 'string');
        if (typeof v === 'string') return firstLine(v);
        if (Array.isArray(v)) return firstLine(v.join(' '));
      }
    } catch {
      /* not JSON: freeform input such as a patch or script */
    }
  }
  if (attachmentType(ev)) return firstLine(ev.text.split('\n').slice(1).join('\n')) || attachmentType(ev)!.replace(/_/g, ' ');
  if (ev.kind === 'turn' || ev.kind === 'meta') return firstLine(cleanUserText(ev.text).text) || `(${ev.kind})`;
  return firstLine(ev.text) || `(${ev.kind})`;
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000);
  return m < 60 ? `${m}m${Math.round((ms % 60_000) / 1000)}s` : `${Math.floor(m / 60)}h${m % 60}m`;
}

export function fmtTokens(n: number): string {
  if (!n) return '';
  return n < 1000 ? String(n) : n < 1e6 ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k` : `${(n / 1e6).toFixed(1)}M`;
}

/** Merge freshly fetched events into the current list by id (new rows replace old ones). */
export function mergeEvents(cur: EventRow[], fresh: EventRow[]): EventRow[] {
  if (!fresh.length) return cur;
  const idx = new Map(cur.map((e, i) => [e.id, i]));
  const out = cur.slice();
  for (const e of fresh) {
    const i = idx.get(e.id);
    if (i === undefined) out.push(e);
    else out[i] = e;
  }
  return out;
}
