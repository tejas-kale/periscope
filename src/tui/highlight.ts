import { RGBA, StyledText, TextAttributes, type TextChunk } from '@opentui/core';

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
  const needle = query.trim().toLowerCase();
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

  const lower = text.toLowerCase();
  const chunks: TextChunk[] = [];
  let pos = 0;

  while (pos < text.length) {
    const idx = lower.indexOf(needle, pos);
    if (idx === -1) {
      chunks.push({
        __isChunk: true,
        text: text.slice(pos),
        fg: baseFg,
        bg: baseBg,
        attributes: baseAttrs,
      });
      break;
    }
    if (idx > pos) {
      chunks.push({
        __isChunk: true,
        text: text.slice(pos, idx),
        fg: baseFg,
        bg: baseBg,
        attributes: baseAttrs,
      });
    }
    chunks.push({
      __isChunk: true,
      text: text.slice(idx, idx + needle.length),
      fg: matchFg,
      bg: matchBg,
      attributes: baseAttrs | TextAttributes.BOLD,
    });
    pos = idx + needle.length;
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
