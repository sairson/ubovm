import test from 'node:test';
import assert from 'node:assert/strict';
import { Blackboard } from '../blackboard.mjs';
import { buildBlackboardContext } from '../context.mjs';
import { BlackboardCoordinator } from '../coordinator.mjs';
import { parseReasonDecision } from '../../agents/protocol.mjs';
import { intentCapacity } from '../intent-capacity.mjs';
const specs = count => Array.from({ length: count }, (_, i) => ({ description: 'existing ' + i, keyPoints: ['verify'] }));
const proposal = (context, count) => JSON.stringify({ intents: Array.from({ length: count }, (_, i) => ({ description: 'new ' + i, parentIds: [context.data.root], priority: 'medium', keyPoints: ['verify'] })) });
for (let open = 0; open <= 5; open++) {
  test(`${open} open intents permits exactly ${5 - open} new intents`, async () => {
    const board = new Blackboard({ sessionId: 'capacity-' + open, goal: 'verify' });
    const nodes = await board.createIntents(specs(open));
    if (nodes.length) await board.beginAttempt(nodes[0].id);
    const context = buildBlackboardContext(board.snapshot());
    if (open < 5) assert.equal(parseReasonDecision(proposal(context, 5 - open), { context }).intents.length, 5 - open);
    else assert.deepEqual(parseReasonDecision('{"wait":true}', { context }), { wait: true });
    assert.throws(() => parseReasonDecision(proposal(context, 6 - open), { context }), /open intents/);
  });
}

test('atomic concurrent writes cannot consume the same final slot', async () => {
  const board = new Blackboard({ sessionId: 'atomic-capacity', goal: 'verify' });
  await board.createIntents(specs(4));
  const results = await Promise.allSettled([board.createIntent({ description: 'A' }), board.createIntent({ description: 'B' })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'OPEN_INTENT_LIMIT');
  assert.equal(intentCapacity(board.snapshot().nodes).open, 5);
  const before = board.snapshot();
  await assert.rejects(board.createIntents(specs(2)), { code: 'OPEN_INTENT_LIMIT' });
  assert.deepEqual(board.snapshot(), before);
});

test('terminal intents release slots and retry must reacquire a slot', async () => {
  const board = new Blackboard({ sessionId: 'released-capacity', goal: 'verify' });
  const nodes = await board.createIntents(specs(5));
  for (let i = 0; i < 3; i++) {
    const attempt = await board.beginAttempt(nodes[i].id);
    if (i === 0) await board.completeAttempt(nodes[i].id, attempt.id, 'verified');
    else await board.failAttempt(nodes[i].id, attempt.id, 'failed', { interrupted: i === 2 });
  }
  assert.equal(intentCapacity(board.snapshot().nodes).available, 3);
  await board.createIntents(specs(3));
  await assert.rejects(board.retryIntent(nodes[1].id), { code: 'OPEN_INTENT_LIMIT' });
  assert.equal(board.node(nodes[1].id).intent.status, 'failed');
});

test('custom Reason callbacks cannot bypass the model parser capacity limit', async () => {
  const board = new Blackboard({ sessionId: 'custom-capacity', goal: 'verify' });
  let executed = 0;
  await assert.rejects(new BlackboardCoordinator({ blackboard: board,
    reason: async ({ context }) => JSON.parse(proposal(context, 6)),
    worker: async () => { executed++; return 'verified'; }
  }).run(), { code: 'OPEN_INTENT_LIMIT' });
  assert.equal(executed, 0);
  assert.equal(board.snapshot().nodes.length, 1);
});

test('resuming more than five failed intents reopens them as capacity becomes available', async () => {
  const board = new Blackboard({ sessionId: 'resume-capacity', goal: 'verify all' });
  for (let i = 0; i < 7; i++) {
    const node = await board.createIntent({ description: 'retry ' + i });
    const attempt = await board.beginAttempt(node.id);
    await board.failAttempt(node.id, attempt.id, 'interrupted', { interrupted: true });
  }
  let peak = 0;
  board.subscribe(() => { peak = Math.max(peak, intentCapacity(board.snapshot().nodes, board.openIntents).open); });
  const result = await new BlackboardCoordinator({ blackboard: board, maxConcurrency: 2,
    reason: async ({ context }) => {
      const facts = context.data.nodes.filter(node => node.kind === 'fact');
      return facts.length === 7 ? { complete: true, summary: 'all verified', evidenceIds: facts.map(node => node.ref) } : { wait: true };
    },
    worker: async () => 'verified'
  }).run({ resume: true });
  assert.equal(result.complete, true);
  assert.equal(result.evidenceIds.length, 7);
  assert.equal(peak, 5);
});

test('custom openIntents raises the hard capacity for board writes and Reason parsing', async () => {
  const board = new Blackboard({ sessionId: 'custom-open', goal: 'verify', openIntents: 8 });
  assert.equal(board.openIntents, 8);
  await board.createIntents(specs(8));
  assert.equal(intentCapacity(board.snapshot().nodes, board.openIntents).available, 0);
  await assert.rejects(board.createIntent({ description: 'overflow' }), { code: 'OPEN_INTENT_LIMIT' });
  const context = buildBlackboardContext(board.snapshot());
  assert.throws(() => parseReasonDecision(proposal(context, 1), { context, openIntents: 8 }), /open intents/);
  const room = new Blackboard({ sessionId: 'custom-open-room', goal: 'verify', openIntents: 8 });
  const roomContext = buildBlackboardContext(room.snapshot());
  assert.equal(parseReasonDecision(proposal(roomContext, 8), { context: roomContext, openIntents: 8, maxIntents: 8 }).intents.length, 8);
});
