import type { Agent, Host, LineParser } from './types.ts';
import type { Store } from './store.ts';
import { claudeParser } from './parsers/claude.ts';
import { codexParser } from './parsers/codex.ts';
import { antigravityParser } from './parsers/antigravity.ts';
import { cursorParser } from './parsers/cursor.ts';

/** Where each agent keeps transcripts, relative to its home directory (`~/.claude`, `~/.codex`, `~/.gemini`, `~/.cursor`). */
export const AGENT_DIRS: Record<Agent, string> = {
  claude: 'projects',
  codex: 'sessions',
  antigravity: 'antigravity-cli/brain',
  cursor: 'projects',
};

/** Sidecar file with Antigravity conversation titles and workspaces, relative to `~/.gemini`. */
export const AGY_METADATA = 'antigravity-cli/cache/conversation_metadata.json';

export const PARSERS: Record<Agent, LineParser<any>> = {
  claude: claudeParser,
  codex: codexParser,
  antigravity: antigravityParser,
  cursor: cursorParser,
};

export interface TranscriptFile {
  agent: Agent;
  host: Host;
  /** Raw id of the conversation as the agent names it. */
  conversation: string;
  sessionId: string;
  /** Distinguishes files that feed the same session. */
  fileTag: string;
  /** For Claude subagent files: path (relative to the agent dir) of the `.meta.json` naming the parent tool call. */
  subagentMeta?: string;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CLAUDE_MAIN = new RegExp(`^[^/]+/(${UUID})\\.jsonl$`);
const CLAUDE_SUB = new RegExp(`^([^/]+/(${UUID})/subagents/agent-([\\w-]+))\\.jsonl$`);
const CODEX = new RegExp(`(?:^|/)rollout-[^/]*?(${UUID})\\.jsonl$`);
const AGY = new RegExp(`^(${UUID})/\\.system_generated/logs/transcript_full\\.jsonl$`);
const CURSOR_MAIN = new RegExp(`^[^/]+/agent-transcripts/(${UUID})/\\1\\.jsonl$`);
const CURSOR_FLAT = new RegExp(`^[^/]+/agent-transcripts/(${UUID})\\.jsonl$`);
const CURSOR_SUB = new RegExp(`^[^/]+/agent-transcripts/(${UUID})/subagents/([\\w-]+)\\.jsonl$`);
const CURSOR_STORE = new RegExp(`^[^/]+/(${UUID})/store\\.db$`);

export function sessionIdFor(host: Host, conversation: string): string {
  return `${host === 'native' ? 'n' : 's'}:${conversation}`;
}

/** Classify a path relative to the agent's transcript dir; null if it is not a transcript. */
export function classify(agent: Agent, host: Host, rel: string): TranscriptFile | null {
  rel = rel.replace(/\\/g, '/');
  const mk = (conversation: string, fileTag: string, subagentMeta?: string): TranscriptFile => ({
    agent,
    host,
    conversation,
    sessionId: sessionIdFor(host, conversation),
    fileTag,
    subagentMeta,
  });
  if (agent === 'claude') {
    let m = rel.match(CLAUDE_MAIN);
    if (m) return mk(m[1], 'm');
    m = rel.match(CLAUDE_SUB);
    if (m) return mk(m[2], `a:${m[3]}`, `${m[1]}.meta.json`);
    return null;
  }
  if (agent === 'codex') {
    const m = rel.match(CODEX);
    return m ? mk(m[1], 'm') : null;
  }
  if (agent === 'antigravity') {
    const m = rel.match(AGY);
    return m ? mk(m[1], 'm') : null;
  }
  let m = rel.match(CURSOR_MAIN) ?? rel.match(CURSOR_FLAT) ?? rel.match(CURSOR_STORE);
  if (m) return mk(m[1], 'm');
  m = rel.match(CURSOR_SUB);
  return m ? mk(m[1], `a:${m[2]}`) : null;
}

export function projectName(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const parts = cwd.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || cwd;
}

export interface AgyMeta {
  title?: string;
  cwd?: string;
}

/** Parse Antigravity's `conversation_metadata.json` into title and workspace per conversation id. */
export function parseAgyMetadata(json: string): Record<string, AgyMeta> {
  const out: Record<string, AgyMeta> = {};
  try {
    const d = JSON.parse(json);
    for (const [id, v] of Object.entries<any>(d?.conversations ?? {})) {
      const s = v?.summary ?? {};
      const uri: string | undefined = s.WorkspaceURIs?.[0];
      out[id] = {
        title: s.Title || undefined,
        cwd: uri?.startsWith('file://') ? decodeURIComponent(uri.slice(7)) : uri,
      };
    }
  } catch {
    /* tolerate a half-written file */
  }
  return out;
}

/** Update titles and workspaces of Antigravity sessions already in the index. */
export function applyAgyMeta(store: Store, host: Host, metas: Record<string, AgyMeta>): void {
  for (const [id, m] of Object.entries(metas)) {
    const sid = sessionIdFor(host, id);
    if (store.getSession(sid)) store.updateSession(sid, { title: m.title, cwd: m.cwd, project: projectName(m.cwd) });
  }
}
