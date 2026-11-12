import type { Agent, Host, SearchHit, SessionFilter, SessionRow } from '../core/types.ts';
import { formatAgent, formatHost } from './session-list.ts';

export type DateRangePreset = 'all' | '24h' | '7d' | '30d' | 'custom';

export interface SnippetSegment {
  text: string;
  match: boolean;
}

export interface SearchResultItem {
  key: string;
  hit: SearchHit;
  session: SessionRow;
  quickIndex: number | null;
}

const AGENTS: readonly (Agent | undefined)[] = [undefined, 'claude', 'codex', 'antigravity'];
const HOSTS: readonly (Host | undefined)[] = [undefined, 'native', 'sandbox'];
const STATUSES: readonly ('live' | 'idle' | undefined)[] = [undefined, 'live', 'idle'];
const DATE_PRESETS: readonly Exclude<DateRangePreset, 'custom'>[] = ['all', '24h', '7d', '30d'];

const DAY_MS = 86_400_000;

function cycleValue<T>(values: readonly T[], current: T): T {
  const idx = values.indexOf(current);
  return values[(idx + 1) % values.length]!;
}

/** Cycle the agent filter through all, claude, codex, and antigravity. */
export function cycleAgentFilter(current?: Agent): Agent | undefined {
  return cycleValue(AGENTS, current);
}

/** Cycle the host filter through all, native (Mac), and sandbox. */
export function cycleHostFilter(current?: Host): Host | undefined {
  return cycleValue(HOSTS, current);
}

/** Cycle the status filter through all, live, and idle. */
export function cycleStatusFilter(current?: 'live' | 'idle'): 'live' | 'idle' | undefined {
  return cycleValue(STATUSES, current);
}

/** Cycle the date range preset through all, 24h, 7d, and 30d. */
export function cycleDatePreset(current: DateRangePreset): Exclude<DateRangePreset, 'custom'> {
  if (current === 'custom') return 'all';
  return cycleValue(DATE_PRESETS, current);
}

/** Compute `{ from, to }` epoch bounds for a preset relative to `now`. */
export function dateRangeForPreset(
  preset: Exclude<DateRangePreset, 'custom'>,
  now: number,
): Pick<SessionFilter, 'from' | 'to'> {
  if (preset === '24h') return { from: now - DAY_MS };
  if (preset === '7d') return { from: now - 7 * DAY_MS };
  if (preset === '30d') return { from: now - 30 * DAY_MS };
  return {};
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseBoundary(dateStr: string, endOfDay: boolean): number | null {
  if (!ISO_DATE_RE.test(dateStr)) return null;
  const ms = Date.parse(`${dateStr}${endOfDay ? 'T23:59:59.999' : 'T00:00:00'}`);
  return Number.isNaN(ms) ? null : ms;
}

/** Parse a `YYYY-MM-DD` or `YYYY-MM-DD..YYYY-MM-DD` date range string. */
export function parseDateRangeInput(
  input: string,
): { from?: number; to?: number; label: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (!trimmed.includes('..')) {
    const from = parseBoundary(trimmed, false);
    const to = parseBoundary(trimmed, true);
    if (from == null || to == null) return null;
    return { from, to, label: trimmed };
  }

  const parts = trimmed.split('..');
  if (parts.length !== 2) return null;
  const [rawFrom, rawTo] = parts.map((p) => p.trim());
  if (!rawFrom && !rawTo) return null;

  const from = rawFrom ? parseBoundary(rawFrom, false) : undefined;
  const to = rawTo ? parseBoundary(rawTo, true) : undefined;
  if ((rawFrom && from == null) || (rawTo && to == null)) return null;
  if (from != null && to != null && from > to) return null;

  return {
    ...(from != null ? { from } : {}),
    ...(to != null ? { to } : {}),
    label: `${rawFrom}..${rawTo}`,
  };
}

/** Return true if any session list filter is currently active. */
export function hasActiveFilters(filter: SessionFilter): boolean {
  return Boolean(
    filter.agent ||
      filter.host ||
      filter.status ||
      filter.from != null ||
      filter.to != null,
  );
}

/** Format the compact keyboard-driven filter bar for the sessions pane. */
export function formatFilterBar(filter: SessionFilter, dateLabel: string): string {
  const agent = filter.agent ? formatAgent(filter.agent) : 'All';
  const host = filter.host ? formatHost(filter.host) : 'All';
  const status = filter.status === 'live' ? 'Live' : filter.status === 'idle' ? 'Idle' : 'All';
  const date = dateLabel || 'All';
  const clear = hasActiveFilters(filter) ? '  [c]Clear' : '';
  return `[a]Agent:${agent}  [o]Host:${host}  [s]Status:${status}  [d]Date:${date}${clear}  [/]Search`;
}

/** Split an FTS5 snippet delimited by `\u0001`..`\u0002` into plain and matched segments. */
export function parseSnippet(snippet: string): SnippetSegment[] {
  const clean = snippet.replace(/[\r\n\t]+/g, ' ');
  const parts = clean.split(/(\u0001[^\u0002]*\u0002)/);
  const segments: SnippetSegment[] = [];
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith('\u0001') && part.endsWith('\u0002')) {
      const text = part.slice(1, -1);
      if (text) segments.push({ text, match: true });
    } else {
      segments.push({ text: part, match: false });
    }
  }
  return segments;
}

/** Pair FTS5 search hits with their session metadata and assign 1-9 quick indices. */
export function buildSearchResultItems(
  hits: readonly SearchHit[],
  sessionsById: ReadonlyMap<string, SessionRow>,
): SearchResultItem[] {
  const items: SearchResultItem[] = [];
  let nextQuick = 1;
  for (const hit of hits) {
    const session = sessionsById.get(hit.session_id);
    if (!session) continue;
    items.push({
      key: `s:${session.id}`,
      hit,
      session,
      quickIndex: nextQuick <= 9 ? nextQuick++ : null,
    });
  }
  return items;
}
