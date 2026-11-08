import { useEffect, useMemo, useRef, useState } from 'react';
import type { SandboxState, SearchHit, SessionFilter, SessionRow } from '../../core/types.ts';
import { AgentBadge, Chevron, HostMarker, LiveDot } from './Icons.tsx';
import { isTyping } from '../keys.ts';

const OPEN_GROUPS = 3;
const PAGE = 4;

export function relTime(ms: number | null): string {
  if (!ms) return '';
  const d = Date.now() - ms;
  if (d < 60_000) return 'now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`;
  if (d < 7 * 86_400_000) return `${Math.floor(d / 86_400_000)}d`;
  return new Date(ms).toLocaleDateString();
}

function Snippet({ text }: { text: string }) {
  const parts = text.split(/(\u0001[^\u0002]*\u0002)/);
  return (
    <span className="snippet">
      {parts.map((p, i) => (p.startsWith('\u0001') ? <mark key={i}>{p.slice(1, -1)}</mark> : p))}
    </span>
  );
}

function SessionItem({ s, active, cursor, onClick, children }: { s: SessionRow; active: boolean; cursor: boolean; onClick: () => void; children?: React.ReactNode }) {
  return (
    <li className={`session ${active ? 'active' : ''} ${cursor ? 'cursor' : ''}`} data-key={`s:${s.id}`} onClick={onClick} title={s.cwd ?? s.source_path}>
      <div className="session-line">
        {s.status === 'live' && <LiveDot />}
        <span className="session-title">{s.title || s.id}</span>
        <span className="session-time">{relTime(s.updated_at)}</span>
      </div>
      <div className="session-sub">
        <AgentBadge agent={s.agent} />
        <HostMarker host={s.host} />
        {children}
      </div>
    </li>
  );
}

const dateValue = (ms?: number) => (ms ? new Date(ms).toISOString().slice(0, 10) : '');

export function Sidebar(p: {
  sessions: SessionRow[];
  hits: SearchHit[] | null;
  filter: SessionFilter;
  setFilter: (f: SessionFilter) => void;
  query: string;
  setQuery: (q: string) => void;
  selected: string | null;
  onSelect: (id: string, eventId?: string) => void;
  sandbox: SandboxState;
}) {
  const byId = useMemo(() => new Map(p.sessions.map((s) => [s.id, s])), [p.sessions]);
  const groups = useMemo(() => {
    const m = new Map<string, SessionRow[]>();
    for (const s of p.sessions) {
      const k = s.project ?? '(no project)';
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(s);
    }
    return [...m.entries()]; // sessions arrive newest first, so groups are ordered by their newest session
  }, [p.sessions]);
  // Folding: the most recent projects start open, the rest folded; each shows PAGE chats, then "Show more".
  const [openMap, setOpenMap] = useState<Map<string, boolean>>(new Map());
  const [limits, setLimits] = useState<Map<string, number>>(new Map());
  const isOpen = (project: string, i: number) => openMap.get(project) ?? i < OPEN_GROUPS;
  const limitOf = (project: string) => limits.get(project) ?? PAGE;
  const setOpen = (project: string, v: boolean) => setOpenMap((m) => new Map(m).set(project, v));
  const more = (project: string) => setLimits((m) => new Map(m).set(project, limitOf(project) + PAGE));
  const less = (project: string) => setLimits((m) => new Map(m).set(project, PAGE));

  // Keyboard: a cursor over group headers and visible sessions.
  type Item = { key: string; project: string; group?: number; s?: SessionRow; eventId?: string };
  const items: Item[] = useMemo(() => {
    if (p.hits) return p.hits.flatMap((h) => (byId.get(h.session_id) ? [{ key: `s:${h.session_id}`, project: '', s: byId.get(h.session_id)!, eventId: h.event_id }] : []));
    const out: Item[] = [];
    groups.forEach(([project, list], i) => {
      out.push({ key: `g:${project}`, project, group: i });
      if (isOpen(project, i)) for (const s of list.slice(0, limitOf(project))) out.push({ key: `s:${s.id}`, project, s });
    });
    return out;
  }, [p.hits, groups, openMap, limits, byId]);
  const [cursor, setCursor] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [listFocused, setListFocused] = useState(false);
  const cur = cursor && items.some((it) => it.key === cursor) ? cursor : p.selected && items.some((it) => it.key === `s:${p.selected}`) ? `s:${p.selected}` : null;

  const moveTo = (it: Item | undefined) => {
    if (!it) return;
    setCursor(it.key);
    if (it.s) p.onSelect(it.s.id, it.eventId);
    listRef.current?.querySelector(`[data-key="${CSS.escape(it.key)}"]`)?.scrollIntoView({ block: 'nearest' });
  };
  const step = (d: number, sessionsOnly = false) => {
    const pool = sessionsOnly ? items.filter((it) => it.s) : items;
    const i = pool.findIndex((it) => it.key === (sessionsOnly && p.selected ? `s:${p.selected}` : cur));
    moveTo(pool[i < 0 ? (d > 0 ? 0 : pool.length - 1) : Math.max(0, Math.min(pool.length - 1, i + d))]);
  };

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const it = items.find((x) => x.key === cur);
    const k = { j: 'ArrowDown', k: 'ArrowUp', h: 'ArrowLeft', l: 'ArrowRight' }[e.key] ?? e.key;
    if (k === 'ArrowDown') step(1);
    else if (k === 'ArrowUp') step(-1);
    else if (k === 'g') moveTo(items[0]);
    else if (k === 'G') moveTo(items[items.length - 1]);
    else if (it && !p.hits && (k === 'ArrowLeft' || k === 'ArrowRight' || (k === ' ' && it.group != null))) {
      const gi = groups.findIndex(([proj]) => proj === it.project);
      const open = isOpen(it.project, gi);
      const want = k === ' ' ? !open : k === 'ArrowRight';
      if (open !== want) setOpen(it.project, want);
      if (!want) setCursor(`g:${it.project}`);
    } else if (k === 'm' && it && !p.hits) more(it.project);
    else if (k === 'Enter' && it?.s) document.getElementById('trace')?.focus();
    else return;
    e.preventDefault();
  };

  // ⌥↑ / ⌥↓ from anywhere: previous / next chat.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && !e.metaKey && !e.ctrlKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !isTyping(e)) {
        e.preventDefault();
        step(e.key === 'ArrowDown' ? 1 : -1, true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const f = p.filter;
  const set = (patch: Partial<SessionFilter>) => p.setFilter({ ...f, ...patch });
  const sb = p.sandbox;
  const [showSb, setShowSb] = useState(false);

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <h1>Periscope</h1>
        <span className={`sandbox s-${sb.state}`} title={sb.message ? `${sb.message}\n\nClick to show` : ''} onClick={() => setShowSb(!showSb)}>
          {sb.state === 'online' ? 'sandbox online' : sb.state === 'offline' ? 'sandbox offline' : sb.state === 'error' ? 'sandbox error' : sb.state === 'disabled' ? 'sandbox off' : 'sandbox…'}
        </span>
      </div>
      {showSb && sb.message && (
        <div className={`sandbox-msg s-${sb.state}`}>
          <strong>{sb.state === 'error' ? 'Podman failed while polling the sandbox volumes:' : 'Sandbox:'}</strong>
          <pre>{sb.message}</pre>
        </div>
      )}
      <input
        className="search"
        id="global-search"
        type="search"
        placeholder="Search all sessions  ( / )"
        value={p.query}
        onChange={(e) => p.setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'Enter') {
            e.preventDefault();
            listRef.current?.focus();
            if (e.key === 'Enter') moveTo(items.find((it) => it.s));
          } else if (e.key === 'Escape') {
            p.setQuery('');
            listRef.current?.focus();
          }
        }}
      />
      <div className="filters">
        <select value={f.agent ?? ''} onChange={(e) => set({ agent: (e.target.value || undefined) as any })} aria-label="Agent">
          <option value="">All agents</option>
          <option value="claude">Claude Code</option>
          <option value="codex">Codex</option>
          <option value="antigravity">Antigravity</option>
        </select>
        <select value={f.host ?? ''} onChange={(e) => set({ host: (e.target.value || undefined) as any })} aria-label="Host">
          <option value="">All hosts</option>
          <option value="native">Mac</option>
          <option value="sandbox">Sandbox</option>
        </select>
        <select value={f.status ?? ''} onChange={(e) => set({ status: (e.target.value || undefined) as any })} aria-label="Status">
          <option value="">Any status</option>
          <option value="live">Live</option>
          <option value="idle">Idle</option>
        </select>
        <label>
          From
          <input type="date" value={dateValue(f.from)} onChange={(e) => set({ from: e.target.value ? Date.parse(e.target.value + 'T00:00:00') : undefined })} />
        </label>
        <label>
          To
          <input type="date" value={dateValue(f.to)} onChange={(e) => set({ to: e.target.value ? Date.parse(e.target.value + 'T23:59:59') : undefined })} />
        </label>
      </div>
      <div
        className={`session-list ${listFocused ? 'focused' : ''}`}
        id="session-list"
        ref={listRef}
        tabIndex={0}
        onKeyDown={onListKey}
        onFocus={() => setListFocused(true)}
        onBlur={() => setListFocused(false)}
      >
        {p.hits ? (
          <ul>
            {p.hits.length === 0 && <li className="empty">No matches.</li>}
            {p.hits.map((h) => {
              const s = byId.get(h.session_id);
              return s ? (
                <SessionItem key={h.session_id} s={s} active={p.selected === s.id} cursor={cur === `s:${s.id}`} onClick={() => (setCursor(`s:${s.id}`), p.onSelect(s.id, h.event_id))}>
                  <Snippet text={h.snippet} />
                </SessionItem>
              ) : null;
            })}
          </ul>
        ) : (
          groups.map(([project, list], i) => {
            const open = isOpen(project, i);
            const limit = limitOf(project);
            return (
              <div key={project} className="group">
                <div className={`group-head ${cur === `g:${project}` ? 'cursor' : ''}`} data-key={`g:${project}`} onClick={() => (setCursor(`g:${project}`), setOpen(project, !open))}>
                  <Chevron open={open} />
                  <span className="group-name">{project}</span>
                  <span className="count">{list.length}</span>
                </div>
                {open && (
                  <ul>
                    {list.slice(0, limit).map((s) => (
                      <SessionItem key={s.id} s={s} active={p.selected === s.id} cursor={cur === `s:${s.id}`} onClick={() => (setCursor(`s:${s.id}`), p.onSelect(s.id))} />
                    ))}
                    {(list.length > limit || limit > PAGE) && (
                      <li className="more">
                        {list.length > limit && (
                          <button onClick={() => more(project)} title="Show more (M)">
                            Show {Math.min(PAGE, list.length - limit)} more
                          </button>
                        )}
                        {limit > PAGE && <button onClick={() => less(project)}>Show less</button>}
                      </li>
                    )}
                  </ul>
                )}
              </div>
            );
          })
        )}
        {!p.hits && p.sessions.length === 0 && <div className="empty">No sessions yet. Transcripts appear here as soon as they are found.</div>}
      </div>
    </aside>
  );
}
