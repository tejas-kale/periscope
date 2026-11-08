import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aliveInSandbox, parseClaudeProcs, presenceChanges, presenceMap } from '../src/core/presence.ts';

const reg = (pid: number, sessionId: string, status: string, startedAt: number) => JSON.stringify({ pid, sessionId, status, startedAt, kind: 'interactive' });

test('presence: registry files parse; busy is running, idle is open; junk is skipped', () => {
  const procs = parseClaudeProcs([reg(1, 'a', 'busy', 100), reg(455, 'b', 'idle', 50), '{"pid":', 'null']);
  assert.deepEqual(procs.map((p) => p.sessionId), ['a', 'b']);
  const m = presenceMap([{ prefix: 's:', procs }]);
  assert.equal(m.get('s:a'), 'running');
  assert.equal(m.get('s:b'), 'open');
});

test('presence: sandbox entries older than every running container are stale', () => {
  const procs = parseClaudeProcs([reg(1, 'now', 'busy', 10_000), reg(455, 'old', 'idle', 1_000)]);
  assert.deepEqual(aliveInSandbox(procs, [9_000]).map((p) => p.sessionId), ['now']);
  assert.deepEqual(aliveInSandbox(procs, []), [], 'no container running: nothing is open');
});

test('presence: changes between two maps', () => {
  const a = new Map([['x', 'open' as const], ['y', 'running' as const]]);
  const b = new Map([['x', 'running' as const], ['z', 'open' as const]]);
  assert.deepEqual(presenceChanges(a, b).sort(), ['x', 'y', 'z']);
});
