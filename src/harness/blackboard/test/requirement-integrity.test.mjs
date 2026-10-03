import test from 'node:test';
import assert from 'node:assert/strict';
import { Blackboard, normalizeKeyPoints } from '../blackboard.mjs';
import { BlackboardCoordinator } from '../coordinator.mjs';
import { parseReasonDecision } from '../../agents/protocol.mjs';
import { parseWorkerFact } from '../../worker-agents/protocol.mjs';

test('long acceptance conditions survive planning, execution, evidence validation and restore', async () => {
  const prefix = '检查指定目标在以下条件下的完整行为：'.repeat(15);
  const points = [prefix + '必须保留用户草稿', prefix + '必须保留会话隔离'];
  const board = new Blackboard({ sessionId: 'requirements', goal: 'Verify both acceptance conditions' });
  const completed = await new BlackboardCoordinator({ blackboard: board,
    reason: async ({ context }) => {
      const facts = context.data.nodes.filter(node => node.kind === 'fact');
      return parseReasonDecision(JSON.stringify(facts.length
        ? { complete: true, evidenceIds: facts.map(node => node.ref), summary: 'Both conditions verified' }
        : { intents: [{ description: 'Verify requirements', parentIds: [context.data.root], priority: 'high', keyPoints: points }] }), { context });
    },
    worker: async ({ node }) => {
      assert.deepEqual(node.intent.keyPoints, points);
      const fact = parseWorkerFact(JSON.stringify({ outcome: 'confirmed', statement: 'Both conditions verified',
        coverage: points.map(point => ({ point, status: 'confirmed', result: 'Observed passing control' })),
        evidence: [{ toolCallId: 'verify', observation: 'Both checks passed' }] }), {
        keyPoints: node.intent.keyPoints, ledger: [{ toolCallId: 'verify', status: 'completed', isError: false }]
      });
      return JSON.stringify(fact);
    }
  }).run();
  assert.equal(completed.complete, true);
  const restored = Blackboard.fromSnapshot({ snapshot: board.snapshot() });
  assert.deepEqual(restored.snapshot().nodes.find(node => node.intent).intent.keyPoints, points);
  assert.deepEqual(JSON.parse(restored.node(completed.evidenceIds[0]).fact.content).coverage.map(item => item.point), points);
});

test('key point normalization preserves the supported boundary and explicitly rejects overflow', () => {
  const boundary = '字'.repeat(2048);
  assert.deepEqual(normalizeKeyPoints([boundary]), [boundary]);
  assert.deepEqual(normalizeKeyPoints(['  First\ncheck ', 'first check', 'Second check']), ['First check', 'Second check']);
  assert.throws(() => normalizeKeyPoints(['字'.repeat(2049)]), /2048/);
  assert.throws(() => normalizeKeyPoints(Array.from({ length: 7 }, (_, index) => `check ${index}`)), /6 distinct/);
});

test('invalid task batches do not persist a shortened or partially created plan', async () => {
  const board = new Blackboard({ sessionId: 'atomic-requirements', goal: 'verify' });
  const before = board.snapshot();
  await assert.rejects(async () => board.createIntents([
    { description: 'valid', keyPoints: ['verify'] },
    { description: 'invalid', keyPoints: Array.from({ length: 7 }, (_, index) => `check ${index}`) }
  ]), /6 distinct/);
  assert.deepEqual(board.snapshot(), before);
});

test('custom planners cannot silently drop excess requirements before dispatch', async () => {
  const board = new Blackboard({ sessionId: 'custom-requirements', goal: 'verify' });
  await assert.rejects(new BlackboardCoordinator({ blackboard: board,
    reason: async () => ({ intents: [{ description: 'inspect', keyPoints: ['x'.repeat(2049)] }] }),
    worker: async () => assert.fail('Invalid requirements must never execute')
  }).run(), error => error.code === 'INVALID_DECISION' && /2048/.test(error.message));
  assert.equal(board.snapshot().nodes.length, 1);
});
