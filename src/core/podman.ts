import type { Agent } from './types.ts';
import { AGENT_DIRS, AGY_METADATA, applyAgyMeta, classify, parseAgyMetadata, type AgyMeta } from './sources.ts';
import type { Ingestor } from './ingest.ts';
import type { Store } from './store.ts';
import { aliveInSandbox, parseClaudeProcs, type ClaudeProc } from './presence.ts';

/** Podman volumes the sandbox keeps agent homes in, and where each agent's transcripts live inside them. */
export const VOLUMES: { name: string; roots: { agent: Agent; dir: string }[]; sidecars: string[] }[] = [
  {
    name: 'claude-home', // ~/.claude; ~/.codex is a symlink to ~/.claude/codex
    roots: [
      { agent: 'claude', dir: AGENT_DIRS.claude },
      { agent: 'codex', dir: `codex/${AGENT_DIRS.codex}` },
    ],
    sidecars: [],
  },
  {
    name: 'agy-home', // ~/.gemini
    roots: [{ agent: 'antigravity', dir: AGENT_DIRS.antigravity }],
    sidecars: [AGY_METADATA],
  },
];

export const DEFAULT_IMAGE = 'localhost/agent-sandbox:latest';

/** Input to the in-container script. */
export interface PollRequest {
  roots: { mount: string; dir: string }[];
  /** Read offset per in-container file path. */
  known: Record<string, number>;
  /** Sidecar files to return when their mtime differs. */
  sidecars: { path: string; mtime: number }[];
  maxBytes: number;
  maxTotal: number;
  /** Directories of Claude Code's process registry (`sessions/<pid>.json`) to return in full. */
  presence?: string[];
}

export interface PollFile {
  p: string;
  size: number;
  mtime: number;
  start?: number;
  data?: string; // base64
}
export interface PollResponse {
  files: PollFile[];
  metas: Record<string, string>;
  sidecars: Record<string, { mtime: number; data: string }>;
  /** Files that could not be read (e.g. EACCES), one message each. */
  errors?: string[];
  /** Registry file contents from `presence` directories. */
  presence?: string[];
  /** The VM's clock when the script ran, to correct mtimes for clock drift. */
  now?: number;
}

/**
 * Runs inside a throwaway container (`node -e`): lists transcript files under the mounted volumes with size and
 * mtime, and returns bytes appended since the known offset. Plain JS so the image needs nothing but node.
 */
export const POLL_SCRIPT = String.raw`
const fs = require('fs'), path = require('path');
let input = '';
process.stdin.on('data', (d) => (input += d)).on('end', () => {
  const req = JSON.parse(input);
  const out = { files: [], metas: {}, sidecars: {}, errors: [], presence: [], now: Date.now() };
  for (const d of req.presence || []) {
    let names = [];
    try { names = fs.readdirSync(d); } catch {}
    for (const n of names) if (n.endsWith('.json')) { try { out.presence.push(fs.readFileSync(path.join(d, n), 'utf8')); } catch {} }
  }
  let budget = req.maxTotal;
  const walk = (dir, depth) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 8 && e.name !== 'media' && e.name !== 'chunks') walk(p, depth + 1); continue; }
      if (!e.isFile()) continue;
      if (e.name.endsWith('.meta.json')) {
        if (!(p in req.known)) { try { out.metas[p] = fs.readFileSync(p, 'utf8'); } catch {} }
        continue;
      }
      if (!e.name.endsWith('.jsonl')) continue;
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      const f = { p, size: st.size, mtime: Math.round(st.mtimeMs) };
      let start = req.known[p] || 0;
      if (st.size < start) start = 0;
      if (st.size > start && budget > 0) {
        const len = Math.min(st.size - start, req.maxBytes, budget);
        const buf = Buffer.alloc(len);
        let fd;
        try {
          fd = fs.openSync(p, 'r');
          const n = fs.readSync(fd, buf, 0, len, start);
          budget -= n;
          f.start = start;
          f.data = buf.subarray(0, n).toString('base64');
        } catch (err) {
          out.errors.push(String(err && err.message || err));
        } finally {
          if (fd !== undefined) fs.closeSync(fd);
        }
      }
      out.files.push(f);
    }
  };
  for (const r of req.roots) walk(path.join(r.mount, r.dir), 0);
  for (const s of req.sidecars) {
    try {
      const st = fs.statSync(s.path);
      if (Math.round(st.mtimeMs) !== s.mtime) out.sidecars[s.path] = { mtime: Math.round(st.mtimeMs), data: fs.readFileSync(s.path, 'utf8') };
    } catch {}
  }
  process.stdout.write(JSON.stringify(out));
});
`;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Exec = (cmd: string, args: string[], input?: string) => Promise<ExecResult>;

export type SandboxStatus = { state: 'unknown' | 'online' | 'offline' | 'error'; message?: string; at?: number };

const OFFLINE = /cannot connect|connection refused|no such file or directory.*sock|machine.*(not running|stopped)|vm.*not running|ENOENT|not found|dial unix|EOF/i;

export function classifyFailure(stderr: string): SandboxStatus['state'] {
  return OFFLINE.test(stderr) ? 'offline' : 'error';
}

/** The useful line of a failed podman run's stderr: Node crashes end with stack frames and a `Node.js vX` footer. */
export function failureMessage(stderr: string, code: number): string {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  const err = lines.find((l) => /^(\w*Error|Error)\b.*:/.test(l));
  return err ?? lines.filter((l) => !/^Node\.js v/.test(l) && !l.startsWith('at ')).pop() ?? `podman exited ${code}`;
}

/** Start times (ms, VM clock) of running sandbox containers from `podman ps --format json`, leaving out Periscope's own poll containers. */
export function sandboxContainerStarts(json: string, image: string): number[] {
  const base = (s: string) => s.replace(/:[^:/]+$/, '');
  try {
    const list = JSON.parse(json);
    if (!Array.isArray(list)) return [];
    return list
      .filter((c) => typeof c?.Image === 'string' && base(c.Image) === base(image) && !c.Labels?.['periscope.poll'])
      .map((c) => Number(c.StartedAt) * 1000)
      .filter((t) => t > 0);
  } catch {
    return [];
  }
}

/** Key a sandbox file by volume and in-volume path, e.g. `podman:claude-home:projects/p/x.jsonl`. */
export const sandboxPath = (volume: string, rel: string) => `podman:${volume}:${rel}`;

export interface PollerOptions {
  exec: Exec;
  ingestor: Ingestor;
  store: Store;
  image?: string;
  podman?: string;
  maxBytes?: number;
  maxTotal?: number;
  onStatus?: (s: SandboxStatus) => void;
  onIngested?: (sessionIds: string[]) => void;
  /** Claude Code processes alive in the sandbox, after each poll. */
  onPresence?: (procs: ClaudeProc[]) => void;
}

/**
 * Polls the sandbox volumes with a short-lived read-only container. One poll at a time: a tick while one runs is
 * skipped. A stopped Podman machine reports "offline"; the poller never starts it.
 */
export class PodmanPoller {
  status: SandboxStatus = { state: 'unknown' };
  private running = false;
  private o: Required<Omit<PollerOptions, 'onStatus' | 'onIngested' | 'onPresence'>> & Pick<PollerOptions, 'onStatus' | 'onIngested' | 'onPresence'>;
  private volumes: string[] | null = null;
  private volumesAt = 0;
  private sidecarMtime: Record<string, number> = {};
  private agyMeta: Record<string, AgyMeta> = {};
  private metas: Record<string, string> = {};

  constructor(o: PollerOptions) {
    this.o = { image: DEFAULT_IMAGE, podman: 'podman', maxBytes: 8 << 20, maxTotal: 24 << 20, ...o };
  }

  private setStatus(s: SandboxStatus) {
    const changed = s.state !== this.status.state || s.message !== this.status.message;
    this.status = { ...s, at: Date.now() };
    if (changed) this.o.onStatus?.(this.status);
  }

  /** Returns false when skipped because a poll is already running. */
  async tick(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      await this.poll();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.setStatus({ state: classifyFailure(msg), message: msg });
    } finally {
      this.running = false;
    }
    return true;
  }

  private async poll() {
    const { exec, podman } = this.o;
    if (!this.volumes || Date.now() - this.volumesAt > 30_000) {
      const r = await exec(podman, ['volume', 'ls', '--format', '{{.Name}}']);
      if (r.code !== 0) return this.setStatus({ state: classifyFailure(r.stderr), message: failureMessage(r.stderr, r.code) });
      this.volumes = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
      this.volumesAt = Date.now();
    }
    // Mounting a volume that does not exist would create it; only mount the ones that are there.
    const vols = VOLUMES.filter((v) => this.volumes!.includes(v.name));
    if (!vols.length) return this.setStatus({ state: 'online', message: 'no sandbox volumes yet' });

    const mount = (v: string) => `/v/${v}`;
    const req: PollRequest = { roots: [], known: {}, sidecars: [], maxBytes: this.o.maxBytes, maxTotal: this.o.maxTotal, presence: [] };
    if (vols.some((v) => v.name === 'claude-home')) req.presence!.push(`${mount('claude-home')}/sessions`);
    for (const v of vols) {
      for (const r of v.roots) req.roots.push({ mount: mount(v.name), dir: r.dir });
      for (const s of v.sidecars) {
        const p = `${mount(v.name)}/${s}`;
        req.sidecars.push({ path: p, mtime: this.sidecarMtime[p] ?? -1 });
      }
    }
    for (const f of this.o.store.filesForHost('sandbox')) {
      const m = f.path.match(/^podman:([^:]+):(.*)$/);
      if (m) req.known[`${mount(m[1])}/${m[2]}`] = f.offset;
    }
    for (const p of Object.keys(this.metas)) req.known[p] = 0;

    // Rootless podman: the volume files belong to the user that runs podman, which is root inside a container
    // without --userns=keep-id. Transcripts are mode 600, so the image's own user cannot read them.
    const args = ['run', '--rm', '-i', '--network', 'none', '--pull', 'never', '--user', '0:0', '--label', 'periscope.poll=1', '--entrypoint', 'node'];
    for (const v of vols) args.push('-v', `${v.name}:${mount(v.name)}:ro`);
    args.push(this.o.image, '-e', POLL_SCRIPT);
    const r = await exec(podman, args, JSON.stringify(req));
    if (r.code !== 0) return this.setStatus({ state: classifyFailure(r.stderr), message: failureMessage(r.stderr, r.code) });
    const res = JSON.parse(r.stdout) as PollResponse;
    this.apply(res, vols);
    await this.updatePresence(parseClaudeProcs(res.presence ?? []));
    const errs = res.errors ?? [];
    this.setStatus({ state: 'online', message: errs.length ? `${errs.length} file(s) unreadable, e.g. ${errs[0]}` : undefined });
  }

  private containersAt = 0;
  private containerStarts: number[] = [];

  /** Registry entries count as open only while a sandbox container that could own them runs (checked every 5 s). */
  private async updatePresence(procs: ClaudeProc[]) {
    if (!this.o.onPresence) return;
    if (procs.length && Date.now() - this.containersAt > 5_000) {
      const r = await this.o.exec(this.o.podman, ['ps', '--format', 'json']);
      this.containersAt = Date.now();
      if (r.code === 0) this.containerStarts = sandboxContainerStarts(r.stdout, this.o.image);
    }
    this.o.onPresence(aliveInSandbox(procs, this.containerStarts));
  }

  /** Ingest a poll response; exposed for tests. */
  apply(res: PollResponse, vols = VOLUMES) {
    // The Podman VM's clock drifts from the Mac's (notably after sleep); shift mtimes onto the Mac's clock.
    const skew = res.now ? Date.now() - res.now : 0;
    Object.assign(this.metas, res.metas);
    for (const [p, s] of Object.entries(res.sidecars)) {
      this.sidecarMtime[p] = s.mtime;
      const metas = parseAgyMetadata(s.data);
      Object.assign(this.agyMeta, metas);
      applyAgyMeta(this.o.store, 'sandbox', metas);
    }
    const changed = new Set<string>();
    for (const f of res.files) {
      if (f.data == null || f.start == null) continue;
      const m = f.p.match(/^\/v\/([^/]+)\/(.*)$/);
      const vol = m && vols.find((v) => v.name === m[1]);
      if (!m || !vol) continue;
      const root = vol.roots.find((r) => m[2].startsWith(r.dir + '/'));
      if (!root) continue;
      const file = classify(root.agent, 'sandbox', m[2].slice(root.dir.length + 1));
      if (!file) continue;
      const key = sandboxPath(vol.name, m[2]);
      const start = this.o.ingestor.offsetFor(key, f.size);
      if (start !== f.start) continue; // stale or reset; the next poll sends the right bytes
      let parentToolUseId: string | null = null;
      if (file.subagentMeta) {
        const meta = this.metas[`/v/${vol.name}/${root.dir}/${file.subagentMeta}`];
        try {
          parentToolUseId = meta ? JSON.parse(meta).toolUseId ?? null : null;
        } catch {
          /* ignore */
        }
      }
      const r = this.o.ingestor.ingest({
        file,
        path: key,
        size: f.size,
        mtime: f.mtime + skew,
        start,
        bytes: Buffer.from(f.data, 'base64'),
        parentToolUseId,
        agyMeta: file.agent === 'antigravity' ? this.agyMeta[file.conversation] : undefined,
      });
      if (r.inserted) changed.add(r.sessionId);
    }
    if (changed.size) this.o.onIngested?.([...changed]);
  }
}
