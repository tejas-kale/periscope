import { useMemo, useState } from 'react';
import { hasAnsi, parseAnsi } from '../lib/ansi.ts';
import { looksLikeDiff, parseUnified } from '../lib/diff.ts';
import { CodeBlock } from './CodeBlock.tsx';
import { CopyButton } from './CopyButton.tsx';
import { DiffView } from './DiffView.tsx';
import { Markdown } from './Markdown.tsx';
import { looksLikeMarkdown } from '../lib/markdown.ts';

const COLLAPSE_LINES = 40;

function AnsiPre({ text }: { text: string }) {
  const spans = useMemo(() => parseAnsi(text), [text]);
  return (
    <pre className="out">
      {spans.map((s, i) => {
        const cls = [s.bold && 'b', s.dim && 'dim', s.italic && 'i', s.underline && 'u', s.fg?.startsWith('ansi-') && `fg-${s.fg}`, s.bg?.startsWith('ansi-') && `bg-${s.bg}`].filter(Boolean).join(' ');
        const style = { color: s.fg?.startsWith('rgb') ? s.fg : undefined, background: s.bg?.startsWith('rgb') ? s.bg : undefined };
        return cls || style.color || style.background ? (
          <span key={i} className={cls} style={style}>
            {s.text}
          </span>
        ) : (
          s.text
        );
      })}
    </pre>
  );
}

/** Tool output: diffs coloured, JSON pretty-printed, shell output monospaced with ANSI colours, long output collapsed. */
export function Output({ text, forceOpen }: { text: string; forceOpen?: boolean }) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState(false);
  const md = useMemo(() => looksLikeMarkdown(text), [text]);
  const lines = useMemo(() => text.split('\n'), [text]);
  const json = useMemo(() => {
    const t = text.trim();
    if (!(t.startsWith('{') || t.startsWith('['))) return null;
    try {
      return JSON.stringify(JSON.parse(t), null, 2);
    } catch {
      return null;
    }
  }, [text]);
  if (!text) return <div className="empty">(no output)</div>;
  const long = lines.length > COLLAPSE_LINES && !open && !forceOpen;
  const shown = long ? lines.slice(0, COLLAPSE_LINES).join('\n') : text;
  let body;
  if (json) body = <CodeBlock code={long ? json.split('\n').slice(0, COLLAPSE_LINES).join('\n') : json} lang="json" showCopy={false} />;
  else if (looksLikeDiff(text)) body = <DiffView lines={parseUnified(shown)} />;
  else if (md && !raw) body = <div className="out-md"><Markdown text={shown} /></div>;
  else if (hasAnsi(text)) body = <AnsiPre text={shown} />;
  else body = <pre className="out">{shown}</pre>;
  return (
    <div className="output">
      <CopyButton text={json ?? text} />
      {md && !json && (
        <button className="raw-toggle" onClick={() => setRaw(!raw)} title="Switch between rendered Markdown and the raw text">
          {raw ? 'Rendered' : 'Raw'}
        </button>
      )}
      {body}
      {lines.length > COLLAPSE_LINES && !forceOpen && (
        <button className="expand" onClick={() => setOpen(!open)}>
          {open ? 'Collapse' : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}
