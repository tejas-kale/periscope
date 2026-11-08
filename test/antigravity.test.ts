import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES, ingestFixture, memStore } from './helpers.ts';
import { Ingestor } from '../src/core/ingest.ts';
import { parseAgyMetadata } from '../src/core/sources.ts';

const REL = '344fe0a7-79f1-4a0d-8d48-b6e4ffdb183b/.system_generated/logs/transcript_full.jsonl';
const SID = 'n:344fe0a7-79f1-4a0d-8d48-b6e4ffdb183b';

test('antigravity: results pair with pending tool calls in order', () => {
  const store = memStore();
  ingestFixture(new Ingestor(store), 'antigravity', REL);
  const evs = store.getEvents(SID);
  const turn = evs.find((e) => e.kind === 'turn')!;
  assert.match(turn.text, /^Read fr-morphology-roadmap/);
  assert.doesNotMatch(turn.text, /USER_REQUEST/);
  const calls = evs.filter((e) => e.kind === 'tool_call');
  assert.ok(calls.length >= 3);
  assert.equal(calls[0].tool_name, 'read_file');
  assert.equal(calls[1].tool_name, 'run_command');
  const r0 = evs.find((e) => e.parent_id === calls[0].id)!;
  assert.match(r0.text, /^Showing lines/);
  const r1 = evs.find((e) => e.parent_id === calls[1].id)!;
  assert.match(r1.text, /Command exited/);
  assert.ok(evs.some((e) => e.kind === 'error' && calls.some((c) => c.id === e.parent_id)), 'errored step nests under its call');
  assert.ok(evs.some((e) => e.kind === 'reasoning'));
});

test('antigravity: metadata gives title and workspace', () => {
  const json = JSON.stringify({ conversations: { abc: { summary: { Title: 'Verify', WorkspaceURIs: ['file:///Users/x/Code/my%20proj'] } } } });
  assert.deepEqual(parseAgyMetadata(json).abc, { title: 'Verify', cwd: '/Users/x/Code/my proj' });
  assert.deepEqual(parseAgyMetadata('{oops'), {});
});
