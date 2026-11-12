import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EventRow } from '../src/core/types.ts';
import { buildTree } from '../src/view-model/tree.ts';
import { buildContextGroups, computeSessionStats } from '../src/view-model/stats-context.ts';

function makeEv(overrides: Partial<EventRow> & { id: string; seq: number; kind: EventRow['kind'] }): EventRow {
  return {
    session_id: 's1',
    parent_id: null,
    role: null,
    ts: 1000 + overrides.seq * 1000,
    duration_ms: null,
    tokens_in: null,
    tokens_out: null,
    tool_name: null,
    text: '',
    ...overrides,
  };
}

test('stats view-model: computes duration, tokens, turns, tool calls, errors, and tool breakdown', () => {
  const events: EventRow[] = [
    makeEv({ id: 't1', seq: 1, kind: 'turn', ts: 1000, text: 'Hello' }),
    makeEv({ id: 'm1', seq: 2, parent_id: 't1', kind: 'text', ts: 2000, tokens_in: 120, tokens_out: 45, text: 'Hi' }),
    makeEv({ id: 'tc1', seq: 3, parent_id: 't1', kind: 'tool_call', ts: 3000, duration_ms: 250, tool_name: 'Bash' }),
    makeEv({ id: 'tr1', seq: 4, parent_id: 'tc1', kind: 'error', ts: 3250, text: 'exit 1' }),
    makeEv({ id: 'tc2', seq: 5, parent_id: 't1', kind: 'tool_call', ts: 4000, duration_ms: 100, tool_name: 'Read' }),
    makeEv({ id: 'tc3', seq: 6, parent_id: 't1', kind: 'tool_call', ts: 5500, duration_ms: 150, tool_name: 'Bash' }),
  ];

  const tree = buildTree(events);
  const stats = computeSessionStats(tree, events);

  assert.equal(stats.durationMs, 4500);
  assert.equal(stats.turns, 1);
  assert.equal(stats.toolCalls, 3);
  assert.equal(stats.errors, 1);
  assert.equal(stats.tokensIn, 120);
  assert.equal(stats.tokensOut, 45);
  assert.equal(stats.tools.length, 2);
  assert.deepEqual(stats.tools[0], { name: 'Bash', calls: 2, errors: 1, durationMs: 400 });
  assert.deepEqual(stats.tools[1], { name: 'Read', calls: 1, errors: 0, durationMs: 100 });
});

test('context view-model: groups injected attachments and system reminders latest-first', () => {
  const events: EventRow[] = [
    makeEv({ id: 't1', seq: 1, kind: 'turn', text: 'User prompt' }),
    makeEv({ id: 'a1', seq: 2, parent_id: 't1', kind: 'meta', role: 'attachment', text: 'date\n2026-06-01' }),
    makeEv({ id: 'a2', seq: 3, parent_id: 't1', kind: 'meta', role: 'attachment', text: 'environment\nlinux' }),
    makeEv({ id: 'a3', seq: 4, parent_id: 't1', kind: 'meta', role: 'attachment', text: 'date\n2026-06-02' }),
    makeEv({ id: 'a-err', seq: 5, parent_id: 't1', kind: 'meta', role: 'attachment', text: 'hook_error\nfailed' }),
    makeEv({
      id: 'sr1',
      seq: 6,
      parent_id: 't1',
      kind: 'meta',
      role: 'system',
      text: '<system-reminder>Always run tests</system-reminder>',
    }),
  ];

  const rawById = new Map<string, string | null>([
    ['a3', JSON.stringify({ type: 'attachment', attachment: { type: 'date', date: '2026-06-02' } })],
  ]);

  const groups = buildContextGroups(events, rawById);
  assert.equal(groups.length, 3);
  assert.equal(groups[0]!.key, 'system_reminder');
  assert.equal(groups[0]!.title, 'System reminder');
  assert.equal(groups[0]!.count, 1);
  assert.match(groups[0]!.fields[0]!.value, /Always run tests/);

  assert.equal(groups[1]!.key, 'date');
  assert.equal(groups[1]!.count, 2);
  assert.equal(groups[1]!.latestEvent.id, 'a3');
  assert.deepEqual(groups[1]!.fields, [{ label: 'Date', value: '2026-06-02' }]);

  assert.equal(groups[2]!.key, 'environment');
  assert.equal(groups[2]!.count, 1);
});
