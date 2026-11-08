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
test('MCP instruction provider tells the agent which servers are connected', async t => {
  clients(t);
  const mcp = await createMcpMiddleware({ servers: [{ name: 'local', command: 'unused' }] });
  try {
    const status = mcp.instructionProvider();
    assert.match(status, /MCP servers/);
    assert.match(status, /local \(stdio\): connected; tools: mcp__local__read/);
    assert.match(status, /connected from the next turn/);
  } finally { await mcp.close(); }
});
test('MCP instruction provider names an unreachable server and explains the gap', async t => {
  const mcp = await createMcpMiddleware({ servers: [{ name: 'dead', command: 'unused', required: false }] });
  try {
    const status = mcp.instructionProvider();
    assert.match(status, /dead \(stdio\): NOT connected/);
  } finally { await mcp.close().catch(() => {}); }
});
test('MCP instruction provider is empty without configured servers', async () => {
  const mcp = await createMcpMiddleware({ servers: [] });
  assert.equal(mcp.instructionProvider(), '');
  await mcp.close();
});

test('MCP diagnostics keep the numeric HTTP status and the server error body', async t => {
  const { createServer } = await import('node:http');
  const server = createServer((_request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end('{"code":401,"message":"invalid mcp key"}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const mcp = await createMcpMiddleware({ servers: [{ name: 'remote', transport: 'streamable_http',
    url: `http://127.0.0.1:${server.address().port}/mcp`, required: false }], connectTimeoutMs: 5000 });
  try {
    const [diagnostic] = mcp.diagnostics();
    assert.equal(diagnostic.connected, false);
    assert.match(diagnostic.error, /\(401\)/);
    assert.match(diagnostic.error, /invalid mcp key/);
    assert.match(mcp.instructionProvider(), /remote \(streamable_http\): NOT connected .*invalid mcp key/);
  } finally { await mcp.close(); }
});

test('MCP TLS options are validated and only accepted for HTTP transports', async () => {
  await assert.rejects(createMcpMiddleware({ servers: [{ name: 'local', command: 'unused', insecureTls: true }] }), /TLS/);
  await assert.rejects(createMcpMiddleware({ servers: [{ name: 'remote', transport: 'sse', url: 'https://example.test/sse', tlsCa: 'not a certificate' }] }), /PEM/);
  await assert.rejects(createMcpMiddleware({ servers: [{ name: 'remote', transport: 'sse', url: 'https://example.test/sse', insecureTls: 'yes' }] }), /insecureTls/);
  // accepted for HTTP transports (the unreachable endpoint only fails later)
  const mcp = await createMcpMiddleware({ servers: [{ name: 'remote', transport: 'sse', url: 'https://127.0.0.1:1/mcp', insecureTls: true, required: false }], connectTimeoutMs: 1000 });
  assert.equal(mcp.diagnostics()[0].connected, false);
  await mcp.close().catch(() => {});
});

test('host-level insecureTls applies to every HTTP server and is validated', async () => {
  await assert.rejects(createMcpMiddleware({ servers: [], insecureTls: 'yes' }), /insecureTls option must be boolean/);
  const mcp = await createMcpMiddleware({ servers: [
    { name: 'local', command: 'unused', required: false },
    { name: 'remote', transport: 'streamable_http', url: 'https://127.0.0.1:1/mcp', required: false },
  ], insecureTls: true, connectTimeoutMs: 1000 });
  try {
    const [local, remote] = mcp.diagnostics();
    assert.equal(local.connected, false);
    assert.equal(remote.connected, false);
    // The opt-out path uses the dedicated https fetch, so a refused connection
    // surfaces the raw Node error instead of undici's opaque "fetch failed".
    assert.match(remote.error, /ECONNREFUSED|connect/);
    assert.doesNotMatch(remote.error, /fetch failed/);
  } finally { await mcp.close().catch(() => {}); }
});
