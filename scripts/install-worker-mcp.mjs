#!/usr/bin/env node
import { parse, stringify } from 'smol-toml';
import { readFile, open, rename, unlink, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const launcher = fileURLToPath(new URL('../dist/herdr-worker-mcp/launcher.mjs',import.meta.url));
const begin = '# BEGIN managed herdr-worker MCP';
const end = '# END managed herdr-worker MCP';
const parseConfig = source => parse(source,{integersAsBigInt:'asNeeded'});
function checkConflicts(server) {
  if (server.url || server.args?.length || Object.hasOwn(server.env ?? {},'HC_PARENT') || Object.hasOwn(server.env ?? {},'HC_TERMINAL_ID') || server.disabled_tools?.some(name => ['report','ask_owner'].includes(name))) throw new Error('Conflicting herdr-worker configuration; resolve manually.');
}
export function configure(source, command = launcher) {
  const config = parseConfig(source);
  const server = config.mcp_servers?.['herdr-worker'];
  if (server) checkConflicts(server);
  const desired = {command,env_vars:['HC_TERMINAL_ID','HC_PARENT'],enabled:true,enabled_tools:['report','ask_owner'],tools:{report:{approval_mode:'approve'},ask_owner:{approval_mode:'approve'}}};
  let prefix = source;
  const start = source.indexOf(begin);
  if (start !== -1) {
    // Validate the prefix separately: a marker inside a multiline string cannot
    // become an edit boundary. Only a standalone trailing block is owned here.
    if (start > 0 && source[start-1] !== '\n' || source.indexOf(begin,start+begin.length) !== -1 || !source.slice(start).trimEnd().endsWith(end)) throw new Error('Managed MCP block must be standalone and last in the file.');
    prefix = source.slice(0,start);
    if (parseConfig(prefix).mcp_servers?.['herdr-worker']) throw new Error('herdr-worker is also configured outside the managed block.');
    const block = parseConfig(source.slice(start));
    const owned = block.mcp_servers?.['herdr-worker'];
    if (!owned || Object.keys(block).some(key => key !== 'mcp_servers') || Object.keys(block.mcp_servers).some(key => key !== 'herdr-worker') || Object.keys(owned).some(key => !Object.hasOwn(desired,key)) || Object.keys(owned.tools ?? {}).some(key => !['report','ask_owner'].includes(key)) || Object.values(owned.tools ?? {}).some(tool => Object.keys(tool).some(key => key !== 'approval_mode'))) throw new Error('Unowned settings in managed MCP block; move them outside before updating.');
  } else if (server) {
    // Leave an already compatible unmanaged table byte-for-byte intact.
    const compatible = server.command === command && server.enabled === true && desired.env_vars.every(name => server.env_vars?.includes(name)) && server.enabled_tools?.length === 2 && desired.enabled_tools.every(name => server.enabled_tools.includes(name)) && desired.enabled_tools.every(name => server.tools?.[name]?.approval_mode === 'approve');
    if (compatible) return source;
    throw new Error('Existing unmanaged herdr-worker table: migrate it to the generated managed block before installation. No file was changed.');
  }
  if (prefix && !prefix.endsWith('\n')) prefix += '\n';
  const updated = prefix + begin + '\n' + stringify({mcp_servers:{'herdr-worker':desired}}) + end + '\n';
  parseConfig(updated);
  return updated;
}

if (process.argv[1]?.endsWith('/install-worker-mcp.mjs') && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const mode = args.find(arg => ['--check','--dry-run','--write'].includes(arg));
    const path = args.find(arg => !arg.startsWith('--'));
    if (!mode || args.some(arg => arg.startsWith('--') && !['--check','--dry-run','--write'].includes(arg)) || args.length !== (path ? 2 : 1)) throw new Error('Usage: node scripts/install-worker-mcp.mjs --dry-run [profile] | --check profile | --write profile');
    if (!path && mode !== '--dry-run') throw new Error('Profile path required.');
    const original = path ? await readFile(path,'utf8') : '';
    const updated = configure(original);
    if (mode === '--dry-run') process.stdout.write(updated);
    else if (mode === '--check') process.exitCode = original === updated ? 0 : 1;
    else if (original !== updated) {
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary,'wx',(await stat(path)).mode & 0o777);
        try { await file.writeFile(updated); await file.sync(); } finally { await file.close(); }
        if (await readFile(path,'utf8') !== original) throw new Error('Profile changed during installation.');
        await rename(temporary,path);
        const directory = await open(dirname(resolve(path)),'r');
        try { await directory.sync(); } finally { await directory.close(); }
      } finally { await unlink(temporary).catch(() => {}); }
    }
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
