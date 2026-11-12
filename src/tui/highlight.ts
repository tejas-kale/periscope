import { RGBA, StyledText, TextAttributes, type TextChunk } from '@opentui/core';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Split `text` into TextChunks highlighting case-insensitive occurrences of `query`. */
export function highlightTextChunks(
  text: string,
  query: string,
  baseFg: RGBA | undefined,
  matchBg: RGBA,
  matchFg: RGBA,
  baseBg?: RGBA,
  baseAttrs: number = TextAttributes.NONE,
): TextChunk[] {
  const needle = query.trim();
  if (!needle || !text) {
    return [
      {
        __isChunk: true,
        text,
        fg: baseFg,
        bg: baseBg,
        attributes: baseAttrs,
      },
    ];
  }

  const re = new RegExp(escapeRegExp(needle), 'gi');
  const chunks: TextChunk[] = [];
  let pos = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) break;
    if (m.index > pos) {
      chunks.push({
        __isChunk: true,
        text: text.slice(pos, m.index),
        fg: baseFg,
        bg: baseBg,
        attributes: baseAttrs,
      });
    }
    chunks.push({
      __isChunk: true,
      text: m[0],
      fg: matchFg,
      bg: matchBg,
      attributes: baseAttrs | TextAttributes.BOLD,
    });
    pos = m.index + m[0].length;
  }

  if (pos < text.length) {
    chunks.push({
      __isChunk: true,
      text: text.slice(pos),
      fg: baseFg,
      bg: baseBg,
      attributes: baseAttrs,
    });
  }

  return chunks;
}

/** Build a StyledText with case-insensitive `query` matches highlighted. */
export function buildHighlightedStyledText(
  text: string,
  query: string,
  baseFg: RGBA | undefined,
  matchBg: RGBA,
  matchFg: RGBA,
): StyledText {
  return new StyledText(highlightTextChunks(text, query, baseFg, matchBg, matchFg));
}
