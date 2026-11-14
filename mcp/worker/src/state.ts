import { homedir } from 'node:os';
import { join } from 'node:path';

export function stateDirectory(environment: NodeJS.ProcessEnv = process.env) {
  return join(environment.XDG_STATE_HOME || join(homedir(),'.local/state'),'herdr-core','worker-mcp');
}
