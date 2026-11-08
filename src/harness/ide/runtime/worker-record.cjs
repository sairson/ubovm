'use strict';

const { redactDisplayObject, sanitizeToolImage } = require('./projection.cjs');
const WORKER_RECORD_LIMIT = 8 << 20;
const WORKER_RECORD_COUNT = 100;
const byteLength = value => Buffer.byteLength(JSON.stringify(value));

/**
 * Persist one display part. redactDisplayObject clamps every string to 64000
 * chars, which would corrupt an inlined base64 tool image; valid image payloads
 * are therefore validated separately and kept whole, or dropped to an
 * imageOmitted note when they cannot be stored intact.
 */
function persistPart(part) {
  if (!part || typeof part !== 'object' || Array.isArray(part) || part.image === undefined && part.imageOmitted !== true) return redactDisplayObject(part);
  const { image, ...rest } = part;
  const clean = redactDisplayObject(rest);
  const sanitized = sanitizeToolImage(image);
  if (sanitized) return { ...clean, image: sanitized };
  return { ...clean, ...(part.imageOmitted === true || image !== undefined ? { imageOmitted: true } : {}) };
}

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
      let part = persistPart(parts[partIndex]);
      let bytes = byteLength(part) + (kept.length ? 1 : 0);
      // An image that no longer fits the record budget must not evict the whole
      // tool card: retry the part without its payload and mark it omitted.
      if (bytes > remaining && part && typeof part === 'object' && !Array.isArray(part) && part.image !== undefined) {
        const { image, ...rest } = part;
        part = { ...rest, imageOmitted: true };
        bytes = byteLength(part) + (kept.length ? 1 : 0);
      }
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
