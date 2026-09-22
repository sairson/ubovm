import test from 'node:test';
import assert from 'node:assert/strict';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createPiWorker } from './worker_pi_agent.mjs';
import { createWorkerCheckpoint, restoreWorkerCheckpoint } from './checkpoint.mjs';

const model = { id: 'fixture', api: 'openai-completions', provider: 'fixture' };
const fact = JSON.stringify({ outcome: 'blocked', statement: 'No evidence available', limitations: ['unavailable'] });
function response(content, stopReason = 'stop') {
  const stream = new AssistantMessageEventStream();
  stream.push({ type: 'done', reason: stopReason, message: {
    role: 'assistant', content, stopReason, api: model.api, provider: model.provider, model: model.id, timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
  } });
  return stream;
}
function setup(phase = 'conclude') {
  const checkpoint = createWorkerCheckpoint({ intentId: 'intent', goal: 'verify' });
  checkpoint.phase = phase;
  if (phase === 'execute') checkpoint.plan = [{ description: 'write', doneWhen: 'saved' }];
  const saved = [];
  return { saved, args: { node: { id: 'intent', intent: { description: 'verify', keyPoints: [] } }, attempt: { id: 'attempt' }, checkpoint,
    getContext: () => ({ data: { goal: 'verify', nodes: [] }, text: 'verify' }), saveCheckpoint: async value => { saved.push(value); } } };
}

test('large thinking and signatures do not consume the report budget', async () => {
  const fixture = setup();
  const worker = createPiWorker({ model, streamFn: () => response([
    { type: 'thinking', thinking: '思'.repeat(10000), thinkingSignature: 's'.repeat(30000) }, { type: 'text', text: fact }
  ]) });
  assert.equal(JSON.parse((await worker(fixture.args)).content).outcome, 'blocked');
});

test('large tool arguments execute once and remain durable', async () => {
  const fixture = setup('execute');
  const content = '代码'.repeat(10000);
  let requests = 0, writes = 0;
  const worker = createPiWorker({ model, tools: [{ name: 'write', description: 'write', parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] },
    execute: async (_id, args) => { writes++; assert.equal(args.content, content); return { content: [{ type: 'text', text: 'saved' }] }; } }],
    streamFn: () => {
      requests++;
      if (requests === 1) return response([{ type: 'toolCall', id: 'write-1', name: 'write', arguments: { content } }], 'toolUse');
      return response([{ type: 'text', text: requests === 2 ? 'saved' : requests === 3 ? '{"done":true}' : fact }]);
    } });
  await worker(fixture.args);
  assert.equal(writes, 1);
  assert.equal(fixture.saved.at(-1).ledger[0].args.content, content);
  assert.doesNotThrow(() => restoreWorkerCheckpoint(fixture.saved.at(-1), { intentId: 'intent', goal: 'verify' }));
});

test('UTF-8 report overflow gets one shortening request and can recover', async () => {
  const fixture = setup();
  let requests = 0;
  const worker = createPiWorker({ model, streamFn: (_model, transcript) => {
    if (++requests === 1) return response([{ type: 'text', text: '中'.repeat(8193) }]);
    assert.ok(transcript.messages.some(message => message.content?.some?.(part => part.text?.includes('24579 UTF-8 bytes'))));
    return response([{ type: 'text', text: fact }]);
  } });
  await worker(fixture.args);
  assert.equal(requests, 2);
});

test('repeated oversized reports fail with an actionable error and bounded retries', async () => {
  const fixture = setup();
  let requests = 0;
  const worker = createPiWorker({ model, streamFn: () => { requests++; return response([{ type: 'text', text: 'x'.repeat(24577) }]); } });
  await assert.rejects(worker(fixture.args), error => error.code === 'RESPONSE_TOO_LARGE' && /worker.maxResponseBytes/.test(error.message));
  assert.equal(requests, 2);
});

test('truncated tool arguments are discarded and repaired without executing partial writes', async () => {
  const fixture = setup('execute');
  let requests = 0, writes = 0;
  const worker = createPiWorker({ model,
    tools: [{ name: 'write', description: 'write', parameters: { type: 'object', properties: {} }, execute: async () => { writes++; return { content: [] }; } }],
    streamFn: () => {
      requests++;
      if (requests <= 2) return response([{ type: 'toolCall', id: 'call-' + requests, name: 'write', arguments: {} }], requests === 1 ? 'length' : 'toolUse');
      return response([{ type: 'text', text: requests === 3 ? 'saved' : requests === 4 ? '{"done":true}' : fact }]);
    } });
  await worker(fixture.args);
  assert.equal(writes, 1);
  assert.deepEqual(fixture.saved.at(-1).ledger.map(entry => entry.toolCallId), ['call-2']);
  assert.doesNotThrow(() => restoreWorkerCheckpoint(fixture.saved.at(-1), { intentId: 'intent', goal: 'verify' }));
});

test('repeated token truncation is bounded and leaves a recoverable checkpoint', async () => {
  const fixture = setup(); let requests = 0;
  const worker = createPiWorker({ model, streamFn: () => { requests++; return response([{ type: 'text', text: '{"outcome":' }], 'length'); } });
  await assert.rejects(worker(fixture.args), { code: 'MODEL_RESPONSE_TRUNCATED' });
  assert.equal(requests, 2);
  assert.doesNotThrow(() => restoreWorkerCheckpoint(fixture.saved.at(-1), { intentId: 'intent', goal: 'verify' }));
});

test('repair after a successful tool retains its result instead of replaying the operation', async () => {
  const fixture = setup('execute'); let requests = 0, writes = 0;
  const worker = createPiWorker({ model,
    tools: [{ name: 'write', description: 'write', parameters: { type: 'object', properties: {} }, execute: async () => { writes++; return { content: [{ type: 'text', text: 'durable result' }] }; } }],
    streamFn: (_model, transcript) => {
      requests++;
      if (requests === 1) return response([{ type: 'toolCall', id: 'successful', name: 'write', arguments: {} }], 'toolUse');
      if (requests === 2) return response([{ type: 'text', text: 'unfinished report' }], 'length');
      if (requests === 3) {
        assert.ok(transcript.messages.some(message => message.role === 'toolResult' && message.toolCallId === 'successful' && message.content[0].text === 'durable result'));
        assert.ok(!transcript.messages.some(message => message.role === 'assistant' && message.stopReason === 'length'));
      }
      return response([{ type: 'text', text: requests === 3 ? 'saved' : requests === 4 ? '{"done":true}' : fact }]);
    } });
  await worker(fixture.args); assert.equal(writes, 1);
});

test('cancellation holds the intent lock until an outstanding tool has stopped', { timeout: 5000 }, async () => {
  const fixture = setup('execute'), controller = new AbortController();
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const running = new Promise(resolve => { started = resolve; });
  let resume = false;
  const worker = createPiWorker({ model,
    tools: [{ name: 'write', description: 'write', parameters: { type: 'object', properties: {} }, execute: async () => { started(); await gate; return { content: [] }; } }],
    streamFn: () => resume ? response([{ type: 'text', text: fact }]) : response([{ type: 'toolCall', id: 'pending', name: 'write', arguments: {} }], 'toolUse') });
  const operation = worker({ ...fixture.args, signal: controller.signal });
  try {
    await running; controller.abort();
    await assert.rejects(operation, { code: 'ABORT_ERR' });
    await assert.rejects(worker(setup().args), { code: 'WORKER_BUSY' });
  } finally { release(); }
  await new Promise(resolve => setImmediate(resolve));
  resume = true;
  assert.equal(JSON.parse((await worker(setup().args)).content).outcome, 'blocked');
});
