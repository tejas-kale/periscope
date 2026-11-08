import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from './CodeBlock.tsx';
import { DiffView } from './DiffView.tsx';
import { parseUnified } from '../lib/diff.ts';

const components: Components = {
  code({ className, children }) {
    const text = String(children ?? '');
    const lang = /language-([\w+-]+)/.exec(className ?? '')?.[1];
    if (!lang && !text.includes('\n')) return <code className="inline-code">{children}</code>;
    if (lang === 'diff' || lang === 'patch') return <DiffView lines={parseUnified(text.replace(/\n$/, ''))} />;
    return <CodeBlock code={text.replace(/\n$/, '')} lang={lang} />;
  },
  pre({ children }) {
    return <>{children}</>;
  },
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  },
};

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
