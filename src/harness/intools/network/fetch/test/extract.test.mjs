import test from 'node:test';
import assert from 'node:assert/strict';
import { extract } from '../extract.mjs';
import { createFetchTool } from '../index.mjs';

test('HTML extraction preserves code indentation, tabs and embedded fences', () => {
  const source = '<html><body><p>  Hello   world </p><pre>if True:\n    print("中文")\n\t```\n</pre><p> End </p></body></html>';
  const result = extract(Buffer.from(source), 'text/html', 'https://example.com');
  assert.equal(result.text, 'Hello world\n\n````\nif True:\n    print("中文")\n\t```\n````\n\nEnd');
});

test('feed entry caps report unrecoverable omitted content and incomplete matching', async () => {
  const source = `<rss><channel><title>Feed</title>${Array.from({ length: 101 }, (_, i) => `<item><title>entry-${i}</title><description>${i === 100 ? 'unique-tail-marker' : 'summary'}</description></item>`).join('')}</channel></rss>`;
  const result = extract(Buffer.from(source), 'application/rss+xml', 'https://example.com');
  assert.equal(result.extractionTruncated, true);
  assert.match(result.text, /showing first 100/);
  const tool = createFetchTool({ allowPrivateAddresses: true, fetch: async () => new Response(source, { headers: { 'content-type': 'application/rss+xml' } }) });
  const { details } = await tool.execute('feed', { url: 'https://example.com', expected_identifiers: ['unique-tail-marker'] });
  assert.equal(details.extraction_truncated, true);
  assert.equal(details.verification_status, 'content_incomplete');
  assert.ok(details.warnings.some(value => /feed-entry/.test(value)));
  const partial = (await tool.execute('partial', { url: 'https://example.com', expected_identifiers: ['entry-0'] })).details;
  assert.equal(partial.verification_status, 'verified_partial_content');
});

test('fetch pagination counts Unicode codepoints without splitting emoji', async () => {
  const text = '😀'.repeat(600);
  const tool = createFetchTool({ allowPrivateAddresses: true, fetch: async () => new Response(text) });
  const first = (await tool.execute('first', { url: 'https://example.com', max_content_chars: 256 })).details;
  const second = (await tool.execute('second', { url: 'https://example.com', content_offset: first.next_content_offset })).details;
  assert.equal(first.next_content_offset, 256);
  assert.equal(first.content + second.content, text);
  assert.equal(second.next_content_offset, undefined);
});

test('fetch retries transient 429 and network blips before succeeding', async () => {
  let attempts = 0;
  const tool = createFetchTool({
    allowPrivateAddresses: true,
    retryBackoffMs: 1,
    fetch: async () => {
      attempts++;
      if (attempts === 1) return new Response('rate', { status: 429 });
      if (attempts === 2) throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
      return new Response('ok-body', { status: 200, headers: { 'content-type': 'text/plain' } });
    }
  });
  const { details } = await tool.execute('retry', { url: 'https://example.com/doc' });
  assert.equal(details.status, 'ok');
  assert.match(details.content, /ok-body/);
  assert.equal(attempts, 3);
});

test('rendering_required warns against refetch loops', async () => {
  const tool = createFetchTool({
    allowPrivateAddresses: true,
    fetch: async () => new Response('<html><head><title>App</title></head><body><div id="root"></div><script src="/runtime.js"></script><script src="/app.js"></script></body></html>', {
      headers: { 'content-type': 'text/html' }
    })
  });
  const { details } = await tool.execute('spa', { url: 'https://example.com/app' });
  assert.equal(details.rendering_required, true);
  assert.ok(details.warnings.some(value => /Do not refetch/.test(value)));
});
