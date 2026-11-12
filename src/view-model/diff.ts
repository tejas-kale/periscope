export type DiffLine = { type: 'ctx' | 'add' | 'del' | 'hunk' | 'file'; text: string; oldNo?: number; newNo?: number };

/** Line diff of two texts (LCS), returned as unified-diff lines with `context` lines around changes. */
export function lineDiff(a: string, b: string, context = 3): DiffLine[] {
  const x = a.split('\n');
  const y = b.split('\n');
  // Trim common prefix and suffix so the quadratic table stays small.
  let pre = 0;
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
  let suf = 0;
  while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
  const xs = x.slice(pre, x.length - suf);
  const ys = y.slice(pre, y.length - suf);
  const ops: DiffLine[] = [];
  for (let i = 0; i < pre; i++) ops.push({ type: 'ctx', text: x[i], oldNo: i + 1, newNo: i + 1 });
  if (xs.length * ys.length > 4_000_000) {
    xs.forEach((t, i) => ops.push({ type: 'del', text: t, oldNo: pre + i + 1 }));
    ys.forEach((t, i) => ops.push({ type: 'add', text: t, newNo: pre + i + 1 }));
  } else {
    const n = xs.length;
    const m = ys.length;
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = xs[i] === ys[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && xs[i] === ys[j]) (ops.push({ type: 'ctx', text: xs[i], oldNo: pre + i + 1, newNo: pre + j + 1 }), i++, j++);
      else if (j < m && (i === n || L[i][j + 1] >= L[i + 1][j])) (ops.push({ type: 'add', text: ys[j], newNo: pre + j + 1 }), j++);
      else (ops.push({ type: 'del', text: xs[i], oldNo: pre + i + 1 }), i++);
    }
  }
  for (let k = 0; k < suf; k++) ops.push({ type: 'ctx', text: x[x.length - suf + k], oldNo: x.length - suf + k + 1, newNo: y.length - suf + k + 1 });
  return withContext(ops, context);
}

function withContext(ops: DiffLine[], context: number): DiffLine[] {
  const keep = new Uint8Array(ops.length);
  ops.forEach((o, i) => {
    if (o.type !== 'ctx') for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = 1;
  });
  const out: DiffLine[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (!keep[i]) continue;
    if (i === 0 || !keep[i - 1]) out.push({ type: 'hunk', text: `@@ -${ops[i].oldNo ?? '?'} +${ops[i].newNo ?? '?'} @@` });
    out.push(ops[i]);
  }
  return out;
}

/** Does this text look like a unified diff or an apply_patch envelope? */
export function looksLikeDiff(s: string): boolean {
  return /^(\*\*\* Begin Patch|diff --git |--- \S.*\n\+\+\+ |@@ -\d)/m.test(s) && /^[+-]/m.test(s);
}

/** Classify the lines of a unified diff (git diff or Codex apply_patch) for colouring. */
export function parseUnified(s: string): DiffLine[] {
  return s.split('\n').map((text) => {
    if (/^(\*\*\* |diff --git |index |--- |\+\+\+ )/.test(text)) return { type: 'file', text };
    if (text.startsWith('@@')) return { type: 'hunk', text };
    if (text.startsWith('+')) return { type: 'add', text: text.slice(1) };
    if (text.startsWith('-')) return { type: 'del', text: text.slice(1) };
    return { type: 'ctx', text: text.startsWith(' ') ? text.slice(1) : text };
  });
}
