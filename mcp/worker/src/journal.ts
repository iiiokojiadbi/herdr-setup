import { open, rename, unlink, stat, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { prune, journalBudgetBytes, type Entry, type Journal } from '../../../core/src/journal';

// The launcher holds an exclusive flock for this file's entire lifetime.
export class FileJournal implements Journal {
  private values = new Map<string, Entry>();
  constructor(private path: string) {}
  async load() {
    try {
      if ((await stat(this.path)).size > journalBudgetBytes * 2) throw new Error('Journal exceeds read limit.');
      const rows: [string, Entry][] = JSON.parse(await readFile(this.path, 'utf8'));
      if (!Array.isArray(rows) || rows.length > 500 || rows.some(row => !Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || !row[1] || !['sent','pending','unknown'].includes(row[1].status) || !Number.isFinite(row[1].timestamp) || typeof row[1].payloadHash !== 'string')) throw new Error('Invalid journal.');
      this.values = new Map(rows);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await prune(this);
    for (const [key, entry] of this.values) if (entry.status === 'pending') await this.set(JSON.stringify(['','','',key]), {...entry, status:'unknown'});
  }
  // Request IDs can contain sensitive strings. Only fingerprints reach disk.
  private key(key: string) { return createHash('sha256').update(key).digest('hex'); }
  async get(key: string) {
    const entry = this.values.get(this.storageKey(key));
    if (!entry) return undefined;
    const parts = JSON.parse(key);
    return {...entry, ...(entry.status === 'sent' ? {result:{ok:true as const,data:{address:parts[2],requestId:parts[3],delivery:'sent',duplicate:false}}} : {})};
  }
  async entries(): Promise<[string, Entry][]> {
    // Core pruning requires a valid four-part journal key. Persisted metadata is
    // redacted; reconstruct a key mapped back to its fingerprint for operations.
    return [...this.values].map(([key, entry]) => [JSON.stringify(['','','',key]), entry]);
  }
  private storageKey(key: string) {
    const parts = JSON.parse(key);
    return parts[0] === '' && parts[1] === '' && parts[2] === '' ? parts[3] : this.key(key);
  }
  async set(key: string, entry: Entry) {
    const next = new Map(this.values);
    // No payload, requestId, process environment, stderr or response persisted.
    next.set(this.storageKey(key), {sender:'',sessionId:'',recipient:'',requestId:'',payloadHash:entry.payloadHash,timestamp:entry.timestamp,implicit:entry.implicit,status:entry.status});
    await this.save(next);
  }
  async delete(key: string) { const next = new Map(this.values); next.delete(this.storageKey(key)); await this.save(next); }
  private async save(next: Map<string, Entry>) {
    const content = JSON.stringify([...next]);
    if (next.size > 500 || Buffer.byteLength(content) > journalBudgetBytes) throw new Error('Journal budget exceeded.');
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
      await rename(temporary, this.path);
      const directory = await open(dirname(this.path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      this.values = next;
    } finally { await unlink(temporary).catch(() => {}); }
  }
}
