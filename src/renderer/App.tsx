import { useEffect, useRef, useState } from 'react';
import type { SandboxState, SearchHit, SessionFilter, SessionRow } from '../core/types.ts';
import { api } from './api.ts';
import { Sidebar } from './components/Sidebar.tsx';
import { SessionView } from './components/SessionView.tsx';
import { Shortcuts } from './components/Shortcuts.tsx';
import { isTyping } from './keys.ts';

const focus = (id: string) => document.getElementById(id)?.focus();

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

export function App() {
  const [filter, setFilter] = useState<SessionFilter>({});
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [selected, setSelected] = useState<{ id: string; eventId?: string; query?: string } | null>(null);
  const [sandbox, setSandbox] = useState<SandboxState>({ state: 'unknown' });
  const [listTick, setListTick] = useState(0);
  const [sessionTick, setSessionTick] = useState(0);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const q = useDebounced(query, 200);
  const [help, setHelp] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (help) {
        if (e.key === 'Escape' || e.key === '?') (e.preventDefault(), setHelp(false));
        return;
      }
      if (mod && e.key.toLowerCase() === 'k') (e.preventDefault(), focus('global-search'), (document.getElementById('global-search') as HTMLInputElement | null)?.select());
      else if (mod && ['1', '2', '3'].includes(e.key)) (e.preventDefault(), focus({ 1: 'session-list', 2: 'trace', 3: 'detail' }[e.key as '1' | '2' | '3']));
      else if (!mod && !e.altKey && !isTyping(e)) {
        if (e.key === '?') (e.preventDefault(), setHelp(true));
        else if (e.key === '/') (e.preventDefault(), focus('global-search'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [help]);

  useEffect(() => {
    void api().sandboxStatus().then(setSandbox);
    const offS = api().onSandbox(setSandbox);
    const offC = api().onChange((n) => {
      setListTick((t) => t + 1);
      if (selectedRef.current && n.sessionIds.includes(selectedRef.current.id)) setSessionTick((t) => t + 1);
    });
    return () => (offS(), offC());
  }, []);

  useEffect(() => {
    void api().listSessions(filter).then(setSessions);
  }, [filter, listTick]);

  useEffect(() => {
    if (!q.trim()) return setHits(null);
    let live = true;
    void api()
      .search(q, filter)
      .then((h) => live && setHits(h));
    return () => {
      live = false;
    };
  }, [q, filter, listTick]);

  // Keep the open session even when a filter hides it from the list.
  const lastSession = useRef<SessionRow | undefined>(undefined);
  const found = selected ? sessions.find((s) => s.id === selected.id) : undefined;
  if (found) lastSession.current = found;
  const session = selected ? (found ?? (lastSession.current?.id === selected.id ? lastSession.current : undefined)) : undefined;

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        hits={hits}
        filter={filter}
        setFilter={setFilter}
        query={query}
        setQuery={setQuery}
        selected={selected?.id ?? null}
        onSelect={(id, eventId) => setSelected({ id, eventId, query: eventId ? q : undefined })}
        sandbox={sandbox}
      />
      {session ? (
        <SessionView key={session.id} session={session} focusEvent={selected?.eventId} initialQuery={selected?.query} changeTick={sessionTick} />
      ) : (
        <main className="empty-state">
          <div>
            <h2>Periscope</h2>
            <p>Pick a session on the left, or search across all of them.</p>
            <p className="muted">
              Press <kbd>?</kbd> for keyboard shortcuts.
            </p>
            <p className="muted">
              {sessions.length} sessions indexed · {sandbox.state === 'offline' ? 'sandbox offline' : `sandbox ${sandbox.state}`}
            </p>
          </div>
        </main>
      )}
      {help && <Shortcuts onClose={() => setHelp(false)} />}
    </div>
  );
}
