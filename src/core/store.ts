import type { Agent, EventPatch, EventRow, Host, ParsedEvent, SearchHit, SessionFields, SessionFilter, SessionRow } from './types.ts';

/** The subset of better-sqlite3 (and node:sqlite, used in tests) the store needs. */
export interface SqlStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
export interface SqlDb {
  exec(sql: string): unknown;
  prepare(sql: string): SqlStatement;
}

export const LIVE_WINDOW_MS = 30_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY, agent TEXT NOT NULL, host TEXT NOT NULL, project TEXT, cwd TEXT, title TEXT,
  started_at INTEGER, updated_at INTEGER, status TEXT NOT NULL DEFAULT 'idle', source_path TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated_at DESC);
CREATE TABLE IF NOT EXISTS events(
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, parent_id TEXT, kind TEXT NOT NULL, role TEXT,
  ts INTEGER, duration_ms INTEGER, tokens_in INTEGER, tokens_out INTEGER, tool_name TEXT, text TEXT NOT NULL DEFAULT '',
  raw_json TEXT);
CREATE INDEX IF NOT EXISTS events_session_seq ON events(session_id, seq);
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  text, tool_name, session_id UNINDEXED, content='events', content_rowid='rowid', tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, text, tool_name, session_id) VALUES (new.rowid, new.text, new.tool_name, new.session_id);
END;
CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, text, tool_name, session_id) VALUES ('delete', old.rowid, old.text, old.tool_name, old.session_id);
END;
CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE OF text, tool_name ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, text, tool_name, session_id) VALUES ('delete', old.rowid, old.text, old.tool_name, old.session_id);
  INSERT INTO events_fts(rowid, text, tool_name, session_id) VALUES (new.rowid, new.text, new.tool_name, new.session_id);
END;
CREATE TABLE IF NOT EXISTS files(
  path TEXT PRIMARY KEY, host TEXT NOT NULL, offset INTEGER NOT NULL DEFAULT 0, mtime INTEGER,
  session_id TEXT, state TEXT);
`;

export interface FileRecord {
  path: string;
  host: Host;
  offset: number;
  mtime: number | null;
  session_id: string | null;
  state: string | null;
}

const EVENT_COLS = 'id, session_id, seq, parent_id, kind, role, ts, duration_ms, tokens_in, tokens_out, tool_name, text';

const n = (v: unknown) => (v === undefined ? null : v);

/** Turn free text into an FTS5 query: every word must match, the last as a prefix. */
export function ftsQuery(input: string): string | null {
  const words = input.match(/[\p{L}\p{N}_]+/gu);
  if (!words?.length) return null;
  return words.map((w, i) => `"${w}"${i === words.length - 1 ? '*' : ''}`).join(' ');
}

export class Store {
  readonly db: SqlDb;
  private s: Record<string, SqlStatement> = {};

  constructor(db: SqlDb) {
    this.db = db;
    db.exec(SCHEMA);
  }

  private stmt(sql: string): SqlStatement {
    return (this.s[sql] ??= this.db.prepare(sql));
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  getFile(path: string): FileRecord | undefined {
    return this.stmt('SELECT * FROM files WHERE path = ?').get(path) as FileRecord | undefined;
  }

  putFile(f: FileRecord): void {
    this.stmt(
      `INSERT INTO files(path, host, offset, mtime, session_id, state) VALUES (?,?,?,?,?,?)
       ON CONFLICT(path) DO UPDATE SET offset=excluded.offset, mtime=excluded.mtime, session_id=excluded.session_id, state=excluded.state`,
    ).run(f.path, f.host, f.offset, n(f.mtime), n(f.session_id), n(f.state));
  }

  filesForHost(host: Host): FileRecord[] {
    return this.stmt('SELECT * FROM files WHERE host = ?').all(host) as FileRecord[];
  }

  filesForSession(sessionId: string): FileRecord[] {
    return this.stmt('SELECT * FROM files WHERE session_id = ?').all(sessionId) as FileRecord[];
  }

  /** Forget a session's events and rewind its files so they are read again from zero. */
  resetSession(sessionId: string): void {
    this.stmt('DELETE FROM events WHERE session_id = ?').run(sessionId);
    this.stmt('UPDATE files SET offset = 0, state = NULL WHERE session_id = ?').run(sessionId);
  }

  ensureSession(id: string, agent: Agent, host: Host, sourcePath: string): void {
    this.stmt('INSERT OR IGNORE INTO sessions(id, agent, host, source_path) VALUES (?,?,?,?)').run(id, agent, host, sourcePath);
  }

  /** The main transcript is the session's source; subagent files never replace it. */
  setSourcePath(id: string, sourcePath: string): void {
    this.stmt('UPDATE sessions SET source_path = ? WHERE id = ?').run(sourcePath, id);
  }

  updateSession(id: string, f: SessionFields & { project?: string | null }): void {
    if (f.cwd) this.stmt('UPDATE sessions SET cwd = COALESCE(cwd, ?), project = COALESCE(project, ?) WHERE id = ?').run(f.cwd, n(f.project), id);
    if (f.title) this.stmt('UPDATE sessions SET title = ? WHERE id = ?').run(f.title, id);
    if (f.weakTitle) this.stmt('UPDATE sessions SET title = COALESCE(title, ?) WHERE id = ?').run(f.weakTitle.slice(0, 200), id);
    if (f.started_at) this.stmt('UPDATE sessions SET started_at = MIN(COALESCE(started_at, ?), ?) WHERE id = ?').run(f.started_at, f.started_at, id);
  }

  touchSession(id: string, mtime: number, now: number): void {
    this.stmt(
      `UPDATE sessions SET updated_at = MAX(COALESCE(updated_at, 0), ?), status = CASE WHEN MAX(COALESCE(updated_at, 0), ?) > ? THEN 'live' ELSE 'idle' END WHERE id = ?`,
    ).run(mtime, mtime, now - LIVE_WINDOW_MS, id);
  }

  /** Mark sessions idle once they have been quiet for the live window; returns the ids that changed. */
  expireLive(now: number): string[] {
    const rows = this.stmt(`SELECT id FROM sessions WHERE status = 'live' AND COALESCE(updated_at, 0) <= ?`).all(now - LIVE_WINDOW_MS) as { id: string }[];
    if (rows.length) this.stmt(`UPDATE sessions SET status = 'idle' WHERE status = 'live' AND COALESCE(updated_at, 0) <= ?`).run(now - LIVE_WINDOW_MS);
    return rows.map((r) => r.id);
  }

  nextSeq(sessionId: string): number {
    const r = this.stmt('SELECT MAX(seq) AS m FROM events WHERE session_id = ?').get(sessionId) as { m: number | null };
    return (r?.m ?? -1) + 1;
  }

  /** Insert an event unless its id exists; returns whether it was new. */
  insertEvent(sessionId: string, seq: number, e: ParsedEvent): boolean {
    const r = this.stmt(
      `INSERT OR IGNORE INTO events(${EVENT_COLS}, raw_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(e.id, sessionId, seq, n(e.parent_id), e.kind, n(e.role), n(e.ts), n(e.duration_ms), n(e.tokens_in), n(e.tokens_out), n(e.tool_name), e.text ?? '', n(e.raw_json)) as { changes: number | bigint };
    return Number(r.changes) > 0;
  }

  patchEvent(id: string, p: EventPatch): void {
    const keys = (Object.keys(p) as (keyof EventPatch)[]).filter((k) => p[k] !== undefined);
    if (!keys.length) return;
    this.stmt(`UPDATE events SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => n(p[k])), id);
  }

  listSessions(f: SessionFilter = {}, now = Date.now()): SessionRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (f.agent) (where.push('agent = ?'), args.push(f.agent));
    if (f.host) (where.push('host = ?'), args.push(f.host));
    if (f.from != null) (where.push('updated_at >= ?'), args.push(f.from));
    if (f.to != null) (where.push('COALESCE(started_at, updated_at) <= ?'), args.push(f.to));
    if (f.status === 'live') (where.push('updated_at > ?'), args.push(now - LIVE_WINDOW_MS));
    if (f.status === 'idle') (where.push('COALESCE(updated_at, 0) <= ?'), args.push(now - LIVE_WINDOW_MS));
    where.push('EXISTS (SELECT 1 FROM events e WHERE e.session_id = sessions.id)');
    const rows = this.db
      .prepare(`SELECT * FROM sessions WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT 5000`)
      .all(...args) as SessionRow[];
    for (const r of rows) r.status = (r.updated_at ?? 0) > now - LIVE_WINDOW_MS ? 'live' : 'idle';
    return rows;
  }

  getSession(id: string): SessionRow | undefined {
    return this.stmt('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  }

  getEvents(sessionId: string, sinceSeq = -1): EventRow[] {
    return this.stmt(`SELECT ${EVENT_COLS} FROM events WHERE session_id = ? AND seq > ? ORDER BY seq`).all(sessionId, sinceSeq) as EventRow[];
  }

  getRaw(eventId: string): string | null {
    const r = this.stmt('SELECT raw_json FROM events WHERE id = ?').get(eventId) as { raw_json: string | null } | undefined;
    return r?.raw_json ?? null;
  }

  /** Full-text search across sessions: the best hit per session, newest sessions first. */
  search(input: string, f: SessionFilter = {}, limit = 200): SearchHit[] {
    const q = ftsQuery(input);
    if (!q) return [];
    const ids = f.agent || f.host || f.status || f.from != null || f.to != null ? new Set(this.listSessions(f).map((s) => s.id)) : null;
    const rows = this.stmt(
      `SELECT e.session_id AS session_id, e.id AS event_id, snippet(events_fts, 0, char(1), char(2), '…', 14) AS snippet
       FROM events_fts JOIN events e ON e.rowid = events_fts.rowid
       WHERE events_fts MATCH ? ORDER BY rank LIMIT 5000`,
    ).all(q) as SearchHit[];
    const seen = new Set<string>();
    const out: SearchHit[] = [];
    for (const r of rows) {
      if (seen.has(r.session_id) || (ids && !ids.has(r.session_id))) continue;
      seen.add(r.session_id);
      out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  }
}
