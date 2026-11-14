import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { createClient, type Context } from '../../../core/src/client';
import { failure } from '../../../core/src/errors';
import type { Journal } from '../../../core/src/journal';
import type { Transport } from '../../../core/src/transport';

export function createServer(context: Context, journal: Journal, transport: Transport) {
  const client = createClient({context, journal, transport});
  const server = new Server({name:'herdr-worker',version:'0.1.0'}, {capabilities:{tools:{}}});
  const scalar = (kind: string, extra = {}) => ({['type']:kind,...extra});
  server.setRequestHandler(ListToolsRequestSchema, async () => ({tools:['report','ask_owner'].map(name => ({
    name, description: name === 'report' ? 'Send result or blocker to parent. Reuse requestId on retry.' : 'Send question to parent. Returns after delivery; answer arrives as separate hc input. Reuse requestId on retry.',
    inputSchema:{['type']:'object' as const,additionalProperties:false,properties:{text:scalar('string',{minLength:1,maxLength:32768}),requestId:scalar('string',{minLength:1,maxLength:128}),...(name === 'report' ? {blocker:scalar('boolean')} : {})},required:['text']},
  }))}));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const {name, arguments:input = {}} = request.params;
    if (!['report','ask_owner'].includes(name)) throw new McpError(ErrorCode.InvalidParams,'Unknown tool.');
    const allowed = name === 'report' ? ['text','requestId','blocker'] : ['text','requestId'];
    const result = Object.keys(input).some(key => !allowed.includes(key)) ? failure('INVALID_INPUT','Unknown input field.') : await (name === 'report' ? client.report(input) : client.askOwner(input));
    return {content:[{['type']:'text' as const,text:JSON.stringify(result)}],isError:!result.ok};
  });
  return server;
}
