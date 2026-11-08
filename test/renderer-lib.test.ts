import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnsi } from '../src/renderer/lib/ansi.ts';
import { lineDiff, looksLikeDiff, parseUnified } from '../src/renderer/lib/diff.ts';
import { buildTree, findMatches, flatten, hint, mergeEvents, fmtDuration } from '../src/renderer/lib/tree.ts';
import type { EventRow } from '../src/core/types.ts';

test('ansi: colours, bold, reset and dropped cursor codes', () => {
  assert.deepEqual(parseAnsi('a\x1b[31mred\x1b[0m \x1b[1;38;5;196mx\x1b[22m\x1b[2Ky'), [
    { text: 'a' },
    { text: 'red', fg: 'ansi-red' },
    { text: ' ' },
    { text: 'x', fg: 'rgb(255,0,0)', bold: true },
    { text: 'y', fg: 'rgb(255,0,0)' },
  ]);
  assert.deepEqual(parseAnsi('plain'), [{ text: 'plain' }]);
});

test('diff: line diff with context and hunks', () => {
  const a = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
  const b = a.replace('l10', 'L10');
  const d = lineDiff(a, b);
  assert.equal(d[0].type, 'hunk');
  assert.deepEqual(d.filter((l) => l.type === 'del').map((l) => l.text), ['l10']);
  assert.deepEqual(d.filter((l) => l.type === 'add').map((l) => [l.text, l.newNo]), [['L10', 11]]);
  assert.equal(d.filter((l) => l.type === 'ctx').length, 6);
  assert.ok(looksLikeDiff('*** Begin Patch\n*** Update File: a\n@@\n-x\n+y\n*** End Patch'));
  assert.ok(!looksLikeDiff('just - some text'));
  assert.deepEqual(parseUnified('@@ -1 +1 @@\n-a\n+b').map((l) => l.type), ['hunk', 'del', 'add']);
});

const ev = (id: string, parent: string | null, kind: any, seq: number, extra: Partial<EventRow> = {}): EventRow => ({
  id, session_id: 's', seq, parent_id: parent, kind, role: null, ts: 1000 * seq, duration_ms: null, tokens_in: null, tokens_out: null, tool_name: null, text: id, ...extra,
});

const EVS = [
  ev('t1', null, 'turn', 0),
  ev('r1', 't1', 'reasoning', 1, { tokens_out: 5 }),
  ev('c1', 't1', 'tool_call', 2, { tool_name: 'Bash', text: '{"command":"ls -la"}', duration_ms: 500 }),
  ev('o1', 'c1', 'error', 3, { text: 'boom NEEDLE' }),
  ev('x1', 't1', 'text', 4, { tokens_out: 7, text: 'needle and needle' }),
  ev('t2', null, 'turn', 5),
  ev('m2', 't2', 'meta', 6),
];

test('tree: nesting, aggregated tokens and turn duration', () => {
  const t = buildTree(EVS);
  assert.deepEqual(t.roots.map((r) => r.ev.id), ['t1', 't2']);
  const t1 = t.byId.get('t1')!;
  assert.equal(t1.tokensOut, 12);
  assert.equal(t1.duration, 4000);
  assert.equal(hint(t.byId.get('c1')!.ev), 'ls -la');
});

test('tree: show filter keeps matches and ancestors; collapse; reveal opens ancestors', () => {
  const t = buildTree(EVS);
  const ids = (rows: ReturnType<typeof flatten>) => rows.map((r) => r.node.ev.id);
  assert.deepEqual(ids(flatten(t, { show: 'all', expanded: new Map(), collapseAll: false })), ['t1', 'r1', 'c1', 'o1', 'x1', 't2', 'm2']);
  assert.deepEqual(ids(flatten(t, { show: 'errors', expanded: new Map(), collapseAll: true })), ['t1', 'c1', 'o1']);
  assert.deepEqual(ids(flatten(t, { show: 'all', expanded: new Map(), collapseAll: true })), ['t1', 't2']);
  assert.deepEqual(ids(flatten(t, { show: 'all', expanded: new Map(), collapseAll: true, reveal: ['o1'] })), ['t1', 'r1', 'c1', 'o1', 'x1', 't2']);
  assert.deepEqual(ids(flatten(t, { show: 'all', expanded: new Map([['t1', false]]), collapseAll: false })), ['t1', 't2', 'm2']);
});

test('search: case-insensitive matches and occurrence count', () => {
  assert.deepEqual(findMatches(EVS, 'needle'), { ids: ['o1', 'x1'], count: 3 });
  assert.deepEqual(findMatches(EVS, '  '), { ids: [], count: 0 });
});

test('mergeEvents replaces by id and appends new', () => {
  const m = mergeEvents(EVS.slice(0, 2), [ev('r1', 't1', 'reasoning', 1, { tokens_out: 9 }), ev('n', null, 'turn', 9)]);
  assert.deepEqual(m.map((e) => [e.id, e.tokens_out]), [['t1', null], ['r1', 9], ['n', null]]);
  assert.equal(fmtDuration(65_000), '1m5s');
});
