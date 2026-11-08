import type { LineParser, ParseOp } from '../types.ts';
import { isObj, parseTs, pretty, tryJson } from '../util.ts';

/**
 * Antigravity CLI (`agy`) writes one JSON object per step to
 * `brain/<conversation>/.system_generated/logs/transcript_full.jsonl`.
 * Tool calls carry no ids: each GENERIC step after a PLANNER_RESPONSE is the result of the next pending call, in order.
 */
export interface AgyState {
  turnId: string | null;
  pending: { id: string; ts: number | null }[];
}

function userText(s: string): string {
  const m = s.match(/<USER_REQUEST>\s*([\s\S]*?)\s*(<\/USER_REQUEST>|$)/);
  return m ? m[1].trim() : s;
}

/** Results start with "Created At: …\nCompleted At: …\n"; drop that header. */
function resultText(s: string): string {
  return s.replace(/^Created At: [^\n]*\n(Completed At: [^\n]*\n)?/, '');
}

export const antigravityParser: LineParser<AgyState> = {
  initialState: () => ({ turnId: null, pending: [] }),

  parseLine(line, offset, st, ctx) {
    const d = tryJson(line);
    const step = isObj(d) && typeof d.step_index === 'number' ? `S${d.step_index}` : `${ctx.fileTag}@${offset}`;
    const id = (i: number | string = 0) => ctx.id(`${step}:${i}`);
    if (!isObj(d)) return [{ op: 'event', ev: { id: id('bad'), kind: 'meta', parent_id: st.turnId, text: 'Unparseable line', raw_json: line } }];
    const ts = parseTs(d.created_at);
    const content = typeof d.content === 'string' ? d.content : '';
    const base = { ts, raw_json: line };

    switch (d.type) {
      case 'USER_INPUT': {
        const tid = id();
        st.turnId = tid;
        st.pending = [];
        const text = userText(content);
        return [
          { op: 'event', ev: { ...base, id: tid, parent_id: null, kind: 'turn', role: 'user', text } },
          { op: 'session', fields: { weakTitle: text, started_at: ts } },
        ];
      }
      case 'PLANNER_RESPONSE': {
        const ops: ParseOp[] = [];
        const evBase = { ...base, parent_id: st.turnId, role: 'assistant' };
        if (typeof d.thinking === 'string' && d.thinking.trim()) ops.push({ op: 'event', ev: { ...evBase, id: id('think'), kind: 'reasoning', text: d.thinking } });
        if (content.trim()) ops.push({ op: 'event', ev: { ...evBase, id: id('text'), kind: 'text', text: content } });
        const calls: unknown[] = Array.isArray(d.tool_calls) ? d.tool_calls : [];
        calls.forEach((c, i) => {
          if (!isObj(c)) return;
          const cid = id(`tc${i}`);
          st.pending.push({ id: cid, ts });
          ops.push({ op: 'event', ev: { ...evBase, id: cid, kind: 'tool_call', tool_name: c.name ?? null, text: pretty(c.args) } });
        });
        if (ops.length) {
          const tin = (d.input_tokens ?? 0) + (d.cache_read_tokens ?? 0);
          const first = ops[0] as Extract<ParseOp, { op: 'event' }>;
          first.ev.tokens_in = tin || null;
          first.ev.tokens_out = d.output_tokens ?? null;
        }
        return ops;
      }
      case 'GENERIC': {
        const call = st.pending.shift();
        const isErr = d.status === 'ERROR' || typeof d.error === 'string';
        const text = resultText(content) || (typeof d.error === 'string' ? d.error : '');
        const ops: ParseOp[] = [
          { op: 'event', ev: { ...base, id: id(), parent_id: call?.id ?? st.turnId, kind: isErr ? 'error' : call ? 'tool_result' : 'meta', role: 'tool', text } },
        ];
        if (call && call.ts != null && ts != null) ops.push({ op: 'patch', id: call.id, fields: { duration_ms: ts - call.ts } });
        return ops;
      }
      case 'SYSTEM_MESSAGE':
        return [{ op: 'event', ev: { ...base, id: id(), parent_id: st.turnId, kind: 'meta', role: 'system', text: content } }];
      default:
        return [{ op: 'event', ev: { ...base, id: id(), parent_id: st.turnId, kind: 'meta', text: content || `[${d.type ?? 'unknown'}]` } }];
    }
  },
};
