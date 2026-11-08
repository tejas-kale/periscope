import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { EventRow, SessionRow } from '../../core/types.ts';
import { api } from '../api.ts';
import { buildTree, findMatches, flatten, fmtDuration, fmtTokens, hint, mergeEvents, treeOrder, type ShowFilter, type Tree } from '../lib/tree.ts';
import { useHighlight } from '../useHighlight.ts';
import { Detail } from './Detail.tsx';
import { AgentBadge, HostMarker, KindIcon, LiveDot } from './Icons.tsx';

const ROW_H = 26;
/** On a live update, re-fetch this many recent events too, to pick up patched durations and tokens. */
const REFETCH_WINDOW = 200;

function Stats({ tree, events }: { tree: Tree; events: EventRow[] }) {
  const s = useMemo(() => {
    const kinds: Record<string, number> = {};
    const tools = new Map<string, { n: number; ms: number; err: number }>();
    let tin = 0;
    let tout = 0;
    for (const e of events) {
      kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
      tin += e.tokens_in ?? 0;
      tout += e.tokens_out ?? 0;
      if (e.kind === 'tool_call') {
        const t = tools.get(e.tool_name ?? '?') ?? { n: 0, ms: 0, err: 0 };
        t.n++;
        t.ms += e.duration_ms ?? 0;
        if (tree.byId.get(e.id)?.children.some((c) => c.ev.kind === 'error')) t.err++;
        tools.set(e.tool_name ?? '?', t);
      }
    }
    const ts = events.map((e) => e.ts).filter((t): t is number => t != null);
    const span = ts.length ? Math.max(...ts) - Math.min(...ts) : null;
    return { kinds, tools: [...tools.entries()].sort((a, b) => b[1].n - a[1].n), tin, tout, span };
  }, [tree, events]);
  return (
    <div className="stats">
      <div className="stat-row">
        <span>Span {fmtDuration(s.span)}</span>
        <span>Turns {s.kinds.turn ?? 0}</span>
        <span>Tool calls {s.kinds.tool_call ?? 0}</span>
        <span className="err">Errors {s.kinds.error ?? 0}</span>
        <span>Tokens in {fmtTokens(s.tin) || 0}</span>
        <span>out {fmtTokens(s.tout) || 0}</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Tool</th>
            <th>Calls</th>
            <th>Errors</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          {s.tools.slice(0, 12).map(([name, t]) => (
            <tr key={name}>
              <td>{name}</td>
              <td>{t.n}</td>
              <td>{t.err || ''}</td>
              <td>{fmtDuration(t.ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SessionView({ session, focusEvent, initialQuery, changeTick }: { session: SessionRow; focusEvent?: string; initialQuery?: string; changeTick: number }) {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [show, setShow] = useState<ShowFilter>('all');
  const [collapseAll, setCollapseAll] = useState(false);
  const [expanded, setExpanded] = useState<Map<string, boolean>>(new Map());
  const [stats, setStats] = useState(false);
  const [follow, setFollow] = useState(false);
  const [searchOpen, setSearchOpen] = useState(!!initialQuery);
  const [query, setQuery] = useState(initialQuery ?? '');
  const [matchIdx, setMatchIdx] = useState(0);
  const loadedFor = useRef<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Load all events when the session changes; then only the tail on live updates.
  useEffect(() => {
    let live = true;
    loadedFor.current = null;
    setEvents([]);
    setSelected(focusEvent ?? null);
    setExpanded(new Map());
    void api()
      .getEvents(session.id)
      .then((evs) => {
        if (!live) return;
        setEvents(evs);
        loadedFor.current = session.id;
        if (!focusEvent && evs.length) setSelected(evs[0].id);
      });
    return () => {
      live = false;
    };
  }, [session.id]);

  useEffect(() => {
    if (focusEvent) setSelected(focusEvent);
    if (initialQuery) (setQuery(initialQuery), setSearchOpen(true));
  }, [focusEvent, initialQuery]);

  useEffect(() => {
    if (loadedFor.current !== session.id || changeTick === 0) return;
    const maxSeq = events.length ? events[events.length - 1].seq : -1;
    void api()
      .getEvents(session.id, maxSeq - REFETCH_WINDOW)
      .then((fresh) => loadedFor.current === session.id && setEvents((cur) => mergeEvents(cur, fresh)));
  }, [changeTick]);

  const tree = useMemo(() => buildTree(events), [events]);
  const matches = useMemo(() => {
    const m = findMatches(events, searchOpen ? query : '');
    return { ...m, ids: treeOrder(tree, m.ids) };
  }, [events, tree, query, searchOpen]);
  const current = matches.ids.length ? matches.ids[Math.min(matchIdx, matches.ids.length - 1)] : null;
  const reveal = useMemo(() => [...matches.ids, ...(selected ? [selected] : [])], [matches.ids, selected]);
  const rows = useMemo(() => flatten(tree, { show, expanded, collapseAll, reveal }), [tree, show, expanded, collapseAll, reveal]);
  const rowIndex = useMemo(() => new Map(rows.map((r, i) => [r.node.ev.id, i])), [rows]);
  const matchSet = useMemo(() => new Set(matches.ids), [matches.ids]);

  const parentRef = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: () => ROW_H, overscan: 20 });

  const select = useCallback(
    (id: string | null, scroll = true) => {
      setSelected(id);
      if (scroll && id != null) {
        const i = rowIndex.get(id);
        if (i != null) virt.scrollToIndex(i, { align: 'auto' });
      }
    },
    [rowIndex, virt],
  );

  // Jump to the current search match.
  useEffect(() => {
    if (current) select(current);
  }, [current]);
  useEffect(() => setMatchIdx(0), [query]);

  // Keep the selected row in view once the tree has rows for it (e.g. after opening from a search hit).
  useEffect(() => {
    if (selected && rowIndex.has(selected)) virt.scrollToIndex(rowIndex.get(selected)!, { align: 'auto' });
  }, [selected && rowIndex.has(selected)]);

  // Follow: stick to the newest event.
  useEffect(() => {
    if (!follow || !rows.length) return;
    const last = rows[rows.length - 1].node.ev.id;
    setSelected(last);
    virt.scrollToIndex(rows.length - 1, { align: 'end' });
  }, [follow, rows.length, events.length]);

  const toggle = (id: string, isOpen: boolean) => setExpanded((m) => new Map(m).set(id, !isOpen));

  const step = (d: number) => {
    if (!matches.ids.length) return;
    setMatchIdx((i) => (i + d + matches.ids.length) % matches.ids.length);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchRef.current?.select(), 0);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        step(e.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const onTreeKey = (e: React.KeyboardEvent) => {
    const i = selected ? rowIndex.get(selected) : undefined;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = i == null ? 0 : Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
      if (rows[next]) select(rows[next].node.ev.id);
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && i != null) {
      const r = rows[i];
      if (r.node.children.length && r.expanded === (e.key === 'ArrowLeft')) toggle(r.node.ev.id, r.expanded);
      else if (e.key === 'ArrowLeft' && r.node.parent) select(r.node.parent.ev.id);
    }
  };

  const treeRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const hq = searchOpen ? query : '';
  useHighlight(treeRef, 'search-tree', hq, [rows, virt.getVirtualItems().length]);
  useHighlight(detailRef, 'search-detail', hq, [selected, events]);

  const selNode = selected ? tree.byId.get(selected) ?? null : null;

  return (
    <section className="session-view">
      <header className="sv-head">
        <div className="sv-title">
          {session.status === 'live' && <LiveDot />}
          <h2>{session.title || session.id}</h2>
          <AgentBadge agent={session.agent} />
          <HostMarker host={session.host} />
          <span className="sv-cwd" title={session.source_path}>
            {session.cwd}
          </span>
        </div>
        <div className="toolbar">
          <label>
            Show
            <select value={show} onChange={(e) => setShow(e.target.value as ShowFilter)}>
              <option value="all">All</option>
              <option value="errors">Errors</option>
              <option value="reasoning">Reasoning</option>
              <option value="text">Model text</option>
            </select>
          </label>
          <button className={collapseAll ? 'on' : ''} onClick={() => (setCollapseAll(!collapseAll), setExpanded(new Map()))}>
            Collapse
          </button>
          <button className={stats ? 'on' : ''} onClick={() => setStats(!stats)}>
            Stats
          </button>
          <button className={follow ? 'on' : ''} onClick={() => setFollow(!follow)} title="Stick to the newest event">
            Follow
          </button>
          <button onClick={() => (setSearchOpen(true), setTimeout(() => searchRef.current?.select(), 0))} title="Find in session (⌘F)">
            Find
          </button>
        </div>
        {searchOpen && (
          <div className="find">
            <input
              ref={searchRef}
              autoFocus
              placeholder="Find in session"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') step(e.shiftKey ? -1 : 1);
                if (e.key === 'Escape') (setSearchOpen(false), setQuery(''));
              }}
            />
            <span className="find-count">{query.trim() ? `${matches.ids.length ? Math.min(matchIdx, matches.ids.length - 1) + 1 : 0} / ${matches.ids.length} steps · ${matches.count} hits` : ''}</span>
            <button onClick={() => step(-1)} title="Previous (⇧Enter)">
              ↑
            </button>
            <button onClick={() => step(1)} title="Next (Enter)">
              ↓
            </button>
            <button onClick={() => (setSearchOpen(false), setQuery(''))} title="Close (Esc)">
              ✕
            </button>
          </div>
        )}
        {stats && <Stats tree={tree} events={events} />}
      </header>
      <div className="sv-body">
        <div className="tree" ref={parentRef} tabIndex={0} onKeyDown={onTreeKey}>
          <div ref={treeRef} style={{ height: virt.getTotalSize(), position: 'relative' }}>
            {virt.getVirtualItems().map((vi) => {
              const r = rows[vi.index];
              const ev = r.node.ev;
              return (
                <div
                  key={ev.id}
                  className={`row k-${ev.kind} ${ev.id === selected ? 'sel' : ''} ${matchSet.has(ev.id) ? 'match' : ''}`}
                  style={{ transform: `translateY(${vi.start}px)`, height: ROW_H, paddingLeft: 8 + r.depth * 16 }}
                  onClick={() => select(ev.id, false)}
                >
                  <span
                    className={`twisty ${r.node.children.length ? '' : 'none'}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (r.node.children.length) toggle(ev.id, r.expanded);
                    }}
                  >
                    {r.node.children.length ? (r.expanded ? '▾' : '▸') : ''}
                  </span>
                  <KindIcon kind={ev.kind} />
                  {ev.kind === 'tool_call' && <span className="tool-name">{ev.tool_name}</span>}
                  <span className="hint">{hint(ev)}</span>
                  <span className="row-meta">
                    {r.node.duration != null && <span>{fmtDuration(r.node.duration)}</span>}
                    {r.node.tokensOut > 0 && <span>{fmtTokens(r.node.tokensIn + r.node.tokensOut)}</span>}
                  </span>
                </div>
              );
            })}
          </div>
          {events.length === 0 && <div className="empty">Loading…</div>}
        </div>
        <div className="detail-wrap" ref={detailRef}>
          <Detail node={selNode} />
        </div>
      </div>
    </section>
  );
}
