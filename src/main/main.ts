import { app, BrowserWindow, ipcMain, session, shell } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { watch, type FSWatcher } from 'chokidar';
import { Store, type SqlDb } from '../core/store.ts';
import { Ingestor } from '../core/ingest.ts';
import { NativeReader, nativeRoots } from '../core/native.ts';
import { DEFAULT_IMAGE, PodmanPoller, type Exec } from '../core/podman.ts';
import type { SandboxState, SessionFilter } from '../core/types.ts';

const POLL_MS = 1500;
const DEV_URL = process.env.PERISCOPE_DEV_URL;

let win: BrowserWindow | null = null;
let sandbox: SandboxState = { state: 'unknown' };

// ---- change notifications (debounced) ----
const pending = new Set<string>();
let flushTimer: NodeJS.Timeout | null = null;
function notify(ids: string[]) {
  ids.forEach((i) => pending.add(i));
  flushTimer ??= setTimeout(() => {
    flushTimer = null;
    const sessionIds = [...pending];
    pending.clear();
    win?.webContents.send('periscope:change', { sessionIds });
  }, 200);
}

function setSandbox(s: SandboxState) {
  sandbox = s;
  win?.webContents.send('periscope:sandbox', s);
}

// ---- podman ----
function findPodman(): string | null {
  const candidates = ['/opt/homebrew/bin/podman', '/usr/local/bin/podman', '/opt/podman/bin/podman', '/usr/bin/podman'];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  for (const dir of (process.env.PATH ?? '').split(':')) if (dir && fs.existsSync(path.join(dir, 'podman'))) return path.join(dir, 'podman');
  return null;
}

const exec: Exec = (cmd, args, input) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:/opt/podman/bin:${process.env.PATH ?? ''}` } });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => (clearTimeout(timer), resolve({ code: -1, stdout: '', stderr: String(e) })));
    child.on('close', (code) => (clearTimeout(timer), resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })));
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });

// ---- startup ----
function openStore(): Store {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'periscope.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  return new Store(db as unknown as SqlDb);
}

function startNative(store: Store, ingestor: Ingestor) {
  const { roots, agyMetadata } = nativeRoots(os.homedir());
  const reader = new NativeReader({ ingestor, store, roots, agyMetadata, onIngested: notify });
  const watchers = new Map<string, FSWatcher>();
  const ensure = () => {
    for (const target of [...roots.map((r) => r.dir), path.dirname(agyMetadata)]) {
      if (watchers.has(target) || !fs.existsSync(target)) continue;
      const w = watch(target, {
        ignoreInitial: false,
        ignored: (p, st) => !!st?.isFile() && !p.endsWith('.jsonl') && !p.endsWith('.meta.json') && p !== agyMetadata,
        depth: 8,
      });
      w.on('add', (p) => reader.enqueue(p));
      w.on('change', (p) => reader.enqueue(p));
      w.on('error', (e) => console.error('periscope: watcher', target, e));
      watchers.set(target, w);
    }
  };
  ensure();
  setInterval(ensure, 30_000); // an agent installed later creates its directory later
}

function startSandbox(store: Store, ingestor: Ingestor) {
  if (process.env.PERISCOPE_SANDBOX === '0') return setSandbox({ state: 'disabled', message: 'disabled by PERISCOPE_SANDBOX=0' });
  const podman = findPodman();
  if (!podman) return setSandbox({ state: 'offline', message: 'podman not found' });
  const poller = new PodmanPoller({
    exec,
    ingestor,
    store,
    podman,
    image: process.env.PERISCOPE_SANDBOX_IMAGE || DEFAULT_IMAGE,
    onStatus: (s) => setSandbox({ state: s.state, message: s.message }),
    onIngested: notify,
  });
  void poller.tick();
  setInterval(() => void poller.tick(), POLL_MS);
}

function registerIpc(store: Store) {
  const { roots } = nativeRoots(os.homedir());
  ipcMain.handle('periscope:listSessions', (_e, f: SessionFilter) => store.listSessions(f ?? {}));
  ipcMain.handle('periscope:getEvents', (_e, id: string, since?: number) => store.getEvents(id, since ?? -1));
  ipcMain.handle('periscope:getRaw', (_e, id: string) => store.getRaw(id));
  ipcMain.handle('periscope:search', (_e, q: string, f: SessionFilter) => store.search(q, f ?? {}));
  ipcMain.handle('periscope:sandboxStatus', () => sandbox);
  ipcMain.handle('periscope:readImage', async (_e, p: string) => {
    // Only images inside the agents' own directories, e.g. Antigravity step screenshots.
    const abs = path.resolve(p.replace(/^file:\/\//, ''));
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[path.extname(abs).toLowerCase()];
    if (!mime || !roots.some((r) => abs.startsWith(r.dir + path.sep))) return null;
    try {
      return `data:${mime};base64,${(await fs.promises.readFile(abs)).toString('base64')}`;
    } catch {
      return null;
    }
  });
}

function lockDown() {
  // Everything is local: refuse any network request the renderer might make.
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => {
    const ok = d.url.startsWith('file:') || d.url.startsWith('data:') || d.url.startsWith('devtools:') || (DEV_URL && d.url.startsWith(DEV_URL)) || (DEV_URL && d.url.startsWith('ws://localhost'));
    cb({ cancel: !ok });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  app.on('web-contents-created', (_e, wc) => {
    wc.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('file:')) void shell.openPath(url.slice(7));
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e) => e.preventDefault());
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 500,
    title: 'Periscope',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  if (DEV_URL) void win.loadURL(DEV_URL);
  else void win.loadFile(path.join(import.meta.dirname, '..', 'dist', 'index.html'));
  win.on('closed', () => (win = null));
}

app.whenReady().then(() => {
  lockDown();
  // Packaged builds get the icon from the bundle; `npm start` / `npm run dev` need it set on the dock.
  const icon = path.join(import.meta.dirname, '..', 'build', 'icon.png');
  if (process.platform === 'darwin' && !app.isPackaged && fs.existsSync(icon)) app.dock?.setIcon(icon);
  const store = openStore();
  const ingestor = new Ingestor(store);
  registerIpc(store);
  createWindow();
  startNative(store, ingestor);
  startSandbox(store, ingestor);
  setInterval(() => {
    const ids = store.expireLive(Date.now());
    if (ids.length) notify(ids);
  }, 5000);
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
