import { mkdir, copyFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const target = 'node_modules/.cache/mod-api.d.ts';
if (process.env.MOD_API_TYPES) {
  await mkdir('node_modules/.cache',{recursive:true});
  await copyFile(process.env.MOD_API_TYPES,target);
}
try { await access(target); } catch {
  console.error('Set MOD_API_TYPES to the runtime API declaration file for the installed release.');
  process.exit(1);
}
const result = spawnSync('node',['node_modules/typescript/bin/tsc','-p','tsconfig.json'],{stdio:'inherit'});
process.exit(result.status ?? 1);
