import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarness } from '../session_manager.mjs';
import { MemoryStore } from '../intools/shared/store/memory-store.mjs';
import { HarnessDatabase } from '../blackboard/database/database.mjs';

for (const asynchronous of [false, true]) test(`session close releases storage after ${asynchronous ? 'asynchronous' : 'synchronous'} unsubscribe failure`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ubovm-close-fault-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const expected = new Error('memory unsubscribe failed');
  const original = MemoryStore.prototype.subscribe;
  const mock = t.mock.method(MemoryStore.prototype, 'subscribe', function(listener) {
    const unsubscribe = original.call(this, listener);
    return () => { unsubscribe(); if (asynchronous) return Promise.reject(expected); throw expected; };
  });
  const options = { directory, sessionId: 'close-fault', goal: 'Verify cleanup', contextSummary: false,
    intools: { knowledge: false, allowedTools: [] }, reason: async () => {}, worker: async () => {} };
  const session = await createHarness(options);
  mock.mock.restore();
  const closing = session.close();
  assert.equal(session.close(), closing, 'all close callers share the same cleanup barrier');
  await assert.rejects(closing, error => error instanceof AggregateError && error.errors.includes(expected));
  assert.equal(session.status, 'closed');
  assert.throws(() => session.run(), { code: 'SESSION_CLOSED' });
  const reopened = await createHarness(options);
  await reopened.close();
  assert.equal(reopened.status, 'closed', 'directory ownership and database lease must both be released');
});

for (const cleanupFailure of [false, true]) test(`failed initialization releases directory and preserves its cause (cleanup failure: ${cleanupFailure})`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ubovm-init-fault-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const expected = new Error('subscription initialization failed');
  const closingError = new Error('database close failed');
  const subscribe = t.mock.method(MemoryStore.prototype, 'subscribe', () => { throw expected; });
  const original = HarnessDatabase.prototype.close;
  let closed = 0;
  const close = t.mock.method(HarnessDatabase.prototype, 'close', function() {
    original.call(this); closed++;
    if (cleanupFailure) throw closingError;
  });
  const options = { directory, sessionId: 'init-fault', goal: 'Verify initialization cleanup', contextSummary: false,
    intools: { knowledge: false, allowedTools: [] }, reason: async () => {}, worker: async () => {} };
  await assert.rejects(createHarness(options), error => cleanupFailure
    ? error instanceof AggregateError && error.cause === expected && error.errors.includes(expected) && error.errors.includes(closingError)
    : error === expected);
  assert.equal(closed, 1);
  subscribe.mock.restore(); close.mock.restore();
  const reopened = await createHarness(options);
  await reopened.close();
});
