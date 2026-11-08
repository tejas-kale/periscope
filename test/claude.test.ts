import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES, ingestFixture, memStore } from './helpers.ts';
import { Ingestor } from '../src/core/ingest.ts';
import { claudeParser } from '../src/core/parsers/claude.ts';
import { stableId } from '../src/core/util.ts';

const MAIN = 'proj/9fde03bf-efa5-480b-8289-14c5e1d865da.jsonl';
const SUB = 'proj/9fde03bf-efa5-480b-8289-14c5e1d865da/subagents/agent-a480e3567ff014a8f.jsonl';
const SID = 'n:9fde03bf-efa5-480b-8289-14c5e1d865da';

test('claude: builds turns, tool calls and results from a real session', () => {
  const store = memStore();
  const r = ingestFixture(new Ingestor(store), 'claude', MAIN);
  assert.equal(r.sessionId, SID);
  const evs = store.getEvents(SID);
  const kinds = new Set(evs.map((e) => e.kind));
  for (const k of ['turn', 'reasoning', 'text', 'tool_call', 'tool_result', 'meta']) assert.ok(kinds.has(k as any), `has ${k}`);
  const turn = evs.find((e) => e.kind === 'turn')!;
  assert.equal(turn.parent_id, null);
  const call = evs.find((e) => e.kind === 'tool_call' && e.tool_name === 'Bash')!;
  assert.equal(call.parent_id, turn.id);
  const result = evs.find((e) => e.parent_id === call.id)!;
  assert.ok(result.kind === 'tool_result' || result.kind === 'error');
  assert.ok(call.duration_ms! >= 0, 'tool call gets a duration');
  assert.ok(evs.some((e) => e.kind === 'error'), 'is_error results become errors');
  const s = store.getSession(SID)!;
  assert.equal(s.cwd, '/Users/tejaskale/Code/config');
  assert.equal(s.project, 'config');
  assert.ok(s.title && s.title.length > 0);
});

test('claude: token usage counted once per assistant message', () => {
  const store = memStore();
  ingestFixture(new Ingestor(store), 'claude', MAIN);
  const lines = fs.readFileSync(path.join(FIXTURES, 'claude', MAIN), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const msgIds = new Set(lines.filter((d) => d.type === 'assistant' && d.message.usage).map((d) => d.message.id));
  const withTokens = store.getEvents(SID).filter((e) => e.tokens_out != null);
  assert.equal(withTokens.length, msgIds.size);
});

test('claude: chunked reads at arbitrary byte boundaries give the same events', () => {
  const a = memStore();
  ingestFixture(new Ingestor(a), 'claude', MAIN);
  const b = memStore();
  ingestFixture(new Ingestor(b), 'claude', MAIN, { pieces: 7 });
  const strip = (s: typeof a) => s.getEvents(SID).map(({ seq, ...e }) => e);
  assert.deepEqual(strip(b), strip(a));
});

test('claude: re-reading the same bytes inserts nothing (idempotent ids)', () => {
  const store = memStore();
  const ing = new Ingestor(store);
  ingestFixture(ing, 'claude', MAIN);
  const before = store.getEvents(SID).length;
  // Forget the offset but keep the events: the same bytes must map onto the same ids.
  store.db.exec(`UPDATE files SET offset = 0, state = NULL`);
  const r = ingestFixture(ing, 'claude', MAIN);
  assert.equal(r.inserted, 0);
  assert.equal(store.getEvents(SID).length, before);
});

test('claude: subagent sidechain nests under its parent Agent tool call', () => {
  const store = memStore();
  const ing = new Ingestor(store);
  ingestFixture(ing, 'claude', MAIN);
  const meta = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'claude', SUB.replace(/\.jsonl$/, '.meta.json')), 'utf8'));
  ingestFixture(ing, 'claude', SUB, { parentToolUseId: meta.toolUseId });
  const evs = store.getEvents(SID);
  const agentCall = evs.find((e) => e.id === stableId(SID, `tool:${meta.toolUseId}`))!;
  assert.equal(agentCall.tool_name, 'Agent');
  const subTurn = evs.find((e) => e.kind === 'turn' && e.parent_id === agentCall.id);
  assert.ok(subTurn, 'subagent prompt is a turn under the Agent call');
  assert.ok(evs.some((e) => e.parent_id === subTurn!.id && e.kind === 'tool_call'), 'subagent tool calls nest under its turn');
  assert.equal(store.getSession(SID)!.source_path.endsWith(MAIN), true);
});

test('claude: unknown and malformed records become meta events', () => {
  const ctx = { sessionId: 's', fileTag: 'm', rootParent: null, id: (k: string) => k };
  const st = claudeParser.initialState();
  const a = claudeParser.parseLine('{"type":"brand-new-thing","x":1}', 0, st, ctx);
  assert.equal(a[0].op === 'event' && a[0].ev.kind, 'meta');
  const b = claudeParser.parseLine('{not json', 10, st, ctx);
  assert.equal(b[0].op === 'event' && b[0].ev.kind, 'meta');
  assert.deepEqual(claudeParser.parseLine('{"type":"api-request-blob"}', 20, st, ctx), []);
});
