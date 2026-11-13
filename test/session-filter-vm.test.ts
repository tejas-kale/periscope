import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSearchResultItems,
  cycleAgentFilter,
  cycleDatePreset,
  cycleHostFilter,
  cycleStatusFilter,
  dateRangeForPreset,
  formatFilterBar,
  hasActiveFilters,
  parseDateRangeInput,
  parseSnippet,
} from '../src/view-model/session-filter.ts';
import type { SearchHit, SessionRow } from '../src/core/types.ts';

test('filter cyclers step through all options and wrap to undefined', () => {
  assert.equal(cycleAgentFilter(undefined), 'claude');
  assert.equal(cycleAgentFilter('claude'), 'codex');
  assert.equal(cycleAgentFilter('codex'), 'antigravity');
  assert.equal(cycleAgentFilter('antigravity'), 'cursor');
  assert.equal(cycleAgentFilter('cursor'), undefined);

  assert.equal(cycleHostFilter(undefined), 'native');
  assert.equal(cycleHostFilter('native'), 'sandbox');
  assert.equal(cycleHostFilter('sandbox'), undefined);

  assert.equal(cycleStatusFilter(undefined), 'live');
  assert.equal(cycleStatusFilter('live'), 'idle');
  assert.equal(cycleStatusFilter('idle'), undefined);

  assert.equal(cycleDatePreset('all'), '24h');
  assert.equal(cycleDatePreset('24h'), '7d');
  assert.equal(cycleDatePreset('7d'), '30d');
  assert.equal(cycleDatePreset('30d'), 'all');
});

test('dateRangeForPreset computes from/to relative to clock', () => {
  const now = Date.parse('2026-06-15T12:00:00Z');
  assert.deepEqual(dateRangeForPreset('all', now), {});
  assert.deepEqual(dateRangeForPreset('24h', now), { from: now - 86_400_000 });
  assert.deepEqual(dateRangeForPreset('7d', now), { from: now - 7 * 86_400_000 });
  assert.deepEqual(dateRangeForPreset('30d', now), { from: now - 30 * 86_400_000 });
});

test('parseDateRangeInput parses single day, closed range, and open-ended ranges', () => {
  const single = parseDateRangeInput('2026-06-01');
  assert.ok(single);
  assert.equal(single.from, Date.parse('2026-06-01T00:00:00'));
  assert.equal(single.to, Date.parse('2026-06-01T23:59:59.999'));
  assert.equal(single.label, '2026-06-01');

  const range = parseDateRangeInput('2026-06-01..2026-06-05');
  assert.ok(range);
  assert.equal(range.from, Date.parse('2026-06-01T00:00:00'));
  assert.equal(range.to, Date.parse('2026-06-05T23:59:59.999'));
  assert.equal(range.label, '2026-06-01..2026-06-05');

  const openEnd = parseDateRangeInput('2026-06-01..');
  assert.ok(openEnd);
  assert.equal(openEnd.from, Date.parse('2026-06-01T00:00:00'));
  assert.equal(openEnd.to, undefined);

  const openStart = parseDateRangeInput('..2026-06-05');
  assert.ok(openStart);
  assert.equal(openStart.from, undefined);
  assert.equal(openStart.to, Date.parse('2026-06-05T23:59:59.999'));

  assert.equal(parseDateRangeInput('not-a-date'), null);
  assert.equal(parseDateRangeInput(''), null);
});

test('formatFilterBar and hasActiveFilters reflect active filter state', () => {
  assert.equal(hasActiveFilters({}), false);
  assert.equal(hasActiveFilters({ agent: 'claude' }), true);

  const emptyBar = formatFilterBar({}, 'All');
  assert.match(emptyBar, /\[a\]Agent:All/);
  assert.match(emptyBar, /\[o\]Host:All/);
  assert.match(emptyBar, /\[s\]Status:All/);
  assert.match(emptyBar, /\[d\]Date:All/);
  assert.doesNotMatch(emptyBar, /\[c\]Clear/);

  const activeBar = formatFilterBar({ agent: 'codex', host: 'sandbox', status: 'live' }, '7d');
  assert.match(activeBar, /\[a\]Agent:Codex/);
  assert.match(activeBar, /\[o\]Host:Sandbox/);
  assert.match(activeBar, /\[s\]Status:Live/);
  assert.match(activeBar, /\[d\]Date:7d/);
  assert.match(activeBar, /\[c\]Clear/);
});

test('parseSnippet splits FTS5 \\u0001/\\u0002 markers into highlighted segments', () => {
  const segs = parseSnippet('found \u0001needle\u0002 in \u0001haystack\u0002 here');
  assert.deepEqual(segs, [
    { text: 'found ', match: false },
    { text: 'needle', match: true },
    { text: ' in ', match: false },
    { text: 'haystack', match: true },
    { text: ' here', match: false },
  ]);

  assert.deepEqual(parseSnippet('plain text'), [{ text: 'plain text', match: false }]);
});

test('buildSearchResultItems pairs hits with sessions and assigns 1-9 quick indices', () => {
  const s1: SessionRow = {
    id: 's1',
    agent: 'claude',
    host: 'native',
    project: 'proj',
    cwd: '/tmp/proj',
    title: 'First',
    started_at: 1000,
    updated_at: 2000,
    status: 'idle',
    source_path: '/tmp/s1.jsonl',
  };
  const hits: SearchHit[] = [
    { session_id: 's1', event_id: 'e1', snippet: 'hello \u0001world\u0002' },
    { session_id: 'missing', event_id: 'e2', snippet: 'ignored' },
  ];
  const items = buildSearchResultItems(hits, new Map([[s1.id, s1]]));
  assert.equal(items.length, 1);
  assert.equal(items[0]!.key, 's:s1');
  assert.equal(items[0]!.hit.event_id, 'e1');
  assert.equal(items[0]!.quickIndex, 1);
});
