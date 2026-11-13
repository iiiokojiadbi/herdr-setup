import { Fault, type Envelope } from './errors';
export interface Entry { sender: string; sessionId: string; recipient: string; requestId: string; payloadHash: string; timestamp: number; implicit: boolean; status: 'pending' | 'sent' | 'unknown'; result?: Envelope }
export interface Journal { get(key: string): Promise<Entry | undefined>; set(key: string, entry: Entry): Promise<void>; entries(): Promise<[string,Entry][]>; delete(key: string): Promise<void> }
export const ttlMs = 7 * 24 * 60 * 60 * 1000;
export const journalBudgetBytes = 1024 * 1024;
export function journalKey(sender: string, sessionId: string, recipient: string, requestId: string): string { return JSON.stringify([sender,sessionId,recipient,requestId]); }
// Count serialized UTF-8 bytes without depending on a host text encoder.
export function entryBytes(key: string, entry: Entry): number {
  let bytes = 0;
  for (const character of JSON.stringify({['delivery:'+key]:entry})) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}
export async function prune(journal: Journal, now = Date.now(), incoming?: [string,Entry]): Promise<void> {
  const reservedBytes = incoming ? entryBytes(...incoming) : 0;
  if (reservedBytes > journalBudgetBytes) throw new Fault('HC_ERROR','Delivery entry exceeds journal byte budget.');
  const entries = (await journal.entries()).filter(([key]) => key !== incoming?.[0]).sort((a,b) => a[1].timestamp - b[1].timestamp);
  const retained: [string,Entry][] = [];
  let bytes = reservedBytes;
  for (const [key,entry] of entries) {
    if (now - entry.timestamp >= ttlMs) await journal.delete(key);
    else { retained.push([key,entry]); bytes += entryBytes(key,entry); }
  }
  let offset = 0;
  while (retained.length - offset + (incoming ? 1 : 0) > 500 || bytes > journalBudgetBytes) {
    const [key,entry] = retained[offset++];
    await journal.delete(key);
    bytes -= entryBytes(key,entry);
  }
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
