import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/client';
import { argv } from '../src/argv';
import { terminal } from '../src/parse';
import { prune, journalKey } from '../src/journal';
import { register as ownerRegister } from '../../mods/orchestrator/src/register';
import { register as workerRegister } from '../../mods/worker/src/register';
const context = {self:'t1',cwd:'/repo'};
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
  const journal=memory();await journal.set(journalKey('t1','t0','r'),{payload:'Result:\nx',timestamp:Date.now(),status:'pending'});
  const {client,calls}=fake([],{...context,parent:'t0'},journal);assert.equal((await client.report({text:'x',requestId:'r'})).error.code,'DELIVERY_PENDING');assert.equal(calls.length,0);
});
test('journal TTL and record cap',async()=>{
  const journal=memory();for(let i=0;i<502;i++) await journal.set(String(i),{timestamp:Date.now()-i});await journal.set('old',{timestamp:0});
  await prune(journal);assert.equal(journal.map.size,500);assert.equal(journal.map.has('old'),false);
});
function harness(register:any,env:Record<string,string>={}) {
  const hooks=new Map<string,any>();const tools:any[]=[];let subprocesses=0;
  const on=(event:string,matcher:any,hook?:any)=>{const callback=hook??matcher;hooks.set(event==='tool.call'?matcher.tool:event,callback);return {catch:()=>{}}};
  register(on,{});
  const $={env:{get:async(key:string)=>env[key]},session:{cwd:async()=>'/repo'},tool:{register:async(spec:any)=>{tools.push(spec)},check:async()=>({decision:'ask'})},store:{keys:async()=>[]},process:{run:async()=>{subprocesses++;return output({})}}};
  return {hooks,tools,$,count:()=>subprocesses,start:()=>hooks.get('session.start')($,{},async()=>({}))};
}
test('mods register only the matching role and no tools outside herdr',async()=>{
  for (const register of [ownerRegister,workerRegister]) {const h=harness(register);await h.start();assert.equal(h.tools.length,0)}
  const owner=harness(ownerRegister,{HC_TERMINAL_ID:'t1'});await owner.start();assert.equal(owner.tools.length,7);assert.ok(owner.tools.every(tool=>tool.isDeferred===false));
  const wrong=harness(ownerRegister,{HC_TERMINAL_ID:'t2',HC_PARENT:'t1'});await wrong.start();assert.equal(wrong.tools.length,0);
  const worker=harness(workerRegister,{HC_TERMINAL_ID:'t2',HC_PARENT:'t1'});await worker.start();assert.equal(worker.tools.length,2);
});
test('permission ask and deny prevent subprocess, nested agents refused',async()=>{
  const h=harness(ownerRegister,{HC_TERMINAL_ID:'t1'});await h.start();const hook=h.hooks.get('mcp__herdr-orchestrator__worker_spawn');
  const event={tool:'mcp__herdr-orchestrator__worker_spawn',input:{template:'runner',task:'x'}};
  assert.equal((await hook(h.$,event)).result.error.code,'PERMISSION_REQUIRED');
  h.$.tool.check=async()=>({decision:'deny'});assert.equal((await hook(h.$,event)).result.error.code,'PERMISSION_DENIED');
  assert.equal((await hook(h.$,{...event,agentId:'nested'})).result.error.code,'WRONG_ROLE');assert.equal(h.count(),0);
});
test('worker tools reject recipient overrides before sending',async()=>{
  const h=harness(workerRegister,{HC_TERMINAL_ID:'t2',HC_PARENT:'t1'});await h.start();
  const result=await h.hooks.get('mcp__herdr-worker__report')(h.$,{tool:'mcp__herdr-worker__report',input:{text:'x',address:'other'}});
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
