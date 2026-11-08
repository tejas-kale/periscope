import { createHash } from 'node:crypto';

export function stableId(sessionId: string, key: string): string {
  return createHash('sha1').update(sessionId).update('\0').update(key).digest('hex').slice(0, 20);
}

export function parseTs(v: unknown): number | null {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

export function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

export function pretty(v: unknown): string {
  if (typeof v === 'string') {
    const parsed = tryJson(v);
    if (parsed !== undefined && typeof parsed === 'object' && parsed !== null) return JSON.stringify(parsed, null, 2);
    return v;
  }
  if (v === undefined) return '';
  return JSON.stringify(v, null, 2);
}

export function oneLine(s: string, max = 120): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** Text out of a content value that may be a string or a list of typed blocks. */
export function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : pretty(content);
  return content
    .map((b) => {
      if (typeof b === 'string') return b;
      if (b && typeof b === 'object') {
        const o = b as Record<string, unknown>;
        if (typeof o.text === 'string') return o.text;
        if (o.type === 'image') return '[image]';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export function isObj(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
