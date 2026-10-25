import test from 'node:test';
import assert from 'node:assert/strict';
import { Blackboard } from '../blackboard.mjs';
import { BlackboardCoordinator } from '../coordinator.mjs';

const intent = (description, keyPoints = ['checked']) => ({ description, parentIds: ['n1'], priority: 'medium', keyPoints });

test('a repeated intent description is rejected even with different key points', async () => {
  const board = new Blackboard({ sessionId: 'dedupe-description', goal: 'verify' });
  await board.createIntent({ description: 'Inspect response headers', keyPoints: ['headers'] });
  const coordinator = new BlackboardCoordinator({ blackboard: board, worker: async () => 'never',
    reason: async () => ({ intents: [intent('inspect RESPONSE headers', ['cookies'])] }) });
  await assert.rejects(coordinator.run(), error => error.code === 'INVALID_DECISION' && /duplicates/.test(error.message));
  assert.equal(board.snapshot().nodes.filter(node => node.intent).length, 1);
});

test('agenda directions are enforced as duplicates before dispatch', async () => {
  const board = new Blackboard({ sessionId: 'dedupe-agenda', goal: 'verify' });
  const coordinator = new BlackboardCoordinator({ blackboard: board, worker: async () => 'never',
    duplicateTexts: async () => [{ text: 'Check cache poisoning via CDN edge', label: 'shared agenda direction' }],
    reason: async () => ({ intents: [intent('check CACHE poisoning via cdn edge')] }) });
  await assert.rejects(coordinator.run(), error => error.code === 'INVALID_DECISION' && /shared agenda/.test(error.message));
});

test('duplicate descriptions inside one decision admit only the first intent', async () => {
  const board = new Blackboard({ sessionId: 'dedupe-batch', goal: 'verify' });
  let calls = 0;
  const coordinator = new BlackboardCoordinator({ blackboard: board, worker: async () => 'observed fact',
    reason: async ({ context }) => {
      calls++;
      if (calls === 1) return { intents: [intent('Audit the edge cache', ['cache']), intent('audit the EDGE cache', ['headers'])] };
      const facts = context.data.nodes.filter(node => node.kind === 'fact');
      return facts.length ? { complete: true, evidenceIds: facts.map(node => node.ref), summary: 'done' } : { wait: true };
    } });
  const result = await coordinator.run();
  assert.equal(result.complete, true);
  assert.equal(board.snapshot().nodes.filter(node => node.intent).length, 1);
  assert.equal(board.snapshot().nodes.filter(node => node.kind === 'fact').length, 1);
});

test('duplicateTexts failures are advisory and do not stop planning', async () => {
  const board = new Blackboard({ sessionId: 'dedupe-advisory', goal: 'verify' });
  const coordinator = new BlackboardCoordinator({ blackboard: board, worker: async () => 'observed fact',
    duplicateTexts: async () => { throw new Error('agenda unavailable'); },
    reason: async ({ context }) => {
      if (context.data.nodes.some(node => node.kind === 'fact')) {
        return { complete: true, evidenceIds: context.data.nodes.filter(node => node.kind === 'fact').map(node => node.ref), summary: 'done' };
      }
      return { intents: [intent('Fresh useful check')] };
    } });
  assert.equal((await coordinator.run()).complete, true);
});
