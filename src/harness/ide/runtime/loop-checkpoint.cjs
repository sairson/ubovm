'use strict';
const { performance } = require('node:perf_hooks');

// Promise continuations alone never give timers, ports or cancellation events
// a turn. Keep the common path allocation-free and yield once per bounded batch.
// The counter resets, so its size does not grow with the lifetime of the loop.
function createLoopCheckpoint(batchSize = 256) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new TypeError('batchSize must be a positive safe integer');
  let remaining = batchSize, deadline = performance.now() + 8;
  return function checkpoint() {
    if (--remaining > 0 && performance.now() < deadline) return undefined;
    remaining = batchSize;
    return new Promise(resolve => setImmediate(() => { deadline = performance.now() + 8; resolve(); }));
  };
}

module.exports = { createLoopCheckpoint };
