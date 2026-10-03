'use strict';
// Opt-in: node --expose-gc --test src/renderer/test/host/agent/push-long-run.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { setImmediate: turn } = require('node:timers/promises');
const { createExecutionPublisher } = require('../../../host/agent/state-publisher.cjs');

test('ten million mixed state updates remain bounded across bridge stalls and visibility churn', async t => {
  assert.equal(typeof global.gc, 'function', 'Run with --expose-gc');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const releases = [], sent = [];
  let value = 0, failures = 0;
  const publisher = createExecutionPublisher({ currentId: () => 'session', canPublish: () => true,
    readExecution: () => ({ busy: true, streamText: String(value) }),
    postMessage: message => { sent.push(message); return new Promise(resolve => releases.push(resolve)); },
    onError: () => { failures++; }
  });
  t.after(() => publisher.dispose());
  global.gc(); const heapBefore = process.memoryUsage().heapUsed, start = performance.now();
  for (let round = 0; round < 10000; round++) {
    if (round % 10 === 0) publisher.clear(); // Hide/reveal the same stalled bridge.
    for (let index = 0; index < 1000; index++) {
      value++;
      publisher.publishFull({ type: 'state', conversation: { id: 'session' }, messages: [value] });
      publisher.schedule('session');
    }
    t.mock.timers.tick(6000); await turn();
  }
  assert.equal(sent.length, 4);
  releases[0](true); await turn(); t.mock.timers.tick(1000); await turn();
  assert.equal(sent.length, 5);
  assert.equal(sent[4].type, 'state');
  assert.equal(sent[4].messages[0], 10000000);
  assert.equal(sent[4].execution.streamText, '10000000');
  for (const resolve of releases.slice(1)) resolve(true);
  await turn(); t.mock.timers.tick(20000); await turn();
  assert.equal(sent.length, 5);
  global.gc(); const retainedHeapBytes = process.memoryUsage().heapUsed - heapBefore;
  assert(retainedHeapBytes < 8 * 1024 * 1024);
  t.diagnostic(JSON.stringify({ mixedUpdates: value, simulatedElapsedMs: 60000000,
    elapsedMs: performance.now() - start, sendsBeforeRecovery: 4, sendsTotal: sent.length, failures, retainedHeapBytes }));
});
