import type { LineParser, ParseOp } from '../types.ts';
import { blockText, isObj, parseTs, pretty, tryJson } from '../util.ts';

export interface ClaudeState {
  turnId: string | null;
  /** First event id per assistant message id, to hold that message's token usage. */
  msgFirst: Record<string, string>;
  msgOrder: string[];
  /** Start time per pending tool_use id, for the call's duration. */
  toolTs: Record<string, number>;
}

/** Record types that carry no transcript content; skipped on purpose. */
const SKIP = new Set([
  'api-request',
  'api-request-blob',
  'api-request-shape',
  'file-history-snapshot',
  'file-history-delta',
  'atis-latch',
  'session-owner',
  'mode',
  'permission-mode',
  'last-prompt',
  'tools-used',
  'cost-state',
  'queue-operation',
  'summary',
  'bridge-session',
  'agent-name',
  'continued-in',
  'frame-link',
]);
/** Bookkeeping records from artifact and plugin features. */
const SKIP_PREFIX = ['artifact-'];

function usageTokens(u: unknown): { tokens_in: number | null; tokens_out: number | null } {
  if (!isObj(u)) return { tokens_in: null, tokens_out: null };
  const inp = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  return { tokens_in: inp || null, tokens_out: u.output_tokens ?? null };
}

export const claudeParser: LineParser<ClaudeState> = {
  initialState: () => ({ turnId: null, msgFirst: {}, msgOrder: [], toolTs: {} }),

  parseLine(line, offset, st, ctx) {
    const d = tryJson(line);
    const key = (i: number | string) => `${ctx.fileTag}@${offset}:${i}`;
    if (!isObj(d)) {
      return [{ op: 'event', ev: { id: ctx.id(key('bad')), kind: 'meta', parent_id: st.turnId ?? ctx.rootParent, text: 'Unparseable line', raw_json: line } }];
    }
    const type = d.type as string;
    if (SKIP.has(type) || SKIP_PREFIX.some((p) => type?.startsWith(p))) return [];
    const ts = parseTs(d.timestamp);
    const ops: ParseOp[] = [];
    if (typeof d.cwd === 'string') ops.push({ op: 'session', fields: { cwd: d.cwd, started_at: ts } });

    if (type === 'ai-title') {
      return [{ op: 'session', fields: { title: d.aiTitle ?? null } }];
    }

    if (type === 'user' && isObj(d.message)) {
      const content = d.message.content;
      const blocks = Array.isArray(content) ? content : null;
      const results = blocks?.filter((b) => isObj(b) && b.type === 'tool_result') ?? [];
      if (results.length) {
        results.forEach((b, i) => {
          const callId = ctx.id(`tool:${b.tool_use_id}`);
          const isErr = b.is_error === true;
          ops.push({
            op: 'event',
            ev: {
              id: ctx.id(key(i)),
              parent_id: callId,
              kind: isErr ? 'error' : 'tool_result',
              role: 'tool',
              ts,
              text: blockText(b.content),
              raw_json: line,
            },
          });
          const start = st.toolTs[b.tool_use_id];
          if (start != null && ts != null) {
            ops.push({ op: 'patch', id: callId, fields: { duration_ms: ts - start } });
            delete st.toolTs[b.tool_use_id];
          }
        });
        return ops;
      }
      const text = blockText(content);
      if (d.isMeta || d.isCompactSummary) {
        ops.push({ op: 'event', ev: { id: ctx.id(key(0)), parent_id: st.turnId ?? ctx.rootParent, kind: 'meta', role: 'user', ts, text, raw_json: line } });
        return ops;
      }
      const id = ctx.id(key(0));
      ops.push({ op: 'event', ev: { id, parent_id: ctx.rootParent, kind: 'turn', role: 'user', ts, text, raw_json: line } });
      if (!ctx.rootParent) ops.push({ op: 'session', fields: { weakTitle: text } });
      st.turnId = id;
      return ops;
    }

    if (type === 'assistant' && isObj(d.message)) {
      const m = d.message;
      const blocks: unknown[] = Array.isArray(m.content) ? m.content : [{ type: 'text', text: blockText(m.content) }];
      const parent = st.turnId ?? ctx.rootParent;
      blocks.forEach((b, i) => {
        if (!isObj(b)) return;
        const base = { parent_id: parent, role: 'assistant', ts, raw_json: line };
        let id = ctx.id(key(i));
        if (b.type === 'thinking' || b.type === 'redacted_thinking') {
          ops.push({ op: 'event', ev: { ...base, id, kind: 'reasoning', text: b.thinking || '', duration_ms: d.thinkingDurationMs ?? null } });
        } else if (b.type === 'text') {
          ops.push({ op: 'event', ev: { ...base, id, kind: 'text', text: b.text ?? '' } });
        } else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
          id = ctx.id(`tool:${b.id}`);
          if (ts != null) st.toolTs[b.id] = ts;
          ops.push({ op: 'event', ev: { ...base, id, kind: 'tool_call', tool_name: b.name ?? null, text: pretty(b.input) } });
        } else {
          ops.push({ op: 'event', ev: { ...base, id, kind: 'meta', text: `[${b.type}]` } });
        }
        // Token usage is repeated on every line of a message: keep it once, on the message's first event, latest value wins.
        const msgId = typeof m.id === 'string' ? m.id : null;
        if (msgId && m.usage) {
          let first = st.msgFirst[msgId];
          if (!first) {
            first = id;
            st.msgFirst[msgId] = id;
            st.msgOrder.push(msgId);
            if (st.msgOrder.length > 50) delete st.msgFirst[st.msgOrder.shift()!];
          }
          ops.push({ op: 'patch', id: first, fields: usageTokens(m.usage) });
        }
      });
      return ops;
    }

    if (type === 'system') {
      const text = typeof d.content === 'string' ? d.content : d.subtype ?? 'system';
      ops.push({ op: 'event', ev: { id: ctx.id(key(0)), parent_id: st.turnId ?? ctx.rootParent, kind: d.level === 'error' ? 'error' : 'meta', role: 'system', ts, text, raw_json: line } });
      return ops;
    }

    if (type === 'attachment' && isObj(d.attachment)) {
      const a = d.attachment;
      const text = [a.type, a.hookName, a.content, a.stdout, a.stderr].filter((x) => typeof x === 'string' && x).join('\n');
      ops.push({ op: 'event', ev: { id: ctx.id(key(0)), parent_id: st.turnId ?? ctx.rootParent, kind: 'meta', role: 'attachment', ts, text, raw_json: line } });
      return ops;
    }

    ops.push({ op: 'event', ev: { id: ctx.id(key(0)), parent_id: st.turnId ?? ctx.rootParent, kind: 'meta', ts, text: `[${type ?? 'unknown'}]`, raw_json: line } });
    return ops;
  },
};

