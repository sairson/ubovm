import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelClient } from '../model.mjs';

test('legacy SDK configuration uses Pi transport with its original endpoint and credential', async () => {
  for (const backend of ['claude', 'codex']) {
    let called = 0;
    const client = createModelClient({ backend, provider: 'deepseek', modelId: backend === 'claude' ? 'deepseek-flash[1m]' : 'deepseek-flash', apiKey: 'private',
      streamFn: (model, context, options) => { called++; assert.equal(options.apiKey, 'private'); return 'pi-stream'; } });
    assert.equal(client.backend, 'pi');
    assert.equal(client.model.id, 'deepseek-flash');
    assert.equal(client.model.api, backend === 'claude' ? 'anthropic-messages' : 'openai-responses');
    assert.equal(client.model.baseUrl, backend === 'claude' ? 'https://api.deepseek.com/anthropic' : 'https://api.deepseek.com');
    assert.equal(await client.streamFn(client.model, {}), 'pi-stream');
    assert.equal(called, 1);
    assert(!JSON.stringify(client.model).includes('private'));
  }
  assert.throws(() => createModelClient({ backend: 'unknown' }), /Pi Agent/);
});

test('streamOptions default to a small transient retry budget and honor explicit zero', async () => {
  let options;
  const client = createModelClient({
    provider: 'smoke', modelId: 'fixture', api: 'openai-completions', baseUrl: 'https://offline.invalid/v1', apiKey: 'k',
    streamFn: (_model, _context, streamOptions) => { options = streamOptions; return 'ok'; }
  });
  await client.streamFn(client.model, {});
  assert.equal(options.maxRetries, 2);
  assert.equal(options.maxRetryDelayMs, 2000);

  const disabled = createModelClient({
    provider: 'smoke', modelId: 'fixture', api: 'openai-completions', baseUrl: 'https://offline.invalid/v1', apiKey: 'k',
    streamOptions: { maxRetries: 0, maxRetryDelayMs: 0 },
    streamFn: (_model, _context, streamOptions) => { options = streamOptions; return 'ok'; }
  });
  await disabled.streamFn(disabled.model, {});
  assert.equal(options.maxRetries, 0);
  assert.equal(options.maxRetryDelayMs, 0);
});

test('pre-token transport failures retry once for transient network errors', async () => {
  let calls = 0;
  const client = createModelClient({
    provider: 'smoke', modelId: 'fixture', api: 'openai-completions', baseUrl: 'https://offline.invalid/v1', apiKey: 'k',
    streamOptions: { maxRetries: 0 },
    streamFn: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' });
      return 'recovered';
    }
  });
  assert.equal(await client.streamFn(client.model, {}), 'recovered');
  assert.equal(calls, 2);
});

test('pre-token retry does not mask cancellation', async () => {
  const controller = new AbortController();
  const client = createModelClient({
    provider: 'smoke', modelId: 'fixture', api: 'openai-completions', baseUrl: 'https://offline.invalid/v1', apiKey: 'k',
    streamFn: async () => {
      controller.abort();
      throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' });
    }
  });
  await assert.rejects(client.streamFn(client.model, {}, { signal: controller.signal }), { name: 'AbortError' });
});
