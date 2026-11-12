import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDetailModel } from './detail.ts';
import type { KeyInputLike } from './session-list.ts';
import type { TreeNode } from './tree.ts';

/** Maximum UTF-8 byte length sent over OSC 52 before falling back to a temp file. */
export const OSC52_MAX_BYTES = 65_536;

export type CopyAction =
  | { type: 'copyText' }
  | { type: 'copyCode' }
  | { type: 'copyDiff' }
  | { type: 'copySessionId' }
  | { type: 'copySourcePath' };

export interface CopyFallbackOptions {
  label: string;
  osc52Supported: boolean;
  copyOsc52: (text: string) => boolean;
  maxBytes?: number;
  tmpDir?: string;
}

export interface CopyResult {
  method: 'osc52' | 'tempfile';
  filePath?: string;
  statusMessage: string;
}

/** Map a key event to a clipboard copy action, or null if not a copy shortcut. */
export function keyToCopyAction(key: KeyInputLike): CopyAction | null {
  if (key.ctrl || key.meta || key.shift) return null;
  switch (key.name) {
    case 'y':
      return { type: 'copyText' };
    case 'c':
      return { type: 'copyCode' };
    case 'd':
      return { type: 'copyDiff' };
    case 'i':
      return { type: 'copySessionId' };
    case 'p':
      return { type: 'copySourcePath' };
    default:
      return null;
  }
}

/** Extract the full plain text of a selected trace step (uncollapsed, raw markdown). */
export function extractStepCopyText(node: TreeNode | null): string | null {
  if (!node) return null;
  const model = buildDetailModel(node, { rawMode: true, outputExpanded: true });
  const parts: string[] = [];
  for (const b of model.blocks) {
    if (b.kind === 'markdown' || b.kind === 'text' || b.kind === 'ansi') {
      if (b.text) parts.push(b.text);
    } else if (b.kind === 'code') {
      if (b.code) parts.push(b.code);
    } else if (b.kind === 'diff') {
      if (b.diffText) parts.push(b.diffText);
    }
  }
  if (parts.length > 0) return parts.join('\n\n');
  return node.ev.text || null;
}

const FENCED_CODE_RE = /```[^\n]*\n([\s\S]*?)```/g;

/** Extract code blocks from a selected trace step (tool code blocks or fenced markdown blocks). */
export function extractCodeBlockText(node: TreeNode | null): string | null {
  if (!node) return null;
  const model = buildDetailModel(node, { rawMode: true, outputExpanded: true });
  const codeParts: string[] = [];
  for (const b of model.blocks) {
    if (b.kind === 'code' && b.code) {
      codeParts.push(b.code);
    }
  }
  if (codeParts.length > 0) return codeParts.join('\n\n');

  const fencedParts: string[] = [];
  for (const b of model.blocks) {
    if (b.kind === 'markdown' && b.text) {
      FENCED_CODE_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = FENCED_CODE_RE.exec(b.text)) !== null) {
        const body = m[1]!.replace(/\n$/, '');
        if (body) fencedParts.push(body);
      }
    }
  }
  return fencedParts.length > 0 ? fencedParts.join('\n\n') : null;
}

/** Extract unified diff text from a selected trace step, if any diff block is present. */
export function extractDiffText(node: TreeNode | null): string | null {
  if (!node) return null;
  const model = buildDetailModel(node, { rawMode: true, outputExpanded: true });
  const diffs: string[] = [];
  for (const b of model.blocks) {
    if (b.kind === 'diff' && b.diffText) {
      diffs.push(b.diffText);
    }
  }
  return diffs.length > 0 ? diffs.join('\n\n') : null;
}

/**
 * Copy text via OSC 52 when supported and within the byte cap; otherwise write
 * the text to a temp file in `os.tmpdir()` and return a status message with its path.
 */
export function copyWithFallback(text: string, opts: CopyFallbackOptions): CopyResult {
  const maxBytes = opts.maxBytes ?? OSC52_MAX_BYTES;
  const byteLen = Buffer.byteLength(text, 'utf8');

  if (opts.osc52Supported && byteLen <= maxBytes && opts.copyOsc52(text)) {
    return {
      method: 'osc52',
      statusMessage: `Copied ${opts.label} to clipboard`,
    };
  }

  const dir = opts.tmpDir ?? os.tmpdir();
  const token = crypto.randomBytes(4).toString('hex');
  const filePath = path.join(dir, `periscope-copy-${Date.now()}-${token}.txt`);
  fs.writeFileSync(filePath, text, 'utf8');

  const reason = !opts.osc52Supported
    ? 'OSC 52 unsupported'
    : byteLen > maxBytes
      ? 'Too large for OSC 52'
      : 'Clipboard failed';

  return {
    method: 'tempfile',
    filePath,
    statusMessage: `${reason} — wrote ${opts.label} to ${filePath}`,
  };
}
