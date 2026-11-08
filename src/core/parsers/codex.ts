import type { LineParser, ParseOp } from '../types.ts';
import { blockText, isObj, parseTs, pretty, tryJson } from '../util.ts';

export interface CodexState {
  turnId: string | null;
  lastModelId: string | null;
  callTs: Record<string, number>;
}

/** Records that repeat other records or carry only configuration. */
const SKIP_TOP = new Set(['world_state', 'turn_context', 'compacted']);
const SKIP_EVENT = new Set([
  'item_completed',
  'item_started',
  'thread_settings_applied',
  'task_started',
  'task_complete',
  'user_message',
  'agent_message',
  'agent_reasoning',
  'agent_reasoning_raw_content',
  'token_count',
  'exec_command_begin',
  'exec_command_end',
  'patch_apply_begin',
  'patch_apply_end',
  'turn_diff',
]);
const SKIP_ITEM = new Set(['additional_tools']);

/** Injected context the CLI sends as a "user" message. */
const CONTEXT_PREFIXES = ['# AGENTS.md', '<environment_context>', '<user_instructions>', '<permissions', '<INSTRUCTIONS>'];

function outputText(out: unknown): { text: string; error: boolean } {
  if (typeof out === 'string') {
    const j = tryJson(out);
    if (isObj(j) && typeof j.output === 'string') {
      const code = j.metadata?.exit_code;
      return { text: j.output, error: typeof code === 'number' && code !== 0 };
    }
    return { text: out, error: false };
  }
  if (isObj(out) && typeof out.content === 'string') return { text: out.content, error: out.success === false };
  return { text: blockText(out), error: false };
}

export const codexParser: LineParser<CodexState> = {
  initialState: () => ({ turnId: null, lastModelId: null, callTs: {} }),

  parseLine(line, offset, st, ctx) {
    const d = tryJson(line);
    const id = (i: number | string = 0) => ctx.id(`${ctx.fileTag}@${offset}:${i}`);
    if (!isObj(d)) return [{ op: 'event', ev: { id: id('bad'), kind: 'meta', parent_id: st.turnId, text: 'Unparseable line', raw_json: line } }];
    const ts = parseTs(d.timestamp);
    const p = isObj(d.payload) ? d.payload : {};
    const type = d.type as string;
    const parent = st.turnId;
    const mk = (f: { id: string; kind: any; text: string; ts: number | null; role?: string; tool_name?: string | null; parent_id?: string | null }): ParseOp => ({
      op: 'event',
      ev: { parent_id: parent, raw_json: line, ...f },
    });
    const ev = (fields: Omit<Parameters<typeof mk>[0], 'ts'>) => mk({ ts, ...fields });

    if (SKIP_TOP.has(type)) return [];
    if (type === 'session_meta') {
      return [{ op: 'session', fields: { cwd: p.cwd ?? null, started_at: parseTs(p.timestamp) ?? ts } }];
    }
    if (type === 'token_usage_record') {
      const u = p.usage;
      if (!st.lastModelId || !isObj(u)) return [];
      return [{ op: 'patch', id: st.lastModelId, fields: { tokens_in: u.input_tokens ?? null, tokens_out: (u.output_tokens ?? 0) || null } }];
    }
    if (type === 'event_msg') {
      if (SKIP_EVENT.has(p.type)) return [];
      if (p.type === 'error' || p.type === 'stream_error') return [ev({ id: id(), kind: 'error', text: p.message ?? pretty(p) })];
      return [ev({ id: id(), kind: 'meta', text: `[${p.type}]` })];
    }
    if (type !== 'response_item') return [ev({ id: id(), kind: 'meta', text: `[${type ?? 'unknown'}]` })];
    if (SKIP_ITEM.has(p.type)) return [];

    switch (p.type) {
      case 'message': {
        const text = blockText(p.content);
        if (p.role === 'user') {
          if (CONTEXT_PREFIXES.some((x) => text.startsWith(x))) return [ev({ id: id(), kind: 'meta', role: 'user', text })];
          const tid = id();
          st.turnId = tid;
          return [mk({ id: tid, kind: 'turn', role: 'user', text, ts, parent_id: null }), { op: 'session', fields: { weakTitle: text } }];
        }
        if (p.role === 'assistant') {
          st.lastModelId = id();
          return [ev({ id: st.lastModelId, kind: 'text', role: 'assistant', text })];
        }
        return [ev({ id: id(), kind: 'meta', role: p.role ?? null, text })];
      }
      case 'reasoning': {
        const parts = [...(p.summary ?? []), ...(p.content ?? [])].map((x: any) => x?.text).filter(Boolean);
        st.lastModelId = id();
        return [ev({ id: st.lastModelId, kind: 'reasoning', role: 'assistant', text: parts.join('\n\n') })];
      }
      case 'function_call':
      case 'custom_tool_call':
      case 'local_shell_call':
      case 'web_search_call':
      case 'tool_search_call': {
        const callId = p.call_id ?? p.id;
        const cid = callId ? ctx.id(`call:${callId}`) : id();
        if (callId && ts != null) st.callTs[callId] = ts;
        st.lastModelId = cid;
        const name = p.name ?? (p.type === 'local_shell_call' ? 'shell' : p.type.replace(/_call$/, ''));
        const body = p.type === 'function_call' ? pretty(p.arguments) : p.type === 'custom_tool_call' ? String(p.input ?? '') : pretty(p.action ?? p);
        return [ev({ id: cid, kind: 'tool_call', role: 'assistant', tool_name: name, text: body })];
      }
      case 'function_call_output':
      case 'custom_tool_call_output':
      case 'local_shell_call_output':
      case 'tool_search_output': {
        const callId = p.call_id;
        const cid = callId ? ctx.id(`call:${callId}`) : parent;
        const { text, error } = outputText(p.output);
        const ops: ParseOp[] = [ev({ id: id(), kind: error ? 'error' : 'tool_result', role: 'tool', text, parent_id: cid })];
        const start = callId ? st.callTs[callId] : undefined;
        if (start != null && ts != null && cid) {
          ops.push({ op: 'patch', id: cid, fields: { duration_ms: ts - start } });
          delete st.callTs[callId];
        }
        return ops;
      }
      default:
        return [ev({ id: id(), kind: 'meta', text: `[${p.type ?? 'response_item'}]` })];
    }
  },
};
