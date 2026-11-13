import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { memStore } from './helpers.ts';
import { Ingestor } from '../src/core/ingest.ts';
import { NativeReader, nativeRoots } from '../src/core/native.ts';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function encodeTreeNode(childHexIds: string[]): Buffer {
  const parts: Buffer[] = [];
  for (const hex of childHexIds) {
    const digest = Buffer.from(hex, 'hex');
    parts.push(Buffer.from([0x0a, digest.length]), digest);
  }
  return Buffer.concat(parts);
}

test('cursor store.db: NativeReader ingests blob tree + meta.json and appends new turns on update', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'periscope-cursor-cli-'));
  const { roots, agyMetadata } = nativeRoots(home);
  const chatUuid = '22222222-3333-4444-5555-666666666666';
  const chatDir = path.join(home, '.cursor', 'chats', 'abc123hash', chatUuid);
  fs.mkdirSync(chatDir, { recursive: true });

  const dbPath = path.join(chatDir, 'store.db');
  fs.writeFileSync(path.join(chatDir, 'meta.json'), JSON.stringify({ cwd: '/Users/x/Code/demo' }));

  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);');

  const putBlob = (data: Buffer): string => {
    const id = sha256(data);
    db.prepare('INSERT OR IGNORE INTO blobs(id, data) VALUES (?, ?)').run(id, data);
    return id;
  };

  const b1 = putBlob(Buffer.from(JSON.stringify({ role: 'user', content: 'List files' })));
  const b2 = putBlob(
    Buffer.from(
      JSON.stringify({
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Checking' },
          { type: 'text', text: 'Running ls' },
          { type: 'tool-call', toolCallId: 'tc1', toolName: 'Shell', args: { command: 'ls' } },
        ],
      }),
    ),
  );
  const b3 = putBlob(
    Buffer.from(
      JSON.stringify({
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'tc1', toolName: 'Shell', result: 'README.md' }],
      }),
    ),
  );
  const root1 = putBlob(encodeTreeNode([b1, b2, b3]));

  const metaObj = { agentId: chatUuid, latestRootBlobId: root1, name: 'CLI list files', createdAt: 1_700_000_000_000 };
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('0', Buffer.from(JSON.stringify(metaObj)).toString('hex'));

  const store = memStore();
  const seen: string[][] = [];
  const reader = new NativeReader({ ingestor: new Ingestor(store), store, roots, agyMetadata, onIngested: (ids) => seen.push(ids) });

  reader.enqueue(dbPath);
  await reader.idle;

  const sid = `n:${chatUuid}`;
  const sess = store.getSession(sid)!;
  assert.equal(sess.agent, 'cursor');
  assert.equal(sess.title, 'CLI list files');
  assert.equal(sess.cwd, '/Users/x/Code/demo');
  assert.equal(sess.project, 'demo');

  const evs1 = store.getEvents(sid);
  const turn = evs1.find((e) => e.kind === 'turn')!;
  assert.equal(turn.text, 'List files');
  const call = evs1.find((e) => e.kind === 'tool_call')!;
  assert.equal(call.tool_name, 'Shell');
  const res = evs1.find((e) => e.kind === 'tool_result')!;
  assert.equal(res.parent_id, call.id);
  assert.equal(res.text, 'README.md');
  assert.deepEqual(seen.flat(), [sid]);

  // Append a new assistant message and update latestRootBlobId; bump mtime and enqueue WAL.
  const b4 = putBlob(Buffer.from(JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'Done.' }] })));
  const root2 = putBlob(encodeTreeNode([b1, b2, b3, b4]));
  db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(Buffer.from(JSON.stringify({ ...metaObj, latestRootBlobId: root2 })).toString('hex'), '0');
  db.close();

  const future = new Date(Date.now() + 2000);
  fs.utimesSync(dbPath, future, future);

  reader.enqueue(path.join(chatDir, 'store.db-wal'));
  await reader.idle;

  const evs2 = store.getEvents(sid);
  assert.equal(evs2.length, evs1.length + 1);
  assert.equal(evs2.at(-1)!.text, 'Done.');
});
