import type { EventRow } from '../core/types.ts';
import { attachmentType, isContext, type Tree } from './tree.ts';

export interface ToolStat {
  name: string;
  calls: number;
  errors: number;
  durationMs: number;
}

export interface SessionStats {
  durationMs: number | null;
  turns: number;
  toolCalls: number;
  errors: number;
  tokensIn: number;
  tokensOut: number;
  tools: ToolStat[];
}

export interface ContextField {
  label: string;
  value: string;
}

export interface ContextGroup {
  key: string;
  title: string;
  count: number;
  latestEvent: EventRow;
  fields: ContextField[];
}

/** Aggregate session totals (duration, tokens, turns, tool calls, errors, per-tool breakdown). */
export function computeSessionStats(tree: Tree, events: EventRow[]): SessionStats {
  let turns = 0;
  let toolCalls = 0;
  let errors = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let minTs: number | null = null;
  let maxTs: number | null = null;
  const toolsMap = new Map<string, ToolStat>();

  for (const ev of events) {
    if (ev.kind === 'turn') turns++;
    else if (ev.kind === 'error') errors++;

    tokensIn += ev.tokens_in ?? 0;
    tokensOut += ev.tokens_out ?? 0;

    if (ev.ts != null) {
      if (minTs == null || ev.ts < minTs) minTs = ev.ts;
      if (maxTs == null || ev.ts > maxTs) maxTs = ev.ts;
    }

    if (ev.kind === 'tool_call') {
      toolCalls++;
      const name = ev.tool_name ?? '?';
      const entry = toolsMap.get(name) ?? { name, calls: 0, errors: 0, durationMs: 0 };
      entry.calls++;
      entry.durationMs += ev.duration_ms ?? 0;
      if (tree.byId.get(ev.id)?.children.some((c) => c.ev.kind === 'error')) {
        entry.errors++;
      }
      toolsMap.set(name, entry);
    }
  }

  const tools = [...toolsMap.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
  const durationMs = minTs != null && maxTs != null ? maxTs - minTs : null;

  return {
    durationMs,
    turns,
    toolCalls,
    errors,
    tokensIn,
    tokensOut,
    tools,
  };
}

function prettyLabel(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

function extractAttachmentFields(ev: EventRow, rawJson: string | null | undefined): ContextField[] {
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as Record<string, unknown>;
      const att = parsed.attachment;
      if (att && typeof att === 'object' && !Array.isArray(att)) {
        const fields: ContextField[] = [];
        for (const [k, v] of Object.entries(att as Record<string, unknown>)) {
          if (k === 'type' || k === 'toolUseID' || v === '' || v == null) continue;
          if (Array.isArray(v) && v.length === 0) continue;
          const value =
            typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
              ? String(v)
              : JSON.stringify(v, null, 2);
          fields.push({ label: prettyLabel(k), value });
        }
        if (fields.length > 0) return fields;
      }
    } catch {
      // Fall back to event text
    }
  }

  const attType = attachmentType(ev);
  const body = attType ? ev.text.split('\n').slice(1).join('\n').trim() : ev.text.trim();
  const cleaned = body.replace(/<\/?system-reminder>/gi, '').trim();
  if (!cleaned) return [];
  return [{ label: 'Content', value: cleaned }];
}

/** Group injected context events (attachments & system reminders) latest-first by type. */
export function buildContextGroups(
  events: EventRow[],
  rawById?: ReadonlyMap<string, string | null>,
): ContextGroup[] {
  const grouped = new Map<string, EventRow[]>();
  const contextEvents = events.filter((e) => isContext(e));

  for (let i = contextEvents.length - 1; i >= 0; i--) {
    const ev = contextEvents[i]!;
    const key = attachmentType(ev) ?? 'system_reminder';
    const list = grouped.get(key);
    if (list) list.push(ev);
    else grouped.set(key, [ev]);
  }

  const out: ContextGroup[] = [];
  for (const [key, list] of grouped.entries()) {
    const latestEvent = list[0]!;
    out.push({
      key,
      title: prettyLabel(key),
      count: list.length,
      latestEvent,
      fields: extractAttachmentFields(latestEvent, rawById?.get(latestEvent.id)),
    });
  }
  return out;
}
