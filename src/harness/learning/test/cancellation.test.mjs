import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { abortable } from '../cancellation.mjs';
import { createKnowledgeReflector } from '../background.mjs';

test('cancelled learning releases listeners immediately and observes late rejection', async () => {
  for (const preAborted of [false, true]) {
    const controller = new AbortController(), reason = new Error('cancelled');
    if (preAborted) controller.abort(reason);
    let reject;
    const operation = new Promise((_, fail) => { reject = fail; });
    const pending = assert.rejects(abortable(operation, controller.signal), error => error === reason);
    controller.abort(reason); await pending;
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    reject(new Error('late provider failure')); await new Promise(resolve => setImmediate(resolve));
  }
});
test('pre-cancelled reflection never starts a provider request', async () => {
  let calls = 0;
  const reflect = createKnowledgeReflector({ streamFn() { calls++; } });
  await assert.rejects(reflect({ records: [], signal: AbortSignal.abort(new Error('closed')) }), /closed/);
  assert.equal(calls, 0);
});


test('large durable learning backlogs schedule without argument overflow or dropping jobs', async () => {
  const { createBackgroundLearning } = await import('../runner.mjs');
  const count = 150000;
  const state = { toolEvidence: [], agentKnowledge: { version: 1, lessons: [], queue: { version: 1, cursor: 0, windows: [], jobs: Array.from({ length: count }, (_, index) => ({
    id: 'base:' + index, kind: 'base', workerId: 'worker', refs: [{ toolCallId: 'call', digest: 'digest' }], status: 'pending', attempts: 0, nextAttemptAt: Date.now() + 60000
  })) } } };
  let reads = 0;
  const store = { learningJobs() { reads++; return state.agentKnowledge.queue.jobs; }, async commit(update) { return update(state); } };
  const learning = createBackgroundLearning({ store, knowledge: {} });
  try {
    await learning.flush(); reads = 0;
    const status = learning.status();
    assert.equal(status.pending, count); assert.equal(status.failures, 0); assert.equal(status.dropped, 0);
    assert.equal(reads, 1, 'status reads job metadata once regardless of queue size');
  } finally { await learning.close(); }
});
