import test from 'node:test';
import assert from 'node:assert/strict';
import { requestBytes } from '../index.mjs';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';

test('native transport handles compressed responses and bodyless HEAD/204 without decoder errors', async t => {
  const payload = gzipSync(Buffer.from('压缩正文'));
  const server = createServer((request, response) => {
    response.writeHead(request.url === '/empty' ? 204 : 200, { 'content-encoding': 'gzip' });
    response.end(request.method === 'HEAD' || request.url === '/empty' ? undefined : payload);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const options = { secure: true, allowPrivateAddresses: true, timeoutMs: 1000 };
  assert.equal((await requestBytes(url, options)).body.toString(), '压缩正文');
  assert.equal((await requestBytes(url, { ...options, method: 'HEAD' })).body.length, 0);
  assert.equal((await requestBytes(`${url}/empty`, options)).body.length, 0);
});

test('POST redirects remove body headers while HEAD remains HEAD after 303', async () => {
  for (const status of [301, 302, 303]) {
    const calls = [];
    await requestBytes('https://example.com/start', {
      method: 'post', body: 'payload',
      headers: { 'content-type': 'text/plain', 'content-length': '7', 'content-encoding': 'identity', 'x-test': 'kept' },
      fetch: async (url, init) => {
        calls.push(init);
        return calls.length === 1 ? new Response(null, { status, headers: { location: '/end' } }) : new Response('ok');
      },
    });
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[1].method, 'GET');
    assert.equal(calls[1].body, undefined);
    assert.deepEqual(calls[1].headers, { 'x-test': 'kept' });
  }
  let calls = 0;
  await requestBytes('https://example.com/start', { method: 'HEAD', fetch: async (_url, init) => {
    assert.equal(init.method, 'HEAD');
    return ++calls === 1 ? new Response(null, { status: 303, headers: { location: '/end' } }) : new Response(null);
  } });
  assert.equal(calls, 2);
});

test('307 preserves the POST body and cross-origin credentials never get forwarded', async () => {
  let calls = 0;
  await requestBytes('https://example.com/start', { method: 'POST', body: 'payload', fetch: async (_url, init) => {
    assert.equal(init.method, 'POST');
    assert.equal(init.body, 'payload');
    return ++calls === 1 ? new Response(null, { status: 307, headers: { location: '/end' } }) : new Response('ok');
  } });
  calls = 0;
  await assert.rejects(requestBytes('https://example.com/start', { headers: { authorization: 'secret' }, fetch: async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: 'https://other.example/end' } });
  } }), /cross-origin/);
  assert.equal(calls, 1);
});

test('cancellation disposes a response returned late by a host transport', async () => {
  const controller = new AbortController();
  let complete, cancelled = false;
  const pending = requestBytes('https://example.com', { signal: controller.signal, fetch: () => new Promise(resolve => { complete = resolve; }) });
  controller.abort(new Error('stop request'));
  await assert.rejects(pending, /stop request/);
  complete(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test('a transport that aborts synchronously still has its rejection observed', async () => {
  const controller = new AbortController();
  await assert.rejects(requestBytes('https://example.com', { signal: controller.signal, fetch: () => {
    controller.abort(new Error('synchronous stop'));
    return Promise.reject(new Error('transport failure'));
  } }), /synchronous stop/);
  await new Promise(resolve => setImmediate(resolve));
});

test('bounded responses cancel streams and retain only the permitted prefix', async () => {
  let cancelled = false;
  const result = await requestBytes('https://example.com', { maxResponseBytes: 3, truncate: true,
    fetch: async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('abcdef')); }, cancel() { cancelled = true; } })) });
  assert.equal(result.body.toString(), 'abc');
  assert.equal(result.truncated, true);
  assert.equal(cancelled, true);
});
