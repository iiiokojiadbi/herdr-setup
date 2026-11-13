import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../',import.meta.url));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
console.log(`После сборки выполните вручную:\nclaude plugin marketplace add ${quote(root)}`);
for (const role of ['orchestrator','worker']) {
  console.log(`claude plugin install herdr-${role}@herdr-setup --scope user`);
  console.log(`claude plugin enable herdr-${role}@herdr-setup --scope user`);
}
console.log('\nДобавьте в пользовательские permissions.allow:\n'+JSON.stringify(['mcp__herdr-orchestrator__*','mcp__herdr-worker__*'],null,2));
console.log('Затем /reload-plugins в открытых сессиях. Скрипт только печатает инструкции.');
