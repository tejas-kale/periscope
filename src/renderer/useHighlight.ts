import { useLayoutEffect, type RefObject } from 'react';

/**
 * Highlight every occurrence of `query` inside `ref` with the CSS Custom Highlight API: works over any rendered
 * content (Markdown, Shiki, diffs) without changing the DOM.
 */
export function useHighlight(ref: RefObject<HTMLElement | null>, name: string, query: string, deps: unknown[]) {
  useLayoutEffect(() => {
    const reg = (CSS as any).highlights as Map<string, unknown> | undefined;
    const HighlightCtor = (globalThis as any).Highlight;
    if (!reg || !HighlightCtor) return;
    const run = () => {
      const el = ref.current;
      const q = query.trim().toLowerCase();
      if (!el || !q) return reg.delete(name);
      const ranges: Range[] = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = (n.nodeValue ?? '').toLowerCase();
        for (let i = t.indexOf(q); i !== -1; i = t.indexOf(q, i + q.length)) {
          const r = new Range();
          r.setStart(n, i);
          r.setEnd(n, i + q.length);
          ranges.push(r);
        }
      }
      reg.set(name, new HighlightCtor(...ranges));
    };
    run();
    // Shiki and images render asynchronously; re-run when the subtree changes.
    const mo = new MutationObserver(() => run());
    if (ref.current) mo.observe(ref.current, { childList: true, subtree: true, characterData: true });
    return () => {
      mo.disconnect();
      reg.delete(name);
    };
  }, [query, ...deps]);
}
