import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnsi } from '../src/view-model/ansi.ts';
import { lineDiff, looksLikeDiff, parseUnified } from '../src/view-model/diff.ts';
import { buildTree, cleanUserText, execCommand, findMatches, flatten, hint, isContext, mergeEvents, fmtDuration, visibleId } from '../src/view-model/tree.ts';
import { looksLikeMarkdown } from '../src/view-model/markdown.ts';
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
  assert.deepEqual(ids(flatten(t, { show: 'all', expanded: new Map(), collapseAll: false })), ['t1', 'r1', 'c1', 'x1', 't2', 'm2']);
  assert.deepEqual(ids(flatten(t, { show: 'errors', expanded: new Map(), collapseAll: true })), ['t1', 'c1']);
  assert.deepEqual(ids(flatten(t, { show: 'all', expanded: new Map(), collapseAll: true })), ['t1', 't2']);
  assert.deepEqual(ids(flatten(t, { show: 'all', expanded: new Map(), collapseAll: true, reveal: ['o1'] })), ['t1', 'r1', 'c1', 'x1', 't2']);
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

test('tree: noise rows are hidden; results fold into their call; a hidden match maps to its call', () => {
  const t = buildTree([
    ...EVS,
    ev('r0', 't2', 'reasoning', 7, { text: '' }),
    ev('a1', 't2', 'meta', 8, { role: 'attachment', text: 'environment' }),
    ev('a2', 't2', 'meta', 9, { role: 'attachment', text: 'queued_command\nlater' }),
    ev('s1', 't2', 'meta', 10, { role: 'system', text: 'turn_duration' }),
    ev('t3', null, 'turn', 11, { text: '<command-name>/exit</command-name>\n<command-message>exit</command-message>' }),
  ]);
  const rows = flatten(t, { show: 'all', expanded: new Map(), collapseAll: false });
  assert.deepEqual(rows.map((r) => r.node.ev.id), ['t1', 'r1', 'c1', 'x1', 't2', 'm2', 'a2']);
  assert.equal(rows.find((r) => r.node.ev.id === 'c1')!.hasChildren, false);
  assert.ok(t.byId.get('c1')!.failed);
  assert.equal(visibleId(t, 'o1'), 'c1');
  assert.ok(isContext(t.byId.get('a1')!.ev) && !isContext(t.byId.get('a2')!.ev));
  assert.equal(hint(t.byId.get('a2')!.ev), 'later');
});

test('cleanUserText: slash commands, local output, ! shell, caveats', () => {
  assert.deepEqual(cleanUserText('<command-message>grill-me</command-message>\n<command-name>/grill-me</command-name>\n<command-args>plan X</command-args>'), { text: '/grill-me plan X', hidden: false });
  assert.equal(cleanUserText('<command-name>/exit</command-name>').hidden, true);
  assert.deepEqual(cleanUserText('<local-command-stdout>Goodbye!</local-command-stdout>'), { text: 'Goodbye!', hidden: true });
  assert.deepEqual(cleanUserText('<local-command-stdout>Set model to \x1b[1mSonnet\x1b[22m</local-command-stdout>'), { text: 'Set model to Sonnet', hidden: false });
  assert.equal(cleanUserText('<local-command-caveat>Caveat: ...</local-command-caveat>').hidden, true);
  assert.deepEqual(cleanUserText('<bash-input>git status</bash-input>'), { text: '! git status', hidden: false });
  assert.deepEqual(cleanUserText('<bash-stdout>ok</bash-stdout><bash-stderr></bash-stderr>'), { text: 'ok', hidden: false });
  assert.deepEqual(cleanUserText('plain prompt'), { text: 'plain prompt', hidden: false });
});

test('execCommand: Codex exec wrapper yields the shell command', () => {
  const text = 'text(await tools.exec_command({cmd:"cat >> a.py <<\'PY\'\\n\\ndef f():\\n    return \\"x\\"\\nPY", yield_time_ms: 1000}))';
  assert.equal(execCommand(text), 'cat >> a.py <<\'PY\'\n\ndef f():\n    return "x"\nPY');
  assert.equal(hint(ev('e', null, 'tool_call', 0, { tool_name: 'exec', text })), "cat >> a.py <<'PY'");
  assert.equal(execCommand('console.log(1)'), null);
});

test('looksLikeMarkdown: handoff notes yes, code and numbered output no', () => {
  assert.ok(looksLikeMarkdown('# Handoff\n\n**Status:** built\n\n## Goal\nExtend it.'));
  assert.ok(!looksLikeMarkdown('def f():\n    return 1\n'));
  assert.ok(!looksLikeMarkdown('     1\t# Title\n     2\t**b**\n     3\t- x'));
  assert.ok(!looksLikeMarkdown('total 8\n-rw-r--r-- 1 a b 0 x'));
});
