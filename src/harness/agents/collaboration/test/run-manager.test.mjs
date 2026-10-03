import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunManager } from '../run-manager.mjs';

test('wall clock adjustments do not affect duration budgets and closed duration freezes', () => {
  let wall = 10000, monotonic = 100;
  const runtime = createRunManager({ now: () => wall, monotonicNow: () => monotonic, limits: { maxDurationMs: 1000 } });
  try {
    wall = -1000000; monotonic += 200;
    runtime.beforeModel('root');
    assert.equal(runtime.snapshot().elapsedMs, 200);
    wall = 100000000; monotonic += 300;
    runtime.beforeTool('root');
    assert.equal(runtime.snapshot().startedAt, 10000);
    assert.equal(runtime.snapshot().elapsedMs, 500);
    monotonic += 500;
    assert.throws(() => runtime.beforeModel('root'), { code: 'HARNESS_TIME_LIMIT' });
  } finally { runtime.close(); }
  monotonic += 5000;
  runtime.close();
  assert.equal(runtime.snapshot().elapsedMs, 1000);
});

test('shared budgets include every worker and snapshots remain detached', () => {
  const runtime = createRunManager({ limits: { maxModelCalls: 3, maxToolCalls: 2 } });
  try {
    runtime.beforeModel('root'); runtime.beforeModel('child'); runtime.beforeModel('grandchild');
    runtime.beforeTool('child'); runtime.beforeTool('root');
    const snapshot = runtime.snapshot();
    snapshot.workers[0].modelCalls = 99; snapshot.limits.maxModelCalls = 99;
    assert.equal(runtime.snapshot().workers[0].modelCalls, 1);
    assert.throws(() => runtime.beforeModel('other'), { code: 'HARNESS_CALL_LIMIT' });
    assert.equal(runtime.signal.aborted, true);
    assert.equal(runtime.snapshot().modelCalls, 3);
  } finally { runtime.close(); }
});

test('time limits cancel active operations and closing removes the deadline', async () => {
  const runtime = createRunManager({ limits: { maxDurationMs: 20 } });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await new Promise(resolve => runtime.signal.addEventListener('abort', resolve, { once: true }));
    assert.equal(runtime.signal.reason.code, 'HARNESS_TIME_LIMIT');
  } finally { clearTimeout(keepAlive); runtime.close(); }
  const finished = createRunManager({ limits: { maxDurationMs: 10 } });
  finished.close(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(finished.signal.aborted, false);
});

test('default limits allow long runs and invalid limits fail explicitly', () => {
  const runtime = createRunManager();
  for (let index = 0; index < 10000; index++) { runtime.beforeModel('root'); runtime.beforeTool('child'); }
  assert.equal(runtime.snapshot().modelCalls, 10000);
  runtime.close();
  for (const limits of [[], { maxDurationMs: 2147483648 }, { maxToolCalls: -1 }, { maxModelCalls: 1.5 }, { typo: 10 }]) {
    assert.throws(() => createRunManager({ limits }), TypeError);
  }
});
