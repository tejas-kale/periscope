import { useEffect, useState } from 'react';
import type { EventRow } from '../../core/types.ts';
import { lineDiff, looksLikeDiff, parseUnified } from '../lib/diff.ts';
import { fmtDuration, fmtTokens, type TreeNode } from '../lib/tree.ts';
import { api } from '../api.ts';
import { CodeBlock, langForPath } from './CodeBlock.tsx';
import { DiffView } from './DiffView.tsx';
import { Markdown } from './Markdown.tsx';
import { Output } from './Output.tsx';
import { KindIcon } from './Icons.tsx';

function parseArgs(text: string): Record<string, any> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** Tool arguments, rendered by what the tool does: edits as diffs, shell commands and file writes as code. */
export function ToolArgs({ ev }: { ev: EventRow }) {
  const a = parseArgs(ev.text);
  const tool = ev.tool_name ?? '';
  if (a) {
    const file = a.file_path ?? a.path ?? a.AbsolutePath ?? a.TargetFile;
    if (typeof a.old_string === 'string' && typeof a.new_string === 'string') {
      return <DiffView title={file} lines={lineDiff(a.old_string, a.new_string)} copy={a.new_string} />;
    }
    if (Array.isArray(a.edits) && a.edits.every((e: any) => typeof e?.old_string === 'string')) {
      return (
        <>
          {a.edits.map((e: any, i: number) => (
            <DiffView key={i} title={`${file ?? ''} · edit ${i + 1}`} lines={lineDiff(e.old_string, e.new_string ?? '')} copy={e.new_string} />
          ))}
        </>
      );
    }
    if (typeof a.content === 'string' && file) {
      return (
        <>
          <div className="diff-title">{file}</div>
          <CodeBlock code={a.content} lang={langForPath(file)} />
        </>
      );
    }
    const cmd = a.command ?? a.CommandLine ?? a.cmd;
    if (typeof cmd === 'string' || Array.isArray(cmd)) {
      const rest = Object.fromEntries(Object.entries(a).filter(([k]) => !['command', 'CommandLine', 'cmd'].includes(k)));
      return (
        <>
          <CodeBlock code={Array.isArray(cmd) ? cmd.join(' ') : cmd} lang="bash" />
          {Object.keys(rest).length > 0 && <CodeBlock code={JSON.stringify(rest, null, 2)} lang="json" />}
        </>
      );
    }
    const patch = a.patch ?? a.input;
    if (typeof patch === 'string' && looksLikeDiff(patch)) return <DiffView lines={parseUnified(patch)} copy={patch} />;
    if (typeof a.prompt === 'string' && Object.keys(a).length <= 4) {
      return (
        <>
          <CodeBlock code={JSON.stringify({ ...a, prompt: undefined }, null, 2)} lang="json" />
          <Markdown text={a.prompt} />
        </>
      );
    }
    return <CodeBlock code={JSON.stringify(a, null, 2)} lang="json" />;
  }
  if (looksLikeDiff(ev.text)) return <DiffView lines={parseUnified(ev.text)} copy={ev.text} />;
  if (tool === 'exec' || tool === 'js') return <CodeBlock code={ev.text} lang="javascript" />;
  return <CodeBlock code={ev.text} lang={tool === 'shell' ? 'bash' : null} />;
}

interface Img {
  src: string;
  alt: string;
}

/** Images in the raw record: Claude base64 blocks, Antigravity step media. */
function useImages(ev: EventRow): Img[] {
  const [imgs, setImgs] = useState<Img[]>([]);
  useEffect(() => {
    let live = true;
    setImgs([]);
    void api()
      .getRaw(ev.id)
      .then(async (raw) => {
        if (!raw || (!raw.includes('"image') && !raw.includes('"media"'))) return;
        const out: Img[] = [];
        const visit = (v: any) => {
          if (!v || typeof v !== 'object') return;
          if (Array.isArray(v)) return v.forEach(visit);
          if (v.type === 'image' && v.source?.type === 'base64' && typeof v.source.data === 'string') out.push({ src: `data:${v.source.media_type};base64,${v.source.data}`, alt: 'image' });
          for (const k of Object.keys(v)) if (k !== 'toolUseResult') visit(v[k]);
        };
        const d = JSON.parse(raw);
        // In a Claude tool-result line, only the block for this event counts; otherwise the whole record.
        visit(d.message?.content ?? d);
        for (const m of Array.isArray(d.media) ? d.media : []) {
          if (typeof m?.uri === 'string' && m.mime_type?.startsWith('image/')) {
            const src = await api().readImage(m.uri);
            if (src) out.push({ src, alt: m.uri.split('/').pop() });
          }
        }
        if (live) setImgs(out);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [ev.id]);
  return imgs;
}

function RawJson({ id }: { id: string }) {
  const [raw, setRaw] = useState<string | null | undefined>(undefined);
  return (
    <details className="raw" onToggle={(e) => (e.currentTarget.open && raw === undefined ? void api().getRaw(id).then(setRaw) : undefined)}>
      <summary>Raw record</summary>
      {raw === undefined ? <div className="empty">Loading…</div> : raw ? <Output text={raw} forceOpen /> : <div className="empty">(none)</div>}
    </details>
  );
}

function Body({ node }: { node: TreeNode }) {
  const ev = node.ev;
  switch (ev.kind) {
    case 'turn':
    case 'text':
      return <Markdown text={ev.text} />;
    case 'reasoning':
      return ev.text.trim() ? <div className="reasoning"><Markdown text={ev.text} /></div> : <div className="empty">The model's thinking was not recorded in the transcript.</div>;
    case 'tool_call': {
      const results = node.children.filter((c) => c.ev.kind === 'tool_result' || c.ev.kind === 'error');
      return (
        <>
          <h4>Input</h4>
          <ToolArgs ev={ev} />
          {results.map((r) => (
            <div key={r.ev.id}>
              <h4 className={r.ev.kind === 'error' ? 'err' : ''}>{r.ev.kind === 'error' ? 'Error' : 'Output'}</h4>
              <Output text={r.ev.text} />
              <Images ev={r.ev} />
            </div>
          ))}
        </>
      );
    }
    case 'tool_result':
    case 'error':
      return <Output text={ev.text} />;
    default:
      return <Output text={ev.text} />;
  }
}

function Images({ ev }: { ev: EventRow }) {
  const imgs = useImages(ev);
  return imgs.length ? (
    <div className="images">
      {imgs.map((im, i) => (
        <img key={i} src={im.src} alt={im.alt} />
      ))}
    </div>
  ) : null;
}

function label(ev: EventRow): string {
  if (ev.kind === 'tool_call') return ev.tool_name ?? 'tool call';
  if (ev.kind === 'turn') return 'User prompt';
  if (ev.kind === 'tool_result') return 'Tool result';
  return { reasoning: 'Reasoning', text: 'Model text', error: 'Error', meta: ev.role ? `Meta · ${ev.role}` : 'Meta' }[ev.kind] ?? ev.kind;
}

export function Detail({ node }: { node: TreeNode | null }) {
  if (!node) return <div className="detail empty-state">Select a step in the trace.</div>;
  const ev = node.ev;
  return (
    <div className="detail">
      <header className="detail-head">
        <KindIcon kind={ev.kind} />
        <h3>{label(ev)}</h3>
        <span className="detail-meta">
          {ev.ts != null && <time>{new Date(ev.ts).toLocaleString()}</time>}
          {node.duration != null && <span>{fmtDuration(node.duration)}</span>}
          {node.tokensIn > 0 && <span title="input tokens (including cache)">in {fmtTokens(node.tokensIn)}</span>}
          {node.tokensOut > 0 && <span title="output tokens">out {fmtTokens(node.tokensOut)}</span>}
        </span>
      </header>
      <div className="detail-body">
        <Body node={node} />
        {ev.kind !== 'tool_call' && <Images ev={ev} />}
        <RawJson key={ev.id} id={ev.id} />
      </div>
    </div>
  );
}
