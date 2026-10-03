import test from 'node:test';
import assert from 'node:assert/strict';
import { Blackboard } from '../blackboard.mjs';
import { buildBlackboardContext } from '../context.mjs';
import { BlackboardCoordinator } from '../coordinator.mjs';
import { parseReasonDecision } from '../../agents/protocol.mjs';
import { parseWorkerFact } from '../../worker-agents/protocol.mjs';

const result = (overrides = {}) => ({ version: 1, statement: 'Observed the scoped result', outcome: 'confirmed',
  coverage: [{ point: 'verify', status: 'confirmed', result: 'Passed' }],
  evidence: [{ toolCallId: 'check', observation: 'Control passed' }], nextSteps: [], ...overrides });
async function record(board, content, parentIds) {
  const intent = await board.createIntent({ description: 'inspect', keyPoints: ['verify'], parentIds });
  const attempt = await board.beginAttempt(intent.id);
  return board.completeAttempt(intent.id, attempt.id, content);
}

test('findings preserve partial discoveries, trace follow-ups, and do not promote notes or legacy text', async () => {
  const board = new Blackboard({ sessionId: 'index', goal: 'verify' });
  const partial = await record(board, JSON.stringify(result({ outcome: 'partial', coverage: [], nextSteps: ['Run control'] })));
  const verified = await record(board, JSON.stringify(result()), [partial.resultId]);
  const pending = await board.createIntent({ description: 'check remaining scope', parentIds: [partial.resultId] });
  const failed = await board.createIntent({ description: 'other method' });
  const attempt = await board.beginAttempt(failed.id);
  await board.failAttempt(failed.id, attempt.id, 'Unavailable');
  await board.createFact({ content: JSON.stringify(result()) });
  await record(board, 'Legacy observation');
  const snapshot = board.snapshot(), before = JSON.stringify(snapshot);
  const context = buildBlackboardContext(snapshot), index = context.data.exploration;
  assert.deepEqual(index.findings.map(item => [item.ref, item.completionEligible]), [
    [context.aliasFor(partial.resultId), false], [context.aliasFor(verified.resultId), true]
  ]);
  assert.deepEqual(index.gaps, [{ ref: context.aliasFor(partial.resultId), unresolvedKeyPoints: ['verify'],
    nextSteps: ['Run control'], followUpRefs: [context.aliasFor(verified.id), context.aliasFor(pending.id)] }]);
  assert.deepEqual(index.activeIntents, [context.aliasFor(pending.id)]);
  assert.deepEqual(index.failedIntents, [context.aliasFor(failed.id)]);
  assert.equal(JSON.stringify(snapshot), before);
  assert.equal(buildBlackboardContext(snapshot, { focusId: pending.id }).data.exploration, undefined);
  assert.deepEqual(buildBlackboardContext(Blackboard.fromSnapshot({ snapshot }).snapshot()).data.exploration, index);
});

test('malformed evidence cannot become an eligible core finding', async () => {
  const board = new Blackboard({ sessionId: 'malformed-index', goal: 'verify' });
  await record(board, JSON.stringify(result({ outcome: null, nextSteps: [null, {}, 'Missing check'] })));
  const index = buildBlackboardContext(board.snapshot()).data.exploration;
  assert.equal(index.findings[0].outcome, 'unknown');
  assert.equal(index.findings[0].completionEligible, false);
  assert.deepEqual(index.gaps[0].nextSteps, ['Missing check']);
});

test('exploration frontier tracks follow-up lifecycle without declaring unresolved sources closed', async () => {
  const board = new Blackboard({ sessionId: 'frontier', goal: 'verify' });
  const source = await record(board, JSON.stringify(result({ outcome: 'partial', coverage: [], nextSteps: ['Run control'] })));
  const frontier = () => {
    const context = buildBlackboardContext(board.snapshot());
    return { context, entry: context.data.exploration.frontier.find(item => item.sourceRef === context.aliasFor(source.resultId)) };
  };
  assert.equal(frontier().entry.status, 'unassigned');
  const follow = await board.createIntent({ description: 'Run control', parentIds: [source.resultId], keyPoints: ['verify'] });
  assert.equal(frontier().entry.status, 'in_progress');
  const attempt = await board.beginAttempt(follow.id);
  await board.failAttempt(follow.id, attempt.id, 'Control unavailable');
  assert.equal(frontier().entry.status, 'needs_replan');
  assert.deepEqual(frontier().entry.failedRefs, [frontier().context.aliasFor(follow.id)]);
  await board.retryIntent(follow.id);
  assert.equal(frontier().entry.status, 'in_progress');
  const retry = await board.beginAttempt(follow.id);
  const partial = await board.completeAttempt(follow.id, retry.id, JSON.stringify(result({ outcome: 'partial', coverage: [], nextSteps: ['Obtain missing control input'] })));
  const active = await board.createIntent({ description: 'Check another condition', parentIds: [source.resultId] });
  const failed = await board.createIntent({ description: 'Alternative source', parentIds: [source.resultId] });
  const failedAttempt = await board.beginAttempt(failed.id);
  await board.failAttempt(failed.id, failedAttempt.id, 'Unavailable');
  const { context, entry } = frontier();
  assert.deepEqual(entry, { sourceRef: context.aliasFor(source.resultId), status: 'review_results',
    resultRefs: [context.aliasFor(partial.resultId)], activeRefs: [context.aliasFor(active.id)], failedRefs: [context.aliasFor(failed.id)] });
  assert.equal(context.data.exploration.gaps.length, 2, 'neither the parent nor partial follow-up is silently closed');
  assert(context.data.exploration.frontier.some(item => item.sourceRef === context.aliasFor(partial.resultId) && item.status === 'unassigned'));
  const restored = Blackboard.fromSnapshot({ snapshot: board.snapshot() });
  assert.deepEqual(buildBlackboardContext(restored.snapshot()).data.exploration, context.data.exploration);
});

test('focused Workers see active peer work with valid ancestry but cannot cite plans as evidence', async () => {
  const board = new Blackboard({ sessionId: 'peer-context', goal: 'verify' });
  const source = await record(board, JSON.stringify(result()));
  const own = await board.createIntent({ description: 'Own check', parentIds: [source.resultId] });
  const peer = await board.createIntent({ description: 'Peer control', parentIds: [source.resultId] });
  await board.beginAttempt(peer.id);
  const before = board.snapshot();
  const context = buildBlackboardContext(before, { focusId: own.id });
  const peerRef = context.aliasFor(peer.id);
  assert.equal(context.data.focus, context.aliasFor(own.id));
  assert.equal(context.data.nodes.find(node => node.ref === peerRef).intent.status, 'running');
  for (const node of context.data.nodes) for (const ref of node.parents) assert(context.data.nodes.some(parent => parent.ref === ref));
  assert.throws(() => parseWorkerFact(JSON.stringify({ outcome: 'confirmed', statement: 'Peer must have verified it',
    evidence: [{ nodeRef: peerRef, observation: 'Planned check' }] }), { context }), { code: 'INVALID_FACT' });
  assert.deepEqual(board.snapshot(), before);
});

test('exploration follows a partial discovery to decisive evidence without rerunning covered work', async () => {
  const board = new Blackboard({ sessionId: 'close-gap', goal: 'verify with control' });
  const initial = await record(board, JSON.stringify(result({ outcome: 'partial',
    coverage: [{ point: 'verify', status: 'partial', result: 'Observation recorded; control missing' }],
    nextSteps: ['Run control'] })));
  const restored = Blackboard.fromSnapshot({ snapshot: board.snapshot() });
  const tasks = [];
  const completed = await new BlackboardCoordinator({ blackboard: restored,
    reason: async ({ context }) => {
      const index = context.data.exploration;
      const verified = index.findings.filter(finding => finding.completionEligible);
      const decision = verified.length
        ? { complete: true, evidenceIds: verified.map(finding => finding.ref), summary: 'Observation verified with control' }
        : { intents: [{ description: index.gaps[0].nextSteps[0], parentIds: [index.gaps[0].ref],
          priority: 'high', keyPoints: ['verify'] }] };
      return parseReasonDecision(JSON.stringify(decision), { context });
    },
    worker: async ({ node }) => {
      tasks.push(node.intent.description);
      assert.deepEqual(node.parentIds, [initial.resultId]);
      return JSON.stringify(result());
    }
  }).run();
  assert.equal(completed.complete, true);
  assert.deepEqual(tasks, ['Run control']);
  assert.equal(completed.evidenceIds.length, 1);
  assert.notEqual(completed.evidenceIds[0], initial.resultId);
});

test('combined results are reviewed once while waiting for genuinely new evidence', { timeout: 3000 }, async () => {
  const board = new Blackboard({ sessionId: 'coalesced', goal: 'verify all' });
  const counts = [];
  let releaseSlow;
  const slow = new Promise(resolve => { releaseSlow = resolve; });
  const result = await new BlackboardCoordinator({ blackboard: board, maxConcurrency: 3, maxRounds: 3,
    reason: async ({ context }) => {
      const facts = context.data.nodes.filter(node => node.kind === 'fact');
      counts.push(facts.length);
      if (!facts.length) return { intents: ['one', 'two', 'slow'].map(description => ({ description, keyPoints: ['verify'] })) };
      if (facts.length < 3) {
        // Let the already-completed sibling's notification drain before the
        // remaining worker publishes genuinely new evidence.
        setTimeout(releaseSlow, 30);
        return { wait: true };
      }
      return { complete: true, summary: 'All verified', evidenceIds: facts.map(node => node.ref) };
    },
    worker: async ({ node }) => {
      if (node.intent.description === 'slow') await slow;
      return 'verified';
    }
  }).run();
  assert.equal(result.complete, true);
  assert.deepEqual(counts, [0, 2, 3]);
  assert.equal(result.rounds, 3);
});
