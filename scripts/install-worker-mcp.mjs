#!/usr/bin/env node
import { parse, stringify } from 'smol-toml';
import { readFile, open, rename, unlink, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const launcher = fileURLToPath(new URL('../dist/herdr-worker-mcp/launcher.mjs',import.meta.url));
export function configure(source, command = launcher) {
  const config = parse(source);
  config.mcp_servers ??= {};
  const server = config.mcp_servers['herdr-worker'] ??= {};
  // Preserve unowned keys, but refuse incompatible transport/delivery overrides.
  if (server.url || server.args?.length || server.env?.HC_PARENT || server.env?.HC_TERMINAL_ID || server.disabled_tools?.some(name => ['report','ask_owner'].includes(name))) throw new Error('Conflicting herdr-worker configuration; resolve manually.');
  Object.assign(server,{command,env_vars:[...new Set([...(server.env_vars ?? []),'HC_TERMINAL_ID','HC_PARENT'])],enabled:true,enabled_tools:['report','ask_owner']});
  server.tools ??= {};
  for (const name of ['report','ask_owner']) {
    server.tools[name] ??= {};
    server.tools[name].approval_mode = 'approve';
  }
  return stringify(config);
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
    else if (mode === '--check') process.exitCode = JSON.stringify(parse(original)) === JSON.stringify(parse(updated)) ? 0 : 1;
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
