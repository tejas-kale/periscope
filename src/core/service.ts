import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Ingestor } from './ingest.ts';
import { NativeReader, nativeRoots, type NativeRoot } from './native.ts';
import { DEFAULT_IMAGE, PodmanPoller, type Exec } from './podman.ts';
import { parseClaudeProcs, presenceChanges, presenceMap, type ClaudeProc, type Presence } from './presence.ts';
import { Store, type SqlDb } from './store.ts';
import type { ChangeNotice, EventRow, PeriscopeApi, SandboxState, SearchHit, SessionFilter, SessionRow } from './types.ts';

export interface DbPathOptions {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

/** Return the per-user SQLite database path: macOS preserves the Electron userData location; Linux uses XDG_DATA_HOME. */
export function defaultDbPath(opts: DbPathOptions = {}): string {
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? os.homedir();
  const env = opts.env ?? process.env;
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Periscope', 'periscope.db');
  }
  const xdg = env.XDG_DATA_HOME?.trim();
  const base = xdg || path.join(home, '.local', 'share');
  return path.join(base, 'periscope', 'periscope.db');
}

export interface IndexProgress {
  indexed: number;
  total: number;
  done: boolean;
}

export interface PeriscopeServiceOptions {
  dbPath?: string;
  roots?: NativeRoot[];
  agyMetadata?: string;
  claudeSessionsDir?: string;
  clock?: () => number;
  exec?: Exec;
  podman?: string | null;
  sandboxEnabled?: boolean;
  sandboxImage?: string;
  pollMs?: number;
  presenceMs?: number;
  expireMs?: number;
  debounceMs?: number;
  watchEnsureMs?: number;
  isAlive?: (pid: number) => boolean;
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const defaultIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

function findPodman(): string | null {
  const candidates = ['/opt/homebrew/bin/podman', '/usr/local/bin/podman', '/opt/podman/bin/podman', '/usr/bin/podman'];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir && fs.existsSync(path.join(dir, 'podman'))) return path.join(dir, 'podman');
  }
  return null;
}

const defaultExec: Exec = (cmd, args, input) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:/opt/podman/bin:${process.env.PATH ?? ''}` },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: '', stderr: String(e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });

async function discoverTranscripts(roots: NativeRoot[], reader: NativeReader): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (depth < 8 && ent.name !== 'media' && ent.name !== 'chunks') await walk(full, depth + 1);
      } else if (ent.isFile() && reader.classify(full)) {
        found.push(full);
      }
    }
  };
  for (const r of roots) await walk(r.dir, 0);
  return found;
}

export class PeriscopeService implements PeriscopeApi {
  private opts: PeriscopeServiceOptions;
  private clock: () => number;
  private roots: NativeRoot[];
  private agyMetadata: string;
  private claudeSessionsDir: string;
  private isAlive: (pid: number) => boolean;

  private db: DatabaseSync | null = null;
  private store: Store | null = null;
  private ingestor: Ingestor | null = null;
  private reader: NativeReader | null = null;

  private sandbox: SandboxState = { state: 'unknown' };
  private nativeProcs: ClaudeProc[] = [];
  private sandboxProcs: ClaudeProc[] = [];
  private presence = new Map<string, Presence>();

  private changeListeners = new Set<(n: ChangeNotice) => void>();
  private sandboxListeners = new Set<(s: SandboxState) => void>();
  private progressListeners = new Set<(p: IndexProgress) => void>();

  private pending = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;
  private watchers = new Map<string, fs.FSWatcher>();
  private intervals: NodeJS.Timeout[] = [];
  private started = false;

  constructor(opts: PeriscopeServiceOptions = {}) {
    this.opts = opts;
    this.clock = opts.clock ?? Date.now;
    const defaults = nativeRoots(os.homedir());
    this.roots = opts.roots ?? defaults.roots;
    this.agyMetadata = opts.agyMetadata ?? defaults.agyMetadata;
    this.claudeSessionsDir = opts.claudeSessionsDir ?? path.join(os.homedir(), '.claude', 'sessions');
    this.isAlive = opts.isAlive ?? defaultIsAlive;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const dbPath = this.opts.dbPath ?? defaultDbPath();
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    const db = new DatabaseSync(dbPath);
    if (dbPath !== ':memory:') {
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    }
    this.db = db;
    this.store = new Store(db as unknown as SqlDb);
    this.ingestor = new Ingestor(this.store, this.clock);
    this.reader = new NativeReader({
      ingestor: this.ingestor,
      store: this.store,
      roots: this.roots,
      agyMetadata: this.agyMetadata,
      onIngested: (ids) => this.notify(ids),
    });

    await this.runInitialIndex();
    this.startWatchers();
    this.startNativePresence();
    this.startSandbox();
    this.startExpiry();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    for (const t of this.intervals) clearInterval(t);
    this.intervals = [];

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pending.clear();

    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();

    if (this.reader) await this.reader.idle;

    this.db?.close();
    this.db = null;
    this.store = null;
    this.ingestor = null;
    this.reader = null;
  }

  onProgress(cb: (p: IndexProgress) => void): () => void {
    this.progressListeners.add(cb);
    return () => this.progressListeners.delete(cb);
  }

  onChange(cb: (n: ChangeNotice) => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  onSandbox(cb: (s: SandboxState) => void): () => void {
    this.sandboxListeners.add(cb);
    return () => this.sandboxListeners.delete(cb);
  }

  async listSessions(f: SessionFilter = {}): Promise<SessionRow[]> {
    const store = this.requireStore();
    const rows = store.listSessions({ ...f, status: undefined }, this.clock());
    for (const r of rows) {
      const p = this.presence.get(r.id);
      if (p === 'running') r.status = 'live';
      else if (p === 'open' && r.status !== 'live') r.status = 'open';
    }
    if (f.status === 'live') return rows.filter((r) => r.status !== 'idle');
    if (f.status === 'idle') return rows.filter((r) => r.status === 'idle');
    return rows;
  }

  async getEvents(sessionId: string, sinceSeq = -1): Promise<EventRow[]> {
    return this.requireStore().getEvents(sessionId, sinceSeq);
  }

  async getRaw(eventId: string): Promise<string | null> {
    return this.requireStore().getRaw(eventId);
  }

  async search(q: string, f: SessionFilter = {}): Promise<SearchHit[]> {
    return this.requireStore().search(q, f);
  }

  async sandboxStatus(): Promise<SandboxState> {
    return this.sandbox;
  }

  async readImage(p: string): Promise<string | null> {
    const abs = path.resolve(p.replace(/^file:\/\//, ''));
    const mime = IMAGE_MIME[path.extname(abs).toLowerCase()];
    if (!mime || !this.roots.some((r) => abs.startsWith(r.dir + path.sep))) return null;
    try {
      const data = await fs.promises.readFile(abs);
      return `data:${mime};base64,${data.toString('base64')}`;
    } catch {
      return null;
    }
  }

  private requireStore(): Store {
    if (!this.store) throw new Error('PeriscopeService has not been started');
    return this.store;
  }

  private emitProgress(p: IndexProgress): void {
    for (const cb of this.progressListeners) cb(p);
  }

  private notify(ids: string[]): void {
    if (!ids.length) return;
    for (const id of ids) this.pending.add(id);
    if (this.flushTimer) return;
    const delay = this.opts.debounceMs ?? 200;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const sessionIds = [...this.pending];
      this.pending.clear();
      if (!sessionIds.length) return;
      for (const cb of this.changeListeners) cb({ sessionIds });
    }, delay);
  }

  private setSandbox(s: SandboxState): void {
    this.sandbox = s;
    for (const cb of this.sandboxListeners) cb(s);
  }

  private refreshPresence(): void {
    const next = presenceMap([
      { prefix: 'n:', procs: this.nativeProcs },
      { prefix: 's:', procs: this.sandboxProcs },
    ]);
    const changed = presenceChanges(this.presence, next);
    this.presence = next;
    if (changed.length) this.notify(changed);
  }

  private async runInitialIndex(): Promise<void> {
    const reader = this.reader!;
    const ingestor = this.ingestor!;
    const files = await discoverTranscripts(this.roots, reader);
    const total = files.length;
    this.emitProgress({ indexed: 0, total, done: total === 0 });
    if (!total) return;

    const changed = new Set<string>();
    let indexed = 0;
    for (const abs of files) {
      try {
        if (await reader.read(abs)) {
          const info = reader.classify(abs);
          if (info) changed.add(info.sessionId);
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error('periscope: reading', abs, e);
      }
      for (const r of ingestor.drainRescans()) {
        if (!r.startsWith('podman:')) {
          try {
            if (await reader.read(r)) {
              const info = reader.classify(r);
              if (info) changed.add(info.sessionId);
            }
          } catch {
            /* ignore missing rescan target */
          }
        }
      }
      indexed++;
      this.emitProgress({ indexed, total, done: indexed === total });
    }
    if (changed.size) this.notify([...changed]);
  }

  private startWatchers(): void {
    const reader = this.reader!;
    const ensure = () => {
      for (const target of [...this.roots.map((r) => r.dir), path.dirname(this.agyMetadata)]) {
        if (this.watchers.has(target) || !fs.existsSync(target)) continue;
        const w = fs.watch(target, { recursive: true }, (_eventType, filename) => {
          if (!filename) return;
          const fullPath = path.join(target, filename.toString());
          if (!fullPath.endsWith('.jsonl') && !fullPath.endsWith('.meta.json') && fullPath !== this.agyMetadata) {
            return;
          }
          reader.enqueue(fullPath);
        });
        w.on('error', (e) => console.error('periscope: watcher', target, e));
        this.watchers.set(target, w);
      }
    };
    ensure();
    this.intervals.push(setInterval(ensure, this.opts.watchEnsureMs ?? 30_000));
  }

  private startNativePresence(): void {
    const scan = async () => {
      let names: string[] = [];
      try {
        names = (await fs.promises.readdir(this.claudeSessionsDir)).filter((n) => n.endsWith('.json'));
      } catch {
        /* no Claude Code sessions dir */
      }
      const texts = await Promise.all(names.map((n) => fs.promises.readFile(path.join(this.claudeSessionsDir, n), 'utf8').catch(() => '')));
      this.nativeProcs = parseClaudeProcs(texts).filter((p) => this.isAlive(p.pid));
      this.refreshPresence();
    };
    void scan();
    this.intervals.push(setInterval(() => void scan(), this.opts.presenceMs ?? 2_000));
  }

  private startSandbox(): void {
    const enabled = this.opts.sandboxEnabled ?? process.env.PERISCOPE_SANDBOX !== '0';
    if (!enabled) {
      const message = this.opts.sandboxEnabled === false ? 'disabled by --no-sandbox' : 'disabled by PERISCOPE_SANDBOX=0';
      this.setSandbox({ state: 'disabled', message });
      return;
    }
    const podman = this.opts.podman !== undefined ? this.opts.podman : findPodman();
    if (!podman) {
      this.setSandbox({ state: 'offline', message: 'podman not found' });
      return;
    }
    const poller = new PodmanPoller({
      exec: this.opts.exec ?? defaultExec,
      ingestor: this.ingestor!,
      store: this.store!,
      podman,
      image: this.opts.sandboxImage ?? (process.env.PERISCOPE_SANDBOX_IMAGE || DEFAULT_IMAGE),
      onStatus: (s) => this.setSandbox({ state: s.state, message: s.message }),
      onIngested: (ids) => this.notify(ids),
      onPresence: (procs) => {
        this.sandboxProcs = procs;
        this.refreshPresence();
      },
    });
    void poller.tick();
    this.intervals.push(setInterval(() => void poller.tick(), this.opts.pollMs ?? 1500));
  }

  private startExpiry(): void {
    this.intervals.push(
      setInterval(() => {
        if (!this.store) return;
        const ids = this.store.expireLive(this.clock());
        if (ids.length) this.notify(ids);
      }, this.opts.expireMs ?? 5000),
    );
  }
}
