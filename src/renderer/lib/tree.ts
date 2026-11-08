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
}

export interface Tree {
  roots: TreeNode[];
  byId: Map<string, TreeNode>;
}

export function buildTree(events: EventRow[]): Tree {
  const byId = new Map<string, TreeNode>();
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  for (const ev of sorted) byId.set(ev.id, { ev, parent: null, children: [], duration: ev.duration_ms, tokensIn: 0, tokensOut: 0 });
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
  for (const id of o.reveal ?? []) for (let p = tree.byId.get(id)?.parent; p; p = p.parent) forced.add(p.ev.id);
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
      if (keep && !keep.has(n.ev.id)) continue;
      const explicit = o.expanded.get(n.ev.id);
      const expanded = n.children.length > 0 && (forced.has(n.ev.id) || (explicit ?? (!o.collapseAll || keep !== null)));
      rows.push({ node: n, depth, expanded });
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
export function hint(ev: EventRow): string {
  if (ev.kind === 'tool_call') {
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
  if (ev.kind === 'reasoning' && !ev.text.trim()) return '(thinking not recorded)';
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
