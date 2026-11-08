import type { ParseContext, ParseOp } from './types.ts';
import { PARSERS, projectName, type AgyMeta, type TranscriptFile } from './sources.ts';
import type { Store } from './store.ts';
import { stableId, tryJson } from './util.ts';

export interface Chunk {
  file: TranscriptFile;
  /** Unique path of the source file (absolute on the Mac, `podman:<volume>:<path>` in the sandbox). */
  path: string;
  size: number;
  mtime: number;
  /** Byte offset `bytes` starts at; must equal `offsetFor(path, size)`. */
  start: number;
  bytes: Uint8Array;
  /** Parent tool call of a Claude subagent file, as its tool_use id. */
  parentToolUseId?: string | null;
  /** Title and workspace from Antigravity's metadata file. */
  agyMeta?: AgyMeta;
}

export interface IngestResult {
  sessionId: string;
  inserted: number;
  offset: number;
}

const NL = 10;
const decoder = new TextDecoder();

/**
 * Turns appended transcript bytes into events. Append-only and idempotent: each file's read offset and parser
 * state are stored with the events in one transaction, and event ids derive from stable keys, so reading the
 * same bytes twice inserts nothing new.
 */
export class Ingestor {
  private store: Store;
  private now: () => number;
  private rescan = new Set<string>();

  constructor(store: Store, now: () => number = Date.now) {
    this.store = store;
    this.now = now;
  }

  /** Where to resume reading `path`. A file that shrank is reset: its session is dropped and re-read from zero. */
  offsetFor(path: string, size: number): number {
    const rec = this.store.getFile(path);
    if (!rec) return 0;
    if (size < rec.offset) {
      if (rec.session_id) {
        for (const f of this.store.filesForSession(rec.session_id)) if (f.path !== path) this.rescan.add(f.path);
        this.store.transaction(() => this.store.resetSession(rec.session_id!));
      } else {
        this.store.putFile({ ...rec, offset: 0, state: null });
      }
      return 0;
    }
    return rec.offset;
  }

  /** Paths whose offsets were rewound because a sibling file in their session shrank. */
  drainRescans(): string[] {
    const out = [...this.rescan];
    this.rescan.clear();
    return out;
  }

  ingest(c: Chunk): IngestResult {
    const { file, store } = { file: c.file, store: this.store };
    const parser = PARSERS[file.agent];
    const sessionId = file.sessionId;
    const rec = store.getFile(c.path);
    const offset = rec?.offset ?? 0;
    if (c.start !== offset) throw new Error(`chunk for ${c.path} starts at ${c.start}, expected ${offset}`);

    // Only whole lines are consumed; a trailing partial line waits for the next read,
    // unless the file has been quiet for a while and the remainder is complete JSON.
    let end = c.bytes.lastIndexOf(NL) + 1;
    if (end < c.bytes.length && this.now() - c.mtime > 10_000 && c.start + c.bytes.length >= c.size) {
      if (tryJson(decoder.decode(c.bytes.subarray(end))) !== undefined) end = c.bytes.length;
    }

    const state = (rec?.state && tryJson(rec.state)) || parser.initialState();
    const ctx: ParseContext = {
      sessionId,
      fileTag: file.fileTag,
      id: (key) => stableId(sessionId, key),
      rootParent: c.parentToolUseId ? stableId(sessionId, `tool:${c.parentToolUseId}`) : null,
    };

    let inserted = 0;
    store.transaction(() => {
      store.ensureSession(sessionId, file.agent, file.host, c.path);
      if (file.fileTag === 'm') store.setSourcePath(sessionId, c.path);
      if (c.agyMeta) {
        store.updateSession(sessionId, { cwd: c.agyMeta.cwd, project: projectName(c.agyMeta.cwd), title: c.agyMeta.title });
      }
      let seq = store.nextSeq(sessionId);
      let pos = 0;
      while (pos < end) {
        let nl = c.bytes.indexOf(NL, pos);
        if (nl === -1 || nl >= end) nl = end;
        const line = decoder.decode(c.bytes.subarray(pos, nl)).trim();
        if (line) {
          let ops: ParseOp[];
          try {
            ops = parser.parseLine(line, c.start + pos, state, ctx);
          } catch (e) {
            ops = [{ op: 'event', ev: { id: ctx.id(`${file.fileTag}@${c.start + pos}:err`), kind: 'meta', text: `Parser error: ${String(e)}`, raw_json: line } }];
          }
          for (const op of ops) {
            if (op.op === 'event') {
              if (store.insertEvent(sessionId, seq, op.ev)) (seq++, inserted++);
            } else if (op.op === 'patch') {
              store.patchEvent(op.id, op.fields);
            } else {
              store.updateSession(sessionId, { ...op.fields, project: projectName(op.fields.cwd) });
            }
          }
        }
        pos = nl + 1;
      }
      store.putFile({ path: c.path, host: file.host, offset: offset + end, mtime: c.mtime, session_id: sessionId, state: JSON.stringify(state) });
      if (end > 0 || !rec) store.touchSession(sessionId, c.mtime, this.now());
    });
    return { sessionId, inserted, offset: offset + end };
  }
}
