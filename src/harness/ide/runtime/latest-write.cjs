'use strict';
const { createLoopCheckpoint } = require('./loop-checkpoint.cjs');

// Retain one active write and one latest replacement, not a chain of snapshots.
// All callers share a durability barrier that includes updates queued mid-write.
function createLatestWrite() {
  let pending, draining;
  return function enqueue(write) {
    if (typeof write !== 'function') throw new TypeError('write must be a function');
    pending = write;
    if (!draining) draining = Promise.resolve().then(async () => {
      let failure, failed = false;
      const checkpoint = createLoopCheckpoint();
      try {
        while (pending) {
          const pause = checkpoint();
          if (pause) await pause;
          const current = pending; pending = undefined;
          try { await current(); } catch (error) { failure = error; failed = true; }
        }
        if (failed) throw failure;
      } finally { draining = undefined; }
    });
    return draining;
  };
}
module.exports = { createLatestWrite };
