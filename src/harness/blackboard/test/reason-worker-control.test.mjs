import test from 'node:test';
import assert from 'node:assert/strict';
import { Blackboard } from '../blackboard.mjs';
import { BlackboardCoordinator } from '../coordinator.mjs';

const refFor = (context, prefix) => {
  const node = context.data.nodes.find(item => item.intent?.description.startsWith(prefix));
  assert(node, `intent ${prefix} exists`);
  return node.ref;
};
const facts = context => context.data.nodes.filter(node => node.kind === 'fact');

test('Reason can stop a running Worker and start it again from the same checkpoint', async () => {
  const board = new Blackboard({ sessionId: 'control-stop-start', goal: 'verify' });
  const slowAttempts = [];
  let phase = 0, stopRequested = false, restartRequested = false;
  const reason = async ({ context, control }) => {
    if (++phase === 1) {
      return { intents: [
        { description: 'quick evidence', parentIds: [context.data.root], keyPoints: ['quick'], priority: 'medium' },
        { description: 'slow evidence', parentIds: [context.data.root], keyPoints: ['slow'], priority: 'medium' }
      ] };
    }
    const slowRef = refFor(context, 'slow evidence');
    if (!stopRequested) {
      const workers = control.list();
      assert.equal(workers.find(worker => worker.worker === refFor(context, 'quick evidence')).status, 'completed');
      assert.equal(workers.find(worker => worker.worker === slowRef).status, 'running');
      const stopped = await control.stop(slowRef, 'no longer needed');
      assert.equal(stopped.stopped, true);
      assert.equal(stopped.status, 'stopping');
      stopRequested = true;
      return { wait: true };
    }
    const slow = control.list().find(worker => worker.worker === slowRef);
    if (!restartRequested && slow.status === 'interrupted') {
      assert.match(slow.failures?.at(-1)?.error ?? '', /no longer needed/);
      const started = await control.start(slowRef);
      assert.equal(started.started, true);
      restartRequested = true;
      return { wait: true };
    }
    if (facts(context).length >= 2) {
      return { complete: true, evidenceIds: facts(context).map(node => node.ref), summary: 'both facts recorded' };
    }
    return { wait: true };
  };
  const coordinator = new BlackboardCoordinator({ blackboard: board, maxConcurrency: 2, reason,
    worker: async args => {
      if (args.node.intent.description.startsWith('quick evidence')) return 'quick fact';
      slowAttempts.push(args.node.intent.description);
      if (slowAttempts.length === 1) return new Promise((resolve, reject) => args.signal.addEventListener('abort', () => reject(args.signal.reason), { once: true }));
      return 'slow fact';
    } });
  const result = await coordinator.run();
  assert.equal(result.complete, true);
  assert.equal(result.evidenceIds.length, 2);
  const slow = board.snapshot().nodes.find(node => node.intent?.description === 'slow evidence');
  assert.deepEqual(slow.attempts.map(attempt => attempt.status), ['interrupted', 'completed']);
});

test('Reason can steer a running Worker; the new direction is attached to the restarted attempt', async () => {
  const board = new Blackboard({ sessionId: 'control-prompt', goal: 'verify' });
  const directions = [];
  let phase = 0;
  const reason = async ({ context, control }) => {
    if (++phase === 1) {
      return { intents: [
        { description: 'quick evidence', parentIds: [context.data.root], keyPoints: ['quick'], priority: 'medium' },
        { description: 'browser evidence', parentIds: [context.data.root], keyPoints: ['browser'], priority: 'medium' }
      ] };
    }
    if (phase === 2) {
      const target = refFor(context, 'browser evidence');
      const directed = await control.prompt(target, 'Focus only on the TLS handshake and ignore login.');
      assert.equal(directed.directed, true);
      return { wait: true };
    }
    if (facts(context).length >= 2) return { complete: true, evidenceIds: facts(context).map(node => node.ref), summary: 'steered fact recorded' };
    return { wait: true };
  };
  const coordinator = new BlackboardCoordinator({ blackboard: board, maxConcurrency: 2, reason,
    worker: async ({ node, signal }) => {
      if (node.intent.description.startsWith('quick evidence')) return 'quick fact';
      directions.push(node.intent.description);
      if (directions.length === 1) return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      assert.match(node.intent.description, /Focus only on the TLS handshake/);
      return 'steered fact';
    } });
  const result = await coordinator.run();
  assert.equal(result.complete, true);
  assert.equal(result.evidenceIds.length, 2);
  const steered = board.snapshot().nodes.find(node => node.intent?.description === 'browser evidence');
  assert.deepEqual(steered.attempts.map(attempt => attempt.status), ['interrupted', 'completed']);
  assert.equal(directions.length, 2);
  // The durable intent text is never rewritten by steering.
  assert.equal(steered.intent.description, 'browser evidence');
});

test('Reason steers a queued Worker and stops another to free its slot', async () => {
  const board = new Blackboard({ sessionId: 'control-queued', goal: 'verify' });
  const lateDirections = [];
  let phase = 0;
  const reason = async ({ context, control }) => {
    if (++phase === 1) {
      return { intents: [
        { description: 'quick evidence', parentIds: [context.data.root], keyPoints: ['quick'], priority: 'medium' },
        { description: 'blocker evidence', parentIds: [context.data.root], keyPoints: ['blocker'], priority: 'medium' },
        { description: 'late evidence', parentIds: [context.data.root], keyPoints: ['late'], priority: 'medium' },
        { description: 'removed evidence', parentIds: [context.data.root], keyPoints: ['removed'], priority: 'medium' }
      ] };
    }
    if (phase === 2) {
      const lateRef = refFor(context, 'late evidence');
      const blockerRef = refFor(context, 'blocker evidence');
      const removedRef = refFor(context, 'removed evidence');
      assert.equal(control.list().find(worker => worker.worker === lateRef).status, 'pending');
      assert.equal(control.list().find(worker => worker.worker === removedRef).status, 'pending');
      const cancelled = await control.stop(removedRef, 'duplicate direction');
      assert.equal(cancelled.stopped, true);
      assert.equal(cancelled.status, 'interrupted');
      const directed = await control.prompt(lateRef, 'Include the remote port check.');
      assert.equal(directed.directed, true);
      const stopped = await control.stop(blockerRef, 'blocking the queue');
      assert.equal(stopped.stopped, true);
      return { wait: true };
    }
    if (facts(context).length >= 2) return { complete: true, evidenceIds: facts(context).map(node => node.ref), summary: 'queued work finished' };
    return { wait: true };
  };
  const coordinator = new BlackboardCoordinator({ blackboard: board, maxConcurrency: 2, reason,
    worker: async ({ node, signal }) => {
      if (node.intent.description.startsWith('quick evidence')) return 'quick fact';
      if (node.intent.description.startsWith('blocker evidence')) {
        return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      if (node.intent.description.startsWith('removed evidence')) assert.fail('a stopped queued worker must never start');
      lateDirections.push(node.intent.description);
      assert.match(node.intent.description, /Include the remote port check/);
      return 'late fact';
    } });
  const result = await coordinator.run();
  assert.equal(result.complete, true);
  assert.equal(result.evidenceIds.length, 2);
  assert.equal(lateDirections.length, 1);
  const removed = board.snapshot().nodes.find(node => node.intent?.description === 'removed evidence');
  assert.equal(removed.intent.status, 'interrupted');
  assert.deepEqual(removed.attempts.map(attempt => attempt.status), ['interrupted']);
});

test('Reason control rejects invalid targets and terminal Workers without breaking the review', async () => {
  const board = new Blackboard({ sessionId: 'control-errors', goal: 'verify' });
  let phase = 0;
  const reason = async ({ context, control }) => {
    if (++phase === 1) return { intents: [{ description: 'quick evidence', parentIds: [context.data.root], keyPoints: ['quick'], priority: 'medium' }] };
    const quickRef = refFor(context, 'quick evidence');
    await assert.rejects(control.start(quickRef), /already completed/);
    await assert.rejects(control.prompt(quickRef, 'more'), /already completed/);
    await assert.rejects(control.stop(quickRef), /only running or pending/);
    await assert.rejects(control.stop('n99'), /Unknown worker alias/);
    await assert.rejects(control.stop('worker-1'), /node alias/);
    assert.equal(control.list().filter(worker => worker.worker === quickRef).length, 1);
    return { complete: true, evidenceIds: facts(context).map(node => node.ref), summary: 'done' };
  };
  const result = await new BlackboardCoordinator({ blackboard: board, maxConcurrency: 1, reason, worker: async () => 'quick fact' }).run();
  assert.equal(result.complete, true);
});

test('cancelIntent stops queued work and remains retryable', async () => {
  const board = new Blackboard({ sessionId: 'cancel-intent', goal: 'verify' });
  const intent = await board.createIntent({ description: 'queued work', keyPoints: ['queued'] });
  const cancelled = await board.cancelIntent(intent.id, 'Reason stopped it before it started');
  assert.equal(cancelled.intent.status, 'interrupted');
  assert.equal(cancelled.attempts.length, 1);
  assert.equal(cancelled.attempts[0].status, 'interrupted');
  assert.match(cancelled.attempts[0].error, /before it started/);
  assert.deepEqual(Blackboard.fromSnapshot({ snapshot: board.snapshot() }).snapshot(), board.snapshot());
  await assert.rejects(board.cancelIntent(intent.id), /only pending intents/);
  const reopened = await board.retryIntent(intent.id);
  assert.equal(reopened.intent.status, 'pending');
  const attempt = await board.beginAttempt(intent.id);
  assert.equal((await board.completeAttempt(intent.id, attempt.id, 'queued fact')).intent.status, 'completed');
});
