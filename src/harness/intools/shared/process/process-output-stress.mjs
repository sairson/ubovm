// Opt-in, bounded runner: node --expose-gc process-output-stress.mjs
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createProcessOutput } from './process-output.mjs';

assert.equal(typeof global.gc, 'function', 'Run with --expose-gc');
const iterations = 100000, batchSize = 1000, limit = 4096;
const chunk = Buffer.alloc(1024, 'x');
const started = performance.now(), samples = [];
let notifications = 0;
global.gc();
const baseline = process.memoryUsage().heapUsed;
const output = createProcessOutput(limit, () => { notifications++; }, { rolling: () => true, batchBytes: limit });
for (let i = 0; i < iterations; i += batchSize) {
  assert(performance.now() - started < 10000, 'stress duration exceeded 10 seconds');
  for (let j = 0; j < batchSize; j++) assert.equal(output.write(chunk), true);
  await nextTurn();
  if ((i + batchSize) % 10000 === 0) {
    global.gc();
    const memory = process.memoryUsage();
    samples.push({ chunks: i + batchSize, heapUsed: memory.heapUsed, external: memory.external, rss: memory.rss });
  }
}
const finalBytes = Buffer.byteLength(output.finish());
assert(finalBytes <= limit);
const finishedNotifications = notifications;
assert.equal(output.write(chunk), false);
await new Promise(resolve => setTimeout(resolve, 40));
assert.equal(notifications, finishedNotifications, 'finished output still has a notification timer');
global.gc();
console.log(JSON.stringify({ iterations, inputBytes: iterations * chunk.length, elapsedMs: performance.now() - started,
  baselineHeap: baseline, retainedHeapDelta: process.memoryUsage().heapUsed - baseline,
  finalBytes, notifications, samples }, null, 2));
