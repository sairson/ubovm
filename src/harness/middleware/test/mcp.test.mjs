import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMcpMiddleware } from '../mcp.mjs';
function clients(t) {
  t.mock.method(Client.prototype, 'connect', async () => {});
  t.mock.method(Client.prototype, 'listTools', async () => ({ tools: [{ name: 'read', inputSchema: { type: 'object', properties: {} } }] }));
  t.mock.method(Client.prototype, 'close', async () => {});
}
test('MCP asynchronous progress failures cannot fail a successful tool call', async t => {
  clients(t);
  t.mock.method(Client.prototype, 'callTool', async (_input, _schema, options) => {
    options.onprogress({ progress: 1, total: 1 });
    return { content: [{ type: 'text', text: 'done' }] };
  });
  const mcp = await createMcpMiddleware({ servers: [{ name: 'local', command: 'unused' }] });
  try {
    const result = await mcp.tools[0].execute('call', {}, undefined, async () => { throw new Error('observer failed'); });
    assert.equal(result.content[0].text, 'done');
    await new Promise(resolve => setImmediate(resolve));
  } finally { await mcp.close(); }
});
test('MCP close attempts every client even when one close throws synchronously', async t => {
  clients(t); let closed = 0;
  t.mock.method(Client.prototype, 'close', () => { if (++closed === 1) throw new Error('close failed'); });
  const mcp = await createMcpMiddleware({ servers: [{ name: 'one', command: 'unused' }, { name: 'two', command: 'unused' }] });
  await assert.rejects(mcp.close(), AggregateError);
  assert.equal(closed, 2);
  assert.ok(mcp.diagnostics().every(server => !server.connected));
  await assert.rejects(mcp.tools[0].execute('call', {}), { code: 'MCP_CLOSED' });
});
