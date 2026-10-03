import test from 'node:test';
import assert from 'node:assert/strict';
import { Blackboard } from '../blackboard.mjs';
import { BlackboardCoordinator } from '../coordinator.mjs';
import { buildBlackboardContext } from '../context.mjs';
import { parseReasonDecision } from '../../agents/protocol.mjs';

const decisive = () => ({ version: 1, statement: 'Verified', outcome: 'confirmed',
  evidence: [{ toolCallId: 'check', observation: 'Test passed' }],
  coverage: [{ point: 'verify', status: 'confirmed', result: 'Passed' }] });
async function completed(content) {
  const board = new Blackboard({ sessionId: 'quality', goal: 'verify' });
  const intent = await board.createIntent({ description: 'inspect', keyPoints: ['verify'] });
  const attempt = await board.beginAttempt(intent.id);
  const done = await board.completeAttempt(intent.id, attempt.id, content);
  return { board, done };
}

test('model and custom Reason completion reject the same unresolved structured evidence', async () => {
  const variants = [
    f => { f.coverage = []; },
    f => { f.coverage = [null]; },
    f => { f.coverage[0].result = ' '; },
    f => { f.coverage.push({ ...f.coverage[0] }); },
    f => { f.coverage.push({ point: 'unassigned check', status: 'confirmed', result: 'Passed' }); },
    f => { f.failedChecks = 'not an auditable list'; },
    f => { f.limitations = [null]; },
    f => { f.statement = ''; },
    f => { f.evidence = [{}]; },
    f => { f.nextSteps = ['Run the missing control']; },
    f => { f.outcome = 'blocked'; },
  ];
  for (const mutate of variants) {
    const fact = decisive(); mutate(fact);
    const { board, done } = await completed(JSON.stringify(fact));
    const context = buildBlackboardContext(board.snapshot());
    const decision = { complete: true, summary: 'done', evidenceIds: [context.aliasFor(done.resultId)] };
    assert.throws(() => parseReasonDecision(JSON.stringify(decision), { context }), { code: 'INVALID_REASON_DECISION' });
    const coordinator = new BlackboardCoordinator({ blackboard: board, reason: async () => decision, worker: async () => assert.fail('No new execution') });
    await assert.rejects(coordinator.run(), { code: 'INVALID_COMPLETION' });
  }
});

test('decisive structured results and legacy text remain accepted by both boundaries', async () => {
  for (const content of [JSON.stringify(decisive()), 'Legacy verified observation']) {
    const { board, done } = await completed(content);
    const context = buildBlackboardContext(board.snapshot());
    const decision = { complete: true, summary: 'done', evidenceIds: [context.aliasFor(done.resultId)] };
    assert.equal(parseReasonDecision(JSON.stringify(decision), { context }).complete, true);
    const result = await new BlackboardCoordinator({ blackboard: board, reason: async () => decision, worker: async () => assert.fail() }).run();
    assert.deepEqual(result.evidenceIds, [done.resultId]);
  }
});

test('context exposes missing checks without altering durable facts or inventing goal completion', async () => {
  const fact = decisive(); fact.coverage = []; fact.outcome = 'partial';
  const content = JSON.stringify(fact), { board, done } = await completed(content);
  const snapshot = board.snapshot(), before = JSON.stringify(snapshot);
  const context = buildBlackboardContext(snapshot);
  const result = context.data.nodes.find(n => n.ref === context.aliasFor(done.resultId));
  assert.deepEqual(result.assessment.unresolvedKeyPoints, ['verify']);
  assert.match(result.assessment.completionIssue, /unresolved/);
  assert.equal(result.fact, content);
  assert.equal(JSON.stringify(snapshot), before);
});

test('historical intent parents and result parents identify the same work at both boundaries', async () => {
  const { board, done } = await completed('Source evidence');
  const existing = await board.createIntent({ description: 'Follow up', parentIds: [done.resultId], keyPoints: ['check'] });
  const attempt = await board.beginAttempt(existing.id);
  await board.failAttempt(existing.id, attempt.id, 'Needs host retry');
  const snapshot = board.snapshot();
  snapshot.nodes.find(n => n.id === existing.id).parentIds = [done.id];
  snapshot.nodes.find(n => n.id === done.resultId).childIds = [];
  snapshot.nodes.find(n => n.id === done.id).childIds.push(existing.id);
  const restored = Blackboard.fromSnapshot({ snapshot });
  const context = buildBlackboardContext(restored.snapshot());
  const decision = { intents: [{ description: 'follow UP', parentIds: [context.aliasFor(done.resultId)], keyPoints: ['CHECK'], priority: 'high' }] };
  assert.throws(() => parseReasonDecision(JSON.stringify(decision), { context }), /repeats/);
  await assert.rejects(new BlackboardCoordinator({ blackboard: restored, reason: async () => decision, worker: async () => assert.fail() }).run(), /duplicates/);
});
