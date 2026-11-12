import type { Agent, Host, SessionRow } from '../core/types.ts';

export const DEFAULT_OPEN_GROUPS = 3;
export const DEFAULT_GROUP_PAGE = 4;

export interface SessionGroup {
  project: string;
  sessions: SessionRow[];
}

export type SessionListItem =
  | {
      kind: 'group';
      key: string;
      project: string;
      expanded: boolean;
      totalCount: number;
      hiddenCount: number;
      groupIndex: number;
    }
  | {
      kind: 'session';
      key: string;
      project: string;
      session: SessionRow;
      quickIndex: number | null;
    };

export interface SessionListState {
  openMap: ReadonlyMap<string, boolean>;
  limits: ReadonlyMap<string, number>;
  cursorKey: string | null;
  selectedSessionId: string | null;
}

export function formatAgent(agent: Agent): string {
  switch (agent) {
    case 'claude':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'antigravity':
      return 'Antigravity';
  }
}

export function formatHost(host: Host): string {
  return host === 'native' ? 'Mac' : 'Sandbox';
}

export function formatAge(ms: number | null, now = Date.now()): string {
  if (ms == null) return '';
  const d = Math.max(0, now - ms);
  if (d < 60_000) return 'now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`;
  if (d < 7 * 86_400_000) return `${Math.floor(d / 86_400_000)}d`;
  return new Date(ms).toISOString().slice(0, 10);
}

export function formatStatusBadge(status: SessionRow['status']): string {
  if (status === 'live') return '● live';
  if (status === 'open') return '○ open';
  return '';
}

function sessionTimestamp(s: SessionRow): number {
  return s.updated_at ?? s.started_at ?? 0;
}

export function groupSessions(sessions: readonly SessionRow[]): SessionGroup[] {
  const byProject = new Map<string, SessionRow[]>();
  for (const s of sessions) {
    const project = s.project ?? '(no project)';
    let list = byProject.get(project);
    if (!list) {
      list = [];
      byProject.set(project, list);
    }
    list.push(s);
  }

  const groups: SessionGroup[] = [];
  for (const [project, list] of byProject.entries()) {
    const sorted = [...list].sort((a, b) => {
      const diff = sessionTimestamp(b) - sessionTimestamp(a);
      return diff !== 0 ? diff : a.id.localeCompare(b.id);
    });
    groups.push({ project, sessions: sorted });
  }

  groups.sort((a, b) => {
    const diff = sessionTimestamp(b.sessions[0]!) - sessionTimestamp(a.sessions[0]!);
    return diff !== 0 ? diff : a.project.localeCompare(b.project);
  });

  return groups;
}

export function createSessionListState(sessions: readonly SessionRow[] = []): SessionListState {
  const groups = groupSessions(sessions);
  const firstKey = groups.length > 0 ? `g:${groups[0]!.project}` : null;
  return {
    openMap: new Map(),
    limits: new Map(),
    cursorKey: firstKey,
    selectedSessionId: null,
  };
}

export function buildSessionListItems(
  sessions: readonly SessionRow[],
  state: SessionListState,
  opts: { openGroups?: number; pageSize?: number } = {},
): SessionListItem[] {
  const openGroups = opts.openGroups ?? DEFAULT_OPEN_GROUPS;
  const pageSize = opts.pageSize ?? DEFAULT_GROUP_PAGE;
  const groups = groupSessions(sessions);
  const items: SessionListItem[] = [];
  let nextQuick = 1;

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!;
    const expanded = state.openMap.get(group.project) ?? i < openGroups;
    const limit = state.limits.get(group.project) ?? pageSize;
    const visibleSessions = expanded ? group.sessions.slice(0, limit) : [];
    const hiddenCount = expanded ? Math.max(0, group.sessions.length - visibleSessions.length) : group.sessions.length;

    items.push({
      kind: 'group',
      key: `g:${group.project}`,
      project: group.project,
      expanded,
      totalCount: group.sessions.length,
      hiddenCount,
      groupIndex: i,
    });

    for (const session of visibleSessions) {
      const quickIndex = nextQuick <= 9 ? nextQuick++ : null;
      items.push({
        kind: 'session',
        key: `s:${session.id}`,
        project: group.project,
        session,
        quickIndex,
      });
    }
  }

  return items;
}

export interface KeyInputLike {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

export type SessionListAction =
  | { type: 'move'; delta: number }
  | { type: 'jump'; edge: 'top' | 'bottom' }
  | { type: 'expand' }
  | { type: 'collapse' }
  | { type: 'toggle' }
  | { type: 'activate' }
  | { type: 'showMore' }
  | { type: 'quickOpen'; index: number }
  | { type: 'clickItem'; key: string };

export function keyToSessionListAction(key: KeyInputLike): SessionListAction | null {
  if (key.ctrl || key.meta) return null;
  const name = key.name ?? '';
  if (name === 'up' || (!key.shift && name === 'k')) return { type: 'move', delta: -1 };
  if (name === 'down' || (!key.shift && name === 'j')) return { type: 'move', delta: 1 };
  if (name === 'left' || (!key.shift && name === 'h')) return { type: 'collapse' };
  if (name === 'right' || (!key.shift && name === 'l')) return { type: 'expand' };
  if (name === 'space') return { type: 'toggle' };
  if (name === 'return' || name === 'enter') return { type: 'activate' };
  if (!key.shift && name === 'm') return { type: 'showMore' };
  if ((key.shift && name === 'g') || key.sequence === 'G') return { type: 'jump', edge: 'bottom' };
  if (!key.shift && name === 'g') return { type: 'jump', edge: 'top' };
  if (/^[1-9]$/.test(name)) return { type: 'quickOpen', index: Number(name) };
  return null;
}

export function applySessionListAction(
  state: SessionListState,
  sessions: readonly SessionRow[],
  action: SessionListAction,
  opts: { openGroups?: number; pageSize?: number } = {},
): SessionListState {
  const items = buildSessionListItems(sessions, state, opts);
  if (items.length === 0) return state;

  const currentIdx = state.cursorKey ? items.findIndex((it) => it.key === state.cursorKey) : -1;
  const currentItem = currentIdx >= 0 ? items[currentIdx]! : items[0]!;

  if (action.type === 'move') {
    const base = currentIdx >= 0 ? currentIdx : action.delta > 0 ? -1 : items.length;
    const nextIdx = Math.max(0, Math.min(items.length - 1, base + action.delta));
    return { ...state, cursorKey: items[nextIdx]!.key };
  }

  if (action.type === 'jump') {
    const target = action.edge === 'top' ? items[0]! : items[items.length - 1]!;
    return { ...state, cursorKey: target.key };
  }

  if (action.type === 'expand' || action.type === 'collapse' || action.type === 'toggle') {
    if (action.type === 'toggle' && currentItem.kind === 'session') {
      return { ...state, selectedSessionId: currentItem.session.id };
    }
    const groupItem = items.find((it) => it.kind === 'group' && it.project === currentItem.project);
    if (!groupItem || groupItem.kind !== 'group') return state;
    const want = action.type === 'toggle' ? !groupItem.expanded : action.type === 'expand';
    const openMap = new Map(state.openMap);
    openMap.set(groupItem.project, want);
    return {
      ...state,
      openMap,
      cursorKey: !want ? groupItem.key : state.cursorKey ?? groupItem.key,
    };
  }

  if (action.type === 'activate') {
    if (currentItem.kind === 'session') {
      return { ...state, selectedSessionId: currentItem.session.id };
    }
    const openMap = new Map(state.openMap);
    openMap.set(currentItem.project, !currentItem.expanded);
    return { ...state, openMap };
  }

  if (action.type === 'showMore') {
    const pageSize = opts.pageSize ?? DEFAULT_GROUP_PAGE;
    const limits = new Map(state.limits);
    limits.set(currentItem.project, (limits.get(currentItem.project) ?? pageSize) + pageSize);
    return { ...state, limits };
  }

  if (action.type === 'quickOpen') {
    const visibleSessions = items.filter((it): it is Extract<SessionListItem, { kind: 'session' }> => it.kind === 'session');
    const target = visibleSessions[action.index - 1];
    if (!target) return state;
    return {
      ...state,
      cursorKey: target.key,
      selectedSessionId: target.session.id,
    };
  }

  if (action.type === 'clickItem') {
    const target = items.find((it) => it.key === action.key);
    if (!target) return state;
    if (target.kind === 'group') {
      const openMap = new Map(state.openMap);
      openMap.set(target.project, !target.expanded);
      return { ...state, openMap, cursorKey: target.key };
    }
    return { ...state, cursorKey: target.key, selectedSessionId: target.session.id };
  }

  return state;
}

