import assert from 'node:assert/strict';
import test from 'node:test';
import { createSwarm } from './swarm.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const invoke = async (swarm, name, input = {}, workerId, signal) => {
  const tool = swarm.toolsFor(workerId).find(item => item.name === name);
  return (await tool.execute('test', input, signal)).details;
};
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('workers return immediately, share a concurrency bound, and expose results and errors', async () => {
  const gates = [deferred(), deferred(), deferred()];
  const started = [], events = [];
  let active = 0, peak = 0;
  const swarm = createSwarm({ sessionId: 'root', maxConcurrency: 2, onEvent: event => events.push(event),
    runWorker: async ({ task }) => {
      active++;
      peak = Math.max(peak, active);
      const index = Number(task);
      started.push(index);
      try { await gates[index].promise; if (index === 1) throw new Error('expected failure'); return `result ${index}`; }
      finally { active--; }
    } });
  const ids = [];
  for (const task of ['0', '1', '2']) ids.push((await invoke(swarm, 'spawn_worker', { task })).worker_id);
  await nextTurn();
  assert.deepEqual(started, [0, 1]);
  assert.equal((await invoke(swarm, 'wait_workers', { timeout_ms: 0 })).timed_out, true);
  gates[0].resolve();
  await nextTurn();
  assert.deepEqual(started, [0, 1, 2]);
  gates[1].resolve();
  gates[2].resolve();
  const workers = await swarm.settle();
  assert.equal(peak, 2);
  assert.deepEqual(workers.map(worker => worker.id), ids);
  assert.deepEqual(workers.map(worker => worker.status), ['completed', 'failed', 'completed']);
  assert.equal(workers[0].result, 'result 0');
  assert.equal(workers[1].error, 'expected failure');
  assert.ok(events.every(event => event.type === 'swarm.status'));
  assert.equal((await invoke(swarm, 'wait_workers')).timed_out, false);
  await swarm.close();
});

test('nested explicit waits and completion barriers release their concurrency slots', { timeout: 3000 }, async () => {
  let swarm;
  const events = [];
  swarm = createSwarm({ sessionId: 'root', maxConcurrency: 1, maxDepth: 3, onEvent: event => events.push(event),
    runWorker: async ({ workerId, task }) => {
      if (task === 'grandchild') return 'leaf';
      const taskName = task === 'parent' ? 'child' : 'grandchild';
      const child = await invoke(swarm, 'spawn_worker', { task: taskName }, workerId);
      if (task === 'parent') {
        const output = await invoke(swarm, 'wait_workers', { worker_ids: [child.worker_id] }, workerId);
        assert.equal(output.workers[0].result, 'child done');
      } else {
        const output = await swarm.settle(workerId);
        assert.equal(output[0].result, 'leaf');
      }
      return `${task} done`;
    } });
  await invoke(swarm, 'spawn_worker', { task: 'parent' });
  const workers = await swarm.settle();
  assert.deepEqual(workers.map(worker => worker.result), ['parent done', 'child done', 'leaf']);
  assert.ok(events.some(event => event.workers.some(worker => worker.status === 'waiting')));
  assert.ok(events.every(event => event.workers.filter(worker => worker.status === 'running').length <= 1));
  await swarm.close();
});

test('depth, total-worker and descendant ownership limits are enforced', async () => {
  const gate = deferred();
  const swarm = createSwarm({ sessionId: 'root', maxConcurrency: 2, maxDepth: 1, maxWorkers: 2,
    runWorker: () => gate.promise });
  const first = await invoke(swarm, 'spawn_worker', { task: 'first' });
  const second = await invoke(swarm, 'spawn_worker', { task: 'second' });
  await assert.rejects(invoke(swarm, 'spawn_worker', { task: 'third' }), /limited to 2 workers/);
  await assert.rejects(invoke(swarm, 'spawn_worker', { task: 'child' }, first.worker_id), /nesting/);
  for (const target of ['root', first.worker_id, second.worker_id, 'missing']) {
    await assert.rejects(invoke(swarm, 'wait_workers', { worker_ids: [target] }, first.worker_id), /outside your descendants/);
  }
  assert.deepEqual((await invoke(swarm, 'list_workers', {}, first.worker_id)).workers, []);
  await assert.rejects(invoke(swarm, 'wait_workers', { timeout_ms: 60001 }), /timeout_ms/);
  gate.resolve('done');
  await swarm.settle();
  await swarm.close();
});

test('requests and dispatches are durable before worker execution', async () => {
  const saves = [], dispatchGate = deferred(), started = deferred();
  const swarm = createSwarm({ sessionId: 'root', persist: async state => {
    saves.push(state);
    if (state.workers.some(worker => worker.status === 'running')) await dispatchGate.promise;
  }, runWorker: async () => { started.resolve(); return 'done'; } });
  const spawned = await invoke(swarm, 'spawn_worker', { task: 'persist first' });
  let didStart = false;
  started.promise.then(() => { didStart = true; });
  await nextTurn();
  assert.equal(didStart, false);
  assert.ok(saves.some(state => state.workers.some(worker => worker.id === spawned.worker_id && worker.status === 'queued')));
  dispatchGate.resolve();
  await started.promise;
  await swarm.settle();
  assert.equal(saves.at(-1).workers[0].result, 'done');
  await swarm.close();
});

test('failed persistence prevents external work from launching', async () => {
  let invoked = 0;
  const swarm = createSwarm({ sessionId: 'root', persist: async state => {
    if (state.workers.some(worker => worker.status === 'running')) throw new Error('disk full');
  }, runWorker: async () => { invoked++; return 'unexpected'; } });
  await invoke(swarm, 'spawn_worker', { task: 'save dispatch first' });
  await assert.rejects(swarm.settle(), /disk full/);
  assert.equal(invoked, 0);
  assert.equal(swarm.snapshot().workers[0].status, 'failed');
  await assert.rejects(swarm.close(), /disk full/);
});

test('restored workers are never replayed and do not consume the new turn budget', async () => {
  let invoked = 0;
  const state = { sessionId: 'root', workers: ['queued', 'running', 'waiting', 'completed'].map((status, index) => ({
    id: `old-${index}`, parentId: 'root', task: 'old', depth: 1, status,
  })) };
  const swarm = createSwarm({ sessionId: 'root', state, maxWorkers: 1, runWorker: async () => { invoked++; return 'fresh'; } });
  assert.deepEqual(swarm.snapshot().workers.map(worker => worker.status), ['interrupted', 'interrupted', 'interrupted', 'completed']);
  await invoke(swarm, 'spawn_worker', { task: 'new' });
  const workers = await swarm.settle();
  assert.equal(invoked, 1);
  assert.equal(workers.at(-1).result, 'fresh');
  await swarm.close();
});

test('close aborts running workers, cancels queued workers, and awaits cleanup', async () => {
  const started = deferred(), cleaned = deferred(), cleanupGate = deferred();
  let invoked = 0;
  const swarm = createSwarm({ sessionId: 'root', maxConcurrency: 1, runWorker: async ({ signal }) => {
    invoked++;
    started.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    await cleanupGate.promise;
    cleaned.resolve();
    signal.throwIfAborted();
  } });
  await invoke(swarm, 'spawn_worker', { task: 'running' });
  await invoke(swarm, 'spawn_worker', { task: 'queued' });
  await started.promise;
  let closed = false;
  const closing = swarm.close().then(() => { closed = true; });
  await nextTurn();
  assert.equal(closed, false);
  cleanupGate.resolve();
  await closing;
  await cleaned.promise;
  assert.equal(invoked, 1);
  assert.deepEqual(swarm.snapshot().workers.map(worker => worker.status), ['interrupted', 'interrupted']);
  await assert.rejects(invoke(swarm, 'spawn_worker', { task: 'too late' }), /closed/);
});

test('external cancellation interrupts a child waiting on a descendant without deadlock', { timeout: 3000 }, async () => {
  const controller = new AbortController(), leafStarted = deferred();
  let swarm;
  swarm = createSwarm({ sessionId: 'root', maxConcurrency: 1, signal: controller.signal,
    runWorker: async ({ workerId, task, signal }) => {
      if (task === 'parent') {
        await invoke(swarm, 'spawn_worker', { task: 'leaf' }, workerId);
        await swarm.settle(workerId);
        return 'unexpected';
      }
      leafStarted.resolve();
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      signal.throwIfAborted();
    } });
  await invoke(swarm, 'spawn_worker', { task: 'parent' });
  await leafStarted.promise;
  controller.abort(new Error('stop'));
  await swarm.close();
  assert.deepEqual(swarm.snapshot().workers.map(worker => worker.status), ['interrupted', 'interrupted']);
});

test('constructor validates optional callbacks, signal, and saved count metadata', () => {
  const base = { sessionId: 'root', runWorker: async () => '' };
  for (const key of ['persist', 'onEvent']) {
    for (const value of [null, {}, 'callback']) assert.throws(() => createSwarm({ ...base, [key]: value }), /must be a function/);
  }
  assert.throws(() => createSwarm({ ...base, signal: {} }), /AbortSignal/);
  assert.throws(() => createSwarm({ ...base, state: { workers: {} } }), /workers must be an array/);
  assert.throws(() => createSwarm({ ...base, state: { omittedWorkerCount: Infinity } }), /safe integer/);
  assert.throws(() => createSwarm({ ...base, state: { omittedInterruptedWorkerCount: 1 } }), /exceeds/);
});

test('task input is bounded and oversized worker output and errors carry explicit truncation flags', async () => {
  const swarm = createSwarm({ sessionId: 'root', maxWorkers: 2, runWorker: async ({ task }) => {
    if (task === 'fail') throw new Error('e'.repeat(5000));
    return 'r'.repeat(20000);
  } });
  await assert.rejects(invoke(swarm, 'spawn_worker', { task: 't'.repeat(32769) }), /32768/);
  await invoke(swarm, 'spawn_worker', { task: 't'.repeat(32768) });
  await invoke(swarm, 'spawn_worker', { task: 'fail' });
  const workers = await swarm.settle();
  assert.equal(workers[0].task.length, 32768);
  assert.equal(workers[0].result.length, 16384);
  assert.equal(workers[0].resultTruncated, true);
  assert.equal(workers[1].error.length, 4096);
  assert.equal(workers[1].errorTruncated, true);
  await swarm.close();
});

test('restoration validates primitives, bounds history text, and isolates all snapshot consumers', async () => {
  const malformed = { nested: 'original' };
  const state = { sessionId: 'root', workers: [
    { id: 'bad', parentId: 'root', task: 'bad', status: 'running', createdAt: malformed },
    { id: 'kept', parentId: 'root', task: 't'.repeat(40000), status: 'completed',
      result: 'r'.repeat(20000), name: 'n'.repeat(100), error: 'e'.repeat(5000), metadata: malformed },
  ] };
  const saves = [];
  const swarm = createSwarm({ sessionId: 'root', state, runWorker: async () => '',
    onEvent: event => { if (event.workers[0]) event.workers[0].task = 'observer mutation'; },
    persist: saved => { saves.push(structuredClone(saved)); if (saved.workers[0]) saved.workers[0].task = 'persist mutation'; } });
  state.workers[1].result = 'input mutation';
  malformed.nested = 'mutated';
  const snapshot = swarm.snapshot();
  assert.equal(snapshot.workers.length, 1);
  assert.equal(snapshot.omittedWorkerCount, 1);
  assert.equal(snapshot.omittedInterruptedWorkerCount, 1);
  const [worker] = snapshot.workers;
  assert.deepEqual([worker.task.length, worker.result.length, worker.error.length, worker.name.length], [32768, 16384, 4096, 80]);
  for (const key of ['task', 'result', 'error', 'name']) assert.equal(worker[`${key}Truncated`], true);
  assert.equal(worker.metadata, undefined);
  snapshot.workers[0].result = 'snapshot mutation';
  await swarm.settle();
  assert.equal(swarm.snapshot().workers[0].result.length, 16384);
  assert.equal(saves[0].workers[0].task.length, 32768);
  await swarm.close();
});

test('pruning retains explicit counts for omitted interrupted effects across future turns', async () => {
  const state = { sessionId: 'root', omittedWorkerCount: 4, omittedInterruptedWorkerCount: 2,
    workers: Array.from({ length: 105 }, (_, index) => ({ id: `old-${index}`, parentId: 'root',
      task: 'old', depth: 1, status: index < 3 ? 'running' : 'completed' })) };
  const swarm = createSwarm({ sessionId: 'root', state, runWorker: async () => 'fresh' });
  const snapshot = swarm.snapshot();
  assert.equal(snapshot.workers.length, 100);
  assert.equal(snapshot.omittedWorkerCount, 9);
  assert.equal(snapshot.omittedInterruptedWorkerCount, 5);
  const listed = await invoke(swarm, 'list_workers');
  const waited = await invoke(swarm, 'wait_workers');
  assert.equal(listed.omittedInterruptedWorkerCount, 5);
  assert.equal(waited.omittedInterruptedWorkerCount, 5);
  await swarm.close();
  const restored = createSwarm({ sessionId: 'root', state: snapshot, runWorker: async () => '' });
  assert.equal(restored.snapshot().omittedWorkerCount, 9);
  assert.equal(restored.snapshot().omittedInterruptedWorkerCount, 5);
  await restored.close();
});
