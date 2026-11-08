import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { EventRow, SessionRow } from '../../core/types.ts';
import { api } from '../api.ts';
import { buildTree, findMatches, flatten, fmtDuration, fmtTokens, hint, isContext, mergeEvents, treeOrder, visibleId, type ShowFilter, type Tree } from '../lib/tree.ts';
import { useHighlight } from '../useHighlight.ts';
import { ContextPanel, Detail } from './Detail.tsx';
import { AgentBadge, Chevron, HostMarker, KindIcon, LiveDot } from './Icons.tsx';
import { isTyping } from '../keys.ts';

const ROW_H = 28;
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
  const [showContext, setShowContext] = useState(false);
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
    // A match inside a folded-away row (a tool result) counts as a match on the row that shows it.
    return { ...m, ids: [...new Set(treeOrder(tree, m.ids).map((id) => visibleId(tree, id)))] };
  }, [events, tree, query, searchOpen]);
  const current = matches.ids.length ? matches.ids[Math.min(matchIdx, matches.ids.length - 1)] : null;
  const sel = selected ? visibleId(tree, selected) : null;
  const reveal = useMemo(() => [...matches.ids, ...(sel ? [sel] : [])], [matches.ids, sel]);
  const rows = useMemo(() => flatten(tree, { show, expanded, collapseAll, reveal }), [tree, show, expanded, collapseAll, reveal]);
  const rowIndex = useMemo(() => new Map(rows.map((r, i) => [r.node.ev.id, i])), [rows]);
  const matchSet = useMemo(() => new Set(matches.ids), [matches.ids]);

  const parentRef = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: () => ROW_H, overscan: 20 });

  const select = useCallback(
    (id: string | null, scroll = true) => {
      setSelected(id);
      if (scroll && id != null) {
        const i = rowIndex.get(visibleId(tree, id));
        if (i != null) virt.scrollToIndex(i, { align: 'auto' });
      }
    },
    [rowIndex, virt, tree],
  );

  // Jump to the current search match.
  useEffect(() => {
    if (current) select(current);
  }, [current]);
  useEffect(() => setMatchIdx(0), [query]);

  // Keep the selected row in view once the tree has rows for it (e.g. after opening from a search hit).
  useEffect(() => {
    if (sel && rowIndex.has(sel)) virt.scrollToIndex(rowIndex.get(sel)!, { align: 'auto' });
  }, [sel && rowIndex.has(sel)]);

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

  const contextEvents = useMemo(() => events.filter((e) => isContext(e)), [events]);
  const toggleCollapseAll = () => (setCollapseAll(!collapseAll), setExpanded(new Map()));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchRef.current?.select(), 0);
      } else if (mod && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        step(e.shiftKey ? -1 : 1);
      } else if (!mod && !e.altKey && !isTyping(e)) {
        const k = e.key;
        if (k === 'c') toggleCollapseAll();
        else if (k === 's') setStats((v) => !v);
        else if (k === 'f') setFollow((v) => !v);
        else if (k === 'i') setShowContext((v) => !v);
        else return;
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const onTreeKey = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const i = sel ? rowIndex.get(sel) : undefined;
    const k = { j: 'ArrowDown', k: 'ArrowUp', h: 'ArrowLeft', l: 'ArrowRight' }[e.key] ?? e.key;
    const go = (n: number) => rows[n] && select(rows[n].node.ev.id);
    if (k === 'ArrowDown' || k === 'ArrowUp') go(i == null ? 0 : Math.max(0, Math.min(rows.length - 1, i + (k === 'ArrowDown' ? 1 : -1))));
    else if (k === 'g') go(0);
    else if (k === 'G') go(rows.length - 1);
    else if (k === 'PageDown' || k === 'PageUp') go(Math.max(0, Math.min(rows.length - 1, (i ?? 0) + (k === 'PageDown' ? 20 : -20))));
    else if (k === ' ' && i != null) rows[i].hasChildren && toggle(rows[i].node.ev.id, rows[i].expanded);
    else if (k === 'Enter') document.getElementById('detail')?.focus();
    else if ((k === 'ArrowLeft' || k === 'ArrowRight') && i != null) {
      const r = rows[i];
      if (r.hasChildren && r.expanded === (k === 'ArrowLeft')) toggle(r.node.ev.id, r.expanded);
      else if (k === 'ArrowLeft' && r.node.parent) select(visibleId(tree, r.node.parent.ev.id));
    } else return;
    e.preventDefault();
  };

  const onDetailKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const el = e.currentTarget;
    if (e.key === 'j') el.scrollBy({ top: 80 });
    else if (e.key === 'k') el.scrollBy({ top: -80 });
    else if (e.key === 'Escape' || e.key === 'h') document.getElementById('trace')?.focus();
    else return;
    e.preventDefault();
  };

  const treeRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const hq = searchOpen ? query : '';
  useHighlight(treeRef, 'search-tree', hq, [rows, virt.getVirtualItems().length]);
  useHighlight(detailRef, 'search-detail', hq, [sel, events]);

  const selNode = sel ? tree.byId.get(sel) ?? null : null;

  return (
    <section className="session-view">
      <header className="sv-head">
        <div className="sv-title">
          <LiveDot status={session.status} />
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
          <button className={collapseAll ? 'on' : ''} onClick={toggleCollapseAll} title="Collapse all (C)">
            Collapse
          </button>
          <button className={stats ? 'on' : ''} onClick={() => setStats(!stats)} title="Stats (S)">
            Stats
          </button>
          {contextEvents.length > 0 && (
            <button className={showContext ? 'on' : ''} onClick={() => setShowContext(!showContext)} title="What Claude Code added to the model's context: environment, date, model, hooks, listings (I)">
              Context
            </button>
          )}
          <button className={follow ? 'on' : ''} onClick={() => setFollow(!follow)} title="Stick to the newest event (F)">
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
        {showContext && <ContextPanel events={contextEvents} />}
      </header>
      <div className="sv-body">
        <div className="tree" id="trace" ref={parentRef} tabIndex={0} onKeyDown={onTreeKey}>
          <div ref={treeRef} style={{ height: virt.getTotalSize(), position: 'relative' }}>
            {virt.getVirtualItems().map((vi) => {
              const r = rows[vi.index];
              const ev = r.node.ev;
              return (
                <div
                  key={ev.id}
                  className={`row k-${ev.kind} ${ev.id === sel ? 'sel' : ''} ${matchSet.has(ev.id) ? 'match' : ''} ${r.node.failed ? 'failed' : ''}`}
                  style={{ transform: `translateY(${vi.start}px)`, height: ROW_H, paddingLeft: 8 + r.depth * 16 }}
                  onClick={() => select(ev.id, false)}
                >
                  {r.hasChildren ? (
                    <button
                      className="twisty"
                      tabIndex={-1}
                      title={r.expanded ? 'Collapse (← or Space)' : 'Expand (→ or Space)'}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(ev.id, r.expanded);
                      }}
                    >
                      <Chevron open={r.expanded} />
                    </button>
                  ) : (
                    <span className="twisty none" />
                  )}
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
        <div className="detail-wrap" id="detail" ref={detailRef} tabIndex={0} onKeyDown={onDetailKey}>
          <Detail node={selNode} />
        </div>
      </div>
    </section>
  );
}
