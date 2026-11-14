import { mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { stateDirectory } from './state';

try {
  process.umask(0o077);
  const directory = stateDirectory();
  await mkdir(directory,{recursive:true,mode:0o700});
  await chmod(directory,0o700);
  const identity = createHash('sha256').update(JSON.stringify([process.env.HC_TERMINAL_ID,process.env.HC_PARENT])).digest('hex');
  const journal = join(directory,`${identity}.json`);
  // --no-fork keeps the lock owned by the server, including after launcher death.
  const child = spawn('flock',['--exclusive','--nonblock','--no-fork',`${journal}.lock`,process.execPath,fileURLToPath(new URL('./server.mjs',import.meta.url)),journal],{stdio:'inherit'});
  for (const signal of ['SIGTERM','SIGINT'] as const) process.on(signal,() => child.kill(signal));
  child.once('error',() => { console.error('Cannot start MCP server: flock unavailable.'); process.exitCode = 1; });
  child.once('exit',code => { if (code) console.error('MCP server failed or journal is locked.'); process.exitCode = code ?? 1; });
} catch { console.error('Cannot initialize MCP state directory.'); process.exitCode = 1; }
