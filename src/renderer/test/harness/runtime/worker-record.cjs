'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { workerRecord, WORKER_RECORD_LIMIT } = require('../../../../harness/ide/runtime/worker-record.cjs');
const worker = (id, parts = []) => ({ id, description: 'Worker ' + id, status: 'completed', parts });

test('worker persistence keeps the newest 100 workers beyond the display array limit', () => {
  const workers = Array.from({ length: 601 }, (_, i) => worker(String(i)));
  const record = workerRecord('session', workers, workers.length);
  assert.equal(record.workers.length, 100);
  assert.equal(record.workers[0].id, '501');
  assert.equal(record.workers.at(-1).id, '600');
  assert.equal(record.omittedWorkers, 501);
});

test('a single oversized worker retains recent UTF-8 history within the restore byte limit', () => {
  const parts = Array.from({ length: 200 }, (_, i) => ({ id: String(i), type: 'text', text: '中文🙂'.repeat(10000), status: 'completed' }));
  const record = workerRecord('session', [worker('huge', parts)], 1);
  assert(Buffer.byteLength(JSON.stringify(record)) <= WORKER_RECORD_LIMIT);
  assert.equal(record.workers.length, 1);
  const saved = record.workers[0];
  assert(saved.parts.length > 0 && saved.parts.length < parts.length);
  assert.equal(saved.parts.at(-1).id, '199');
  assert.equal(saved.omittedParts, parts.length - saved.parts.length);
  assert.equal(parts.length, 200, 'execution history must not be mutated');
  const rewritten = workerRecord('session', record.workers, 1);
  assert.equal(rewritten.workers[0].omittedParts, saved.omittedParts, 'restore and close preserve truncation accounting');
});

test('part-count trimming keeps recent history, removes credentials and leaves execution data intact', () => {
  const parts = Array.from({ length: 601 }, (_, i) => ({ id: String(i), type: 'text', text: 'password=secret-value', status: 'completed' }));
  const saved = workerRecord('session', [worker('a', parts)], 1);
  assert.equal(saved.workers[0].parts[0].id, '101');
  assert.equal(saved.workers[0].parts.length, 500);
  assert.equal(saved.workers[0].omittedParts, 101);
  assert(!JSON.stringify(saved).includes('secret-value'));
  assert(parts[0].text.includes('secret-value'));
});

test('sizing reads each retained part once instead of serializing the full record repeatedly', () => {
  let reads = 0;
  const workers = Array.from({ length: 100 }, (_, i) => worker(String(i), [{ id: String(i), get text() { reads++; return 'progress'; } }]));
  const saved = workerRecord('session', workers, workers.length);
  assert.equal(saved.workers.length, 100);
  assert.equal(reads, 100);
});
