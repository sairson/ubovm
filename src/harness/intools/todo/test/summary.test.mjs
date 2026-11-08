import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../../shared/store/memory-store.mjs';
import { createTodoTool } from '../index.mjs';
import { createInternalTools } from '../../runtime.mjs';

test('goal Worker summaries hide only their own host-managed plan items', async () => {
  const sessionId = 'todo-own-plan';
  const store = new MemoryStore({ sessionId });
  const own = createTodoTool({ store, sessionId, workerId: 'worker-a' });
  const peer = createTodoTool({ store, sessionId, workerId: 'worker-b' });
  await own.syncPlan('worker-a', [
    { id: '1', content: 'inspect host step', status: 'in_progress' },
    { id: '2', content: 'deploy service', status: 'pending' }
  ]);
  await peer.syncPlan('worker-b', [{ id: '1', content: 'peer investigation', status: 'pending' }]);
  await own.execute('t', { action: 'write', items: [{ content: 'own scratch note', status: 'in_progress' }] });

  const assist = own.summary('worker-a');
  assert.match(assist, /inspect host step/);
  assert.match(assist, /peer investigation/);
  assert.equal(own.summary('worker-a'), assist, 'assist mode keeps the current default');
  assert.equal(own.summary('worker-a', { ownPlan: true }), assist);

  const goal = own.summary('worker-a', { ownPlan: false });
  assert.doesNotMatch(goal, /inspect host step|deploy service/);
  assert.match(goal, /peer investigation/, 'other owners stay visible');
  assert.match(goal, /own scratch note/, 'the worker keeps todos it wrote itself');
  assert.match(goal, /# Session Todo Board/);
  assert.match(goal, /2 item\(s\) still open/);
});

test('a goal Worker with only its own plan items gets no board noise', async () => {
  const sessionId = 'todo-solo-plan';
  const solo = createTodoTool({ store: new MemoryStore({ sessionId }), sessionId, workerId: 'worker-c' });
  await solo.syncPlan('worker-c', [{ id: '1', content: 'only host step', status: 'in_progress' }]);
  assert.match(solo.summary('worker-c'), /only host step/);
  assert.equal(solo.summary('worker-c', { ownPlan: false }), '');
});

test('runtime hides a goal Worker plan but keeps the assist-mode board', async () => {
  const runtime = await createInternalTools({ sessionId: 'todo-runtime-' + process.pid });
  try {
    await runtime.onProgress({
      node: { id: 'goal-worker' }, phase: 'execute',
      plan: [{ description: 'inspect deployed page', doneWhen: 'reachable' }], completed: []
    });
    const goalText = await runtime.contextProvider({ node: { id: 'goal-worker', intent: { description: 'verify deployment' } } });
    assert.doesNotMatch(goalText, /inspect deployed page/, 'goal Worker plan comes from its phase assignment');
    const assistText = await runtime.contextProvider({ node: { id: 'goal-worker' } });
    assert.match(assistText, /inspect deployed page/, 'assist mode still receives the shared board');
  } finally {
    await runtime.close();
  }
});
