import type { Envelope } from './errors';
export interface Entry { sender: string; recipient: string; requestId: string; payload: string; timestamp: number; implicit: boolean; status: 'pending' | 'sent' | 'unknown'; result?: Envelope }
export interface Journal { get(key: string): Promise<Entry | undefined>; set(key: string, entry: Entry): Promise<void>; entries(): Promise<[string,Entry][]>; delete(key: string): Promise<void> }
export const ttlMs = 7 * 24 * 60 * 60 * 1000;
export function journalKey(sender: string, recipient: string, requestId: string): string { return JSON.stringify([sender,recipient,requestId]); }
export async function prune(journal: Journal, now = Date.now()): Promise<void> {
  const entries = (await journal.entries()).sort((a,b) => b[1].timestamp - a[1].timestamp);
  for (const [index,[key,entry]] of entries.entries()) if (now - entry.timestamp >= ttlMs || index >= 500) await journal.delete(key);
}
export function hash(text: string): string {
  let a = 2166136261, b = 5381;
  for (let i=0;i<text.length;i++) { a = Math.imul(a ^ text.charCodeAt(i),16777619); b = Math.imul(b,33) ^ text.charCodeAt(i); }
  return `${(a>>>0).toString(16)}${(b>>>0).toString(16)}`;
}
