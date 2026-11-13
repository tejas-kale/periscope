import { test } from 'node:test';
import assert from 'node:assert/strict';
import { traceIcon } from '../src/view-model/trace-icons.ts';

test('user turns no longer use a > style chevron', () => {
  const icon = traceIcon('turn', null);
  assert.ok(!/[>›❯»]/.test(icon), `got ${icon}`);
});

test('tool calls get an icon per tool family, across agents', () => {
  assert.equal(traceIcon('tool_call', 'Bash'), traceIcon('tool_call', 'exec_command'));
  assert.equal(traceIcon('tool_call', 'Edit'), traceIcon('tool_call', 'apply_patch'));
  assert.notEqual(traceIcon('tool_call', 'Bash'), traceIcon('tool_call', 'Edit'));
  assert.notEqual(traceIcon('tool_call', 'Read'), traceIcon('tool_call', 'Grep'));
  assert.notEqual(traceIcon('tool_call', 'Agent'), traceIcon('tool_call', 'Bash'));
});

test('unknown tools fall back to a generic tool icon', () => {
  assert.equal(traceIcon('tool_call', 'SomethingNew'), traceIcon('tool_call', null));
});

test('every icon is a single terminal cell', () => {
  const names = ['Bash', 'Edit', 'Read', 'Grep', 'Agent', 'WebFetch', 'TodoWrite', 'x', null];
  const kinds = ['turn', 'reasoning', 'text', 'tool_result', 'error', 'meta'] as const;
  const icons = [...names.map((n) => traceIcon('tool_call', n)), ...kinds.map((k) => traceIcon(k, null))];
  for (const i of icons) {
    assert.equal([...i].length, 1, `icon ${i}`);
    assert.ok(!/\p{Extended_Pictographic}/u.test(i), `emoji-width icon ${i}`);
  }
});
