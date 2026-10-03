'use strict';

const { redactDisplayObject } = require('./projection.cjs');
const WORKER_RECORD_LIMIT = 8 << 20;
const WORKER_RECORD_COUNT = 100;
const byteLength = value => Buffer.byteLength(JSON.stringify(value));

// Bound persisted display data, never execution checkpoints or model context.
// Work newest-first and size each part once instead of repeatedly serializing
// the complete history after removing one worker at a time.
function workerRecord(sessionId, workers, totalWorkers) {
  const record = { schemaVersion: 1, sessionId, workers: [], omittedWorkers: totalWorkers };
  let remaining = WORKER_RECORD_LIMIT - byteLength(record);
  for (let index = workers.length - 1; index >= Math.max(0, workers.length - WORKER_RECORD_COUNT); index--) {
    const { parts = [], ...metadata } = workers[index];
    const previousOmitted = Number.isSafeInteger(metadata.omittedParts) && metadata.omittedParts > 0 ? metadata.omittedParts : 0;
    const worker = { ...redactDisplayObject(metadata), parts: [], omittedParts: parts.length + previousOmitted };
    const overhead = byteLength(worker) + (record.workers.length ? 1 : 0);
    if (overhead > remaining) break;
    remaining -= overhead;
    const kept = [];
    for (let partIndex = parts.length - 1; partIndex >= Math.max(0, parts.length - 500); partIndex--) {
      const part = redactDisplayObject(parts[partIndex]);
      const bytes = byteLength(part) + (kept.length ? 1 : 0);
      if (bytes > remaining) break;
      kept.push(part); remaining -= bytes;
    }
    worker.parts = kept.reverse();
    // Counts only shrink, so the precomputed JSON envelope remains an upper bound.
    worker.omittedParts = parts.length - kept.length + previousOmitted;
    record.workers.push(worker);
  }
  record.workers.reverse();
  record.omittedWorkers = totalWorkers - record.workers.length;
  return record;
}

module.exports = { workerRecord, WORKER_RECORD_LIMIT, WORKER_RECORD_COUNT };
