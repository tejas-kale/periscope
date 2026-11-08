import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ingestFixture, memStore } from './helpers.ts';
import { Ingestor } from '../src/core/ingest.ts';
import { ftsQuery, LIVE_WINDOW_MS } from '../src/core/store.ts';
import { classify } from '../src/core/sources.ts';

test('ftsQuery quotes words and prefixes the last', () => {
  assert.equal(ftsQuery('git diff'), '"git" "diff"*');
  assert.equal(ftsQuery('  "; DROP --'), '"DROP"*');
  assert.equal(ftsQuery('!!'), null);
});

test('global search returns one snippet per session and honours filters', () => {
  const store = memStore();
  const ing = new Ingestor(store);
  ingestFixture(ing, 'claude', 'proj/9fde03bf-efa5-480b-8289-14c5e1d865da.jsonl');
  ingestFixture(ing, 'codex', '2026/11/07/rollout-2026-11-07T17-46-32-01a1b71e-834a-7ec0-ae01-30a451a6d9fa.jsonl');
  const hits = store.search('review');
  assert.ok(hits.length >= 1);
  assert.equal(new Set(hits.map((h) => h.session_id)).size, hits.length);
  assert.ok(hits[0].snippet.includes('\u0001'));
  const codexOnly = store.search('review', { agent: 'codex' });
  assert.ok(codexOnly.every((h) => h.session_id === 'n:01a1b71e-834a-7ec0-ae01-30a451a6d9fa'));
  assert.equal(store.search('zzzznotthere').length, 0);
});

test('sessions list: live status, filters', () => {
  const store = memStore();
  const now = 1_800_000_000_000;
  const ing = new Ingestor(store, () => now);
  ingestFixture(ing, 'claude', 'proj/9fde03bf-efa5-480b-8289-14c5e1d865da.jsonl', { mtime: now - 1000 });
  ingestFixture(ing, 'codex', '2026/11/07/rollout-2026-11-07T17-46-32-01a1b71e-834a-7ec0-ae01-30a451a6d9fa.jsonl', { mtime: now - LIVE_WINDOW_MS - 1 });
  assert.deepEqual(store.listSessions({ status: 'live' }, now).map((s) => s.agent), ['claude']);
  assert.deepEqual(store.listSessions({ agent: 'codex' }, now).map((s) => s.status), ['idle']);
  assert.deepEqual(store.expireLive(now + LIVE_WINDOW_MS), ['n:9fde03bf-efa5-480b-8289-14c5e1d865da']);
});

test('a file that shrinks is re-read from zero', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'periscope-'));
  const rel = 'p/11111111-2222-3333-4444-555555555555.jsonl';
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs));
  const line = (t: string) => JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: t } }) + '\n';
  const store = memStore();
  const ing = new Ingestor(store);
  const file = classify('claude', 'native', rel)!;
  const feed = () => {
    const b = fs.readFileSync(abs);
    const start = ing.offsetFor(abs, b.length);
    return ing.ingest({ file, path: abs, size: b.length, mtime: 0, start, bytes: b.subarray(start) });
  };
  fs.writeFileSync(abs, line('first long prompt here') + line('second'));
  feed();
  assert.equal(store.getEvents(file.sessionId).length, 2);
  fs.writeFileSync(abs, line('replaced'));
  feed();
  assert.deepEqual(store.getEvents(file.sessionId).map((e) => e.text), ['replaced']);
});

test('a partial trailing line waits for the rest', () => {
  const store = memStore();
  const ing = new Ingestor(store, () => 0);
  const rel = 'p/11111111-2222-3333-4444-555555555555.jsonl';
  const file = classify('claude', 'native', rel)!;
  const full = Buffer.from(JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n');
  const r1 = ing.ingest({ file, path: rel, size: 10, mtime: 0, start: 0, bytes: full.subarray(0, 10) });
  assert.equal(r1.offset, 0);
  const r2 = ing.ingest({ file, path: rel, size: full.length, mtime: 0, start: 0, bytes: full });
  assert.equal(r2.offset, full.length);
  assert.equal(r2.inserted, 1);
});

test('classify recognises transcript paths per agent', () => {
  assert.equal(classify('claude', 'sandbox', 'p/9fde03bf-efa5-480b-8289-14c5e1d865da.jsonl')?.sessionId, 's:9fde03bf-efa5-480b-8289-14c5e1d865da');
  assert.equal(classify('claude', 'native', 'p/9fde03bf-efa5-480b-8289-14c5e1d865da/subagents/agent-abc.jsonl')?.fileTag, 'a:abc');
  assert.equal(classify('claude', 'native', 'p/memory/notes.jsonl'), null);
  assert.ok(classify('codex', 'native', '2026/11/07/rollout-2026-11-07T17-46-32-01a1b71e-834a-7ec0-ae01-30a451a6d9fa.jsonl'));
  assert.equal(classify('antigravity', 'native', '344fe0a7-79f1-4a0d-8d48-b6e4ffdb183b/.system_generated/logs/transcript.jsonl'), null);
});
