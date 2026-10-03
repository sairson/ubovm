import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../memory-store.mjs';
import { createHarness } from '../../../../session_manager.mjs';

test('commit publishes the saved state despite retained draft and adapter mutations', async () => {
  let release, draft, returned, saved;
  const store = new MemoryStore({ sessionId: 'isolated-commit', persist: async value => {
    saved = structuredClone(value);
    value.workers.length = 0;
    await new Promise(resolve => { release = resolve; });
  } });
  const revisions = [];
  store.subscribe(event => revisions.push(event.revision));
  const writing = store.commit(state => {
    draft = state;
    state.workers.push({ worker_id: 'worker', root_worker_id: 'root' });
    returned = { accepted: true };
    return returned;
  });
  await Promise.resolve();
  draft.workers[0].root_worker_id = 'late-change';
  draft.revision = 500;
  returned.accepted = false;
  assert.equal(store.snapshot().revision, 0);
  release();
  assert.deepEqual(await writing, { accepted: true });
  assert.deepEqual(store.snapshot(), saved);
  assert.deepEqual(revisions, [1]);
  assert.deepEqual(MemoryStore.fromSnapshot({ snapshot: saved }).snapshot(), store.snapshot());
});

test('invalid commit results and revision tampering fail before persistence', async () => {
  let writes = 0;
  const store = new MemoryStore({ sessionId: 'atomic-validation', persist: async () => { writes++; } });
  await assert.rejects(store.commit(state => {
    state.workers.push({ worker_id: 'bad', root_worker_id: 'bad' });
    return () => {};
  }), /clone/i);
  await assert.rejects(store.commit(state => { state.revision = 50; }), /managed by the store/);
  assert.equal(writes, 0);
  assert.equal(store.snapshot().revision, 0);
  assert.deepEqual(store.snapshot().workers, []);
  await store.registerWorker('good');
  assert.equal(writes, 1);
  assert.equal(store.snapshot().revision, 1);
});

test('selective reads isolate results and avoid cloning unrelated history', async t => {
  const store = new MemoryStore({ sessionId: 'selective' });
  await store.registerWorker('worker');
  await store.commit(state => {
    state.toolEvidence = Array.from({ length: 200 }, (_, i) => ({ workerId: i ? 'other' : 'worker', toolCallId: `call-${i}`, observations: 'x'.repeat(16384) }));
  });
  const original = globalThis.structuredClone;
  const copies = [];
  t.mock.method(globalThis, 'structuredClone', value => { copies.push(value); return original(value); });
  const selected = store.snapshot(['workers']);
  selected.workers[0].root_worker_id = 'changed';
  const evidence = store.toolEvidence('worker', 'call-0');
  evidence.observations = 'changed';
  const ids = store.toolCallIds('worker');
  ids.push('fake');
  await store.registerWorker('worker');
  assert.equal(copies.length, 2, 'registration and ID reads must not clone the full history');
  assert.deepEqual(Object.keys(copies[0]), ['workers']);
  assert.equal(copies[1].toolCallId, 'call-0');
  assert.equal(store.snapshot(['workers']).workers[0].root_worker_id, 'worker');
  assert.equal(store.toolEvidence('worker', 'call-0').observations.length, 16384);
  assert.deepEqual(store.toolCallIds('worker'), ['call-0']);
  assert.equal(store.toolEvidence('other', 'call-0'), undefined);
  assert.throws(() => store.snapshot(['__proto__']), /Snapshot fields/);
});

test('queued registration checks durable ownership and recovers after a failed write', async () => {
  let fail = true;
  const store = new MemoryStore({ sessionId: 'queued', persist: async () => {
    if (fail) { fail = false; throw new Error('disk unavailable'); }
  } });
  const failed = store.registerWorker('child', { rootWorkerId: 'first' });
  const succeeded = store.registerWorker('child', { rootWorkerId: 'second' });
  await assert.rejects(failed, /disk unavailable/);
  await succeeded;
  const conflict = store.registerWorker('child', { rootWorkerId: 'first' });
  const duplicate = store.registerWorker('child', { rootWorkerId: 'second' });
  await assert.rejects(conflict, /ownership/);
  await duplicate;
  assert.equal(store.snapshot().revision, 1);
  assert.deepEqual(store.snapshot().workers, [{ worker_id: 'child', root_worker_id: 'second' }]);
});

test('restored memory rejects duplicate worker ownership and missing roots', async () => {
  const store = new MemoryStore({ sessionId: 'workers' });
  await store.registerWorker('child', { rootWorkerId: 'root' });
  const snapshot = store.snapshot();
  snapshot.workers.push({ worker_id: 'child', root_worker_id: 'other' });
  assert.throws(() => MemoryStore.fromSnapshot({ snapshot }), /Duplicate memory worker/);
  snapshot.workers = [{ worker_id: 'child' }];
  assert.throws(() => MemoryStore.fromSnapshot({ snapshot }), /root_worker_id/);
  assert.deepEqual(MemoryStore.fromSnapshot({ snapshot: store.snapshot() }).snapshot(), store.snapshot());
});

test('accidental async mutators cannot persist writes or cause unhandled rejections', async () => {
  let persisted = 0;
  const store = new MemoryStore({ sessionId: 'async-mutator', persist: async () => { persisted++; } });
  await assert.rejects(store.commit(async state => {
    await Promise.resolve();
    state.workers.push({ worker_id: 'bad', root_worker_id: 'bad' });
    throw new Error('late mutation failure');
  }), /must be synchronous/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(persisted, 0);
  assert.deepEqual(store.snapshot().workers, []);
  await store.registerWorker('good');
  assert.equal(persisted, 1);
});

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
