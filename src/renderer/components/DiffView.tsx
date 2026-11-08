import type { DiffLine } from '../lib/diff.ts';
import { CopyButton } from './CopyButton.tsx';

export function DiffView({ lines, title, copy }: { lines: DiffLine[]; title?: string; copy?: string }) {
  return (
    <div className="diff">
      {title && <div className="diff-title">{title}</div>}
      {copy != null && <CopyButton text={copy} />}
      <pre>
        {lines.map((l, i) => (
          <div key={i} className={`dl dl-${l.type}`}>
            <span className="dl-no">{l.oldNo ?? ''}</span>
            <span className="dl-no">{l.newNo ?? ''}</span>
            <span className="dl-sign">{l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}</span>
            <span className="dl-text">{l.text}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}
