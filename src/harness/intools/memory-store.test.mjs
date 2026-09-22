import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from './memory-store.mjs';
import { createHarness } from '../session_manager.mjs';

test('memory notifications follow persistence and isolate failing observers', async () => {
  let release;
  let fail = false;
  const store = new MemoryStore({ sessionId: 'live', persist: () => fail
    ? Promise.reject(new Error('disk failed')) : new Promise(resolve => { release = resolve; }) });
  const revisions = [];
  store.subscribe(() => { throw new Error('observer failed'); });
  store.subscribe(async () => { throw new Error('async observer failed'); });
  const unsubscribe = store.subscribe(event => revisions.push([event.revision, store.snapshot().revision]));
  const pending = store.registerWorker('worker');
  await Promise.resolve();
  assert.deepEqual(revisions, []);
  release(); await pending;
  assert.deepEqual(revisions, [[1, 1]]);
  await store.registerWorker('worker');
  assert.equal(revisions.length, 1, 'unchanged writes do not notify');
  fail = true;
  await assert.rejects(store.registerWorker('failed'), /disk failed/);
  assert.equal(revisions.length, 1);
  assert.equal(store.snapshot().revision, 1);
  unsubscribe(); fail = false;
  const next = store.registerWorker('next');
  await Promise.resolve(); release(); await next;
  assert.equal(revisions.length, 1);
});

test('session forwards durable memory changes and removes its subscription on close', async () => {
  const store = new MemoryStore({ sessionId: 'live-session' });
  const events = [];
  const session = await createHarness({ sessionId: store.sessionId, goal: 'Observe notes',
    reason: async () => ({}), worker: async () => 'done',
    intools: { store, allowedTools: ['note', 'todo'] }, onEvent: event => events.push(event) });
  try {
    await store.registerWorker('worker');
    assert.equal(events.at(-1).type, 'memory.changed');
    assert.equal(events.at(-1).revision, session.memory().revision);
  } finally { await session.close(); }
  const count = events.length;
  await store.registerWorker('after-close');
  assert.equal(events.length, count);
});
