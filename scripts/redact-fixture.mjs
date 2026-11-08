#!/usr/bin/env node
// Make a parser fixture from a real transcript: keep the JSON structure, ids and short labels; shorten free text.
// Usage: node scripts/redact-fixture.mjs <in.jsonl> <out.jsonl> [maxLines] [--grep=<regex> lines to keep in addition]
import fs from 'node:fs';

const [, , input, output, maxArg, ...rest] = process.argv;
const max = Number(maxArg ?? 60);
const grep = rest.find((a) => a.startsWith('--grep='))?.slice(7);
const KEEP_KEYS = new Set(['type', 'name', 'role', 'timestamp', 'created_at', 'id', 'uuid', 'parentUuid', 'tool_use_id', 'call_id', 'sessionId', 'session_id', 'cwd', 'model', 'status', 'source', 'subtype', 'aiTitle', 'mime_type']);
const DROP_KEYS = new Set(['signature', 'encrypted_content', 'accountUuid', 'organizationUuid', 'creator_user_id', 'creator_account_id', 'base_instructions', 'data', 'requestId', 'wireIngestContext']);
const SECRET = /(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{12,}|Bearer\s+\S+|xox[abp]-\S+)/g;

function redact(v, key) {
  if (typeof v === 'string') {
    const s = v.replace(SECRET, '[secret]');
    if (KEEP_KEYS.has(key) || s.length <= 80) return s;
    // Keep the first lines (headers such as "Created At: …") and the last line, shortened; drop the middle.
    const lines = s.split('\n');
    const cut = (x) => (x.length > 70 ? x.slice(0, 50) + ' … [redacted]' : x);
    const head = lines.slice(0, 3).map(cut);
    return [...head, `[… ${s.length} chars redacted …]`, ...(lines.length > 3 ? [cut(lines[lines.length - 1])] : [])].join('\n');
  }
  if (Array.isArray(v)) return v.map((x) => redact(x, key));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) if (!DROP_KEYS.has(k)) o[k] = redact(x, k);
    return o;
  }
  return v;
}

const re = grep ? new RegExp(grep) : null;
const lines = fs.readFileSync(input, 'utf8').split('\n').filter(Boolean);
const keep = lines.filter((l, i) => i < max || (re && re.test(l))).filter((l) => !/"type":"api-request(-blob|-shape)?"/.test(l) || Math.random() < 0);
fs.writeFileSync(output, keep.map((l) => JSON.stringify(redact(JSON.parse(l)))).join('\n') + '\n');
console.log(`${keep.length} lines -> ${output}`);
