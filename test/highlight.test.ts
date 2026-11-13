import assert from 'node:assert/strict';
import test from 'node:test';
import { RGBA } from '@opentui/core';
import { buildSegmentsStyledText, truncateStyledSegments } from '../src/tui/highlight.ts';

const baseFg = RGBA.fromHex('#f3f4f6');
const toolFg = RGBA.fromHex('#93c5fd');
const matchBg = RGBA.fromHex('#854d0e');
const matchFg = RGBA.fromHex('#fef08a');

test('truncateStyledSegments preserves segments within maxWidth and clips with ellipsis', () => {
  const segs = [
    { text: '    ', fg: baseFg },
    { text: '$ Bash ', fg: toolFg },
    { text: 'Explore repo layout  557ms', fg: baseFg },
  ];

  const exact = truncateStyledSegments(segs, 40);
  assert.equal(exact.map((s) => s.text).join(''), '    $ Bash Explore repo layout  557ms');
  assert.equal(exact[1]?.fg, toolFg);

  const clipped = truncateStyledSegments(segs, 16);
  assert.equal(clipped.map((s) => s.text).join(''), '    $ Bash Expl…');
  assert.equal(clipped[1]?.fg, toolFg);
  assert.equal(clipped[2]?.fg, baseFg);
});

test('buildSegmentsStyledText keeps tool segment color and highlights search matches across segments', () => {
  const segs = [
    { text: '  ', fg: baseFg },
    { text: '$ Bash ', fg: toolFg },
    { text: 'Run bash tests', fg: baseFg },
  ];

  const plain = buildSegmentsStyledText(segs, '', matchBg, matchFg);
  assert.deepEqual(
    plain.chunks.map((c) => ({ text: c.text, fg: c.fg })),
    [
      { text: '  ', fg: baseFg },
      { text: '$ Bash ', fg: toolFg },
      { text: 'Run bash tests', fg: baseFg },
    ],
  );

  const highlighted = buildSegmentsStyledText(segs, 'bash', matchBg, matchFg);
  const matchChunks = highlighted.chunks.filter((c) => c.bg === matchBg);
  assert.deepEqual(
    matchChunks.map((c) => c.text),
    ['Bash', 'bash'],
  );
  assert.equal(highlighted.chunks[1]?.text, '$ ');
  assert.equal(highlighted.chunks[1]?.fg, toolFg);
});
