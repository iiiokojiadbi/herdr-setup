import { build } from 'esbuild';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
for (const role of ['orchestrator','worker']) {
  const output = `dist/herdr-${role}`;
  await mkdir(`${output}/.claude-plugin`,{recursive:true});
  await mkdir(`${output}/hooks`,{recursive:true});
  const result = await build({metafile:true,entryPoints:[`mods/${role}/src/register.ts`],outfile:`${output}/hooks/register.js`,bundle:true,format:'esm',platform:'neutral',target:'es2022',minify:false});
  if (Object.values(result.metafile.outputs).some(file => file.imports.length)) throw new Error('Unexpected runtime import in bundle.');
  const modulePath = `${output}/hooks/register.js`;
  const bundle = await readFile(modulePath,'utf8');
  if (!bundle.includes('var register =') && !bundle.includes('const register =')) throw new Error('Missing register binding.');
  // The runtime scanner requires a top-level const for the register binding.
  await writeFile(modulePath,bundle.replace('var register =', 'const register ='));
  for (const name of ['.claude-plugin/plugin.json','hooks/hooks.json']) await copyFile(`mods/${role}/${name}`,`${output}/${name}`);
}
