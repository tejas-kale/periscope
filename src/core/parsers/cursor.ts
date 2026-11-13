import type { LineParser, ParseOp } from '../types.ts';
import { blockText, isObj, parseTs, pretty, tryJson } from '../util.ts';

export interface CursorState {
  turnId: string | null;
  toolTs: Record<string, number>;
}

function stripUserQuery(s: string): string {
  const m = s.match(/^\s*<user_query>\s*([\s\S]*?)\s*<\/user_query>\s*$/);
  return m ? m[1] : s;
}

/**
 * Parser for Cursor IDE and CLI JSONL transcripts under
 * `~/.cursor/projects/<project>/agent-transcripts/`.
 */
export const cursorParser: LineParser<CursorState> = {
  initialState: () => ({ turnId: null, toolTs: {} }),

  parseLine(line, offset, st, ctx) {
    const d = tryJson(line);
    const key = (i: number | string) => `${ctx.fileTag}@${offset}:${i}`;
    if (!isObj(d)) {
      return [{ op: 'event', ev: { id: ctx.id(key('bad')), kind: 'meta', parent_id: st.turnId ?? ctx.rootParent, text: 'Unparseable line', raw_json: line } }];
    }

    const ts = parseTs(d.timestamp ?? d.created_at);
    const msg = isObj(d.message) ? d.message : d;
    const role = typeof d.role === 'string' ? d.role : typeof msg.role === 'string' ? msg.role : null;
    if (!role) {
      if (typeof d.type === 'string' && typeof d.status === 'string') return [];
      return [{ op: 'event', ev: { id: ctx.id(key('meta')), kind: 'meta', parent_id: st.turnId ?? ctx.rootParent, text: pretty(d), raw_json: line } }];
    }

    const content = msg.content;
    const blocks = Array.isArray(content) ? content : null;
    const ops: ParseOp[] = [];

    if (role === 'user') {
      const results = blocks?.filter((b) => isObj(b) && b.type === 'tool_result') ?? [];
      if (results.length) {
        results.forEach((b, i) => {
          const callId = typeof b.tool_use_id === 'string' ? ctx.id(`tool:${b.tool_use_id}`) : st.turnId ?? ctx.rootParent;
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
          if (typeof b.tool_use_id === 'string') {
            const start = st.toolTs[b.tool_use_id];
            if (start != null && ts != null) {
              ops.push({ op: 'patch', id: callId!, fields: { duration_ms: ts - start } });
              delete st.toolTs[b.tool_use_id];
            }
          }
        });
        return ops;
      }

      const text = stripUserQuery(blockText(content));
      if (!text.trim()) return [];
      const tid = ctx.id(key('t'));
      st.turnId = tid;
      ops.push({ op: 'event', ev: { id: tid, parent_id: ctx.rootParent, kind: 'turn', role: 'user', ts, text, raw_json: line } });
      ops.push({ op: 'session', fields: { weakTitle: text, started_at: ts } });
      return ops;
    }

    if (role === 'assistant') {
      const parent = st.turnId ?? ctx.rootParent;
      if (!blocks) {
        const text = blockText(content);
        if (!text.trim()) return [];
        return [{ op: 'event', ev: { id: ctx.id(key(0)), parent_id: parent, kind: 'text', role: 'assistant', ts, text, raw_json: line } }];
      }
      blocks.forEach((b, i) => {
        if (!isObj(b)) return;
        const base = { parent_id: parent, role: 'assistant', ts, raw_json: line };
        if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
          ops.push({ op: 'event', ev: { ...base, id: ctx.id(key(i)), kind: 'reasoning', text: b.thinking } });
        } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          ops.push({ op: 'event', ev: { ...base, id: ctx.id(key(i)), kind: 'text', text: b.text } });
        } else if (b.type === 'tool_use') {
          const id = typeof b.id === 'string' ? ctx.id(`tool:${b.id}`) : ctx.id(key(i));
          if (typeof b.id === 'string' && ts != null) st.toolTs[b.id] = ts;
          ops.push({
            op: 'event',
            ev: { ...base, id, kind: 'tool_call', tool_name: typeof b.name === 'string' ? b.name : null, text: pretty(b.input) },
          });
        }
      });
      return ops;
    }

    return [{ op: 'event', ev: { id: ctx.id(key(0)), parent_id: st.turnId ?? ctx.rootParent, kind: 'meta', role, ts, text: blockText(content), raw_json: line } }];
  },
};
