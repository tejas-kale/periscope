/** A run of text with the SGR styling in effect. */
export interface AnsiSpan {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

const NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

function xterm256(n: number): string {
  if (n < 8) return `ansi-${NAMES[n]}`;
  if (n < 16) return `ansi-bright-${NAMES[n - 8]}`;
  if (n < 232) {
    const v = [0, 95, 135, 175, 215, 255];
    const i = n - 16;
    return `rgb(${v[Math.floor(i / 36)]},${v[Math.floor(i / 6) % 6]},${v[i % 6]})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

/**
 * Split text with ANSI escapes into styled spans. Colours are either `ansi-<name>` (themed by CSS) or `rgb(...)`.
 * Non-SGR escape sequences (cursor moves, OSC titles) are dropped.
 */
export function parseAnsi(input: string): AnsiSpan[] {
  const out: AnsiSpan[] = [];
  let cur: Omit<AnsiSpan, 'text'> = {};
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\[([0-9;?]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78]/g;
  let last = 0;
  const push = (t: string) => {
    if (!t) return;
    const prev = out[out.length - 1];
    if (prev && sameStyle(prev, cur)) prev.text += t;
    else out.push({ text: t, ...cur });
  };
  for (let m; (m = re.exec(input)); ) {
    push(input.slice(last, m.index));
    last = re.lastIndex;
    if (m[2] !== 'm' || m[1] === undefined) continue;
    const codes = m[1] === '' ? [0] : m[1].split(';').map((x) => Number(x) || 0);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) cur = {};
      else if (c === 1) cur = { ...cur, bold: true };
      else if (c === 2) cur = { ...cur, dim: true };
      else if (c === 3) cur = { ...cur, italic: true };
      else if (c === 4) cur = { ...cur, underline: true };
      else if (c === 22) cur = { ...cur, bold: false, dim: false };
      else if (c === 23) cur = { ...cur, italic: false };
      else if (c === 24) cur = { ...cur, underline: false };
      else if (c >= 30 && c <= 37) cur = { ...cur, fg: `ansi-${NAMES[c - 30]}` };
      else if (c >= 90 && c <= 97) cur = { ...cur, fg: `ansi-bright-${NAMES[c - 90]}` };
      else if (c >= 40 && c <= 47) cur = { ...cur, bg: `ansi-${NAMES[c - 40]}` };
      else if (c >= 100 && c <= 107) cur = { ...cur, bg: `ansi-bright-${NAMES[c - 100]}` };
      else if (c === 39) cur = { ...cur, fg: undefined };
      else if (c === 49) cur = { ...cur, bg: undefined };
      else if ((c === 38 || c === 48) && codes[i + 1] === 5) {
        cur = { ...cur, [c === 38 ? 'fg' : 'bg']: xterm256(codes[i + 2] ?? 0) };
        i += 2;
      } else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
        cur = { ...cur, [c === 38 ? 'fg' : 'bg']: `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})` };
        i += 4;
      }
    }
  }
  push(input.slice(last));
  return out.map(clean);
}

function clean(s: AnsiSpan): AnsiSpan {
  const o: AnsiSpan = { text: s.text };
  for (const k of ['fg', 'bg', 'bold', 'dim', 'italic', 'underline'] as const) if (s[k]) (o as any)[k] = s[k];
  return o;
}

function sameStyle(a: Omit<AnsiSpan, 'text'>, b: Omit<AnsiSpan, 'text'>): boolean {
  return a.fg === b.fg && a.bg === b.bg && !!a.bold === !!b.bold && !!a.dim === !!b.dim && !!a.italic === !!b.italic && !!a.underline === !!b.underline;
}

export const hasAnsi = (s: string) => s.includes('\x1b[');
