import test from 'node:test';
import assert from 'node:assert/strict';
import { Blackboard } from '../blackboard.mjs';
import { buildBlackboardContext } from '../context.mjs';
import { BlackboardCoordinator, orderPendingIntents, frontierLaunchRank } from '../coordinator.mjs';

const result = (overrides = {}) => ({ version: 1, statement: 'Observed the scoped result', outcome: 'confirmed',
  coverage: [{ point: 'verify', status: 'confirmed', result: 'Passed' }],
  evidence: [{ toolCallId: 'check', observation: 'Control passed' }], nextSteps: [], ...overrides });

async function record(board, content, parentIds) {
  const intent = await board.createIntent({ description: 'inspect', keyPoints: ['verify'], parentIds });
  const attempt = await board.beginAttempt(intent.id);
  return board.completeAttempt(intent.id, attempt.id, content);
}

test('orderPendingIntents prefers gap-closing work over higher-priority unrelated intents', async () => {
  const board = new Blackboard({ sessionId: 'frontier-order', goal: 'verify' });
  const gap = await record(board, JSON.stringify(result({
    outcome: 'partial',
    coverage: [{ point: 'verify', status: 'partial', result: 'Need control' }],
    nextSteps: ['Run control']
  })));
  const unrelated = await board.createIntent({ description: 'unrelated branch', priority: 'high', keyPoints: ['verify'], parentIds: [board.snapshot().rootId] });
  const closing = await board.createIntent({ description: 'Run control', priority: 'medium', keyPoints: ['verify'], parentIds: [gap.resultId] });
  const ordered = orderPendingIntents(board.pendingIntents(), board.snapshot());
  assert.deepEqual(ordered.map(node => node.id), [closing.id, unrelated.id]);
  const context = buildBlackboardContext(board.snapshot());
  assert.equal(frontierLaunchRank(closing, context) < frontierLaunchRank(unrelated, context), true);
});

test('launch runs gap-closing pending intent first when maxConcurrency is 1', async () => {
  const board = new Blackboard({ sessionId: 'frontier-launch', goal: 'verify control' });
  const gap = await record(board, JSON.stringify(result({
    outcome: 'partial',
    coverage: [{ point: 'verify', status: 'partial', result: 'Need control' }],
    nextSteps: ['Run control']
  })));
  await board.createIntent({ description: 'unrelated branch', priority: 'high', keyPoints: ['verify'], parentIds: [board.snapshot().rootId] });
  await board.createIntent({ description: 'Run control', priority: 'low', keyPoints: ['verify'], parentIds: [gap.resultId] });
  const started = [];
  const completed = await new BlackboardCoordinator({
    blackboard: board,
    maxConcurrency: 1,
    maxRounds: 4,
    reason: async ({ context }) => {
      const facts = context.data.nodes.filter(node => node.kind === 'fact' && node.assessment?.completionIssue === null);
      const eligible = facts.filter(node => {
        try {
          const parsed = JSON.parse(node.fact);
          return parsed.outcome === 'confirmed';
        } catch { return false; }
      });
      if (eligible.length) {
        return { complete: true, summary: 'Control verified', evidenceIds: [eligible.at(-1).ref] };
      }
      return { wait: true };
    },
    worker: async ({ node }) => {
      started.push(node.intent.description);
      if (node.intent.description === 'Run control') {
        return JSON.stringify(result());
      }
      return JSON.stringify(result({
        outcome: 'partial',
        coverage: [{ point: 'verify', status: 'partial', result: 'Unrelated observation' }],
        nextSteps: ['Still need control']
      }));
    }
  }).run();
  assert.equal(started[0], 'Run control');
  assert.equal(completed.complete, true);
});

test('needs_replan lineage outranks review_results when both are pending', async () => {
  const board = new Blackboard({ sessionId: 'frontier-replan', goal: 'verify' });
  const source = await record(board, JSON.stringify(result({
    outcome: 'partial',
    coverage: [],
    nextSteps: ['Retry method']
  })));
  const failed = await board.createIntent({ description: 'failed method', parentIds: [source.resultId], keyPoints: ['verify'] });
  const attempt = await board.beginAttempt(failed.id);
  await board.failAttempt(failed.id, attempt.id, 'Unavailable');
  const reviewSource = await record(board, JSON.stringify(result({
    outcome: 'partial',
    coverage: [],
    nextSteps: ['Inspect prior result']
  })), [source.resultId]);
  const reviewed = await record(board, JSON.stringify(result({
    outcome: 'partial',
    coverage: [],
    nextSteps: ['Still open']
  })), [reviewSource.resultId]);
  const replan = await board.createIntent({ description: 'new method', priority: 'low', parentIds: [source.resultId], keyPoints: ['verify'] });
  const review = await board.createIntent({ description: 'review prior', priority: 'high', parentIds: [reviewSource.resultId], keyPoints: ['verify'] });
  void reviewed;
  const ordered = orderPendingIntents(board.pendingIntents(), board.snapshot());
  assert.equal(ordered[0].id, replan.id);
  assert.equal(ordered.map(node => node.id).includes(review.id), true);
});
