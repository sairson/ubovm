import assert from 'node:assert/strict';
import test from 'node:test';
import { createSwarm } from '../swarm.mjs';

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

test('worker completion waits for its terminal journal and propagates storage failure', { timeout: 3000 }, async () => {
  for (const fail of [false, true]) {
    const journal = deferred(), saving = deferred();
    const swarm = createSwarm({ sessionId: 'root', runWorker: async () => 'done', persist: async state => {
      if (state.workers.some(worker => worker.status === 'completed')) { saving.resolve(); await journal.promise; }
    } });
    let returned = false;
    try {
      await invoke(swarm, 'spawn_worker', { task: 'work' });
      const waiting = invoke(swarm, 'wait_workers').then(value => { returned = true; return value; });
      const checked = fail ? assert.rejects(waiting, /journal failed/) : waiting;
      await saving.promise; await nextTurn();
      assert.equal(returned, false);
      assert.equal((await invoke(swarm, 'wait_workers', { timeout_ms: 0 })).timed_out, true);
      if (fail) journal.reject(new Error('journal failed')); else journal.resolve();
      await checked;
      assert.equal(returned, !fail);
    } finally {
      journal.resolve();
      if (fail) await assert.rejects(swarm.close(), /journal failed/); else await swarm.close();
    }
  }
});

test('overlapping worker waits cannot resume code without reacquiring its slot', { timeout: 3000 }, async () => {
  const childStarted = deferred(), childFinish = deferred(), verified = deferred();
  let swarm;
  swarm = createSwarm({ sessionId: 'root', maxConcurrency: 1, runWorker: async ({ task, workerId }) => {
    if (task === 'child') { childStarted.resolve(); await childFinish.promise; return 'child'; }
    await invoke(swarm, 'spawn_worker', { task: 'child' }, workerId);
    const first = invoke(swarm, 'wait_workers', {}, workerId);
    await childStarted.promise;
    await assert.rejects(invoke(swarm, 'wait_workers', {}, workerId), /active wait/);
    await assert.rejects(invoke(swarm, 'wait_workers', { worker_ids: [], timeout_ms: 0 }, workerId), /active wait/);
    await assert.rejects(swarm.settle(workerId), /active wait/);
    assert.equal((await invoke(swarm, 'list_workers')).capacity.occupied_slots, 1);
    verified.resolve(); childFinish.resolve(); await first;
    assert.equal((await invoke(swarm, 'list_workers')).capacity.occupied_slots, 1);
    return 'parent';
  } });
  try {
    await invoke(swarm, 'spawn_worker', { task: 'parent' });
    await verified.promise; await swarm.settle();
    assert(swarm.snapshot().workers.every(worker => worker.status === 'completed'));
  } finally { childFinish.resolve(); await swarm.close(); }
});

test('cancelling a completion waiter during journal blockage leaves worker evidence and later waits usable', { timeout: 3000 }, async () => {
  const journal = deferred(), saving = deferred(), controller = new AbortController();
  const swarm = createSwarm({ sessionId: 'root', runWorker: async () => 'durable result', persist: async state => {
    if (state.workers.some(worker => worker.status === 'completed')) { saving.resolve(); await journal.promise; }
  } });
  try {
    await invoke(swarm, 'spawn_worker', { task: 'finish' });
    const checked = assert.rejects(invoke(swarm, 'wait_workers', {}, undefined, controller.signal), /stop waiting/);
    await saving.promise;
    controller.abort(new Error('stop waiting')); await checked;
    assert.equal(swarm.snapshot().workers[0].status, 'completed');
    journal.resolve();
    const waited = await invoke(swarm, 'wait_workers');
    assert.equal(waited.timed_out, false);
    assert.equal(waited.workers[0].result, 'durable result');
    const next = await invoke(swarm, 'spawn_worker', { task: 'next' });
    const later = await invoke(swarm, 'wait_workers', { worker_ids: [next.worker_id] });
    assert.equal(later.workers[0].status, 'completed');
  } finally { journal.resolve(); await swarm.close(); }
});

test('resolved model selection is passed to dispatch and survives journal recovery without replay', async () => {
  let selected;
  const swarm = createSwarm({ sessionId: 'root', runWorker: async input => { selected = input.modelProfile; return 'done'; } });
  try {
    await invoke(swarm, 'spawn_worker', { task: 'Inspect', modelProfile: 'saved.claude' });
    await invoke(swarm, 'wait_workers');
    assert.equal(selected, 'saved.claude');
    const restored = createSwarm({ sessionId: 'root', state: swarm.snapshot(), runWorker: async () => { throw new Error('Must not replay'); } });
    try { assert.equal(restored.snapshot().workers[0].modelProfile, 'saved.claude'); }
    finally { await restored.close(); }
  } finally { await swarm.close(); }
});

test('cancelling a parent queued for reentry does not wait for an unrelated occupied slot', { timeout: 3000 }, async () => {
  const parentStarted = deferred(), beginWait = deferred(), blockerStarted = deferred(), blockerFinish = deferred(), parentExited = deferred();
  let swarm, childCalls = 0;
  swarm = createSwarm({ sessionId: 'root', maxConcurrency: 1, runWorker: async ({ workerId, task }) => {
    if (task === 'blocker') { blockerStarted.resolve(); await blockerFinish.promise; return 'done'; }
    if (task === 'child') { childCalls++; return 'unexpected'; }
    parentStarted.resolve(); await beginWait.promise;
    try {
      const child = await invoke(swarm, 'spawn_worker', { task: 'child' }, workerId);
      await invoke(swarm, 'wait_workers', { worker_ids: [child.worker_id], timeout_ms: 5 }, workerId);
    } finally { parentExited.resolve(); }
    return 'parent';
  } });
  try {
    const parent = await invoke(swarm, 'spawn_worker', { task: 'parent' });
    await parentStarted.promise;
    await invoke(swarm, 'spawn_worker', { task: 'blocker' });
    beginWait.resolve(); await blockerStarted.promise;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal((await invoke(swarm, 'list_workers')).capacity.resuming_workers, 1);
    await invoke(swarm, 'cancel_workers', { worker_ids: [parent.worker_id] });
    await parentExited.promise; await nextTurn();
    assert.equal(swarm.snapshot().workers.find(worker => worker.id === parent.worker_id).status, 'interrupted');
    assert.equal(childCalls, 0);
    assert.equal((await invoke(swarm, 'list_workers')).capacity.occupied_slots, 1);
    assert.equal((await invoke(swarm, 'list_workers')).capacity.resuming_workers, 0);
  } finally { blockerFinish.resolve(); await swarm.close(); }
});

test('falsy persistence failures remain latched and cannot allow later dispatch', async () => {
  for (const thrown of [null, undefined, '', 0]) {
    let attempts = 0, calls = 0;
    const swarm = createSwarm({ sessionId: 'root', persist: () => { if (++attempts === 1) throw thrown; },
      runWorker: async () => { calls++; return 'unexpected'; } });
    await assert.rejects(invoke(swarm, 'spawn_worker', { task: 'first' }));
    await assert.rejects(invoke(swarm, 'spawn_worker', { task: 'later' }), Error);
    await assert.rejects(swarm.close(), Error);
    assert.equal(calls, 0);
  }
});

test('journal failure aborts live workers, rejects waiters and retains cleanup capacity', { timeout: 3000 }, async () => {
  const entered = deferred(), aborted = deferred(), cleanup = deferred();
  let fail = false, started = 0;
  const swarm = createSwarm({ sessionId: 'root', maxConcurrency: 1,
    persist: async () => { if (fail) { fail = false; throw new Error('journal unavailable'); } },
    runWorker: async ({ signal }) => {
      started++; entered.resolve();
      await new Promise(resolve => signal.addEventListener('abort', () => { aborted.resolve(); resolve(); }, { once: true }));
      await cleanup.promise;
      signal.throwIfAborted();
    }
  });
  await invoke(swarm, 'spawn_worker', { task: 'active' });
  await entered.promise;
  const waiting = assert.rejects(invoke(swarm, 'wait_workers'), /journal unavailable/);
  fail = true;
  await assert.rejects(invoke(swarm, 'spawn_worker', { task: 'queued' }), /journal unavailable/);
  await aborted.promise; await waiting;
  assert.equal(started, 1);
  const listing = await invoke(swarm, 'list_workers');
  assert.equal(listing.capacity.occupied_slots, 1);
  let closed = false;
  const closing = assert.rejects(swarm.close(), /journal unavailable/).then(() => { closed = true; });
  await nextTurn(); assert.equal(closed, false);
  cleanup.resolve(); await closing;
  assert.equal(swarm.snapshot().workers[0].status, 'interrupted');
});

test('dependent workers wait without slots and receive detached bounded results', async () => {
  const gate = deferred(), started = [];
  const swarm = createSwarm({ sessionId: 'root', maxConcurrency: 2, runWorker: async input => {
    started.push(input);
    if (input.task === 'research') return gate.promise;
    return 'done';
  } });
  try {
    const source = await invoke(swarm, 'spawn_worker', { task: 'research' });
    const dependent = await invoke(swarm, 'spawn_worker', { task: 'implement', depends_on: [source.worker_id] });
    await invoke(swarm, 'spawn_worker', { task: 'independent' });
    await nextTurn();
    assert.deepEqual(started.map(item => item.task), ['research', 'independent']);
    const snapshot = swarm.snapshot();
    snapshot.workers.find(item => item.id === dependent.worker_id).dependsOn.length = 0;
    assert.deepEqual(swarm.snapshot().workers.find(item => item.id === dependent.worker_id).dependsOn, [source.worker_id]);
    gate.resolve('e'.repeat(5000));
    await swarm.settle();
    const input = started.find(item => item.task === 'implement');
    assert.equal(input.dependencies[0].worker_id, source.worker_id);
    assert.equal(input.dependencies[0].result.length, 4096);
    assert.equal(input.dependencies[0].resultTruncated, true);
    const restored = createSwarm({ sessionId: 'root', state: swarm.snapshot(), runWorker: () => { throw Error('must not replay'); } });
    assert.deepEqual(restored.snapshot().workers.find(item => item.id === dependent.worker_id).dependsOn, [source.worker_id]);
    await restored.close();
  } finally { gate.resolve('done'); await swarm.close(); }
});

test('cancelling a prerequisite blocks dependents and nested workers cannot reference sibling branches', async () => {
  const started = deferred(); let calls = 0;
  const swarm = createSwarm({ sessionId: 'root', runWorker: async ({ signal }) => {
    calls++; started.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    signal.throwIfAborted();
  } });
  try {
    const first = await invoke(swarm, 'spawn_worker', { task: 'first' });
    await started.promise;
    const second = await invoke(swarm, 'spawn_worker', { task: 'second', depends_on: [first.worker_id] });
    await assert.rejects(invoke(swarm, 'spawn_worker', { task: 'invalid', depends_on: [second.worker_id] }, first.worker_id), /outside your descendants/);
    await invoke(swarm, 'cancel_workers', { worker_ids: [first.worker_id] });
    const settled = await swarm.settle();
    assert.deepEqual(settled.map(worker => worker.status), ['interrupted', 'failed']);
    assert.equal(calls, 1);
  } finally { await swarm.close(); }
});

test('unreadable worker errors settle dependencies and release capacity', { timeout: 3000 }, async () => {
  const gate = deferred(), started = [];
  const swarm = createSwarm({ sessionId: 'root', maxConcurrency: 1, runWorker: async ({ task }) => {
    started.push(task);
    if (task === 'bad') {
      await gate.promise;
      throw Object.defineProperty(new Error(), 'message', { get() { throw Error('unreadable'); } });
    }
    return 'ok';
  } });
  try {
    const bad = await invoke(swarm, 'spawn_worker', { task: 'bad' });
    await invoke(swarm, 'spawn_worker', { task: 'dependent', depends_on: [bad.worker_id] });
    await invoke(swarm, 'spawn_worker', { task: 'independent' });
    gate.resolve();
    const workers = await swarm.settle();
    assert.deepEqual(workers.map(worker => worker.status), ['failed', 'failed', 'completed']);
    assert.match(workers[0].error, /unreadable error/);
    assert.deepEqual(started, ['bad', 'independent']);
    assert.equal((await invoke(swarm, 'list_workers')).capacity.occupied_slots, 0);
  } finally { gate.resolve(); await swarm.close(); }
});

test('failed dependencies stop downstream chains without invoking tools', async () => {
  const gate = deferred(), started = [];
  const swarm = createSwarm({ sessionId: 'root', maxConcurrency: 1, runWorker: async ({ task }) => {
    started.push(task); await gate.promise; throw Error('research failed');
  } });
  try {
    const first = await invoke(swarm, 'spawn_worker', { task: 'first' });
    const second = await invoke(swarm, 'spawn_worker', { task: 'second', depends_on: [first.worker_id] });
    await invoke(swarm, 'spawn_worker', { task: 'third', depends_on: [second.worker_id] });
    gate.resolve();
    const settled = await swarm.settle();
    assert.deepEqual(started, ['first']);
    assert.ok(settled.every(worker => worker.status === 'failed'));
    assert.match(settled[2].error, /was not started/);
    await assert.rejects(invoke(swarm, 'spawn_worker', { task: 'invalid', depends_on: ['unknown'] }), /outside your descendants/);
  } finally { gate.resolve(); await swarm.close(); }
});

test('wait any returns the first terminal worker without waiting for slower peers', { timeout: 3000 }, async () => {
  const gates = [deferred(), deferred()];
  const swarm = createSwarm({ sessionId: 'root', runWorker: ({ task }) => gates[Number(task)].promise });
  try {
    const ids = [];
    for (const task of ['0', '1']) ids.push((await invoke(swarm, 'spawn_worker', { task })).worker_id);
    const waiting = invoke(swarm, 'wait_workers', { mode: 'any', worker_ids: ids });
    gates[1].resolve('fast');
    const result = await waiting;
    assert.equal(result.timed_out, false);
    assert.deepEqual(result.workers.map(worker => worker.status), ['running', 'completed']);
    assert.equal((await invoke(swarm, 'wait_workers', { mode: 'all', timeout_ms: 0 })).timed_out, true);
    assert.equal((await invoke(swarm, 'wait_workers', { mode: 'any', worker_ids: [] })).timed_out, false);
    await assert.rejects(invoke(swarm, 'wait_workers', { mode: 'invalid' }), /mode/);
  } finally { gates.forEach(gate => gate.resolve('done')); await swarm.close(); }
});

test('targeted cancellation skips queued work and holds running slots through cleanup', { timeout: 3000 }, async () => {
  const cleanup = deferred(), started = [];
  const swarm = createSwarm({ sessionId: 'root', maxConcurrency: 1, runWorker: async ({ task, signal }) => {
    started.push(task);
    if (task !== 'running') return task;
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    await cleanup.promise;
    signal.throwIfAborted();
  } });
  try {
    const first = await invoke(swarm, 'spawn_worker', { task: 'running' });
    const queued = await invoke(swarm, 'spawn_worker', { task: 'cancel queued' });
    const survivor = await invoke(swarm, 'spawn_worker', { task: 'survivor' });
    await nextTurn();
    const listed = await invoke(swarm, 'list_workers');
    assert.equal(listed.counts.queued, 2);
    assert.equal(listed.capacity.occupied_slots, 1);
    assert.equal(listed.capacity.remaining_workers, 9);
    const cancelled = await invoke(swarm, 'cancel_workers', { worker_ids: [first.worker_id, queued.worker_id], reason: 'obsolete' });
    assert.equal(cancelled.cancellation_requested.length, 2);
    assert.deepEqual(started, ['running']);
    assert.deepEqual(swarm.snapshot().workers.map(worker => worker.status), ['running', 'interrupted', 'queued']);
    assert.equal((await invoke(swarm, 'cancel_workers', { worker_ids: [first.worker_id] })).cancellation_requested.length, 0);
    cleanup.resolve();
    const settled = await swarm.settle();
    assert.deepEqual(started, ['running', 'survivor']);
    assert.equal(settled.find(worker => worker.id === survivor.worker_id).status, 'completed');
    assert.equal(settled[0].cancelReason, 'obsolete');
    const restored = createSwarm({ sessionId: 'root', state: swarm.snapshot(), runWorker: async () => 'unused' });
    assert.equal(restored.snapshot().workers[0].cancelReason, 'obsolete');
    await restored.close();
  } finally { cleanup.resolve(); await swarm.close(); }
});

test('cancellation covers a nested subtree, rejects siblings, and validates all IDs before acting', { timeout: 3000 }, async () => {
  const leafStarted = deferred(), childId = deferred();
  let swarm;
  swarm = createSwarm({ sessionId: 'root', maxConcurrency: 2, runWorker: async ({ workerId, task, signal }) => {
    if (task === 'parent') {
      const child = await invoke(swarm, 'spawn_worker', { task: 'leaf' }, workerId);
      childId.resolve(child.worker_id);
      await swarm.settle(workerId);
    } else {
      if (task === 'leaf') leafStarted.resolve();
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      signal.throwIfAborted();
    }
    return 'done';
  } });
  try {
    const parent = await invoke(swarm, 'spawn_worker', { task: 'parent' });
    const sibling = await invoke(swarm, 'spawn_worker', { task: 'sibling' });
    await leafStarted.promise;
    await assert.rejects(invoke(swarm, 'cancel_workers', { worker_ids: [await childId.promise, sibling.worker_id] }, parent.worker_id), /outside your descendants/);
    assert.ok(swarm.snapshot().workers.every(worker => !worker.cancelRequestedAt));
    const result = await invoke(swarm, 'cancel_workers', { worker_ids: [parent.worker_id] });
    assert.equal(result.cancellation_requested.length, 2);
    const waited = await invoke(swarm, 'wait_workers', { worker_ids: [parent.worker_id, await childId.promise] });
    assert.ok(waited.workers.every(worker => worker.status === 'interrupted'));
    assert.equal(swarm.snapshot().workers.find(worker => worker.id === sibling.worker_id).status, 'running');
  } finally { await swarm.close(); }
});

test('one persistence failure blocks later dispatches even when later writes succeed', { timeout: 3000 }, async () => {
  const gate = deferred(); let started = 0, fail = true;
  const swarm = createSwarm({ sessionId: 'root', maxConcurrency: 1, persist: async state => {
    if (state.workers.some(worker => worker.status === 'running') && fail) { await gate.promise; fail = false; throw new Error('transient disk failure'); }
  }, runWorker: async () => { started++; return 'unexpected'; } });
  await invoke(swarm, 'spawn_worker', { task: 'first' });
  const second = invoke(swarm, 'spawn_worker', { task: 'queued' });
  const rejected = assert.rejects(second, /transient disk failure/);
  gate.resolve();
  await rejected;
  await assert.rejects(swarm.settle(), /transient disk failure/);
  assert.equal(started, 0);
  assert.ok(swarm.snapshot().workers.every(worker => worker.status === 'failed'));
  await assert.rejects(invoke(swarm, 'spawn_worker', { task: 'later' }), /transient disk failure/);
  await assert.rejects(swarm.close(), /transient disk failure/);
});

test('close is reentrant from a worker abort listener and returns the same cleanup promise', async () => {
  const started = deferred(); let swarm, nested;
  swarm = createSwarm({ sessionId: 'root', runWorker: async ({ signal }) => {
    started.resolve();
    await new Promise(resolve => signal.addEventListener('abort', () => { nested = swarm.close(); resolve(); }, { once: true }));
    signal.throwIfAborted();
  } });
  await invoke(swarm, 'spawn_worker', { task: 'running' });
  await started.promise;
  const closing = swarm.close();
  assert.equal(nested, closing);
  await closing;
  assert.equal(swarm.snapshot().workers[0].status, 'interrupted');
});

test('aborting a spawn during durable queueing reports interrupted and never launches', async () => {
  const saved = deferred(), gate = deferred(), controller = new AbortController();
  let started = 0;
  const swarm = createSwarm({ sessionId: 'root', persist: async state => {
    if (state.workers.some(worker => worker.status === 'queued')) { saved.resolve(); await gate.promise; }
  }, runWorker: async () => { started++; return 'unexpected'; } });
  const pending = invoke(swarm, 'spawn_worker', { task: 'cancel before dispatch' }, undefined, controller.signal);
  const rejected = assert.rejects(pending, /cancel spawn/);
  await saved.promise;
  controller.abort(new Error('cancel spawn'));
  gate.resolve();
  await rejected;
  assert.equal(started, 0);
  assert.equal(swarm.snapshot().workers[0].status, 'interrupted');
  await swarm.close();
});

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
  assert.equal((await invoke(swarm, 'list_workers', {}, first.worker_id)).capacity.queued_workers, 0);
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

test('falsy cancellation reasons reject waiters without reporting unfinished work as settled', { timeout: 3000 }, async () => {
  for (const reason of [false, 0, '']) {
    const gate = deferred(), controller = new AbortController();
    const swarm = createSwarm({ sessionId: 'root', runWorker: () => gate.promise });
    try {
      await invoke(swarm, 'spawn_worker', { task: 'unfinished' });
      const waiting = invoke(swarm, 'wait_workers', {}, undefined, controller.signal);
      const checked = waiting.then(() => assert.fail('cancelled wait resolved'), error => assert.equal(error, reason));
      controller.abort(reason);
      await checked;
      assert.equal(swarm.snapshot().workers[0].status, 'running');
    } finally { gate.resolve('done'); await swarm.close(); }
  }
});

test('falsy cancellation while reacquiring a slot never resumes worker code', { timeout: 3000 }, async () => {
  const controller = new AbortController();
  const parentStarted = deferred(), beginWait = deferred(), blockerStarted = deferred(), blockerFinish = deferred();
  let swarm, resumed = false;
  swarm = createSwarm({ sessionId: 'root', maxConcurrency: 1, signal: controller.signal, runWorker: async ({ workerId, task }) => {
    if (task === 'blocker') { blockerStarted.resolve(); await blockerFinish.promise; return 'done'; }
    if (task === 'child') return 'unexpected';
    parentStarted.resolve(); await beginWait.promise;
    const child = await invoke(swarm, 'spawn_worker', { task: 'child' }, workerId);
    await invoke(swarm, 'wait_workers', { worker_ids: [child.worker_id], timeout_ms: 5 }, workerId);
    resumed = true;
    return 'parent resumed after cancellation';
  } });
  try {
    await invoke(swarm, 'spawn_worker', { task: 'parent' }); await parentStarted.promise;
    await invoke(swarm, 'spawn_worker', { task: 'blocker' });
    beginWait.resolve(); await blockerStarted.promise;
    for (let attempt = 0; attempt < 100 && (await invoke(swarm, 'list_workers')).capacity.resuming_workers !== 1; attempt++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal((await invoke(swarm, 'list_workers')).capacity.resuming_workers, 1);
    controller.abort(false);
    await nextTurn();
    assert.equal(resumed, false);
  } finally { beginWait.resolve(); blockerFinish.resolve(); await swarm.close(); }
});

test('close waits for pending worker creation to persist its final interrupted state', { timeout: 3000 }, async () => {
  const initialization = deferred(), finalWrite = deferred(), finalStarted = deferred();
  let writes = 0, launched = 0, closed = false;
  const swarm = createSwarm({ sessionId: 'root', runWorker: async () => { launched++; }, persist: async snapshot => {
    if (++writes === 1) await initialization.promise;
    // spawn's rejection path adds its terminal error after shutdown marks queued work interrupted.
    if (snapshot.workers.some(worker => worker.error === 'Collaboration swarm closed')) {
      // Delay only the final post-admission rejection, whose message comes from ensureOpen().
      if (writes >= 4) { finalStarted.resolve(); await finalWrite.promise; }
    }
  } });
  const spawning = assert.rejects(invoke(swarm, 'spawn_worker', { task: 'queued during initialization' }));
  const closing = swarm.close().then(() => { closed = true; });
  try {
    initialization.resolve();
    await finalStarted.promise;
    await nextTurn();
    assert.equal(closed, false, 'close must retain ownership of the pending spawn journal');
    assert.equal(launched, 0);
    finalWrite.resolve();
    await spawning; await closing;
    const finishedWrites = writes;
    await nextTurn();
    assert.equal(writes, finishedWrites, 'no journal writes may arrive after close returns');
  } finally { initialization.resolve(); finalWrite.resolve(); await spawning; await closing; }
});

test('higher-priority queued workers start before earlier lower-priority peers', { timeout: 3000 }, async () => {
  const gates = { low: deferred(), high: deferred() };
  const started = [];
  const swarm = createSwarm({ sessionId: 'root', maxConcurrency: 1, runWorker: async ({ task, signal }) => {
    started.push(task);
    await gates[task].promise;
    signal.throwIfAborted();
    return task;
  } });
  try {
    await invoke(swarm, 'spawn_worker', { task: 'low', priority: 1 });
    await invoke(swarm, 'spawn_worker', { task: 'high', priority: 9 });
    await nextTurn();
    assert.deepEqual(started, ['low']);
    gates.low.resolve();
    await invoke(swarm, 'wait_workers', { mode: 'any' });
    await nextTurn();
    assert.deepEqual(started, ['low', 'high']);
    gates.high.resolve();
    const workers = await swarm.settle();
    assert.deepEqual(workers.map(worker => worker.priority), [1, 9]);
  } finally {
    gates.low.resolve(); gates.high.resolve();
    await swarm.close();
  }
});

test('manage_workers can raise priority, interrupt, and preempt a lower-priority runner', { timeout: 3000 }, async () => {
  const running = deferred(), cleanup = deferred();
  const started = [];
  const swarm = createSwarm({ sessionId: 'root', maxConcurrency: 1, runWorker: async ({ task, signal }) => {
    started.push(task);
    if (task === 'background') {
      running.resolve();
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      await cleanup.promise;
      signal.throwIfAborted();
    }
    return task;
  } });
  try {
    const background = await invoke(swarm, 'spawn_worker', { task: 'background', priority: 1 });
    const critical = await invoke(swarm, 'spawn_worker', { task: 'critical' });
    await running.promise;
    await assert.rejects(invoke(swarm, 'spawn_worker', { task: 'bad', priority: 10 }), /priority/);
    await assert.rejects(invoke(swarm, 'manage_workers', { action: 'shuffle', worker_ids: [critical.worker_id], priority: 9 }), /prioritize or interrupt/);
    const help = await invoke(swarm, 'manage_workers', { action: 'help' });
    assert.equal(help.mode, 'help');
    const ranked = await invoke(swarm, 'manage_workers', { action: 'prioritize', worker_ids: [critical.worker_id], priority: 9, preempt: true });
    assert.deepEqual(ranked.updated, [critical.worker_id]);
    assert.deepEqual(ranked.preempted, [background.worker_id]);
    assert.equal(swarm.snapshot().workers.find(worker => worker.id === critical.worker_id).priority, 9);
    const stopped = await invoke(swarm, 'manage_workers', { action: 'interrupt', worker_ids: [critical.worker_id], reason: 'replaced' });
    assert.deepEqual(stopped.cancellation_requested, [critical.worker_id]);
    cleanup.resolve();
    const settled = await swarm.settle();
    assert.equal(settled.find(worker => worker.id === background.worker_id).status, 'interrupted');
    assert.equal(settled.find(worker => worker.id === critical.worker_id).status, 'interrupted');
    assert.deepEqual(started, ['background']);
    const restored = createSwarm({ sessionId: 'root', state: swarm.snapshot(), runWorker: async () => 'unused' });
    try { assert.equal(restored.snapshot().workers.find(worker => worker.id === critical.worker_id).priority, 9); }
    finally { await restored.close(); }
  } finally { cleanup.resolve(); await swarm.close(); }
});

test('preempt does not cancel a running ancestor of the preferred queued worker', { timeout: 3000 }, async () => {
  const parentStarted = deferred(), allowChild = deferred(), childId = deferred(), parentReady = deferred(), parentHold = deferred();
  let swarm;
  swarm = createSwarm({ sessionId: 'root', maxConcurrency: 2, maxDepth: 2, runWorker: async ({ workerId, task, signal }) => {
    if (task === 'parent') {
      parentStarted.resolve();
      await allowChild.promise;
      const child = await invoke(swarm, 'spawn_worker', { task: 'critical-child', priority: 9 }, workerId);
      childId.resolve(child.worker_id);
      parentReady.resolve();
      await parentHold.promise;
      return 'parent';
    }
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    signal.throwIfAborted();
  } });
  try {
    const sibling = await invoke(swarm, 'spawn_worker', { task: 'sibling', priority: 0 });
    const parent = await invoke(swarm, 'spawn_worker', { task: 'parent', priority: 0 });
    await parentStarted.promise;
    allowChild.resolve();
    await parentReady.promise;
    const queued = await childId.promise;
    await invoke(swarm, 'manage_workers', { action: 'prioritize', worker_ids: [queued], priority: 9, preempt: true });
    const snapshot = swarm.snapshot();
    const parentState = snapshot.workers.find(worker => worker.id === parent.worker_id);
    const siblingState = snapshot.workers.find(worker => worker.id === sibling.worker_id);
    const childState = snapshot.workers.find(worker => worker.id === queued);
    assert.equal(parentState.status, 'running');
    assert.equal(parentState.cancelRequestedAt, undefined);
    assert.ok(siblingState.cancelRequestedAt);
    assert.ok(['running', 'interrupted'].includes(siblingState.status));
    assert.notEqual(childState.status, 'interrupted');
  } finally { parentHold.resolve(); await swarm.close(); }
});

test('spawn can preempt a lower-priority runner and list_workers exposes admission', { timeout: 3000 }, async () => {
  const running = deferred(), cleanup = deferred();
  const started = [];
  const swarm = createSwarm({ sessionId: 'root', maxConcurrency: 1, runWorker: async ({ task, signal }) => {
    started.push(task);
    if (task === 'background') {
      running.resolve();
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      await cleanup.promise;
      signal.throwIfAborted();
    }
    return task;
  } });
  try {
    await invoke(swarm, 'spawn_worker', { task: 'background', priority: 1 });
    await running.promise;
    const listed = await invoke(swarm, 'list_workers');
    assert.equal(listed.capacity.occupied_slots, 1);
    assert.equal(listed.admission.ready_queue.length, 0);
    const spawned = await invoke(swarm, 'spawn_worker', { task: 'critical', priority: 9, preempt: true, reason: 'critical path' });
    assert.equal(spawned.priority, 9);
    assert.equal(spawned.preempted.length, 1);
    assert.equal(spawned.admission.preemptable.length, 0);
    cleanup.resolve();
    const settled = await swarm.settle();
    assert.equal(settled.find(worker => worker.task === 'background').status, 'interrupted');
    assert.equal(settled.find(worker => worker.task === 'critical').status, 'completed');
    assert.deepEqual(started, ['background', 'critical']);
  } finally { cleanup.resolve(); await swarm.close(); }
});

test('higher-priority queued work starts before a lower-priority slot reacquisition', { timeout: 3000 }, async () => {
  const parentStarted = deferred(), beginWait = deferred(), blockerStarted = deferred(), blockerFinish = deferred();
  const started = [];
  let swarm;
  swarm = createSwarm({ sessionId: 'root', maxConcurrency: 1, runWorker: async ({ workerId, task }) => {
    started.push(task);
    if (task === 'blocker') { blockerStarted.resolve(); await blockerFinish.promise; return 'blocker'; }
    if (task === 'high') return 'high';
    if (task === 'child') return 'child';
    parentStarted.resolve(); await beginWait.promise;
    const child = await invoke(swarm, 'spawn_worker', { task: 'child' }, workerId);
    await invoke(swarm, 'wait_workers', { worker_ids: [child.worker_id], timeout_ms: 5 }, workerId);
    return 'parent';
  } });
  try {
    await invoke(swarm, 'spawn_worker', { task: 'parent', priority: 0 });
    await parentStarted.promise;
    await invoke(swarm, 'spawn_worker', { task: 'blocker', priority: 0 });
    beginWait.resolve();
    await blockerStarted.promise;
    for (let attempt = 0; attempt < 100 && (await invoke(swarm, 'list_workers')).capacity.resuming_workers !== 1; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.equal((await invoke(swarm, 'list_workers')).capacity.resuming_workers, 1);
    const high = await invoke(swarm, 'spawn_worker', { task: 'high', priority: 9 });
    assert.equal(high.status, 'queued');
    assert.equal((await invoke(swarm, 'list_workers')).admission.next.kind, 'queue');
    blockerFinish.resolve();
    const waited = await invoke(swarm, 'wait_workers', { worker_ids: [high.worker_id] });
    assert.equal(waited.workers[0].status, 'completed');
    assert.ok(started.indexOf('high') > started.indexOf('blocker'));
    assert.equal(started.includes('child') ? started.indexOf('high') < started.indexOf('child') : true, true);
  } finally { beginWait.resolve(); blockerFinish.resolve(); await swarm.close(); }
});

test('queued workers report why they are blocked and skip preemption until dependencies complete', { timeout: 3000 }, async () => {
  const hold = deferred();
  const swarm = createSwarm({ sessionId: 'root', maxConcurrency: 1, runWorker: async ({ task }) => {
    if (task === 'source') { await hold.promise; return 'source'; }
    return task;
  } });
  try {
    const source = await invoke(swarm, 'spawn_worker', { task: 'source', priority: 1 });
    const dependent = await invoke(swarm, 'spawn_worker', {
      task: 'critical', priority: 9, preempt: true, depends_on: [source.worker_id],
    });
    assert.equal(dependent.status, 'queued');
    assert.equal(dependent.skip_preempt, 'dependencies');
    assert.equal(dependent.preempted.length, 0);
    assert.equal(dependent.blocked.reason, 'dependencies');
    assert.deepEqual(dependent.blocked.worker_ids, [source.worker_id]);
    const listed = await invoke(swarm, 'list_workers');
    const row = listed.workers.find(worker => worker.id === dependent.worker_id);
    assert.equal(row.blocked.reason, 'dependencies');
    const timed = await invoke(swarm, 'wait_workers', { worker_ids: [dependent.worker_id], timeout_ms: 5 });
    assert.equal(timed.timed_out, true);
    assert.match(timed.guidance, /blocked/);
    assert.equal(timed.admission.occupied_slots, 1);
    hold.resolve();
    await swarm.settle();
  } finally { hold.resolve(); await swarm.close(); }
});

test('prioritize+preempt on a running worker does not interrupt unrelated runners', { timeout: 3000 }, async () => {
  const started = { a: deferred(), b: deferred() };
  const hold = { a: deferred(), b: deferred() };
  const swarm = createSwarm({ sessionId: 'root', maxConcurrency: 2, runWorker: async ({ task }) => {
    started[task].resolve();
    await hold[task].promise;
    return task;
  } });
  try {
    const first = await invoke(swarm, 'spawn_worker', { task: 'a', priority: 1 });
    const second = await invoke(swarm, 'spawn_worker', { task: 'b', priority: 1 });
    await Promise.all([started.a.promise, started.b.promise]);
    const ranked = await invoke(swarm, 'manage_workers', { action: 'prioritize', worker_ids: [first.worker_id], priority: 9, preempt: true });
    assert.deepEqual(ranked.updated, [first.worker_id]);
    assert.deepEqual(ranked.preempted, []);
    assert.equal(ranked.skip_preempt, 'no_ready_queued_target');
    const snapshot = swarm.snapshot();
    assert.equal(snapshot.workers.find(worker => worker.id === second.worker_id).cancelRequestedAt, undefined);
    assert.equal(snapshot.workers.find(worker => worker.id === first.worker_id).status, 'running');
    const occupancy = swarm.inspect();
    assert.equal(occupancy.workers.find(worker => worker.id === first.worker_id).blocked, undefined);
  } finally { hold.a.resolve(); hold.b.resolve(); await swarm.close(); }
});

