import { useMemo } from 'react';
import type { SandboxState, SearchHit, SessionFilter, SessionRow } from '../../core/types.ts';
import { AgentBadge, HostMarker, LiveDot } from './Icons.tsx';

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

function SessionItem({ s, active, onClick, children }: { s: SessionRow; active: boolean; onClick: () => void; children?: React.ReactNode }) {
  return (
    <li className={`session ${active ? 'active' : ''}`} onClick={onClick} title={s.cwd ?? s.source_path}>
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
  const f = p.filter;
  const set = (patch: Partial<SessionFilter>) => p.setFilter({ ...f, ...patch });
  const sb = p.sandbox;

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <h1>Periscope</h1>
        <span className={`sandbox s-${sb.state}`} title={sb.message ?? ''}>
          {sb.state === 'online' ? 'sandbox online' : sb.state === 'offline' ? 'sandbox offline' : sb.state === 'error' ? 'sandbox error' : sb.state === 'disabled' ? 'sandbox off' : 'sandbox…'}
        </span>
      </div>
      <input className="search" type="search" placeholder="Search all sessions" value={p.query} onChange={(e) => p.setQuery(e.target.value)} />
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
      <div className="session-list">
        {p.hits ? (
          <ul>
            {p.hits.length === 0 && <li className="empty">No matches.</li>}
            {p.hits.map((h) => {
              const s = byId.get(h.session_id);
              return s ? (
                <SessionItem key={h.session_id} s={s} active={p.selected === s.id} onClick={() => p.onSelect(s.id, h.event_id)}>
                  <Snippet text={h.snippet} />
                </SessionItem>
              ) : null;
            })}
          </ul>
        ) : (
          groups.map(([project, list]) => (
            <details key={project} open className="group">
              <summary>
                <span>{project}</span>
                <span className="count">{list.length}</span>
              </summary>
              <ul>
                {list.map((s) => (
                  <SessionItem key={s.id} s={s} active={p.selected === s.id} onClick={() => p.onSelect(s.id)} />
                ))}
              </ul>
            </details>
          ))
        )}
        {!p.hits && p.sessions.length === 0 && <div className="empty">No sessions yet. Transcripts appear here as soon as they are found.</div>}
      </div>
    </aside>
  );
}
