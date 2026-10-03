import test from 'node:test';
import assert from 'node:assert/strict';
import { Blackboard } from '../blackboard.mjs';
import { BlackboardCoordinator } from '../coordinator.mjs';
import { buildBlackboardContext } from '../context.mjs';

test('peer progress is bounded, detached and excludes private checkpoint data', async () => {
  const board = new Blackboard({ sessionId: 'peers', goal: 'verify' });
  const own = await board.createIntent({ description: 'own' });
  const peer = await board.createIntent({ description: 'peer' });
  const attempt = await board.beginAttempt(peer.id);
  await board.saveCheckpoint(peer.id, attempt.id, {
    kind: 'ubovm.pi-worker', version: 1, intentId: peer.id, phase: 'execute',
    plan: [{ description: 'x'.repeat(1000) }], completed: [{ output: 'PRIVATE' }],
    messages: [{ content: 'PRIVATE' }], ledger: [{ args: 'PRIVATE', result: 'PRIVATE' }],
  });
  const context = buildBlackboardContext(board.snapshot(), { focusId: own.id });
  const observed = context.data.nodes.find(n => n.intent?.description === 'peer');
  assert.deepEqual(observed.progress, { phase: 'execute', completedSteps: 1, remainingSteps: 1, currentStep: 'x'.repeat(320) + '…' });
  assert.equal(context.text.includes('PRIVATE'), false);
  observed.progress.phase = 'done';
  observed.intent.status = 'completed';
  assert.equal(board.node(peer.id).intent.status, 'running');
  assert.equal(board.node(peer.id).attempts[0].checkpoint.phase, 'execute');
  await board.failAttempt(peer.id, attempt.id, 'interrupted', { interrupted: true });
  const refreshed = buildBlackboardContext(board.snapshot(), { focusId: own.id });
  const stopped = refreshed.data.nodes.find(n => n.ref === observed.ref);
  assert.equal(stopped.intent.status, 'interrupted');
  assert.equal(stopped.progress, undefined);
  assert.equal(observed.intent.status, 'completed'); // Old copies do not change either.
});

test('concurrent workers observe fresh peer progress with no peer write capability', { timeout: 3000 }, async () => {
  const board = new Blackboard({ sessionId: 'concurrent-peers', goal: 'verify' });
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  let staleRead;
  await new BlackboardCoordinator({ blackboard: board, maxConcurrency: 2,
    reason: ({ context }) => context.data.nodes.some(n => n.kind === 'fact')
      ? { complete: true, summary: 'verified', evidenceIds: context.data.nodes.filter(n => n.kind === 'fact').map(n => n.ref) }
      : { intents: ['observer', 'peer'].map(description => ({ description, parentIds: [context.data.root], keyPoints: ['verify'], priority: 'medium' })) },
    worker: async input => {
      const { node, attempt, getContext, saveCheckpoint } = input;
      if (node.intent.description === 'peer') {
        await saveCheckpoint({ kind: 'ubovm.pi-worker', version: 1, intentId: node.id, phase: 'execute', plan: [{ description: 'check evidence' }], completed: [] });
        release();
        return 'peer verified';
      }
      staleRead = getContext;
      const before = getContext();
      await ready;
      const after = getContext();
      assert.ok(after.revision > before.revision);
      const peer = after.data.nodes.find(n => n.intent?.description === 'peer');
      assert.equal(peer.progress.currentStep, 'check evidence');
      assert.equal(input.blackboard, undefined);
      assert.equal(input.cancelWorker, undefined);
      peer.intent.description = 'tampered';
      assert.equal(getContext().data.nodes.find(n => n.ref === peer.ref).intent.description, 'peer');
      assert.ok(attempt.id);
      return 'observer verified';
    },
  }).run();
  assert.throws(() => staleRead(), error => ['ATTEMPT_CLOSED', 'ABORT_ERR'].includes(error.code));
});
