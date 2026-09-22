import test from 'node:test';
import assert from 'node:assert/strict';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createPiReason } from './reason_agent.mjs';
import { runConversation } from './collaboration/conversation.mjs';

const model = { id: 'fixture', provider: 'fixture', api: 'openai-completions' };
function response(text, stopReason) {
  const stream = new AssistantMessageEventStream();
  stream.push({ type: 'done', reason: stopReason, message: { role: 'assistant', content: [{ type: 'text', text }], stopReason,
    api: model.api, provider: model.provider, model: model.id, timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
  return stream;
}
const context = { data: { goal: 'verify', revision: 0, root: 'n1', nodes: [{ ref: 'n1', kind: 'root', parents: [] }] }, resolveId: ref => ref };

test('Reason repairs token truncation against the same evidence within its budget', async () => {
  let calls = 0;
  const reason = createPiReason({ model, streamFn: () => ++calls === 1 ? response('{"intents":', 'length')
    : response('{"intents":[{"description":"inspect","parentIds":["n1"],"priority":"medium","keyPoints":["checked"]}]}', 'stop') });
  assert.equal((await reason({ context })).intents.length, 1);
  assert.equal(calls, 2);
  await assert.rejects(createPiReason({ model, maxRepairs: 0, streamFn: () => response('partial', 'length') })({ context }), { code: 'MODEL_RESPONSE_TRUNCATED' });
});

function conversation(streamFn, options = {}) {
  return runConversation({ client: { model, streamFn }, options, workerId: 'chat', prompt: 'verify', systemPrompt: 'verify', tools: [],
    load: () => undefined, save: () => {}, audit: () => {}, swarm: { snapshot: () => ({ sessionId: 'chat', workers: [] }), settle: async () => {} } });
}
test('conversation completes a truncated answer instead of publishing it as success', async () => {
  let calls = 0;
  const result = await conversation(() => ++calls === 1 ? response('incomplete', 'length') : response('Complete answer.', 'stop'));
  assert.equal(result.answer, 'Complete answer.'); assert.equal(calls, 2);
});
test('conversation truncation retries respect both retry and model budgets', async () => {
  let calls = 0;
  await assert.rejects(conversation(() => { calls++; return response('incomplete', 'length'); }), { code: 'COLLABORATION_RESPONSE_TRUNCATED' });
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(conversation(() => { calls++; return response('incomplete', 'length'); }, { maxModelCalls: 1 }), { code: 'COLLABORATION_MODEL_BUDGET' });
  assert.equal(calls, 1);
});

test('provider failures are not mistaken for recoverable truncation', async () => {
  let calls = 0;
  await assert.rejects(conversation(() => { calls++; throw new Error('authentication failed'); }), /authentication failed/);
  assert.equal(calls, 1);
});
