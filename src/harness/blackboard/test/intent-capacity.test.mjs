import test from 'node:test';
import assert from 'node:assert/strict';
import { Blackboard } from '../blackboard.mjs';
import { buildBlackboardContext } from '../context.mjs';
import { BlackboardCoordinator } from '../coordinator.mjs';
import { parseReasonDecision } from '../../agents/protocol.mjs';
import { admitIntentProposals, fillIntentSlots, intentCapacity } from '../intent-capacity.mjs';
const specs = count => Array.from({ length: count }, (_, i) => ({ description: 'existing ' + i, keyPoints: ['verify'] }));
const proposal = (context, count) => JSON.stringify({ intents: Array.from({ length: count }, (_, i) => ({ description: 'new ' + i, parentIds: [context.data.root], priority: 'medium', keyPoints: ['verify'] })) });
for (let open = 0; open <= 5; open++) {
  test(`${open} open intents permits exactly ${5 - open} new intents`, async () => {
    const board = new Blackboard({ sessionId: 'capacity-' + open, goal: 'verify' });
    const nodes = await board.createIntents(specs(open));
    if (nodes.length) await board.beginAttempt(nodes[0].id);
    const context = buildBlackboardContext(board.snapshot());
    if (open < 5) {
      assert.equal(parseReasonDecision(proposal(context, 5 - open), { context }).intents.length, 5 - open);
      assert.equal(parseReasonDecision(proposal(context, 6 - open), { context }).intents.length, 5 - open);
    } else {
      assert.deepEqual(parseReasonDecision('{"wait":true}', { context }), { wait: true });
      assert.deepEqual(parseReasonDecision(proposal(context, 1), { context }), { wait: true });
    }
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

test('custom Reason overflow is admitted into remaining slots instead of aborting', async () => {
  const board = new Blackboard({ sessionId: 'custom-capacity', goal: 'verify' });
  let executed = 0;
  const result = await new BlackboardCoordinator({ blackboard: board,
    reason: async ({ context }) => {
      const facts = context.data.nodes.filter(node => node.kind === 'fact');
      const intents = context.data.nodes.filter(node => node.kind === 'intent');
      if (facts.length >= 5) return { complete: true, summary: 'verified', evidenceIds: facts.map(node => node.ref) };
      if (intents.length) return { wait: true };
      return JSON.parse(proposal(context, 6));
    },
    worker: async () => { executed++; return 'verified'; }
  }).run();
  assert.equal(result.complete, true);
  assert.equal(executed, 5);
  assert.equal(intentCapacity(board.snapshot().nodes).open, 0);
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
  assert.deepEqual(parseReasonDecision(proposal(context, 1), { context, openIntents: 8 }), { wait: true });
  const room = new Blackboard({ sessionId: 'custom-open-room', goal: 'verify', openIntents: 8 });
  const roomContext = buildBlackboardContext(room.snapshot());
  assert.equal(parseReasonDecision(proposal(roomContext, 8), { context: roomContext, openIntents: 8, maxIntents: 8 }).intents.length, 8);
});

test('fillIntentSlots keeps filling after a skipped invalid item', () => {
  const { admitted, errors } = fillIntentSlots([
    { priority: 'high', keep: false },
    { priority: 'low', keep: true }
  ], { available: 1, tryPrepare: item => { if (!item.keep) throw new Error('skip'); return item; } });
  assert.equal(admitted[0].keep, true);
  assert.equal(errors.length, 1);
});

test('admitIntentProposals keeps highest priority work and waits on a full board', () => {
  assert.deepEqual(admitIntentProposals([
    { priority: 'low', description: 'later' },
    { priority: 'high', description: 'first' },
    { priority: 'medium', description: 'mid' }
  ], { available: 2, maxIntents: 5 }).admitted.map(item => item.description), ['first', 'mid']);
  assert.deepEqual(admitIntentProposals([{ priority: 'high' }], { available: 0 }), { admitted: [], deferred: 1, wait: true, errors: [] });
  assert.deepEqual(admitIntentProposals([], { available: 0 }), { admitted: [], deferred: 0, wait: false, errors: [] });
});

test('Reason overflow prefers high-priority intents that fit remaining slots', async () => {
  const board = new Blackboard({ sessionId: 'priority-admit', goal: 'verify' });
  await board.createIntents(specs(4));
  const context = buildBlackboardContext(board.snapshot());
  const decision = parseReasonDecision(JSON.stringify({ intents: [
    { description: 'low leftover', parentIds: [context.data.root], priority: 'low', keyPoints: ['verify'] },
    { description: 'high keep', parentIds: [context.data.root], priority: 'high', keyPoints: ['verify'] }
  ] }), { context });
  assert.deepEqual(decision.intents.map(item => item.description), ['high keep']);
});

test('invalid or duplicate surplus intents do not poison remaining valid work', async () => {
  const board = new Blackboard({ sessionId: 'skip-invalid', goal: 'verify' });
  await board.createIntent({ description: 'same work', keyPoints: ['verify'] });
  const context = buildBlackboardContext(board.snapshot());
  const root = context.data.root;
  const decision = parseReasonDecision(JSON.stringify({ intents: [
    { description: 'bad high', parentIds: [root], priority: 'high', keyPoints: ['verify'], hint: 'nope' },
    { description: 'same work', parentIds: [root], priority: 'high', keyPoints: ['verify'] },
    { description: 'fresh low', parentIds: [root], priority: 'low', keyPoints: ['verify'] }
  ] }), { context });
  assert.deepEqual(decision.intents.map(item => item.description), ['fresh low']);
  assert.throws(() => parseReasonDecision(JSON.stringify({ intents: [
    { description: 'same work', parentIds: [root], priority: 'high', keyPoints: ['verify'] }
  ] }), { context }), /repeats/);
});

test('blackboard batch writes keep as many intents as remaining slots', async () => {
  const board = new Blackboard({ sessionId: 'partial-write', goal: 'verify' });
  await board.createIntents(specs(4));
  const created = await board.createIntents(specs(2));
  assert.equal(created.length, 1);
  assert.equal(intentCapacity(board.snapshot().nodes).open, 5);
  await assert.rejects(board.createIntents(specs(2)), { code: 'OPEN_INTENT_LIMIT' });
});

test('custom Reason skips poisoned items and still completes admitted work', async () => {
  const board = new Blackboard({ sessionId: 'skip-custom', goal: 'verify' });
  let executed = 0;
  const result = await new BlackboardCoordinator({ blackboard: board,
    reason: async ({ context }) => {
      const facts = context.data.nodes.filter(node => node.kind === 'fact');
      const intents = context.data.nodes.filter(node => node.kind === 'intent');
      if (facts.length >= 1) return { complete: true, summary: 'verified', evidenceIds: facts.map(node => node.ref) };
      if (intents.length) return { wait: true };
      return { intents: [
        { description: 'poison', parentIds: [context.data.root], priority: 'high', keyPoints: ['verify'], hint: 'no' },
        { description: 'keep', parentIds: [context.data.root], priority: 'low', keyPoints: ['verify'] }
      ] };
    },
    worker: async () => { executed++; return 'verified'; }
  }).run();
  assert.equal(result.complete, true);
  assert.equal(executed, 1);
});
