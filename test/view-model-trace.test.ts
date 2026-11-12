import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EventRow } from '../src/core/types.ts';
import {
  appendTraceEvents,
  applyTraceAction,
  computeWindow,
  createTraceState,
  getVisibleRows,
} from '../src/view-model/trace.ts';

function makeEv(overrides: Partial<EventRow> & { id: string; seq: number }): EventRow {
  return {
    session_id: 's1',
    parent_id: null,
    kind: 'turn',
    role: 'user',
    tool_name: null,
    text: overrides.id,
    ts: 1000 + overrides.seq * 100,
    duration_ms: null,
    tokens_in: null,
    tokens_out: null,
    ...overrides,
  };
}

test('trace view-model: builds tree, folds tool results, hides noise, nests subagents, and selects first visible row', () => {
  const events: EventRow[] = [
    makeEv({ id: 'turn-1', seq: 1, kind: 'turn', text: 'Fix bug' }),
    makeEv({ id: 'noise-empty', seq: 2, parent_id: 'turn-1', kind: 'reasoning', text: '   ' }),
    makeEv({ id: 'call-1', seq: 3, parent_id: 'turn-1', kind: 'tool_call', tool_name: 'Agent', text: '{"prompt":"sub"}' }),
    makeEv({ id: 'sub-text', seq: 4, parent_id: 'call-1', kind: 'text', text: 'Subagent work' }),
    makeEv({ id: 'res-1', seq: 5, parent_id: 'call-1', kind: 'tool_result', text: 'done' }),
  ];

  const state = createTraceState(events);
  const rows = getVisibleRows(state);
  assert.deepEqual(
    rows.map((r) => [r.node.ev.id, r.depth]),
    [
      ['turn-1', 0],
      ['call-1', 1],
      ['sub-text', 2],
    ],
  );
  assert.equal(state.selectedId, 'turn-1');
});

test('trace view-model: arrow navigation, expand/collapse, and parent jump', () => {
  const events: EventRow[] = [
    makeEv({ id: 'turn-1', seq: 1, kind: 'turn', text: 'Hello' }),
    makeEv({ id: 'text-1', seq: 2, parent_id: 'turn-1', kind: 'text', text: 'Hi there' }),
    makeEv({ id: 'turn-2', seq: 3, kind: 'turn', text: 'Next' }),
  ];

  let state = createTraceState(events);
  // Move down to text-1
  state = applyTraceAction(state, { type: 'moveDown' }, 10);
  assert.equal(state.selectedId, 'text-1');

  // Left on leaf jumps to parent turn-1
  state = applyTraceAction(state, { type: 'collapseOrAscend' }, 10);
  assert.equal(state.selectedId, 'turn-1');

  // Left on expanded turn-1 collapses it
  state = applyTraceAction(state, { type: 'collapseOrAscend' }, 10);
  assert.deepEqual(
    getVisibleRows(state).map((r) => r.node.ev.id),
    ['turn-1', 'turn-2'],
  );

  // Right on collapsed turn-1 expands it
  state = applyTraceAction(state, { type: 'expandOrDescend' }, 10);
  assert.deepEqual(
    getVisibleRows(state).map((r) => r.node.ev.id),
    ['turn-1', 'text-1', 'turn-2'],
  );
});

test('trace view-model: windowing slices visible rows and append preserves selection and scrollOffset', () => {
  const events: EventRow[] = Array.from({ length: 50 }, (_, i) =>
    makeEv({ id: `ev-${i}`, seq: i + 1, kind: 'turn', text: `Step ${i}` }),
  );

  let state = createTraceState(events);
  // Move down 15 times with viewport height 10 -> scrollOffset should advance to 6
  for (let i = 0; i < 15; i++) {
    state = applyTraceAction(state, { type: 'moveDown' }, 10);
  }
  assert.equal(state.selectedId, 'ev-15');
  assert.equal(state.scrollOffset, 6);

  const rows = getVisibleRows(state);
  const win = computeWindow(rows, state.scrollOffset, 10, 2);
  assert.equal(win.start, 6);
  assert.equal(win.end, 18); // 6 + 10 + 2 overscan
  assert.equal(win.visibleRows[0]!.node.ev.id, 'ev-6');

  // Append 5 new events -> selection and scrollOffset stay untouched
  const fresh = Array.from({ length: 5 }, (_, i) =>
    makeEv({ id: `ev-${50 + i}`, seq: 51 + i, kind: 'turn', text: `Step ${50 + i}` }),
  );
  state = appendTraceEvents(state, fresh);
  assert.equal(state.selectedId, 'ev-15');
  assert.equal(state.scrollOffset, 6);
  assert.equal(getVisibleRows(state).length, 55);
});

test('trace view-model: cycleShow, setShow, and toggleCollapseAll preserve valid selection', () => {
  const events: EventRow[] = [
    makeEv({ id: 't1', seq: 1, kind: 'turn', text: 'Turn 1' }),
    makeEv({ id: 'r1', seq: 2, parent_id: 't1', kind: 'reasoning', text: 'Thinking...' }),
    makeEv({ id: 'm1', seq: 3, parent_id: 't1', kind: 'text', text: 'Answer' }),
    makeEv({ id: 't2', seq: 4, kind: 'turn', text: 'Turn 2' }),
    makeEv({ id: 'e1', seq: 5, parent_id: 't2', kind: 'error', text: 'Boom' }),
  ];

  let state = createTraceState(events);
  assert.equal(state.show, 'all');
  assert.equal(state.rows.length, 5);

  // Select m1, then cycleShow -> 'errors' (m1 is filtered out, selection moves to valid row)
  state = applyTraceAction(state, { type: 'selectId', id: 'm1' }, 10);
  assert.equal(state.selectedId, 'm1');

  state = applyTraceAction(state, { type: 'cycleShow' }, 10);
  assert.equal(state.show, 'errors');
  assert.deepEqual(
    state.rows.map((r) => r.node.ev.id),
    ['t2', 'e1'],
  );
  assert.ok(state.selectedId && state.rowIndex.has(state.selectedId));

  state = applyTraceAction(state, { type: 'cycleShow' }, 10);
  assert.equal(state.show, 'reasoning');
  assert.deepEqual(
    state.rows.map((r) => r.node.ev.id),
    ['t1', 'r1'],
  );
  assert.ok(state.selectedId && state.rowIndex.has(state.selectedId));

  state = applyTraceAction(state, { type: 'cycleShow' }, 10);
  assert.equal(state.show, 'text');
  assert.deepEqual(
    state.rows.map((r) => r.node.ev.id),
    ['t1', 'm1'],
  );

  state = applyTraceAction(state, { type: 'cycleShow' }, 10);
  assert.equal(state.show, 'all');
  assert.equal(state.rows.length, 5);

  // Select child m1, toggleCollapseAll -> collapses t1 and t2, moves selection to ancestor t1
  state = applyTraceAction(state, { type: 'selectId', id: 'm1' }, 10);
  state = applyTraceAction(state, { type: 'toggleCollapseAll' }, 10);
  assert.equal(state.collapseAll, true);
  assert.deepEqual(
    state.rows.map((r) => r.node.ev.id),
    ['t1', 't2'],
  );
  assert.equal(state.selectedId, 't1');

  // Toggle again -> expands all
  state = applyTraceAction(state, { type: 'toggleCollapseAll' }, 10);
  assert.equal(state.collapseAll, false);
  assert.equal(state.rows.length, 5);
  assert.equal(state.selectedId, 't1');
});
