import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createTlsFetch } from '../tls-fetch.mjs';

async function serve(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('TLS fetch forwards a Headers instance, method, body and returns a streaming Response', async t => {
  let seen;
  const base = await serve(t, (request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      seen = { method: request.method, headers: request.headers, body };
      response.writeHead(201, { 'content-type': 'application/json', 'x-probe': 'yes' });
      response.end('{"ok":true}');
    });
  });
  const response = await createTlsFetch({ rejectUnauthorized: true })(new URL(`${base}/mcp?x=1`), {
    method: 'POST',
    headers: new Headers({ 'MCP-API-Key': 'key-1', authorization: 'Basic abc' }),
    body: '{"jsonrpc":"2.0"}',
  });
  assert.equal(response.status, 201);
  assert.equal(response.statusText, 'Created');
  assert.equal(response.headers.get('x-probe'), 'yes');
  assert.equal(seen.method, 'POST');
  assert.equal(seen.headers['mcp-api-key'], 'key-1');
  assert.equal(seen.headers.authorization, 'Basic abc');
  assert.equal(seen.body, '{"jsonrpc":"2.0"}');
  assert.deepEqual(await response.json(), { ok: true });
});

test('TLS fetch returns a bodyless Response for 204 and empty responses', async t => {
  const base = await serve(t, (_request, response) => { response.writeHead(204); response.end(); });
  const response = await createTlsFetch()(base);
  assert.equal(response.status, 204);
  assert.equal(response.body, null);
  assert.equal(await response.text(), '');
});

test('TLS fetch follows redirects and turns a redirected POST into GET', async t => {
  const methods = [];
  const base = await serve(t, (request, response) => {
    methods.push(`${request.method} ${request.url}`);
    if (request.url === '/start') { response.writeHead(303, { location: '/done' }); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('finished');
  });
  const response = await createTlsFetch()(`${base}/start`, { method: 'POST', body: 'payload' });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'finished');
  assert.deepEqual(methods, ['POST /start', 'GET /done']);
});

test('TLS fetch rejects on an aborted signal and on connection errors', async t => {
  const base = await serve(t, () => { /* never responds */ });
  await assert.rejects(createTlsFetch()(base, { signal: AbortSignal.timeout(50) }));
  // A closed port is the closest portable stand-in for an unreachable endpoint.
  await assert.rejects(createTlsFetch()('http://127.0.0.1:1/mcp'), error => ['ECONNREFUSED', 'EACCES', 'EADDRNOTAVAIL'].includes(error.code));
});
