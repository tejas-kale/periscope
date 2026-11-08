/**
 * Which Claude Code sessions are open right now. Claude Code keeps one registry file per running process at
 * `~/.claude/sessions/<pid>.json` ({ pid, sessionId, status: 'busy' | 'idle', startedAt, ... }); files of
 * processes that died are left behind, so each source decides separately which entries are still alive.
 */
export type Presence = 'running' | 'open';

export interface ClaudeProc {
  pid: number;
  sessionId: string;
  status: string;
  startedAt: number;
}

export function parseClaudeProcs(texts: string[]): ClaudeProc[] {
  const out: ClaudeProc[] = [];
  for (const t of texts) {
    try {
      const d = JSON.parse(t);
      if (typeof d?.pid === 'number' && typeof d.sessionId === 'string') out.push({ pid: d.pid, sessionId: d.sessionId, status: String(d.status ?? 'idle'), startedAt: Number(d.startedAt) || 0 });
    } catch {
      /* partly written or not a registry file */
    }
  }
  return out;
}

export const presenceOf = (p: ClaudeProc): Presence => (p.status === 'busy' ? 'running' : 'open');

/** Sandbox containers are `--rm`, so a registry entry is alive only if it started after the oldest running sandbox container (same VM clock). */
export function aliveInSandbox(procs: ClaudeProc[], containerStarts: number[], slackMs = 5_000): ClaudeProc[] {
  if (!containerStarts.length) return [];
  const oldest = Math.min(...containerStarts);
  return procs.filter((p) => p.startedAt >= oldest - slackMs);
}

/** Map session id → presence from (prefix, alive procs) pairs; a later source wins on a clash. */
export function presenceMap(sources: { prefix: string; procs: ClaudeProc[] }[]): Map<string, Presence> {
  const m = new Map<string, Presence>();
  for (const s of sources) for (const p of s.procs) m.set(`${s.prefix}${p.sessionId}`, presenceOf(p));
  return m;
}

/** Ids whose presence differs between two maps. */
export function presenceChanges(a: Map<string, Presence>, b: Map<string, Presence>): string[] {
  const ids = new Set([...a.keys(), ...b.keys()]);
  return [...ids].filter((id) => a.get(id) !== b.get(id));
}
