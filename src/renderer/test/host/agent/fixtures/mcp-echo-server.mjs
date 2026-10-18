import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// Minimal stdio MCP server used by the install-flow test: one echo tool.
const server = new Server({ name: 'echo', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'echo', description: 'Echo the provided text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }]
}));
server.setRequestHandler(CallToolRequestSchema, async request => ({
  content: [{ type: 'text', text: String(request.params.arguments?.text ?? '') }]
}));
await server.connect(new StdioServerTransport());
