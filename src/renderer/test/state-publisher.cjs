'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { createExecutionPublisher } = require('../host/state-publisher.cjs');

function fixture(t, postMessage) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const published = [], errors = [];
  let id = 'current', visible = true, version = 0, reads = 0;
  const publisher = createExecutionPublisher({
    currentId: () => id,
    canPublish: () => visible,
    readExecution: () => { reads++; return { status: 'running', busy: true, streamText: String(version) }; },
    postMessage: message => { published.push(message); return postMessage?.(message); },
    onError: error => errors.push(error)
  });
  t.after(() => publisher.dispose());
  return { publisher, published, errors, reads: () => reads,
    change(value) { version = value; publisher.schedule(id); },
    visible(value) { visible = value; },
    select(value) { publisher.clear(); id = value; },
    async advance(ms = 75) { t.mock.timers.tick(ms); await nextTurn(); }
  };
}

test('a burst reads and publishes only the newest execution without copying conversation history', async t => {
  const f = fixture(t);
  for (let i = 0; i < 1000; i++) f.change(i);
  assert.equal(f.reads(), 0);
  await f.advance();
  assert.equal(f.reads(), 1);
  assert.deepEqual(f.published, [{ type: 'executionState', conversationId: 'current', execution: { status: 'running', busy: true, streamText: '999' }, busy: true }]);
});

test('background conversations and hidden panels perform no snapshot work', async t => {
  const f = fixture(t);
  f.publisher.schedule('background');
  f.visible(false);
  f.change(1);
  await f.advance();
  assert.equal(f.reads(), 0);
  f.visible(true);
  f.change(2);
  f.visible(false);
  await f.advance();
  assert.equal(f.reads(), 0, 'hiding before a pending flush also suppresses its work');
  f.visible(true);
  f.change(3);
  await f.advance();
  assert.equal(f.published[0].execution.streamText, '3');
});

test('slow bridge retains one update in flight and then sends the latest state', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const f = fixture(t, () => held);
  f.change(1);
  await f.advance();
  for (let i = 2; i < 100; i++) f.change(i);
  await f.advance(1000);
  assert.equal(f.published.length, 1);
  assert.equal(f.reads(), 1);
  release(true);
  await nextTurn();
  await f.advance();
  assert.equal(f.published.length, 2);
  assert.equal(f.published[1].execution.streamText, '99');
});

test('full publications, session switches and disposal cancel pending incremental work', async t => {
  const f = fixture(t);
  f.change(1);
  f.publisher.clear();
  await f.advance();
  assert.equal(f.reads(), 0);
  f.change(2);
  f.select('next');
  f.change(3);
  await f.advance();
  assert.equal(f.published.length, 1);
  assert.equal(f.published[0].conversationId, 'next');
  f.change(4);
  f.publisher.dispose();
  f.change(5);
  await f.advance();
  assert.equal(f.published.length, 1);
});

test('a rejected bridge send is reported without blocking later publications', async t => {
  let reject = true;
  const failure = new Error('bridge unavailable');
  const f = fixture(t, () => { if (reject) { reject = false; return Promise.reject(failure); } return true; });
  f.change(1);
  await f.advance();
  assert.deepEqual(f.errors, [failure]);
  f.change(2);
  await f.advance();
  assert.equal(f.published.length, 2);
});
