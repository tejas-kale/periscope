import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestFixture, memStore } from './helpers.ts';
import { Ingestor } from '../src/core/ingest.ts';
import { classify } from '../src/core/sources.ts';

const REL_MAIN = 'Users-x-Code-demo/agent-transcripts/11111111-2222-3333-4444-555555555555/11111111-2222-3333-4444-555555555555.jsonl';
const REL_FLAT = 'Users-x-Code-demo/agent-transcripts/11111111-2222-3333-4444-555555555555.jsonl';
const REL_SUB = 'Users-x-Code-demo/agent-transcripts/11111111-2222-3333-4444-555555555555/subagents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl';
const SID = 'n:11111111-2222-3333-4444-555555555555';

test('cursor: classify handles nested, flat, and subagent agent-transcripts', () => {
  const main = classify('cursor', 'native', REL_MAIN);
  assert.equal(main?.conversation, '11111111-2222-3333-4444-555555555555');
  assert.equal(main?.fileTag, 'm');

  const flat = classify('cursor', 'native', REL_FLAT);
  assert.equal(flat?.conversation, '11111111-2222-3333-4444-555555555555');
  assert.equal(flat?.fileTag, 'm');

  const sub = classify('cursor', 'native', REL_SUB);
  assert.equal(sub?.conversation, '11111111-2222-3333-4444-555555555555');
  assert.equal(sub?.fileTag, 'a:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

  assert.equal(classify('cursor', 'native', 'Users-x-Code-demo/notes.md'), null);
});

test('cursor: parses turns, reasoning, tool_use, tool_result, and strips user_query tags', () => {
  const store = memStore();
  ingestFixture(new Ingestor(store), 'cursor', REL_MAIN);
  const sess = store.getSession(SID)!;
  assert.equal(sess.agent, 'cursor');
  assert.equal(sess.title, 'Fix the typo in README.md');

  const evs = store.getEvents(SID);
  const turn = evs.find((e) => e.kind === 'turn')!;
  assert.equal(turn.text, 'Fix the typo in README.md');
  assert.doesNotMatch(turn.text, /user_query/);

  const reasoning = evs.find((e) => e.kind === 'reasoning')!;
  assert.equal(reasoning.parent_id, turn.id);
  assert.equal(reasoning.text, 'Let me inspect README.md first.');

  const call = evs.find((e) => e.kind === 'tool_call')!;
  assert.equal(call.tool_name, 'Read');
  assert.equal(call.parent_id, turn.id);

  const res = evs.find((e) => e.kind === 'tool_result')!;
  assert.equal(res.parent_id, call.id);
  assert.equal(res.text, 'Helo world');
});

test('cursor: subagent transcript shares session and chunked reads are idempotent', () => {
  const whole = memStore();
  const ingWhole = new Ingestor(whole);
  ingestFixture(ingWhole, 'cursor', REL_MAIN);
  ingestFixture(ingWhole, 'cursor', REL_SUB);

  const chunked = memStore();
  const ingChunked = new Ingestor(chunked);
  ingestFixture(ingChunked, 'cursor', REL_MAIN, { pieces: 5 });
  ingestFixture(ingChunked, 'cursor', REL_SUB, { pieces: 3 });

  assert.deepEqual(
    chunked.getEvents(SID).map((e) => [e.id, e.kind, e.text]),
    whole.getEvents(SID).map((e) => [e.id, e.kind, e.text]),
  );

  // Re-ingesting the same bytes inserts nothing new.
  const again = ingestFixture(ingChunked, 'cursor', REL_MAIN);
  assert.equal(again.inserted, 0);
});
