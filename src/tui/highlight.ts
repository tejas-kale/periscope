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

export interface StyledSegment {
  text: string;
  fg: RGBA;
  attributes?: number;
}

/** Truncate styled segments to `maxWidth` columns (appending `…` when clipped). */
export function truncateStyledSegments(segments: StyledSegment[], maxWidth: number): StyledSegment[] {
  const total = segments.reduce((n, s) => n + s.text.length, 0);
  if (total <= maxWidth) return segments;
  if (maxWidth <= 1) {
    const out: StyledSegment[] = [];
    let rem = Math.max(0, maxWidth);
    for (const s of segments) {
      if (rem <= 0) break;
      const slice = s.text.slice(0, rem);
      if (slice) out.push({ ...s, text: slice });
      rem -= slice.length;
    }
    return out;
  }
  const out: StyledSegment[] = [];
  let rem = maxWidth - 1;
  for (const s of segments) {
    if (rem <= 0) break;
    if (s.text.length <= rem) {
      if (s.text) out.push(s);
      rem -= s.text.length;
    } else {
      const slice = s.text.slice(0, rem);
      if (slice) out.push({ ...s, text: slice });
      rem = 0;
    }
  }
  if (out.length > 0) {
    const last = out[out.length - 1]!;
    out[out.length - 1] = { ...last, text: `${last.text}…` };
  }
  return out;
}

/** Render styled segments into a StyledText, highlighting `query` matches when non-empty. */
export function buildSegmentsStyledText(
  segments: StyledSegment[],
  query: string,
  matchBg: RGBA,
  matchFg: RGBA,
): StyledText {
  const chunks: TextChunk[] = [];
  for (const seg of segments) {
    if (!seg.text) continue;
    chunks.push(
      ...highlightTextChunks(
        seg.text,
        query,
        seg.fg,
        matchBg,
        matchFg,
        undefined,
        seg.attributes ?? TextAttributes.NONE,
      ),
    );
  }
  return new StyledText(chunks);
}
