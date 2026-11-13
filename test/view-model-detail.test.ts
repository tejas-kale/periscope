import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree } from '../src/view-model/tree.ts';
import type { EventRow } from '../src/core/types.ts';
import { buildDetailModel, extractImageRefs, COLLAPSE_LINES } from '../src/view-model/detail.ts';

function makeEv(overrides: Partial<EventRow> & { id: string; seq: number }): EventRow {
  return {
    session_id: 's1',
    parent_id: null,
    kind: 'text',
    role: 'assistant',
    tool_name: null,
    text: '',
    ts: 1000,
    duration_ms: null,
    tokens_in: null,
    tokens_out: null,
    ...overrides,
  };
}

test('detail view-model: Markdown step switches between rendered and raw source', () => {
  const tree = buildTree([
    makeEv({ id: 'm1', seq: 1, kind: 'text', text: '# Heading\n\n| A | B |\n|---|---|\n| 1 | 2 |' }),
  ]);
  const node = tree.byId.get('m1')!;

  const rendered = buildDetailModel(node, { rawMode: false, outputExpanded: false });
  assert.equal(rendered.canToggleRaw, true);
  assert.equal(rendered.blocks[0]!.kind, 'markdown');
  assert.equal((rendered.blocks[0] as { raw: boolean }).raw, false);

  const raw = buildDetailModel(node, { rawMode: true, outputExpanded: false });
  assert.equal(raw.canToggleRaw, true);
  assert.equal(raw.blocks[0]!.kind, 'markdown');
  assert.equal((raw.blocks[0] as { raw: boolean }).raw, true);
});

test('detail view-model: Edit tool call renders diff and folds tool_result output', () => {
  const tree = buildTree([
    makeEv({
      id: 'tc1',
      seq: 1,
      kind: 'tool_call',
      tool_name: 'Edit',
      text: JSON.stringify({
        file_path: 'src/app.ts',
        old_string: 'const a = 1;\nconst b = 2;',
        new_string: 'const a = 1;\nconst b = 3;',
      }),
    }),
    makeEv({
      id: 'tr1',
      seq: 2,
      parent_id: 'tc1',
      kind: 'tool_result',
      text: 'File updated successfully.',
    }),
  ]);
  const node = tree.byId.get('tc1')!;
  const model = buildDetailModel(node, { rawMode: false, outputExpanded: false });

  assert.equal(model.title, 'Edit');
  const diffBlock = model.blocks.find((b) => b.kind === 'diff');
  assert.ok(diffBlock, 'expected diff block');
  assert.match(diffBlock.diffText, /-const b = 2;/);
  assert.match(diffBlock.diffText, /\+const b = 3;/);

  const outputHeading = model.blocks.find((b) => b.kind === 'heading' && b.text === 'Output');
  assert.ok(outputHeading, 'expected folded Output heading');
  const outputText = model.blocks.find((b) => b.kind === 'text' && b.text.includes('File updated successfully.'));
  assert.ok(outputText, 'expected folded Output text');
});

test('detail view-model: long ANSI output collapses at 40 lines and expands on demand', () => {
  const lines = Array.from({ length: 60 }, (_, i) => `\x1b[32mline ${i + 1}\x1b[0m`).join('\n');
  const tree = buildTree([
    makeEv({ id: 'tc2', seq: 1, kind: 'tool_call', tool_name: 'Bash', text: '{"command":"ls"}' }),
    makeEv({ id: 'tr2', seq: 2, parent_id: 'tc2', kind: 'tool_result', text: lines }),
  ]);
  const node = tree.byId.get('tc2')!;

  const collapsed = buildDetailModel(node, { rawMode: false, outputExpanded: false });
  assert.equal(collapsed.hasCollapsibleOutput, true);
  assert.equal(collapsed.totalOutputLines, 60);
  const ansiCollapsed = collapsed.blocks.find((b) => b.kind === 'ansi');
  assert.ok(ansiCollapsed && ansiCollapsed.kind === 'ansi');
  assert.equal(ansiCollapsed.text.split('\n').length, COLLAPSE_LINES);

  const expanded = buildDetailModel(node, { rawMode: false, outputExpanded: true });
  const ansiExpanded = expanded.blocks.find((b) => b.kind === 'ansi');
  assert.ok(ansiExpanded && ansiExpanded.kind === 'ansi');
  assert.equal(ansiExpanded.text.split('\n').length, 60);

  // When findQuery matches past line 40, output auto-expands
  const withTailMatch = buildDetailModel(node, {
    rawMode: false,
    outputExpanded: false,
    findQuery: 'line 55',
  });
  assert.equal(withTailMatch.outputExpanded, true);
  const ansiTail = withTailMatch.blocks.find((b) => b.kind === 'ansi');
  assert.ok(ansiTail && ansiTail.kind === 'ansi');
  assert.equal(ansiTail.text.split('\n').length, 60);

  // When findQuery only matches in the first 40 lines, output stays collapsed
  const withHeadMatch = buildDetailModel(node, {
    rawMode: false,
    outputExpanded: false,
    findQuery: 'line 12',
  });
  assert.equal(withHeadMatch.outputExpanded, false);
});

test('detail view-model: extractImageRefs finds Claude base64 and Antigravity media URIs', () => {
  const claudeRaw = JSON.stringify({
    message: {
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ],
    },
  });
  assert.deepEqual(extractImageRefs(claudeRaw), [
    { kind: 'base64', mimeType: 'image/png', data: 'AAAA', alt: 'embedded image', location: 'embedded image' },
  ]);

  const agyRaw = JSON.stringify({
    media: [{ uri: '/tmp/screenshot.png', mime_type: 'image/png' }],
  });
  assert.deepEqual(extractImageRefs(agyRaw), [
    { kind: 'uri', mimeType: 'image/png', uri: '/tmp/screenshot.png', alt: 'screenshot.png', location: '/tmp/screenshot.png' },
  ]);

  const claudeTextImgRaw = JSON.stringify({
    message: {
      content: [
        { type: 'text', text: '[Image: source: /private/tmp/claude-501/-Users-foo/abc/images/1.png]' },
      ],
    },
  });
  assert.deepEqual(extractImageRefs(claudeTextImgRaw), [
    {
      kind: 'uri',
      mimeType: 'image/png',
      uri: '/private/tmp/claude-501/-Users-foo/abc/images/1.png',
      alt: '1.png',
      location: '/private/tmp/claude-501/-Users-foo/abc/images/1.png',
    },
  ]);
});
