import { argv } from './argv';
import { parse, terminal, firstMessage } from './parse';
import { Fault, failure, success, type Data, type Effect, type Envelope } from './errors';
import { hash, journalKey, writeEntry, type Journal, type Entry } from './journal';
import type { Transport } from './transport';
export interface Context { sessionId: string; self?: string; parent?: string; cwd: string; hcExecutable?: string }
export function text(value: unknown, label: string, max = 32768): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Fault('INVALID_INPUT',`Invalid ${label}.`);
}
function integer(value: unknown, min: number, max: number): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new Fault('INVALID_INPUT','Integer outside allowed range.');
}
const finished = (state: string) => ['finished','exited','dead'].includes(state);
const SPAWN_HINT = 'Continue independent work. Worker reports, questions and emergency events arrive as separate hc input; call worker_list for a snapshot. done or idle do not prove success.';
const SEND_HINT = 'Continue independent work. The report arrives as separate hc input; call worker_list to verify state. done or idle do not prove success.';
export function createClient({ transport, context, journal }: {transport: Transport; context: Context; journal?: Journal}) {
  let queue: Promise<unknown> = Promise.resolve();
  let waiting = false;
  async function run(args: string[], effect: Effect = 'none', timeoutMs = 30000, executable = context.hcExecutable ?? 'hc', cwd = context.cwd) {
    try { return parse(await transport.run([executable,...args],{cwd,timeoutMs}),effect); }
    catch (error) {
      if (error instanceof Fault) throw error;
      const message = String(error);
      throw new Fault(/timeout|timed out/i.test(message) ? 'PROCESS_TIMEOUT' : /ENOENT|not found/i.test(message) ? 'HC_UNAVAILABLE' : 'HC_ERROR',message,undefined,effect);
    }
  }
  async function child(address: unknown) {
    text(address,'address',256);
    const item = terminal(await run(argv.get(address)));
    // Preserve the machine qualifier even if a remote response uses its local ID.
    if (address.includes('/') && !item.address.includes('/')) item.address = `${address.slice(0,address.lastIndexOf('/'))}/${item.address}`;
    if (item.parent !== context.self) throw new Fault('NOT_CHILD','Terminal belongs to another parent.');
    return item;
  }
  async function guarded(role: 'owner' | 'worker', action: () => Promise<Envelope>): Promise<Envelope> {
    try {
      if (!context.self) throw new Fault('NOT_IN_HERDR','No terminal address.');
      if (role === 'owner' && context.parent) throw new Fault('WRONG_ROLE','Worker cannot manage terminals.');
      if (role === 'worker' && !context.parent) throw new Fault('NO_PARENT','No parent address.');
      return await action();
    } catch (error) {
      return error instanceof Fault ? failure(error.code,error.message,error.effect,error.data,error.details,error.code === 'JOURNAL_FULL' ? 'Wait for active deliveries to finish, then retry with the same requestId.' : undefined) : failure('HC_ERROR',String(error),'unknown');
    }
  }
  async function deliver(input: Data, kind: string): Promise<Envelope> {
    return guarded('worker',async () => {
      text(input.text,'text');
      if (input.requestId !== undefined) text(input.requestId,'requestId',128);
      if (input.blocker !== undefined && typeof input.blocker !== 'boolean') throw new Fault('INVALID_INPUT','Invalid blocker.');
      if (!journal) throw new Fault('HC_ERROR','Delivery journal unavailable.');
      const implicit = input.requestId === undefined;
      const payloadHash = hash(`${kind}:\n${input.text}`);
      const requestId = input.requestId ?? payloadHash;
      const key = journalKey(context.self!,context.sessionId,context.parent!,requestId);
      const now = Date.now();
      const old = await journal.get(key);
      if (old && now-old.timestamp < (implicit ? 60000 : 7*86400000)) {
        if (old.payloadHash !== payloadHash) return failure('REQUEST_ID_CONFLICT','requestId already has another payload.');
        if (old.status === 'sent' && old.result) return { ...old.result, data: { ...old.result.data, duplicate: true } };
        return failure(old.status === 'pending' ? 'DELIVERY_PENDING' : 'DELIVERY_UNKNOWN','Previous delivery outcome is unknown.','unknown',{address:context.parent,requestId,duplicate:true});
      }
      const entry: Entry = {sender:context.self!,sessionId:context.sessionId,recipient:context.parent!,requestId,payloadHash,timestamp:now,implicit,status:'pending'};
      await writeEntry(journal,key,entry);
      const data = {address:context.parent,delivery:'sent',requestId,duplicate:false};
      try {
        await run(argv.send(context.parent!,`${kind} [${requestId}]:\n${input.text}`),'unknown');
        const result = success(data);
        await writeEntry(journal,key,{...entry,status:'sent',result});
        return result;
      } catch (error) {
        try { await writeEntry(journal,key,{...entry,status:'unknown'}); } catch {}
        return failure('DELIVERY_UNKNOWN','Parent delivery outcome is unknown.','unknown',{...data,delivery:'unknown'},error instanceof Fault ? error.details ?? error.message : String(error));
      }
    });
  }
  function serialized(action: () => Promise<Envelope>): Promise<Envelope> {
    const next = queue.then(action,action); queue = next.catch(() => undefined); return next;
  }
  return {
    spawn: (input: Data = {}) => guarded('owner',async () => {
      const byTemplate = input.template !== undefined;
      if (byTemplate) { text(input.template,'template',256); text(input.task,'task'); if (input.template.startsWith('-') || input.command !== undefined) throw new Fault('INVALID_INPUT','Invalid launch mode.'); }
      else if (!Array.isArray(input.command) || !input.command.length || input.task !== undefined) throw new Fault('INVALID_INPUT','Provide template and task or command argv.');
      if (!byTemplate) {
        for (const arg of input.command) text(arg,'command argument');
        if (input.command.length === 1 && /^[A-Za-z0-9._/-]+$/.exec(input.command[0])?.[0] !== input.command[0]) throw new Fault('INVALID_INPUT','A single command element must match ^[A-Za-z0-9._/-]+$.');
      }
      if (input.cwd !== undefined && input.worktree !== undefined) throw new Fault('INVALID_INPUT','cwd and worktree are exclusive.');
      const cwd = input.worktree ?? input.cwd ?? context.cwd;
      text(cwd,'cwd'); if (!cwd.startsWith('/')) throw new Fault('INVALID_INPUT','cwd must be absolute.');
      if (input.worktree !== undefined) {
        try {
          const response = await transport.run(['git','-C',cwd,'rev-parse','--is-inside-work-tree'],{cwd:context.cwd,timeoutMs:10000});
          if (response.exitCode !== 0 || response.isStdoutTruncated || response.stdout.trim() !== 'true') throw new Error();
          const root = await transport.run(['git','-C',cwd,'rev-parse','--show-prefix'],{cwd:context.cwd,timeoutMs:10000});
          if (root.exitCode !== 0 || root.stdout.trim() !== '') throw new Error();
        } catch { throw new Fault('INVALID_WORKTREE','Expected an existing checkout root.'); }
      }
      const labels = input.labels ?? {};
      if (!labels || Array.isArray(labels) || typeof labels !== 'object') throw new Fault('INVALID_INPUT','Invalid labels.');
      for (const [key,value] of Object.entries(labels)) { text(key,'label key'); if (key.includes('=') || key.startsWith('herdr.')) throw new Fault('INVALID_INPUT','Reserved or invalid label.'); if (typeof value !== 'string' || value.includes('\0')) throw new Fault('INVALID_INPUT','Invalid label value.'); }
      let name = input.name;
      if (name === undefined) {
        const listing = await run(argv.ls());
        if (!Array.isArray(listing.terminals)) throw new Fault('INVALID_RESPONSE','Missing terminals.');
        const base = byTemplate && /^[a-z0-9_-]{1,24}$/.test(input.template) ? input.template : 'worker';
        let index = 1; while (listing.terminals.some((item: Data) => item.name === `${base}-${index}`)) index++;
        name = `${base}-${index}`;
      }
      if (typeof name !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(name)) throw new Fault('INVALID_INPUT','Invalid name.');
      let value: Data;
      try { value = await run(argv.run({parent:context.self!,name,cwd,labels,template:input.template,task:input.task,command:input.command}),'unknown',210000); }
      catch (error) {
        if (error instanceof Fault && ['NAME_IN_USE','TEMPLATE_NOT_FOUND'].includes(error.code)) throw new Fault(error.code,error.message,error.details,'none');
        return failure('SPAWN_OUTCOME_UNKNOWN','Spawn outcome is unknown.','unknown',{name},error instanceof Fault ? error.details ?? error.message : String(error));
      }
      if (typeof value.address !== 'string') return failure('SPAWN_OUTCOME_UNKNOWN','Missing spawned address.','unknown',{name});
      let first;
      try { first = firstMessage(value); } catch { return failure('INVALID_RESPONSE','Invalid first message result.','applied',{address:value.address,name}); }
      const data = {...value,name,cwd,parent:context.self,...(first ? {firstMessage:first} : {})};
      if (byTemplate && !first) return failure('INVALID_RESPONSE','Missing first_message.','applied',data);
      if (first?.sent === false) return failure('FIRST_MESSAGE_NOT_SENT','Worker created; first task was not sent.','applied',data,undefined,'Read the worker before sending its task.');
      return success({...data,hint:SPAWN_HINT});
    }),
    list: (input: Data = {}) => guarded('owner',async () => {
      const includeFinished = input.includeFinished ?? false;
      if (typeof includeFinished !== 'boolean') throw new Fault('INVALID_INPUT','Invalid includeFinished.');
      if (input.address !== undefined) {
        const item = await child(input.address);
        if (!includeFinished && finished(item.state)) return failure('FINISHED','Worker has finished.','none',{address:item.address,state:item.state},undefined,'Call worker_list with includeFinished: true for a final snapshot.');
        return success({worker:item});
      }
      const value = await run(argv.ls(includeFinished));
      if (!Array.isArray(value.terminals)) throw new Fault('INVALID_RESPONSE','Missing terminals.');
      return success({workers:value.terminals.filter((item: Data) => item.parent === context.self && (includeFinished || !finished(item.state))).map(terminal)});
    }),
    send: (input: Data) => guarded('owner',async () => {
      text(input.text,'text'); const item = await child(input.address);
      if (item.status === 'blocked') return failure('BLOCKED','Worker is blocked.');
      if (finished(item.state)) return failure('FINISHED','Worker has finished.');
      try { const value = await run(argv.send(item.address,input.text),'unknown'); return success({address:item.address,delivery:'sent',observation:value,hint:SEND_HINT}); }
      catch (error) { return failure('DELIVERY_UNKNOWN','Delivery outcome is unknown.','unknown',{address:item.address},error instanceof Fault ? error.details ?? error.message : String(error)); }
    }),
    wait: (input: Data = {}) => guarded('owner',async () => {
      if (input.address !== undefined && input.children !== undefined) throw new Fault('INVALID_INPUT','Choose address or children.');
      const timeoutMs = input.timeoutMs ?? 180000; integer(timeoutMs,1000,540000);
      if (input.children !== undefined && !['any','all'].includes(input.children)) throw new Fault('INVALID_INPUT','Invalid children scope.');
      const scope = input.address !== undefined ? {address:(await child(input.address)).address} : {children:input.children ?? 'any'};
      if (waiting) throw new Fault('INVALID_INPUT','Another wait is active.');
      waiting = true;
      try { const value = await run(argv.wait(scope,timeoutMs),'none',timeoutMs+30000); if (typeof value.reason !== 'string') throw new Fault('INVALID_RESPONSE','Missing wait reason.'); return success({...value,scope,observation:value.observation ?? {...value,...(value.status !== undefined ? {status:typeof value.status === 'string' ? value.status : value.status?.state ?? null} : {})},hint:value.reason === 'message' ? 'A message arrived as separate input. Continue your current work; call worker_list for a snapshot instead of waiting again.' : 'No news is a normal check-in. Continue independent work; call worker_list for a snapshot instead of waiting again.'}); }
      finally { waiting = false; }
    }),
    read: (input: Data) => guarded('owner',async () => {
      const lines = input.lines ?? 100; integer(lines,0,1000); const item = await child(input.address);
      const value = await run(argv.read(item.address,lines));
      if (typeof value.text !== 'string') throw new Fault('INVALID_RESPONSE','Missing read text.');
      return success({...value,address:item.address,text:value.text.slice(0,65536),truncated:!!value.truncated || value.text.length > 65536});
    }),
    stop: (input: Data) => guarded('owner',async () => {
      if (input.remove !== undefined && typeof input.remove !== 'boolean') throw new Fault('INVALID_INPUT','Invalid remove.');
      const item = await child(input.address);
      if (!finished(item.state)) {
        try { await run(argv.kill(item.address),'unknown'); }
        catch (error) { return failure('STOP_FAILED','Stop outcome is unknown.','unknown',{address:item.address},error instanceof Fault ? error.details ?? error.message : String(error)); }
      }
      const data = {address:item.address,stopped:true,removed:false};
      if (input.remove) {
        try { await run(argv.rm(item.address),'unknown'); data.removed = true; }
        catch (error) { return failure('REMOVE_FAILED','Worker stopped; removal failed.','applied',data,error instanceof Fault ? error.details ?? error.message : String(error)); }
      }
      return success(data);
    }),
    templates: () => guarded('owner',async () => { const value = await run(argv.templates()); if (!Array.isArray(value.templates)) throw new Fault('INVALID_RESPONSE','Missing templates.'); return success({templates:value.templates}); }),
    report: (input: Data) => serialized(() => deliver(input,input.blocker ? 'Blocker' : 'Result')),
    askOwner: (input: Data) => serialized(() => deliver(input,'Question')),
  };
}
