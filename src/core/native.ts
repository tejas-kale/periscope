import fs from 'node:fs/promises';
import path from 'node:path';
import type { Agent } from './types.ts';
import type { Ingestor } from './ingest.ts';
import type { Store } from './store.ts';
import { AGENT_DIRS, AGY_METADATA, applyAgyMeta, classify, parseAgyMetadata, type AgyMeta, type TranscriptFile } from './sources.ts';
import { ingestCursorStoreDb } from './parsers/cursor-store.ts';

export interface NativeRoot {
  agent: Agent;
  /** Absolute transcript dir, e.g. `~/.claude/projects`. */
  dir: string;
}

export function nativeRoots(home: string): { roots: NativeRoot[]; agyMetadata: string } {
  return {
    roots: [
      { agent: 'claude', dir: path.join(home, '.claude', AGENT_DIRS.claude) },
      { agent: 'codex', dir: path.join(home, '.codex', AGENT_DIRS.codex) },
      { agent: 'antigravity', dir: path.join(home, '.gemini', AGENT_DIRS.antigravity) },
      { agent: 'cursor', dir: path.join(home, '.cursor', AGENT_DIRS.cursor) },
      { agent: 'cursor', dir: path.join(home, '.cursor', 'chats') },
    ],
    agyMetadata: path.join(home, '.gemini', AGY_METADATA),
  };
}

const STEP = 8 << 20;

/**
 * Reads host-native transcript files from their stored offset. Paths are queued and processed one at a time,
 * so a burst of change events for one file costs one read.
 */
export class NativeReader {
  private queue = new Set<string>();
  private busy = false;
  private agyMeta: Record<string, AgyMeta> = {};
  private agyMetaMtime = -1;
  private ingestor: Ingestor;
  private store: Store;
  private roots: NativeRoot[];
  private agyMetadataPath: string;
  private onIngested: (ids: string[]) => void;
  idle: Promise<void> = Promise.resolve();
  private resolveIdle: (() => void) | null = null;

  constructor(o: { ingestor: Ingestor; store: Store; roots: NativeRoot[]; agyMetadata: string; onIngested: (ids: string[]) => void }) {
    this.ingestor = o.ingestor;
    this.store = o.store;
    this.roots = o.roots;
    this.agyMetadataPath = o.agyMetadata;
    this.onIngested = o.onIngested;
  }

  /** Map an absolute path to its transcript file, or null if it is not one. */
  classify(abs: string): (TranscriptFile & { root: NativeRoot }) | null {
    for (const root of this.roots) {
      const rel = path.relative(root.dir, abs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      const f = classify(root.agent, 'native', rel);
      return f ? { ...f, root } : null;
    }
    return null;
  }

  enqueue(abs: string): void {
    const base = path.basename(abs);
    if (abs === this.agyMetadataPath) {
      this.agyMetaMtime = -1; // drain() re-reads it
    } else if (base === 'store.db-wal' || base === 'store.db-shm' || base === 'meta.json') {
      const dbPath = path.join(path.dirname(abs), 'store.db');
      if (this.classify(dbPath)) this.queue.add(dbPath);
      else return;
    } else if (this.classify(abs)) this.queue.add(abs);
    else return;
    if (!this.busy) {
      this.idle = new Promise((r) => (this.resolveIdle = r));
      void this.drain();
    }
  }

  private async drain() {
    this.busy = true;
    const changed = new Set<string>();
    let lastFlush = Date.now();
    try {
      while (this.queue.size) {
        const [p] = this.queue;
        this.queue.delete(p);
        try {
          if (await this.read(p)) changed.add(this.classify(p)!.sessionId);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error('periscope: reading', p, e);
        }
        for (const r of this.ingestor.drainRescans()) if (!r.startsWith('podman:')) this.queue.add(r);
        if (changed.size && Date.now() - lastFlush > 250) {
          this.onIngested([...changed]);
          changed.clear();
          lastFlush = Date.now();
        }
        await new Promise((r) => setImmediate(r)); // keep the main process responsive during the first full scan
      }
      if (await this.refreshAgyMeta()) for (const id of Object.keys(this.agyMeta)) changed.add(`n:${id}`);
    } finally {
      this.busy = false;
      if (changed.size) this.onIngested([...changed]);
      this.resolveIdle?.();
    }
  }

  private async refreshAgyMeta(): Promise<boolean> {
    try {
      const st = await fs.stat(this.agyMetadataPath);
      if (st.mtimeMs === this.agyMetaMtime) return false;
      this.agyMetaMtime = st.mtimeMs;
      this.agyMeta = parseAgyMetadata(await fs.readFile(this.agyMetadataPath, 'utf8'));
      applyAgyMeta(this.store, 'native', this.agyMeta);
      return true;
    } catch {
      return false;
    }
  }

  /** Read new bytes of one file; returns whether any events were inserted. */
  async read(abs: string): Promise<boolean> {
    const file = this.classify(abs);
    if (!file) return false;
    if (file.agent === 'antigravity') await this.refreshAgyMeta();
    if (path.basename(abs) === 'store.db') {
      const st = await fs.stat(abs);
      let mtime = st.mtimeMs;
      try {
        const wal = await fs.stat(`${abs}-wal`);
        mtime = Math.max(mtime, wal.mtimeMs);
      } catch {
        /* no WAL */
      }
      if (this.store.getFile(abs)?.mtime === mtime) return false;
      return ingestCursorStoreDb(abs, this.store, file, mtime, st.size) > 0;
    }
    let parentToolUseId: string | null = null;
    if (file.subagentMeta) {
      try {
        parentToolUseId = JSON.parse(await fs.readFile(path.join(file.root.dir, file.subagentMeta), 'utf8')).toolUseId ?? null;
      } catch {
        /* meta not written yet: nest at the session root */
      }
    }
    const fh = await fs.open(abs, 'r');
    let inserted = 0;
    try {
      const st = await fh.stat();
      let start = this.ingestor.offsetFor(abs, st.size);
      let step = STEP;
      while (start < st.size) {
        const len = Math.min(step, st.size - start);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, start);
        const r = this.ingestor.ingest({
          file,
          path: abs,
          size: st.size,
          mtime: st.mtimeMs,
          start,
          bytes: buf.subarray(0, bytesRead),
          parentToolUseId,
          agyMeta: file.agent === 'antigravity' ? this.agyMeta[file.conversation] : undefined,
        });
        inserted += r.inserted;
        if (r.offset === start) {
          if (start + len >= st.size) break; // only a partial line left: wait for the writer
          step *= 2; // one line longer than the step
        } else step = STEP;
        start = r.offset;
      }
    } finally {
      await fh.close();
    }
    return inserted > 0;
  }
}
