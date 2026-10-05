import test from 'node:test';
import assert from 'node:assert/strict';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createModelClient } from '../model.mjs';
import { hasAssistantContent, isRetryableModelFailure, isTransientTransportError, rateLimitDelayMs } from '../model-retry.mjs';

function errorStream(model, message) {
  const stream = new AssistantMessageEventStream();
  const error = {
    role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'error', errorMessage: message, timestamp: Date.now(),
  };
  stream.push({ type: 'error', reason: 'error', error });
  return stream;
}

function doneStream(model, text) {
  const stream = new AssistantMessageEventStream();
  const message = {
    role: 'assistant', content: [{ type: 'text', text }], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop', timestamp: Date.now(),
  };
  stream.push({ type: 'start', partial: message });
  stream.push({ type: 'text_start', contentIndex: 0, partial: message });
  stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: message });
  stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: message });
  stream.push({ type: 'done', reason: 'stop', message });
  return stream;
}

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
  assert.equal(options.maxRetries, 3);
  assert.equal(options.maxRetryDelayMs, 5000);
  assert.equal(options.timeoutMs, 900000, 'a default streaming deadline bounds hung connections');

  const disabled = createModelClient({
    provider: 'smoke', modelId: 'fixture', api: 'openai-completions', baseUrl: 'https://offline.invalid/v1', apiKey: 'k',
    streamOptions: { maxRetries: 0, maxRetryDelayMs: 0 },
    streamFn: (_model, _context, streamOptions) => { options = streamOptions; return 'ok'; }
  });
  await disabled.streamFn(disabled.model, {});
  assert.equal(options.maxRetries, 0);
  assert.equal(options.maxRetryDelayMs, 0);
});

test('pre-token transport failures retry for transient network errors', async () => {
  let calls = 0;
  const client = createModelClient({
    provider: 'smoke', modelId: 'fixture', api: 'openai-completions', baseUrl: 'https://offline.invalid/v1', apiKey: 'k',
    streamOptions: { maxRetries: 1, maxRetryDelayMs: 1 },
    streamFn: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' });
      return 'recovered';
    }
  });
  assert.equal(await client.streamFn(client.model, {}), 'recovered');
  assert.equal(calls, 2);
});

test('empty retryable error streams are retried before content is observed', async () => {
  let calls = 0;
  const client = createModelClient({
    provider: 'smoke', modelId: 'fixture', api: 'openai-completions', baseUrl: 'https://offline.invalid/v1', apiKey: 'k',
    streamOptions: { maxRetries: 1, maxRetryDelayMs: 1 },
    streamFn: async (model) => {
      calls += 1;
      if (calls === 1) return errorStream(model, 'fetch failed: socket hang up');
      return doneStream(model, 'recovered');
    }
  });
  const stream = await client.streamFn(client.model, {});
  const result = await stream.result();
  assert.equal(result.stopReason, 'stop');
  assert.equal(result.content[0].text, 'recovered');
  assert.equal(calls, 2);
});

test('content-bearing failures are not retried by the stream wrapper', async () => {
  let calls = 0;
  const client = createModelClient({
    provider: 'smoke', modelId: 'fixture', api: 'openai-completions', baseUrl: 'https://offline.invalid/v1', apiKey: 'k',
    streamOptions: { maxRetries: 2, maxRetryDelayMs: 1 },
    streamFn: async (model) => {
      calls += 1;
      const stream = new AssistantMessageEventStream();
      const message = {
        role: 'assistant', content: [{ type: 'text', text: 'partial' }], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'error', errorMessage: 'socket hang up', timestamp: Date.now(),
      };
      stream.push({ type: 'start', partial: { ...message, content: [{ type: 'text', text: '' }] } });
      stream.push({ type: 'text_delta', contentIndex: 0, delta: 'partial', partial: message });
      stream.push({ type: 'error', reason: 'error', error: message });
      return stream;
    }
  });
  const result = await (await client.streamFn(client.model, {})).result();
  assert.equal(result.stopReason, 'error');
  assert.equal(calls, 1);
});

test('pre-token retry does not mask cancellation', async () => {
  const controller = new AbortController();
  const client = createModelClient({
    provider: 'smoke', modelId: 'fixture', api: 'openai-completions', baseUrl: 'https://offline.invalid/v1', apiKey: 'k',
    streamOptions: { maxRetries: 2, maxRetryDelayMs: 50 },
    streamFn: async () => {
      controller.abort();
      throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' });
    }
  });
  await assert.rejects(client.streamFn(client.model, {}, { signal: controller.signal }), { name: 'AbortError' });
});

test('retry classification covers common transport wording', () => {
  assert.equal(isTransientTransportError(Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' })), true);
  assert.equal(isTransientTransportError(Object.assign(new Error('auth failed'), { status: 401 })), false);
  assert.equal(isRetryableModelFailure({ stopReason: 'error', errorMessage: '503 service unavailable' }), true);
  assert.equal(isRetryableModelFailure({ stopReason: 'error', errorMessage: 'insufficient_quota' }), false);
  assert.equal(hasAssistantContent({ content: [{ type: 'text', text: 'x' }] }), true);
  assert.equal(hasAssistantContent({ content: [] }), false);
});

test('rateLimitDelayMs extracts Retry-After from fields, headers, and message text', () => {
  assert.equal(rateLimitDelayMs(Object.assign(new Error('Too Many Requests'), { status: 429, retryAfter: 2 })), 2000);
  assert.equal(rateLimitDelayMs(Object.assign(new Error('rate limited'), { status: 429, headers: { 'retry-after': '1.5' } })), 1500);
  assert.equal(rateLimitDelayMs({ stopReason: 'error', errorMessage: '429 Too Many Requests; retry after 3 seconds' }), 3000);
  assert.equal(rateLimitDelayMs(Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' })), 0, 'non rate-limit failures carry no delay');
  assert.equal(rateLimitDelayMs(Object.assign(new Error('server error'), { status: 500 })), 0);
  assert.equal(rateLimitDelayMs(null), 0);
});

test('a 429 with Retry-After coordinates concurrent callers of the same model', async () => {
  const configuration = {
    provider: 'smoke', modelId: 'cooldown', api: 'openai-completions', baseUrl: 'https://offline.invalid/v1', apiKey: 'k'
  };
  const throttled = createModelClient({ ...configuration, streamOptions: { maxRetries: 0 },
    streamFn: async () => { throw Object.assign(new Error('Too Many Requests'), { status: 429, retryAfter: 0.15 }); } });
  await assert.rejects(throttled.streamFn(throttled.model, {}), /Too Many Requests/);
  // The giving-up caller still publishes the provider's cooldown window.
  let opened = 0;
  const started = Date.now();
  const sharing = createModelClient({ ...configuration, streamOptions: { maxRetries: 0 },
    streamFn: async () => { opened += 1; return 'ok'; } });
  assert.equal(await sharing.streamFn(sharing.model, {}), 'ok');
  assert.equal(opened, 1);
  assert.ok(Date.now() - started >= 100, `second caller honored the cooldown (waited ${Date.now() - started}ms)`);
});
