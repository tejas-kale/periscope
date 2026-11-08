import { useEffect, useState } from 'react';
import type { HighlighterGeneric } from 'shiki';
import { createHighlighter, bundledLanguages } from 'shiki';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { CopyButton } from './CopyButton.tsx';

let hl: Promise<HighlighterGeneric<any, any>> | null = null;
const getHl = () =>
  (hl ??= createHighlighter({ themes: ['github-light', 'github-dark'], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) }));

const ALIASES: Record<string, string> = { sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', js: 'javascript', ts: 'typescript', py: 'python', yml: 'yaml', md: 'markdown', rs: 'rust', rb: 'ruby', el: 'emacs-lisp', elisp: 'emacs-lisp' };
const MAX_HIGHLIGHT = 200_000;

export function resolveLang(lang?: string | null): string | null {
  if (!lang) return null;
  const l = lang.toLowerCase();
  const name = ALIASES[l] ?? l;
  return name in bundledLanguages ? name : null;
}

const EXT: Record<string, string> = { ts: 'typescript', tsx: 'tsx', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', py: 'python', rs: 'rust', go: 'go', rb: 'ruby', sh: 'bash', bash: 'bash', zsh: 'bash', json: 'json', md: 'markdown', yml: 'yaml', yaml: 'yaml', toml: 'toml', html: 'html', css: 'css', sql: 'sql', el: 'emacs-lisp', lua: 'lua', java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', r: 'r', R: 'r', tex: 'latex', org: 'org', nix: 'nix', dockerfile: 'docker', txt: 'text' };
export function langForPath(p?: string | null): string | null {
  if (!p) return null;
  const base = p.split('/').pop() ?? '';
  if (/^Dockerfile|Containerfile/.test(base)) return 'docker';
  return resolveLang(EXT[base.split('.').pop() ?? ''] ?? null);
}

export function CodeBlock({ code, lang, showCopy = true }: { code: string; lang?: string | null; showCopy?: boolean }) {
  const [html, setHtml] = useState<string | null>(null);
  const resolved = resolveLang(lang);
  useEffect(() => {
    setHtml(null);
    if (!resolved || code.length > MAX_HIGHLIGHT) return;
    let live = true;
    getHl()
      .then(async (h) => {
        if (!h.getLoadedLanguages().includes(resolved)) await h.loadLanguage(resolved as any);
        return h.codeToHtml(code, { lang: resolved, themes: { light: 'github-light', dark: 'github-dark' }, defaultColor: false });
      })
      .then((out) => live && setHtml(out))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [code, resolved]);
  return (
    <div className="code">
      {showCopy && <CopyButton text={code} />}
      {lang && <span className="code-lang">{lang}</span>}
      {html ? <div className="code-html" dangerouslySetInnerHTML={{ __html: html }} /> : <pre className="code-plain">{code}</pre>}
    </div>
  );
}
