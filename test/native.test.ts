import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FIXTURES, memStore } from './helpers.ts';
import { Ingestor } from '../src/core/ingest.ts';
import { NativeReader, nativeRoots } from '../src/core/native.ts';

test('native reader: initial read, appended lines, and non-transcripts ignored', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'periscope-home-'));
  const { roots, agyMetadata } = nativeRoots(home);
  const dir = path.join(roots[0].dir, '-Users-x-Code-config');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '9fde03bf-efa5-480b-8289-14c5e1d865da.jsonl');
  fs.copyFileSync(path.join(FIXTURES, 'claude/proj/9fde03bf-efa5-480b-8289-14c5e1d865da.jsonl'), file);
  const store = memStore();
  const seen: string[][] = [];
  const r = new NativeReader({ ingestor: new Ingestor(store), store, roots, agyMetadata, onIngested: (ids) => seen.push(ids) });
  r.enqueue(file);
  r.enqueue(path.join(dir, 'memory', 'x.md'));
  await r.idle;
  const sid = 'n:9fde03bf-efa5-480b-8289-14c5e1d865da';
  const n = store.getEvents(sid).length;
  assert.ok(n > 10);
  assert.deepEqual(seen.flat(), [sid]);
  // A half-written line is held back until it is complete.
  const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'later' } }) + '\n';
  fs.appendFileSync(file, line.slice(0, 20));
  r.enqueue(file);
  await r.idle;
  assert.equal(store.getEvents(sid).length, n);
  fs.appendFileSync(file, line.slice(20));
  r.enqueue(file);
  await r.idle;
  assert.equal(store.getEvents(sid).at(-1)!.text, 'later');
});
