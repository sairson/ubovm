'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { createExecutionPublisher } = require('../../../host/agent/state-publisher.cjs');

test('invalid publisher timers and callbacks fail before installing work', () => {
  const base = { currentId: () => 'id', canPublish: () => true, readExecution: () => ({}), postMessage() {} };
  for (const invalid of [{ delay: -1 }, { delay: NaN }, { delay: 2147483648 }, { postMessage: null }, { readExecution: false }]) {
    assert.throws(() => createExecutionPublisher({ ...base, ...invalid }), TypeError);
  }
});

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
    select(value) { publisher.clear({ resetTransport: true }); id = value; },
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

test('a late full snapshot from another conversation cannot erase the current full snapshot', async t => {
  const f = fixture(t);
  f.publisher.publishFull({ type: 'state', conversation: { id: 'current' }, marker: 'current full' });
  f.publisher.publishFull({ type: 'state', conversation: { id: 'old' }, marker: 'stale full' });
  f.publisher.publishFull(null);
  await f.advance();
  assert.equal(f.published.length, 1);
  assert.equal(f.published[0].type, 'state');
  assert.equal(f.published[0].marker, 'current full');
  assert.equal(f.errors.length, 0);
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
  await f.advance(250);
  assert.equal(f.published.length, 2);
});

test('clearing after timer dispatch cancels the queued snapshot even in the same conversation', async t => {
  const f = fixture(t);
  f.change(1);
  t.mock.timers.tick(75);
  f.publisher.clear();
  await nextTurn();
  assert.equal(f.reads(), 0);
  assert.equal(f.published.length, 0);
  f.change(2); await f.advance();
  assert.equal(f.published[0].execution.streamText, '2');
});

test('a replaced bridge cannot stall or release the new generation publication', async t => {
  let rejectOld, releaseCurrent;
  const old = new Promise((_, reject) => { rejectOld = reject; });
  const current = new Promise(resolve => { releaseCurrent = resolve; });
  let sends = 0;
  const f = fixture(t, () => ++sends === 1 ? old : current);
  f.change(1); await f.advance();
  f.select('new'); f.change(2); await f.advance();
  assert.equal(sends, 2, 'new view does not wait for old acknowledgement');
  rejectOld(Error('disposed old bridge')); await nextTurn();
  f.change(3); await f.advance();
  assert.equal(sends, 2, 'old completion cannot clear the current send');
  assert.deepEqual(f.errors, []);
  releaseCurrent(); await nextTurn(); await f.advance();
  assert.equal(f.published.at(-1).execution.streamText, '3');
});

test('snapshot and observer failures do not create unhandled rejections or poison scheduling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let fail = true, visible = true, reports = 0, sends = 0;
  const publisher = createExecutionPublisher({ currentId: () => 's', canPublish: () => {
    if (!visible) throw Error('visibility'); return true;
  }, readExecution: () => { if (fail) throw Error('snapshot'); return { busy: false }; }, postMessage: () => { sends++; },
  onError: async () => { reports++; throw Error('observer'); } });
  t.after(() => publisher.dispose());
  publisher.schedule('s'); t.mock.timers.tick(75); await nextTurn();
  publisher.schedule('s'); visible = false; t.mock.timers.tick(75); await nextTurn();
  visible = false; publisher.schedule('s'); await nextTurn();
  fail = false; visible = true; publisher.schedule('s'); t.mock.timers.tick(75); await nextTurn();
  assert.equal(reports, 3); assert.equal(sends, 1);
});


test('large timelines back off publication and a view change resets the delay', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let sends = 0;
  const publisher = createExecutionPublisher({ currentId: () => 's', canPublish: () => true,
    readExecution: () => ({ busy: true, parts: Array(10000).fill({ type: 'text', text: 'log' }) }), postMessage: () => { sends++; } });
  t.after(() => publisher.dispose());
  publisher.schedule('s'); t.mock.timers.tick(75); await nextTurn();
  assert.equal(sends, 1);
  for (let i = 0; i < 1000; i++) publisher.schedule('s');
  t.mock.timers.tick(499); await nextTurn(); assert.equal(sends, 1);
  t.mock.timers.tick(1); await nextTurn(); assert.equal(sends, 2);
  publisher.clear(); publisher.schedule('s'); t.mock.timers.tick(75); await nextTurn(); assert.equal(sends, 3);
});

test('an undelivered final snapshot retries without further events and retries remain bounded', async t => {
  const f = fixture(t, () => false);
  f.change(1); await f.advance();
  for (const ms of [250, 500, 1000]) await f.advance(ms);
  assert.equal(f.published.length, 4);
  await f.advance(10000);
  assert.equal(f.published.length, 4, 'permanent failure must not spin');
  assert.equal(f.errors.length, 4);
});

test('a stalled bridge times out and sends current state without waiting for the old promise', async t => {
  let release, count = 0;
  const f = fixture(t, () => ++count === 1 ? new Promise(resolve => { release = resolve; }) : true);
  f.change(1); await f.advance();
  f.change(2); await f.advance(5000);
  assert.match(f.errors[0].message, /timed out/);
  await f.advance(250);
  assert.equal(f.published.length, 2);
  assert.equal(f.published[1].execution.streamText, '2');
  release(false); await nextTurn();
  await f.advance(10000);
  assert.equal(f.errors.length, 1, 'late completion cannot restart retries');
});

test('continuous updates cannot accumulate unlimited unresolved bridge sends', async t => {
  const releases = [];
  const f = fixture(t, () => new Promise(resolve => releases.push(resolve)));
  f.change(1); await f.advance();
  for (let round = 0; round < 20; round++) {
    for (let change = 0; change < 500; change++) f.change(round * 500 + change);
    await f.advance(5000); await f.advance(1000);
  }
  assert.equal(f.published.length, 2, 'physical in-flight sends must be capped even after logical timeouts');
  f.change('final');
  releases[0](true); await nextTurn(); await f.advance(1000);
  assert.equal(f.published.length, 3);
  assert.equal(f.published.at(-1).execution.streamText, 'final');
  releases.slice(1).forEach(resolve => resolve(true)); await nextTurn();
});

test('a replaced view gets fresh capacity while late old sends cannot disturb it', async t => {
  const releases = [];
  const f = fixture(t, () => new Promise(resolve => releases.push(resolve)));
  f.change('old'); await f.advance();
  f.select('new'); f.change('new'); await f.advance();
  assert.equal(f.published.length, 2);
  releases[0](false); await nextTurn(); await f.advance(1000);
  assert.equal(f.published.length, 2); assert.equal(f.errors.length, 0);
  releases[1](true); await nextTurn();
});

test('full and incremental states share one queue and retain only the newest full state', async t => {
  const releases = [];
  const f = fixture(t, () => new Promise(resolve => releases.push(resolve)));
  f.change(1); await f.advance();
  for (let index = 0; index < 10000; index++) {
    f.publisher.publishFull({ type: 'state', conversation: { id: 'current' }, messages: [index] });
    f.change(index);
  }
  assert.equal(f.published.length, 1);
  releases[0](true); await nextTurn(); await f.advance();
  assert.equal(f.published.length, 2);
  assert.equal(f.published[1].type, 'state');
  assert.deepEqual(f.published[1].messages, [9999]);
  assert.equal(f.published[1].execution.streamText, '9999');
  releases[1](true); await nextTurn();
  f.change('later'); await f.advance();
  assert.equal(f.published[2].type, 'executionState');
  releases[2](true); await nextTurn();
});

test('failed final full publication retries metadata without requiring another update', async t => {
  let calls = 0;
  const f = fixture(t, () => ++calls > 1);
  f.publisher.publishFull({ type: 'state', conversation: { id: 'current' }, messages: ['saved'], toolApprovals: ['pending'] });
  await f.advance(); await f.advance(250);
  assert.equal(f.published.length, 2);
  for (const message of f.published) {
    assert.equal(message.type, 'state');
    assert.deepEqual(message.messages, ['saved']);
    assert.deepEqual(message.toolApprovals, ['pending']);
  }
});

test('acknowledging old full state does not discard a concurrent new full publication', async t => {
  const releases = [];
  const f = fixture(t, () => new Promise(resolve => releases.push(resolve)));
  f.publisher.publishFull({ type: 'state', conversation: { id: 'current' }, messages: ['old'] });
  await f.advance();
  f.publisher.publishFull({ type: 'state', conversation: { id: 'current' }, messages: ['new'] });
  releases[0](true); await nextTurn(); await f.advance();
  assert.deepEqual(f.published[1].messages, ['new']);
  releases[1](true); await nextTurn();
});

test('visibility churn cannot reset physical send capacity and a retired send wakes the latest state', async t => {
  const releases = [];
  const f = fixture(t, () => new Promise(resolve => releases.push(resolve)));
  for (let cycle = 0; cycle < 100; cycle++) {
    f.publisher.clear(); f.change(cycle); await f.advance();
  }
  assert.equal(f.published.length, 2, 'hidden views retain the same transport bound');
  assert.equal(f.reads(), 2, 'blocked publication must not allocate snapshots');
  releases[0](true); await nextTurn(); await f.advance();
  assert.equal(f.published.length, 3);
  assert.equal(f.published.at(-1).execution.streamText, '99');
  releases.slice(1).forEach(resolve => resolve(true)); await nextTurn();
});

test('disposal does not restart pending work when old capacity becomes available', async t => {
  let release;
  const f = fixture(t, () => new Promise(resolve => { release = resolve; }));
  f.change(1); await f.advance();
  f.publisher.clear(); f.change(2); f.publisher.dispose();
  release(false); await nextTurn(); await f.advance(10000);
  assert.equal(f.published.length, 1); assert.deepEqual(f.errors, []);
});
