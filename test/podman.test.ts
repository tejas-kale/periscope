import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FIXTURES, memStore } from './helpers.ts';
import { Ingestor } from '../src/core/ingest.ts';
import { PodmanPoller, POLL_SCRIPT, classifyFailure, failureMessage, type Exec } from '../src/core/podman.ts';

const SESSION = '9fde03bf-efa5-480b-8289-14c5e1d865da';

/** Fake podman: `volume ls` lists the volumes; `run` executes the poll script locally against a temp dir standing in for /v. */
function fakePodman(root: string, calls: string[][]): Exec {
  return async (_cmd, args, input) => {
    calls.push(args);
    if (args[0] === 'volume') return { code: 0, stdout: 'claude-home\nagy-home\nother\n', stderr: '' };
    const script = args[args.indexOf('-e') + 1];
    const req = input!.replaceAll('"/v/', JSON.stringify(root + '/v/').slice(0, -1));
    const r = spawnSync(process.execPath, ['-e', script], { input: req, encoding: 'utf8' });
    return { code: r.status ?? 1, stdout: r.stdout.replaceAll(root + '/v/', '/v/'), stderr: r.stderr };
  };
}

function setupVolumes() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'periscope-vol-'));
  const proj = path.join(root, 'v/claude-home/projects/-Users-x-Code-config');
  fs.mkdirSync(path.join(proj, SESSION, 'subagents'), { recursive: true });
  const src = path.join(FIXTURES, 'claude/proj');
  fs.copyFileSync(path.join(src, `${SESSION}.jsonl`), path.join(proj, `${SESSION}.jsonl`));
  for (const f of fs.readdirSync(path.join(src, SESSION, 'subagents'))) fs.copyFileSync(path.join(src, SESSION, 'subagents', f), path.join(proj, SESSION, 'subagents', f));
  const agy = path.join(root, 'v/agy-home/antigravity-cli');
  const conv = '344fe0a7-79f1-4a0d-8d48-b6e4ffdb183b';
  fs.mkdirSync(path.join(agy, 'brain', conv, '.system_generated/logs'), { recursive: true });
  fs.mkdirSync(path.join(agy, 'cache'), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, 'antigravity', conv, '.system_generated/logs/transcript_full.jsonl'), path.join(agy, 'brain', conv, '.system_generated/logs/transcript_full.jsonl'));
  fs.writeFileSync(path.join(agy, 'cache/conversation_metadata.json'), JSON.stringify({ conversations: { [conv]: { summary: { Title: 'Agy title', WorkspaceURIs: ['file:///Users/x/Code/radio'] } } } }));
  return { root, mainFile: path.join(proj, `${SESSION}.jsonl`) };
}

test('poller ingests sandbox sessions, then only appended bytes', async () => {
  const { root, mainFile } = setupVolumes();
  const store = memStore();
  const calls: string[][] = [];
  const ingested: string[][] = [];
  const poller = new PodmanPoller({ exec: fakePodman(root, calls), ingestor: new Ingestor(store), store, onIngested: (ids) => ingested.push(ids) });
  assert.equal(await poller.tick(), true);
  assert.equal(poller.status.state, 'online', poller.status.message);

  const run = calls.find((a) => a[0] === 'run')!;
  assert.ok(run.includes('claude-home:/v/claude-home:ro') && run.includes('agy-home:/v/agy-home:ro'), 'volumes mounted read-only');
  assert.ok(!run.some((a) => a.startsWith('other:')), 'only known volumes are mounted');
  assert.ok(run.includes('--rm') && run.includes('localhost/agent-sandbox:latest'));
  assert.equal(run[run.indexOf('--user') + 1], '0:0', 'runs as container root, which owns the volume files in rootless podman');

  const sid = `s:${SESSION}`;
  const s = store.getSession(sid)!;
  assert.equal(s.host, 'sandbox');
  const evs = store.getEvents(sid);
  assert.ok(evs.some((e) => e.kind === 'turn' && e.parent_id), 'subagent nested via its meta.json');
  const agy = store.getSession('s:344fe0a7-79f1-4a0d-8d48-b6e4ffdb183b')!;
  assert.equal(agy.title, 'Agy title');
  assert.equal(agy.project, 'radio');

  const n = evs.length;
  fs.appendFileSync(mainFile, JSON.stringify({ type: 'user', timestamp: '2026-11-08T10:00:00Z', message: { role: 'user', content: 'appended prompt' } }) + '\n');
  ingested.length = 0;
  await poller.tick();
  assert.equal(store.getEvents(sid).length, n + 1);
  assert.deepEqual(ingested, [[sid]]);
  await poller.tick();
  assert.equal(store.getEvents(sid).length, n + 1, 'no change, nothing new');
});

test('poller skips a tick while one is running', async () => {
  let release!: () => void;
  const exec: Exec = () => new Promise((r) => (release = () => r({ code: 0, stdout: '', stderr: '' })));
  const store = memStore();
  const poller = new PodmanPoller({ exec, ingestor: new Ingestor(store), store });
  const first = poller.tick();
  assert.equal(await poller.tick(), false);
  release();
  assert.equal(await first, true);
});

test('stopped podman machine shows offline and nothing is started', async () => {
  const calls: string[][] = [];
  const exec: Exec = async (_c, args) => {
    calls.push(args);
    return { code: 125, stdout: '', stderr: 'Error: Cannot connect to Podman. Please verify your connection to the Linux system using `podman system connection list`' };
  };
  const store = memStore();
  const statuses: string[] = [];
  const poller = new PodmanPoller({ exec, ingestor: new Ingestor(store), store, onStatus: (s) => statuses.push(s.state) });
  await poller.tick();
  assert.deepEqual(statuses, ['offline']);
  assert.ok(!calls.some((a) => a.includes('machine') || a.includes('start')));
  assert.equal(classifyFailure('spawn podman ENOENT'), 'offline');
  assert.equal(classifyFailure('Error: invalid reference format'), 'error');
});

test('poll script re-reads a file that shrank from zero', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'periscope-s-'));
  fs.mkdirSync(path.join(dir, 'projects/p'), { recursive: true });
  const f = path.join(dir, 'projects/p/x.jsonl');
  fs.writeFileSync(f, 'abc\n');
  const r = spawnSync(process.execPath, ['-e', POLL_SCRIPT], { input: JSON.stringify({ roots: [{ mount: dir, dir: 'projects' }], known: { [f]: 100 }, sidecars: [], maxBytes: 1e6, maxTotal: 1e6 }), encoding: 'utf8' });
  const out = JSON.parse(r.stdout);
  assert.equal(out.files[0].start, 0);
  assert.equal(Buffer.from(out.files[0].data, 'base64').toString(), 'abc\n');
});

test('poll script reports an unreadable transcript instead of crashing', { skip: process.getuid?.() === 0 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'periscope-s-'));
  fs.mkdirSync(path.join(dir, 'projects/p'), { recursive: true });
  const bad = path.join(dir, 'projects/p/bad.jsonl');
  const good = path.join(dir, 'projects/p/good.jsonl');
  fs.writeFileSync(bad, 'secret\n', { mode: 0o000 });
  fs.writeFileSync(good, 'ok\n');
  const r = spawnSync(process.execPath, ['-e', POLL_SCRIPT], { input: JSON.stringify({ roots: [{ mount: dir, dir: 'projects' }], known: {}, sidecars: [], maxBytes: 1e6, maxTotal: 1e6 }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(Buffer.from(out.files.find((f: any) => f.p === good).data, 'base64').toString(), 'ok\n');
  assert.match(out.errors[0], /EACCES.*bad\.jsonl/);
});

test('failure message keeps the error line from a node crash, not the version footer', () => {
  const stderr = `node:fs:573\n  return binding.open(\n                 ^\n\nError: EACCES: permission denied, open '/v/claude-home/projects/p/x.jsonl'\n    at Object.openSync (node:fs:573:18)\n    at walk ([eval]:23:20) {\n  errno: -13,\n  code: 'EACCES'\n}\n\nNode.js v22.23.4\n`;
  assert.equal(failureMessage(stderr, 1), "Error: EACCES: permission denied, open '/v/claude-home/projects/p/x.jsonl'");
  assert.equal(failureMessage('Error: invalid reference format\n', 125), 'Error: invalid reference format');
  assert.equal(failureMessage('', 2), 'podman exited 2');
});
