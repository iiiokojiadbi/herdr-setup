import type { Register, EngineInterface } from 'claude-code';
import { createClient, type Context } from '../../../core/src/client';
import { toolResult } from '../../shared/result';
import { failure } from '../../../core/src/errors';
import { prune, writeEntry, type Journal, type Entry } from '../../../core/src/journal';
let context: Context = { cwd: '', sessionId: '' };
let activeWait = false;
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
    if (!self || parent) return next(e);
    await $.tool.register({"name": "worker_spawn", "description": "Start a worker. Choose exactly one launch mode: template plus task, or command argv without template or task. cwd and worktree are mutually exclusive. A single command element must match ^[A-Za-z0-9._/-]+$; two or more elements remain separate argv. Never repeat an unknown spawn. Continue independent work after a spawn: worker reports, questions and emergency events arrive as separate hc input, and worker_list gives a non-blocking snapshot. done or idle do not prove success.", "inputSchema": {"type": "object", "properties": {"template": {"type": "string", "minLength": 1}, "task": {"type": "string", "minLength": 1, "maxLength": 32768}, "command": {"type": "array", "items": {"type": "string", "minLength": 1}, "minItems": 1}, "name": {"type": "string", "pattern": "^[a-z0-9_-]{1,32}$"}, "cwd": {"type": "string", "minLength": 1}, "worktree": {"type": "string", "minLength": 1}, "labels": {"type": "object", "additionalProperties": {"type": "string"}}}, "additionalProperties": false}, "isDeferred": false});
    await $.tool.register({"name": "worker_list", "description": "Non-blocking snapshot of children, never waits. Without arguments lists live children of this terminal. address returns one own child snapshot; includeFinished true adds finished, exited and dead workers, and applies to the whole list too. Missing or not_found addresses are failures, not a successful finish.", "inputSchema": {"type": "object", "additionalProperties": false, "properties": {"address": {"type": "string", "minLength": 1, "maxLength": 256}, "includeFinished": {"type": "boolean"}}, "required": []}, "isDeferred": false});
    await $.tool.register({"name": "worker_send", "description": "Send a task to a child. Read before retrying a failed send. Continue independent work afterward: the report arrives as separate hc input, and worker_list gives a non-blocking snapshot. done or idle do not prove success.", "inputSchema": {"type": "object", "additionalProperties": false, "properties": {"address": {"type": "string", "minLength": 1, "maxLength": 256}, "text": {"type": "string", "minLength": 1, "maxLength": 32768}}, "required": ["address", "text"]}, "isDeferred": false});
    await $.tool.register({"name": "worker_wait", "description": "Blocking diagnostic only, not the normal mode. Waits for child activity or a message; do not call it in a loop. Normal operation is push: reports and emergency events arrive as separate hc input, and worker_list gives a non-blocking snapshot. Timeout is a normal check-in. Default children any, 180 seconds.", "inputSchema": {"type": "object", "additionalProperties": false, "properties": {"address": {"type": "string", "minLength": 1, "maxLength": 256}, "children": {"type": "string", "enum": ["any", "all"]}, "timeoutMs": {"type": "integer", "minimum": 1000, "maximum": 540000}}, "required": []}, "isDeferred": true});
    await $.tool.register({"name": "worker_read", "description": "Read child screen and history.", "inputSchema": {"type": "object", "additionalProperties": false, "properties": {"address": {"type": "string", "minLength": 1, "maxLength": 256}, "lines": {"type": "integer", "minimum": 0, "maximum": 1000}}, "required": ["address"]}, "isDeferred": false});
    await $.tool.register({"name": "worker_stop", "description": "End a worker only on explicit user request. Removal is optional.", "inputSchema": {"type": "object", "additionalProperties": false, "properties": {"address": {"type": "string", "minLength": 1, "maxLength": 256}, "remove": {"type": "boolean"}}, "required": ["address"]}, "isDeferred": false});
    await $.tool.register({"name": "worker_templates", "description": "List worker templates.", "inputSchema": {"type": "object", "additionalProperties": false, "properties": {}, "required": []}, "isDeferred": false});
    return next(e);
  });
  on('tool.call', {tool:'mcp__herdr-orchestrator__worker_spawn'}, async ($, e) => {
    if (!context.self) return toolResult(failure('NOT_IN_HERDR','No terminal address.'));
    if (e.agentId || context.parent) return toolResult(failure('WRONG_ROLE','Tool is unavailable in this role.'));
    const input = Object.fromEntries(Object.entries(e).filter(([key]) => !['tool','tool_use_id','agentId','requestMeta'].includes(key)));
    if (!input || typeof input !== 'object' || Array.isArray(input)) return toolResult(failure('INVALID_INPUT','Expected an input object.'));
    if (Object.keys(input).some(key => !(["template", "task", "command", "name", "cwd", "worktree", "labels"] as string[]).includes(key))) return toolResult(failure('INVALID_INPUT','Unknown input field.'));
    const permission = await $.tool.check({tool:e.tool,input});
    if (permission.decision !== 'allow') return toolResult(failure(permission.decision === 'ask' ? 'PERMISSION_REQUIRED' : 'PERMISSION_DENIED',permission.reason ?? 'Permission required.'));
    const client = createClient({transport:adapter($),context});
    return toolResult(await client.spawn(input));
  }).catch(() => (toolResult(failure('HC_ERROR','Tool handler failed.','unknown'))));
  on('tool.call', {tool:'mcp__herdr-orchestrator__worker_list'}, async ($, e) => {
    if (!context.self) return toolResult(failure('NOT_IN_HERDR','No terminal address.'));
    if (e.agentId || context.parent) return toolResult(failure('WRONG_ROLE','Tool is unavailable in this role.'));
    const input = Object.fromEntries(Object.entries(e).filter(([key]) => !['tool','tool_use_id','agentId','requestMeta'].includes(key)));
    if (!input || typeof input !== 'object' || Array.isArray(input)) return toolResult(failure('INVALID_INPUT','Expected an input object.'));
    if (Object.keys(input).some(key => !(["address", "includeFinished"] as string[]).includes(key))) return toolResult(failure('INVALID_INPUT','Unknown input field.'));
    const client = createClient({transport:adapter($),context});
    return toolResult(await client.list(input));
  }).catch(() => (toolResult(failure('HC_ERROR','Tool handler failed.','unknown'))));
  on('tool.call', {tool:'mcp__herdr-orchestrator__worker_send'}, async ($, e) => {
    if (!context.self) return toolResult(failure('NOT_IN_HERDR','No terminal address.'));
    if (e.agentId || context.parent) return toolResult(failure('WRONG_ROLE','Tool is unavailable in this role.'));
    const input = Object.fromEntries(Object.entries(e).filter(([key]) => !['tool','tool_use_id','agentId','requestMeta'].includes(key)));
    if (!input || typeof input !== 'object' || Array.isArray(input)) return toolResult(failure('INVALID_INPUT','Expected an input object.'));
    if (Object.keys(input).some(key => !(["address", "text"] as string[]).includes(key))) return toolResult(failure('INVALID_INPUT','Unknown input field.'));
    const permission = await $.tool.check({tool:e.tool,input});
    if (permission.decision !== 'allow') return toolResult(failure(permission.decision === 'ask' ? 'PERMISSION_REQUIRED' : 'PERMISSION_DENIED',permission.reason ?? 'Permission required.'));
    const client = createClient({transport:adapter($),context});
    return toolResult(await client.send(input));
  }).catch(() => (toolResult(failure('HC_ERROR','Tool handler failed.','unknown'))));
  on('tool.call', {tool:'mcp__herdr-orchestrator__worker_wait'}, async ($, e) => {
    if (!context.self) return toolResult(failure('NOT_IN_HERDR','No terminal address.'));
    if (e.agentId || context.parent) return toolResult(failure('WRONG_ROLE','Tool is unavailable in this role.'));
    const input = Object.fromEntries(Object.entries(e).filter(([key]) => !['tool','tool_use_id','agentId','requestMeta'].includes(key)));
    if (!input || typeof input !== 'object' || Array.isArray(input)) return toolResult(failure('INVALID_INPUT','Expected an input object.'));
    if (Object.keys(input).some(key => !(["address", "children", "timeoutMs"] as string[]).includes(key))) return toolResult(failure('INVALID_INPUT','Unknown input field.'));
    const client = createClient({transport:adapter($),context});
    if (activeWait) return toolResult(failure('INVALID_INPUT','Another wait is active.'));
    activeWait = true;
    try { return toolResult(await client.wait(input)); } finally { activeWait = false; }
  }).catch(() => (toolResult(failure('HC_ERROR','Tool handler failed.','unknown'))));
  on('tool.call', {tool:'mcp__herdr-orchestrator__worker_read'}, async ($, e) => {
    if (!context.self) return toolResult(failure('NOT_IN_HERDR','No terminal address.'));
    if (e.agentId || context.parent) return toolResult(failure('WRONG_ROLE','Tool is unavailable in this role.'));
    const input = Object.fromEntries(Object.entries(e).filter(([key]) => !['tool','tool_use_id','agentId','requestMeta'].includes(key)));
    if (!input || typeof input !== 'object' || Array.isArray(input)) return toolResult(failure('INVALID_INPUT','Expected an input object.'));
    if (Object.keys(input).some(key => !(["address", "lines"] as string[]).includes(key))) return toolResult(failure('INVALID_INPUT','Unknown input field.'));
    const client = createClient({transport:adapter($),context});
    return toolResult(await client.read(input));
  }).catch(() => (toolResult(failure('HC_ERROR','Tool handler failed.','unknown'))));
  on('tool.call', {tool:'mcp__herdr-orchestrator__worker_stop'}, async ($, e) => {
    if (!context.self) return toolResult(failure('NOT_IN_HERDR','No terminal address.'));
    if (e.agentId || context.parent) return toolResult(failure('WRONG_ROLE','Tool is unavailable in this role.'));
    const input = Object.fromEntries(Object.entries(e).filter(([key]) => !['tool','tool_use_id','agentId','requestMeta'].includes(key)));
    if (!input || typeof input !== 'object' || Array.isArray(input)) return toolResult(failure('INVALID_INPUT','Expected an input object.'));
    if (Object.keys(input).some(key => !(["address", "remove"] as string[]).includes(key))) return toolResult(failure('INVALID_INPUT','Unknown input field.'));
    const permission = await $.tool.check({tool:e.tool,input});
    if (permission.decision !== 'allow') return toolResult(failure(permission.decision === 'ask' ? 'PERMISSION_REQUIRED' : 'PERMISSION_DENIED',permission.reason ?? 'Permission required.'));
    const client = createClient({transport:adapter($),context});
    return toolResult(await client.stop(input));
  }).catch(() => (toolResult(failure('HC_ERROR','Tool handler failed.','unknown'))));
  on('tool.call', {tool:'mcp__herdr-orchestrator__worker_templates'}, async ($, e) => {
    if (!context.self) return toolResult(failure('NOT_IN_HERDR','No terminal address.'));
    if (e.agentId || context.parent) return toolResult(failure('WRONG_ROLE','Tool is unavailable in this role.'));
    const input = Object.fromEntries(Object.entries(e).filter(([key]) => !['tool','tool_use_id','agentId','requestMeta'].includes(key)));
    if (!input || typeof input !== 'object' || Array.isArray(input)) return toolResult(failure('INVALID_INPUT','Expected an input object.'));
    if (Object.keys(input).some(key => !([] as string[]).includes(key))) return toolResult(failure('INVALID_INPUT','Unknown input field.'));
    const client = createClient({transport:adapter($),context});
    return toolResult(await client.templates());
  }).catch(() => (toolResult(failure('HC_ERROR','Tool handler failed.','unknown'))));
};
