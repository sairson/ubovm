import test from 'node:test';
import assert from 'node:assert/strict';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createPiReason } from '../reason_agent.mjs';

const model = { id: 'fixture', provider: 'fixture', api: 'openai-completions' };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function response(text) {
  const stream = new AssistantMessageEventStream();
  stream.push({ type: 'done', reason: 'stop', message: { role: 'assistant', content: [{ type: 'text', text }], api: model.api, provider: model.provider,
    model: model.id, usage, stopReason: 'stop', timestamp: Date.now() } });
  return stream;
}

const fact = JSON.stringify({
  version: 1,
  statement: 'Login probe returned 200',
  outcome: 'confirmed',
  coverage: [{ point: 'verify', status: 'confirmed', result: '200' }],
  evidence: [{ toolCallId: 't1', observation: '200' }]
});

const context = {
  data: { goal: 'penetration test example.com', revision: 3, root: 'n1', nodes: [
    { ref: 'n1', kind: 'root', parents: [] },
    { ref: 'n2', kind: 'intent', parents: ['n1'], result: 'n3', intent: { description: 'probe login', status: 'completed', keyPoints: ['verify'] } },
    { ref: 'n3', kind: 'fact', parents: ['n2'], producer: 'n2', fact }
  ] },
  resolveId: ref => ref,
  aliasFor: id => id
};

const decision = JSON.stringify({ complete: true, evidenceIds: ['n3'], summary: 'Scope verified' });

test('a host completion gate rejection is returned to Reason as a repairable decision', async () => {
  const reason = createPiReason({
    model,
    streamFn: () => response(decision),
    completionGuard: async () => ({ issue: 'Coverage gate: 2 of 3 hosts are untested; mark them tested first.' }),
    maxRepairs: 0
  });
  await assert.rejects(reason({ context }), /Coverage gate: 2 of 3 hosts are untested/);
});

test('a satisfied guard leaves the completion decision intact', async () => {
  const reason = createPiReason({
    model,
    streamFn: () => response(decision),
    completionGuard: async () => ({ issue: null, surface: { status: 'ok' } }),
    maxRepairs: 0
  });
  const accepted = await reason({ context });
  assert.equal(accepted.complete, true);
  assert.deepEqual(accepted.evidenceIds, ['n3']);
  assert.equal(accepted.summary, 'Scope verified');
});
