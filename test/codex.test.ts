import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestFixture, memStore } from './helpers.ts';
import { Ingestor } from '../src/core/ingest.ts';

const REL = '2026/11/07/rollout-2026-11-07T17-46-32-01a1b71e-834a-7ec0-ae01-30a451a6d9fa.jsonl';
const SID = 'n:01a1b71e-834a-7ec0-ae01-30a451a6d9fa';

test('codex: session meta, prompt turn, tool calls with outputs', () => {
  const store = memStore();
  ingestFixture(new Ingestor(store), 'codex', REL);
  const evs = store.getEvents(SID);
  const turns = evs.filter((e) => e.kind === 'turn');
  assert.equal(turns.length, 1, 'AGENTS.md and environment context are not turns');
  assert.match(turns[0].text, /^Code review task/);
  const call = evs.find((e) => e.kind === 'tool_call')!;
  assert.equal(call.tool_name, 'exec');
  assert.equal(call.parent_id, turns[0].id);
  const out = evs.find((e) => e.parent_id === call.id)!;
  assert.equal(out.kind, 'tool_result');
  assert.ok(evs.some((e) => e.kind === 'text' && e.role === 'assistant'));
  assert.ok(evs.some((e) => e.tokens_in != null), 'token usage attached to a model event');
  assert.equal(store.getSession(SID)!.cwd, '/Users/tejaskale/Code/config');
  assert.ok(!evs.some((e) => e.raw_json), 'raw_json is not returned with the event list');
});

test('codex: chunked ingestion matches whole-file ingestion', () => {
  const a = memStore();
  ingestFixture(new Ingestor(a), 'codex', REL);
  const b = memStore();
  ingestFixture(new Ingestor(b), 'codex', REL, { pieces: 5 });
  const strip = (s: typeof a) => s.getEvents(SID).map(({ seq, ...e }) => e);
  assert.deepEqual(strip(b), strip(a));
});
