import test from 'node:test';
import assert from 'node:assert/strict';
import { Blackboard } from './blackboard.mjs';
import { BlackboardCoordinator } from './coordinator.mjs';
import { buildBlackboardContext } from './context.mjs';
import { parseReasonDecision } from '../agents/protocol.mjs';
import { createHarness } from '../session_manager.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('SQLite session restores independent evidence without dispatching completed work again', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ubovm-exploration-'));
  let session;
  t.after(async () => { await session?.close(); await rm(directory, { recursive: true, force: true }); });
  let workerCalls = 0;
  const options = { directory, sessionId: 'durable', goal: 'verify', intools: false, contextSummary: false,
    reason: async ({ context }) => {
      const facts = context.data.nodes.filter(n => n.kind === 'fact');
      return facts.length ? { complete: true, evidenceIds: facts.map(n => n.ref), summary: 'verified' }
        : { intents: [{ description: 'inspect', parentIds: [context.data.root], keyPoints: ['evidence'], priority: 'medium' }] };
    }, worker: async () => { workerCalls++; return 'observed evidence'; }
  };
  session = await createHarness(options);
  const result = await session.run(), snapshot = session.snapshot();
  assert.equal(result.complete, true);
  assert.equal(snapshot.nodes.find(n => n.id === result.evidenceIds[0]).kind, 'fact');
  await session.close();
  session = await createHarness(options);
  assert.equal(session.status, 'completed');
  assert.deepEqual(session.snapshot(), snapshot);
  assert.deepEqual(await session.run(), result);
  assert.equal(workerCalls, 1);
});

test('intent completion durably creates exactly one independent fact and round-trips', async () => {
  const persisted = [];
  const board = new Blackboard({ sessionId: 'separate', goal: 'verify', persist: async s => persisted.push(s) });
  const intent = await board.createIntent({ description: 'inspect', keyPoints: ['evidence'] });
  const attempt = await board.beginAttempt(intent.id);
  const completed = await board.completeAttempt(intent.id, attempt.id, 'observed evidence');
  assert.equal(completed.fact, null);
  const fact = board.node(completed.resultId);
  assert.equal(fact.kind, 'fact'); assert.equal(fact.producerId, intent.id);
  assert.deepEqual(fact.parentIds, [intent.id]); assert.equal(fact.fact.attemptId, attempt.id);
  assert.equal(persisted.at(-1).nodes.length, 3);
  await assert.rejects(board.completeAttempt(intent.id, attempt.id, 'duplicate'));
  assert.equal(board.snapshot().nodes.length, 3);
  const restored = Blackboard.fromSnapshot({ snapshot: board.snapshot() });
  assert.deepEqual(restored.snapshot(), board.snapshot());
  const next = await restored.createIntent({ description: 'follow up', parentIds: [intent.id] });
  assert.deepEqual(next.parentIds, [fact.id]);
  const corrupt = board.snapshot(); corrupt.nodes.find(n => n.id === fact.id).producerId = corrupt.rootId;
  assert.throws(() => Blackboard.fromSnapshot({ snapshot: corrupt }), /relationship/);
});

test('write failure rolls back intent completion and fact together; interruption creates no fact', async () => {
  let fail = false;
  const board = new Blackboard({ sessionId: 'atomic', goal: 'verify', persist: async () => { if (fail) throw Error('disk failure'); } });
  const intent = await board.createIntent({ description: 'inspect' }), attempt = await board.beginAttempt(intent.id);
  const before = board.snapshot(); fail = true;
  await assert.rejects(board.completeAttempt(intent.id, attempt.id, 'evidence'), /disk failure/);
  assert.deepEqual(board.snapshot(), before); fail = false;
  await board.failAttempt(intent.id, attempt.id, 'cancelled', { interrupted: true });
  assert.equal(board.snapshot().nodes.filter(n => n.kind === 'fact').length, 0);
});

test('Reason and coordinator plan from facts and complete with fact evidence after parallel work', async () => {
  const board = new Blackboard({ sessionId: 'parallel', goal: 'verify' });
  let calls = 0, active = 0, peak = 0;
  const coordinator = new BlackboardCoordinator({ blackboard: board, maxConcurrency: 2,
    reason: async ({ context }) => {
      calls++;
      if (calls === 1) return { intents: ['A', 'B'].map(description => ({ description, parentIds: [context.data.root], keyPoints: ['evidence'], priority: 'medium' })) };
      const facts = context.data.nodes.filter(n => n.kind === 'fact');
      assert.equal(facts.length, 2);
      assert(facts.every(n => n.producer && context.data.nodes.find(p => p.ref === n.producer).result === n.ref));
      return parseReasonDecision(JSON.stringify({ complete: true, evidenceIds: facts.map(n => n.ref), summary: 'verified' }), { context });
    },
    worker: async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 10)); active--; return 'confirmed evidence'; }
  });
  const result = await coordinator.run();
  assert.equal(result.complete, true); assert.equal(peak, 2);
  assert(result.evidenceIds.every(id => board.node(id).kind === 'fact'));
});

test('legacy results remain usable, but root and unexecuted intent cannot prove completion', async () => {
  const board = new Blackboard({ sessionId: 'legacy', goal: 'verify' });
  const intent = await board.createIntent({ description: 'inspect', keyPoints: ['evidence'] });
  const attempt = await board.beginAttempt(intent.id);
  await board.completeAttempt(intent.id, attempt.id, 'legacy evidence');
  const snapshot = board.snapshot(), oldIntent = snapshot.nodes.find(n => n.id === intent.id);
  oldIntent.fact = snapshot.nodes.find(n => n.id === oldIntent.resultId).fact;
  snapshot.nodes = snapshot.nodes.filter(n => n.id !== oldIntent.resultId); delete oldIntent.resultId;
  const restored = Blackboard.fromSnapshot({ snapshot }), context = buildBlackboardContext(restored.snapshot());
  const decision = evidenceIds => JSON.stringify({ complete: true, evidenceIds, summary: 'done' });
  assert(parseReasonDecision(decision([context.aliasFor(intent.id)]), { context }).complete);
  assert.throws(() => parseReasonDecision(decision([context.data.root]), { context }), /completed Worker fact/);
  const pending = await restored.createIntent({ description: 'unstarted', keyPoints: ['check'] });
  const updated = buildBlackboardContext(restored.snapshot());
  assert.throws(() => parseReasonDecision(JSON.stringify({ intents: [{ description: 'dependent', parentIds: [updated.aliasFor(pending.id)], priority: 'medium', keyPoints: ['check'] }] }), { context: updated }), /parents/);
});
