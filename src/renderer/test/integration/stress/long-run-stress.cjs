'use strict';
// Opt-in stress runner: node --expose-gc src/renderer/test/integration/stress/long-run-stress.cjs
// No model, network, filesystem write per iteration, or tool side effects.
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { createLatestWrite } = require('../../../../harness/ide/runtime/latest-write.cjs');
const { createLatestDelivery } = require('../../../host/agent/latest-delivery.cjs');
const { createSnapshotQueue } = require('../../../../harness/ide/runtime/snapshot-queue.cjs');

const iterations = Number(process.env.UBOVM_LONG_RUN_ITERATIONS ?? 10000000);
assert(Number.isSafeInteger(iterations) && iterations >= 10000);
assert.equal(typeof global.gc, 'function', 'Run with --expose-gc for retained-heap measurements');

async function measure(kind) {
  global.gc();
  const before = process.memoryUsage().heapUsed, started = performance.now();
  let completed = 0, beats = 0, peakHeap = before, maxHeartbeatGapMs = 0, lastBeat = started;
  const timer = setInterval(() => {
    const now = performance.now();
    maxHeartbeatGapMs = Math.max(maxHeartbeatGapMs, now - lastBeat); lastBeat = now;
    beats++; peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  }, 1);
  try {
    if (kind === 'snapshots') {
      let finish;
      const done = new Promise(resolve => { finish = resolve; });
      const queue = createSnapshotQueue({ read: id => id, send: () => {
        if (++completed < iterations) queue.schedule('session');
        else finish();
      } });
      try { queue.schedule('session'); await done; } finally { queue.close(); }
    } else if (kind === 'writes') {
      const enqueue = createLatestWrite();
      function write() { if (++completed < iterations) enqueue(write); }
      await enqueue(write);
    } else {
      const delivery = createLatestDelivery();
      const resolved = Promise.resolve();
      function publish() {
        if (++completed < iterations) delivery.publish(publish);
        if (kind === 'async-delivery') return resolved;
      }
      await delivery.publish(publish);
      delivery.clear();
    }
  } finally { clearInterval(timer); }
  const elapsedMs = performance.now() - started;
  assert.equal(completed, iterations);
  assert(beats > 0, 'heartbeat must run before the loop completes');
  global.gc();
  const retainedHeapBytes = process.memoryUsage().heapUsed - before;
  assert(retainedHeapBytes < 8 * 1024 * 1024, 'retained heap must stay bounded, not grow with iteration count');
  return { kind, iterations, elapsedMs, heartbeatTicks: beats, maxHeartbeatGapMs,
    retainedHeapBytes, sampledPeakHeapBytes: peakHeap };
}

(async () => {
  const results = [];
  for (const kind of ['sync-delivery', 'async-delivery', 'writes', 'snapshots']) results.push(await measure(kind));
  console.log(JSON.stringify({ node: process.version, results }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
