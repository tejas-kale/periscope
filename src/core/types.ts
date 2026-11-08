export type Agent = 'claude' | 'codex' | 'antigravity';
export type Host = 'native' | 'sandbox';
export type EventKind = 'turn' | 'reasoning' | 'text' | 'tool_call' | 'tool_result' | 'error' | 'meta';

export interface EventRow {
  id: string;
  session_id: string;
  seq: number;
  parent_id: string | null;
  kind: EventKind;
  role: string | null;
  ts: number | null; // epoch ms
  duration_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  tool_name: string | null;
  text: string;
  raw_json?: string | null;
}

export interface SessionRow {
  id: string;
  agent: Agent;
  host: Host;
  project: string | null;
  cwd: string | null;
  title: string | null;
  started_at: number | null;
  updated_at: number | null;
  status: 'live' | 'idle';
  source_path: string;
}

/** An event as a parser emits it; the ingestor adds session_id and seq. */
export type ParsedEvent = Omit<EventRow, 'session_id' | 'seq' | 'duration_ms' | 'tokens_in' | 'tokens_out' | 'tool_name' | 'role' | 'ts' | 'parent_id'> &
  Partial<Pick<EventRow, 'duration_ms' | 'tokens_in' | 'tokens_out' | 'tool_name' | 'role' | 'ts' | 'parent_id'>>;

export type EventPatch = Partial<Pick<EventRow, 'duration_ms' | 'tokens_in' | 'tokens_out' | 'text'>>;

export interface SessionFields {
  cwd?: string | null;
  title?: string | null;
  /** A title derived from the first prompt; never overrides a real one. */
  weakTitle?: string | null;
  started_at?: number | null;
}

export type ParseOp =
  | { op: 'event'; ev: ParsedEvent }
  | { op: 'patch'; id: string; fields: EventPatch }
  | { op: 'session'; fields: SessionFields };

export interface ParseContext {
  sessionId: string;
  /** Stable event id for a key that is unique within the session. */
  id(key: string): string;
  /** Key prefix unique to the file being parsed (subagent files share a session). */
  fileTag: string;
  /** Parent for top-level events (a subagent file nests under its tool call). */
  rootParent: string | null;
}

export interface LineParser<S> {
  initialState(): S;
  parseLine(line: string, offset: number, state: S, ctx: ParseContext): ParseOp[];
}

export interface SessionFilter {
  agent?: Agent;
  host?: Host;
  status?: 'live' | 'idle';
  from?: number;
  to?: number;
}

export interface SearchHit {
  session_id: string;
  event_id: string;
  snippet: string;
}

export interface SandboxState {
  state: 'unknown' | 'online' | 'offline' | 'error' | 'disabled';
  message?: string;
}

export interface ChangeNotice {
  sessionIds: string[];
}

/** What the preload script exposes to the renderer as `window.periscope`. */
export interface PeriscopeApi {
  listSessions(f: SessionFilter): Promise<SessionRow[]>;
  getEvents(sessionId: string, sinceSeq?: number): Promise<EventRow[]>;
  getRaw(eventId: string): Promise<string | null>;
  search(q: string, f: SessionFilter): Promise<SearchHit[]>;
  sandboxStatus(): Promise<SandboxState>;
  readImage(path: string): Promise<string | null>;
  onChange(cb: (n: ChangeNotice) => void): () => void;
  onSandbox(cb: (s: SandboxState) => void): () => void;
}
