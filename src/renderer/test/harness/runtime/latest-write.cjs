'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLatestWrite } = require('../../../../harness/ide/runtime/latest-write.cjs');

test('a continuously replenished write queue yields to cancellation and heartbeat tasks', async () => {
  const enqueue = createLatestWrite();
  let writes = 0, observed = false;
  const heartbeat = new Promise(resolve => setImmediate(() => { observed = writes > 0 && writes < 10000; resolve(); }));
  function write() { if (++writes < 10000) enqueue(write); }
  await enqueue(write); await heartbeat;
  assert.equal(writes, 10000);
  assert.equal(observed, true, 'the queue must not monopolize microtasks until every write finishes');
});

test('slow persistence coalesces thousands of updates and waits for the final durable write', async () => {
  const enqueue = createLatestWrite(), writes = [];
  let release, finalRelease;
  const first = enqueue(async () => { writes.push(0); await new Promise(resolve => { release = resolve; }); });
  await Promise.resolve();
  for (let i = 1; i < 10000; i++) assert.equal(enqueue(() => { writes.push(i); }), first);
  assert.equal(enqueue(async () => { writes.push('final'); await new Promise(resolve => { finalRelease = resolve; }); }), first);
  let settled = false;
  first.then(() => { settled = true; });
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(writes, [0, 'final']);
  assert.equal(settled, false);
  finalRelease(); await first;
  await enqueue(() => { writes.push('next run'); });
  assert.deepEqual(writes, [0, 'final', 'next run']);
});

test('write failure is reported, latest pending state is attempted, and later writes recover', async () => {
  const enqueue = createLatestWrite();
  let release, latest = false;
  const writing = enqueue(() => new Promise((_, reject) => { release = () => reject(new Error('disk full')); }));
  const rejected = assert.rejects(writing, /disk full/);
  await Promise.resolve();
  enqueue(() => { latest = true; });
  release(); await rejected;
  assert.equal(latest, true);
  await enqueue(() => {});
});

test('falsy thrown values still reject the durability barrier and permit recovery', async () => {
  for (const reason of [undefined, null, false, 0, '']) {
    const enqueue = createLatestWrite();
    let release;
    const writing = enqueue(() => new Promise((_, reject) => { release = () => reject(reason); }));
    const observed = writing.then(() => assert.fail('write failure was swallowed'), error => assert.equal(error, reason));
    await Promise.resolve();
    let latest = false;
    enqueue(() => { latest = true; });
    release(); await observed;
    assert.equal(latest, true);
    await enqueue(() => {});
  }
});

test('invalid writes cannot replace valid pending work or corrupt the barrier', async () => {
  const enqueue = createLatestWrite();
  let release, saved = false;
  const writing = enqueue(() => new Promise(resolve => { release = resolve; }));
  await Promise.resolve();
  enqueue(() => { saved = true; });
  assert.throws(() => enqueue(null), /write must be a function/);
  release(); await writing;
  assert.equal(saved, true);
});
