import test from 'node:test';
import assert from 'node:assert/strict';
import { Blackboard } from '../blackboard.mjs';
import { BlackboardCoordinator } from '../coordinator.mjs';
import { parseReasonDecision } from '../../agents/protocol.mjs';
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const plan = context => ({ intents: ['fast', 'slow', 'queued'].map(description => ({ description, parentIds: [context.data.root], priority: 'medium', keyPoints: ['verify'] })) });
const facts = context => context.data.nodes.filter(node => node.kind === 'fact');
const done = context => parseReasonDecision(JSON.stringify({ complete: true, summary: 'Goal verified', evidenceIds: facts(context).map(node => node.ref) }), { context });

test('each completed worker triggers Reason; completion is delivered without aborting peers or launching queued work', { timeout: 3000 }, async () => {
  const board = new Blackboard({ sessionId: 'notify', goal: 'verify' });
  const ready = gate(), delivered = gate(), wrapUp = gate();
  const started = [], observations = [];
  let slowSignal, calls = 0;
  const coordinator = new BlackboardCoordinator({ blackboard: board, maxConcurrency: 2,
    reason: async ({ context }) => { calls++; return facts(context).length ? done(context) : plan(context); },
    worker: async ({ node, signal, onMessage, getMessages }) => {
      started.push(node.intent.description);
      if (node.intent.description === 'fast') { await ready.promise; return 'verified'; }
      slowSignal = signal;
      onMessage(message => { observations.push(message); delivered.resolve(); });
      ready.resolve();
      await delivered.promise;
      assert.equal(signal.aborted, false);
      assert.deepEqual(getMessages(), observations);
      await wrapUp.promise;
      return 'finished voluntary cleanup';
    }
  });
  let finished = false;
  const running = coordinator.run().then(result => { finished = true; return result; });
  await delivered.promise;
  assert.equal(calls, 2);
  assert.equal(finished, false);
  assert.equal(slowSignal.aborted, false);
  assert.equal(observations[0].type, 'goal_completed');
  assert.equal(observations[0].completion.summary, 'Goal verified');
  wrapUp.resolve();
  assert.equal((await running).complete, true);
  assert.deepEqual(started, ['fast', 'slow']);
  assert.equal(board.snapshot().nodes.filter(node => node.intent?.status === 'completed').length, 2);
});

test('Reason waits for existing workers and reviews their results separately', { timeout: 3000 }, async () => {
  const board = new Blackboard({ sessionId: 'reviews', goal: 'verify both' });
  const ready = gate(), release = gate();
  const counts = [];
  const result = await new BlackboardCoordinator({ blackboard: board, maxConcurrency: 2,
    reason: async ({ context }) => {
      const count = facts(context).length; counts.push(count);
      if (!count) return { intents: plan(context).intents.slice(0, 2) };
      if (count === 1) { setImmediate(release.resolve); return parseReasonDecision('{"wait":true}', { context }); }
      return done(context);
    },
    worker: async ({ node }) => {
      if (node.intent.description === 'fast') await ready.promise;
      else { ready.resolve(); await release.promise; }
      return 'verified ' + node.intent.description;
    }
  }).run();
  assert.equal(result.complete, true);
  assert.deepEqual(counts, [0, 1, 2]);
});

test('external cancellation still revokes running workers while waiting for advisory wrap-up', { timeout: 3000 }, async () => {
  const board = new Blackboard({ sessionId: 'cancel', goal: 'verify' });
  const controller = new AbortController(), ready = gate(), delivered = gate();
  const coordinator = new BlackboardCoordinator({ blackboard: board, maxConcurrency: 2,
    reason: async ({ context }) => facts(context).length ? done(context) : { intents: plan(context).intents.slice(0, 2) },
    worker: async ({ node, onMessage }) => {
      if (node.intent.description === 'fast') { await ready.promise; return 'verified'; }
      onMessage(() => delivered.resolve()); ready.resolve();
      return new Promise(() => {});
    }
  });
  const running = coordinator.run({ signal: controller.signal });
  const rejected = assert.rejects(running, { code: 'ABORT_ERR' });
  await delivered.promise; controller.abort(); await rejected;
  assert.equal(board.snapshot().nodes.find(node => node.intent?.description === 'slow').intent.status, 'interrupted');
});

test('checkpoint traffic during Reason evaluation does not discard an otherwise current decision', { timeout: 3000 }, async () => {
  const board = new Blackboard({ sessionId: 'checkpoint-review', goal: 'verify' });
  const ready = gate(), review = gate(), saved = gate(), delivered = gate();
  let calls = 0;
  const result = await new BlackboardCoordinator({ blackboard: board, maxConcurrency: 2, maxRounds: 2,
    reason: async ({ context }) => {
      calls++;
      if (!facts(context).length) return { intents: plan(context).intents.slice(0, 2) };
      review.resolve(); await saved.promise;
      return done(context);
    },
    worker: async ({ node, saveCheckpoint, onMessage }) => {
      if (node.intent.description === 'fast') { await ready.promise; return 'verified'; }
      onMessage(() => delivered.resolve()); ready.resolve();
      await review.promise; await saveCheckpoint({ phase: 'working' }); saved.resolve();
      await delivered.promise; return 'wrapped up';
    }
  }).run();
  assert.equal(result.complete, true);
  assert.equal(calls, 2);
});

test('new facts arriving during Reason evaluation invalidate its old completion decision', { timeout: 3000 }, async () => {
  const board = new Blackboard({ sessionId: 'stale-review', goal: 'verify' });
  const ready = gate(), release = gate(), committed = gate();
  let calls = 0;
  board.subscribe(event => { if (event.type === 'blackboard.intent.completed' && board.snapshot().nodes.filter(n => n.kind === 'fact').length === 2) committed.resolve(); });
  const result = await new BlackboardCoordinator({ blackboard: board, maxConcurrency: 2,
    reason: async ({ context }) => {
      calls++;
      if (!facts(context).length) return { intents: plan(context).intents.slice(0, 2) };
      if (facts(context).length === 1) { release.resolve(); await committed.promise; }
      return done(context);
    },
    worker: async ({ node }) => {
      if (node.intent.description === 'fast') await ready.promise;
      else { ready.resolve(); await release.promise; }
      return 'verified';
    }
  }).run();
  assert.equal(calls, 3);
  assert.equal(result.evidenceIds.length, 2);
});
