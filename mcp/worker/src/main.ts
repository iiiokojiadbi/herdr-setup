import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { FileJournal } from './journal';
import { createServer } from './server';
import { processTransport } from './transport';

try {
  const journal = new FileJournal(process.argv[2]);
  await journal.load();
  const server = createServer({self:process.env.HC_TERMINAL_ID,parent:process.env.HC_PARENT,sessionId:'terminal-lifetime',cwd:process.cwd()}, journal, processTransport);
  server.onerror = () => console.error('MCP protocol error.');
  // EOF/signals close the protocol; Node drains any delivery already in flight.
  const close = () => { void server.close(); };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stdin.once('end', close);
} catch { console.error('MCP startup failed: journal unavailable or invalid.'); process.exitCode = 1; }
