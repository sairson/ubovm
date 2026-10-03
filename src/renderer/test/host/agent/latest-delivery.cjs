'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { setTimeout: sleep } = require('node:timers/promises');
const { createLatestDelivery } = require('../../../host/agent/latest-delivery.cjs');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

for (const asynchronous of [false, true]) test(`continuous ${asynchronous ? 'async' : 'sync'} publication yields and clear fences pending work`, async () => {
  const delivery = createLatestDelivery();
  let delivered = 0, observed = false;
  const interrupted = new Promise(resolve => setImmediate(() => {
    observed = delivered > 0 && delivered < 10000;
    delivery.clear(); resolve();
  }));
  function publish() {
    if (++delivered < 10000) delivery.publish(publish);
    if (asynchronous) return Promise.resolve();
  }
  await delivery.publish(publish); await interrupted;
  assert.equal(observed, true);
  const count = delivered;
  await nextTurn();
  assert.equal(delivered, count, 'cleared generation must stop after yielding');
  let next = false; await delivery.publish(() => { next = true; }); assert.equal(next, true);
});

test('synchronous delivery releases capacity without delaying subsequent publications', async () => {
  const sent = [], delivery = createLatestDelivery();
  const first = delivery.publish(() => { sent.push('first'); return true; });
  const second = delivery.publish(() => { sent.push('second'); });
  assert.deepEqual(sent, ['first', 'second']);
  await Promise.all([first, second]);
});

test('throwing then accessors release the delivery queue and retain the latest update', async () => {
  const errors = [], sent = [], delivery = createLatestDelivery(error => errors.push(error.message));
  const done = delivery.publish(() => ({ get then() { throw Error('broken bridge thenable'); } }));
  delivery.publish(() => sent.push('latest'));
  await done;
  assert.deepEqual(errors, ['broken bridge thenable']);
  assert.deepEqual(sent, ['latest']);
});

test('a slow component keeps only the latest queued state and shares one completion promise', async () => {
  const delivery = createLatestDelivery(), gate = deferred(), sent = [];
  const done = delivery.publish(() => { sent.push(0); return gate.promise; });
  for (let i = 1; i <= 1000; i++) assert.equal(delivery.publish(() => sent.push(i)), done);
  assert.deepEqual(sent, [0]);
  gate.resolve(); await done;
  assert.deepEqual(sent, [0, 1000]);
});

test('clearing a disposed component releases waiters and fences its late completion', async () => {
  const errors = [], delivery = createLatestDelivery(error => errors.push(error)), old = deferred(), current = deferred(), sent = [];
  const previous = delivery.publish(() => old.promise);
  delivery.publish(() => sent.push('obsolete'));
  delivery.clear(); await previous;
  const latest = delivery.publish(() => { sent.push('new'); return current.promise; });
  old.reject(Error('disposed bridge')); await nextTurn();
  delivery.publish(() => sent.push('newest'));
  assert.deepEqual(sent, ['new']); assert.deepEqual(errors, []);
  current.resolve(); await latest;
  assert.deepEqual(sent, ['new', 'newest']);
});

test('sync and async failures cannot poison the next delivery even if reporting fails', async () => {
  const errors = [], delivery = createLatestDelivery(error => { errors.push(error.message); throw Error('observer'); }, { maxRetries: 0 });
  await delivery.publish(() => { throw Error('sync'); });
  await delivery.publish(() => Promise.reject(Error('async')));
  let delivered = false; await delivery.publish(() => { delivered = true; });
  assert.deepEqual(errors, ['sync', 'async']); assert.equal(delivered, true);
});

test('failed delivery acknowledgements are reported for sync and async bridges', async () => {
  const errors = [], delivery = createLatestDelivery(error => errors.push(error.message), { maxRetries: 0 });
  await delivery.publish(() => false);
  await delivery.publish(() => Promise.resolve(false));
  assert.deepEqual(errors, Array(2).fill('Component state message was not delivered'));
});

test('timeouts advance latest state while unresolved transports stay bounded across cycles', async () => {
  const gates = [deferred(), deferred()], errors = [], sent = [];
  const delivery = createLatestDelivery(error => errors.push(error.message), { timeoutMs: 10, maxInFlight: 2, maxRetries: 0 });
  const first = delivery.publish(() => { sent.push(0); return gates[0].promise; });
  delivery.publish(() => { sent.push(1); return gates[1].promise; });
  await first;
  assert.deepEqual(sent, [0, 1]);
  assert.deepEqual(errors, Array(2).fill('Component state delivery timed out'));
  const next = delivery.publish(() => sent.push(2));
  for (let i = 3; i <= 1000; i++) delivery.publish(() => sent.push(i));
  await sleep(20); assert.deepEqual(sent, [0, 1]);
  gates[0].resolve(); await next;
  assert.deepEqual(sent, [0, 1, 1000]);
  gates[1].reject(Error('late bridge failure')); await nextTurn();
  assert.equal(errors.length, 2, 'late rejection is absorbed after timeout');
  delivery.clear();
});

test('latest snapshot delivery retries transient failures when no newer state exists', async () => {
  const errors = [], attempts = [];
  const delivery = createLatestDelivery(error => errors.push(error.message), { maxRetries: 2, timeoutMs: 20 });
  let tries = 0;
  await delivery.publish(() => {
    attempts.push(++tries);
    if (tries < 3) return false;
    return true;
  });
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.equal(errors.length, 2);
  assert.deepEqual(errors, Array(2).fill('Component state message was not delivered'));
});

test('a newer publish replaces a failed snapshot instead of retrying the obsolete job', async () => {
  const errors = [], sent = [];
  const delivery = createLatestDelivery(error => errors.push(error.message), { maxRetries: 2, timeoutMs: 15 });
  const gate = deferred();
  const first = delivery.publish(() => { sent.push('old'); return gate.promise; });
  delivery.publish(() => { sent.push('new'); return true; });
  await sleep(20);
  assert.deepEqual(errors, ['Component state delivery timed out']);
  gate.resolve(); await first;
  assert.deepEqual(sent, ['old', 'new']);
});

test('clearing a timed-out saturated queue releases callers and isolates the new view', async () => {
  const errors = [], old = deferred();
  const delivery = createLatestDelivery(error => errors.push(error.message), { timeoutMs: 10, maxInFlight: 1, maxRetries: 0 });
  await delivery.publish(() => old.promise);
  let stale = false, fresh = false;
  const blocked = delivery.publish(() => { stale = true; });
  delivery.clear(); await blocked;
  await delivery.publish(() => { fresh = true; });
  old.reject(Error('disposed')); await nextTurn();
  assert.equal(stale, false); assert.equal(fresh, true); assert.equal(errors.length, 1);
});

test('a job that replaces its own view cannot occupy the replacement capacity', async () => {
  const old = deferred(), delivery = createLatestDelivery(undefined, { timeoutMs: 10, maxInFlight: 1 });
  let fresh = false;
  await delivery.publish(() => {
    delivery.clear();
    delivery.publish(() => { fresh = true; });
    return old.promise;
  });
  assert.equal(fresh, true);
  old.reject(Error('old view')); await nextTurn();
});

test('invalid delivery configuration and jobs fail before allocating work', () => {
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: 2147483648 }, { maxInFlight: 0 }, { maxInFlight: 1.5 }, { maxRetries: -1 }, { maxRetries: 11 }]) {
    assert.throws(() => createLatestDelivery(undefined, options), /Invalid delivery/);
  }
  assert.throws(() => createLatestDelivery(null), /observer/);
  assert.throws(() => createLatestDelivery().publish(null), /job/);
});

test('visibility churn preserves capacity and sends only latest state when an old send finishes', async () => {
  const gates = [], sent = [], errors = [];
  const delivery = createLatestDelivery(error => errors.push(error), { maxInFlight: 2 });
  for (let i = 0; i < 100; i++) {
    delivery.publish(() => { sent.push(i); const gate = deferred(); gates.push(gate); return gate.promise; });
    delivery.clear({ resetTransport: false });
  }
  assert.deepEqual(sent, [0, 1]);
  const final = delivery.publish(() => sent.push('final'));
  gates[0].reject(Error('obsolete hidden send')); await final;
  assert.deepEqual(sent, [0, 1, 'final']); assert.deepEqual(errors, []);
  gates[1].resolve(); delivery.clear(); await nextTurn();
});

for (const fails of [false, true]) test(`reentrant hiding reserves transport before calling bridge, synchronous failure=${fails}`, async () => {
  const gate = deferred(), sent = [], errors = [];
  const delivery = createLatestDelivery(error => errors.push(error), { maxInFlight: 1 });
  let next;
  await delivery.publish(() => {
    sent.push('old'); delivery.clear({ resetTransport: false });
    next = delivery.publish(() => sent.push('new'));
    assert.deepEqual(sent, ['old'], 'reentrant send cannot bypass reservation');
    if (fails) throw Error('old bridge');
    return gate.promise;
  });
  if (!fails) { assert.deepEqual(sent, ['old']); gate.resolve(); }
  await next;
  assert.deepEqual(sent, ['old', 'new']); assert.deepEqual(errors, []);
  delivery.clear();
});
