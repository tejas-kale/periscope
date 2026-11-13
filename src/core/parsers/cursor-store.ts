import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ParseOp } from '../types.ts';
import type { Store } from '../store.ts';
import { projectName, type TranscriptFile } from '../sources.ts';
import { blockText, isObj, parseTs, pretty, stableId, tryJson } from '../util.ts';

function readVarint(buf: Uint8Array, pos: number): [number, number] | null {
  let val = 0;
  let shift = 0;
  while (pos < buf.length) {
    const b = buf[pos++]!;
    val |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [val, pos];
    shift += 7;
    if (shift > 35) return null;
  }
  return null;
}

/** Extract 32-byte SHA-256 child blob digests from a protobuf tree node (repeated field 1). */
function decodeTreeRefs(buf: Uint8Array): string[] {
  const refs: string[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const tagRes = readVarint(buf, pos);
    if (!tagRes) break;
    const [tag, afterTag] = tagRes;
    const field = tag >>> 3;
    const wire = tag & 0x07;
    if (wire === 2) {
      const lenRes = readVarint(buf, afterTag);
      if (!lenRes) break;
      const [len, start] = lenRes;
      const end = start + len;
      if (end > buf.length) break;
      if (field === 1 && len === 32) {
        refs.push(Buffer.from(buf.subarray(start, end)).toString('hex'));
      }
      pos = end;
    } else if (wire === 0) {
      const vRes = readVarint(buf, afterTag);
      if (!vRes) break;
      pos = vRes[1];
    } else if (wire === 1) {
      pos = afterTag + 8;
    } else if (wire === 5) {
      pos = afterTag + 4;
    } else {
      break;
    }
  }
  return refs;
}

function decodeHexJson(raw: string): Record<string, any> | null {
  const direct = tryJson(raw);
  if (isObj(direct)) return direct;
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) {
    const decoded = tryJson(Buffer.from(raw, 'hex').toString('utf8'));
    if (isObj(decoded)) return decoded;
  }
  return null;
}

function stripUserQuery(s: string): string {
  const m = s.match(/^\s*<user_query>\s*([\s\S]*?)\s*<\/user_query>\s*$/);
  return m ? m[1] : s;
}

function messageOps(
  msg: Record<string, any>,
  blobId: string,
  st: { turnId: string | null },
  id: (key: string) => string,
  ts: number | null,
): ParseOp[] {
  const role = typeof msg.role === 'string' ? msg.role : null;
  if (!role) return [];
  const content = msg.content;
  const blocks = Array.isArray(content) ? content : null;
  const ops: ParseOp[] = [];
  const rawJson = JSON.stringify(msg);

  if (role === 'user') {
    const text = stripUserQuery(blockText(content));
    if (!text.trim()) return [];
    const tid = id(`db:${blobId}:t`);
    st.turnId = tid;
    ops.push({ op: 'event', ev: { id: tid, parent_id: null, kind: 'turn', role: 'user', ts, text, raw_json: rawJson } });
    ops.push({ op: 'session', fields: { weakTitle: text, started_at: ts } });
    return ops;
  }

  if (role === 'assistant') {
    const parent = st.turnId;
    if (!blocks) {
      const text = blockText(content);
      if (!text.trim()) return [];
      return [{ op: 'event', ev: { id: id(`db:${blobId}:0`), parent_id: parent, kind: 'text', role: 'assistant', ts, text, raw_json: rawJson } }];
    }
    blocks.forEach((b, i) => {
      if (!isObj(b)) return;
      const base = { parent_id: parent, role: 'assistant', ts, raw_json: rawJson };
      if (b.type === 'reasoning') {
        const text = typeof b.text === 'string' ? b.text : typeof b.reasoning === 'string' ? b.reasoning : '';
        if (text.trim()) ops.push({ op: 'event', ev: { ...base, id: id(`db:${blobId}:${i}`), kind: 'reasoning', text } });
      } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        ops.push({ op: 'event', ev: { ...base, id: id(`db:${blobId}:${i}`), kind: 'text', text: b.text } });
      } else if (b.type === 'tool-call' || b.type === 'tool_use') {
        const tcId = typeof b.toolCallId === 'string' ? b.toolCallId : typeof b.id === 'string' ? b.id : null;
        const evId = tcId ? id(`tool:${tcId}`) : id(`db:${blobId}:${i}`);
        const toolName = typeof b.toolName === 'string' ? b.toolName : typeof b.name === 'string' ? b.name : null;
        const args = b.args !== undefined ? b.args : b.input;
        ops.push({ op: 'event', ev: { ...base, id: evId, kind: 'tool_call', tool_name: toolName, text: pretty(args) } });
      }
    });
    return ops;
  }

  if (role === 'tool' && blocks) {
    blocks.forEach((b, i) => {
      if (!isObj(b) || (b.type !== 'tool-result' && b.type !== 'tool_result')) return;
      const tcId = typeof b.toolCallId === 'string' ? b.toolCallId : typeof b.tool_use_id === 'string' ? b.tool_use_id : null;
      const parent = tcId ? id(`tool:${tcId}`) : st.turnId;
      const isErr = b.isError === true || b.is_error === true;
      const payload = b.result !== undefined ? b.result : b.output !== undefined ? b.output : b.content;
      const text = typeof payload === 'string' ? payload : blockText(payload);
      ops.push({
        op: 'event',
        ev: { id: id(`db:${blobId}:${i}`), parent_id: parent, kind: isErr ? 'error' : 'tool_result', role: 'tool', ts, text, raw_json: rawJson },
      });
    });
    return ops;
  }

  return [];
}

/**
 * Ingest a Cursor CLI `store.db` SQLite database (and optional sibling `meta.json`) into `Store`.
 * Idempotent: events use deterministic blob-keyed IDs.
 */
export function ingestCursorStoreDb(dbPath: string, store: Store, file: TranscriptFile, mtime: number, size: number): number {
  const sessionId = file.sessionId;
  const id = (key: string) => stableId(sessionId, key);

  let siblingMeta: Record<string, any> | null = null;
  try {
    const parsed = tryJson(fs.readFileSync(path.join(path.dirname(dbPath), 'meta.json'), 'utf8'));
    if (isObj(parsed)) siblingMeta = parsed;
  } catch {
    /* optional sibling meta.json */
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  let metaObj: Record<string, any> = {};
  const messages: { blobId: string; msg: Record<string, any> }[] = [];

  try {
    const metaRows = db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[];
    for (const row of metaRows) {
      const decoded = decodeHexJson(row.value);
      if (decoded) {
        metaObj = { ...metaObj, ...decoded };
      }
    }

    const rootId = typeof metaObj?.latestRootBlobId === 'string' ? metaObj.latestRootBlobId : null;
    if (rootId) {
      const getBlob = db.prepare('SELECT data FROM blobs WHERE id = ?');
      const visited = new Set<string>();
      const walk = (blobId: string) => {
        if (visited.has(blobId)) return;
        visited.add(blobId);
        const row = getBlob.get(blobId) as { data: Uint8Array } | undefined;
        if (!row?.data) return;
        const buf = row.data;
        if (buf[0] === 0x7b) {
          const parsed = tryJson(Buffer.from(buf).toString('utf8'));
          if (isObj(parsed)) {
            messages.push({ blobId, msg: parsed });
            return;
          }
        }
        for (const childId of decodeTreeRefs(buf)) {
          walk(childId);
        }
      };
      walk(rootId);
    }
  } finally {
    db.close();
  }

  const cwd = typeof siblingMeta?.cwd === 'string' ? siblingMeta.cwd : null;
  const title =
    (typeof metaObj?.name === 'string' && metaObj.name) ||
    (typeof siblingMeta?.title === 'string' && siblingMeta.title) ||
    (typeof siblingMeta?.name === 'string' && siblingMeta.name) ||
    null;
  const startedAt = parseTs(metaObj?.createdAt ?? siblingMeta?.createdAtMs);

  let inserted = 0;
  store.transaction(() => {
    store.ensureSession(sessionId, file.agent, file.host, dbPath);
    store.setSourcePath(sessionId, dbPath);
    if (cwd || title || startedAt != null) {
      store.updateSession(sessionId, { cwd, project: projectName(cwd), title, started_at: startedAt });
    }
    let seq = store.nextSeq(sessionId);
    const st = { turnId: null as string | null };
    for (const { blobId, msg } of messages) {
      const msgTs = parseTs(msg.createdAt ?? msg.timestamp) ?? startedAt;
      for (const op of messageOps(msg, blobId, st, id, msgTs)) {
        if (op.op === 'event') {
          if (store.insertEvent(sessionId, seq, op.ev)) (seq++, inserted++);
        } else if (op.op === 'session') {
          store.updateSession(sessionId, { ...op.fields, project: projectName(op.fields.cwd) });
        }
      }
    }
    store.putFile({ path: dbPath, host: file.host, offset: size, mtime, session_id: sessionId, state: null });
  });

  return inserted;
}
