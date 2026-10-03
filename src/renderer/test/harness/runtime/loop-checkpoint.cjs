'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { createLoopCheckpoint } = require('../../../../harness/ide/runtime/loop-checkpoint.cjs');

test('elapsed time yields before the count limit and resets after resumption', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const checkpoint = createLoopCheckpoint(1000);
  assert.equal(checkpoint(), undefined);
  now = 9;
  const pause = checkpoint();
  assert(pause instanceof Promise);
  let heartbeat = false;
  process.nextTick(() => { heartbeat = true; });
  await pause;
  assert.equal(heartbeat, true);
  assert.equal(checkpoint(), undefined);
});

test('count threshold yields even when the clock does not advance', async t => {
  t.mock.method(performance, 'now', () => 0);
  const checkpoint = createLoopCheckpoint(3);
  for (let batch = 0; batch < 10; batch++) {
    assert.equal(checkpoint(), undefined);
    assert.equal(checkpoint(), undefined);
    const pause = checkpoint(); assert(pause instanceof Promise); await pause;
  }
  for (const invalid of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createLoopCheckpoint(invalid), TypeError);
  }
});
