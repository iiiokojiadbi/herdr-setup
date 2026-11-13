import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
await build({entryPoints:['core/test/client.test.ts'],outfile:'.test-build/client.test.mjs',bundle:true,format:'esm',platform:'node',target:'es2022'});
const result = spawnSync(process.execPath,['--test','.test-build/client.test.mjs'],{stdio:'inherit'});
process.exit(result.status ?? 1);
