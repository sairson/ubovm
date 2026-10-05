import test from 'node:test';
import assert from 'node:assert/strict';
import { Blackboard } from '../blackboard.mjs';
import { BlackboardCoordinator } from '../coordinator.mjs';

const result = (overrides = {}) => ({ version: 1, statement: 'Observed the scoped result', outcome: 'confirmed',
  coverage: [{ point: 'verify', status: 'confirmed', result: 'Passed' }],
  evidence: [{ toolCallId: 'check', observation: 'Control passed' }], nextSteps: [], ...overrides });

function confirmedFact(context) {
  return context.data.nodes.filter(node => node.kind === 'fact' && node.assessment?.completionIssue === null)
    .find(node => { try { return JSON.parse(node.fact).outcome === 'confirmed'; } catch { return false; } });
}

test('a transient worker failure is requeued once within the run', async () => {
  const board = new Blackboard({ sessionId: 'worker-auto-retry', goal: 'verify' });
  await board.createIntent({ description: 'flaky check', keyPoints: ['verify'] });
  let attempts = 0;
  const completed = await new BlackboardCoordinator({
    blackboard: board,
    maxRounds: 6,
    maxWorkerRetries: 1,
    reason: async ({ context }) => {
      const fact = confirmedFact(context);
      return fact ? { complete: true, summary: 'Verified after retry', evidenceIds: [fact.ref] } : { wait: true };
    },
    worker: async ({ node }) => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient tool failure');
      return JSON.stringify(result({ statement: `Recovered on attempt ${node.attempts.length}` }));
    }
  }).run();
  assert.equal(completed.complete, true);
  assert.equal(attempts, 2);
  const node = board.snapshot().nodes.find(item => item.intent?.description === 'flaky check');
  assert.equal(node.intent.status, 'completed');
  assert.equal(node.attempts.length, 2, 'the failed first attempt stays on the board for review');
  assert.equal(node.attempts[0].status, 'failed');
});

test('the retry budget stops permanent failures from looping', async () => {
  const board = new Blackboard({ sessionId: 'worker-retry-budget', goal: 'verify' });
  await board.createIntent({ description: 'broken check', keyPoints: ['verify'] });
  let attempts = 0;
  // With no completable evidence the run must stall after the budget is spent
  // rather than retrying the permanently failing intent forever.
  const stalled = await new BlackboardCoordinator({
    blackboard: board,
    maxRounds: 6,
    maxWorkerRetries: 1,
    reason: async () => ({ wait: true }),
    worker: async () => { attempts += 1; throw new Error('permanent failure'); }
  }).run().then(() => null, error => error);
  assert.equal(stalled?.code, 'STALLED');
  assert.equal(attempts, 2, 'one automatic retry, then the failure stays on the board');
  const node = board.snapshot().nodes.find(item => item.intent?.description === 'broken check');
  assert.equal(node.intent.status, 'failed');
  assert.equal(node.attempts.length, 2);
});

test('workerTimeoutMs converts a hung worker into a failed attempt', async () => {
  const board = new Blackboard({ sessionId: 'worker-timeout', goal: 'verify' });
  await board.createIntent({ description: 'fast check', keyPoints: ['verify'] });
  await board.createIntent({ description: 'hung check', keyPoints: ['verify'] });
  let fastResult;
  const completed = await new BlackboardCoordinator({
    blackboard: board,
    maxRounds: 6,
    workerTimeoutMs: 60,
    reason: async ({ context }) => {
      const fact = confirmedFact(context);
      return fact ? { complete: true, summary: 'Fast path verified', evidenceIds: [fact.ref] } : { wait: true };
    },
    worker: async ({ node }) => {
      if (node.intent.description === 'hung check') {
        // An uncooperative worker that never settles and ignores its signal.
        await new Promise(() => {});
      }
      fastResult ??= JSON.stringify(result({ statement: 'Fast path observed' }));
      return fastResult;
    }
  }).run();
  assert.equal(completed.complete, true);
  const hung = board.snapshot().nodes.find(item => item.intent?.description === 'hung check');
  assert.equal(hung.intent.status, 'failed');
  assert.match(hung.attempts[0].error, /exceeded 60ms/);
});

test('maxConcurrency beyond the board openIntents limit is rejected', () => {
  const board = new Blackboard({ sessionId: 'worker-config', goal: 'verify', openIntents: 2 });
  assert.throws(() => new BlackboardCoordinator({
    blackboard: board, reason: async () => ({}), worker: async () => '', maxConcurrency: 3
  }), /maxConcurrency cannot exceed/);
  assert.doesNotThrow(() => new BlackboardCoordinator({
    blackboard: board, reason: async () => ({}), worker: async () => '', maxConcurrency: 2
  }));
});
