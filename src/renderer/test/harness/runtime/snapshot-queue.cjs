'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSnapshotQueue } = require('../../../../harness/ide/runtime/snapshot-queue.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { assert(Date.now() < deadline, 'snapshot queue did not settle'); await tick(); }
}

test('slow host bounds projections and messages, and drains fairly with latest data', async () => {
  const reads = [], sent = [], releases = [], values = { a: 0, b: 0 };
  const queue = createSnapshotQueue({
    read: id => { reads.push(id); return { id, value: values[id] }; },
    send: value => { sent.push(value); return new Promise(resolve => releases.push(resolve)); }
  });
  queue.schedule('a'); await waitFor(() => sent.length === 1);
  for (let i = 1; i <= 10000; i++) { values.a = i; queue.schedule('a'); queue.schedule('b'); }
  assert.equal(reads.length, 1); assert.equal(sent.length, 1);
  releases.shift()(); await waitFor(() => sent.length === 2);
  assert.deepEqual(sent[1], { id: 'a', value: 10000 });
  queue.schedule('a'); releases.shift()(); await waitFor(() => sent.length === 3);
  assert.equal(sent[2].id, 'b');
  queue.close(); releases.shift()(); await tick();
  assert.equal(sent.length, 3);
});

test('forget invalidates a queued projection before it is read', async () => {
  const read = () => { throw new Error('deleted session must not be projected'); };
  let error;
  const queue = createSnapshotQueue({ read, send: () => {}, onError: value => { error = value; } });
  queue.schedule('deleted'); queue.forget('deleted'); await tick();
  assert.equal(error, undefined); queue.close();
});

test('one projection failure leaves other sessions and later updates usable', async () => {
  const errors = [], sent = [];
  const queue = createSnapshotQueue({ read: id => id, send: id => { sent.push(id); if (id === 'a') throw new Error('bad projection'); }, onError: (error, id) => { errors.push(id); throw error; } });
  queue.schedule('a'); queue.schedule('b'); await tick(); queue.schedule('c'); await tick();
  assert.deepEqual(sent, ['a', 'b', 'c']); assert.deepEqual(errors, ['a']); queue.close();
});

test('rejected asynchronous error observers never become unhandled rejections', async () => {
  const queue = createSnapshotQueue({ read: () => { throw new Error('read failed'); }, send() {}, onError: async () => { throw new Error('observer failed'); } });
  queue.schedule('a'); await tick(); queue.close();
});

test('a superseded in-flight snapshot cannot publish a late error over new state', async () => {
  let rejectOld;
  const errors = [], sent = [], current = [];
  const queue = createSnapshotQueue({ read: id => id, send: (value, isCurrent) => {
    sent.push(value); current.push(isCurrent);
    if (sent.length === 1) return new Promise((resolve, reject) => { rejectOld = reject; });
  }, onError: error => errors.push(error) });
  queue.schedule('session'); await tick();
  assert.equal(current[0](), true);
  queue.forget('session'); queue.schedule('session');
  assert.equal(current[0](), false, 'retry loops must stop for the old snapshot');
  rejectOld(new Error('obsolete send failed')); await tick();
  assert.equal(errors.length, 0);
  assert.deepEqual(sent, ['session', 'session']);
  assert.equal(current[1](), true);
  queue.close(); assert.equal(current[1](), false);
});

test('paced snapshots coalesce bursts, preserve fairness, and cancel delayed work on close', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let value = 0;
  const sent = [];
  const queue = createSnapshotQueue({ delay: 75, read: id => ({ id, value }), send: item => sent.push(item) });
  t.after(() => queue.close());
  for (let i = 0; i < 10000; i++) { value = i; queue.schedule('a'); }
  queue.schedule('b');
  await tick(); assert.equal(sent.length, 0);
  t.mock.timers.tick(75); await tick();
  assert.deepEqual(sent, [{ id: 'a', value: 9999 }]);
  queue.schedule('a');
  t.mock.timers.tick(75); await tick();
  assert.equal(sent[1].id, 'b');
  queue.close(); t.mock.timers.tick(1000); await tick();
  assert.equal(sent.length, 2);
});

test('continuous synchronous snapshots yield to cancellation instead of starving event-loop turns', async () => {
  let sent = 0;
  const queue = createSnapshotQueue({ read: id => id, send: id => { sent++; if (sent < 100000) queue.schedule(id); } });
  queue.schedule('hot');
  await tick();
  assert(sent > 0 && sent < 100000, `expected cooperative yield, got ${sent}`);
  queue.close();
  const stopped = sent;
  await tick(); await tick();
  assert.equal(sent, stopped, 'a deferred drain must recheck closure before reading/sending');
});

test('stalled snapshot delivery releases the logical queue, bounds physical sends and resumes fairly', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sends = [], releases = [], errors = [], current = [];
  const queue = createSnapshotQueue({ timeoutMs: 50, maxInFlight: 2, read: id => id,
    send: (id, isCurrent) => { sends.push(id); current.push(isCurrent); return new Promise(resolve => releases.push(resolve)); },
    onError: (error, id) => errors.push([error.code, id]) });
  t.after(() => queue.close());
  queue.schedule('blocked'); queue.schedule('healthy'); await waitFor(() => sends.length === 1);
  t.mock.timers.tick(50); await waitFor(() => sends.length === 2);
  assert.deepEqual(sends, ['blocked', 'healthy']);
  assert.equal(current[0](), false);
  assert.deepEqual(errors, [['SNAPSHOT_TIMEOUT', 'blocked']]);
  queue.schedule('latest'); t.mock.timers.tick(50); await tick();
  for (let attempt = 0; attempt < 10; attempt++) { queue.schedule('latest'); t.mock.timers.tick(100); await tick(); }
  assert.equal(sends.length, 2, 'unresolved physical sends must stay bounded');
  releases[0](); await waitFor(() => sends.length === 3);
  assert.equal(sends[2], 'latest');
  queue.close(); assert.equal(current[2](), false);
  for (const release of releases) release(); await tick();
  assert.equal(sends.length, 3);
});

test('snapshot timeout settings and callbacks validate before scheduling', () => {
  for (const config of [{ timeoutMs: 0 }, { maxInFlight: 0 }, { delay: -1 }, { send: null }]) {
    assert.throws(() => createSnapshotQueue({ read: () => {}, send() {}, ...config }), TypeError);
  }
});

test('forget releases logical waiting immediately but repeated cancellation cannot bypass transport capacity', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sends = [], releases = [], errors = [];
  const queue = createSnapshotQueue({ maxInFlight: 2, read: id => id,
    send: id => { sends.push(id); return new Promise(resolve => releases.push(resolve)); },
    onError: error => errors.push(error) });
  t.after(() => queue.close());
  queue.schedule('old'); await tick();
  queue.forget('old'); queue.schedule('new'); await tick();
  assert.deepEqual(sends, ['old', 'new'], 'must not wait for timeout or old acknowledgement');
  queue.forget('new');
  for (let i = 0; i < 1000; i++) {
    queue.schedule('candidate'); queue.forget('candidate');
  }
  queue.schedule('latest'); await tick();
  assert.equal(sends.length, 2);
  t.mock.timers.tick(10000); await tick();
  assert.deepEqual(errors, [], 'cancellation must remove timeout work');
  releases[0](); await tick();
  assert.deepEqual(sends, ['old', 'new', 'latest']);
  queue.close(); for (const release of releases) release(); await tick();
});

test('closing or forgetting during projection cannot create a late transport or timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const action of ['close', 'forget']) {
    const sends = [], errors = [];
    let reads = 0;
    const queue = createSnapshotQueue({ read: id => {
      reads++;
      if (id === 'old') { if (action === 'close') queue.close(); else queue.forget(id); }
      return id;
    }, send: id => sends.push(id), onError: error => errors.push(error) });
    queue.schedule('old'); queue.schedule('next'); await tick();
    assert.deepEqual(sends, action === 'close' ? [] : ['next']);
    assert.equal(reads, action === 'close' ? 1 : 2);
    t.mock.timers.tick(10000); await tick(); assert.deepEqual(errors, []);
    queue.close();
  }
});

test('close suppresses late transport rejection and never reads queued snapshots', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reject; const reads = [], errors = [];
  const queue = createSnapshotQueue({ read: id => { reads.push(id); return id; },
    send: () => new Promise((_, fail) => { reject = fail; }), onError: error => errors.push(error) });
  queue.schedule('active'); queue.schedule('queued'); await tick();
  queue.close(); queue.close(); await tick();
  t.mock.timers.tick(10000); reject(Error('late transport failure')); await tick();
  assert.deepEqual(reads, ['active']); assert.deepEqual(errors, []);
});

test('cancelling synchronously inside send preserves physical capacity until it settles', async () => {
  const sends = []; let release;
  const queue = createSnapshotQueue({ maxInFlight: 1, read: id => id, send: id => {
    sends.push(id);
    if (id === 'old') {
      queue.forget(id); queue.schedule('new');
      return new Promise(resolve => { release = resolve; });
    }
  } });
  try {
    queue.schedule('old'); await waitFor(() => sends.length === 1); await tick();
    assert.deepEqual(sends, ['old']);
    release(); await waitFor(() => sends.length === 2);
    assert.deepEqual(sends, ['old', 'new']);
  } finally { queue.close(); release?.(); }
});

test('throwing thenable delivery does not strand other sessions', async () => {
  const errors = [], sends = [];
  const queue = createSnapshotQueue({ read: id => id, send: id => {
    sends.push(id);
    if (id === 'bad') return { get then() { throw Error('bad thenable'); } };
  }, onError: error => errors.push(error.message) });
  try {
    queue.schedule('bad'); queue.schedule('good'); await waitFor(() => sends.length === 2);
    assert.deepEqual(errors, ['bad thenable']); assert.deepEqual(sends, ['bad', 'good']);
  } finally { queue.close(); }
});

test('falsy read and send failures are reported once and never poison the next session', async () => {
  for (const reason of [undefined, null, false, 0, '']) {
    for (const phase of ['read', 'send', 'reject']) {
      const errors = [], sent = []; let current;
      const queue = createSnapshotQueue({ read: id => {
        if (id === 'bad' && phase === 'read') throw reason;
        return id;
      }, send: (id, isCurrent) => {
        if (id === 'bad') {
          current = isCurrent;
          if (phase === 'send') throw reason;
          return Promise.reject(reason);
        }
        sent.push(id);
      }, onError: (error, id) => errors.push({ error, id }) });
      try {
        queue.schedule('bad'); queue.schedule('good'); await waitFor(() => sent.length === 1);
        assert.equal(errors.length, 1, phase);
        assert.equal(errors[0].id, 'bad'); assert(errors[0].error instanceof Error);
        if (current) assert.equal(current(), false);
        assert.deepEqual(sent, ['good']);
      } finally { queue.close(); }
    }
  }
});

test('false acknowledgement and hostile error properties fail safely without retry loops', async () => {
  for (const mode of ['false', 'async-false', 'hostile']) {
    const errors = []; let sends = 0, current;
    const queue = createSnapshotQueue({ read: id => id, send: (_id, isCurrent) => {
      sends++; current = isCurrent;
      if (mode === 'hostile') return Promise.reject(new Proxy({}, { get() { throw Error('getter'); } }));
      return mode === 'false' ? false : Promise.resolve(false);
    }, onError: error => errors.push(error) });
    try {
      queue.schedule('s'); await waitFor(() => errors.length === 1); await tick();
      assert.equal(sends, 1); assert.equal(current(), false);
      if (mode !== 'hostile') assert.equal(errors[0].code, 'SNAPSHOT_NOT_DELIVERED');
      else assert.equal(errors[0].message, 'Agent operation failed');
    } finally { queue.close(); }
  }
});
