import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
await import('./build.mjs');
await build({entryPoints:['core/test/client.test.ts'],outfile:'.test-build/client.test.mjs',bundle:true,format:'esm',platform:'node',target:'es2022'});
await build({entryPoints:['mcp/worker/test/worker.test.ts'],outfile:'.test-build/worker.test.mjs',bundle:true,packages:'external',format:'esm',platform:'node',target:'node22'});
const result = spawnSync(process.execPath,['--test','.test-build/client.test.mjs','.test-build/worker.test.mjs'],{stdio:'inherit'});
process.exit(result.status ?? 1);
