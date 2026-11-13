import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionRow } from '../src/core/types.ts';
import {
  applySessionListAction,
  buildSessionListItems,
  createSessionListState,
  formatAge,
  formatAgent,
  formatHost,
  formatStatusBadge,
  keyToSessionListAction,
} from '../src/view-model/session-list.ts';

function makeSession(id: string, overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id,
    agent: 'claude',
    host: 'native',
    project: 'proj-a',
    cwd: '/tmp/proj-a',
    title: `Session ${id}`,
    started_at: 1_000,
    updated_at: 2_000,
    status: 'idle',
    source_path: `/tmp/${id}.jsonl`,
    ...overrides,
  };
}

test('session-list: formatAgent formats all supported agents', () => {
  assert.equal(formatAgent('claude'), 'Claude Code');
  assert.equal(formatAgent('codex'), 'Codex');
  assert.equal(formatAgent('antigravity'), 'Antigravity');
  assert.equal(formatAgent('cursor'), 'Cursor');
});

test('session-list: groups by project sorted by most recent activity, expands top 3, collapses rest', () => {
  const sessions = [
    makeSession('s-old', { project: 'delta', updated_at: 100 }),
    makeSession('s-p1-a', { project: 'alpha', updated_at: 500 }),
    makeSession('s-p1-b', { project: 'alpha', updated_at: 450 }),
    makeSession('s-p2', { project: 'beta', updated_at: 400 }),
    makeSession('s-p3', { project: 'gamma', updated_at: 300 }),
    makeSession('s-none', { project: null, updated_at: 200 }),
  ];

  const state = createSessionListState(sessions);
  const items = buildSessionListItems(sessions, state);

  assert.deepEqual(
    items.map((it) => ({
      kind: it.kind,
      key: it.key,
      quickIndex: it.kind === 'session' ? it.quickIndex : null,
    })),
    [
      { kind: 'group', key: 'g:alpha', quickIndex: null },
      { kind: 'session', key: 's:s-p1-a', quickIndex: 1 },
      { kind: 'session', key: 's:s-p1-b', quickIndex: 2 },
      { kind: 'group', key: 'g:beta', quickIndex: null },
      { kind: 'session', key: 's:s-p2', quickIndex: 3 },
      { kind: 'group', key: 'g:gamma', quickIndex: null },
      { kind: 'session', key: 's:s-p3', quickIndex: 4 },
      { kind: 'group', key: 'g:(no project)', quickIndex: null },
      { kind: 'group', key: 'g:delta', quickIndex: null },
    ],
  );
});

test('session-list: formatting helpers for agent, host, age, and live status badge', () => {
  assert.equal(formatAgent('claude'), 'Claude Code');
  assert.equal(formatAgent('codex'), 'Codex');
  assert.equal(formatAgent('antigravity'), 'Antigravity');

  assert.equal(formatHost('native'), 'Mac');
  assert.equal(formatHost('sandbox'), 'Sandbox');

  const now = 10_000_000;
  assert.equal(formatAge(now - 30_000, now), 'now');
  assert.equal(formatAge(now - 5 * 60_000, now), '5m');
  assert.equal(formatAge(now - 3 * 3_600_000, now), '3h');
  assert.equal(formatAge(now - 2 * 86_400_000, now), '2d');
  assert.equal(formatAge(null, now), '');

  assert.equal(formatStatusBadge('live'), '● live');
  assert.equal(formatStatusBadge('open'), '○ open');
  assert.equal(formatStatusBadge('idle'), '');
});

test('session-list: keyboard navigation, expand/collapse, show-more, and 1-9 quick-open', () => {
  const sessions = [
    makeSession('a1', { project: 'alpha', updated_at: 900 }),
    makeSession('a2', { project: 'alpha', updated_at: 890 }),
    makeSession('a3', { project: 'alpha', updated_at: 880 }),
    makeSession('a4', { project: 'alpha', updated_at: 870 }),
    makeSession('a5', { project: 'alpha', updated_at: 860 }),
    makeSession('b1', { project: 'beta', updated_at: 700 }),
    makeSession('c1', { project: 'gamma', updated_at: 600 }),
    makeSession('d1', { project: 'delta', updated_at: 500 }),
  ];

  let state = createSessionListState(sessions);
  assert.equal(state.cursorKey, 'g:alpha');

  // Move down to a1 and activate with Enter
  state = applySessionListAction(state, sessions, keyToSessionListAction({ name: 'down' })!);
  assert.equal(state.cursorKey, 's:a1');
  state = applySessionListAction(state, sessions, keyToSessionListAction({ name: 'return' })!);
  assert.equal(state.selectedSessionId, 'a1');

  // Show more in alpha reveals a5
  state = applySessionListAction(state, sessions, keyToSessionListAction({ name: 'm' })!);
  let items = buildSessionListItems(sessions, state);
  assert.ok(items.some((it) => it.key === 's:a5'));

  // Collapse alpha with 'h' while on a1 -> collapses alpha and moves cursor to g:alpha
  state = applySessionListAction(state, sessions, keyToSessionListAction({ name: 'h' })!);
  assert.equal(state.cursorKey, 'g:alpha');
  items = buildSessionListItems(sessions, state);
  assert.ok(!items.some((it) => it.key === 's:a1'));

  // Jump to bottom ('G') -> g:delta (collapsed), expand with 'l' -> reveals d1
  state = applySessionListAction(state, sessions, keyToSessionListAction({ name: 'g', shift: true, sequence: 'G' })!);
  assert.equal(state.cursorKey, 'g:delta');
  state = applySessionListAction(state, sessions, keyToSessionListAction({ name: 'l' })!);
  items = buildSessionListItems(sessions, state);
  assert.ok(items.some((it) => it.key === 's:d1'));

  // Quick-open '2' opens the 2nd visible session from top (c1, since alpha is collapsed, beta has b1 (#1), gamma has c1 (#2))
  state = applySessionListAction(state, sessions, keyToSessionListAction({ name: '2' })!);
  assert.equal(state.selectedSessionId, 'c1');
  assert.equal(state.cursorKey, 's:c1');

  // Clicking a group header toggles it; clicking a session selects it
  state = applySessionListAction(state, sessions, { type: 'clickItem', key: 'g:alpha' });
  items = buildSessionListItems(sessions, state);
  assert.ok(items.some((it) => it.key === 's:a1'));
  state = applySessionListAction(state, sessions, { type: 'clickItem', key: 's:a2' });
  assert.equal(state.selectedSessionId, 'a2');
  assert.equal(state.cursorKey, 's:a2');
});
