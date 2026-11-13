import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/client';
import { argv } from '../src/argv';
import { terminal } from '../src/parse';
import { prune, journalKey, hash, writeEntry, entryBytes, journalBudgetBytes } from '../src/journal';
import { register as ownerRegister } from '../../mods/orchestrator/src/register';
import { register as workerRegister } from '../../mods/worker/src/register';
const context = {self:'t1',cwd:'/repo',sessionId:'session-1'};
const child = {address:'t2',parent:'t1',state:'live',status:{app:'runner',state:'idle'},cwd:'/repo'};
const output = (data: unknown, extra = {}) => ({exitCode:0,stdout:JSON.stringify(data),stderr:'',isStdoutTruncated:false,isStderrTruncated:false,...extra});
function fake(responses: any[], ctx = context, journal?: any) {
  const calls: any[] = [];
  const transport = {run: async (args: string[],options: any) => {
    calls.push({args,options});
    const response = responses.shift();
    if (response instanceof Error) throw response;
    assert.ok(response,'Unexpected subprocess');
    return response;
  }};
  return {client:createClient({transport,context:ctx,journal}),calls};
}
function memory() {
  const map = new Map<string,any>();
  return {map,get:async(key:string)=>map.get(key),set:async(key:string,value:any)=>{map.set(key,value)},delete:async(key:string)=>{map.delete(key)},entries:async()=>[...map.entries()]};
}
test('argv preserves literal multiline text and shell syntax',() => {
  const task = 'line one\n"quoted" $(touch /tmp/forbidden) `date`';
  const args = argv.run({parent:'t1',name:'w',cwd:'/a b',template:'runner',task,labels:{paths:'/x,/y'}});
  assert.equal(args.at(-1),task); assert.ok(!args.includes('sh')); assert.ok(args.includes('/a b'));
  assert.deepEqual(argv.run({parent:'t1',name:'w',cwd:'/repo',command:['cmd','-x','a b']}).slice(-4),['--','cmd','-x','a b']);
  assert.deepEqual(argv.send('t2',task),['send','--json','--','t2',task]);
});
test('status string and object normalize identically',()=>assert.equal(terminal(child).status,terminal({...child,status:'idle'}).status));
test('list filters children and finished records',async()=>{
  const {client}=fake([output({terminals:[child,{...child,address:'t3',parent:'other'},{...child,address:'t4',state:'finished'}]})]);
  const result=await client.list(); assert.equal(result.data.workers.length,1); assert.equal(result.data.workers[0].status,'idle');
});
test('name resolves to ID and text stays one argument',async()=>{
  const {client,calls}=fake([output(child),output({started:true,turn:3})]);
  const result=await client.send({address:'named',text:'a\nb'});
  assert.equal(result.data.address,'t2'); assert.equal(calls[1].args.at(-1),'a\nb'); assert.equal(calls[1].args.at(-2),'t2');
});
test('non-child rejected before mutation',async()=>{
  const {client,calls}=fake([output({...child,parent:'other'})]);
  const result=await client.stop({address:'t2',remove:true});assert.equal(result.error.code,'NOT_CHILD');assert.equal(calls.length,1);
});
test('spawn partial effect returns address without retry',async()=>{
  const {client,calls}=fake([output({...child,first_message:{sent:false,reason:'blocked'}})]);
  const result=await client.spawn({name:'runner-1',template:'runner',task:'hello'});
  assert.equal(result.error.code,'FIRST_MESSAGE_NOT_SENT');assert.equal(result.error.effect,'applied');assert.equal(result.data.address,'t2');assert.equal(calls.length,1);
});
test('command spawn has no first message',async()=>{
  const {client}=fake([output(child)]);const result=await client.spawn({name:'worker-1',command:['runner','x y']});assert.equal(result.ok,true);assert.equal(result.data.firstMessage,undefined);
});
test('missing launch reply is unknown and never retried',async()=>{
  const {client,calls}=fake([new Error('timed out')]); const result=await client.spawn({name:'w',template:'runner',task:'x'});
  assert.equal(result.error.code,'SPAWN_OUTCOME_UNKNOWN'); assert.equal(result.error.effect,'unknown');assert.equal(calls.length,1);
});
test('invalid launch combinations rejected before transport',async()=>{
  for (const input of [{command:['runner'],task:'x'},{template:'runner',task:'x',command:['runner']},{template:'runner'},{command:[]},{command:['runner'],cwd:'/x',worktree:'/y'}]) {
    const {client,calls}=fake([]); assert.equal((await client.spawn(input)).error.code,'INVALID_INPUT');assert.equal(calls.length,0);
  }
});
test('worktree requires Git checkout root',async()=>{
  const {client,calls}=fake([output({}, {stdout:'true\n'}),output({}, {stdout:'subdir/\n'})]);
  assert.equal((await client.spawn({name:'w',command:['runner'],worktree:'/repo/subdir'})).error.code,'INVALID_WORKTREE');assert.equal(calls[0].args[0],'git');assert.equal(calls.length,2);
});
test('default name avoids existing names',async()=>{
  const {client,calls}=fake([output({terminals:[{name:'runner-1'}]}),output({...child,first_message:{sent:true}})]);
  const result=await client.spawn({template:'runner',task:'x'}); assert.equal(result.data.name,'runner-2');assert.equal(calls.length,2);
});
for (const reason of ['timeout','message','future-reason']) test(`wait preserves ${reason}`,async()=>{
  const {client,calls}=fake([output({reason})]);const result=await client.wait({timeoutMs:1001});assert.equal(result.ok,true);assert.equal(result.data.reason,reason);assert.ok(calls[0].args.includes('2'));
});
test('transport timeout differs from wait timeout',async()=>{
  const {client}=fake([new Error('process timeout')]);const result=await client.wait();assert.equal(result.error.code,'PROCESS_TIMEOUT');
});
test('parallel waits refused',async()=>{
  let release:any;const transport={run:()=>new Promise<any>(resolve=>{release=resolve})};const client=createClient({transport,context});
  const pending=client.wait();const result=await client.wait();assert.equal(result.error.code,'INVALID_INPUT');release(output({reason:'timeout'}));await pending;
});
for (const response of [output({}, {stdout:'broken'}),output({}, {isStdoutTruncated:true}),output([])]) test('invalid response rejected',async()=>{
  const {client}=fake([response]);assert.equal((await client.templates()).error.code,'INVALID_RESPONSE');
});
test('stderr retained as details with stable code',async()=>{
  const {client}=fake([output({}, {exitCode:1,stderr:'{"error":{"kind":"internal_new_code","message":"problem"}}'})]);
  const result=await client.list();assert.equal(result.error.code,'HC_ERROR');assert.equal(result.error.details.stderr.error.message,'problem');
});
test('read truncates with explicit marker',async()=>{
  const {client}=fake([output(child),output({text:'x'.repeat(70000),complete:false,how:'screen',why:'working'})]);
  const result=await client.read({address:'t2',lines:0});assert.equal(result.data.text.length,65536);assert.equal(result.data.truncated,true);assert.equal(result.data.complete,false);
});
test('remove failure preserves stopped effect',async()=>{
  const {client,calls}=fake([output(child),output({}),output({}, {exitCode:1,stderr:'cannot remove'})]);
  const result=await client.stop({address:'t2',remove:true});assert.equal(result.error.code,'REMOVE_FAILED');assert.equal(result.error.effect,'applied');assert.equal(result.data.stopped,true);assert.equal(calls.length,3);
});
test('finished terminal removal skips kill',async()=>{
  const {client,calls}=fake([output({...child,state:'finished'}),output({})]);assert.equal((await client.stop({address:'t2',remove:true})).ok,true);assert.equal(calls[1].args[1],'rm');
});
test('report serializes duplicates and detects conflicts',async()=>{
  const journal=memory();const {client,calls}=fake([output({})],{...context,parent:'t0'},journal);
  const [first,second]=await Promise.all([client.report({text:'a\nb',requestId:'r1'}),client.report({text:'a\nb',requestId:'r1'})]);
  assert.equal(first.data.duplicate,false);assert.equal(second.data.duplicate,true);assert.equal(calls.length,1);assert.equal(calls[0].args.at(-1),'Result [r1]:\na\nb');
  assert.equal((await client.report({text:'different',requestId:'r1'})).error.code,'REQUEST_ID_CONFLICT');
});
test('implicit report expires after 60 seconds',async()=>{
  const journal=memory();const {client,calls}=fake([output({}),output({})],{...context,parent:'t0'},journal);
  await client.report({text:'x'});assert.equal((await client.report({text:'x'})).data.duplicate,true);
  for (const entry of journal.map.values()) entry.timestamp-=61000;
  assert.equal((await client.report({text:'x'})).data.duplicate,false);assert.equal(calls.length,2);
});
test('failed report remains unknown across client recreation',async()=>{
  const journal=memory();const first=fake([new Error('timeout')],{...context,parent:'t0'},journal);
  assert.equal((await first.client.askOwner({text:'x',requestId:'r'})).error.code,'DELIVERY_UNKNOWN');
  const second=fake([],{...context,parent:'t0'},journal);assert.equal((await second.client.askOwner({text:'x',requestId:'r'})).error.code,'DELIVERY_UNKNOWN');assert.equal(second.calls.length,0);
});
test('pending report never blindly retries',async()=>{
  const journal=memory();await journal.set(journalKey('t1','session-1','t0','r'),{payloadHash:hash('Result:\nx'),timestamp:Date.now(),status:'pending'});
  const {client,calls}=fake([],{...context,parent:'t0'},journal);assert.equal((await client.report({text:'x',requestId:'r'})).error.code,'DELIVERY_PENDING');assert.equal(calls.length,0);
});
test('journal TTL and record cap',async()=>{
  const journal=memory();for(let i=0;i<502;i++) await journal.set(journalKey('t1','s','t0',String(i)),{timestamp:Date.now()-i});await journal.set('old',{timestamp:0});
  await prune(journal);assert.equal(journal.map.size,500);assert.equal(journal.map.has('old'),false);
});
function harness(register:any,env:Record<string,string>={}, options: any = {}) {
  const hooks=new Map<string,any>();const tools:any[]=[];let subprocesses=0;const checks:any[]=[];const processCalls:any[]=[];
  const on=(event:string,matcher:any,hook?:any)=>{const callback=hook??matcher;hooks.set(event==='tool.call'?matcher.tool:event,callback);return {catch:()=>{}}};
  register(on,{});
  const $={env:{get:async(key:string)=>env[key]},session:{cwd:async()=>'/repo',id:async()=>options.sessionId ?? 'session-1'},tool:{register:async(spec:any)=>{tools.push(spec)},check:async(input:any)=>{checks.push(input);return {decision:options.permission ?? 'ask'}}},store:options.store ?? boundedStore(),process:{run:async(args:any)=>{subprocesses++;processCalls.push(args);return options.responses?.shift() ?? output({})}}};
  return {hooks,tools,$,checks,processCalls,count:()=>subprocesses,start:()=>hooks.get('session.start')($,{},async()=>({}))};
}
test('mods register only the matching role and no tools outside herdr',async()=>{
  for (const register of [ownerRegister,workerRegister]) {const h=harness(register);await h.start();assert.equal(h.tools.length,0)}
  const owner=harness(ownerRegister,{HC_TERMINAL_ID:'t1'});await owner.start();assert.equal(owner.tools.length,7);assert.ok(owner.tools.every(tool=>tool.isDeferred===false));
  const wrong=harness(ownerRegister,{HC_TERMINAL_ID:'t2',HC_PARENT:'t1'});await wrong.start();assert.equal(wrong.tools.length,0);
  const worker=harness(workerRegister,{HC_TERMINAL_ID:'t2',HC_PARENT:'t1'});await worker.start();assert.equal(worker.tools.length,2);
});
test('permission ask and deny prevent subprocess, nested agents refused',async()=>{
  const h=harness(ownerRegister,{HC_TERMINAL_ID:'t1'});await h.start();const hook=h.hooks.get('mcp__herdr-orchestrator__worker_spawn');
  const event={tool:'mcp__herdr-orchestrator__worker_spawn',tool_use_id:'call-1',requestMeta:{},template:'runner',task:'x'};
  assert.equal((await hook(h.$,event)).result.error.code,'PERMISSION_REQUIRED');
  h.$.tool.check=async()=>({decision:'deny'});assert.equal((await hook(h.$,event)).result.error.code,'PERMISSION_DENIED');
  assert.equal((await hook(h.$,{...event,agentId:'nested'})).result.error.code,'WRONG_ROLE');assert.equal(h.count(),0);
});
test('worker tools reject recipient overrides before sending',async()=>{
  const h=harness(workerRegister,{HC_TERMINAL_ID:'t2',HC_PARENT:'t1'});await h.start();
  const result=await h.hooks.get('mcp__herdr-worker__report')(h.$,{tool:'mcp__herdr-worker__report',tool_use_id:'call-2',text:'x',address:'other'});
  assert.equal(result.result.error.code,'INVALID_INPUT');assert.equal(h.count(),0);
});
test('remote ID stays qualified after resolution',async()=>{
  const {client,calls}=fake([output(child),output({text:'screen',complete:true,how:'screen'})]);
  const result=await client.read({address:'remote/t2'});assert.equal(result.data.address,'remote/t2');assert.equal(calls[1].args.at(-1),'remote/t2');
});
test('failed journal commit cannot cause a second send',async()=>{
  const journal=memory();const originalSet=journal.set;let writes=0;
  journal.set=async(key:string,entry:any)=>{writes++;if(writes===2) throw new Error('store write failed');await originalSet(key,entry)};
  const {client,calls}=fake([output({})],{...context,parent:'t0'},journal);
  const first=await client.report({text:'x',requestId:'r'});assert.equal(first.error.code,'DELIVERY_UNKNOWN');
  const second=await client.report({text:'x',requestId:'r'});assert.equal(second.error.code,'DELIVERY_UNKNOWN');assert.equal(calls.length,1);
});
function boundedStore(limit = 4 * 1024 * 1024) {
  const values: Record<string,any> = {};
  let peak = 0;
  return {
    get: async(key:string)=>values[key],
    set: async(key:string,value:any)=>{
      const next = {...values,[key]:value};
      const size = Buffer.byteLength(JSON.stringify(next),'utf8');
      if (size > limit) throw new Error('Store exceeds 4 MiB');
      values[key]=value;peak=Math.max(peak,size);
    },
    delete: async(key:string)=>{delete values[key]},
    keys: async()=>Object.keys(values),
    bytes: ()=>Buffer.byteLength(JSON.stringify(values),'utf8'),
    peak: ()=>peak,
  };
}
function storeJournal(store:any) {
  return {
    get:(key:string)=>store.get('delivery:'+key),
    set:(key:string,entry:any)=>store.set('delivery:'+key,entry),
    delete:(key:string)=>store.delete('delivery:'+key),
    entries:async()=>Promise.all((await store.keys()).filter((key:string)=>key.startsWith('delivery:')).map(async(key:string)=>[key.slice(9),await store.get(key)])),
  };
}
test('all nine hooks accept flat runtime events and check only tool arguments',async()=>{
  const cases = [
    ['worker_spawn',{name:'w',command:['runner']},[output(child)],true],
    ['worker_list',{},[output({terminals:[child]})],false],
    ['worker_send',{address:'t2',text:'a\nb'},[output(child),output({started:true})],true],
    ['worker_wait',{},[output({reason:'timeout'})],false],
    ['worker_read',{address:'t2'},[output(child),output({text:'screen',complete:true,how:'screen'})],false],
    ['worker_stop',{address:'t2'},[output(child),output({})],true],
    ['worker_templates',{},[output({templates:[]})],false],
  ];
  for (const [name,input,responses,mutation] of cases) {
    const h=harness(ownerRegister,{HC_TERMINAL_ID:'t1'},{responses,permission:'allow'});await h.start();
    const tool=`mcp__herdr-orchestrator__${name}`;
    const result=await h.hooks.get(tool)(h.$,{tool,tool_use_id:'call',agentId:undefined,requestMeta:{source:'test'},...input});
    assert.equal(result.result.ok,true,`${name}: ${JSON.stringify(result)}`);
    assert.deepEqual(h.checks,mutation ? [{tool,input}] : []);
  }
  for (const name of ['report','ask_owner']) {
    const h=harness(workerRegister,{HC_TERMINAL_ID:'t2',HC_PARENT:'t1'},{permission:'allow'});await h.start();
    const tool=`mcp__herdr-worker__${name}`;const input={text:'line one\nline two',requestId:'r1'};
    const result=await h.hooks.get(tool)(h.$,{tool,tool_use_id:'call',requestMeta:{},...input});
    assert.equal(result.result.ok,true);assert.deepEqual(h.checks,[{tool,input}]);
    assert.equal(h.processCalls[0].at(-1),`${name==='report'?'Result':'Question'} [r1]:\n${input.text}`);
  }
});
test('many full-size reports fit a store limited to 4 MiB',async()=>{
  const store=boundedStore();const journal=storeJournal(store);
  // Leave most of the plugin store to unrelated plugin state.
  await store.set('other-state','x'.repeat(2800000));
  const transport={run:async()=>output({})};
  const client=createClient({transport,context:{...context,parent:'t0'},journal});
  for(let i=0;i<160;i++) {
    const result=await client.report({text:'я'.repeat(32768),requestId:`report-${i}`});
    assert.equal(result.ok,true,JSON.stringify(result));
  }
  assert.ok(store.peak() < 4*1024*1024);
  for(const [,entry] of await journal.entries()) { assert.equal(entry.payload,undefined);assert.equal(typeof entry.payloadHash,'string'); }
});
test('byte eviction happens before store.set and removes oldest entries',async()=>{
  const store=boundedStore();const journal=storeJournal(store);const now=Date.now();
  const makeEntry=(index:number)=>({sender:'t1',sessionId:'s',recipient:'t0',requestId:String(index),payloadHash:'hash',timestamp:now+index,implicit:false,status:'sent',result:{ok:true,data:{padding:'я'.repeat(100000)}}});
  for(let i=0;i<7;i++) await writeEntry(journal,journalKey('t1','s','t0',String(i)),makeEntry(i));
  const entries=await journal.entries();
  assert.deepEqual(entries.map(([key])=>JSON.parse(key)[3]),['2','3','4','5','6']);
  assert.ok(entries.reduce((sum,[key,entry])=>sum+entryBytes(key,entry),0)<=journalBudgetBytes);
  assert.ok(store.peak()<=journalBudgetBytes);
});
test('new session isolates request IDs, reload preserves sent and unknown entries',async()=>{
  const store=boundedStore();
  const env={HC_TERMINAL_ID:'t2',HC_PARENT:'t1'};
  const invoke=async(sessionId:string,text:string,responses:any[]=[])=>{
    const h=harness(workerRegister,env,{store,sessionId,permission:'allow',responses});await h.start();
    const result=await h.hooks.get('mcp__herdr-worker__report')(h.$,{tool:'mcp__herdr-worker__report',tool_use_id:'call',text,requestId:'same'});
    return {result:result.result,h};
  };
  assert.equal((await invoke('old','first')).result.ok,true);
  const reloaded=await invoke('old','first');assert.equal(reloaded.result.data.duplicate,true);assert.equal(reloaded.h.count(),0);
  const fresh=await invoke('new','second');assert.equal(fresh.result.ok,true);assert.equal(fresh.result.data.duplicate,false);assert.equal(fresh.h.count(),1);
  assert.equal((await invoke('uncertain','x',[output({}, {exitCode:1})])).result.error.code,'DELIVERY_UNKNOWN');
  const unknown=await invoke('uncertain','x');assert.equal(unknown.result.error.code,'DELIVERY_UNKNOWN');assert.equal(unknown.h.count(),0);
});
test('pending delivery surviving reload becomes unknown without resend',async()=>{
  const store=boundedStore();const key=journalKey('t2','session-1','t1','r');
  await store.set('delivery:'+key,{sender:'t2',sessionId:'session-1',recipient:'t1',requestId:'r',payloadHash:hash('Result:\nx'),timestamp:Date.now(),implicit:false,status:'pending'});
  const h=harness(workerRegister,{HC_TERMINAL_ID:'t2',HC_PARENT:'t1'},{store,permission:'allow'});await h.start();
  const result=await h.hooks.get('mcp__herdr-worker__report')(h.$,{tool:'mcp__herdr-worker__report',text:'x',requestId:'r'});
  assert.equal(result.result.error.code,'DELIVERY_UNKNOWN');assert.equal(h.count(),0);
});
test('single command shell syntax rejected; multiple argv elements remain literal',async()=>{
  for(const suffix of ['*','?','~','#','+',' ','\t','\n',';','|','&','$','`','(',')','<','>',"'",'"','\\']) {
    const {client,calls}=fake([]);assert.equal((await client.spawn({name:'w',command:[`runner${suffix}argument`]})).error.code,'INVALID_INPUT');assert.equal(calls.length,0);
  }
  const single=fake([output(child)]);assert.equal((await single.client.spawn({name:'w',command:['/usr/bin/runner']})).ok,true);
  const multiple=fake([output(child)]);const command=['/a path/runner','; $() `text`\n'];
  assert.equal((await multiple.client.spawn({name:'w',command})).ok,true);assert.deepEqual(multiple.calls[0].args.slice(-3),['--',...command]);
});
test('implicit unknown expires after 60 seconds; explicit unknown and pending wait for TTL',async()=>{
  const journal=memory();const {client,calls}=fake([new Error('timeout'),output({})],{...context,parent:'t0'},journal);
  assert.equal((await client.report({text:'x'})).error.code,'DELIVERY_UNKNOWN');
  assert.equal((await client.report({text:'x'})).error.code,'DELIVERY_UNKNOWN');assert.equal(calls.length,1);
  for(const entry of journal.map.values())entry.timestamp-=61000;
  assert.equal((await client.report({text:'x'})).ok,true);assert.equal(calls.length,2);
  for(const status of ['unknown','pending']) {
    const store=memory();const key=journalKey('t1','session-1','t0','r');
    await store.set(key,{sender:'t1',sessionId:'session-1',recipient:'t0',requestId:'r',payloadHash:hash('Result:\nx'),timestamp:Date.now()-61000,implicit:false,status});
    const attempt=fake([output({})],{...context,parent:'t0'},store);
    assert.equal((await attempt.client.report({text:'x',requestId:'r'})).error.code,status==='pending'?'DELIVERY_PENDING':'DELIVERY_UNKNOWN');assert.equal(attempt.calls.length,0);
    store.map.get(key).timestamp-=7*86400000;
    assert.equal((await attempt.client.report({text:'x',requestId:'r'})).ok,true);assert.equal(attempt.calls.length,1);
  }
});
test('a session change without session.start also isolates report keys',async()=>{
  const options={permission:'allow',sessionId:'before-clear'};
  const h=harness(workerRegister,{HC_TERMINAL_ID:'t2',HC_PARENT:'t1'},options);await h.start();
  const event={tool:'mcp__herdr-worker__report',tool_use_id:'call',text:'x',requestId:'r'};
  const hook=h.hooks.get(event.tool);
  assert.equal((await hook(h.$,event)).result.ok,true);
  options.sessionId='after-clear';
  const fresh=await hook(h.$,event);assert.equal(fresh.result.ok,true);assert.equal(fresh.result.data.duplicate,false);assert.equal(h.count(),2);
});
test('journal byte accounting includes UTF-8, escapes and store keys',()=>{
  const key='key"\nя😀';const entry:any={payloadHash:'hash',timestamp:1,result:{data:{text:'я😀\ud800\n"'}}};
  assert.equal(entryBytes(key,entry),Buffer.byteLength(JSON.stringify({['delivery:'+key]:entry}),'utf8'));
});
function deliveryEntry(requestId:string, overrides:any={}) {
  return {sender:'foreign',sessionId:'foreign-session',recipient:'owner',requestId,payloadHash:'hash',timestamp:Date.now(),implicit:false,status:'sent',...overrides};
}
test('another worker cannot evict the oldest active pending among 499 sent entries',async()=>{
  const journal=memory();const now=Date.now();
  for(let i=0;i<499;i++) journal.map.set(journalKey('foreign','foreign-session','owner',String(i)),deliveryEntry(String(i),{timestamp:now-5000+i}));
  let started:any,finish:any;
  const entered=new Promise<void>(resolve=>{started=resolve});
  const first=createClient({context:{...context,parent:'owner'},journal,transport:{run:async()=>{started();return new Promise(resolve=>{finish=resolve})}}});
  const ongoing=first.report({text:'first',requestId:'active'});await entered;
  const activeKey=journalKey('t1','session-1','owner','active');
  journal.map.get(activeKey).timestamp=now-6000;
  const second=fake([output({})],{...context,self:'other-worker',parent:'owner'},journal);
  assert.equal((await second.client.report({text:'second',requestId:'new'})).ok,true);
  assert.equal(journal.map.get(activeKey).status,'pending');assert.equal(journal.map.size,500);
  assert.equal(journal.map.has(journalKey('foreign','foreign-session','owner','0')),false);
  finish(output({}));assert.equal((await ongoing).ok,true);
});
test('a journal full of protected pending refuses a new delivery before send',async()=>{
  for(const limit of ['count','bytes']) {
    const journal=memory();const count=limit==='count'?500:2;
    for(let i=0;i<count;i++) journal.map.set(journalKey('foreign','foreign-session','owner',String(i)),deliveryEntry(String(i),{status:'pending',...(limit==='bytes'?{result:{ok:true,data:{padding:'x'.repeat(530000)}}}:{})}));
    const {client,calls}=fake([],{...context,parent:'owner'},journal);
    const result=await client.report({text:'new',requestId:'new'});
    assert.equal(result.ok,false);assert.equal(result.error.code,'JOURNAL_FULL');assert.equal(result.error.effect,'none');assert.match(result.error.hint,/active deliveries/);
    assert.equal(calls.length,0);assert.equal(journal.map.size,count);
    assert.ok([...journal.map.values()].every(entry=>entry.status==='pending'));
  }
});
test('pending older than ten minutes can be evicted',async()=>{
  const journal=memory();const now=Date.now();
  for(let i=0;i<500;i++) journal.map.set(journalKey('foreign','foreign-session','owner',String(i)),deliveryEntry(String(i),{status:'pending',timestamp:now-600001+i}));
  const {client}=fake([output({})],{...context,parent:'owner'},journal);
  assert.equal((await client.report({text:'new',requestId:'new'})).ok,true);
  assert.equal(journal.map.has(journalKey('foreign','foreign-session','owner','0')),false);
});
test('startup leaves foreign pending protected and cleans old keys in every status',async()=>{
  const store=boundedStore();const activeKey=journalKey('foreign','other-session','owner','active');
  await store.set('delivery:'+activeKey,deliveryEntry('active',{status:'pending'}));
  for(const status of ['sent','pending','unknown']) await store.set('delivery:'+JSON.stringify(['old-worker','owner',status]),{sender:'old-worker',recipient:'owner',requestId:status,payload:'old full text',timestamp:Date.now(),status});
  const h=harness(workerRegister,{HC_TERMINAL_ID:'t2',HC_PARENT:'t1'},{store,permission:'allow'});await h.start();
  assert.deepEqual(await store.keys(),['delivery:'+activeKey]);assert.equal((await store.get('delivery:'+activeKey)).status,'pending');assert.equal(h.count(),0);assert.equal(h.tools.length,2);
});
test('prune removes legacy sent, pending and unknown keys without a session',async()=>{
  const journal=memory();
  for(const status of ['sent','pending','unknown']) journal.map.set(JSON.stringify(['old-worker','owner',status]),{payload:'legacy',timestamp:Date.now(),status});
  await prune(journal);assert.equal(journal.map.size,0);
});
test('single command rejects expansion, comments and nonmatching executables',async()=>{
  for(const value of ['runner*','runner?','~','#comment','runner+suffix','команда','runner\n','runner\r','runner\r\n']) {
    const {client,calls}=fake([]);assert.equal((await client.spawn({name:'w',command:[value]})).error.code,'INVALID_INPUT');assert.equal(calls.length,0);
  }
  for(const value of ['runner','./runner','/usr/bin/runner','runner_1.2-3']) {
    const {client}=fake([output(child)]);assert.equal((await client.spawn({name:'w',command:[value]})).ok,true);
  }
});
