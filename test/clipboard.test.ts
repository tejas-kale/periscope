import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EventRow } from '../src/core/types.ts';
import { buildTree } from '../src/view-model/tree.ts';
import {
  copyWithFallback,
  extractCodeBlockText,
  extractDiffText,
  extractStepCopyText,
  keyToCopyAction,
  OSC52_MAX_BYTES,
} from '../src/view-model/clipboard.ts';

function makeEvent(overrides: Partial<EventRow> & Pick<EventRow, 'id' | 'kind' | 'text'>): EventRow {
  return {
    session_id: 'sess-1',
    seq: 1,
    parent_id: null,
    role: null,
    ts: 1000,
    duration_ms: null,
    tokens_in: null,
    tokens_out: null,
    tool_name: null,
    ...overrides,
  };
}

test('clipboard view-model: extracts step text, fenced code blocks, and diffs', () => {
  const events: EventRow[] = [
    makeEvent({
      id: 'e-md',
      seq: 1,
      kind: 'text',
      text: '# Heading\n\nHere is code:\n\n```ts\nconst a = 1;\n```\n\nDone.',
    }),
    makeEvent({
      id: 'e-edit',
      seq: 2,
      kind: 'tool_call',
      tool_name: 'Edit',
      text: JSON.stringify({
        file_path: 'src/foo.ts',
        old_string: 'const x = 1;',
        new_string: 'const x = 2;',
      }),
    }),
    makeEvent({
      id: 'e-edit-res',
      seq: 3,
      parent_id: 'e-edit',
      kind: 'tool_result',
      text: 'Updated src/foo.ts',
    }),
  ];

  const tree = buildTree(events);
  const mdNode = tree.roots[0]!;
  const editNode = tree.roots[1]!;

  assert.match(extractStepCopyText(mdNode) ?? '', /# Heading/);
  assert.equal(extractCodeBlockText(mdNode), 'const a = 1;');
  assert.equal(extractDiffText(mdNode), null);

  const editDiff = extractDiffText(editNode);
  assert.ok(editDiff);
  assert.match(editDiff, /-const x = 1;/);
  assert.match(editDiff, /\+const x = 2;/);
  assert.equal(extractCodeBlockText(editNode), null);
  assert.match(extractStepCopyText(editNode) ?? '', /Updated src\/foo\.ts/);
});

test('clipboard view-model: copyWithFallback uses OSC 52 when supported and within cap, else writes temp file', () => {
  const oscCalls: string[] = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'periscope-clip-unit-'));
  try {
    // 1. OSC 52 supported and within cap
    const ok = copyWithFallback('hello world', {
      label: 'step text',
      osc52Supported: true,
      copyOsc52: (text) => {
        oscCalls.push(text);
        return true;
      },
      tmpDir,
    });
    assert.equal(ok.method, 'osc52');
    assert.deepEqual(oscCalls, ['hello world']);
    assert.match(ok.statusMessage, /Copied step text to clipboard/);

    // 2. OSC 52 unsupported -> temp file
    const unsup = copyWithFallback('secret output', {
      label: 'step text',
      osc52Supported: false,
      copyOsc52: () => {
        throw new Error('should not call osc52 when unsupported');
      },
      tmpDir,
    });
    assert.equal(unsup.method, 'tempfile');
    assert.ok(unsup.filePath && unsup.filePath.startsWith(tmpDir));
    assert.equal(fs.readFileSync(unsup.filePath, 'utf8'), 'secret output');
    assert.ok(unsup.statusMessage.includes(unsup.filePath));

    // 3. Exceeds size cap -> temp file even if OSC 52 supported
    const big = 'x'.repeat(OSC52_MAX_BYTES + 1);
    const overCap = copyWithFallback(big, {
      label: 'diff',
      osc52Supported: true,
      copyOsc52: () => {
        throw new Error('should not call osc52 when over cap');
      },
      tmpDir,
    });
    assert.equal(overCap.method, 'tempfile');
    assert.ok(overCap.filePath);
    assert.equal(fs.readFileSync(overCap.filePath, 'utf8'), big);
    assert.ok(overCap.statusMessage.includes(overCap.filePath));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('clipboard view-model: keyToCopyAction maps y, c, d, i, p without modifiers', () => {
  assert.deepEqual(keyToCopyAction({ name: 'y' }), { type: 'copyText' });
  assert.deepEqual(keyToCopyAction({ name: 'c' }), { type: 'copyCode' });
  assert.deepEqual(keyToCopyAction({ name: 'd' }), { type: 'copyDiff' });
  assert.deepEqual(keyToCopyAction({ name: 'i' }), { type: 'copySessionId' });
  assert.deepEqual(keyToCopyAction({ name: 'p' }), { type: 'copySourcePath' });
  assert.equal(keyToCopyAction({ name: 'c', ctrl: true }), null);
  assert.equal(keyToCopyAction({ name: 'y', meta: true }), null);
  assert.equal(keyToCopyAction({ name: 'x' }), null);
});
