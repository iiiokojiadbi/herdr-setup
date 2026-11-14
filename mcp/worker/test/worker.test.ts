import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, chmod, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server';
import { FileJournal } from '../src/journal';
import { createClient } from '../../../core/src/client';
import { journalKey, hash, writeEntry } from '../../../core/src/journal';
import { configure } from '../../../scripts/install-worker-mcp.mjs';
import { parse } from 'smol-toml';
const context = {self:'t1',parent:'t0',sessionId:'terminal-lifetime',cwd:'/tmp'};
const decode = (result: any) => JSON.parse(result.content[0].text);
async function setup(t: any, options: any = {}) {
  const dir = options.dir ?? await mkdtemp(join(tmpdir(),'worker-mcp-'));
  const journal = new FileJournal(join(dir,'journal.json')); await journal.load();
  const calls: any[] = [];
  const server = createServer(options.context ?? context, journal, {run:async (...args) => { calls.push(args); if (options.fail) throw new Error('timeout'); return {exitCode:0,stdout:'{}',stderr:'',isStdoutTruncated:false,isStderrTruncated:false}; }});
  const client = new Client({name:'test',version:'1'}, {capabilities:{}});
  const [a,b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  t.after(async () => {await client.close(); await server.close();});
  return {client,calls,journal,dir};
}
test('SDK initialize, capabilities, flat schemas, delivery, dedup, conflict, validation',async t => {
  const {client,calls,dir} = await setup(t);
  assert.ok(client.getServerCapabilities()?.tools);
  const listed = await client.listTools(); assert.deepEqual(listed.tools.map(tool => tool.name),['report','ask_owner']);
  for (const tool of listed.tools) for (const key of ['oneOf','anyOf','not']) assert.equal(key in tool.inputSchema,false);
  const input = {name:'report',arguments:{text:'private body',requestId:'private-id'}};
  assert.equal(decode(await client.callTool(input)).ok,true);
  assert.equal(decode(await client.callTool(input)).data.duplicate,true);
  assert.equal(decode(await client.callTool({...input,arguments:{...input.arguments,text:'other'}})).error.code,'REQUEST_ID_CONFLICT');
  assert.equal(calls.length,1); assert.equal(calls[0][0].at(-2),'t0');
  assert.equal(decode(await client.callTool({name:'ask_owner',arguments:{text:'question',requestId:'q'}})).ok,true);
  assert.match(calls[1][0].at(-1),/^Question/);
  for (const args of [{text:'x',recipient:'else'},{text:'x'.repeat(32769)},{text:' '},{text:'x',requestId:''},{text:'x',blocker:'yes'}]) assert.equal(decode(await client.callTool({name:'report',arguments:args})).error.code,'INVALID_INPUT');
  await assert.rejects(client.callTool({name:'unknown',arguments:{text:'x'}}));
  const disk = await readFile(join(dir,'journal.json'),'utf8'); assert.ok(!disk.includes('private body')); assert.ok(!disk.includes('private-id'));
  assert.equal((await stat(join(dir,'journal.json'))).mode & 0o777,0o600);
  const restarted = await setup(t,{dir});
  assert.equal(decode(await restarted.client.callTool(input)).data.duplicate,true); assert.equal(restarted.calls.length,0);
});
test('unknown survives restart, pending recovers without resend',async t => {
  const first = await setup(t,{fail:true});
  const input = {name:'report',arguments:{text:'x',requestId:'uncertain'}};
  assert.equal(decode(await first.client.callTool(input)).error.code,'DELIVERY_UNKNOWN');
  const second = await setup(t,{dir:first.dir});
  assert.equal(decode(await second.client.callTool(input)).error.code,'DELIVERY_UNKNOWN'); assert.equal(second.calls.length,0);
  const key = journalKey('t1','terminal-lifetime','t0','abandoned');
  await writeEntry(second.journal,key,{sender:'t1',recipient:'t0',sessionId:'terminal-lifetime',requestId:'abandoned',timestamp:Date.now(),implicit:false,status:'pending',payloadHash:hash('Result:\nx')});
  const third = await setup(t,{dir:first.dir});
  assert.equal(decode(await third.client.callTool({name:'report',arguments:{text:'x',requestId:'abandoned'}})).error.code,'DELIVERY_UNKNOWN'); assert.equal(third.calls.length,0);
});
test('missing environment returns core errors before transport',async t => {
  for (const [ctx,code] of [[{...context,parent:undefined},'NO_PARENT'],[{...context,self:undefined},'NOT_IN_HERDR']] as const) {
    const {client,calls} = await setup(t,{context:ctx}); assert.equal(decode(await client.callTool({name:'report',arguments:{text:'x'}})).error.code,code); assert.equal(calls.length,0);
  }
});
test('config merge is idempotent, keeps foreign values, rejects transport conflicts',() => {
  const source = 'approval_policy = "on-request"\n[other]\nx = 42\n[mcp_servers.other]\nstartup_timeout_sec = 20\n';
  const configured = configure(source,'/a b/launcher.mjs'); assert.equal(configure(configured,'/a b/launcher.mjs'),configured);
  const value: any = parse(configured); assert.equal(value.other.x,42); assert.equal(value.approval_policy,'on-request');
  assert.equal(value.mcp_servers.other.startup_timeout_sec,20); assert.equal(value.mcp_servers['herdr-worker'].tools.report.approval_mode,'approve');
  assert.throws(() => configure('[mcp_servers.herdr-worker]\nurl = "http://example.org"\n'));
});
test('stdio launcher: clean stdout, protocol errors, actual hc failure, EOF and lock',{timeout:10000},async t => {
  const dir = await mkdtemp(join(tmpdir(),'worker-stdio-')); await mkdir(join(dir,'bin'));
  await writeFile(join(dir,'bin/hc'),'#!/bin/sh\necho private-stderr >&2\nexit 1\n'); await chmod(join(dir,'bin/hc'),0o755);
  const env = {...process.env,XDG_STATE_HOME:dir,HC_TERMINAL_ID:'t1',HC_PARENT:'t0',PATH:join(dir,'bin')+':'+process.env.PATH};
  const child = spawn(process.execPath,[resolve('dist/herdr-worker-mcp/launcher.mjs')],{env,stdio:['pipe','pipe','pipe']});
  t.after(() => child.kill());
  let stdout = '', stderr = ''; child.stdout.on('data',chunk => {stdout += chunk;}); child.stderr.on('data',chunk => {stderr += chunk;});
  const pending = new Map<number, (value: any) => void>(); let partial = '';
  child.stdout.on('data',chunk => {partial += chunk; let index; while ((index=partial.indexOf('\n')) >= 0) {const value=JSON.parse(partial.slice(0,index)); partial=partial.slice(index+1); pending.get(value.id)?.(value);}});
  const request = (id:number,method:string,params:any={}) => new Promise<any>(resolve => {pending.set(id,resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  const hello = await request(1,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'wire-test',version:'1'}}); assert.ok(hello.result.capabilities.tools);
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  assert.equal((await request(2,'tools/list')).result.tools.length,2);
  const conflicting = spawn(process.execPath,[resolve('dist/herdr-worker-mcp/launcher.mjs')],{env,stdio:['pipe','pipe','pipe']}); conflicting.stderr.resume(); conflicting.stdout.resume(); assert.notEqual((await once(conflicting,'exit'))[0],0);
  const result = await request(3,'tools/call',{name:'report',arguments:{text:'x',requestId:'fail'}}); assert.equal(decode(result.result).error.code,'DELIVERY_UNKNOWN');
  assert.equal((await request(4,'unknown')).error.code,-32601);
  const exited = once(child,'exit'); child.stdin.end(); assert.equal((await exited)[0],0);
  assert.equal(stderr,''); assert.ok(stdout.trim().split('\n').every(line => JSON.parse(line).jsonrpc === '2.0'));
});

test('file journal refuses protected capacity and corrupt state before delivery',async t => {
  const dir = await mkdtemp(join(tmpdir(),'worker-capacity-'));
  const entry = {sender:'',sessionId:'',recipient:'',requestId:'',payloadHash:'abc',timestamp:Date.now(),implicit:false,status:'pending'};
  // Loading abandoned entries converts them to unknown; live pending entries
  // are populated after startup to exercise the shared reservation path.
  const {client,journal,calls} = await setup(t,{dir});
  for (let index=0;index<500;index++) await writeEntry(journal,journalKey('t1','terminal-lifetime','t0',`pending-${index}`),{...entry,sender:'t1',sessionId:'terminal-lifetime',recipient:'t0',requestId:`pending-${index}`,status:'pending'});
  const result = decode(await client.callTool({name:'report',arguments:{text:'x',requestId:'new'}}));
  assert.equal(result.error.code,'JOURNAL_FULL'); assert.equal(result.error.effect,'none'); assert.equal(calls.length,0);
  const path = join(dir,'corrupt.json'); await writeFile(path,'broken');
  await assert.rejects(new FileJournal(path).load());
});
test('installer CLI dry-run, check, write and repeated write preserve foreign config',async () => {
  const dir = await mkdtemp(join(tmpdir(),'worker-install-')); const path = join(dir,'role.toml');
  const source = 'approval_policy = "on-request"\n[foreign]\nx = 42\n'; await writeFile(path,source);
  const run = (mode:string) => spawnSync(process.execPath,['scripts/install-worker-mcp.mjs',mode,path],{encoding:'utf8'});
  assert.equal(run('--check').status,1); assert.equal(run('--dry-run').status,0); assert.equal(await readFile(path,'utf8'),source);
  assert.equal(run('--write').status,0); const updated = await readFile(path,'utf8');
  assert.equal(run('--check').status,0); assert.equal(run('--write').status,0); assert.equal(await readFile(path,'utf8'),updated);
  assert.equal((parse(updated) as any).foreign.x,42);
});

test('FileJournal capacity counts pending to sent as one entry and preserves oldest retry',async () => {
  const dir = await mkdtemp(join(tmpdir(),'worker-boundary-'));
  const journal = new FileJournal(join(dir,'journal.json')); await journal.load();
  let calls = 0;
  const client = createClient({context,journal,transport:{run:async () => {
    calls++;
    if (calls === 500 || calls === 501) {
      const entries = await journal.entries();
      assert.equal(entries.length,500);
      assert.equal(entries.filter(([,entry]) => entry.status === 'pending').length,1);
    }
    return {exitCode:0,stdout:'{}',stderr:'',isStdoutTruncated:false,isStderrTruncated:false};
  }}});
  for (let index=0;index<500;index++) assert.equal((await client.report({text:'x',requestId:`id${index}`})).ok,true);
  assert.equal((await journal.entries()).length,500);
  assert.ok((await journal.entries()).every(([,entry]) => entry.status === 'sent'));
  // id0 was incorrectly evicted by the old pending-to-sent update at capacity.
  assert.equal((await client.report({text:'x',requestId:'id0'})).data.duplicate,true);
  assert.equal(calls,500);
  assert.equal((await client.report({text:'x',requestId:'id500'})).ok,true);
  assert.equal((await journal.entries()).length,500);
  // Exactly one oldest record may be evicted for the genuinely new ID.
  assert.equal(await journal.get(journalKey('t1','terminal-lifetime','t0','id0')),undefined);
  assert.equal((await client.report({text:'x',requestId:'id1'})).data.duplicate,true);
  assert.equal((await client.report({text:'x',requestId:'id500'})).data.duplicate,true);
  assert.equal(calls,501);
  const restarted = new FileJournal(join(dir,'journal.json')); await restarted.load();
  assert.equal((await restarted.entries()).length,500);
  assert.equal((await restarted.get(journalKey('t1','terminal-lifetime','t0','id1')))?.status,'sent');
});
test('installer rejects even empty address overrides',() => {
  for (const name of ['HC_PARENT','HC_TERMINAL_ID']) {
    assert.throws(() => configure(`[mcp_servers.herdr-worker.env]\n${name} = ""\n`),/Conflicting/);
    assert.throws(() => configure(`[mcp_servers.herdr-worker]\nenv = { ${name} = "" }\n`),/Conflicting/);
  }
});
test('managed installer preserves unrelated TOML bytes including float and int64',() => {
  const source = '# keep this comment\r\nfloat = 1.0 # significant spelling\r\nlarge = 9223372036854775807\r\n[foreign]\r\ntext = """multiline\r\n[not.a.table]\r\n"""\r\n';
  const configured = configure(source,'/launcher');
  assert.ok(configured.startsWith(source));
  assert.equal(configure(configured,'/launcher'),configured);
  const updated = configure(configured,'/new-launcher');
  assert.ok(updated.startsWith(source));
  assert.equal(parse(updated,{integersAsBigInt:'asNeeded'}).large,9223372036854775807n);
  assert.throws(() => configure('[mcp_servers.herdr-worker]\nstartup_timeout_sec = 20\n'),/unmanaged/);
  assert.throws(() => configure(configured+'[another]\nx=1\n'),/last/);
  assert.throws(() => configure(configured.replace('enabled = true','enabled = true\nforeign = 1.0')),/Unowned/);
  const unmanaged = configured.replace('# BEGIN managed herdr-worker MCP\n','').replace('# END managed herdr-worker MCP\n','');
  assert.equal(configure(unmanaged,'/launcher'),unmanaged);
});

test('installer ignores marker examples in strings and comments, then installs and checks',async () => {
  const begin = '# BEGIN managed herdr-worker MCP';
  const end = '# END managed herdr-worker MCP';
  const examples = [
    `developer_instructions = """\nExample:\n${begin}\n${end}\n"""\n`,
    `developer_instructions = '''\r\nExample:\r\n${begin}\r\n${end}\r\n'''\r\n`,
    `# Guide mentions ${begin}\n`,
    `# Guide mentions ${end}\n`,
    `# Guide mentions ${begin}\n# Guide mentions ${end}\n`,
  ];
  const dir = await mkdtemp(join(tmpdir(),'worker-marker-examples-'));
  const path = join(dir,'role.toml');
  const run = (mode:string) => spawnSync(process.execPath,['scripts/install-worker-mcp.mjs',mode,path],{encoding:'utf8'});
  for (const source of examples) {
    const configured = configure(source,'/launcher');
    assert.ok(configured.startsWith(source));
    assert.equal(configure(configured,'/launcher'),configured);
    const changed = configure(configured,'/changed-launcher');
    assert.ok(changed.startsWith(source));
    await writeFile(path,source);
    assert.equal(run('--write').status,0);
    const installed = await readFile(path,'utf8');
    assert.ok(installed.startsWith(source));
    assert.equal(run('--check').status,0);
    assert.equal(run('--write').status,0);
    assert.equal(await readFile(path,'utf8'),installed);
  }
  assert.throws(() => configure(`${begin}\n# missing end\n`),/last/);
  assert.throws(() => configure(`${begin}\n[foreign]\nx=1\n${end}\n`),/Unowned/);
  assert.throws(() => configure(`${begin}\n${begin}\n${end}\n`),/last/);
});
test('installer preserves exact whitespace suffix after END and check accepts it',async () => {
  const dir = await mkdtemp(join(tmpdir(),'worker-marker-suffix-'));
  const path = join(dir,'role.toml');
  const generated = configure('float = 1.0\r\n');
  for (const suffix of ['', '\n', '\r\n', '\n\r\n\r\n', '\r\n \t\r\n\r\n']) {
    const source = generated.slice(0,generated.lastIndexOf('# END managed herdr-worker MCP')) + '# END managed herdr-worker MCP' + suffix;
    assert.equal(configure(source),source);
    assert.ok(configure(source,'/changed-launcher').endsWith('# END managed herdr-worker MCP'+suffix));
    await writeFile(path,source);
    const check = spawnSync(process.execPath,['scripts/install-worker-mcp.mjs','--check',path],{encoding:'utf8'});
    assert.equal(check.status,0,check.stderr);
    const write = spawnSync(process.execPath,['scripts/install-worker-mcp.mjs','--write',path],{encoding:'utf8'});
    assert.equal(write.status,0,write.stderr);
    assert.equal(await readFile(path,'utf8'),source);
  }
});
