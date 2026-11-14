import { Fault, type Envelope } from './errors';
export interface Entry { sender: string; sessionId: string; recipient: string; requestId: string; payloadHash: string; timestamp: number; implicit: boolean; status: 'pending' | 'sent' | 'unknown'; result?: Envelope }
export interface Journal { canonicalKey?(key: string): string; get(key: string): Promise<Entry | undefined>; set(key: string, entry: Entry): Promise<void>; entries(): Promise<[string,Entry][]>; delete(key: string): Promise<void> }
export const ttlMs = 7 * 24 * 60 * 60 * 1000;
export const pendingProtectionMs = 10 * 60 * 1000;
export const journalBudgetBytes = 1024 * 1024;
export function journalKey(sender: string, sessionId: string, recipient: string, requestId: string): string { return JSON.stringify([sender,sessionId,recipient,requestId]); }
function currentKey(key: string): boolean {
  try {
    const parts = JSON.parse(key);
    return Array.isArray(parts) && parts.length === 4 && parts.every(part => typeof part === 'string');
  } catch { return false; }
}
// Count serialized UTF-8 bytes without depending on a host text encoder.
export function entryBytes(key: string, entry: Entry): number {
  let bytes = 0;
  for (const character of JSON.stringify({['delivery:'+key]:entry})) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}
// The shared store has no atomic compare-and-swap. Rechecking before deletion is
// best-effort: a write can still race the following delete or reserve the last
// slot concurrently. The 500-entry cap is soft (499 pending + two writes can
// become 501); the byte budget leaves headroom under the 4 MiB store limit.
// Strict guarantees would require an external lock, outside this MVP.
async function removeUnchanged(journal: Journal, key: string, snapshot: Entry): Promise<boolean> {
  const current = await journal.get(key);
  if (!current) return true;
  if (current.timestamp !== snapshot.timestamp || current.status !== snapshot.status || current.payloadHash !== snapshot.payloadHash) return false;
  await journal.delete(key);
  return true;
}
export async function prune(journal: Journal, now = Date.now(), incoming?: [string,Entry]): Promise<void> {
  const reservedBytes = incoming ? entryBytes(...incoming) : 0;
  if (reservedBytes > journalBudgetBytes) throw new Fault('JOURNAL_FULL','Delivery entry exceeds journal byte budget.');
  const canonicalKey = (key: string) => journal.canonicalKey?.(key) ?? key;
  const incomingKey = incoming ? canonicalKey(incoming[0]) : undefined;
  const entries = (await journal.entries()).filter(([key]) => canonicalKey(key) !== incomingKey).sort((a,b) => a[1].timestamp - b[1].timestamp);
  const retained: [string,Entry][] = [];
  let bytes = reservedBytes;
  const changed = new Set<string>();
  for (const [key,entry] of entries) {
    if (!currentKey(key) || now - entry.timestamp >= ttlMs) {
      if (await removeUnchanged(journal,key,entry)) continue;
      changed.add(key);
    }
    retained.push([key,entry]); bytes += entryBytes(key,entry);
  }
  let count = retained.length + (incoming ? 1 : 0);
  for (const [key,entry] of retained) {
    if (count <= 500 && bytes <= journalBudgetBytes) break;
    if (changed.has(key)) continue;
    if (entry.status === 'pending' && now - entry.timestamp < pendingProtectionMs) continue;
    if (!await removeUnchanged(journal,key,entry)) continue;
    bytes -= entryBytes(key,entry);
    count--;
  }
  if (incoming && (count > 500 || bytes > journalBudgetBytes)) throw new Fault('JOURNAL_FULL','Delivery journal is full of active pending entries.');
}
export async function writeEntry(journal: Journal, key: string, entry: Entry): Promise<void> {
  await prune(journal,Date.now(),[key,entry]);
  await journal.set(key,entry);
}
export function hash(text: string): string {
  let a = 2166136261, b = 5381;
  for (let i=0;i<text.length;i++) { a = Math.imul(a ^ text.charCodeAt(i),16777619); b = Math.imul(b,33) ^ text.charCodeAt(i); }
  return `${(a>>>0).toString(16)}${(b>>>0).toString(16)}`;
}
