/** Plain text that is really Markdown (a handoff note, a README printed by `cat`): headings, bold, lists, fences. */
export function looksLikeMarkdown(text: string): boolean {
  if (text.length > 400_000) return false;
  const lines = text.split('\n').slice(0, 400);
  // `cat -n` style numbered output and ANSI output stay as they are.
  if (lines.filter((l) => /^\s*\d+[\t→]/.test(l)).length > lines.length / 2) return false;
  if (text.includes('\x1b[')) return false;
  let headings = 0;
  let other = 0;
  for (const l of lines) {
    if (/^#{1,6} \S/.test(l)) headings++;
    else if (/\*\*[^*\n]+\*\*|^\s*([-*]|\d+\.) \S|^```|^\|.*\|\s*$|\[[^\]]+\]\([^)]+\)/.test(l)) other++;
  }
  return (headings >= 1 && other >= 1) || headings >= 2 || other >= 4;
}
