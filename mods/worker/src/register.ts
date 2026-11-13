import type { Register, EngineInterface } from 'claude-code';
import { createClient, type Context } from '../../../core/src/client';
import { failure } from '../../../core/src/errors';
import { prune, writeEntry, type Journal, type Entry } from '../../../core/src/journal';
let context: Context = { cwd: '', sessionId: '' };
let deliveries: Promise<unknown> = Promise.resolve();
function adapter($: EngineInterface) {
  return { run: (argv: string[], options: {cwd: string; timeoutMs: number}) => $.process.run(argv,options) };
}
function journalAdapter($: EngineInterface): Journal {
  return {
    get: async (key) => (await $.store.get('delivery:'+key)) as Entry | undefined,
    set: (key,entry) => $.store.set('delivery:'+key,entry),
    delete: (key) => $.store.delete('delivery:'+key),
    entries: async () => {
      const entries: [string,Entry][] = [];
      for (const key of await $.store.keys()) if (key.startsWith('delivery:')) {
        const entry = await $.store.get(key);
        if (entry) entries.push([key.slice(9),entry as Entry]);
      }
      return entries;
    },
  };
}
export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const self = await $.env.get("HC_TERMINAL_ID");
    const parent = await $.env.get("HC_PARENT");
    context = {self,parent,cwd:await $.session.cwd(),sessionId:await $.session.id()};
    if (!self || !parent) return next(e);
    const journal = journalAdapter($);
    // A pending entry surviving reload has an unknown delivery outcome.
    for (const [key,entry] of await journal.entries()) if (entry.status === 'pending') await writeEntry(journal,key,{...entry,status:'unknown'});
    await prune(journal);
    await $.tool.register({"name": "report", "description": "Send result or blocker to parent. Reuse requestId on retry; new IDs can duplicate delivery. Without ID, deduplicate for 60 seconds including unknown outcomes, then allow another delivery. Explicit IDs keep unknown or pending outcomes until TTL (7 days), subject to journal eviction.", "inputSchema": {"type": "object", "additionalProperties": false, "properties": {"text": {"type": "string", "minLength": 1, "maxLength": 32768}, "blocker": {"type": "boolean"}, "requestId": {"type": "string", "minLength": 1, "maxLength": 128}}, "required": ["text"]}, "isDeferred": false});
    await $.tool.register({"name": "ask_owner", "description": "Send question to parent without waiting for response. Reuse requestId on retry; new IDs can duplicate delivery. Without ID, unknown outcomes can be retried after 60 seconds. Explicit IDs keep unknown or pending outcomes until TTL (7 days), subject to journal eviction.", "inputSchema": {"type": "object", "additionalProperties": false, "properties": {"text": {"type": "string", "minLength": 1, "maxLength": 32768}, "requestId": {"type": "string", "minLength": 1, "maxLength": 128}}, "required": ["text"]}, "isDeferred": false});
    return next(e);
  });
  on('tool.call', {tool:'mcp__herdr-worker__report'}, async ($, e) => {
    if (!context.self) return {result:failure('NOT_IN_HERDR','No terminal address.')};
    if (e.agentId || !context.parent) return {result:failure('WRONG_ROLE','Tool is unavailable in this role.')};
    const input = Object.fromEntries(Object.entries(e).filter(([key]) => !['tool','tool_use_id','agentId','requestMeta'].includes(key)));
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {result:failure('INVALID_INPUT','Expected an input object.')};
    if (Object.keys(input).some(key => !(["text", "blocker", "requestId"] as string[]).includes(key))) return {result:failure('INVALID_INPUT','Unknown input field.')};
    const permission = await $.tool.check({tool:e.tool,input});
    if (permission.decision !== 'allow') return {result:failure(permission.decision === 'ask' ? 'PERMISSION_REQUIRED' : 'PERMISSION_DENIED',permission.reason ?? 'Permission required.')};
    const client = createClient({transport:adapter($),context:{...context,sessionId:await $.session.id()},journal:journalAdapter($)});
    const result = deliveries.then(() => client.report(input), () => client.report(input));
    deliveries = result.catch(() => undefined);
    return {result:await result};
  }).catch(() => ({result:failure('HC_ERROR','Tool handler failed.','unknown')}));
  on('tool.call', {tool:'mcp__herdr-worker__ask_owner'}, async ($, e) => {
    if (!context.self) return {result:failure('NOT_IN_HERDR','No terminal address.')};
    if (e.agentId || !context.parent) return {result:failure('WRONG_ROLE','Tool is unavailable in this role.')};
    const input = Object.fromEntries(Object.entries(e).filter(([key]) => !['tool','tool_use_id','agentId','requestMeta'].includes(key)));
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {result:failure('INVALID_INPUT','Expected an input object.')};
    if (Object.keys(input).some(key => !(["text", "requestId"] as string[]).includes(key))) return {result:failure('INVALID_INPUT','Unknown input field.')};
    const permission = await $.tool.check({tool:e.tool,input});
    if (permission.decision !== 'allow') return {result:failure(permission.decision === 'ask' ? 'PERMISSION_REQUIRED' : 'PERMISSION_DENIED',permission.reason ?? 'Permission required.')};
    const client = createClient({transport:adapter($),context:{...context,sessionId:await $.session.id()},journal:journalAdapter($)});
    const result = deliveries.then(() => client.askOwner(input), () => client.askOwner(input));
    deliveries = result.catch(() => undefined);
    return {result:await result};
  }).catch(() => ({result:failure('HC_ERROR','Tool handler failed.','unknown')}));
};
