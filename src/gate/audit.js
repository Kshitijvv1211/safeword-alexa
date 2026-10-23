import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Append-only, hash-chained audit log. Each entry commits to the previous
// entry's hash, so editing or deleting any line breaks verification from
// that point on.

export const GENESIS = '0'.repeat(64);

/** Stable JSON (sorted keys) so the hash does not depend on key order. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function entryHash({ seq, ts, kind, data, prev_hash }) {
  return createHash('sha256').update(canonical({ seq, ts, kind, data, prev_hash })).digest('hex');
}

export class AuditLog {
  /** @param {string|null} file JSONL path, or null for in-memory only */
  constructor(file = null) {
    this.file = file;
    this.entries = [];
    if (file && existsSync(file)) {
      this.entries = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    }
  }

  append(kind, data, now = new Date()) {
    const prev = this.entries.at(-1);
    const entry = { seq: (prev?.seq ?? 0) + 1, ts: now.toISOString(), kind, data, prev_hash: prev?.hash ?? GENESIS };
    entry.hash = entryHash(entry);
    this.entries.push(entry);
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, JSON.stringify(entry) + '\n');
    }
    return entry;
  }

  verify() {
    let prev = GENESIS;
    for (const e of this.entries) {
      if (e.prev_hash !== prev || entryHash(e) !== e.hash) {
        return { intact: false, broken_at: e.seq, entries: this.entries.length };
      }
      prev = e.hash;
    }
    return { intact: true, entries: this.entries.length, head: prev };
  }

  recent(limit = 20, kind) {
    const list = kind ? this.entries.filter((e) => e.kind === kind) : this.entries;
    return list.slice(-limit).reverse();
  }

  /** Demo helper: silently rewrite one entry on disk and in memory, as an attacker would. */
  tamper(seq, mutate) {
    const e = this.entries.find((x) => x.seq === seq);
    if (!e) return false;
    mutate(e.data);
    if (this.file) writeFileSync(this.file, this.entries.map((x) => JSON.stringify(x)).join('\n') + '\n');
    return true;
  }
}
