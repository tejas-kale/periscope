import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { Store, type SqlDb } from '../src/core/store.ts';
import { Ingestor } from '../src/core/ingest.ts';
import { classify } from '../src/core/sources.ts';
import type { Agent, Host } from '../src/core/types.ts';

export const FIXTURES = path.join(import.meta.dirname, 'fixtures');

export function memStore(): Store {
  return new Store(new DatabaseSync(':memory:') as unknown as SqlDb);
}

/** Ingest a fixture file in one go (or in `pieces` chunks split at arbitrary byte positions). */
export function ingestFixture(ing: Ingestor, agent: Agent, rel: string, opts: { host?: Host; pieces?: number; parentToolUseId?: string; mtime?: number } = {}) {
  const host = opts.host ?? 'native';
  const abs = path.join(FIXTURES, agent, rel);
  const file = classify(agent, host, rel);
  if (!file) throw new Error(`not a transcript: ${rel}`);
  const bytes = fs.readFileSync(abs);
  const mtime = opts.mtime ?? 0;
  const pieces = opts.pieces ?? 1;
  let last;
  for (let i = 1; i <= pieces; i++) {
    const cut = Math.floor((bytes.length * i) / pieces);
    const start = ing.offsetFor(abs, cut);
    last = ing.ingest({ file, path: abs, size: bytes.length, mtime, start, bytes: bytes.subarray(start, cut), parentToolUseId: opts.parentToolUseId });
  }
  return last!;
}
