import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computePaneWidths,
  createLayoutState,
  resetPaneWidths,
  resizePane,
  toggleDetailZoom,
} from '../src/view-model/layout.ts';

test('layout view-model: computes default pane widths at 120 and 80 cols', () => {
  const state = createLayoutState();

  assert.deepEqual(computePaneWidths(120, state, false), {
    sessions: 120,
    trace: 0,
    detail: 0,
  });

  const w120 = computePaneWidths(120, state, true);
  assert.equal(w120.sessions + w120.trace + w120.detail, 120);
  assert.deepEqual(w120, { sessions: 31, trace: 41, detail: 48 });

  const w80 = computePaneWidths(80, state, true);
  assert.equal(w80.sessions + w80.trace + w80.detail, 80);
  assert.deepEqual(w80, { sessions: 21, trace: 27, detail: 32 });
});

test('layout view-model: resizes focused pane with clamping and resets to defaults', () => {
  let state = createLayoutState();

  // Grow trace pane
  state = resizePane(state, 'trace', 6);
  const grown = computePaneWidths(100, state, true);
  assert.equal(grown.trace, 40);
  assert.equal(grown.sessions + grown.trace + grown.detail, 100);

  // Shrink detail pane
  state = resizePane(state, 'detail', -10);
  const shrunkDetail = computePaneWidths(100, state, true);
  assert.equal(shrunkDetail.detail, 24);
  assert.equal(shrunkDetail.sessions + shrunkDetail.trace + shrunkDetail.detail, 100);

  // Clamp at minimum so no pane collapses below min
  for (let i = 0; i < 20; i++) {
    state = resizePane(state, 'sessions', -10);
  }
  const clamped = computePaneWidths(100, state, true);
  assert.ok(clamped.sessions >= 15);
  assert.ok(clamped.trace >= 20);
  assert.ok(clamped.detail >= 20);
  assert.equal(clamped.sessions + clamped.trace + clamped.detail, 100);

  // Reset restores 26 / 34 / 40
  state = resetPaneWidths(state);
  assert.deepEqual(computePaneWidths(100, state, true), {
    sessions: 26,
    trace: 34,
    detail: 40,
  });
});

test('layout view-model: detail zoom gives detail 100% width and toggles back', () => {
  let state = createLayoutState();
  state = toggleDetailZoom(state);
  assert.equal(state.detailZoomed, true);
  assert.deepEqual(computePaneWidths(80, state, true), {
    sessions: 0,
    trace: 0,
    detail: 80,
  });

  state = toggleDetailZoom(state);
  assert.equal(state.detailZoomed, false);
  assert.deepEqual(computePaneWidths(80, state, true), {
    sessions: 21,
    trace: 27,
    detail: 32,
  });
});

test('keymap view-model: lists every shortcut and formats lines within width', async () => {
  const { KEY_BINDINGS, formatHelpLines } = await import('../src/view-model/keymap.ts');
  const keys = KEY_BINDINGS.map((b) => b.keys).join(' ');
  for (const required of ['Tab', '[', ']', '=', 'z', 't', '?', 'q', 'Ctrl+C', 'S', '1-9', 'r', 'e', 'Enter', 'Esc', '/', 'n / N', 'f']) {
    assert.ok(keys.includes(required), `missing shortcut ${required} in KEY_BINDINGS`);
  }
  assert.ok(
    KEY_BINDINGS.some((b) => b.section === 'Trace Tree' && b.keys === '/'),
    'missing / in Trace Tree section',
  );
  assert.ok(
    KEY_BINDINGS.some((b) => b.section === 'Trace Tree' && b.keys === 'n / N'),
    'missing n / N in Trace Tree section',
  );

  const lines80 = formatHelpLines(68);
  assert.ok(lines80.length > 10);
  for (const line of lines80) {
    assert.ok(line.length <= 68, `line exceeds width 68: "${line}"`);
  }
});
